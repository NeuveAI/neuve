import { openStoreReader } from "./read-only.ts";
import { basename, join } from "node:path";
import {
  Cause,
  Clock,
  Context,
  Duration,
  Effect,
  Option,
  Result,
} from "effect";
import { FileSystem } from "effect/FileSystem";
import { SqlClient } from "effect/sql/SqlClient";
import { decodeTime } from "ulid";
import { BlobStore, type PrunedBlob } from "./blobs.ts";
import { describeEvict, evictDeclared } from "./evictable.ts";
import type { JobQueue } from "./queue.ts";
import { assertCompatible, backupDirectory } from "./store.ts";
import { RAW_CAPTURE_DAYS, unprotectedRawBlob } from "./raw-capture-parts.ts";

/**
 * Retention of raw captures (5.8, 8.10, D26): transcripts, raw tool outputs and model bodies expire
 * 30 days after capture, with no exemptions. Pruning keeps each blob's row as its tombstone (hash,
 * size, media type, class, capture and prune dates), so events and computations that reference it
 * stay intact and resolve to "pruned on <date>". Durable blobs are never pruned.
 */
export const RAW_CAPTURE_RETENTION = Duration.days(RAW_CAPTURE_DAYS);

/** Raw captures pruned per write transaction, so a large backlog never holds the lock for long. */
const PAGE = 500;

/**
 * When an item named by a ULID (an event, or a run, whose ID is its request's event ID) was minted
 * (D4), from the ID's own timestamp; none when the name is not a ULID. Retention ages local state by
 * it rather than by file times, which some file systems do not record.
 */
export const mintedAt = (id: string): Option.Option<number> => {
  try {
    return Option.some(decodeTime(id));
  } catch {
    return Option.none();
  }
};

/** Captures made before this instant are past retention at `nowMillis`. */
export const cutoffAt = (nowMillis: number) =>
  new Date(nowMillis - Duration.toMillis(RAW_CAPTURE_RETENTION)).toISOString();

const DAY = Duration.toMillis(Duration.days(1));

/** Age bands beyond the 30-day cutoff, for the dry run. */
const AGE_BANDS: ReadonlyArray<{
  readonly label: string;
  readonly fromDays: number;
  readonly toDays: number | null;
}> = [
  { label: "30-37 days", fromDays: 30, toDays: 37 },
  { label: "37-60 days", fromDays: 37, toDays: 60 },
  { label: "60-90 days", fromDays: 60, toDays: 90 },
  { label: "90+ days", fromDays: 90, toDays: null },
];

/** Why the blob folders could not be scanned or a leftover file removed, as one sentence. */
const describeScanFailure = (error: { readonly _tag: string }) => {
  if (error._tag === "BlobScanFailed" || error._tag === "BlobRemoveFailed") {
    const cause = (error as { readonly cause?: { readonly message?: string } })
      .cause;
    return `${error._tag}: ${cause?.message ?? "file system error"}`;
  }
  const message = (error as { readonly message?: unknown }).message;
  return typeof message === "string" ? `${error._tag}: ${message}` : error._tag;
};

export interface Tally {
  readonly blobs: number;
  readonly bytes: number;
}

export interface PrunePlan {
  readonly now: string;
  readonly cutoff: string;
  /** Raw captures past retention, which a prune now would remove. */
  readonly due: Tally & { readonly oldestCapturedAt: string | null };
  readonly byClass: ReadonlyArray<
    Tally & {
      readonly retention: "raw-capture";
      readonly mediaType: string;
      readonly placement: string;
    }
  >;
  readonly byAge: ReadonlyArray<Tally & { readonly label: string }>;
  /**
   * Files still on disk beside a tombstone, left by an interrupted prune; a prune removes them.
   * `null` when the blob folders could not be scanned (`leftoverError` says why).
   */
  readonly leftoverFiles: number | null;
  readonly leftoverError?: string;
  /** Raw captures still within retention. */
  readonly retained: Tally;
  /** Durable blobs: never pruned. */
  readonly durable: Tally;
  /** Tombstones already in the store. */
  readonly tombstones: Tally & { readonly lastPrunedAt: string | null };
}

