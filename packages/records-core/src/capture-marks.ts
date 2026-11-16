import { readData } from "./compatible-read.ts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { z } from "zod";
import { RecordEvent, PublicRefusal } from "@neuve/records-schema";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { CorruptRecord } from "./errors.ts";
export const CAPTURE_DETECTOR_VERSION = "capture-scan-v1";
export const CAPTURE_SCAN_ACTOR = sha256Hex("neuve/capture-scan/1");
/** Resolve record aliases first, then follow only sealed, explicit replacements of the current mark. */
export const captureRawIdentity = (identity: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const [raw] = yield* sql<{
      rawCapture: string;
    }>`SELECT json_extract(envelope,'$.payload.rawCapture') AS raw_capture FROM events WHERE kind='capture.sealed@1' AND actor_id=${CAPTURE_SCAN_ACTOR}
      AND json_extract(envelope,'$.payload.detectorVersion')=${CAPTURE_DETECTOR_VERSION} AND json_extract(envelope,'$.payload.rawCapture')=${identity} ORDER BY seq LIMIT 1`;
    const source =
      raw ??
      (yield* sql<{
        rawCapture: string;
      }>`SELECT json_extract(envelope,'$.payload.rawCapture') AS raw_capture FROM events WHERE kind='capture.sealed@1' AND actor_id=${CAPTURE_SCAN_ACTOR}
      AND json_extract(envelope,'$.payload.detectorVersion')=${CAPTURE_DETECTOR_VERSION} AND json_extract(envelope,'$.payload.record')=${identity} ORDER BY seq LIMIT 1`)[0];
    return source?.rawCapture;
  });

export const captureMarkState = (identity: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rawCapture = yield* captureRawIdentity(identity);
    if (rawCapture === undefined) return { mark: undefined, conflicted: false };

    let current:
      | Extract<z.infer<typeof RecordEvent>, { kind: "capture.marked@1" }>
      | undefined;
    let after = 0;
    for (;;) {
      const rows = yield* sql<{
        seq: number;
        envelope: string;
        seal: string | null;
      }>`SELECT m.seq,m.envelope,s.envelope AS seal FROM events m LEFT JOIN events s ON s.seq=m.seq-1 AND s.kind='capture.sealed@1'
        WHERE m.kind='capture.marked@1' AND m.seq>${after} AND json_extract(m.envelope,'$.payload.rawCapture')=${rawCapture}
        AND json_extract(m.envelope,'$.payload.detectorVersion')=${CAPTURE_DETECTOR_VERSION} ORDER BY m.seq LIMIT 128`;
      for (const row of rows) {
        after = row.seq;
        if (row.seal === null) continue;
        const mark = yield* Effect.try({
          try: () => readData(RecordEvent, JSON.parse(row.envelope)),
          catch: () =>
            new CorruptRecord({ message: "invalid capture mark envelope" }),
        });
        const seal = yield* Effect.try({
          try: () => readData(RecordEvent, JSON.parse(row.seal!)),
          catch: () =>
            new CorruptRecord({ message: "invalid capture seal envelope" }),
        });
        if (
          mark.kind !== "capture.marked@1" ||
          seal.kind !== "capture.sealed@1" ||
          mark.actor !== CAPTURE_SCAN_ACTOR ||
          seal.actor !== CAPTURE_SCAN_ACTOR ||
          canonicalJson(JSON.parse(row.envelope).payload) !==
            canonicalJson(JSON.parse(row.seal).payload)
        )
          continue;
        const key =
          current === undefined
            ? `${rawCapture}:${CAPTURE_DETECTOR_VERSION}`
            : `audit:${current.id}:${mark.payload.record}`;
        const suffix = seal.idempotencyKey.slice(
          `capture.sealed:${key}`.length,
        );
        if (
          !seal.idempotencyKey.startsWith(`capture.sealed:${key}`) ||
          (suffix !== "" &&
            !/^:job:[1-9][0-9]*:attempt:[1-9][0-9]*$/.test(suffix)) ||
          mark.idempotencyKey !== `capture.marked:${key}${suffix}`
        )
          continue;
        if (current === undefined) {
          // Initial marks written before causal seal links used the same adjacent event pair.
          if (
            mark.causation?.supersedes !== undefined ||
            (mark.causation?.causedBy !== undefined &&
              mark.causation.causedBy !== undefined &&
              mark.causation.causedBy !== seal.id)
          )
            continue;
        } else if (
          mark.causation?.supersedes !== current.id ||
          (mark.causation.causedBy !== undefined &&
            mark.causation.causedBy !== seal.id)
        )
          continue;
        current = mark;
      }
      if (rows.length < 128) {
        if (current !== undefined) {
          for (const kind of ["sealed", "marked"] as const) {
            const prefix = `capture.${kind}:audit:${current.id}:`;
            const [squatted] =
              yield* sql`SELECT 1 FROM events WHERE idempotency_key >= ${prefix} AND idempotency_key < ${prefix + "~"} LIMIT 1`;
            if (squatted !== undefined)
              return { mark: current, conflicted: true };
          }
        }
        if (
          current !== undefined &&
          current.payload.reason !== undefined &&
          !PublicRefusal.safeParse(current.payload.reason).success
        )
          return {
            mark: {
              ...current,
              payload: {
                ...current.payload,
                outcome: "refused" as const,
                reason: "capture scan has not passed; export refused",
              },
            },
            conflicted: false,
          };
        return { mark: current, conflicted: false };
      }
    }
  });

/** The existing reference role carries the basis without adding a field to a stored known kind (12.24). */
export const captureMarkBasis = (
  mark: Extract<z.infer<typeof RecordEvent>, { kind: "capture.marked@1" }>,
): "source-scan" | "legacy-certificates" =>
  mark.refs?.some(
    (ref) =>
      ref.ref === `blob:${mark.payload.record}` &&
      ref.role === "scan-basis:legacy-certificates",
  )
    ? "legacy-certificates"
    : "source-scan";
