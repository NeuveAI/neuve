// Why: the shared Graph service runs two reads at once, but the harness let one Graph call run at
// a time, so a hunk's search waited about 30 s behind the one before it (the measured window of 24
// October 2026). The harness now uses as many slots as the service runs reads while it answers,
// one when it is off, and keeps waited-on calls first; a capacity that never opened, or one that
// stayed at two after the service went away, would pass every other test.
import { expect, test } from "bun:test";
import { Deferred, Effect, Fiber } from "effect";
import { slotsForTests as slots } from "../src/graph-search.ts";

const holding = (
  started: Array<string>,
  name: string,
  release: Deferred.Deferred<void>,
  urgent = () => true,
) =>
  slots.withSlot(urgent)(
    Effect.andThen(
      Effect.sync(() => started.push(name)),
      Deferred.await(release),
    ),
  );

test("the slots follow the service: two calls at once while it answers, one when it is off, waited-on first", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const started: Array<string> = [];
      const gates = {
        a: yield* Deferred.make<void>(),
        b: yield* Deferred.make<void>(),
        c: yield* Deferred.make<void>(),
        d: yield* Deferred.make<void>(),
      };
      // The service is off: one at a time.
      slots.observeService(false);
      const a = yield* Effect.forkChild(holding(started, "a", gates.a));
      const b = yield* Effect.forkChild(holding(started, "b", gates.b));
      yield* Effect.sleep("20 millis");
      expect(started).toEqual(["a"]);
      // The service answers: a second slot opens for the waiter at once.
      slots.observeService(true);
      yield* Effect.sleep("20 millis");
      expect(started).toEqual(["a", "b"]);
      expect(slots.state()).toMatchObject({ inUse: 2, capacity: 2 });
      // Both busy: background work waits behind a later waited-on call.
      const c = yield* Effect.forkChild(
        holding(started, "c", gates.c, () => false),
      );
      const d = yield* Effect.forkChild(holding(started, "d", gates.d));
      yield* Effect.sleep("20 millis");
      yield* Deferred.succeed(gates.a, undefined);
      yield* Fiber.join(a);
      yield* Effect.sleep("20 millis");
      expect(started).toEqual(["a", "b", "d"]);
      // The service goes away: no new call starts until only one is running.
      slots.observeService(false);
      yield* Deferred.succeed(gates.b, undefined);
      yield* Fiber.join(b);
      yield* Effect.sleep("20 millis");
      expect(started).toEqual(["a", "b", "d"]);
      yield* Deferred.succeed(gates.d, undefined);
      yield* Fiber.join(d);
      yield* Effect.sleep("20 millis");
      expect(started).toEqual(["a", "b", "d", "c"]);
      yield* Deferred.succeed(gates.c, undefined);
      yield* Fiber.join(c);
      expect(slots.state()).toEqual({ inUse: 0, capacity: 1, waiting: 0 });
    }),
  );
});
