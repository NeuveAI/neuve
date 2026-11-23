// The shared fixture drives the actual pi stage task, tool registrations and durable conversations.
import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
  type Message,
} from "@earendil-works/pi-ai";
import type {
  Harness,
  TaskId,
  ConversationId,
} from "@earendil-works/pi-durable";
import { Effect, Exit, Scope } from "effect";
import { z } from "zod";
import { Blobs, Computations, readData } from "@neuve/records-core";
import { routeFailureDiagnostic } from "../src/pi/providers/failure.ts";
import {
  defaultConfig,
  keyedStub,
  PipelineConfig,
  runConfig,
  turnLimitFor,
} from "../src/config.ts";
import { stepInput, stageRun } from "../src/pi/stages/run.ts";
import { AgentStepInput } from "../src/pi/stages/agent-step.ts";
import { outputOf } from "../src/pi/review-task.ts";
import { storedOutput, type StageRecord } from "../src/pipeline.ts";
import {
  RunControlDoc,
  admitResume,
  credentialLost,
} from "../src/pi/control.ts";
import { AgentContextDoc, RunToolsDoc } from "../src/pi/stages/docs.ts";
import {
  agentConversation,
  world,
  toolResults,
  settled,
  systemOf,
} from "./pi/stages/fixture.ts";
import { agentRoutes } from "../src/pi/bindings.ts";
import { routeByName } from "../src/route.ts";
type Reply = Parameters<Awaited<ReturnType<typeof world>>["script"]["push"]>[0];

test("a null where a value is required is refused before the tool runs, and three refused submissions end the context at the backstop", async () => {
  const run = await world("required-null");
  // Three rounds, each a probe and a submission whose required fields are null.
  for (let round = 1; round <= 3; round++)
    run.script.push(() =>
      fauxAssistantMessage(
        [
          fauxToolCall("probe", { n: null }, { id: `probe-${round}` }),
          fauxToolCall(
            "submit_frame",
            { answer: null },
            { id: `submit-${round}` },
          ),
        ],
        { stopReason: "toolUse" },
      ),
    );
  const opened = await run.open();
  const id = await run.start(opened);
  await opened.harness.resume();
  const record = await settled(opened.harness, id);

  // pi coerces a required null into 0 when it validates; zod refused the call first, so the
  // probe's own code never ran.
  expect(run.probes).toEqual([]);
  // The third refused submission ends the context: no fourth request, and the backstop answers.
  expect(run.sent.length).toBe(3);
  expect(record.status).toBe("computed");
  expect(record.agentResult?.status).toBe("backstop");
  expect(record.agentResult?.turnsUsed).toBe(3);
  // Each refusal reached the model, in call order, as a tool error naming zod's complaint.
  const seen = toolResults(run.sent[2]!.messages);
  expect(seen.map((result) => [result.name, result.error])).toEqual([
    ["probe", true],
    ["submit_frame", true],
    ["probe", true],
    ["submit_frame", true],
  ]);
  expect(seen[0]!.text).toContain(
    "probe n takes an integer and received null.",
  );
  expect(
    run.ctx.log
      .read()
      .filter((entry) => entry.type === "gap")
      .map((entry) => entry["kind"]),
  ).toContain("invalid-submissions");
  await opened.harness.close(context);
});

test("three submissions that fail the checks end the context with code's repair of the last, through the tools' own answers", async () => {
  const run = await world("repair");
  for (let round = 1; round <= 3; round++)
    run.script.push(() =>
      fauxAssistantMessage(
        [
          fauxToolCall(
            "submit_frame",
            { answer: 0 },
            { id: `submit-${round}` },
          ),
        ],
        { stopReason: "toolUse" },
      ),
    );
  const opened = await run.open();
  const id = await run.start(opened);
  await opened.harness.resume();
  const record = await settled(opened.harness, id);

  expect(run.sent.length).toBe(3);
  // The first two were answered with the check's problem, as the agent saw them.
  const seen = toolResults(run.sent[2]!.messages);
  expect(seen.map((result) => result.text.split("\n")[0])).toEqual([
    "Not submitted. Fix these and call submit_frame again:",
    "Not submitted. Fix these and call submit_frame again:",
  ]);
  expect(record.agentResult?.status).toBe("submitted");
  expect(
    run.ctx.log
      .read()
      .filter((entry) => entry.type === "gap")
      .map((entry) => entry["kind"]),
  ).toContain("output-repaired");
  await opened.harness.close(context);
});

