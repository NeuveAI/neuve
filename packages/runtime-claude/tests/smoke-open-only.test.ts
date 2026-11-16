import { expect, test } from "bun:test";
import { join } from "node:path";
import { Effect } from "effect";
import { RuntimeUnavailable } from "@neuve/runtime";
import { makeRuntime } from "../src/runtime.ts";
import { ClaudeSdk } from "../src/services.ts";
import { diagnoseObservation, diagnoseSmoke } from "../src/smoke-diagnose.ts";
import {
  observeSmokeSdk,
  toolOutputObservation,
} from "../src/smoke-runtime.ts";
import { checkNormalAndFinal } from "../src/smoke-checks.ts";
import { account } from "./smoke-fixture.ts";
import {
  openFixture,
  privateValues,
  stderrCases,
} from "./smoke-open-fixture.ts";

async function run(mode = "ready", diagnose = true) {
  const fake = openFixture(mode);
  const observation = diagnose
    ? diagnoseObservation()
    : toolOutputObservation();
  const value = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const baseRuntime = yield* makeRuntime({
          cwd: "/test",
          environment: {},
        });
        const runtime =
          mode === "probeFailure"
            ? {
                ...baseRuntime,
                probe: () =>
                  Effect.fail(
                    new RuntimeUnavailable({
                      account: account.name,
                      reason: "start-failed",
                    }),
                  ),
              }
            : baseRuntime;
        return diagnose && "event" in observation
          ? yield* diagnoseSmoke(runtime, account, observation)
          : yield* checkNormalAndFinal(runtime, account, undefined);
      }),
    ).pipe(
      Effect.provideService(ClaudeSdk, observeSmokeSdk(fake.sdk, observation)),
      Effect.provide(fake.layers),
      Effect.timeout("2 seconds"),
    ),
  );
  expect(fake.closed).toBe(fake.opens);
  return { value: JSON.parse(JSON.stringify(value)), fake };
}

// Reason: structured output alone must reach the first child without sending a user message.
test("schemaOnly injects outputFormat on its first open only", async () => {
  const { value, fake } = await run();
  expect(value.turns.schemaOnly).toMatchObject({
    sendWithheld: true,
    requestsStarted: 0,
    opens: [
      {
        step: "ready",
        options: { sessionId: true, outputFormat: true, resume: false },
      },
    ],
  });
  const opening = fake.optionsReceived[3];
  expect(opening?.outputFormat).toMatchObject({
    type: "json_schema",
    schema: {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      additionalProperties: false,
    },
  });
  expect(opening?.resume).toBeUndefined();
  expect(fake.offersByOpen[3]).toBe(0);
  expect(fake.optionsReceived[4]?.outputFormat).toBeUndefined();
});

// Reason: the two resume opens must differ only in their recorded resume point and spend no request.
test("resumeOnly and resumeAtOnly withhold non-final sends", async () => {
  const { value, fake } = await run();
  for (const [step, index, at] of [
    ["resumeOnly", 5, false],
    ["resumeAtOnly", 6, true],
  ] as const) {
    expect(value.turns[step]).toMatchObject({
      sendWithheld: true,
      requestsStarted: 0,
      opens: [
        {
          step: "ready",
          options: {
            resume: true,
            resumeSessionAt: at,
            outputFormat: false,
            forkSession: false,
          },
        },
      ],
    });
    expect(fake.optionsReceived[index]?.resume).toBe(
      fake.optionsReceived[7]?.resume,
    );
    expect(fake.optionsReceived[index]?.outputFormat).toBeUndefined();
    expect(fake.optionsReceived[index]?.resumeSessionAt !== undefined).toBe(at);
    expect(fake.offersByOpen[index]).toBe(0);
  }
  expect(fake.optionsReceived[6]?.resumeSessionAt).toBe(
    fake.optionsReceived[7]?.resumeSessionAt,
  );
  expect(fake.offersByOpen).toEqual([0, 0, 0, 0, 1, 0, 0, 0]);
  expect(value).toMatchObject({
    requestsStarted: 1,
    requestsCompleted: 1,
    expectedRequests: 1,
    withinPlan: true,
  });
});

