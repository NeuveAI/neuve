import { repositoryOwner } from "./budget/owner.ts";
import type { BudgetAdmissionFailed } from "./budget/acquire.ts";
import { cpuWork } from "./budget/cpu.ts";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { Effect, Exit } from "effect";
import { Computations, Worker, storeLocationIn } from "@neuve/records-core";
import {
  openAsItStands,
  readWithoutLog,
  watchUnchanged,
} from "@neuve/records-core/read-only";
import {
  SemanticClient,
  type BatchResult,
  type SemanticSpawn,
} from "@neuve/semantic-client";
import { describeChunks, type E0Config, type Retriever } from "./retriever.ts";
import { indexRecipe, type TreeIndex } from "./search-index.ts";
import { SharedWork } from "@neuve/records-core/shared-work";
import { sharedWorkEffect } from "@neuve/records-core/shared-work-effect";

/**
 * E0 behind the retriever port (9.61, 10.89): untuned EmbeddingGemma 2, exact cosine over the
 * range base's shared chunks. Two halves, each named in the retriever's config:
 *
 * - **Chunk vectors** are the benchmark's own (`documents`): read from a Records store under the
 *   benchmark's encoding contract (`packages/evaluation/src/retrieval-bench/dense.ts`, `encodeSpec`:
 *   the chunk text's SHA-256 and its path, under the model identity recorded in
 *   the private archive's arms identity record, `encoding.E0.identity`), so an agent's search ranks the
 *   same vectors the seeded leads were ranked with. A chunk with no stored vector is not searched,
 *   and every answer counts and discloses those. Nothing here encodes chunks: encoding at commit
 *   time is C10's open question (full-test.md), not ruled.
 * - **Query vectors** are encoded on this machine by `@neuve/semantic-client` (CPU, float32, the
 *   same prefixes as the benchmark), stored once per query text in the run's store, so a replay
 *   reads the vector the model saw. The parity measurement kept in the private archive measures
 *   their drift from the benchmark's Modal-encoded query vectors.
 */

/**
 * The benchmark's E0 model identity, the `config.model` of its encoding computations
 * (`modelIdentity(MODELS.E0)` in retrieval-bench/models.ts). It must equal that object exactly, or
 * no stored vector is found, which the answer then reports.
 */
export const BENCH_E0_IDENTITY = {
  hfId: "google/embeddinggemma-2",
  revision: "914f7f89142e33e77833254d9c9b90c3cef7303b",
  weights: {
    "model.safetensors":
      "197a32965d4b1105faf060417baa899e193fb73cd401f42ec9295234d5553d79",
  },
  adapter: null,
  recipe: "embeddinggemma2-code-retrieval-title-path-v1",
  pooling: "mean (sentence-transformers modules), normalised",
  dimensions: 768,
  maxTokens: 8192,
  device: "cuda",
  dtype: "float32",
} as const;

export const E0_DIMENSIONS = 768;

/** The benchmark's chunk-vector computation for one chunk text and path. */
export const benchChunkSpec = (textSha256: string, path: string) => ({
  op: "bench.encode-chunk",
  opVersion: 1,
  inputs: { chunk: `blob:${textSha256}`, path },
  config: { model: BENCH_E0_IDENTITY },
});

/** The benchmark's query-vector computation for a Q1 query (its text's SHA-256). */
export const benchQuerySpec = (querySha256: string) => ({
  op: "bench.encode-query",
  opVersion: 1,
  inputs: { query: `blob:${querySha256}` },
  config: { model: BENCH_E0_IDENTITY },
});

/** What E0 needs on this machine (`search-config.ts` resolves it from the user's settings). */
export interface E0Runtime {
  readonly python: string;
  readonly snapshot: string;
  readonly worker: string;
  /** The directory whose `neuve/` Records store holds the chunk vectors (8.6's shape). */
  readonly vectorStore: string;
}

/** The columns the reader needs, by table: all the store's schema must have for E0 to read it. */
export const VECTOR_STORE_COLUMNS = {
  computations: ["key", "output_hash"],
  blobs: ["hash", "placement", "content", "pruned_at"],
} as const;

export class VectorStoreUnreadable extends Error {
  readonly _tag = "VectorStoreUnreadable";
}

