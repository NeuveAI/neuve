import type { RetainedReadingPlan as ReadingPlan } from "./assignments.ts";
import { addedLines, publicSurface } from "../lane-rule.ts";
import type { ManifestHunk } from "../manifest.ts";
import {
  stepEffortOf,
  type AnyRouteConfig,
  type RouteEffort,
} from "../route.ts";
import { removesDeclaration } from "./code-facts.ts";
import type { PlanSection } from "./plan.ts";

/**
 * The effort each reading step runs at (NEU-148), decided by code when the plan's reading tasks are
 * listed, from the plan alone, never from a model's answer. Each reading task carries it in its
 * input and each of its steps in its parameters, and the step sets it on its spec (`AgentSpec`'s
 * `effort`), so its key and its requests follow it, and a resumed or re-read step asks for the same.
 *
 * Without effort by risk, Assess and a Lane review each run at their kind's entry in
 * `review.stepEffort` when it names one, else at the lower of the route's effort and the readings'
 * default (`READING_EFFORT`): a review set to low stays at low, one at medium or high reads at
 * medium. A claim check sets none, so it runs at its stage's (`verify`: the route's, unless
 * `review.stepEffort.verify` names one).
 *
 * With effort by risk (`review.sectionReadingsEffort: "by-risk"`), each read section is in the high
 * class when it removes a declaration (`removesDeclaration`, the fact the removal floor reads), when
 * the lines it adds hit the public surface (`publicSurface` over `addedLines`, what
 * `withPublicSurface` reads, over the same added lines the plan's rank reads), or when its own rank
 * is in the top quarter of the plan's read sections (`topQuarterKeys`); every other section is in
 * the medium class. The plan packs its reading groups within each class (`planReadings`' `split`),
 * so a group is all of one class. A high-class group's Lane review runs at high and a medium-class
 * group's at medium; Assess at medium for both; a claim check at high. These are fixed levels,
 * whatever the route's effort is.
 *
 * Only types come from `plan.ts`, so `plan.ts` can call this module.
 */

/** A level effort by risk sends a reading step at. */
export type ReadingEffort = "medium" | "high";

export const ASSESS_EFFORT: ReadingEffort = "medium";
export const CLAIM_EFFORT: ReadingEffort = "high";

/**
 * The most effort Assess and a Lane review run at when nothing names theirs, without effort by risk.
 * From the planted cases scored at three settings (`coordination/neu-148/reports/readers-1.md`,
 * "High against high"): medium is no further from high, plant by plant, than high is from itself,
 * at about half the reading tokens. One line to change.
 */
export const READING_EFFORT: RouteEffort = "medium";

const EFFORT_ORDER: ReadonlyArray<RouteEffort> = ["low", "medium", "high"];
const lowerOf = (a: RouteEffort, b: RouteEffort): RouteEffort =>
  EFFORT_ORDER.indexOf(a) <= EFFORT_ORDER.indexOf(b) ? a : b;

/** Why a section, or a group, is in the high class, as closed labels, in this order. */
export type EffortWhy = "top-quarter" | "removal" | "public-surface";
const WHY_ORDER: ReadonlyArray<EffortWhy> = [
  "top-quarter",
  "removal",
  "public-surface",
];

/** The facts the rule reads for one section: the `reading.section` row's `risk` and `topQuarter`. */
export interface SectionFacts {
  /** It removes a declaration (`removesDeclaration`). */
  readonly removal: boolean;
  /** Its added lines hit the public surface (`publicSurface`). */
  readonly publicSurface: boolean;
  /** Its own rank is in the top quarter of the plan's read sections (`topQuarterKeys`). */
  readonly topQuarter: boolean;
}

type RiskSection = Pick<
  PlanSection,
  "key" | "kind" | "identity" | "owned" | "hunkIds" | "path" | "rank"
>;

/** A section's two code facts; see the module comment. */
export const sectionRisk = (
  section: Omit<RiskSection, "key" | "rank">,
  hunks: ReadonlyMap<string, ManifestHunk>,
): { readonly removal: boolean; readonly publicSurface: boolean } => {
  const own = section.hunkIds.flatMap((id) => {
    const hunk = hunks.get(id);
    return hunk === undefined ? [] : [hunk];
  });
  const newPath = own[0]?.newPath ?? section.path;
  return {
    removal: removesDeclaration(section),
    publicSurface:
      publicSurface(
        addedLines(
          section.owned
            .filter((range) => range.side === "new")
            .map((range) => ({ kind: "lines", path: newPath, ...range })),
          own,
        ),
      ).length > 0,
  };
};

/**
 * The top quarter of the read sections by their own rank: the first `floor(n / 4)` of them, taken
 * highest rank first, ties in the order given (the plan's order: path, first line, key).
 */
export const topQuarterKeys = (
  sections: ReadonlyArray<Pick<PlanSection, "key" | "rank">>,
): ReadonlySet<string> =>
  new Set(
    sections
      .map((section, at) => ({ section, at }))
      .sort((a, b) => b.section.rank - a.section.rank || a.at - b.at)
      .slice(0, Math.floor(sections.length / 4))
      .map(({ section }) => section.key),
  );

