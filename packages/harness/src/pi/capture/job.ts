import { readData } from "@neuve/records-core";
import { safeRead } from "@neuve/records-schema";
import { z } from "zod";
import { DumpManifest } from "./archive.ts";
import { DEFAULT_LIMITS } from "./types.ts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { Blobs, type StoreLocation, type Worker } from "@neuve/records-core";
import {
  DETECTOR_VERSION,
  markState,
  scanEvent,
  appendMark,
} from "./records.ts";
import { runScanProcess, ScanAttemptFailed } from "./process.ts";
import { publicCloseReason } from "./close-diagnostic.ts";

const markConflict = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  error._tag === "IdempotencyConflict";

export const captureScanHandler =
  (options: {
    location: StoreLocation;
    command: ReadonlyArray<string>;
  }): Worker.JobHandler =>
  (job) =>
    Effect.gen(function* () {
      const event = yield* scanEvent(job);
      const state = yield* markState(event.payload.rawCapture);
      const previous = state.mark;
      const recovery = safeRead(
        z.strictObject({ recoveryMark: z.string() }),
        job.payload,
      );
      if (
        state.conflicted &&
        (!recovery.success ||
          recovery.data.recoveryMark !== previous?.id ||
          !job.dedupeKey.includes(":requeue:"))
      )
        return yield* new ScanAttemptFailed({
          reason: "capture scan mark has an idempotency conflict",
          retryable: false,
        });
      if (previous !== undefined && !state.conflicted) return;
      const blobs = yield* Blobs.BlobStore;
      const raw = yield* blobs.inspect(event.payload.rawCapture);
      if (raw._tag === "None" || raw.value.prunedAt !== null)
        return yield* Effect.fail(
          new ScanAttemptFailed({
            reason:
              raw._tag === "Some"
                ? `raw capture pruned on ${raw.value.prunedAt}`
                : "raw capture was pruned",
            retryable: false,
          }),
        );
      yield* runScanProcess({
        ...options,
        event,
        job: { seq: job.seq, attempt: job.attempts },
        seal: (result) =>
          Effect.gen(function* () {
            const diagnostic = new TextEncoder().encode(
              JSON.stringify({
                machine: result.machine,
                rss: result.rss,
                diagnostic: result.diagnostic ?? null,
              }),
            );
            const diagnosticBlob = yield* blobs.put({
              bytes: diagnostic,
              mediaType: "application/vnd.neuve.capture-scan-diagnostic+json",
              retention: "raw-capture",
            });
            let files: string[] = [];
            if (result.outcome === "clean") {
              const metadata = yield* blobs.inspect(result.record);
              if (
                metadata._tag === "None" ||
                metadata.value.size > DEFAULT_LIMITS.manifestBytes
              )
                return yield* Effect.fail(
                  new ScanAttemptFailed({
                    reason: "invalid raw capture manifest",
                    retryable: false,
                  }),
                );
              const header = yield* blobs.get(result.record);
              if (header._tag !== "Present")
                return yield* Effect.fail(
                  new ScanAttemptFailed({
                    reason: `raw capture pruned on ${header.blob.prunedAt}`,
                    retryable: false,
                  }),
                );
              const manifest = yield* Effect.try({
                try: () =>
                  readData(
                    DumpManifest,
                    JSON.parse(new TextDecoder().decode(header.bytes)),
                  ),
                catch: () =>
                  new ScanAttemptFailed({
                    reason: "invalid raw capture manifest",
                    retryable: false,
                  }),
              });
              files = manifest.files.map((file) => file.sha256);
            }
            const sql = yield* SqlClient;
            yield* sql.withTransaction(
              Effect.gen(function* () {
                const [record] =
                  yield* sql`SELECT 1 FROM blobs WHERE hash=${result.record} AND pruned_at IS NULL`;
                const [source] =
                  yield* sql`SELECT 1 FROM blobs WHERE hash=${event.payload.rawCapture} AND pruned_at IS NULL`;
                if (record === undefined || source === undefined)
                  return yield* Effect.fail(
                    new ScanAttemptFailed({
                      reason: "raw capture was pruned",
                      retryable: false,
                    }),
                  );
                const hashes = [...new Set(files)];
                for (let i = 0; i < hashes.length; i += 128) {
                  const batch = hashes.slice(i, i + 128);
                  const rows =
                    yield* sql`SELECT hash FROM blobs WHERE ${sql.in("hash", batch)} AND pruned_at IS NULL`;
                  if (rows.length !== batch.length)
                    return yield* Effect.fail(
                      new ScanAttemptFailed({
                        reason: "raw capture was pruned",
                        retryable: false,
                      }),
                    );
                }
                const current = yield* markState(event.payload.rawCapture);
                if (current.mark?.id !== previous?.id)
                  return yield* new ScanAttemptFailed({
                    reason:
                      "capture mark changed during scan; seal not applied",
                    retryable: true,
                  });
                yield* appendMark(
                  {
                    rawCapture: event.payload.rawCapture,
                    detectorVersion: DETECTOR_VERSION,
                    outcome: result.outcome,
                    record: result.record,
                    ...(result.reason === undefined
                      ? {}
                      : { reason: result.reason }),
                  },
                  previous?.id,
                  diagnosticBlob.blob.hash,
                  { job: job.seq, attempt: job.attempts },
                  result.basis,
                );
              }),
            );
          }),
      });
    }).pipe(
      Effect.catchDefect((defect) =>
        Effect.fail(
          new ScanAttemptFailed({
            reason: publicCloseReason(defect),
            retryable: true,
          }),
        ),
      ),
      Effect.mapError((error) =>
        markConflict(error)
          ? new ScanAttemptFailed({
              reason: "capture scan mark has an idempotency conflict",
              retryable: false,
            })
          : error instanceof ScanAttemptFailed ||
              (typeof error === "object" && error !== null && "hold" in error)
            ? error
            : new ScanAttemptFailed({
                reason: publicCloseReason(error),
                retryable: true,
              }),
      ),
    );
