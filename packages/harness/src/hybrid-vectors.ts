import { createHash } from "node:crypto";
import { Data, Effect } from "effect";
import { z } from "zod";
import { Blobs, Computations } from "@neuve/records-core";
import { splitLines } from "./chunker.ts";
import { BENCH_E0_IDENTITY, E0_DIMENSIONS, type TreeVectors } from "./e0.ts";
import { readBlobs } from "./git-objects.ts";
import type { IndexedChunk, TreeIndex } from "./search-index.ts";
import { jsonComputation, storedOutput } from "./search-index.ts";

/**
 * Chunk vectors encoded on this machine (10.117), in the repository's own Records store. Each is
 * keyed exactly as the benchmark's encoding contract keys its own (`bench.encode-chunk@1`: the
 * chunk text's SHA-256 and its path, under E0's model identity), with this machine's device in that
 * identity, so a vector computed once is reused by every commit and review whose tree holds the
 * chunk, and never collides with the benchmark's GPU vectors. A chunk the encoder refuses (over the
 * model's 8,192 tokens) is recorded as refused under the same inputs, so readiness knows it is not
 * encodable rather than missing.
 */

export type LocalDevice = "cpu" | "mps";

export const localE0Identity = (device: LocalDevice) => ({
  ...BENCH_E0_IDENTITY,
  device,
});

/** A chunk's vector computation here: the benchmark's contract, with this machine's device. */
export const localChunkSpec = (
  textSha256: string,
  path: string,
  device: LocalDevice,
): Computations.ComputationSpec => ({
  op: "bench.encode-chunk",
  opVersion: 1,
  inputs: { chunk: `blob:${textSha256}`, path },
  config: { model: localE0Identity(device) },
});

/** That the encoder refused a chunk, and why. */
export const chunkRefusalSpec = (
  textSha256: string,
  path: string,
  device: LocalDevice,
): Computations.ComputationSpec => ({
  op: "harness.e0-chunk-refusal",
  opVersion: 1,
  inputs: { chunk: `blob:${textSha256}`, path },
  config: { model: localE0Identity(device) },
});

const Refusal = z.strictObject({ reason: z.string().min(1).max(200) });

/** One chunk as the encoder reads it: its path (the document's title) and its text. */
export interface ChunkInput {
  readonly path: string;
  readonly text: string;
}

export type EncodedChunk =
  | { readonly kind: "vector"; readonly vector: Float32Array }
  | { readonly kind: "refused"; readonly reason: string };

/** The model process could not encode (it failed to start, died or timed out). */
export class EncoderUnavailable extends Data.TaggedError("EncoderUnavailable")<{
  readonly message: string;
}> {}

/**
 * The chunk encoder (port): EmbeddingGemma 2 as the semantic client runs it, on this machine's
 * device, with the benchmark's document format (`title: <path> | text: <text>`). One batch at a
 * time per process.
 */
export interface ChunkEncoder {
  readonly device: LocalDevice;
  readonly workerSha256: string;
  /** Chunks per request; `ENCODE_BATCH.items` unless the device needs fewer (Apple's GPU). */
  readonly batchItems?: number | undefined;
  readonly encode: (
    items: ReadonlyArray<ChunkInput>,
  ) => Effect.Effect<ReadonlyArray<EncodedChunk>, EncoderUnavailable>;
}

/** The semantic client's bounds on one request (worker.py): items, and formatted bytes. */
export const ENCODE_BATCH = { items: 16, bytes: 192 * 1024 } as const;

const vectorBytes = (vector: Float32Array) =>
  new Uint8Array(
    vector.buffer.slice(
      vector.byteOffset,
      vector.byteOffset + vector.byteLength,
    ),
  );

const asFloats = (bytes: Uint8Array) =>
  new Float32Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );

