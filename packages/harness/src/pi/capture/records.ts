import { readData } from "@neuve/records-core";
import { safeRead } from "@neuve/records-schema";
import { Data, Effect, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { z } from "zod";
import {
  RecordEvent,
  CaptureFiled,
  CaptureScanBasis,
} from "@neuve/records-schema";
import {
  Log,
  CAPTURE_SCAN_ACTOR,
  CAPTURE_DETECTOR_VERSION,
  captureRawIdentity as rawCaptureFor,
  captureMarkState as markState,
  captureMarkBasis,
  mintUlid,
  type JobQueue,
} from "@neuve/records-core";
export class CaptureMarkConflict extends Data.TaggedError(
  "CaptureMarkConflict",
)<{}> {
  readonly retryable = false;
  readonly reason = "capture scan mark has an idempotency conflict";
  override get message() {
    return this.reason;
  }
}
export const DETECTOR_VERSION = CAPTURE_DETECTOR_VERSION;
const actor = CAPTURE_SCAN_ACTOR;
const envelope = (key: string) => ({
  id: mintUlid(),
  idempotencyKey: key,
  actor,
  occurredAt: new Date().toISOString(),
});
export const captureFiledEvent = (
  payload: z.infer<typeof CaptureFiled>["payload"],
) => ({
  ...envelope(`capture.filed:${payload.rawCapture}`),
  kind: "capture.filed@1" as const,
  payload,
  refs: [{ ref: `blob:${payload.rawCapture}`, role: "raw-capture" }],
});
export const scanEvent = (job: JobQueue.Job) =>
  Effect.gen(function* () {
    if (job.kind !== "capture.scan" || job.eventId === null)
      return yield* Effect.fail(new Error("capture scan has no filing event"));
    const event = yield* Log.get(job.eventId);
    if (Option.isNone(event) || event.value.event.kind !== "capture.filed@1")
      return yield* Effect.fail(new Error("capture scan has no filing event"));
    return event.value.event;
  });
export type CaptureVerdict = Extract<
  z.infer<typeof RecordEvent>,
  { kind: "capture.marked@1" }
>["payload"];
export const appendMark = (
  verdict: CaptureVerdict,
  supersedes?: string,
  diagnostic?: string,
  attempt?: { job: number; attempt: number },
  basis: z.infer<typeof CaptureScanBasis> = "source-scan",
) =>
  Effect.gen(function* () {
    const root =
      supersedes === undefined
        ? `${verdict.rawCapture}:${verdict.detectorVersion}`
        : `audit:${supersedes}:${verdict.record}`;
    const key =
      root +
      (attempt === undefined
        ? ""
        : `:job:${attempt.job}:attempt:${attempt.attempt}`);
    const basisRefs =
      basis === "legacy-certificates"
        ? [
            {
              ref: `blob:${verdict.record}`,
              role: "scan-basis:legacy-certificates",
            },
          ]
        : [];
    const seal = envelope(`capture.sealed:${key}`);
    return yield* Log.append([
      {
        ...seal,
        kind: "capture.sealed@1",
        payload: verdict,
        refs: [
          ...basisRefs,
          { ref: `blob:${verdict.record}`, role: "sealed-capture" },
          ...(diagnostic === undefined
            ? []
            : [{ ref: `blob:${diagnostic}`, role: "scan-diagnostic" }]),
        ],
      },
      {
        ...envelope(`capture.marked:${key}`),
        kind: "capture.marked@1",
        payload: verdict,
        causation: {
          causedBy: seal.id,
          ...(supersedes === undefined ? {} : { supersedes }),
        },
        refs: [
          ...basisRefs,
          { ref: `blob:${verdict.record}`, role: "sealed-capture" },
        ],
      },
    ]);
  });
export {
  captureRawIdentity as rawCaptureFor,
  captureMarkState as markState,
} from "@neuve/records-core";
export const markFor = (identity: string) =>
  Effect.flatMap(markState(identity), (state) =>
    state.conflicted
      ? Effect.fail(new CaptureMarkConflict())
      : Effect.succeed(state.mark),
  );

/** A concurrent repair may only replace the mark the audit actually observed. */
export const repairMark = (
  verdict: CaptureVerdict,
  expected: string | undefined,
  basis: z.infer<typeof CaptureScanBasis> = "source-scan",
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* markFor(verdict.rawCapture);
        if (current?.id !== expected)
          return {
            repaired: false,
            reason: "capture mark changed during audit; repair not applied",
          };
        yield* appendMark(verdict, expected, undefined, undefined, basis);
        return { repaired: true };
      }),
    );
  });
