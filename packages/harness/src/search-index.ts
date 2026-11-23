import { graphRefusesSourcePath } from "@neuve/graph-client";
import { SharedWork, KeyHeld } from "@neuve/records-core/shared-work";
import { sharedWorkEffect } from "@neuve/records-core/shared-work-effect";
import { canonicalStoreIdentity } from "@neuve/records-core/shared-work-socket";
import {
  readOutlinesWithBudget,
  assertOutlineSource,
  GRAPH_SOURCE_BINDING,
  GRAPH_REQUEST_BINDING,
  type OutlineBatch,
  type OutlineSource,
} from "./graph-outline.ts";
import { repositoryOwner } from "./budget/owner.ts";
import { IndexSnapshot, knownIndexSnapshot } from "./index-snapshot.ts";
import { safeRead } from "@neuve/records-schema";
import { readData } from "@neuve/records-core";
import { CpuWork, cpuBatch, cpuConcurrency, cpuWork } from "./budget/cpu.ts";
import { timePrecomputeItem } from "./telemetry.ts";
import { deserialize, serialize } from "node:v8";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  readdir,
  stat,
  rm,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { CodeWork, codeCheckpoint, codeOwnerAlive } from "./code-work.ts";
import { withStoreLock } from "./stack/store.ts";
import { createHash } from "node:crypto";
import { Cause, Effect, Exit, Option } from "effect";
import { z } from "zod";
import {
  sharedPublication,
  PublicationPolicy,
  PublicationTooLarge,
  PublicationCapacity,
  PublicationHostGone,
  heldPublication,
  isHeldPublication,
  publicationIdentity,
  inlinePublicationFailure,
  createPublicationFailure,
} from "./shared-publication.ts";
import { step } from "./telemetry.ts";
import { Blobs, Computations } from "@neuve/records-core";
import { estimateTokens } from "./budget.ts";
import {
  CHUNK_RECIPE,
  capabilityFor,
  declaresCodePositions,
  chunkFile,
  graphFallback,
  retryableFallback,
  splitLines,
  type Chunk,
  type GraphChunkContext,
} from "./chunker.ts";
import {
  DECLARATIONS_RECIPE,
  DeclaredKind,
  kindsOf,
  readDeclarations,
  type Declarations,
} from "./declarations.ts";
import {
  groupsBySize,
  lsTree,
  readBlobs,
  type TreeEntry,
} from "./git-objects.ts";
import {
  REFUSED_PATH,
  blobStructureSpec,
  encodeBlobStructure,
  structureRetryable,
  type StructureContext,
} from "./sections.ts";

/**
 * Precompute's search index (10.25, proposal §4 and §5.2): BM25 over the product chunker's chunks,
 * with the benchmark's parameters (k1 1.2, b 0.75, path plus body, identifier parts), and the
 * identifier index of 10.46. Everything is read from git objects at the tree's revision (10.34).
 *
 * The cache is per blob: each blob's chunks, symbols and code-position identifiers are one
 * computation keyed by its OID and the chunker recipe, so a commit prepares only its changed blobs
 * and every tree that shares a blob reuses it (PC13, PC15). A tree's index is assembled from those
 * computations and the blobs' text, and kept in memory for the trees in use; nothing per tree is
 * stored, so a burst of commits never stores a copy of the repository per commit.
 *
 * The product index keeps only safety bounds (proposal §5.2): non-blobs and submodule links,
 * symlinks, binary content and files over 1 MiB are left out, each counted by reason. Generated,
 * test and documentation files are indexed like any other; their declared kinds are metadata.
 */

export const BM25 = {
  k1: 1.2,
  b: 0.75,
  recipe: "bm25-path-body-identifier-parts-v1",
} as const;

/** The safety bounds, part of every chunk key. */
export const INDEX_BOUNDS = {
  id: "neuve-index-bounds-v1",
  maxFileBytes: 1_048_576,
} as const;

export const ExclusionReason = z.enum([
  "submodule",
  "not-a-blob",
  "symlink",
  "over-size",
  "binary",
]);
export type ExclusionReason = z.infer<typeof ExclusionReason>;

/** Lowercase alphanumeric runs plus the parts of camelCase and snake_case identifiers. */
export const terms = (text: string): Array<string> => {
  const out: Array<string> = [];
  for (const word of text.match(/[A-Za-z0-9_]+/g) ?? []) {
    const lower = word.toLowerCase();
    out.push(lower);
    const parts = word
      .split("_")
      .flatMap((piece) =>
        piece.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/),
      )
      .map((part) => part.toLowerCase())
      .filter((part) => part !== "");
    if (parts.length > 1) for (const part of parts) out.push(part);
  }
  return out;
};

/** Word-like tokens, where no parser gives code positions (10.46): letters first, three or more. */
export const wordTokens = (text: string) =>
  new Set(text.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []);

const StoredChunk = z.strictObject({
  kind: z.enum(["symbol", "section", "window"]),
  symbol: z.string().nullable(),
  headingPath: z.array(z.string()),
  startLine: z.int().min(1),
  endLine: z.int().min(1),
  textSha256: z.string(),
  identifiers: z.array(z.string()),
  callables: z.array(z.string()),
});

export const BlobChunks = z.strictObject({
  capability: z.string(),
  language: z.string(),
  fallback: z.string().nullable(),
  excluded: ExclusionReason.nullable(),
  chunks: z.array(StoredChunk),
});
export type BlobChunks = z.infer<typeof BlobChunks>;

const chunkSpec = (
  blob: string,
  path: string,
  source: OutlineSource,
): Computations.ComputationSpec => ({
  op: "harness.blob-chunks",
  opVersion: 1,
  inputs: { blob: `git-blob:${blob}` },
  config: {
    recipe: CHUNK_RECIPE,
    source: source.key,
    sourceBinding: GRAPH_SOURCE_BINDING,
    bounds: INDEX_BOUNDS,
    path,
  },
});

const strict = new TextDecoder("utf-8", { fatal: true });

/** Text of a blob, or undefined when it is binary (a NUL in its first 8,000 bytes, or not UTF-8). */
export const blobText = (
  bytes: Uint8Array,
  onFailure?: (cause: string) => void,
) => {
  if (bytes.subarray(0, 8_000).includes(0)) {
    onFailure?.("The first 8,000 bytes contain a NUL byte.");
    return undefined;
  }
  try {
    return strict.decode(bytes);
  } catch (error) {
    onFailure?.(String(error));
    return undefined;
  }
};

/**
 * Whether a blob is over the index's size bound. Its byte length is the one authority: a tree
 * entry's size is git's byte length, used before the content is read when known.
 */
export const overSize = (bytes: Uint8Array) =>
  bytes.byteLength > INDEX_BOUNDS.maxFileBytes;

