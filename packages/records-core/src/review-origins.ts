import { safeRead } from "@neuve/records-schema";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  GitHubExternalRefSchema,
  ReviewOriginSchema,
  Ulid,
  type GitHubExternalRef,
  type ReviewOrigin,
} from "@neuve/records-schema";
import { CorruptRecord } from "./errors.ts";
import { assertCompatible } from "./store.ts";

export interface OriginReview {
  readonly association: string;
  readonly reference: string;
  readonly base: string;
  readonly head: string;
  readonly origin: ReviewOrigin;
  readonly at: string;
}

export const cycle = (reference: string) =>
  Effect.gen(function* () {
    yield* assertCompatible;
    const id = Ulid.parse(reference);
    const sql = yield* SqlClient;
    const [row] = yield* sql<{
      reference: string;
      base: string;
      head: string;
    }>`SELECT cycle_id AS reference, base_oid AS base, head_oid AS head FROM projection_cycles WHERE cycle_id = ${id}`;
    return row;
  });

export const list = (query: {
  readonly channel?: string;
  readonly chat?: number;
  readonly identity?: string;
  readonly reference?: string;
  readonly item?: GitHubExternalRef;
}) =>
  Effect.gen(function* () {
    yield* assertCompatible;
    const sql = yield* SqlClient;
    const item =
      query.item === undefined
        ? undefined
        : GitHubExternalRefSchema.parse(query.item);
    const rows = yield* sql<{
      association: string;
      reference: string;
      base: string;
      head: string;
      origin: string;
      at: string;
    }>`SELECT event_id AS association, cycle_id AS reference, base_oid AS base, head_oid AS head,
      origin_json AS origin, occurred_at AS at FROM projection_review_origins
      WHERE (${query.channel ?? null} IS NULL OR channel = ${query.channel ?? null})
        AND (${query.chat ?? null} IS NULL OR chat = ${query.chat ?? null})
        AND (${query.identity ?? null} IS NULL OR identity = ${query.identity ?? null})
        AND (${query.reference ?? null} IS NULL OR cycle_id = ${query.reference ?? null})
      ORDER BY event_id DESC`;
    const found: OriginReview[] = [];
    for (const row of rows) {
      const origin = safeRead(ReviewOriginSchema, JSON.parse(row.origin));
      if (!origin.success)
        return yield* new CorruptRecord({
          message: `review origin ${row.association}: ${origin.error.message}`,
        });
      if (
        item !== undefined &&
        !origin.data.items.some(
          (candidate) =>
            candidate.provider === item.provider &&
            candidate.repo.toLowerCase() === item.repo.toLowerCase() &&
            candidate.kind === item.kind &&
            candidate.number === item.number,
        )
      )
        continue;
      found.push({ ...row, origin: origin.data });
    }
    return found;
  });