export const rawCaptures = (afterSeq = 0, runId?: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql<{
      seq: number;
      envelope: string;
      rawCapture: string | null;
      prunedAt: string | null;
    }>`SELECT e.seq,e.envelope,
      CASE WHEN json_valid(e.envelope) THEN json_extract(e.envelope,'$.payload.rawCapture') END AS raw_capture,b.pruned_at FROM events e
      LEFT JOIN blobs b ON b.hash=CASE WHEN json_valid(e.envelope) THEN json_extract(e.envelope,'$.payload.rawCapture') END
      WHERE e.kind='capture.filed@1' AND e.seq>${afterSeq}
      AND ${runId === undefined ? sql.literal("1=1") : sql`CASE WHEN json_valid(e.envelope) THEN json_extract(e.envelope,'$.payload.runId') END=${runId}`} ORDER BY e.seq LIMIT 128`;
    return rows.map((row) => {
      let decoded: unknown;
      try {
        decoded = JSON.parse(row.envelope);
      } catch {}
      const parsed = safeRead(CaptureFiled, decoded);
      if (!parsed.success)
        return {
          _tag: "Invalid" as const,
          seq: row.seq,
          rawCapture:
            typeof row.rawCapture === "string" &&
            /^[a-f0-9]{64}$/.test(row.rawCapture)
              ? row.rawCapture
              : null,
          prunedAt: row.prunedAt,
          reason: "invalid capture filing; export refused",
        };
      return {
        _tag: "Filed" as const,
        seq: row.seq,
        ...parsed.data.payload,
        event: parsed.data,
        prunedAt: row.prunedAt,
      };
    });
  });
export const scanStatus = (identity: string) =>
  Effect.gen(function* () {
    const observed = yield* markFor(identity).pipe(Effect.result);
    const mark = observed._tag === "Success" ? observed.success : undefined;
    const rawCapture = (yield* rawCaptureFor(identity)) ?? identity;
    const sql = yield* SqlClient;
    const [row] = yield* sql<{
      jobSeq: number;
      state: string;
      attempts: number;
      envelope: string;
      lastError: string | null;
      prunedAt: string | null;
    }>`SELECT j.job_seq,j.state,j.attempts,j.last_error,e.envelope,b.pruned_at FROM events e
    JOIN jobs j ON j.event_id=e.id AND j.kind='capture.scan' JOIN blobs b ON b.hash=json_extract(e.envelope,'$.payload.rawCapture')
    WHERE e.kind='capture.filed@1' AND json_extract(e.envelope,'$.payload.rawCapture')=${rawCapture} ORDER BY j.job_seq DESC LIMIT 1`;
    if (row === undefined) return { status: "unknown" as const };
    const event = yield* Effect.try(() =>
      readData(CaptureFiled, JSON.parse(row.envelope)),
    );
    const base = {
      rawCapture,
      jobSeq: row.jobSeq,
      attempts: row.attempts,
      counts: event.payload.counts,
    };
    if (observed._tag === "Failure")
      return {
        ...base,
        status: "refused" as const,
        reason:
          observed.failure instanceof CaptureMarkConflict
            ? observed.failure.reason
            : "capture scan has not passed; export refused",
      };
    if (row.prunedAt !== null)
      return {
        ...base,
        status: "pruned" as const,
        prunedAt: row.prunedAt,
        reason: `raw capture pruned on ${row.prunedAt}`,
      };
    if (
      mark !== undefined &&
      identity !== rawCapture &&
      identity !== mark.payload.record
    )
      return {
        ...base,
        status: "refused" as const,
        reason:
          mark.payload.reason ??
          "capture clean mark disagrees with its sealed record; export refused",
      };
    if (mark !== undefined)
      return {
        ...base,
        status: mark.payload.outcome,
        capture: mark.payload.record,
        markId: mark.id,
        basis: captureMarkBasis(mark),
        reason: mark.payload.reason,
      };
    if (row.state === "failed") {
      const failure = yield* Effect.try(() =>
        z
          .object({ message: z.string() })
          .parse(
            JSON.parse(row.lastError ?? '{"message":"capture scan failed"}'),
          ),
      );
      return { ...base, status: "failed" as const, reason: failure.message };
    }
    return { ...base, status: "pending" as const, state: row.state };
  });
