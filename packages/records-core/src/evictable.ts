import { Clock, Data, Duration, Effect, Metric, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { BlobStore } from "./blobs.ts";
import { assertCompatible } from "./store.ts";

/**
 * Evictable outputs (design `records-evictable-outputs`, migration 20). A producer declares a kind
 * recomputable with a byte cap; Records then evicts that kind's oldest stored outputs while their
 * bytes, each blob once, exceed the cap. Eviction removes the computation row, the attempts of its
 * key and, when nothing else names it, the output blob, so every reader in every build sees "never
 * computed" and computes again under the same key (record 0016). The store's triggers refuse any
 * other delete: an output an event names, or one a model produced, is never evicted.
 */

/** An output stored this recently is never evicted, so a caller just told "done" always finds it. */
export const EVICT_AFTER = Duration.minutes(15);

/** Over-cap candidates read per page, oldest stored first. */
const CANDIDATES = 64;

const OP = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*$/;

export interface KindDeclaration {
  readonly op: string;
  readonly recomputable: boolean;
  readonly capBytes: number;
  readonly declaredAt: string;
}

export interface DeclaredKind extends KindDeclaration {
  /** `unchanged` when the same declaration was already stored, so nothing was written. */
  readonly status: "declared" | "updated" | "unchanged";
}

/** The operation name or cap is not one Records can declare. */
export class InvalidKindDeclaration extends Data.TaggedError(
  "InvalidKindDeclaration",
)<{
  readonly op: string;
  readonly message: string;
}> {}

/**
 * Records refuses to make a kind recomputable when one of its stored outputs must stay durable:
 * a model produced it (its attempt holds a model or usage, decision 12.45), or an event names it.
 */
export class KindNotRecomputable extends Data.TaggedError(
  "KindNotRecomputable",
)<{
  readonly op: string;
  readonly reason: "model" | "event";
}> {
  override get message() {
    return this.reason === "model"
      ? `${this.op} cannot be declared recomputable: a model produced one of its stored outputs, which stay permanent`
      : `${this.op} cannot be declared recomputable: an event names one of its stored outputs, which stay permanent`;
  }
}

/** What one eviction pass over a kind did. */
export interface EvictReport {
  readonly op: string;
  /** False when the kind is not declared recomputable; nothing is then evicted. */
  readonly declared: boolean;
  readonly capBytes: number | null;
  /** The kind's output bytes, each blob once, before the pass and after it. */
  readonly storedBytes: number;
  readonly remainingBytes: number;
  /** Outputs evicted: computation rows, with the attempts of their keys. */
  readonly outputs: number;
  /** Output blobs deleted with them (a blob another row still names stays) and their bytes. */
  readonly blobs: number;
  readonly bytes: number;
  /** Over-cap candidates the store keeps: an event names them, or a model produced them. */
  readonly refused: number;
  /** Files removed: this pass's, and any an interrupted removal left. */
  readonly removed: number;
  /** Files whose removal failed; their marks stay, and the next pass tries again. */
  readonly removalFailures: number;
}

const COUNTERS = {
  outputs: Metric.counter("records.computations.evicted", {
    description: "Stored outputs evicted, by kind",
    incremental: true,
  }),
  bytes: Metric.counter("records.computations.evicted.bytes", {
    description: "Output blob bytes evicted, by kind",
    incremental: true,
  }),
};

const kindRow = (op: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const [row] = yield* sql<{
      op: string;
      recomputable: number;
      capBytes: number;
      declaredAt: string;
    }>`SELECT op, recomputable, cap_bytes, declared_at FROM computation_kinds WHERE op = ${op}`;
    return row === undefined
      ? Option.none<KindDeclaration>()
      : Option.some<KindDeclaration>({
          op: row.op,
          recomputable: row.recomputable === 1,
          capBytes: row.capBytes,
          declaredAt: row.declaredAt,
        });
  });

/** The declaration of `op`, when it is declared recomputable. */
export const recomputableKind = (op: string) =>
  Effect.map(
    kindRow(op),
    Option.filter((kind) => kind.recomputable),
  );

/** Every declaration, by operation name. */
export const kinds = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* assertCompatible;
  const rows = yield* sql<{
    op: string;
    recomputable: number;
    capBytes: number;
    declaredAt: string;
  }>`SELECT op, recomputable, cap_bytes, declared_at FROM computation_kinds ORDER BY op`;
  return rows.map((row): KindDeclaration => ({
    op: row.op,
    recomputable: row.recomputable === 1,
    capBytes: row.capBytes,
    declaredAt: row.declaredAt,
  }));
});

