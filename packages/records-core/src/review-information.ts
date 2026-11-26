import { Clock, Data, Effect, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  ReviewInformationDetails,
  ReviewInformationFact,
  ReviewInformationRecorded,
  ReviewInformationReadQuery,
} from "@neuve/records-schema";
import { BlobStore } from "./blobs.ts";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { CorruptRecord } from "./errors.ts";
import { mintUlid } from "./ids.ts";
import { append, get } from "./log.ts";

const actor = sha256Hex("neuve/harness/review-information/1");
const MAX_DETAILS_BYTES = 1_048_576;
export class InformationRefused extends Data.TaggedError("InformationRefused")<{
  readonly message: string;
}> {}

export type InformationInput = ReviewInformationFact &
  ReviewInformationDetails & {
    readonly cycleId: string;
    /** The draining run, not a replacement for the original producer/source in details. */
    readonly runId: string;
  };

/** One immutable status fact per complete input; replay never duplicates it or changes a packet. */
export const record = (input: InformationInput) =>
  Effect.gen(function* () {
    const { cycleId, runId, report, source, ...fact } = input;
    const parsed = ReviewInformationFact.safeParse(fact);
    const details = ReviewInformationDetails.safeParse({ report, source });
    if (!parsed.success || !details.success)
      return yield* new InformationRefused({
        message: "Invalid attributed review information",
      });
    const bytes = new TextEncoder().encode(canonicalJson(details.data));
    if (bytes.length > MAX_DETAILS_BYTES)
      return yield* new InformationRefused({
        message: "Review information exceeds its retained detail bound",
      });
    const blobs = yield* BlobStore;
    const stored = yield* blobs.put({
      bytes,
      mediaType: "application/json",
      retention: "durable",
    });
    const payload = { ...parsed.data, details: stored.blob.hash };
    const attribution = { cycleId, runId };
    const event = ReviewInformationRecorded.safeParse({
      id: mintUlid(),
      kind: "review.information-recorded@1",
      actor,
      occurredAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
      // The drain may be retried by another host. Its run is not another producer or vote.
      idempotencyKey: `review-information:${sha256Hex(canonicalJson({ cycleId, payload }))}`,
      attribution,
      refs: [
        { ref: `blob:${stored.blob.hash}`, role: "original-claim-and-source" },
      ],
      payload,
    });
    if (!event.success)
      return yield* new InformationRefused({
        message: "Invalid review information attribution",
      });
    // Attribution must be stable across drains too: recover the original event rather than sending
    // a later runId under the same content key (which Records correctly treats as a conflict).
    const sql = yield* SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [held] = yield* sql<{
          id: string;
          seq: number;
        }>`SELECT id, seq FROM events
      WHERE idempotency_key = ${event.data.idempotencyKey}`;
        if (held)
          return { status: "existing" as const, id: held.id, seq: held.seq };
        return (yield* append([event.data]))[0]!;
      }),
    );
  });

export interface InformationRow {
  readonly seq: number;
  readonly event: typeof ReviewInformationRecorded._output;
  readonly details:
    | { readonly status: "available"; readonly value: ReviewInformationDetails }
    | { readonly status: "unavailable"; readonly reason: string };
}

/** Independent side-channel projection; never inserts comments, changes closure or rewrites manifests. */
export const read = (input: ReviewInformationReadQuery) =>
  Effect.gen(function* () {
    const parsed = ReviewInformationReadQuery.safeParse(input);
    if (!parsed.success)
      return yield* new InformationRefused({
        message: "Invalid review information read query",
      });
    const query = parsed.data;
    const limit = query.limit ?? 100;
    const sql = yield* SqlClient;
    const classification =
      query.classifications === undefined
        ? sql`1`
        : sql`json_extract(envelope, '$.payload.classification') IN ${sql.in(query.classifications)}`;
    const destination =
      query.destination === undefined
        ? sql`1`
        : query.destination.kind === "unassigned"
          ? sql`json_extract(envelope, '$.payload.destination.kind') = 'unassigned'`
          : sql`json_extract(envelope, '$.payload.destination.kind') = 'owned'
          AND json_extract(envelope, '$.payload.destination.sectionKey') IN ${sql.in(query.destination.sectionKeys)}`;
    const rows = yield* sql<{
      seq: number;
      envelope: string;
    }>`SELECT seq, envelope FROM events
      WHERE kind = 'review.information-recorded@1'
        AND json_extract(envelope, '$.attribution.cycleId') = ${query.cycleId}
        AND json_extract(envelope, '$.payload.runKey') = ${query.runKey}
        AND seq > ${query.afterSeq ?? 0}
        AND ${classification} AND ${destination}
      ORDER BY seq LIMIT ${limit + 1}`;
    const blobs = yield* BlobStore;
    const items: InformationRow[] = [];
    let remainingDetails = query.detailsBytes ?? 65_536;
    for (const row of rows.slice(0, limit)) {
      const event = yield* Effect.try({
        try: () => ReviewInformationRecorded.parse(JSON.parse(row.envelope)),
        catch: () =>
          new CorruptRecord({ message: "Invalid retained review information" }),
      });
      const metadata = yield* blobs.inspect(event.payload.details);
      if (Option.isSome(metadata) && metadata.value.size > remainingDetails) {
        items.push({
          seq: row.seq,
          event,
          details: {
            status: "unavailable",
            reason: `Original report/source details retained in blob ${event.payload.details}, omitted from this bounded view. This observation is not resolved.`,
          },
        });
        continue;
      }
      if (Option.isSome(metadata)) remainingDetails -= metadata.value.size;
      const result = yield* Effect.result(
        Effect.gen(function* () {
          const held = yield* blobs.get(event.payload.details);
          if (held._tag !== "Present")
            return yield* new InformationRefused({
              message: "Original detail was pruned",
            });
          return yield* Effect.try({
            try: () =>
              ReviewInformationDetails.parse(
                JSON.parse(new TextDecoder().decode(held.bytes)),
              ),
            catch: () =>
              new CorruptRecord({
                message: "Invalid review information details",
              }),
          });
        }),
      );
      items.push({
        seq: row.seq,
        event,
        details:
          result._tag === "Success"
            ? { status: "available", value: result.success }
            : {
                status: "unavailable",
                reason:
                  "Original claim/source details could not be read; this observation is not resolved.",
              },
      });
    }
    return {
      items,
      hasMore: rows.length > limit,
      nextSeq: items.at(-1)?.seq ?? query.afterSeq ?? 0,
    };
  });

/** Includes follow-on runs' observations, even when this run has no published packet. */
export const forRun = (
  runId: string,
  page?: Omit<ReviewInformationReadQuery, "cycleId" | "runKey">,
) =>
  Effect.gen(function* () {
    const parsed = ReviewInformationReadQuery.omit({
      cycleId: true,
      runKey: true,
    }).safeParse(page ?? {});
    if (!parsed.success)
      return yield* new InformationRefused({
        message: "Invalid review information page query",
      });
    const held = Option.getOrUndefined(yield* get(runId));
    if (held?.event.kind !== "review.requested@1") return undefined;
    return yield* read({
      ...parsed.data,
      cycleId: held.event.attribution.cycleId,
      runKey: held.event.payload.runKey,
    });
  });
