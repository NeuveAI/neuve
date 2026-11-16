import { Blobs } from "@neuve/records-core";
import { Effect } from "effect";
import type { Manifest } from "./manifest.ts";
import {
  DOC,
  byCodepoint,
  classifyDoc,
  isTestFile,
  type CorpusKey,
} from "./policy.ts";
import { ViewFailed, baseView } from "./views.ts";
import type { BenchChunkVariant } from "./graph-chunk.ts";

/**
 * What B2's chunk-based arms (L, dense, fusion, rerank) search: every chunk occurrence in a case
 * base's exact view (index basis B), from B1's blob-addressed chunk cache.
 */

export type Case = Manifest["cases"][number];
export type Hunk = Case["hunks"][number];

/** Source kinds (proposal, section 3) as separate indexes for the per-kind topologies (3.8). */
export const KINDS = ["code", "test", "doc", "plan"] as const;
export type SourceKind = (typeof KINDS)[number];

/** Path rules only: Markdown scope documents are plans, other Markdown is docs, tests by name. */
export const kindOf = (path: string): SourceKind =>
  DOC.test(path)
    ? classifyDoc(path) === "scope"
      ? "plan"
      : "doc"
    : isTestFile(path)
      ? "test"
      : "code";

export interface Occurrence {
  /** `path#Lstart-Lend`: unique in a base, and the tie-break order for every ranking. */
  readonly chunkId: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  /** SHA-256 of the chunk text; the text is a blob in the benchmark store. */
  readonly hash: string;
  readonly kind: SourceKind;
  /** The B1 chunk computation of the file's blob, and this chunk's position in it. */
  readonly chunkKey: string;
  readonly position: number;
}

export interface BaseCorpus {
  readonly repository: CorpusKey;
  readonly commit: string;
  readonly viewKey: string;
  /** Occurrences in chunk-id order. */
  readonly occurrences: ReadonlyArray<Occurrence>;
  /** Files as (chunk computation, path) pairs: the unit of encoding and token counting. */
  readonly files: ReadonlyArray<{
    readonly chunkKey: string;
    readonly path: string;
    readonly hashes: ReadonlyArray<string>;
  }>;
}

export const chunkId = (path: string, start: number, end: number) =>
  `${path}#L${start}-L${end}`;

export const loadBase = (
  repository: CorpusKey,
  path: string,
  commit: string,
  variant?: BenchChunkVariant,
) =>
  Effect.gen(function* () {
    const result = yield* baseView(repository, path, commit, variant);
    const occurrences: Array<Occurrence> = [];
    const files: Array<BaseCorpus["files"][number]> = [];
    for (const file of result.view.files) {
      const chunked = result.chunks.get(file.chunkKey);
      if (chunked === undefined || chunked.chunks.length === 0) continue;
      const kind = kindOf(file.path);
      files.push({
        chunkKey: file.chunkKey,
        path: file.path,
        hashes: chunked.chunks.map((chunk) => chunk.hash),
      });
      chunked.chunks.forEach((chunk, position) =>
        occurrences.push({
          chunkId: chunkId(file.path, chunk.startLine, chunk.endLine),
          path: file.path,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          hash: chunk.hash,
          kind,
          chunkKey: file.chunkKey,
          position,
        }),
      );
    }
    occurrences.sort((a, b) => byCodepoint(a.chunkId, b.chunkId));
    return {
      repository,
      commit,
      viewKey: result.viewKey,
      occurrences,
      files,
    } satisfies BaseCorpus;
  });

const decoder = new TextDecoder();

/** Chunk text by hash, from the benchmark store. */
export const chunkText = (hash: string) =>
  Effect.gen(function* () {
    const read = yield* (yield* Blobs.BlobStore).get(hash);
    if (read._tag === "Pruned")
      return yield* new ViewFailed({ message: `chunk ${hash} pruned` });
    return decoder.decode(read.bytes);
  });

/** One base per repository and commit of the given cases, loaded in a fixed order. */
export const loadBases = (
  cases: ReadonlyArray<Case>,
  repositories: Record<CorpusKey, string>,
  variant?: BenchChunkVariant,
) =>
  Effect.gen(function* () {
    const unique = [
      ...new Map(
        cases.map((entry) => [`${entry.repository}:${entry.base}`, entry]),
      ).values(),
    ].sort(
      (a, b) =>
        byCodepoint(a.repository, b.repository) || byCodepoint(a.base, b.base),
    );
    const bases: Array<BaseCorpus> = [];
    for (const entry of unique)
      bases.push(
        yield* loadBase(
          entry.repository,
          repositories[entry.repository],
          entry.base,
          variant,
        ),
      );
    return bases;
  });
