// Why: an answer the schema refused was recorded as clean, so a run could not explain its second
// model calls. A step's result now says what the step answered to each of its answers at the time,
// as recorded with each answer: refused by the schema, refused by the checks, advised, or
// accepted. Each case says what it guards. The production agent step runs on a real pi harness
// over SQLite (`pi/stages/fixture.ts`) and, for the contract engine, the fake runtime of
// `pi/stages/contract-fixture.ts`.
import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { Blobs, Computations } from "@neuve/records-core";
import { Effect } from "effect";
import { z } from "zod";
import type { AgentStep, SubmissionOutcome } from "../src/pi/stages/agent.ts";
import { AgentContextDoc } from "../src/pi/stages/docs.ts";
import { RECORDS, defineTool } from "../src/toolkit.ts";
import {
  agentConversation,
  settled,
  testRuntimes,
  toolResults,
  world,
} from "./pi/stages/fixture.ts";
import { setup, submit, usage } from "./pi/stages/contract-fixture.ts";

type Seen = Array<ReadonlyArray<SubmissionOutcome> | undefined>;

/** Wraps a step's composition to keep the list each composition was handed. */
const recording =
  (seen: Seen) =>
  (step: AgentStep<unknown, unknown>): AgentStep<unknown, unknown> => ({
    ...step,
    compose: (result) => {
      seen.push(result.submissions);
      return step.compose(result);
    },
  });

/** A pi-engine world whose step records the list it composes with. */
const recorded = async (
  name: string,
  turnLimit = 6,
  adjust: (step: AgentStep<unknown, unknown>) => AgentStep<unknown, unknown> = (
    step,
  ) => step,
) => {
  const seen: Seen = [];
  const run = await world(
    name,
    turnLimit,
    false,
    false,
    "faux",
    undefined,
    false,
    undefined,
    {
      runtimes: testRuntimes().registry,
      configure: (step) => recording(seen)(adjust(step)),
    },
  );
  return { run, seen };
};

/** A check that passes only once the probe tool has read region 7, as find's head reads do. */
const needsProbe7 = (
  step: AgentStep<unknown, unknown>,
): AgentStep<unknown, unknown> => ({
  ...step,
  spec: {
    ...step.spec,
    check: () =>
      JSON.stringify(step.spec.state?.save() ?? null).includes('"p7"')
        ? []
        : ["probe 7 first"],
  },
});

const submitting =
  (answer: number | null, id: string) => (): AssistantMessage =>
    fauxAssistantMessage([fauxToolCall("submit_frame", { answer }, { id })], {
      stopReason: "toolUse",
    });

const answering = (text: string) => (): AssistantMessage =>
  fauxAssistantMessage(text);

/** Runs a script to its end in one process and returns the step's record and lists. */
const runToEnd = async (
  name: string,
  replies: ReadonlyArray<() => AssistantMessage>,
  turnLimit = 6,
) => {
  const { run, seen } = await recorded(name, turnLimit);
  run.script.push(...replies);
  const opened = await run.open();
  try {
    const id = await run.start(opened);
    await opened.harness.resume();
    const record = await settled(opened.harness, id);
    return { run, seen, record };
  } finally {
    await opened.harness.close(context);
  }
};

// Guards the running phase: the schema's refusal is told apart from the checks' refusal.
test("running: a schema refusal then an accepted answer, and a checks refusal then an accepted answer", async () => {
  const schema = await runToEnd("submissions-running-schema", [
    submitting(null, "submit-1"),
    submitting(5, "submit-2"),
  ]);
  expect(schema.record.agentResult?.status).toBe("submitted");
  expect(schema.run.sent).toHaveLength(2);
  expect(schema.seen).toEqual([["schema", "accepted"]]);

  const checks = await runToEnd("submissions-running-checks", [
    submitting(0, "submit-1"),
    submitting(5, "submit-2"),
  ]);
  expect(checks.record.agentResult?.status).toBe("submitted");
  expect(checks.run.sent).toHaveLength(2);
  expect(checks.seen).toEqual([["checks", "accepted"]]);
});

// Guards the final phase: its refused answers are read back from the refusals it sent, after the
// running phase's submissions, in order.
test("final: the running phase's refusals, then a final answer the schema refused, one the checks refused, then an accepted one", async () => {
  const { run, seen, record } = await runToEnd(
    "submissions-final",
    [
      submitting(null, "submit-1"),
      submitting(0, "submit-2"),
      answering("not json"),
      answering('{"answer":0}'),
      answering('{"answer":3}'),
    ],
    2,
  );
  expect(record.agentResult).toMatchObject({
    status: "final-generation",
    endedBy: "turn-limit",
  });
  expect(run.sent.map((sent) => sent.mode.kind)).toEqual([
    "normal",
    "normal",
    "final",
    "final",
    "final",
  ]);
  expect(seen).toEqual([["schema", "checks", "schema", "checks", "accepted"]]);
});