test("a round that reads and submits ends at the accepted submission, with strict nulls dropped and a nullable null kept", async () => {
  const run = await world("mixed-round");
  run.script.push(() =>
    fauxAssistantMessage(
      [
        fauxToolCall("probe", { n: 4 }, { id: "probe-1" }),
        // Strict sampling writes null for every optional field; the weight accepts null itself.
        fauxToolCall(
          "submit_frame",
          { answer: 5, note: null, parts: [{ label: null, weight: null }] },
          { id: "submit-1" },
        ),
      ],
      { stopReason: "toolUse" },
    ),
  );
  const opened = await run.open();
  const id = await run.start(opened);
  await opened.harness.resume();
  const record = await settled(opened.harness, id);

  expect(run.sent.length).toBe(1);
  expect(run.probes).toEqual([{ n: 4 }]);
  expect(record.agentResult?.status).toBe("submitted");
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
        : (JSON.parse(new TextDecoder().decode(read.bytes)) as {
            output: { output: unknown };
          });
    }).pipe(Effect.provide(run.ctx.records)),
  );
  expect(stored?.output.output).toEqual({
    answer: 5,
    parts: [{ weight: null }],
  });
  await opened.harness.close(context);
});

test("a step closed mid-context reopens on its conversation with the same prompt, tools, handles and final mode, counting nothing twice", async () => {
  const run = await world("reopen", 2);
  let release: () => void = () => {};
  const closing = new Promise<void>((resolve) => {
    release = resolve;
  });
  run.script.push(() =>
    fauxAssistantMessage([fauxToolCall("probe", { n: 1 }, { id: "probe-1" })], {
      stopReason: "toolUse",
      responseId: "r1",
    }),
  );
  // The second request is in flight when the harness closes: its answer never comes.
  run.script.push(async (_sent, signal) => {
    release();
    // Answers only when the closing harness cancels it, as a provider's stream does.
    await new Promise((_resolve, reject) =>
      signal?.addEventListener("abort", () => reject(new Error("cancelled"))),
    );
    return fauxAssistantMessage("never");
  });
  const first = await run.open();
  const id = await run.start(first);
  await first.harness.resume();
  await closing;
  const before = await first.harness.getTask(id, context);
  const conversationId = (
    before?.state as { checkpoint?: { conversationId?: number } }
  ).checkpoint?.conversationId as ConversationId;
  const handlesBefore = (
    await first.harness.snapshot(AgentContextDoc, conversationId, context)
  )?.state;
  await first.harness.close(context);

  // Reopen: a new process's registry, models and agent objects over the same file.
  run.script.length = 0;
  run.script.push(() =>
    fauxAssistantMessage([fauxToolCall("probe", { n: 2 }, { id: "probe-2" })], {
      stopReason: "toolUse",
      responseId: "r2",
    }),
  );
  run.script.push(() =>
    fauxAssistantMessage(
      [fauxText(JSON.stringify({ answer: 7, note: null }))],
      {
        stopReason: "stop",
        responseId: "r3",
      },
    ),
  );
  const second = await run.open();
  const tools = await second.harness.snapshot(RunToolsDoc, context);
  expect(Object.keys(tools?.kinds ?? {})).toEqual(["frame"]);
  await second.harness.resume();
  const record = await settled(second.harness, id);

  // Requests: probe 1, the one cut by the close, its resend, then the final generation.
  expect(run.sent.length).toBe(4);
  const [cut, resent, final] = [run.sent[1]!, run.sent[2]!, run.sent[3]!];
  // The same system prompt and offered tools, schemas included, before and after the reopen.
  expect(systemOf(resent.messages)).toEqual(systemOf(cut.messages));
  expect(JSON.stringify(systemOf(resent.messages))).toContain(
    "SYSTEM-MARK-7f3",
  );
  expect(
    systemOf(resent.messages)?.toolsAdded?.map((tool) => tool.name),
  ).toEqual(["probe", "vent", "submit_frame"]);
  // The task was submitted once: it appears once in every request.
  const userTexts = (messages: ReadonlyArray<Message>) =>
    messages.filter(
      (message) =>
        message.role === "user" &&
        JSON.stringify(message).includes("TASK-MARK-91c"),
    );
  expect(userTexts(resent.messages).length).toBe(1);
  // The turn limit reached at turn 2 leads to the final generation, dispatched in final mode with
  // the submit tool's schema.
  expect(cut.mode.kind).toBe("normal");
  expect(final.mode.kind).toBe("final");
  expect(JSON.stringify(final.mode)).toContain('"answer"');
  expect(record.agentResult?.status).toBe("final-generation");
  expect(record.agentResult?.endedBy).toBe("turn-limit");
  // The handles the first process's probe recorded are the state the reopened one went on from.
  const after = (
    await second.harness.snapshot(AgentContextDoc, conversationId, context)
  )?.state;
  expect(JSON.stringify(handlesBefore)).toContain('"p1"');
  expect(JSON.stringify(after)).toContain('"p1"');
  expect(JSON.stringify(after)).toContain('"p2"');
  // One binding for the one conversation, and each answered response counted once.
  expect(
    run.events.filter((event) => event.type === "session.bind").length,
  ).toBe(1);
  const calls = run.ctx.log
    .read()
    .filter((entry) => entry.type === "model.call");
  expect(calls.map((entry) => entry["responseId"])).toEqual(["r1", "r2", "r3"]);
  expect(calls.map((entry) => entry["kind"])).toEqual([
    "turn",
    "turn",
    "final",
  ]);
  await second.harness.close(context);
});