/**
 * The benchmark's Records store, read directly through SQLite, read-only, whatever its schema
 * version: the labelling side owns it and its hashes matter, so it is never migrated, gated or
 * written (no permission change, no journal pragma, no records-core `Store.layer`). Opening checks
 * that the tables and columns a lookup uses exist and refuses with what is missing otherwise. A
 * lookup is the encoding computation's key (`computations.key`, records-core's key of the same
 * spec), its output hash, and the blob's bytes, inline in `blobs.content` or in the store's
 * `blobs/sha256/<2>/<62>` file, checked against that hash.
 */
export class VectorStoreReader {
  readonly #path: string;
  readonly #blobs: string;
  #database!: DatabaseSync;
  #computation!: StatementSync;
  #blob!: StatementSync;
  #unchanged = () => true;
  /** Stated once when the reader opens. It holds up without a WAL because `output` checks every hash. */
  withoutLog = false;

  #open() {
    const { database, withoutLog } = openAsItStands(this.#path);
    this.#database = database;
    this.withoutLog = withoutLog;
    this.#unchanged = withoutLog ? watchUnchanged(this.#path) : () => true;
  }

  constructor(directory: string) {
    const location = storeLocationIn(directory);
    if (!existsSync(location.database))
      throw new VectorStoreUnreadable(
        `no Records store at ${location.database}`,
      );
    this.#path = location.database;
    this.#open();
    const missing: Array<string> = [];
    for (const [table, columns] of Object.entries(VECTOR_STORE_COLUMNS)) {
      const present = new Set(
        (
          this.#database
            .prepare(`SELECT name FROM pragma_table_info('${table}')`)
            .all() as Array<{ name: string }>
        ).map((row) => row.name),
      );
      if (present.size === 0) missing.push(`table ${table}`);
      else
        for (const column of columns)
          if (!present.has(column)) missing.push(`${table}.${column}`);
    }
    if (missing.length > 0) {
      this.#database.close();
      throw new VectorStoreUnreadable(
        `the E0 vector store at ${location.database} lacks ${missing.join(", ")}, which reading its vectors needs`,
      );
    }
    this.#blobs = location.blobs;
    this.#prepare();
  }

  #prepare() {
    this.#computation = this.#database.prepare(
      "SELECT output_hash FROM computations WHERE key = ?",
    );
    this.#blob = this.#database.prepare(
      "SELECT placement, content, pruned_at FROM blobs WHERE hash = ?",
    );
  }

  /** With no WAL this connection takes no locks and caches what it read, so it can't see a writer's commits. */
  #followWriters() {
    if (this.#unchanged()) return;
    this.#database.close();
    this.#open();
    this.#prepare();
  }

  /** The stored bytes of a computation's output, or undefined when absent, pruned or corrupt. */
  output(spec: Computations.ComputationSpec): Uint8Array | undefined {
    this.#followWriters();
    const held = this.#computation.get(
      Computations.computationKey(spec).key,
    ) as { output_hash: string } | undefined;
    if (held === undefined) return undefined;
    const hash = held.output_hash;
    const blob = this.#blob.get(hash) as
      | {
          placement: string;
          content: Uint8Array | null;
          pruned_at: string | null;
        }
      | undefined;
    if (blob === undefined || blob.pruned_at !== null) return undefined;
    let bytes: Uint8Array | undefined;
    if (blob.content !== null) bytes = new Uint8Array(blob.content);
    else {
      const path = join(this.#blobs, "sha256", hash.slice(0, 2), hash.slice(2));
      bytes = existsSync(path) ? new Uint8Array(readFileSync(path)) : undefined;
    }
    if (
      bytes === undefined ||
      createHash("sha256").update(bytes).digest("hex") !== hash
    )
      return undefined;
    return bytes;
  }

  close() {
    this.#database.close();
  }
}

const readers = new Map<string, VectorStoreReader>();

/** The vector store's reader, opened once per worker; a store that cannot be read says why. */
export const openVectorStore = (directory: string) =>
  Effect.try({
    try: () => {
      const known = readers.get(directory);
      if (known !== undefined) return { reader: known, opened: false };
      const reader = new VectorStoreReader(directory);
      readers.set(directory, reader);
      return { reader, opened: true };
    },
    catch: (cause) =>
      cause instanceof VectorStoreUnreadable
        ? cause
        : new VectorStoreUnreadable(
            `the E0 vector store at ${directory} could not be opened: ${String(cause)}`,
          ),
  }).pipe(
    Effect.tap(({ reader, opened }) =>
      opened && reader.withoutLog
        ? Effect.logWarning(readWithoutLog(storeLocationIn(directory).database))
        : Effect.void,
    ),
    Effect.map(({ reader }) => reader),
  );

