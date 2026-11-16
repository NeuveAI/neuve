import { Effect, Option } from "effect";
import { graphRefusesSourcePath } from "@neuve/graph-client";
import { Computations, canonicalJson } from "@neuve/records-core";
import { cpuBatch, cpuWork } from "./budget/cpu.ts";
import { repositoryOwner } from "./budget/owner.ts";
import { capabilityFor, type GraphChunkContext } from "./chunker.ts";
import { codeCheckpoint } from "./code-work.ts";
import { groupsBySize, readBlobs, type TreeEntry } from "./git-objects.ts";
import { blobSizes } from "./hunks.ts";
import {
  assertOutlineSource,
  readOutlinesWithBudget,
  type OutlineSource,
} from "./graph-outline.ts";
import {
  ExclusionReason,
  INDEX_BOUNDS,
  blobText,
  decodeJson,
  decodeStored,
  entryExclusion,
  overSize,
  storedBytes,
  uniquePathBatches,
} from "./search-index.ts";
import {
  BlobStructure,
  REFUSED_PATH,
  blobStructureSpec,
  encodeBlobStructure,
  noStructure,
  structureRetryable,
  type StructureContext,
  type StructureReason,
} from "./sections.ts";
import type { ManifestHunk } from "./manifest.ts";
import { timePrecomputeItem } from "./telemetry.ts";

/**
 * Each blob's structure, read from the store. The pass that chunks a blob (`blobChunks`) stores its
 * structure from the same Graph read; this reader only reads Graph for a blob whose structure is not
 * stored: its chunks were stored before structures were, or its last outcome was retryable. Such a
 * blob costs one outline observation (none for Markdown or binary content), batched with unique
 * paths, and is then stored, so the next call reads Graph for it no more.
 */

// Every index exclusion is a structure reason; the compiler holds it.
const exclusions: ReadonlyArray<StructureReason> = ExclusionReason.options;
void exclusions;

/** At most this many structures decoded in one CPU job. */
const DECODE_BATCH = 128;

export interface BlobStructureCounts {
  /** Distinct blobs (by path and object ID) asked for. */
  readonly asked: number;
  /** Structures found under their stable key. */
  readonly stored: number;
  /**
   * Structures the fallback stored under their stable key, and those another run had just stored
   * there; and structures that are retryable, kept under their reason's key and not stored for good.
   */
  readonly computed: number;
  readonly joined: number;
  readonly retryable: number;
  /** Outline reads the fallback made, and the files they held. */
  readonly outlineBatches: number;
  readonly outlineFiles: number;
  /** Blobs with no structure, by reason. */
  readonly none: Readonly<Partial<Record<StructureReason, number>>>;
}

/** The key a structure is returned under: the blob's path and object ID. */
export const structureKeyOf = (path: string, oid: string) => `${path}\0${oid}`;

/**
 * The blobs of a manifest's text hunks, each side once, named as Precompute names them
 * (`describeHunks`), so their stored structures' keys are found. Sizes are left to the reader.
 */
export const hunkBlobEntries = (
  hunks: ReadonlyArray<
    Pick<
      ManifestHunk,
      | "kind"
      | "oldPath"
      | "oldOid"
      | "oldMode"
      | "newPath"
      | "newOid"
      | "newMode"
    >
  >,
): ReadonlyMap<string, TreeEntry> => {
  const entries = new Map<string, TreeEntry>();
  for (const hunk of hunks) {
    if (hunk.kind !== "text") continue;
    for (const [path, oid, mode] of [
      [hunk.oldPath, hunk.oldOid, hunk.oldMode],
      [hunk.newPath, hunk.newOid, hunk.newMode],
    ] as const) {
      if (path === null || oid === null) continue;
      entries.set(structureKeyOf(path, oid), {
        mode: mode ?? "100644",
        type: mode === "160000" ? "commit" : "blob",
        oid,
        size: null,
        path,
      });
    }
  }
  return entries;
};

/**
 * Each blob's structure by blob id, from structures read by path and id (`blobStructures`). One
 * blob read under two paths whose structures differ is given a structure with none and the reason
 * `conflicting-paths`: neither cut is taken for it, and it is never left out, so whoever reads the
 * map sees why. Not stored: it is a fact of this set of paths, not of the blob.
 */