const tally = (row: { blobs: number; bytes: number } | undefined): Tally => ({
  blobs: row?.blobs ?? 0,
  bytes: row?.bytes ?? 0,
});

/** What a prune at the current time would do, read without writing (`neuve records prune --dry-run`). */
export const plan = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const blobs = yield* BlobStore;
  yield* assertCompatible;
  const nowMillis = yield* Clock.currentTimeMillis;
  const cutoff = cutoffAt(nowMillis);
  const unprotected = (yield* unprotectedRawBlob(cutoff)) ?? sql`1`;
  const [due] = yield* sql<{
    blobs: number;
    bytes: number;
    oldest: string | null;
  }>`SELECT count(*) AS blobs, coalesce(sum(size), 0) AS bytes, min(captured_at) AS oldest
    FROM blobs WHERE retention = 'raw-capture' AND pruned_at IS NULL AND captured_at < ${cutoff} AND ${unprotected}`;
  const byClass = yield* sql<{
    mediaType: string;
    placement: string;
    blobs: number;
    bytes: number;
  }>`SELECT media_type, placement, count(*) AS blobs, coalesce(sum(size), 0) AS bytes
    FROM blobs WHERE retention = 'raw-capture' AND pruned_at IS NULL AND captured_at < ${cutoff} AND ${unprotected}
    GROUP BY media_type, placement ORDER BY media_type, placement`;
  const byAge: Array<Tally & { readonly label: string }> = [];
  for (const band of AGE_BANDS) {
    const newest = new Date(nowMillis - band.fromDays * DAY).toISOString();
    const oldest =
      band.toDays === null
        ? ""
        : new Date(nowMillis - band.toDays * DAY).toISOString();
    const [row] = yield* sql<{
      blobs: number;
      bytes: number;
    }>`SELECT count(*) AS blobs, coalesce(sum(size), 0) AS bytes FROM blobs
      WHERE retention = 'raw-capture' AND pruned_at IS NULL
        AND captured_at < ${newest} AND captured_at >= ${oldest}`;
    byAge.push({ label: band.label, ...tally(row) });
  }
  const [retained] = yield* sql<{
    blobs: number;
    bytes: number;
  }>`SELECT count(*) AS blobs, coalesce(sum(size), 0) AS bytes FROM blobs
    WHERE retention = 'raw-capture' AND pruned_at IS NULL AND (captured_at >= ${cutoff} OR NOT (${unprotected}))`;
  const [durable] = yield* sql<{
    blobs: number;
    bytes: number;
  }>`SELECT count(*) AS blobs, coalesce(sum(size), 0) AS bytes FROM blobs WHERE retention = 'durable'`;
  const [tombstones] = yield* sql<{
    blobs: number;
    bytes: number;
    last: string | null;
  }>`SELECT count(*) AS blobs, coalesce(sum(size), 0) AS bytes, max(pruned_at) AS last
    FROM blobs WHERE pruned_at IS NOT NULL`;
  const leftovers = yield* Effect.result(blobs.leftovers);
  const result: PrunePlan = {
    now: new Date(nowMillis).toISOString(),
    cutoff,
    due: { ...tally(due), oldestCapturedAt: due?.oldest ?? null },
    byClass: byClass.map((row) => ({ retention: "raw-capture", ...row })),
    byAge,
    ...(Result.isSuccess(leftovers)
      ? { leftoverFiles: leftovers.success.length }
      : {
          leftoverFiles: null,
          leftoverError: describeScanFailure(leftovers.failure),
        }),
    retained: tally(retained),
    durable: tally(durable),
    tombstones: {
      ...tally(tombstones),
      lastPrunedAt: tombstones?.last ?? null,
    },
  };
  return result;
});

