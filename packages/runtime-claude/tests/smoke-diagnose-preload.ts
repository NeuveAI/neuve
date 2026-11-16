import { expect, mock } from "bun:test";
import { Cause, Context, Effect, Exit, Layer, Scope, Stream } from "effect";
import { ClaudeExecutable, ClaudeProcess, ClaudeSdk } from "../src/services.ts";
import { AccountName, TurnFailed } from "@neuve/runtime";
import { messageCollector } from "../src/messages.ts";
import { smokeRuntime, toolOutputObservation } from "../src/smoke-runtime.ts";
import { replay } from "./replay.ts";
import { diagnoseFixture } from "./smoke-diagnose-fixture.ts";

const mode = Bun.argv[5] ?? "clean";
const fixture = diagnoseFixture(mode);
let injected = false;
const injectFault = () => {
  if (!injected && new Error().stack?.includes("smoke-diagnose.ts")) {
    injected = true;
    throw new Error("private-observer-error");
  }
};
if (mode === "observerEventThrow") {
  const fromEntries = Object.fromEntries;
  Object.fromEntries = (...args: Parameters<typeof Object.fromEntries>) => {
    if (!new Error().stack?.includes("partial")) injectFault();
    return fromEntries(...args);
  };
}
if (mode === "observerOfferedThrow") {
  const makeSmoke = smokeRuntime;
  mock.module("../src/smoke-runtime.ts", () => ({
    toolOutputObservation,
    smokeRuntime: (...args: Parameters<typeof smokeRuntime>) =>
      makeSmoke(args[0], {
        ...args[1],
        offered: (message) =>
          args[1].offered(
            new Proxy(message, {
              get(target, property, receiver) {
                if (property === "uuid") injectFault();
                return Reflect.get(target, property, receiver);
              },
            }),
          ),
      }),
  }));
}
if (mode === "observerThrow" || mode === "observerBeginThrow") {
  const collect = messageCollector;
  let thrown = false;
  let diagnosticCollectors = 0;
  mock.module("../src/messages.ts", () => ({
    messageCollector: (...args: Parameters<typeof messageCollector>) => {
      if (
        mode === "observerBeginThrow" &&
        new Error().stack?.includes("smoke-diagnose.ts") &&
        ++diagnosticCollectors === 5
      )
        injectFault();
      const collector = collect(...args);
      return {
        ...collector,
        isPublishedFrame: (
          frame: Parameters<typeof collector.isPublishedFrame>[0],
        ) => {
          if (mode === "observerThrow" && !thrown) {
            thrown = true;
            throw new Error("private-observer-error");
          }
          return collector.isPublishedFrame(frame);
        },
      };
    },
  }));
}
const startFails = [
  "startFail",
  "startTimeout",
  "startInterrupt",
  "unsafeFailure",
].includes(mode);
if (
  startFails ||
  [
    "missingFinish",
    "finalStartFail",
    "probeFail",
    "openFail",
    "freshFail",
  ].includes(mode)
) {
  const makeSmoke = smokeRuntime;
  const failure = () =>
    mode === "startTimeout"
      ? Effect.fail(new Cause.TimeoutError("private-start-error"))
      : mode === "startInterrupt"
        ? Effect.interrupt
        : mode === "unsafeFailure"
          ? Effect.fail({
              _tag: "private failure tag!",
              reason: "private failure reason!",
              message: "private failure message!",
            })
          : Effect.fail(
              Object.defineProperty(
                new TurnFailed({
                  account: AccountName.parse("default"),
                  reason: "previous-turn-active",
                }),
                "message",
                { value: "private-start-error" },
              ),
            );
  let opens = 0;
  mock.module("../src/smoke-runtime.ts", () => ({
    toolOutputObservation,
    smokeRuntime: (...args: Parameters<typeof smokeRuntime>) =>
      makeSmoke(...args).pipe(
        Effect.map((runtime) => ({
          ...runtime,
          probe: mode === "probeFail" ? failure : runtime.probe,
          openSession: (...opening: Parameters<typeof runtime.openSession>) => {
            opens++;
            if (mode === "openFail" || (mode === "freshFail" && opens === 3))
              return failure();
            return runtime.openSession(...opening).pipe(
              Effect.map((session) => ({
                ...session,
                startTurn: (input: Parameters<typeof session.startTurn>[0]) =>
                  startFails || (mode === "finalStartFail" && input.final)
                    ? failure()
                    : session.startTurn(input),
                events:
                  mode === "missingFinish"
                    ? session.events.pipe(
                        Stream.takeWhile(
                          (event) => event.type !== "turn.finished",
                        ),
                      )
                    : session.events,
              })),
            );
          },
        })),
      ),
  }));
}
const scope = Effect.runSync(Scope.make());
const context = Effect.runSync(
  Layer.buildWithScope(replay(fixture.entries).layer, scope),
);
process.once("beforeExit", () => Effect.runSync(Scope.close(scope, Exit.void)));
mock.module("../src/production.ts", () => ({
  executableLayer: Layer.succeed(ClaudeExecutable, {
    resolve: () => Effect.succeed("/test/claude"),
  }),
  processLayer: Layer.succeed(ClaudeProcess, {
    run: () => Effect.die("No process allowed"),
  }),
  sdkLayer: Layer.succeed(ClaudeSdk, Context.get(context, ClaudeSdk)),
}));
const print = console.log;
console.log = (line: string) => {
  if (
    [
      "observerEventThrow",
      "observerBeginThrow",
      "observerOfferedThrow",
    ].includes(mode)
  )
    expect(injected).toBe(true);
  // Reason: check even the fresh outgoing UUIDs against the actual printed JSON line.
  for (const value of fixture.privateValues) expect(line).not.toContain(value);
  print(line);
};
