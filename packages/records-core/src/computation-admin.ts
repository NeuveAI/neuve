import { safeRead } from "@neuve/records-schema";
import { Clock, Duration, Effect, Result } from "effect";
import { EVICT_AFTER } from "./evictable.ts";
import { FileSystem } from "effect/FileSystem";
import { SqlClient } from "effect/sql/SqlClient";
import {
  AttemptOutcome,
  BlobRow,
  ComputationRow,
  type Reference,
  type TokenUsage,
} from "@neuve/records-schema";
import { blobFolderEntries, blobPath } from "./blobs.ts";
import { sha256Bytes, sha256Hex } from "./canonical.ts";
import type { StoreLocation } from "./location.ts";
import { cutoffAt } from "./retention.ts";

export interface StoreCheck {
  readonly name: string;
  readonly status: "ok" | "fail" | "skipped";
  readonly detail: string;
}

const summarize = (problems: ReadonlyArray<string>, ok: string) =>
  problems.length === 0
    ? ok
    : `${problems.length} problem(s): ${problems.slice(0, 5).join("; ")}`;

const check = (
  name: string,
  problems: ReadonlyArray<string>,
  ok: string,
): StoreCheck => ({
  name,
  status: problems.length === 0 ? "ok" : "fail",
  detail: summarize(problems, ok),
});

const PAGE = 256;

/**
 * The computation store checked against itself and the log, inside fsck's transaction (proposal §3,
 * Integrity): every event reference resolves to a blob (present or pruned) or a finished computation;
 * every computation's key hashes its material and binds a durable, unpruned output through a
 * succeeded attempt; and every inline blob's bytes hash to its name. File blobs are checked after the
 * transaction by `blobFileCheck`, so file reads never hold the write lock; the rows it needs are
 * returned here, with the removals an eviction recorded (`blob_removals`). An evicted output leaves
 * nothing else behind for these checks to find.
 */
export const computationChecks = (
  references: ReadonlyArray<{ readonly seq: number; readonly ref: Reference }>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const checks: Array<StoreCheck> = [];

    const blobRows = yield* sql<
      Record<string, unknown>
    >`SELECT hash, size, media_type, retention, placement, captured_at, pruned_at FROM blobs`;
    const blobs = new Map<string, BlobRow>();
    const blobProblems: Array<string> = [];
    for (const row of blobRows) {
      const parsed = safeRead(BlobRow, row);
      if (parsed.success) blobs.set(parsed.data.hash, parsed.data);
      else
        blobProblems.push(
          `blob ${String(row["hash"])}: ${parsed.error.message}`,
        );
    }
    const computationRows = yield* sql<
      Record<string, unknown>
    >`SELECT key, op, op_version, material, output_hash, attempt_id, completed_at FROM computations`;
    const computations = new Map<string, ComputationRow>();
    const computationProblems: Array<string> = [];
    for (const row of computationRows) {
      const parsed = safeRead(ComputationRow, row);
      if (parsed.success) computations.set(parsed.data.key, parsed.data);
      else
        computationProblems.push(
          `computation ${String(row["key"])}: ${parsed.error.message}`,
        );
    }

    const referenceProblems: Array<string> = [];
    let pruned = 0;
    for (const { seq, ref } of references) {
      const [kind, hash = ""] = ref.ref.split(":");
      if (kind === "blob") {
        const blob = blobs.get(hash);
        if (blob === undefined)
          referenceProblems.push(`seq ${seq}: ${ref.role} ${ref.ref} missing`);
        else if (blob.prunedAt !== null) pruned += 1;
      } else if (!computations.has(hash))
        referenceProblems.push(
          `seq ${seq}: ${ref.role} ${ref.ref} has no finished computation`,
        );
    }
    checks.push(
      check(
        "computation and blob references resolve",
        referenceProblems,
        `${references.length} references; ${pruned} to pruned raw captures (tombstones)`,
      ),
    );

    const attempts = new Map(
      (yield* sql<{
        attemptId: string;
        key: string;
        outcome: string;
        outputHash: string | null;
      }>`SELECT attempt_id, key, outcome, output_hash FROM computation_attempts`).map(
        (row) => [row.attemptId, row],
      ),
    );
    for (const computation of computations.values()) {
      const label = `computation ${computation.key.slice(0, 12)}`;
      if (sha256Hex(computation.material) !== computation.key)
        computationProblems.push(`${label}: key does not hash its material`);
      const output = blobs.get(computation.outputHash);
      if (output === undefined)
        computationProblems.push(`${label}: output blob missing`);
      else if (output.retention !== "durable" || output.prunedAt !== null)
        computationProblems.push(
          `${label}: output is ${output.prunedAt === null ? output.retention : "pruned"}, not durable`,
        );
      const attempt = attempts.get(computation.attemptId);
      if (
        attempt === undefined ||
        attempt.key !== computation.key ||
        attempt.outcome !== "succeeded" ||
        attempt.outputHash !== computation.outputHash
      )
        computationProblems.push(
          `${label}: not bound by a succeeded attempt of its own key`,
        );
    }
    const [declared] = yield* sql<{
      n: number;
    }>`SELECT count(*) AS n FROM computation_kinds WHERE recomputable = 1`;
    checks.push(
      check(
        "computations bind durable outputs through a succeeded attempt",
        computationProblems,
        `${computations.size} computations, ${attempts.size} attempts${(declared?.n ?? 0) > 0 ? `; ${declared?.n} kind(s) declared recomputable` : ""}`,
      ),
    );

    let after = "";
    let inline = 0;
    for (;;) {
      const page = yield* sql<{
        hash: string;
        size: number;
        content: Uint8Array | null;
      }>`SELECT hash, size, content FROM blobs
        WHERE placement = 'inline' AND pruned_at IS NULL AND hash > ${after} ORDER BY hash LIMIT ${PAGE}`;
      for (const row of page) {
        inline += 1;
        if (
          row.content === null ||
          row.content.byteLength !== row.size ||
          sha256Bytes(row.content) !== row.hash
        )
          blobProblems.push(
            `blob ${row.hash.slice(0, 12)}: inline bytes do not hash to its name`,
          );
        after = row.hash;
      }
      if (page.length < PAGE) break;
    }
    checks.push(
      check(
        "inline blobs hash to their names",
        blobProblems,
        `${inline} inline blobs`,
      ),
    );
    const removals = (yield* sql<{
      hash: string;
    }>`SELECT hash FROM blob_removals ORDER BY hash`).map((row) => row.hash);
    return { checks, blobs: [...blobs.values()], removals };
  });

