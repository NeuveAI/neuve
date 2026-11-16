import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import {
  buildHunkGold,
  keepCrossFamily,
  type GoldItem,
  type RawGoldItem,
} from "../retrieval-bench/score/gold.ts";
import {
  evaluateBudget,
  familyMean,
} from "../retrieval-bench/score/metrics.ts";
import {
  familyBootstrap,
  familyPermutation,
} from "../retrieval-bench/score/stats.ts";
import type { HunkGold } from "../retrieval-bench/score/types.ts";
import { rankingFromRow } from "../retrieval-bench/deep-rankings.ts";
import {
  loadScoringInputs,
  type DevHunk,
} from "../retrieval-bench/scoring-inputs.ts";
import {
  CANDIDATES,
  DEFAULT_CANDIDATE,
  RESULTS,
  SLUG,
  benchmark,
  comparisonExclusions,
  excludedHunk,
  runDir,
  type Candidate,
} from "./common.ts";
import {
  placeEntry,
  rankingFor,
  type LedgerLite,
  type ManifestHunkLite,
  type Placement,
} from "./ledgers.ts";
import { readSelection } from "./select.ts";
import { shownLeads } from "./shown-leads.ts";

/**
 * Step 6: Investigate's stored ledgers scored with B4's scorer, as a separate step that reads only
 * what the runs stored (`runs/<case>/<candidate>.json.gz` and the seed reports), so it can run again
 * once gold changes. Nothing here calls a model.
 *
 * Metric: coverage at depth, B4's fractional recall (score/coverage.ts) of each hunk's necessary,
 * useful and relevant (9.54) targets by everything the ledger kept for that hunk (the ledger is
 * already trimmed to the hunk's allowance, so the scorer serves all of it). Means are B4's
 * family-weighted means; the delta is R(H3-E3) minus R(H3-E1) per hunk, with B4's paired family
 * bootstrap (cases nested in families, the pre-registered seed), at 95% and at comparison 6's
 * Bonferroni level (6 comparisons), and the sign-flip permutation p.
 *
 * Gold views:
 * - all: every retrieval target of the resolved dev gold;
 * - cross-family: a target is kept when its status is `agreed`, `owner-decided`, or
 *   `council-decided` with both Sol members voting the decided grade in the final round; dropped
 *   targets are removed from the gold altogether, so they are unjudged, never irrelevant;
 * - Opus overlap: Investigate runs on Opus and Opus labelled every item, so targets are split by
 *   whether Opus's own label (`opus`, or `opus (grader)` on another family's addition) equals the
 *   final grade. "Opus-agreed" targets are where an Opus bias could be shared; "Opus-disagreed"
 *   ones are where the final grade went against Opus.
 * Both views are restricted to the chosen ranges' hunks left after 9.47.
 *
 * Reference: the same candidate's frozen top 3 (the most leads Investigate preloads per hunk,
 * 10.43) scored the same way, to show how much of the coverage the leads alone give.
 */

export const DEFAULT_GOLD = join(benchmark, "labelling/dev");
const COUNT_CHECK = {
  targets: 878,
  kept: 849,
  dropped: 29,
  necessary: 12,
  useful: 17,
};

const Item = z.looseObject({
  id: z.string(),
  grade: z.string(),
  status: z.string(),
  retrievalTarget: z.boolean(),
  labels: z.record(z.string(), z.string()).optional(),
  owner: z
    .looseObject({
      council: z
        .looseObject({
          votes: z.array(
            z.looseObject({ votes: z.record(z.string(), z.string()) }),
          ),
        })
        .optional(),
    })
    .nullable()
    .optional(),
});
type RawItem = z.infer<typeof Item>;

const Pool = z.looseObject({
  caseId: z.string(),
  hunkId: z.string(),
  candidates: z.array(z.any()).default([]),
});

const isTarget = (item: RawItem) =>
  item.retrievalTarget &&
  (item.grade === "necessary" || item.grade === "useful");

/** The cross-family rule (9.52) from its one authority, the M4 scorer (7.11). */
const crossFamily = (item: RawItem) => keepCrossFamily(item as RawGoldItem);

export const opusAgrees = (item: RawItem) => {
  const label = item.labels?.["opus"] ?? item.labels?.["opus (grader)"];
  return label === item.grade;
};

const findGold = (directory: string, out: Array<string> = []) => {
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) findGold(path, out);
    else if (name === "gold.json") out.push(path);
  }
  return out;
};

export type View = "all" | "cross-family" | "opus-agreed" | "opus-disagreed";
export const VIEWS: ReadonlyArray<View> = [
  "all",
  "cross-family",
  "opus-agreed",
  "opus-disagreed",
];
const keepIn: Record<View, (item: RawItem) => boolean> = {
  all: () => true,
  "cross-family": crossFamily,
  "opus-agreed": opusAgrees,
  "opus-disagreed": (item) => !opusAgrees(item),
};