const asFloats = (bytes: Uint8Array) =>
  new Float32Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );

/** A stored chunk vector, if the store has one of the model's dimension. */
export const storedVector = (
  reader: VectorStoreReader,
  spec: Computations.ComputationSpec,
) => {
  const bytes = reader.output(spec);
  if (bytes === undefined) return undefined;
  const vector = asFloats(bytes);
  return vector.length === E0_DIMENSIONS ? vector : undefined;
};

/** A tree's chunk vectors: rows of `matrix` are the index docs listed in `docs`. */
export interface TreeVectors {
  readonly tree: string;
  readonly matrix: Float32Array;
  readonly docs: Int32Array;
  readonly missing: number;
  /** Which of the tree's chunks have a vector: part of every E0 answer's and lead's key. */
  readonly coverage: string;
  readonly loadMs: number;
}

/** The store's database files' sizes and times: a store that gained vectors reads them again. */
const storeStamp = (directory: string) => {
  const database = storeLocationIn(directory).database;
  return [database, `${database}-wal`]
    .map((path) => {
      try {
        const info = statSync(path);
        return `${info.size}:${info.mtimeMs}`;
      } catch {
        return "-";
      }
    })
    .join("/");
};

const vectorCache = new Map<string, TreeVectors>();
const CACHED_TREES = 2;

/** The stored vectors of every chunk of an index, read once per tree and kept for two trees. */
const vectorBuilds = new SharedWork<
  Exit.Exit<TreeVectors, VectorStoreUnreadable | BudgetAdmissionFailed>
>();
export const treeVectors = (index: TreeIndex, runtime: E0Runtime) =>
  Effect.flatMap(Worker.HeavyWork, (gate) =>
    gate.start(
      Effect.suspend(() => {
        const key = `${runtime.vectorStore}\0${index.tree}\0${storeStamp(runtime.vectorStore)}`;
        return sharedWorkEffect(vectorBuilds, {
          scope: "e0-vectors@1",
          key,
          run: () =>
            Effect.map(
              Effect.exit(
                cpuWork(
                  "e0.vectors",
                  Effect.gen(function* () {
                    const held = vectorCache.get(key);
                    if (held !== undefined) return held;
                    const started = Date.now();
                    const reader = yield* openVectorStore(runtime.vectorStore);
                    const rows: Array<Float32Array> = [];
                    const docs: Array<number> = [];
                    let missing = 0;
                    for (const [doc, chunk] of index.chunks.entries()) {
                      const vector = storedVector(
                        reader,
                        benchChunkSpec(chunk.textSha256, chunk.path),
                      );
                      if (vector === undefined) missing++;
                      else {
                        rows.push(vector);
                        docs.push(doc);
                      }
                      if (doc % 512 === 511) yield* Effect.yieldNow;
                    }
                    const matrix = new Float32Array(
                      rows.length * E0_DIMENSIONS,
                    );
                    rows.forEach((row, at) =>
                      matrix.set(row, at * E0_DIMENSIONS),
                    );
                    const coverage = createHash("sha256");
                    for (const doc of docs) {
                      const chunk = index.chunks[doc]!;
                      coverage.update(`${chunk.textSha256}\0${chunk.path}\n`);
                    }
                    const vectors: TreeVectors = {
                      tree: index.tree,
                      matrix,
                      docs: Int32Array.from(docs),
                      missing,
                      coverage: `${docs.length}/${index.chunks.length}:${coverage.digest("hex").slice(0, 32)}`,
                      loadMs: Date.now() - started,
                    };
                    vectorCache.set(key, vectors);
                    while (vectorCache.size > CACHED_TREES) {
                      const oldest = vectorCache.keys().next().value;
                      if (oldest === undefined) break;
                      vectorCache.delete(oldest);
                    }
                    return vectors;
                  }),
                ),
              ),
              (value) => ({ kind: "succeeded", value }),
            ),
        }).pipe(
          Effect.catchTag("SharedWorkError", Effect.die),
          Effect.flatMap(({ value: exit }) =>
            Exit.isSuccess(exit)
              ? Effect.succeed(exit.value)
              : Effect.failCause(exit.cause),
          ),
        );
      }).pipe(
        Effect.provideService(
          Worker.HeavyWork,
          Worker.HeavyWork.defaultValue(),
        ),
      ),
    ),
  );

const clients = new Map<string, SemanticClient>();

