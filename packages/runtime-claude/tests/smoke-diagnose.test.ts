import { expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { join } from "node:path";
import { RuntimeEvent } from "@neuve/runtime";
import { diagnoseObservation } from "../src/smoke-diagnose.ts";
import { frameShapeIssues, validFrame } from "../src/protocol.ts";
import { assistant, result, textDelta, errorResult } from "./frames.ts";
import { diagnoseFixture } from "./smoke-diagnose-fixture.ts";

for (const field of [
  "outcome",
  "status",
  "failure",
  "reason",
  "disposition",
  "invalidReason",
  "invalidDisposition",
] as const) {
  // Reason: terminal fallback must retain each readable outcome field and omit unreadable or non-enum values.
  test(`terminal diagnosis fallback guards ${field}`, () => {
    const observation = diagnoseObservation();
    observation.begin();
    const event = RuntimeEvent.parse({
      type: "turn.finished",
      turnId: "test",
      at: "2026-11-10T00:00:00Z",
      outcome: {
        status: "failed",
        disposition: "broken",
        failure: {
          _tag: "TurnFailed",
          account: "test",
          reason: "protocol-error",
        },
      },
    });
    if (event.type !== "turn.finished" || event.outcome.status !== "failed")
      throw new Error("Invalid terminal fixture");
    const fail = {
      get: () => {
        throw new Error("private-observer-error");
      },
    };
    // Force full diagnosis to fail even when testing a readable, invalid enum.
    Object.defineProperty(event.outcome.failure, "_tag", fail);
    if (field === "outcome") Object.defineProperty(event, field, fail);
    else if (field === "reason")
      Object.defineProperty(event.outcome.failure, field, fail);
    else if (field === "invalidReason")
      Object.defineProperty(event.outcome.failure, "reason", {
        value: "private-reason",
      });
    else if (field === "invalidDisposition")
      Object.defineProperty(event.outcome, "disposition", {
        value: "private-disposition",
      });
    else Object.defineProperty(event.outcome, field, fail);
    const diagnosis = JSON.parse(
      JSON.stringify(observation.event(event)) ?? "null",
    );
    expect(diagnosis).toEqual({
      outcome:
        field === "outcome" || field === "status"
          ? { status: "unknown" }
          : {
              status: "failed",
              ...(["failure", "reason", "invalidReason"].includes(field)
                ? {}
                : { reason: "protocol-error" }),
              ...(["disposition", "invalidDisposition"].includes(field)
                ? {}
                : { disposition: "broken" }),
            },
      firedPath: "unclassified",
      observerError: true,
      observerErrorIn: "event",
      requestsStarted: 0,
      requestsCompleted: 0,
    });
  });
}

const reasons = {
  stamp:
    "An unknown reply stamp must identify the binding fault and diagnose final on a fresh session.",
  usage:
    "A malformed first request must identify its usage schema path before mapping.",
  clean:
    "A normal turn and two withheld final turns must finish within the one-request plan without leaking their content.",
  third:
    "A third root request must fail the plan before its response completes.",
  retry: "An API retry must count even when it has no message id.",
  normalRetry:
    "A normal-turn retry must skip final and exit within the request cap.",
  normalOverBudget:
    "A normal turn over the request cap must skip final and exit 1.",
};
for (const mode of [
  "stamp",
  "usage",
  "clean",
  "third",
  "retry",
  "normalRetry",
  "normalOverBudget",
] as const) {
  // Reason: each case above exercises the production adapter through replay and verifies output privacy.
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
      const warnings: Partial<Record<keyof typeof reasons, string>> = {
        stamp: "reply-binding frame=assistant",
        usage: "invalid-frame frame=stream_event/message_start",
        third: "message-receive frame=result/success",
      };
      const warning = warnings[mode];
      // Reason: the fixed site warning is the only new stderr output for a protocol failure.
      if (warning === undefined) expect(stderr).toBe("");
      else {
        expect(stderr.trim().split("\n")).toHaveLength(1);
        expect(stderr.trim().split(" WARN ")[1]).toBe(
          `claude-runtime protocol-error site=${warning}`,
        );
      }
      const over = [
        "third",
        "retry",
        "normalRetry",
        "normalOverBudget",
      ].includes(mode);
      expect(code).toBe(over ? 1 : 0);
      expect(stdout.trim().split("\n")).toHaveLength(1);
      const counts = JSON.parse(stdout);
      expect(counts).toMatchObject({
        mode: "diagnose",
        probe: { requests: 0, rows: 1, withinPlan: true },
        expectedRequests: 1,
        withinPlan: !over,
        requestsStarted: mode === "normalOverBudget" ? 3 : over ? 2 : 1,
        turns: {
          freshFinal: { sendWithheld: true },
          resumedFinal: over
            ? { skipped: "requestBudget" }
            : mode === "clean"
              ? { sendWithheld: true }
              : { outcome: "failed", step: "resumedFinal" },
        },
      });
      expect(counts.wallMs).toBeGreaterThanOrEqual(0);
      expect(counts.turns.normal).toMatchObject({
        observerError: mode === "third",
        outcome: {
          status:
            mode === "stamp" || mode === "usage" || mode === "third"
              ? "failed"
              : "completed",
        },
      });
      if (mode === "stamp" || mode === "usage") {
        expect(counts.turns.normal).toMatchObject({
          firedPath: mode === "stamp" ? "stampNotSent" : "validFrame",
          faultIsLastFrame: true,
          faultingFrame:
            mode === "usage"
              ? {
                  type: "stream_event",
                  subtype: "message_start",
                  shapeIssues: [
                    {
                      path: "event.message.usage.cache_creation",
                      code: "invalid_type",
                    },
                  ],
                }
              : { type: "assistant", stampsMatchOffered: false },
        });
      }
      for (const value of diagnoseFixture(mode).privateValues)
        expect(stdout).not.toContain(value);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  }, 10000);
}