export const loadViews = async (directory: string) => {
  const hunks = new Map<
    string,
    { caseId: string; items: Array<RawItem>; pool: z.infer<typeof Pool> }
  >();
  for (const file of findGold(directory)) {
    const poolPath = join(dirname(file), "pool.json");
    const pool = Pool.parse(
      existsSync(poolPath)
        ? JSON.parse(await Bun.file(poolPath).text())
        : { caseId: "", hunkId: basename(dirname(file)), candidates: [] },
    );
    const items = z.array(Item).parse(JSON.parse(await Bun.file(file).text()));
    hunks.set(pool.hunkId, { caseId: pool.caseId, items, pool });
  }
  // The coordinator's check on the cross-family filter, over the whole dev gold.
  const targets = [...hunks.values()].flatMap((hunk) =>
    hunk.items.filter(isTarget),
  );
  const dropped = targets.filter((item) => !crossFamily(item));
  const check = {
    targets: targets.length,
    kept: targets.length - dropped.length,
    dropped: dropped.length,
    necessary: dropped.filter((item) => item.grade === "necessary").length,
    useful: dropped.filter((item) => item.grade === "useful").length,
  };
  if (JSON.stringify(check) !== JSON.stringify(COUNT_CHECK))
    throw new Error(
      `cross-family filter check failed: ${JSON.stringify(check)}, expected ${JSON.stringify(COUNT_CHECK)}`,
    );
  const views = new Map<View, Map<string, HunkGold>>();
  for (const view of VIEWS) {
    const map = new Map<string, HunkGold>();
    for (const [hunkId, hunk] of hunks) {
      // A target outside the view leaves the gold entirely: unjudged, never irrelevant.
      const items = hunk.items.filter(
        (item) => !isTarget(item) || keepIn[view](item),
      );
      map.set(
        hunkId,
        buildHunkGold(
          hunk.caseId,
          hunkId,
          items as unknown as ReadonlyArray<GoldItem>,
          hunk.pool.candidates,
        ),
      );
    }
    views.set(view, map);
  }
  return { views, check, raw: hunks };
};

export interface RunFile {
  readonly outcome?: string;
  /** The run's cycle: lanes of one attempt share it. */
  readonly cycleId?: string;
  /** What the runner recorded beside Records (runner.ts), for a run stopped after Investigate. */
  readonly measurement?: {
    readonly cycleId?: string;
    readonly stoppedAfterInvestigate?: boolean;
  };
  readonly totals?: { readonly costUsd?: number };
  readonly manifest: {
    readonly hunks: ReadonlyArray<
      ManifestHunkLite & {
        readonly leads?: {
          readonly results: ReadonlyArray<{
            readonly identity: {
              readonly path: string;
              readonly startLine: number;
              readonly endLine: number;
            };
          }>;
        } | null;
      }
    >;
  } | null;
  /** The range's leads, for a run from NEU-148 on (`shown-leads.ts`); absent before. */
  readonly leads?: {
    readonly hunks: ReadonlyArray<{
      readonly hunkId: string;
      readonly leads: {
        readonly results: ReadonlyArray<{
          readonly identity: {
            readonly path: string;
            readonly startLine: number;
            readonly endLine: number;
          };
        }>;
      } | null;
    }>;
  } | null;
  readonly ledgers: ReadonlyArray<LedgerLite>;
}

/** A stored run by its lane's file name (the comparison's are the candidates' slugs). */
export const readRun = (
  caseId: string,
  slug: string,
  results: string = RESULTS,
): RunFile | undefined => {
  const path = join(runDir(caseId, results), `${slug}.json.gz`);
  if (!existsSync(path)) return undefined;
  return JSON.parse(gunzipSync(readFileSync(path)).toString("utf8")) as RunFile;
};

export const readSeed = async (
  caseId: string,
  slug: string,
  results: string = RESULTS,
) => {
  const path = join(runDir(caseId, results), `seed-${slug}.json`);
  return existsSync(path)
    ? (JSON.parse(await Bun.file(path).text()) as {
        harnessHunks: number;
        seeded: ReadonlyArray<{
          m4HunkId: string;
          harnessHunkId: string | null;
          top?: ReadonlyArray<string>;
        }>;
      })
    : undefined;
};

export const round = (value: number | null | undefined, digits = 4) =>
  value === null || value === undefined ? null : Number(value.toFixed(digits));

