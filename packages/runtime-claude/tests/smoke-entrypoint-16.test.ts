import { expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";

// Reason: the whole entrypoint must account for every reply within its plan without disclosing model names, text, tokens or ids.
test("smoke entrypoint reports all six steps within the planned requests through the preloaded fake", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--preload",
      join(import.meta.dirname, "smoke-preload.ts"),
      join(import.meta.dirname, "../src/smoke.ts"),
      "--live",
      "/test",
      "valid",
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
    expect(stderr).toBe("");
    expect(stdout.trim().split("\n")).toHaveLength(1);
    const counts = z
      .record(
        z.string(),
        z.union([
          z.boolean(),
          z.number(),
          z.enum(["completed", "failed", "interrupted"]),
        ]),
      )
      .parse(JSON.parse(stdout));
    expect(counts).toMatchObject({
      probeModelsPresent: true,
      defaultFirst: true,
      resolvedModelPresent: true,
      probeRows: 1,
      probeRequests: 0,
      normalCompleted: true,
      finalCompleted: true,
      structuredOutputParsed: true,
      defaultModelMatches: true,
      distinctModels: 1,
      modelsAgree: true,
      contextWindowPositive: true,
      maxOutputTokensPositive: true,
      normalFinalRequests: 2,
      inputCompleted: true,
      resumeCompleted: true,
      messageTokenFound: true,
      steerTokenFound: true,
      completedInputsRequests: 3,
      forkCompleted: true,
      forkMessageTokenFound: true,
      forkSteerTokenFound: true,
      forkNativeSessionIdDiffers: true,
      forkRequests: 1,
      toolsCompleted: true,
      carrierPresent: true,
      noteCalledOnce: true,
      finishCalledOnce: true,
      steerAccepted: true,
      finishReceivedSteerToken: true,
      twoToolMessages: true,
      balancedTools: true,
      noRequestAfterFinish: true,
      toolsRequests: 2,
      refusedCompleted: true,
      refusedSubmitOnce: true,
      refusedErrored: true,
      refusedOneMessage: true,
      noRequestAfterRefusal: true,
      refusedFinalStarted: true,
      refusedFinalCompleted: true,
      refusedFinalWithinBackstop: true,
      refusedProtocolError: false,
      refusedRequests: 2,
      protocolError: false,
      requests: 10,
      requestsStarted: 10,
      requestsCompleted: 10,
      expectedRequests: 12,
      withinPlan: true,
      turnsWithinPlan: true,
      inputsWithinPlan: true,
      forkWithinPlan: true,
      toolsWithinPlan: true,
      refusedWithinPlan: true,
      discardedSteerAbsent: true,
      discardedSteers: 1,
      failures: 0,
    });
    expect(counts.successes).toBeGreaterThan(0);
    expect(counts.wallMs).toBeGreaterThanOrEqual(0);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
});

// Reason: a fork start failure must print SDK-observed starts and completed messages across all earlier steps, without message text.
test("R22c full smoke fork failure counts earlier requests", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--preload",
      join(import.meta.dirname, "smoke-preload.ts"),
      join(import.meta.dirname, "../src/smoke.ts"),
      "--live",
      "/test",
      "fork-failure",
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(1);
    expect(stderr).toBe("");
    expect(stdout.trim().split("\n")).toHaveLength(1);
    const { wallMs, ...line } = JSON.parse(stdout);
    expect(wallMs).toBeGreaterThanOrEqual(0);
    expect(line).toEqual({
      outcome: "failed",
      step: "fork",
      causeKind: "fail",
      errorTag: "RuntimeUnavailable",
      reason: "start-failed",
      expectedRequests: 12,
      requestsStarted: 5,
      requestsCompleted: 5,
    });
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
});

// Reason: suppressed provider output after endTurn must still make the whole smoke fail.
test("smoke entrypoint fails when the SDK emits another response after finish", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--preload",
      join(import.meta.dirname, "smoke-preload.ts"),
      join(import.meta.dirname, "../src/smoke.ts"),
      "--live",
      "/test",
      "tool-extra",
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(1);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({
      noRequestAfterFinish: false,
      toolsRequests: 2,
      requests: 10,
      expectedRequests: 12,
      failures: 1,
    });
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
});

// Reason: every response plan and the whole-run plan must reject excess observations through the actual entrypoint.
for (const step of ["turns", "inputs", "fork", "tools", "total"] as const) {
  test(`smoke entrypoint rejects over-plan ${step}`, async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--preload",
        join(import.meta.dirname, "smoke-preload.ts"),
        join(import.meta.dirname, "../src/smoke.ts"),
        "--live",
        "/test",
        `plan-${step}`,
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(stderr).toBe("");
      const counts = JSON.parse(stdout);
      expect(counts.withinPlan).toBe(step !== "total");
      if (step === "total") {
        expect(counts.requests).toBeGreaterThan(12);
        for (const name of ["turns", "inputs", "fork", "tools"])
          expect(counts[`${name}WithinPlan`]).toBe(false);
      } else {
        expect(counts.requests).toBe(10);
        expect(counts[`${step}WithinPlan`]).toBe(false);
      }
      expect(code).toBe(1);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  });
}

// Reason: folding the steer into the first request is a passing run below the planned total.
test("smoke entrypoint accepts one response fewer with a folded steer", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--preload",
      join(import.meta.dirname, "smoke-preload.ts"),
      join(import.meta.dirname, "../src/smoke.ts"),
      "--live",
      "/test",
      "folded-steer",
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({
      requests: 9,
      expectedRequests: 12,
      withinPlan: true,
      completedInputsRequests: 2,
      inputsWithinPlan: true,
      failures: 0,
    });
    expect(code).toBe(0);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
});
