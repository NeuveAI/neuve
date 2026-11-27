// Why: a review whose route's credential lapses mid-run must wait for it without losing work. This
// drives the real `review.run` handler (Records, git, pi's SQLite, the stages, the route's own
// provider and capture) against a local OpenAI Responses endpoint, in its own process so its home
// folder is a scratch one (tests/fixtures/pi-handler-held.ts). The final generation's request is
// refused 401 as the token command disappears; the job is held; the same claim again wakes
// nothing; the next claim resumes the same conversation's final generation with the same model
// input, completes, and removes the run folder only through the ended close's capture receipt.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { hostBudget } from "../src/budget/local.ts";
import { settingsPath } from "../src/settings.ts";
import { runProcess } from "./fixtures/process.ts";
import { compatibilityNotice } from "@neuve/records-schema";

const root = mkdtempSync(
  join(
    process.env.NEUVE_TEST_STORE_DIRECTORY ?? tmpdir(),
    "harness-pi-handler-",
  ),
);
afterAll(() => rmSync(root, { recursive: true, force: true }));

// Exercise a scratch home whose settings still contain the retired switch.
const legacySettings = (home: string) => {
  mkdirSync(dirname(settingsPath(home)), { recursive: true });
  writeFileSync(
    settingsPath(home),
    JSON.stringify({ version: 1, review: { sectionReadings: "off" } }),
  );
};

test("a lapsed credential holds the run, the same claim wakes nothing, and the next claim resumes it", async () => {
  mkdirSync(join(root, "home"));
  legacySettings(join(root, "home"));
  const {
    OPENAI_API_KEY: _openai,
    ANTHROPIC_API_KEY: _anthropic,
    ...env
  } = process.env;
  const run = await runProcess(
    [
      process.execPath,
      "run",
      join(import.meta.dir, "fixtures", "pi-handler-held.ts"),
    ],
    {
      env: {
        ...env,
        HOME: join(root, "home"),
        TMPDIR: root,
        SCENARIO_ROOT: root,
      },
      timeout: 110_000,
    },
  );
  expect(run.exitCode, run.stderr.toString().slice(-4000)).toBe(0);
  const lines = run.stdout.toString().trim().split("\n");
  const observed = JSON.parse(lines[lines.length - 1]!);

  expect(observed.taskKinds).toContain("neuve.front");
  expect(observed.taskKinds).not.toContain("neuve.finder");
  expect(observed.taskKinds).toContain("neuve.reading");
  expect(observed.taskKinds).not.toContain("neuve.understand");
  expect(observed.taskKinds).not.toContain("neuve.batch");
  expect(observed.receiptTotals.retries).toBe(0);
  expect(new Set(observed.nativeAttempts).size).toBe(
    observed.nativeAttempts.length,
  );
  expect(observed.claims).toEqual({
    sameSeq: true,
    sameAttempt: true,
    newClaimTime: true,
  });
  expect(observed.outcomes).toEqual(["JobHeld", "JobHeld", "completed"]);
  expect(observed.admitted).toEqual([
    ["created", "none"],
    ["joined", "joined"],
    ["continued", "committed"],
  ]);
  // The refused final request was the second; the same claim sent nothing more.
  expect(observed.requests.afterFirst).toBe(2);
  expect(observed.requests.afterRepeat).toBe(2);
  // The held step's typed failure, as the provider recorded it on the refused turn.
  expect(observed.stepCheckpointFailure).toEqual({
    kind: "auth",
    status: 401,
    code: "invalid_token",
    detail:
      "OpenAI API error (HTTP 401, invalid_token): Token expired (fixture)",
  });
  // The run control's typed failure the handler decided on, at the hold and after the reopen.
  const auth = { kind: "auth", status: 401, code: "invalid_token" };
  expect(observed.heldFailures).toEqual([[auth], [auth]]);
  // One resume: the refused model input sent once more, still as the final generation.
  expect(observed.resumedFinal).toEqual([{ final: true, status: 200 }]);
  // In the ended capture, the held conversation holds both: its turn, the refused final request,
  // the resumed one with the same input, then one retry of its invalid answer, as Frame allows.
  expect(observed.heldConversationCalls).toEqual([
    { status: 200, sameInput: false },
    { status: 401, sameInput: true },
    { status: 200, sameInput: true },
    { status: 200, sameInput: false },
  ]);
  expect(observed.snapshots).toEqual([
    ["held", "open"],
    ["held", "open"],
    ["ended", "ended"],
  ]);
  // Every model request the run sent waited for one of its call slots, in the run log's telemetry.
  expect(observed.slotWaitSpans).toBe(observed.requests.total);
  expect(observed.slotWaitMetricCount).toBe(observed.requests.total);
  expect(observed.folderWhileHeld).toBe(true);
  expect(observed.folderAfter).toBe(false);
  expect(observed.completed).toMatchObject({
    outcome: "completed",
    runFolderRemoved: true,
    captures: [observed.endedCapture],
  });
}, 120_000);