/** Why a tree entry is left out before its content is read, or undefined. */
export const entryExclusion = (
  entry: TreeEntry,
): ExclusionReason | undefined => {
  if (entry.type === "commit") return "submodule";
  if (entry.type !== "blob") return "not-a-blob";
  if (entry.mode === "120000") return "symlink";
  if ((entry.size ?? 0) > INDEX_BOUNDS.maxFileBytes) return "over-size";
  return undefined;
};

/**
 * The chunker's fallback for a blob's context. A path Graph refuses is never sent to it: its
 * fallback is `outline-unavailable`, stable (Markdown needs no Graph and has none).
 */
const fallbackOf = (path: string, graph: StructureContext) =>
  graph.kind === "refused"
    ? capabilityFor(path).capability === "markdown-sections"
      ? undefined
      : "outline-unavailable"
    : graphFallback(path, graph);

const computeChunks = (
  path: string,
  text: string | undefined,
  context: StructureContext,
): BlobChunks => {
  // A refused path is chunked as a file with no outline: line windows, `outline-unavailable`.
  const graph: GraphChunkContext =
    context.kind === "refused" ? { kind: "unavailable" } : context;
  if (text === undefined) {
    const { capability, language } = capabilityFor(path);
    return {
      capability,
      language,
      fallback: null,
      excluded: "binary",
      chunks: [],
    };
  }
  const chunked = chunkFile(path, text, graph);
  return {
    capability: chunked.capability,
    language: chunked.language,
    fallback:
      context.kind === "refused"
        ? (fallbackOf(path, context) ?? null)
        : (chunked.fallback ?? null),
    excluded: null,
    chunks: chunked.chunks.map((chunk: Chunk) => ({
      kind: chunk.kind,
      symbol: chunk.symbol ?? null,
      headingPath: [...chunk.headingPath],
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      textSha256: chunk.textSha256,
      identifiers: [...chunk.identifiers],
      callables: [...chunk.callables],
    })),
  };
};

export const decodeJson = <T>(bytes: Uint8Array, schema: z.ZodType<T>) =>
  readData(schema, JSON.parse(new TextDecoder().decode(bytes)));

/** A stored computation's JSON output, or none when it was never computed (or its bytes are gone). */
export const storedOutput = <T>(
  spec: Computations.ComputationSpec,
  schema: z.ZodType<T>,
) =>
  Effect.map(
    storedOutputs([spec], schema),
    (values) => values[0] ?? Option.none<T>(),
  );

/**
 * Each immutable key's stored output bytes and their hash, read once for a batch, preserving the
 * caller's order and duplicate keys; undefined where never computed (or its bytes are gone).
 * An output of a recomputable kind evicted between the row read and the blob read is a miss too;
 * a missing or corrupt blob of any other kind fails the batch as before.
 */
export const storedBytes = (
  specs: ReadonlyArray<Computations.ComputationSpec>,
) =>
  Effect.gen(function* () {
    const store = yield* Computations.ComputationStore;
    const blobs = yield* Blobs.BlobStore;
    const keys = specs.map((spec) => Computations.computationKey(spec).key);
    const held = yield* store.lookupMany(keys);
    const reads = yield* blobs
      .getMany([...held.values()].map((row) => row.outputHash))
      .pipe(
        Effect.catchTags({
          BlobMissing: (error) => readEach(held, error),
          BlobCorrupt: (error) => readEach(held, error),
        }),
      );
    return keys.map((key) => {
      const computation = held.get(key);
      if (computation === undefined) return undefined;
      const read = reads.get(computation.outputHash);
      if (read === undefined || read._tag === "Pruned") return undefined;
      return { hash: computation.outputHash, bytes: read.bytes };
    });
  });

/**
 * The batch read again one output at a time, after `getMany` failed with `failure`: an output whose
 * computation was evicted meanwhile is left out (a miss); any other failure is the batch's own.
 */
const readEach = (
  held: ReadonlyMap<string, Computations.Computation>,
  failure: Blobs.BlobMissing | Blobs.BlobCorrupt,
) =>
  Effect.gen(function* () {
    const store = yield* Computations.ComputationStore;
    const blobs = yield* Blobs.BlobStore;
    const reads = new Map<string, Blobs.BlobRead>();
    for (const computation of held.values()) {
      if (reads.has(computation.outputHash)) continue;
      const read = yield* Effect.result(blobs.get(computation.outputHash));
      if (read._tag === "Success") {
        reads.set(computation.outputHash, read.success);
        continue;
      }
      const error = read.failure;
      if (error._tag !== "BlobMissing" && error._tag !== "BlobCorrupt")
        return yield* Effect.fail(error);
      if (!(yield* store.evictedMeanwhile(computation)))
        return yield* Effect.fail(failure);
    }
    return reads as ReadonlyMap<string, Blobs.BlobRead>;
  });

/** Decodes stored outputs, each distinct output once. */
export const decodeStored = <T>(
  stored: ReadonlyArray<{ hash: string; bytes: Uint8Array } | undefined>,
  schema: z.ZodType<T>,
) => {
  const decoded = new Map<string, Option.Option<T>>();
  return stored.map((read) => {
    if (read === undefined) return Option.none<T>();
    const cached = decoded.get(read.hash);
    if (cached !== undefined) return cached;
    const value = Option.some(decodeJson(read.bytes, schema));
    decoded.set(read.hash, value);
    return value;
  });
};

/** Reads each immutable key once for a batch, preserving the caller's order and duplicate keys. */
export const storedOutputs = <T>(
  specs: ReadonlyArray<Computations.ComputationSpec>,
  schema: z.ZodType<T>,
) => Effect.map(storedBytes(specs), (stored) => decodeStored(stored, schema));

/**
 * Graph refuses a batch that names one path twice, or a path and a path under it, so the old and
 * new side of a modified file, or a file and the folder that replaced it, never share an outline
 * read. Each file goes, in input order, to the first batch holding neither its path, nor an
 * ancestor of it, nor a path under it: without such a pair, the first occurrence of each path, then
 * the second, and so on. A batch has no file cap: callers bound it by size group. The path Graph is given is never
 * changed.
 */
export const uniquePathBatches = <T>(
  files: ReadonlyArray<T>,
  pathOf: (file: T) => string,
): ReadonlyArray<ReadonlyArray<T>> => {
  const rounds: Array<{
    files: Array<T>;
    paths: Set<string>;
    ancestors: Set<string>;
  }> = [];
  for (const file of files) {
    const path = pathOf(file);
    const parts = path.split("/");
    const above = parts
      .slice(1)
      .map((_, length) => parts.slice(0, length + 1).join("/"));
    let round = rounds.find(
      (held) =>
        !held.paths.has(path) &&
        !held.ancestors.has(path) &&
        !above.some((ancestor) => held.paths.has(ancestor)),
    );
    if (round === undefined)
      rounds.push(
        (round = { files: [], paths: new Set(), ancestors: new Set() }),
      );
    round.files.push(file);
    round.paths.add(path);
    for (const ancestor of above) round.ancestors.add(ancestor);
  }
  return rounds.map(({ files: round }) => round);
};

