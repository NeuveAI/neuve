import type { OutlineSource } from "./graph-outline.ts";
import { repositoryOwner } from "./budget/owner.ts";
import { cpuWork } from "./budget/cpu.ts";
import { METRICS } from "./telemetry.ts";
import { createHash } from "node:crypto";
import { Effect, Metric } from "effect";
import { z } from "zod";
import { gitWithInput } from "./git.ts";
import { splitLines, WINDOW_RECIPE, fallbackLimitation } from "./chunker.ts";
import {
  groupsBySize,
  readBlobs,
  type DiffFile,
  type TreeEntry,
} from "./git-objects.ts";
import {
  blobChunks,
  blobText,
  entryExclusion,
  type BlobChunks,
} from "./search-index.ts";

/**
 * Hunks with their enclosing symbols and their queries (proposal §5.2), for one commit at
 * `commit.prepare` and for a range at the review request: the same code, so a commit's hunk and the
 * range's hunk carry the same text and query when they are the same change (PC13's reuse rule).
 */

/** The benchmark's Q1 recipe: path, enclosing symbol, the hunk with its three context lines. */
export const QUERY_RECIPE = "q1-path-symbol-hunk-v1";
const MAX_BODY_BYTES = 24 * 1024;

export const HunkQuery = z.strictObject({
  recipe: z.literal(QUERY_RECIPE),
  /** The post-image, or the pre-image for a hunk that only deletes. */
  side: z.enum(["post", "pre"]),
  path: z.string(),
  startLine: z.int().min(1),
  endLine: z.int().min(1),
  symbols: z.array(z.string()),
  droppedLines: z.int().min(0),
  text: z.string().min(1),
  sha256: z.string(),
});
export type HunkQuery = z.infer<typeof HunkQuery>;

export const Enclosing = z.strictObject({
  side: z.enum(["post", "pre"]),
  /** Symbol names, or a section's heading, of the chunks the hunk's lines fall in. */
  symbols: z.array(z.string()),
  headingPath: z.array(z.string()),
  capability: z.string(),
  language: z.string(),
  /** Set when the chunker read the file with no symbol or section capability (line windows). */
  limitation: z.string().nullable(),
});
export type Enclosing = z.infer<typeof Enclosing>;

export const HunkRecord = z.strictObject({
  hunkId: z.string(),
  /** Content identity across ranges; absent in older stored manifests. */
  contentKey: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  /** `text` for a diff hunk; `binary` or `metadata` for a file change with no text hunk. */
  kind: z.enum(["text", "binary", "metadata"]),
  path: z.string(),
  oldPath: z.string().nullable(),
  newPath: z.string().nullable(),
  oldOid: z.string().nullable(),
  newOid: z.string().nullable(),
  status: z.enum(["added", "deleted", "modified", "renamed", "type-changed"]),
  oldMode: z.string().nullable(),
  newMode: z.string().nullable(),
  oldStart: z.int().min(0),
  oldLines: z.int().min(0),
  newStart: z.int().min(0),
  newLines: z.int().min(0),
  added: z.int().min(0),
  deleted: z.int().min(0),
  /** The `@@` line and body as git printed them. */
  text: z.string().min(1),
  textSha256: z.string(),
  enclosing: Enclosing.nullable(),
  query: HunkQuery.nullable(),
});
export type HunkRecord = z.infer<typeof HunkRecord>;

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/** Git's three context lines, excluding only the coordinate header. */
export const hunkContentKey = (hunk: {
  readonly path: string;
  readonly text: string;
  readonly kind?: "text" | "binary" | "metadata";
  readonly oldOid?: string | null;
  readonly newOid?: string | null;
  readonly oldMode?: string | null;
  readonly newMode?: string | null;
}) =>
  sha256(
    JSON.stringify([
      hunk.path,
      hunk.text.replace(/^@@[^\n]*(?:\n|$)/, ""),
      ...(hunk.kind === "binary" || hunk.kind === "metadata"
        ? [
            hunk.oldOid ?? null,
            hunk.newOid ?? null,
            hunk.oldMode ?? null,
            hunk.newMode ?? null,
          ]
        : []),
    ]),
  );

const hunkIdOf = (file: DiffFile, text: string) =>
  `h${sha256(`${file.oldPath ?? ""}\0${file.newPath ?? ""}\0${text}`).slice(0, 15)}`;

/** The enclosing symbols or section of lines [start, end] of a blob's chunks. */
const enclosingOf = (
  chunks: BlobChunks | undefined,
  side: "post" | "pre",
  start: number,
  end: number,
): Enclosing | null => {
  if (chunks === undefined || chunks.excluded !== null) return null;
  const overlapping = chunks.chunks.filter(
    (chunk) => chunk.startLine <= end && chunk.endLine >= start,
  );
  const symbols = [
    ...new Set(
      overlapping.flatMap((chunk) =>
        chunk.symbol === null ? [] : chunk.symbol.split(","),
      ),
    ),
  ].filter((symbol) => symbol !== "");
  const headingPath =
    overlapping.find((chunk) => chunk.headingPath.length > 0)?.headingPath ??
    [];
  return {
    side,
    symbols,
    headingPath: [...headingPath],
    capability: chunks.capability,
    language: chunks.language,
    limitation:
      chunks.capability === WINDOW_RECIPE
        ? fallbackLimitation(chunks.fallback)
        : null,
  };
};

