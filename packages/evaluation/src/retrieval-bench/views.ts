import { defaultGraphVariant } from "./graph-chunk.ts";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { Data, Effect, Layer } from "effect";
import { z } from "zod";
import type { BenchChunkVariant } from "./graph-chunk.ts";
import type { BenchChunkedFile } from "./graph-chunk.ts";
import {
  CAPABILITIES,
  CHUNK_RECIPE,
  capabilityFor,
  type CapabilityId,
} from "../../../harness/src/chunker.ts";
import { lsTree, readBlobs, treeOf, type TreeEntry } from "./git.ts";
import {
  INDEX_POLICY,
  POLICY_HASH,
  byCodepoint,
  classifyPath,
  hasGeneratedMarker,
  isBenchmarkPath,
  type CorpusKey,
} from "./policy.ts";

/**
 * Index basis B (proposal, section 6): each case's base is an exact view over a blob-addressed chunk
 * cache. Chunking is a computation per git blob and capability, so a blob shared by many bases is
 * chunked once (5.4); each chunk's text is a content-addressed blob, so B2 encodes each unique chunk
 * once per model. Everything lives in a dedicated benchmark Records store, never the repository's
 * own store under .git/neuve.
 */

const CHUNK_OP = "bench.chunk";
const VIEW_OP = "bench.base-view";
const TEXT = "text/plain; charset=utf-8";
const JSON_TYPE = "application/json";

const ChunkRef = z.strictObject({
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  kind: z.enum(["symbol", "section", "window"]),
  symbol: z.string().nullable(),
  startLine: z.int().positive(),
  endLine: z.int().positive(),
});
const ChunkOutput = z.strictObject({
  capability: z.string(),
  language: z.string(),
  fallback: z
    .enum([
      "parse-error",
      "partial-failure",
      "source-not-parsed",
      "outline-unavailable",
      "capability-unavailable",
      "unsupported-language",
    ])
    .nullable(),
  excluded: z.enum(["binary", "generated-marker", "minified"]).nullable(),
  chunks: z.array(ChunkRef),
});
type ChunkOutput = z.infer<typeof ChunkOutput>;
const ViewOutput = z.strictObject({
  tree: z.string(),
  indexPolicy: z.string(),
  chunkRecipe: z.string(),
  files: z.array(
    z.strictObject({
      path: z.string(),
      blob: z.string(),
      chunkKey: z.string(),
    }),
  ),
  excluded: z.record(z.string(), z.int()),
});
export type ViewOutput = z.infer<typeof ViewOutput>;

export class ViewFailed extends Data.TaggedError("ViewFailed")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** The benchmark's own Records store under `directory` (8.6's location shape, at another root). */
export const benchStoreLayer = (directory: string) => {
  const location = storeLocationIn(directory);
  const store = Store.layer(location, { create: true });
  const prepared = Layer.effectDiscard(Store.prepareForWrite).pipe(
    Layer.provideMerge(store),
  );
  return Computations.layer.pipe(
    Layer.provideMerge(Blobs.layer(location)),
    Layer.provideMerge(prepared),
    Layer.provideMerge(BunFileSystem.layer),
  );
};

const encoder = new TextEncoder();
const json = (value: unknown) => ({
  bytes: encoder.encode(JSON.stringify(value)),
  mediaType: JSON_TYPE,
});
const parse = <T>(schema: z.ZodType<T>, bytes: Uint8Array, what: string) => {
  const parsed = schema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
  return parsed.success
    ? Effect.succeed(parsed.data)
    : Effect.fail(
        new ViewFailed({
          message: `${what}: ${z.prettifyError(parsed.error)}`,
        }),
      );
};

const KEY_CONFIG = {
  recipe: CHUNK_RECIPE,
  indexPolicy: INDEX_POLICY.id,
  policyHash: POLICY_HASH,
  implementations: CAPABILITIES.map((capability) =>
    capability.implementation(),
  ),
};

