import { expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { TurnLimit } from "@neuve/runtime";
import { Effect, Layer, Stream, type Scope } from "effect";
import { makeRuntime } from "../src/runtime.ts";
import { ClaudeExecutable, ClaudeProcess, ClaudeSdk } from "../src/services.ts";
import { diagnoseObservation, diagnoseSmoke } from "../src/smoke-diagnose.ts";
import { observeSmokeSdk, type SmokeRuntime } from "../src/smoke-runtime.ts";
import { assistant, result, textDelta } from "./frames.ts";
import { inbound, out, replay, type Entry } from "./replay.ts";
import { diagnoseFixture } from "./smoke-diagnose-fixture.ts";
import { account } from "./smoke-fixture.ts";

const policy = {
  systemPrompt: "fixture",
  tools: [],
  approvalPolicy: "allow" as const,
  turnLimit: TurnLimit.parse(1),
  outputSchema: { type: "object" },
};

const runDiagnosis = <A, E>(
  entries: readonly Entry[],
  body: (
    runtime: SmokeRuntime,
    observation: ReturnType<typeof diagnoseObservation>,
  ) => Effect.Effect<A, E, Scope.Scope>,
) => {
  const observation = diagnoseObservation();
  const fake = replay(entries);
  let offers = 0;
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sdk = yield* ClaudeSdk;
        const runtime = yield* makeRuntime({
          cwd: "/test",
          environment: {},
        }).pipe(
          Effect.provideService(
            ClaudeSdk,
            observeSmokeSdk(sdk, {
              ...observation,
              receive: observation.receive,
              offered: (message) => {
                offers++;
                observation.offered(message);
              },
            }),
          ),
        );
        const value = yield* body(runtime, observation);
        return { value, opens: fake.opens.length, offers };
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

const diagnoseFrames = (frames: SDKMessage[], offer = true) =>
  runDiagnosis(
    [
      out({ type: "query.open" }),
      ...(offer ? [out({ type: "prompt.offer", message: "go" })] : []),
      ...frames.map(inbound),
      out({ type: "query.close" }),
    ],
    (runtime, observation) =>
      Effect.gen(function* () {
        const session = yield* runtime.openSession(account, policy, {
          kind: "new",
        });
        observation.begin();
        observation.allowNormalSend();
        yield* Effect.exit(
          session.startTurn({ turnId: "test", message: "go" }),
        );
        const diagnoses = yield* Stream.runCollect(
          session.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.finished"),
            Stream.map(observation.event),
            Stream.filter((diagnosis) => diagnosis !== undefined),
          ),
        );
        return diagnoses[0];
      }),
  );

// Reason: the adapter activates a turn before offering its first prompt.
test("diagnosis matches adapter result before prompt", async () => {
  const { value, offers } = await diagnoseFrames([result()], false);
  expect(offers).toBe(0);
  expect(value).toMatchObject({
    firedPath: "resultWithoutPendingSend",
    outcome: {
      status: "failed",
      reason: "protocol-error",
      disposition: "broken",
    },
  });
});

for (const [name, frame] of [
  ["validFrame", Object.assign(assistant(undefined), { uuid: "" })],
  [
    "stampNotSent",
    Object.assign(assistant(undefined), { user_message_uuid: "foreign" }),
  ],
  [
    "emptyStampArray",
    Object.assign(assistant(undefined), { user_message_uuids: [] }),
  ],
] as const) {
  // Reason: earlier ingress predicates must retain the adapter's classification order.
  test(`diagnosis matches adapter ${name}`, async () => {
    const { value } = await diagnoseFrames([frame]);
    expect(value).toMatchObject({
      firedPath: name,
      outcome: { status: "failed", reason: "protocol-error" },
    });
  });
}

// Reason: publication faults must still be recognized while the turn is active.
test("diagnosis matches adapter published frame after message completion", async () => {
  const first = assistant(undefined);
  const stop = textDelta("");
  Object.assign(stop, { event: { type: "message_stop" } });
  const { value } = await diagnoseFrames([first, stop, first]);
  expect(value).toMatchObject({
    firedPath: "publishedFrameAfterEnding",
    outcome: { status: "failed", reason: "protocol-error" },
  });
});

for (const mode of [
  "normal retry",
  "broken normal retry",
  "normal over budget",
] as const) {
  // Reason: retries spend the request budget even if the normal turn breaks its session.
  test(`diagnosis skips final after ${mode}`, async () => {
    const retry = diagnoseFixture("retry").entries.find(
      (entry) =>
        entry.type === "emit_inbound" &&
        entry.frame.type === "system" &&
        entry.frame.subtype === "api_retry",
    );
    if (retry === undefined) throw new Error("Missing retry fixture");
    const broken = mode === "broken normal retry";
    const over = mode === "normal over budget";
    const normal = assistant(undefined);
    if (broken) Object.assign(normal, { user_message_uuid: "foreign" });
    const entries = [
      ...diagnoseFixture("clean").entries.slice(0, 10),
      retry,
      ...(over ? [retry] : []),
      inbound(normal),
      ...(broken ? [] : [inbound(result())]),
      out({ type: "query.close" }),
    ];
    const { value, opens, offers } = await runDiagnosis(
      entries,
      (runtime, observation) => diagnoseSmoke(runtime, account, observation),
    );
    expect(value).toMatchObject({
      requestsStarted: over ? 3 : 2,
      withinPlan: false,
      turns: {
        normal: {
          requestsStarted: over ? 3 : 2,
          outcome: { status: broken ? "failed" : "completed" },
        },
        resumedFinal: { skipped: "requestBudget" },
      },
    });
    expect(opens).toBe(5);
    expect(offers).toBe(1);
  });
}

for (const [field, tag, expected] of [
  ["type", "private payload text", "unrecognized"],
  ["event.type", "Private-Payload!", "unrecognized"],
  ["type", "a".repeat(41), "unrecognized"],
  ["subtype", "private payload text", "unrecognized"],
  ["type", "new_frame_kind", "new_frame_kind"],
  ["subtype", "new_frame_kind", "new_frame_kind"],
  ["event.type", "new_frame_kind", "new_frame_kind"],
] as const) {
  // Reason: unknown discriminator tags aid diagnosis, while arbitrary header strings must stay private.
  test(`diagnosis filters header ${field} ${tag}`, async () => {
    const frame =
      field === "type"
        ? Object.assign(result(), { type: tag })
        : field === "subtype"
          ? Object.assign(result(), { subtype: tag })
          : Object.assign(textDelta(""), { event: { type: tag } });
    const { value } = await diagnoseFrames(
      field === "type" ? [frame, assistant(undefined), result()] : [frame],
    );
    const type =
      field === "type"
        ? expected
        : field === "subtype"
          ? "result"
          : "stream_event";
    expect(value).toMatchObject({
      ...(field === "type"
        ? { firedPath: "none", outcome: { status: "completed" } }
        : {
            firedPath: "validFrame",
            faultingFrame: { type, subtype: expected },
          }),
      frameShapes: { [field === "type" ? type : `${type}:${expected}`]: 1 },
    });
    if (field === "type") expect(value).not.toHaveProperty("faultingFrame");
    if (expected === "unrecognized")
      expect(JSON.stringify(value)).not.toContain(tag);
  });
}