/** Q1 for one hunk from its side's blob text. */
const queryOf = (
  path: string,
  side: "post" | "pre",
  content: string,
  start: number,
  count: number,
  chunks: BlobChunks | undefined,
): HunkQuery | null => {
  const lines = splitLines(content);
  if (lines.length === 0) return null;
  const startLine = Math.max(1, start);
  const endLine = Math.min(lines.length, start + Math.max(1, count) - 1);
  const kept: Array<string> = [];
  let bytes = 0;
  for (const line of lines.slice(startLine - 1, endLine)) {
    bytes += Buffer.byteLength(line);
    if (bytes > MAX_BODY_BYTES && kept.length > 0) break;
    kept.push(line);
  }
  if (kept.length === 0) return null;
  const lastLine = startLine + kept.length - 1;
  const symbols = enclosingOf(chunks, side, startLine, lastLine)?.symbols ?? [];
  const body = kept.join("").replace(/\n$/, "");
  const text = [
    `path: ${path}`,
    ...(symbols.length > 0 ? [`symbol: ${symbols.join(", ")}`] : []),
    "",
    body,
  ].join("\n");
  return {
    recipe: QUERY_RECIPE,
    side,
    path,
    startLine,
    endLine,
    symbols,
    droppedLines: endLine - startLine + 1 - kept.length,
    text,
    sha256: sha256(text),
  };
};

/** Every changed hunk before blob reads, symbol lookup or query construction. */
export const rawHunks = (
  files: ReadonlyArray<DiffFile>,
): ReadonlyArray<HunkRecord> => {
  const records: HunkRecord[] = [];
  for (const file of files) {
    const path = file.newPath ?? file.oldPath ?? "";
    const base = {
      path,
      oldPath: file.oldPath,
      newPath: file.newPath,
      oldOid: file.oldOid,
      newOid: file.newOid,
      status: file.status,
      oldMode: file.oldMode,
      newMode: file.newMode,
    };
    if (file.hunks.length === 0) {
      const kind = file.binary ? ("binary" as const) : ("metadata" as const);
      const text = file.binary
        ? `Binary file ${file.oldPath ?? "/dev/null"} -> ${file.newPath ?? "/dev/null"} differs`
        : `${file.status}: ${file.oldPath ?? "/dev/null"} (${file.oldMode ?? "-"}) -> ${file.newPath ?? "/dev/null"} (${file.newMode ?? "-"})`;
      records.push({
        ...base,
        hunkId: hunkIdOf(file, text),
        contentKey: hunkContentKey({ ...base, kind, text }),
        kind,
        oldStart: 0,
        oldLines: 0,
        newStart: 0,
        newLines: 0,
        added: 0,
        deleted: 0,
        text,
        textSha256: sha256(text),
        enclosing: null,
        query: null,
      });
      continue;
    }

    for (const hunk of file.hunks)
      records.push({
        ...base,
        hunkId: hunkIdOf(file, hunk.text),
        contentKey: hunkContentKey({ path, text: hunk.text }),
        kind: "text",
        oldStart: hunk.oldStart,
        oldLines: hunk.oldLines,
        newStart: hunk.newStart,
        newLines: hunk.newLines,
        added: hunk.added,
        deleted: hunk.deleted,
        text: hunk.text,
        textSha256: sha256(hunk.text),
        enclosing: null,
        query: null,
      });
  }
  return records;
};

/**
 * Each blob's size in bytes from one `cat-file --batch-check`, through the run's git read session
 * when it has one; an object that is not a blob has none. No call for no object IDs.
 */
export const blobSizes = (repository: string, oids: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sizes = new Map<string, number>();
    if (oids.length === 0) return sizes;
    const input = oids.join("\n") + "\n";
    const metadata = yield* gitWithInput(
      repository,
      ["cat-file", "--batch-check"],
      input,
    );
    for (const row of metadata.trim().split("\n")) {
      const [oid, type, size] = row.split(" ");
      if (oid !== undefined && type === "blob") sizes.set(oid, Number(size));
    }
    return sizes;
  });

/**
 * Every hunk of a diff with its enclosing symbols and Q1 query. Each side's blob is chunked through
 * the per-blob computations, so the symbols come from the same chunks the index holds.
 */