/**
 * Whether an event's `refs` name a stored output of the kind (`?`). SQLite scans the log once and
 * looks each reference up by key (`EXPLAIN QUERY PLAN`: `SCAN e`, `SCAN r VIRTUAL TABLE`, then
 * `SEARCH c EXISTS USING INDEX sqlite_autoindex_computations_1 (key=?)`); a join on `c.op` instead
 * put `computations` outermost and scanned the log once per output.
 */
export const NAMED_BY_AN_EVENT = `SELECT 1 AS one FROM events e JOIN json_each(e.envelope, '$.refs') r
  WHERE instr(e.envelope, '"computation:') > 0
    AND json_extract(r.value, '$.ref') LIKE 'computation:%'
    AND EXISTS (SELECT 1 FROM computations c
      WHERE c.key = substr(json_extract(r.value, '$.ref'), 13) AND c.op = ?)
  LIMIT 1`;

/** Refused when an attempt of a stored output of `op` holds a model or usage: one lookup per output. */
const refuseModelled = (op: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const [modelled] = yield* sql<{
      one: number;
    }>`SELECT 1 AS one FROM computations c JOIN computation_attempts a ON a.key = c.key
      WHERE c.op = ${op} AND (a.model IS NOT NULL OR a.usage IS NOT NULL) LIMIT 1`;
    if (modelled !== undefined)
      return yield* new KindNotRecomputable({ op, reason: "model" });
  });

/**
 * Refused when an event's `refs` name a stored output of `op`. One scan of the log whatever the kind
 * holds: each reference is looked up in `computations` by key, never the log once per output.
 * Nothing is read when the kind holds no output.
 */
const refuseNamed = (op: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const [holds] = yield* sql<{
      one: number;
    }>`SELECT 1 AS one FROM computations WHERE op = ${op} LIMIT 1`;
    if (holds === undefined) return;
    const [named] = yield* sql.unsafe<{ one: number }>(NAMED_BY_AN_EVENT, [op]);
    if (named !== undefined)
      return yield* new KindNotRecomputable({ op, reason: "event" });
  });

/**
 * Declares `op` recomputable with a byte cap, as its producer does when it starts. Idempotent: the
 * same declaration reads once and writes nothing; a new cap is an update. Making a kind recomputable
 * is refused, with nothing written, when a model produced one of its stored outputs or an event's
 * `refs` name one.
 */
export const declareKind = (declaration: {
  readonly op: string;
  readonly capBytes: number;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const { op, capBytes } = declaration;
    if (!OP.test(op) || op.length > 128)
      return yield* new InvalidKindDeclaration({
        op,
        message: "Expected an operation name",
      });
    if (!Number.isSafeInteger(capBytes) || capBytes < 0)
      return yield* new InvalidKindDeclaration({
        op,
        message: "Expected a cap of zero or more whole bytes",
      });
    const unchanged = (held: Option.Option<KindDeclaration>) =>
      Option.isSome(held) &&
      held.value.recomputable &&
      held.value.capBytes === capBytes
        ? Option.some<DeclaredKind>({ ...held.value, status: "unchanged" })
        : Option.none<DeclaredKind>();
    yield* assertCompatible;
    const seen = kindRow(op);
    const before = yield* seen;
    const same = unchanged(before);
    if (Option.isSome(same)) return same.value;
    const isFirst = (held: Option.Option<KindDeclaration>) =>
      !(Option.isSome(held) && held.value.recomputable);
    // Making a kind recomputable is checked before the write lock: the log is read once, outside
    // it. Only the model check, which is an index lookup per output, is read again under the lock.
    // A row that an event names or a model produces after this read is not evictable anyway: the
    // triggers refuse its delete.
    const checkedBefore = isFirst(before);
    if (checkedBefore) {
      yield* refuseModelled(op);
      yield* refuseNamed(op);
    }
    const at = new Date(yield* Clock.currentTimeMillis).toISOString();
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* assertCompatible;
        const held = yield* seen;
        const stillSame = unchanged(held);
        if (Option.isSome(stillSame)) return stillSame.value;
        // Only making a kind recomputable is checked; a declared kind's new cap is an update, and
        // the triggers keep any of its rows a model produced or an event names since.
        if (isFirst(held)) {
          yield* refuseModelled(op);
          // Declared by another process meanwhile and undeclared again by hand: read it here.
          if (!checkedBefore) yield* refuseNamed(op);
        }
        yield* sql`INSERT INTO computation_kinds (op, recomputable, cap_bytes, declared_at)
          VALUES (${op}, 1, ${capBytes}, ${at})
          ON CONFLICT (op) DO UPDATE SET recomputable = 1, cap_bytes = excluded.cap_bytes,
            declared_at = excluded.declared_at`;
        const declared: DeclaredKind = {
          op,
          recomputable: true,
          capBytes,
          declaredAt: at,
          status: Option.isSome(held) ? "updated" : "declared",
        };
        return declared;
      }),
    );
  });