test("a call the provider refused holds the step with the route's typed failure through a close and reopen, and a resume sends the same request with nothing new", async () => {
  const run = await world("held");
  run.script.push((): AssistantMessage => ({
    ...fauxAssistantMessage([], {
      stopReason: "error",
      errorMessage: "OpenAI API error (HTTP 401): invalid_api_key",
    }),
    diagnostics: [
      routeFailureDiagnostic({ kind: "auth", status: 401 }, Date.now()),
    ],
  }));
  const heldIn = async (harness: Harness, id: TaskId<StageRecord>) => {
    const watch = await harness.watchTaskGraph(context);
    try {
      await new Promise<void>((resolve) => {
        const check = () => {
          const state = watch.value?.tasks[String(id)]?.state;
          if (
            state !== undefined &&
            "phase" in state &&
            state.phase === "provider-held"
          )
            resolve();
        };
        check();
        watch.start(async () => check());
      });
    } finally {
      await watch.stop();
    }
    const task = await harness.getTask(id, context);
    return task?.state.status === "running" ? task.state.checkpoint : undefined;
  };
  const first = await run.open();
  const id = await run.start(first);
  first.harness.resume();
  const held = await heldIn(first.harness, id);
  expect(held).toMatchObject({ failure: { kind: "auth", status: 401 } });
  // Explicit credential loss, rather than a crash, authorizes recovery on a later claim.
  await credentialLost(first.harness, context);
  // The host closes a held run without aborting it, keeping its database.
  await first.harness.close(context);

  const second = await run.open();
  const control = await second.harness.snapshot(RunControlDoc, context);
  expect(Object.keys(control?.held ?? {})).toEqual([String(id)]);
  // The run control the host reads holds the route's typed failure, not only its text.
  expect(control?.held[String(id)]?.failure).toEqual({
    kind: "auth",
    status: 401,
    code: null,
  });
  run.script.push(() =>
    fauxAssistantMessage(
      [fauxToolCall("submit_frame", { answer: 3 }, { id: "submit-1" })],
      { stopReason: "toolUse" },
    ),
  );
  // The next claim's nonce, admitted before scheduling resumes, as the host does.
  expect(await admitResume(second.harness, "claim-2", context)).toBe(
    "committed",
  );
  second.harness.resume();
  const record = await settled(second.harness, id);
  expect(record.agentResult?.status).toBe("submitted");
  expect(run.sent.length).toBe(2);
  expect(run.ctx.log.read()).toContainEqual(
    expect.objectContaining({
      type: "span",
      name: "harness.pi.phase",
      attributes: expect.objectContaining({ "harness.phase": "provider-held" }),
    }),
  );
  // The resend is the failed request again: the same messages, then pi-durable's empty resume
  // input, which pi-ai's converters drop from the wire (held-resume-proof); no new text.
  const resent = run.sent[1]!.messages;
  expect(resent.slice(0, -1)).toEqual([...run.sent[0]!.messages]);
  expect(resent.at(-1)).toMatchObject({ role: "user", content: [] });
  expect((await second.harness.snapshot(RunControlDoc, context))?.held).toEqual(
    {},
  );
  await second.harness.close(context);
});

