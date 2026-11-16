import type { BenchChunkVariant } from "./graph-chunk.ts";
import { Effect, Option } from "effect";
import {
  KINDS,
  kindOf,
  loadBase,
  type BaseCorpus,
  type Case,
  type Occurrence,
  type SourceKind,
} from "./corpus.ts";
import {
  EQUAL_SHARES,
  layeredRrf,
  quotaInterleave,
  rrf,
  h3CandidateLists,
} from "./fusion.ts";
import { changedSymbols } from "./graph.ts";
import { DENSE_IDS } from "./models.ts";
import type { CorpusKey } from "./policy.ts";
import type { HunkQuery } from "./queries.ts";
import {
  DEEP_TOKENS,
  FUSION_INPUT_TOKENS,
  POOL_DEPTH,
  byPath,
  decodePool,
  poolFile,
  projectToChunks,
  regionsFromRow,
  type PoolRow,
} from "./retriever.ts";
import { storedAnswer } from "./run-graph.ts";
import { deepSpec, describeArms, graphDeepSpec } from "./run-pools.ts";
import { readStoredJson } from "./stored.ts";
import { chunkTokens } from "./tokens.ts";
import { spanKey, type Item, type Ranking } from "./ranking.ts";

/**
 * Every arm's ranking per dev hunk, read without re-running anything: the frozen top 50 from
 * `pools/dev/<arm>.jsonl.gz`, and the deep rankings up to DEEP_TOKENS (512k) from the benchmark
 * Records store (B2). Chunk arms' deep rankings are stored as ranked chunk ids (overall and per
 * kind); the per-kind topologies and fusions are rebuilt from them exactly as B2 builds their pools
 * (fusions over inputs cut at FUSION_INPUT_TOKENS, extended by the deeper inputs), and each rebuilt
 * ranking's first 50 is checked against the frozen pool. Graph arms' deep answers are stored as cut
 * regions with token counts. Each reranked arm (R over H3-E2, R(<arm>) over another, 9.57) is its
 * frozen top 50 (reranked) followed by the rest of its candidate arm's deep ranking.
 */

export const GRAPH_ARMS = ["G-fork", "G-fork-syntax", "G-base"] as const;
export type GraphArm = (typeof GRAPH_ARMS)[number];
const GRAPH_MODES: Record<
  GraphArm,
  "prepared-full" | "prepared-syntax" | "refresh-full"
> = {
  "G-fork": "prepared-full",
  "G-fork-syntax": "prepared-syntax",
  "G-base": "refresh-full",
};
const TOPOLOGIES = ["", "@kind-rrf", "@kind-quota"] as const;

export const poolItem = (
  region: ReturnType<typeof regionsFromRow>[number],
): Item => ({
  key: spanKey(region.path, region.startLine, region.endLine),
  path: region.path,
  startLine: region.startLine,
  endLine: region.endLine,
  kind: region.kind,
  tokens: region.tokens,
  chunkId: region.chunkId,
  hash: null,
});

export const rankingFromRow = (row: PoolRow): Ranking => {
  const regions = regionsFromRow(row);
  return {
    items: regions.map(poolItem),
    scores: regions.map((region) => region.score),
  };
};

/** Frozen pools for every arm file present, keyed arm → hunk. */
export const loadPools = async (
  directory: string,
  arms: ReadonlyArray<string>,
) => {
  const out = new Map<string, Map<string, PoolRow>>();
  for (const arm of arms) {
    const file = Bun.file(poolFile(directory, arm));
    if (!(await file.exists())) continue;
    const rows = decodePool(new Uint8Array(await file.arrayBuffer()));
    out.set(arm, new Map(rows.map((row) => [row.hunkId, row])));
  }
  return out;
};

/** Cut a ranked list at `maxTokens` cumulative tokens, keeping at least POOL_DEPTH items (B2's rule). */
const cutDeep = (
  items: ReadonlyArray<Item>,
  scores: ReadonlyArray<number>,
  maxTokens = DEEP_TOKENS,
): Ranking => {
  const outItems: Array<Item> = [];
  const outScores: Array<number> = [];
  let total = 0;
  for (const [index, item] of items.entries()) {
    if (outItems.length >= POOL_DEPTH && total >= maxTokens) break;
    total += item.tokens;
    outItems.push(item);
    outScores.push(scores[index] ?? 0);
  }
  return { items: outItems, scores: outScores };
};

export interface GraphFailure {
  readonly arm: string;
  readonly hunkId: string;
  readonly caseId: string;
  readonly depth: "pool" | "deep";
  readonly error: string;
}

