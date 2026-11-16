// Why: the production agent step must be one run per key with two callers (record 0016), through
// pi's own generation tasks, which a resumed run restarts by themselves. Each case says what it
// guards:
// 1. A step that starts while another caller holds its key waits, makes no model request, and
//    ends `reused` with the holder's output. A cold waiter must not call the model.
// 2. A step resumed while another caller holds its key sends no model request and runs no tool
//    while it waits, then ends `reused`. Before the dispatch gate, pi ran the resumed
//    conversation to its end beside the holder (the reviewer measured 5 requests, 4 tool calls).
// 3. A waiter behind a holder that held or was interrupted (it released the claim) claims again
//    and runs its own conversation. Giving a claim up is no verdict on the work, so the waiter
//    must not fail.
// 4. A waiter behind a holder whose work failed ends failed with the holder's own retryability,
//    retryable and not. A waiter must neither stop on what its holder retries nor retry what it
//    stops on.
// 5. A single caller's resume sends the same requests as before this change (on `03709d6d`), with
//    a real claim host: the step claims, its gate opens, and pi's restarted request goes out as
//    it did. The gate must not change one caller's run.
//
// The production step, its kind extension and route bindings run on a real pi harness over SQLite
// (`pi/stages/fixture.ts`), with a real Records store and a real budget host in this file's own
// directory under TMPDIR. The other caller is a separate process: `step-claim.test.ts`'s child.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type Message,
} from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import { z } from "zod";
import { Computations } from "@neuve/records-core";
import { hostBudget } from "../src/budget/local.ts";
import { agentStageSpec, type StageRecord } from "../src/pipeline.ts";
import { INTERRUPTED } from "../src/pi/stages/step-claim.ts";
import { world } from "./pi/stages/fixture.ts";

const root = mkdtempSync(join(tmpdir(), "pi-stage-agent-claim-"));
const budget = join(root, "budget");
mkdirSync(budget, { mode: 0o700 });
const previous = process.env.NEUVE_BUDGET_DIRECTORY;
// The step's store transport finds the claim host through this variable, as a worker's does.
process.env.NEUVE_BUDGET_DIRECTORY = budget;
const host = await hostBudget({ directory: budget, threads: 2, fixed: 4 });
if (!host) throw new Error("budget host missing");
await host.claims.ready;
const children: Array<{ readonly stop: () => Promise<void> }> = [];
afterAll(async () => {
  await Promise.all(children.map((child) => child.stop()));
  await host.close();
  if (previous === undefined) delete process.env.NEUVE_BUDGET_DIRECTORY;
  else process.env.NEUVE_BUDGET_DIRECTORY = previous;
  rmSync(root, { recursive: true, force: true });
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const Event = z.object({
  event: z.string(),
  kind: z.string().optional(),
  role: z.string().optional(),
  status: z.string().optional(),
});
type Event = z.infer<typeof Event>;

/** Another caller of the step's key in its own process, with its own store connection. */
const otherCaller = (location: string, spec: Computations.ComputationSpec) => {
  const events: Event[] = [];
  const listeners = new Set<() => void>();
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "step-claim.test.ts"),
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        TMPDIR: root,
        NEUVE_BUDGET_DIRECTORY: budget,
        NEUVE_STEP_CLAIM_CHILD: JSON.stringify({ location, spec }),
      },
    },
  );
  const reading = (async () => {
    let buffer = "";
    for await (const chunk of child.stdout) {
      buffer += new TextDecoder().decode(chunk);
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const parsed = Event.safeParse(JSON.parse(line));
          if (parsed.success) events.push(parsed.data);
        } catch {}
        for (const listener of listeners) listener();
      }
    }
  })();
  const wait = (predicate: (event: Event) => boolean, after = 0) =>
    new Promise<Event>((resolve, reject) => {
      const inspect = () => {
        const found = events.slice(after).find(predicate);
        if (found) {
          listeners.delete(inspect);
          resolve(found);
        }
      };
      listeners.add(inspect);
      inspect();
      void child.exited.then(async (code) => {
        await reading;
        if (listeners.delete(inspect))
          reject(
            new Error(
              `caller exited ${code}; ${JSON.stringify(events)}; ${await new Response(child.stderr).text()}`,
            ),
          );
      });
    });
  const send = (command: object) => {
    child.stdin.write(`${JSON.stringify({ task: 1, ...command })}\n`);
    child.stdin.flush();
  };
  const handle = {
    ready: wait((event) => event.event === "ready"),
    /** Claims the key; a claim another caller just released is claimed again. */
    hold: async () => {
      for (;;) {
        const after = events.length;
        send({ op: "begin" });
        const answer = await wait((event) => event.event === "answer", after);
        if (answer.kind === "holder") return;
        if (answer.kind !== "released")
          throw new Error(`the other caller got ${JSON.stringify(answer)}`);
      }
    },
    settle: async (value: string) => {
      const after = events.length;
      send({ op: "settle", value });
      return wait((event) => event.event === "settled", after);
    },
    fail: async (ending: {
      readonly tag: string;
      readonly message: string;
      readonly retryable: boolean;
      readonly released?: boolean;
    }) => {
      const after = events.length;
      send({ op: "fail", ...ending });
      return wait((event) => event.event === "ended", after);
    },
    stop: async () => {
      child.kill("SIGKILL");
      await child.exited;
      await reading;
    },
  };
  children.push(handle);
  return handle;
};

