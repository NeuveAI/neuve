import { Effect } from "effect";
import {
  SYMBOL_TOKENS_BATCH_BYTES,
  graphRefusesSourcePath,
  type GraphFileTokens,
} from "@neuve/graph-client";
import { SharedWorkError } from "@neuve/records-core/shared-work-effect";
import { structureKeyOf } from "./blob-structure.ts";
import { cpuWork } from "./budget/cpu.ts";
import { codeCheckpoint } from "./code-work.ts";
import { groupsBySize, readBlobs, type TreeEntry } from "./git-objects.ts";
import {
  OutlineSourceChanged,
  assertOutlineSource,
  readOutlinesWithBudget,
  type OutlineBatch,
  type OutlineSource,
} from "./graph-outline.ts";
import { blobSizes } from "./hunks.ts";
import {
  INDEX_BOUNDS,
  blobText,
  entryExclusion,
  overSize,
  uniquePathBatches,
} from "./search-index.ts";
import { repositoryOwner } from "./budget/owner.ts";

/**
 * Graph's syntax leaves and import bindings of blobs (`readGraphSymbols({ tokens: true })`), read
 * through the shared outline read with the option on, batched as the structure read batches: no
 * path twice and no file with a path under it in one read (`uniquePathBatches`), at most
 * `SYMBOL_TOKENS_BATCH_BYTES` of source per read (the reader's own bound with tokens on), within the
 * CPU and Graph budget helpers. Nothing is stored here: a tokens record is about seven bytes per
 * source byte, and the rules read it only when their own stored computation misses.
 *
 * A blob Graph is never sent gets a stable answer of its own: a path Graph refuses
 * (`graphRefusesSourcePath`), a blob over the index's size bound, a binary blob, a submodule, a
 * symlink or a tree. An engine that does not declare tokens is stable too (`engine-unsupported`).
 * Graph unavailable, and a blob the reader did not return, are retryable.
 */

/** Why a blob has no tokens record: never sent to Graph, or no answer from it. */
export type BlobTokensGap =
  | "path-refused"
  | "over-size"
  | "binary"
  | "submodule"
  | "symlink"
  | "not-a-blob"
  | "unreadable"
  | "engine-unsupported"
  | "graph-unavailable";

/** Gaps a later read may close; every other gap is what the same inputs give again. */
const RETRYABLE_GAPS: ReadonlySet<BlobTokensGap> = new Set([
  "unreadable",
  "graph-unavailable",
]);

/** One blob's answer: Graph's record (available or not, as the client gives it), or a gap. */
export type BlobTokensAnswer =
  | Readonly<{ status: "read"; tokens: GraphFileTokens }>
  | Readonly<{ status: "not-read"; reason: BlobTokensGap; retryable: boolean }>;

/** Whether a later read may give another answer. */
export const answerRetryable = (answer: BlobTokensAnswer) =>
  answer.status === "read"
    ? answer.tokens.status === "unavailable" && answer.tokens.retryable
    : answer.retryable;

const gap = (reason: BlobTokensGap): BlobTokensAnswer => ({
  status: "not-read",
  reason,
  retryable: RETRYABLE_GAPS.has(reason),
});

export interface BlobTokensCounts {
  /** Distinct blobs (by path and object id) asked for. */
  readonly asked: number;
  /** Blobs sent to Graph. */
  readonly sent: number;
  /** Records available, and unavailable by Graph's reason. */
  readonly available: number;
  readonly unavailable: Readonly<Record<string, number>>;
  /** Blobs with no record, by gap. */
  readonly notRead: Readonly<Partial<Record<BlobTokensGap, number>>>;
  /** Answers a later read may change (retryable records and retryable gaps). */
  readonly retryable: number;
  /** Outline reads with tokens made, and the source bytes they held. */
  readonly graphReads: number;
  readonly sourceBytes: number;
}

/** Splits a batch so no read holds more than `limit` source bytes (one file over it goes alone). */
const bySource = <T extends { readonly bytes: Uint8Array }>(
  files: ReadonlyArray<T>,
  limit: number,
): ReadonlyArray<ReadonlyArray<T>> => {
  const out: Array<Array<T>> = [];
  let current: Array<T> = [];
  let held = 0;
  for (const file of files) {
    if (current.length > 0 && held + file.bytes.byteLength > limit) {
      out.push(current);
      current = [];
      held = 0;
    }
    current.push(file);
    held += file.bytes.byteLength;
  }
  if (current.length > 0) out.push(current);
  return out;
};

/**
 * The tokens of each blob, by `structureKeyOf(path, oid)`, the bytes Graph was given by object id
 * (text blobs sent), and counts. Bytes already read can be passed in `contents` (by object id).
 * Never fails for Graph: a read that fails is a retryable `graph-unavailable` for its files. An
 * engine that changed during the read fails the call, as the structure read does.
 */
