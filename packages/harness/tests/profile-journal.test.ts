// Why: stream capture must not enlarge every afterResponse log read or exhaust its 1,024-record
// telemetry queue. Run the real journal and sink at 300 calls with 220 events per call.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storeLocationIn } from "@neuve/records-core";
import { openCaptureJournal } from "../src/pi/capture/journal.ts";
import { DEFAULT_LIMITS } from "../src/pi/capture/types.ts";
import { openRunLog } from "../src/run-log.ts";

test("300 streaming calls add one journal summary and leave the queue available", async () => {
  const folder = mkdtempSync(join(tmpdir(), "profile-journal-"));
  const log = openRunLog(storeLocationIn(folder), "R");
  const baseline = openRunLog(storeLocationIn(folder), "baseline");
  try {
    for (let row = 0; row < 4300; row++) {
      log.write({ type: "stage", stage: "find" });
      baseline.write({ type: "stage", stage: "find" });
    }
    const journal = openCaptureJournal(join(folder, "capture"), "R", { log });
    let parsedBytes = 0;
    let expectedBytes = 0;
    let readMs = 0;
    let baselineReadMs = 0;
    for (let call = 0; call < 300; call++) {
      const callId = String(call);
      journal.capture({
        type: "model.request",
        scope: { runId: "R" },
        callId,
        route: "chatgpt",
        provider: "openai",
        model: "fixture",
        headerNames: [],
        body: { status: "sent", json: {} },
      });
      for (let event = 0; event < 220; event++)
        journal.capture({
          type: "model.event",
          scope: { runId: "R" },
          callId,
          name: "response.output_text.delta",
          data: { delta: "fixture" },
        });
      log.write({ type: "model.call", call: callId });
      baseline.write({ type: "model.call", call: callId });
      // The afterResponse hook uses this same whole-log read once per response.
      const started = performance.now();
      const records = log.read();
      readMs += performance.now() - started;
      expect(records.length).toBe(4301 + call);
      const baselineStarted = performance.now();
      const baselineRecords = baseline.read();
      baselineReadMs += performance.now() - baselineStarted;
      expect(records.map((record) => record.type)).toEqual(
        baselineRecords.map((record) => record.type),
      );
      parsedBytes += statSync(log.path).size;
      expectedBytes += statSync(baseline.path).size;
      // Every call is synchronous, so without a turn of the event loop Bun's limit can only fire
      // after the last call (62 s against 30 s in a loaded pool). Nothing is queued during the calls.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const before = statSync(log.path).size;
    for (let i = 0; i < 1023; i++) log.enqueue?.({ type: "fixture", count: i });
    journal.close();
    journal.close();
    const queued = log.read();
    expect(queued.filter((row) => row.type === "fixture").length).toBe(1023);
    expect(queued.some((row) => row.type === "telemetry.loss")).toBe(false);
    const summaries = queued.filter(
      (row) => row["name"] === "harness.journal.append",
    );
    expect(summaries.length).toBe(1);
    const bytes = statSync(join(folder, "capture/events.jsonl")).size;
    expect(summaries[0]).toMatchObject({
      type: "metric",
      kind: "Summary",
      status: "ok",
      state: { count: 66302 },
      attributes: {
        "harness.serialized_bytes": bytes,
        "harness.append_failures": 0,
      },
    });
    expect(parsedBytes).toBe(expectedBytes);
    await log.flush?.();
    expect(log.read().some((row) => row.type === "telemetry.loss")).toBe(false);
    const summary = log
      .read()
      .find((row) => row["name"] === "harness.journal.append");
    console.log(
      JSON.stringify({
        calls: 300,
        streamEvents: 66000,
        journalLines: 66302,
        journalBytes: bytes,
        summary,
        journalRecordsDuringResponses: 0,
        parsedBytes,
        baselineParsedBytes: expectedBytes,
        readMs,
        baselineReadMs,
        baselineLogBytes: before,
        summaryBytes:
          Buffer.byteLength(
            readFileSync(log.path, "utf8")
              .split("\n")
              .find((line) => line.includes('"harness.journal.append"')) ?? "",
          ) + 1,
        queuedOtherRecords: 1023,
        journalRecords: 1,
        recordsLost: 0,
      }),
    );
  } finally {
    await log.flush?.();
    rmSync(folder, { recursive: true, force: true });
  }
  // The time follows the disk. While the journal opened events.jsonl per line this took 2.6-6.0 s
  // alone and 62 s in a loaded pool (0.9 ms an append), so the limit is about five times that pool.
  // The journal now holds its file open; the 8,600 run-log rows above still open theirs per row.
}, 300_000);

test("a refused journal append emits one counted error and preserves the capture failure", async () => {
  const folder = mkdtempSync(join(tmpdir(), "profile-journal-failed-"));
  const log = openRunLog(storeLocationIn(folder), "R");
  try {
    const journal = openCaptureJournal(join(folder, "capture"), "R", {
      log,
      limits: { ...DEFAULT_LIMITS, journalBytes: 256 },
    });
    expect(() =>
      journal.capture({
        type: "model.request",
        scope: { runId: "R" },
        callId: "1",
        route: "chatgpt",
        provider: "openai",
        model: "fixture",
        headerNames: [],
        body: { status: "sent", json: "x".repeat(512) },
      }),
    ).toThrow();
    expect(() => journal.close()).toThrow();
    await log.flush?.();
    expect(log.read()).toMatchObject([
      {
        name: "harness.journal.append",
        status: "error",
        state: { count: 2 },
        attributes: { "harness.append_failures": 1 },
      },
    ]);
  } finally {
    await log.flush?.();
    rmSync(folder, { recursive: true, force: true });
  }
});
