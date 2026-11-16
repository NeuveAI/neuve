import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { familyBootstrap } from "../../retrieval-bench/score/stats.ts";
import { loadScoringInputs } from "../../retrieval-bench/scoring-inputs.ts";
import {
  RESULTS,
  STICKY_RESULTS,
  comparisonExclusions,
  ensureDir,
  excludedHunk,
} from "../common.ts";
import { rankingFor } from "../ledgers.ts";
import { DEFAULT_GOLD, loadViews, readRun, readSeed, round } from "../score.ts";
import { readSelection } from "../select.ts";
import { FULL_TEST_RESULTS } from "./config.ts";
import {
  METRICS,
  SCORED_VIEWS,
  coverage,
  judgedPrecision,
  summariseRows,
  type Metric,
} from "./measures.ts";

/**
 * FT7's model control at no model cost: the committed ledgers of the 9.57 comparison on Opus
 * (R(H3-E1), lane `e1`) and of the 10.84 run on Sol (R(H3-E1) without seeding, `e1-no-seed`),
 * rescored with one scorer version, the full test's (measures.ts over B4's `evaluateBudget`, gold
 * views through `keepCrossFamily`). Both ran the same arm on the same 12 ranges against the same
 * gold, so the paired difference is the size of the route-and-snapshot gap, which stays
 * confounded: the routes differ and so do the harness snapshots (06f5cde9 against d5c15b0e). The
 * other stored lanes (Opus R(H3-E3), Sol seeded, and 10.88's re-measurement) are rescored beside
 * them for reference. No conclusion about Opus is drawn from Sol figures.
 */

export const RESCORED_LEDGERS = [
  {
    id: "opus-e1",
    label: "Opus, 9.57, R(H3-E1)",
    results: RESULTS,
    slug: "e1",
    headline: true,
  },
  {
    id: "sol-no-seed",
    label: "Sol, 10.84, R(H3-E1) without seeding",
    results: join(STICKY_RESULTS, "sol"),
    slug: "e1-no-seed",
    headline: true,
  },
  {
    id: "opus-e3",
    label: "Opus, 9.57, R(H3-E3)",
    results: RESULTS,
    slug: "e3",
    headline: false,
  },
  {
    id: "sol-seeded",
    label: "Sol, 10.84, R(H3-E1) seeded",
    results: join(STICKY_RESULTS, "sol"),
    slug: "e1-seeded",
    headline: false,
  },
  {
    id: "sol-drops-seeded",
    label: "Sol, 10.88, R(H3-E1) seeded with the lead-drop checks",
    results: join(STICKY_RESULTS, "sol-drops"),
    slug: "e1-seeded",
    headline: false,
  },
  {
    id: "sol-drops-no-seed",
    label: "Sol, 10.88, R(H3-E1) without seeding",
    results: join(STICKY_RESULTS, "sol-drops"),
    slug: "e1-no-seed",
    headline: false,
  },
] as const;