/**
 * Whether `computation`, read before its output, was evicted meanwhile: its kind is declared
 * recomputable and its key no longer holds that row (gone, or computed again since). A reader that
 * then finds the output blob missing has a miss, not corruption. Any other kind answers false, so
 * its readers keep the error they have today.
 */
export const evictedMeanwhile = (computation: {
  readonly key: string;
  readonly op: string;
  readonly attemptId: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    if (Option.isNone(yield* recomputableKind(computation.op))) return false;
    const [row] = yield* sql<{
      attemptId: string;
    }>`SELECT attempt_id FROM computations WHERE key = ${computation.key}`;
    return row === undefined || row.attemptId !== computation.attemptId;
  });

/** The kind's output bytes, each blob once (two keys with identical bytes share one blob). */
const kindBytes = (op: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const [row] = yield* sql<{
      bytes: number;
    }>`SELECT coalesce(sum(size), 0) AS bytes FROM blobs
      WHERE hash IN (SELECT output_hash FROM computations WHERE op = ${op})`;
    return row?.bytes ?? 0;
  });

const errorText = (error: SqlError) => {
  const reason = error.reason as {
    readonly message?: unknown;
    cause?: unknown;
  };
  return `${error.message} ${String(reason.message ?? "")} ${String(reason.cause ?? "")}`;
};

/** The store's own refusal, from a trigger of migration 20. */
const refusedByStore = (error: SqlError) =>
  /not evictable|blobs keep their row/.test(errorText(error));

type Outcome =
  | { readonly _tag: "Gone" }
  | { readonly _tag: "Refused" }
  | {
      readonly _tag: "Evicted";
      /** Bytes the kind no longer names: the blob's size, unless another key of the kind names it. */
      readonly freed: number;
      /** The blob deleted with it, if this was its last referrer. */
      readonly deleted:
        | {
            readonly hash: string;
            readonly bytes: number;
            readonly file: boolean;
          }
        | undefined;
    };

/** The store refused the computation row; failing rolls the output's transaction back. */
class RowRefused extends Data.TaggedError("RowRefused")<{}> {}

const GONE: Outcome = { _tag: "Gone" };
const REFUSED: Outcome = { _tag: "Refused" };

/**
 * One output in one write transaction (`BEGIN IMMEDIATE`): the computation row, the finished
 * attempts of its key and, when nothing else names it, the blob row, marked in `blob_removals` first
 * so its file can be removed after the commit. Whether an event names the output or its blob is
 * known only by scanning the log, so that check is left to the triggers, once each, rather than read
 * here too: a refused row rolls the transaction back (`Refused`), and a refused blob delete is undone
 * alone, so the row and attempts still go and the blob stays. The cheap checks (a model, another row
 * naming the blob) are read first, so a kept output is skipped without a scan.
 *
 * Under the lock it evicts only the row the pass selected: the same attempt, still older than
 * `EVICT_AFTER` by the clock read now. Another process may have evicted the key and a caller
 * computed it again since the pass read its page; that new output is `Gone` to this pass.
 */
