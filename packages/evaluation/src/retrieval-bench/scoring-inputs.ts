import settings from "./paths.json";
import type { BenchChunkVariant } from "./graph-chunk.ts";
import { join, resolve } from "node:path";
import { type Case } from "./corpus.ts";
import { Manifest } from "./manifest.ts";
import type { CorpusKey } from "./policy.ts";
import { QueryFile, type HunkQuery } from "./queries.ts";
import { loadPools, type DeepInputs } from "./deep-rankings.ts";
import { R_CANDIDATES } from "./rerank.ts";
import { SPLITS, splitCases, type BenchSplit } from "./split.ts";

/**
 * The scoring inputs that B4's scorer and the benchmark's reranker job both read: the manifest's cases
 * and hunks of one split (dev by default), its frozen queries, arms.<split>.json, the frozen pools and
 * the Graph failure causes, plus what `loadDeepRankings` needs to read the deep rankings from the
 * store. Paths and the case filter come only from split.ts.
 */

export const root = resolve(import.meta.dir, "../../../..");
export const benchmark = resolve(import.meta.dir, settings.benchmark);

export const repositories: Record<CorpusKey, string> = {
  neuve_effect: resolve(
    process.env["NEUVE_EFFECT_REPOSITORY"] ?? resolve(root, "../neuve_effect"),
  ),
  neuve: root,
};

export interface ArmsFile {
  readonly hunks: number;
  readonly arms: ReadonlyArray<{
    readonly arm: string;
    readonly family: string;
    readonly label: string;
    readonly empty: number;
    readonly errors: number;
    readonly normalized: number;
    readonly poolTokens: unknown;
    readonly latencyMillis: unknown;
  }>;
  readonly indexes: Record<string, unknown>;
  readonly encoding: Record<
    string,
    {
      readonly wallSeconds?: number;
      readonly hardware?: unknown;
      readonly units?: number;
      /** The dev queries' encode on Modal: items, seconds spent encoding, wall seconds. */
      readonly queryReceipt?: {
        readonly items: number;
        readonly encodeSeconds: number;
        readonly wallSeconds: number;
      };
    }
  >;
  readonly models?: Record<
    string,
    { readonly label?: string; readonly dimensions?: number }
  >;
  readonly graph: {
    readonly build: Record<"fork" | "base", { readonly sha256: string }>;
    readonly preparationSecondsFirstMeasured: Record<
      string,
      { full_s: number; syntax_s: number }
    >;
    readonly deep: Record<string, unknown>;
    /** Plans without a usable answer, `arm:depth:hunkId` → attempts in order (run-graph.ts). */
    readonly failures?: Record<
      string,
      ReadonlyArray<{ readonly cause: string; readonly timeoutMs: number }>
    >;
  };
  /** V3b's reranker pairs (9.48), scored ahead by `bench:m4:arms rerank-rescored`. */
  readonly rerankRescored?: {
    readonly bases?: ReadonlyArray<string>;
    readonly newPairs: number;
    readonly distinctPairs: number;
    readonly truncation: {
      readonly pairs: number;
      readonly truncatedPairs: number;
      readonly perHunk?: Record<
        string,
        { readonly pairs: number; readonly truncated: number }
      >;
    };
  };
  readonly rerank?: RerankRecord;
  /** R over other candidate arms (9.57), keyed by arm (`R(<candidates>)`). */
  readonly reranks?: Record<string, RerankRecord>;
}

export interface RerankRecord {
  readonly label?: string;
  readonly config: { readonly candidates: string };
  readonly truncation: {
    readonly pairs: number;
    readonly truncatedPairs: number;
    readonly rate: number | null;
    readonly poolsWithTruncation: number;
    /** Per hunk with any truncated pair: pairs scored and pairs cut to the reranker's window. */
    readonly perHunk?: Record<
      string,
      { readonly pairs: number; readonly truncated: number }
    >;
  };
}

/** A hunk of the split with everything scoring reads about it: its case, family, shares and strata. */
export interface DevHunk {
  readonly hunkId: string;
  readonly caseId: string;
  readonly family: string;
  readonly repository: CorpusKey;
  readonly base: string;
  readonly queryText: string;
  readonly realShare: Readonly<Record<"opus" | "sol", number>>;
  readonly computedShare: Readonly<Record<"opus" | "sol", number>>;
  readonly period: string;
  readonly scopeSource: string;
  readonly changeType: string;
  readonly tunedFile: boolean;
  readonly leakageTags: ReadonlyArray<string>;
  readonly graphTuningRange: boolean;
  readonly phase2Range: boolean;
}

