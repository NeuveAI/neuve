import type { Checkpoints } from "@neuve/records-core";
import type {
  CheckpointState,
  JudgementLineage,
  Lane,
} from "@neuve/records-schema";
import {
  confirmedMoveOf,
  floorsOf,
  recordedLane,
  type AddedLine,
  type Floor,
  type FloorFacts,
  type FloorOptions,
  type Move,
} from "../lane-rule.ts";
import { coverageOf, type NamedProof } from "../proof-state.ts";
import type {
  Anchor,
  AssessJudgement,
  Effect,
  LaneReviewJudgement,
} from "./answers.ts";
import type { RelationsGapCause } from "./evidence.ts";

/**
 * One section's decision, from both readings' outcomes, the defect claims that land on it and its
 * proof. Pure: the stored entry it returns is the lane rule's input, and nothing is cut after the
 * rule runs, so `recordedLane(entry, added)` always gives `entry.lane`.
 */

/**
 * Why a reading did not judge a section. `refused` is a provider's quota refusal. `unreadable`: the
 * section has no text to read (a binary file, a mode-only change), so no reading is made.
 */
export type NotJudgedCause =
  "failed" | "too-large" | "not-reached" | "refused" | "unreadable";

/** Why a settled section is undecided, which sends it to human-required. */
export type UndecidedCause =
  | "failed"
  | "not-reached"
  | "unsure"
  | "unconfirmed"
  | "disagreed"
  | "too-large"
  | "unreadable";

export type UndecidedReading = "assess" | "lane-review" | "verify";

export const UNDECIDED_CAUSES: ReadonlyArray<UndecidedCause> = [
  "failed",
  "not-reached",
  "unsure",
  "unconfirmed",
  "disagreed",
  "too-large",
  "unreadable",
];

export interface Claim {
  readonly id: string;
  readonly source: "lane-review" | "finder";
  /** `not-reached`: its check was not started before the run's cut-off; it is not unconfirmed. */
  readonly verify: "confirmed" | "refuted" | "unconfirmed" | "not-reached";
}

export type ReadingOutcome<J> =
  | { readonly judged: true; readonly judgement: J }
  | { readonly judged: false; readonly cause: NotJudgedCause };

/**
 * Why a file gets no reading at all: the map excluded it as a lockfile, a declared-generated file,
 * or a file GitHub Linguist's generated or vendored list marks (`review-map.ts` `mapExclusion`).
 */
export type ExcludedReason =
  | "lockfile"
  | "declared-generated"
  | "linguist-generated"
  | "linguist-vendored";

/**
 * Where a carried judgement came from: the review (its run key) and run whose stored reading this
 * review reused, the cycle and head it read, the reading's computation (`judgement`), its output
 * blob (`output`), and how long that reading took (`savedMs`), as the records' lineage names them.
 */
export type CarriedFrom = JudgementLineage & { readonly run: string };

export interface DecideInput {
  /**
   * The map excluded the section's file: no reading is made and none is waited for, so it is settled
   * with no verdict, in today's lane for such a file (human-suggested). Its readings and claims are
   * not read.
   */
  readonly excluded?:
    | {
        readonly reason: ExcludedReason;
        /** The declaration or rule that fired (`ReviewMap.excluded[].by`), where given. */
        readonly by?: string | undefined;
      }
    | undefined;
  readonly section: {
    readonly key: string;
    readonly path: string;
    readonly declared: "test" | "doc" | "generated" | null;
    /** Whether its boundaries came from the file's structure or a fallback. */
    readonly boundaries: "structure" | "fallback";
    /** Whether relation evidence (callers, tests) was shown to the readings. */
    readonly relations: boolean;
    /**
     * Why it was not, as its gap says (`relationsGapCause`): absent, `unavailable`, today's words.
     * Read only when `relations` is false.
     */
    readonly relationsGap?: RelationsGapCause | undefined;
    readonly added: ReadonlyArray<AddedLine>;
    readonly floorFacts: FloorFacts;
    /**
     * The moves the section's kept findings give (`movesOf`), stored on its assessment and read by
     * the lane rule. Not read where Assess did not judge it: such a section is undecided.
     */
    readonly moves: ReadonlyArray<Move>;
    /** Passed through to the entry unread. */
    readonly facts: unknown;
  };
  readonly assess: ReadingOutcome<AssessJudgement>;
  readonly review: ReadingOutcome<Pick<LaneReviewJudgement, "verdict">>;
  readonly claims: ReadonlyArray<Claim>;
  /**
   * Set when a reading this section's judgement rests on was stored by an earlier review and reused
   * here: the entry is then recorded as carried from it. Absent, the judgement is this review's.
   */
  readonly carried?: CarriedFrom | undefined;
  readonly proof: {
    /** The proof records a requirement may name, with their currency for this section's file. */
    readonly records: ReadonlyMap<string, NamedProof>;
    /** The pinned sources this section's requirements rest on, by their snapshot IDs. */
    readonly sources: ReadonlyArray<{
      readonly id: string;
      readonly status: Checkpoints.SourceStatus;
    }>;
  };
  readonly options: {
    readonly floors: FloorOptions;
    /** Whether the follow-on cap is reached: a section not reached is then final. */
    readonly capReached: boolean;
  };
}