export const describeHunks = (
  repository: string,
  files: ReadonlyArray<DiffFile>,
  source: OutlineSource,
) =>
  Effect.gen(function* () {
    const oids = [
      ...new Set(
        files.flatMap((file) =>
          file.binary
            ? []
            : [file.oldOid, file.newOid].filter((oid) => oid !== null),
        ),
      ),
    ];
    const sizes = yield* blobSizes(repository, oids);
    const entries: Array<TreeEntry> = [];
    const records: HunkRecord[] = [];
    const fileOf: number[] = [];
    const elapsed = files.map(() => 0);
    for (const [fileIndex, file] of files.entries()) {
      const started = performance.now();
      const raw = yield* cpuWork(
        repositoryOwner(repository),
        Effect.sync(() => rawHunks([file])),
      );
      records.push(...raw);
      fileOf.push(...raw.map(() => fileIndex));
      elapsed[fileIndex] = performance.now() - started;
    }
    const hunksBySide = new Map<string, number[]>();
    for (const [index, hunk] of records.entries()) {
      if (hunk.kind !== "text") continue;
      const side = hunk.added === 0 ? "pre" : "post";
      const path = side === "post" ? hunk.newPath : hunk.oldPath;
      const oid = side === "post" ? hunk.newOid : hunk.oldOid;
      if (path === null || oid === null) continue;
      const key = `${path}\0${oid}`;
      const indices = hunksBySide.get(key) ?? [];
      indices.push(index);
      hunksBySide.set(key, indices);
    }
    for (const file of files) {
      if (file.binary) continue;
      for (const [path, oid, mode] of [
        [file.oldPath, file.oldOid, file.oldMode],
        [file.newPath, file.newOid, file.newMode],
      ] as const) {
        if (path === null || oid === null) continue;
        const entry: TreeEntry = {
          mode: mode ?? "100644",
          type: mode === "160000" ? "commit" : "blob",
          oid,
          size: sizes.get(oid) ?? null,
          path,
        };
        // Excluded entries still need text for the original query recipe.
        entries.push(entry);
      }
    }
    const chunkableSides = new Set(
      entries
        .filter((entry) => entryExclusion(entry) === undefined)
        .map((entry) => `${entry.path}\0${entry.oid}`),
    );
    // Only hunk records outlive a group. Bodies and decoded source stay in this group.
    for (const group of groupsBySize(entries)) {
      const contents = yield* readBlobs(
        repository,
        group.map((entry) => entry.oid),
      );
      const { chunks } = yield* blobChunks(
        repository,
        group.filter((entry) => entryExclusion(entry) === undefined),
        source,
        contents,
      ).pipe(Effect.withSpan("harness.precompute.chunks"));
      yield* cpuWork(
        repositoryOwner(repository),
        Effect.sync(() => {
          for (const entry of group) {
            const key = `${entry.path}\0${entry.oid}`;
            // A symlink and a regular file can share a key across groups. Use its chunkable entry.
            if (chunkableSides.has(key) && entryExclusion(entry) !== undefined)
              continue;
            const bytes = contents.get(entry.oid);
            const sideChunks = chunks.get(key);
            for (const index of hunksBySide.get(key) ?? []) {
              const started = performance.now();
              const hunk = records[index];
              if (hunk === undefined || hunk.kind !== "text") continue;
              const side = hunk.added === 0 ? "pre" : "post";
              const start = side === "post" ? hunk.newStart : hunk.oldStart;
              const count = side === "post" ? hunk.newLines : hunk.oldLines;
              const content = bytes === undefined ? undefined : blobText(bytes);
              const firstChanged = changedSpan(hunk.text, side, start);
              records[index] = {
                ...hunk,
                enclosing: enclosingOf(
                  sideChunks,
                  side,
                  firstChanged.start,
                  firstChanged.end,
                ),
                query:
                  content === undefined
                    ? null
                    : queryOf(
                        entry.path,
                        side,
                        content,
                        start,
                        count,
                        sideChunks,
                      ),
              };
              const fileIndex = fileOf[index];
              if (fileIndex !== undefined)
                elapsed[fileIndex] =
                  (elapsed[fileIndex] ?? 0) + performance.now() - started;
            }
            hunksBySide.delete(key);
          }
        }),
      );
    }
    for (const duration of elapsed)
      yield* Metric.update(
        Metric.withAttributes(METRICS.precomputeItem, {
          "harness.phase": "hunks.file",
          "harness.source": "computed",
        }),
        duration / 1000,
      );
    return records as ReadonlyArray<HunkRecord>;
  });

/** The first and last changed line of a hunk on one side. */
const changedSpan = (text: string, side: "post" | "pre", start: number) => {
  let line = start;
  let first: number | undefined;
  let last = start;
  const mark = side === "post" ? "+" : "-";
  const skip = side === "post" ? "-" : "+";
  for (const row of text.split("\n").slice(1)) {
    if (row.startsWith("\\") || row === "") continue;
    if (row.startsWith(skip)) {
      first ??= line;
      last = Math.max(last, line);
      continue;
    }
    if (row.startsWith(mark)) {
      first ??= line;
      last = line;
    }
    line++;
  }
  return { start: first ?? start, end: Math.max(first ?? start, last) };
};
