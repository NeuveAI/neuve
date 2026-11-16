import { safeRead } from "@neuve/records-schema";
import { readFile, stat } from "node:fs/promises";
import { deserialize } from "node:v8";
import { z } from "zod";
import { DeclaredKind, Suggestion } from "./declarations.ts";

export const IndexSnapshot = z.strictObject({
  tree: z.string(),
  chunks: z.array(
    z.strictObject({
      chunkId: z.string(),
      path: z.string(),
      blobOid: z.string(),
      kind: z.enum(["symbol", "section", "window"]),
      symbol: z.string().nullable(),
      headingPath: z.array(z.string()),
      startLine: z.number(),
      endLine: z.number(),
      capability: z.string(),
      language: z.string(),
      fallback: z.string().nullable().optional(),
      declared: z.union([z.array(DeclaredKind), z.literal("undeclared")]),
      callables: z.array(z.string()),
      parsedIdentifiers: z.array(z.string()).nullable(),
      tokens: z.number(),
      textSha256: z.string(),
      previous: z.string().nullable(),
      next: z.string().nullable(),
    }),
  ),
  byId: z.map(z.string(), z.number()),
  byPath: z.map(z.string(), z.array(z.number())),
  lengths: z.instanceof(Uint32Array),
  averageLength: z.number(),
  postings: z.map(
    z.string(),
    z.strictObject({
      docs: z.instanceof(Uint32Array),
      tfs: z.instanceof(Uint32Array),
    }),
  ),
  identifierFrequency: z.map(z.string(), z.number()),
  specificThreshold: z.number(),
  declarations: z.strictObject({
    byPath: z.map(z.string(), z.array(Suggestion)),
    readers: z.array(z.string()),
    gaps: z.array(z.string()),
    // `testStatusOf` reads both: a copy without them would read an undecided path, or one the
    // declarations were not read for, as not-test. Stored as v8 keeps them, a Map and a Set (as
    // `partial`). Required: every build keyed by `neuve-declarations-v4` writes both.
    undecided: z.map(z.string(), z.string()),
    asked: z.set(z.string()),
  }),
  partial: z.set(z.string()),
  excluded: z.record(z.string(), z.number()),
  files: z.number(),
  blobsComputed: z.number(),
  blobsReused: z.number(),
  chunksComputed: z.number(),
  chunksReused: z.number(),
  buildMs: z.number(),
});

/** Cleanup can remove only snapshots whose complete format this build understands. */
export const knownIndexSnapshot = async (path: string) => {
  try {
    if ((await stat(path)).size > 128 * 2 ** 20) return false;
    const parsed = safeRead(IndexSnapshot, deserialize(await readFile(path)), {
      source: path,
    });
    return parsed.success && parsed.droppedKeys.length === 0;
  } catch {
    return false;
  }
};