/** A requirement as stored: as the reading wrote it, with what code set. */
export interface StoredRequirement {
  readonly requirement: string;
  readonly cites: ReadonlyArray<string>;
  readonly coverage: "missing" | "shallow" | "solid";
  readonly proof: ReadonlyArray<string>;
  readonly kinds: AssessJudgement["easeOfValidation"]["requirements"][number]["kinds"];
  readonly agree: boolean;
  readonly testable: boolean;
  readonly untested: string;
  readonly proofState: CheckpointState;
  readonly coverageNote: string;
  readonly proofNote: string;
  readonly anchors: ReadonlyArray<Anchor>;
  readonly sources: ReadonlyArray<string>;
}

export interface StoredAssess {
  readonly complexity: AssessJudgement["complexity"];
  /** Code's factors from the plan's facts, which the lane rule never reads (`AssessJudgement`). */
  readonly codeFactors: AssessJudgement["codeFactors"];
  readonly easeOfValidation: {
    readonly level: "easy" | "hard";
    readonly requirements: ReadonlyArray<StoredRequirement>;
  };
  /**
   * The moves on the matrix code gave the section: one per kept finding that moves an axis (14.28),
   * then, under lane rule 5, one on each axis for a request for changes resting on confirmed claims
   * (14.34).
   */
  readonly movement: ReadonlyArray<Move>;
  readonly lean: AssessJudgement["lean"];
  readonly gaps: AssessJudgement["gaps"];
}

/** A section's stored entry, in the records' stored form. */
export interface SectionEntry {
  readonly key: string;
  readonly facts: unknown;
  readonly assess: StoredAssess | null;
  /** The reviewer's own word. */
  readonly review: { readonly verdict: LaneReviewJudgement["verdict"] } | null;
  readonly lane: {
    readonly judged: Lane | null;
    readonly surfaced: Lane | null;
    readonly floors: ReadonlyArray<Floor>;
    readonly applied: Lane;
  };
  readonly undecided?: {
    readonly cause: UndecidedCause;
    readonly reading: UndecidedReading;
  };
  /** A lockfile, declared-generated or Linguist-marked file, which no reading reads. */
  readonly excluded?: { readonly reason: ExcludedReason; readonly by?: string };
  readonly impact: ReadonlyArray<{
    readonly effect: Effect;
    readonly text: string;
    readonly cites: ReadonlyArray<string>;
  }>;
  /** The section's standing verdict after its claims were checked. */
  readonly verdict: "approve" | "request-changes" | null;
  /** The confirmed claims a request for changes rests on. */
  readonly restsOn: ReadonlyArray<string>;
  /** `carried` when a reading it rests on was reused from an earlier review, which `from` names. */
  readonly lineage: "fresh" | "carried";
  readonly from?: CarriedFrom;
  /** What the floor rule read, so `floorsOf(facts, options)` can be run again from the entry. */
  readonly floorInputs: {
    readonly facts: FloorFacts;
    readonly options: FloorOptions;
  };
}