// Guards the backstop: a step that never had an answer accepted lists its refusals and no
// `accepted`, in the running phase and in the final phase.
test("backstop: refusals and no accepted, from the running phase and from the final phase", async () => {
  const running = await runToEnd("submissions-backstop-running", [
    submitting(null, "submit-1"),
    submitting(null, "submit-2"),
    submitting(null, "submit-3"),
  ]);
  expect(running.record.agentResult?.status).toBe("backstop");
  expect(running.seen).toEqual([["schema", "schema", "schema"]]);

  const final = await runToEnd(
    "submissions-backstop-final",
    [
      answering("read the evidence"),
      answering("one"),
      answering("two"),
      answering("three"),
    ],
    1,
  );
  expect(final.record.agentResult).toMatchObject({
    status: "backstop",
    finalGeneration: true,
  });
  expect(final.run.sent).toHaveLength(4);
  expect(final.seen).toEqual([["schema", "schema", "schema"]]);
});

// Guards the derivation from what is stored: a refusal made in one process is in the list a fresh
// process composes with, the same list one uninterrupted process gives.
test("resume: a step taken up again in a fresh process gives the same list as one process", async () => {
  const { run, seen } = await recorded("submissions-resume", 1);
  let release: () => void = () => {};
  const closing = new Promise<void>((resolve) => {
    release = resolve;
  });
  run.script.push(submitting(null, "submit-1"), answering("nope"));
  // The second final request is in flight when the harness closes: its answer never comes.
  run.script.push(async (_sent, signal) => {
    release();
    await new Promise((_resolve, reject) =>
      signal?.addEventListener("abort", () => reject(new Error("cancelled"))),
    );
    return fauxAssistantMessage("never");
  });
  const first = await run.open();
  const id = await run.start(first);
  await first.harness.resume();
  await closing;
  await first.harness.close(context);
  // The first process composed nothing: both refusals are only in the stored conversation.
  expect(seen).toEqual([]);

  run.script.length = 0;
  run.script.push(answering('{"answer":4}'));
  const second = await run.open();
  try {
    await second.harness.resume();
    const record = await settled(second.harness, id);
    expect(record.agentResult?.status).toBe("final-generation");
  } finally {
    await second.harness.close(context);
  }
  expect(seen).toEqual([["schema", "schema", "accepted"]]);

  const once = await runToEnd(
    "submissions-resume-once",
    [
      submitting(null, "submit-1"),
      answering("nope"),
      answering('{"answer":4}'),
    ],
    1,
  );
  expect(once.seen).toEqual(seen);
});

// Guards that nothing else changes: a step whose composition ignores the list (the fixture's own)
// stores the output, summary and stage record it stored before, with no list in any of them or in
// the run log.
test("a composition that ignores the list stores and records exactly what it did before", async () => {
  const run = await world("submissions-unchanged");
  run.script.push(submitting(null, "submit-1"), submitting(5, "submit-2"));
  const opened = await run.open();
  try {
    const id = await run.start(opened);
    await opened.harness.resume();
    const record = await settled(opened.harness, id);
    const stored = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Computations.ComputationStore;
        const blobs = yield* Blobs.BlobStore;
        const computation = (yield* store.lookup(record.key!)).pipe((option) =>
          option._tag === "Some" ? option.value : undefined,
        );
        const read = yield* blobs.get(computation!.outputHash);
        return read._tag === "Pruned"
          ? undefined
          : (JSON.parse(new TextDecoder().decode(read.bytes)) as Record<
              string,
              Record<string, unknown>
            >);
      }).pipe(Effect.provide(run.ctx.records)),
    );
    expect(Object.keys(stored ?? {})).toEqual(["output", "summary", "context"]);
    expect(stored?.["output"]).toEqual({
      status: "submitted",
      output: { answer: 5 },
    });
    // The summary's fields as the step stored them before the list existed, in the same order.
    expect(Object.keys(stored?.["summary"] ?? {})).toEqual([
      "agent",
      "stage",
      "status",
      "endedBy",
      "turnsUsed",
      "turnLimit",
      "finalGeneration",
      "usage",
      "costUsd",
      "resumedTurns",
      "restarted",
      "modelCalls",
      "context",
    ]);
    expect(stored?.["summary"]).toMatchObject({
      agent: "frame",
      stage: "frame",
      status: "submitted",
      endedBy: "submit",
      turnsUsed: 2,
      turnLimit: 6,
      finalGeneration: false,
      resumedTurns: 0,
      restarted: false,
      modelCalls: 2,
    });
    expect(record.agentResult).toEqual(stored?.["summary"] as never);
    expect(Object.keys(record)).not.toContain("submissions");
    const agentEntries = run.ctx.log
      .read()
      .filter((entry) => entry.type === "agent");
    expect(agentEntries).toHaveLength(1);
    expect(Object.keys(agentEntries[0]!)).not.toContain("submissions");
    expect(JSON.stringify(stored)).not.toContain("submissions");
  } finally {
    await opened.harness.close(context);
  }
});