const evictOne = (op: string, key: string, attemptId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const refusal = (error: SqlError) =>
      refusedByStore(error) ? Effect.succeed(true) : Effect.fail(error);
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* assertCompatible;
          const [row] = yield* sql<{
            op: string;
            outputHash: string;
            attemptId: string;
            completedAt: string;
          }>`SELECT op, output_hash, attempt_id, completed_at FROM computations WHERE key = ${key}`;
          const nowMillis = yield* Clock.currentTimeMillis;
          const at = new Date(nowMillis).toISOString();
          if (
            row === undefined ||
            row.op !== op ||
            row.attemptId !== attemptId ||
            row.completedAt >= freshFrom(nowMillis)
          )
            return GONE;
          const [modelled] = yield* sql<{
            one: number;
          }>`SELECT 1 AS one FROM computation_attempts
            WHERE key = ${key} AND (model IS NOT NULL OR usage IS NOT NULL) LIMIT 1`;
          if (modelled !== undefined) return REFUSED;
          const hash = row.outputHash;
          const [blob] = yield* sql<{
            size: number;
            placement: string;
            retention: string;
            prunedAt: string | null;
          }>`SELECT size, placement, retention, pruned_at FROM blobs WHERE hash = ${hash}`;
          const [shared] = yield* sql<{
            one: number;
          }>`SELECT 1 AS one WHERE
              EXISTS (SELECT 1 FROM computations WHERE output_hash = ${hash} AND key <> ${key})
              OR EXISTS (SELECT 1 FROM computation_attempts WHERE output_hash = ${hash} AND key <> ${key})
              OR EXISTS (SELECT 1 FROM computation_attempts WHERE cause_blob = ${hash})`;
          const candidate =
            blob !== undefined &&
            shared === undefined &&
            blob.retention === "durable" &&
            blob.prunedAt === null;
          if (candidate)
            yield* sql`INSERT INTO blob_removals (hash, at) VALUES (${hash}, ${at})
              ON CONFLICT (hash) DO NOTHING`;
          // The triggers refuse here when an event names the computation; nothing is then kept.
          const rowRefused =
            yield* sql`DELETE FROM computations WHERE key = ${key}`.pipe(
              Effect.as(false),
              Effect.catchTag("SqlError", refusal),
            );
          if (rowRefused) return yield* new RowRefused();
          yield* sql`DELETE FROM computation_attempts WHERE key = ${key} AND outcome <> 'running'`;
          let last = false;
          if (candidate) {
            // A refused statement is undone alone (`RAISE(ABORT)`): an event that names the blob
            // keeps it, and only it.
            const blobRefused =
              yield* sql`DELETE FROM blobs WHERE hash = ${hash}`.pipe(
                Effect.as(false),
                Effect.catchTag("SqlError", refusal),
              );
            last = !blobRefused;
            // An inline blob's bytes went with its row, and a kept blob keeps its bytes.
            if (!last || blob.placement === "inline")
              yield* sql`DELETE FROM blob_removals WHERE hash = ${hash}`;
          }
          const [still] = yield* sql<{
            one: number;
          }>`SELECT 1 AS one FROM computations WHERE op = ${op} AND output_hash = ${hash} LIMIT 1`;
          const evicted: Outcome = {
            _tag: "Evicted",
            freed: still === undefined ? (blob?.size ?? 0) : 0,
            deleted:
              last && blob !== undefined
                ? {
                    hash,
                    bytes: blob.size,
                    file: blob.placement === "file",
                  }
                : undefined,
          };
          return evicted;
        }),
      )
      .pipe(
        Effect.catchTag("RowRefused", () => Effect.succeed(REFUSED)),
        Effect.catchTag("SqlError", (error) =>
          refusedByStore(error) ? Effect.succeed(REFUSED) : Effect.fail(error),
        ),
      );
  });

/** Outputs stored at or after this instant are too fresh to evict at `nowMillis`. */
const freshFrom = (nowMillis: number) =>
  new Date(nowMillis - Duration.toMillis(EVICT_AFTER)).toISOString();

/**
 * At most this many outputs are evicted by the pass that runs after a store, in the storing
 * caller's fiber before `run` returns. Each costs about three scans of the log under the write
 * lock (0.13 s at 58,000 events), so 4 bounds the caller's added time near half a second. A store
 * adds one output, so 4 still shrinks a backlog by at least 3 a store; the daily job's pass is not
 * bounded and clears the rest.
 */
export const AFTER_STORE_LIMIT = 4;

/**
 * Evicts `op`'s oldest stored outputs (`completed_at`) while the kind's bytes exceed its cap, one
 * output per write transaction, never one stored within `EVICT_AFTER`; each deleted blob's file is
 * removed after its commit. With `limit`, it stops after that many outputs. Removals an earlier pass
 * left unfinished are finished first. A kind not declared recomputable is left as it is.
 *
 * Never call it inside a caller's transaction: it removes files after its own commits, so a caller
 * that then rolled back would keep rows whose files are gone.
 */