export type DecideOutput =
  | {
      readonly settled: true;
      readonly entry: SectionEntry;
      readonly verdict: SectionEntry["verdict"];
      readonly restsOn: ReadonlyArray<string>;
    }
  | {
      /** A reading was refused, or not reached before the follow-on cap: nothing is applied yet. */
      readonly settled: false;
      readonly entry: null;
      readonly verdict: null;
      readonly restsOn: ReadonlyArray<never>;
      readonly waiting: {
        readonly cause: "refused" | "not-reached";
        readonly reading: "assess" | "lane-review" | "verify";
      };
    };

const RELATIONS_GAP = {
  axis: "ease-of-validation",
  kind: "relations-unavailable",
  detail:
    "The callers and tests of this code were not available, so how it is used could not be checked.",
} as const;

/**
 * Code's relations gap by its cause, one kind (`relations-unavailable`) in different words: what a
 * person reads says whether the callers were not to be had, or were still being computed when the
 * code was read (the head gate's cut-off, round 20). It forecasts nothing: past the gate's cut-off
 * the head read is kept only while the review runs, so a later review may lack the callers again.
 * A follow-on of the same chain shows the same words on purpose: the chain's decision is never
 * reversed (`relationsGapCause`).
 */
const RELATIONS_GAPS = {
  unavailable: RELATIONS_GAP,
  computing: {
    ...RELATIONS_GAP,
    detail:
      "The callers and tests of this code were still being computed when it was read.",
  },
  "not-started": {
    ...RELATIONS_GAP,
    detail:
      "The callers and tests of this code had not started being computed when it was read.",
  },
  // The head's relations were read (round 23): the section's own state, in true words.
  "no-evidence": {
    ...RELATIONS_GAP,
    detail: "No caller shows how this code is used.",
  },
  partial: {
    ...RELATIONS_GAP,
    detail: "The callers read don't show how all of this code is used.",
  },
  "over-cap": {
    ...RELATIONS_GAP,
    detail: "This change touches too much code to show all its callers.",
  },
  "not-read": {
    ...RELATIONS_GAP,
    detail: "Callers weren't read for this file.",
  },
  "submodule-pointer": {
    ...RELATIONS_GAP,
    detail: "Callers aren't read for a submodule pointer, so none is shown.",
  },
  // The hold: the callers were read and shown, and the change still goes to a person.
  held: {
    ...RELATIONS_GAP,
    detail: "The callers of this code were read; a person still reviews it.",
  },
  published: {
    ...RELATIONS_GAP,
    detail:
      "The callers and tests of this code were not computed before the review was published, so how it is used could not be checked.",
  },
  stopped: {
    ...RELATIONS_GAP,
    detail:
      "The callers and tests of this code were not computed because the review was stopped, so how it is used could not be checked.",
  },
} as const satisfies Record<
  RelationsGapCause,
  {
    readonly axis: "ease-of-validation";
    readonly kind: "relations-unavailable";
    readonly detail: string;
  }
>;

const STRUCTURE_GAP = {
  axis: "complexity",
  kind: "structure-unavailable",
  detail:
    "The file's structure could not be read, so this change's boundaries are approximate.",
} as const;

/** Every gap code writes, whole: what tells a gap code wrote from one a reading wrote. */
export const CODE_GAPS = [
  RELATIONS_GAP,
  STRUCTURE_GAP,
  RELATIONS_GAPS.computing,
  RELATIONS_GAPS["not-started"],
  RELATIONS_GAPS.held,
  RELATIONS_GAPS["no-evidence"],
  RELATIONS_GAPS.partial,
  RELATIONS_GAPS["over-cap"],
  RELATIONS_GAPS["not-read"],
  RELATIONS_GAPS["submodule-pointer"],
  RELATIONS_GAPS.published,
  RELATIONS_GAPS.stopped,
] as const;
export type CodeGapKind = (typeof CODE_GAPS)[number]["kind"];

/**
 * A stored gap's kind as a closed label: code's own kind where the gap is exactly one code writes
 * (its axis, kind and words), else `model`, so a reading's own words for a gap are never given out.
 */
export const gapKindOf = (gap: {
  readonly axis: string;
  readonly kind: string;
  readonly detail: string;
}): CodeGapKind | "model" =>
  CODE_GAPS.find(
    (own) =>
      own.axis === gap.axis &&
      own.kind === gap.kind &&
      own.detail === gap.detail,
  )?.kind ?? "model";

