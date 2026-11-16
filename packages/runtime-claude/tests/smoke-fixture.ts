import { Account } from "@neuve/runtime";
import { Effect, Layer, type Scope } from "effect";
import { makeRuntime } from "../src/runtime.ts";
import {
  observeSmokeSdk,
  type ToolOutputObservation,
  type SmokeRuntime,
} from "../src/smoke-runtime.ts";
import { ClaudeExecutable, ClaudeProcess, ClaudeSdk } from "../src/services.ts";
import { SESSION_ID } from "./frames.ts";
import { replay, type Entry } from "./replay.ts";

export const account = Account.parse({
  name: "test",
  kind: "claude-subscription",
  runtime: "claude-code",
  credential: { kind: "claude-config-folder" },
});

export const runReplay = <A, E>(
  entries: readonly Entry[],
  body: (runtime: SmokeRuntime) => Effect.Effect<A, E, Scope.Scope>,
  observation?: ToolOutputObservation,
) => {
  const fake = replay(entries);
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sdk = yield* ClaudeSdk;
        const runtime = yield* makeRuntime({
          cwd: "/test",
          environment: {},
          identity: { sessionId: SESSION_ID },
        }).pipe(
          Effect.provideService(
            ClaudeSdk,
            observation === undefined ? sdk : observeSmokeSdk(sdk, observation),
          ),
        );
        return yield* body(runtime);
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          fake.layer,
          Layer.succeed(ClaudeExecutable, {
            resolve: () => Effect.succeed("/test/claude"),
          }),
          Layer.succeed(ClaudeProcess, {
            run: () => Effect.die("No process allowed"),
          }),
        ),
      ),
      Effect.timeout("3 seconds"),
    ),
  );
};