/** Every read section's facts, by key, in the order given (the plan's). */
export const effortFactsOf = (
  sections: ReadonlyArray<RiskSection>,
  hunks: ReadonlyMap<string, ManifestHunk>,
): ReadonlyMap<string, SectionFacts> => {
  const top = topQuarterKeys(sections);
  return new Map(
    sections.map((section) => [
      section.key,
      { ...sectionRisk(section, hunks), topQuarter: top.has(section.key) },
    ]),
  );
};

/** The reasons one section's facts give, in `WHY_ORDER`. */
export const whyOf = (
  facts: SectionFacts | undefined,
): ReadonlyArray<EffortWhy> =>
  facts === undefined
    ? []
    : WHY_ORDER.filter((why) =>
        why === "top-quarter"
          ? facts.topQuarter
          : why === "removal"
            ? facts.removal
            : facts.publicSurface,
      );

/** Whether a section is in the high class. */
export const isHigh = (facts: SectionFacts | undefined) =>
  whyOf(facts).length > 0;

/** One group's class (its Lane review's effort by risk), and why: the union of its sections' reasons. */
export interface GroupEffort {
  readonly laneReview: ReadingEffort;
  readonly why: ReadonlyArray<EffortWhy>;
}

export interface ReadingEfforts {
  readonly sections: ReadonlyMap<string, SectionFacts>;
  readonly groups: ReadonlyMap<string, GroupEffort>;
  /**
   * The counts the `readings.plan` row carries: sections and groups per class (a group is high
   * when any of its sections is; with effort by risk every group is of one class), the groups whose
   * sections give each reason, and the high class's sections by the exact reasons they have
   * (`top-quarter`, `removal`, `public-surface`, or several joined by `+`).
   */
  readonly counts: {
    readonly sections: { readonly high: number; readonly medium: number };
    readonly groups: { readonly high: number; readonly medium: number };
    readonly groupsBy: Readonly<Record<EffortWhy, number>>;
    readonly highSectionsBy: Readonly<Record<string, number>>;
  };
}

/** Each section's facts, each group's class and reasons, and the counts. */
export const readingEfforts = (
  plan: ReadingPlan,
  hunks: ReadonlyMap<string, ManifestHunk>,
): ReadingEfforts => {
  const sections = effortFactsOf(plan.sections, hunks);
  const groups = new Map<string, GroupEffort>();
  const counts = {
    sections: { high: 0, medium: 0 },
    groups: { high: 0, medium: 0 },
    groupsBy: { "top-quarter": 0, removal: 0, "public-surface": 0 },
    highSectionsBy: {} as Record<string, number>,
  };
  for (const facts of sections.values()) {
    const why = whyOf(facts);
    if (why.length === 0) {
      counts.sections.medium++;
      continue;
    }
    counts.sections.high++;
    const label = why.join("+");
    counts.highSectionsBy[label] = (counts.highSectionsBy[label] ?? 0) + 1;
  }
  for (const group of plan.groups) {
    const reasons = new Set(
      group.keys.flatMap((key) => whyOf(sections.get(key))),
    );
    const why = WHY_ORDER.filter((reason) => reasons.has(reason));
    const laneReview: ReadingEffort = why.length > 0 ? "high" : "medium";
    groups.set(group.id, { laneReview, why });
    counts.groups[laneReview]++;
    for (const reason of why) counts.groupsBy[reason]++;
  }
  return { sections, groups, counts };
};

/** The kinds of reading step: a group's two readings, a Lane review's claim check, and the briefing. */
export type ReadingStepKind =
  "assess" | "lane-review" | "verify-claim" | "brief";

/**
 * The effort a reading step sets on its spec: by risk (`byRisk`, the plan's efforts when the run
 * asks for it) a fixed level by kind and class; otherwise its kind's entry in `review.stepEffort`,
 * else the lower of the route's effort and `READING_EFFORT`, and none for a claim check, which then
 * runs at its stage's.
 */
export const readingStepEffort = (
  route: AnyRouteConfig,
  byRisk: ReadingEfforts | undefined,
  kind: ReadingStepKind,
  group: string,
): RouteEffort | undefined =>
  // The briefing judges nothing, so effort by risk leaves it alone: its own entry, else the lower of
  // the route's effort and `READING_EFFORT`, with effort by risk on or off (one model per route).
  kind === "brief"
    ? (route.stepEffort?.brief ?? lowerOf(route.effort, READING_EFFORT))
    : byRisk !== undefined
      ? kind === "assess"
        ? ASSESS_EFFORT
        : kind === "verify-claim"
          ? CLAIM_EFFORT
          : (byRisk.groups.get(group)?.laneReview ?? "medium")
      : kind === "verify-claim"
        ? undefined
        : (route.stepEffort?.[kind] ?? lowerOf(route.effort, READING_EFFORT));

/**
 * The effort a reading step runs at, as its `reading.call` row names it: the one it sets, else its
 * stage's (`verify`), as `agentStageSpec` and the agent step's binding resolve it.
 */
export const readingCallEffort = (
  route: AnyRouteConfig,
  byRisk: ReadingEfforts | undefined,
  kind: ReadingStepKind,
  group: string,
): RouteEffort =>
  stepEffortOf(route, "verify", readingStepEffort(route, byRisk, kind, group));