test("a step stopped by its owner before the cut-off ends as aborted, and one the cut-off reaches ends as cut off", async () => {
  /** A reply that answers only when its request is cancelled, as a provider's stream does. */
  const blocked =
    (started: () => void): Reply =>
    async (_sent, signal) => {
      started();
      await new Promise((_resolve, reject) =>
        signal?.addEventListener("abort", () => reject(new Error("cancelled"))),
      );
      return fauxAssistantMessage("never");
    };
  const outcomeOf = async (harness: Harness, id: TaskId<StageRecord>) =>
    (await harness.waitForTask(id, context)).state.outcome;

  // The owner stops the run while the step's first call is in flight, long before its cut-off.
  const stopped = await world("owner-stop");
  let inFlight: () => void = () => {};
  const requested = new Promise<void>((resolve) => {
    inFlight = resolve;
  });
  stopped.script.push(blocked(() => inFlight()));
  const a = await stopped.open();
  const first = await stopped.start(a);
  a.harness.resume();
  await requested;
  await a.harness.abortTask(first, context);
  const early = await outcomeOf(a.harness, first);
  expect(early.status).toBe("aborted");
  expect(early.status === "aborted" ? early.reason : undefined).toBe("aborted");
  expect(early.status === "aborted" ? early.result?.status : undefined).toBe(
    "interrupted",
  );
  expect(early.status === "aborted" ? early.result?.note : "").toContain(
    "before the run's cut-off",
  );
  expect(
    stopped.events.flatMap((event) =>
      event.type === "stage.end" ? [event.status] : [],
    ),
  ).toEqual(["aborted"]);
  await a.harness.close(context);

  // The run's cut-off passes while the step's first call is in flight.
  const late = await world("cut-off");
  late.script.push(blocked(() => {}));
  const b = await late.open();
  const second = await late.start(b, Date.now() + 300);
  b.harness.resume();
  const cut = await outcomeOf(b.harness, second);
  expect(cut.status).toBe("aborted");
  expect(cut.status === "aborted" ? cut.reason : undefined).toBe("cutoff");
  expect(cut.status === "aborted" ? cut.result?.note : "").toContain("cut-off");
  expect(
    late.events.flatMap((event) =>
      event.type === "stage.end" ? [event.status] : [],
    ),
  ).toEqual(["cutoff"]);
  await b.harness.close(context);
});

