import { expect, test } from "bun:test";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { makeRuntime } from "../src/runtime.ts";
import { ClaudeSdk } from "../src/services.ts";
import { diagnoseObservation, diagnoseSmoke } from "../src/smoke-diagnose.ts";
import { observeSmokeSdk } from "../src/smoke-runtime.ts";
import { account } from "./smoke-fixture.ts";
import { openFixture, privateValues } from "./smoke-open-fixture.ts";

async function run(mode: string) {
  const fake = openFixture(mode);
  const observation = diagnoseObservation();
  const program = Effect.scoped(
    Effect.gen(function* () {
      const runtime = yield* makeRuntime({ cwd: "/test", environment: {} });
      return yield* diagnoseSmoke(
        mode === "effortUpdate"
          ? {
              ...runtime,
              openSession: (account, policy, selection) =>
                runtime.openSession(
                  account,
                  { ...policy, model: { id: "default", effort: "high" } },
                  selection,
                ),
            }
          : runtime,
        account,
        observation,
      );
    }),
  ).pipe(
    Effect.provideService(
      ClaudeSdk,
      observeSmokeSdk(
        fake.sdk,
        mode === "observerSdk"
          ? {
              ...observation,
              open: (options) => {
                const opening = observation.open(options);
                return opening === undefined
                  ? undefined
                  : {
                      ...opening,
                      stderr: () => {
                        throw new Error("fixture-secret");
                      },
                    };
              },
            }
          : observation,
      ),
    ),
    Effect.provide(fake.layers),
  );
  const value = await Effect.runPromise(
    mode === "timeout"
      ? Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(program);
          yield* Effect.promise(() => fake.entered);
          yield* TestClock.adjust("25 seconds");
          return yield* Fiber.join(fiber);
        }).pipe(Effect.provide(TestClock.layer()), Effect.timeout("2 seconds"))
      : program.pipe(Effect.timeout("2 seconds")),
  );
  expect(fake.closed).toBe(fake.opens - fake.failedSdkOpens);
  for (const secret of privateValues)
    expect(JSON.stringify(value)).not.toContain(secret);
  return { value: JSON.parse(JSON.stringify(value)), fake };
}

for (const step of [
  "initialization",
  "sdkOpen",
  "effortUpdate",
  "timeout",
] as const) {
  // Reason: the production adapter maps every failed open step to start-failed, so the observer must preserve the original step.
  test(`diagnose open step ${step}`, async () => {
    const { value } = await run(step);
    expect(value).toMatchObject({
      expectedRequests: 1,
      requestsStarted: 1,
      turns: {
        freshFinal: {
          outcome: "failed",
          step: "freshFinal",
          causeKind: "fail",
          errorTag: "RuntimeUnavailable",
          reason: "start-failed",
          frameShapes: {},
          opens: [
            {
              step: "ready",
              options: { resume: false, sessionId: true, outputFormat: false },
            },
            {
              step,
              options: { resume: false, sessionId: true, outputFormat: true },
            },
          ],
        },
        normal: { outcome: { status: "completed" }, requestsStarted: 1 },
      },
    });
    const last = value.turns.freshFinal.opens.at(-1);
    if (step !== "timeout")
      expect(last.child).toMatchObject({ exited: true, exitCode: 1 });
    if (step === "initialization")
      expect(last.child).toMatchObject({
        marker: "noConversation",
        stderrLines: 1,
      });
  });
}
// Reason: the two suspect resume paths must be distinguishable in one production-adapter run.
test("diagnose resumed final identifies missing message", async () => {
  const { value } = await run("resumed");
  expect(value.turns.resumedFinal.opens.at(-1)).toMatchObject({
    step: "initialization",
    options: { resume: true, resumeSessionAt: true, outputFormat: true },
    child: { marker: "noMessageAtUuid", exited: true, exitCode: 1 },
  });
  expect(value.turns.normal).toMatchObject({
    requestsStarted: 1,
    outcome: { status: "completed" },
  });
});
// Reason: successful final opens must spend no model request or forward their user messages.
test("diagnose withholds both final sends", async () => {
  const { value, fake } = await run("ready");
  expect(fake.received.map((message) => message.message.content)).toEqual([
    "Reply briefly.",
  ]);
  expect(value).toMatchObject({
    expectedRequests: 1,
    requestsStarted: 1,
    withinPlan: true,
    probe: { opens: [{ step: "ready" }] },
    turns: {
      freshFinal: { sendWithheld: true },
      resumedFinal: { sendWithheld: true },
    },
  });
  for (const turn of [value.turns.freshFinal, value.turns.resumedFinal])
    expect(turn.opens.at(-1).step).toBe("ready");
});
// Reason: arbitrary stderr must be classified across chunk boundaries without retaining private values or oversized tokens.
test("diagnose stderr privacy and non-tag token", async () => {
  const { value } = await run("unsafeToken");
  expect(value.turns.freshFinal.opens.at(-1).child).toMatchObject({
    stderrLines: 5,
    marker: "noConversation",
  });
  expect(value.turns.freshFinal.opens.at(-1).child).not.toHaveProperty(
    "errorToken",
  );
});

// Reason: a diagnostic stderr classifier fault must not throw back into the SDK or stop the other suspect path.
test("diagnose contains SDK observer exceptions", async () => {
  const { value, fake } = await run("observerSdk");
  expect(value.turns.freshFinal).toMatchObject({
    observerError: true,
    observerErrorIn: "sdk",
    errorTag: "RuntimeUnavailable",
    reason: "start-failed",
  });
  expect(value.turns.normal).toMatchObject({
    observerError: false,
    outcome: { status: "completed" },
    requestsStarted: 1,
  });
  expect(fake.received.map((message) => message.message.content)).toEqual([
    "Reply briefly.",
  ]);
});