/** Runs a JSON computation over the store and decodes its output. */
export const jsonComputation = <T, E, R>(
  spec: Computations.ComputationSpec,
  schema: z.ZodType<T>,
  compute: Effect.Effect<T, E, R>,
) =>
  Effect.gen(function* () {
    const store = yield* Computations.ComputationStore;
    const result = yield* store.run(
      spec,
      Effect.map(compute, (value) => ({
        bytes: new TextEncoder().encode(JSON.stringify(value)),
        mediaType: "application/json",
      })),
    );
    return {
      value: decodeJson(result.output, schema),
      status: result.status,
      key: result.computation.key,
    };
  });

/**
 * Size groups `blobChunks` works on at once. Each group holds up to 16 MiB of source and its
 * outline observations (one measured about 294 MB on this repository), so at most two are held.
 */
const OVERLAPPED_GROUPS = 2;

/**
 * The chunks of each blob, computed once per blob OID (and the capability its path declares) and
 * read back from the store afterwards. Bytes already read can be passed in `contents` (by blob OID);
 * the rest are read here, only for blobs not yet stored. Yields between blobs, so a large tree never
 * holds the worker's event loop.
 *
 * The same pass stores each computed blob's structure (`harness.blob-structure@1`, `sections.ts`)
 * from the same Graph outline, in the same CPU job, so a blob costs one Graph read for both.
 */