test("agent steps make their model calls concurrently: three contexts' first requests are in flight at once", async () => {
  // The stages never serialise contexts: each is its own task and conversation, and pi runs them
  // in parallel. How many calls the run may have in flight is the runtime's dispatch limit.
  const run = await world("concurrent", 6, true);
  let inFlight = 0;
  let most = 0;
  let arrived: () => void = () => {};
  const all = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  for (let index = 0; index < 3; index++)
    run.script.push(async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      if (inFlight === 3) arrived();
      // Each answer waits until all three requests are in flight, or fails the test.
      await Promise.race([
        all,
        new Promise((_resolve, reject) =>
          setTimeout(
            () => reject(new Error(`only ${inFlight} request(s) in flight`)),
            5_000,
          ),
        ),
      ]);
      inFlight -= 1;
      return fauxAssistantMessage(
        [
          fauxToolCall(
            "submit_frame",
            { answer: 2 },
            { id: `submit-${index}` },
          ),
        ],
        { stopReason: "toolUse" },
      );
    });
  const opened = await run.open();
  const ids = [
    await run.start(opened),
    await run.start(opened),
    await run.start(opened),
  ];
  opened.harness.resume();
  const records = await Promise.all(
    ids.map((id) => settled(opened.harness, id)),
  );
  expect(most).toBe(3);
  expect(run.sent.length).toBe(3);
  expect(records.map((record) => record.agentResult?.status)).toEqual([
    "submitted",
    "submitted",
    "submitted",
  ]);
  // Each context was bound to its own agent and conversation.
  const binds = run.events.flatMap((event) =>
    event.type === "session.bind" ? [event.scope] : [],
  );
  expect(new Set(binds.map((scope) => scope.agent)).size).toBe(3);
  expect(new Set(binds.map((scope) => scope.conversationId)).size).toBe(3);
  await opened.harness.close(context);
});

test("a trusted code backstop runs once and may be smaller than the model submission schema", async () => {
  const run = await world("trusted-backstop", 1, false, true);
  run.script.push(
    ...Array.from(
      { length: 4 },
      () => () => fauxAssistantMessage("no submission"),
    ),
  );
  const opened = await run.open();
  const id = await run.start(opened);
  opened.harness.resume();
  const record = await settled(opened.harness, id);
  expect(record.agentResult?.status).toBe("backstop");
  const output = await Effect.runPromise(
    storedOutput(
      run.ctx,
      record.key!,
      z.strictObject({ status: z.string(), output: z.unknown() }),
    ),
  );
  expect(output).toEqual({ status: "backstop", output: { answer: 0 } });
  expect(run.backstops).toEqual([0]);
  await opened.harness.close(context);
});

test("the actual stub hold records its phase name", async () => {
  const run = await world("named-stub-hold");
  run.ctx.config.stub = { hold: { stage: "frame", seconds: 1 } };
  run.script.push(() =>
    fauxAssistantMessage([fauxToolCall("submit_frame", { answer: 7 })], {
      stopReason: "toolUse",
    }),
  );
  const opened = await run.open();
  try {
    const id = await run.start(opened);
    await opened.harness.resume();
    await settled(opened.harness, id);
    expect(run.ctx.log.read()).toContainEqual(
      expect.objectContaining({
        type: "span",
        name: "harness.pi.phase",
        attributes: expect.objectContaining({ "harness.phase": "stub-hold" }),
      }),
    );
  } finally {
    await opened.harness.close(context);
  }
});