const encoderKey = (runtime: E0Runtime) =>
  `${runtime.python}\0${runtime.snapshot}\0${runtime.worker}`;

/** One long-lived local encoder per runtime (the model loads once: about 12 s on an idle machine). */
const queryEncoder = (runtime: E0Runtime) => {
  const key = encoderKey(runtime);
  let client = clients.get(key);
  if (client === undefined) {
    client = new SemanticClient({
      pythonExecutable: runtime.python,
      snapshotPath: runtime.snapshot,
      workerPath: runtime.worker,
      variant: { kind: "base" },
      requestTimeoutMs: 60_000,
      startupTimeoutMs: 300_000,
      // 6.10: the encoder runs below the worker's other work (its threads are capped at 4).
      niceness: 10,
    });
    clients.set(key, client);
  }
  return client;
};

/** Refusals about the input itself; any other refusal means the encoder process is gone. */
const INPUT_REFUSALS = new Set([
  "invalid-text",
  "invalid-title",
  "unexpected-title",
  "invalid-batch-size",
  "batch-too-large",
  "request-too-large",
  "token-limit-exceeded",
]);

/**
 * Encodes one query. The semantic client stays closed after a timeout or a failed start, so a
 * refusal that is not about the input drops it, and the next query starts a fresh encoder rather
 * than failing for the rest of the worker's life.
 */
export const encodeQuery = async (runtime: E0Runtime, text: string) => {
  const client = queryEncoder(runtime);
  const encoded = await client.encodeBatch([{ role: "code-query", text }]);
  if (encoded.kind === "refusal" && !INPUT_REFUSALS.has(encoded.reason)) {
    if (clients.get(encoderKey(runtime)) === client)
      clients.delete(encoderKey(runtime));
    void client.close();
  }
  return encoded;
};

/** Encodes one query text (role `code-query`); the semantic client's process by default. */
export type QueryEncoder = (
  text: string,
  signal?: AbortSignal,
  spawnProcess?: SemanticSpawn,
) => Promise<BatchResult>;

/** The semantic client's text cap; a longer query is cut at a character boundary, and says so. */
const QUERY_BYTES = 32 * 1024;

export const clipQuery = (text: string) => {
  if (Buffer.byteLength(text) <= QUERY_BYTES) return { text, clipped: false };
  let end = Math.min(text.length, QUERY_BYTES);
  while (end > 0 && Buffer.byteLength(text.slice(0, end)) > QUERY_BYTES) end--;
  return { text: text.slice(0, end), clipped: true };
};

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/**
 * Encodes a query, cut to the model's 8,192 tokens when it is longer, as the benchmark's encoder
 * truncates (sentence-transformers' max_seq_length; dense.ts counts those as truncated). The
 * semantic client refuses an over-long input instead of cutting it, and reports no token count, so
 * the cut is the longest prefix of the text it accepts: refusals are found by tokenizing alone, and
 * only accepted prefixes are encoded. That can differ from a token cut by the last partial word.
 */
export const encodeWithinLimit = async (
  runtime: E0Runtime,
  text: string,
  encode: QueryEncoder = (part) => encodeQuery(runtime, part),
) => {
  const whole = await encode(text);
  if (whole.kind === "encoded" || whole.reason !== "token-limit-exceeded")
    return { encoded: whole, kept: text.length };
  let accepted: { encoded: BatchResult; kept: number } | undefined;
  let low = 0;
  let high = text.length;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    const tried = await encode(text.slice(0, middle));
    if (tried.kind === "encoded") {
      low = middle;
      accepted = { encoded: tried, kept: middle };
    } else if (tried.reason === "token-limit-exceeded") high = middle;
    else return { encoded: tried, kept: 0 };
  }
  return accepted ?? { encoded: whole, kept: 0 };
};

const StoredQuery = {
  parse: (bytes: Uint8Array) =>
    JSON.parse(new TextDecoder().decode(bytes)) as {
      readonly values: ReadonlyArray<number>;
      /** `bytes`: cut to the client's 32 KiB; `tokens`: cut to the model's 8,192 tokens. */
      readonly cut: ReadonlyArray<"bytes" | "tokens">;
      readonly keptCharacters: number;
    },
};

/**
 * A query's vector: stored once per text and encoder identity in the run's store (so a replay and
 * every partition asking the same text read the same vector, and say the same about any cut),
 * else encoded now.
 */
