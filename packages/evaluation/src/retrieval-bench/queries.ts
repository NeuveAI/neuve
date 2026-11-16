import { defaultGraphVariant } from "./graph-chunk.ts";
import { createHash } from "node:crypto";
import { Effect } from "effect";
import { z } from "zod";
import { chunkFile } from "../../../harness/src/chunker.ts";
import type { Case, Hunk } from "./corpus.ts";
import { gitText } from "./git.ts";
import type { CorpusKey } from "./policy.ts";
import { SPLIT_NAMES } from "./split.ts";
import type { BenchChunkVariant } from "./graph-chunk.ts";

/**
 * Q1, the hunk-derived query (proposal, section 6): the path, the enclosing symbol and the post-image
 * hunk with its three context lines; a hunk that only deletes uses its pre-image. Every arm receives
 * exactly this text, so the query is held fixed across arms.
 */

export const QUERY_RECIPE = "q1-path-symbol-hunk-v1";
/**
 * The body keeps whole lines up to this many bytes, so every arm reads the same text within its
 * input window (8,192 model tokens). Only the stress case's whole-file deletions reach it.
 */
export const MAX_BODY_BYTES = 24 * 1024;

export const HunkQuery = z.strictObject({
  caseId: z.string(),
  hunkId: z.string(),
  repository: z.enum(["neuve_effect", "neuve"]),
  base: z.string(),
  head: z.string(),
  path: z.string(),
  /** The side the body comes from, and the 1-based inclusive line span on that side. */
  side: z.enum(["post", "pre"]),
  startLine: z.int().positive(),
  endLine: z.int().positive(),
  /** Symbols (or Markdown section titles) of the shared chunker overlapping the kept lines. */
  symbols: z.array(z.string()),
  /** Lines of the span dropped by the body cap. */
  droppedLines: z.int().nonnegative(),
  text: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type HunkQuery = z.infer<typeof HunkQuery>;

export const QueryFile = z.strictObject({
  schemaVersion: z.literal(1),
  recipe: z.literal(QUERY_RECIPE),
  split: z.enum(SPLIT_NAMES),
  queries: z.array(HunkQuery),
});

const splitLines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** Builds Q1 for one hunk from the exact base (pre-image) or head (post-image) blob. */
export const buildQuery = (
  repository: string,
  entry: Case,
  hunk: Hunk,
  variant?: BenchChunkVariant,
) =>
  Effect.gen(function* () {
    const side = hunk.added === 0 ? "pre" : "post";
    const path = side === "post" ? hunk.path : hunk.oldPath;
    const commit = side === "post" ? entry.head : entry.base;
    const span = side === "post" ? hunk.new : hunk.old;
    const content = yield* gitText(repository, [
      "cat-file",
      "blob",
      `${commit}:${path}`,
    ]);
    const lines = splitLines(content);
    const startLine = Math.max(1, span.start);
    const endLine = Math.min(
      lines.length,
      span.start + Math.max(1, span.lines) - 1,
    );
    const kept: Array<string> = [];
    let bytes = 0;
    for (const line of lines.slice(startLine - 1, endLine)) {
      bytes += Buffer.byteLength(line);
      if (bytes > MAX_BODY_BYTES && kept.length > 0) break;
      kept.push(line);
    }
    const lastLine = startLine + kept.length - 1;
    const selected = variant ?? (yield* Effect.tryPromise(defaultGraphVariant));
    const graphChunks = yield* Effect.tryPromise((signal) =>
      selected.chunk(
        [{ path, bytes: new TextEncoder().encode(content) }],
        signal,
      ),
    );
    const symbols = [
      ...new Set(
        (
          graphChunks?.get(path) ??
          chunkFile(path, content, { kind: "unavailable" })
        ).chunks
          .filter(
            (chunk) =>
              chunk.symbol !== undefined &&
              chunk.startLine <= lastLine &&
              chunk.endLine >= startLine,
          )
          .flatMap((chunk) => (chunk.symbol ?? "").split(",")),
      ),
    ].filter((symbol) => symbol !== "");
    const body = kept.join("").replace(/\n$/, "");
    const text = [
      `path: ${path}`,
      ...(symbols.length > 0 ? [`symbol: ${symbols.join(", ")}`] : []),
      "",
      body,
    ].join("\n");
    return {
      caseId: entry.id,
      hunkId: hunk.id,
      repository: entry.repository as CorpusKey,
      base: entry.base,
      head: entry.head,
      path,
      side,
      startLine,
      endLine,
      symbols,
      droppedLines: endLine - startLine + 1 - kept.length,
      text,
      sha256: createHash("sha256").update(text).digest("hex"),
    } satisfies HunkQuery;
  });