/**
 * Every unpruned file blob exists and hashes to its name. Files no row names are left by a write
 * interrupted before its row committed: harmless, and counted. A file beside a tombstone is the
 * remainder of a prune interrupted between its two transactions (or one in progress); the next
 * prune removes it, so it is counted, not failed. A file whose blob an eviction deleted
 * (`removals`, from `blob_removals`) is an interrupted removal: the next eviction removes it, so it
 * is counted, not failed. A blob pruned after fsck read its row is re-read before a missing file
 * counts as a problem.
 */
export const blobFileCheck = (
  location: StoreLocation,
  blobs: ReadonlyArray<BlobRow>,
  removals: ReadonlyArray<string> = [],
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const sql = yield* SqlClient;
    const problems: Array<string> = [];
    const named = new Set<string>();
    let files = 0;
    let besideTombstones = 0;
    let prunedSince = 0;
    for (const blob of blobs) {
      if (blob.placement !== "file") continue;
      const path = blobPath(location, blob.hash);
      named.add(path);
      // A file or folder that cannot be read fails the check with its reason; fsck goes on.
      const probed = yield* Effect.result(fs.exists(path));
      if (Result.isFailure(probed)) {
        problems.push(
          `blob ${blob.hash.slice(0, 12)}: file unreadable: ${probed.failure.message}`,
        );
        continue;
      }
      const exists = probed.success;
      if (blob.prunedAt !== null) {
        if (exists) besideTombstones += 1;
        continue;
      }
      if (!exists) {
        const [now] = yield* sql<{
          prunedAt: string | null;
        }>`SELECT pruned_at FROM blobs WHERE hash = ${blob.hash}`;
        if (now?.prunedAt !== null && now?.prunedAt !== undefined)
          prunedSince += 1;
        else problems.push(`blob ${blob.hash.slice(0, 12)}: file missing`);
        continue;
      }
      files += 1;
      const read = yield* Effect.result(fs.readFile(path));
      if (Result.isFailure(read)) {
        problems.push(
          `blob ${blob.hash.slice(0, 12)}: file unreadable: ${read.failure.message}`,
        );
        continue;
      }
      const bytes = read.success;
      if (bytes.byteLength !== blob.size || sha256Bytes(bytes) !== blob.hash)
        problems.push(
          `blob ${blob.hash.slice(0, 12)}: file bytes do not hash to its name`,
        );
    }
    const withRow = new Set(blobs.map((blob) => blob.hash));
    const removing = new Set(
      removals
        .filter((hash) => !withRow.has(hash))
        .map((hash) => blobPath(location, hash)),
    );
    let interrupted = 0;
    // An unreadable blob folder is a failed check with its reason, never an aborted fsck.
    let stray = 0;
    const entries = yield* Effect.result(blobFolderEntries(location));
    if (Result.isFailure(entries))
      problems.push(
        `blob folders could not be listed: ${entries.failure.message}`,
      );
    else
      for (const entry of entries.success)
        if (removing.has(entry.path)) interrupted += 1;
        else if (!named.has(entry.path)) stray += 1;
    return check(
      "blob files exist and hash to their names",
      problems,
      `${files} file blobs; ${stray} unreferenced file(s) from interrupted writes; ${besideTombstones} file(s) beside tombstones, which the next prune removes${interrupted > 0 ? `; ${interrupted} file(s) of evicted outputs whose removal was interrupted, which the next eviction removes` : ""}${prunedSince > 0 ? `; ${prunedSince} pruned during this check` : ""}`,
    );
  });