export const blobChunks = (
  repository: string,
  entries: ReadonlyArray<TreeEntry>,
  source: OutlineSource,
  contents: ReadonlyMap<string, Uint8Array> = new Map(),
) =>
  Effect.gen(function* () {
    yield* Effect.try(() => assertOutlineSource(source));
    const store = yield* Computations.ComputationStore;
    const out = new Map<string, BlobChunks>();
    const missing: Array<{
      entry: TreeEntry;
      spec: Computations.ComputationSpec;
    }> = [];
    const encode = (value: unknown) => ({
      bytes: new TextEncoder().encode(JSON.stringify(value)),
      mediaType: "application/json",
    });
    const compute = yield* cpuBatch(
      repositoryOwner(repository),
      ({
        path,
        content,
        graph,
        structure,
      }: {
        path: string;
        content: Uint8Array;
        graph: StructureContext;
        structure: boolean;
      }) => {
        const text = blobText(content);
        return {
          chunks: encode(computeChunks(path, text, graph)),
          structure: structure
            ? encodeBlobStructure(path, text, graph)
            : undefined,
        };
      },
    );
    // Only where another run computed the chunks and this run owns the structure's key.
    const computeStructure = yield* cpuBatch(
      repositoryOwner(repository),
      ({
        path,
        content,
        graph,
      }: {
        path: string;
        content: Uint8Array;
        graph: StructureContext;
      }) => encodeBlobStructure(path, blobText(content), graph),
    );
    let computed = 0;
    let reused = 0;
    let chunksComputed = 0;
    let chunksReused = 0;
    let structuresStored = 0;
    let structuresRetryable = 0;
    for (let offset = 0; offset < entries.length; offset += 500) {
      yield* codeCheckpoint;
      const keyed = entries.slice(offset, offset + 500).map((entry) => {
        return { entry, spec: chunkSpec(entry.oid, entry.path, source) };
      });
      const cached = yield* timePrecomputeItem(
        "chunks.lookup",
        storedOutputs(
          keyed.map(({ spec }) => spec),
          BlobChunks,
        ),
        (values) => (values.every(Option.isSome) ? "cached" : "missing"),
      );
      for (const [index, { entry, spec }] of keyed.entries()) {
        yield* codeCheckpoint;
        const stored = cached[index] ?? Option.none<BlobChunks>();
        if (
          Option.isSome(stored) &&
          !retryableFallback(stored.value.fallback)
        ) {
          out.set(`${entry.path}\0${entry.oid}`, stored.value);
          reused++;
          chunksReused += stored.value.chunks.length;
        } else missing.push({ entry, spec });
      }
    }
    type Missing = (typeof missing)[number];
    // One size group: its blobs, its outline reads, then its chunk computations. Its chunks are
    // returned, not written to `out`, so they are joined in group order whatever order groups end.
    const groupChunks = (group: ReadonlyArray<Missing>) =>
      Effect.gen(function* () {
        const found = new Map<string, BlobChunks>();
        const read = yield* readBlobs(
          repository,
          group
            .filter(({ entry }) => !contents.has(entry.oid))
            .map(({ entry }) => entry.oid),
        );
        const files = group.flatMap((item) => {
          const bytes =
            contents.get(item.entry.oid) ?? read.get(item.entry.oid);
          return bytes && blobText(bytes) !== undefined
            ? [{ item, path: item.entry.path, bytes }]
            : [];
        });
        // Both sides of a modified file share a path: each outline read holds a path at most once. A
        // path Graph refuses is kept out of every read, so it no longer fails its whole batch.
        const contexts = new Map<(typeof group)[number], GraphChunkContext>();
        let first: OutlineBatch | undefined;
        for (const batch of uniquePathBatches(
          files.filter((file) => !graphRefusesSourcePath(file.path)),
          (file) => file.path,
        )) {
          const outlines = yield* readOutlinesWithBudget(
            batch.map(({ path, bytes }) => ({ path, bytes })),
            repositoryOwner(repository),
            source,
          );
          first ??= outlines;
          for (const file of batch)
            contexts.set(file.item, outlines.context(file.path));
        }
        // A blob not sent to Graph sees the first read's answer for its path, as with one read; a
        // refused path has its own stable context.
        const contextOf = (item: (typeof group)[number]): StructureContext =>
          graphRefusesSourcePath(item.entry.path)
            ? REFUSED_PATH
            : (contexts.get(item) ??
              first?.context(item.entry.path) ?? { kind: "unavailable" });
        // Claims join outside CPU admission; only owned callbacks enter a bounded batch.
        for (let offset = 0; offset < group.length; offset += 128) {
          yield* codeCheckpoint;
          yield* Effect.forEach(
            group.slice(offset, offset + 128),
            (item) =>
              Effect.gen(function* () {
                const { entry, spec } = item;
                const content = contents.get(entry.oid) ?? read.get(entry.oid);
                if (content === undefined) return;
                const graph = contextOf(item);
                const fallback = fallbackOf(entry.path, graph);
                const failed =
                  fallback !== undefined && retryableFallback(fallback);
                // A symlink, submodule or over-size blob has no structure of its own to store.
                const structure =
                  entryExclusion(entry) === undefined && !overSize(content);
                const owned: {
                  structure?: ReturnType<typeof encodeBlobStructure>;
                } = {};
                const result = yield* timePrecomputeItem(
                  "chunks.compute",
                  store.run(
                    // Failed observations are retryable; never poison the successful blob key.
                    failed
                      ? {
                          ...spec,
                          config: {
                            source: source.key,
                            sourceBinding: GRAPH_SOURCE_BINDING,
                            path: entry.path,
                            recipe: CHUNK_RECIPE,
                            fallback,
                          },
                        }
                      : spec,
                    Effect.map(
                      compute({ path: entry.path, content, graph, structure }),
                      (value) => {
                        if (value.structure !== undefined)
                          owned.structure = value.structure;
                        return value.chunks;
                      },
                    ),
                  ),
                  (value) => value.status,
                );
                const decoded = decodeJson(result.output, BlobChunks);
                if (result.status === "computed") {
                  computed++;
                  chunksComputed += decoded.chunks.length;
                } else {
                  reused++;
                  chunksReused += decoded.chunks.length;
                }
                found.set(`${entry.path}\0${entry.oid}`, decoded);
                if (!structure) return;
                const built = owned.structure;
                // A retryable structure is keyed by its reason and never takes the stable key. Where
                // another run computed the chunks, their stored output says whether the blob is
                // binary, and this run computes the structure only if it owns the key.
                const retryable =
                  built === undefined
                    ? structureRetryable(
                        entry.path,
                        decoded.excluded === "binary",
                        graph,
                      )
                    : built.retryable;
                const stored = yield* timePrecomputeItem(
                  "structure.store",
                  store.run(
                    blobStructureSpec(entry.oid, entry.path, source, retryable),
                    built === undefined
                      ? Effect.map(
                          computeStructure({
                            path: entry.path,
                            content,
                            graph,
                          }),
                          (value) => value.output,
                        )
                      : Effect.succeed(built.output),
                  ),
                  (value) => value.status,
                );
                if (stored.status === "computed") {
                  if (retryable === undefined) structuresStored++;
                  else structuresRetryable++;
                }
              }),
            { concurrency: 128, discard: true },
          );
        }
        return found;
      });
    // Groups overlap, at most `OVERLAPPED_GROUPS` at once, so one group's blob and outline reads run
    // while another's chunks are computed. Under the budget's own pool each outline read is its own
    // shared-work key and takes its CPU permits from the machine's pool, and each chunk batch its
    // `cpuBatch` grant: the overlap adds no CPU of its own. Under an inherited grant of P permits
    // nothing is acquired, so the grant is shared instead: `overlapped`, as many groups as P allows
    // and at most `OVERLAPPED_GROUPS`, run at once. A group takes its share when its first outline
    // read asks for permits and keeps it for its other reads: P divided by `overlapped`, or by the
    // groups not yet finished, counting itself, if fewer, rounded down. So a lone group, and a last
    // group that starts its reads once every other group has finished, run Graph on the whole grant,
    // and two groups running together each get half. A group counts as finished only once it has
    // returned; one that fails or is interrupted keeps counting. An outline read is one shared run
    // per key (record 0016) and keeps running after its group is interrupted while another caller
    // waits on the key, so it can ask for permits after its group, or the whole build, has ended.
    // Counting such groups keeps those late reads within P: two interrupted groups take P / 2 each,
    // and a lone interrupted group takes P with nothing else holding any. Lowering the count when a
    // group fails would open a window before the other group is interrupted in which that group's
    // next read took P beside the failed group's late read. A group that returned has no read left
    // running, so the count is at least 1 whenever a read asks. A group holds its share only during
    // its outline reads (Graph's batch processes) and, only after they return, one permit for its
    // chunks, which run inline on this thread; its blob reads come first and hold none. The groups
    // together never hold more than P: a group took the whole grant only when it was the one group
    // not finished, and no group starts after the last; otherwise at most two groups run, each
    // holding at most P / 2 or one permit, and a one-permit grant runs them one at a time. A failure
    // or interruption in one group interrupts the others, so the build fails or is interrupted as a
    // whole and none of its own work is left running, only a shared read that another caller waits
    // on. The per-item times (`chunks.compute`, `structure.store`) stay one item's wall time, which
    // can now include waiting for CPU behind the other group, as it already could behind its own
    // batch; nothing sums them per group, and `harness.index.chunk` stays the pass's wall time.
    const configured = yield* Effect.serviceOption(CpuWork);
    const overlapped = yield* cpuConcurrency(OVERLAPPED_GROUPS);
    const grant =
      Option.isSome(configured) && configured.value.inherited
        ? configured.value
        : undefined;
    const groups = groupsBySize(
      missing.map((item) => ({ ...item, size: item.entry.size })),
    );
    let unfinished = groups.length;
    const found = yield* Effect.forEach(
      groups,
      (group) => {
        if (grant === undefined) return groupChunks(group);
        let permits: number | undefined;
        const share: CpuWork["Service"] = {
          ...grant,
          // Read by the group's outline reads (`cpuPool`); fixed by the first of them. The guard
          // only keeps the divisor above 0: `unfinished` drops on success alone, so it is at least
          // 1 while any read can still ask.
          get permits() {
            return (permits ??= Math.floor(
              (grant.permits ?? 1) /
                Math.min(overlapped, Math.max(1, unfinished)),
            ));
          },
        };
        return groupChunks(group).pipe(
          Effect.provideService(CpuWork, share),
          Effect.tap(() =>
            Effect.sync(() => {
              unfinished--;
            }),
          ),
        );
      },
      { concurrency: overlapped },
    );
    for (const chunks of found)
      for (const [key, value] of chunks) out.set(key, value);
    yield* Effect.annotateCurrentSpan({
      "harness.chunks.structures_stored": structuresStored,
      "harness.chunks.structures_retryable": structuresRetryable,
    });
    yield* Effect.try(() => assertOutlineSource(source));
    return {
      chunks: out as ReadonlyMap<string, BlobChunks>,
      computed,
      reused,
      chunksComputed,
      chunksReused,
      /** Structures this pass wrote under their stable key, and under a retryable one. */
      structuresStored,
      structuresRetryable,
    };
  });