export interface LoadedRankings {
  /** arm → hunk → ranking (deep where stored, else the frozen pool). */
  readonly rankings: Map<string, Map<string, Ranking>>;
  /** Which arms' rankings go past the pool (deep) and for how many hunks. */
  readonly depth: Record<string, { deep: number; poolOnly: number }>;
  /** arm → hunks read only at the frozen top 50 (no deep ranking stored), for mixed-depth pairs. */
  readonly poolOnlyHunks: Map<string, Set<string>>;
  /** Rebuilt rankings whose first 50 differ from the frozen pool: an input integrity check. */
  readonly poolMismatches: Record<string, ReadonlyArray<string>>;
  readonly graphFailures: ReadonlyArray<GraphFailure>;
  /** Chunk population per repository (for the hub measure's skew), as span keys. */
  readonly population: Map<CorpusKey, Set<string>>;
  readonly bases: ReadonlyArray<BaseCorpus>;
  /** Counting-tokenizer tokens of every chunk of a base, keyed `repository:commit`. */
  readonly baseTokens: Map<string, number>;
  /** G-fork's pool answer projected onto chunks (the Graph list of H2, H3 and V4), 1 / (rank + 1). */
  readonly forkChunks: Map<string, Ranking>;
}

const sameSpans = (ranking: Ranking, row: PoolRow) => {
  const head = ranking.items.slice(0, row.regions.length);
  return (
    head.length === row.regions.length &&
    head.every(
      (item, index) =>
        item.path === row.regions[index]?.[0] &&
        item.startLine === row.regions[index]?.[1] &&
        item.endLine === row.regions[index]?.[2],
    )
  );
};

/** Pool-only rankings: every arm read at its frozen top 50 (no store needed). */
export const poolRankings = (pools: Map<string, Map<string, PoolRow>>) => {
  const rankings = new Map<string, Map<string, Ranking>>();
  for (const [arm, rows] of pools)
    rankings.set(
      arm,
      new Map([...rows].map(([hunkId, row]) => [hunkId, rankingFromRow(row)])),
    );
  return rankings;
};

export interface DeepInputs {
  readonly variant?: BenchChunkVariant | undefined;
  readonly cases: ReadonlyArray<Case>;
  readonly queries: ReadonlyMap<string, HunkQuery>;
  readonly repositories: Record<CorpusKey, string>;
  readonly pools: Map<string, Map<string, PoolRow>>;
  /** Engine SHA-256 per Graph engine, from arms.dev.json (graph.build). */
  readonly engines: { readonly fork: string; readonly base: string };
  /** Each reranked arm and the arm it reranked (arms.dev.json rerank and reranks). */
  readonly reranks: ReadonlyArray<{
    readonly arm: string;
    readonly candidates: string;
  }>;
  /**
   * Recorded causes of Graph plans without a usable answer, keyed `arm:depth:hunkId` (arms.dev.json
   * graph.failures, the latest attempt); a failure with none recorded says so.
   */
  readonly graphFailureCauses: ReadonlyMap<string, string>;
  readonly log: (line: string) => void;
}

