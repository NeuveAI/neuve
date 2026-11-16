import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { Effect, Option } from "effect";
import { z } from "zod";
import { observeGraphProvider } from "@neuve/graph-client";
import {
  BASE_REVISION,
  BASE_WEIGHTS_SHA256,
  RERANKER_WORKER_SHA256,
  WORKER_SHA256,
} from "@neuve/semantic-client";
import type { E0Runtime } from "./e0.ts";
import type { GraphRuntime } from "./graph-search.ts";
import { BENCH_R_IDENTITY } from "./hybrid.ts";
import {
  DEFAULT_RETRIEVER,
  E0Config,
  GraphConfig,
  type HybridConfig,
  type RetrieverConfig,
} from "./retriever.ts";
import type { Settings } from "./settings.ts";

/**
 * Investigate's search tools beyond BM25 (10.89) and the retriever its leads come from: what a run
 * is frozen with (`SearchConfig`, in the request and the run key) and what the worker needs on this
 * machine to serve them (`SearchRuntime`, from the user's settings, never keyed). A request resolves
 * both from the settings; the worker resolves the runtime again from the same settings and refuses
 * nothing silently: a tool whose runtime is missing answers with a disclosed gap.
 */

/**
 * How long a review waits on Graph at a time (architecture record 0013): one `graph_search` call,
 * or the review's whole round of lead searches, the waits for a slot and the base's preparation
 * included. Past it the search keeps running and keeps its answer (`GRAPH_SEARCH_DEADLINE_MS`), and
 * the review moves on with a disclosed gap or the keyword search's leads. Set low enough that Graph
 * never sets a review's pace; tuned from the fallback rate and Graph's timings.
 */
export const GRAPH_DEADLINE_MS = 20_000;
/** Graph's pool depth, as the benchmark's G-fork arm and H3's Graph input. */
export const GRAPH_TOP_K = 50;

export const SearchConfig = z.strictObject({
  graph: GraphConfig.nullable(),
  e0: E0Config.nullable(),
  graphDeadlineMs: z.int().min(1_000).max(600_000),
});
export type SearchConfig = z.infer<typeof SearchConfig>;

/** E0 as 9.61 chose it and the benchmark encoded it (arms.dev.json `models.E0`). */
export const E0_RETRIEVER: E0Config = {
  id: "e0",
  model: {
    hfId: "google/embeddinggemma-2",
    revision: BASE_REVISION,
    weightsSha256: BASE_WEIGHTS_SHA256,
    recipe: "embeddinggemma2-code-retrieval-title-path-v1",
  },
  documents: {
    contract: "bench.encode-chunk@1",
    device: "cuda",
    dtype: "float32",
  },
  queries: {
    encoder: "semantic-client-base",
    workerSha256: WORKER_SHA256,
    device: "cpu",
    dtype: "float32",
  },
};

/** What hybrid leads need here (settings `search.hybrid`), apart from the agents' search tools. */
export interface HybridRuntime {
  /** Commit-time model work is on (10.118); off unless the settings say so. */
  readonly prepare: boolean;
  readonly device: "cpu" | "mps";
  /** E0's encoder: chunk vectors on `device`, query vectors on the CPU. */
  readonly e0: E0Runtime;
  readonly graph: GraphRuntime;
  /** Model processes resident at once (settings `models`, 1 unless set). */
  readonly models: number;
  /** A job pauses before a hunk below this free disk or above this swap in use. */
  readonly limits: {
    readonly minFreeDiskBytes: number;
    readonly maxSwapUsedBytes: number;
  };
  readonly reranker: {
    readonly snapshot: string;
    readonly worker: string;
    readonly workerSha256: string;
  };
}

export interface SearchRuntime {
  readonly graph?: GraphRuntime | undefined;
  readonly e0?: E0Runtime | undefined;
  readonly hybrid?: HybridRuntime | undefined;
  /** Frozen leads files by SHA-256. */
  readonly frozen: ReadonlyMap<string, string>;
  /** Why a configured tool has no runtime here, by tool. */
  readonly problems: Readonly<Record<string, string>>;
}

let current: SearchRuntime = { frozen: new Map(), problems: {} };

/** The worker's search runtime, set once at start from the user's settings. */
export const setSearchRuntime = (runtime: SearchRuntime) => {
  current = runtime;
};
export const searchRuntime = () => current;

const executable = (path: string) => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

// Keep discovery aligned with the CLI's discoverGraphBinary; the release tests check parity.
export const discoverSearchGraphBinary = (
  input: Readonly<{ override: string | undefined; executable: string }> = {
    override: process.env.NEUVE_GRAPH_BINARY,
    executable: process.execPath,
  },
): string => {
  if (input.override !== undefined) {
    if (!executable(input.override))
      throw new Error(
        `NEUVE_GRAPH_BINARY does not name an executable file: ${input.override}`,
      );
    return resolve(input.override);
  }
  const directory = dirname(realpathSync(input.executable));
  const installed = resolve(directory, "../lib/neuve/entire-graph");
  if (executable(installed)) return installed;
  const sibling = resolve(directory, "../../neuve-graph/entire-graph");
  if (!executable(sibling))
    throw new Error(
      `Neuve Graph binary is unavailable at ${installed} or ${sibling}; run bun run install:cli, build it, or set NEUVE_GRAPH_BINARY.`,
    );
  return sibling;
};