export const evict = (op: string, options: { readonly limit?: number } = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const blobs = yield* BlobStore;
    yield* assertCompatible;
    let removed = 0;
    let removalFailures = 0;
    const finish = (hashes?: ReadonlyArray<string>) =>
      blobs.removeEvicted(hashes).pipe(
        Effect.map((count) => {
          removed += count;
        }),
        Effect.catchTag("BlobRemoveFailed", () =>
          Effect.andThen(
            Effect.sync(() => {
              removalFailures += 1;
            }),
            Effect.logWarning(
              "records: an evicted output's file was not removed; the next eviction tries again",
            ),
          ),
        ),
      );
    yield* finish();
    const kind = yield* recomputableKind(op);
    const storedBytes = yield* kindBytes(op);
    let remaining = storedBytes;
    let outputs = 0;
    let deletedBlobs = 0;
    let deletedBytes = 0;
    let refused = 0;
    if (Option.isSome(kind) && remaining > kind.value.capBytes) {
      const cap = kind.value.capBytes;
      const limit = options.limit ?? Number.POSITIVE_INFINITY;
      const selectedBefore = freshFrom(yield* Clock.currentTimeMillis);
      let after = { completedAt: "", key: "" };
      scan: while (remaining > cap) {
        const page = yield* sql<{
          key: string;
          attemptId: string;
          completedAt: string;
        }>`SELECT key, attempt_id, completed_at FROM computations
          WHERE op = ${op} AND completed_at < ${selectedBefore}
            AND (completed_at, key) > (${after.completedAt}, ${after.key})
          ORDER BY completed_at, key LIMIT ${CANDIDATES}`;
        if (page.length === 0) break;
        for (const candidate of page) {
          if (remaining <= cap || outputs >= limit) break scan;
          after = candidate;
          const outcome = yield* evictOne(
            op,
            candidate.key,
            candidate.attemptId,
          );
          if (outcome._tag === "Refused") refused += 1;
          // Another process changed the kind meanwhile: read its bytes again, not this pass's count.
          if (outcome._tag === "Gone") remaining = yield* kindBytes(op);
          if (outcome._tag !== "Evicted") continue;
          outputs += 1;
          remaining -= outcome.freed;
          if (outcome.deleted !== undefined) {
            deletedBlobs += 1;
            deletedBytes += outcome.deleted.bytes;
            if (outcome.deleted.file) yield* finish([outcome.deleted.hash]);
          }
        }
      }
    }
    if (outputs > 0) {
      const attributes = { "records.computation.op": op };
      yield* Metric.update(
        Metric.withAttributes(COUNTERS.outputs, attributes),
        outputs,
      );
      yield* Metric.update(
        Metric.withAttributes(COUNTERS.bytes, attributes),
        deletedBytes,
      );
    }
    const report: EvictReport = {
      op,
      declared: Option.isSome(kind),
      capBytes: Option.isSome(kind) ? kind.value.capBytes : null,
      storedBytes,
      remainingBytes: remaining,
      outputs,
      blobs: deletedBlobs,
      bytes: deletedBytes,
      refused,
      removed,
      removalFailures,
    };
    yield* Effect.annotateCurrentSpan({
      "records.computation.op": op,
      "records.evict.outputs": outputs,
      "records.evict.bytes": deletedBytes,
      "records.evict.refused": refused,
    });
    return report;
  }).pipe(Effect.withSpan("records.computations.evict"));

/** One pass over every kind declared recomputable, as the daily `retention.prune` job runs it. */
export const evictDeclared = Effect.gen(function* () {
  const reports: Array<EvictReport> = [];
  for (const kind of yield* kinds)
    if (kind.recomputable) reports.push(yield* evict(kind.op));
  return reports as ReadonlyArray<EvictReport>;
});

/** One line per kind for logs. Counts and bytes only. */
export const describeEvict = (report: EvictReport) =>
  `${report.op}: evicted ${report.outputs} output(s), ${report.blobs} blob(s) (${report.bytes} bytes); ${report.remainingBytes} of ${report.capBytes ?? "no"} cap bytes stored${report.refused > 0 ? `; ${report.refused} kept (named by an event or produced by a model)` : ""}${report.removed > 0 ? `; ${report.removed} file(s) removed` : ""}${report.removalFailures > 0 ? `; ${report.removalFailures} removal(s) to retry` : ""}`;