for (const [marker] of stderrCases) {
  // Reason: each startup marker must survive chunk splits while stdout and logs omit every fixture value.
  test(`printed startup marker ${marker}`, async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--preload",
        join(import.meta.dirname, "smoke-open-preload.ts"),
        join(import.meta.dirname, "../src/smoke.ts"),
        "--live",
        "/test",
        "--diagnose",
        marker,
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code).toBe(0);
      expect(stdout.trim().split("\n")).toHaveLength(1);
      expect(stderr).toBe("");
      const value = JSON.parse(stdout);
      expect(value.turns.freshFinal.opens.at(-1).child).toMatchObject({
        marker,
        errorPrefix: true,
        stderrLines: 1,
      });
      if (marker === "jsonSchemaNotJson")
        expect(value.turns.freshFinal.opens.at(-1).child.flag).toBe(
          "--json-schema",
        );
      for (const secret of privateValues) {
        expect(stdout).not.toContain(secret);
        expect(stderr).not.toContain(secret);
      }
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  });
}

// Reason: an unknown flag must become a boolean and never be retained as a token.
test("unknown stderr flag is omitted", async () => {
  const { value } = await run("unknownFlag");
  const child = value.turns.freshFinal.opens.at(-1).child;
  expect(child).toMatchObject({ otherFlag: true, errorPrefix: true });
  expect(child).not.toHaveProperty("flag");
  expect(JSON.stringify(value)).not.toContain("--not-a-real-flag-zz");
});

// Reason: failure in the schema-only child must leave every subsequent open check runnable.
test("schemaOnly failure is isolated", async () => {
  const { value, fake } = await run("schemaFailure");
  expect(value.turns.schemaOnly).toMatchObject({
    outcome: "failed",
    step: "schemaOnly",
  });
  expect(value.turns.normal.outcome.status).toBe("completed");
  for (const step of ["resumeOnly", "resumeAtOnly", "resumedFinal"])
    expect(value.turns[step].sendWithheld).toBe(true);
  expect(fake.received).toHaveLength(1);
  expect(value.requestsStarted).toBe(1);
});

// Reason: a normal turn that exceeds the plan must skip all three resume steps.
test("two normal requests skip all resume steps", async () => {
  const { value, fake } = await run("twoRequests");
  expect(value).toMatchObject({
    requestsStarted: 2,
    expectedRequests: 1,
    withinPlan: false,
  });
  for (const step of ["resumeOnly", "resumeAtOnly", "resumedFinal"])
    expect(value.turns[step]).toEqual({ skipped: "requestBudget" });
  expect(fake.received).toHaveLength(1);
  expect(fake.optionsReceived).toHaveLength(5);
});

// Reason: passes before, guards behaviour; full-smoke opens and offers must retain the adapter's original options and sends.
test("non-diagnose normal and final SDK behaviour is unchanged", async () => {
  const { value, fake } = await run("ready", false);
  expect(value.normalCompleted).toBe(true);
  expect(value.finalCompleted).toBe(true);
  expect(
    fake.optionsReceived.map((options) => options.outputFormat !== undefined),
  ).toEqual([false, true]);
  expect(fake.offersByOpen).toEqual([1, 1]);
});

// Reason: a failed normal open must skip every resume step without attempting another request.
test("normal unavailable skips all resume checks", async () => {
  const { value, fake } = await run("normalUnavailable");
  for (const step of ["resumeOnly", "resumeAtOnly", "resumedFinal"])
    expect(value.turns[step]).toEqual({ skipped: "normalUnavailable" });
  expect(fake.received).toHaveLength(0);
  expect(value).toMatchObject({
    requestsStarted: 0,
    requestsCompleted: 0,
    withinPlan: true,
  });
});

// Reason: a probe failure must be diagnosed locally while later open checks still run.
test("probe failure leaves later checks runnable", async () => {
  const { value, fake } = await run("probeFailure");
  expect(value.probe).toMatchObject({ outcome: "failed", step: "probe" });
  expect(value.turns.normal.outcome.status).toBe("completed");
  expect(value.turns.schemaOnly.sendWithheld).toBe(true);
  expect(value.turns.resumeAtOnly.sendWithheld).toBe(true);
  expect(fake.received).toHaveLength(1);
});

for (const [mode, step, later] of [
  ["resumeFailure", "resumeOnly", "resumeAtOnly"],
  ["resumeAtFailure", "resumeAtOnly", "resumedFinal"],
] as const) {
  // Reason: failure in either resume-only open must not prevent the following check.
  test(`${step} failure is isolated`, async () => {
    const { value } = await run(mode);
    expect(value.turns[step]).toMatchObject({ outcome: "failed", step });
    expect(value.turns[later].sendWithheld).toBe(true);
    expect(value).toMatchObject({
      requestsStarted: 1,
      requestsCompleted: 1,
      withinPlan: true,
    });
  });
}