/**
 * A semantic-client worker script (`worker.py` by default): beside its sources in the workspace,
 * else the installed copy beside the CLI (`bun run install:cli`: `<prefix>/lib/neuve/semantic/`),
 * which a compiled binary needs because it cannot ship Python files inside itself.
 */
const semanticWorker = (file = "worker.py") => {
  try {
    const require = createRequire(import.meta.url);
    const beside = join(
      dirname(require.resolve("@neuve/semantic-client")),
      file,
    );
    if (existsSync(beside)) return beside;
  } catch {
    // Not in the workspace: the installed copy below.
  }
  const installed = resolve(
    dirname(realpathSync(process.execPath)),
    "../lib/neuve/semantic",
    file,
  );
  return existsSync(installed) ? installed : undefined;
};

const sha256File = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

const GIB = 1024 ** 3;

const sameFile = (path: string, sha256: string) => {
  try {
    return sha256File(path) === sha256;
  } catch {
    return false;
  }
};

/**
 * What the settings give this machine. `storeDirectory` is the Records store's folder: Graph's
 * clones and snapshot cache live under it, so they go with the store.
 */
export const searchRuntimeFrom = (
  settings: Option.Option<Settings>,
  storeDirectory: string,
  discovery = {
    override: process.env.NEUVE_GRAPH_BINARY,
    executable: process.execPath,
  },
): SearchRuntime => {
  const search = Option.getOrUndefined(settings)?.search;
  const problems: Record<string, string> = {};
  let graph: GraphRuntime | undefined;
  if (search?.graph !== undefined) {
    try {
      const path =
        search.graph.executable ?? discoverSearchGraphBinary(discovery);
      if (isAbsolute(path) && executable(path))
        graph = {
          executable: path,
          workDirectory: join(storeDirectory, "graph"),
        };
      else problems["graph_search"] = `no Graph engine at ${path}`;
    } catch (error) {
      problems["graph_search"] = String(error);
    }
  }
  let e0: E0Runtime | undefined;
  if (search?.e0 !== undefined) {
    const worker = search.e0.worker ?? semanticWorker();
    const paths = [
      search.e0.python,
      search.e0.snapshot,
      search.e0.vectorStore,
      worker ?? "",
    ];
    if (worker === undefined)
      problems["semantic_search"] = "no semantic-client worker script found";
    else if (!paths.every(isAbsolute))
      problems["semantic_search"] =
        "the E0 python, snapshot, vector store and worker must be absolute paths";
    else e0 = { ...search.e0, worker };
  }
  let hybrid: HybridRuntime | undefined;
  if (search?.hybrid !== undefined) {
    const setup = search.hybrid;
    const reranker =
      setup.reranker.worker ?? semanticWorker("reranker_worker.py");
    const encoder = setup.e0.worker ?? semanticWorker();
    let engine: string | undefined;
    try {
      engine = setup.graph?.executable ?? discoverSearchGraphBinary(discovery);
    } catch (error) {
      problems["hybrid"] = String(error);
    }
    const paths = [setup.python, setup.e0.snapshot, setup.reranker.snapshot];
    if (engine !== undefined) {
      if (reranker === undefined || encoder === undefined)
        problems["hybrid"] = "no semantic-client worker scripts found";
      else if (![...paths, engine, reranker, encoder].every(isAbsolute))
        problems["hybrid"] =
          "the hybrid Python, snapshots, Graph engine and workers must be absolute paths";
      else if (!executable(engine))
        problems["hybrid"] = `no Graph engine at ${engine}`;
      else if (!sameFile(reranker, RERANKER_WORKER_SHA256))
        problems["hybrid"] =
          `the reranker worker at ${reranker} is not the one this build expects`;
      else
        try {
          hybrid = {
            prepare: setup.prepare === true,
            device: setup.device,
            models: setup.models ?? 1,
            limits: {
              minFreeDiskBytes: (setup.limits?.minFreeDiskGiB ?? 13) * GIB,
              maxSwapUsedBytes: (setup.limits?.maxSwapUsedGiB ?? 15) * GIB,
            },
            e0: {
              python: setup.python,
              snapshot: setup.e0.snapshot,
              worker: encoder,
              // Hybrid's chunk vectors live in the repository's own store (hybrid-vectors.ts).
              vectorStore: storeDirectory,
            },
            graph: {
              executable: engine,
              workDirectory: join(storeDirectory, "graph"),
            },
            reranker: {
              snapshot: setup.reranker.snapshot,
              worker: reranker,
              workerSha256: RERANKER_WORKER_SHA256,
            },
          };
        } catch (error) {
          problems["hybrid"] =
            `the reranker worker is unreadable: ${String(error)}`;
        }
    }
  }
  const frozen = new Map<string, string>();
  const leads = search?.leads;
  if (leads !== undefined && typeof leads === "object")
    try {
      frozen.set(sha256File(leads.frozen.file), leads.frozen.file);
    } catch (error) {
      problems["leads"] =
        `the frozen leads file is unreadable: ${String(error)}`;
    }
  return { graph, e0, hybrid, frozen, problems };
};

