import { indexRecipe } from "../../../harness/src/search-index.ts";
import { captureOutlineSource } from "../../../harness/src/graph-outline.ts";
import { z } from "zod";
import {
  ProofRecorded,
  PROOF_MEDIA_TYPES,
} from "../../../records-schema/src/index.ts";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer, Option } from "effect";
import {
  Blobs,
  Computations,
  Log,
  Store,
  resolveStoreLocation,
  type StoreLocation,
} from "@neuve/records-core";
import { readAsItStands, readWithoutLog } from "@neuve/records-core/read-only";
import { estimateTokens } from "../../../harness/src/budget.ts";
import { CHUNK_RECIPE, splitLines } from "../../../harness/src/chunker.ts";
import {
  diffTrees,
  lsTree,
  mergeBase,
  readBlobs,
  treeOf,
} from "../../../harness/src/git-objects.ts";
import { describeHunks, type HunkRecord } from "../../../harness/src/hunks.ts";
import {
  FrozenRow,
  assignRows,
  frozenResults,
} from "../../../harness/src/frozen.ts";
import {
  HunkLeads,
  LEADS_PER_HUNK,
  leadsSpec,
} from "../../../harness/src/leads.ts";
import {
  DEFAULT_RETRIEVER,
  type SearchResult,
} from "../../../harness/src/retriever.ts";
import { shownLeads } from "./shown-leads.ts";
import {
  chunkIdOf,
  chunkIdentifiers,
  specificIdentifiers,
  treeIndex,
} from "../../../harness/src/search-index.ts";

/**
 * The harness side of the comparison: code that runs inside the pinned harness snapshot (the
 * harness at HEAD, copied out of the shared checkout so another lane's edits never reach a run),
 * over one scratch clone's Records store. Two commands:
 *
 * `seed`: the retriever-port adapter. For each of the range's harness hunks that is one of M4's
 * hunks, it turns the candidate's frozen ranking (M4's top 50 for that hunk, cut to the port's
 * LEADS_PER_HUNK) into the port's search results and stores them as that hunk's leads computation
 * (`harness.hunk-leads`), so Precompute's manifest reuses them exactly as it reuses commit-time
 * leads (PC13). Every other hunk has no frozen ranking and gets the harness's own BM25 leads, the
 * same in both candidates. Nothing is re-encoded and no model is called.
 *
 * The port's `RetrieverConfig` admits only `bm25` at HEAD, so the leads are stored under the BM25
 * key; each candidate has its own store, so the key never mixes candidates, and every result names
 * its real retriever in `retrieval.retriever`. A harness seam that admits another retriever id would
 * remove this (reported as an open issue, not made here: packages/harness belongs to another lane).
 *
 * `copy`: copies the lead-independent computations (Understand, its merge pass, the cycle's scope
 * snapshot) from candidate A's store into candidate B's under the same keys, so B's run reuses A's
 * Understand instead of calling the model again. Keys are recomputed from the stored material and
 * must match.
 */

type Region = readonly [
  path: string,
  startLine: number,
  endLine: number,
  chunkId: string | null,
  kind: string,
  tokens: number,
  score: number,
];

/** What the orchestrator hands `seed`: each M4 hunk of the range with the candidate's ranking. */
export interface SeedInput {
  readonly candidate: string;
  readonly base: string;
  readonly head: string;
  readonly hunks: ReadonlyArray<{
    readonly hunkId: string;
    readonly path: string;
    readonly oldPath: string;
    readonly old: { readonly start: number; readonly lines: number };
    readonly new: { readonly start: number; readonly lines: number };
    readonly queryText: string;
    readonly regions: ReadonlyArray<Region>;
    /**
     * The hunk's diff text, when the leads come from an all-hunks leads file (full test, FT6):
     * matched to the harness hunk on the same path and text before its header is tried.
     */
    readonly diffText?: string;
  }>;
}

export interface HunkMatch {
  readonly m4HunkId: string;
  readonly harnessHunkId: string | null;
  readonly how: "text" | "exact" | "overlap" | "none";
}

const recordsLayer = (location: StoreLocation) =>
  Layer.mergeAll(
    Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
  ).pipe(
    Layer.provideMerge(Store.layer(location, { create: true })),
    Layer.provideMerge(BunFileSystem.layer),
  );

/**
 * M4 hunks (or leads-file rows) to the range's harness hunks: the same file and diff text where the
 * input carries it, else the same file and header, else the overlapping one.
 */
