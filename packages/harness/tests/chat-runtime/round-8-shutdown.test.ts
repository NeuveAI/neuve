import { expect, test } from "bun:test";
import { Effect } from "effect";
import { TurnFailed } from "@neuve/runtime";
import { account, fixture, until } from "./fixture.ts";

// Worker shutdown must join an acquisition's existing finalization, rather than treating a closed scope as drained.
test("worker close awaits resources already finalizing after an unsuccessful acquisition", async () => {
  const gate = Promise.withResolvers<void>();
  let finalizing = false;
  let released = false;
  const run = await fixture({
    registry: (registry) => ({
      ...registry,
      openSession: (...args) =>
        Effect.gen(function* () {
          yield* registry.openSession(...args);
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              finalizing = true;
              await gate.promise;
              released = true;
            }),
          );
          return yield* new TurnFailed({
            account: account().name,
            reason: "provider-failed",
          });
        }),
    }),
  });
  const work = run.submit("first");
  let closeReturned = false;
  let closing: Promise<void> | undefined;
  try {
    await until(() => finalizing);
    closing = run.bridge.close().then(() => {
      closeReturned = true;
    });
    await Bun.sleep(25);
    expect(closeReturned).toBe(false);
    expect(released).toBe(false);
    expect(run.fake.opened[0]?.session.closed).toBe(0);
  } finally {
    gate.resolve();
    await closing;
    await work;
    await run.close();
    await until(() => released && run.fake.opened[0]?.session.closed === 1);
  }
});
