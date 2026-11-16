// These regressions exercise wire measurements through the actual validated capture journal.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCaptureJournal } from "../src/pi/capture/journal.ts";
import { JournalLine } from "../src/pi/capture/types.ts";
import {
  beginNativeMeasurements,
  writeNativeMeasurements,
} from "../src/pi/measurements.ts";
import type { RunLog, RunLogRecord } from "../src/run-log.ts";

const root = mkdtempSync(join(tmpdir(), "pi-measurements-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const scope = { runId: "measured", agent: "understand.1" };
const claim = { jobSeq: 1, attempt: 1, claimedAt: "2026-10-31T12:00:00Z" };
const boundary = {
  kind: "ready",
  claim,
  journalAfterSeq: 0,
  logFromIndex: 0,
} as const;

test("the claim watermark partitions calls and estimates even when request timestamps coincide", () => {
  const journal = openCaptureJournal(join(root, "partitioned"), scope.runId);
  const written: RunLogRecord[] = [];
  const log: RunLog = {
    path: "",
    read: () => written,
    write: (e) => written.push(e),
  };
  const request = (callId: string) =>
    journal.capture({
      type: "model.request",
      scope,
      callId,
      route: "chatgpt",
      provider: "openai",
      model: "fixture",
      headerNames: [],
      body: { status: "sent", json: { input: [] } },
    });
  request("old");
  log.write({ type: "estimate", label: "old", bytes: 10 });
  const start = beginNativeMeasurements(log, journal.directory, claim);
  // A preceding claim's completion arriving after this boundary still belongs to its old request.
  journal.capture({
    type: "model.end",
    scope,
    callId: "old",
    outcome: "completed",
  });
  request("new");
  journal.capture({
    type: "model.end",
    scope,
    callId: "new",
    outcome: "completed",
  });
  request("unfinished");
  log.write({
    type: "estimate",
    label: "new",
    bytes: 20,
    estimate: 9,
    counted: 8,
    ratio: 1.125,
  });
  journal.close();
  const path = join(journal.directory, "events.jsonl");
  writeFileSync(
    path,
    readFileSync(path, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) =>
        JSON.stringify({ ...JournalLine.parse(JSON.parse(line)), at: 1000 }),
      )
      .join("\n") + "\n",
  );
  writeNativeMeasurements(log, journal.directory, "medium", start);
  expect(written.find((e) => e["name"] === "strict-flag")?.["requests"]).toBe(
    2,
  );
  expect(written.find((e) => e["name"] === "turn-latency")).toMatchObject({
    turns: 1,
    meanMs: 0,
  });
  expect(
    written.find((e) => e["name"] === "thinking-and-append-only")?.["agents"],
  ).toMatchObject([{ responseBlockTypes: [[], []] }]);
  expect(
    written.find((e) => e["name"] === "estimate-calibration")?.["samples"],
  ).toEqual([
    { label: "new", bytes: 20, estimate: 9, counted: 8, ratio: 1.125 },
  ]);
  expect(written.find((e) => e.type === "measurement.boundary")).toMatchObject({
    claim,
    journalAfterSeq: 2,
    logFromIndex: 1,
  });
});

test("a fresh missing journal is empty, while an unreadable boundary never becomes zero calls", () => {
  const written: RunLogRecord[] = [];
  const log: RunLog = {
    path: "",
    read: () => written,
    write: (e) => written.push(e),
  };
  const path = join(root, "fresh");
  const start = beginNativeMeasurements(log, path, claim);
  expect(start).toEqual({
    kind: "ready",
    claim,
    journalAfterSeq: 0,
    logFromIndex: 0,
  });
  writeNativeMeasurements(log, path, "medium", start);
  expect(written.find((e) => e["name"] === "strict-flag")?.["requests"]).toBe(
    0,
  );
  const journal = openCaptureJournal(join(root, "corrupt"), scope.runId);
  journal.close();
  writeFileSync(join(journal.directory, "events.jsonl"), "invalid\n");
  const bad = beginNativeMeasurements(log, journal.directory, claim);
  expect(bad.kind).toBe("unavailable");
  const before = written.length;
  writeNativeMeasurements(log, path, "medium", bad);
  expect(written.slice(before)).toEqual([
    {
      type: "measurement",
      name: "unavailable",
      claim,
      reason:
        "the capture journal is unreadable at line 1: Credential JSON source is invalid",
    },
  ]);
});

test("legacy Messages signed thinking and tool use remain grouped within their assistant message", () => {
  const journal = openCaptureJournal(join(root, "messages"), scope.runId);
  journal.capture({
    type: "model.request",
    scope,
    callId: "legacy",
    route: "anthropic",
    provider: "anthropic",
    model: "fixture",
    headerNames: [],
    body: {
      status: "sent",
      json: {
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", signature: "fixture" },
              { type: "text", text: "review" },
              { type: "tool_use", name: "read" },
            ],
          },
        ],
      },
    },
  });
  journal.close();
  const written: RunLogRecord[] = [];
  writeNativeMeasurements(
    { path: "", read: () => written, write: (e) => written.push(e) },
    journal.directory,
    "medium",
    boundary,
  );
  expect(
    written.find((e) => e["name"] === "thinking-and-append-only")?.["agents"],
  ).toMatchObject([
    {
      signedThinkingReplayed: true,
      thinkingBeforeToolUse: true,
      responseBlockTypes: [[]],
    },
  ]);
  expect(written.find((e) => e["name"] === "turn-latency")).toMatchObject({
    turns: 0,
    medianMs: null,
    p90Ms: null,
    meanMs: null,
  });
});