/** The Graph engine's identity, as its provider reports it through graph-client. */
export const graphConfigFor = (runtime: GraphRuntime) =>
  Effect.map(
    observeGraphProvider({ executable: runtime.executable }),
    (provider): GraphConfig => ({
      id: "graph",
      engine: {
        sha256: provider.executable.sha256,
        provider: provider.name,
        version: provider.version,
        identityRevision: provider.identityRevision,
      },
      profile: "full",
      topK: GRAPH_TOP_K,
    }),
  );

/**
 * Hybrid leads as the runtime serves them (9.61, 10.117): BM25, E0 over chunk vectors encoded on
 * this machine (the benchmark's contract, this device), Graph's pool answer, the benchmark's
 * fusion settings and the reranker on this device.
 */
export const hybridConfigFor = (
  hybrid: HybridRuntime,
  graph: GraphConfig,
): HybridConfig => ({
  id: "hybrid",
  members: {
    bm25: DEFAULT_RETRIEVER,
    e0: {
      ...E0_RETRIEVER,
      // One encoder process serves the chunks and the queries, on the chunks' device.
      queries: { ...E0_RETRIEVER.queries, device: hybrid.device },
      documents: {
        contract: "bench.encode-chunk@1",
        device: hybrid.device,
        dtype: "float32",
        encoder: { name: "semantic-client-base", workerSha256: WORKER_SHA256 },
      },
    },
    graph,
  },
  fusion: {
    method: "layered-rrf",
    k: 60,
    inputTokens: 256_000,
    deepTokens: 512_000,
    minItems: 50,
    tokens: "chunk-estimate",
  },
  reranker: {
    model: {
      hfId: BENCH_R_IDENTITY.hfId,
      revision: BENCH_R_IDENTITY.revision,
      weightsSha256: BENCH_R_IDENTITY.weights["model.safetensors"],
      recipe: BENCH_R_IDENTITY.recipe,
      instruction: BENCH_R_IDENTITY.rerank.instruction,
    },
    runner: {
      workerSha256: hybrid.reranker.workerSha256,
      device: hybrid.device,
      dtype: "float32",
    },
    depth: 50,
  },
});

/** A leads choice the request names over the settings' (`neuve review --leads`). */
export type LeadsChoice = "bm25" | "hybrid";

/**
 * What a request is frozen with: the search tools its runtime can serve, and the leads retriever
 * (BM25 unless the settings name another). A leads choice the runtime cannot serve fails the
 * request, so no run silently falls back to BM25 under another name.
 */
export const resolveSearch = (
  runtime: SearchRuntime,
  settings: Option.Option<Settings>,
  override?: LeadsChoice | undefined,
) =>
  Effect.gen(function* () {
    const choice = Option.getOrUndefined(settings)?.search;
    const graph =
      runtime.graph === undefined ? null : yield* graphConfigFor(runtime.graph);
    const e0 = runtime.e0 === undefined ? null : E0_RETRIEVER;
    const search: SearchConfig | undefined =
      graph === null && e0 === null
        ? undefined
        : {
            graph,
            e0,
            graphDeadlineMs: GRAPH_DEADLINE_MS,
          };
    const leadsChoice = override ?? choice?.leads ?? "bm25";
    let leads: RetrieverConfig = DEFAULT_RETRIEVER;
    if (typeof leadsChoice === "object") {
      const sha = [...runtime.frozen.entries()].find(
        ([, path]) => path === leadsChoice.frozen.file,
      )?.[0];
      if (sha === undefined)
        return yield* Effect.fail(
          new Error(
            runtime.problems["leads"] ?? "the frozen leads file is unreadable",
          ),
        );
      leads = {
        id: "frozen",
        candidate: leadsChoice.frozen.candidate,
        sha256: sha,
        fallback: DEFAULT_RETRIEVER,
      };
    } else if (leadsChoice === "hybrid") {
      if (runtime.hybrid === undefined)
        return yield* Effect.fail(
          new Error(
            `hybrid leads are not set up on this machine${runtime.problems["hybrid"] === undefined ? " (no search.hybrid in the Neuve settings)" : ` (${runtime.problems["hybrid"]})`}`,
          ),
        );
      leads = hybridConfigFor(
        runtime.hybrid,
        yield* graphConfigFor(runtime.hybrid.graph),
      );
    } else if (leadsChoice !== "bm25") {
      const chosen = leadsChoice === "graph" ? graph : e0;
      if (chosen === null)
        return yield* Effect.fail(
          new Error(
            `the settings take leads from ${leadsChoice}, which this machine cannot serve${Object.keys(runtime.problems).length === 0 ? "" : ` (${Object.values(runtime.problems).join("; ")})`}`,
          ),
        );
      leads = chosen;
    }
    return { search, leads };
  });
