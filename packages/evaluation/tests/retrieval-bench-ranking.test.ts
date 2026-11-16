// Coverage, family holdouts and rerank depths remain contracts of Graph-only reruns.
import { expect, test } from "bun:test";
import type { Item } from "../src/retrieval-bench/ranking.ts";
import {
  poolRow,
  regionsFromRow,
  encodePool,
  decodePool,
} from "../src/retrieval-bench/retriever.ts";
import { distinctLineCoverage } from "../src/retrieval-bench/stage-rank.ts";
import { topK } from "../src/retrieval-bench/score/coverage.ts";
const item = (i: number): Item => ({
  key: `a.ts#L${i}-L${i}`,
  chunkId: `a.ts#L${i}-L${i}`,
  path: "a.ts",
  startLine: i,
  endLine: i,
  kind: "code",
  hash: `h${i}`,
  tokens: 10,
});
const source = {
  items: Array.from({ length: 200 }, (_, i) => item(i + 1)),
  scores: Array.from({ length: 200 }, (_, i) => 1 / (i + 1)),
};

test("pool coverage counts distinct lines across overlapping targets and retrieved ranges", () => {
  const targets = [
    { path: "a.ts", startLine: 1, endLine: 5 },
    { path: "a.ts", startLine: 3, endLine: 10 },
    { path: "b.ts", startLine: 1, endLine: 2 },
  ];
  const ranking = {
    items: [
      { ...item(1), endLine: 4 },
      { ...item(3), endLine: 6 },
      { ...item(1), path: "b.ts", endLine: 1 },
      { ...item(1), path: "unrelated.ts", endLine: 100 },
    ],
    scores: [4, 3, 2, 1],
  };
  expect(distinctLineCoverage(targets, topK(ranking, 50))).toBe(7 / 12);
  expect(distinctLineCoverage(targets, [])).toBe(0);
  expect(distinctLineCoverage([], topK(ranking, 50))).toBeNull();
});

test("rerank depth keeps 50, 100 and 150 documents through pool serialization", () => {
  for (const depth of [50, 100, 150]) {
    const row = poolRow(
      {
        arm: `R-depth${depth}`,
        caseId: "c",
        hunkId: "h",
        regions: source.items.map((i, index) => ({
          ...i,
          score: 1 / (index + 1),
        })),
        timing: { millis: 0, stages: {}, cold: false },
      },
      depth,
    );
    const held = decodePool(encodePool([row]))[0];
    expect(held?.regions).toHaveLength(depth);
    expect(held && regionsFromRow(held).length).toBe(depth);
  }
});

test("leave-one-family-out selection never reads the omitted family's result", async () => {
  const { leaveOneFamilyOut } =
    await import("../src/retrieval-bench/stage-rank.ts");
  const result = leaveOneFamilyOut(
    new Map([
      [
        "a",
        [
          { family: "one", caseId: "c1", delta: 1 },
          { family: "two", caseId: "c2", delta: 0 },
        ],
      ],
      [
        "b",
        [
          { family: "one", caseId: "c1", delta: 0 },
          { family: "two", caseId: "c2", delta: 1 },
        ],
      ],
    ]),
  );
  expect(
    result.selected.map((f) => [f.family, f.variant, f.heldOutGain]),
  ).toEqual([
    ["one", "b", 0],
    ["two", "a", 0],
  ]);
  expect(result.gain).toBe(0);
  expect(result.fixed["a"]?.gain).toBe(0.5);
});

