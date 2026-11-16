import { createHash } from "node:crypto";
import { Effect } from "effect";
import { buildIndex, bm25Ranking, indexBytes, BM25 } from "./bm25.ts";
import {
  KINDS,
  chunkText,
  kindOf,
  type BaseCorpus,
  type Case,
  type Occurrence,
  type SourceKind,
} from "./corpus.ts";
import { baseMatrix, cosineRanking, queryVector } from "./dense.ts";
import type { EncoderProcess } from "./encoder.ts";
import {
  EQUAL_SHARES,
  RRF_K,
  layeredRrf,
  h3CandidateLists,
  quotaInterleave,
  rrf,
} from "./fusion.ts";
import {
  GRAPH_DEEP_LIMITS,
  GRAPH_LIMITS,
  POLITE,
  type GraphAnswer,
  type GraphRegion,
} from "./graph.ts";
import { gitText, lsTree, readBlobs } from "./git.ts";
import { COUNTER, MODELS, modelIdentity, type DenseId } from "./models.ts";
import type { CorpusKey } from "./policy.ts";
import type { HunkQuery } from "./queries.ts";
import {
  DEEP_TOKENS,
  FUSION_INPUT_TOKENS,
  POOL_DEPTH,
  byPath,
  chunkRegions,
  projectToChunks,
  type ArmAnswer,
  type ArmDescription,
  type Region,
} from "./retriever.ts";
import { storedJson } from "./stored.ts";
import { GRAPH_ARMS } from "./run-graph.ts";
import { chunkTokens, textTokens } from "./tokens.ts";

/**
 * Builds every arm's answer for the dev hunks from stored computations: BM25 and exact cosine are
 * recomputed (cheap, and timed), encodings and Graph answers are read from the store, never
 * recomputed. Chunk arms run in three topologies (one index, per-kind RRF, per-kind quotas); fusions
 * use G-fork, L and each dense arm, each input cut at FUSION_INPUT_TOKENS and extended by its deeper
 * ranking (layeredRrf). Each chunk arm's deep ranking, up to DEEP_TOKENS overall and per kind, and
 * each Graph arm's deep answer cut at DEEP_TOKENS, are stored for B4.
 */

type Ranked = ReadonlyArray<{
  readonly occurrence: Occurrence;
  readonly score: number;
}>;

export interface PoolInputs {
  readonly graphArms?: readonly (typeof GRAPH_ARMS)[number][];
  readonly bases: ReadonlyArray<BaseCorpus>;
  readonly cases: ReadonlyArray<Case>;
  readonly queries: ReadonlyMap<string, HunkQuery>;
  readonly graph: ReadonlyMap<string, GraphAnswer>;
  readonly repositories: Record<CorpusKey, string>;
  readonly dense: ReadonlyArray<DenseId>;
  /** Query encoding time per model and hunk, from the encode run. */
  readonly queryMillis: ReadonlyMap<string, number>;
  /** SHA-256 of the Graph executables whose answers are read (fork and Entire baseline). */
  readonly graphEngines: { readonly fork: string; readonly base: string };
}