// Reason: the diagnostic validator must agree with validFrame for fixture shapes and identify only broken fields.
test("frame shape diagnostics agree with ingress validation", () => {
  const frames: SDKMessage[] = [
    assistant(undefined),
    textDelta("private-delta"),
    result(),
    errorResult("error_max_turns"),
  ];
  for (const mode of ["stamp", "usage", "clean", "third"]) {
    for (const entry of diagnoseFixture(mode).entries)
      if (entry.type === "emit_inbound") frames.push(entry.frame);
  }
  for (const frame of frames)
    expect(frameShapeIssues(frame).length === 0).toBe(validFrame(frame));
  const broken: ReadonlyArray<{ frame: SDKMessage; path: string }> = [
    {
      frame: {
        ...assistant(undefined),
        message: { ...assistant(undefined).message, id: "" },
      },
      path: "message.id",
    },
    {
      frame: Object.assign(textDelta(""), { parent_tool_use_id: undefined }),
      path: "parent_tool_use_id",
    },
    {
      frame: Object.assign(result(), { is_error: undefined }),
      path: "is_error",
    },
    {
      frame: Object.assign(
        {
          type: "user",
          parent_tool_use_id: null,
          message: { role: "user", content: "" },
        } satisfies SDKMessage,
        { message: { content: undefined } },
      ),
      path: "message.content",
    },
    {
      frame: Object.assign(result(), { user_message_uuids: [undefined] }),
      path: "user_message_uuids[]",
    },
  ];
  for (const { frame, path } of broken) {
    expect(validFrame(frame)).toBe(false);
    expect(frameShapeIssues(frame)).toEqual([
      {
        path,
        code:
          path === "message.content"
            ? "invalid_union"
            : path === "message.id"
              ? "too_small"
              : "invalid_type",
      },
    ]);
  }
});

// Reason: malformed headers and model-ledger keys must never copy provider values into the shape report.
test("diagnostic shape output excludes malformed headers and provider record keys", () => {
  for (const frame of [
    JSON.parse("null"),
    JSON.parse(
      '{"type":"stream_event","parent_tool_use_id":null,"event":{"type":{"private-header-value":"private-payload"}}}',
    ),
  ]) {
    const observation = diagnoseObservation();
    observation.begin();
    observation.receive(frame);
    observation.receive(assistant(undefined));
    const diagnosis = observation.event(
      RuntimeEvent.parse({
        type: "turn.finished",
        turnId: "test",
        at: new Date().toISOString(),
        outcome: {
          status: "failed",
          disposition: "broken",
          failure: {
            _tag: "TurnFailed",
            account: "test",
            reason: "protocol-error",
          },
        },
      }),
    );
    expect(diagnosis).toMatchObject({
      firedPath: "validFrame",
      faultIsLastFrame: false,
    });
    expect(JSON.stringify(diagnosis)).not.toContain("private-header-value");
    expect(JSON.stringify(diagnosis)).not.toContain("private-payload");
  }
  const ledger = result();
  Object.assign(ledger, {
    modelUsage: {
      "private-ledger-model": { inputTokens: "private-token-value" },
    },
  });
  expect(validFrame(ledger)).toBe(false);
  expect(frameShapeIssues(ledger)).toContainEqual({
    path: "modelUsage[].inputTokens",
    code: "invalid_type",
  });
  expect(JSON.stringify(frameShapeIssues(ledger))).not.toContain(
    "private-ledger-model",
  );
  expect(JSON.stringify(frameShapeIssues(ledger))).not.toContain(
    "private-token-value",
  );
});
