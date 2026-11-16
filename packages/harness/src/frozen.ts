import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { Effect } from "effect";
import { z } from "zod";
import { estimateTokens } from "./budget.ts";
import { CHUNK_RECIPE, WINDOW_RECIPE, splitLines } from "./chunker.ts";
import { lsTree, readBlobs } from "./git-objects.ts";
import type { HunkRecord } from "./hunks.ts";
import type { FrozenConfig, Retriever, SearchResult } from "./retriever.ts";
import {
  chunkIdOf,
  chunkIdentifiers,
  specificIdentifiers,
  type IndexedChunk,
  type TreeIndex,
} from "./search-index.ts";

/**
 * The frozen-candidate seam (10.89, suggested in the 9.57 review): a candidate's leads read from a
 * file instead of searched, under the candidate's own name and the file's SHA-256 in the leads key,
 * so the end-to-end check's frozen R(H3-E0) or R(H1-E0) leads never pass for BM25's.
 *
 * The file is gzipped JSON lines in the benchmark's pool shape (`pools/<split>/<arm>.jsonl.gz`):
 * each row a case (`<corpus>:<base8>..<head8>`), a benchmark hunk and its ranked regions as
 * `[path, startLine, endLine, chunkId, kind, tokens, score]`; the full test's all-hunks rows
 * (`results/full-test/leads/`) carry no benchmark hunk ID but the hunk's path, spans and exact
 * diff text (`diffText`). A row is
 * matched to the range's harness hunk on the same path by diff text, else by header, else by
 * overlapping lines (the rule harness-compare's `matchHunks` uses). Each region becomes a search
 * result at the base tree with the 10.45 metadata of the shared chunk it overlaps most; a region
 * not in the base tree is skipped. A hunk no row matches gets the fallback retriever's leads.
 */

const Region = z.tuple([
  z.string(),
  z.int().min(1),
  z.int().min(1),
  z.string().nullable(),
  z.string(),
  z.number(),
  z.number(),
]);
const Span = z.object({ start: z.int().min(0), lines: z.int().min(0) });

/**
 * One row, as the pools and the labelling side's all-hunks mode write it. A pool row names its
 * benchmark hunk (`hunkId`); an all-hunks row has none and carries the hunk's exact `diffText`
 * (`diff` in earlier rows) and its query text instead. Other fields (the arm, Graph's status per
 * hunk) are kept as given.
 */
export const FrozenRow = z.looseObject({
  caseId: z.string().regex(/^[^:]+:[0-9a-f]{7,40}\.\.[0-9a-f]{7,40}$/),
  hunkId: z.string().min(1).optional(),
  path: z.string().optional(),
  oldPath: z.string().nullable().optional(),
  old: Span.optional(),
  new: Span.optional(),
  diffText: z.string().optional(),
  diff: z.string().optional(),
  queryText: z.string().optional(),
  regions: z.array(Region),
});

/** A row's diff text, by either name. */
const diffOf = (row: FrozenRow) => row.diffText ?? row.diff;
export type FrozenRow = z.infer<typeof FrozenRow>;

export interface FrozenTable {
  readonly sha256: string;
  readonly rows: ReadonlyArray<FrozenRow>;
}

const tables = new Map<string, FrozenTable>();

/** Reads and checks a leads file: its bytes must hash to the config's SHA-256. */
export const loadFrozen = (path: string, sha256: string): FrozenTable => {
  const held = tables.get(sha256);
  if (held !== undefined) return held;
  const bytes = readFileSync(path);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== sha256)
    throw new Error(
      `the frozen leads file ${path} has SHA-256 ${actual}, not the run's ${sha256}`,
    );
  const text = new TextDecoder().decode(
    path.endsWith(".gz") ? gunzipSync(bytes) : bytes,
  );
  const rows = text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, at) => {
      const parsed = FrozenRow.safeParse(JSON.parse(line));
      if (!parsed.success)
        throw new Error(
          `${path} line ${at + 1}: ${z.prettifyError(parsed.error)}`,
        );
      return parsed.data;
    });
  const table = { sha256, rows };
  tables.set(sha256, table);
  return table;
};

/** The rows of a table for one range: the case's base and head prefix the range's OIDs. */
export const rowsForRange = (
  table: FrozenTable,
  range: {
    readonly baseOid: string;
    readonly mergeBase: string;
    readonly headOid: string;
  },
) =>
  table.rows.filter((row) => {
    const [, span] = row.caseId.split(":") as [string, string];
    const [base, head] = span.split("..") as [string, string];
    return (
      range.headOid.startsWith(head) &&
      (range.baseOid.startsWith(base) || range.mergeBase.startsWith(base))
    );
  });

