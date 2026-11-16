import { Deferred, Effect } from "effect";
import { AccountName, TurnLimit } from "../../src/index.ts";
import {
  AccountStore,
  RuntimeRegistry,
  fakeRuntime,
  provideRegistry,
} from "./fixtures.ts";

// A separate process keeps only the store's record watch. stdin holds its finalizer
// until the parent proves that remove returned without waiting on this process.
const home = process.argv[2];
if (home === undefined) throw new Error("scratch home argument required");
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const store = yield* AccountStore.make(home);
      const closed = yield* Deferred.make<void>();
      const base = fakeRuntime({ calls: [] });
      const runtime = {
        ...base,
        openSession: (...args: Parameters<typeof base.openSession>) =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                console.log("session-finalizer");
                yield* Effect.promise(() => Bun.stdin.text());
                yield* Deferred.succeed(closed, undefined);
              }),
            );
            return yield* base.openSession(...args);
          }),
      };
      yield* Effect.gen(function* () {
        const registry = yield* RuntimeRegistry;
        yield* registry.openSession(AccountName.parse("work"), {
          systemPrompt: "fake",
          tools: [],
          turnLimit: TurnLimit.parse(1),
          approvalPolicy: "allow",
        });
        console.log("ready");
        yield* Deferred.await(closed);
      }).pipe(Effect.provide(provideRegistry(store, [runtime])));
    }),
  ),
);