export const describeArms = (
  dense: ReadonlyArray<DenseId>,
): Array<ArmDescription> => [
  {
    arm: "G-fork",
    family: "graph",
    label: "Graph fork f89d58a, exact-commit prepared full-profile reads",
    config: {
      engine: "fork",
      mode: "prepared-full",
      limits: GRAPH_LIMITS,
      polite: POLITE,
    },
  },
  {
    arm: "G-fork-syntax",
    family: "graph",
    label: "Graph fork f89d58a, prepared syntax-only generation",
    config: {
      engine: "fork",
      mode: "prepared-syntax",
      limits: GRAPH_LIMITS,
      polite: POLITE,
    },
  },
  {
    arm: "G-base",
    family: "graph",
    label: "Entire baseline 5637039f, complete full-profile index per query",
    config: {
      engine: "base",
      mode: "refresh-full",
      limits: GRAPH_LIMITS,
      polite: POLITE,
    },
  },
  {
    arm: "S-ref",
    family: "reference",
    label:
      "Graph neighbors depth 1 from the changed symbols (reference, not a candidate)",
    config: { relation: "CALLS family", directions: ["in", "out"] },
  },
  ...["", "@kind-rrf", "@kind-quota"].flatMap((topology) => [
    {
      arm: `L${topology}`,
      family: "lexical" as const,
      label: `BM25 path + body${topology}`,
      config: { ...BM25, topology: topology || "one-index" },
    },
    ...dense.map((id) => ({
      arm: `${id}${topology}`,
      family: "dense" as const,
      label: `${MODELS[id].label}${topology}`,
      config: {
        model: modelIdentity(MODELS[id]),
        topology: topology || "one-index",
      },
    })),
  ]),
  ...dense.flatMap((id) => [
    {
      arm: `H1-${id}`,
      family: "fusion" as const,
      label: `L + ${id}, RRF k=${RRF_K}`,
      config: { lists: ["L", id], k: RRF_K },
    },
    {
      arm: `H2-${id}`,
      family: "fusion" as const,
      label: `G-fork + ${id}, RRF k=${RRF_K}`,
      config: { lists: ["G-fork", id], k: RRF_K },
    },
    {
      arm: `H3-${id}`,
      family: "fusion" as const,
      label: `G-fork + L + ${id}, RRF k=${RRF_K}`,
      config: { lists: ["G-fork", "L", id], k: RRF_K },
    },
  ]),
];

/**
 * Bump when the shaping of a stored deep ranking changes (ranking ties, token cut, topology,
 * Graph region text). Part of every deep ranking's key with the counting tokenizer's hash (5.4).
 * v4 (18 October 2026): the cut moved from 256k to 512k tokens; v3 rankings stay in the store.
 */
export const DEEP_RECIPE = "deep-ranking-v4";

export const deepSpec = (
  arm: string,
  config: unknown,
  base: BaseCorpus,
  query: HunkQuery,
) => ({
  op: "bench.deep-ranking",
  opVersion: 1,
  inputs: {
    view: `computation:${base.viewKey}`,
    query: `blob:${query.sha256}`,
  },
  config: {
    arm,
    armConfig: JSON.parse(JSON.stringify(config)) as never,
    deepTokens: DEEP_TOKENS,
    recipe: DEEP_RECIPE,
    counter: COUNTER.sha256,
  },
});

/**
 * The key of a Graph arm's deep cut: the arm's configuration without its thread counts (`polite`,
 * which change timing, never an answer), the deep limits, the engine binary and the exact answer it
 * is cut from. Until 18 October 2026 the v4 cuts were keyed with `polite` as well; those rows stay in
 * the store and are no longer read.
 */
export const graphDeepSpec = (
  arm: string,
  armConfig: unknown,
  engineSha256: string,
  regions: ReadonlyArray<GraphRegion>,
  base: BaseCorpus,
  query: HunkQuery,
) => {
  const { polite: _polite, ...config } = (armConfig ?? {}) as Record<
    string,
    unknown
  >;
  return deepSpec(
    arm,
    {
      ...config,
      depth: "deep",
      limits: GRAPH_DEEP_LIMITS,
      engineSha256,
      answerSha256: createHash("sha256")
        .update(JSON.stringify(regions))
        .digest("hex"),
    },
    base,
    query,
  );
};

export const countGraphPrefix = <E, R>(
  regions: readonly GraphRegion[],
  textsOf: (
    regions: readonly GraphRegion[],
  ) => Effect.Effect<readonly string[], E, R>,
  counter: Pick<EncoderProcess, "count">,
) =>
  Effect.gen(function* () {
    const global: Array<[string, number, number, number]> = [];
    let total = 0;
    for (let offset = 0; offset < regions.length; offset += 32) {
      if (global.length >= POOL_DEPTH && total >= DEEP_TOKENS) break;
      const group = regions.slice(offset, offset + 32);
      const texts = yield* textsOf(group);
      const counts = yield* counter.count(texts.map((text) => text || " "));
      for (const [index, region] of group.entries()) {
        if (global.length >= POOL_DEPTH && total >= DEEP_TOKENS) break;
        const tokens = texts[index] === "" ? 0 : (counts[index] ?? 0);
        total += tokens;
        global.push([region.path, region.startLine, region.endLine, tokens]);
      }
    }
    return { global, total };
  });

