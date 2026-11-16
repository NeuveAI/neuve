import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  evaluateBudget,
  familyMean,
} from "../retrieval-bench/score/metrics.ts";
import {
  familyBootstrap,
  familyPermutation,
} from "../retrieval-bench/score/stats.ts";
import {
  loadScoringInputs,
  type DevHunk,
} from "../retrieval-bench/scoring-inputs.ts";
import {
  DEFAULT_CANDIDATE,
  STICKY_RESULTS,
  comparisonExclusions,
  ensureDir,
  excludedHunk,
  root,
} from "./common.ts";
import { judgedGrade } from "../retrieval-bench/score/coverage.ts";
import { placeEntry, rankingFor } from "./ledgers.ts";
import { spanKey, type Item } from "../retrieval-bench/ranking.ts";
import {
  COMPARISON,
  OPUS,
  readSpend,
  runRanges,
  type Lane,
  type RouteSpec,
  type RunMode,
  type SpendEntry,
} from "./runner.ts";
import { DEFAULT_GOLD, loadViews, readRun, readSeed, round } from "./score.ts";
import { readSelection } from "./select.ts";
import { shownLeads } from "./shown-leads.ts";

/**
 * The 10.84 measurement: Investigate with its top leads seeded into the ledger, on R(H3-E1)'s leads,
 * over the comparison's 12 ranges, scored against the same gold as the 9.57 comparison.
 *
 * Arms. Both run on every route, from the same snapshot: "seeded" is the harness as committed;
 * "no-seed" is requested with `--stub-no-seed-leads`, a development setting frozen in its run's
 * configuration (`stub.seedLeads: false`) and printed on its receipt, under which Investigate runs
 * exactly as version 1 did. The two runs share the range's cycle, and the second reuses the first's
 * Understand, merge pass and scope snapshot (runner.ts; Understand's key leaves `seedLeads` out),
 * so the arms differ only from Investigate on. Which arm goes first alternates with the run order.
 *
 * Snapshot. The harness runs from a snapshot of HEAD taken when a route's first run starts and
 * pinned in `sticky-leads/<route>/snapshot.json` (a dry run pins nothing); later invocations reuse
 * it, so every range runs the same harness while other lanes commit. The snapshot must contain the
 * seeding and its development setting.
 *
 * Spend. Opus: a 20 USD stop; before each run, the spend so far plus 1.25 times the committed
 * comparison's R(H3-E1) cost for that range (plus its Understand, where it reused R(H3-E3)'s) must
 * stay under it. Sol: no USD price, so cost is in tokens, no USD stop, and the plan's usage limit
 * stops the invocation (runner.ts).
 *
 * Stages. The score reads only the ledgers. Every request carries `--stub-hold assemble=3600`, so
 * Assemble (and so Dispose and Publish) waits instead of spending, and the worker is stopped once
 * every Investigate partition is done; a run cut off before that is requested again as a new
 * generation, which reuses the stored stages (10.42).
 *
 * Outputs: `sticky-leads/<route>/` (spend.json, snapshot.json, runs/<case>/, score.json, score.md).
 * Committed outputs are never written. A truncated run is stored as `<lane>.incomplete.json.gz`,
 * never scored, and listed.
 */

export const STICKY_STOP_USD = 20;
const SEEDED: Lane = {
  slug: "e1-seeded",
  candidate: DEFAULT_CANDIDATE,
  env: {},
};
const NO_SEED: Lane = {
  slug: "e1-no-seed",
  candidate: DEFAULT_CANDIDATE,
  env: {},
  requestArgs: ["--stub-no-seed-leads"],
};
const LANES: ReadonlyArray<Lane> = [NO_SEED, SEEDED];

/**
 * GPT-6.1-Sol on the owner's ChatGPT sign-in (10.85), as committed: `neuve review --route openai`
 * freezes the route in the request, and the worker admits the job when it can read the sign-in in
 * `$XDG_CONFIG_HOME/neuve/` or `~/.config/neuve/` (openai-auth.ts `authDirectory`). The scratch home
 * gets a link to the user's folder, so the worker reads (and refreshes in place) the one sign-in and
 * nothing else of the user's home; the token is never copied or printed. A worker that cannot use
 * it makes no model call, which stops the invocation (runner.ts).
 */
export const SOL: RouteSpec = {
  name: "sol",
  requestArgs: ["--route", "openai"],
  credential: (home) => {
    const real = join(homedir(), ".config", "neuve");
    const linked = join(home, ".config", "neuve");
    if (!existsSync(real))
      throw new Error(
        "no ~/.config/neuve: sign in with `neuve auth login openai` first",
      );
    if (!existsSync(linked)) {
      mkdirSync(join(home, ".config"), { recursive: true });
      symlinkSync(real, linked);
    }
    return {};
  },
  price: null,
};

/**
 * The lead-drop re-measurement: the same Sol route and lanes, its own results folder and pinned
 * snapshot, which must hold Investigate's version-5 drop checks (reason replaced, carried anchors).
 * Both arms run fresh from that snapshot: the stored `sol` arms predate 11.13, whose Understand and
 * Investigate prompts changed, so neither stored arm shares this snapshot's Understand.
 */
export const SOL_DROPS: RouteSpec = { ...SOL, name: "sol-drops" };

export const ROUTES: Record<string, RouteSpec> = {
  opus: OPUS,
  sol: SOL,
  "sol-drops": SOL_DROPS,
};

/** Text a route's snapshot must hold in investigate.ts beyond 10.84's seeding. */
const SNAPSHOT_HOLDS: Record<string, string> = {
  "sol-drops": "export const SeededDropInput",
};

const resultsOf = (route: RouteSpec) => join(STICKY_RESULTS, route.name);

/** The snapshot commit for a route's runs: pinned on the first run (not a dry one), then reused. */
const pinnedSnapshot = (
  route: RouteSpec,
  requested: string | undefined,
  dry: boolean,
) => {
  const file = join(resultsOf(route), "snapshot.json");
  const pinned = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as { commit: string }).commit
    : undefined;
  const git = (...args: Array<string>) => {
    const result = Bun.spawnSync(["git", "-C", root, ...args]);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  const commit =
    pinned ?? git("rev-parse", "--verify", `${requested ?? "HEAD"}^{commit}`);
  if (requested !== undefined && pinned !== undefined) {
    const asked = git("rev-parse", "--verify", `${requested}^{commit}`);
    if (asked !== pinned)
      throw new Error(
        `${route.name}'s runs are pinned to ${pinned}; remove ${file} and its runs to start again at ${asked}`,
      );
  }
  const holds = (path: string, text: string) =>
    git("show", `${commit}:${path}`).includes(text);
  if (
    !holds(
      "packages/harness/src/investigate.ts",
      "export const investigatePromptVersion",
    ) ||
    !holds("apps/neuve-cli/src/review-cli.ts", "stub-no-seed-leads")
  )
    throw new Error(
      `${commit} does not contain 10.84's seeded leads and --stub-no-seed-leads; commit them before measuring`,
    );
  const needs = SNAPSHOT_HOLDS[route.name];
  if (
    needs !== undefined &&
    !holds("packages/harness/src/investigate.ts", needs)
  )
    throw new Error(
      `${commit} does not contain Investigate's lead-drop checks (${needs}); commit them before measuring on ${route.name}`,
    );
  if (pinned === undefined && !dry) {
    ensureDir(resultsOf(route));
    writeFileSync(
      file,
      `${JSON.stringify({ commit, pinnedAt: new Date().toISOString() }, null, 2)}\n`,
    );
  }
  return commit;
};