// Why: the readings are on by default, so the held-credential policy must hold with them and the
// publish phase running: the hold, the repeated claim that wakes nothing and the resume, then each
// batch published by its waiter before the ending call. No settings file: the default. The bound is
// the held case's: the readings add their calls (about forty requests in all), measured near ten
// seconds on a loaded machine, so the held case's headroom covers them.
test("with the readings on by default, a lapsed credential holds, resumes and publishes per batch", async () => {
  const directory = join(root, "readings-default");
  mkdirSync(join(directory, "home"), { recursive: true });
  const {
    OPENAI_API_KEY: _openai,
    ANTHROPIC_API_KEY: _anthropic,
    ...env
  } = process.env;
  const run = await runProcess(
    [
      process.execPath,
      "run",
      join(import.meta.dir, "fixtures", "pi-handler-held.ts"),
    ],
    {
      env: { ...env, HOME: join(directory, "home"), SCENARIO_ROOT: directory },
      timeout: 110_000,
    },
  );
  expect(run.exitCode, run.stderr.toString().slice(-4000)).toBe(0);
  const observed = JSON.parse(run.stdout.toString().trim().split("\n").at(-1)!);
  expect(observed.claims).toEqual({
    sameSeq: true,
    sameAttempt: true,
    newClaimTime: true,
  });
  expect(observed.outcomes).toEqual(["JobHeld", "JobHeld", "completed"]);
  expect(observed.admitted).toEqual([
    ["created", "none"],
    ["joined", "joined"],
    ["continued", "committed"],
  ]);
  // The same claim again sent nothing more.
  expect(observed.requests.afterRepeat).toBe(observed.requests.afterFirst);
  const auth = { kind: "auth", status: 401, code: "invalid_token" };
  expect(observed.stepCheckpointFailure).toMatchObject(auth);
  expect(observed.heldFailures).toEqual([[auth], [auth]]);
  // One resume: the refused model input sent once more, still as the final generation.
  expect(observed.resumedFinal).toEqual([{ final: true, status: 200 }]);
  expect(observed.snapshots).toEqual([
    ["held", "open"],
    ["held", "open"],
    ["ended", "ended"],
  ]);
  // Every request waited for a call slot; a call the hold cancelled may have waited and sent
  // nothing, as the readings' calls run beside the held one.
  expect(observed.slotWaitSpans).toBeGreaterThanOrEqual(
    observed.requests.total,
  );
  // The publish phase after the resume: the one batch published by its waiter, then the ending
  // call, which completes the packet; nothing refused.
  expect(observed.waiters).toEqual([[0, "published"]]);
  expect(observed.publications).toEqual([
    { ending: false, ordinal: 1, complete: false, refused: [] },
    { ending: true, ordinal: 2, complete: true, refused: [] },
  ]);
  expect(observed.folderWhileHeld).toBe(true);
  expect(observed.folderAfter).toBe(false);
  expect(observed.completed).toMatchObject({
    outcome: "completed",
    runFolderRemoved: true,
    captures: [observed.endedCapture],
  });
}, 120_000);

// These exercise the retained handler consequences, where helper-only tests missed the policy loss.
test.each([
  "preflight",
  "retry",
  "aged-retry",
  "held-final",
  "deadline",
  "crash-auth",
  "crash-quota",
])(
  "the real handler preserves %s policy",
  async (policy) => {
    const directory = join(root, policy);
    mkdirSync(join(directory, "home"), { recursive: true });
    legacySettings(join(directory, "home"));
    const {
      OPENAI_API_KEY: _openai,
      ANTHROPIC_API_KEY: _anthropic,
      ...env
    } = process.env;
    const run = await runProcess(
      [
        process.execPath,
        "run",
        join(import.meta.dir, "fixtures", "pi-handler-held.ts"),
      ],
      {
        timeout: 25_000,
        env: {
          ...env,
          HOME: join(directory, "home"),
          TMPDIR: directory,
          SCENARIO_ROOT: directory,
          SCENARIO_POLICY: policy,
        },
      },
    );
    expect(run.exitCode, run.stderr.toString().slice(-4000)).toBe(0);
    const lines = run.stdout.toString().trim().split("\n");
    const observed = JSON.parse(lines.at(-1)!);
    if (policy === "preflight") {
      expect(observed.physicalRequests).toBe(1);
      expect(observed.error).toMatchObject({
        _tag: "RunFailed",
        stageError: "PreflightFailed",
        retryable: false,
        status: 401,
      });
      expect(observed.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "neuve.front",
            state: {
              status: "terminal",
              outcome: {
                status: "failed",
                error: {
                  detail: {
                    tag: "PreflightFailed",
                    retryable: false,
                    status: 401,
                  },
                },
              },
            },
          }),
          expect.objectContaining({
            kind: "neuve.review",
            state: {
              status: "terminal",
              outcome: {
                status: "failed",
                error: {
                  detail: {
                    tag: "PreflightFailed",
                    retryable: false,
                    status: 401,
                  },
                },
              },
            },
          }),
        ]),
      );
    } else if (policy === "held-final") {
      expect(observed.outcome).toBe("RunFailed");
      expect(observed.physicalRequests).toBeGreaterThanOrEqual(4);
      expect(observed.error?.stageError).toBe("InternalProviderError");
      expect(observed.stopCause).toBe("held-failure");
    } else if (policy === "aged-retry") {
      expect(observed.outcome).toBe("completed");
      expect(observed.elapsed).toBeGreaterThanOrEqual(100);
    } else if (policy === "retry") {
      expect(observed.outcome).toBe("completed");
      expect(observed.failed).toBe(1);
      expect(observed.physicalRequests).toBe(observed.successful + 1);
      expect(observed.receipt.totals.modelCalls).toBe(observed.successful);
      expect(observed.receipt.totals.failedModelCalls).toBe(1);
      expect(observed.receipt.totals.abortedModelCalls).toBe(0);
      expect(observed.receipt.totals.retries).toBe(1);
      expect(observed.persisted.totals.retries).toBe(1);
    } else if (policy.startsWith("crash-")) {
      expect(observed.physicalRequests).toBe(2);
      expect(observed.error).toMatchObject({
        _tag: "RunFailed",
        stageError:
          policy === "crash-auth"
            ? "AuthenticationError"
            : "QuotaExhaustedError",
        retryable: false,
      });
      expect(observed.receipt).toBeNull();
    } else {
      expect(observed.stopCause).toBe("deadline");
      expect(observed.outcome).toBe("RunDeadlineExceeded");
      expect(observed.elapsed).toBeLessThan(18_000);
      expect(observed.retained).toBe(true);
      expect(observed.pendingTask).toBe(true);
      expect(observed.snapshots).toMatchObject([{ mode: "interrupted" }]);
      expect(observed.cleanup).toMatchObject([{ phase: "stopping" }]);
    }
  },
  30_000,
);