export interface BlobClassStats {
  readonly retention: string;
  readonly placement: string;
  readonly blobs: number;
  readonly bytes: number;
  readonly pruned: number;
}

export interface AgentTokens {
  readonly actorId: string;
  readonly alias: string;
  readonly harness: string;
  readonly subagent: boolean;
  readonly model: string | null;
  readonly turns: number;
  readonly summaries: number;
  readonly tokens: TokenUsage;
  readonly apiCalls: number;
  readonly toolCalls: number;
}

/** One kind's stored outputs (`op`), for `neuve records stats`. */
export interface ComputationKindStats {
  readonly op: string;
  readonly outputs: number;
  /** Their output bytes, each blob once. */
  readonly bytes: number;
  /**
   * At most what an eviction may take now: outputs of a kind declared recomputable, stored over
   * 15 minutes ago, that no model produced and no event's `refs` name. An upper bound: the store
   * also keeps an output an event names outside `refs`, and the bytes count a blob another kind
   * shares. Zero for any other kind.
   */
  readonly evictable: { readonly outputs: number; readonly bytes: number };
  /** The declared byte cap; null when the kind is not declared recomputable. */
  readonly capBytes: number | null;
  readonly oldestStoredAt: string | null;
  readonly newestStoredAt: string | null;
}

export interface ComputationStats {
  readonly database: {
    /** `page_count × page_size`: the main database file's logical size. */
    readonly pageBytes: number;
    readonly freeBytes: number;
    readonly fileBytes: number;
    readonly walBytes: number;
    /** Bytes of unpruned file blobs under `blobs/`. */
    readonly blobFileBytes: number;
    /** Database file, write-ahead log and blob files together. */
    readonly totalBytes: number;
  };
  readonly blobs: ReadonlyArray<BlobClassStats>;
  readonly computations: {
    readonly finished: number;
    readonly attempts: Readonly<Record<AttemptOutcome, number>>;
    /** Finished computations by kind, largest first. */
    readonly kinds: ReadonlyArray<ComputationKindStats>;
    /** Evicted outputs' files whose removal has not finished (`blob_removals`). */
    readonly pendingRemovals: number;
  };
  readonly transcripts: {
    /** `turn.summarized` events by segment. */
    readonly summaries: { readonly turn: number; readonly sessionTail: number };
    /** Distinct transcript blobs those events reference, and what became of them. */
    readonly blobs: number;
    readonly bytes: number;
    readonly inline: number;
    readonly files: number;
    readonly pruned: number;
    readonly missing: number;
  };
  /** Token totals per agent actor, from `turn.summarized`, largest first. */
  readonly agents: ReadonlyArray<AgentTokens>;
  /** Raw-capture retention (D26): what is past the 30-day cutoff now, and the tombstones so far. */
  readonly retention: {
    readonly cutoff: string;
    readonly due: { readonly blobs: number; readonly bytes: number };
    readonly tombstones: {
      readonly blobs: number;
      readonly bytes: number;
      readonly lastPrunedAt: string | null;
    };
  };
}

const fileSize = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    if (!(yield* fs.exists(path))) return 0;
    return Number((yield* fs.stat(path)).size);
  });

/**
 * Stored outputs by kind. Bytes count each blob once per kind. The evictable share is an upper
 * bound (see `ComputationKindStats.evictable`): it reads the log's `refs` once for the keys events
 * name, and never scans it per output as the store's own check does.
 */