// Why (readers round 14): the test hold is a first run's timing seam only. A follow-on's request
// copies its request's payload, hold included, so the run's configuration drops the hold past
// generation 0 (`runConfig`): a held first run is cut at its cut-off, and its follow-on, under the
// same keys, runs the same step unheld and completes.
test("a held first run is cut at its cut-off; its follow-on runs the step unheld and completes", async () => {
  const run = await world("held-then-follow-on");
  const held = PipelineConfig.parse({
    ...run.ctx.config,
    stub: { hold: { stage: "frame", seconds: 600 }, turnLimit: 6 },
  });
  run.ctx.config = runConfig(held, 0);
  expect(run.ctx.config.stub?.hold).toEqual({ stage: "frame", seconds: 600 });
  const first = await run.open();
  try {
    const id = await run.start(first, Date.now() + 1_500);
    await first.harness.resume();
    // Held to its cut-off: the step ends cut, with its interrupted record, and asks no model.
    const ended = await first.harness.waitForTask(id, context);
    expect(ended.state.outcome).toMatchObject({
      status: "aborted",
      reason: "cutoff",
      result: { status: "interrupted" },
    });
    expect(run.sent).toHaveLength(0);
  } finally {
    await first.harness.close(context);
  }
  // Generation 1 of the same run key: unheld, every other stub setting kept, the same keys.
  run.ctx.config = runConfig(held, 1);
  expect(run.ctx.config.stub).toEqual({ turnLimit: 6 });
  expect(keyedStub(run.ctx.config.stub)).toEqual(keyedStub(held.stub));
  run.script.push(() =>
    fauxAssistantMessage([fauxToolCall("submit_frame", { answer: 7 })], {
      stopReason: "toolUse",
    }),
  );
  const next = await run.open();
  try {
    const id = await run.start(next);
    await next.harness.resume();
    const record = await settled(next.harness, id);
    expect(record.status).toBe("computed");
    expect(run.sent).toHaveLength(1);
    expect(
      run.ctx.log
        .read()
        .filter((r) => r.type === "span" && r["name"] === "harness.pi.phase")
        .filter(
          (r) =>
            (r["attributes"] as Record<string, unknown>)["harness.task_id"] ===
              id &&
            (r["attributes"] as Record<string, unknown>)["harness.phase"] ===
              "stub-hold",
        ),
    ).toEqual([]);
  } finally {
    await next.harness.close(context);
  }
  // Without a hold, every generation's configuration is the one its request froze.
  const plain = defaultConfig();
  expect(runConfig(plain, 3)).toBe(plain);
});

// Why: per-step retry limits must stop the native tool round and the final-generation policy
// at the same boundary. A smaller retry setting must survive the shared agent type erasure.
test("a step can disable invalid-submission retries", async () => {
  const run = await world("zero-retries");
  run.policy.retries = 0;
  run.script.push(() =>
    fauxAssistantMessage([fauxToolCall("submit_frame", { answer: null })], {
      stopReason: "toolUse",
    }),
  );
  const opened = await run.open();
  try {
    const id = await run.start(opened);
    const record = await settled(opened.harness, id);
    expect(run.sent).toHaveLength(1);
    expect(record.agentResult?.status).toBe("backstop");
  } finally {
    await opened.harness.close(context);
  }
});

test("one retry repairs the second invalid submission without another model call", async () => {
  const run = await world("one-retry");
  run.policy.retries = 1;
  for (let i = 0; i < 2; i++)
    run.script.push(() =>
      fauxAssistantMessage([fauxToolCall("submit_frame", { answer: 0 })], {
        stopReason: "toolUse",
      }),
    );
  const opened = await run.open();
  try {
    const id = await run.start(opened);
    const record = await settled(opened.harness, id);
    expect(run.sent).toHaveLength(2);
    expect(record.agentResult?.status).toBe("submitted");
    expect(
      await Effect.runPromise(storedOutput(run.ctx, record.key!, z.unknown())),
    ).toEqual({ status: record.agentResult?.status, output: { answer: 1 } });
  } finally {
    await opened.harness.close(context);
  }
});

test("one retry also bounds invalid final-generation answers", async () => {
  const run = await world("one-final-retry", 1);
  run.policy.retries = 1;
  run.script.push(() => fauxAssistantMessage("read the evidence"));
  for (let i = 0; i < 2; i++)
    run.script.push(() => fauxAssistantMessage('{"answer":0}'));
  const opened = await run.open();
  try {
    const id = await run.start(opened);
    const record = await settled(opened.harness, id);
    expect(run.sent).toHaveLength(3);
    expect(record.agentResult?.status).toBe("final-generation");
    expect(
      await Effect.runPromise(storedOutput(run.ctx, record.key!, z.unknown())),
    ).toEqual({ status: record.agentResult?.status, output: { answer: 1 } });
  } finally {
    await opened.harness.close(context);
  }
});