/** One chunk of a tree's index. */
export interface IndexedChunk {
  readonly chunkId: string;
  readonly path: string;
  readonly blobOid: string;
  readonly kind: "symbol" | "section" | "window";
  readonly symbol: string | null;
  readonly headingPath: ReadonlyArray<string>;
  readonly startLine: number;
  readonly endLine: number;
  readonly capability: string;
  readonly language: string;
  readonly fallback?: string | null | undefined;
  readonly declared: ReadonlyArray<DeclaredKind> | "undeclared";
  readonly callables: ReadonlyArray<string>;
  /** Code-position identifiers where a parser read the file; null where only words were taken. */
  readonly parsedIdentifiers: ReadonlyArray<string> | null;
  readonly tokens: number;
  /** SHA-256 of the chunk's text: with its path, the unit a dense retriever's vector is keyed by. */
  readonly textSha256: string;
  readonly previous: string | null;
  readonly next: string | null;
}

export interface TreeIndex {
  readonly source: OutlineSource;
  readonly tree: string;
  readonly chunks: ReadonlyArray<IndexedChunk>;
  readonly byId: ReadonlyMap<string, number>;
  readonly byPath: ReadonlyMap<string, ReadonlyArray<number>>;
  readonly lengths: Uint32Array;
  readonly averageLength: number;
  readonly postings: ReadonlyMap<
    string,
    { docs: Uint32Array; tfs: Uint32Array }
  >;
  /** Chunk frequency of each identifier, for specificity (10.46). */
  readonly identifierFrequency: ReadonlyMap<string, number>;
  /** An identifier is specific when it appears in at most this many chunks: √N, between 3 and 200. */
  readonly specificThreshold: number;
  readonly declarations: Declarations;
  /**
   * Paths with a line that is not blank but in no chunk: a line over the chunk size, which the
   * line windows leave out. Their text is not all in the postings.
   */
  readonly partial: ReadonlySet<string>;
  readonly excluded: Readonly<Record<string, number>>;
  readonly files: number;
  readonly blobsComputed: number;
  readonly blobsReused: number;
  /** Chunks of the blobs chunked for this build, and of the blobs whose chunks were stored. */
  readonly chunksComputed: number;
  readonly chunksReused: number;
  readonly buildMs: number;
}

const snapshotOf = ({ source: _source, ...snapshot }: TreeIndex) => snapshot;

/**
 * The snapshot as the index is published: no array in it is reached from two chunks. The build gives
 * one `declared` array to every chunk of a file, and two entries handed the same stored chunking
 * share its chunks' `headingPath`, `callables` and identifiers; `serialize` would write such an
 * array once and point back to it, while the parse gives each chunk its own copy. With no array
 * reached twice the publication takes the value as it is (`fitsExactly`), and its bytes are those
 * of the parse. Only an array met before is copied, and only its chunk with it; the index itself is
 * not changed.
 */
const publishedSnapshotOf = (index: TreeIndex) => {
  const snapshot = snapshotOf(index);
  const met = new Set<ReadonlyArray<unknown>>();
  const own = <A extends ReadonlyArray<unknown> | null | "undeclared">(
    list: A,
  ): A => {
    if (!Array.isArray(list)) return list;
    if (!met.has(list)) {
      met.add(list);
      return list;
    }
    return [...list] as unknown as A;
  };
  return {
    ...snapshot,
    chunks: snapshot.chunks.map((chunk) => {
      const headingPath = own(chunk.headingPath),
        declared = own(chunk.declared),
        callables = own(chunk.callables),
        parsedIdentifiers = own(chunk.parsedIdentifiers);
      return headingPath === chunk.headingPath &&
        declared === chunk.declared &&
        callables === chunk.callables &&
        parsedIdentifiers === chunk.parsedIdentifiers
        ? chunk
        : { ...chunk, headingPath, declared, callables, parsedIdentifiers };
    }),
  };
};

export const chunkIdOf = (blob: string, startLine: number, endLine: number) =>
  createHash("sha256")
    .update(`${CHUNK_RECIPE}\0${blob}\0${startLine}\0${endLine}`)
    .digest("hex")
    .slice(0, 20);

/** The identifiers a chunk's text offers, by code position where parsed, else word-like tokens. */
export const chunkIdentifiers = (chunk: IndexedChunk, text: string) =>
  chunk.parsedIdentifiers !== null
    ? new Set(chunk.parsedIdentifiers)
    : wordTokens(text);

/** Up to 8 specific identifiers of a chunk, rarest first (10.46). */
export const specificIdentifiers = (
  index: TreeIndex,
  identifiers: Iterable<string>,
) =>
  [...new Set(identifiers)]
    .map((name) => ({ name, df: index.identifierFrequency.get(name) ?? 1 }))
    .filter((entry) => entry.df <= index.specificThreshold)
    .sort(
      (a, b) => a.df - b.df || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    )
    .slice(0, 8)
    .map((entry) => entry.name);

/** The index version, part of every lead key. */
export const indexRecipe = (source: OutlineSource) => ({
  chunker: {
    recipe: CHUNK_RECIPE,
    source: source.key,
    sourceBinding: GRAPH_REQUEST_BINDING,
  },
  bounds: INDEX_BOUNDS,
  bm25: BM25,
  declarations: DECLARATIONS_RECIPE,
  identifiers: "neuve-identifiers-sqrt-3-200-8-v1",
});

/**
 * An index is degraded when a chunk's Graph fallback is retryable. `partial` is not a reason: it is
 * filled from the blobs' content and their chunks, and an index with no retryable chunk has every
 * chunk under its blob's stable key, so a rebuild of the same tree and recipe gives the same set.
 */
const retryableIndex = (index: TreeIndex) =>
  index.chunks.some((chunk) => retryableFallback(chunk.fallback));

/**
 * This process's indexes, degraded or not, for the last few trees in use. A degraded index stays
 * here so one review builds each tree once; it never reaches the snapshot file or a reusable
 * publication, and `forgetDegradedIndexes` drops it when the next review starts.
 */
const cache = new Map<string, TreeIndex>();
const CACHED_TREES = 2;

/**
 * Keeps a healthy index read from this tree's snapshot file or publication, as a built one is kept,
 * so after a release (`releaseIndexCache`) the calls that follow share the copy the first one read
 * instead of each decoding its own. A degraded index read never enters: only a build caches one.
 */