export const scoreAll = async (options: {
  readonly gold?: string | undefined;
}) => {
  const goldDir = options.gold ?? DEFAULT_GOLD;
  if (!goldDir.startsWith("/"))
    throw new Error("--gold must be an absolute path");
  const { views, check } = await loadViews(goldDir);
  const selection = await readSelection();
  const inputs = await loadScoringInputs();
  const exclusions = comparisonExclusions(inputs.armsFile);
  const chosen = new Set(selection.selected.map((entry) => entry.caseId));
  const hunks: Array<DevHunk> = inputs.hunks.filter(
    (hunk) =>
      chosen.has(hunk.caseId) && excludedHunk(exclusions, hunk).length === 0,
  );

  type Row = {
    hunkId: string;
    caseId: string;
    family: string;
    candidate: Candidate;
    source: "ledger" | "frozen-top3" | "ledger+top3";
    view: View;
    necessary: number | null;
    useful: number | null;
    relevant: number | null;
    /** The same coverage under B4's any-line overlap rule (a target touched counts whole). */
    necessaryAny: number | null;
    relevantAny: number | null;
    misleadingShare: number | null;
  };
  /** Per scored hunk: whether both candidates preloaded the same top 3 leads (seed reports). */
  const sameTop3 = new Map<string, boolean>();
  const harnessHunksOf = new Map<string, number>();
  const seededOf = new Map<string, number>();
  /** Lines per region the scorer sees, per candidate: the ledger's against the top 3 leads'. */
  const widths = new Map<Candidate, { ledger: number[]; top3: number[] }>(
    CANDIDATES.map((candidate) => [candidate, { ledger: [], top3: [] }]),
  );
  /** The leads each candidate's manifest gave the harness hunks with no M4 hunk, by range. */
  const unscoredLeads = new Map<string, string>();
  const rows: Array<Row> = [];
  const runInfo: Array<Record<string, unknown>> = [];
  const missing: Array<string> = [];
  for (const caseId of chosen) {
    for (const candidate of CANDIDATES) {
      const run = readRun(caseId, SLUG[candidate]);
      const seed = await readSeed(caseId, SLUG[candidate]);
      if (run === undefined || seed === undefined || run.manifest === null) {
        missing.push(`${caseId} ${candidate}`);
        continue;
      }
      harnessHunksOf.set(caseId, seed.harnessHunks);
      const seededIds = new Set(
        seed.seeded.flatMap((entry) =>
          entry.harnessHunkId === null ? [] : [entry.harnessHunkId],
        ),
      );
      const leadsOf = shownLeads(run);
      for (const record of run.manifest.hunks)
        if (!seededIds.has(record.hunkId))
          unscoredLeads.set(
            `${candidate}\u0000${caseId}\u0000${record.hunkId}`,
            JSON.stringify(
              (leadsOf(record.hunkId)?.results ?? []).map(
                (result) =>
                  `${result.identity.path}:${result.identity.startLine}-${result.identity.endLine}`,
              ),
            ),
          );
      seededOf.set(
        caseId,
        seed.seeded.filter((entry) => entry.harnessHunkId !== null).length,
      );
      if (candidate === DEFAULT_CANDIDATE) {
        const other = await readSeed(caseId, SLUG["R(H3-E3)"]);
        for (const entry of seed.seeded)
          sameTop3.set(
            entry.m4HunkId,
            JSON.stringify(entry.top ?? []) ===
              JSON.stringify(
                other?.seeded.find((item) => item.m4HunkId === entry.m4HunkId)
                  ?.top ?? null,
              ),
          );
      }
      const placements: Record<string, number> = {};
      for (const hunk of hunks.filter((entry) => entry.caseId === caseId)) {
        const harnessHunkId =
          seed.seeded.find((entry) => entry.m4HunkId === hunk.hunkId)
            ?.harnessHunkId ?? null;
        const mapped =
          harnessHunkId === null
            ? null
            : rankingFor(harnessHunkId, run.ledgers, run.manifest.hunks);
        const frozen = inputs.pools.get(candidate)?.get(hunk.hunkId);
        const top3 =
          frozen === undefined ? [] : rankingFromRow(frozen).items.slice(0, 3);
        const lines = (item: { startLine: number; endLine: number }) =>
          item.endLine - item.startLine + 1;
        widths
          .get(candidate)!
          .ledger.push(...(mapped?.ranking.items ?? []).map(lines));
        widths.get(candidate)!.top3.push(...top3.map(lines));
        // Lead influence beyond lineage: entries not recorded as a preloaded lead whose base region
        // overlaps one of the hunk's top 3 lead regions.
        const anchored =
          harnessHunkId === null
            ? []
            : run.ledgers
                .filter((ledger) =>
                  ledger.partition.hunkIds.includes(harnessHunkId),
                )
                .flatMap((ledger) => ledger.entries)
                .filter((entry) =>
                  entry.anchors.some((anchor) => anchor.hunk === harnessHunkId),
                );
        const overlapsLead = anchored.filter((entry) => {
          if (entry.lineage.lookup === "preloaded-lead") return false;
          const region = placeEntry(entry, run.manifest!.hunks).region;
          return (
            region !== undefined &&
            top3.some(
              (item) =>
                item.path === region.path &&
                item.startLine <= region.endLine &&
                region.startLine <= item.endLine,
            )
          );
        }).length;
        runInfo.push({
          caseId,
          candidate,
          hunkId: hunk.hunkId,
          harnessHunkId,
          ledgered: mapped !== null,
          entries: mapped?.entries ?? 0,
          items: mapped?.ranking.items.length ?? 0,
          fromLeads: mapped?.fromLeads ?? 0,
          overlapsTop3Lead: overlapsLead,
          sameTop3: sameTop3.get(hunk.hunkId) ?? null,
          ungraded: mapped?.ungraded ?? 0,
          tokens: mapped?.tokens ?? 0,
          placements: mapped?.placements ?? null,
          partitionStatus: mapped?.partitionStatus ?? [],
        });
        for (const [name, count] of Object.entries(mapped?.placements ?? {}))
          placements[name] = (placements[name] ?? 0) + (count as number);
        for (const view of VIEWS) {
          const gold = views.get(view)!.get(hunk.hunkId);
          if (gold === undefined) continue;
          const ledgerItems = mapped?.ranking.items ?? [];
          const sources = [
            ["ledger", { items: ledgerItems, scores: [] }],
            ...(frozen === undefined
              ? []
              : ([
                  ["frozen-top3", { items: top3, scores: [] }],
                  [
                    "ledger+top3",
                    { items: [...ledgerItems, ...top3], scores: [] },
                  ],
                ] as const)),
          ] as const;
          for (const [source, ranking] of sources) {
            const metrics = evaluateBudget(
              gold,
              ranking,
              Number.MAX_SAFE_INTEGER,
            );
            rows.push({
              hunkId: hunk.hunkId,
              caseId,
              family: hunk.family,
              candidate,
              source: source as Row["source"],
              view,
              necessary: metrics.necessary.fractional,
              useful: metrics.useful.fractional,
              relevant: metrics.relevant.fractional,
              necessaryAny: metrics.necessary.anyLine,
              relevantAny: metrics.relevant.anyLine,
              misleadingShare: metrics.attribution.misleadingShare,
            });
          }
        }
      }
    }
  }

  const metricNames = [
    "necessary",
    "useful",
    "relevant",
    "necessaryAny",
    "relevantAny",
  ] as const;
  const summary = VIEWS.map((view) => {
    const perCandidate = Object.fromEntries(
      CANDIDATES.flatMap((candidate) =>
        (["ledger", "frozen-top3", "ledger+top3"] as const).map((source) => [
          `${candidate} ${source}`,
          Object.fromEntries(
            metricNames.map((metric) => {
              const mean = familyMean(
                rows
                  .filter(
                    (row) =>
                      row.view === view &&
                      row.candidate === candidate &&
                      row.source === source,
                  )
                  .map((row) => ({
                    family: row.family,
                    caseId: row.caseId,
                    value: row[metric],
                  })),
              );
              return [
                metric,
                {
                  mean: round(mean.mean),
                  hunkMean: round(mean.hunkMean),
                  hunks: mean.hunks,
                  families: mean.families,
                },
              ];
            }),
          ),
        ]),
      ),
    );
    const deltas = Object.fromEntries(
      metricNames.map((metric) => {
        const units = hunks.flatMap((hunk) => {
          const get = (candidate: Candidate) =>
            rows.find(
              (row) =>
                row.view === view &&
                row.source === "ledger" &&
                row.candidate === candidate &&
                row.hunkId === hunk.hunkId,
            )?.[metric] ?? null;
          const other = get("R(H3-E3)");
          const base = get(DEFAULT_CANDIDATE);
          return other === null || base === null
            ? []
            : [
                {
                  family: hunk.family,
                  caseId: hunk.caseId,
                  delta: other - base,
                },
              ];
        });
        const ci95 = familyBootstrap(units, { comparisons: 1 });
        const ciBonferroni = familyBootstrap(units, { comparisons: 6 });
        return [
          metric,
          {
            delta: round(ci95.observed),
            ci95: [round(ci95.lower), round(ci95.upper)],
            ciComparison6Level: {
              level: round(ciBonferroni.level),
              interval: [round(ciBonferroni.lower), round(ciBonferroni.upper)],
            },
            permutationP: round(familyPermutation(units).p),
            hunks: ci95.hunks,
            cases: ci95.cases,
            families: ci95.families,
          },
        ];
      }),
    );
    const targetCounts = hunks.reduce(
      (sum, hunk) => {
        const gold = views.get(view)!.get(hunk.hunkId);
        return {
          necessary: sum.necessary + (gold?.necessary.length ?? 0),
          useful: sum.useful + (gold?.useful.length ?? 0),
        };
      },
      { necessary: 0, useful: 0 },
    );
    return {
      view,
      targets: targetCounts,
      perCandidate,
      deltaE3MinusE1: deltas,
    };
  });

  // Per view, how many targets of the chosen hunks the cross-family filter dropped.
  const allTargets = summary.find((entry) => entry.view === "all")!.targets;
  const crossTargets = summary.find(
    (entry) => entry.view === "cross-family",
  )!.targets;
  /** Treatment contrast, run-to-run noise, lead influence and selection skew: all measured. */
  const contextOf = () => {
    const ledgerAll = (candidate: Candidate, hunkId: string) =>
      rows.find(
        (row) =>
          row.view === "all" &&
          row.source === "ledger" &&
          row.candidate === candidate &&
          row.hunkId === hunkId,
      );
    const group = (same: boolean) => {
      const ids = hunks
        .filter((hunk) => sameTop3.get(hunk.hunkId) === same)
        .map((hunk) => hunk.hunkId);
      const deltas = ids.flatMap((id) => {
        const a = ledgerAll(DEFAULT_CANDIDATE, id)?.relevant ?? null;
        const b = ledgerAll("R(H3-E3)", id)?.relevant ?? null;
        return a === null || b === null ? [] : [b - a];
      });
      return {
        hunks: ids.length,
        ranges: new Set(
          hunks
            .filter((hunk) => ids.includes(hunk.hunkId))
            .map((hunk) => hunk.caseId),
        ).size,
        withRelevantGold: deltas.length,
        meanDeltaRelevant: round(
          deltas.reduce((sum, value) => sum + value, 0) / (deltas.length || 1),
        ),
        meanAbsDeltaRelevant: round(
          deltas.reduce((sum, value) => sum + Math.abs(value), 0) /
            (deltas.length || 1),
        ),
      };
    };
    const harnessTotal = [...harnessHunksOf.values()].reduce(
      (sum, value) => sum + value,
      0,
    );
    const seededTotal = [...seededOf.values()].reduce(
      (sum, value) => sum + value,
      0,
    );
    const influence = Object.fromEntries(
      CANDIDATES.map((candidate) => {
        const own = runInfo.filter((info) => info["candidate"] === candidate);
        const sum = (field: string) =>
          own.reduce((total, info) => total + Number(info[field] ?? 0), 0);
        return [
          candidate,
          {
            entries: sum("entries"),
            recordedAsPreloadedLead: sum("fromLeads"),
            overlappingATop3LeadOtherwise: sum("overlapsTop3Lead"),
          },
        ];
      }),
    );
    const families = new Map<string, number>();
    for (const entry of selection.selected)
      families.set(entry.family, (families.get(entry.family) ?? 0) + 1);
    const sizes = [...harnessHunksOf.values()];
    const stats = (values: ReadonlyArray<number>) => {
      const sorted = [...values].sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      return {
        regions: sorted.length,
        meanLines: round(
          sorted.reduce((sum, value) => sum + value, 0) / (sorted.length || 1),
          1,
        ),
        medianLines:
          sorted.length === 0
            ? null
            : sorted.length % 2 === 1
              ? sorted[middle]!
              : (sorted[middle - 1]! + sorted[middle]!) / 2,
      };
    };
    const unscoredKeys = [...unscoredLeads.keys()]
      .filter((key) => key.startsWith(`${DEFAULT_CANDIDATE}\u0000`))
      .map((key) => key.slice(DEFAULT_CANDIDATE.length + 1));
    const unscoredSame = unscoredKeys.filter(
      (key) =>
        unscoredLeads.get(`${DEFAULT_CANDIDATE}\u0000${key}`) ===
        unscoredLeads.get(`R(H3-E3)\u0000${key}`),
    ).length;
    return {
      regionWidths: Object.fromEntries(
        CANDIDATES.map((candidate) => [
          candidate,
          {
            ledger: stats(widths.get(candidate)!.ledger),
            top3: stats(widths.get(candidate)!.top3),
          },
        ]),
      ),
      treatment: {
        scoredHunks: hunks.length,
        identicalTop3: group(true),
        differingTop3: group(false),
        harnessHunks: harnessTotal,
        unscoredHarnessHunks: harnessTotal - seededTotal,
        /** Compared in the two manifests, not assumed: hunks whose stored leads are identical. */
        unscoredLeadsCompared: unscoredKeys.length,
        unscoredLeadsIdentical: unscoredSame,
      },
      leadInfluence: influence,
      selectionSkew: {
        harnessHunksPerRange: {
          min: Math.min(...sizes),
          max: Math.max(...sizes),
          byRange: Object.fromEntries(harnessHunksOf),
        },
        rangesPerFamily: Object.fromEntries(
          [...families].sort((a, b) => b[1] - a[1]),
        ),
      },
    };
  };

  const out = {
    schemaVersion: 1,
    gold: goldDir,
    goldCheck: check,
    scoredHunks: hunks.length,
    scoredCases: new Set(hunks.map((hunk) => hunk.caseId)).size,
    exclusions: exclusions.map((exclusion) => exclusion.rule),
    missingRuns: missing,
    droppedByCrossFamily: {
      necessary: allTargets.necessary - crossTargets.necessary,
      useful: allTargets.useful - crossTargets.useful,
    },
    rules: {
      metric:
        "coverage at depth: B4 fractional recall of each hunk's targets by every region the ledger kept for it (already cut to the hunk's allowance), family-weighted means",
      delta:
        "R(H3-E3) minus R(H3-E1) per hunk; B4 paired family bootstrap (seed neuve-m4-b4-bootstrap-v1, 10,000 resamples) at 95% and at comparison 6's Bonferroni level, and the sign-flip permutation p",
      crossFamily:
        "kept: agreed, owner-decided, council-decided with sol-medium and sol-high both voting the decided grade in the final round; dropped targets are unjudged",
      opusOverlap:
        "opus-agreed: Opus's own label (opus, or opus (grader)) equals the final grade; opus-disagreed: it does not",
    },
    summary,
    runs: runInfo,
    perHunk: rows.map((row) => ({
      ...row,
      necessary: round(row.necessary),
      useful: round(row.useful),
      relevant: round(row.relevant),
      necessaryAny: round(row.necessaryAny),
      relevantAny: round(row.relevantAny),
      misleadingShare: round(row.misleadingShare),
    })),
    context: contextOf(),
  };
  writeFileSync(
    join(RESULTS, "score.json"),
    `${JSON.stringify(out, null, 2)}\n`,
  );
  const lines = markdown(out);
  writeFileSync(join(RESULTS, "score.md"), `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
  return out;
};

type Summary = {
  view: string;
  targets: { necessary: number; useful: number };
  perCandidate: Record<
    string,
    Record<string, { mean: number | null; hunkMean: number | null }>
  >;
  deltaE3MinusE1: Record<
    string,
    {
      delta: number | null;
      ci95: Array<number | null>;
      ciComparison6Level: {
        level: number | null;
        interval: Array<number | null>;
      };
      permutationP: number | null;
      hunks: number;
    }
  >;
};

/** score.md: measurements in tables first, then the interpretation, labelled as such (2.16). */
const markdown = (out: {
  scoredHunks: number;
  scoredCases: number;
  missingRuns: ReadonlyArray<string>;
  goldCheck: unknown;
  droppedByCrossFamily: { necessary: number; useful: number };
  summary: ReadonlyArray<unknown>;
  context: ReturnType<() => Record<string, any>>;
}) => {
  const summary = out.summary as ReadonlyArray<Summary>;
  const view = (name: string) => summary.find((entry) => entry.view === name)!;
  const mean = (entry: Summary, key: string, metric: string) =>
    entry.perCandidate[key]![metric]!.mean;
  const interval = (values: ReadonlyArray<number | null>) =>
    `[${values.join(", ")}]`;
  const ctx = out.context;
  const t = ctx["treatment"];
  const all = view("all");
  return [
    "# Harness comparison, R(H3-E1) vs R(H3-E3) (9.57, 10.78, 10.81)",
    "",
    `Measured on ${out.scoredHunks} hunks in ${out.scoredCases} ranges after 9.47 (missing runs: ${out.missingRuns.length === 0 ? "none" : out.missingRuns.join(", ")}). Gold check ${JSON.stringify(out.goldCheck)}; the cross-family view drops ${out.droppedByCrossFamily.necessary} necessary and ${out.droppedByCrossFamily.useful} useful targets of these hunks.`,
    "",
    "**10.81 caveat.** This comparison runs on 12 of the 23 dev ranges for cost, so its intervals are wide and a small difference between the candidates may not be detectable. The intervals below are 95% and, beside them, at comparison 6's Bonferroni level (6 comparisons, 99.17%).",
    "",
    "## Measurements",
    "",
    "### Coverage at depth (fractional rule), Investigate's ledger",
    "",
    "Delta is R(H3-E3) minus R(H3-E1) per hunk, B4's paired family bootstrap.",
    "",
    "| view | targets (N/U) | E1 N / R | E3 N / R | delta N [95%] [99.17%] | delta R [95%] [99.17%] | permutation p (N / R) |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...summary.map((entry) => {
      const d = entry.deltaE3MinusE1;
      return `| ${entry.view} | ${entry.targets.necessary}/${entry.targets.useful} | ${mean(entry, "R(H3-E1) ledger", "necessary")} / ${mean(entry, "R(H3-E1) ledger", "relevant")} | ${mean(entry, "R(H3-E3) ledger", "necessary")} / ${mean(entry, "R(H3-E3) ledger", "relevant")} | ${d["necessary"]!.delta} ${interval(d["necessary"]!.ci95)} ${interval(d["necessary"]!.ciComparison6Level.interval)} | ${d["relevant"]!.delta} ${interval(d["relevant"]!.ci95)} ${interval(d["relevant"]!.ciComparison6Level.interval)} | ${d["necessary"]!.permutationP} / ${d["relevant"]!.permutationP} |`;
    }),
    "",
    "### Treatment contrast and run-to-run noise (view all, ledger, relevant)",
    "",
    "| scored hunks | top 3 leads | hunks | ranges | with relevant gold | mean delta R | mean abs delta R |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...(["identicalTop3", "differingTop3"] as const).map((key) => {
      const g = t[key];
      return `| ${t.scoredHunks} | ${key === "identicalTop3" ? "identical in E1 and E3" : "differ"} | ${g.hunks} | ${g.ranges} | ${g.withRelevantGold} | ${g.meanDeltaRelevant} | ${g.meanAbsDeltaRelevant} |`;
    }),
    "",
    `The ranges hold ${t.harnessHunks} harness hunks. The ${t.unscoredHarnessHunks} without an M4 hunk have no frozen ranking and got the harness's own BM25 leads; comparing the two manifests, ${t.unscoredLeadsIdentical} of the ${t.unscoredLeadsCompared} compared have identical stored leads in both candidates.`,
    "",
    "### Region widths the scorer sees (lines per region, scored hunks)",
    "",
    "| candidate | ledger regions | ledger mean / median | top-3 regions | top-3 mean / median |",
    "| --- | --- | --- | --- | --- |",
    ...Object.entries(ctx["regionWidths"] as Record<string, any>).map(
      ([candidate, value]) =>
        `| ${candidate} | ${value.ledger.regions} | ${value.ledger.meanLines} / ${value.ledger.medianLines} | ${value.top3.regions} | ${value.top3.meanLines} / ${value.top3.medianLines} |`,
    ),
    "",
    "### Leads alone against the ledger, under both overlap rules (view all)",
    "",
    "Each cell is necessary / relevant coverage: B4's family-weighted mean, then the plain mean over hunks in brackets.",
    "",
    "| source | E1 fractional | E3 fractional | E1 any line | E3 any line |",
    "| --- | --- | --- | --- | --- |",
    ...(
      [
        ["Investigate's ledger", "ledger"],
        ["frozen top 3 leads alone", "frozen-top3"],
        ["ledger plus top 3", "ledger+top3"],
      ] as const
    ).map(([label, source]) => {
      const cell = (candidate: string, n: string, r: string) => {
        const c = all.perCandidate[`${candidate} ${source}`]!;
        return `${c[n]!.mean} / ${c[r]!.mean} [${c[n]!.hunkMean} / ${c[r]!.hunkMean}]`;
      };
      return `| ${label} | ${cell("R(H3-E1)", "necessary", "relevant")} | ${cell("R(H3-E3)", "necessary", "relevant")} | ${cell("R(H3-E1)", "necessaryAny", "relevantAny")} | ${cell("R(H3-E3)", "necessaryAny", "relevantAny")} |`;
    }),
    "",
    "### Lead influence on the ledger (entries anchored to the scored hunks)",
    "",
    "| candidate | entries | recorded as a preloaded lead | other entries overlapping a top-3 lead's region |",
    "| --- | --- | --- | --- |",
    ...Object.entries(ctx["leadInfluence"] as Record<string, any>).map(
      ([candidate, value]) =>
        `| ${candidate} | ${value.entries} | ${value.recordedAsPreloadedLead} | ${value.overlappingATop3LeadOtherwise} |`,
    ),
    "",
    "### Selection skew",
    "",
    `Strata use M4's picked-hunk count per range (1 or 2-4), not the range's size: the chosen ranges hold ${ctx["selectionSkew"].harnessHunksPerRange.min}-${ctx["selectionSkew"].harnessHunksPerRange.max} harness hunks each. Ranges per family: ${Object.entries(
      ctx["selectionSkew"].rangesPerFamily as Record<string, number>,
    )
      .map(([family, count]) => `${family} ${count}`)
      .join(", ")}.`,
    "",
    "## Interpretation (agent reading of the measurements above, not a measurement)",
    "",
    "Each direction below is computed from the tables at render time, so a rescore cannot leave it stale.",
    "",
    ...interpretation(summary, ctx),
  ];
};

