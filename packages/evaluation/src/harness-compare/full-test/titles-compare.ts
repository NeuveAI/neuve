import { createHash } from "node:crypto";
import type { z } from "zod";
import { quantile, random } from "../../retrieval-bench/score/stats.ts";
import { TITLE_RULES, titleRows, type ShownTitles } from "./titles.ts";
import { readableRun, READS_STORED } from "./packets.ts";
import {
  TitleRubricItem,
  TITLE_RUBRIC_VERSION,
  type ShownRubricUnits,
  type TitleRubricDecided,
} from "./title-rubric.ts";

/**
 * A title candidate against its baseline (10.139): the same development cases recomposed twice, on
 * builds that differ only by the candidate, read in pairs. A title candidate runs after placement, so
 * both arms must hold the same units with the same lanes and sections; a pair that does not is
 * refused, since its titles would not be of the same units. The deltas are read per case and resampled
 * by case, so a few large cases cannot carry them.
 */

export const TITLES_BOOTSTRAP_SEED = "neuve-titles-compare-v1";
export const TITLES_DRAWS = 2_000;

type Shown = ShownTitles & ShownRubricUnits & Record<string, unknown>;

export interface TitlePair {
  readonly caseId: string;
  readonly source: string;
  readonly baseline: Shown;
  readonly candidate: Shown;
}

interface UnitLite {
  readonly id: string;
  readonly title: string;
  readonly hunkIds?: ReadonlyArray<string>;
  readonly ownedRanges?: ReadonlyArray<unknown>;
  readonly assessment?: {
    readonly lane?: string | null;
    readonly quadrant?: string | null;
    readonly complexity?: { readonly level?: string | null } | null;
    readonly validation?: { readonly level?: string | null } | null;
  } | null;
  readonly sections?: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly ownedRanges?: ReadonlyArray<unknown>;
  }>;
}

const unitsOf = (shown: Shown) =>
  (shown.assembled ?? []).flatMap(
    (batch) => batch.units as unknown as ReadonlyArray<UnitLite>,
  );

/**
 * The placement both arms must share: everything but a unit's title that the title check or the
 * rubric reads, so the evaluator's main change and supporting sections are the same in both arms.
 * Each unit's ID, hunks, owned ranges, lane, quadrant and levels; each section's ID, title and
 * owned ranges; the change map's hunk roles.
 */
