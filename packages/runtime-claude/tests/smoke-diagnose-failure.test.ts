import { expect, test } from "bun:test";
import { join } from "node:path";
import { diagnoseFixture } from "./smoke-diagnose-fixture.ts";

const reasons = {
  observerEventThrow:
    "A terminal serializer fault must retain the adapter outcome and print an event observer error within plan.",
  observerBeginThrow:
    "A begin fault must let the adapter finish and print a shape-only begin observer error.",
  observerOfferedThrow:
    "An offered fault must let the adapter finish and print a shape-only offered observer error.",
  observerThrow:
    "An observer receive fault must not change the adapter outcome or escape its stream tap.",
  startFail:
    "A failed start must print the Effect failure shape and the normal-turn step.",
  missingFinish:
    "A stream ending without turn.finished must print a defect shape and the current step.",
  probeFail:
    "A failed probe must identify the probe step before opening a session.",
  openFail:
    "Failed fresh and normal session opens must retain their plan steps.",
  freshFail:
    "A failed second session open must retain the fresh final diagnosis.",
  finalStartFail:
    "A failed resumed final start must retain the completed normal turn diagnosis.",
  startTimeout:
    "An Effect timeout must be distinguished from an ordinary typed failure.",
  startInterrupt:
    "An Effect interruption must be distinguished from failure and defect.",
  unsafeFailure:
    "Arbitrary error tags, reasons and messages must not reach the printed line.",
  rateWindow:
    "An unknown rate window must identify its schema path without printing its value.",
};
for (const mode of [
  "observerEventThrow",
  "observerBeginThrow",
  "observerOfferedThrow",
  "observerThrow",
  "startFail",
  "missingFinish",
  "rateWindow",
  "probeFail",
  "openFail",
  "freshFail",
  "finalStartFail",
  "startTimeout",
  "startInterrupt",
  "unsafeFailure",
] as const) {
  // Reason: each replay exercises the production adapter, printed failure shape and fixture privacy.
  test(`diagnose ${mode}: ${reasons[mode]}`, async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--preload",
        join(import.meta.dirname, "smoke-diagnose-preload.ts"),
        join(import.meta.dirname, "../src/smoke.ts"),
        "--live",
        "/test",
        "--diagnose",
        mode,
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      // Reason: rejected rate frames now report exactly one content-free protocol site warning.
      if (mode === "rateWindow") {
        expect(stderr.trim().split("\n")).toHaveLength(1);
        expect(stderr.trim().split(" WARN ")[1]).toBe(
          "claude-runtime protocol-error site=invalid-frame frame=rate_limit_event",
        );
      } else expect(stderr).toBe("");
      expect(stdout.trim().split("\n")).toHaveLength(1);
      const line = JSON.parse(stdout);
      const observer = mode.startsWith("observer");
      const eventFault = mode === "observerEventThrow";
      expect(code).toBe(eventFault ? 1 : 0);
      expect(line).toMatchObject({ mode: "diagnose", expectedRequests: 1 });
      expect(line.wallMs).toBeGreaterThanOrEqual(0);
      if (mode === "probeFail")
        expect(line.probe).toMatchObject({
          outcome: "failed",
          step: "probe",
          causeKind: "fail",
          errorTag: "TurnFailed",
          reason: "previous-turn-active",
        });
      else if (observer) {
        expect(line.turns.normal).toMatchObject({
          outcome: { status: "completed" },
          observerError: true,
          observerErrorIn: eventFault
            ? "event"
            : mode === "observerBeginThrow"
              ? "begin"
              : mode === "observerOfferedThrow"
                ? "offered"
                : "receive",
        });
        expect(line.turns.resumedFinal).toMatchObject(
          eventFault ? { skipped: "requestBudget" } : { sendWithheld: true },
        );
      } else if (mode === "rateWindow") {
        expect(line.turns.normal).toMatchObject({
          outcome: {
            status: "failed",
            reason: "protocol-error",
            disposition: "broken",
          },
          observerError: false,
          firedPath: "validFrame",
          faultIsLastFrame: true,
          faultingFrame: {
            type: "rate_limit_event",
            shapeIssues: [
              { path: "rate_limit_info.rateLimitType", code: "invalid_value" },
            ],
          },
        });
      } else {
        const diagnosis =
          mode === "finalStartFail"
            ? line.turns.resumedFinal
            : line.turns.normal;
        expect(diagnosis).toMatchObject({
          outcome: "failed",
          step: mode === "finalStartFail" ? "resumedFinal" : "normalTurn",
          causeKind:
            mode === "missingFinish"
              ? "die"
              : mode === "startTimeout"
                ? "timeout"
                : mode === "startInterrupt"
                  ? "interrupt"
                  : "fail",
        });
        if (
          ["startFail", "openFail", "freshFail", "finalStartFail"].includes(
            mode,
          )
        )
          expect(diagnosis).toMatchObject({
            errorTag: "TurnFailed",
            reason: "previous-turn-active",
          });
        if (mode === "unsafeFailure") {
          expect(diagnosis).not.toHaveProperty("errorTag");
          expect(diagnosis).not.toHaveProperty("reason");
        }
        if (mode === "finalStartFail")
          expect(line.turns.normal.outcome.status).toBe("completed");
      }
      for (const value of diagnoseFixture(mode).privateValues)
        expect(stdout).not.toContain(value);
      for (const field of ["message", "stack", "value"])
        expect(line).not.toHaveProperty(field);
      expect(stdout).not.toContain("Missing turn.finished");
      expect(stdout).not.toContain("Turn failed:");
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  }, 10000);
}