/** A run, its step's key, and another caller already holding that key. */
const contested = async (name: string) => {
  const run = await world(name, 6);
  const { step } = run.agentFor();
  const spec = agentStageSpec(run.ctx.config, step.spec, {
    op: step.op,
    opVersion: step.opVersion,
    inputs: step.inputs as Record<string, unknown>,
  });
  const other = otherCaller(run.root, spec);
  await other.ready;
  const attempts = () => {
    const database = new Database(run.ctx.location.database);
    database.run("PRAGMA busy_timeout = 5000");
    try {
      return database
        .query(
          "SELECT outcome, error_tag AS tag FROM computation_attempts WHERE key = ? ORDER BY n",
        )
        .all(Computations.computationKey(spec).key);
    } finally {
      database.close();
    }
  };
  return { run, other, attempts };
};

/** What another run stored under the key: the stage's envelope (`AgentStored`). */
const storedByOther = JSON.stringify({
  output: { status: "submitted", output: { answer: 3 } },
  summary: null,
  context: {},
});

const submit = (answer: number) => () =>
  fauxAssistantMessage(
    [
      fauxToolCall(
        "submit_frame",
        { answer, note: null, parts: null },
        { id: `submit-${answer}` },
      ),
    ],
    { stopReason: "toolUse", responseId: `r-submit-${answer}` },
  );

const outcomeOf = async (
  harness: Awaited<ReturnType<Awaited<ReturnType<typeof world>>["open"]>>,
  id: TaskId<StageRecord>,
) => (await harness.harness.waitForTask(id, context)).state.outcome;

test("a step that starts while another caller holds its key ends reused with no model request", async () => {
  const { run, other, attempts } = await contested("claim-cold");
  await other.hold();
  const opened = await run.open();
  const id = await run.start(opened);
  await opened.harness.resume();
  await pause(500);
  expect((await opened.harness.getTask(id, context))?.state.status).toBe(
    "running",
  );
  expect(run.sent.length).toBe(0);
  await other.settle(storedByOther);
  const outcome = await outcomeOf(opened, id);
  expect(outcome).toMatchObject({
    status: "completed",
    result: { status: "reused" },
  });
  expect(run.sent.length).toBe(0);
  expect(attempts()).toEqual([{ outcome: "succeeded", tag: null }]);
  await opened.harness.close(context);
}, 60_000);

test("a step resumed while another caller holds its key sends nothing and runs no tool while it waits", async () => {
  const { run, other, attempts } = await contested("claim-resumed");
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
  // The second request is in flight when the harness closes.
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
  const sentBefore = run.sent.length;
  const probesBefore = run.probes.length;
  expect([sentBefore, probesBefore]).toEqual([2, 1]);
  // Another review's step now holds the key (the closed run released it).
  await other.hold();
  // What pi would send if it ran the resumed conversation beside the holder.
  run.script.length = 0;
  for (const n of [2, 3, 4, 5])
    run.script.push(() =>
      fauxAssistantMessage(
        [fauxToolCall("probe", { n }, { id: `probe-${n}` })],
        { stopReason: "toolUse", responseId: `r${n}` },
      ),
    );
  run.script.push(submit(7));
  const second = await run.open();
  await second.harness.resume();
  await pause(1_500);
  expect((await second.harness.getTask(id, context))?.state.status).toBe(
    "running",
  );
  expect(run.sent.length - sentBefore).toBe(0);
  expect(run.probes.length - probesBefore).toBe(0);
  await other.settle(storedByOther);
  expect(await outcomeOf(second, id)).toMatchObject({
    status: "completed",
    result: { status: "reused" },
  });
  expect(run.sent.length - sentBefore).toBe(0);
  expect(run.probes.length - probesBefore).toBe(0);
  expect(attempts()).toEqual([
    { outcome: "failed", tag: INTERRUPTED },
    { outcome: "succeeded", tag: null },
  ]);
  await second.harness.close(context);
}, 60_000);