const kindStats = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const freshFrom = new Date(
    (yield* Clock.currentTimeMillis) - Duration.toMillis(EVICT_AFTER),
  ).toISOString();
  const rows = yield* sql<{
    op: string;
    outputs: number;
    oldest: string | null;
    newest: string | null;
    capBytes: number | null;
  }>`SELECT c.op, count(*) AS outputs, min(c.completed_at) AS oldest, max(c.completed_at) AS newest,
      k.cap_bytes AS cap_bytes
    FROM computations c LEFT JOIN computation_kinds k ON k.op = c.op AND k.recomputable = 1
    GROUP BY c.op`;
  const bytes = new Map(
    (yield* sql<{
      op: string;
      bytes: number;
    }>`SELECT op, coalesce(sum(size), 0) AS bytes FROM (
        SELECT DISTINCT c.op, b.hash, b.size FROM computations c JOIN blobs b ON b.hash = c.output_hash)
      GROUP BY op`).map((row) => [row.op, row.bytes]),
  );
  const evictable = rows.some((row) => row.capBytes !== null)
    ? new Map(
        (yield* sql<{
          op: string;
          outputs: number;
          bytes: number;
        }>`WITH named AS (
            SELECT DISTINCT substr(json_extract(r.value, '$.ref'), 13) AS key
            FROM events e JOIN json_each(e.envelope, '$.refs') r
            WHERE instr(e.envelope, '"computation:') > 0 AND json_extract(r.value, '$.ref') LIKE 'computation:%'),
          candidates AS (
            SELECT c.op, c.key, c.output_hash FROM computations c
              JOIN computation_kinds k ON k.op = c.op AND k.recomputable = 1
            WHERE c.completed_at < ${freshFrom} AND c.key NOT IN (SELECT key FROM named)
              AND NOT EXISTS (SELECT 1 FROM computation_attempts a
                WHERE a.key = c.key AND (a.model IS NOT NULL OR a.usage IS NOT NULL)))
          SELECT op, count(*) AS outputs,
            (SELECT coalesce(sum(size), 0) FROM blobs
              WHERE hash IN (SELECT output_hash FROM candidates c2 WHERE c2.op = candidates.op)) AS bytes
          FROM candidates GROUP BY op`).map((row) => [row.op, row]),
      )
    : new Map<string, { outputs: number; bytes: number }>();
  return rows
    .map((row): ComputationKindStats => ({
      op: row.op,
      outputs: row.outputs,
      bytes: bytes.get(row.op) ?? 0,
      evictable: {
        outputs: evictable.get(row.op)?.outputs ?? 0,
        bytes: evictable.get(row.op)?.bytes ?? 0,
      },
      capBytes: row.capBytes,
      oldestStoredAt: row.oldest,
      newestStoredAt: row.newest,
    }))
    .sort((a, b) => b.bytes - a.bytes || a.op.localeCompare(b.op));
});