type Matchable = Pick<
  HunkRecord,
  "path" | "kind" | "oldStart" | "oldLines" | "newStart" | "newLines" | "text"
>;

const withoutTrailingNewline = (text: string) => text.replace(/\n$/, "");

/** The row with the hunk's path and diff text, else its exact spans. */
const matchExactly = (hunk: Matchable, rows: ReadonlyArray<FrozenRow>) => {
  if (hunk.kind !== "text") return undefined;
  const samePath = rows.filter((row) => row.path === hunk.path);
  const byText = samePath.find((row) => {
    const diff = diffOf(row);
    return (
      diff !== undefined &&
      withoutTrailingNewline(diff) === withoutTrailingNewline(hunk.text)
    );
  });
  if (byText !== undefined) return { row: byText, how: "text" as const };
  const exact = samePath.find(
    (row) =>
      row.old?.start === hunk.oldStart &&
      row.old?.lines === hunk.oldLines &&
      row.new?.start === hunk.newStart &&
      row.new?.lines === hunk.newLines,
  );
  return exact === undefined
    ? undefined
    : { row: exact, how: "exact" as const };
};

const overlaps = (hunk: Matchable, row: FrozenRow) => {
  if (row.path !== hunk.path || row.old === undefined || row.new === undefined)
    return false;
  const side = row.new.lines > 0 ? "new" : "old";
  const [start, lines] =
    side === "new"
      ? [row.new.start, row.new.lines]
      : [row.old.start, row.old.lines];
  const [rs, rl] =
    side === "new"
      ? [hunk.newStart, hunk.newLines]
      : [hunk.oldStart, hunk.oldLines];
  return rs <= start + lines - 1 && start <= rs + rl - 1;
};

/**
 * Each hunk's row over the whole range, decided once and in hunk order: by diff text, else by exact
 * spans; then each hunk still without one takes the first overlapping row no other hunk has, so a
 * row never serves two hunks and the assignment does not depend on which hunk asks first.
 */
export const assignRows = (
  hunks: ReadonlyArray<Matchable & { readonly hunkId: string }>,
  rows: ReadonlyArray<FrozenRow>,
) => {
  const assigned = new Map<
    string,
    { readonly row: FrozenRow; readonly how: "text" | "exact" | "overlap" }
  >();
  const used = new Set<FrozenRow>();
  for (const hunk of hunks) {
    const matched = matchExactly(hunk, rows);
    if (matched === undefined || used.has(matched.row)) continue;
    assigned.set(hunk.hunkId, matched);
    used.add(matched.row);
  }
  for (const hunk of hunks) {
    if (hunk.kind !== "text" || assigned.has(hunk.hunkId)) continue;
    const row = rows.find((entry) => !used.has(entry) && overlaps(hunk, entry));
    if (row === undefined) continue;
    assigned.set(hunk.hunkId, { row, how: "overlap" });
    used.add(row);
  }
  return assigned;
};

/** What a frozen candidate's leads are keyed on beyond its config: the range its rows were read for. */
export const frozenKeyed = (range: {
  readonly mergeBase: string;
  readonly headOid: string;
}) => ({ range: `${range.mergeBase}..${range.headOid}` });

const bestChunk = (
  chunks: ReadonlyArray<IndexedChunk>,
  start: number,
  end: number,
) => {
  let best: { chunk: IndexedChunk; shared: number } | undefined;
  for (const chunk of chunks) {
    const shared =
      Math.min(end, chunk.endLine) - Math.max(start, chunk.startLine) + 1;
    if (shared > 0 && (best === undefined || shared > best.shared))
      best = { chunk, shared };
  }
  return best?.chunk;
};