export const blobTokens = (
  repository: string,
  entries: ReadonlyArray<TreeEntry>,
  source: OutlineSource,
  contents: ReadonlyMap<string, Uint8Array> = new Map(),
) =>
  Effect.gen(function* () {
    yield* Effect.try(() => assertOutlineSource(source));
    const answers = new Map<string, BlobTokensAnswer>();
    const bytes = new Map<string, Uint8Array>();
    let graphReads = 0;
    let sourceBytes = 0;
    let sent = 0;
    const unique = new Map<string, TreeEntry>();
    for (const entry of entries) {
      const key = structureKeyOf(entry.path, entry.oid);
      // A symlink and a regular file can share a key: the regular file's answer is the one.
      const held = unique.get(key);
      if (held === undefined || entryExclusion(held) !== undefined)
        unique.set(key, entry);
    }
    const wanted: Array<{ key: string; entry: TreeEntry }> = [];
    for (const [key, entry] of unique) {
      const excluded = entryExclusion(entry);
      if (excluded !== undefined) answers.set(key, gap(excluded));
      else if (graphRefusesSourcePath(entry.path))
        answers.set(key, gap("path-refused"));
      else wanted.push({ key, entry });
    }
    // A size is git's byte length, so one over the bound is over-size without reading it.
    const sizes = yield* blobSizes(repository, [
      ...new Set(
        wanted.flatMap(({ entry }) =>
          entry.size === null && !contents.has(entry.oid) ? [entry.oid] : [],
        ),
      ),
    ]);
    const toRead = wanted.flatMap((item) => {
      const size =
        item.entry.size ??
        contents.get(item.entry.oid)?.byteLength ??
        sizes.get(item.entry.oid) ??
        null;
      if (size !== null && size > INDEX_BOUNDS.maxFileBytes) {
        answers.set(item.key, gap("over-size"));
        return [];
      }
      return [{ ...item, size }];
    });
    for (const group of groupsBySize(toRead)) {
      yield* codeCheckpoint;
      const read = yield* readBlobs(
        repository,
        group
          .filter(({ entry }) => !contents.has(entry.oid))
          .map(({ entry }) => entry.oid),
      );
      const decoded = yield* cpuWork(
        repositoryOwner(repository),
        Effect.sync(() =>
          group.map((item) => {
            const blob =
              contents.get(item.entry.oid) ?? read.get(item.entry.oid);
            // `read` tells the two shapes apart by value, so every compiler setting narrows them.
            if (blob === undefined)
              return {
                read: false as const,
                item,
                reason: "unreadable" as const,
              };
            if (overSize(blob))
              return {
                read: false as const,
                item,
                reason: "over-size" as const,
              };
            if (blobText(blob) === undefined)
              return { read: false as const, item, reason: "binary" as const };
            return { read: true as const, item, bytes: blob };
          }),
        ),
      );
      const readable = decoded.flatMap((file) =>
        file.read
          ? [{ item: file.item, path: file.item.entry.path, bytes: file.bytes }]
          : [],
      );
      for (const file of decoded)
        if (!file.read) answers.set(file.item.key, gap(file.reason));
      for (const batch of uniquePathBatches(readable, (file) => file.path))
        for (const files of bySource(batch, SYMBOL_TOKENS_BATCH_BYTES)) {
          yield* codeCheckpoint;
          const outlines: OutlineBatch | undefined =
            yield* readOutlinesWithBudget(
              files.map(({ path, bytes }) => ({ path, bytes })),
              "graph.outline.tokens",
              source,
              { tokens: true },
            ).pipe(
              // A shared read that failed is Graph unavailable for its files; an engine that changed
              // mid-read is not, and fails the call.
              Effect.catchIf(
                (error): error is SharedWorkError =>
                  error instanceof SharedWorkError &&
                  !(error.cause instanceof OutlineSourceChanged),
                () => Effect.succeed(undefined),
              ),
            );
          graphReads++;
          sent += files.length;
          for (const file of files) {
            sourceBytes += file.bytes.byteLength;
            bytes.set(file.item.entry.oid, file.bytes);
            if (outlines === undefined) {
              answers.set(file.item.key, gap("graph-unavailable"));
              continue;
            }
            if (outlines.tokensUnsupported) {
              answers.set(file.item.key, gap("engine-unsupported"));
              continue;
            }
            const context = outlines.context(file.path);
            const tokens =
              context.kind === "available"
                ? context.observation?.tokens
                : undefined;
            answers.set(
              file.item.key,
              tokens === undefined
                ? gap("graph-unavailable")
                : { status: "read", tokens },
            );
          }
        }
    }
    let available = 0;
    let retryable = 0;
    const unavailable: Record<string, number> = {};
    const notRead: Partial<Record<BlobTokensGap, number>> = {};
    for (const answer of answers.values()) {
      if (answerRetryable(answer)) retryable++;
      if (answer.status === "not-read")
        notRead[answer.reason] = (notRead[answer.reason] ?? 0) + 1;
      else if (answer.tokens.status === "available") available++;
      else
        unavailable[answer.tokens.reason] =
          (unavailable[answer.tokens.reason] ?? 0) + 1;
    }
    const counts: BlobTokensCounts = {
      asked: unique.size,
      sent,
      available,
      unavailable,
      notRead,
      retryable,
      graphReads,
      sourceBytes,
    };
    yield* Effect.annotateCurrentSpan({
      "harness.tokens.asked": counts.asked,
      "harness.tokens.sent": counts.sent,
      "harness.tokens.available": counts.available,
      "harness.tokens.retryable": counts.retryable,
      "harness.tokens.graph_reads": counts.graphReads,
      "harness.tokens.source_bytes": counts.sourceBytes,
      ...Object.fromEntries(
        Object.entries(unavailable).map(([reason, count]) => [
          `harness.tokens.unavailable.${reason}`,
          count,
        ]),
      ),
      ...Object.fromEntries(
        Object.entries(notRead).map(([reason, count]) => [
          `harness.tokens.not_read.${reason}`,
          count,
        ]),
      ),
    });
    yield* Effect.try(() => assertOutlineSource(source));
    return {
      answers: answers as ReadonlyMap<string, BlobTokensAnswer>,
      bytes: bytes as ReadonlyMap<string, Uint8Array>,
      counts,
    };
  }).pipe(Effect.withSpan("harness.tokens.read"));
