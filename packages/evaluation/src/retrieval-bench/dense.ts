import { createHash } from "node:crypto";
import { Blobs, Computations } from "@neuve/records-core";
import { Effect, Exit, Option } from "effect";
import { chunkText, type BaseCorpus, type Occurrence } from "./corpus.ts";
import type { EncoderProcess } from "./encoder.ts";
import { modelIdentity, type ModelEntry } from "./models.ts";
import type { HunkQuery } from "./queries.ts";
import { asFloats, floatBytes, readStored } from "./stored.ts";

/**
 * Dense arms (E0 to E4): every distinct chunk text is encoded once per model and path, and stored as
 * a computation keyed by the model's identity (revision, weight hashes, adapter, input recipe, device
 * and dtype), the chunk text's hash and the path in its title (5.4). A chunk shared by many bases or
 * by many versions of a file is encoded once. Retrieval is exact cosine over the base's chunks, ties
 * broken by chunk id.
 */

export const encodeSpec = (model: ModelEntry, hash: string, path: string) => ({
  op: "bench.encode-chunk",
  opVersion: 1,
  inputs: {
    chunk: `blob:${hash}`,
    path,
  },
  config: { model: modelIdentity(model) },
});

const queryHash = (text: string) =>
  createHash("sha256").update(text).digest("hex");

const queryEncodeSpec = (model: ModelEntry, query: HunkQuery) => ({
  op: "bench.encode-query",
  opVersion: 1,
  inputs: { query: `blob:${query.sha256}` },
  config: { model: modelIdentity(model) },
});

/** One distinct (chunk text, path) pair: the unit of encoding. */
export interface EncodeUnit {
  readonly hash: string;
  readonly path: string;
  /** Counting-tokenizer tokens, used only to size batches. */
  readonly tokens: number;
}

/** The distinct encoding units of some bases, in a fixed order. */
export const encodeUnits = (
  bases: ReadonlyArray<BaseCorpus>,
  tokens: ReadonlyMap<string, ReadonlyArray<number>>,
) => {
  const units = new Map<string, EncodeUnit>();
  for (const base of bases)
    for (const occurrence of base.occurrences) {
      const key = `${occurrence.hash}\u0000${occurrence.path}`;
      if (!units.has(key))
        units.set(key, {
          hash: occurrence.hash,
          path: occurrence.path,
          tokens: tokens.get(occurrence.chunkKey)?.[occurrence.position] ?? 512,
        });
    }
  return [...units.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, unit]) => unit);
};

export interface EncodeProgress {
  readonly model: string;
  readonly units: number;
  readonly reused: number;
  readonly encoded: number;
  readonly modelTokens: number;
  readonly truncated: number;
  readonly seconds: number;
}

/** Counter tokens plus a margin for prefixes and special tokens, used only to size batches. */
const MARGIN = 32;
const GROUP = 1024;

/**
 * Encodes every unit that has no stored encoding: in groups, sorted by length and batched under
 * `batchTokens` padded tokens, each vector stored as its own computation.
 */
