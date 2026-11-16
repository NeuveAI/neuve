// Queue admission and the worker use the same sealed chain, including ignored and replaced rows.
import { afterAll, expect, test } from "bun:test";
import { Effect, Option } from "effect";
import {
  Blobs,
  JobQueue,
  Log,
  mintUlid,
  CAPTURE_SCAN_ACTOR,
  captureMarkState,
} from "../src/index.ts";
import { freshLocation, runOn, removeTemporaryDirectories } from "./support.ts";
afterAll(removeTemporaryDirectories);
for (const stale of [false, true])
  test(
    stale
      ? "send-back refuses an already replaced recovery mark"
      : "an unsealed squat mark cannot permanently block send-back",
    async () => {
      const location = freshLocation();
      await runOn(
        location,
        Effect.gen(function* () {
          const blobs = yield* Blobs.BlobStore;
          const raw = (yield* blobs.put({
            bytes: new Uint8Array([1]),
            mediaType: "application/octet-stream",
            retention: "raw-capture",
          })).blob.hash;
          const at = new Date().toISOString();
          yield* Log.append([
            {
              id: mintUlid(),
              kind: "capture.filed@1",
              idempotencyKey: `capture.filed:${raw}`,
              actor: CAPTURE_SCAN_ACTOR,
              occurredAt: at,
              payload: {
                rawCapture: raw,
                runId: "synthetic",
                checkpoint: null,
                counts: { records: 1, bytes: 1, calls: 0, frames: 1 },
                sizes: { total: 1, largest: 1 },
              },
            },
          ]);
          const queue = yield* JobQueue.JobQueue;
          const job = Option.getOrThrow(yield* queue.take(["capture.scan"]));
          yield* queue.fail(job.seq, job.attempts, {
            tag: "ScanAttemptFailed",
            message: "capture scan failed; retry later",
            final: true,
          });
          const payload = {
            rawCapture: raw,
            record: "b".repeat(64),
            detectorVersion: "capture-scan-v1" as const,
            outcome: "clean" as const,
          };
          if (!stale) {
            yield* Log.append([
              {
                id: mintUlid(),
                kind: "capture.marked@1",
                idempotencyKey: "unsealed-squat",
                actor: "d".repeat(64),
                occurredAt: at,
                payload,
              },
            ]);
            expect((yield* captureMarkState(raw)).mark).toBeUndefined();
            expect((yield* queue.retryFailedScan(job.seq, [raw])).state).toBe(
              "waiting",
            );
          } else {
            const sealId = mintUlid(),
              markId = mintUlid();
            yield* Log.append([
              {
                id: sealId,
                kind: "capture.sealed@1",
                idempotencyKey: `capture.sealed:${raw}:capture-scan-v1`,
                actor: CAPTURE_SCAN_ACTOR,
                occurredAt: at,
                payload,
              },
              {
                id: markId,
                kind: "capture.marked@1",
                idempotencyKey: `capture.marked:${raw}:capture-scan-v1`,
                actor: CAPTURE_SCAN_ACTOR,
                occurredAt: at,
                payload,
                causation: { causedBy: sealId },
              },
            ]);
            const nextSeal = mintUlid(),
              nextMark = mintUlid();
            yield* Log.append([
              {
                id: nextSeal,
                kind: "capture.sealed@1",
                idempotencyKey: `capture.sealed:audit:${markId}:${payload.record}`,
                actor: CAPTURE_SCAN_ACTOR,
                occurredAt: at,
                payload,
              },
              {
                id: nextMark,
                kind: "capture.marked@1",
                idempotencyKey: `capture.marked:audit:${markId}:${payload.record}`,
                actor: CAPTURE_SCAN_ACTOR,
                occurredAt: at,
                payload,
                causation: { causedBy: nextSeal, supersedes: markId },
              },
            ]);
            expect((yield* captureMarkState(raw)).mark?.id).toBe(nextMark);
            expect(
              yield* queue
                .retryFailedScan(job.seq, [raw], markId)
                .pipe(Effect.result),
            ).toMatchObject({
              _tag: "Failure",
              failure: {
                _tag: "JobStateConflict",
                message:
                  "capture mark recovery requires the current conflicted mark",
              },
            });
          }
        }).pipe(
          Effect.provide(JobQueue.layer),
          Effect.provide(Blobs.layer(location)),
        ),
      );
    },
  );