/** A stored local vector of the model's dimension, if any. */
const storedVector = (spec: Computations.ComputationSpec) =>
  Effect.gen(function* () {
    const store = yield* Computations.ComputationStore;
    const blobs = yield* Blobs.BlobStore;
    const held = yield* store.lookup(Computations.computationKey(spec).key);
    if (held._tag === "None") return undefined;
    const read = yield* blobs.get(held.value.outputHash);
    if (read._tag === "Pruned") return undefined;
    const vector = asFloats(read.bytes);
    return vector.length === E0_DIMENSIONS ? vector : undefined;
  });

/** A tree's local vectors, and which chunks are refused or missing. */
export interface LocalTreeVectors extends TreeVectors {
  /** Docs the encoder refused: not encodable, so not searched, and not missing. */
  readonly refused: ReadonlyArray<number>;
  /** Docs with neither a vector nor a refusal: encoding is not done. */
  readonly missingDocs: ReadonlyArray<number>;
}

/**
 * The stored local vectors of every chunk of an index. Ready (10.118, the overseer's readiness
 * rule) when no chunk is missing: every encodable chunk has a vector.
 */
export const localTreeVectors = (index: TreeIndex, device: LocalDevice) =>
  Effect.gen(function* () {
    const started = Date.now();
    const rows: Array<Float32Array> = [];
    const docs: Array<number> = [];
    const refused: Array<number> = [];
    const missingDocs: Array<number> = [];
    for (const [doc, chunk] of index.chunks.entries()) {
      const vector = yield* storedVector(
        localChunkSpec(chunk.textSha256, chunk.path, device),
      );
      if (vector !== undefined) {
        rows.push(vector);
        docs.push(doc);
      } else if (
        (yield* storedOutput(
          chunkRefusalSpec(chunk.textSha256, chunk.path, device),
          Refusal,
        ))._tag === "Some"
      )
        refused.push(doc);
      else missingDocs.push(doc);
      if (doc % 512 === 511) yield* Effect.yieldNow;
    }
    const matrix = new Float32Array(rows.length * E0_DIMENSIONS);
    rows.forEach((row, at) => matrix.set(row, at * E0_DIMENSIONS));
    const coverage = createHash("sha256");
    for (const doc of docs) {
      const chunk = index.chunks[doc]!;
      coverage.update(`${chunk.textSha256}\0${chunk.path}\n`);
    }
    return {
      tree: index.tree,
      matrix,
      docs: Int32Array.from(docs),
      missing: missingDocs.length,
      refused,
      missingDocs,
      coverage: `${docs.length}/${index.chunks.length}:${coverage.digest("hex").slice(0, 32)}`,
      loadMs: Date.now() - started,
    } satisfies LocalTreeVectors;
  }).pipe(
    Effect.withSpan("harness.hybrid.vectors.read", {
      attributes: { "harness.tree": index.tree, "harness.device": device },
    }),
  );

/** The chunks among `chunks` with neither a stored vector nor a refusal, without reading vectors. */
export const missingAmong = (
  chunks: ReadonlyArray<IndexedChunk>,
  device: LocalDevice,
) =>
  Effect.gen(function* () {
    const store = yield* Computations.ComputationStore;
    const missing: Array<IndexedChunk> = [];
    for (const chunk of chunks) {
      const vector = yield* store.lookup(
        Computations.computationKey(
          localChunkSpec(chunk.textSha256, chunk.path, device),
        ).key,
      );
      if (vector._tag === "Some") continue;
      const refusal = yield* store.lookup(
        Computations.computationKey(
          chunkRefusalSpec(chunk.textSha256, chunk.path, device),
        ).key,
      );
      if (refusal._tag === "None") missing.push(chunk);
    }
    return missing;
  });

/** The text of each chunk, read from its blob; a chunk whose text no longer hashes to its key is left out. */
export const chunkTexts = (
  repository: string,
  chunks: ReadonlyArray<IndexedChunk>,
) =>
  Effect.gen(function* () {
    const bytes = yield* readBlobs(repository, [
      ...new Set(chunks.map((chunk) => chunk.blobOid)),
    ]);
    const lines = new Map<string, ReadonlyArray<string>>();
    const out = new Map<IndexedChunk, string>();
    for (const chunk of chunks) {
      let split = lines.get(chunk.blobOid);
      if (split === undefined) {
        const content = bytes.get(chunk.blobOid);
        split =
          content === undefined
            ? []
            : splitLines(new TextDecoder().decode(content));
        lines.set(chunk.blobOid, split);
      }
      const text = split.slice(chunk.startLine - 1, chunk.endLine).join("");
      if (createHash("sha256").update(text).digest("hex") === chunk.textSha256)
        out.set(chunk, text);
    }
    return out;
  });

