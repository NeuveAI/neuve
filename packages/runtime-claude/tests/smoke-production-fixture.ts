import { expect, mock } from "bun:test";
import { Effect } from "effect";
import { ClaudeSdk } from "../src/services.ts";
let rejection: unknown;
let phase: "open" | "initializationResult" | "applyFlagSettings" =
  "initializationResult";
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  ORG_POLICY_LIMIT_PREFIXES: [],
  USAGE_LIMIT_ERROR_PREFIXES: [],
  query: () => {
    if (phase === "open") throw rejection;
    return {
      initializationResult: () => Promise.reject(rejection),
      applyFlagSettings: () => Promise.reject(rejection),
      close: () => {},
      [Symbol.asyncDispose]: async () => {},
    };
  },
}));
const { sdkLayer } = await import("../src/production.ts");
// Reason: the production error boundary must preserve typed exit facts without copying provider content or accepting malformed fields.
for (const method of [
  "open",
  "initializationResult",
  "applyFlagSettings",
] as const) {
  phase = method;
  for (const [raw, expected] of [
    [
      Object.assign(new Error("private multiline message"), {
        errorClass: "process_exited_nonzero",
        exitCode: 1,
        signal: "SIGTERM",
        token: "fixture-secret",
        path: "/private/fixture/path",
        telemetryMessage: "private multiline message",
      }),
      { errorClass: "process_exited_nonzero", exitCode: 1, signal: "SIGTERM" },
    ],
    [{ errorClass: "private error!", exitCode: 1.5, signal: "unknown" }, {}],
    [
      {
        get errorClass() {
          throw new Error("private multiline message");
        },
        exitCode: NaN,
        signal: "SIGTOOLONGGG",
      },
      {},
    ],
  ] as const) {
    rejection = raw;
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sdk = yield* ClaudeSdk;
          if (phase === "open") return yield* Effect.flip(sdk.open({}));
          const query = yield* sdk.open({});
          return yield* Effect.flip(
            phase === "initializationResult"
              ? query.initializationResult
              : query.applyFlagSettings({ effortLevel: null }),
          );
        }),
      ).pipe(Effect.provide(sdkLayer)),
    );
    expect(Object.fromEntries(Object.entries(error))).toEqual({
      _tag: "ClaudeSdkError",
      method,
      ...expected,
    });
    expect(error.message).not.toContain("private");
  }
}
console.log(JSON.stringify({ passed: 9 }));
