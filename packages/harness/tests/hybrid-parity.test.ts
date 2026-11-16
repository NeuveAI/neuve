// Why: live hybrid leads must be the benchmark's chosen combination (9.61, 10.117), and the
// harness carries its own copy of the fusion and the model identities its keys use. A copy that
// drifts would rank differently, or key vectors and reranker scores so that none is ever found,
// and nothing would fail. This checks the copies against the benchmark's own code.
import { expect, test } from "bun:test";
import {
  layeredRrf as benchLayeredRrf,
  rrf as benchRrf,
} from "../../evaluation/src/retrieval-bench/fusion.ts";
import {
  MODELS,
  modelIdentity,
} from "../../evaluation/src/retrieval-bench/models.ts";
import {
  DEEP_TOKENS,
  FUSION_INPUT_TOKENS,
  POOL_DEPTH,
} from "../../evaluation/src/retrieval-bench/retriever.ts";
import { chunkId } from "../../evaluation/src/retrieval-bench/corpus.ts";
import { BENCH_E0_IDENTITY } from "../src/e0.ts";
import { localE0Identity } from "../src/hybrid-vectors.ts";
import {
  BENCH_R_IDENTITY,
  fusionId,
  layeredRrf,
  rerankDocument,
  rrf,
} from "../src/hybrid.ts";
import { hybridConfigFor } from "../src/search-config.ts";

/** A seeded generator, so a failure reproduces. */
const random = (seed: number) => () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed / 2_147_483_648;
};

test("the harness's fusion ranks as the benchmark's, ties included", () => {
  const next = random(7);
  for (let round = 0; round < 200; round++) {
    // Small id spaces force shared items and tied scores.
    const list = (length: number) => {
      const ids = new Set<string>();
      while (ids.size < length) ids.add(`c${Math.floor(next() * 40)}`);
      return [...ids];
    };
    const heads = [list(5), list(12), list(12)];
    const deeper = heads.map((head) =>
      [...head, ...list(8)].filter((id, at, all) => all.indexOf(id) === at),
    );
    expect(rrf(heads)).toEqual(benchRrf(heads));
    expect(layeredRrf(heads, deeper)).toEqual(benchLayeredRrf(heads, deeper));
  }
});

test("fusion ids are the benchmark's chunk ids, so tied scores break in its order", () => {
  const index = {
    chunks: [{ path: "src/a.ts", startLine: 3, endLine: 40 }],
  } as unknown as Parameters<typeof fusionId>[0];
  expect(fusionId(index, 0)).toBe(chunkId("src/a.ts", 3, 40));
});

test("the hybrid config's depths are the benchmark's", () => {
  const config = hybridConfigFor(
    {
      prepare: false,
      device: "mps",
      e0: { python: "/p", snapshot: "/s", worker: "/w", vectorStore: "/v" },
      graph: { executable: "/g", workDirectory: "/d" },
      models: 1,
      limits: { minFreeDiskBytes: 1, maxSwapUsedBytes: 2 },
      reranker: { snapshot: "/r", worker: "/w", workerSha256: "f".repeat(64) },
    },
    {
      id: "graph",
      engine: {
        sha256: "b".repeat(64),
        provider: "p",
        version: "v",
        identityRevision: "r",
      },
      profile: "full",
      topK: 50,
    },
  );
  expect(config.fusion.inputTokens).toBe(FUSION_INPUT_TOKENS);
  expect(config.fusion.deepTokens).toBe(DEEP_TOKENS);
  expect(config.fusion.minItems).toBe(POOL_DEPTH);
  expect(config.reranker.depth).toBe(POOL_DEPTH);
  expect(config.members.graph.topK).toBe(POOL_DEPTH);
  // Local vectors are keyed with this machine's device, never the benchmark's.
  expect(config.members.e0.documents.device).toBe("mps");
  // One E0 process: queries are encoded on the chunks' device, so their key says so.
  expect(config.members.e0.queries.device).toBe("mps");
});

test("vector and reranker keys use the benchmark's model identities, with only the device changed", () => {
  expect(BENCH_E0_IDENTITY).toEqual(modelIdentity(MODELS.E0) as never);
  expect(localE0Identity("cpu")).toEqual({
    ...modelIdentity(MODELS.E0),
    device: "cpu",
  } as never);
  expect(BENCH_R_IDENTITY).toEqual(modelIdentity(MODELS.R) as never);
  expect(rerankDocument("a/b.ts", "body\n")).toBe(
    MODELS.R.format.document("a/b.ts", "body\n"),
  );
  expect(MODELS.R.format.query("q")).toBe("q");
});
