// Why: both clocks must apply the same exact cut-off without changing reuse, composition or durable holds.
import { expect, spyOn, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Harness, TaskId } from "@earendil-works/pi-durable";
import { Clock, Duration, Effect, Exit, Scope } from "effect";
import { Computations } from "@neuve/records-core";
import { z } from "zod";
import {
  AgentStored,
  codeStage,
  cutoffAt,
  guard,
  storedBytes,
  storedOutput,
  withRecords,
  type StageRecord,
} from "../src/pipeline.ts";
import {
  cutoffNotes,
  cutoffReached,
  stageStartPolicy,
} from "../src/stage-policy.ts";
import { settled, world } from "./pi/stages/fixture.ts";

const clockAt = (
  read: () => number,
  advance: (ms: number) => void,
): Clock.Clock => ({
  currentTimeMillisUnsafe: read,
  currentTimeMillis: Effect.sync(read),
  currentTimeNanosUnsafe: () => BigInt(read()) * 1_000_000n,
  currentTimeNanos: Effect.sync(() => BigInt(read()) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => BigInt(read()) * 1_000_000n,
  monotonicTimeNanos: Effect.sync(() => BigInt(read()) * 1_000_000n),
  sleep: (duration) => Effect.sync(() => advance(Duration.toMillis(duration))),
});
const spec = (id: string) => ({
  op: `test.stage-policy.${id}`,
  opVersion: 1,
  inputs: {},
  config: {},
});

test("admission keeps exact equality, stored reuse, afterCutoff and incumbent hold selection", () => {
  const input = {
    now: 999,
    cutoffAt: 1000,
    stored: false,
    afterCutoff: false,
    holdable: true,
    stage: "map",
    hold: { stage: "map", seconds: 1 },
  } satisfies Parameters<typeof stageStartPolicy>[0];
  expect(stageStartPolicy(input)).toEqual({ kind: "start", holdMs: 1 });
  expect(stageStartPolicy({ ...input, now: 1000 })).toEqual({ kind: "skip" });
  expect(stageStartPolicy({ ...input, now: 1001, stored: true })).toEqual({
    kind: "start",
    holdMs: undefined,
  });
  expect(stageStartPolicy({ ...input, now: 1000, afterCutoff: true })).toEqual({
    kind: "start",
    holdMs: undefined,
  });
  expect(stageStartPolicy({ ...input, now: 1001, afterCutoff: true })).toEqual({
    kind: "start",
    holdMs: undefined,
  });
  expect(stageStartPolicy({ ...input, holdable: false })).toEqual({
    kind: "start",
    holdMs: undefined,
  });
  expect(
    stageStartPolicy({
      ...input,
      hold: { ...input.hold, at: "before-commit" },
    }),
  ).toEqual({ kind: "start", holdMs: undefined });
  expect(
    stageStartPolicy({
      ...input,
      hold: { ...input.hold, stage: "frame" },
    }),
  ).toEqual({ kind: "start", holdMs: undefined });
  expect([
    cutoffReached(999, 1000),
    cutoffReached(1000, 1000),
    cutoffReached(1001, 1000),
  ]).toEqual([false, true, true]);
});

test("the actual Effect guard skips at equality but reuses stored work and composes after cut-off", async () => {
  const run = await world("effect-cutoff-policy");
  let now = 1000;
  const clock = clockAt(
    () => now,
    (ms) => {
      now += ms;
    },
  );
  run.ctx.startedAt = now - run.ctx.config.budgets.cutoffMs;
  const deadline = cutoffAt(run.ctx);
  // A run frozen with the older 15-second margin still reserves today's publication window.
  run.ctx.config.budgets.cutoffMs = 585_000;
  expect(cutoffAt(run.ctx)).toBe(deadline);
  const execute = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.runPromise(effect.pipe(Effect.provideService(Clock.Clock, clock)));
  try {
    let computed = 0;
    const skipped = await execute(
      guard(
        run.ctx,
        "map",
        "agent",
        spec("skip"),
        Effect.sync(() => {
          computed++;
          return {
            stage: "map" as const,
            status: "computed" as const,
            wallMs: 0,
          };
        }),
      ),
    );
    expect(skipped).toMatchObject({
      status: "skipped",
      wallMs: 0,
      note: cutoffNotes.skipped,
    });
    expect(computed).toBe(0);
    const first = await execute(
      codeStage(
        run.ctx,
        "map",
        spec("reuse"),
        Effect.sync(() => {
          computed++;
          return { answer: 7 };
        }),
        { afterCutoff: true },
      ),
    );
    expect(first.status).toBe("computed");
    now++;
    const reused = await execute(
      codeStage(
        run.ctx,
        "map",
        spec("reuse"),
        Effect.sync(() => {
          computed++;
          return { answer: 99 };
        }),
      ),
    );
    expect(reused.status).toBe("reused");
    expect(computed).toBe(1);
    const composed = await execute(
      codeStage(
        run.ctx,
        "map",
        spec("composition"),
        Effect.succeed({ composed: true }),
        { afterCutoff: true, agent: "composition" },
      ),
    );
    expect(composed.status).toBe("computed");
    expect(cutoffAt(run.ctx)).toBe(deadline);
  } finally {
    await Effect.runPromise(Scope.close(run.scope, Exit.void));
  }
});

test("the actual Effect hold stops at equality with the original disclosure and wall time", async () => {
  const run = await world("effect-stub-policy");
  let now = 1000;
  run.ctx.startedAt = 1100 - run.ctx.config.budgets.cutoffMs;
  run.ctx.config.stub = { hold: { stage: "map", seconds: 1 } };
  let ran = false;
  try {
    const result = await Effect.runPromise(
      guard(
        run.ctx,
        "map",
        "held",
        spec("hold"),
        Effect.sync(() => {
          ran = true;
          return {
            stage: "map" as const,
            status: "computed" as const,
            wallMs: 0,
          };
        }),
      ).pipe(
        Effect.provideService(
          Clock.Clock,
          clockAt(
            () => now,
            (ms) => {
              now += ms;
            },
          ),
        ),
      ),
    );
    expect(result).toMatchObject({
      status: "interrupted",
      wallMs: 100,
      note: cutoffNotes.held,
    });
    expect(ran).toBe(false);
    expect(now).toBe(1100);
  } finally {
    await Effect.runPromise(Scope.close(run.scope, Exit.void));
  }
});

test("the actual native agent task also skips at exact equality without dispatch", async () => {
  const run = await world("native-equality-policy");
  const now = Date.now();
  const time = spyOn(Date, "now").mockReturnValue(now);
  let opened: Awaited<ReturnType<typeof run.open>> | undefined;
  try {
    opened = await run.open();
    const id = await run.start(opened, now);
    opened.harness.resume();
    expect(await settled(opened.harness, id)).toMatchObject({
      status: "skipped",
      wallMs: 0,
      note: cutoffNotes.skipped,
    });
    expect(run.sent).toEqual([]);
  } finally {
    await opened?.harness.close(context);
    time.mockRestore();
    await Effect.runPromise(Scope.close(run.scope, Exit.void));
  }
});

const heldCheckpoint = (harness: Harness, id: TaskId<StageRecord>) => {
  const ready = Promise.withResolvers<{ startedAt: number; until: number }>();
  const shape = z.object({
    phase: z.literal("stub-hold"),
    startedAt: z.number(),
    until: z.number(),
  });
  const off = harness.subscribeCommits((publication) => {
    for (const change of publication.changes)
      if (
        change.type === "task" &&
        change.value.id === Number(id) &&
        change.value.state.status === "running"
      ) {
        const parsed = shape.safeParse(change.value.state.checkpoint);
        if (parsed.success) {
          off();
          ready.resolve(parsed.data);
        }
      }
  });
  return ready.promise;
};

test("native stub close/reopen retains its original hold and cut-off, then dispatches once", async () => {
  const run = await world("native-stub-resume-policy");
  run.ctx.config.stub = { hold: { stage: "frame", seconds: 1 } };
  run.script.push(() =>
    fauxAssistantMessage(
      [fauxToolCall("submit_frame", { answer: 3 }, { id: "submit-policy" })],
      { stopReason: "toolUse" },
    ),
  );
  let opened = await run.open();
  try {
    const deadline = Date.now() + 10_000;
    const id = await run.start(opened, deadline);
    const held = heldCheckpoint(opened.harness, id);
    opened.harness.resume();
    const checkpoint = await held;
    expect(run.sent).toEqual([]);
    await opened.harness.close(context);
    opened = await run.open();
    const restored = await opened.harness.getTask(id, context);
    expect(restored?.state.checkpoint).toEqual({
      phase: "stub-hold",
      ...checkpoint,
    });
    expect(restored?.input).toMatchObject({ cutoffAt: deadline });
    opened.harness.resume();
    const computed = await settled(opened.harness, id);
    expect(computed.status).toBe("computed");
    expect(run.sent).toHaveLength(1);
    const reused = await run.start(opened, 0);
    expect(await settled(opened.harness, reused)).toMatchObject({
      status: "reused",
      key: computed.key,
      wallMs: 0,
    });
    expect(run.sent).toHaveLength(1);
  } finally {
    await opened.harness.close(context);
    await Effect.runPromise(Scope.close(run.scope, Exit.void));
  }
});

test("native stub cancellation preserves the stopped-before-start outcome without dispatch", async () => {
  const run = await world("native-stub-cancel-policy");
  run.ctx.config.stub = { hold: { stage: "frame", seconds: 10 } };
  const opened = await run.open();
  try {
    const id = await run.start(opened, Date.now() + 20_000);
    const held = heldCheckpoint(opened.harness, id);
    opened.harness.resume();
    await held;
    await opened.harness.abortTask(id, context);
    const outcome = (await opened.harness.waitForTask(id, context)).state
      .outcome;
    expect(outcome).toMatchObject({
      status: "aborted",
      reason: "aborted",
      result: {
        status: "interrupted",
        note: "stopped before it started: its run was stopped; nothing is stored",
      },
    });
    expect(run.sent).toEqual([]);
  } finally {
    await opened.harness.close(context);
    await Effect.runPromise(Scope.close(run.scope, Exit.void));
  }
});

test("the shared stored reader keeps full agent envelopes distinct from unwrapped outputs", async () => {
  const run = await world("stored-envelope-policy");
  const envelope = {
    output: { answer: 7 },
    summary: { status: "submitted" },
    context: { planned: { input: 3 } },
  };
  try {
    const stored = await Effect.runPromise(
      withRecords(
        run.ctx,
        Effect.gen(function* () {
          const store = yield* Computations.ComputationStore;
          return yield* store.run(
            spec("envelope"),
            Effect.succeed({
              bytes: new TextEncoder().encode(JSON.stringify(envelope)),
              mediaType: "application/json",
            }),
          );
        }),
      ),
    );
    const bytes = await Effect.runPromise(
      storedBytes(run.ctx, stored.computation.key),
    );
    expect(
      AgentStored.parse(JSON.parse(new TextDecoder().decode(bytes))),
    ).toEqual(envelope);
    expect(
      await Effect.runPromise(
        storedOutput(
          run.ctx,
          stored.computation.key,
          z.object({ answer: z.number() }),
        ),
      ),
    ).toEqual({ answer: 7 });
    await expect(
      Effect.runPromise(storedBytes(run.ctx, "0".repeat(64))),
    ).rejects.toThrow();
    await expect(
      Effect.runPromise(
        storedOutput(
          run.ctx,
          stored.computation.key,
          z.object({ missing: z.string() }),
        ),
      ),
    ).rejects.toThrow();
  } finally {
    await Effect.runPromise(Scope.close(run.scope, Exit.void));
  }
});