// Guards the contract engine, which reaches the same result through its own rounds: a submit call
// the schema refused, then final answers refused by the schema and the checks, then accepted.
test("contract: a refused submission, then final answers refused by the schema and the checks, then an accepted one", async () => {
  const seen: Seen = [];
  const refused = submit("refused", null);
  const finalAnswer =
    (structuredOutput: unknown) =>
    async (turn: Parameters<Parameters<typeof setup>[1][number]>[0]) => {
      expect(turn.final).toBe(true);
      await turn.message();
      await turn.charge(usage);
      return {
        status: "completed" as const,
        structuredOutput: structuredOutput as never,
      };
    };
  const w = await setup(
    "submissions-contract",
    [
      async (turn) => {
        await turn.message([refused]);
        expect((await turn.invoke(refused)).error).toBe("InvalidInput");
        await turn.charge(usage);
      },
      finalAnswer({ answer: "bad" }),
      finalAnswer({ answer: 0 }),
      finalAnswer({ answer: 4 }),
    ],
    { limit: 1, configure: recording(seen) },
  );
  try {
    const outcome = await w.start();
    expect(outcome.status).toBe("completed");
    if (outcome.status === "completed")
      expect(outcome.result.agentResult?.status).toBe("final-generation");
    expect(seen).toEqual([["schema", "schema", "checks", "accepted"]]);
  } finally {
    await w.close();
  }
});

const probing = (n: number, id: string) => (): AssistantMessage =>
  fauxAssistantMessage([fauxToolCall("probe", { n }, { id })], {
    stopReason: "toolUse",
  });

// Guards the label against a check that reads tool state: the refusal the model was told stays a
// refusal, even though the same check passes on the state the step ends with.
test("a check that passes only after a later tool call: the list shows the refusal the model was told", async () => {
  // The world's record of the probe tool's calls stands in for find's head reads: the check reads
  // it whenever it runs, so a later call changes what it says about an earlier answer.
  const probes: { list: ReadonlyArray<unknown> } = { list: [] };
  const { run, seen } = await recorded(
    "submissions-state-check",
    6,
    (step) => ({
      ...step,
      spec: {
        ...step.spec,
        check: () =>
          JSON.stringify(probes.list).includes('{"n":7}')
            ? []
            : ["probe 7 first"],
      },
    }),
  );
  probes.list = run.probes;
  run.script.push(submitting(5, "submit-1"), probing(7, "probe-1"));
  const opened = await run.open();
  try {
    const id = await run.start(opened);
    await opened.harness.resume();
    await settled(opened.harness, id);
    const told = toolResults(run.sent[1]!.messages).map(
      (result) => result.text.split("\n")[0],
    );
    expect(told).toEqual([
      "Not submitted. Fix these and call submit_frame again:",
    ]);
    expect(seen).toEqual([["checks"]]);
  } finally {
    await opened.harness.close(context);
  }
});

// Guards the fourth label: a passing submission answered with the step's advice is `advised`.
test("a submission answered with advice is advised, and the next one accepted", async () => {
  const { run, seen } = await recorded("submissions-advised", 6, (step) => ({
    ...step,
    spec: { ...step.spec, advise: () => ["consider a better answer"] },
  }));
  run.script.push(submitting(5, "submit-1"), submitting(5, "submit-2"));
  const opened = await run.open();
  try {
    const id = await run.start(opened);
    await opened.harness.resume();
    const record = await settled(opened.harness, id);
    expect(record.agentResult?.status).toBe("submitted");
    expect(
      toolResults(run.sent[1]!.messages).map((result) =>
        result.text.startsWith("Not submitted yet."),
      ),
    ).toEqual([true]);
    expect(seen).toEqual([["advised", "accepted"]]);
  } finally {
    await opened.harness.close(context);
  }
});