/** Sizes and counts of the computation store, transcripts and token totals for `neuve records stats`. */
export const computationStats = (location: StoreLocation) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const [pages] = yield* sql<{
      pageCount: number;
      pageSize: number;
      freelistCount: number;
    }>`SELECT (SELECT page_count FROM pragma_page_count) AS page_count,
      (SELECT page_size FROM pragma_page_size) AS page_size,
      (SELECT freelist_count FROM pragma_freelist_count) AS freelist_count`;
    const blobs =
      yield* sql<BlobClassStats>`SELECT retention, placement, count(*) AS blobs,
      coalesce(sum(CASE WHEN pruned_at IS NULL THEN size ELSE 0 END), 0) AS bytes,
      coalesce(sum(pruned_at IS NOT NULL), 0) AS pruned
      FROM blobs GROUP BY retention, placement ORDER BY retention, placement`;
    const blobFileBytes = blobs
      .filter((row) => row.placement === "file")
      .reduce((sum, row) => sum + row.bytes, 0);
    const [finished] = yield* sql<{
      n: number;
    }>`SELECT count(*) AS n FROM computations`;
    const outcomes = yield* sql<{
      outcome: AttemptOutcome;
      n: number;
    }>`SELECT outcome, count(*) AS n FROM computation_attempts GROUP BY outcome`;
    const attempts = Object.fromEntries(
      AttemptOutcome.options.map((outcome) => [
        outcome,
        outcomes.find((row) => row.outcome === outcome)?.n ?? 0,
      ]),
    ) as Record<AttemptOutcome, number>;
    const kinds = yield* kindStats;
    const [removals] = yield* sql<{
      n: number;
    }>`SELECT count(*) AS n FROM blob_removals`;
    const segments = yield* sql<{
      segment: string;
      n: number;
    }>`SELECT json_extract(envelope, '$.payload.segment') AS segment, count(*) AS n
      FROM events WHERE kind = 'turn.summarized@1' GROUP BY segment`;
    const [transcripts] = yield* sql<{
      blobs: number;
      bytes: number;
      inline: number;
      files: number;
      pruned: number;
      missing: number;
    }>`WITH refs AS (
        SELECT DISTINCT substr(json_extract(r.value, '$.ref'), 6) AS hash
        FROM events e, json_each(e.envelope, '$.refs') r
        WHERE e.kind = 'turn.summarized@1' AND json_extract(r.value, '$.role') = 'transcript')
      SELECT count(*) AS blobs, coalesce(sum(b.size), 0) AS bytes,
        coalesce(sum(b.placement = 'inline'), 0) AS inline, coalesce(sum(b.placement = 'file'), 0) AS files,
        coalesce(sum(b.pruned_at IS NOT NULL), 0) AS pruned, coalesce(sum(b.hash IS NULL), 0) AS missing
      FROM refs LEFT JOIN blobs b ON b.hash = refs.hash`;
    const agents = yield* sql<{
      actorId: string;
      alias: string;
      harness: string;
      subagentId: string | null;
      model: string | null;
      turns: number;
      summaries: number;
      tokensInput: number;
      tokensCacheCreation: number;
      tokensCacheRead: number;
      tokensOutput: number;
      apiCalls: number;
      toolCalls: number;
    }>`SELECT a.actor_id, a.alias, a.harness, a.subagent_id, t.model, t.turns, t.summaries,
        t.tokens_input, t.tokens_cache_creation, t.tokens_cache_read, t.tokens_output, t.api_calls, t.tool_calls
      FROM projection_actor_activity t JOIN projection_actors a ON a.actor_id = t.actor_id
      WHERE a.actor_kind = 'agent' AND (t.turns > 0 OR t.summaries > 0)
      ORDER BY t.tokens_input + t.tokens_cache_creation + t.tokens_cache_read + t.tokens_output DESC, a.alias`;
    const cutoff = cutoffAt(yield* Clock.currentTimeMillis);
    const [due] = yield* sql<{
      blobs: number;
      bytes: number;
    }>`SELECT count(*) AS blobs, coalesce(sum(size), 0) AS bytes FROM blobs
      WHERE retention = 'raw-capture' AND pruned_at IS NULL AND captured_at < ${cutoff}`;
    const [tombstones] = yield* sql<{
      blobs: number;
      bytes: number;
      lastPrunedAt: string | null;
    }>`SELECT count(*) AS blobs, coalesce(sum(size), 0) AS bytes, max(pruned_at) AS last_pruned_at
      FROM blobs WHERE pruned_at IS NOT NULL`;
    const fileBytes = yield* fileSize(location.database);
    const walBytes = yield* fileSize(`${location.database}-wal`);
    const stats: ComputationStats = {
      database: {
        pageBytes: (pages?.pageCount ?? 0) * (pages?.pageSize ?? 0),
        freeBytes: (pages?.freelistCount ?? 0) * (pages?.pageSize ?? 0),
        fileBytes,
        walBytes,
        blobFileBytes,
        totalBytes: fileBytes + walBytes + blobFileBytes,
      },
      blobs,
      computations: {
        finished: finished?.n ?? 0,
        attempts,
        kinds,
        pendingRemovals: removals?.n ?? 0,
      },
      transcripts: {
        summaries: {
          turn: segments.find((row) => row.segment === "turn")?.n ?? 0,
          sessionTail:
            segments.find((row) => row.segment === "session-tail")?.n ?? 0,
        },
        blobs: transcripts?.blobs ?? 0,
        bytes: transcripts?.bytes ?? 0,
        inline: transcripts?.inline ?? 0,
        files: transcripts?.files ?? 0,
        pruned: transcripts?.pruned ?? 0,
        missing: transcripts?.missing ?? 0,
      },
      agents: agents.map((row) => ({
        actorId: row.actorId,
        alias: row.alias,
        harness: row.harness,
        subagent: row.subagentId !== null,
        model: row.model,
        turns: row.turns,
        summaries: row.summaries,
        tokens: {
          input: row.tokensInput,
          cacheCreation: row.tokensCacheCreation,
          cacheRead: row.tokensCacheRead,
          output: row.tokensOutput,
        },
        apiCalls: row.apiCalls,
        toolCalls: row.toolCalls,
      })),
      retention: {
        cutoff,
        due: { blobs: due?.blobs ?? 0, bytes: due?.bytes ?? 0 },
        tombstones: {
          blobs: tombstones?.blobs ?? 0,
          bytes: tombstones?.bytes ?? 0,
          lastPrunedAt: tombstones?.lastPrunedAt ?? null,
        },
      },
    };
    return stats;
  });