/** Code's gaps, added before the rule runs (and by the hold's replay, `readings/replay-hold.ts`). */
export const codeGaps = (
  section: Pick<
    DecideInput["section"],
    "relations" | "relationsGap" | "declared" | "boundaries"
  >,
) => [
  ...(!section.relations &&
  section.declared !== "test" &&
  section.declared !== "doc" &&
  section.declared !== "generated"
    ? [RELATIONS_GAPS[section.relationsGap ?? "unavailable"]]
    : []),
  ...(section.boundaries === "fallback" ? [STRUCTURE_GAP] : []),
];

const storedAssess = (
  judgement: AssessJudgement,
  input: DecideInput,
  /** The verdict's own move (`confirmedMoveOf`), after the kept findings' moves. */
  verdictMoves: ReadonlyArray<Move>,
): StoredAssess => {
  const statuses = input.proof.sources.map((source) => source.status);
  const sourceIds = input.proof.sources.map((source) => source.id);
  const added = codeGaps(input.section).filter(
    (gap) =>
      !judgement.gaps.some((g) => g.axis === gap.axis && g.kind === gap.kind),
  );
  return {
    complexity: judgement.complexity,
    codeFactors: judgement.codeFactors,
    easeOfValidation: {
      level: judgement.easeOfValidation.level,
      requirements: judgement.easeOfValidation.requirements.map((r) => {
        const proof = coverageOf(r, input.proof.records, statuses);
        return {
          requirement: r.requirement,
          cites: r.cites,
          coverage: proof.coverage,
          proof: r.proof,
          kinds: r.kinds,
          agree: r.agree,
          testable: r.testable,
          untested: r.untested,
          proofState: proof.proofState,
          coverageNote: proof.note,
          proofNote: proof.proofNote,
          anchors: r.anchors,
          sources: sourceIds,
        };
      }),
    },
    movement: [...input.section.moves, ...verdictMoves].map((move) => ({
      ...move,
      cites: [...move.cites],
    })),
    lean: judgement.lean,
    gaps: [...judgement.gaps, ...added],
  };
};

/** The first reading that leaves the section unsettled, in order: a refusal, then not reached before the cap. */
const waitingOf = (input: DecideInput) => {
  const readings = [
    ["assess", input.assess],
    ["lane-review", input.review],
  ] as const;
  for (const [reading, outcome] of readings)
    if (!outcome.judged && outcome.cause === "refused")
      return { cause: "refused" as const, reading };
  for (const [reading, outcome] of readings)
    if (
      !outcome.judged &&
      outcome.cause === "not-reached" &&
      !input.options.capReached
    )
      return { cause: "not-reached" as const, reading };
  // A claim whose check the cut-off kept from starting waits for it, as a reading not reached does.
  if (
    !input.options.capReached &&
    input.claims.some((claim) => claim.verify === "not-reached")
  )
    return { cause: "not-reached" as const, reading: "verify" as const };
  return undefined;
};

/** Why a settled section is undecided, in order of precedence, or undefined when it is decided. */
const undecidedOf = (
  input: DecideInput,
): SectionEntry["undecided"] | undefined => {
  if (!input.assess.judged && input.assess.cause !== "refused")
    return { cause: input.assess.cause, reading: "assess" };
  if (!input.review.judged)
    return input.review.cause === "refused"
      ? undefined
      : { cause: input.review.cause, reading: "lane-review" };
  if (input.review.judgement.verdict === "unsure")
    return { cause: "unsure", reading: "lane-review" };
  if (input.claims.some((claim) => claim.verify === "not-reached"))
    return { cause: "not-reached", reading: "verify" };
  if (input.claims.some((claim) => claim.verify === "unconfirmed"))
    return { cause: "unconfirmed", reading: "verify" };
  if (
    input.review.judgement.verdict === "request-changes" &&
    !input.claims.some((claim) => claim.verify === "confirmed")
  )
    return { cause: "disagreed", reading: "verify" };
  return undefined;
};