export const structuresByBlob = (
  entries: Iterable<Pick<TreeEntry, "path" | "oid">>,
  structures: ReadonlyMap<string, BlobStructure>,
): { byBlob: ReadonlyMap<string, BlobStructure>; conflicting: number } => {
  const byBlob = new Map<string, BlobStructure>();
  const conflicting = new Set<string>();
  for (const entry of entries) {
    if (conflicting.has(entry.oid)) continue;
    const structure = structures.get(structureKeyOf(entry.path, entry.oid));
    if (structure === undefined) continue;
    const held = byBlob.get(entry.oid);
    if (
      held !== undefined &&
      canonicalJson(held) !== canonicalJson(structure)
    ) {
      byBlob.set(entry.oid, noStructure("conflicting-paths"));
      conflicting.add(entry.oid);
    } else byBlob.set(entry.oid, structure);
  }
  return { byBlob, conflicting: conflicting.size };
};

/**
 * The structure of each blob, by `structureKeyOf(path, oid)`. Entries that are not regular blobs,
 * or over the index's size bound, have no structure and say why; nothing is stored for them.
 * Bytes already read can be passed in `contents` (by blob OID).
 */
export const blobStructures = (
  repository: string,
  entries: ReadonlyArray<TreeEntry>,
  source: OutlineSource,
  contents: ReadonlyMap<string, Uint8Array> = new Map(),
) =>
  Effect.gen(function* () {
    yield* Effect.try(() => assertOutlineSource(source));
    const store = yield* Computations.ComputationStore;
    const out = new Map<string, BlobStructure>();
    const none: Partial<Record<StructureReason, number>> = {};
    let computed = 0;
    let joined = 0;
    let retryable = 0;
    let outlineBatches = 0;
    let outlineFiles = 0;
    const unique = new Map<string, TreeEntry>();
    for (const entry of entries) {
      const key = structureKeyOf(entry.path, entry.oid);
      // A symlink and a regular file can share a key: the regular file's structure is the answer.
      const held = unique.get(key);
      if (held === undefined || entryExclusion(held) !== undefined)
        unique.set(key, entry);
    }
    const wanted: Array<{ key: string; entry: TreeEntry }> = [];
    for (const [key, entry] of unique) {
      const reason = entryExclusion(entry);
      if (reason === undefined) wanted.push({ key, entry });
      else out.set(key, noStructure(reason));
    }
    const raw = yield* timePrecomputeItem(
      "structure.lookup",
      storedBytes(
        wanted.map(({ entry }) =>
          blobStructureSpec(entry.oid, entry.path, source),
        ),
      ),
      (values) =>
        values.every((value) => value !== undefined) ? "cached" : "missing",
    );
    const missing: Array<{ key: string; entry: TreeEntry }> = [];
    // Decoding is CPU work: bounded jobs off the event loop, never one job for every blob asked.
    for (let offset = 0; offset < wanted.length; offset += DECODE_BATCH) {
      yield* codeCheckpoint;
      const cached = yield* cpuWork(
        repositoryOwner(repository),
        Effect.sync(() =>
          decodeStored(raw.slice(offset, offset + DECODE_BATCH), BlobStructure),
        ),
      );
      for (const [index, item] of wanted
        .slice(offset, offset + DECODE_BATCH)
        .entries()) {
        const stored = cached[index] ?? Option.none<BlobStructure>();
        if (Option.isSome(stored)) out.set(item.key, stored.value);
        else missing.push(item);
      }
    }
    const stored = wanted.length - missing.length;
    // Only blobs to be read need a size; a stored hit costs no git process. A size is git's byte
    // length, so one over the bound is over-size (the rule of `overSize`) without reading it.
    const sizes = yield* blobSizes(repository, [
      ...new Set(
        missing.flatMap(({ entry }) =>
          entry.size === null && !contents.has(entry.oid) ? [entry.oid] : [],
        ),
      ),
    ]);
    const toRead = missing.flatMap((item) => {
      const size =
        item.entry.size ??
        contents.get(item.entry.oid)?.byteLength ??
        sizes.get(item.entry.oid) ??
        null;
      if (size !== null && size > INDEX_BOUNDS.maxFileBytes) {
        out.set(item.key, noStructure("over-size"));
        return [];
      }
      return [{ ...item, size }];
    });
    const compute = yield* cpuBatch(
      repositoryOwner(repository),
      ({
        path,
        text,
        graph,
      }: {
        path: string;
        text: string | undefined;
        graph: StructureContext;
      }) => encodeBlobStructure(path, text, graph),
    );
    // Groups are bounded by size, so a fallback over thousands of blobs never holds them all.
    for (const group of groupsBySize(toRead)) {
      yield* codeCheckpoint;
      const read = yield* readBlobs(
        repository,
        group
          .filter(({ entry }) => !contents.has(entry.oid))
          .map(({ entry }) => entry.oid),
      );
      // Decoding is CPU work; it runs off the event loop like the chunker's.
      const decoded = yield* cpuWork(
        repositoryOwner(repository),
        Effect.sync(() =>
          group.map((item) => {
            const bytes =
              contents.get(item.entry.oid) ?? read.get(item.entry.oid);
            // `read` tells the two shapes apart by value, so every compiler setting narrows them.
            if (bytes === undefined)
              return {
                read: false as const,
                item,
                reason: "unreadable" as const,
              };
            if (overSize(bytes))
              return {
                read: false as const,
                item,
                reason: "over-size" as const,
              };
            return { read: true as const, item, bytes, text: blobText(bytes) };
          }),
        ),
      );
      const readable = decoded.flatMap((file) => (file.read ? [file] : []));
      for (const file of decoded)
        if (!file.read) out.set(file.item.key, noStructure(file.reason));
      // Batched as the pass does: per size group, unique paths, no file cap (each read pays Graph's
      // start). Markdown needs no Graph, binary content is never sent to it, and a path Graph
      // refuses is kept out, so it no longer fails its whole batch.
      const contexts = new Map<string, GraphChunkContext>();
      for (const batch of uniquePathBatches(
        readable.filter(
          (file) =>
            file.text !== undefined &&
            capabilityFor(file.item.entry.path).capability !==
              "markdown-sections" &&
            !graphRefusesSourcePath(file.item.entry.path),
        ),
        (file) => file.item.entry.path,
      )) {
        const outlines = yield* readOutlinesWithBudget(
          batch.map((file) => ({
            path: file.item.entry.path,
            bytes: file.bytes,
          })),
          "graph.outline.structure",
          source,
        );
        outlineBatches++;
        outlineFiles += batch.length;
        for (const file of batch)
          contexts.set(file.item.key, outlines.context(file.item.entry.path));
      }
      for (let offset = 0; offset < readable.length; offset += DECODE_BATCH) {
        yield* codeCheckpoint;
        const results = yield* Effect.forEach(
          readable.slice(offset, offset + DECODE_BATCH),
          (file) =>
            Effect.gen(function* () {
              const { entry, key } = file.item;
              const graph: StructureContext = graphRefusesSourcePath(entry.path)
                ? REFUSED_PATH
                : (contexts.get(key) ?? { kind: "unavailable" });
              const reason = structureRetryable(
                entry.path,
                file.text === undefined,
                graph,
              );
              // The key is chosen before the work, so one run per key computes it.
              const result = yield* timePrecomputeItem(
                "structure.compute",
                store.run(
                  blobStructureSpec(entry.oid, entry.path, source, reason),
                  Effect.map(
                    compute({ path: entry.path, text: file.text, graph }),
                    (built) => built.output,
                  ),
                ),
                (value) => value.status,
              );
              if (reason !== undefined) retryable++;
              else if (result.status === "computed") computed++;
              else joined++;
              return { key, output: result.output };
            }),
          { concurrency: DECODE_BATCH },
        );
        const structures = yield* cpuWork(
          repositoryOwner(repository),
          Effect.sync(() =>
            results.map(({ key, output }) => ({
              key,
              structure: decodeJson(output, BlobStructure),
            })),
          ),
        );
        for (const { key, structure } of structures) out.set(key, structure);
      }
    }
    for (const structure of out.values())
      if (structure.reason !== null)
        none[structure.reason] = (none[structure.reason] ?? 0) + 1;
    const counts: BlobStructureCounts = {
      asked: unique.size,
      stored,
      computed,
      joined,
      retryable,
      outlineBatches,
      outlineFiles,
      none,
    };
    yield* Effect.annotateCurrentSpan({
      "harness.structures.asked": counts.asked,
      "harness.structures.stored": counts.stored,
      "harness.structures.computed": counts.computed,
      "harness.structures.joined": counts.joined,
      "harness.structures.retryable": counts.retryable,
      "harness.structures.outline_batches": counts.outlineBatches,
      "harness.structures.outline_files": counts.outlineFiles,
      ...Object.fromEntries(
        Object.entries(none).map(([reason, count]) => [
          `harness.structures.none.${reason}`,
          count,
        ]),
      ),
    });
    yield* Effect.try(() => assertOutlineSource(source));
    return {
      structures: out as ReadonlyMap<string, BlobStructure>,
      counts,
    };
  }).pipe(Effect.withSpan("harness.structure.read"));