/** Batches of at most `ENCODE_BATCH` items and formatted bytes, in order. */
export const batches = <T extends ChunkInput>(
  items: ReadonlyArray<T>,
  bounds: { readonly items: number; readonly bytes: number } = ENCODE_BATCH,
) => {
  const out: Array<Array<T>> = [];
  let current: Array<T> = [];
  let size = 0;
  for (const item of items) {
    const bytes =
      Buffer.byteLength(item.text) + Buffer.byteLength(item.path) + 24;
    if (
      current.length > 0 &&
      (current.length >= bounds.items || size + bytes > bounds.bytes)
    ) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += bytes;
  }
  if (current.length > 0) out.push(current);
  return out;
};

export interface EncodeReport {
  readonly encoded: number;
  readonly refused: number;
  /** Chunks whose text could not be read back at the hash the index holds. */
  readonly unreadable: number;
  readonly batches: number;
}

/**
 * Encodes the given chunks that have neither a vector nor a refusal, batch by batch, storing each
 * result as it lands (so an interrupted run resumes). Each batch is a `harness.hybrid.encode.batch`
 * span (10.97) with its items, bytes and the time the model took.
 */
export const encodeChunks = (
  repository: string,
  chunks: ReadonlyArray<IndexedChunk>,
  encoder: ChunkEncoder,
) =>
  Effect.gen(function* () {
    const texts = yield* chunkTexts(repository, chunks);
    const items = chunks.flatMap((chunk) => {
      const text = texts.get(chunk);
      return text === undefined ? [] : [{ chunk, path: chunk.path, text }];
    });
    let encoded = 0;
    let refused = 0;
    const planned = batches(items, {
      items: encoder.batchItems ?? ENCODE_BATCH.items,
      bytes: ENCODE_BATCH.bytes,
    });
    for (const batch of planned) {
      const results = yield* encoder.encode(batch).pipe(
        Effect.withSpan("harness.hybrid.encode.batch", {
          attributes: {
            "harness.device": encoder.device,
            "harness.items": batch.length,
            "harness.bytes": batch.reduce(
              (sum, item) => sum + Buffer.byteLength(item.text),
              0,
            ),
          },
        }),
      );
      for (const [at, item] of batch.entries()) {
        const result = results[at];
        if (result === undefined)
          return yield* new EncoderUnavailable({
            message: `the encoder answered ${results.length} of ${batch.length} items`,
          });
        const { textSha256, path } = item.chunk;
        if (result.kind === "vector") {
          if (result.vector.length !== E0_DIMENSIONS)
            return yield* new EncoderUnavailable({
              message: `the encoder returned ${result.vector.length} dimensions, not ${E0_DIMENSIONS}`,
            });
          const store = yield* Computations.ComputationStore;
          yield* store.run(
            localChunkSpec(textSha256, path, encoder.device),
            Effect.succeed({
              bytes: vectorBytes(result.vector),
              mediaType: "application/octet-stream",
            }),
          );
          encoded++;
        } else {
          yield* jsonComputation(
            chunkRefusalSpec(textSha256, path, encoder.device),
            Refusal,
            Effect.succeed({ reason: result.reason.slice(0, 200) }),
          );
          refused++;
        }
      }
      yield* Effect.yieldNow;
    }
    return {
      encoded,
      refused,
      unreadable: chunks.length - items.length,
      batches: planned.length,
    } satisfies EncodeReport;
  }).pipe(
    Effect.withSpan("harness.hybrid.encode", {
      attributes: {
        "harness.device": encoder.device,
        "harness.chunks": chunks.length,
      },
    }),
  );