// Guards a call the submit tool never answered: in a round the cut-off aborted before the submit
// tool ran, the call has no stored answer and no label; the answered one before it keeps its own.
test("a submit call in a round the cut-off aborted gets no label", async () => {
  const kept: Seen = [];
  const hold = defineTool({
    name: "hold",
    description: "Waits until it is stopped.",
    input: z.strictObject({}),
    hints: RECORDS,
    handle: () => Effect.never,
  });
  const { run } = await recorded("submissions-aborted", 6, (step) => ({
    ...step,
    spec: { ...step.spec, tools: [...step.spec.tools, hold] },
    partial: (summary) => {
      kept.push(summary.submissions);
      return { status: "interrupted", output: null };
    },
  }));
  run.script.push(submitting(0, "submit-1"), () =>
    fauxAssistantMessage(
      [
        fauxToolCall("hold", {}, { id: "hold-1" }),
        fauxToolCall("submit_frame", { answer: 5 }, { id: "submit-2" }),
      ],
      { stopReason: "toolUse" },
    ),
  );
  const opened = await run.open();
  try {
    const id = await run.start(opened, Date.now() + 2_000);
    await opened.harness.resume();
    const done = await opened.harness.waitForTask(id, context);
    expect(done.state.outcome.status).toBe("aborted");
    expect(run.sent).toHaveLength(2);
    expect(kept).toEqual([["checks"]]);
  } finally {
    await opened.harness.close(context);
  }
}, 30_000);

// Guards the final phase's labels against a check that reads tool state across a resume: the
// labels are the refusals the resumed final phase sent, never a judgement made again at the end.
test("a resumed final phase with a check that reads tool state lists the refusals it sent", async () => {
  const { run, seen } = await recorded(
    "submissions-final-state",
    1,
    needsProbe7,
  );
  let release: () => void = () => {};
  const closing = new Promise<void>((resolve) => {
    release = resolve;
  });
  run.script.push(probing(7, "probe-1"));
  run.script.push(async (_sent, signal) => {
    release();
    await new Promise((_resolve, reject) =>
      signal?.addEventListener("abort", () => reject(new Error("cancelled"))),
    );
    return fauxAssistantMessage("never");
  });
  const first = await run.open();
  const id = await run.start(first);
  await first.harness.resume();
  await closing;
  await first.harness.close(context);

  run.script.length = 0;
  for (let i = 0; i < 3; i++) run.script.push(answering('{"answer":5}'));
  const second = await run.open();
  try {
    await second.harness.resume();
    const record = await settled(second.harness, id);
    expect(record.agentResult?.status).toBe("backstop");
    // Two refusals reached the model as refusal prompts; the third answer ended the step.
    const prompts = run.sent
      .at(-1)!
      .messages.filter(
        (message) =>
          message.role === "user" &&
          JSON.stringify(message).includes("[harness: output refused]"),
      );
    expect(prompts).toHaveLength(2);
    expect(seen).toEqual([["checks", "checks", "checks"]]);
  } finally {
    await second.harness.close(context);
  }
});

// Guards an older stored conversation: an answer stored without a label (as a build before the
// label stored it) still reads, the step goes on, and that call has no entry in the list.
test("an answer stored without a label reads, and that call has no entry", async () => {
  const { run, seen } = await recorded("submissions-older-doc");
  let release: () => void = () => {};
  const closing = new Promise<void>((resolve) => {
    release = resolve;
  });
  run.script.push(submitting(0, "submit-1"));
  run.script.push(async (_sent, signal) => {
    release();
    await new Promise((_resolve, reject) =>
      signal?.addEventListener("abort", () => reject(new Error("cancelled"))),
    );
    return fauxAssistantMessage("never");
  });
  const first = await run.open();
  const id = await run.start(first);
  await first.harness.resume();
  await closing;
  // What an older build stored for the call: its text and whether it ended the round only.
  const conversationId = await agentConversation(first.harness);
  const stored = await first.harness.commit(async (tx) => {
    const doc = await tx.doc(AgentContextDoc, conversationId);
    const applied = doc.applied["submit-1"]!;
    doc.applied["submit-1"] = {
      text: applied.text,
      terminate: applied.terminate,
    };
    return applied.submission;
  }, context);
  expect(stored).toBe("checks");
  await first.harness.close(context);

  run.script.length = 0;
  run.script.push(submitting(5, "submit-2"));
  const second = await run.open();
  try {
    await second.harness.resume();
    const record = await settled(second.harness, id);
    expect(record.agentResult?.status).toBe("submitted");
    expect(seen).toEqual([["accepted"]]);
  } finally {
    await second.harness.close(context);
  }
});