export const loadDeepRankings = (inputs: DeepInputs) =>
  Effect.gen(function* () {
    const descriptions = new Map(
      describeArms([...DENSE_IDS]).map((entry) => [entry.arm, entry]),
    );
    const rankings = new Map<string, Map<string, Ranking>>();
    const set = (arm: string, hunkId: string, ranking: Ranking) => {
      const map = rankings.get(arm) ?? new Map<string, Ranking>();
      map.set(hunkId, ranking);
      rankings.set(arm, map);
    };
    const depth: Record<string, { deep: number; poolOnly: number }> = {};
    const poolOnlyHunks = new Map<string, Set<string>>();
    const count = (arm: string, hunkId: string, deep: boolean) => {
      const entry = (depth[arm] ??= { deep: 0, poolOnly: 0 });
      if (deep) entry.deep++;
      else {
        entry.poolOnly++;
        poolOnlyHunks.set(
          arm,
          (poolOnlyHunks.get(arm) ?? new Set<string>()).add(hunkId),
        );
      }
    };
    const poolMismatches: Record<string, Array<string>> = {};
    const check = (arm: string, hunkId: string, ranking: Ranking) => {
      const row = inputs.pools.get(arm)?.get(hunkId);
      if (row !== undefined && !sameSpans(ranking, row))
        (poolMismatches[arm] ??= []).push(hunkId);
    };
    const poolRanking = (arm: string, hunkId: string): Ranking => {
      const row = inputs.pools.get(arm)?.get(hunkId);
      return row === undefined
        ? { items: [], scores: [] }
        : rankingFromRow(row);
    };
    const graphFailures: Array<GraphFailure> = [];
    const population = new Map<CorpusKey, Set<string>>();
    const bases: Array<BaseCorpus> = [];
    const baseTokens = new Map<string, number>();
    const forkChunks = new Map<string, Ranking>();
    const known = new Map<string, ReadonlyArray<number>>();

    const byBase = new Map<string, Array<Case>>();
    for (const entry of inputs.cases) {
      const key = `${entry.repository}:${entry.base}`;
      byBase.set(key, [...(byBase.get(key) ?? []), entry]);
    }
    for (const [baseKey, entries] of [...byBase].sort(([a], [b]) =>
      a < b ? -1 : 1,
    )) {
      const first = entries[0] as Case;
      const started = performance.now();
      const base = yield* loadBase(
        first.repository,
        inputs.repositories[first.repository],
        first.base,
        inputs.variant,
      );
      bases.push(base);
      yield* chunkTokens(base, undefined, known);
      const pool = population.get(base.repository) ?? new Set<string>();
      const items = new Map<string, Item>();
      for (const occurrence of base.occurrences) {
        pool.add(occurrence.chunkId);
        items.set(occurrence.chunkId, {
          key: occurrence.chunkId,
          path: occurrence.path,
          startLine: occurrence.startLine,
          endLine: occurrence.endLine,
          kind: occurrence.kind,
          tokens: known.get(occurrence.chunkKey)?.[occurrence.position] ?? 0,
          chunkId: occurrence.chunkId,
          hash: occurrence.hash,
        });
      }
      population.set(base.repository, pool);
      baseTokens.set(
        baseKey,
        [...items.values()].reduce((sum, item) => sum + item.tokens, 0),
      );
      const pathIndex = byPath(base);
      const itemOf = (id: string) => {
        const item = items.get(id);
        if (item === undefined)
          throw new Error(`${baseKey}: ${id} is not a chunk of the base`);
        return item;
      };
      const fromPairs = (
        pairs: ReadonlyArray<readonly [string, number]>,
      ): Ranking => ({
        items: pairs.map(([id]) => itemOf(id)),
        scores: pairs.map(([, score]) => score),
      });

      for (const entry of entries)
        for (const hunk of entry.hunks) {
          const query = inputs.queries.get(hunk.id);
          if (query === undefined) throw new Error(`no query for ${hunk.id}`);
          // Chunk arms: overall deep ranking and the per-kind lists, then both topologies.
          const globals = new Map<string, Ranking>();
          for (const arm of ["L", ...DENSE_IDS].filter((arm) =>
            inputs.pools.has(arm),
          )) {
            const stored = yield* readStoredJson<{
              global: Array<[string, number]>;
              perKind: Record<SourceKind, Array<[string, number]>>;
            }>(deepSpec(arm, descriptions.get(arm)?.config, base, query));
            if (Option.isNone(stored)) {
              for (const topology of TOPOLOGIES) {
                set(
                  `${arm}${topology}`,
                  hunk.id,
                  poolRanking(`${arm}${topology}`, hunk.id),
                );
                count(`${arm}${topology}`, hunk.id, false);
              }
              continue;
            }
            const global = fromPairs(stored.value.global);
            globals.set(arm, global);
            set(arm, hunk.id, global);
            const perKind = new Map<SourceKind, Ranking>(
              KINDS.map((kind) => [
                kind,
                fromPairs(stored.value.perKind[kind] ?? []),
              ]),
            );
            const kindRrf = rrf(
              KINDS.map((kind) =>
                (perKind.get(kind)?.items ?? []).map((item) => item.key),
              ),
            );
            set(
              `${arm}@kind-rrf`,
              hunk.id,
              cutDeep(
                kindRrf.map((entry) => itemOf(entry.id)),
                kindRrf.map((entry) => entry.score),
              ),
            );
            const quotaLists = new Map<
              SourceKind,
              ReadonlyArray<{ tokens: number; item: Item; score: number }>
            >(
              KINDS.map((kind) => {
                const ranking = perKind.get(kind) as Ranking;
                return [
                  kind,
                  ranking.items.map((item, index) => ({
                    tokens: item.tokens,
                    item,
                    score: ranking.scores[index] ?? 0,
                  })),
                ];
              }),
            );
            const quota = quotaInterleave(
              quotaLists,
              EQUAL_SHARES,
              Number.MAX_SAFE_INTEGER,
            );
            const quotaItems: Array<Item> = [];
            const quotaScores: Array<number> = [];
            let quotaTokens = 0;
            for (const { item } of quota) {
              if (quotaItems.length >= POOL_DEPTH && quotaTokens >= DEEP_TOKENS)
                break;
              quotaItems.push(item.item);
              quotaScores.push(item.score);
              quotaTokens += item.tokens;
            }
            set(`${arm}@kind-quota`, hunk.id, {
              items: quotaItems,
              scores: quotaScores,
            });
            for (const topology of TOPOLOGIES) {
              count(`${arm}${topology}`, hunk.id, true);
              check(
                `${arm}${topology}`,
                hunk.id,
                rankings.get(`${arm}${topology}`)?.get(hunk.id) as Ranking,
              );
            }
          }

          // Graph arms: errors of the pool answers, then the stored deep cut.
          const symbols = yield* changedSymbols(
            inputs.repositories[entry.repository],
            entry,
            hunk,
            inputs.variant,
          ).pipe(Effect.orElseSucceed(() => [] as Array<string>));
          let forkRegions: ReadonlyArray<{
            path: string;
            startLine: number;
            endLine: number;
          }> = [];
          for (const arm of GRAPH_ARMS.filter((arm) => inputs.pools.has(arm))) {
            const engine =
              arm === "G-base" ? inputs.engines.base : inputs.engines.fork;
            const plan = (planDepth: "pool" | "deep") =>
              ({
                arm,
                depth: planDepth,
                engine,
                input: {
                  executable: "",
                  clone: "",
                  cacheDirectory: "",
                  temporaryParent: "",
                  commit: entry.base,
                  query,
                  mode: GRAPH_MODES[arm],
                  depth: planDepth,
                  ...(arm === "G-fork" && planDepth === "pool"
                    ? { symbols, symbolPath: hunk.oldPath }
                    : {}),
                },
              }) satisfies Parameters<typeof storedAnswer>[0];
            const recorded = (planDepth: "pool" | "deep") =>
              inputs.graphFailureCauses.get(`${arm}:${planDepth}:${hunk.id}`) ??
              "no usable answer stored and no failure recorded";
            const poolAnswer = yield* storedAnswer(plan("pool"));
            const poolError = Option.isNone(poolAnswer)
              ? recorded("pool")
              : poolAnswer.value.error;
            if (arm === "G-fork" && Option.isSome(poolAnswer))
              forkRegions = poolAnswer.value.regions;
            if (poolError !== null)
              graphFailures.push({
                arm,
                hunkId: hunk.id,
                caseId: entry.id,
                depth: "pool",
                error: poolError,
              });
            if (
              arm === "G-fork" &&
              inputs.pools.has("S-ref") &&
              Option.isSome(poolAnswer) &&
              poolAnswer.value.error === null
            ) {
              // S-ref rides on G-fork's pool answer: record its empty answers too.
              if (poolAnswer.value.neighbors.length === 0)
                graphFailures.push({
                  arm: "S-ref",
                  hunkId: hunk.id,
                  caseId: entry.id,
                  depth: "pool",
                  error: `empty: ${symbols.length} changed symbols; relationships ${poolAnswer.value.relationships.map((r) => `${r.id}=${r.outcome}`).join(", ") || "none"}`,
                });
            }
            const deepAnswer = yield* storedAnswer(plan("deep"));
            if (Option.isNone(deepAnswer) || deepAnswer.value.error !== null) {
              graphFailures.push({
                arm,
                hunkId: hunk.id,
                caseId: entry.id,
                depth: "deep",
                error: Option.isNone(deepAnswer)
                  ? recorded("deep")
                  : (deepAnswer.value.error as string),
              });
              set(arm, hunk.id, poolRanking(arm, hunk.id));
              count(arm, hunk.id, false);
              continue;
            }
            const stored = yield* readStoredJson<{
              global: Array<[string, number, number, number]>;
            }>(
              graphDeepSpec(
                arm,
                descriptions.get(arm)?.config,
                engine,
                deepAnswer.value.regions,
                base,
                query,
              ),
            );
            if (Option.isNone(stored)) {
              graphFailures.push({
                arm,
                hunkId: hunk.id,
                caseId: entry.id,
                depth: "deep",
                error: "deep answer stored but its token cut is not",
              });
              set(arm, hunk.id, poolRanking(arm, hunk.id));
              count(arm, hunk.id, false);
              continue;
            }
            const graphItems = stored.value.global.map(
              ([path, startLine, endLine, tokens]) => ({
                key: spanKey(path, startLine, endLine),
                path,
                startLine,
                endLine,
                kind: kindOf(path),
                tokens,
                chunkId: null,
                hash: null,
              }),
            );
            set(arm, hunk.id, {
              items: graphItems,
              scores: graphItems.map((_, rank) => 1 / (rank + 1)),
            });
            count(arm, hunk.id, true);
          }
          if (inputs.pools.has("S-ref")) {
            const sref = poolRanking("S-ref", hunk.id);
            set("S-ref", hunk.id, sref);
            count("S-ref", hunk.id, false);
          }

          // Fusions: G-fork's whole pool answer projected onto chunks, L and each dense arm (B2's lists),
          // each cut at FUSION_INPUT_TOKENS and extended by its deep ranking.
          const graphIds = projectToChunks(forkRegions, pathIndex).map(
            (occurrence: Occurrence) => occurrence.chunkId,
          );
          forkChunks.set(hunk.id, {
            items: graphIds.map((id) => itemOf(id)),
            scores: graphIds.map((_, rank) => 1 / (rank + 1)),
          });
          const input = (ranking: Ranking | undefined) =>
            ranking === undefined
              ? undefined
              : {
                  head: cutDeep(
                    ranking.items,
                    ranking.scores,
                    FUSION_INPUT_TOKENS,
                  ).items.map((item) => item.key),
                  deep: ranking.items.map((item) => item.key),
                };
          const lexical = input(globals.get("L"));
          const graph = { head: graphIds, deep: graphIds };
          for (const id of DENSE_IDS.filter((id) => inputs.pools.has(id))) {
            const dense = input(globals.get(id));
            for (const [arm, lists] of [
              [`H1-${id}`, [lexical, dense]],
              [`H2-${id}`, [graph, dense]],
              [`H3-${id}`, h3CandidateLists(graph, lexical, dense)],
            ] as const) {
              if (lists.some((list) => list === undefined)) {
                set(arm, hunk.id, poolRanking(arm, hunk.id));
                count(arm, hunk.id, false);
                continue;
              }
              const present = lists as ReadonlyArray<{
                head: ReadonlyArray<string>;
                deep: ReadonlyArray<string>;
              }>;
              const fused = layeredRrf(
                present.map((list) => list.head),
                present.map((list) => list.deep),
              );
              const ranking = cutDeep(
                fused.map((item) => itemOf(item.id)),
                fused.map((item) => item.score),
              );
              set(arm, hunk.id, ranking);
              count(arm, hunk.id, true);
              check(arm, hunk.id, ranking);
            }
          }

          // Each reranked arm: the reranked top 50, then the candidate arm's deep ranking past
          // those items.
          for (const { arm, candidates: from } of inputs.reranks) {
            const reranked = poolRanking(arm, hunk.id);
            const candidates = rankings.get(from)?.get(hunk.id);
            if (candidates !== undefined) {
              const head = new Set(reranked.items.map((item) => item.key));
              const tailItems: Array<Item> = [];
              const tailScores: Array<number> = [];
              candidates.items.forEach((item, index) => {
                if (head.has(item.key)) return;
                tailItems.push(item);
                tailScores.push(candidates.scores[index] ?? 0);
              });
              const floor = Math.min(0, ...reranked.scores) - 1;
              set(arm, hunk.id, {
                items: [...reranked.items, ...tailItems],
                // Tail scores sit below every reranker score so the order is kept by any re-sort.
                scores: [
                  ...reranked.scores,
                  ...tailScores.map((_, index) => floor - index * 1e-9),
                ],
              });
              count(arm, hunk.id, !poolOnlyHunks.get(from)?.has(hunk.id));
            } else {
              set(arm, hunk.id, reranked);
              count(arm, hunk.id, false);
            }
          }
        }
      inputs.log(
        `${baseKey.slice(0, baseKey.indexOf(":") + 9)}: ${entries.reduce((sum, entry) => sum + entry.hunks.length, 0)} hunks read in ${((performance.now() - started) / 1000).toFixed(1)} s`,
      );
    }
    return {
      rankings,
      depth,
      poolOnlyHunks,
      poolMismatches,
      graphFailures,
      population,
      bases,
      baseTokens,
      forkChunks,
    } satisfies LoadedRankings;
  });