/**
 * One section's decision. Not settled when a reading was refused, or not reached while the
 * follow-on cap is not reached. Otherwise settled, with the lane from rule 5, except that an
 * undecided section is human-required. The verdict is set before the lane: a request for changes
 * when any claim on the section is confirmed, resting on those claims; else an approval when Lane
 * review approved and no claim is unconfirmed; else none. A decided section's request for changes
 * also moves both axes, to high complexity and hard validation (`confirmedMoveOf`, 14.34), so it is
 * human-required; an undecided one gets no such move, so its entry is as before (14.4).
 */
export const decideSection = (input: DecideInput): DecideOutput => {
  if (input.excluded !== undefined) {
    const by = input.excluded.by;
    const excluded = {
      reason: input.excluded.reason,
      ...(by === undefined ? {} : { by }),
    };
    const floorFacts: FloorFacts = { ...input.section.floorFacts };
    const floors = floorsOf(floorFacts, input.options.floors);
    const trail = recordedLane(
      { assess: null, lane: { floors }, excluded },
      input.section.added,
    );
    const entry: SectionEntry = {
      key: input.section.key,
      facts: input.section.facts,
      assess: null,
      review: null,
      lane: {
        judged: trail.judged,
        surfaced: trail.surfaced,
        floors: trail.floors,
        applied: trail.applied,
      },
      excluded,
      impact: [],
      verdict: null,
      restsOn: [],
      lineage: "fresh",
      floorInputs: { facts: floorFacts, options: { ...input.options.floors } },
    };
    return { settled: true, entry, verdict: null, restsOn: [] };
  }
  const waiting = waitingOf(input);
  if (waiting !== undefined)
    return { settled: false, entry: null, verdict: null, restsOn: [], waiting };
  const undecided = undecidedOf(input);
  const confirmed = input.claims
    .filter((claim) => claim.verify === "confirmed")
    .map((claim) => claim.id);
  const verdict: SectionEntry["verdict"] =
    confirmed.length > 0
      ? "request-changes"
      : input.review.judged &&
          input.review.judgement.verdict === "approve" &&
          !input.claims.some((claim) => claim.verify === "unconfirmed") &&
          !input.claims.some((claim) => claim.verify === "not-reached")
        ? "approve"
        : null;
  const assess = input.assess.judged
    ? storedAssess(
        input.assess.judgement,
        input,
        undecided === undefined ? confirmedMoveOf(verdict, confirmed) : [],
      )
    : null;
  const impact = input.assess.judged ? input.assess.judgement.impact : [];
  const floorFacts: FloorFacts = {
    ...input.section.floorFacts,
    effects: [
      ...input.section.floorFacts.effects,
      ...impact.map((entry) => entry.effect),
    ],
  };
  const floors = floorsOf(floorFacts, input.options.floors);
  const trail = recordedLane(
    {
      assess,
      lane: { floors },
      ...(undecided === undefined ? {} : { undecided }),
    },
    input.section.added,
  );
  const entry: SectionEntry = {
    key: input.section.key,
    facts: input.section.facts,
    assess,
    review: input.review.judged
      ? { verdict: input.review.judgement.verdict }
      : null,
    lane: {
      judged: trail.judged,
      surfaced: trail.surfaced,
      floors: trail.floors,
      applied: trail.applied,
    },
    ...(undecided === undefined ? {} : { undecided }),
    impact,
    verdict,
    restsOn: confirmed,
    ...(input.carried === undefined
      ? { lineage: "fresh" as const }
      : { lineage: "carried" as const, from: { ...input.carried } }),
    floorInputs: { facts: floorFacts, options: { ...input.options.floors } },
  };
  return { settled: true, entry, verdict, restsOn: confirmed };
};

// ---------------------------------------------------------------------------------------------
// Every outcome, as data
// ---------------------------------------------------------------------------------------------

/**
 * Every outcome a section can have, as data, so a test walks each row. `assess` and `review` are
 * the readings' outcomes (`judged`, a Lane review verdict, or a not-judged cause); `cap` whether the
 * follow-on cap is reached. `lane` is `rule` where the lane rule sets it, `human-required` where a
 * confirmed request for changes moves both axes (14.34) or the
 * section is undecided, null where it is not settled. `disposition` is `by-lane` where the verdict
 * goes through `applyLane` on that lane, `none` where there is no verdict or the section is undecided
 * (its unit then has no verdict, round 32).
 */