const placementOf = (shown: Shown) =>
  JSON.stringify({
    units: unitsOf(shown)
      .map((unit) => ({
        id: unit.id,
        hunkIds: [...(unit.hunkIds ?? [])].sort(),
        ownedRanges: unit.ownedRanges ?? [],
        lane: unit.assessment?.lane ?? null,
        quadrant: unit.assessment?.quadrant ?? null,
        complexity: unit.assessment?.complexity?.level ?? null,
        validation: unit.assessment?.validation?.level ?? null,
        sections: (unit.sections ?? []).map((section) => ({
          id: section.id,
          title: section.title,
          ownedRanges: section.ownedRanges ?? [],
        })),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
    roles: [...(shown.changeMap?.hunkRoles ?? [])]
      .map((role) => `${role.hunkId}:${role.role}`)
      .sort(),
  });

/** Refuses a pair whose arms placed differently: the candidate may only rename units. */
export const checkPairs = (pairs: ReadonlyArray<TitlePair>) => {
  const ids = pairs.map((pair) => pair.caseId);
  const twice = ids.find((id, index) => ids.indexOf(id) !== index);
  if (twice !== undefined) throw new Error(`${twice} is paired more than once`);
  for (const pair of pairs) {
    if (unitsOf(pair.baseline).length === 0)
      throw new Error(`${pair.caseId}: the baseline assembled no units`);
    if (placementOf(pair.baseline) !== placementOf(pair.candidate))
      throw new Error(
        `${pair.caseId}: the candidate placed units differently from the baseline; a title candidate only renames them`,
      );
  }
  return pairs;
};

type Bucket = "joined" | "single" | "2-3" | "4+";
const BUCKETS: ReadonlyArray<Bucket> = ["joined", "single", "2-3", "4+"];
const inBucket = (bucket: Bucket, concerns: number) =>
  bucket === "joined"
    ? concerns > 1
    : bucket === "single"
      ? concerns <= 1
      : bucket === "2-3"
        ? concerns > 1 && concerns <= 3
        : concerns >= 4;

const MEASURES = [...TITLE_RULES, "allRules"] as const;
type Measure = (typeof MEASURES)[number];

/** One case's passes per bucket and measure, for one arm. */
const caseCounts = (shown: Shown) => {
  const rows = titleRows(shown);
  return Object.fromEntries(
    BUCKETS.map((bucket) => {
      const of = rows.filter((row) => inBucket(bucket, row.concerns));
      return [
        bucket,
        {
          units: of.length,
          ...(Object.fromEntries(
            MEASURES.map((measure) => [
              measure,
              of.filter((row) =>
                measure === "allRules"
                  ? TITLE_RULES.every((rule) => row.rules[rule])
                  : row.rules[measure],
              ).length,
            ]),
          ) as Record<Measure, number>),
        },
      ];
    }),
  ) as Record<Bucket, { units: number } & Record<Measure, number>>;
};

const share = (part: number, whole: number) =>
  whole === 0 ? null : Math.round((part / whole) * 1_000) / 1_000;

/**
 * The paired case bootstrap of a share's delta: cases resampled with replacement, each draw
 * reading both arms on the same cases. Seeded per bucket and measure.
 */
export const pairedShareInterval = (
  cases: ReadonlyArray<{ units: number; base: number; next: number }>,
  label: string,
): readonly [number, number] | null => {
  if (cases.every((entry) => entry.units === 0)) return null;
  const next = random(`${TITLES_BOOTSTRAP_SEED}:${label}`);
  const deltas: Array<number> = [];
  for (let draw = 0; draw < TITLES_DRAWS; draw++) {
    let units = 0;
    let gained = 0;
    for (let index = 0; index < cases.length; index++) {
      const entry =
        cases[Math.min(cases.length - 1, Math.floor(next() * cases.length))]!;
      units += entry.units;
      gained += entry.next - entry.base;
    }
    if (units > 0) deltas.push(gained / units);
  }
  if (deltas.length === 0) return null;
  deltas.sort((a, b) => a - b);
  return [
    Math.round(quantile(deltas, 0.025) * 1_000) / 1_000,
    Math.round(quantile(deltas, 0.975) * 1_000) / 1_000,
  ];
};

/**
 * The code title rules, both arms, per bucket and measure: each share, its delta and the paired
 * case bootstrap's 95% interval. One-concern units' titles are their section's, so the candidate
 * cannot move them; the bucket is read to show it did not.
 */
export const titleComparison = (pairs: ReadonlyArray<TitlePair>) => {
  checkPairs(pairs);
  const perCase = pairs.map((pair) => ({
    base: caseCounts(pair.baseline),
    next: caseCounts(pair.candidate),
  }));
  return {
    cases: pairs.length,
    buckets: Object.fromEntries(
      BUCKETS.map((bucket) => {
        const units = perCase.reduce(
          (sum, entry) => sum + entry.base[bucket].units,
          0,
        );
        return [
          bucket,
          {
            units,
            ...Object.fromEntries(
              MEASURES.map((measure) => {
                const base = perCase.reduce(
                  (sum, entry) => sum + entry.base[bucket][measure],
                  0,
                );
                const next = perCase.reduce(
                  (sum, entry) => sum + entry.next[bucket][measure],
                  0,
                );
                const baseline = share(base, units);
                const candidate = share(next, units);
                return [
                  measure,
                  {
                    baseline,
                    candidate,
                    delta:
                      baseline === null || candidate === null
                        ? null
                        : Math.round((candidate - baseline) * 1_000) / 1_000,
                    interval: pairedShareInterval(
                      perCase.map((entry) => ({
                        units: entry.base[bucket].units,
                        base: entry.base[bucket][measure],
                        next: entry.next[bucket][measure],
                      })),
                      `${bucket}:${measure}`,
                    ),
                  },
                ];
              }),
            ),
          },
        ];
      }),
    ) as Record<
      Bucket,
      { units: number } & Record<
        Measure,
        {
          baseline: number | null;
          candidate: number | null;
          delta: number | null;
          interval: readonly [number, number] | null;
        }
      >
    >,
  };
};

const firstSentence = (text: string) =>
  (
    text
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .split(/\n\s*\n/)[0]
      ?.split(/(?<=[.!?])\s+/)[0] ?? ""
  ).trim();

/** A seeded shuffle, so a sample can be drawn again. */
export const shuffled = <T>(items: ReadonlyArray<T>, seed: string) => {
  const next = random(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(next() * (i + 1)));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
};

/**
 * The blind rubric over both arms' joined-unit titles: each title an item of its own, the two arms'
 * items shuffled together so a judge never knows which arm wrote one, and a title both arms wrote
 * judged once for both. One-concern units are left out: both arms title them the same.
 */
export const titlePairRubricSample = (
  pairs: ReadonlyArray<TitlePair>,
  seed: string,
) => {
  checkPairs(pairs);
  const entries = pairs.flatMap((pair) => {
    // The rubric reads what a reviewer sees beside a title: its sections' briefings and its files.
    type RubricUnit = NonNullable<
      ShownRubricUnits["assembled"]
    >[number]["units"][number];
    const named = (shown: Shown) =>
      new Map(
        ((shown as ShownRubricUnits).assembled ?? []).flatMap((batch) =>
          batch.units.map((unit) => [unit.id, unit as RubricUnit] as const),
        ),
      );
    const base = named(pair.baseline);
    const next = named(pair.candidate);
    return [...base.values()].flatMap((unit) => {
      const sections = unit.sections ?? [];
      if (sections.length < 2) return [];
      const changes = sections.map(
        (section) =>
          firstSentence(section.content?.briefed ?? "") || section.title,
      );
      const paths =
        unit.ownedPaths !== undefined && unit.ownedPaths.length > 0
          ? [...unit.ownedPaths]
          : ["(unknown)"];
      const titles = [
        { arm: "baseline" as const, title: unit.title },
        { arm: "candidate" as const, title: next.get(unit.id)!.title },
      ];
      const distinct = [...new Set(titles.map((entry) => entry.title))];
      return distinct.map((title) => {
        const place = `${pair.caseId}|${unit.id}|${title}`;
        return {
          id: `t${createHash("sha256").update(`${seed}|${place}`).digest("hex").slice(0, 12)}`,
          title,
          changes,
          paths,
          key: {
            caseId: pair.caseId,
            unit: unit.id,
            source: pair.source,
            arms: titles
              .filter((entry) => entry.title === title)
              .map((entry) => entry.arm),
          },
        };
      });
    });
  });
  const items = shuffled(entries, `${seed}|order`);
  return {
    version: TITLE_RUBRIC_VERSION,
    seed,
    items: items.map(({ key: _key, ...item }) => TitleRubricItem.parse(item)),
    key: Object.fromEntries(items.map((entry) => [entry.id, entry.key])),
  };
};

export type PairRubricKey = ReturnType<typeof titlePairRubricSample>["key"];

const QUESTIONS = [
  "namesMain",
  "coversRest",
  "oneStatement",
  "whereToLook",
] as const;

/** A rubric row and the answers it counts: `good` is the share reported, `bad` the other judged one. */
export interface RubricRow {
  readonly name: string;
  readonly good: string;
  readonly bad: string;
}

/**
 * A paired rubric's shares for each arm, per row: the good answer's share of the judged ones, the
 * delta and the paired case bootstrap's interval. An item is judged on a row when it got the good or
 * the bad answer there; any other (unsure) leaves it out of that row in its arms. Seeded per label
 * and row.
 */
export const pairedRubricRates = (
  answers: ReadonlyArray<{ readonly id: string } & Record<string, unknown>>,
  key: PairRubricKey,
  rows: ReadonlyArray<RubricRow>,
  label: string,
) => {
  const ids = answers.map((answer) => answer.id);
  const twice = ids.find((id, index) => ids.indexOf(id) !== index);
  if (twice !== undefined)
    throw new Error(`the decided answers name ${twice} more than once`);
  const missing = Object.keys(key).filter((id) => !ids.includes(id));
  const byId = new Map(answers.map((answer) => [answer.id, answer]));
  // Per case, per row, per arm: good and judged counts.
  type Counts = Record<
    "baseline" | "candidate",
    { yes: number; judged: number }
  >;
  const cases = new Map<string, Record<string, Counts>>();
  for (const [id, entry] of Object.entries(key)) {
    const answer = byId.get(id);
    if (answer === undefined) continue;
    const held =
      cases.get(entry.caseId) ??
      Object.fromEntries(
        rows.map((row) => [
          row.name,
          {
            baseline: { yes: 0, judged: 0 },
            candidate: { yes: 0, judged: 0 },
          },
        ]),
      );
    for (const row of rows) {
      const value = answer[row.name];
      if (value !== row.good && value !== row.bad) continue;
      for (const arm of entry.arms) {
        held[row.name]![arm].judged++;
        if (value === row.good) held[row.name]![arm].yes++;
      }
    }
    cases.set(entry.caseId, held);
  }
  const all = [...cases.values()];
  return {
    items: Object.keys(key).length,
    unanswered: missing.length,
    questions: Object.fromEntries(
      rows.map(({ name: question }) => {
        const sum = (arm: "baseline" | "candidate", field: "yes" | "judged") =>
          all.reduce((total, entry) => total + entry[question]![arm][field], 0);
        const baseline = share(
          sum("baseline", "yes"),
          sum("baseline", "judged"),
        );
        const candidate = share(
          sum("candidate", "yes"),
          sum("candidate", "judged"),
        );
        // The interval resamples cases; each draw compares the arms' shares on the same cases.
        const next = random(`${TITLES_BOOTSTRAP_SEED}:${label}:${question}`);
        const deltas: Array<number> = [];
        if (all.length > 0)
          for (let draw = 0; draw < TITLES_DRAWS; draw++) {
            const totals = { by: 0, bj: 0, cy: 0, cj: 0 };
            for (let index = 0; index < all.length; index++) {
              const entry =
                all[Math.min(all.length - 1, Math.floor(next() * all.length))]![
                  question
                ]!;
              totals.by += entry.baseline.yes;
              totals.bj += entry.baseline.judged;
              totals.cy += entry.candidate.yes;
              totals.cj += entry.candidate.judged;
            }
            if (totals.bj > 0 && totals.cj > 0)
              deltas.push(totals.cy / totals.cj - totals.by / totals.bj);
          }
        deltas.sort((a, b) => a - b);
        return [
          question,
          {
            judged: {
              baseline: sum("baseline", "judged"),
              candidate: sum("candidate", "judged"),
            },
            baseline,
            candidate,
            delta:
              baseline === null || candidate === null
                ? null
                : Math.round((candidate - baseline) * 1_000) / 1_000,
            interval:
              deltas.length === 0
                ? null
                : ([
                    Math.round(quantile(deltas, 0.025) * 1_000) / 1_000,
                    Math.round(quantile(deltas, 0.975) * 1_000) / 1_000,
                  ] as const),
          },
        ];
      }),
    ),
  };
};

/**
 * The title rubric's yes shares for each arm over joined units, per question, with the delta and the
 * paired case bootstrap's interval. A unit is judged in an arm when its title there got a yes or a
 * no; an unsure answer leaves it out of that question in that arm.
 */
export const pairRubricComparison = (
  decided: z.infer<typeof TitleRubricDecided>,
  key: PairRubricKey,
) =>
  pairedRubricRates(
    decided.answers,
    key,
    QUESTIONS.map((name) => ({ name, good: "yes", bad: "no" })),
    "rubric",
  );

/** Pairs each case's baseline and candidate recompose, by case; a case in one arm alone is refused. */
export const pairRuns = (
  baseline: ReadonlyArray<{
    caseId: string;
    source: string;
    shown: Record<string, unknown>;
  }>,
  candidate: ReadonlyArray<{
    caseId: string;
    source: string;
    shown: Record<string, unknown>;
  }>,
): Array<TitlePair> => {
  const next = new Map(candidate.map((run) => [run.caseId, run]));
  const only = [
    ...baseline.filter((run) => !next.has(run.caseId)),
    ...candidate.filter(
      (run) => !baseline.some((base) => base.caseId === run.caseId),
    ),
  ];
  if (only.length > 0)
    throw new Error(
      `${only[0]!.caseId} is in one arm only; both arms read the same cases`,
    );
  // Through the guard (packets.ts): titles and digests have no reader for the sections shape.
  return baseline.map((run) => ({
    caseId: run.caseId,
    source: run.source,
    baseline: readableRun(
      run.shown,
      `case ${run.caseId}'s baseline run`,
      READS_STORED,
    ) as Shown,
    candidate: readableRun(
      next.get(run.caseId)!.shown,
      `case ${run.caseId}'s candidate run`,
      READS_STORED,
    ) as Shown,
  }));
};

/** The comparison in plain lines. */
export const describeTitleComparison = (
  result: ReturnType<typeof titleComparison>,
) => {
  const pct = (value: number | null) =>
    value === null ? "n/a" : `${Math.round(value * 1_000) / 10}%`;
  const points = (value: number) =>
    `${value >= 0 ? "+" : ""}${Math.round(value * 1_000) / 10}`;
  return [
    `${result.cases} case(s), each recomposed by the baseline and the candidate.`,
    ...(["joined", "2-3", "4+", "single"] as const).map((bucket) => {
      const row = result.buckets[bucket];
      const all = row.allRules;
      return `  ${bucket === "single" ? "one concern" : bucket === "joined" ? "joined" : `${bucket} concerns`} (${row.units} units): every rule ${pct(all.baseline)} → ${pct(all.candidate)}${all.delta === null ? "" : ` (${points(all.delta)} points${all.interval === null ? "" : `, 95% interval ${points(all.interval[0])} to ${points(all.interval[1])}`})`}; names the main change ${pct(row.namesMain.baseline)} → ${pct(row.namesMain.candidate)}; supporting left out ${pct(row.leavesOutSupporting.baseline)} → ${pct(row.leavesOutSupporting.candidate)}.`;
    }),
  ];
};

/**
 * The paired rubric's calls: never both arms' titles of one unit in the same call, so a judge reads
 * each title alone instead of comparing the two. Units with two items are placed first, each item in
 * the least-filled call that holds none of its unit (seeded order); then the order within each call
 * is shuffled. Throws if a unit's items still share a call.
 */
export const pairRubricChunks = <T extends { readonly id: string }>(
  items: ReadonlyArray<T>,
  key: PairRubricKey,
  seed: string,
  size = 25,
) => {
  const unitOf = (item: T) => {
    const entry = key[item.id];
    if (entry === undefined) throw new Error(`${item.id} is not in the key`);
    return `${entry.caseId}|${entry.unit}`;
  };
  const byUnit = new Map<string, Array<T>>();
  for (const item of items)
    byUnit.set(unitOf(item), [...(byUnit.get(unitOf(item)) ?? []), item]);
  const paired = [...byUnit.values()].some((of) => of.length > 1);
  const count = Math.max(Math.ceil(items.length / size), paired ? 2 : 1);
  const calls: Array<Array<T>> = Array.from({ length: count }, () => []);
  const units = shuffled([...byUnit.entries()], `${seed}|units`).sort(
    (a, b) => b[1].length - a[1].length,
  );
  for (const [unit, of] of units)
    for (const item of of) {
      const open = calls
        .map((call, index) => ({ call, index }))
        .filter(({ call }) => !call.some((other) => unitOf(other) === unit))
        .sort((a, b) => a.call.length - b.call.length || a.index - b.index);
      if (open.length === 0)
        throw new Error(`no call is free of ${unit}'s other title`);
      open[0]!.call.push(item);
    }
  const chunks = calls.map((call, index) =>
    shuffled(call, `${seed}|call|${index}`),
  );
  for (const call of chunks) {
    const seen = call.map(unitOf);
    if (new Set(seen).size !== seen.length)
      throw new Error("a call holds both arms' titles of one unit");
  }
  return chunks.filter((call) => call.length > 0);
};