export const encodeChunks = (
  model: ModelEntry,
  units: ReadonlyArray<EncodeUnit>,
  encoder: Pick<EncoderProcess, "encode">,
  batchTokens: number,
  log: (line: string) => void,
) =>
  Effect.gen(function* () {
    const store = yield* Computations.ComputationStore;
    const started = performance.now();
    const pending: Array<EncodeUnit> = [];
    for (const unit of units)
      if (
        Option.isNone(
          yield* store.lookup(
            Computations.computationKey(encodeSpec(model, unit.hash, unit.path))
              .key,
          ),
        )
      )
        pending.push(unit);
    let encoded = 0;
    let modelTokens = 0;
    let truncated = 0;
    log(
      `${model.id}: ${units.length} chunk encodings; ${units.length - pending.length} stored, ${pending.length} to encode`,
    );
    const context = yield* Effect.context<Blobs.BlobStore>();
    type Encoded = Computations.Output;
    type EncodingError =
      | Effect.Error<ReturnType<EncoderProcess["encode"]>>
      | Effect.Error<ReturnType<typeof chunkText>>;
    type Request = {
      unit: EncodeUnit;
      resume: (effect: Effect.Effect<Encoded, EncodingError>) => void;
      cancelled: boolean;
      ended: ReturnType<typeof Promise.withResolvers<void>>;
      cancelBatch?: () => void;
    };
    const ready: Request[] = [];
    let scheduled = false;
    let flushing = Promise.resolve();
    const flush = () => {
      scheduled = false;
      const claimed = ready
        .splice(0)
        .sort((a, b) => a.unit.tokens - b.unit.tokens);
      // This queue contains only admitted compute callbacks. Waiters never enter inference.
      flushing = flushing.then(async () => {
        for (let offset = 0; offset < claimed.length;) {
          const batch: Request[] = [];
          let longest = 0;
          while (offset < claimed.length) {
            const request = claimed[offset]!;
            if (request.cancelled) {
              offset++;
              request.ended.resolve();
              continue;
            }
            const estimate = request.unit.tokens + MARGIN;
            if (
              batch.length &&
              Math.max(longest, estimate) * (batch.length + 1) > batchTokens
            )
              break;
            batch.push(request);
            offset++;
            longest = Math.max(longest, estimate);
          }
          if (!batch.length) continue;
          const controller = new AbortController();
          for (const request of batch)
            request.cancelBatch = () => {
              if (batch.every((item) => item.cancelled)) controller.abort();
            };
          try {
            const exit = await Effect.runPromiseExitWith(context)(
              Effect.gen(function* () {
                const texts = yield* Effect.forEach(batch, ({ unit }) =>
                  modelInput(model, unit),
                );
                const result = yield* encoder.encode(texts);
                if (result.dim !== model.dimensions)
                  return yield* Effect.die(
                    new Error(`${model.id}: dimension ${result.dim}`),
                  );
                for (const count of result.tokens) {
                  modelTokens += count;
                  if (count > model.maxTokens) truncated++;
                }
                encoded += batch.length;
                return result;
              }),
              { signal: controller.signal },
            );
            for (const [row, request] of batch.entries()) {
              request.resume(
                Exit.isFailure(exit)
                  ? Effect.failCause(exit.cause)
                  : Effect.succeed({
                      bytes: floatBytes(
                        exit.value.vectors.slice(
                          row * exit.value.dim,
                          (row + 1) * exit.value.dim,
                        ),
                      ),
                      mediaType: "application/octet-stream",
                    }),
              );
            }
          } finally {
            for (const request of batch) {
              delete request.cancelBatch;
              request.ended.resolve();
            }
          }
        }
      });
    };
    for (let offset = 0; offset < pending.length; offset += GROUP) {
      yield* Effect.forEach(
        pending.slice(offset, offset + GROUP),
        (unit) =>
          store.run(
            encodeSpec(model, unit.hash, unit.path),
            Effect.callback<Encoded, EncodingError>((resume) => {
              const request: Request = {
                unit,
                resume,
                cancelled: false,
                ended: Promise.withResolvers<void>(),
              };
              ready.push(request);
              if (!scheduled) {
                scheduled = true;
                setImmediate(flush);
              }
              return Effect.promise(async () => {
                request.cancelled = true;
                const index = ready.indexOf(request);
                if (index >= 0) {
                  ready.splice(index, 1);
                  request.ended.resolve();
                }
                request.cancelBatch?.();
                // Keep ownership until any inference using this key has actually stopped.
                await request.ended.promise;
              });
            }),
          ),
        { concurrency: "unbounded", discard: true },
      );
      const seconds = (performance.now() - started) / 1000;
      log(
        `${model.id}: ${encoded}/${pending.length} chunks, ${(encoded / seconds).toFixed(1)} chunks/s, truncated ${truncated}`,
      );
    }

    return {
      model: model.id,
      units: units.length,
      reused: units.length - encoded,
      encoded,
      modelTokens,
      truncated,
      seconds: (performance.now() - started) / 1000,
    } satisfies EncodeProgress;
  });

/** Encodes and stores the Q1 queries for one model; the query text is kept as a blob. */
export const encodeQueries = (
  model: ModelEntry,
  queries: ReadonlyArray<HunkQuery>,
  encoder: Pick<EncoderProcess, "encode">,
) =>
  Effect.gen(function* () {
    const store = yield* Computations.ComputationStore;
    const blobs = yield* Blobs.BlobStore;
    const timings: Array<{
      hunkId: string;
      millis: number;
      tokens: number;
      status: string;
    }> = [];
    for (const query of queries) {
      if (queryHash(query.text) !== query.sha256)
        return yield* Effect.die(
          new Error(`query ${query.hunkId} text changed`),
        );
      yield* blobs.put({
        bytes: new TextEncoder().encode(query.text),
        mediaType: "text/plain; charset=utf-8",
        retention: "durable",
      });
      let millis = 0;
      let tokens = 0;
      const result = yield* store.run(
        queryEncodeSpec(model, query),
        Effect.gen(function* () {
          const started = performance.now();
          const encoded = yield* encoder.encode([
            model.format.query(query.text),
          ]);
          millis = performance.now() - started;
          tokens = encoded.tokens[0] ?? 0;
          return {
            bytes: floatBytes(encoded.vectors),
            mediaType: "application/octet-stream",
          };
        }),
      );
      timings.push({
        hunkId: query.hunkId,
        millis,
        tokens,
        status: result.status,
      });
    }
    return timings;
  });

/** A base's chunk vectors for one model, row-aligned with `base.occurrences`; `cache` spans bases. */
export const baseMatrix = (
  model: ModelEntry,
  base: BaseCorpus,
  cache: Map<string, Float32Array>,
) =>
  Effect.gen(function* () {
    const matrix = new Float32Array(base.occurrences.length * model.dimensions);
    for (const [row, occurrence] of base.occurrences.entries()) {
      const key = `${occurrence.hash}\u0000${occurrence.path}`;
      let vector = cache.get(key);
      if (vector === undefined) {
        const bytes = yield* readStored(
          encodeSpec(model, occurrence.hash, occurrence.path),
        );
        if (Option.isNone(bytes))
          return yield* Effect.die(
            new Error(
              `${model.id}: no encoding for ${occurrence.chunkId} at ${base.commit}`,
            ),
          );
        vector = asFloats(bytes.value);
        cache.set(key, vector);
      }
      matrix.set(vector, row * model.dimensions);
    }
    return matrix;
  });