export const readArmsFile = async (path: string): Promise<ArmsFile> => {
  const armsFile = JSON.parse(await Bun.file(path).text()) as ArmsFile;
  const armNames = new Set<string>();
  for (const { arm } of armsFile.arms) {
    if (armNames.has(arm)) throw new Error(`Duplicate arm name: ${arm}`);
    armNames.add(arm);
  }
  return armsFile;
};

export const loadScoringInputs = async (
  split: BenchSplit = SPLITS.dev,
  options: {
    output?: string;
    variant?: BenchChunkVariant | undefined;
    /** Outputs this run replaces, excluded from pool reads and deep reconstruction. */
    excludeArms?: ReadonlySet<string>;
  } = {},
) => {
  const output = options.output ?? benchmark;
  const manifest = Manifest.parse(
    JSON.parse(await Bun.file(join(output, "manifest.json")).text()),
  );
  const cases = splitCases(manifest.cases, split);
  const queries: ReadonlyMap<string, HunkQuery> = new Map(
    QueryFile.parse(
      JSON.parse(
        await Bun.file(join(output, `queries.${split.folder}.json`)).text(),
      ),
    ).queries.map((query) => [query.hunkId, query]),
  );
  const armsFile = await readArmsFile(
    join(output, `arms.${split.folder}.json`),
  );
  const caseOfHunk = new Map<string, Case>();
  for (const entry of cases)
    for (const hunk of entry.hunks) caseOfHunk.set(hunk.id, entry);
  const hunks: Array<DevHunk> = cases.flatMap((entry) =>
    entry.hunks.map((hunk) => ({
      hunkId: hunk.id,
      caseId: entry.id,
      family: entry.family,
      repository: entry.repository,
      base: entry.base,
      queryText: queries.get(hunk.id)?.text ?? "",
      realShare: hunk.realShare,
      computedShare: hunk.computedShare,
      period: entry.period,
      scopeSource: entry.strata.scopeSource,
      changeType: entry.strata.changeType,
      tunedFile: hunk.tunedFile,
      leakageTags: entry.leakageTags,
      graphTuningRange: entry.graphTuningRange,
      phase2Range: entry.phase2Files.length > 0,
    })),
  );
  const baseArms = armsFile.arms
    .map((arm) => arm.arm)
    .filter((arm) => !options.excludeArms?.has(arm));
  const pools = await loadPools(join(output, "pools", split.folder), baseArms);
  const rerankCandidates = armsFile.rerank?.config.candidates ?? R_CANDIDATES;
  // R, then every other reranked arm with a frozen pool (9.57).
  const reranks = [
    ...(baseArms.includes("R")
      ? [{ arm: "R", candidates: rerankCandidates }]
      : []),
    ...Object.entries(armsFile.reranks ?? {})
      .filter(([arm]) => baseArms.includes(arm))
      .map(([arm, entry]) => ({ arm, candidates: entry.config.candidates })),
  ];
  const graphFailureCauses = new Map(
    Object.entries(armsFile.graph.failures ?? {}).flatMap(([key, attempts]) => {
      const last = attempts.at(-1);
      return last === undefined
        ? []
        : [
            [
              key,
              `${last.cause} (${attempts.length} attempt${attempts.length === 1 ? "" : "s"} in this record, the longest timeout ${Math.max(...attempts.map((attempt) => attempt.timeoutMs)) / 60_000} minutes)`,
            ] as const,
          ];
    }),
  );
  const deepInputs = (log: (line: string) => void): DeepInputs => ({
    cases,
    queries,
    variant: options.variant,
    repositories,
    pools,
    engines: {
      fork: armsFile.graph.build.fork.sha256,
      base: armsFile.graph.build.base.sha256,
    },
    reranks,
    graphFailureCauses,
    log,
  });
  return {
    cases,
    queries,
    armsFile,
    caseOfHunk,
    hunks,
    baseArms,
    pools,
    rerankCandidates,
    reranks,
    deepInputs,
  };
};