export const matchHunks = (
  m4: SeedInput["hunks"],
  harness: ReadonlyArray<
    Pick<
      HunkRecord,
      | "hunkId"
      | "path"
      | "kind"
      | "oldStart"
      | "oldLines"
      | "newStart"
      | "newLines"
      | "text"
    >
  >,
): Array<HunkMatch> => {
  // One rule in three passes, each over the harness hunks no earlier match took, so two inputs
  // never land on one harness hunk: diff text first, then the exact header, then overlapping lines.
  const taken = new Set<string>();
  const result = new Map<number, HunkMatch>();
  const samePath = (hunk: SeedInput["hunks"][number]) =>
    harness.filter(
      (record) =>
        record.path === hunk.path &&
        record.kind === "text" &&
        !taken.has(record.hunkId),
    );
  const sameText = (a: string, b: string) =>
    a === b || a.replace(/\n$/, "") === b.replace(/\n$/, "");
  const passes: ReadonlyArray<
    readonly [
      HunkMatch["how"],
      (
        hunk: SeedInput["hunks"][number],
        record: (typeof harness)[number],
      ) => boolean,
    ]
  > = [
    [
      "text",
      (hunk, record) =>
        hunk.diffText !== undefined && sameText(record.text, hunk.diffText),
    ],
    [
      "exact",
      (hunk, record) =>
        record.oldStart === hunk.old.start &&
        record.oldLines === hunk.old.lines &&
        record.newStart === hunk.new.start &&
        record.newLines === hunk.new.lines,
    ],
    [
      "overlap",
      (hunk, record) => {
        const side = hunk.new.lines > 0 ? "new" : "old";
        const [start, lines] =
          side === "new"
            ? [hunk.new.start, hunk.new.lines]
            : [hunk.old.start, hunk.old.lines];
        const [rs, rl] =
          side === "new"
            ? [record.newStart, record.newLines]
            : [record.oldStart, record.oldLines];
        return rs <= start + lines - 1 && start <= rs + rl - 1;
      },
    ],
  ];
  for (const [how, matches] of passes)
    m4.forEach((hunk, index) => {
      if (result.has(index)) return;
      const record = samePath(hunk).find((candidate) =>
        matches(hunk, candidate),
      );
      if (record === undefined) return;
      taken.add(record.hunkId);
      result.set(index, {
        m4HunkId: hunk.hunkId,
        harnessHunkId: record.hunkId,
        how,
      });
    });
  return m4.map(
    (hunk, index) =>
      result.get(index) ?? {
        m4HunkId: hunk.hunkId,
        harnessHunkId: null,
        how: "none",
      },
  );
};

/** The harness chunk on the same path that shares most lines with [start, end]. */
export const bestChunk = <
  C extends {
    readonly chunkId: string;
    readonly startLine: number;
    readonly endLine: number;
  },
>(
  chunks: ReadonlyArray<C>,
  start: number,
  end: number,
) => {
  let best: { chunk: C; shared: number } | undefined;
  for (const chunk of chunks) {
    const shared =
      Math.min(end, chunk.endLine) - Math.max(start, chunk.startLine) + 1;
    if (shared > 0 && (best === undefined || shared > best.shared))
      best = { chunk, shared };
  }
  return best?.chunk;
};

