// Filing, retries and sending back must preserve the event and attempt history atomically.
import { afterAll, expect, test } from "bun:test";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { Blobs, JobQueue, Log, mintUlid, sha256Hex } from "../src/index.ts";
import { freshLocation, runOn, removeTemporaryDirectories } from "./support.ts";
afterAll(removeTemporaryDirectories);
const filed = (rawCapture: string) => ({
  id: mintUlid(),
  actor: sha256Hex("synthetic"),
  occurredAt: new Date().toISOString(),
  kind: "capture.filed@1" as const,
  idempotencyKey: `capture.filed:${rawCapture}`,
  payload: {
    rawCapture,
    runId: "synthetic",
    counts: { records: 1, bytes: 10, calls: 0, frames: 1 },
    sizes: { total: 10, largest: 10 },
    checkpoint: null,
  },
});

test("a rolled-back filing leaves no job and replay queues exactly once", async () => {
  const result = await runOn(
    freshLocation(),
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const event = filed("a".repeat(64));
      yield* sql
        .withTransaction(
          Effect.andThen(Log.append([event]), Effect.fail("rollback")),
        )
        .pipe(Effect.result);
      const [before] = yield* sql<{
        n: number;
      }>`SELECT count(*) AS n FROM jobs WHERE kind='capture.scan'`;
      yield* Log.append([event]);
      yield* Log.append([event]);
      const [after] = yield* sql<{
        n: number;
      }>`SELECT count(*) AS n FROM jobs WHERE kind='capture.scan'`;
      return { before: before?.n, after: after?.n };
    }),
  );
  expect(result).toEqual({ before: 0, after: 1 });
});

test("three transient failures dead-letter; sending back creates a new job and retains failed history", async () => {
  const location = freshLocation();
  const result = await runOn(
    location,
    Effect.gen(function* () {
      const blobs = yield* Blobs.BlobStore;
      const blob = yield* blobs.put({
        bytes: new Uint8Array([1]),
        mediaType: "application/octet-stream",
        retention: "raw-capture",
      });
      const raw = blob.blob.hash;
      const event = filed(raw);
      yield* Log.append([event]);
      const queue = yield* JobQueue.JobQueue;
      const sql = yield* SqlClient;
      const outcomes = [];
      let seq = 0;
      for (let i = 0; i < 3; i++) {
        const job = Option.getOrThrow(yield* queue.take(["capture.scan"]));
        seq = job.seq;
        outcomes.push(
          (yield* queue.fail(job.seq, job.attempts, {
            tag: "ScanAttemptFailed",
            message: "capture scan failed; retry later",
          })).state,
        );
        yield* sql`UPDATE jobs SET run_at='2000-01-01T00:00:00.000Z' WHERE job_seq=${seq} AND state='delayed'`;
      }
      const failed = yield* queue.failedScans(0, 128);
      const next = yield* queue.retryFailedScan(seq, [raw]);
      const duplicate = yield* queue
        .retryFailedScan(seq, [raw])
        .pipe(Effect.result);
      const original = Option.getOrThrow(yield* queue.inspect(seq));
      const active = Option.getOrThrow(yield* queue.take(["capture.scan"]));
      yield* queue.fail(active.seq, active.attempts, {
        tag: "ScanAttemptFailed",
        message: "capture scan failed; retry later",
        final: true,
      });
      const stale = yield* queue
        .retryFailedScan(seq, [raw])
        .pipe(Effect.result);
      const latest = yield* queue.retryFailedScan(active.seq, [raw]);
      return {
        outcomes,
        failed,
        next,
        duplicate: duplicate._tag,
        original,
        stale: stale._tag,
        latest,
        eventId: event.id,
      };
    }).pipe(
      Effect.provide(JobQueue.layer),
      Effect.provide(Blobs.layer(location)),
    ),
  );
  expect(result.outcomes).toEqual(["delayed", "delayed", "failed"]);
  expect(result.failed).toHaveLength(1);
  expect(result.next.seq).toBeGreaterThan(result.original.seq);
  expect(result.next.eventId).toBe(result.eventId);
  expect(result.next.dedupeKey).toBe(
    `capture.scan:${result.eventId}:requeue:${result.original.seq}`,
  );
  expect(result.original.state).toBe("failed");
  expect(result.original.attempts).toBe(3);
  expect(result.duplicate).toBe("Failure");
  expect(result.stale).toBe("Failure");
  expect(result.latest.seq).toBeGreaterThan(result.next.seq);
});

test("derived capture puts cannot restore bytes pruned after a scan read", async () => {
  const location = freshLocation();
  const outcomes = await runOn(
    location,
    Effect.gen(function* () {
      const blobs = yield* Blobs.BlobStore;
      const requests = [
        new Uint8Array([1, 2, 3]),
        new Uint8Array(200_000).fill(7),
      ].map((bytes) => ({
        bytes,
        mediaType: "application/octet-stream",
        retention: "raw-capture" as const,
      }));
      const hashes = [];
      for (const request of requests)
        hashes.push((yield* blobs.put(request)).blob.hash);
      yield* blobs.prune({
        cutoff: new Date(Date.now() + 86400000).toISOString(),
        limit: 128,
      });
      const results = [];
      for (const [index, request] of requests.entries()) {
        const put = yield* blobs
          .put({ ...request, restore: "never" })
          .pipe(Effect.result);
        results.push({
          result: put._tag,
          read: (yield* blobs.get(hashes[index]!))._tag,
        });
      }
      return results;
    }).pipe(Effect.provide(Blobs.layer(location))),
  );
  expect(outcomes).toEqual([
    { result: "Failure", read: "Pruned" },
    { result: "Failure", read: "Pruned" },
  ]);
});

test("capture mark and alias lookups use partial indexes without raising compatibility floors", async () => {
  const result = await runOn(
    freshLocation(),
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const plans = [];
      for (const [kind, field] of [
        ["capture.marked@1", "rawCapture"],
        ["capture.sealed@1", "rawCapture"],
        ["capture.sealed@1", "record"],
      ] as const)
        plans.push(
          yield* sql.unsafe<{ detail: string }>(
            `EXPLAIN QUERY PLAN SELECT envelope FROM events WHERE kind='${kind}' AND json_extract(envelope,'$.payload.${field}')=? AND json_extract(envelope,'$.payload.detectorVersion')=? AND seq>? ORDER BY seq LIMIT 128`,
            ["a".repeat(64), "capture-scan-v1", 0],
          ),
        );
      const floors =
        yield* sql`SELECT key,value FROM records_meta WHERE key IN ('min_writer_version','projector_version') ORDER BY key`;
      return { plans, floors };
    }),
  );
  expect(
    result.plans.map((plan) => plan.map((row) => row.detail).join(" ")),
  ).toEqual([
    expect.stringContaining("events_capture_marks_raw"),
    expect.stringContaining("events_capture_seals_raw"),
    expect.stringContaining("events_capture_seals_record"),
  ]);
  expect(result.floors).toEqual([
    { key: "min_writer_version", value: 13 },
    { key: "projector_version", value: 9 },
  ]);
});

test("a pruned derived blob has its own BlobPruned tag", async () => {
  const { BlobPruned } = await import("../src/blobs.ts");
  const error = new BlobPruned({
    hash: "a".repeat(64),
    prunedAt: "2026-11-02T00:00:00.000Z",
  });
  expect(error._tag).toBe("BlobPruned");
  expect(error.message).toBe("raw capture pruned on 2026-11-02T00:00:00.000Z");
});