export interface PruneReport {
  readonly prunedAt: string;
  readonly cutoff: string;
  readonly pruned: Tally & { readonly inline: number; readonly files: number };
  /**
   * Files beside tombstones from an interrupted prune, removed after the tombstones commit.
   * Best effort: `null` when the scan or a removal failed (`leftoverError` says why), which never
   * stops tombstoning; the next prune tries again.
   */
  readonly leftoverFilesRemoved: number | null;
  readonly leftoverError?: string;
  /**
   * Database pages given back to the file system. Stores created since this build use incremental
   * auto-vacuum; older ones keep freed pages for reuse until a full `VACUUM`.
   */
  readonly vacuum:
    | { readonly mode: "incremental"; readonly freedBytes: number }
    | { readonly mode: "none"; readonly freeBytes: number };
}

const freePages = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const [row] = yield* sql<{
    autoVacuum: number;
    freelistCount: number;
    pageSize: number;
  }>`SELECT (SELECT auto_vacuum FROM pragma_auto_vacuum) AS auto_vacuum,
    (SELECT freelist_count FROM pragma_freelist_count) AS freelist_count,
    (SELECT page_size FROM pragma_page_size) AS page_size`;
  return {
    incremental: row?.autoVacuum === 2,
    freeBytes: (row?.freelistCount ?? 0) * (row?.pageSize ?? 0),
  };
});

/** A migration copy expires as soon as any raw capture it holds expires. */
const expiredBackups = (cutoff: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const fs = yield* FileSystem;
    const [main] = yield* sql<{
      file: string;
    }>`SELECT file FROM pragma_database_list WHERE name = 'main'`;
    if (!main?.file) return [];
    const directory = backupDirectory(main.file);
    if (!(yield* fs.exists(directory))) return [];
    const prefix = `${basename(main.file, ".sqlite")}-`;
    const paths: string[] = [];
    for (const name of yield* fs.readDirectory(directory)) {
      if (!name.startsWith(prefix) || !name.endsWith(".sqlite")) continue;
      const path = join(directory, name);
      const expired = yield* Effect.try(() => {
        // VACUUM INTO writes these in rollback mode, so no WAL is involved.
        const database = openStoreReader(path);
        try {
          if (
            !database
              .query(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='blobs'",
              )
              .get()
          )
            return false;
          return (
            database
              .query(
                "SELECT 1 FROM blobs WHERE retention='raw-capture' AND pruned_at IS NULL AND content IS NOT NULL AND captured_at < ? LIMIT 1",
              )
              .get(cutoff) !== null
          );
        } finally {
          database.close();
        }
      }).pipe(
        Effect.catch(() =>
          Effect.as(
            Effect.logWarning(
              "retention.prune: unreadable migration backup skipped",
            ),
            false,
          ),
        ),
      );
      if (expired) paths.push(path);
    }
    return paths;
  });

/**
 * Prunes every raw capture past retention: due captures page by page, oldest first, each page in its
 * own transactions (see `BlobStore.prune`); then, best effort, the files an interrupted prune left
 * beside their tombstones. A capture of the same bytes after pruning is a new capture with its own clock
 * (8.10); a page never touches it, because the tombstone update re-checks every row's state.
 */