test("deeper controls count new pairs and retain all 150 reranked positions", async () => {
  const { Effect } = await import("effect");
  const { Blobs } = await import("@neuve/records-core");
  const { benchStoreLayer } = await import("../src/retrieval-bench/views.ts");
  const { poolDocuments, uniquePairIndices, storePairScores, rerankRow } =
    await import("../src/retrieval-bench/rerank.ts");
  const { MODELS } = await import("../src/retrieval-bench/models.ts");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "depth-pairs-"));
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const occurrences = [];
        for (let i = 1; i <= 150; i++) {
          const blob = yield* (yield* Blobs.BlobStore).put({
            bytes: new TextEncoder().encode(`document ${i}`),
            mediaType: "text/plain",
            retention: "durable",
          });
          occurrences.push({
            chunkId: item(i).key,
            path: "a.ts",
            startLine: i,
            endLine: i,
            hash: blob.blob.hash,
            kind: "code" as const,
            chunkKey: "c",
            position: i - 1,
          });
        }
        const base = {
          repository: "neuve" as const,
          commit: "base",
          viewKey: "v",
          files: [],
          occurrences,
        };
        const query = {
          caseId: "c",
          hunkId: "h",
          repository: "neuve" as const,
          base: "base",
          head: "head",
          path: "a.ts",
          side: "pre" as const,
          startLine: 1,
          endLine: 1,
          symbols: [],
          droppedLines: 0,
          text: "q",
          sha256: "q",
        };
        const answer = {
          arm: "H3-E0",
          caseId: "c",
          hunkId: "h",
          regions: source.items
            .slice(0, 150)
            .map((i, index) => ({ ...i, score: 1 / (index + 1) })),
          timing: { millis: 0, stages: {}, cold: false },
        };
        const seen = new Set<string>();
        for (const depth of [50, 100, 150]) {
          const row = poolRow(answer, depth);
          const docs = yield* poolDocuments(MODELS.R, row, query, base);
          expect(docs.documents).toHaveLength(depth);
          expect(
            uniquePairIndices(query, docs.documents, docs.missing, seen),
          ).toHaveLength(50);
        }
        const row = poolRow(answer, 150),
          docs = yield* poolDocuments(MODELS.R, row, query, base);
        yield* storePairScores(
          MODELS.R,
          query,
          docs.documents,
          Array.from({ length: 150 }, (_, i) => i),
        );
        const reranked = yield* rerankRow(
          MODELS.R,
          "R-depth150",
          row,
          query,
          base,
          undefined,
        );
        expect(reranked.regions).toHaveLength(150);
        expect(reranked.regions[0]?.chunkId).toBe(item(150).key);
        expect(reranked.regions.at(-1)?.chunkId).toBe(item(1).key);
        expect(
          (yield* poolDocuments(MODELS.R, row, query, base)).missing,
        ).toEqual([]);
      }).pipe(Effect.provide(benchStoreLayer(dir))),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Separate Graph outputs are separate candidates even when their directory names match.
test("same-basename outputs retain their own intervals and both reach selection", async () => {
  const { variantName, leaveOneFamilyOut } =
    await import("../src/retrieval-bench/stage-rank.ts");
  const { familyBootstrap } =
    await import("../src/retrieval-bench/score/stats.ts");
  const first = variantName("/run-a/graph", "H3-E0");
  const second = variantName("/run-b/graph", "H3-E0");
  const variants = new Map([
    [
      first,
      [
        { family: "one", caseId: "1", delta: 1 },
        { family: "two", caseId: "2", delta: 0 },
      ],
    ],
    [
      second,
      [
        { family: "one", caseId: "1", delta: -1 },
        { family: "two", caseId: "2", delta: 1 },
      ],
    ],
  ]);
  expect(variants.size).toBe(2);
  expect(
    familyBootstrap(variants.get(first)!, { comparisons: 2, resamples: 8 })
      .observed,
  ).toBe(0.5);
  expect(
    familyBootstrap(variants.get(second)!, { comparisons: 2, resamples: 8 })
      .observed,
  ).toBe(0);
  const selection = leaveOneFamilyOut(variants);
  expect(Object.keys(selection.fixed).sort()).toEqual([first, second].sort());
  expect(selection.selected.map((fold) => fold.variant)).toEqual([
    second,
    first,
  ]);
});