export const queryVector = (
  config: E0Config,
  runtime: E0Runtime,
  text: string,
  /** Another process to encode with (hybrid leads' shared encoder); `config.queries` names it. */
  encode?: QueryEncoder,
) =>
  Effect.gen(function* () {
    const store = yield* Computations.ComputationStore;
    const clipped = clipQuery(text);
    const result = yield* store.run(
      {
        op: "harness.e0-query",
        opVersion: 2,
        inputs: { query: sha256(text) },
        config: { model: config.model, queries: config.queries },
      },
      Effect.tryPromise({
        try: async (signal) => {
          const { encoded, kept } = await encodeWithinLimit(
            runtime,
            clipped.text,
            encode === undefined ? undefined : (text) => encode(text, signal),
          );
          if (encoded.kind === "refusal")
            throw new Error(`the E0 encoder refused: ${encoded.reason}`);
          const cut = [
            ...(clipped.clipped ? (["bytes"] as const) : []),
            ...(kept < clipped.text.length ? (["tokens"] as const) : []),
          ];
          return {
            bytes: new TextEncoder().encode(
              JSON.stringify({
                values: encoded.items[0]!.values,
                cut,
                keptCharacters: kept,
              }),
            ),
            mediaType: "application/json",
          };
        },
        catch: (cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
      }),
    );
    const stored = StoredQuery.parse(result.output);
    return {
      vector: Float32Array.from(stored.values),
      cut: stored.cut,
      keptCharacters: stored.keptCharacters,
      characters: text.length,
      encoded: result.status === "computed",
    };
  });

/** Exact cosine (unit vectors) over the rows; best first, ties by index position. */
export const cosineRanking = (
  vectors: TreeVectors,
  query: Float32Array,
): Array<{ doc: number; score: number }> => {
  const scores = new Float64Array(vectors.docs.length);
  for (let row = 0; row < vectors.docs.length; row++) {
    let sum = 0;
    const offset = row * E0_DIMENSIONS;
    for (let column = 0; column < E0_DIMENSIONS; column++)
      sum += (vectors.matrix[offset + column] ?? 0) * (query[column] ?? 0);
    scores[row] = sum;
  }
  return [...vectors.docs.keys()]
    .sort(
      (a, b) =>
        (scores[b] ?? 0) - (scores[a] ?? 0) ||
        (vectors.docs[a] ?? 0) - (vectors.docs[b] ?? 0),
    )
    .map((row) => ({ doc: vectors.docs[row] ?? 0, score: scores[row] ?? 0 }));
};

/** E0 over a tree's index. Query vectors are computed in the store the caller provides. */
export const e0Retriever = (
  repository: string,
  index: TreeIndex,
  config: E0Config,
  runtime: E0Runtime,
  coverage: string,
): Retriever => ({
  description: {
    id: "e0",
    family: "dense",
    config,
    index: indexRecipe(index.source),
    keyed: { vectors: coverage },
  },
  tree: index.tree,
  search: (query) =>
    Effect.gen(function* () {
      const started = Date.now();
      const vectors = yield* treeVectors(index, runtime);
      const encoded = yield* queryVector(config, runtime, query.text);
      const ranked = yield* cpuWork(
        repositoryOwner(repository),
        Effect.sync(() => cosineRanking(vectors, encoded.vector)),
      );
      const window = query.kinds === undefined ? query.limit : query.limit * 10;
      const results = yield* describeChunks(
        repository,
        index,
        ranked.slice(0, window),
        query,
        "e0",
        "current",
      );
      const gaps: Array<string> = [];
      if (vectors.missing > 0)
        gaps.push(
          `${vectors.missing} of ${index.chunks.length} chunks have no stored E0 vector and were not searched`,
        );
      if (encoded.cut.length > 0)
        gaps.push(
          `the query was cut to its first ${encoded.keptCharacters} of ${encoded.characters} characters (${encoded.cut.map((cut) => (cut === "bytes" ? "the encoder's 32 KiB text limit" : "the model's 8,192 tokens, as the benchmark truncates")).join(" and ")})`,
        );
      return {
        results,
        millis: Date.now() - started,
        coverage: {
          chunks: vectors.docs.length,
          excluded: {
            ...index.excluded,
            ...(vectors.missing > 0 ? { "no-vector": vectors.missing } : {}),
          },
        },
        gaps,
      };
    }).pipe(
      Effect.withSpan("harness.retriever.search", {
        attributes: { "harness.retriever": "e0", "harness.tree": index.tree },
      }),
    ),
});