/** A row's regions as search results at the base tree, the first `limit` that are in it. */
export const frozenResults = (
  repository: string,
  index: TreeIndex,
  row: FrozenRow,
  candidate: string,
  querySha256: string,
  limit: number,
) =>
  Effect.gen(function* () {
    const entries = new Map(
      (yield* lsTree(repository, index.tree)).map((entry) => [
        entry.path,
        entry.oid,
      ]),
    );
    const wanted = row.regions.slice(0, limit * 3);
    const texts = yield* readBlobs(repository, [
      ...new Set(wanted.flatMap(([path]) => entries.get(path) ?? [])),
    ]);
    const results: Array<SearchResult> = [];
    let skipped = 0;
    let unreadable = 0;
    for (const [path, startLine, endLine, , , , score] of row.regions) {
      if (results.length >= limit) break;
      const blob = entries.get(path);
      const bytes =
        blob === undefined
          ? undefined
          : (texts.get(blob) ??
            (yield* readBlobs(repository, [blob])).get(blob));
      if (blob === undefined || bytes === undefined) {
        skipped++;
        if (blob !== undefined) unreadable++;
        continue;
      }
      const lines = splitLines(new TextDecoder().decode(bytes));
      const end = Math.min(endLine, lines.length);
      if (startLine > end) {
        skipped++;
        continue;
      }
      const onPath = (index.byPath.get(path) ?? []).flatMap(
        (doc) => index.chunks[doc] ?? [],
      );
      const chunk = bestChunk(onPath, startLine, end);
      const text = lines.slice(startLine - 1, end).join("");
      results.push({
        identity: {
          tree: index.tree,
          blobOid: blob,
          path,
          startLine,
          endLine: end,
          chunkId: chunkIdOf(blob, startLine, end),
          recipe: CHUNK_RECIPE,
        },
        kind:
          chunk === undefined || chunk.declared === "undeclared"
            ? "undeclared"
            : [...chunk.declared],
        language: chunk?.language ?? "undeclared",
        capability: chunk?.capability ?? WINDOW_RECIPE,
        enclosing: {
          kind: chunk?.kind ?? "window",
          name: chunk?.symbol ?? null,
          headingPath: [...(chunk?.headingPath ?? [])],
        },
        callables: [...(chunk?.callables ?? [])],
        identifiers: {
          specific:
            chunk === undefined
              ? []
              : specificIdentifiers(index, chunkIdentifiers(chunk, text)),
          from:
            chunk === undefined || chunk.parsedIdentifiers === null
              ? "word-tokens"
              : "code-positions",
        },
        neighbours: {
          previous: chunk?.previous ?? null,
          next: chunk?.next ?? null,
          outline: `${path}@${index.tree}`,
        },
        retrieval: {
          retriever: candidate,
          querySha256,
          rank: results.length + 1,
          score: Number(score.toPrecision(9)),
          tokens: estimateTokens(Buffer.byteLength(text)),
        },
        coverage: { vectors: "not-applicable", stale: false },
      });
    }
    return { results, skipped, unreadable };
  });

/**
 * The frozen candidate over a range: `leadsFor` serves a hunk's assigned row (its first `limit`
 * regions in the base tree); `search` is the fallback retriever's, so a hunk with no row, or whose
 * row has no region in the base tree, gets the fallback's leads, named as the fallback's, with a note.
 */
export const frozenRetriever = (
  repository: string,
  index: TreeIndex,
  config: FrozenConfig,
  rows: ReadonlyArray<FrozenRow>,
  fallback: Retriever,
  limit: number,
  range: { readonly mergeBase: string; readonly headOid: string },
  hunks: ReadonlyArray<Matchable & { readonly hunkId: string }>,
): Retriever => {
  const assigned = assignRows(hunks, rows);
  return {
    description: {
      id: config.candidate,
      family: "frozen",
      config,
      index: fallback.description.index,
      keyed: frozenKeyed(range),
    },
    tree: index.tree,
    search: fallback.search,
    leadsFor: (hunk) =>
      Effect.gen(function* () {
        const matched = assigned.get(hunk.hunkId);
        if (hunk.query === null) return undefined;
        if (matched === undefined)
          return {
            note: `${config.candidate}'s leads file has no row for this hunk; these are ${config.fallback.id}'s leads`,
          };
        const { results, skipped, unreadable } = yield* frozenResults(
          repository,
          index,
          matched.row,
          config.candidate,
          hunk.query.sha256,
          limit,
        );
        const absent = skipped - unreadable;
        const notes: string[] = [];
        if (absent > 0)
          notes.push(
            results.length === 0
              ? `none of the ${absent} region(s) in ${config.candidate}'s row for this hunk is in the base tree`
              : `${absent} region(s) of ${config.candidate}'s row were not in the base tree and were skipped`,
          );
        if (unreadable > 0)
          notes.push(
            `${unreadable} region(s) of ${config.candidate}'s row are in the base tree, but their text could not be read and they were skipped`,
          );
        if (results.length === 0) {
          if (notes.length === 0)
            notes.push(
              `none of the ${skipped} region(s) in ${config.candidate}'s row for this hunk is in the base tree`,
            );
          notes.push(`these are ${config.fallback.id}'s leads`);
          return { note: notes.join("; ") };
        }
        return {
          results,
          ...(notes.length === 0 ? {} : { note: notes.join("; ") }),
        };
      }),
  };
};