export const prune = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const blobs = yield* BlobStore;
  const nowMillis = yield* Clock.currentTimeMillis;
  const cutoff = cutoffAt(nowMillis);
  for (const path of yield* expiredBackups(cutoff))
    yield* (yield* FileSystem).remove(path);
  const pruned: Array<PrunedBlob> = [];
  for (;;) {
    const page = yield* blobs.prune({ cutoff, limit: PAGE });
    pruned.push(...page);
    if (page.length < PAGE) break;
  }
  const leftovers = yield* Effect.result(
    Effect.flatMap(blobs.leftovers, blobs.removeLeftovers),
  );
  if (Result.isFailure(leftovers))
    yield* Effect.logWarning(
      `retention.prune: files beside tombstones were not removed: ${describeScanFailure(leftovers.failure)}`,
    );
  const before = yield* freePages;
  let vacuum: PruneReport["vacuum"];
  if (before.incremental) {
    yield* sql.withTransaction(sql`PRAGMA incremental_vacuum`);
    const after = yield* freePages;
    vacuum = {
      mode: "incremental",
      freedBytes: Math.max(0, before.freeBytes - after.freeBytes),
    };
  } else vacuum = { mode: "none", freeBytes: before.freeBytes };
  const report: PruneReport = {
    prunedAt: new Date(nowMillis).toISOString(),
    cutoff,
    pruned: {
      blobs: pruned.length,
      bytes: pruned.reduce((sum, blob) => sum + blob.size, 0),
      inline: pruned.filter((blob) => blob.placement === "inline").length,
      files: pruned.filter((blob) => blob.placement === "file").length,
    },
    ...(Result.isSuccess(leftovers)
      ? { leftoverFilesRemoved: leftovers.success }
      : {
          leftoverFilesRemoved: null,
          leftoverError: describeScanFailure(leftovers.failure),
        }),
    vacuum,
  };
  return report;
});

/** One line for logs and the CLI. */
export const describePrune = (report: PruneReport) =>
  `pruned ${report.pruned.blobs} raw capture(s) captured before ${report.cutoff} (${report.pruned.bytes} bytes; ${report.pruned.inline} inline, ${report.pruned.files} files); ${report.leftoverFilesRemoved === null ? `leftover files not removed (${report.leftoverError})` : `${report.leftoverFilesRemoved} leftover file(s) removed`}; ${
    report.vacuum.mode === "incremental"
      ? `incremental vacuum returned ${report.vacuum.freedBytes} bytes`
      : `${report.vacuum.freeBytes} bytes of free pages kept for reuse (this store predates incremental auto-vacuum)`
  }`;

/**
 * The dedupe key of the prune for the UTC day of `nowMillis` (proposal §7): at most one prune job a
 * day, so the jobs table grows by at most one row a day. A capture becomes due 30 days after it was
 * made and is pruned by that day's job, or by the next day's when it falls due after the day's job
 * ran: retention is 30 days plus at most one day. No timer runs it: the worker checks when it starts
 * and once a day while it runs, and the launchd sweep starts a worker when a prune is wanted.
 */
const pruneKey = (nowMillis: number) =>
  `retention.prune:${new Date(nowMillis).toISOString().slice(0, 10)}`;

/** The prune job the store needs now, if any: raw captures are due and today has no prune job. */
export const wantedPrune = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const nowMillis = yield* Clock.currentTimeMillis;
  const cutoff = cutoffAt(nowMillis);
  const unprotected = (yield* unprotectedRawBlob(cutoff)) ?? sql`1`;
  const [due] = yield* sql<{
    hash: string;
  }>`SELECT hash FROM blobs
    WHERE retention = 'raw-capture' AND pruned_at IS NULL AND captured_at < ${cutoff} AND ${unprotected}
    LIMIT 1`;
  if (
    due === undefined &&
    (yield* expiredBackups(cutoffAt(nowMillis))).length === 0
  )
    return Option.none<string>();
  const dedupeKey = pruneKey(nowMillis);
  const [held] = yield* sql<{
    jobSeq: number;
  }>`SELECT job_seq FROM jobs WHERE dedupe_key = ${dedupeKey}`;
  return held === undefined ? Option.some(dedupeKey) : Option.none<string>();
});

/**
 * Local state beside the store that the daily prune also clears under 8.10's bound, owned by a
 * package Records cannot depend on: the harness's run folders (proposal §1). The worker's process
 * provides them through `RetentionSweeps`; a worker without any prunes raw captures only.
 */
export interface RetentionSweep {
  /** What the sweep clears, as the prune's log names it, for example `run folders`. */
  readonly name: string;
  /** Whether a sweep now would clear anything, so a prune is wanted with no raw capture due. */
  readonly wanted: Effect.Effect<boolean, unknown, RetentionServices>;
  /** Clears what is due; one line per item removed, for the prune's log. */
  readonly sweep: Effect.Effect<
    ReadonlyArray<string>,
    unknown,
    RetentionServices
  >;
}