// Why: pi otherwise continues tool calls inside its generation without returning to the step.
test("a deadline reached between tool turns enters the final generation with timeout", async () => {
  const run = await world("step-deadline", 11);
  run.script.push(() =>
    fauxAssistantMessage([fauxToolCall("probe", { n: 1 })], {
      stopReason: "toolUse",
    }),
  );
  run.script.push(() => fauxAssistantMessage('{"answer":7}'));
  const opened = await run.open();
  try {
    const id = await run.start(opened, Date.now() + 60_000, 0);
    const record = await settled(opened.harness, id);
    expect(run.probes).toEqual([{ n: 1 }]);
    expect(run.sent).toHaveLength(2);
    expect(record.agentResult).toMatchObject({
      endedBy: "timeout",
      status: "final-generation",
      modelCalls: 2,
    });
  } finally {
    await opened.harness.close(context);
  }
});

// Why: interrupted outputs have an envelope, while code stages store their value directly.
test("outputOf reads computed, reused and interrupted outputs and ignores missing work", async () => {
  const run = await world("output-of");
  try {
    const store = async (op: string, value: unknown) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const computations = yield* Computations.ComputationStore;
          return yield* computations.run(
            { op, opVersion: 1, inputs: {} },
            Effect.succeed({
              bytes: new TextEncoder().encode(JSON.stringify(value)),
              mediaType: "application/json",
            }),
          );
        }).pipe(Effect.provide(run.ctx.records)),
      );
    const raw = (await store("test.raw-output", { answer: 7 })).computation.key;
    const envelope = (
      await store("test.partial-output", {
        output: { answer: 8 },
        summary: null,
      })
    ).computation.key;
    const read = (status: StageRecord["status"], key?: string) =>
      Effect.runPromise(
        outputOf(
          {
            stage: "frame",
            status,
            wallMs: 0,
            ...(key === undefined ? {} : { key }),
          },
          z.strictObject({ answer: z.int() }),
        ).pipe(Effect.provide(run.ctx.records)),
      );
    expect(await read("computed", raw)).toEqual({ answer: 7 });
    expect(await read("reused", envelope)).toEqual({ answer: 8 });
    expect(await read("interrupted", envelope)).toEqual({ answer: 8 });
    expect(await read("skipped", raw)).toBeUndefined();
    expect(await read("interrupted")).toBeUndefined();
  } finally {
    await Effect.runPromise(Scope.close(run.scope, Exit.succeed(undefined)));
  }
});

// Why: old frozen requests must still parse after the task graph changes its stage registry.
test("old optional turn-limit keys decode while the new stages use their defaults", () => {
  const current = defaultConfig();
  expect(current.budgets.turnLimits).toEqual({
    frame: 1,
    map: 1,
    find: 11,
    verify: 1,
  });
  const legacy = PipelineConfig.parse({
    ...current,
    budgets: {
      ...current.budgets,
      turnLimits: {
        understand: 35,
        investigate: 35,
        assemble: 40,
        dispose: 15,
        merge: 20,
      },
    },
  });
  expect([
    turnLimitFor(legacy, "frame"),
    turnLimitFor(legacy, "map"),
    turnLimitFor(legacy, "find"),
    turnLimitFor(legacy, "verify"),
  ]).toEqual([1, 1, 11, 1]);
});

// Why: the front task's durable children must get their own contract deadlines automatically.
test("frame and map step inputs freeze their deadline when created", () => {
  const before = Date.now();
  const frame = stepInput("frame", {}, before + 550_000);
  const map = stepInput(
    "map",
    { frame: "frame", manifest: "manifest" },
    before + 550_000,
  );
  const after = Date.now();
  expect(frame.deadline).toBeGreaterThanOrEqual(before + 90_000);
  expect(frame.deadline).toBeLessThanOrEqual(after + 90_000);
  expect(map.deadline).toBeGreaterThanOrEqual(before + 120_000);
  expect(map.deadline).toBeLessThanOrEqual(after + 120_000);
  expect(stepInput("frame", {}, before + 550_000, 44).deadline).toBe(44);
});