/** Opus's reserve: the committed comparison's cost for the range, with its Understand, times 1.25. */
const opusReserve = (caseId: string) => {
  const committed = readSpend(COMPARISON).filter(
    (entry) => entry.caseId === caseId,
  );
  const e1 = committed.find((entry) => entry.candidate === DEFAULT_CANDIDATE);
  const e3 = committed.find((entry) => entry.candidate !== DEFAULT_CANDIDATE);
  if (e1 === undefined) return 5;
  // R(H3-E1) ran second on even orders and reused Understand; the first run's surplus estimates it.
  const understand =
    e1.order % 2 === 0 && e3 !== undefined
      ? Math.max(0, (e3.costUsd ?? 0) - (e1.costUsd ?? 0))
      : 0;
  return 1.25 * ((e1.costUsd ?? 0) + understand);
};

/** The plan route's default budget, in input tokens over every run of the route (cli --stop-input-tokens). */
export const DEFAULT_STOP_INPUT_TOKENS = 30_000_000;

export const stickyMode = (
  routeName: string,
  snapshot: string | undefined,
  dry: boolean,
  stopInputTokens: number = DEFAULT_STOP_INPUT_TOKENS,
): RunMode => {
  const route = ROUTES[routeName];
  if (route === undefined)
    throw new Error(
      `unknown route ${routeName}; known: ${Object.keys(ROUTES).join(", ")}`,
    );
  return {
    lanes: LANES,
    snapshotCommit: pinnedSnapshot(route, snapshot, dry),
    route,
    results: resultsOf(route),
    stopUsd: route.price === null ? null : STICKY_STOP_USD,
    reserveUsd: (caseId) => opusReserve(caseId),
    scratchSuffix: `-sticky-${route.name}`,
    // The score reads only the ledgers: Assemble is held by the existing stub setting (so it and
    // Dispose spend nothing while later batches are still investigated; the pipeline starts a
    // batch's Assemble as soon as its own partitions finish), and the worker is stopped once every
    // Investigate partition is done. Both arms carry the hold, so they still share Understand.
    requestArgs: ["--stub-hold", "assemble=3600"],
    stopAfterInvestigate: true,
    // The measurement's budget on the plan route: input tokens over every run the route's
    // spend.json records, earlier invocations included.
    ...(route.price === null ? { stopInputTokens } : {}),
    workerTimeoutMs: 90 * 60_000,
  };
};

export const runSticky = (options: {
  readonly route: string;
  readonly snapshot?: string | undefined;
  readonly from: number;
  readonly to: number;
  readonly dry?: boolean;
  readonly stopInputTokens?: number | undefined;
}) => {
  if (
    options.stopInputTokens !== undefined &&
    !(
      Number.isSafeInteger(options.stopInputTokens) &&
      options.stopInputTokens > 0
    )
  )
    throw new Error("--stop-input-tokens must be a positive integer");
  if (
    options.stopInputTokens !== undefined &&
    ROUTES[options.route]?.price !== null
  )
    console.error(
      `--stop-input-tokens is ignored on ${options.route}: a priced route stops on its USD budget`,
    );
  return runRanges({
    from: options.from,
    to: options.to,
    dry: options.dry === true,
    mode: stickyMode(
      options.route,
      options.snapshot,
      options.dry === true,
      options.stopInputTokens,
    ),
  });
};

// Scoring

type SeedReport = NonNullable<Awaited<ReturnType<typeof readSeed>>>;

type Arm = "no-seed" | "seeded";
const METRICS = [
  "necessary",
  "relevant",
  "necessaryAny",
  "relevantAny",
] as const;
type Metric = (typeof METRICS)[number];
const SCORED_VIEWS = ["all", "cross-family"] as const;

const slugOf: Record<Arm, string> = {
  "no-seed": NO_SEED.slug,
  seeded: SEEDED.slug,
};

/** The spend of an arm's runs (truncated ones too), in USD where priced and in tokens. */
const armSpend = (route: RouteSpec, arm: Arm) => {
  const runs: ReadonlyArray<SpendEntry> = readSpend({
    ...COMPARISON,
    results: resultsOf(route),
  }).filter((entry) => entry.lane === slugOf[arm]);
  const sum = (pick: (tokens: NonNullable<SpendEntry["tokens"]>) => number) =>
    runs.reduce(
      (total, entry) =>
        total + (entry.tokens === undefined ? 0 : pick(entry.tokens)),
      0,
    );
  /** Input is every input token, uncached, written to and read from the cache (route.ts). */
  const tokens = runs.some((entry) => entry.tokens !== undefined)
    ? {
        input: sum(
          (t) => t.input + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead,
        ),
        uncached: sum((t) => t.input),
        cacheRead: sum((t) => t.cacheRead),
        cacheWrite: sum((t) => t.cacheWrite5m + t.cacheWrite1h),
        output: sum((t) => t.output),
      }
    : null;
  const usd =
    runs.length > 0 && runs.every((entry) => entry.costUsd !== null)
      ? round(
          runs.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0),
          4,
        )
      : null;
  return {
    runs: runs.length,
    usd,
    tokens,
    modelCalls: runs.reduce((sum, entry) => sum + entry.modelCalls, 0),
    usageLimits: runs.flatMap((entry) =>
      entry.usageLimit == null ? [] : [`${entry.caseId}: ${entry.usageLimit}`],
    ),
    /** Runs not stored as the lane's run (truncated: stopped, limited or not completed). */
    truncated: runs.flatMap((entry) =>
      entry.stored === false ? [`${entry.caseId}: ${entry.outcome}`] : [],
    ),
  };
};

