import { expect, test } from "bun:test";
import { bm25Ranking, buildIndex, terms } from "../src/retrieval-bench/bm25.ts";
import type { Occurrence, SourceKind } from "../src/retrieval-bench/corpus.ts";
import {
  EQUAL_SHARES,
  quotaInterleave,
  rrf,
} from "../src/retrieval-bench/fusion.ts";
import { projectToChunks } from "../src/retrieval-bench/retriever.ts";
import { checkModalIdentity } from "../src/retrieval-bench/encoder.ts";
import { MODELS } from "../src/retrieval-bench/models.ts";

const occurrence = (
  path: string,
  start: number,
  end: number,
  kind: SourceKind = "code",
): Occurrence => ({
  chunkId: `${path}#L${start}-L${end}`,
  path,
  startLine: start,
  endLine: end,
  hash: `${path}:${start}`,
  kind,
  chunkKey: "k",
  position: 0,
});

// Why: every fused pool (H1 to H3, per-kind RRF) is ordered by these scores and tie-breaks; a change
// to the rank offset or tie order silently reorders every frozen fusion pool.
test("RRF sums 1/(k + rank) per list and breaks ties by id", () => {
  const fused = rrf([
    ["a", "b", "c"],
    ["c", "b", "d"],
  ]);
  expect(fused.map((item) => item.id)).toEqual(["c", "b", "a", "d"]);
  expect(fused[0]?.score).toBeCloseTo(1 / 63 + 1 / 61, 12);
  expect(fused[1]?.score).toBeCloseTo(2 / 62, 12);
  expect(rrf([["y"], ["x"]]).map((item) => item.id)).toEqual(["x", "y"]);
});

// Why: the per-kind quota topology must keep every prefix near each kind's token share and hand an
// empty kind's share to the others; a drift here silently changes which kinds fill a budget.
test("quota interleave keeps token shares on every prefix and skips empty kinds", () => {
  const items = (kind: string, tokens: number, count: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: `${kind}${index}`,
      tokens,
    }));
  const lists = new Map<
    SourceKind,
    ReadonlyArray<{ id: string; tokens: number }>
  >([
    ["code", items("c", 100, 10)],
    ["test", items("t", 50, 10)],
    ["doc", []],
    ["plan", items("p", 200, 10)],
  ]);
  const out = quotaInterleave(lists, EQUAL_SHARES, 12);
  expect(out.map((entry) => entry.item.id).slice(0, 6)).toEqual([
    "c0",
    "t0",
    "p0",
    "t1",
    "c1",
    "t2",
  ]);
  const tokensBy = (kind: SourceKind) =>
    out
      .filter((entry) => entry.kind === kind)
      .reduce((sum, entry) => sum + entry.item.tokens, 0);
  for (const kind of ["code", "test", "plan"] as const)
    expect(tokensBy(kind)).toBeGreaterThanOrEqual(200);
  expect(out.some((entry) => entry.kind === "doc")).toBe(false);
});

// Why: L's terms decide what BM25 can match; losing identifier parts or path terms silently lowers
// lexical recall, and score ties must fall back to chunk-id order for stable pools.
test("BM25 splits identifiers, scores path and body, and orders ties by chunk id", () => {
  expect(terms("recordsClientLayer HTTP_status parseURLPath")).toEqual([
    "recordsclientlayer",
    "records",
    "client",
    "layer",
    "http_status",
    "http",
    "status",
    "parseurlpath",
    "parse",
    "url",
    "path",
  ]);
  const occurrences = [
    occurrence("a.ts", 1, 5),
    occurrence("b.ts", 1, 5),
    occurrence("retry/c.ts", 1, 5),
  ];
  const index = buildIndex([
    "a.ts\nconst value = 1;",
    "b.ts\nconst value = 1;",
    "retry/c.ts\nexport const retryPolicy = 2;",
  ]);
  const ranked = bm25Ranking(index, occurrences, "retry policy value");
  expect(ranked.map((item) => item.occurrence.chunkId)).toEqual([
    "retry/c.ts#L1-L5",
    "a.ts#L1-L5",
    "b.ts#L1-L5",
  ]);
  expect(ranked[1]?.score).toBe(ranked[2]?.score);
});