export const rescoreLedgers = async (
  options: { readonly gold?: string | undefined } = {},
) => {
  const { views, check } = await loadViews(options.gold ?? DEFAULT_GOLD);
  const selection = await readSelection();
  const inputs = await loadScoringInputs();
  const exclusions = comparisonExclusions(inputs.armsFile);
  const chosen = new Set(selection.selected.map((entry) => entry.caseId));
  const hunks = inputs.hunks.filter(
    (hunk) =>
      chosen.has(hunk.caseId) && excludedHunk(exclusions, hunk).length === 0,
  );
  type Row = {
    id: string;
    hunkId: string;
    caseId: string;
    family: string;
    view: string;
  } & Record<Metric, number | null>;
  const rows: Array<Row> = [];
  const precision: Record<string, { judged: number; relevant: number }> = {};
  const missing: Array<string> = [];
  for (const ledger of RESCORED_LEDGERS) {
    precision[ledger.id] = { judged: 0, relevant: 0 };
    for (const caseId of chosen) {
      const run = readRun(caseId, ledger.slug, ledger.results);
      const seed = await readSeed(caseId, ledger.slug, ledger.results);
      if (run === undefined || seed === undefined || run.manifest === null) {
        missing.push(`${ledger.id} ${caseId}`);
        continue;
      }
      for (const hunk of hunks.filter((entry) => entry.caseId === caseId)) {
        const harness =
          seed.seeded.find((entry) => entry.m4HunkId === hunk.hunkId)
            ?.harnessHunkId ?? null;
        const mapped =
          harness === null
            ? null
            : rankingFor(harness, run.ledgers, run.manifest.hunks);
        const items = [...(mapped?.ranking.items ?? [])];
        for (const view of SCORED_VIEWS) {
          const gold = views.get(view)?.get(hunk.hunkId);
          if (gold === undefined) continue;
          rows.push({
            id: ledger.id,
            hunkId: hunk.hunkId,
            caseId,
            family: hunk.family,
            view,
            ...coverage(gold, items),
          });
          if (view === "all") {
            const p = judgedPrecision(gold, items);
            precision[ledger.id]!.judged += p.judged;
            precision[ledger.id]!.relevant += p.relevant;
          }
        }
      }
    }
  }
  const gap = SCORED_VIEWS.flatMap((view) =>
    METRICS.map((metric) => {
      const units = hunks.flatMap((hunk) => {
        const get = (id: string) =>
          rows.find(
            (row) =>
              row.id === id && row.view === view && row.hunkId === hunk.hunkId,
          )?.[metric] ?? null;
        const opus = get("opus-e1");
        const sol = get("sol-no-seed");
        return opus === null || sol === null
          ? []
          : [{ family: hunk.family, caseId: hunk.caseId, delta: sol - opus }];
      });
      const ci = familyBootstrap(units, { comparisons: 1 });
      return {
        view,
        metric,
        hunks: units.length,
        solMinusOpus: round(ci.observed),
        ci95: [round(ci.lower), round(ci.upper)],
      };
    }),
  );
  return {
    schemaVersion: 1,
    note: "One scorer over the committed ledgers; no model call. The Sol-minus-Opus gap confounds route and harness snapshot.",
    goldCheck: check,
    scoredHunks: hunks.length,
    ledgers: RESCORED_LEDGERS.map(({ results: _results, ...rest }) => rest),
    missing,
    summary: summariseRows(rows, ["id", "view"]),
    precision: Object.fromEntries(
      Object.entries(precision).map(([id, p]) => [
        id,
        p.judged === 0 ? null : round(p.relevant / p.judged),
      ]),
    ),
    solMinusOpus: gap,
    perHunk: rows,
  };
};

export const writeRescore = async (
  options: { readonly gold?: string | undefined } = {},
) => {
  const out = await rescoreLedgers(options);
  ensureDir(FULL_TEST_RESULTS);
  writeFileSync(
    join(FULL_TEST_RESULTS, "rescore.json"),
    `${JSON.stringify(out, null, 2)}\n`,
  );
  const lines = [
    "# Earlier ledgers rescored with one scorer (FT7)",
    "",
    `${out.scoredHunks} scored hunks of the 12 named ranges after 9.47. No model call. Missing: ${out.missing.length === 0 ? "none" : out.missing.join(", ")}.`,
    "",
    "| ledger | view | hunks | necessary | relevant | necessary, any line | relevant, any line |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...out.summary.map((row) => {
      const r = row as unknown as Record<
        string,
        { mean: number | null } | string | number
      >;
      const cell = (metric: string) =>
        String((r[metric] as { mean: number | null }).mean);
      return `| ${String(r["id"])} | ${String(r["view"])} | ${String(r["hunks"])} | ${cell("necessary")} | ${cell("relevant")} | ${cell("necessaryAny")} | ${cell("relevantAny")} |`;
    }),
    "",
    "Sol minus Opus per hunk (R(H3-E1); route and snapshot confounded), family bootstrap at 95%:",
    "",
    "| view | measure | hunks | Sol − Opus [95%] |",
    "| --- | --- | --- | --- |",
    ...out.solMinusOpus.map(
      (row) =>
        `| ${row.view} | ${row.metric} | ${row.hunks} | ${row.solMinusOpus} [${row.ci95.join(", ")}] |`,
    ),
    "",
  ];
  writeFileSync(join(FULL_TEST_RESULTS, "rescore.md"), `${lines.join("\n")}\n`);
  return out;
};

export const rescoreAvailable = () =>
  RESCORED_LEDGERS.filter((ledger) => existsSync(join(ledger.results, "runs")));
