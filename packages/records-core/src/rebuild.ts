import {
  RecordEvent,
  ReviewOriginSchema,
  safeRead,
  sayOnce,
} from "@neuve/records-schema";
import { Effect, Option } from "effect";
import * as Str from "effect/String";
import { SqlClient } from "effect/sql/SqlClient";
import { z } from "zod";
import {
  ActorActivityView,
  ActorView,
  BatchView,
  CommentView,
  CommitRewriteView,
  CommitView,
  ContextReferenceView,
  CycleView,
  DeliveryView,
  DispositionView,
  FeedbackView,
  GapView,
  PacketView,
  ProofView,
  ReviewOriginView,
  RunView,
  StageView,
  SupersessionView,
  UnitView,
} from "@neuve/records-schema";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { decodeStoredEvent } from "./codec.ts";
import { CorruptRecord } from "./errors.ts";
import { project } from "./projectors.ts";
import { PROJECTOR_VERSION } from "./schema.ts";

/** Each projection table, its read model and the key that orders it for checksums. */
export const PROJECTIONS: ReadonlyArray<{
  readonly table: string;
  readonly orderBy: string;
  readonly view: z.ZodObject;
  readonly jsonColumns?: Readonly<Record<string, z.ZodType>>;
}> = [
  { table: "projection_actors", orderBy: "actor_id", view: ActorView },
  {
    table: "projection_actor_activity",
    orderBy: "actor_id",
    view: ActorActivityView,
  },
  { table: "projection_cycles", orderBy: "cycle_id", view: CycleView },
  { table: "projection_batches", orderBy: "batch_id", view: BatchView },
  { table: "projection_units", orderBy: "unit_id", view: UnitView },
  {
    table: "projection_dispositions",
    orderBy: "event_id",
    view: DispositionView,
  },
  {
    table: "projection_supersessions",
    orderBy: "target_id, by_event_id",
    view: SupersessionView,
  },
  { table: "projection_comments", orderBy: "event_id", view: CommentView },
  {
    table: "projection_context_references",
    orderBy: "event_id",
    view: ContextReferenceView,
  },
  { table: "projection_commits", orderBy: "oid", view: CommitView },
  {
    table: "projection_commit_rewrites",
    orderBy: "from_oid, to_oid",
    view: CommitRewriteView,
  },
  { table: "projection_deliveries", orderBy: "event_id", view: DeliveryView },
  { table: "projection_packets", orderBy: "event_id", view: PacketView },
  { table: "projection_gaps", orderBy: "event_id", view: GapView },
  { table: "projection_stages", orderBy: "event_id", view: StageView },
  { table: "projection_runs", orderBy: "run_id", view: RunView },
  { table: "projection_proofs", orderBy: "event_id", view: ProofView },
  { table: "projection_feedback", orderBy: "event_id", view: FeedbackView },
  {
    table: "projection_review_origins",
    orderBy: "event_id",
    view: ReviewOriginView,
    jsonColumns: { originJson: ReviewOriginSchema },
  },
];

export interface ProjectionChecksum {
  readonly table: string;
  readonly rows: number;
  readonly sha256: string;
}

/** sha256 over each projection table's rows, validated through its read model and hashed as stored. */
export const projectionChecksums = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const checksums: Array<ProjectionChecksum> = [];
  for (const { table, orderBy, view } of PROJECTIONS) {
    const rows = yield* sql.unsafe<Record<string, unknown>>(
      `SELECT * FROM ${table} ORDER BY ${orderBy}`,
    );
    const hash = new Bun.CryptoHasher("sha256");
    for (const row of rows) {
      const parsed = safeRead(view, row);
      if (!parsed.success)
        return yield* new CorruptRecord({
          message: `${table}: ${parsed.error.message}`,
        });
      hash.update(`${canonicalJson(row)}\n`);
    }
    checksums.push({ table, rows: rows.length, sha256: hash.digest("hex") });
  }
  return checksums;
});

/** One digest over all tables, for a single line to compare. */
export const combinedChecksum = (
  checksums: ReadonlyArray<ProjectionChecksum>,
) =>
  sha256Hex(
    checksums.map(({ table, sha256 }) => `${table}:${sha256}`).join("\n"),
  );

const PAGE = 1_000;