for (const [label, tag] of [
  ["held", "ModelError"],
  ["interrupted", INTERRUPTED],
] as const)
  test(`a waiter behind a holder that ${label} claims again and runs its own conversation`, async () => {
    const { run, other, attempts } = await contested(`claim-released-${label}`);
    await other.hold();
    run.script.push(submit(5));
    const opened = await run.open();
    const id = await run.start(opened);
    await opened.harness.resume();
    await pause(500);
    expect(run.sent.length).toBe(0);
    await other.fail({
      tag,
      message: `the other run ${label}`,
      retryable: true,
      released: true,
    });
    expect(await outcomeOf(opened, id)).toMatchObject({
      status: "completed",
      result: { status: "computed" },
    });
    expect(run.sent.length).toBe(1);
    expect(attempts()).toEqual([
      { outcome: "failed", tag },
      { outcome: "succeeded", tag: null },
    ]);
    await opened.harness.close(context);
  }, 60_000);

for (const [tag, retryable] of [
  ["ModelError", true],
  ["QuotaExhaustedError", false],
] as const)
  test(`a waiter behind a holder whose work failed (${tag}) fails with retryable ${retryable}`, async () => {
    const { run, other } = await contested(`claim-failed-${tag.toLowerCase()}`);
    await other.hold();
    const opened = await run.open();
    const id = await run.start(opened);
    await opened.harness.resume();
    await pause(500);
    await other.fail({ tag, message: `the other run: ${tag}`, retryable });
    const outcome = await outcomeOf(opened, id);
    expect(outcome.status).toBe("failed");
    expect(
      outcome.status === "failed" ? outcome.error.detail : undefined,
    ).toMatchObject({ tag, retryable });
    expect(run.sent.length).toBe(0);
    await opened.harness.close(context);
  }, 60_000);

/** Each request as the model got it: its mode, and its messages' roles and tool calls. */
const digest = (
  sent: ReadonlyArray<{
    readonly mode: { readonly kind: string };
    readonly messages: ReadonlyArray<Message>;
  }>,
) =>
  sent.map(({ mode, messages }) => ({
    mode: mode.kind,
    messages: messages.map((message) =>
      message.role === "assistant"
        ? `assistant:${message.content
            .flatMap((part) => (part.type === "toolCall" ? [part.id] : []))
            .join(",")}`
        : message.role === "toolResult"
          ? `toolResult:${message.toolCallId}`
          : message.role,
    ),
  }));

test("a single caller's resume sends the same requests as before the gate", async () => {
  const run = await world("claim-single-resume", 2);
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
  run.script.push(() =>
    fauxAssistantMessage([fauxToolCall("probe", { n: 2 }, { id: "probe-2" })], {
      stopReason: "toolUse",
      responseId: "r2",
    }),
  );
  run.script.push(() =>
    fauxAssistantMessage(
      [fauxText(JSON.stringify({ answer: 7, note: null }))],
      { stopReason: "stop", responseId: "r3" },
    ),
  );
  const second = await run.open();
  await second.harness.resume();
  const outcome = await outcomeOf(second, id);
  // Recorded from this same case run on `03709d6d`'s agent step, kinds and tools, before the claim
  // and its gate: probe 1, the request the close cut, its resend, then the final generation.
  expect(digest(run.sent)).toEqual(BEFORE_THE_GATE);
  expect(outcome).toMatchObject({
    status: "completed",
    result: { status: "computed" },
  });
  await second.harness.close(context);
}, 60_000);

const BEFORE_THE_GATE: ReturnType<typeof digest> = [
  {
    mode: "normal",
    messages: ["user", "system"],
  },
  {
    mode: "normal",
    messages: [
      "user",
      "system",
      "assistant:probe-1",
      "toolResult:probe-1",
      "user",
    ],
  },
  {
    mode: "normal",
    messages: [
      "user",
      "system",
      "assistant:probe-1",
      "toolResult:probe-1",
      "user",
    ],
  },
  {
    mode: "final",
    messages: [
      "user",
      "system",
      "assistant:probe-1",
      "toolResult:probe-1",
      "user",
      "assistant:probe-2",
      "toolResult:probe-2",
      "user",
    ],
  },
];