const seed = (repository: string, input: SeedInput) =>
  Effect.gen(function* () {
    const source = captureOutlineSource();
    const merge = yield* mergeBase(repository, input.base, input.head);
    const baseTree = yield* treeOf(repository, merge);
    const files = yield* diffTrees(repository, merge, input.head);
    const hunks = yield* describeHunks(repository, files, source);
    const baseBlobs = new Map(
      (yield* lsTree(repository, baseTree)).map((entry) => [
        entry.path,
        entry.oid,
      ]),
    );
    const { index } = yield* treeIndex(repository, baseTree, source);
    const matches = matchHunks(input.hunks, hunks);
    const store = yield* Computations.ComputationStore;
    const seeded: Array<Record<string, unknown>> = [];
    const usedBlobs = [
      ...new Set(
        input.hunks.flatMap((hunk) =>
          hunk.regions
            .slice(0, LEADS_PER_HUNK)
            .flatMap(([path]) => baseBlobs.get(path) ?? []),
        ),
      ),
    ];
    const texts = yield* readBlobs(repository, usedBlobs);
    const decoded = new Map(
      [...texts].map(([oid, bytes]) => [
        oid,
        splitLines(new TextDecoder().decode(bytes)),
      ]),
    );
    for (const match of matches) {
      const m4 = input.hunks.find((hunk) => hunk.hunkId === match.m4HunkId)!;
      const record = hunks.find((hunk) => hunk.hunkId === match.harnessHunkId);
      if (record === undefined || record.query === null) {
        seeded.push({
          m4HunkId: m4.hunkId,
          harnessHunkId: match.harnessHunkId,
          how: match.how,
          seeded: false,
          reason:
            record === undefined
              ? "no harness hunk matches"
              : "the harness hunk has no query",
        });
        continue;
      }
      const skipped: Array<string> = [];
      const results: Array<SearchResult> = [];
      /** Each served lead as the harness's own chunk it falls in (FT4's served-top-3 rule). */
      const servedChunks: Array<string> = [];
      for (const region of m4.regions) {
        if (results.length >= LEADS_PER_HUNK) break;
        const [path, startLine, endLine, , , , score] = region;
        const blob = baseBlobs.get(path);
        const lines = blob === undefined ? undefined : decoded.get(blob);
        if (blob === undefined || lines === undefined) {
          skipped.push(`${path}:${startLine}-${endLine} not in the base tree`);
          continue;
        }
        const end = Math.min(endLine, lines.length);
        if (startLine > end) {
          skipped.push(`${path}:${startLine}-${endLine} past the file's end`);
          continue;
        }
        const onPath = (index.byPath.get(path) ?? []).flatMap(
          (doc) => index.chunks[doc] ?? [],
        );
        const chunk = bestChunk(onPath, startLine, end);
        servedChunks.push(chunk?.chunkId ?? `${path}:${startLine}-${end}`);
        const text = lines.slice(startLine - 1, end).join("");
        const identifiers =
          chunk === undefined
            ? []
            : specificIdentifiers(index, chunkIdentifiers(chunk, text));
        results.push({
          identity: {
            tree: baseTree,
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
          capability: chunk?.capability ?? "utf8-line-window-4k-v2",
          enclosing: {
            kind: chunk?.kind ?? "window",
            name: chunk?.symbol ?? null,
            headingPath: [...(chunk?.headingPath ?? [])],
          },
          callables: [...(chunk?.callables ?? [])],
          identifiers: {
            specific: identifiers,
            from:
              chunk === undefined || chunk.parsedIdentifiers === null
                ? "word-tokens"
                : "code-positions",
          },
          neighbours: {
            previous: chunk?.previous ?? null,
            next: chunk?.next ?? null,
            outline: `${path}@${baseTree}`,
          },
          retrieval: {
            retriever: input.candidate,
            querySha256: record.query.sha256,
            rank: results.length + 1,
            score: Number(score.toPrecision(9)),
            tokens: estimateTokens(Buffer.byteLength(text)),
          },
          coverage: { vectors: "current", stale: false },
        });
      }
      const leads: HunkLeads = {
        tree: baseTree,
        querySha256: record.query.sha256,
        results,
        millis: 0,
      };
      const spec = leadsSpec(record, DEFAULT_RETRIEVER, indexRecipe(source));
      const stored = yield* store.run(
        spec,
        Effect.succeed({
          bytes: new TextEncoder().encode(
            JSON.stringify(HunkLeads.parse(leads)),
          ),
          mediaType: "application/json",
        }),
      );
      seeded.push({
        m4HunkId: m4.hunkId,
        harnessHunkId: record.hunkId,
        how: match.how,
        seeded: stored.status === "computed",
        status: stored.status,
        key: stored.computation.key,
        results: results.length,
        skipped,
        sameQueryText: record.query.text === m4.queryText,
        top: results
          .slice(0, 3)
          .map(
            (result) =>
              `${result.identity.path}:${result.identity.startLine}-${result.identity.endLine}`,
          ),
        servedTop3Chunks: servedChunks.slice(0, 3),
      });
    }
    return {
      candidate: input.candidate,
      mergeBase: merge,
      baseIsMergeBase: merge === input.base,
      baseTree,
      harnessHunks: hunks.length,
      textHunks: hunks.filter((hunk) => hunk.kind === "text").length,
      /** Every text harness hunk, so the full test can name the hunks no lead row reached. */
      textHunkIds: hunks
        .filter((hunk) => hunk.kind === "text")
        .map((hunk) => hunk.hunkId),
      seeded,
    };
  });

/** A served lead as it stands in a stored manifest: its region and the tree it was read at. */
export interface ServedLead {
  readonly identity: {
    readonly tree?: string;
    readonly path: string;
    readonly startLine: number;
    readonly endLine: number;
  };
}

/**
 * FT4's served top 3, as the harness's own chunks: each of a hunk's first three served leads mapped
 * to the chunk of the range's base index on its path that shares most lines with it (the seed step's
 * `bestChunk` rule), so two benchmark spans inside one harness chunk count as the same handle. A
 * lead on no indexed chunk keeps its own span. Text hunks with no leads read null.
 */
export const servedChunkIds = (
  hunks: ReadonlyArray<{
    readonly hunkId: string;
    readonly kind: string;
    readonly leads?: { readonly results: ReadonlyArray<ServedLead> } | null;
  }>,
  chunksOn: (path: string) => ReadonlyArray<{
    readonly chunkId: string;
    readonly startLine: number;
    readonly endLine: number;
  }>,
) => {
  const out: Record<string, ReadonlyArray<string> | null> = {};
  for (const hunk of hunks) {
    if (hunk.kind !== "text") continue;
    const results = hunk.leads?.results ?? [];
    out[hunk.hunkId] =
      results.length === 0
        ? null
        : results.slice(0, 3).map(({ identity }) => {
            const chunk = bestChunk(
              chunksOn(identity.path),
              identity.startLine,
              identity.endLine,
            );
            return (
              chunk?.chunkId ??
              `${identity.path}:${identity.startLine}-${identity.endLine}`
            );
          });
  }
  return out;
};

const served = (
  repository: string,
  shown: {
    manifest?: {
      hunks?: ReadonlyArray<Parameters<typeof servedChunkIds>[0][number]>;
    } | null;
    leads?: {
      hunks: ReadonlyArray<{
        hunkId: string;
        leads: { readonly results: ReadonlyArray<ServedLead> } | null;
      }>;
    } | null;
  },
) =>
  Effect.gen(function* () {
    // The leads' own computation for a newer run, each hunk's inline leads for an older one.
    const leadsOf = shownLeads(shown);
    const hunks = (shown.manifest?.hunks ?? []).map((hunk) => ({
      hunkId: hunk.hunkId,
      kind: hunk.kind,
      leads: leadsOf(hunk.hunkId),
    }));
    const trees = [
      ...new Set(
        hunks.flatMap((hunk) =>
          (hunk.leads?.results ?? []).flatMap((result) =>
            result.identity.tree === undefined ? [] : [result.identity.tree],
          ),
        ),
      ),
    ];
    // Leads are read at the range's base tree; one index serves every hunk.
    if (trees.length > 1)
      return yield* Effect.die(
        new Error(`served leads come from ${trees.length} trees, not one`),
      );
    if (trees.length === 0) return servedChunkIds(hunks, () => []);
    const { index } = yield* treeIndex(
      repository,
      trees[0]!,
      captureOutlineSource(),
    );
    return servedChunkIds(hunks, (path) =>
      (index.byPath.get(path) ?? []).flatMap((doc) => {
        const chunk = index.chunks[doc];
        return chunk === undefined ? [] : [chunk];
      }),
    );
  });

/**
 * The pre-pilot check of the leads files against the harness (offline, no model): for one range,
 * every row should match exactly one of the harness's own hunks, by this runner's matcher and by
 * the committed frozen seam alike (both key on path plus diff text); on a sample of hunks, the seam
 * should serve the row's first regions that are in the base tree, and `served` should map each to
 * the harness chunk sharing most lines with it.
 */
const checkLeads = (
  repository: string,
  input: {
    readonly base: string;
    readonly head: string;
    readonly rows: ReadonlyArray<Record<string, unknown>>;
    readonly sample: number;
  },
) =>
  Effect.gen(function* () {
    const source = captureOutlineSource();
    const merge = yield* mergeBase(repository, input.base, input.head);
    const baseTree = yield* treeOf(repository, merge);
    const files = yield* diffTrees(repository, merge, input.head);
    const hunks = yield* describeHunks(repository, files, source);
    const text = hunks.filter((hunk) => hunk.kind === "text");
    const rows = input.rows.map((row) => FrozenRow.parse(row));
    const ours = matchHunks(
      rows.map((row, at) => ({
        hunkId: String(at),
        path: row.path ?? "",
        oldPath: row.oldPath ?? row.path ?? "",
        old: row.old ?? { start: 0, lines: 0 },
        new: row.new ?? { start: 0, lines: 0 },
        queryText: "",
        regions: [],
        ...((row.diffText ?? row.diff) === undefined
          ? {}
          : { diffText: (row.diffText ?? row.diff)! }),
      })),
      hunks,
    );
    const seam = assignRows(hunks, rows);
    const seamRowOf = new Map(
      [...seam].map(([hunkId, entry]) => [
        entry.row,
        { hunkId, how: entry.how },
      ]),
    );
    const perRow = rows.map((row, at) => {
      const mine = ours[at]!;
      const theirs = seamRowOf.get(row);
      return {
        row: at,
        path: row.path,
        hunkId: row.hunkId ?? null,
        ours: mine.harnessHunkId,
        oursHow: mine.how,
        seam: theirs?.hunkId ?? null,
        seamHow: theirs?.how ?? "none",
      };
    });
    const takenBy = new Map<string, number>();
    for (const entry of perRow)
      if (entry.ours !== null)
        takenBy.set(entry.ours, (takenBy.get(entry.ours) ?? 0) + 1);
    const { index } = yield* treeIndex(repository, baseTree, source);
    const chunksOn = (path: string) =>
      (index.byPath.get(path) ?? []).flatMap((doc) => {
        const chunk = index.chunks[doc];
        return chunk === undefined ? [] : [chunk];
      });
    const sample = [];
    for (const hunk of text.slice(0, input.sample)) {
      const assigned = seam.get(hunk.hunkId);
      if (assigned === undefined) continue;
      const { results } = yield* frozenResults(
        repository,
        index,
        assigned.row,
        "check",
        "",
        3,
      );
      const servedIds =
        servedChunkIds(
          [{ hunkId: hunk.hunkId, kind: "text", leads: { results } }],
          chunksOn,
        )[hunk.hunkId] ?? [];
      // Independently: each served lead's chunk must share the most lines with it on its path.
      const mapped = results.map((result, at) => {
        const shared = (chunk: { startLine: number; endLine: number }) =>
          Math.min(result.identity.endLine, chunk.endLine) -
          Math.max(result.identity.startLine, chunk.startLine) +
          1;
        const best = Math.max(0, ...chunksOn(result.identity.path).map(shared));
        const chosen = chunksOn(result.identity.path).find(
          (chunk) => chunk.chunkId === servedIds[at],
        );
        return {
          lead: `${result.identity.path}:${result.identity.startLine}-${result.identity.endLine}`,
          chunk: servedIds[at] ?? null,
          overlapsMost:
            chosen === undefined ? best === 0 : shared(chosen) === best,
        };
      });
      const expected = assigned.row.regions
        .slice(0, 3)
        .map(([path, startLine, endLine]) => `${path}:${startLine}-${endLine}`);
      sample.push({
        hunkId: hunk.hunkId,
        rowTop3: expected,
        seamTop3: mapped.map((entry) => entry.lead),
        sameTop3:
          JSON.stringify(expected) ===
          JSON.stringify(mapped.map((entry) => entry.lead)),
        served: mapped,
      });
    }
    return {
      harnessTextHunks: text.length,
      rows: rows.length,
      rowsMatchedOnce: perRow.filter(
        (entry) => entry.ours !== null && takenBy.get(entry.ours) === 1,
      ).length,
      rowsUnmatched: perRow
        .filter((entry) => entry.ours === null)
        .map((entry) => `${entry.path} (${entry.hunkId})`),
      matcherAgreement: perRow.filter((entry) => entry.ours === entry.seam)
        .length,
      disagreements: perRow.filter((entry) => entry.ours !== entry.seam),

      hunksWithoutRow: text
        .filter((hunk) => !perRow.some((entry) => entry.ours === hunk.hunkId))
        .map((hunk) => `${hunk.path} ${hunk.hunkId}`),
      sample,
    };
  });

/** The computations `copy` moves from A to B: none depends on the leads. */
export const SHARED_OPS = [
  "harness.understand",
  "harness.understand-merge",
  "harness.scope-snapshot",
] as const;

/** One computation's stored output, as `copy` and the full test's bundles move it between stores. */
export interface SharedEntry {
  readonly op: string;
  readonly key: string;
  readonly material: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

/**
 * The named computations of a store, oldest first, with their output bytes checked against their
 * hashes. It reads through SQLite and the blob files, never through Records' writer, so the store is
 * never written.
 */
const readShared = (from: StoreLocation, ops: ReadonlyArray<string>) =>
  Effect.sync(() => {
    const read = readAsItStands(from.database, (database) =>
      (
        database
          .prepare(
            `SELECT c.key, c.op, c.material, c.output_hash AS outputHash, b.media_type AS mediaType, b.size, b.placement, b.content, b.pruned_at AS prunedAt
             FROM computations c LEFT JOIN blobs b ON b.hash = c.output_hash
             WHERE c.op IN (${ops.map(() => "?").join(",")}) ORDER BY c.completed_at`,
          )
          .all(...ops) as Array<{
          key: string;
          op: string;
          material: string;
          outputHash: string;
          mediaType: string | null;
          size: number | null;
          placement: "inline" | "file" | null;
          content: Uint8Array | null;
          prunedAt: string | null;
        }>
      ).map((row): SharedEntry => {
        const bytes =
          row.placement === "inline"
            ? row.content
            : row.placement === "file"
              ? new Uint8Array(
                  readFileSync(
                    join(
                      from.blobs,
                      "sha256",
                      row.outputHash.slice(0, 2),
                      row.outputHash.slice(2),
                    ),
                  ),
                )
              : null;
        if (
          bytes === null ||
          row.prunedAt !== null ||
          bytes.byteLength !== row.size ||
          createHash("sha256").update(bytes).digest("hex") !== row.outputHash
        )
          throw new Error(`${row.op} ${row.key}: output blob is not present`);
        return {
          op: row.op,
          key: row.key,
          material: row.material,
          mediaType: row.mediaType ?? "application/json",
          bytes,
        };
      }),
    );
    if (read.withoutLog) console.error(readWithoutLog(from.database));
    return read.value;
  });

/** Stores each entry under its own key, which must be the key recomputed from its material. */
const writeShared = (to: StoreLocation, entries: ReadonlyArray<SharedEntry>) =>
  Effect.gen(function* () {
    yield* Store.prepareForWrite;
    const store = yield* Computations.ComputationStore;
    const copied: Array<Record<string, unknown>> = [];
    for (const entry of entries) {
      const material = JSON.parse(entry.material) as {
        op: string;
        opVersion: number;
        inputs: unknown;
        config: unknown;
        route: unknown;
      };
      const spec = Computations.ComputationSpec.parse({
        op: material.op,
        opVersion: material.opVersion,
        inputs: material.inputs,
        ...(material.config === null ? {} : { config: material.config }),
        ...(material.route === null ? {} : { route: material.route }),
      });
      const key = Computations.computationKey(spec).key;
      if (key !== entry.key)
        return yield* Effect.die(
          new Error(`${entry.op}: recomputed key ${key} is not ${entry.key}`),
        );
      const held = yield* store.lookup(key);
      const result = yield* store.run(
        spec,
        Effect.succeed({ bytes: entry.bytes, mediaType: entry.mediaType }),
      );
      copied.push({
        op: entry.op,
        key,
        status: Option.isSome(held) ? "already-present" : result.status,
      });
    }
    return copied;
  }).pipe(Effect.provide(recordsLayer(to)));

const copy = (from: StoreLocation, to: StoreLocation) =>
  Effect.flatMap(readShared(from, SHARED_OPS), (entries) =>
    writeShared(to, entries),
  );

/**
 * The full test's bundles: phase A's Understand (or the cycle's scope snapshot alone, for U') kept
 * as one small file once A's clone is deleted (the owner's disk rule), and written into each later
 * phase's store under the same keys. Bytes travel as base64.
 */
export const BUNDLE_OPS: Record<
  "understand" | "scope-only",
  ReadonlyArray<string>
> = {
  understand: SHARED_OPS,
  "scope-only": ["harness.scope-snapshot"],
};

interface Bundle {
  readonly ops: ReadonlyArray<string>;
  readonly entries: ReadonlyArray<
    Omit<SharedEntry, "bytes"> & { readonly bytes: string }
  >;
}

const toBundle = (
  ops: ReadonlyArray<string>,
  entries: ReadonlyArray<SharedEntry>,
): Bundle => ({
  ops,
  entries: entries.map((entry) => ({
    ...entry,
    bytes: Buffer.from(entry.bytes).toString("base64"),
  })),
});

const fromBundle = (
  bundle: Bundle,
  ops: ReadonlyArray<string>,
): Array<SharedEntry> =>
  bundle.entries
    .filter((entry) => ops.includes(entry.op))
    .map((entry) => ({
      ...entry,
      bytes: new Uint8Array(Buffer.from(entry.bytes, "base64")),
    }));

/**
 * Proof records (`proof.recorded@1`) and their artefact bytes, read from a source store through
 * SQLite and its blob files, never through Records' writer, so a live store is never written. A record is taken when the commit it observed, or the head of the range it was
 * recorded on, is one of `commits`.
 */
const exportProofs = (source: StoreLocation, commits: ReadonlySet<string>) => {
  const read = readAsItStands(source.database, (database) => {
    const rows = database
      .prepare(
        `SELECT envelope FROM events WHERE kind = 'proof.recorded@1' ORDER BY seq`,
      )
      .all() as Array<{ envelope: string }>;
    const events = rows
      .map((row) => ProofRecorded.parse(JSON.parse(row.envelope)))
      .filter(
        (event) =>
          commits.has(event.payload.revision) ||
          commits.has(event.attribution?.range?.headOid ?? ""),
      );
    const blobs = events.map((event) => {
      const hash = event.refs[0]!.ref.slice("blob:".length);
      const row = database
        .prepare(
          `SELECT media_type AS mediaType, retention, placement, content, pruned_at AS prunedAt FROM blobs WHERE hash = ?`,
        )
        .get(hash) as
        | {
            mediaType: string;
            retention: "durable" | "raw-capture";
            placement: "inline" | "file";
            content: Uint8Array | null;
            prunedAt: string | null;
          }
        | undefined;
      if (row === undefined || row.prunedAt !== null)
        throw new Error(
          `proof ${event.id}: artefact ${hash.slice(0, 12)} is not stored`,
        );
      const bytes =
        row.placement === "inline"
          ? row.content!
          : new Uint8Array(
              readFileSync(
                join(source.blobs, "sha256", hash.slice(0, 2), hash.slice(2)),
              ),
            );
      return {
        hash,
        mediaType: row.mediaType,
        retention: row.retention,
        bytes: Buffer.from(bytes).toString("base64"),
      };
    });
    return { events, blobs };
  });
  if (read.withoutLog) console.error(readWithoutLog(source.database));
  return read.value;
};

/** Stores the bundle's artefacts, then appends its proof records (idempotent by their keys). */
const importProofs = (
  to: StoreLocation,
  bundle: ReturnType<typeof exportProofs>,
) =>
  Effect.gen(function* () {
    const events = z.array(ProofRecorded).safeParse(bundle.events);
    if (
      !events.success ||
      events.data.some(
        (event) =>
          Log.captureEventKindForKey(event.idempotencyKey) !== undefined,
      )
    )
      return yield* Effect.fail(
        new Error("proof bundle contains an unsupported event"),
      );
    const proofBlobs = z
      .array(
        z.strictObject({
          hash: z.string().regex(/^[a-f0-9]{64}$/),
          mediaType: z
            .string()
            .refine((value) =>
              Object.values(PROOF_MEDIA_TYPES).some((types) =>
                types.some((type) => type === value),
              ),
            ),
          retention: z.enum(["durable", "raw-capture"]),
          bytes: z.string(),
        }),
      )
      .safeParse(bundle.blobs);
    if (!proofBlobs.success)
      return yield* Effect.fail(
        new Error("proof bundle contains an unsupported artefact"),
      );
    yield* Store.prepareForWrite;
    const blobs = yield* Blobs.BlobStore;
    for (const blob of proofBlobs.data)
      yield* blobs.put({
        bytes: new Uint8Array(Buffer.from(blob.bytes, "base64")),
        mediaType: blob.mediaType,
        retention: blob.retention,
      });
    const appended = yield* Log.append(events.data);
    return appended.map((result) => ({ id: result.id, status: result.status }));
  }).pipe(Effect.provide(recordsLayer(to)));

const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
};

const main = async () => {
  const command = process.argv[2];
  if (command === "seed") {
    const repository = argument("--repo");
    const input = JSON.parse(
      await Bun.file(argument("--input")).text(),
    ) as SeedInput;
    const report = await Effect.runPromise(
      Effect.gen(function* () {
        const location = yield* resolveStoreLocation(repository);
        return yield* Effect.andThen(
          Store.prepareForWrite,
          seed(repository, input),
        ).pipe(Effect.provide(recordsLayer(location)));
      }),
    );
    writeFileSync(argument("--out"), `${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  if (command === "check-leads") {
    const repository = argument("--repo");
    const input = JSON.parse(
      await Bun.file(argument("--input")).text(),
    ) as Parameters<typeof checkLeads>[1];
    const report = await Effect.runPromise(
      Effect.gen(function* () {
        const location = yield* resolveStoreLocation(repository);
        return yield* Effect.andThen(
          Store.prepareForWrite,
          checkLeads(repository, input),
        ).pipe(Effect.provide(recordsLayer(location)));
      }),
    );
    writeFileSync(argument("--out"), `${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  if (command === "served") {
    const repository = argument("--repo");
    const shown = JSON.parse(
      gunzipSync(readFileSync(argument("--shown"))).toString("utf8"),
    ) as Parameters<typeof served>[1];
    const report = await Effect.runPromise(
      Effect.gen(function* () {
        const location = yield* resolveStoreLocation(repository);
        return yield* Effect.andThen(
          Store.prepareForWrite,
          served(repository, shown),
        ).pipe(Effect.provide(recordsLayer(location)));
      }),
    );
    writeFileSync(argument("--out"), `${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  if (command === "copy") {
    const report = await Effect.runPromise(
      Effect.gen(function* () {
        const from = yield* resolveStoreLocation(argument("--from"));
        const to = yield* resolveStoreLocation(argument("--to"));
        return yield* copy(from, to);
      }),
    );
    writeFileSync(argument("--out"), `${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  if (command === "export") {
    const which = argument("--ops") as keyof typeof BUNDLE_OPS;
    const ops = BUNDLE_OPS[which];
    if (ops === undefined)
      throw new Error("--ops must be understand or scope-only");
    const entries = await Effect.runPromise(
      Effect.flatMap(resolveStoreLocation(argument("--from")), (from) =>
        readShared(from, ops),
      ),
    );
    writeFileSync(argument("--out"), JSON.stringify(toBundle(ops, entries)));
    return 0;
  }
  if (command === "import") {
    const which = argument("--ops") as keyof typeof BUNDLE_OPS;
    const ops = BUNDLE_OPS[which];
    if (ops === undefined)
      throw new Error("--ops must be understand or scope-only");
    const bundle = JSON.parse(
      await Bun.file(argument("--bundle")).text(),
    ) as Bundle;
    const report = await Effect.runPromise(
      Effect.flatMap(resolveStoreLocation(argument("--to")), (to) =>
        writeShared(to, fromBundle(bundle, ops)),
      ),
    );
    writeFileSync(argument("--out"), `${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  if (command === "export-proofs") {
    const commits = new Set(
      (await Bun.file(argument("--commits")).text())
        .split("\n")
        .filter(Boolean),
    );
    // `--source-store` names a store folder (the one holding records.sqlite and blobs/) outside
    // any repository, as a copied scratch store is; `--source` names a repository.
    const storeIndex = process.argv.indexOf("--source-store");
    const bundle =
      storeIndex === -1
        ? await Effect.runPromise(
            Effect.map(resolveStoreLocation(argument("--source")), (source) =>
              exportProofs(source, commits),
            ),
          )
        : exportProofs(
            {
              directory: argument("--source-store"),
              database: join(argument("--source-store"), "records.sqlite"),
              spool: join(argument("--source-store"), "spool"),
              blobs: join(argument("--source-store"), "blobs"),
            },
            commits,
          );
    writeFileSync(argument("--out"), JSON.stringify(bundle));
    return 0;
  }
  if (command === "import-proofs") {
    const bundle = JSON.parse(
      await Bun.file(argument("--bundle")).text(),
    ) as ReturnType<typeof exportProofs>;
    const report = await Effect.runPromise(
      Effect.flatMap(resolveStoreLocation(argument("--to")), (to) =>
        importProofs(to, bundle),
      ),
    );
    writeFileSync(argument("--out"), `${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  throw new Error(
    "usage: harness-side.ts seed|copy|export|import|export-proofs|import-proofs ...",
  );
};

if (import.meta.main)
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.stack : String(error));
      process.exit(1);
    },
  );