export const queryVectorStored = (model: ModelEntry, query: HunkQuery) =>
  Effect.map(readStored(queryEncodeSpec(model, query)), Option.isSome);

export const queryVector = (model: ModelEntry, query: HunkQuery) =>
  Effect.gen(function* () {
    const bytes = yield* readStored(queryEncodeSpec(model, query));
    if (Option.isNone(bytes))
      return yield* Effect.die(
        new Error(`${model.id}: no encoding for query ${query.hunkId}`),
      );
    return asFloats(bytes.value);
  });

/** Exact cosine (vectors are unit length) over every chunk, best first, ties by chunk id. */
export const cosineRanking = (
  matrix: Float32Array,
  dimensions: number,
  occurrences: ReadonlyArray<Occurrence>,
  vector: Float32Array,
) => {
  const scores = new Float64Array(occurrences.length);
  for (let row = 0; row < occurrences.length; row++) {
    let sum = 0;
    const offset = row * dimensions;
    for (let column = 0; column < dimensions; column++)
      sum += (matrix[offset + column] ?? 0) * (vector[column] ?? 0);
    scores[row] = sum;
  }
  // Occurrences are already in chunk-id order, so a stable sort on score keeps ties by chunk id.
  return [...occurrences.keys()]
    .sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0) || a - b)
    .map((row) => ({
      occurrence: occurrences[row] as Occurrence,
      score: scores[row] ?? 0,
    }));
};

/** One stored chunk vector, for the encoder checks. */
export const storedChunkVector = (
  model: ModelEntry,
  hash: string,
  path: string,
) =>
  Effect.map(readStored(encodeSpec(model, hash, path)), Option.map(asFloats));

/**
 * The encoding contract for any backend. `exportUnits` lists what a model still needs, as the exact
 * model input text, keyed by chunk hash and path (and query hash); `importVector` stores a vector a
 * backend computed under the same computation key a local encode would use. The model entry
 * (revision, weight hashes, recipe, device, dtype) is the backend's declaration of how it computed
 * them; vectors are checked for dimension, finiteness and unit length before they are stored.
 */
export const pendingUnits = (
  model: ModelEntry,
  units: ReadonlyArray<EncodeUnit>,
) =>
  Effect.gen(function* () {
    const store = yield* Computations.ComputationStore;
    const out: Array<EncodeUnit> = [];
    for (const unit of units)
      if (
        Option.isNone(
          yield* store.lookup(
            Computations.computationKey(encodeSpec(model, unit.hash, unit.path))
              .key,
          ),
        )
      )
        out.push(unit);
    return out;
  });

export const modelInput = (model: ModelEntry, unit: EncodeUnit) =>
  Effect.map(chunkText(unit.hash), (text) =>
    model.format.document(unit.path, text),
  );

const checkVector = (model: ModelEntry, vector: Float32Array, what: string) => {
  if (vector.length !== model.dimensions)
    return `${what}: ${vector.length} dimensions, expected ${model.dimensions}`;
  let norm = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) return `${what}: non-finite value`;
    norm += value * value;
  }
  return Math.abs(Math.sqrt(norm) - 1) > 1e-3
    ? `${what}: norm ${Math.sqrt(norm)}`
    : undefined;
};

export const importChunkVector = (
  model: ModelEntry,
  hash: string,
  path: string,
  vector: Float32Array,
) =>
  Effect.gen(function* () {
    const problem = checkVector(model, vector, `${path} ${hash}`);
    if (problem !== undefined) return yield* Effect.die(new Error(problem));
    return (yield* (yield* Computations.ComputationStore).run(
      encodeSpec(model, hash, path),
      Effect.succeed({
        bytes: floatBytes(vector),
        mediaType: "application/octet-stream",
      }),
    )).status;
  });

export const importQueryVector = (
  model: ModelEntry,
  query: HunkQuery,
  vector: Float32Array,
) =>
  Effect.gen(function* () {
    const problem = checkVector(model, vector, `query ${query.hunkId}`);
    if (problem !== undefined) return yield* Effect.die(new Error(problem));
    yield* (yield* Blobs.BlobStore).put({
      bytes: new TextEncoder().encode(query.text),
      mediaType: "text/plain; charset=utf-8",
      retention: "durable",
    });
    return (yield* (yield* Computations.ComputationStore).run(
      queryEncodeSpec(model, query),
      Effect.succeed({
        bytes: floatBytes(vector),
        mediaType: "application/octet-stream",
      }),
    )).status;
  });

export const encodeUnitId = (unit: EncodeUnit) => `${unit.hash}:${unit.path}`;
