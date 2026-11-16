import { Data, Effect } from "effect";
import { z } from "zod";
import { unifiedDiff } from "./git.ts";
import {
  computedShare,
  describeHunk,
  parseHunks,
  realShare,
  selectHunks,
} from "./hunks.ts";
import {
  BENCHMARK_PATHS,
  CORPORA,
  GRAPH_TUNED_FILES,
  GRAPH_TUNING_HEADS,
  PHASE2_FILES,
  REAL_SHARE,
  RULES,
  SEED,
  isBuildFile,
  type CorpusKey,
} from "./policy.ts";
import { selectRanges } from "./ranges.ts";

const Sha = z.string().regex(/^[0-9a-f]{40}$/);
const Corpus = z.enum(["neuve_effect", "neuve"]);
const Split = z.enum(["dev", "held-out"]);
const Share = z.strictObject({
  opus: z.int().nonnegative(),
  sol: z.int().nonnegative(),
});

const Hunk = z.strictObject({
  id: z.string().regex(/^h-[0-9a-f]{12}$/),
  path: z.string().min(1),
  oldPath: z.string().min(1),
  old: z.strictObject({
    start: z.int().nonnegative(),
    lines: z.int().nonnegative(),
  }),
  new: z.strictObject({
    start: z.int().nonnegative(),
    lines: z.int().nonnegative(),
  }),
  added: z.int().nonnegative(),
  deleted: z.int().nonnegative(),
  changedLines: z.int().positive(),
  tunedFile: z.boolean(),
  /** The 9.17 share before the 9.23 minimum. */
  computedShare: Share,
  realShare: Share,
  raisedToMinimum: z.strictObject({
    opus: z.boolean(),
    sol: z.boolean(),
  }),
});

const Case = z.strictObject({
  id: z.string(),
  repository: Corpus,
  kind: z.enum(["merge", "slice", "direct", "stress"]),
  base: Sha,
  head: Sha,
  commits: z.array(Sha),
  subjects: z.array(z.string()),
  family: z.string(),
  split: Split,
  strata: z.strictObject({
    changeType: z.enum([
      "feature",
      "fix",
      "refactor",
      "test-adding",
      "docs-plus-code",
    ]),
    size: z.enum(["S", "M", "L"]),
    scopeSource: z.enum([
      "plan-at-base",
      "plan-in-range",
      "commit-text",
      "none",
    ]),
    area: z.string(),
  }),
  changedLines: z.int().positive(),
  reviewLines: z.int().positive(),
  dataLines: z.int().nonnegative(),
  period: z.string().regex(/^\d{4}-Q[1-4]$/),
  codeFiles: z.int().positive(),
  scopeDocsAtBase: z.array(z.string()),
  inRangeDocs: z.array(
    z.strictObject({
      path: z.string(),
      class: z.enum(["scope", "hindsight", "other"]),
      status: z.enum(["added", "edited", "deleted"]),
    }),
  ),
  tunedFiles: z.array(z.string()),
  phase2Files: z.array(z.string()),
  graphTuningRange: z.boolean(),
  leakageTags: z.array(
    z.enum(["graph-tuning-adjacent", "adapter-training-adjacent"]),
  ),
  hunks: z.array(Hunk).min(1).max(4),
});

const Distribution = z.strictObject({
  min: z.int(),
  median: z.number(),
  max: z.int(),
  raisedToMinimum: z.int().nonnegative(),
});

export const Manifest = z.strictObject({
  schemaVersion: z.literal(1),
  benchmark: z.literal("neuve-m4-retrieval"),
  slice: z.literal("B1"),
  seed: z.string(),
  corpora: z.record(
    Corpus,
    z.strictObject({
      role: z.enum(["primary", "secondary"]),
      head: Sha,
      rangeTarget: z.int(),
    }),
  ),
  rules: z.json(),
  realShare: z.strictObject({
    formula: z.string(),
    workingShare: z.number(),
    workingShareStatus: z.string(),
    windows: z.strictObject({ opus: z.int(), sol: z.int() }),
    denominator: z.string(),
    minimum: z.int(),
    minimumStatus: z.string(),
  }),
  leakage: z.strictObject({
    graphTunedFiles: z.array(z.string()),
    graphTuningHeads: z.array(Sha),
    phase2Files: z.array(z.string()),
    benchmarkPaths: z.array(z.string()),
  }),
  summary: z.strictObject({
    cases: z.int(),
    hunks: z.int(),
    excluded: z.record(Corpus, z.record(z.string(), z.int())),
    families: z.record(
      Corpus,
      z.strictObject({ dev: z.int(), heldOut: z.int() }),
    ),
    strata: z.record(z.string(), z.record(z.string(), z.int())),
    bySplit: z.record(
      z.string(),
      z.strictObject({
        cases: z.int(),
        changeType: z.record(z.string(), z.int()),
        scopeSource: z.record(z.string(), z.int()),
        size: z.record(z.string(), z.int()),
        kind: z.record(z.string(), z.int()),
        period: z.record(z.string(), z.int()),
        repository: z.record(z.string(), z.int()),
      }),
    ),
    hubs: z.record(
      Corpus,
      z.array(z.strictObject({ document: z.string(), families: z.int() })),
    ),
    heldOutComparisons: z.record(
      z.string(),
      z.strictObject({
        excludedCases: z.int(),
        cases: z.int(),
        hunks: z.int(),
      }),
    ),
    dataDominated: z.array(
      z.strictObject({
        id: z.string(),
        split: Split,
        reviewLines: z.int(),
        dataLines: z.int(),
        changedLines: z.int(),
      }),
    ),
    quotas: z.record(
      Corpus,
      z.array(
        z.strictObject({
          category: z.string(),
          quota: z.int(),
          familiesInPool: z.int(),
          reachable: z.int(),
          filledByQuota: z.int(),
          selected: z.int(),
        }),
      ),
    ),
    realShare: z.strictObject({ opus: Distribution, sol: Distribution }),
  }),
  families: z.array(
    z.strictObject({
      id: z.string(),
      repository: Corpus,
      split: Split,
      forcedDev: z.string().nullable(),
      /** The raw families merged into this one through shared handover directories. */
      members: z.array(z.string()).min(1),
      eligibleRanges: z.int(),
      selectedRanges: z.int(),
    }),
  ),
  cases: z.array(Case),
});
export type Manifest = z.infer<typeof Manifest>;