export interface Outcome {
  readonly state: string;
  readonly assess: "judged" | NotJudgedCause;
  readonly review: LaneReviewJudgement["verdict"] | NotJudgedCause;
  readonly claims: ReadonlyArray<Pick<Claim, "source" | "verify">>;
  readonly cap: boolean;
  /** The map excluded the file; the readings given are then not read. */
  readonly excluded?: ExcludedReason;
  readonly settled: boolean;
  readonly lane: "rule" | "human-required" | "human-suggested" | null;
  readonly undecided: {
    readonly cause: UndecidedCause;
    readonly reading: UndecidedReading;
  } | null;
  readonly verdict: SectionEntry["verdict"];
  readonly disposition: "by-lane" | "none";
}

const row = (
  state: string,
  readings: Pick<Outcome, "assess" | "review" | "claims"> & {
    cap?: boolean;
    excluded?: ExcludedReason;
  },
  result: Pick<Outcome, "lane" | "undecided" | "verdict">,
): Outcome => ({
  state,
  assess: readings.assess,
  review: readings.review,
  claims: readings.claims,
  cap: readings.cap ?? false,
  ...(readings.excluded === undefined ? {} : { excluded: readings.excluded }),
  settled: result.lane !== null,
  ...result,
  // An undecided section's unit has no verdict, even where a confirmed defect gives the section a
  // request (round 32, `composeUnits`): it would also stand for what no agent judged.
  disposition:
    result.verdict === null || result.undecided !== null ? "none" : "by-lane",
});

const unconfirmed = { source: "finder", verify: "unconfirmed" } as const;
const finderConfirmed = { source: "finder", verify: "confirmed" } as const;
const reviewConfirmed = { source: "lane-review", verify: "confirmed" } as const;
const reviewRefuted = { source: "lane-review", verify: "refuted" } as const;