test("Anthropic block starts preserve indexed response types without recording block content", () => {
  const journal = openCaptureJournal(join(root, "anthropic"), scope.runId);
  journal.capture({
    type: "model.request",
    scope,
    callId: "a",
    route: "anthropic",
    provider: "anthropic",
    model: "claude-fixture",
    headerNames: [],
    body: {
      status: "sent",
      json: { messages: [{ role: "user", content: "review" }] },
    },
  });
  journal.capture({
    type: "model.event",
    scope,
    callId: "a",
    name: "message_start",
    data: {
      type: "message_start",
      message: { content: [{ type: "thinking", thinking: "private fixture" }] },
    },
  });
  for (const [index, type] of [
    "thinking",
    "text",
    "tool_use",
    "text",
  ].entries())
    journal.capture({
      type: "model.event",
      scope,
      callId: "a",
      name: "content_block_start",
      data: { type: "content_block_start", index, content_block: { type } },
    });
  journal.capture({
    type: "model.end",
    scope,
    callId: "a",
    outcome: "completed",
  });
  journal.close();
  const written: RunLogRecord[] = [];
  writeNativeMeasurements(
    { path: "", read: () => written, write: (e) => written.push(e) },
    journal.directory,
    "medium",
    boundary,
  );
  expect(
    written.find((e) => e["name"] === "thinking-and-append-only")?.["agents"],
  ).toEqual([
    {
      agent: "understand.1",
      messageCounts: [1],
      appendOnly: true,
      signedThinkingReplayed: false,
      thinkingBeforeToolUse: false,
      responseBlockTypes: [["thinking", "text", "tool_use", "text"]],
      errors: [],
    },
  ]);
  expect(JSON.stringify(written)).not.toContain("private fixture");
});

test("Responses reasoning, assistant message and function call share a group until an input boundary", () => {
  const journal = openCaptureJournal(join(root, "responses"), scope.runId);
  for (const [callId, input] of Object.entries({
    grouped: [
      { type: "reasoning", encrypted_content: "fixture" },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "review" }],
      },
      { type: "function_call", name: "read" },
    ],
    separated: [
      { type: "reasoning", encrypted_content: "fixture" },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "review" }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "next" }],
      },
      { type: "function_call", name: "read" },
    ],
  })) {
    journal.capture({
      type: "model.request",
      scope: { ...scope, agent: callId },
      callId,
      route: "chatgpt",
      provider: "openai",
      model: "fixture",
      headerNames: [],
      body: { status: "sent", json: { input } },
    });
    journal.capture({ type: "model.end", scope, callId, outcome: "completed" });
  }
  journal.close();
  const written: RunLogRecord[] = [];
  writeNativeMeasurements(
    { path: "", read: () => written, write: (e) => written.push(e) },
    journal.directory,
    "medium",
    boundary,
  );
  expect(
    written.find((e) => e["name"] === "thinking-and-append-only")?.["agents"],
  ).toMatchObject([
    {
      agent: "grouped",
      signedThinkingReplayed: true,
      thinkingBeforeToolUse: true,
    },
    {
      agent: "separated",
      signedThinkingReplayed: true,
      thinkingBeforeToolUse: false,
    },
  ]);
});
