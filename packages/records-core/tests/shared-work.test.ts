import { expect, test } from "bun:test";
import { Effect } from "effect";
import { KeyHeld, SharedWork, type SharedOutcome } from "../src/shared-work.ts";
import {
  sharedWorkEffect,
  InsideSharedWorkGrant,
} from "../src/shared-work-effect.ts";

// Subscriber ownership must be independent of which caller created the run.
test("all callers subscribe in arrival order and one cancellation leaves the other running", async () => {
  const work = new SharedWork<number, string>();
  const gate = Promise.withResolvers<SharedOutcome<number, string>>();
  const began = Promise.withResolvers<void>();
  let executions = 0;
  const controller = new AbortController();
  let running: AbortSignal | undefined;
  const options = {
    scope: "store",
    key: "key",
    run: (signal: AbortSignal) => {
      running = signal;
      executions++;
      began.resolve();
      return gate.promise;
    },
  };
  const first = work.run({ ...options, signal: controller.signal });
  const observed = first.catch(() => "cancelled");
  const order: number[] = [];
  const second = work.run(options).then((result) => {
    order.push(2);
    return result;
  });
  const third = work.run(options).then((result) => {
    order.push(3);
    return result;
  });
  await began.promise;
  controller.abort();
  expect(await observed).toBe("cancelled");
  expect(running?.aborted).toBe(false);
  gate.resolve({ kind: "failed", error: "typed-cause" });
  expect((await second).outcome).toEqual({
    kind: "failed",
    error: "typed-cause",
  });
  expect((await third).outcome).toEqual({
    kind: "failed",
    error: "typed-cause",
  });
  expect(order).toEqual([2, 3]);
  expect(executions).toBe(1);
  expect(
    (
      await work.run({
        ...options,
        run: async () => ({ kind: "succeeded", value: 2 }),
      })
    ).outcome,
  ).toEqual({ kind: "succeeded", value: 2 });
});

// The last subscriber cancels work, while an explicit keep-running request preserves it.
for (const keepRunning of [false, true])
  test(`last subscriber cancellation, keepRunning=${keepRunning}`, async () => {
    const work = new SharedWork<void>();
    const began = Promise.withResolvers<AbortSignal>();
    const end = Promise.withResolvers<void>();
    const controller = new AbortController();
    const pending = work
      .run({
        scope: "s",
        key: "k",
        signal: controller.signal,
        keepRunning,
        run: async (signal) => {
          began.resolve(signal);
          await end.promise;
          return { kind: "succeeded", value: undefined };
        },
      })
      .catch(() => {});
    const signal = await began.promise;
    controller.abort();
    await pending;
    expect(signal.aborted).toBe(!keepRunning);
    end.resolve();
  });

// A grant holder cannot enter a wait cycle through another caller in its own process.
test("Effect marker fails fast with KeyHeld and recorded failures use the typed channel", async () => {
  const work = new SharedWork<number, string>();
  const began = Promise.withResolvers<void>();
  const end = Promise.withResolvers<void>();
  const first = work.run({
    scope: "s",
    key: "k",
    run: async () => {
      began.resolve();
      await end.promise;
      return { kind: "succeeded", value: 1 };
    },
  });
  await began.promise;
  const held = await Effect.runPromise(
    Effect.flip(
      sharedWorkEffect(work, {
        scope: "s",
        key: "k",
        run: () => Effect.succeed({ kind: "succeeded", value: 2 }),
      }).pipe(Effect.provideService(InsideSharedWorkGrant, true)),
    ),
  );
  expect(held).toBeInstanceOf(KeyHeld);
  end.resolve();
  await first;
  expect(
    await Effect.runPromise(
      Effect.flip(
        sharedWorkEffect(work, {
          scope: "s",
          key: "k",
          run: () => Effect.succeed({ kind: "failed", error: "typed" }),
        }),
      ),
    ),
  ).toBe("typed");
});

// Scopes and input/version keys must partition active work without retaining completed entries.
test("scope and key isolation", async () => {
  const work = new SharedWork<number>();
  let calls = 0;
  const run = async () => ({ kind: "succeeded", value: ++calls }) as const;
  const results = await Promise.all([
    work.run({ scope: "a", key: "v1:x", run }),
    work.run({ scope: "b", key: "v1:x", run }),
    work.run({ scope: "a", key: "v2:x", run }),
    work.run({ scope: "a", key: "v1:y", run }),
  ]);
  expect(results.map((r) => r.outcome)).toEqual(
    [1, 2, 3, 4].map((value) => ({ kind: "succeeded", value })),
  );
});

// Receipts and spans must disclose floor execution rather than treating transport loss as a failure.
test("Effect records floor role and reason on the requesting span", async () => {
  const { Tracer } = await import("effect");
  const spans: Array<ReturnType<typeof Tracer.nativeTracer.span>> = [];
  const tracer = Tracer.make({
    span(options) {
      const span = Tracer.nativeTracer.span(options);
      spans.push(span);
      return span;
    },
  });
  const work = new SharedWork<number>();
  const result = await Effect.runPromise(
    sharedWorkEffect(work, {
      scope: "s",
      key: "k",
      run: () =>
        Effect.succeed({
          publication: "floor",
          outcome: { kind: "succeeded", value: 7 },
        }),
      crossProcess: {
        store: "s",
        read: async () => undefined,
        transport: {
          claim: async () => ({ kind: "floor", reason: "unreachable" }),
        },
      },
    }).pipe(Effect.withTracer(tracer)),
  );
  expect(result).toEqual({ value: 7, floor: "unreachable" });
  expect(
    spans
      .find((span) => span.name === "records.shared-work")
      ?.attributes.get("shared_work.role"),
  ).toBe("floor");
  expect(
    spans
      .find((span) => span.name === "records.shared-work")
      ?.attributes.get("shared_work.floor"),
  ).toBe("unreachable");
});

// Browser callers must import the Promise helper without pulling in platform modules.
test("Promise entry point bundles for browsers", async () => {
  const build = await Bun.build({
    entrypoints: [`${import.meta.dir}/../src/shared-work.ts`],
    target: "browser",
  });
  expect(build.success).toBe(true);
  expect(build.outputs).toHaveLength(1);
});

// A fresh caller must not inherit another caller's already cancelled execution.
test("a fresh in-process caller after cancellation gets its own live attempt", async () => {
  const work = new SharedWork<number>();
  const controller = new AbortController();
  let executions = 0;
  const options = {
    scope: "store",
    key: "key",
    run: async (): Promise<SharedOutcome<number, never>> => ({
      kind: "succeeded",
      value: ++executions,
    }),
  };
  const old = work
    .run({ ...options, signal: controller.signal })
    .catch(() => undefined);
  controller.abort();
  const fresh = work.run(options).then(
    (result) => ({ kind: "result", result }),
    (error: Error) => ({ kind: "rejected", name: error.name }),
  );
  await old;
  const observed = await fresh;
  console.info(
    JSON.stringify({ case: "fresh-local-after-cancel", observed, executions }),
  );
  expect(observed).toEqual({
    kind: "result",
    result: { outcome: { kind: "succeeded", value: 1 } },
  });
  expect(executions).toBe(1);
});