// Why: Graph regions enter fusion only through this projection; a wrong overlap test silently drops
// or duplicates Graph's evidence in H2 and H3.
test("Graph regions project onto overlapping chunks in rank order without duplicates", () => {
  const index = new Map([
    [
      "a.ts",
      [
        occurrence("a.ts", 1, 10),
        occurrence("a.ts", 11, 20),
        occurrence("a.ts", 21, 30),
      ],
    ],
    ["b.ts", [occurrence("b.ts", 1, 40)]],
  ]);
  const projected = projectToChunks(
    [
      { path: "b.ts", startLine: 5, endLine: 6 },
      { path: "a.ts", startLine: 10, endLine: 11 },
      { path: "a.ts", startLine: 12, endLine: 25 },
      { path: "missing.ts", startLine: 1, endLine: 2 },
    ],
    index,
  );
  expect(projected.map((item) => item.chunkId)).toEqual([
    "b.ts#L1-L40",
    "a.ts#L1-L10",
    "a.ts#L11-L20",
    "a.ts#L21-L30",
  ]);
});

// Why: Modal vectors are stored under the registry entry's computation key; a response computed from
// other weights, without the adapter, in another dtype or with TF32 on, by any one of the parallel
// containers, would otherwise be stored under the wrong identity, and every later read would trust it.
test("every Modal container's response must match the registry entry it is stored under", () => {
  const model = MODELS.E1;
  const identity = {
    hfId: model.hfId,
    revision: model.revision,
    weightFiles: { ...model.weights },
    adapterSha256: model.adapter.sha256,
    device: "cuda",
    dtype: "float32",
  };
  const environment = { gpu: "NVIDIA L40S", tf32: false };
  const receipt = {
    wallSeconds: 1,
    identity,
    environment,
    identities: [identity],
    environments: [environment],
  };
  expect(() => checkModalIdentity(model, receipt, "L40S")).not.toThrow();
  for (const [field, value] of [
    ["adapterSha256", null],
    ["dtype", "bfloat16"],
    ["weightFiles", { "model.safetensors": "0".repeat(64) }],
  ] as const)
    expect(() =>
      checkModalIdentity(
        model,
        { ...receipt, identities: [identity, { ...identity, [field]: value }] },
        "L40S",
      ),
    ).toThrow(/does not match the registry entry/);
  expect(() =>
    checkModalIdentity(
      model,
      {
        ...receipt,
        environments: [environment, { ...environment, tf32: true }],
      },
      "L40S",
    ),
  ).toThrow(/tf32/);
  expect(() =>
    checkModalIdentity(
      model,
      { wallSeconds: 1, identity, environment },
      "L40S",
    ),
  ).toThrow(/no per-container identities/);
});

// Deep answers can contain thousands of ranges. Only the served prefix needs source
// reads and token counts, but the 50-position minimum and empty-text tokens must hold.
test("deep Graph counting stops at the same token cutoff in bounded groups", async () => {
  const { Effect } = await import("effect");
  const { countGraphPrefix } =
    await import("../src/retrieval-bench/run-pools.ts");
  const regions = Array.from({ length: 2000 }, (_, index) => ({
    path: "a.ts",
    startLine: index + 1,
    endLine: index + 1,
    kind: "region" as const,
    symbol: null,
  }));
  const read: number[] = [],
    batches: number[] = [];
  const result = await Effect.runPromise(
    countGraphPrefix(
      regions,
      (regions) => {
        read.push(...regions.map((region) => region.startLine));
        return Effect.succeed(
          regions.map((region) => (region.startLine === 1 ? "" : "source")),
        );
      },
      {
        count: (texts) => {
          batches.push(texts.length);
          return Effect.succeed(
            texts.map((text) => (text === " " ? 1 : 20_000)),
          );
        },
      },
    ),
  );
  expect(result.global.length).toBe(50);
  expect(result.global[0]).toEqual(["a.ts", 1, 1, 0]);
  expect(result.global[49]).toEqual(["a.ts", 50, 50, 20_000]);
  expect(result.total).toBe(980_000);
  expect(batches).toEqual([32, 32]);
  expect(read.length).toBe(64);
  const short = await Effect.runPromise(
    countGraphPrefix(
      regions.slice(0, 3),
      (regions) => Effect.succeed(regions.map(() => "source")),
      {
        count: (texts) => Effect.succeed(texts.map(() => 7)),
      },
    ),
  );
  expect(short).toEqual({
    global: [
      ["a.ts", 1, 1, 7],
      ["a.ts", 2, 2, 7],
      ["a.ts", 3, 3, 7],
    ],
    total: 21,
  });
  const later = await Effect.runPromise(
    countGraphPrefix(
      regions,
      (regions) => Effect.succeed(regions.map(() => "source")),
      {
        count: (texts) => Effect.succeed(texts.map(() => 1000)),
      },
    ),
  );
  expect(later.global.length).toBe(512);
  expect(later.global.at(-1)).toEqual(["a.ts", 512, 512, 1000]);
  expect(later.total).toBe(512_000);
});
