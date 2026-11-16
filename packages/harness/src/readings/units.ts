import type { Lane } from "@neuve/records-schema";
import { applyLane, overlaps, requirementsProof } from "../disposition.ts";
import { LANE_ORDER } from "../lane-rule.ts";
import type { Effect } from "./answers.ts";
import {
  UNDECIDED_CAUSES,
  type DecideOutput,
  type SectionEntry,
  type UndecidedCause,
} from "./decide.ts";

/**
 * Units from decided sections, their verdicts and dispositions, and the order a unit's comments are
 * shown in. Within one batch, a file's settled sections that share an applied lane are one unit,
 * always (round 32, the owner's ruling): a file splits into units only across lanes, never between
 * its decided and its undecided sections. Nothing is folded, since each section already carries its
 * own lane. A unit with an undecided section has no verdict; its Guided stop says each section's
 * own (`guidedOf`).
 */

export interface BatchSection {
  readonly path: string;
  /** The section's place in its file, for file order. */
  readonly order: number;
  readonly decision: DecideOutput;
}

export interface SectionUnit {
  readonly path: string;
  readonly lane: Lane;
  readonly sectionKeys: ReadonlyArray<string>;
  readonly verdict: "approve" | "request-changes" | null;
  readonly disposition: "approve" | "request-changes" | undefined;
  readonly suggestion: boolean;
  readonly proof: {
    readonly proof: ReadonlyArray<string>;
    readonly text: string;
  };
  /** Undecided sections by cause; a cause with none is absent. */
  readonly undecided: Partial<Record<UndecidedCause, number>>;
}

/** Whether every section given is settled: a batch is decided only then. */
export const batchSettled = (
  sections: ReadonlyArray<Pick<BatchSection, "decision">>,
) => sections.every((section) => section.decision.settled);

/**
 * A unit's verdict from its sections': a request for changes if any section requests changes, an
 * approval only if every section approves, otherwise none (only an undecided section has none,
 * and an undecided section is human-required). `composeUnits` gives none to a unit with any
 * undecided section before this is read, since an undecided section can still carry a request.
 */
export const unitVerdict = (
  verdicts: ReadonlyArray<SectionEntry["verdict"]>,
): SectionEntry["verdict"] =>
  verdicts.includes("request-changes")
    ? "request-changes"
    : verdicts.length > 0 && verdicts.every((v) => v === "approve")
      ? "approve"
      : null;

const COVERAGE_ORDER = ["missing", "shallow", "solid"] as const;

/**
 * The requirements a unit's proof text speaks for, from all its sections. Only lines identical in
 * requirement, coverage and proof records are merged, so a requirement nothing proves is never
 * hidden by a sibling section's proof. The same requirement in different states gives one line per
 * state, weakest coverage first; requirements keep the order they first appear in. The text and
 * the citations do not depend on the sections' order.
 */
export const unitRequirements = <
  R extends {
    readonly requirement: string;
    readonly coverage: (typeof COVERAGE_ORDER)[number];
    readonly proof: ReadonlyArray<string>;
  },
>(
  all: ReadonlyArray<R>,
): Array<R> => {
  const first = new Map<string, number>();
  const distinct = new Map<string, R>();
  for (const r of all) {
    if (!first.has(r.requirement)) first.set(r.requirement, first.size);
    const proof = [...new Set(r.proof)].sort();
    const key = JSON.stringify([r.requirement, r.coverage, proof]);
    if (!distinct.has(key)) distinct.set(key, { ...r, proof });
  }
  return [...distinct.entries()]
    .sort(
      ([ka, a], [kb, b]) =>
        first.get(a.requirement)! - first.get(b.requirement)! ||
        COVERAGE_ORDER.indexOf(a.coverage) -
          COVERAGE_ORDER.indexOf(b.coverage) ||
        (ka < kb ? -1 : ka > kb ? 1 : 0),
    )
    .map(([, r]) => r);
};

/**
 * The units of one settled batch: a file's sections that share an applied lane, in file order,
 * units by path and then by their first section; decided and undecided sections of one lane are one
 * unit. The verdict is none while any section is undecided (it would also stand for the sections no
 * agent judged), else `unitVerdict`. Disposition and suggestion through `applyLane`; the proof text
 * over the requirements of the unit's sections. Units form only for a settled batch, so a section
 * that is not settled is an error, never skipped.
 */
export const composeUnits = (
  sections: ReadonlyArray<BatchSection>,
): ReadonlyArray<SectionUnit> => {
  const unsettled = sections.filter((s) => !s.decision.settled).length;
  if (unsettled > 0)
    throw new Error(
      `Units form only for a settled batch, and ${unsettled} of its ${sections.length} section(s) ${unsettled === 1 ? "is" : "are"} not settled.`,
    );
  const groups = new Map<
    string,
    Array<{
      readonly order: number;
      readonly entry: SectionEntry;
      readonly path: string;
    }>
  >();
  for (const section of sections) {
    if (!section.decision.settled) continue;
    const entry = section.decision.entry;
    const id = JSON.stringify([section.path, entry.lane.applied]);
    groups.set(id, [
      ...(groups.get(id) ?? []),
      { order: section.order, entry, path: section.path },
    ]);
  }
  return [...groups.values()]
    .map((members) => [...members].sort((a, b) => a.order - b.order))
    .sort(
      (a, b) =>
        (a[0]!.path < b[0]!.path ? -1 : a[0]!.path > b[0]!.path ? 1 : 0) ||
        a[0]!.order - b[0]!.order ||
        LANE_ORDER.indexOf(a[0]!.entry.lane.applied) -
          LANE_ORDER.indexOf(b[0]!.entry.lane.applied),
    )
    .map((members) => {
      const lane = members[0]!.entry.lane.applied;
      const verdict = members.some((m) => m.entry.undecided !== undefined)
        ? null
        : unitVerdict(members.map((m) => m.entry.verdict));
      const outcome =
        verdict === null
          ? { disposition: undefined, suggestion: false }
          : applyLane(lane, verdict);
      const requirements = unitRequirements(
        members.flatMap(
          (m) => m.entry.assess?.easeOfValidation.requirements ?? [],
        ),
      );
      const undecided: Partial<Record<UndecidedCause, number>> = {};
      for (const cause of UNDECIDED_CAUSES) {
        const count = members.filter(
          (m) => m.entry.undecided?.cause === cause,
        ).length;
        if (count > 0) undecided[cause] = count;
      }
      return {
        path: members[0]!.path,
        lane,
        sectionKeys: members.map((m) => m.entry.key),
        verdict,
        disposition: outcome.disposition,
        suggestion: outcome.suggestion,
        proof: requirementsProof(requirements),
        undecided,
      };
    });
};