/** The interpretation's statements, each worded from the measured direction it rests on. */
const interpretation = (
  summary: ReadonlyArray<Summary>,
  ctx: Record<string, any>,
): Array<string> => {
  const t = ctx["treatment"];
  const all = summary.find((entry) => entry.view === "all")!;
  const intervals = summary.flatMap((entry) =>
    (["necessary", "relevant"] as const).map((metric) => ({
      label: `${entry.view} ${metric}`,
      ci: entry.deltaE3MinusE1[metric]!.ci95,
    })),
  );
  const notSpanning = intervals.filter(
    ({ ci }) => ci[0] === null || ci[1] === null || ci[0]! > 0 || ci[1]! < 0,
  );
  const clearsMargin = intervals.filter(
    ({ ci }) => ci[0] !== null && ci[0]! > 0.03,
  );
  const lines: Array<string> = [];
  lines.push(
    notSpanning.length === 0
      ? `- What this can claim: no detectable end-to-end difference between R(H3-E1) and R(H3-E3) at this size. It is not evidence of equivalence: all ${intervals.length} 95% intervals (four views, necessary and relevant) span zero${clearsMargin.length === 0 ? ", and none has a lower bound above 9.21's +3-point margin" : ""}.`
      : `- ${notSpanning.length} of ${intervals.length} 95% intervals exclude zero (${notSpanning.map((entry) => entry.label).join(", ")}); read them against 10.81's caveat before claiming a difference.`,
  );
  lines.push(
    `- The treatment is thin: only ${t.differingTop3.hunks} of ${t.scoredHunks} scored hunks, in ${t.differingTop3.ranges} ranges, saw different preloaded top-3 leads; ${t.unscoredLeadsIdentical === t.unscoredLeadsCompared ? `all ${t.unscoredLeadsCompared} unscored harness hunks had identical BM25 leads in both runs` : `${t.unscoredLeadsCompared - t.unscoredLeadsIdentical} of ${t.unscoredLeadsCompared} unscored harness hunks had different stored leads between the runs, which this comparison did not intend`}.`,
  );
  const same = t.identicalTop3.meanAbsDeltaRelevant;
  const differ = t.differingTop3.meanAbsDeltaRelevant;
  lines.push(
    same !== null && differ !== null && same >= differ
      ? `- Run-to-run noise is at least as large as the effect: on the ${t.identicalTop3.hunks} hunks whose leads were identical, the mean absolute relevant delta (${same}) is not smaller than on the ${t.differingTop3.hunks} where they differed (${differ}).`
      : `- The hunks whose leads differed moved more (mean absolute relevant delta ${differ}) than those with identical leads (${same}), so the leads may carry some effect beyond run-to-run noise.`,
  );
  const pair = (source: string, metric: string) =>
    (["R(H3-E1)", "R(H3-E3)"] as const).map(
      (candidate) =>
        all.perCandidate[`${candidate} ${source}`]![metric]!.mean ?? 0,
    );
  const direction = (metric: string) => {
    const ledger = pair("ledger", metric);
    const top3 = pair("frozen-top3", metric);
    const ahead = ledger.map((value, index) =>
      value > top3[index]! ? "ledger" : value < top3[index]! ? "top 3" : "tie",
    );
    return ahead[0] === ahead[1] ? ahead[0]! : "mixed";
  };
  const fractional = direction("relevant");
  const anyLine = direction("relevantAny");
  lines.push(
    `- Leads alone against the ledger (relevant, family-weighted, both candidates): under the fractional rule ${fractional === "mixed" ? "the order differs between candidates" : fractional === "tie" ? "they tie" : `the ${fractional} is ahead`}; under the any-line rule ${anyLine === "mixed" ? "the order differs between candidates" : anyLine === "tie" ? "they tie" : `the ${anyLine} is ahead`}.${fractional === "top 3" && anyLine === "ledger" ? " So the ledger touches more targets but covers many of them only in part." : ""}`,
  );
  const widths = ctx["regionWidths"] as Record<
    string,
    {
      ledger: { meanLines: number; medianLines: number };
      top3: { meanLines: number; medianLines: number };
    }
  >;
  const compare = (a: number, b: number) =>
    a > b ? "wider" : a < b ? "narrower" : "the same width";
  const split = Object.values(widths).some(
    (value) =>
      compare(value.ledger.meanLines, value.top3.meanLines) !==
      compare(value.ledger.medianLines, value.top3.medianLines),
  );
  lines.push(
    `- Region width, ledger against top 3: ${Object.entries(widths)
      .map(
        ([candidate, value]) =>
          `${candidate} ledger regions are ${compare(value.ledger.meanLines, value.top3.meanLines)} on average (${value.ledger.meanLines} against ${value.top3.meanLines} lines) and ${compare(value.ledger.medianLines, value.top3.medianLines)} at the median (${value.ledger.medianLines} against ${value.top3.medianLines})`,
      )
      .join(
        "; ",
      )}.${split ? " The two readings disagree, so region width alone does not explain the split between the overlap rules." : ""}`,
  );
  return lines;
};

export type { Placement };