test.each([
  "close-success",
  "close-failure",
  "close-stop",
  "close-interrupt",
  "close-drop",
])(
  "the public handler and worker own delayed native export through %s",
  async (policy) => {
    const directory = join(root, policy);
    mkdirSync(join(directory, "home"), { recursive: true });
    legacySettings(join(directory, "home"));
    const {
      OPENAI_API_KEY: _openai,
      ANTHROPIC_API_KEY: _anthropic,
      ...env
    } = process.env;
    // The scenario path exceeds macOS's Unix socket limit under the checks' TMPDIR.
    const budgetDirectory = mkdtempSync(join(tmpdir(), "ph-"));
    let host: Awaited<ReturnType<typeof hostBudget>>;
    let run: Awaited<ReturnType<typeof runProcess>>;
    try {
      host = await hostBudget({ directory: budgetDirectory });
      run = await runProcess(
        [
          process.execPath,
          "run",
          join(import.meta.dir, "fixtures", "pi-handler-held.ts"),
        ],
        {
          timeout: 25_000,
          env: {
            ...env,
            NEUVE_BUDGET_DIRECTORY: budgetDirectory,
            HOME: join(directory, "home"),
            TMPDIR: directory,
            SCENARIO_ROOT: directory,
            SCENARIO_POLICY: policy,
          },
        },
      );
    } finally {
      await host?.close();
      rmSync(budgetDirectory, { recursive: true, force: true });
    }
    // Strip-mode checkpoints now disclose their undeclared fields under F33.
    const expectedNotice = compatibilityNotice([
      "model",
      "thinkingLevel",
      "streamOptions",
      "cutoff",
    ]);
    expect(
      run.stderr
        .toString()
        .split("\n")
        .filter((line) => line !== expectedNotice)
        .join("\n"),
    ).toBe("");
    expect(run.exitCode, run.stderr.toString().slice(-4000)).toBe(0);
    const observed = JSON.parse(
      run.stdout.toString().trim().split("\n").at(-1)!,
    );
    expect(observed.pending).toBe(1);
    expect(observed.stalledMs).toBeGreaterThanOrEqual(60);
    expect(observed.beforeRelease).toEqual({
      sourceHeld: true,
      workerEnded: false,
      terminal: 0,
      completed: false,
    });
    expect(observed.workerBeforeSettlement).toBe(false);
    expect(observed.sourceHeldBeforeSettlement).toBe(true);
    if (policy === "close-drop")
      expect(observed.slotReleasedBeforeSettlement).toBe(true);
    expect(observed.snapshots).toBe(policy === "close-failure" ? 0 : 1);
    expect(observed.failures).toBe(policy === "close-failure" ? 1 : 0);
    expect(observed.exportSettled).toBe(policy !== "close-failure");
    if (policy !== "close-failure") expect(observed.exported).toBeString();
    expect(observed.order.slice(0, 2)).toEqual([
      "run.cleanup-pending",
      policy === "close-failure" ? "run.close-failed" : "run.snapshot",
    ]);
    if (
      policy !== "close-stop" &&
      policy !== "close-interrupt" &&
      policy !== "close-drop"
    )
      expect(observed.order.at(-1)).toBe("run.completed");
    expect(observed.folderRetained).toBe(policy !== "close-success");
  },
  30_000,
);