export const buildPools = (
  inputs: PoolInputs,
  counter: EncoderProcess,
  log: (line: string) => void,
) =>
  Effect.gen(function* () {
    const graphArms = inputs.graphArms ?? GRAPH_ARMS;
    const answers = new Map<string, Array<ArmAnswer>>();
    // Answers keep the frozen pool only; deeper rankings live in the store.
    const add = (answer: ArmAnswer) => {
      const list = answers.get(answer.arm) ?? [];
      list.push({ ...answer, regions: answer.regions.slice(0, POOL_DEPTH) });
      answers.set(answer.arm, list);
    };
    const indexStats: Array<Record<string, unknown>> = [];
    const deepStats = new Map<
      string,
      Array<{
        hunkId: string;
        returned: number;
        kept: number;
        tokens: number;
        reachedDeepTokens: boolean;
        poolPrefixIdentical: boolean;
        poolOverlap: number;
        error: string | null;
      }>
    >();
    const tokens = new Map<string, ReadonlyArray<number>>();
    const descriptions = new Map(
      describeArms(inputs.dense)
        .filter(
          (entry) =>
            !GRAPH_ARMS.some((arm) => arm === entry.arm) ||
            graphArms.some((arm) => arm === entry.arm),
        )
        .map((entry) => [entry.arm, entry]),
    );
    const denseCaches = new Map<DenseId, Map<string, Float32Array>>(
      inputs.dense.map((id) => [id, new Map()]),
    );
    const fileCache = new Map<string, Array<string>>();
    const fileLines = (repository: string, commit: string, path: string) =>
      Effect.gen(function* () {
        const key = `${commit}:${path}`;
        let lines = fileCache.get(key);
        if (lines === undefined) {
          const content = yield* gitText(repository, [
            "cat-file",
            "blob",
            `${commit}:${path}`,
          ]);
          lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
          fileCache.set(key, lines);
        }
        return lines;
      });

    for (const base of inputs.bases) {
      fileCache.clear();
      yield* chunkTokens(base, counter, tokens);
      const tokensOf = (occurrence: Occurrence) =>
        tokens.get(occurrence.chunkKey)?.[occurrence.position] ?? 0;
      const occurrenceById = new Map(
        base.occurrences.map((occurrence) => [occurrence.chunkId, occurrence]),
      );
      const pathIndex = byPath(base);
      const hunks = inputs.cases
        .filter(
          (entry) =>
            entry.repository === base.repository && entry.base === base.commit,
        )
        .flatMap((entry) =>
          entry.hunks.map((hunk) => ({
            entry,
            hunk,
            query: inputs.queries.get(hunk.id) as HunkQuery,
          })),
        );
      const repository = inputs.repositories[base.repository];
      const oids = new Map(
        (graphArms.length ? yield* lsTree(repository, base.commit) : [])
          .filter((entry) => entry.type === "blob")
          .map((entry) => [entry.path, entry.oid]),
      );
      const prefetchLines = (regions: readonly GraphRegion[]) =>
        Effect.gen(function* () {
          const paths = [
            ...new Set(regions.map((region) => region.path)),
          ].filter(
            (path) =>
              !fileCache.has(`${base.commit}:${path}`) && oids.has(path),
          );
          const contents = yield* readBlobs(repository, [
            ...new Set(paths.flatMap((path) => oids.get(path) ?? [])),
          ]);
          for (const path of paths) {
            const oid = oids.get(path),
              bytes = oid === undefined ? undefined : contents.get(oid);
            if (bytes)
              fileCache.set(
                `${base.commit}:${path}`,
                new TextDecoder().decode(bytes).match(/[^\n]*\n|[^\n]+$/g) ??
                  [],
              );
          }
        }).pipe(Effect.orElseSucceed(() => undefined));

      // L: one BM25 index per base over path + body.
      const loadStart = performance.now();
      const texts: Array<string> = [];
      for (const occurrence of base.occurrences)
        texts.push(`${occurrence.path}\n${yield* chunkText(occurrence.hash)}`);
      const textMillis = performance.now() - loadStart;
      const buildStart = performance.now();
      const index = buildIndex(texts);
      const buildMillis = performance.now() - buildStart;
      indexStats.push({
        arm: "L",
        base: `${base.repository}:${base.commit}`,
        chunks: base.occurrences.length,
        loadMillis: Math.round(textMillis),
        buildMillis: Math.round(buildMillis),
        terms: index.postings.size,
        bytes: indexBytes(index),
      });

      const rankings = new Map<string, Map<string, Ranked>>();
      const timings = new Map<
        string,
        Map<
          string,
          { millis: number; stages: Record<string, number>; cold: boolean }
        >
      >();
      const setTiming = (
        arm: string,
        hunkId: string,
        value: {
          millis: number;
          stages: Record<string, number>;
          cold: boolean;
        },
      ) => {
        const map = timings.get(arm) ?? new Map();
        map.set(hunkId, value);
        timings.set(arm, map);
      };
      const lexical = new Map<string, Ranked>();
      hunks.forEach(({ hunk, query }, position) => {
        const started = performance.now();
        lexical.set(hunk.id, bm25Ranking(index, base.occurrences, query.text));
        const millis = performance.now() - started;
        setTiming("L", hunk.id, {
          millis,
          stages: { rank: millis },
          cold: position === 0,
        });
      });
      rankings.set("L", lexical);

      for (const id of inputs.dense) {
        const model = MODELS[id];
        const loadStarted = performance.now();
        const matrix = yield* baseMatrix(
          model,
          base,
          denseCaches.get(id) as Map<string, Float32Array>,
        );
        const matrixMillis = performance.now() - loadStarted;
        indexStats.push({
          arm: id,
          base: `${base.repository}:${base.commit}`,
          chunks: base.occurrences.length,
          loadMillis: Math.round(matrixMillis),
          bytes: matrix.byteLength,
        });
        const ranked = new Map<string, Ranked>();
        for (const [position, { hunk, query }] of hunks.entries()) {
          const vector = yield* queryVector(model, query);
          const started = performance.now();
          ranked.set(
            hunk.id,
            cosineRanking(matrix, model.dimensions, base.occurrences, vector),
          );
          const rank = performance.now() - started;
          const encode = inputs.queryMillis.get(`${id}:${hunk.id}`) ?? 0;
          setTiming(id, hunk.id, {
            millis: rank + encode,
            stages: { encodeQuery: encode, rank },
            cold: position === 0,
          });
        }
        rankings.set(id, ranked);
      }

      // Graph arms and S-ref, with their own regions.
      const graphIds = new Map<string, ReadonlyArray<string>>();
      for (const { entry, hunk } of hunks)
        for (const arm of graphArms) {
          const answer = inputs.graph.get(
            `${arm === "S-ref" ? "G-fork" : arm}:${hunk.id}`,
          );
          if (answer === undefined)
            return yield* Effect.die(
              new Error(`no ${arm} answer for ${hunk.id}`),
            );
          const source: ReadonlyArray<GraphRegion> =
            arm === "S-ref" ? answer.neighbors : answer.regions;
          yield* prefetchLines(source);
          const regions: Array<Region> = [];
          for (const [rank, region] of source.entries()) {
            const lines = yield* fileLines(
              repository,
              base.commit,
              region.path,
            ).pipe(Effect.orElseSucceed(() => [] as Array<string>));
            const text = lines
              .slice(region.startLine - 1, region.endLine)
              .join("");
            regions.push({
              path: region.path,
              startLine: region.startLine,
              endLine: region.endLine,
              chunkId: null,
              kind: kindOf(region.path),
              tokens: text === "" ? 0 : yield* textTokens(text, counter),
              score: 1 / (rank + 1),
            });
          }
          if (arm === "G-fork")
            graphIds.set(
              hunk.id,
              projectToChunks(regions, pathIndex).map(
                (occurrence) => occurrence.chunkId,
              ),
            );
          add({
            arm,
            caseId: entry.id,
            hunkId: hunk.id,
            regions,
            timing: {
              millis:
                arm === "S-ref"
                  ? answer.totalMillis - answer.queryMillis
                  : answer.queryMillis,
              stages: { query: answer.queryMillis, total: answer.totalMillis },
              cold: hunks[0]?.hunk.id === hunk.id,
            },
            ...(answer.error !== null
              ? { note: `error: ${answer.error}` }
              : answer.normalizations.length > 0
                ? {
                    note: `normalized: graph-client clamped ${answer.normalizations.length} end lines one past end of file`,
                  }
                : {}),
          });
        }

      // Deep Graph answers for the allowance curve, cut at DEEP_TOKENS and stored; the frozen pools
      // above stay the top-50 answers. An engine that returns fewer units ends short, and is counted.
      for (const { hunk, query } of hunks)
        for (const arm of graphArms.filter((arm) => arm !== "S-ref")) {
          const answer = inputs.graph.get(`deep:${arm}:${hunk.id}`);
          const pool = inputs.graph.get(`${arm}:${hunk.id}`);
          if (answer === undefined || pool === undefined)
            return yield* Effect.die(
              new Error(`no deep ${arm} answer for ${hunk.id}`),
            );
          // A Graph answer that failed (the stand-in for a timeout or a refused observation) has no
          // deep ranking: nothing is stored, so a later usable answer is never shadowed by it.
          if (answer.error !== null) {
            const stat = deepStats.get(arm) ?? [];
            stat.push({
              hunkId: hunk.id,
              returned: 0,
              kept: 0,
              tokens: 0,
              reachedDeepTokens: false,
              poolPrefixIdentical: false,
              poolOverlap: 0,
              error: answer.error,
            });
            deepStats.set(arm, stat);
            continue;
          }
          const { value } = yield* storedJson(
            graphDeepSpec(
              arm,
              descriptions.get(arm)?.config,
              arm === "G-base"
                ? inputs.graphEngines.base
                : inputs.graphEngines.fork,
              answer.regions,
              base,
              query,
            ),
            Effect.gen(function* () {
              const { global, total } = yield* countGraphPrefix(
                answer.regions,
                (regions) =>
                  Effect.gen(function* () {
                    yield* prefetchLines(regions);
                    const texts: string[] = [];
                    for (const region of regions) {
                      const lines = yield* fileLines(
                        repository,
                        base.commit,
                        region.path,
                      ).pipe(Effect.orElseSucceed(() => [] as Array<string>));
                      texts.push(
                        lines
                          .slice(region.startLine - 1, region.endLine)
                          .join(""),
                      );
                    }
                    return texts;
                  }),
                counter,
              );
              return {
                global,
                returned: answer.regions.length,
                tokens: total,
                reachedDeepTokens: total >= DEEP_TOKENS,
                error: answer.error,
              };
            }),
          );
          const span = (region: {
            path: string;
            startLine: number;
            endLine: number;
          }) => `${region.path}:${region.startLine}-${region.endLine}`;
          const poolSpans = pool.regions.slice(0, POOL_DEPTH).map(span);
          const deepSpans = value.global
            .slice(0, poolSpans.length)
            .map(([path, startLine, endLine]) =>
              span({ path, startLine, endLine }),
            );
          const stat = deepStats.get(arm) ?? [];
          stat.push({
            hunkId: hunk.id,
            returned: value.returned,
            kept: value.global.length,
            tokens: value.tokens,
            reachedDeepTokens: value.reachedDeepTokens,
            poolPrefixIdentical: poolSpans.join() === deepSpans.join(),
            poolOverlap: deepSpans.filter((item) => poolSpans.includes(item))
              .length,
            error: value.error,
          });
          deepStats.set(arm, stat);
        }

      // Chunk arms in three topologies, deep rankings stored.
      const chunkArms = ["L", ...inputs.dense];
      // Each chunk arm's ids as a fusion input: cut at FUSION_INPUT_TOKENS (head) and at DEEP_TOKENS.
      const deepIds = new Map<
        string,
        { head: ReadonlyArray<string>; deep: ReadonlyArray<string> }
      >();
      for (const arm of chunkArms)
        for (const { entry, hunk, query } of hunks) {
          const ranked = rankings.get(arm)?.get(hunk.id) ?? [];
          const timing = timings.get(arm)?.get(hunk.id) ?? {
            millis: 0,
            stages: {},
            cold: false,
          };
          const global = chunkRegions(ranked, tokensOf, DEEP_TOKENS);
          const perKind = new Map<SourceKind, Array<Region>>();
          for (const kind of KINDS)
            perKind.set(
              kind,
              chunkRegions(
                ranked.filter((item) => item.occurrence.kind === kind),
                tokensOf,
                DEEP_TOKENS,
              ),
            );
          const kindRrf = rrf(
            KINDS.map((kind) =>
              (perKind.get(kind) ?? []).map((region) => region.chunkId ?? ""),
            ),
          );
          const kindRrfRegions = chunkRegions(
            kindRrf.map((item) => ({
              occurrence: occurrenceById.get(item.id) as Occurrence,
              score: item.score,
            })),
            tokensOf,
            DEEP_TOKENS,
          );
          const quota = quotaInterleave(
            perKind,
            EQUAL_SHARES,
            Number.MAX_SAFE_INTEGER,
          );
          const quotaRegions: Array<Region> = [];
          let quotaTokens = 0;
          for (const { item } of quota) {
            if (quotaRegions.length >= 50 && quotaTokens >= DEEP_TOKENS) break;
            quotaRegions.push(item);
            quotaTokens += item.tokens;
          }
          deepIds.set(`${arm}:${hunk.id}`, {
            head: chunkRegions(ranked, tokensOf, FUSION_INPUT_TOKENS).map(
              (region) => region.chunkId ?? "",
            ),
            deep: global.map((region) => region.chunkId ?? ""),
          });
          yield* storedJson(
            deepSpec(arm, descriptions.get(arm)?.config, base, query),
            Effect.succeed({
              global: global.map((region) => [region.chunkId, region.score]),
              perKind: Object.fromEntries(
                KINDS.map((kind) => [
                  kind,
                  (perKind.get(kind) ?? []).map((region) => [
                    region.chunkId,
                    region.score,
                  ]),
                ]),
              ),
            }),
          );
          add({
            arm,
            caseId: entry.id,
            hunkId: hunk.id,
            regions: global,
            timing,
          });
          add({
            arm: `${arm}@kind-rrf`,
            caseId: entry.id,
            hunkId: hunk.id,
            regions: kindRrfRegions,
            timing,
          });
          add({
            arm: `${arm}@kind-quota`,
            caseId: entry.id,
            hunkId: hunk.id,
            regions: quotaRegions,
            timing,
          });
        }

      // Fusions over G-fork (projected onto chunks), L and each dense arm.
      for (const id of inputs.dense)
        for (const { entry, hunk } of hunks) {
          const none = { head: [], deep: [] };
          const graph = graphIds.get(hunk.id) ?? [];
          const lists = {
            G: { head: graph, deep: graph },
            L: deepIds.get(`L:${hunk.id}`) ?? none,
            D: deepIds.get(`${id}:${hunk.id}`) ?? none,
          };
          const component = (arm: string) =>
            timings.get(arm)?.get(hunk.id)?.millis ?? 0;
          const graphMillis =
            inputs.graph.get(`G-fork:${hunk.id}`)?.queryMillis ?? 0;
          for (const [arm, members, inputMillis] of [
            [`H1-${id}`, [lists.L, lists.D], component("L") + component(id)],
            [`H2-${id}`, [lists.G, lists.D], graphMillis + component(id)],
            [
              `H3-${id}`,
              h3CandidateLists(lists.G, lists.L, lists.D),
              graphMillis + component("L") + component(id),
            ],
          ] as const) {
            const started = performance.now();
            const fused = layeredRrf(
              members.map((list) => list.head),
              members.map((list) => list.deep),
            );
            const fuse = performance.now() - started;
            add({
              arm,
              caseId: entry.id,
              hunkId: hunk.id,
              regions: chunkRegions(
                fused.map((item) => ({
                  occurrence: occurrenceById.get(item.id) as Occurrence,
                  score: item.score,
                })),
                tokensOf,
                DEEP_TOKENS,
              ),
              timing: {
                millis: inputMillis + fuse,
                stages: { inputs: inputMillis, fuse },
                cold: false,
              },
            });
          }
        }
      log(
        `${base.repository}:${base.commit.slice(0, 8)}: ${hunks.length} hunks, ${base.occurrences.length} chunks; BM25 built in ${(buildMillis / 1000).toFixed(2)} s`,
      );
    }
    return {
      answers,
      indexStats,
      deepStats,
      descriptions: [...descriptions.values()],
    };
  });