// ---------------------------------------------------------------------------------------------
// The order of a unit's comments
// ---------------------------------------------------------------------------------------------

/** How many of a unit's comments the desk shows; the rest keep their rank below the cut. */
export const SHOWN_COMMENTS = 3;

export interface UnitComment {
  readonly id: string;
  /**
   * Who raised it: Lane review, a finder, Assess (an impact entry) or code (a removal the code facts
   * show and no impact entry names).
   */
  readonly source: "lane-review" | "finder" | "assess" | "code";
  readonly kind: "defect" | "risk" | "question" | "pattern-note" | "impact";
  /** An impact comment's effect. */
  readonly effect?: Effect | undefined;
  /** A defect claim's outcome; a claim neither confirmed nor refuted is shown as a question. */
  readonly verify?: "confirmed" | "refuted" | "unconfirmed" | undefined;
  readonly anchor: {
    readonly path: string;
    readonly side: "old" | "new";
    readonly startLine: number;
    readonly endLine: number;
  };
  readonly cites: number;
}

export type RankedComment = UnitComment & {
  readonly rank: number;
  readonly fate: "shown" | "below-cut" | "refuted";
};

/**
 * `added` comes only from a Lane review impact comment or an Assess answer stored by an older
 * version: a new Assess answer writes impact only where existing behaviour changes.
 */
const IMPACT_TIERS: Readonly<Record<Effect, number>> = {
  removed: 0,
  disabled: 1,
  narrowed: 2,
  changed: 4,
  added: 5,
};

/**
 * A comment's tier: impact that removes, disables or narrows; confirmed defects; impact that
 * changes or adds; risks; questions; pattern notes.
 */
const tierOf = (comment: UnitComment) => {
  switch (comment.kind) {
    case "impact":
      return IMPACT_TIERS[comment.effect ?? "changed"];
    case "defect":
      // A refuted claim keeps a defect's place; one not confirmed reads as a question.
      return comment.verify === "confirmed" || comment.verify === "refuted"
        ? 3
        : 7;
    case "risk":
      return 6;
    case "question":
      return 7;
    case "pattern-note":
      return 8;
  }
};

/**
 * A unit's comments in rank order: by tier; then those a finder and Lane review both anchor on
 * overlapping lines; then by number of cites; then by place. A comment the unit's request for
 * changes rests on (`restsOn`) is always shown and does not count against the cut; of the rest,
 * the first three that are not refuted are shown and the others are below the cut. A refuted
 * claim keeps its place with fate `refuted` and is never shown. Every comment keeps its rank and
 * fate.
 */
export const rankComments = (
  comments: ReadonlyArray<UnitComment>,
  options: { readonly restsOn?: ReadonlyArray<string> | undefined } = {},
): ReadonlyArray<RankedComment> => {
  const restsOn = new Set(options.restsOn ?? []);
  // Only a finder and Lane review agreeing counts; an impact comment from Assess or code never does.
  const reviewers = (a: UnitComment, b: UnitComment) =>
    (a.source === "finder" && b.source === "lane-review") ||
    (a.source === "lane-review" && b.source === "finder");
  const agreed = (comment: UnitComment) =>
    comments.some(
      (other) =>
        reviewers(other, comment) &&
        other.anchor.path === comment.anchor.path &&
        other.anchor.side === comment.anchor.side &&
        overlaps(other.anchor, comment.anchor),
    );
  const placed = [...comments]
    .map((comment) => ({
      comment,
      tier: tierOf(comment),
      agreed: agreed(comment),
    }))
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        Number(b.agreed) - Number(a.agreed) ||
        b.comment.cites - a.comment.cites ||
        (a.comment.anchor.path < b.comment.anchor.path
          ? -1
          : a.comment.anchor.path > b.comment.anchor.path
            ? 1
            : 0) ||
        (a.comment.anchor.side === b.comment.anchor.side
          ? 0
          : a.comment.anchor.side === "old"
            ? -1
            : 1) ||
        a.comment.anchor.startLine - b.comment.anchor.startLine ||
        a.comment.anchor.endLine - b.comment.anchor.endLine ||
        (a.comment.id < b.comment.id
          ? -1
          : a.comment.id > b.comment.id
            ? 1
            : 0),
    );
  let shown = 0;
  return placed.map(({ comment }, i) => {
    if (comment.verify !== "refuted" && restsOn.has(comment.id))
      return { ...comment, rank: i + 1, fate: "shown" as const };
    const fate =
      comment.verify === "refuted"
        ? ("refuted" as const)
        : shown < SHOWN_COMMENTS
          ? ("shown" as const)
          : ("below-cut" as const);
    if (fate === "shown") shown++;
    return { ...comment, rank: i + 1, fate };
  });
};