/** What a sweep may use: the services every job handler has (see `Worker.JobServices`). */
export type RetentionServices = SqlClient | FileSystem | BlobStore;

export const RetentionSweeps = Context.Reference<ReadonlyArray<RetentionSweep>>(
  "@neuve/records-core/RetentionSweeps",
  { defaultValue: () => [] },
);

/**
 * Whether a sweep has something to clear. A sweep that cannot tell is logged and counted as not
 * wanted, so it never stops the worker; the next day's check asks again.
 */
const sweepWanted = (sweep: RetentionSweep) =>
  sweep.wanted.pipe(
    Effect.catchCause((cause) =>
      Effect.as(
        Effect.logWarning(
          `retention: could not tell whether ${sweep.name} need sweeping: ${Cause.pretty(cause).split("\n")[0]}`,
        ),
        false,
      ),
    ),
  );

/** A prune job just enqueued, and why it was wanted. */
export interface ScheduledPrune {
  readonly seq: number;
  readonly reason: string;
}

/**
 * Enqueues the prune the store needs, if any: raw captures are due, or a retention sweep has
 * something to clear, and today has no prune job. The worker calls this when it starts and once a
 * day while it runs.
 */
export const schedulePrune = (queue: JobQueue["Service"]) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const sweeps = yield* RetentionSweeps;
    let wanted = Option.map(yield* wantedPrune, (dedupeKey) => ({
      dedupeKey,
      reason: "raw captures are past retention",
    }));
    if (Option.isNone(wanted) && sweeps.length > 0) {
      const dedupeKey = pruneKey(yield* Clock.currentTimeMillis);
      const [held] = yield* sql<{
        jobSeq: number;
      }>`SELECT job_seq FROM jobs WHERE dedupe_key = ${dedupeKey}`;
      if (held === undefined)
        for (const sweep of sweeps)
          if (yield* sweepWanted(sweep)) {
            wanted = Option.some({
              dedupeKey,
              reason: `${sweep.name} are due for sweeping`,
            });
            break;
          }
    }
    if (Option.isNone(wanted)) return Option.none<ScheduledPrune>();
    const { status, job } = yield* queue.enqueue({
      kind: "retention.prune",
      dedupeKey: wanted.value.dedupeKey,
      payload: {},
    });
    return status === "enqueued"
      ? Option.some<ScheduledPrune>({
          seq: job.seq,
          reason: wanted.value.reason,
        })
      : Option.none<ScheduledPrune>();
  });

/**
 * The `retention.prune` job handler: the job carries no input; the cutoff is taken now. The sweeps
 * run first, so local state holding unmasked content goes before the raw-capture pages; the
 * captures a sweep masks are new captures with their own 30 days (8.10). Every kind declared
 * recomputable is then brought under its cap (`evictable.ts`), before the prune's vacuum. Eviction
 * is best effort here: a failure is logged and never stops the raw-capture prune.
 */
export const pruneJob = (_job: unknown) =>
  Effect.gen(function* () {
    for (const sweep of yield* RetentionSweeps) {
      const removed = yield* sweep.sweep;
      for (const line of removed)
        yield* Effect.logInfo(`retention.prune: ${sweep.name}: ${line}`);
      yield* Effect.logInfo(
        `retention.prune: ${sweep.name}: ${removed.length} removed`,
      );
    }
    const evicted = yield* Effect.result(evictDeclared);
    if (Result.isFailure(evicted))
      yield* Effect.logWarning(
        `retention.prune: eviction of recomputable outputs did not finish: ${describeScanFailure(evicted.failure)}`,
      );
    else
      for (const report of evicted.success)
        yield* Effect.logInfo(`retention.prune: ${describeEvict(report)}`);
    const report = yield* prune;
    yield* Effect.logInfo(`retention.prune: ${describePrune(report)}`);
    return report;
  });