// Why: a crash after emitting a duration but before the terminal commit replays finalization.
test("replayed agent finalization writes its stage span only once", async () => {
  const run = await world("replay-finalize");
  run.policy.replayFinalize = true;
  run.script.push(() =>
    fauxAssistantMessage([fauxToolCall("submit_frame", { answer: 7 })], {
      stopReason: "toolUse",
    }),
  );
  const opened = await run.open();
  try {
    const id = await run.start(opened);
    await opened.harness.resume();
    const record = await settled(opened.harness, id);
    expect(record.agentResult?.status).toBe("submitted");
    expect(run.finalizationReplays()).toBe(1);
    expect(run.sent).toHaveLength(1);
    expect(
      run.ctx.log
        .read()
        .filter(
          (entry) =>
            entry.type === "span" && entry["name"] === "harness.stage.frame",
        ),
    ).toHaveLength(1);
  } finally {
    await opened.harness.close(context);
  }
});

// Newer task parameters must resume through the kind-specific reader, while producers stay strict.
test("stored scope-change params prepare with additive keys and still require known fields", async () => {
  const run = await world("newer-params");
  const opened = await run.open();
  try {
    const id = await run.start(opened);
    const change = {
      source: "fixture",
      title: "Fixture",
      fromSha: "a".repeat(64),
      toSha: "b".repeat(64),
      region: { line: 1, before: "old", after: "new" },
      future: true,
    };
    const runner = () =>
      stageRun({
        ctx: run.ctx,
        run: async () => {
          throw new Error("unexpected effect execution");
        },
      });
    const input = readData(AgentStepInput, {
      kind: "scope-change",
      params: { change },
      cutoffAt: Date.now() + 60_000,
    });
    const prepared = await runner().prepare(id, input, opened.harness, context);
    expect(prepared.step.spec.agent).toBe("frame.scope-change.fixture");
    expect(input.params).toEqual({ change });
    await expect(
      runner().prepare(
        id,
        { ...input, params: { change: { source: "fixture", future: true } } },
        opened.harness,
        context,
      ),
    ).rejects.toThrow();
    expect(() =>
      stepInput("scope-change", { change }, input.cutoffAt),
    ).toThrow();
    expect(run.sent).toEqual([]);
  } finally {
    await opened.harness.close(context);
  }
});

// Reason: a step's requests follow its effort only if the agent step task hands that effort to the
// conversation's route binding, from the step's own `effort` or from its kind in `route.stepEffort`.
test("the agent step binds its conversation at the step's own effort, else its kind's", async () => {
  const boundAt = async (
    name: string,
    set: (run: Awaited<ReturnType<typeof world>>) => void,
  ) => {
    const run = await world(name);
    set(run);
    run.script.push(() =>
      fauxAssistantMessage([fauxToolCall("submit_frame", { answer: 7 })], {
        stopReason: "toolUse",
      }),
    );
    const opened = await run.open();
    try {
      await settled(opened.harness, await run.start(opened));
      const binding = await agentRoutes({
        harness: opened.harness,
        models: createModels(),
        runId: run.ctx.runId,
        createProvider: () => {
          throw new Error("reading a binding builds no provider");
        },
      }).readBinding(await agentConversation(opened.harness), context);
      return "effort" in binding ? binding.effort : "none";
    } finally {
      await opened.harness.close(context);
    }
  };
  // The fixture's route is the Anthropic one, at medium.
  expect(
    await boundAt("effort-own", (run) => {
      run.policy.effort = "high";
    }),
  ).toBe("high");
  expect(
    await boundAt("effort-kind", (run) => {
      run.ctx.config.route = routeByName("anthropic", undefined, undefined, {
        frame: "low",
      });
    }),
  ).toBe("low");
  expect(await boundAt("effort-none", () => {})).toBe("none");
});