const keepRead = (cacheKey: string, index: TreeIndex) => {
  if (retryableIndex(index)) return;
  cache.delete(cacheKey);
  cache.set(cacheKey, index);
  while (cache.size > CACHED_TREES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
};

/**
 * Drops every degraded index from this process's cache, so the next call for its tree rebuilds and
 * asks Graph again for the blobs whose fallback was retryable. Healthy indexes stay. Each review's
 * Precompute calls it first, so each review retries once instead of on every call.
 *
 * It only empties part of this process's result cache: no shared work, publication, snapshot or
 * key is touched, and a build already running is joined as before. It is synchronous and cannot
 * throw: it walks a map of indexes this module built and reads each chunk's `fallback` string.
 *
 * Two reviews in one process may overlap: the second's start drops a degraded index the first still
 * uses, and the first's next call retries Graph once more. Precompute may also run more than once
 * for one review in the same process (a replayed phase), which costs one more Graph retry. Both are
 * accepted.
 */
export const forgetDegradedIndexes = (): void => {
  for (const [key, index] of cache)
    if (retryableIndex(index)) cache.delete(key);
};

/**
 * Drops every index this process's cache holds, healthy and degraded, so the next call for a tree
 * reads its snapshot or publication, or builds it again. The review task calls it when the last
 * review running in this process ends (`pi/review-task.ts`), so a worker holds no tree index
 * between reviews.
 *
 * What stays: an index a caller already holds lives until that caller lets go; a build already
 * running is joined as before, gives its callers its result and caches it when it ends; no shared
 * work, publication, snapshot or key is touched. The cache is emptied in one step, so no caller
 * meets a half-dropped entry. It is synchronous and cannot throw.
 */
export const releaseIndexCache = (): void => {
  cache.clear();
};

/**
 * The index of one tree, built from the per-blob computations and the blobs' text, and kept in
 * memory for the last few trees in use. `onBuilt` sees the build's counts for telemetry.
 */
const buildTreeIndex = (
  repository: string,
  tree: string,
  source: OutlineSource,
) =>
  Effect.gen(function* () {
    yield* Effect.try(() => assertOutlineSource(source));
    const cacheKey = `${tree}:${JSON.stringify(indexRecipe(source))}`;
    const held = cache.get(cacheKey);
    if (held !== undefined) {
      cache.delete(cacheKey);
      cache.set(cacheKey, held);
      return { index: held, cached: true };
    }
    const started = Date.now();
    // The build's steps are spans under `harness.index.tree` (10.97).
    const entries = yield* step("harness.index.list", lsTree(repository, tree));
    const excluded: Record<string, number> = {};
    const indexed: Array<TreeEntry> = [];
    for (const entry of entries) {
      const reason = entryExclusion(entry);
      if (reason === undefined) indexed.push(entry);
      else excluded[reason] = (excluded[reason] ?? 0) + 1;
    }
    const {
      chunks: perBlob,
      computed,
      reused,
      chunksComputed,
      chunksReused,
    } = yield* step(
      "harness.index.chunk",
      blobChunks(repository, indexed, source),
    );
    const declarations = yield* step(
      "harness.index.declarations",
      readDeclarations({
        repository,
        revision: tree,
        tree: entries,
        paths: indexed.map((entry) => entry.path),
      }),
    );
    // Filled while the postings are built: one pass over each file's lines.
    const partial = new Set<string>();
    const { chunks, byPath, lengths, identifierFrequency, postings, total } =
      yield* step(
        "harness.index.postings",
        cpuWork(
          repositoryOwner(repository),
          Effect.gen(function* () {
            const chunks: Array<IndexedChunk> = [];
            const byPath = new Map<string, Array<number>>();
            const lists = new Map<
              string,
              { docs: Array<number>; tfs: Array<number> }
            >();
            const lengths: Array<number> = [];
            const identifierFrequency = new Map<string, number>();
            for (const group of groupsBySize(indexed)) {
              yield* codeCheckpoint;
              const bytes = yield* readBlobs(
                repository,
                group.map((entry) => entry.oid),
              );
              for (const entry of group) {
                const stored = perBlob.get(`${entry.path}\0${entry.oid}`);
                const content = bytes.get(entry.oid);
                if (stored === undefined || content === undefined) continue;
                if (stored.excluded !== null) {
                  excluded[stored.excluded] =
                    (excluded[stored.excluded] ?? 0) + 1;
                  continue;
                }
                const lines = splitLines(new TextDecoder().decode(content));
                const declared = kindsOf(declarations, entry.path);
                const positions: Array<number> = [];
                stored.chunks.forEach((chunk, order) => {
                  const doc = chunks.length;
                  const text = lines
                    .slice(chunk.startLine - 1, chunk.endLine)
                    .join("");
                  const id = chunkIdOf(
                    entry.oid,
                    chunk.startLine,
                    chunk.endLine,
                  );
                  const parsed = declaresCodePositions(stored.capability);
                  chunks.push({
                    chunkId: id,
                    path: entry.path,
                    blobOid: entry.oid,
                    kind: chunk.kind,
                    symbol: chunk.symbol,
                    headingPath: chunk.headingPath,
                    startLine: chunk.startLine,
                    endLine: chunk.endLine,
                    capability: stored.capability,
                    language: stored.language,
                    fallback: stored.fallback,
                    declared,
                    callables: chunk.callables,
                    parsedIdentifiers: parsed ? chunk.identifiers : null,
                    tokens: estimateTokens(Buffer.byteLength(text)),
                    textSha256: chunk.textSha256,
                    previous:
                      order === 0
                        ? null
                        : chunkIdOf(
                            entry.oid,
                            stored.chunks[order - 1]?.startLine ?? 0,
                            stored.chunks[order - 1]?.endLine ?? 0,
                          ),
                    next:
                      order === stored.chunks.length - 1
                        ? null
                        : chunkIdOf(
                            entry.oid,
                            stored.chunks[order + 1]?.startLine ?? 0,
                            stored.chunks[order + 1]?.endLine ?? 0,
                          ),
                  });
                  positions.push(doc);
                  const counts = new Map<string, number>();
                  const list = terms(`${entry.path}\n${text}`);
                  lengths.push(list.length);
                  for (const term of list)
                    counts.set(term, (counts.get(term) ?? 0) + 1);
                  for (const [term, tf] of counts) {
                    let posting = lists.get(term);
                    if (posting === undefined)
                      lists.set(term, (posting = { docs: [], tfs: [] }));
                    posting.docs.push(doc);
                    posting.tfs.push(tf);
                  }
                  for (const name of parsed
                    ? chunk.identifiers
                    : wordTokens(text))
                    identifierFrequency.set(
                      name,
                      (identifierFrequency.get(name) ?? 0) + 1,
                    );
                });
                byPath.set(entry.path, positions);
                const covered = new Uint8Array(lines.length + 1);
                for (const chunk of stored.chunks)
                  covered.fill(1, chunk.startLine, chunk.endLine + 1);
                if (
                  lines.some(
                    (line, at) => covered[at + 1] === 0 && line.trim() !== "",
                  )
                )
                  partial.add(entry.path);
              }
              yield* Effect.yieldNow;
            }
            const postings = new Map<
              string,
              { docs: Uint32Array; tfs: Uint32Array }
            >();
            for (const [term, posting] of lists)
              postings.set(term, {
                docs: Uint32Array.from(posting.docs),
                tfs: Uint32Array.from(posting.tfs),
              });
            const total = lengths.reduce((sum, length) => sum + length, 0);
            return {
              chunks,
              byPath,
              lengths,
              identifierFrequency,
              postings,
              total,
            };
          }),
        ),
      );
    const index: TreeIndex = {
      source,
      tree,
      chunks,
      byId: new Map(chunks.map((chunk, doc) => [chunk.chunkId, doc])),
      byPath,
      lengths: Uint32Array.from(lengths),
      averageLength: chunks.length === 0 ? 0 : total / chunks.length,
      postings,
      identifierFrequency,
      specificThreshold: Math.min(
        200,
        Math.max(3, Math.floor(Math.sqrt(chunks.length))),
      ),
      declarations,
      partial,
      excluded,
      files: entries.length,
      blobsComputed: computed,
      blobsReused: reused,
      chunksComputed,
      chunksReused,
      buildMs: Date.now() - started,
    };
    yield* Effect.annotateCurrentSpan({
      "harness.index.chunks": chunks.length,
      "harness.index.blobs_computed": computed,
      "harness.index.blobs_reused": reused,
      "harness.index.chunks_computed": chunksComputed,
      "harness.index.chunks_reused": chunksReused,
    });
    yield* Effect.try(() => assertOutlineSource(source));
    cache.set(cacheKey, index);
    while (cache.size > CACHED_TREES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    return { index, cached: false };
  }).pipe(
    Effect.withSpan("harness.index.tree", {
      attributes: { "harness.tree": tree },
    }),
  );

/** Scores every chunk for the query's distinct terms; best first, ties by position. */
export const bm25Ranking = (index: TreeIndex, query: string) => {
  const scores = new Float64Array(index.chunks.length);
  for (const term of [...new Set(terms(query))].sort()) {
    const posting = index.postings.get(term);
    if (posting === undefined) continue;
    const df = posting.docs.length;
    const idf = Math.log(1 + (index.chunks.length - df + 0.5) / (df + 0.5));
    for (let at = 0; at < df; at++) {
      const doc = posting.docs[at] ?? 0;
      const tf = posting.tfs[at] ?? 0;
      const norm =
        1 - BM25.b + (BM25.b * (index.lengths[doc] ?? 0)) / index.averageLength;
      scores[doc] =
        (scores[doc] ?? 0) + (idf * tf * (BM25.k1 + 1)) / (tf + BM25.k1 * norm);
    }
  }
  const ranked: Array<{ doc: number; score: number }> = [];
  scores.forEach((score, doc) => {
    if (score > 0) ranked.push({ doc, score });
  });
  return ranked.sort((a, b) => b.score - a.score || a.doc - b.doc);
};

const readCompletedSnapshot = async (
  filename: string,
  tree: string,
  source: OutlineSource,
) => {
  let leaveSnapshot = false;
  try {
    const info = await stat(filename);
    leaveSnapshot = true;
    if (info.size > 128 * 2 ** 20) return { leaveSnapshot };
    const bytes = await readFile(filename);
    if (bytes.length > 128 * 2 ** 20) return { leaveSnapshot };
    const parsed = safeRead(IndexSnapshot, deserialize(bytes), {
      source: filename,
    });
    leaveSnapshot = !parsed.success || parsed.droppedKeys.length > 0;
    return {
      leaveSnapshot,
      index:
        parsed.success && parsed.data.tree === tree
          ? { ...parsed.data, source }
          : undefined,
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code !== "ENOENT")
      throw error;
    return { leaveSnapshot };
  }
};

const materializeTreeIndex = (
  repository: string,
  tree: string,
  source: OutlineSource,
): Effect.Effect<
  { index: TreeIndex; cached: boolean },
  unknown,
  Computations.ComputationStore | Blobs.BlobStore
> =>
  Effect.gen(function* () {
    const recipe = indexRecipe(source);
    const cacheKey = `${tree}:${JSON.stringify(recipe)}`;
    yield* Effect.try(() => assertOutlineSource(source));
    const work = yield* CodeWork;
    if (!work) return yield* buildTreeIndex(repository, tree, source);
    yield* codeCheckpoint;
    const root = join(work.directory, "code-work", "indexes");
    const key = createHash("sha256")
      .update(JSON.stringify({ version: 1, tree, recipe }))
      .digest("hex");
    const filename = join(root, `${key}.index`);
    const result = yield* Effect.gen(function* () {
      const { leaveSnapshot } = yield* Effect.promise(() =>
        readCompletedSnapshot(filename, tree, source),
      );
      yield* Effect.try(() => assertOutlineSource(source));
      const built = yield* buildTreeIndex(repository, tree, source);
      if (leaveSnapshot) return built;
      yield* Effect.uninterruptible(
        Effect.promise(async () => {
          if (retryableIndex(built.index)) return;
          const bytes = serialize(snapshotOf(built.index));
          if (bytes.length > 128 * 2 ** 20) return;
          await mkdir(root, { recursive: true, mode: 0o700 });
          const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
          try {
            await writeFile(temporary, bytes, { mode: 0o600 });
            assertOutlineSource(source);
            await rename(temporary, filename);
          } finally {
            await rm(temporary, { force: true });
          }
          await withStoreLock(join(root, "eviction"), async () => {
            const names = await readdir(root);
            for (const name of names) {
              const temporary =
                /^[a-f0-9]{64}\.([1-9]\d*)\.[0-9a-f-]{36}\.tmp$/.exec(name);
              if (temporary !== null && !codeOwnerAlive(Number(temporary[1])))
                await rm(join(root, name), { force: true });
            }
            const entries = await Promise.all(
              names
                .filter((name) => name.endsWith(".index"))
                .map(async (name) => ({
                  name,
                  time: (await stat(join(root, name))).mtimeMs,
                })),
            );
            entries.sort((a, b) => b.time - a.time);
            for (const entry of entries.slice(2))
              if (await knownIndexSnapshot(join(root, entry.name)))
                await rm(join(root, entry.name), { force: true });
          });
        }),
      );
      return built;
    });
    yield* Effect.try(() => assertOutlineSource(source));
    cache.set(cacheKey, result.index);
    while (cache.size > CACHED_TREES) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
    return result;
  });

const TreePublication = z.strictObject({
  publication: z.uuid(),
  outcome: z.strictObject({
    kind: z.literal("succeeded"),
    value: IndexSnapshot,
  }),
});
type TreeResult = { index: TreeIndex; cached: boolean };
class TreeAttemptFailed extends Computations.SharedAttemptFailed {
  constructor(
    data: ConstructorParameters<typeof Computations.SharedAttemptFailed>[0],
    readonly original: Cause.Cause<unknown>,
  ) {
    super(data);
  }
}
type TreeFailure = KeyHeld | Computations.SharedAttemptFailed;
const treeBuilds = new SharedWork<TreeResult, TreeFailure>();

/**
 * The index a builder made but could not publish, by the failure it recorded for subscribers (the
 * graph lane's shape for outlines, `graph-outline.ts` at 4dfea775). Subscribers in this process
 * await the same run and receive that failure object; they share the index with the builder
 * instead, since no publication stands between them. Other processes read the recorded failure.
 */
const unpublished = new WeakMap<Computations.SharedAttemptFailed, TreeResult>();

/** Every materialization and post-grant warm publication uses the same captured source. */
export const treeIndex = (
  repository: string,
  tree: string,
  source: OutlineSource,
) =>
  Effect.gen(function* () {
    const work = yield* CodeWork;
    const scope = yield* Effect.promise(async () => {
      try {
        return await canonicalStoreIdentity(repository);
      } catch (error) {
        if (work !== undefined && !existsSync(repository))
          return resolve(repository);
        throw error;
      }
    });
    const key = `tree-index@1\0${tree}\0${JSON.stringify(indexRecipe(source))}`;
    const cacheKey = `${tree}:${JSON.stringify(indexRecipe(source))}`;
    const policy = yield* PublicationPolicy;
    const copies = sharedPublication({
      namespace: "shared-indexes-v4",
      scope,
      key,
      group: `${scope}\0${tree}`,
      schema: TreePublication,
      reusable: (stored) =>
        !retryableIndex({ ...stored.outcome.value, source }),
      ...policy,
    });
    let floor = false;
    const read = async (publication?: string) => {
      const failure = inlinePublicationFailure(publication, key);
      if (failure && publication !== undefined)
        return {
          publication,
          outcome: { kind: "failed" as const, error: failure },
        };
      if (publication !== undefined && isHeldPublication(publication))
        return {
          publication,
          outcome: { kind: "failed" as const, error: new KeyHeld(scope, key) },
        };
      try {
        const stored = await copies.read(publication);
        if (stored === undefined) return undefined;
        const index = { ...stored.outcome.value, source };
        keepRead(cacheKey, index);
        return {
          publication: stored.publication,
          outcome: {
            kind: "succeeded" as const,
            value: { index, cached: true },
          },
        };
      } catch (error) {
        if (
          !(error instanceof PublicationHostGone) ||
          publication === undefined
        )
          throw error;
        const recorded = createPublicationFailure(
          error.attemptId,
          "PublicationHostGone",
          key,
        );
        return {
          publication,
          outcome: { kind: "failed" as const, error: recorded.failure },
        };
      }
    };
    const publish = async (value: TreeResult, _signal: AbortSignal) => {
      const id = randomUUID();
      try {
        const stored = await copies.publish({
          publication: id,
          outcome: {
            kind: "succeeded",
            value: publishedSnapshotOf(value.index),
          },
        });
        const same = publicationIdentity(stored.publication)?.attemptId === id;
        return {
          publication: stored.publication,
          outcome: {
            kind: "succeeded" as const,
            value: same
              ? value
              : { index: { ...stored.outcome.value, source }, cached: true },
          },
        };
      } catch (error) {
        const tag =
          error instanceof PublicationTooLarge
            ? "PublicationTooLarge"
            : error instanceof PublicationCapacity
              ? "PublicationCapacity"
              : "PublicationFailed";
        const recorded = createPublicationFailure(
          id,
          tag,
          key,
          error instanceof Error ? error.message : String(error),
        );
        const failure = new TreeAttemptFailed(
          recorded.failure,
          Cause.fail(recorded.failure),
        );
        // Subscribers receive the recorded failure; the builder keeps its index.
        unpublished.set(failure, value);
        console.warn(
          JSON.stringify({
            type: "tree-index.publication-failed",
            tag,
            bytes: error instanceof PublicationTooLarge ? error.bytes : null,
            maximum: policy.maximumBytes,
            message: "the builder keeps its index; subscribers get the failure",
          }),
        );
        return {
          publication: recorded.publication,
          outcome: { kind: "failed" as const, error: failure },
        };
      }
    };
    const local = async () => {
      assertOutlineSource(source);
      const held = cache.get(cacheKey);
      if (held) return { value: { index: held, cached: true } };
      if (work) {
        const hash = createHash("sha256")
          .update(
            JSON.stringify({ version: 1, tree, recipe: indexRecipe(source) }),
          )
          .digest("hex");
        const saved = await readCompletedSnapshot(
          join(work.directory, "code-work", "indexes", `${hash}.index`),
          tree,
          source,
        );
        assertOutlineSource(source);
        if (saved.index && !retryableIndex(saved.index)) {
          keepRead(cacheKey, saved.index);
          return { value: { index: saved.index, cached: true } };
        }
      }
      return undefined;
    };
    const result = yield* sharedWorkEffect(treeBuilds, {
      scope,
      key,
      onEvent: (event) => {
        if (event.role === "floor") floor = true;
      },
      crossProcess: {
        store: scope,
        transport: copies.transport,
        read,
        acceptDeliveryFailure: true,
        local: { read: local, publish },
      },
      run: (signal) =>
        Effect.gen(function* () {
          const id = randomUUID();
          const exit = yield* Effect.exit(
            materializeTreeIndex(repository, tree, source).pipe(
              Effect.provideService(
                CodeWork,
                work === undefined ? undefined : { ...work, background: false },
              ),
            ),
          );
          if (Exit.isSuccess(exit)) {
            if (floor)
              return {
                publication: id,
                outcome: { kind: "succeeded" as const, value: exit.value },
              };
            return yield* Effect.promise(() => publish(exit.value, signal));
          }
          const cause = Cause.findErrorOption(exit.cause);
          if (Option.isSome(cause) && cause.value instanceof KeyHeld)
            return {
              publication: heldPublication(id),
              outcome: { kind: "failed" as const, error: cause.value },
            };
          const recorded = createPublicationFailure(
            id,
            "TreeIndexFailed",
            key,
            String(exit.cause),
          );
          return {
            publication: recorded.publication,
            outcome: {
              kind: "failed" as const,
              error: new TreeAttemptFailed(
                {
                  key,
                  attemptId: id,
                  tag: "TreeIndexFailed",
                  message: String(exit.cause),
                },
                exit.cause,
              ),
            },
          };
        }),
    }).pipe(
      Effect.withSpan("harness.index.shared", {
        attributes: { "harness.background": work?.background ?? false },
      }),
      Effect.catchTag("SharedAttemptFailed", (failure) => {
        // Only the publication failed: the index built in this process is kept.
        const kept = unpublished.get(failure);
        if (kept !== undefined) return Effect.succeed({ value: kept });
        return failure instanceof TreeAttemptFailed
          ? Effect.failCause(failure.original)
          : Effect.fail(failure);
      }),
    );
    yield* Effect.try(() => assertOutlineSource(source));
    return result.value;
  });