/** The built manifest failed its own schema or an internal consistency check. */
export class ManifestInvalid extends Data.TaggedError("ManifestInvalid")<{
  readonly message: string;
}> {}

const distribution = (
  values: ReadonlyArray<number>,
  raised: ReadonlyArray<boolean>,
) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length / 2;
  const median =
    sorted.length === 0
      ? 0
      : sorted.length % 2 === 1
        ? (sorted[Math.floor(middle)] ?? 0)
        : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  return {
    min: sorted[0] ?? 0,
    median,
    max: sorted.at(-1) ?? 0,
    raisedToMinimum: raised.filter(Boolean).length,
  };
};

const tally = (values: ReadonlyArray<string>) => {
  const counts: Record<string, number> = {};
  for (const value of [...values].sort())
    counts[value] = (counts[value] ?? 0) + 1;
  return counts;
};

/** Builds the case manifest from the two corpora. The same corpora always give the same bytes. */
export const buildManifest = (
  repositories: Readonly<Record<CorpusKey, string>>,
) =>
  Effect.gen(function* () {
    const selection = yield* selectRanges(repositories);
    const split = new Map(
      selection.families.map((family) => [family.id, family.split]),
    );
    const cases = yield* Effect.forEach(
      selection.ranges,
      (range) =>
        Effect.gen(function* () {
          const diff = yield* unifiedDiff(
            repositories[range.corpus],
            range.base,
            range.head,
            range.diffPaths,
          );
          const all = parseHunks(diff);
          const total = all.reduce(
            (sum, hunk) => sum + hunk.added + hunk.deleted,
            0,
          );
          if (total !== range.changedLines)
            return yield* new ManifestInvalid({
              message: `${range.id}: hunks hold ${total} changed lines but numstat counted ${range.changedLines}`,
            });
          // Build files count toward the range but are never labelled hunks.
          const hunks = selectHunks(
            all.filter((hunk) => !isBuildFile(hunk.path)),
          ).map((hunk) => {
            const described = describeHunk(range.id, hunk);
            const computed = computedShare(
              described.changedLines,
              range.reviewLines,
            );
            const share = realShare(described.changedLines, range.reviewLines);
            return {
              ...described,
              computedShare: computed,
              realShare: share,
              raisedToMinimum: {
                opus: computed.opus < REAL_SHARE.minimum,
                sol: computed.sol < REAL_SHARE.minimum,
              },
            };
          });
          return {
            id: range.id,
            repository: range.corpus,
            kind: range.kind,
            base: range.base,
            head: range.head,
            commits: [...range.commits],
            subjects: [...range.subjects],
            family: range.family,
            split: split.get(range.family) ?? "dev",
            strata: { ...range.strata },
            changedLines: range.changedLines,
            reviewLines: range.reviewLines,
            dataLines: range.dataLines,
            period: range.period,
            codeFiles: range.codeFiles.length,
            scopeDocsAtBase: [...range.scopeDocsAtBase],
            inRangeDocs: range.inRangeDocs.map((doc) => ({ ...doc })),
            tunedFiles: [...range.tunedFiles],
            phase2Files: [...range.phase2Files],
            graphTuningRange: range.graphTuningRange,
            leakageTags: [...range.leakageTags] as Array<
              "graph-tuning-adjacent" | "adapter-training-adjacent"
            >,
            hunks,
          };
        }),
      { concurrency: 8 },
    );
    const hunks = cases.flatMap((entry) => entry.hunks);
    const corpora = Object.keys(CORPORA) as Array<CorpusKey>;
    const familyCounts = (corpus: CorpusKey) => {
      const families = selection.families.filter(
        (family) => family.corpus === corpus,
      );
      return {
        dev: families.filter((family) => family.split === "dev").length,
        heldOut: families.filter((family) => family.split === "held-out")
          .length,
      };
    };
    const candidate = {
      schemaVersion: 1,
      benchmark: "neuve-m4-retrieval",
      slice: "B1",
      seed: SEED,
      corpora: Object.fromEntries(
        corpora.map((corpus) => [
          corpus,
          {
            role: CORPORA[corpus].role,
            head: CORPORA[corpus].head,
            rangeTarget: CORPORA[corpus].rangeTarget,
          },
        ]),
      ),
      rules: RULES,
      realShare: { ...REAL_SHARE, windows: { ...REAL_SHARE.windows } },
      leakage: {
        graphTunedFiles: [...GRAPH_TUNED_FILES],
        graphTuningHeads: [...GRAPH_TUNING_HEADS],
        phase2Files: [...PHASE2_FILES],
        benchmarkPaths: [...BENCHMARK_PATHS],
      },
      summary: {
        cases: cases.length,
        hunks: hunks.length,
        excluded: selection.excluded,
        families: Object.fromEntries(
          corpora.map((corpus) => [corpus, familyCounts(corpus)]),
        ),
        strata: {
          changeType: tally(cases.map((entry) => entry.strata.changeType)),
          size: tally(cases.map((entry) => entry.strata.size)),
          scopeSource: tally(cases.map((entry) => entry.strata.scopeSource)),
          area: tally(
            cases.map((entry) => `${entry.repository}:${entry.strata.area}`),
          ),
          split: tally(cases.map((entry) => entry.split)),
          kind: tally(cases.map((entry) => entry.kind)),
          period: tally(cases.map((entry) => entry.period)),
        },
        bySplit: Object.fromEntries(
          (["dev", "held-out"] as const).map((split) => {
            const subset = cases.filter((entry) => entry.split === split);
            return [
              split,
              {
                cases: subset.length,
                changeType: tally(
                  subset.map((entry) => entry.strata.changeType),
                ),
                scopeSource: tally(
                  subset.map((entry) => entry.strata.scopeSource),
                ),
                size: tally(subset.map((entry) => entry.strata.size)),
                kind: tally(subset.map((entry) => entry.kind)),
                period: tally(subset.map((entry) => entry.period)),
                repository: tally(subset.map((entry) => entry.repository)),
              },
            ];
          }),
        ),
        quotas: selection.quotas,
        dataDominated: cases
          .filter((entry) => entry.dataLines * 2 > entry.reviewLines)
          .map((entry) => ({
            id: entry.id,
            split: entry.split,
            reviewLines: entry.reviewLines,
            dataLines: entry.dataLines,
            changedLines: entry.changedLines,
          })),
        heldOutComparisons: (() => {
          const heldOut = cases.filter((entry) => entry.split === "held-out");
          const keep = (
            tag: string,
            hunkFilter: (hunk: { readonly tunedFile: boolean }) => boolean,
          ) => {
            const kept = heldOut.filter(
              (entry) => !entry.leakageTags.includes(tag as never),
            );
            return {
              excludedCases: heldOut.length - kept.length,
              cases: kept.length,
              hunks: kept.flatMap((entry) => entry.hunks.filter(hunkFilter))
                .length,
            };
          };
          return {
            "G-fork vs G-base": keep(
              "graph-tuning-adjacent",
              (hunk) => !hunk.tunedFile,
            ),
            "E1 vs E0": keep("adapter-training-adjacent", () => true),
          };
        })(),
        hubs: Object.fromEntries(
          corpora.map((corpus) => [
            corpus,
            selection.hubs
              .filter((hub) => hub.key.startsWith(`${corpus}/`))
              .map((hub) => ({
                document: hub.key.slice(hub.key.indexOf("/") + 1),
                families: hub.families,
              })),
          ]),
        ),
        realShare: {
          opus: distribution(
            hunks.map((hunk) => hunk.realShare.opus),
            hunks.map((hunk) => hunk.raisedToMinimum.opus),
          ),
          sol: distribution(
            hunks.map((hunk) => hunk.realShare.sol),
            hunks.map((hunk) => hunk.raisedToMinimum.sol),
          ),
        },
      },
      families: selection.families.map((family) => ({
        id: family.id,
        repository: family.corpus,
        split: family.split,
        forcedDev: family.forcedDev ?? null,
        members: [...family.members],
        eligibleRanges: family.eligible,
        selectedRanges: family.selected,
      })),
      cases,
    };
    const parsed = Manifest.safeParse(candidate);
    if (!parsed.success)
      return yield* new ManifestInvalid({
        message: z.prettifyError(parsed.error),
      });
    return parsed.data;
  });

/** The committed form: two-space JSON with a trailing newline. */
export const serializeManifest = (manifest: Manifest) =>
  `${JSON.stringify(manifest, null, 2)}\n`;