const chunkSpec = (
  blob: string,
  capability: CapabilityId,
  language: string,
  variant: BenchChunkVariant,
  path: string,
): Computations.ComputationSpec => ({
  op: CHUNK_OP,
  opVersion: 1,
  inputs: { blob: `git-blob:${blob}` },
  // Content exclusions are decided inside this computation, so the policy hash and the installed
  // parser versions are part of its key (5.4): an edited rule or an upgrade never reuses old output.
  config: {
    ...KEY_CONFIG,
    variant: variant.key,
    path,
    capability,
    language,
  },
});

/** Path rules decided from the tree alone; content rules run inside the chunk computation. */
export const pathExclusion = (entry: TreeEntry) => {
  if (entry.type !== "blob")
    return entry.type === "commit" ? "gitlink" : "not-a-blob";
  if (entry.mode === "120000") return "symlink";
  if (isBenchmarkPath(entry.path)) return "benchmark-path";
  const kind = classifyPath(entry.path);
  if (kind === "lockfile" || kind === "generated") return kind;
  if ((entry.size ?? 0) > INDEX_POLICY.maxFileBytes) return "over-size";
  return undefined;
};

export const contentExclusion = (
  bytes: Uint8Array,
  text: string | undefined,
) => {
  if (text === undefined || bytes.subarray(0, 8000).includes(0))
    return "binary" as const;
  if (hasGeneratedMarker(bytes)) return "generated-marker" as const;
  const lines = text.split("\n");
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
  if (
    longest > INDEX_POLICY.maxLineBytes ||
    bytes.length / Math.max(1, lines.length) > INDEX_POLICY.maxMeanLineBytes
  )
    return "minified" as const;
  return undefined;
};

const strictDecoder = new TextDecoder("utf-8", { fatal: true });

/** Chunks one blob and stores every chunk's text as its own blob. */
const chunkBlob = (
  path: string,
  bytes: Uint8Array,
  graphChunked?: BenchChunkedFile,
) =>
  Effect.gen(function* () {
    const blobs = yield* Blobs.BlobStore;
    let text: string | undefined;
    try {
      text = strictDecoder.decode(bytes);
    } catch {
      text = undefined;
    }
    const chunked = graphChunked;
    const excluded = contentExclusion(bytes, text);
    if (excluded === undefined && chunked === undefined)
      return yield* new ViewFailed({
        message: `${path}: missing Graph chunks`,
      });
    const output: ChunkOutput = {
      capability: chunked?.capability ?? "none",
      language: chunked?.language ?? "none",
      fallback: chunked?.fallback ?? null,
      excluded: excluded ?? null,
      chunks: [],
    };
    if (excluded === undefined && chunked !== undefined)
      for (const chunk of chunked.chunks) {
        const stored = yield* blobs.put({
          bytes: encoder.encode(chunk.text),
          mediaType: TEXT,
          retention: "durable",
        });
        if (stored.blob.hash !== chunk.textSha256)
          return yield* new ViewFailed({
            message: `${path}: chunk hash ${stored.blob.hash} is not ${chunk.textSha256}`,
          });
        output.chunks.push({
          hash: chunk.textSha256,
          kind: chunk.kind,
          symbol: chunk.symbol ?? null,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
        });
      }
    return output;
  });

export interface ViewResult {
  readonly corpus: CorpusKey;
  readonly commit: string;
  readonly view: ViewOutput;
  readonly viewKey: string;
  readonly chunks: ReadonlyMap<string, ChunkOutput>;
  readonly status: "computed" | "reused" | "shared";
}