/** Validate everything before deletion; a rebuild cannot reconstruct newer fields. */
export const rebuildProjections = Effect.gen(function* () {
  const sql = yield* SqlClient;
  let leave = false;
  const reasons = new Set<string>();
  const [version] = yield* sql<{
    value: number;
  }>`SELECT value FROM records_meta WHERE key='projections_version'`;
  if (version !== undefined && version.value > PROJECTOR_VERSION) {
    leave = true;
    reasons.add("projections_version");
  }
  for (const { table, view, jsonColumns = {} } of PROJECTIONS) {
    const columns = yield* sql.unsafe<{ name: string }>(
      `PRAGMA table_info(${table})`,
    );
    for (const column of columns) {
      const name = Str.snakeToCamel(column.name);
      if (!Object.hasOwn(view.shape, name)) {
        leave = true;
        reasons.add(`${table}.${name}`);
      }
    }
    const rows = yield* sql.unsafe<Record<string, unknown>>(
      `SELECT * FROM ${table}`,
    );
    for (const row of rows) {
      const read = safeRead(view, row, { notice: false });
      if (!read.success)
        return yield* new CorruptRecord({
          message: `${table}: ${read.error.message}`,
        });
      for (const key of read.droppedKeys) {
        leave = true;
        reasons.add(`${table}.${key}`);
      }
      for (const [column, schema] of Object.entries(jsonColumns)) {
        const json = yield* Effect.try({
          try: () => JSON.parse(z.string().parse(row[column])) as unknown,
          catch: () =>
            new CorruptRecord({ message: `${table}.${column}: invalid JSON` }),
        });
        const decoded = safeRead(schema, json, { notice: false });
        if (!decoded.success)
          return yield* new CorruptRecord({
            message: `${table}.${column}: ${decoded.error.message}`,
          });
        for (const key of decoded.droppedKeys) {
          leave = true;
          reasons.add(`${table}.${column}.${key}`);
        }
      }
    }
  }
  let after = 0;
  let newer = 0;
  for (;;) {
    const page = yield* sql<{
      seq: number;
      kind: string;
      envelope: string;
    }>`SELECT seq, kind, envelope FROM events
      WHERE seq > ${after} ORDER BY seq LIMIT ${PAGE}`;
    for (const row of page) {
      after = row.seq;
      const event = yield* decodeStoredEvent(row, `event seq ${row.seq}`);
      if (Option.isNone(event)) {
        newer += 1;
        leave = true;
        continue;
      }
      const read = safeRead(RecordEvent, JSON.parse(row.envelope), {
        notice: false,
      });
      if (read.success)
        for (const key of read.droppedKeys) {
          leave = true;
          reasons.add(key);
        }
    }
    if (page.length < PAGE) break;
  }
  if (leave) {
    sayOnce(
      "compatible-read",
      `neuve: compatibility mode; leaving projection rebuild to a newer build (${
        [...reasons]
          .slice(0, 8)
          .map((key) => key.slice(0, 100))
          .join(", ") || "newer event kinds"
      }); stored projections are unchanged`,
      (line) => process.stderr.write(`${line}\n`),
    );
    // Keep the true projector version, and remember that this projector must not retry on every
    // open. A later projector has a different version and tries again with its own knowledge.
    yield* sql`INSERT INTO records_meta (key, value) SELECT 'projections_deferred_at', ${PROJECTOR_VERSION}
      WHERE coalesce((SELECT value FROM records_meta WHERE key='projections_version'), ${PROJECTOR_VERSION}) < ${PROJECTOR_VERSION}
      ON CONFLICT (key) DO UPDATE SET value=excluded.value`;
    return { replayed: 0, newer, deferred: true };
  }
  for (const { table } of PROJECTIONS)
    yield* sql.unsafe(`DELETE FROM ${table}`);
  after = 0;
  let replayed = 0;
  for (;;) {
    const page = yield* sql<{
      seq: number;
      kind: string;
      envelope: string;
    }>`SELECT seq, kind, envelope FROM events
      WHERE seq > ${after} ORDER BY seq LIMIT ${PAGE}`;
    for (const row of page) {
      after = row.seq;
      const event = yield* decodeStoredEvent(row, `event seq ${row.seq}`);
      if (Option.isSome(event)) {
        yield* project(event.value);
        replayed += 1;
      }
    }
    if (page.length < PAGE) break;
  }
  yield* sql`INSERT INTO records_meta (key, value) VALUES ('projections_version', ${PROJECTOR_VERSION})
    ON CONFLICT (key) DO UPDATE SET value = excluded.value`;
  yield* sql`DELETE FROM records_meta WHERE key='projections_deferred_at'`;
  return { replayed, newer, deferred: false };
});