export const OUTCOMES: ReadonlyArray<Outcome> = [
  row(
    "assessed; Lane review approves; no claim",
    { assess: "judged", review: "approve", claims: [] },
    { lane: "rule", undecided: null, verdict: "approve" },
  ),
  row(
    "assessed; Lane review approves; a finder's claim refuted",
    {
      assess: "judged",
      review: "approve",
      claims: [{ source: "finder", verify: "refuted" }],
    },
    { lane: "rule", undecided: null, verdict: "approve" },
  ),
  row(
    "assessed; Lane review requests changes on a confirmed defect",
    { assess: "judged", review: "request-changes", claims: [reviewConfirmed] },
    { lane: "human-required", undecided: null, verdict: "request-changes" },
  ),
  row(
    "assessed; Lane review approves; a finder's defect confirmed",
    { assess: "judged", review: "approve", claims: [finderConfirmed] },
    { lane: "human-required", undecided: null, verdict: "request-changes" },
  ),
  row(
    "assessed; a request for changes whose every claim was refuted",
    { assess: "judged", review: "request-changes", claims: [reviewRefuted] },
    {
      lane: "human-required",
      undecided: { cause: "disagreed", reading: "verify" },
      verdict: null,
    },
  ),
  row(
    "assessed; a request for changes with no claim",
    { assess: "judged", review: "request-changes", claims: [] },
    {
      lane: "human-required",
      undecided: { cause: "disagreed", reading: "verify" },
      verdict: null,
    },
  ),
  row(
    "assessed; Lane review approves; a claim neither confirmed nor refuted",
    { assess: "judged", review: "approve", claims: [unconfirmed] },
    {
      lane: "human-required",
      undecided: { cause: "unconfirmed", reading: "verify" },
      verdict: null,
    },
  ),
  row(
    "assessed; a confirmed defect beside a claim neither confirmed nor refuted",
    {
      assess: "judged",
      review: "request-changes",
      claims: [reviewConfirmed, unconfirmed],
    },
    {
      lane: "human-required",
      undecided: { cause: "unconfirmed", reading: "verify" },
      verdict: "request-changes",
    },
  ),
  row(
    "assessed; Lane review unsure",
    { assess: "judged", review: "unsure", claims: [] },
    {
      lane: "human-required",
      undecided: { cause: "unsure", reading: "lane-review" },
      verdict: null,
    },
  ),
  row(
    "assessed; Lane review unsure; a finder's defect confirmed",
    { assess: "judged", review: "unsure", claims: [finderConfirmed] },
    {
      lane: "human-required",
      undecided: { cause: "unsure", reading: "lane-review" },
      verdict: "request-changes",
    },
  ),
  ...(["failed", "too-large"] as const).map((cause) =>
    row(
      `assessed; Lane review not judged (${cause})`,
      { assess: "judged", review: cause, claims: [] },
      {
        lane: "human-required",
        undecided: { cause, reading: "lane-review" },
        verdict: null,
      },
    ),
  ),
  row(
    "assessed; Lane review not reached at the follow-on cap",
    { assess: "judged", review: "not-reached", claims: [], cap: true },
    {
      lane: "human-required",
      undecided: { cause: "not-reached", reading: "lane-review" },
      verdict: null,
    },
  ),
  row(
    "assessed; Lane review not judged; a finder's defect confirmed",
    { assess: "judged", review: "failed", claims: [finderConfirmed] },
    {
      lane: "human-required",
      undecided: { cause: "failed", reading: "lane-review" },
      verdict: "request-changes",
    },
  ),
  ...(["failed", "too-large"] as const).map((cause) =>
    row(
      `Assess not judged (${cause}); Lane review approves`,
      { assess: cause, review: "approve", claims: [] },
      {
        lane: "human-required",
        undecided: { cause, reading: "assess" },
        verdict: "approve",
      },
    ),
  ),
  row(
    "Assess not reached at the follow-on cap; Lane review approves",
    { assess: "not-reached", review: "approve", claims: [], cap: true },
    {
      lane: "human-required",
      undecided: { cause: "not-reached", reading: "assess" },
      verdict: "approve",
    },
  ),
  row(
    "Assess not judged; Lane review requests changes on a confirmed defect",
    { assess: "failed", review: "request-changes", claims: [reviewConfirmed] },
    {
      lane: "human-required",
      undecided: { cause: "failed", reading: "assess" },
      verdict: "request-changes",
    },
  ),
  row(
    "neither reading judged it",
    { assess: "failed", review: "failed", claims: [] },
    {
      lane: "human-required",
      undecided: { cause: "failed", reading: "assess" },
      verdict: null,
    },
  ),
  row(
    "Assess refused",
    { assess: "refused", review: "approve", claims: [] },
    { lane: null, undecided: null, verdict: null },
  ),
  row(
    "Lane review refused",
    { assess: "judged", review: "refused", claims: [] },
    { lane: null, undecided: null, verdict: null },
  ),
  row(
    "Assess not reached before the follow-on cap",
    { assess: "not-reached", review: "approve", claims: [] },
    { lane: null, undecided: null, verdict: null },
  ),
  row(
    "Lane review not reached before the follow-on cap",
    { assess: "judged", review: "not-reached", claims: [] },
    { lane: null, undecided: null, verdict: null },
  ),
  row(
    "assessed; Lane review approves; a claim's check not reached before the follow-on cap",
    {
      assess: "judged",
      review: "approve",
      claims: [{ source: "lane-review", verify: "not-reached" }],
    },
    { lane: null, undecided: null, verdict: null },
  ),
  row(
    "assessed; a request for changes whose claim's check was not reached at the follow-on cap",
    {
      assess: "judged",
      review: "request-changes",
      claims: [{ source: "lane-review", verify: "not-reached" }],
      cap: true,
    },
    {
      lane: "human-required",
      undecided: { cause: "not-reached", reading: "verify" },
      verdict: null,
    },
  ),
  ...(
    [
      "lockfile",
      "declared-generated",
      "linguist-generated",
      "linguist-vendored",
    ] as const
  ).map((excluded) =>
    row(
      `excluded by the map (${excluded}): no reading, today's lane for such a file`,
      { assess: "unreadable", review: "unreadable", claims: [], excluded },
      { lane: "human-suggested", undecided: null, verdict: null },
    ),
  ),
  row(
    "nothing to read (unreadable)",
    { assess: "unreadable", review: "unreadable", claims: [] },
    {
      lane: "human-required",
      undecided: { cause: "unreadable", reading: "assess" },
      verdict: null,
    },
  ),
];