/** Builds (or reuses) the exact base view of `commit`, and returns it with its files' chunk lists. */
export const baseView = (
  corpus: CorpusKey,
  repository: string,
  commit: string,
  selectedVariant?: BenchChunkVariant,
) =>
  Effect.gen(function* () {
    const variant =
      selectedVariant ?? (yield* Effect.tryPromise(defaultGraphVariant));
    const store = yield* Computations.ComputationStore;
    const tree = yield* treeOf(repository, commit);
    const entries = yield* lsTree(repository, commit);
    const viewSpec = {
      op: VIEW_OP,
      opVersion: 1,
      inputs: { tree: `git-tree:${tree}` },
      config: {
        ...KEY_CONFIG,
        variant: variant.key,
      },
    };
    const computeView = Effect.gen(function* () {
      const excluded: Record<string, number> = {};
      const files: Array<{
        path: string;
        blob: string;
        spec: ReturnType<typeof chunkSpec>;
      }> = [];
      for (const entry of [...entries].sort((a, b) =>
        byCodepoint(a.path, b.path),
      )) {
        const reason = pathExclusion(entry);
        if (reason !== undefined) {
          excluded[reason] = (excluded[reason] ?? 0) + 1;
          continue;
        }
        const { capability, language } = capabilityFor(entry.path);
        files.push({
          path: entry.path,
          blob: entry.oid,
          spec: chunkSpec(entry.oid, capability, language, variant, entry.path),
        });
      }
      const keys = files.map(
        (file) => Computations.computationKey(file.spec).key,
      );
      const missing: Array<string> = [];
      for (const [index, file] of files.entries()) {
        const found = yield* store.lookup(keys[index] ?? "");
        if (found._tag === "None") missing.push(file.blob);
      }
      const contents = yield* readBlobs(repository, [...new Set(missing)]);
      const eligible = files.flatMap((file) => {
        const bytes = contents.get(file.blob);
        if (!bytes) return [];
        let text: string | undefined;
        try {
          text = strictDecoder.decode(bytes);
        } catch {}
        return contentExclusion(bytes, text) === undefined
          ? [{ path: file.path, bytes }]
          : [];
      });
      const graphChunks =
        eligible.length === 0
          ? undefined
          : yield* Effect.tryPromise({
              try: (signal) => variant.chunk(eligible, signal),
              catch: (cause) =>
                new ViewFailed({ message: String(cause), cause }),
            });
      for (const [index, file] of files.entries()) {
        const fallback = graphChunks?.get(file.path)?.fallback;
        if (fallback !== undefined) {
          file.spec = {
            ...file.spec,
            config: {
              ...KEY_CONFIG,
              capability: "utf8-line-window-4k-v2",
              language: graphChunks?.get(file.path)?.language ?? "undeclared",
              fallback,
              provider: variant.key.provider,
              variant: variant.key,
              path: file.path,
            },
          };
          keys[index] = Computations.computationKey(file.spec).key;
        }
        const bytes = contents.get(file.blob);
        yield* store.run(
          file.spec,
          Effect.gen(function* () {
            const source =
              bytes ??
              (yield* readBlobs(repository, [file.blob])).get(file.blob) ??
              new Uint8Array();
            return json(
              yield* chunkBlob(file.path, source, graphChunks?.get(file.path)),
            );
          }),
        );
      }
      const finished: Record<string, number> = {};
      for (const [reason, count] of Object.entries(excluded).sort(([a], [b]) =>
        byCodepoint(a, b),
      ))
        finished[reason] = count;
      return json({
        tree,
        indexPolicy: INDEX_POLICY.id,
        chunkRecipe: variant.key.recipe,
        files: files.map((file, index) => ({
          path: file.path,
          blob: file.blob,
          chunkKey: keys[index] ?? "",
        })),
        excluded: finished,
      } satisfies ViewOutput);
    });
    // Re-read Graph chunk keys on each view build, so a transient fallback never freezes the view.
    const result = {
      output: (yield* computeView).bytes,
      status: "computed" as const,
    };
    const view = yield* parse(ViewOutput, result.output, `view ${commit}`);
    const chunks = new Map<string, ChunkOutput>();
    for (const file of view.files) {
      if (chunks.has(file.chunkKey)) continue;
      const held = yield* store.lookup(file.chunkKey);
      if (held._tag === "None")
        return yield* new ViewFailed({
          message: `${file.path}: chunk computation ${file.chunkKey} missing`,
        });
      const read = yield* (yield* Blobs.BlobStore).get(held.value.outputHash);
      if (read._tag === "Pruned")
        return yield* new ViewFailed({
          message: `${file.path}: chunk output pruned`,
        });
      chunks.set(
        file.chunkKey,
        yield* parse(ChunkOutput, read.bytes, file.path),
      );
    }
    return {
      corpus,
      commit,
      view,
      viewKey: Computations.computationKey({
        ...viewSpec,
        config: { ...viewSpec.config, resolvedFiles: view.files },
      }).key,
      chunks,
      status: result.status,
    } satisfies ViewResult;
  });