export const scoreSticky = async (options: {
  readonly route: string;
  readonly gold?: string | undefined;
}) => {
  const route = ROUTES[options.route];
  if (route === undefined) throw new Error(`unknown route ${options.route}`);
  const goldDir = options.gold ?? DEFAULT_GOLD;
  const { views, check } = await loadViews(goldDir);
  const selection = await readSelection();
  const inputs = await loadScoringInputs();
  const exclusions = comparisonExclusions(inputs.armsFile);
  const chosen = new Set(selection.selected.map((entry) => entry.caseId));
  const hunks: Array<DevHunk> = inputs.hunks.filter(
    (hunk) =>
      chosen.has(hunk.caseId) && excludedHunk(exclusions, hunk).length === 0,
  );
  const arms: ReadonlyArray<Arm> = ["no-seed", "seeded"];
  type Row = {
    hunkId: string;
    caseId: string;
    family: string;
    arm: Arm;
    view: (typeof SCORED_VIEWS)[number];
  } & Record<Metric, number | null>;
  const rows: Array<Row> = [];
  /** Each scored hunk's ranking per arm, in composeLedger's trimming order, for the equal-size view. */
  const rankingsOf = new Map<string, ReadonlyArray<Item>>();
  /** Ledger size per arm: whole ledgers of the paired ranges, and the scored hunks' share of them. */
  const ledgerSize: Record<
    Arm,
    {
      tokens: number;
      entries: number;
      scoredTokens: number;
      scoredEntries: number;
      scoredAllowance: number;
      scoredUsed: number;
    }
  > = {
    "no-seed": {
      tokens: 0,
      entries: 0,
      scoredTokens: 0,
      scoredEntries: 0,
      scoredAllowance: 0,
      scoredUsed: 0,
    },
    seeded: {
      tokens: 0,
      entries: 0,
      scoredTokens: 0,
      scoredEntries: 0,
      scoredAllowance: 0,
      scoredUsed: 0,
    },
  };
  const missing: Array<string> = [];
  const leads: Record<Arm, Record<string, number>> = {
    "no-seed": {
      entries: 0,
      fromLeads: 0,
      seeded: 0,
      regraded: 0,
      ungraded: 0,
    },
    seeded: { entries: 0, fromLeads: 0, seeded: 0, regraded: 0, ungraded: 0 },
  };
  type Drops = {
    total: number;
    seeded: number;
    seededWithReason: number;
    list: Array<Record<string, string>>;
  };
  const noDrops = (): Drops => ({
    total: 0,
    seeded: 0,
    seededWithReason: 0,
    list: [],
  });
  const drops: Record<Arm, Drops> = { "no-seed": noDrops(), seeded: noDrops() };
  /** Each scored hunk's dropped seeded leads, as ranking items, by arm. */
  const droppedItems = new Map<string, Array<Item>>();
  const givenUp: Array<{
    hunkId: string;
    caseId: string;
    family: string;
    view: (typeof SCORED_VIEWS)[number];
    necessary: number;
    relevant: number;
    necessaryAny: number;
    relevantAny: number;
    hasNecessary: boolean;
    hasRelevant: boolean;
  }> = [];
  for (const caseId of chosen) {
    const stored = new Map<
      Arm,
      { run: NonNullable<ReturnType<typeof readRun>>; seed: SeedReport }
    >();
    for (const arm of arms) {
      const run = readRun(caseId, slugOf[arm], resultsOf(route));
      const seed = await readSeed(caseId, slugOf[arm], resultsOf(route));
      if (run === undefined || seed === undefined || run.manifest === null)
        missing.push(`${caseId} ${arm}`);
      // The runner stores only whole runs under the lane's name; this guards a hand-copied file.
      else if (
        run.outcome !== "completed" &&
        run.measurement?.stoppedAfterInvestigate !== true
      )
        missing.push(`${caseId} ${arm} (outcome ${run.outcome ?? "none"})`);
      else stored.set(arm, { run, seed });
    }
    // A range is scored only as a pair from one attempt: one cycle, so one shared Understand.
    const cycles = new Set(
      [...stored.values()].map(
        ({ run }) => run.cycleId ?? run.measurement?.cycleId,
      ),
    );
    if (
      stored.size !== arms.length ||
      cycles.size !== 1 ||
      cycles.has(undefined)
    ) {
      if (stored.size === arms.length)
        missing.push(
          `${caseId} (arms from different attempts: cycles ${[...cycles].join(", ")})`,
        );
      continue;
    }
    for (const arm of arms) {
      const { run, seed } = stored.get(arm)!;
      for (const ledger of run.ledgers) {
        ledgerSize[arm].entries += ledger.entries.length;
        ledgerSize[arm].tokens += ledger.entries.reduce(
          (sum, entry) => sum + entry.tokens,
          0,
        );
      }
      const m4Of = new Map(
        seed.seeded.flatMap((entry) =>
          entry.harnessHunkId === null
            ? []
            : [[entry.harnessHunkId, entry.m4HunkId] as const],
        ),
      );
      const scoredHere = new Set(
        hunks
          .filter((hunk) => hunk.caseId === caseId)
          .map((hunk) => hunk.hunkId),
      );
      for (const ledger of run.ledgers)
        for (const drop of ledger.dropped ?? []) {
          drops[arm].total++;
          if (drop.seeded !== true) continue;
          drops[arm].seeded++;
          if (drop.note.trim() !== "") drops[arm].seededWithReason++;
          const region = /^(.*):(\d+)-(\d+)@(\S+)$/.exec(drop.region ?? "");
          const path = region?.[1] ?? "";
          const startLine = Number(region?.[2] ?? 0);
          const endLine = Number(region?.[3] ?? 0);
          // A replacement: an entry the agent kept covers some of the dropped lead's lines (on the
          // base revision, where leads are read and gold is drawn).
          const replacement = ledger.entries.some((entry) => {
            const placed = placeEntry(entry, run.manifest!.hunks).region;
            return (
              placed !== undefined &&
              placed.path === path &&
              placed.startLine <= endLine &&
              startLine <= placed.endLine
            );
          });
          // The hunks the lead was seeded for: those of the partition whose preloaded leads hold it.
          const forHunks = ledger.partition.hunkIds.filter((hunkId) =>
            (shownLeads(run)(hunkId)?.results ?? [])
              .slice(0, 3)
              .some(
                (result) =>
                  result.identity.path === path &&
                  result.identity.startLine === startLine &&
                  result.identity.endLine === endLine,
              ),
          );
          const m4Hunks = forHunks.flatMap((hunkId) => {
            const m4 = m4Of.get(hunkId);
            return m4 !== undefined && scoredHere.has(m4) ? [m4] : [];
          });
          const item: Item = {
            key: spanKey(path, startLine, endLine),
            path,
            startLine,
            endLine,
            kind: "code",
            tokens: 0,
            chunkId: null,
            hash: null,
          };
          const touches = Object.fromEntries(
            SCORED_VIEWS.map((view) => {
              let necessary = false;
              let useful = false;
              for (const m4 of m4Hunks) {
                const gold = views.get(view)!.get(m4);
                if (gold === undefined) continue;
                const metrics = evaluateBudget(
                  gold,
                  { items: [item], scores: [] },
                  Number.MAX_SAFE_INTEGER,
                );
                necessary ||= (metrics.necessary.anyLine ?? 0) > 0;
                useful ||= (metrics.useful.anyLine ?? 0) > 0;
              }
              return [view, { necessary, useful }];
            }),
          );
          for (const m4 of m4Hunks)
            droppedItems.set(`${arm}\u0000${m4}`, [
              ...(droppedItems.get(`${arm}\u0000${m4}`) ?? []),
              item,
            ]);
          drops[arm].list.push({
            caseId,
            partition: ledger.partition.id,
            entry: drop.entry,
            region: drop.region ?? "",
            reason: drop.reason,
            note: drop.note,
            replacement: replacement ? "yes" : "no",
            scoredHunks: m4Hunks.join(","),
            touchesNecessary: touches["all"]!.necessary ? "yes" : "no",
            touchesUseful: touches["all"]!.useful ? "yes" : "no",
            touchesNecessaryCrossFamily: touches["cross-family"]!.necessary
              ? "yes"
              : "no",
            touchesUsefulCrossFamily: touches["cross-family"]!.useful
              ? "yes"
              : "no",
          });
        }
      for (const hunk of hunks.filter((entry) => entry.caseId === caseId)) {
        const harnessHunkId =
          seed.seeded.find((entry) => entry.m4HunkId === hunk.hunkId)
            ?.harnessHunkId ?? null;
        const mapped =
          harnessHunkId === null
            ? null
            : rankingFor(harnessHunkId, run.ledgers, run.manifest!.hunks);
        rankingsOf.set(`${arm}\u0000${hunk.hunkId}`, [
          ...(mapped?.ranking.items ?? []),
        ]);
        ledgerSize[arm].scoredTokens += mapped?.tokens ?? 0;
        ledgerSize[arm].scoredEntries += mapped?.entries ?? 0;
        for (const ledger of run.ledgers)
          for (const allowance of ledger.allowances ?? [])
            if (allowance.hunk === harnessHunkId) {
              ledgerSize[arm].scoredAllowance += allowance.tokens;
              ledgerSize[arm].scoredUsed += allowance.used;
            }
        for (const [key, value] of [
          ["entries", mapped?.entries],
          ["fromLeads", mapped?.fromLeads],
          ["seeded", mapped?.seeded],
          ["regraded", mapped?.regraded],
          ["ungraded", mapped?.ungraded],
        ] as const)
          leads[arm][key] = (leads[arm][key] ?? 0) + (value ?? 0);
        for (const view of SCORED_VIEWS) {
          const gold = views.get(view)!.get(hunk.hunkId);
          if (gold === undefined) continue;
          const metrics = evaluateBudget(
            gold,
            { items: [...(mapped?.ranking.items ?? [])], scores: [] },
            Number.MAX_SAFE_INTEGER,
          );
          rows.push({
            hunkId: hunk.hunkId,
            caseId,
            family: hunk.family,
            arm,
            view,
            necessary: metrics.necessary.fractional,
            relevant: metrics.relevant.fractional,
            necessaryAny: metrics.necessary.anyLine,
            relevantAny: metrics.relevant.anyLine,
          });
          // What the hunk's dropped seeded leads would have added, had they been kept.
          const back = droppedItems.get(`${arm}\u0000${hunk.hunkId}`) ?? [];
          if (arm === "seeded") {
            const withDrops = evaluateBudget(
              gold,
              {
                items: [...(mapped?.ranking.items ?? []), ...back],
                scores: [],
              },
              Number.MAX_SAFE_INTEGER,
            );
            givenUp.push({
              hunkId: hunk.hunkId,
              caseId,
              family: hunk.family,
              view,
              necessary:
                (withDrops.necessary.fractional ?? 0) -
                (metrics.necessary.fractional ?? 0),
              relevant:
                (withDrops.relevant.fractional ?? 0) -
                (metrics.relevant.fractional ?? 0),
              necessaryAny:
                (withDrops.necessary.anyLine ?? 0) -
                (metrics.necessary.anyLine ?? 0),
              relevantAny:
                (withDrops.relevant.anyLine ?? 0) -
                (metrics.relevant.anyLine ?? 0),
              hasNecessary: metrics.necessary.fractional !== null,
              hasRelevant: metrics.relevant.fractional !== null,
            });
          }
        }
      }
    }
  }
  const summarise = (source: ReadonlyArray<Row>) =>
    SCORED_VIEWS.map((view) => ({
      view,
      metrics: Object.fromEntries(
        METRICS.map((metric) => {
          const of = (arm: Arm) => {
            const mean = familyMean(
              source
                .filter((row) => row.view === view && row.arm === arm)
                .map((row) => ({
                  family: row.family,
                  caseId: row.caseId,
                  value: row[metric],
                })),
            );
            return { mean: round(mean.mean), hunkMean: round(mean.hunkMean) };
          };
          const units = hunks.flatMap((hunk) => {
            const get = (arm: Arm) =>
              source.find(
                (row) =>
                  row.view === view &&
                  row.arm === arm &&
                  row.hunkId === hunk.hunkId,
              )?.[metric] ?? null;
            const before = get("no-seed");
            const after = get("seeded");
            return before === null || after === null
              ? []
              : [
                  {
                    family: hunk.family,
                    caseId: hunk.caseId,
                    delta: after - before,
                  },
                ];
          });
          const ci = familyBootstrap(units, { comparisons: 1 });
          return [
            metric,
            {
              noSeed: of("no-seed"),
              seeded: of("seeded"),
              delta: round(ci.observed),
              ci95: [round(ci.lower), round(ci.upper)],
              permutationP: round(familyPermutation(units).p),
              hunks: ci.hunks,
            },
          ];
        }),
      ) as Record<
        Metric,
        {
          noSeed: { mean: number | null; hunkMean: number | null };
          seeded: { mean: number | null; hunkMean: number | null };
          delta: number | null;
          ci95: Array<number | null>;
          permutationP: number | null;
          hunks: number;
        }
      >,
    }));
  const summary = summarise(rows);
  // Equal size: both arms served at the smaller of their two rankings' tokens for each hunk, in the
  // order composeLedger trims (ledgers.ts), so a larger ledger cannot score by size alone.
  const equalRows: Array<Row> = [];
  const precisionRows: Array<{
    hunkId: string;
    caseId: string;
    family: string;
    arm: Arm;
    view: (typeof SCORED_VIEWS)[number];
    tokens: number;
    judged: number;
    relevant: number;
    unjudged: number;
    nonTarget: number;
  }> = [];
  for (const hunk of hunks)
    for (const view of SCORED_VIEWS) {
      const gold = views.get(view)!.get(hunk.hunkId);
      if (gold === undefined) continue;
      const items = Object.fromEntries(
        arms.map((arm) => [arm, rankingsOf.get(`${arm}\u0000${hunk.hunkId}`)]),
      ) as Record<Arm, ReadonlyArray<Item> | undefined>;
      if (arms.some((arm) => items[arm] === undefined)) continue;
      const budget = Math.min(
        ...arms.map((arm) =>
          items[arm]!.reduce((sum, item) => sum + item.tokens, 0),
        ),
      );
      for (const arm of arms) {
        const metrics = evaluateBudget(
          gold,
          { items: [...items[arm]!], scores: [] },
          budget,
        );
        equalRows.push({
          hunkId: hunk.hunkId,
          caseId: hunk.caseId,
          family: hunk.family,
          arm,
          view,
          necessary: metrics.necessary.fractional,
          relevant: metrics.relevant.fractional,
          necessaryAny: metrics.necessary.anyLine,
          relevantAny: metrics.relevant.anyLine,
        });
        // Precision over judged tokens (9.49): each kept item takes its grade by judgedGrade's rule;
        // an unjudged item, or one judged but not a retrieval target, never counts either way.
        let tokens = 0;
        let judged = 0;
        let relevant = 0;
        let unjudged = 0;
        let nonTarget = 0;
        for (const item of items[arm]!) {
          tokens += item.tokens;
          const label = judgedGrade(gold, item);
          if (label === undefined) unjudged += item.tokens;
          else if (!label.target) nonTarget += item.tokens;
          else {
            judged += item.tokens;
            if (label.grade === "necessary" || label.grade === "useful")
              relevant += item.tokens;
          }
        }
        precisionRows.push({
          hunkId: hunk.hunkId,
          caseId: hunk.caseId,
          family: hunk.family,
          arm,
          view,
          tokens,
          judged,
          relevant,
          unjudged,
          nonTarget,
        });
      }
    }
  const equalSize = summarise(equalRows);
  const precision = SCORED_VIEWS.map((view) => ({
    view,
    arms: Object.fromEntries(
      arms.map((arm) => {
        const mine = precisionRows.filter(
          (row) => row.view === view && row.arm === arm,
        );
        const sum = (pick: (row: (typeof mine)[number]) => number) =>
          mine.reduce((total, row) => total + pick(row), 0);
        const tokens = sum((row) => row.tokens);
        const judged = sum((row) => row.judged);
        const relevant = sum((row) => row.relevant);
        const perHunk = familyMean(
          mine.map((row) => ({
            family: row.family,
            caseId: row.caseId,
            value: row.judged === 0 ? null : row.relevant / row.judged,
          })),
        );
        return [
          arm,
          {
            tokens,
            judged,
            relevant,
            precision: judged === 0 ? null : round(relevant / judged),
            familyMean: round(perHunk.mean),
            unjudgedShare:
              tokens === 0 ? null : round(sum((row) => row.unjudged) / tokens),
            nonTargetShare:
              tokens === 0 ? null : round(sum((row) => row.nonTarget) / tokens),
          },
        ];
      }),
    ) as Record<
      Arm,
      {
        tokens: number;
        judged: number;
        relevant: number;
        precision: number | null;
        familyMean: number | null;
        unjudgedShare: number | null;
        nonTargetShare: number | null;
      }
    >,
  }));
  const pairedRanges = [
    ...new Set(
      rows.filter((row) => row.view === "all").map((row) => row.caseId),
    ),
  ];
  // Per metric of view all: each family's mean delta (cases nested in families, as B4's mean).
  const familyDeltas = Object.fromEntries(
    METRICS.map((metric) => {
      const byFamily = new Map<string, Map<string, Array<number>>>();
      for (const hunk of hunks) {
        const get = (arm: Arm) =>
          rows.find(
            (row) =>
              row.view === "all" &&
              row.arm === arm &&
              row.hunkId === hunk.hunkId,
          )?.[metric] ?? null;
        const before = get("no-seed");
        const after = get("seeded");
        if (before === null || after === null) continue;
        const cases = byFamily.get(hunk.family) ?? new Map();
        cases.set(hunk.caseId, [
          ...(cases.get(hunk.caseId) ?? []),
          after - before,
        ]);
        byFamily.set(hunk.family, cases);
      }
      const mean = (values: ReadonlyArray<number>) =>
        values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
      return [
        metric,
        [...byFamily.values()].map((cases) =>
          mean([...cases.values()].map(mean)),
        ),
      ];
    }),
  ) as Record<Metric, Array<number>>;
  const list = drops.seeded.list;
  const onScored = list.filter((drop) => drop["scoredHunks"] !== "");
  const yes = (drop: Record<string, string>, key: string) =>
    drop[key] === "yes";
  const byReason = (subset: ReadonlyArray<Record<string, string>>) =>
    Object.fromEntries(
      [...new Set(subset.map((drop) => drop["reason"] ?? ""))].map((reason) => [
        reason,
        subset.filter((drop) => drop["reason"] === reason).length,
      ]),
    );
  const dropsAgainstGold = {
    seededDrops: list.length,
    replacements: list.filter((drop) => yes(drop, "replacement")).length,
    replacementsByReason: byReason(
      list.filter((drop) => yes(drop, "replacement")),
    ),
    notReplacedByReason: byReason(
      list.filter((drop) => !yes(drop, "replacement")),
    ),
    onScoredHunks: onScored.length,
    touching: Object.fromEntries(
      (
        [
          ["all", "touchesNecessary", "touchesUseful"],
          [
            "cross-family",
            "touchesNecessaryCrossFamily",
            "touchesUsefulCrossFamily",
          ],
        ] as const
      ).map(([view, necessary, useful]) => [
        view,
        {
          necessary: onScored.filter((drop) => yes(drop, necessary)).length,
          useful: onScored.filter((drop) => yes(drop, useful)).length,
          either: onScored.filter(
            (drop) => yes(drop, necessary) || yes(drop, useful),
          ).length,
          eitherAndReplaced: onScored.filter(
            (drop) =>
              (yes(drop, necessary) || yes(drop, useful)) &&
              yes(drop, "replacement"),
          ).length,
        },
      ]),
    ),
    /** Coverage the scored hunks' dropped leads would have added back, family-weighted. */
    coverageGivenUp: Object.fromEntries(
      SCORED_VIEWS.map((view) => [
        view,
        Object.fromEntries(
          METRICS.map((metric) => {
            const necessaryMetric = metric.startsWith("necessary");
            const mean = familyMean(
              givenUp
                .filter(
                  (row) =>
                    row.view === view &&
                    (necessaryMetric ? row.hasNecessary : row.hasRelevant),
                )
                .map((row) => ({
                  family: row.family,
                  caseId: row.caseId,
                  value: row[metric],
                })),
            );
            return [metric, round(mean.mean)];
          }),
        ) as Record<Metric, number | null>,
      ]),
    ),
  };
  // Tokens of the runs the deltas rest on: each paired range's stored, current run per arm.
  const pairedRuns = readSpend({
    ...COMPARISON,
    results: resultsOf(route),
  }).filter(
    (entry) =>
      entry.stored === true &&
      entry.superseded !== true &&
      pairedRanges.includes(entry.caseId),
  );
  const tokensOf = (arm: Arm, stage?: string) =>
    pairedRuns
      .filter((entry) => entry.lane === slugOf[arm])
      .reduce(
        (sum, entry) => {
          const t =
            stage === undefined ? entry.tokens : entry.tokensByStage?.[stage];
          return t === undefined
            ? sum
            : {
                input:
                  sum.input +
                  t.input +
                  t.cacheWrite5m +
                  t.cacheWrite1h +
                  t.cacheRead,
                output: sum.output + t.output,
              };
        },
        { input: 0, output: 0 },
      );
  const pairedTokens = {
    noSeed: {
      all: tokensOf("no-seed"),
      investigate: tokensOf("no-seed", "investigate"),
    },
    seeded: {
      all: tokensOf("seeded"),
      investigate: tokensOf("seeded", "investigate"),
    },
  };
  const ratio = (
    a: { input: number; output: number },
    b: { input: number; output: number },
  ) =>
    b.input + b.output === 0
      ? null
      : round((a.input + a.output) / (b.input + b.output) - 1);
  const spendFile = JSON.parse(
    readFileSync(join(resultsOf(route), "spend.json"), "utf8"),
  ) as {
    stops?: ReadonlyArray<Record<string, string>>;
    invocations?: StickyOut["invocations"];
  };
  const out = {
    schemaVersion: 1,
    stops: spendFile.stops ?? [],
    invocations: spendFile.invocations ?? [],
    understandByLane: pairedRuns.map((entry) => ({
      caseId: entry.caseId,
      lane: entry.lane,
      understand: entry.understand,
    })),
    familyDeltas,
    dropsAgainstGold,
    pairedTokens: {
      ...pairedTokens,
      seededOverNoSeed: {
        all: ratio(pairedTokens.seeded.all, pairedTokens.noSeed.all),
        investigate: ratio(
          pairedTokens.seeded.investigate,
          pairedTokens.noSeed.investigate,
        ),
      },
    },
    route: route.name,
    gold: goldDir,
    goldCheck: check,
    snapshot: existsSync(join(resultsOf(route), "snapshot.json"))
      ? JSON.parse(
          readFileSync(join(resultsOf(route), "snapshot.json"), "utf8"),
        )
      : null,
    scoredHunks: hunks.length,
    /** The hunks and ranges with both arms stored as one pair: what the deltas are measured on. */
    pairedHunks: new Set(
      rows.filter((row) => row.view === "all").map((row) => row.hunkId),
    ).size,
    pairedFamilies: new Set(
      rows.filter((row) => row.view === "all").map((row) => row.family),
    ).size,
    pairedRanges: [
      ...new Set(
        rows.filter((row) => row.view === "all").map((row) => row.caseId),
      ),
    ],
    missingRuns: missing,
    summary,
    ledgerSize,
    equalSize,
    precision,
    leads,
    drops,
    spend: {
      noSeed: armSpend(route, "no-seed"),
      seeded: armSpend(route, "seeded"),
    },
    perHunk: rows.map((row) => ({
      ...row,
      ...Object.fromEntries(
        METRICS.map((metric) => [metric, round(row[metric])]),
      ),
    })),
  };
  ensureDir(resultsOf(route));
  writeFileSync(
    join(resultsOf(route), "score.json"),
    `${JSON.stringify(out, null, 2)}\n`,
  );
  const lines = stickyMarkdown(out);
  writeFileSync(join(resultsOf(route), "score.md"), `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
  return out;
};

interface ArmSummary {
  readonly mean: number | null;
  readonly hunkMean: number | null;
}

/** What score.md is written from. */
interface StickyOut {
  readonly route: string;
  readonly scoredHunks: number;
  readonly pairedHunks: number;
  readonly pairedRanges: ReadonlyArray<string>;
  readonly pairedFamilies: number;
  readonly missingRuns: ReadonlyArray<string>;
  readonly snapshot: { readonly commit?: string } | null;
  readonly summary: ReadonlyArray<{
    readonly view: string;
    readonly metrics: Record<
      Metric,
      {
        readonly noSeed: ArmSummary;
        readonly seeded: ArmSummary;
        readonly delta: number | null;
        readonly ci95: ReadonlyArray<number | null>;
        readonly permutationP: number | null;
      }
    >;
  }>;
  readonly ledgerSize: Record<
    Arm,
    {
      readonly tokens: number;
      readonly entries: number;
      readonly scoredTokens: number;
      readonly scoredEntries: number;
      readonly scoredAllowance: number;
      readonly scoredUsed: number;
    }
  >;
  readonly equalSize: StickyOut["summary"];
  readonly precision: ReadonlyArray<{
    readonly view: string;
    readonly arms: Record<
      Arm,
      {
        readonly tokens: number;
        readonly judged: number;
        readonly relevant: number;
        readonly precision: number | null;
        readonly familyMean: number | null;
        readonly unjudgedShare: number | null;
        readonly nonTargetShare: number | null;
      }
    >;
  }>;
  readonly leads: Record<Arm, Record<string, number>>;
  readonly drops: Record<
    Arm,
    {
      readonly total: number;
      readonly seeded: number;
      readonly seededWithReason: number;
      readonly list: ReadonlyArray<Record<string, string>>;
    }
  >;
  readonly spend: Record<"noSeed" | "seeded", ReturnType<typeof armSpend>>;
  readonly stops: ReadonlyArray<Record<string, string>>;
  readonly invocations: ReadonlyArray<{
    readonly at: string;
    readonly from: number;
    readonly to: number;
    readonly stopInputTokens: number | null;
    readonly note?: string;
  }>;
  readonly perHunk: ReadonlyArray<{
    readonly hunkId: string;
    readonly caseId: string;
    readonly family: string;
    readonly arm: Arm;
    readonly view: string;
    readonly necessary: number | null;
  }>;
  readonly understandByLane: ReadonlyArray<{
    readonly caseId: string;
    readonly lane?: string | undefined;
    readonly understand: string;
  }>;
  readonly familyDeltas: Record<Metric, ReadonlyArray<number>>;
  readonly dropsAgainstGold: {
    readonly seededDrops: number;
    readonly replacements: number;
    readonly replacementsByReason: Record<string, number>;
    readonly notReplacedByReason: Record<string, number>;
    readonly onScoredHunks: number;
    readonly touching: Record<
      string,
      {
        readonly necessary: number;
        readonly useful: number;
        readonly either: number;
        readonly eitherAndReplaced: number;
      }
    >;
    readonly coverageGivenUp: Record<string, Record<Metric, number | null>>;
  };
  readonly pairedTokens: {
    readonly noSeed: Record<
      "all" | "investigate",
      { input: number; output: number }
    >;
    readonly seeded: Record<
      "all" | "investigate",
      { input: number; output: number }
    >;
    readonly seededOverNoSeed: Record<"all" | "investigate", number | null>;
  };
}

const pct = (value: number | null) =>
  value === null
    ? "n/a"
    : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;

const stickyMarkdown = (out: StickyOut) => {
  const cell = (entry: ArmSummary) => `${entry.mean} [${entry.hunkMean}]`;
  const lines = [
    `# Seeded leads (10.84), R(H3-E1) on ${out.route}`,
    "",
    `Measured on ${out.pairedHunks} of the ${out.scoredHunks} hunks the comparison's 12 ranges hold after 9.47, in the ${out.pairedRanges.length} range(s) where both arms ran as one pair: ${out.pairedRanges.join(", ")}. Not run: ${out.missingRuns.length === 0 ? "none" : out.missingRuns.join(", ")}. Both arms ran from the same snapshot, sharing Understand per range, and each run stopped once Investigate was done. Snapshot ${out.snapshot?.commit ?? "not pinned"}.`,
    "",
    "## How the run ended",
    "",
    out.missingRuns.length === 0
      ? `Every range ran as a pair.${out.stops.length === 0 ? " No invocation stopped early." : " Earlier invocations stopped as below, and a later one resumed from the next range on the same pinned snapshot."}`
      : `${out.missingRuns.length} lane run(s) did not run (listed above).`,
    "",
    "Each invocation's budget (spend.json `invocations`):",
    "",
    ...out.invocations.map(
      (entry) =>
        `- ${entry.at}, ranges ${entry.from} to ${entry.to}: ${entry.stopInputTokens === null ? "no input-token stop" : `stop at ${entry.stopInputTokens.toLocaleString("en")} input tokens over every run${entry.stopInputTokens > DEFAULT_STOP_INPUT_TOKENS ? `, over the ${DEFAULT_STOP_INPUT_TOKENS.toLocaleString("en")} default` : ""}`}.${entry.note === undefined ? "" : ` ${entry.note}`}`,
    ),
    "",
    ...(out.stops.length === 0
      ? []
      : out.stops.map(
          (stop) =>
            `- ${stop["at"]}, ${stop["by"] === "manual" ? "by hand" : "by the runner"} (${stop["reason"]}${stop["caseId"] === undefined ? "" : `, at ${stop["caseId"]}`}): ${stop["detail"] ?? ""}`,
        )),
    "",
    "## Understand, shared per range",
    "",
    "Each range's first arm computed Understand; the second reused it (spend.json `understand`, from the run logs' stage records).",
    "",
    "| range | arm | Understand |",
    "| --- | --- | --- |",
    ...out.understandByLane.map(
      (entry) =>
        `| ${entry.caseId} | ${entry.lane ?? ""} | ${entry.understand} |`,
    ),
    "",
    "## Coverage at depth, under both overlap rules",
    "",
    "Each cell is B4's family-weighted mean, then the plain mean over hunks in brackets. Delta is seeded minus no-seed per hunk, B4's paired family bootstrap at 95%.",
    "",
    "| view | measure | no seed | seeded | delta [95%] | permutation p |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  const names: Record<Metric, string> = {
    necessary: "necessary, fractional",
    relevant: "relevant, fractional",
    necessaryAny: "necessary, any line",
    relevantAny: "relevant, any line",
  };
  for (const view of out.summary)
    for (const metric of METRICS) {
      const entry = view.metrics[metric];
      lines.push(
        `| ${view.view} | ${names[metric]} | ${cell(entry.noSeed)} | ${cell(entry.seeded)} | ${entry.delta} [${entry.ci95.join(", ")}] | ${entry.permutationP} |`,
      );
    }
  const n = (value: number) => value.toLocaleString("en");
  lines.push(
    "",
    "## Ledger size",
    "",
    "Coverage at depth serves every kept entry, so a larger ledger can cover more by size alone. Tokens are the entries' own (after composeLedger's trimming); scored hunks count each entry anchored to one of them, so an entry shared by two scored hunks counts twice. These are the allowance used, every anchored entry included; the precision and equal-size views below use only the entries placeable on the base (scope sections and files added in the range have no base region), which is why their kept tokens are smaller.",
    "",
    "| arm | ledger tokens (all partitions) | ledger entries | tokens on scored hunks | entries on scored hunks | allowance used on scored hunks |",
    "| --- | --- | --- | --- | --- | --- |",
    ...(["no-seed", "seeded"] as const).map((arm) => {
      const size = out.ledgerSize[arm];
      return `| ${arm} | ${n(size.tokens)} | ${n(size.entries)} | ${n(size.scoredTokens)} | ${n(size.scoredEntries)} | ${n(size.scoredUsed)} of ${n(size.scoredAllowance)} (${size.scoredAllowance === 0 ? "n/a" : `${((100 * size.scoredUsed) / size.scoredAllowance).toFixed(1)}%`}) |`;
    }),
    "",
    "## Coverage at equal size",
    "",
    "Each hunk is served to both arms at the same token budget, the smaller of the two arms' kept tokens on it (placed on the base), in the order composeLedger trims (necessary first, then seeded leads, then rank), with B4's evaluateBudget (the item crossing the budget served in part). Same statistics as above. The cut follows the harness's own order, so this view shows what harness trimming would keep at that size, not an order-neutral measure of which arm selected better context.",
    "",
    "| view | measure | no seed | seeded | delta [95%] | permutation p |",
    "| --- | --- | --- | --- | --- | --- |",
  );
  for (const view of out.equalSize)
    for (const metric of METRICS) {
      const entry = view.metrics[metric];
      lines.push(
        `| ${view.view} | ${names[metric]} | ${cell(entry.noSeed)} | ${cell(entry.seeded)} | ${entry.delta} [${entry.ci95.join(", ")}] | ${entry.permutationP} |`,
      );
    }
  lines.push(
    "",
    "## Precision on scored hunks",
    "",
    "Over judged tokens only (9.49): each kept entry on a scored hunk, placed on the base, takes its grade from the merged candidate, an exact labelled span or a judged candidate that wholly contains it; precision is the share of judged retrieval-target tokens graded necessary or useful. Unjudged tokens, and tokens judged but not a retrieval target, never count either way; their shares of the kept tokens are beside it. Pooled is over all scored hunks; the family-weighted mean averages each hunk's precision as B4 does.",
    "",
    "| view | arm | kept tokens | judged target tokens | of them necessary or useful | precision (pooled) | family-weighted mean | unjudged share | judged, not a target |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...out.precision.flatMap((view) =>
      (["no-seed", "seeded"] as const).map((arm) => {
        const p = view.arms[arm];
        return `| ${view.view} | ${arm} | ${n(p.tokens)} | ${n(p.judged)} | ${n(p.relevant)} | ${p.precision} | ${p.familyMean} | ${p.unjudgedShare} | ${p.nonTargetShare} |`;
      }),
    ),
  );
  lines.push(
    "",
    "## Entries from leads (entries anchored to the scored hunks)",
    "",
    "| arm | entries | recorded as a preloaded lead | seeded leads kept | of them regraded | ungraded |",
    "| --- | --- | --- | --- | --- | --- |",
    ...(["no-seed", "seeded"] as const).map((arm) => {
      const l = out.leads[arm];
      return `| ${arm} | ${l["entries"]} | ${l["fromLeads"]} | ${l["seeded"]} | ${l["regraded"]} | ${l["ungraded"]} |`;
    }),
    "",
    "## Drops (every partition of the paired ranges)",
    "",
    `Seeded arm: ${out.drops.seeded.total} drops, ${out.drops.seeded.seeded} of seeded leads, ${out.drops.seeded.seededWithReason} of them with a reason. No-seed arm: ${out.drops["no-seed"].total} drops.`,
    "",
    ...(out.drops.seeded.list.length === 0
      ? ["No seeded lead was dropped."]
      : (() => {
          const count = (key: string) => {
            const counts = new Map<string, number>();
            for (const drop of out.drops.seeded.list)
              counts.set(
                drop[key] ?? "",
                (counts.get(drop[key] ?? "") ?? 0) + 1,
              );
            return [...counts].sort((a, b) => b[1] - a[1]);
          };
          return [
            "Seeded leads dropped, by range and by reason; every drop, with its region and note, is in score.json (`drops.seeded.list`).",
            "",
            "| range | seeded leads dropped |",
            "| --- | --- |",
            ...count("caseId").map(([range, n]) => `| ${range} | ${n} |`),
            "",
            "| reason | seeded leads dropped |",
            "| --- | --- |",
            ...count("reason").map(([reason, n]) => `| ${reason} | ${n} |`),
          ];
        })()),
    "",
    "### Dropped seeded leads: replacements and gold",
    "",
    (() => {
      const d = out.dropsAgainstGold;
      const reasons = (counts: Record<string, number>) =>
        Object.entries(counts)
          .map(([reason, n]) => `${n} ${reason}`)
          .join(", ") || "none";
      return `Of ${d.seededDrops} dropped seeded leads, ${d.replacements} were replacements (an entry the agent kept covers some of the lead's lines on the base revision: ${reasons(d.replacementsByReason)}); the other ${d.seededDrops - d.replacements} were not replaced (${reasons(d.notReplacedByReason)}). ${d.onScoredHunks} of the drops were seeded for a scored hunk and so can be checked against gold.`;
    })(),
    "",
    "| view | drops on scored hunks | touching a necessary target | touching a useful target | touching either | of those, replaced |",
    "| --- | --- | --- | --- | --- | --- |",
    ...Object.entries(out.dropsAgainstGold.touching).map(
      ([view, t]) =>
        `| ${view} | ${out.dropsAgainstGold.onScoredHunks} | ${t.necessary} | ${t.useful} | ${t.either} | ${t.eitherAndReplaced} |`,
    ),
    "",
    "Coverage the dropped leads would have added back to the seeded arm's ledgers, had they been kept (family-weighted mean over scored hunks, both overlap rules):",
    "",
    "| view | necessary, fractional | relevant, fractional | necessary, any line | relevant, any line |",
    "| --- | --- | --- | --- | --- |",
    ...Object.entries(out.dropsAgainstGold.coverageGivenUp).map(
      ([view, m]) =>
        `| ${view} | ${m.necessary} | ${m.relevant} | ${m.necessaryAny} | ${m.relevantAny} |`,
    ),
    "",
    "## Spend",
    "",
    "Every run is counted, truncated ones too; the first arm of each range also paid for Understand.",
    "",
    "| arm | runs | USD | input tokens (uncached / cache read / cache write) | output tokens | model calls |",
    "| --- | --- | --- | --- | --- | --- |",
    ...(["noSeed", "seeded"] as const).map((arm) => {
      const s = out.spend[arm];
      const n = (value: number) => value.toLocaleString("en");
      return `| ${arm === "noSeed" ? "no-seed" : "seeded"} | ${s.runs} | ${s.usd ?? "no USD price"} | ${s.tokens === null ? "not recorded" : `${n(s.tokens.input)} (${n(s.tokens.uncached)} / ${n(s.tokens.cacheRead)} / ${n(s.tokens.cacheWrite)})`} | ${s.tokens === null ? "" : n(s.tokens.output)} | ${s.modelCalls} |`;
    }),
    ...[...out.spend.noSeed.usageLimits, ...out.spend.seeded.usageLimits].map(
      (line) => `- usage limit: ${line}`,
    ),
    ...[...out.spend.noSeed.truncated, ...out.spend.seeded.truncated].map(
      (line) => `- truncated, not scored: ${line}`,
    ),
    "",
    "On the scored pairs only (each paired range's current stored run per arm; superseded and truncated attempts left out):",
    "",
    "| arm | input tokens | output tokens | Investigate input | Investigate output |",
    "| --- | --- | --- | --- | --- |",
    ...(["noSeed", "seeded"] as const).map((arm) => {
      const t = out.pairedTokens[arm];
      const n = (value: number) => value.toLocaleString("en");
      return `| ${arm === "noSeed" ? "no-seed" : "seeded"} | ${n(t.all.input)} | ${n(t.all.output)} | ${n(t.investigate.input)} | ${n(t.investigate.output)} |`;
    }),
    "",
    `Seeded against no-seed: ${pct(out.pairedTokens.seededOverNoSeed.all)} in all tokens, ${pct(out.pairedTokens.seededOverNoSeed.investigate)} in Investigate's. The no-seed total includes Understand where it ran first.`,
  );
  // Interpretation, computed from the tables above at render time so a rescore cannot leave it
  // stale, and labelled as an agent reading, not a measurement (2.16).
  const all = out.summary.find((view) => view.view === "all");
  const families = out.pairedFamilies;
  // With F families the sign-flip permutation has 2^F equally likely sign patterns, so the
  // two-sided p cannot fall below 2 / 2^F; and a bootstrap over F families excludes zero whenever
  // all F move the same way.
  const pFloor = families === 0 ? null : round(2 / 2 ** families);
  const reading = (metric: Metric) => {
    const entry = all?.metrics[metric];
    if (entry === undefined || entry.delta === null) return "no paired hunks";
    const deltas = out.familyDeltas[metric];
    const up = deltas.filter((value) => value > 0).length;
    const down = deltas.filter((value) => value < 0).length;
    const [lower, upper] = entry.ci95;
    const excludes =
      (lower !== null && lower !== undefined && lower > 0) ||
      (upper !== null && upper !== undefined && upper < 0);
    const direction =
      up === deltas.length
        ? `all ${deltas.length} families up`
        : down === deltas.length
          ? `all ${deltas.length} families down`
          : `${up} of ${deltas.length} families up, ${down} down`;
    return `${entry.delta >= 0 ? "+" : ""}${entry.delta} (${direction}; the 95% interval ${excludes ? "excludes" : "includes"} zero; permutation p ${entry.permutationP})`;
  };
  const kept = out.leads.seeded["seeded"] ?? 0;
  const dropped = out.drops.seeded.seeded;
  const d = out.dropsAgainstGold;
  const anyExcludes = METRICS.some((metric) => {
    const [lower, upper] = all?.metrics[metric]?.ci95 ?? [];
    return (
      (lower !== null && lower !== undefined && lower > 0) ||
      (upper !== null && upper !== undefined && upper < 0)
    );
  });
  const signs = new Set(
    METRICS.map((metric) => Math.sign(all?.metrics[metric]?.delta ?? 0)).filter(
      (sign) => sign !== 0,
    ),
  );
  const mixed = signs.size > 1;
  lines.push(
    "",
    "## Interpretation (agent reading of the measurements above, not a measurement)",
    "",
    `- Seeded minus no-seed, view all: necessary ${reading("necessary")} and relevant ${reading("relevant")} under the fractional rule; necessary ${reading("necessaryAny")} and relevant ${reading("relevantAny")} under the any-line rule.`,
    (() => {
      const equal = out.equalSize.find((view) => view.view === "all");
      const size = out.ledgerSize;
      const grew =
        size["no-seed"].scoredTokens === 0
          ? null
          : size.seeded.scoredTokens / size["no-seed"].scoredTokens - 1;
      const survives = (metric: Metric) => {
        const depth = all?.metrics[metric]?.delta ?? null;
        const same = equal?.metrics[metric];
        if (depth === null || same === undefined || same.delta === null)
          return "n/a";
        const [lower, upper] = same.ci95;
        const excludes =
          (lower !== null && lower !== undefined && lower > 0) ||
          (upper !== null && upper !== undefined && upper < 0);
        return `${same.delta >= 0 ? "+" : ""}${same.delta} against ${depth} at depth (${excludes ? "the interval excludes zero" : "the interval includes zero"}, permutation p ${same.permutationP})`;
      };
      const noneDetected = METRICS.every((metric) => {
        const [lower, upper] =
          equal?.metrics[metric]?.ci95 ?? ([] as Array<number | null>);
        return !(
          (lower !== null && lower !== undefined && lower > 0) ||
          (upper !== null && upper !== undefined && upper < 0)
        );
      });
      const precise = out.precision.find((view) => view.view === "all")?.arms;
      return `- Size: the seeded arm kept ${pct(grew)} tokens on the scored hunks (${n(size.seeded.scoredTokens)} against ${n(size["no-seed"].scoredTokens)}), and coverage at depth rewards size. At equal size, each hunk at the smaller arm's tokens, seeded minus no-seed is necessary ${survives("necessary")} and relevant ${survives("relevant")} under the fractional rule; necessary ${survives("necessaryAny")} and relevant ${survives("relevantAny")} under the any-line rule.${noneDetected ? " There is no detectable difference at equal size: every interval includes zero." : ""} Precision over judged tokens (9.49): ${precise?.["no-seed"].precision} no-seed and ${precise?.seeded.precision} seeded, with ${precise?.["no-seed"].unjudgedShare} and ${precise?.seeded.unjudgedShare} of the kept tokens unjudged.`;
    })(),
    (() => {
      const names: Record<Metric, string> = {
        necessary: "necessary (fractional)",
        relevant: "relevant (fractional)",
        necessaryAny: "necessary (any line)",
        relevantAny: "relevant (any line)",
      };
      const split = METRICS.filter((metric) => {
        const entry = all?.metrics[metric];
        const [lower, upper] = entry?.ci95 ?? [];
        const excludes =
          (lower !== null && lower !== undefined && lower > 0) ||
          (upper !== null && upper !== undefined && upper < 0);
        const deltas = out.familyDeltas[metric];
        const agree =
          deltas.every((value) => value > 0) ||
          deltas.every((value) => value < 0);
        return excludes && !agree;
      });
      return `- With ${families} families these tests are weak. The sign-flip permutation p cannot fall below ${pFloor}. The family bootstrap draws only ${families} families per resample, so its interval excludes zero whenever all ${families} move the same way, and can with one against when that family's change is small (drawing it in every slot has probability 1 / ${families ** families})${split.length === 0 ? "" : `, as for ${split.map((metric) => names[metric]).join(" and ")} here`}. ${
        anyExcludes
          ? "An interval that excludes zero here is not evidence the effect is established: read the result as a consistent direction, not established."
          : `No interval excludes zero: there is no detectable effect at this size, and the point estimates ${mixed ? "point different ways across measures" : "agree in sign"}.`
      }`;
    })(),
    `- The seeded arm kept ${kept} seeded lead(s) on the scored hunks (${out.leads.seeded["regraded"] ?? 0} regraded) and dropped ${dropped} across the paired ranges, ${out.drops.seeded.seededWithReason} with a reason; ${d.replacements} of the drops were replacements. Of the ${d.onScoredHunks} drops on scored hunks, ${d.touching["all"]?.either ?? 0} touched a gold necessary or useful target (${d.touching["all"]?.necessary ?? 0} necessary), so the agents did drop some context the gold wanted, though ${d.touching["all"]?.eitherAndReplaced ?? 0} of those ${d.touching["all"]?.either ?? 0} were replaced by an entry they kept; keeping them would have added ${d.coverageGivenUp["all"]?.relevant ?? 0} relevant coverage under the fractional rule and ${d.coverageGivenUp["all"]?.relevantAny ?? 0} under the any-line rule.`,
    (() => {
      const all = out.perHunk.filter((row) => row.view === "all");
      const hunksOf = new Map<string, Set<string>>();
      for (const row of all)
        hunksOf.set(
          row.family,
          (hunksOf.get(row.family) ?? new Set()).add(row.hunkId),
        );
      const necessaryOf = (hunkId: string, arm: Arm) =>
        all.find((row) => row.hunkId === hunkId && row.arm === arm)
          ?.necessary ?? null;
      const lone = [...hunksOf]
        .filter(([, ids]) => ids.size === 1)
        .flatMap(([family, ids]) => {
          const hunkId = [...ids][0]!;
          const before = necessaryOf(hunkId, "no-seed");
          const after = necessaryOf(hunkId, "seeded");
          if (before === null || after === null || after >= before) return [];
          const ownDrops = out.drops.seeded.list.filter((drop) =>
            (drop["scoredHunks"] ?? "").split(",").includes(hunkId),
          );
          const touching = ownDrops.filter(
            (drop) =>
              drop["touchesNecessary"] === "yes" ||
              drop["touchesUseful"] === "yes",
          ).length;
          const caseId = all.find((row) => row.hunkId === hunkId)?.caseId ?? "";
          return [
            `${family} (${caseId}, ${hunkId}: ${before} → ${after}; ${ownDrops.length} dropped lead(s), ${touching} touching a gold target)`,
          ];
        });
      return lone.length === 0
        ? "- No family with a single hunk lost necessary coverage."
        : `- The family-weighted necessary result leans on families with one hunk, which weigh as much as any other: ${lone.join("; ")}. Where none of a hunk's dropped leads touched a gold target, its loss came from what the agent recorded, not from what it dropped.`;
    })(),
    `- Seeding cost ${pct(out.pairedTokens.seededOverNoSeed.all)} tokens on the scored pairs (${pct(out.pairedTokens.seededOverNoSeed.investigate)} in Investigate).`,
    `- What these ${out.pairedHunks} hunks in ${out.pairedRanges.length} range(s) and ${families} family(ies) can claim: the direction and rough size of seeding on this route and this candidate. They cannot show equivalence, cannot separate the effect from run-to-run noise (one run per arm per range), and say nothing about R(H3-E3), about Opus${out.missingRuns.length === 0 ? ", or about ranges outside the 9.57 selection" : ", or about the ranges that did not run"}. Family-weighted and plain hunk means can differ in sign when a family with few hunks moves against the rest; both are in the table.`,
  );
  return lines;
};
