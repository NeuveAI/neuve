import { sha256Hex } from "@neuve/records-core";
import {
  AssembledReference,
  Citation,
  OwnedRange,
  PHRASE_LINK,
  lineCiteOf,
  type Lane,
} from "@neuve/records-schema";
import { z } from "zod";
import { overlaps, requirementsProof } from "../disposition.ts";
import type { StoredFinding } from "../find.ts";
import { addedLines, LANE_RULE_VERSION, movesOf } from "../lane-rule.ts";
import type { ManifestHunk } from "../manifest.ts";
import type { NamedProof } from "../proof-state.ts";
import { unitKeyOf } from "../publish-sections-input.ts";
import {
  WORDED,
  type AssessJudgement,
  type Effect as ImpactEffect,
  type LaneReviewJudgement,
} from "./answers.ts";
import {
  COMMENT_ID,
  claimKey,
  commentKey,
  finderClaim,
  findingCommentId,
} from "./claims.ts";
import {
  decideSection,
  type UndecidedCause,
  type CarriedFrom,
  type Claim,
  type DecideOutput,
  type ExcludedReason,
  type ReadingOutcome,
  type SectionEntry,
} from "./decide.ts";
import {
  REMOVED_TEXT,
  removalSentence,
  removesDeclaration,
} from "./code-facts.ts";
import type {
  EvidenceRow,
  GroupEvidence,
  RelationsGapCause,
} from "./evidence.ts";
import {
  isGitlink,
  type PlanSection,
  type ReadingPlan,
  type UnreadCause,
} from "./plan.ts";
import {
  batchBriefingOf,
  briefedFrom,
  briefingGaps,
  digestFrom,
  digestGap,
  handleOf,
  obligationsOf,
  verificationOf,
  boundedText,
  citeSide,
  narrowedCite,
  unitLeadOf,
  unitTitleOf,
  wholeSentences,
  type HunkRange,
  type BatchBriefing,
  type BriefingState,
  type SettledBriefings,
  type SettledObligation,
} from "./briefing-settle.ts";
import { oneLine } from "./reading.ts";
import {
  batchSettled,
  composeUnits,
  rankComments,
  unitRequirements,
  unitVerdict,
  type RankedComment,
  type SectionUnit,
  type UnitComment,
} from "./units.ts";

/**
 * What the readings hand the new publisher (`publishSettled`): one `SettledBatch` per settled Map
 * group, in the Map's order, built by code from the plan, the decisions, the readings' judgements
 * and the finders' kept findings. Pure. Nothing here publishes or calls a model; comment bodies are
 * the one place model text is carried, and they go only into this value (and the stored decision
 * that holds it), never into a run-log row.
 *
 * The checks the publisher makes before it writes a batch are made here first: a batch that fails
 * one is not handed over (it is returned as unsettled with the problems, in code's words), since a
 * failure is a defect of this lane, never something to publish.
 */

// ---------------------------------------------------------------------------------------------
// The publisher's input, as the records lane's contract writes it
// ---------------------------------------------------------------------------------------------

// The home of these types is the records lane's `packages/harness/src/publish-sections.ts` (with
// `SectionContent` and `AssessedSection` from `@neuve/records-schema`'s packet module). Neither is
// on this branch yet: these declarations follow the contract and go away when that module is here.

/** A section's own Facts, Briefed and Explained (`SectionContent` in the records' packet module). */
export interface SectionContent {
  readonly facts: {
    readonly text: string;
    readonly cites: ReadonlyArray<string>;
  };
  readonly briefed: string | null;
  readonly explained: unknown;
}

/** The judgement entry the lane rule read (`AssessedSection`): the readers' stored entry. */
export type AssessedSection = SectionEntry;

/** Why a comment is withheld from its batch, alone: it breaks one of its own rules. */
export type WithheldReason =
  /** Its anchor is not inside its unit's owned lines, after clipping to its section's. */
  | "anchor-outside"
  /** An impact with no effect, or with no summary that holds a letter or digit. */
  | "no-summary"
  /** Its ID is not printable ASCII with no space, at most 128 characters. */
  | "id-form";

export interface SettledBatch {
  /** The Map group's label. */
  readonly title: string;
  readonly focus: string;
  /** Every file of the group; the batch's key is the hash of these, sorted. */
  readonly paths: ReadonlyArray<string>;
  /** Every planned section of the batch, each settled. */
  readonly sections: ReadonlyArray<SettledSection>;
  /** A file's sections sharing an applied lane; every section in exactly one unit. */
  readonly units: ReadonlyArray<SettledUnit>;
  /** The briefing's (`source` `agent`), else code's; code writes `verification` and `obligations`. */
  readonly digest: {
    readonly text: string;
    readonly verification?: string;
    readonly uncertainty?: ReadonlyArray<string>;
    readonly limitations?: ReadonlyArray<string>;
    readonly source?: "agent" | "code";
    readonly obligations?: ReadonlyArray<SettledObligation>;
  };
  /** Same-batch references by code (round 27b, `sameBatchReferences`). */
  readonly references?: ReadonlyArray<SettledReference>;
  /** About this batch; `unit` indexes `units`. */
  readonly gaps?: ReadonlyArray<{
    readonly key: string;
    readonly kind: string;
    readonly detail: string;
    readonly unit?: number;
  }>;
  /**
   * Agreed with the records lane after the contract: the comments left out of the batch, each with
   * why; disclosed by a `comments-withheld` gap with their count.
   */
  readonly withheld?: ReadonlyArray<{
    readonly id: string;
    readonly reason: WithheldReason;
  }>;
}

export interface SettledSection {
  /** `sectionIdentities`' value, whole. */
  readonly identity: {
    readonly key: string;
    readonly parts: {
      readonly path: string;
      readonly kind: string;
      readonly name: string | null;
      readonly side?: "new" | "old" | "none";
    } & Readonly<Record<string, unknown>>;
    readonly where: {
      readonly startLine: number;
      readonly endLine: number;
    } | null;
    readonly renamedFrom: string | null;
  };
  /** The sections lane's label, one line. */
  readonly title: string;
  /** At least one, each with its path and side; whole-nontext for a binary or mode-only change. */
  readonly ownedRanges: ReadonlyArray<OwnedRange>;
  /** The judgement entry exactly as the lane rule read it; `entry.key === identity.key`. */
  readonly entry: AssessedSection;
  /** Its own Facts, and its Briefed and Explained (the briefing's, else code's; `briefedFrom`). */
  readonly content?: SectionContent;
  /**
   * Each owned range's hunk ID, parallel to `ownedRanges` (round 27b, `rangeHunksFor`), so a hunk
   * resolves to its own lines; absent where one could not be given whole (records' check
   * `range-hunks`), and the section keeps today's resolve rule.
   */
  readonly rangeHunks?: ReadonlyArray<string>;
}

export interface SettledUnit {
  readonly path: string;
  readonly lane: Lane;
  /** Agreed with the records lane after the contract: the lane rule's version (`LANE_RULE_VERSION`). */
  readonly laneRule: number;
  /** Any order; the publisher orders them. */
  readonly sectionKeys: ReadonlyArray<string>;
  readonly verdict: "approve" | "request-changes" | null;
  /** What `applyLane` gave; undefined records none. */
  readonly disposition: "approve" | "request-changes" | undefined;
  /** The disposition's note. */
  readonly message?: string;
  /** Proof record IDs an approval rests on; empty for any other disposition. */
  readonly proof: ReadonlyArray<string>;
  /** Every comment on the unit, from readings and finders alike, in rank order. */
  readonly comments: ReadonlyArray<SettledComment>;
  /** The Guided stop, by code, on every unit (`guidedOf`). */
  readonly guided: SettledGuided;
  readonly title?: string;
  /**
   * The unit's lead (round 27b, `unitLeadOf`): 1 to `LEAD_POINTS` code points, never cut inside a
   * link (records' check `unit-briefed`); absent where it has none.
   */
  readonly briefed?: string;
}

/** A Guided row's status: the worst the unit's sections were judged, per file. */
export type RowStatus = "met" | "not-met" | "no-evidence";

/** One Guided row (records' `GuidedContentRow`): a Frame done-when row and this unit's status for it. */
export interface SettledGuidedRow {
  readonly row: string;
  readonly text: string;
  readonly basis: "done-when" | "scope" | "gathered";
  readonly sectionId: string | null;
  /** The Lane review judges a row once per file, so the status is the file's. */
  readonly scope: "this file";
  readonly required: true;
  readonly status: RowStatus;
  /**
   * Code's sentence for the status, saying in words that it was judged for the whole file; on a row
   * whose proof is missing, that none is recorded (`DOES.missing`).
   */
  readonly does: string;
  /** Hunk IDs a line cite falls in, and proof record IDs as cited; at most 8. */
  readonly evidence: ReadonlyArray<string>;
  /**
   * Present on a no-evidence row, answered or not, whose file the Lane review was listed no proof
   * record for (`LaneReviewJudgement.fileProofs` is 0): the row cannot be shown met, whatever the
   * code reads as.
   */
  readonly proofState?: "missing";
  /**
   * What the Lane review read the changed code as doing about the row, never a status: every
   * section's reading, whatever its status, in section order and once each; plain, at most 300
   * characters, with no local ID inline; its cites those readings' own, in `evidence`'s form, at
   * most 8.
   */
  readonly reading?: {
    readonly text: string;
    readonly cites: ReadonlyArray<string>;
  };
  /** No stored field ties a requirement to a row: they are the unit's `implied`. */
  readonly requirements: ReadonlyArray<never>;
}

/** A validation requirement of the unit with no row as its basis. */
export interface SettledRequirement {
  readonly requirement: string;
  readonly kinds: ReadonlyArray<string>;
  readonly proof: ReadonlyArray<string>;
}

/** The agent's review of a unit it decided, as the desk's review card and the suggestion read it. */
export interface SettledReview {
  readonly source: "agent";
  readonly carried?: Omit<CarriedFrom, "run">;
  readonly verdict: "approve" | "request-changes";
  readonly message: string;
  readonly uncited: boolean;
  readonly withheld: false;
  readonly gaps: ReadonlyArray<never>;
}

/** The Guided stop of a unit (records' `GuidedContent`), written by code. */
export interface SettledGuided {
  readonly lane: Lane;
  readonly basis: "done-when" | "scope" | "gathered" | "none";
  /** The unit's Map group links no done-when row. */
  readonly unlinked: boolean;
  readonly stratum: string;
  readonly rows: ReadonlyArray<SettledGuidedRow>;
  readonly outside: ReadonlyArray<never>;
  readonly implied: ReadonlyArray<SettledRequirement>;
  readonly omitted: ReadonlyArray<never>;
  /**
   * On a unit an agent decided (a verdict, and no section undecided), its review. On a unit with
   * decided and undecided sections (round 32), a summary of the decided sections alone: their worst
   * verdict, what they checked and, for a request for changes, what it rests on. Null where no
   * section was decided.
   */
  readonly review: SettledReview | null;
  /**
   * On a human-required unit an agent decided. On a human-required unit with undecided sections,
   * only a request for changes (decision 14.4): a suggested approval would also approve the
   * sections no agent judged.
   */
  readonly suggestion: {
    readonly verdict: "approve" | "request-changes";
    readonly message: string;
  } | null;
  readonly proof: string;
  /** `<section title>: <reason>`, one per undecided section, in file order. */
  readonly notes: ReadonlyArray<string>;
  /**
   * Each decided section's own verdict and message (round 32), in file order, only on a unit of
   * more than one section: "Checked: " and its own checked line, and what a request for changes
   * rests on; plain, with no link, at most `SECTION_MESSAGE` characters, ending at a full sentence.
   */
  readonly sectionReviews?: ReadonlyArray<SettledSectionReview>;
  /** Each undecided section's reason, with no title prefix, in file order (round 32). */
  readonly sectionNotes?: ReadonlyArray<SettledSectionNote>;
}

/** One decided section's verdict and message on its unit's Guided stop. */
export interface SettledSectionReview {
  /** The section's key. */
  readonly section: string;
  readonly verdict: "approve" | "request-changes";
  readonly message: string;
}

/** One undecided section's reason on its unit's Guided stop. */
export interface SettledSectionNote {
  /** The section's key. */
  readonly section: string;
  readonly note: string;
}

export interface SettledComment {
  /** The caller's own ID (a claim key or a finding's ID), for fates and for `restsOn`. */
  readonly id: string;
  /** The section key it is about; null for the whole unit. */
  readonly section: string | null;
  readonly kind: "defect" | "risk" | "question" | "pattern-note" | "impact";
  /** Required on impact. */
  readonly effect?: ImpactEffect;
  /** Required on impact: one line, at most 300 characters. */
  readonly summary?: string;
  readonly about: "code" | "tests" | "proof";
  readonly signal?: "forged" | "test-bloat" | "untested" | "stale-proof";
  readonly body: string;
  readonly anchor?: {
    readonly path: string;
    readonly side: "old" | "new";
    readonly startLine: number;
    readonly endLine: number;
  };
  /** Already in the records' Citation form. */
  readonly evidence: ReadonlyArray<{
    readonly ref: string;
    readonly entry?: string;
  }>;
  /** The desk shows it (the top of the ranking). */
  readonly shown: boolean;
  /** The unit's request for changes rests on it. */
  readonly restedOn: boolean;
}

/** A gap about the run, not one batch (the publisher's `gaps`). */
export interface RunGap {
  readonly key: string;
  readonly kind: string;
  readonly detail: string;
}

// ---------------------------------------------------------------------------------------------
// The value read back from the stored decision
// ---------------------------------------------------------------------------------------------

const Anchor = z.strictObject({
  path: z.string().min(1),
  side: z.enum(["old", "new"]),
  startLine: z.int().min(1),
  endLine: z.int().min(1),
});

const LANES = z.enum([
  "static-automation",
  "agentic",
  "human-suggested",
  "human-required",
]);

const SettledCommentSchema = z.strictObject({
  id: z.string().regex(COMMENT_ID),
  section: z.string().nullable(),
  kind: z.enum(["defect", "risk", "question", "pattern-note", "impact"]),
  effect: z
    .enum(["removed", "disabled", "narrowed", "changed", "added"])
    .optional(),
  summary: z.string().max(300).optional(),
  about: z.enum(["code", "tests", "proof"]),
  signal: z
    .enum(["forged", "test-bloat", "untested", "stale-proof"])
    .optional(),
  body: z.string().min(1),
  anchor: Anchor.optional(),
  evidence: z.array(Citation),
  shown: z.boolean(),
  restedOn: z.boolean(),
});

const Requirement = z.strictObject({
  requirement: z.string(),
  kinds: z.array(z.string()),
  proof: z.array(z.string()),
});

const Verdict = z.enum(["approve", "request-changes"]);

/** The most characters (UTF-16 code units, so code points too) a section's Guided message has. */
export const SECTION_MESSAGE = 300;

/** A Guided row as the stored decision holds it (`SettledGuidedRow`). */
const SettledGuidedRowSchema = z.strictObject({
  row: z.string(),
  text: z.string(),
  basis: z.enum(["done-when", "scope", "gathered"]),
  sectionId: z.string().nullable(),
  scope: z.literal("this file"),
  required: z.literal(true),
  status: z.enum(["met", "not-met", "no-evidence"]),
  does: z.string(),
  evidence: z.array(z.string()).max(8),
  /** Absent on a decision stored before rows had a proof state. */
  proofState: z.literal("missing").optional(),
  /** Absent on a decision stored before rows had a reading, and on a row with none. */
  reading: z
    .strictObject({
      text: z.string().max(300),
      cites: z.array(z.string()).max(8),
    })
    .optional(),
  requirements: z.array(z.never()),
});

/** The Guided stop as the stored decision holds it (`SettledGuided`). */
const SettledGuidedSchema = z.strictObject({
  lane: LANES,
  basis: z.enum(["done-when", "scope", "gathered", "none"]),
  unlinked: z.boolean(),
  stratum: z.string(),
  rows: z.array(SettledGuidedRowSchema),
  outside: z.array(z.never()),
  implied: z.array(Requirement),
  omitted: z.array(z.never()),
  review: z
    .strictObject({
      source: z.literal("agent"),
      carried: z
        .strictObject({
          review: z.string(),
          cycle: z.string(),
          head: z.string(),
          judgement: z.string(),
          output: z.string(),
          savedMs: z.number().min(0),
        })
        .optional(),
      verdict: Verdict,
      message: z.string().min(1),
      uncited: z.boolean(),
      withheld: z.literal(false),
      gaps: z.array(z.never()),
    })
    .nullable(),
  suggestion: z
    .strictObject({ verdict: Verdict, message: z.string().min(1) })
    .nullable(),
  proof: z.string(),
  notes: z.array(z.string()),
  /** Absent on a decision stored before round 32, and on a unit of one section or none decided. */
  sectionReviews: z
    .array(
      z.strictObject({
        section: z.string(),
        verdict: Verdict,
        message: z.string().min(1).max(SECTION_MESSAGE),
      }),
    )
    .optional(),
  /** Absent on a decision stored before round 32, and on a unit with no undecided section. */
  sectionNotes: z
    .array(z.strictObject({ section: z.string(), note: z.string().min(1) }))
    .optional(),
});

/**
 * Every field the settler writes on a Guided row and stop has a place in its stored form. The stored
 * form is strict, so a field it lacks fails every read of a stored decision, and assignability alone
 * never says so: an optional field missing from the schema type-checks.
 */
type Unstored<T, S> = Exclude<keyof T, keyof S>;
type StoredGuided = z.infer<typeof SettledGuidedSchema>;
const guidedStored: [
  Unstored<SettledGuidedRow, z.infer<typeof SettledGuidedRowSchema>>,
  Unstored<SettledGuided, StoredGuided>,
  Unstored<
    SettledSectionReview,
    NonNullable<StoredGuided["sectionReviews"]>[number]
  >,
  Unstored<
    SettledSectionNote,
    NonNullable<StoredGuided["sectionNotes"]>[number]
  >,
] extends [never, never, never, never]
  ? true
  : false = true;
void guidedStored;

/** A `SettledBatch` as the stored decision holds it; the entry is the stored entry, read as stored. */
export const SettledBatchSchema = z.strictObject({
  title: z.string(),
  focus: z.string(),
  paths: z.array(z.string()),
  sections: z.array(
    z.strictObject({
      identity: z.strictObject({
        key: z.string(),
        parts: z.looseObject({
          path: z.string(),
          kind: z.string(),
          name: z.string().nullable(),
          side: z.enum(["new", "old", "none"]).optional(),
        }),
        where: z
          .strictObject({ startLine: z.int(), endLine: z.int() })
          .nullable(),
        renamedFrom: z.string().nullable(),
      }),
      title: z.string(),
      ownedRanges: z.array(OwnedRange).min(1),
      rangeHunks: z.array(z.string()).optional(),
      entry: z.looseObject({ key: z.string() }),
      content: z
        .strictObject({
          facts: z.strictObject({
            text: z.string(),
            cites: z.array(z.string()),
          }),
          briefed: z.string().nullable(),
          explained: z.unknown(),
        })
        .optional(),
    }),
  ),
  units: z.array(
    z.strictObject({
      path: z.string(),
      lane: LANES,
      laneRule: z.int().min(1),
      sectionKeys: z.array(z.string()),
      verdict: z.enum(["approve", "request-changes"]).nullable(),
      // JSON has no undefined: a unit with no disposition is stored without the field.
      disposition: z.enum(["approve", "request-changes"]).optional(),
      message: z.string().optional(),
      proof: z.array(z.string()),
      comments: z.array(SettledCommentSchema),
      guided: SettledGuidedSchema,
      title: z.string().optional(),
      briefed: z.string().optional(),
    }),
  ),
  digest: z.strictObject({
    text: z.string(),
    verification: z.string().optional(),
    uncertainty: z.array(z.string()).optional(),
    limitations: z.array(z.string()).optional(),
    source: z.enum(["agent", "code"]).optional(),
    obligations: z
      .array(
        z.strictObject({
          row: z.string(),
          text: z.string(),
          basis: z.string().optional(),
          overall: z.string(),
          units: z.array(
            z.strictObject({
              unit: z.int().min(0),
              status: z.string(),
              required: z.boolean(),
            }),
          ),
        }),
      )
      .optional(),
  }),
  gaps: z
    .array(
      z.strictObject({
        key: z.string(),
        kind: z.string(),
        detail: z.string(),
        unit: z.int().min(0).optional(),
      }),
    )
    .optional(),
  withheld: z
    .array(
      z.strictObject({
        id: z.string(),
        reason: z.enum(["anchor-outside", "no-summary", "id-form"]),
      }),
    )
    .optional(),
  references: z.array(AssembledReference.extend({ id: z.string() })).optional(),
});

/**
 * Every field the settler writes on a batch, a section, a unit and a digest has a place in the
 * stored decision's form (the seams review of the combined branch). The stored form is strict, so a
 * field it lacks fails every read of a stored decision, and assignability alone never says so: an
 * optional field missing from the schema type-checks. It shares `Unstored` with the Guided guard
 * above.
 */
type StoredBatch = z.infer<typeof SettledBatchSchema>;
const batchStored: [
  Unstored<SettledBatch, StoredBatch>,
  Unstored<SettledSection, StoredBatch["sections"][number]>,
  Unstored<SettledUnit, StoredBatch["units"][number]>,
  Unstored<SettledBatch["digest"], StoredBatch["digest"]>,
] extends [never, never, never, never]
  ? true
  : false = true;
void batchStored;

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

/** A planned section, read or not; an unread one carries why. */
export type PlannedSection = PlanSection & { readonly cause?: UnreadCause };

/** One read section's outcomes from both readings, the Lane review's claims on it, and the steps they came from. */
export interface CollectedSection {
  readonly assess: ReadingOutcome<AssessJudgement>;
  readonly review: ReadingOutcome<LaneReviewJudgement>;
  /** The Lane review's defect claims on it, with their Verify outcomes. */
  readonly claims: ReadonlyArray<Claim>;
  /** The stored step whose judgement it holds, per reading: what a line cite of it names. */
  readonly steps: {
    readonly assess: string | null;
    readonly review: string | null;
  };
}

/** A finder's finding that Verify kept, with the stored find output that holds it. */
export interface KeptFinding {
  readonly finding: StoredFinding;
  readonly findKey: string | null;
}

/**
 * The generated batch: lockfiles and declared-generated files, as today's code-only batch holds
 * them (`link.ts` `fillGroups`, `EXCLUDED_GROUP`). Its words are code's, the same as today's.
 */
export const GENERATED_GROUP = {
  id: "generated",
  label: "Lockfiles and generated files",
  why: "Lockfiles and declared-generated files accompany the change.",
} as const;

/** A Map group, as the batch needs it. */
export interface MapGroup {
  readonly id: string;
  readonly label: string;
  readonly why: string;
  readonly files: ReadonlyArray<{ readonly path: string }>;
  readonly hunkIds: ReadonlyArray<string>;
  /** The Frame's done-when rows the group links (`ReviewMap` groups' `doneWhen`). */
  readonly doneWhen: ReadonlyArray<string>;
}

/** What the Guided stop reads of the Frame. */
export interface GuidedFrame {
  readonly stratum: string;
  readonly doneWhen: ReadonlyArray<{
    readonly id: string;
    readonly text: string;
    readonly basis: "done-when" | "scope" | "gathered";
    readonly sectionId: string | null;
  }>;
}

type AnchorValue = z.infer<typeof Anchor>;

// ---------------------------------------------------------------------------------------------
// Owned ranges and anchors
// ---------------------------------------------------------------------------------------------

/**
 * A section's owned ranges in the records' form: each changed line range with its file's path on
 * its side (the old path on the old side of a rename, as today's units give it), or one
 * `whole-nontext` range for a section with no text (a binary file, a mode-only change), on the new
 * side unless the file is deleted, as today's units stage gives a non-text hunk.
 */
export const ownedRangesOf = (
  section: Pick<PlanSection, "path" | "kind" | "owned" | "hunkIds">,
  hunks: ReadonlyMap<string, ManifestHunk>,
): Array<OwnedRange> => {
  if (section.kind === "nontext") {
    const hunk = hunks.get(section.hunkIds[0] ?? "");
    return [
      {
        kind: "whole-nontext",
        path: section.path,
        side: hunk?.status === "deleted" ? "old" : "new",
      },
    ];
  }
  return section.owned.map((range) => {
    const hunk = hunks.get(range.hunkId);
    return {
      kind: "lines",
      path:
        range.side === "old"
          ? (hunk?.oldPath ?? section.path)
          : (hunk?.newPath ?? section.path),
      side: range.side,
      startLine: range.startLine,
      endLine: range.endLine,
    };
  });
};

/**
 * Each of a section's owned ranges' hunk ID, parallel to `ownedRangesOf` (the same length and order):
 * a text section's rows by their hunk, a non-text section's one range by its first hunk. Records'
 * `SettledSection.rangeHunks`, so a hunk resolves to its own lines.
 */
export const rangeHunksOf = (
  section: Pick<PlanSection, "kind" | "owned" | "hunkIds">,
): Array<string> =>
  section.kind === "nontext"
    ? [section.hunkIds[0] ?? ""]
    : section.owned.map((range) => range.hunkId);

/** A hunk ID as the harness writes it (`hunks.ts` `hunkIdOf`): `h` and 15 hex. */
const HUNK_ID = /^h[0-9a-f]{15}$/;

/**
 * A section's `rangeHunks` as records takes them: `rangeHunksOf`, when every entry is a hunk ID and
 * no one ID names ranges in two files (the old and new path of a rename); else undefined, so the
 * section keeps today's resolve rule and never refuses its batch.
 */
export const rangeHunksFor = (
  section: Pick<PlanSection, "kind" | "owned" | "hunkIds">,
  ranges: ReadonlyArray<OwnedRange>,
): Array<string> | undefined => {
  const ids = rangeHunksOf(section);
  if (ids.length !== ranges.length || !ids.every((id) => HUNK_ID.test(id)))
    return undefined;
  const paths = new Map<string, string>();
  for (const [at, id] of ids.entries()) {
    const path = ranges[at]!.path;
    if ((paths.get(id) ?? path) !== path) return undefined;
    paths.set(id, path);
  }
  return ids;
};

// ---------------------------------------------------------------------------------------------
// Same-batch references, by code (round 27b, `design/readers-briefing-rubric.md` 3.5)
// ---------------------------------------------------------------------------------------------

/** A context reference as the publisher takes it (`SettledReference`): an assembled one with a short ID. */
export type SettledReference = AssembledReference & { readonly id: string };

/** A section a same-batch reference may name: a placed section that owns changed lines. */
export interface ReferenceSection {
  readonly key: string;
  readonly title: string;
  readonly hunkIds: ReadonlyArray<string>;
  readonly ranges: ReadonlyArray<OwnedRange>;
  /** Parallel to `ranges` (`rangeHunksOf`). */
  readonly rangeHunks: ReadonlyArray<string>;
}

const HEAD = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * A batch's same-batch references (3.5): for each section A with a confirmed caller row whose call
 * site (path and line) lies in an owned head-side range of another section B of the review, in
 * another unit, one pair per A and B, the first such row by path and line. A pair writes a reference
 * anchored on A's owned lines when A is in this batch, and one anchored on B's call-site line when
 * B is; each is attributed to the pair's units this batch holds, since the publisher attributes a
 * reference to its own batch's units only, so the value never depends on another batch's state.
 * Only a row whose line is the use itself counts (`EvidenceRow.shows` `call`, or `reference`, a
 * line that hands the name over without calling it, said as "refers to"): a `caller` row's line is
 * the calling function's declaration, never where it calls. Unconfirmed rows, rows with no line and rows within one unit write none.
 * A source names the revision its lines are at: the head for head-side lines, the merge base (the
 * diff's old side) for the lines of a section that owns only removed lines, and none is written
 * when that base is not given, so base lines are never labelled as the head. IDs `sb<n>` in anchor
 * order. None without a head commit.
 */
export const sameBatchReferences = (input: {
  /** The head commit, 40 or 64 hex. */
  readonly head: string;
  /** The merge base, the old side of the range's diff, 40 or 64 hex; for removed lines only. */
  readonly base?: string | undefined;
  readonly hunks: ReadonlyMap<string, ManifestHunk>;
  /** Every placed section of the review that owns changed lines. */
  readonly sections: ReadonlyArray<ReferenceSection>;
  /** Each section's stored caller and test rows, by identity key (`GroupEvidence`). */
  readonly rows: ReadonlyMap<string, ReadonlyArray<EvidenceRow>>;
  /** This batch's units: each by its key (`unitKeyOf`) with its sections. */
  readonly units: ReadonlyArray<{
    readonly key: string;
    readonly sectionKeys: ReadonlyArray<string>;
  }>;
}): Array<SettledReference> => {
  if (!HEAD.test(input.head)) return [];
  const unitOf = new Map(
    input.units.flatMap((unit) =>
      unit.sectionKeys.map((key) => [key, unit.key] as const),
    ),
  );
  const byKey = new Map(input.sections.map((s) => [s.key, s]));
  const blobOf = (hunk: string | undefined, side: "old" | "new") => {
    const held = hunk === undefined ? undefined : input.hunks.get(hunk);
    return (side === "new" ? held?.newOid : held?.oldOid) ?? "";
  };
  const pairs = new Map<
    string,
    {
      readonly a: ReferenceSection;
      readonly b: ReferenceSection;
      readonly symbol: string;
      readonly calls: boolean;
      readonly path: string;
      readonly line: number;
      readonly at: number;
    }
  >();
  for (const [key, rows] of [...input.rows].sort(([x], [y]) =>
    x < y ? -1 : x > y ? 1 : 0,
  )) {
    const a = byKey.get(key);
    if (a === undefined) continue;
    const callers = rows
      .filter(
        (row) =>
          row.kind === "caller" &&
          row.confirmed &&
          (row.shows === "call" || row.shows === "reference") &&
          row.line !== null,
      )
      .sort(
        (x, y) =>
          (x.path < y.path ? -1 : x.path > y.path ? 1 : 0) || x.line! - y.line!,
      );
    for (const row of callers) {
      const line = row.line!;
      for (const b of input.sections) {
        if (b.key === a.key) continue;
        const at = b.ranges.findIndex(
          (range) =>
            range.kind === "lines" &&
            range.side === "new" &&
            range.path === row.path &&
            range.startLine <= line &&
            line <= range.endLine,
        );
        if (at === -1) continue;
        const pair = `${a.key}\0${b.key}`;
        if (!pairs.has(pair))
          pairs.set(pair, {
            a,
            b,
            symbol: row.symbol,
            calls: row.shows === "call",
            path: row.path,
            line,
            at,
          });
      }
    }
  }
  const out: Array<Omit<SettledReference, "id">> = [];
  for (const { a, b, symbol, calls, path, line, at } of pairs.values()) {
    const verb = calls ? "calls" : "refers to";
    const unitA = unitOf.get(a.key);
    const unitB = unitOf.get(b.key);
    if (unitA === undefined && unitB === undefined) continue;
    if (unitA !== undefined && unitA === unitB) continue;
    const unitIds = [
      ...(unitA === undefined ? [] : [unitA]),
      ...(unitB === undefined ? [] : [unitB]),
    ];
    const ownAt = Math.max(
      a.ranges.findIndex((r) => r.kind === "lines" && r.side === "new"),
      a.ranges.findIndex((r) => r.kind === "lines"),
    );
    const own = a.ranges[ownAt];
    const callRange = b.ranges[at]!;
    const shared = {
      entries: [],
      unitIds,
      markerKind: "same-batch" as const,
      origin: "same-batch" as const,
      grade: "useful" as const,
      stance: "background" as const,
      retrieval: {
        retriever: "graph",
        querySha256: null,
        rank: null,
        score: null,
      },
      tokens: 0,
    };
    const source = (
      where: { path: string; startLine: number; endLine: number },
      side: "old" | "new",
      blob: string,
      sameBatch: ReadonlyArray<string>,
    ) => ({
      origin: "same-batch" as const,
      repository: "",
      revision: side === "new" ? input.head : input.base!,
      rev: side === "new" ? "head" : "merge-base",
      blob,
      path: where.path,
      startLine: where.startLine,
      endLine: where.endLine,
      kind: "undeclared" as const,
      sameBatch: [...sameBatch],
    });
    const aTitle = oneLine(a.title);
    const bTitle = oneLine(b.title);
    // On A's owned lines: B, changed in this range, calls the symbol A changes.
    if (unitA !== undefined && own !== undefined && own.kind === "lines")
      out.push({
        ...shared,
        locator: `${path}:${line}`,
        source: source(
          { path, startLine: line, endLine: line },
          "new",
          blobOf(b.rangeHunks[at], "new"),
          b.hunkIds,
        ),
        anchors: [
          {
            hunk: a.rangeHunks[ownAt] ?? a.hunkIds[0] ?? "",
            path: own.path,
            side: own.side,
            startLine: own.startLine,
            endLine: own.endLine,
          },
        ],
        why: `${bTitle}, changed in this range, ${verb} ${oneLine(symbol)}, which this change also changes.`,
        beforeYouDecide: `Read both changes together: ${bTitle} is decided separately and is not yet approved.`,
      });
    // On B's call-site line: this line calls the symbol A, changed in this range, changes. Its
    // source is A's lines, at the merge base when A owns only removed lines: written only when
    // that base is given.
    const ownLines =
      own !== undefined && own.kind === "lines" ? own : undefined;
    const based =
      ownLines === undefined ||
      ownLines.side === "new" ||
      (input.base !== undefined && HEAD.test(input.base));
    if (unitB !== undefined && callRange.kind === "lines" && based)
      out.push({
        ...shared,
        locator:
          ownLines !== undefined
            ? `${ownLines.path}:${ownLines.startLine}`
            : `${path}:${line}`,
        source:
          ownLines !== undefined
            ? source(
                ownLines,
                ownLines.side,
                blobOf(a.rangeHunks[ownAt], ownLines.side),
                a.hunkIds,
              )
            : source(
                { path, startLine: line, endLine: line },
                "new",
                blobOf(b.rangeHunks[at], "new"),
                a.hunkIds,
              ),
        anchors: [
          {
            hunk: b.rangeHunks[at] ?? b.hunkIds[0] ?? "",
            path: callRange.path,
            side: "new",
            startLine: line,
            endLine: line,
          },
        ],
        why: `This line ${verb} ${oneLine(symbol)}, which ${aTitle}, changed in this range, also changes.`,
        beforeYouDecide: `Read both changes together: ${aTitle} is decided separately and is not yet approved.`,
      });
  }
  const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  return out
    .sort(
      (x, y) =>
        cmp(x.anchors[0]!.path, y.anchors[0]!.path) ||
        x.anchors[0]!.startLine - y.anchors[0]!.startLine ||
        cmp(x.locator, y.locator) ||
        cmp(x.why, y.why),
    )
    .map((reference, at) => ({ id: `sb${at + 1}`, ...reference }));
};

/**
 * An anchor clipped to the first of a section's owned line ranges it overlaps on its side, with that
 * range's path; undefined when it overlaps none. The anchor's path may be the section's path or the
 * range's own (an old-side range of a renamed file).
 */
const clipTo = (
  anchor: AnchorValue,
  section: Pick<PlanSection, "path">,
  ranges: ReadonlyArray<OwnedRange>,
): AnchorValue | undefined => {
  for (const range of ranges)
    if (
      range.kind === "lines" &&
      range.side === anchor.side &&
      (anchor.path === range.path || anchor.path === section.path) &&
      overlaps(range, anchor)
    )
      return {
        path: range.path,
        side: range.side,
        startLine: Math.max(range.startLine, anchor.startLine),
        endLine: Math.min(range.endLine, anchor.endLine),
      };
  return undefined;
};

/** Whether an anchor lies wholly inside one of the owned line ranges given. */
const inside = (anchor: AnchorValue, ranges: ReadonlyArray<OwnedRange>) =>
  ranges.some(
    (range) =>
      range.kind === "lines" &&
      range.path === anchor.path &&
      range.side === anchor.side &&
      range.startLine <= anchor.startLine &&
      anchor.endLine <= range.endLine,
  );

// ---------------------------------------------------------------------------------------------
// Finder findings, placed by anchor
// ---------------------------------------------------------------------------------------------

export type UnplacedReason =
  /** The finding has no primary anchor. */
  | "no-anchor"
  /** No planned section owns the lines of its primary anchor. */
  | "no-owner"
  /** The section that owns them is an excluded file, which stays in today's code-only batch. */
  | "excluded";

export interface Placement {
  /** Each placed finding, by the comment ID it takes, on the section that owns its primary anchor. */
  readonly placed: ReadonlyArray<{
    readonly id: string;
    readonly section: string;
    readonly anchor: AnchorValue;
    readonly kept: KeptFinding;
  }>;
  readonly unplaced: ReadonlyArray<{
    readonly id: string;
    /** The Map group the finding named; used only to say where its gap belongs. */
    readonly group: string;
    readonly reason: UnplacedReason;
  }>;
}

/**
 * Each kept finding on the section that owns its primary anchor, by anchor alone (never by the Map
 * group the finding names): the section whose owned lines on that side hold the anchor's first
 * line, else the first in file order whose owned lines it overlaps. A finding no section owns is
 * returned with why, never dropped. The same finding given twice is placed once.
 */
export const placeFindings = (
  sections: ReadonlyArray<PlannedSection>,
  hunks: ReadonlyMap<string, ManifestHunk>,
  findings: ReadonlyArray<KeptFinding>,
): Placement => {
  const placed: Array<Placement["placed"][number]> = [];
  const unplaced: Array<Placement["unplaced"][number]> = [];
  const ordered = [...sections].sort(
    (a, b) =>
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.first - b.first,
  );
  const ranges = new Map(
    ordered.map((section) => [section.key, ownedRangesOf(section, hunks)]),
  );
  const seen = new Set<string>();
  for (const kept of findings) {
    const id = findingCommentId(kept.finding.id);
    if (seen.has(id)) continue;
    seen.add(id);
    const primary = kept.finding.anchors[0];
    if (primary === undefined) {
      unplaced.push({ id, group: kept.finding.group, reason: "no-anchor" });
      continue;
    }
    const start = { ...primary, endLine: primary.startLine };
    const owner =
      ordered.find(
        (section) =>
          clipTo(start, section, ranges.get(section.key)!) !== undefined,
      ) ??
      ordered.find(
        (section) =>
          clipTo(primary, section, ranges.get(section.key)!) !== undefined,
      );
    if (owner === undefined)
      unplaced.push({ id, group: kept.finding.group, reason: "no-owner" });
    else if (owner.cause === "excluded")
      unplaced.push({ id, group: kept.finding.group, reason: "excluded" });
    else
      placed.push({
        id,
        section: owner.key,
        anchor: clipTo(primary, owner, ranges.get(owner.key)!)!,
        kept,
      });
  }
  return { placed, unplaced };
};

// ---------------------------------------------------------------------------------------------
// Deciding every planned section, finder claims included
// ---------------------------------------------------------------------------------------------

export interface DecidedSection {
  readonly section: PlannedSection;
  /** Its reading group; null for an unread section. */
  readonly group: string | null;
  /** Its Map group (batch); null when no Map group holds its first hunk. */
  readonly mapGroup: string | null;
  readonly cause: UnreadCause | null;
  /**
   * Null only for a section that could not be decided: one the plan excluded that the map's
   * excluded list does not name (no reason is guessed for it). It is in no batch and counts as pending.
   */
  readonly decision: DecideOutput | null;
  /** Every claim on it: the Lane review's, then the finders' kept defects. */
  readonly claims: ReadonlyArray<Claim>;
}

/**
 * The lines a section adds, as the lane rule's public-surface raise reads them: its owned new-side
 * ranges, at its first hunk's new path, through `addedLines` over its own hunks. One function, so a
 * replay of the lane (`readings/replay-hold.ts`) reads the same lines the decision read.
 */
export const sectionAdded = (
  section: Pick<PlannedSection, "hunkIds" | "path" | "owned">,
  hunks: ReadonlyMap<string, ManifestHunk>,
) => {
  const own = section.hunkIds.flatMap((id) => {
    const hunk = hunks.get(id);
    return hunk === undefined ? [] : [hunk];
  });
  const newPath = own[0]?.newPath ?? section.path;
  return addedLines(
    section.owned
      .filter((range) => range.side === "new")
      .map((range) => ({ kind: "lines", path: newPath, ...range })),
    own,
  );
};

/**
 * Every planned section decided by `decideSection`, read or not: a too-large or unreadable section
 * is decided as not judged by that cause; an excluded one (a lockfile or declared-generated file) is
 * decided as excluded, with the reason the map gives, and belongs to the generated batch
 * (`GENERATED_GROUP`) whatever Map group holds its hunks. A kept finder defect is
 * a confirmed claim on the section that owns its anchor, added before the section is decided, so
 * it reaches the verdict as a Lane review's confirmed claim does; every kept finding placed there
 * that moves an axis is a move on the matrix the lane rule reads (`movesOf`, 14.28). The request for
 * changes those confirmed claims make also moves both axes, to high complexity and hard validation,
 * which `decideSection` places from the verdict (`confirmedMoveOf`, 14.34).
 */
export const decideSections = (input: {
  readonly plan: ReadingPlan;
  readonly hunks: ReadonlyMap<string, ManifestHunk>;
  readonly groups: ReadonlyArray<Pick<MapGroup, "id" | "hunkIds">>;
  readonly collected: ReadonlyMap<string, CollectedSection>;
  readonly proofs: ReadonlyMap<string, ReadonlyMap<string, NamedProof>>;
  readonly findings: ReadonlyArray<KeptFinding>;
  /** The paths the map excluded, with why (`ReviewMap.excluded`). */
  readonly excluded: ReadonlyArray<{
    readonly path: string;
    readonly reason: ExcludedReason;
  }>;
  /**
   * The read sections, by identity key, whose relation evidence both readings were shown whole
   * (`readings/evidence.ts`, `shown`). Every other section keeps code's relations gap.
   */
  readonly relations?: ReadonlySet<string> | undefined;
  /**
   * Why a read section keeps code's relations gap, by identity key, where the words differ from
   * today's (`relationsGapCause`): the head's callers were still being computed when it was read,
   * and so on. A section it does not name reads "not available", as before.
   */
  readonly relationsGaps?: ReadonlyMap<string, RelationsGapCause> | undefined;
  /**
   * No follow-on run is left (the cap is reached): a section no reading reached settles as
   * human-required, cause `not-reached`, instead of waiting. Absent or false everywhere but the
   * review's ending call on its last allowed run.
   */
  readonly capReached?: boolean | undefined;
  /**
   * The read sections, by identity key, whose judgement rests on a reading an earlier review stored
   * and this one reused, with where it came from: their entries are recorded as carried.
   */
  readonly carried?: ReadonlyMap<string, CarriedFrom> | undefined;
}): {
  readonly sections: ReadonlyArray<DecidedSection>;
  readonly placement: Placement;
} => {
  const { plan, hunks } = input;
  const planned: Array<PlannedSection> = [...plan.sections, ...plan.unread];
  const placement = placeFindings(planned, hunks, input.findings);
  // The moves each section's kept findings give on the matrix (14.28), by the finding's comment ID:
  // a finding about code raises complexity, one about tests or proof makes validation hard, and a
  // pattern note moves nothing. The kind and `about` are the finding's own, as Find stored them.
  const movesBy = new Map<string, ReturnType<typeof movesOf>>();
  for (const { id, section, kept } of placement.placed)
    movesBy.set(section, [
      ...(movesBy.get(section) ?? []),
      ...movesOf([{ id, kind: kept.finding.kind, about: kept.finding.about }]),
    ]);
  const finderClaims = new Map<string, Array<Claim>>();
  for (const { section, kept } of placement.placed)
    if (kept.finding.kind === "defect")
      finderClaims.set(section, [
        ...(finderClaims.get(section) ?? []),
        finderClaim(kept.finding.id),
      ]);
  const groupOf = new Map(
    plan.groups.flatMap((group) => group.keys.map((key) => [key, group.id])),
  );
  const mapGroupOf = new Map(
    input.groups.flatMap((group) =>
      group.hunkIds.map((id) => [id, group.id] as const),
    ),
  );
  const reasons = new Map(input.excluded.map((e) => [e.path, e.reason]));
  const decide = (
    section: PlannedSection,
    outcomes: Pick<CollectedSection, "assess" | "review" | "claims">,
    excluded?: ExcludedReason,
    carried?: CarriedFrom,
  ): DecideOutput => {
    return decideSection({
      ...(excluded === undefined ? {} : { excluded: { reason: excluded } }),
      section: {
        key: section.key,
        path: section.path,
        declared: section.declared,
        boundaries: section.boundaries,
        // Only a read section whose evidence both readings were shown whole; never an unread one.
        relations:
          excluded === undefined &&
          section.cause === undefined &&
          input.relations?.has(section.key) === true,
        ...(input.relationsGaps?.has(section.key) === true
          ? { relationsGap: input.relationsGaps.get(section.key) }
          : {}),
        added: sectionAdded(section, hunks),
        // The removal floor is off in this build, so its facts decide nothing.
        floorFacts: {
          removesDeclaration: false,
          removesPublicName: false,
          effects: [],
        },
        moves: movesBy.get(section.key) ?? [],
        facts: {
          kind: section.kind,
          declared: section.declared,
          boundaries: section.boundaries,
          characters: section.characters,
        },
      },
      assess: outcomes.assess,
      review: outcomes.review.judged
        ? {
            judged: true,
            judgement: { verdict: outcomes.review.judgement.verdict },
          }
        : outcomes.review,
      claims: outcomes.claims,
      ...(carried === undefined ? {} : { carried }),
      proof: {
        records: input.proofs.get(section.path) ?? new Map(),
        sources: [],
      },
      options: {
        floors: { removal: false },
        capReached: input.capReached === true,
      },
    });
  };
  const sections: Array<DecidedSection> = [];
  for (const section of plan.sections) {
    const held = input.collected.get(section.key);
    const claims = [
      ...(held?.claims ?? []),
      ...(finderClaims.get(section.key) ?? []).filter(
        (claim) => !(held?.claims ?? []).some((c) => c.id === claim.id),
      ),
    ];
    const outcomes = {
      assess: held?.assess ?? {
        judged: false as const,
        cause: "failed" as const,
      },
      review: held?.review ?? {
        judged: false as const,
        cause: "failed" as const,
      },
      claims,
    };
    sections.push({
      section,
      group: groupOf.get(section.key) ?? null,
      mapGroup: mapGroupOf.get(section.hunkIds[0] ?? "") ?? null,
      cause: null,
      decision: decide(
        section,
        outcomes,
        undefined,
        input.carried?.get(section.key),
      ),
      claims,
    });
  }
  for (const section of plan.unread) {
    const excluded = section.cause === "excluded";
    const claims = excluded ? [] : (finderClaims.get(section.key) ?? []);
    // The map's reason. In `collect` the plan's excluded list and the map's are made by the same
    // code from the same manifest (`buildMapManifest`), so a file the plan excluded that the map
    // does not name comes only from a mismatched pair (such as a map stored by another build of
    // that rule): no reason is guessed for it. It is left undecided, out of every batch, and still
    // counted; `settledBatches` discloses it as a run gap.
    const reason = reasons.get(section.path);
    if (excluded && reason === undefined) {
      sections.push({
        section,
        group: null,
        mapGroup: null,
        cause: section.cause,
        decision: null,
        claims,
      });
      continue;
    }
    // An excluded file is read by nothing; `decideSection` reads no outcome of it.
    const cause: "too-large" | "unreadable" =
      section.cause === "too-large" ? "too-large" : "unreadable";
    sections.push({
      section,
      group: null,
      mapGroup: excluded
        ? GENERATED_GROUP.id
        : (mapGroupOf.get(section.hunkIds[0] ?? "") ?? null),
      cause: section.cause,
      decision: decide(
        section,
        {
          assess: { judged: false, cause },
          review: { judged: false, cause },
          claims,
        },
        excluded ? reason : undefined,
      ),
      claims,
    });
  }
  return { sections, placement };
};

// ---------------------------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------------------------

const LINES_CITE = /^.+:(?:old|new):\d+-\d+$/;
const FACT_CITE = /^[0-9a-f]{64}\./;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** A citation of `ref`, with `entry` only where the records' bounds take it; the ref alone otherwise. */
export const citation = (
  ref: string,
  entry?: string,
): { readonly ref: string; readonly entry?: string } => {
  const whole = entry === undefined ? { ref } : { ref, entry };
  return Citation.safeParse(whole).success ? whole : { ref };
};

/** Citations, each once, in the order given; one whose ref the records refuse is left out. */
const distinct = (
  cites: ReadonlyArray<{ readonly ref: string; readonly entry?: string }>,
) => {
  const out = new Map<
    string,
    { readonly ref: string; readonly entry?: string }
  >();
  for (const cite of cites)
    if (Citation.safeParse(cite).success)
      out.set(JSON.stringify([cite.ref, cite.entry ?? null]), cite);
  return [...out.values()];
};

/**
 * A reading's stored cite in the records' Citation form. A line cite (`<path>:<side>:<start>-<end>`)
 * names the step whose reading showed it, with the cite as the entry where the records' bounds take
 * it; a change fact (`<identity key>.<fact>`) names the plan, which holds the section's facts, with
 * the fact ID as the entry; a proof record names its event; anything else names the step.
 */
export const readingCitation = (
  cite: string,
  context: {
    readonly step: string | null;
    readonly planKey: string;
    readonly proofs: ReadonlySet<string>;
  },
) => {
  if (context.proofs.has(cite) && ULID.test(cite))
    return [{ ref: `event:${cite}` }];
  if (FACT_CITE.test(cite) && !LINES_CITE.test(cite))
    return [citation(`computation:${context.planKey}`, cite)];
  return context.step === null
    ? []
    : [citation(`computation:${context.step}`, cite)];
};

/**
 * A finder's evidence ID in Citation form: a hunk names the range manifest with the hunk ID, a proof
 * record its event, and anything else (a scope section) the finder's stored output with the ID.
 */
const finderCitation = (
  id: string,
  context: {
    readonly manifestKey: string;
    readonly hunks: ReadonlyMap<string, ManifestHunk>;
    readonly findKey: string | null;
  },
) =>
  context.hunks.has(id)
    ? [citation(`computation:${context.manifestKey}`, id)]
    : ULID.test(id)
      ? [{ ref: `event:${id}` }]
      : context.findKey === null
        ? []
        : [citation(`computation:${context.findKey}`, id)];

// ---------------------------------------------------------------------------------------------
// Settled batches
// ---------------------------------------------------------------------------------------------

/** One batch's record, settled or not: what the `reading.batch` row holds, and why it is not handed over. */
export interface BatchRecord {
  readonly mapGroup: string | null;
  /** Every one of its planned sections is settled. */
  readonly settled: boolean;
  /** Handed to the publisher: settled, in a Map group, and every check passed. */
  readonly ready: boolean;
  /** Why it is not handed over: a section still waits, no Map group holds it, or a check failed. */
  readonly reason: "waiting" | "no-map-group" | "checks-failed" | null;
  readonly sections: {
    readonly settled: number;
    readonly waiting: Readonly<Record<string, number>>;
    readonly unread: Readonly<Record<string, number>>;
  };
  readonly units: number;
  /** The checks that failed, in code's words with keys only; empty when none did. */
  readonly problems: ReadonlyArray<string>;
  /**
   * A settled batch's briefing (round 27): `cut` holds it until no follow-on is left
   * (`settleBatch`); absent on a batch that is not settled.
   */
  readonly briefing?: {
    readonly state: BatchBriefing;
    readonly sections: Readonly<Record<BriefingState, number>>;
    readonly digest: "agent" | "code";
  };
}

/** A settled batch as code formed it, for the collector's rows: its units and their ranked comments. */
export interface FormedBatch {
  readonly mapGroup: string;
  readonly units: ReadonlyArray<SectionUnit>;
  /** Each unit's comments in rank order, each with the section it is about. */
  readonly comments: ReadonlyArray<
    ReadonlyArray<RankedComment & { readonly section: string | null }>
  >;
  /** Each unit's Guided stop in counts and labels only, for the `reading.unit` row. */
  readonly guided: ReadonlyArray<{
    readonly basis: SettledGuided["basis"];
    readonly rows: Readonly<Record<RowStatus, number>>;
    readonly review: boolean;
    readonly suggestion: boolean;
    readonly notes: number;
  }>;
}

export interface SettledOutput {
  /** One per ready batch, in the Map's order. */
  readonly batches: ReadonlyArray<SettledBatch>;
  /** Every batch with members, in the Map's order (a batch no Map group holds last). */
  readonly records: ReadonlyArray<BatchRecord>;
  readonly formed: ReadonlyArray<FormedBatch>;
  /**
   * Of the whole review, for the pending counts: only what can be published, the batches with
   * sections that own changed lines and those sections (a batch still waiting counts; a section
   * that owns no line, or that no Map group holds, does not, and is a run gap).
   */
  readonly totals: { readonly batches: number; readonly sections: number };
  /** About the run, not one batch. */
  readonly gaps: ReadonlyArray<RunGap>;
  /** The findings no section owns, with why (also disclosed as gaps). */
  readonly unplaced: Placement["unplaced"];
}

export interface SettledInput {
  readonly planKey: string;
  readonly manifestKey: string;
  readonly hunks: ReadonlyMap<string, ManifestHunk>;
  /** The Map's groups, in the Map's order. */
  readonly groups: ReadonlyArray<MapGroup>;
  /** The Frame's stratum and done-when rows, for each unit's Guided stop. */
  readonly frame: GuidedFrame;
  readonly sections: ReadonlyArray<DecidedSection>;
  /** The read sections' outcomes, for comment text and the steps they cite. */
  readonly collected: ReadonlyMap<string, CollectedSection>;
  readonly placement: Placement;
  /** The proof record IDs the readings listed. */
  readonly proofs: ReadonlySet<string>;
  /** Gaps about the run the caller found (findings it could not read), given first. */
  readonly runGaps?: ReadonlyArray<RunGap> | undefined;
  /**
   * The readings' plan was dropped, so no reading was made and the run's gap says why
   * (`droppedPlanGap`): no batch also names a reading that failed. Absent everywhere else.
   */
  readonly dropped?: boolean | undefined;
  /**
   * What the briefings stored (round 27): each read section's Briefed and Explained and each
   * batch's digest. Absent where the review made no briefing: code's Briefed and digest, as before.
   */
  readonly briefings?: SettledBriefings | undefined;
  /** The head commit, for the same-batch references' sources (round 27b). */
  readonly head?: string | undefined;
  /** The merge base (the diff's old side), for a source on removed lines (round 27b). */
  readonly base?: string | undefined;
  /** Each reading group's stored relation evidence: its confirmed caller rows link sections. */
  readonly evidence?: ReadonlyArray<GroupEvidence> | undefined;
}

/**
 * A batch's gaps for the readings that left its sections to a person: one per reading group and
 * cause, for each section settled undecided because its group's reading `failed` or was
 * `not-reached` (at the follow-on cap), in the words `readingsDisclosure` uses for those causes.
 * Each names the group by its files in this batch, so a person knows which sections no reading
 * judged. Judgements a reading made (unsure, unconfirmed, disagreed) and unread sections are no drop.
 */
const droppedReadingGaps = (members: ReadonlyArray<DecidedSection>) => {
  const words = { failed: "failed", "not-reached": "was not reached" };
  const held = new Map<
    string,
    {
      readonly cause: keyof typeof words;
      readonly paths: Array<string>;
      count: number;
    }
  >();
  for (const member of members) {
    const decision = member.decision;
    if (member.group === null || decision === null || !decision.settled)
      continue;
    const cause = decision.entry.undecided?.cause;
    if (cause !== "failed" && cause !== "not-reached") continue;
    const at = `${member.group}\0${cause}`;
    const entry = held.get(at) ?? { cause, paths: [], count: 0 };
    if (!entry.paths.includes(member.section.path))
      entry.paths.push(member.section.path);
    entry.count++;
    held.set(at, entry);
  }
  return [...held.entries()].map(([at, { cause, paths, count }]) => {
    const named =
      paths.length <= 3
        ? paths.join(", ")
        : `${paths.slice(0, 3).join(", ")} and ${plural(paths.length - 3, "more file")}`;
    return {
      key: `section-readings:${sha256Hex(at).slice(0, 16)}`,
      kind: "section-readings",
      detail: `Section readings: a reading of ${named} ${words[cause]}, so a person decides ${count === 1 ? "its section" : `its ${count} sections`} in this batch.`,
    };
  });
};

/** A defect claim as a unit's comment shows it: one whose check was not reached reads as unchecked. */
const shownVerify = (
  verify: Claim["verify"] | undefined,
): "confirmed" | "refuted" | "unconfirmed" =>
  verify === "confirmed" || verify === "refuted" ? verify : "unconfirmed";

const SUMMARY = 300;

/**
 * An impact's text as a summary: one line, at most 300 UTF-16 code units, cut between code points
 * so a surrogate pair is never split.
 */
export const summaryOf = (text: string) => {
  let out = "";
  for (const point of oneLine(text).replace(/\s+/g, " ").trim()) {
    if (out.length + point.length > SUMMARY) break;
    out += point;
  }
  return out;
};

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

const count = (values: ReadonlyArray<string>) => {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
};

const lineCount = (ranges: ReadonlyArray<OwnedRange>, side: "old" | "new") =>
  ranges.reduce(
    (sum, range) =>
      range.kind === "lines" && range.side === side
        ? sum + range.endLine - range.startLine + 1
        : sum,
    0,
  );

/** A section's code facts line, as today's code-filled units say what a change is. */
const factsLine = (title: string, ranges: ReadonlyArray<OwnedRange>) => {
  const added = lineCount(ranges, "new");
  const removed = lineCount(ranges, "old");
  const what =
    added > 0 && removed > 0
      ? `${plural(added, "line")} added and ${removed} removed`
      : added > 0
        ? `${plural(added, "line")} added`
        : removed > 0
          ? `${plural(removed, "line")} removed`
          : "a change with no text lines";
  return `${title}: ${what}.`;
};

/**
 * A section's facts as a person reads them: the plain sentence today's code-filled units give
 * (`compose.ts` `codeFacts`: lines added and removed), or, for a declaration the change removes,
 * the removal sentence (`removalSentence`), which says the same lines as a removal. Code's words
 * only, from the section's own owned rows; never the plan's change facts, which are written for the
 * readings.
 */
export const readerFacts = (
  section: Pick<PlanSection, "title" | "kind" | "identity" | "owned">,
  ranges: ReadonlyArray<OwnedRange>,
) =>
  removesDeclaration(section)
    ? removalSentence(oneLine(section.title), lineCount(ranges, "old"))
    : factsLine(section.title, ranges);

// ---------------------------------------------------------------------------------------------
// The Guided stop, by code
// ---------------------------------------------------------------------------------------------

const LEVELS = ["done-when", "scope", "gathered"] as const;

/** Worst first: a row is shown as the worst status any of the unit's sections was given. */
const WORST: ReadonlyArray<RowStatus> = ["not-met", "no-evidence", "met"];

/** At most this many evidence IDs on one row. */
const ROW_EVIDENCE = 8;

/** Code's sentence for each status, which says in words that the status is the whole file's. */
const DOES = {
  met: "The Lane review found this condition met, judged for the whole file.",
  "not-met":
    "The Lane review found this condition not met, judged for the whole file.",
  "no-evidence":
    "The Lane review found no evidence either way, judged for the whole file.",
  unanswered: "No reading of this file established this condition's outcome.",
  missing:
    "No test run or other proof is recorded for this condition, so it can't be shown met.",
  unansweredMissing:
    "No reading of this file established this condition's outcome, and no test run or other proof is recorded for it.",
} as const;

/**
 * The done-when rows a unit may show: only those its own Map group (its batch) links, in the
 * Frame's order. A file whose hunks fall in two groups was given both groups' rows to judge
 * (`rowsOf` in `pi/stages/reading-task.ts`), but each unit shows its own group's alone (round 28):
 * the other group's rows are about other hunks.
 */
const groupRows = (
  group: Pick<MapGroup, "doneWhen">,
  frame: GuidedFrame,
): ReadonlyArray<GuidedFrame["doneWhen"][number]> =>
  frame.doneWhen.filter((row) => group.doneWhen.includes(row.id));

const LINES_STABLE = /^(.+):(old|new):(\d+)-(\d+)$/;

/**
 * A Guided row's words with no section or decision code: a parenthesis made only of section IDs,
 * decisions (`decision 0016`) or records (`record 12`, `ADR-7`), joined by commas, semicolons or
 * "and", is taken out with the space before it. A section ID counts in its dotted form (`S13.1`), or
 * bare (`S2`) only beside a decision or record code in the same parenthesis, so "(S3)" for a storage
 * service or "(S1, S2 and S3)" for sizes stays. The Frame's done-when rows carry them ("(S3.4,
 * decision 0016)"); the owner never sees them. Any other parenthesis stays. A square-bracketed group
 * of the same codes ("[S13.1]", "[S3.4, decision 0016]") is taken out by the same rules, unless a
 * "(" follows it: that is a `[phrase](id)` link, never a code. Any other square bracket stays.
 */
const RECORD_CODE = String.raw`(?:[Dd]ecisions?|[Rr]ecords?|ADR)[\s-]*\d+(?:\.\d+)*`;
const CODE_TOKEN = String.raw`(?:S\d+(?:\.\d+)*|${RECORD_CODE})`;
const CODE_LIST = String.raw`\s*${CODE_TOKEN}(?:\s*(?:,|;|\band\b)\s*${CODE_TOKEN})*\s*`;
const CODES = new RegExp(
  String.raw`\s*(?:\(${CODE_LIST}\)|\[${CODE_LIST}\](?!\())`,
  "g",
);
const BARE_SECTION = /\bS\d+\b(?!\.\d)/;
export const withoutCodes = (text: string) => {
  const out = text.replace(CODES, (whole: string, at: number) =>
    BARE_SECTION.test(whole) && !new RegExp(RECORD_CODE).test(whole)
      ? whole
      : // A code between two words ("a [S1.1]b") leaves the space before it, so they stay apart.
        /^\s/.test(whole) && /[\p{L}\p{N}]/u.test(text[at + whole.length] ?? "")
        ? " "
        : "",
  );
  return out === text
    ? text
    : out
        .replace(/\s+([.,;:!?])/g, "$1")
        .replace(/\s{2,}/g, " ")
        .trim();
};

/** A stored Explained with each side ending at a full sentence (`wholeSentences`). */
const wholeExplained = <
  E extends { readonly before: string; readonly after: string },
>(
  explained: E | null,
): E | null =>
  explained === null
    ? null
    : {
        ...explained,
        before: wholeSentences(explained.before),
        after: wholeSentences(explained.after),
      };

/**
 * Each hunk's owned rows across the review, by hunk ID: every planned section's rows, read or not, as
 * the settler hands them to Records (`rangeHunks`). A hunk is in one file, so these are its batch's
 * holders, and its side for a line cite is theirs (`citeSide`), as Records reads it.
 */
export const heldRowsOf = (
  sections: ReadonlyArray<{
    readonly section: Pick<PlanSection, "key" | "owned">;
  }>,
): ReadonlyMap<string, ReadonlyArray<HunkRange>> => {
  const out = new Map<string, Array<HunkRange>>();
  for (const { section } of sections)
    for (const row of section.owned)
      out.set(row.hunkId, [
        ...(out.get(row.hunkId) ?? []),
        {
          hunk: row.hunkId,
          key: section.key,
          side: row.side,
          startLine: row.startLine,
          endLine: row.endLine,
        },
      ]);
  return out;
};

/**
 * A row's evidence, or a reading's cites, as IDs a person can open, at most `ROW_EVIDENCE`: a listed
 * proof record as it is; a Lane review line cite (`path:side:a-b`) as each hunk its lines fall in,
 * written with those lines in records' grammar (`h…@a-b`, `h…@a`, `lineCiteOf`), clipped into one
 * of the unit's own rows of the hunk (`owner`) on the hunk's side over every holder (`narrowedCite`),
 * so the row opens the lines it names and never another unit's. With no such range: the bare hunk ID
 * only when the unit holds every row of the hunk, since Records opens every holder's lines for it;
 * else nothing, as for a hunk the unit holds no row of. Anything else is left out.
 */
export const rowEvidence = (
  cites: ReadonlyArray<string>,
  hunks: ReadonlyMap<string, ManifestHunk>,
  proofs: ReadonlySet<string>,
  held: ReadonlyMap<string, ReadonlyArray<HunkRange>> = new Map(),
  /** The unit's sections, by identity key: a cite narrows into their rows only. */
  owner?: ReadonlyArray<string>,
) => {
  const out = new Set<string>();
  for (const cite of cites) {
    if (proofs.has(cite)) {
      out.add(cite);
      continue;
    }
    const match = LINES_STABLE.exec(cite);
    if (match === null) continue;
    const [path, side, start, end] = [
      match[1]!,
      match[2] as "old" | "new",
      Number(match[3]),
      Number(match[4]),
    ];
    for (const hunk of hunks.values()) {
      const at =
        side === "new"
          ? {
              path: hunk.newPath ?? hunk.path,
              startLine: hunk.newStart,
              lines: hunk.newLines,
            }
          : {
              path: hunk.oldPath ?? hunk.path,
              startLine: hunk.oldStart,
              lines: hunk.oldLines,
            };
      if (
        at.path === path &&
        at.lines > 0 &&
        at.startLine <= end &&
        start <= at.startLine + at.lines - 1
      ) {
        // The side over every holder of the hunk, as Records reads it; the lines only the unit's own.
        const rows = held.get(hunk.hunkId) ?? [];
        const hunkSide = citeSide(rows);
        const own =
          owner === undefined
            ? rows
            : rows.filter((row) => owner.includes(row.key ?? ""));
        // A hunk the unit owns no row of is another unit's: nothing.
        if (rows.length > 0 && own.length === 0) continue;
        const narrowed =
          own.length > 0 && side === hunkSide
            ? narrowedCite(
                hunk.hunkId,
                own.filter((row) => row.side === hunkSide),
                start,
                end,
                hunkSide,
              )
            : undefined;
        // Only what records' parser reads as a line cite of this hunk.
        const lines =
          narrowed === undefined ? undefined : lineCiteOf(narrowed)?.lines;
        if (
          narrowed !== undefined &&
          lines !== undefined &&
          !("malformed" in lines)
        )
          out.add(narrowed);
        // No line range: the bare hunk only when every row of it is the unit's, since Records opens
        // every holder's lines for it; a row never points into another unit.
        else if (own.length === rows.length) out.add(hunk.hunkId);
      }
    }
  }
  return [...out].slice(0, ROW_EVIDENCE);
};

/** The reading's own cite tokens and the stored IDs a person never reads. */
const LOCAL_TOKEN =
  /^(?:\d+[no]\d+(?:-\d+)?|[fps]\d+|[^\s:]+:(?:old|new):\d+-\d+|[0-9a-f]{64}(?:\.[\w-]+)?|[0-9A-HJKMNP-TV-Z]{26})$/;
const BARE_TOKEN =
  /(?<![\w/.-])(?:\d+[no]\d+(?:-\d+)?|[fps]\d+|[^\s:()[\],;]+:(?:old|new):\d+-\d+|[0-9a-f]{64}(?:\.[\w-]+)?|[0-9A-HJKMNP-TV-Z]{26})(?![\w/-])/g;

/**
 * Model text as a person reads it: one line, with no cite token or local ID, alone or in brackets
 * (`(2n14-20, f3)`, `[p1]`), and the space before punctuation they leave closed.
 */
export const plainText = (text: string) =>
  oneLine(text)
    .replace(/\s*[([]([^()[\]]*)[)\]]/g, (whole, inner: string) => {
      const parts = inner
        .replace(/^\s*(?:cites?|see)\s*:?\s*/i, "")
        .split(/[,;\s]+/)
        .filter((part) => part.length > 0);
      return parts.length > 0 && parts.every((part) => LOCAL_TOKEN.test(part))
        ? ""
        : whole;
    })
    .replace(BARE_TOKEN, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/([,;:])(?=[.!?]|$)/g, "")
    .trim();

/** A sentence that ends as one: a full stop added where it has no closing mark. */
const sentence = (text: string) =>
  /[.!?\u2026]$/.test(text) ? text : `${text}.`;

/** The reading's unsure reason for a section, plain and on one line; undefined when it gave none. */
export const unsureReason = (reasons: ReadonlyArray<string>) => {
  const reason = summaryOf(plainText(reasons.join(" ")));
  return reason.length === 0 ? undefined : reason;
};

/** The unsure note of a unit no agent decided: the section's title and the reading's reason. */
export const unsureNote = (title: string, reasons: ReadonlyArray<string>) => {
  const reason = unsureReason(reasons);
  return reason === undefined ? undefined : `${title}: ${reason}`;
};

/**
 * A section's Guided message (round 32): plain, with every `[phrase](id)` link kept as its phrase
 * alone, so it opens no row of another unit (Records indexes no cite in it); at most
 * `SECTION_MESSAGE` UTF-16 code units, cut after its last full sentence that fits (`boundedText`,
 * `wholeSentences`).
 */
export const sectionMessage = (text: string) => {
  const plain = text.replace(PHRASE_LINK, (_whole, phrase: string) => phrase);
  let bound = SECTION_MESSAGE;
  let out = boundedText(plain, bound);
  // `boundedText` counts code points; a surrogate pair is two code units.
  while (out.length > SECTION_MESSAGE && bound > 1)
    out = boundedText(plain, --bound);
  // A checked line the reading's bound cut with "…" ends at its last full sentence instead.
  return wholeSentences(out);
};

/**
 * Code's line for an undecided section the reading gave no reason for, one plain sentence per cause.
 * Each cause keeps its own line. Only a submodule pointer the Lane review was unsure of with no
 * reason gets the pointer's own line, which still says why a person decides it.
 */
const UNDECIDED_NOTES: Readonly<Record<UndecidedCause, string>> = {
  failed: "No reading of this section completed, so a person decides it.",
  "not-reached":
    "No reading of this section was reached before the review's cut-off, so a person decides it.",
  unsure:
    "The Lane review could not check what matters in this section, so a person decides it.",
  unconfirmed:
    "A defect the Lane review raised here could not be confirmed, so a person decides it.",
  disagreed:
    "The Lane review asked for changes here, but no defect it raised was confirmed, so a person decides it.",
  "too-large": "This section is too large to read, so a person decides it.",
  unreadable: "This section has no text to read, so a person decides it.",
};
/** The `unsure` line of a submodule pointer: its Lane review cannot judge a pointer's change. */
const POINTER_NOTE =
  "The Lane review could not judge a submodule pointer, so a person decides it.";
const undecidedNote = (cause: UndecidedCause, pointer: boolean) =>
  pointer && cause === "unsure" ? POINTER_NOTE : UNDECIDED_NOTES[cause];

/**
 * One unit's Guided stop (10.67), by code from what the readings stored. Rows: the Frame's
 * done-when rows the Lane review was given for the unit's file, on the strongest basis present,
 * each at the worst status the unit's sections were given (a section with no answer for the row,
 * or no Lane review judgement, gives no-evidence). Review and suggestion where an agent decided:
 * the unit has a verdict and no section is undecided; the suggestion only on human-required work.
 * A unit with decided and undecided sections (round 32) has no verdict; its review sums up the
 * decided sections (their worst verdict, what they checked, what a request rests on), and its
 * suggestion is only a request for changes. Each undecided section's reason is a note, titled in
 * `notes` and keyed in `sectionNotes`; on a unit of more than one section, each decided section's
 * own verdict and message are in `sectionReviews`.
 */
const guidedOf = (input: {
  readonly unit: SectionUnit;
  readonly generated: boolean;
  readonly rows: ReadonlyArray<GuidedFrame["doneWhen"][number]>;
  readonly stratum: string;
  readonly entries: ReadonlyArray<SectionEntry>;
  readonly titles: ReadonlyMap<string, string>;
  readonly collected: ReadonlyMap<string, CollectedSection>;
  readonly hunks: ReadonlyMap<string, ManifestHunk>;
  readonly proofs: ReadonlySet<string>;
  /** Each hunk's owned rows across the review (`heldRowsOf`): where a line cite narrows to. */
  readonly held?: ReadonlyMap<string, ReadonlyArray<HunkRange>> | undefined;
  /** The disposition's note for a request for changes: how many confirmed defects it rests on. */
  readonly restsOn: string;
  /** Whether a comment the unit shows carries evidence. */
  readonly citedComment: boolean;
  /** The unit's sections that are submodule pointers, whose note says no caller is read for one. */
  readonly pointers?: ReadonlySet<string> | undefined;
}): SettledGuided => {
  const { unit } = input;
  const reviews = unit.sectionKeys.map((key) => {
    const review = input.collected.get(key)?.review;
    return review?.judged === true ? review.judgement : undefined;
  });
  const pool = input.generated ? [] : input.rows;
  const level = LEVELS.find((basis) => pool.some((row) => row.basis === basis));
  const rows = pool
    .filter((row) => row.basis === level)
    .map((row): SettledGuidedRow => {
      const answers = reviews.map((review) =>
        review?.rows.find((answer) => answer.row === row.id),
      );
      const status =
        WORST.find((status) =>
          answers.some(
            (answer) => (answer?.status ?? "no-evidence") === status,
          ),
        ) ?? "no-evidence";
      const given = answers.filter((answer) => answer?.status === status);
      const evidence = rowEvidence(
        given.flatMap((answer) => answer?.cites ?? []),
        input.hunks,
        input.proofs,
        input.held,
        unit.sectionKeys,
      );
      // Missing: a no-evidence row, answered or not, whose file the Lane review was listed no proof
      // record for.
      const missing =
        status === "no-evidence" &&
        reviews.some((review) => review?.fileProofs === 0);
      const unanswered = status === "no-evidence" && given.length === 0;
      // The reading, kept apart from the status: every section's reading of the row, whatever its
      // status, in section order, once each; plain, at most 300 characters (`summaryOf`), and its
      // cites those readings' own, at most 8 (`rowEvidence`).
      const read = answers.flatMap((answer) => {
        const line = plainText(answer?.reading ?? "");
        return line.length === 0
          ? []
          : [{ line: sentence(line), cites: answer?.cites ?? [] }];
      });
      const text = summaryOf(
        plainText([...new Set(read.map(({ line }) => line))].join(" ")),
      );
      const readingCites = rowEvidence(
        read.flatMap(({ cites }) => cites),
        input.hunks,
        input.proofs,
        input.held,
        unit.sectionKeys,
      );
      return {
        row: row.id,
        text: withoutCodes(row.text),
        basis: row.basis,
        sectionId: row.sectionId,
        scope: "this file",
        required: true,
        status,
        does:
          missing && unanswered
            ? DOES.unansweredMissing
            : missing
              ? DOES.missing
              : unanswered
                ? DOES.unanswered
                : withoutCodes(DOES[status]),
        evidence,
        ...(missing ? { proofState: "missing" as const } : {}),
        ...(text.length === 0
          ? {}
          : { reading: { text: withoutCodes(text), cites: readingCites } }),
        requirements: [],
      };
    });
  const implied = new Map<string, SettledRequirement>();
  for (const entry of input.entries)
    for (const r of entry.assess?.easeOfValidation.requirements ?? []) {
      const requirement = {
        requirement: r.requirement,
        kinds: [...r.kinds],
        proof: [...new Set(r.proof)].sort(),
      };
      implied.set(JSON.stringify(requirement), requirement);
    }
  // A section an agent decided: a verdict, and not undecided (an excluded file has neither).
  const decidedAt = input.entries.map(
    (entry) => entry.undecided === undefined && entry.verdict !== null,
  );
  const anyUndecided = input.entries.some(
    (entry) => entry.undecided !== undefined,
  );
  const decided = unit.verdict !== null && !anyUndecided;
  // Decided and undecided sections in one unit (round 32): its review sums up the decided ones.
  const judged = unit.sectionKeys.flatMap((_, at) =>
    decidedAt[at] === true ? [at] : [],
  );
  const mixed = anyUndecided && judged.length > 0;
  const checkedOf = (ats: ReadonlyArray<number>) => [
    ...new Set(
      ats.flatMap((at) => {
        const line = plainText(reviews[at]?.checked ?? "");
        return line.length === 0 ? [] : [sentence(line)];
      }),
    ),
  ];
  // "Checked: " and the Lane review's checked lines, unless the first already begins with "Checked"
  // ("Checked explicit undefined return …"), which would read "Checked: Checked …".
  const checkedText = (checked: ReadonlyArray<string>) => {
    const text = checked.join(" ");
    return /^checked\b/i.test(text) ? text : `Checked: ${text}`;
  };
  const restsOnLine = (entries: ReadonlyArray<SectionEntry>) =>
    `This request for changes rests on ${plural(
      new Set(entries.flatMap((entry) => entry.restsOn)).size,
      "confirmed defect",
    )}.`;
  const proofOf = (entries: ReadonlyArray<SectionEntry>) =>
    requirementsProof(
      unitRequirements(
        entries.flatMap(
          (entry) => entry.assess?.easeOfValidation.requirements ?? [],
        ),
      ),
    ).text;
  const judgedEntries = judged.map((at) => input.entries[at]!);
  const summary: {
    readonly verdict: "approve" | "request-changes";
    readonly message: string;
    readonly entries: ReadonlyArray<SectionEntry>;
  } | null = decided
    ? (() => {
        const checked = checkedOf(unit.sectionKeys.map((_, at) => at));
        const message = [
          ...(checked.length === 0 ? [] : [checkedText(checked)]),
          ...(unit.verdict === "request-changes" ? [input.restsOn] : []),
        ].join(" ");
        return {
          verdict: unit.verdict!,
          // A Lane review that said nothing of what it checked: the approval's proof line, as before.
          message: message.length > 0 ? message : unit.proof.text,
          entries: input.entries,
        };
      })()
    : mixed
      ? (() => {
          // The worst of the decided sections' verdicts; the undecided ones take no part.
          const verdict = unitVerdict(
            judgedEntries.map((entry) => entry.verdict),
          )!;
          const checked = checkedOf(judged);
          const message = [
            ...(checked.length === 0 ? [] : [checkedText(checked)]),
            ...(verdict === "request-changes"
              ? [restsOnLine(judgedEntries)]
              : []),
          ].join(" ");
          return {
            verdict,
            message: message.length > 0 ? message : proofOf(judgedEntries),
            entries: judgedEntries,
          };
        })()
      : null;
  const carried =
    summary !== null &&
    summary.entries.every(
      (entry) => entry.lineage === "carried" && entry.from !== undefined,
    )
      ? summary.entries[0]?.from
      : undefined;
  const review: SettledReview | null =
    summary === null
      ? null
      : {
          source: "agent",
          ...(carried === undefined
            ? {}
            : {
                carried: {
                  review: carried.review,
                  cycle: carried.cycle,
                  head: carried.head,
                  judgement: carried.judgement,
                  output: carried.output,
                  savedMs: carried.savedMs,
                },
              }),
          verdict: summary.verdict,
          message: summary.message,
          uncited:
            !rows.some((row) => row.evidence.length > 0) && !input.citedComment,
          withheld: false,
          gaps: [],
        };
  // On human-required work. With a section no agent judged, only a request for changes (14.4): a
  // suggested approval would also approve the sections no agent judged.
  const suggestion =
    review !== null &&
    unit.lane === "human-required" &&
    (decided || review.verdict === "request-changes")
      ? { verdict: review.verdict, message: review.message }
      : null;
  // Every undecided section says why in one line: the reading's unsure reason where it gave one,
  // else code's sentence for its cause (`UNDECIDED_NOTES`).
  const reasons = unit.sectionKeys.flatMap((key, at) => {
    const cause = input.entries[at]?.undecided?.cause;
    if (cause === undefined) return [];
    const reason =
      (cause === "unsure"
        ? unsureReason(reviews[at]?.unsure ?? [])
        : undefined) ?? undecidedNote(cause, input.pointers?.has(key) === true);
    return [{ key, reason }];
  });
  const notes = reasons.map(
    ({ key, reason }) => `${input.titles.get(key) ?? ""}: ${reason}`,
  );
  const sectionNotes = reasons.map(({ key, reason }) => ({
    section: key,
    note: reason,
  }));
  // Each decided section's own verdict and message, on a unit of more than one section only.
  const sectionReviews =
    unit.sectionKeys.length > 1
      ? judged.map((at) => {
          const entry = input.entries[at]!;
          const verdict = entry.verdict!;
          const checked = checkedOf([at]);
          const text = [
            ...(checked.length === 0 ? [] : [checkedText(checked)]),
            ...(verdict === "request-changes" ? [restsOnLine([entry])] : []),
          ].join(" ");
          return {
            section: unit.sectionKeys[at]!,
            verdict,
            message: sectionMessage(text.length > 0 ? text : proofOf([entry])),
          };
        })
      : [];
  return {
    lane: unit.lane,
    basis: level ?? "none",
    unlinked: !input.generated && pool.length === 0,
    stratum: input.stratum,
    rows,
    outside: [],
    implied: [...implied.values()],
    omitted: [],
    review,
    suggestion,
    proof: unit.proof.text,
    notes,
    ...(sectionReviews.length === 0 ? {} : { sectionReviews }),
    ...(sectionNotes.length === 0 ? {} : { sectionNotes }),
  };
};

// ---------------------------------------------------------------------------------------------
// Briefed, by code
// ---------------------------------------------------------------------------------------------

/** Code's own lean reason (`assessExpand`), written when the reading gave none: never a section's own. */
const CODE_LEAN_REASON =
  "The reading did not say whether a person is needed, so one is suggested.";

/** A lean reason as Briefed reads it, when the reading wrote one. */
const leanReasonOf = (lean: AssessJudgement["lean"] | undefined) => {
  const reason = lean?.reason;
  return reason === undefined || reason === CODE_LEAN_REASON
    ? undefined
    : plainText(reason);
};

/**
 * The lean reasons more than one section holds. Assess writes a lean reason per class of sections,
 * so one shared by several sections is said of them together, never of one: Briefed leaves it out.
 */
export const sharedLeanReasons = (
  leans: ReadonlyArray<AssessJudgement["lean"] | undefined>,
) => {
  const seen = new Map<string, number>();
  for (const lean of leans) {
    const reason = leanReasonOf(lean);
    if (reason !== undefined && reason.length > 0)
      seen.set(reason, (seen.get(reason) ?? 0) + 1);
  }
  return new Set(
    [...seen.entries()].filter(([, n]) => n > 1).map(([reason]) => reason),
  );
};

/**
 * A section's Briefed text, by code from its own stored entry only: its Assess impact entries
 * (never code's removal, which Facts states), then its lean reason when no other section shares
 * it. Null when it has neither: less beats repeated, so nothing said of several sections together
 * (a complexity finding, a shared lean reason) is joined in.
 */
export const briefedOf = (
  entry: SectionEntry,
  shared: ReadonlySet<string>,
): string | null => {
  if (entry.excluded !== undefined) return null;
  const lean = leanReasonOf(entry.assess?.lean);
  const texts = [
    ...entry.impact
      .filter((e) => !(e.effect === "removed" && e.text === REMOVED_TEXT))
      // An Assess text cut at its bound ends at its last full sentence (`wholeSentences`).
      .map((e) => wholeSentences(plainText(e.text))),
    ...(lean === undefined || shared.has(lean) ? [] : [lean]),
  ].filter((text) => text.length > 0);
  const distinctTexts = [...new Set(texts)];
  return distinctTexts.length === 0
    ? null
    : distinctTexts.map(sentence).join(" ").slice(0, 2_000);
};

/**
 * Code's Briefed for a section no reading reads, one plain sentence per unread cause: too large to
 * read, or with no text (a binary file, a mode-only change). Never for an excluded file, whose
 * generated batch keeps no Briefed by rule; never where the section has text of its own.
 */
const UNREAD_BRIEFED = {
  "too-large":
    "This section was too large to read, so no reading describes it.",
  unreadable: "This section has no text to read, so no reading describes it.",
} as const;
export const unreadBriefed = (cause: UnreadCause | null): string | null =>
  cause === "too-large" || cause === "unreadable"
    ? UNREAD_BRIEFED[cause]
    : null;

/**
 * A section's complexity findings as Briefed, for a briefing that failed or was cut only: said of
 * several sections together, so never a section's own text, but better than a blank stop.
 */
export const factorsBriefed = (entry: SectionEntry): string | null => {
  if (entry.excluded !== undefined) return null;
  const texts = [
    ...new Set(
      (entry.assess?.complexity.factors ?? [])
        .map((factor) => plainText(factor.finding))
        .filter((text) => text.length > 0),
    ),
  ];
  return texts.length === 0
    ? null
    : texts.map(sentence).join(" ").slice(0, 2_000);
};

/**
 * The batches' groups, in the review's batch order: the Map's groups without the excluded files,
 * then the generated batch that holds them (when any section is excluded with a reason the map
 * gives). A batch's key is `batchKeyOf` of its group's files.
 */
export const batchGroups = (
  mapGroups: ReadonlyArray<MapGroup>,
  sections: ReadonlyArray<DecidedSection>,
): Array<MapGroup> => {
  const excluded = sections.filter(
    (s) => s.cause === "excluded" && s.decision !== null,
  );
  const excludedPaths = [...new Set(excluded.map((s) => s.section.path))];
  return [
    ...mapGroups.map((group) => ({
      ...group,
      files: group.files.filter((file) => !excludedPaths.includes(file.path)),
    })),
    ...(excluded.length === 0
      ? []
      : [
          {
            ...GENERATED_GROUP,
            files: excludedPaths.map((path) => ({ path })),
            hunkIds: [...new Set(excluded.flatMap((s) => s.section.hunkIds))],
            // No reading judges a lockfile or a generated file against a done-when row.
            doneWhen: [],
          },
        ]),
  ];
};

/**
 * The settled batches of a run, and a record of every batch (see the module comment). Each Map
 * group with sections that own changed lines is a batch, and so is the generated batch of the
 * lockfiles and declared-generated files (today's code-only batch: `link.ts` `fillGroups`), whose
 * files leave every other batch. A batch is handed over only when every section is settled and
 * every check passes. A comment that breaks its own rules is withheld alone and disclosed; only a
 * withheld comment a request for changes rests on fails the batch, since the request would rest on
 * nothing. Sections that own no changed lines, and sections no Map group holds, cannot be published:
 * they are run gaps and are not counted in the totals, so a review can reach nothing pending.
 */
export const settledBatches = (input: SettledInput): SettledOutput => {
  const { hunks } = input;
  const batches: Array<SettledBatch> = [];
  const records: Array<BatchRecord> = [];
  const formed: Array<FormedBatch> = [];
  const runGaps: Array<RunGap> = [...(input.runGaps ?? [])];
  const testPaths = new Set(
    input.sections
      .filter((s) => s.section.declared === "test")
      .map((s) => s.section.path),
  );
  const placedOn = new Map<string, Array<Placement["placed"][number]>>();
  for (const placed of input.placement.placed)
    placedOn.set(placed.section, [
      ...(placedOn.get(placed.section) ?? []),
      placed,
    ]);
  const settledGroups = new Set<string>();
  // From the Assess judgements, which a reading gives for all its sections at once, so whether a
  // reason is shared never depends on which batches have settled.
  const sharedLean = sharedLeanReasons(
    [...input.collected.values()].map((held) =>
      held.assess.judged ? held.assess.judgement.lean : null,
    ),
  );
  const unplacedGap = (id: string, reason: UnplacedReason) => ({
    key: `finding-unplaced:${sha256Hex(id).slice(0, 16)}`,
    kind: "finding-unplaced",
    detail:
      reason === "no-anchor"
        ? "One verified finding names no lines, so it is not shown on any unit."
        : reason === "excluded"
          ? "One verified finding is on a lockfile or a generated file, which no reading reads, so it is not shown on any unit."
          : "One verified finding is on lines no changed section owns, so it is not shown on any unit.",
  });

  // A section the plan excluded with no reason from the map is undecided (`decideSections`): it is
  // in no batch, counts as pending, and is a run gap.
  const unnamed = input.sections.filter(
    (s) => s.cause === "excluded" && s.decision === null,
  );
  const placed = input.sections.filter((s) => !unnamed.includes(s));
  const groups = batchGroups(input.groups, input.sections);
  const order = [
    ...groups.map((group) => group.id),
    ...(placed.some((s) => s.mapGroup === null) ? [null] : []),
  ];
  // The sections a same-batch reference may name, and each section's caller rows (round 27b).
  const referenceSections: Array<ReferenceSection> = placed.flatMap((m) => {
    if (m.mapGroup === null || m.cause === "excluded") return [];
    const ranges = ownedRangesOf(m.section, hunks);
    return ranges.length === 0
      ? []
      : [
          {
            key: m.section.key,
            title: m.section.title,
            hunkIds: m.section.hunkIds,
            ranges,
            rangeHunks: rangeHunksOf(m.section),
          },
        ];
  });
  // Each hunk's rows across the review, for a Guided row's line cites (round 27b).
  const heldRows = heldRowsOf(input.sections);
  const callerRows = new Map<string, ReadonlyArray<EvidenceRow>>();
  for (const evidence of input.evidence ?? [])
    for (const entry of evidence.sections)
      if (!callerRows.has(entry.key)) callerRows.set(entry.key, entry.rows);
  let totalBatches = 0;
  let totalSections = 0;
  let unowned = 0;
  let homeless = 0;
  for (const mapGroup of order) {
    const all = placed.filter((s) => s.mapGroup === mapGroup);
    const group = groups.find((g) => g.id === mapGroup);
    const rangesOf = new Map(
      all.map((m) => [m.section.key, ownedRangesOf(m.section, hunks)]),
    );
    // A section that owns no changed line cannot be published: a run gap, not a member.
    const members = all.filter(
      (m) => (rangesOf.get(m.section.key)?.length ?? 0) > 0,
    );
    const sectionCounts = {
      settled: members.filter((m) => m.decision?.settled === true).length,
      waiting: count(
        members.flatMap((m) =>
          m.decision !== null && !m.decision.settled
            ? [m.decision.waiting.cause]
            : [],
        ),
      ),
      unread: count(all.filter((m) => m.cause !== null).map((m) => m.cause!)),
    };
    const settled = batchSettled(
      members.map((m) => ({
        decision:
          m.decision ??
          ({
            settled: false,
            entry: null,
            verdict: null,
            restsOn: [],
            waiting: { cause: "not-reached", reading: "assess" },
          } satisfies DecideOutput),
      })),
    );
    if (group === undefined) {
      homeless += all.length;
      records.push({
        mapGroup,
        settled,
        ready: false,
        reason: "no-map-group",
        sections: sectionCounts,
        units: 0,
        problems: [],
      });
      continue;
    }
    unowned += all.length - members.length;
    if (members.length === 0) continue;
    totalBatches++;
    totalSections += members.length;
    if (!settled) {
      records.push({
        mapGroup,
        settled,
        ready: false,
        reason: "waiting",
        sections: sectionCounts,
        units: 0,
        problems: [],
      });
      continue;
    }

    const problems: Array<string> = [];
    const gaps: Array<NonNullable<SettledBatch["gaps"]>[number]> = [];
    const withheld: Array<{
      readonly id: string;
      readonly reason: WithheldReason;
    }> = [];
    const sectionsOut: Array<SettledSection> = [];
    for (const member of members) {
      const section = member.section;
      const decision = member.decision as Extract<
        DecideOutput,
        { settled: true }
      >;
      const ranges = rangesOf.get(section.key)!;
      const rangeHunks = rangeHunksFor(section, ranges);
      if (decision.entry.key !== section.identity.key)
        problems.push(
          `Section ${section.key}: its entry's key ${decision.entry.key} is not its identity's key.`,
        );
      sectionsOut.push({
        identity: {
          key: section.identity.key,
          parts: { ...section.identity.parts },
          where: section.identity.where,
          renamedFrom: section.identity.renamedFrom,
        },
        // The part's behaviour title where it wrote one (round 27b); else the sections lane's label.
        title:
          input.briefings?.sections.get(section.key)?.title ?? section.title,
        ownedRanges: ranges,
        // Each range's hunk (round 27b), so a hunk resolves to its own lines.
        ...(rangeHunks === undefined ? {} : { rangeHunks }),
        entry: decision.entry,
        content: {
          // What a person reads first about the section: code's plain sentence of what changed,
          // a removal first. The plan's change facts are the readings' (their wording is the
          // models'), so none is shown here.
          facts: {
            text: readerFacts(section, ranges).slice(0, 2_000),
            cites: section.hunkIds.slice(0, 6),
          },
          // The briefing's where it wrote them (round 27), else code's (`briefedFrom`).
          briefed:
            briefedFrom(input.briefings?.sections.get(section.key), {
              own: briefedOf(decision.entry, sharedLean),
              unshared: briefedOf(decision.entry, new Set()),
              factors: factorsBriefed(decision.entry),
            }) ?? unreadBriefed(member.cause),
          explained: wholeExplained(
            input.briefings?.sections.get(section.key)?.explained ?? null,
          ),
        },
      });
    }

    // Every owned line of the batch owned once: per file and side, no two ranges overlap, and a
    // whole non-text range is the file's only range on that side.
    const bySide = new Map<
      string,
      Array<{ readonly key: string; readonly range: OwnedRange }>
    >();
    for (const member of members)
      for (const range of rangesOf.get(member.section.key)!) {
        const at = `${range.path}\0${range.side}`;
        bySide.set(at, [
          ...(bySide.get(at) ?? []),
          { key: member.section.key, range },
        ]);
      }
    for (const held of bySide.values()) {
      const whole = held.filter(({ range }) => range.kind === "whole-nontext");
      if (whole.length > 0 && held.length > 1)
        problems.push(
          `Section ${whole[0]!.key} owns a whole file that another range of the batch also owns.`,
        );
      const lines = held
        .flatMap(({ key, range }) =>
          range.kind === "lines" ? [{ key, range }] : [],
        )
        .sort((a, b) => a.range.startLine - b.range.startLine);
      for (let i = 1; i < lines.length; i++)
        if (lines[i]!.range.startLine <= lines[i - 1]!.range.endLine)
          problems.push(
            `Sections ${lines[i - 1]!.key} and ${lines[i]!.key} own the same lines.`,
          );
    }

    const units = composeUnits(
      members.map((m) => ({
        path: m.section.path,
        order: m.section.first,
        decision: m.decision!,
      })),
    );
    const byKey = new Map(members.map((m) => [m.section.key, m]));
    // Every section in exactly one unit, and a unit's sections share its lane and its path.
    const seen = new Map<string, number>();
    for (const [at, unit] of units.entries())
      for (const key of unit.sectionKeys) {
        seen.set(key, (seen.get(key) ?? 0) + 1);
        const member = byKey.get(key);
        if (member === undefined)
          problems.push(
            `Unit ${at} names section ${key}, which the batch does not hold.`,
          );
        else {
          if (
            member.decision?.settled === true &&
            member.decision.entry.lane.applied !== unit.lane
          )
            problems.push(
              `Section ${key} is in a unit of lane ${unit.lane} but its lane is ${member.decision.entry.lane.applied}.`,
            );
          if (member.section.path !== unit.path)
            problems.push(`Section ${key} is in a unit of another file.`);
        }
      }
    for (const member of members)
      if (seen.get(member.section.key) !== 1)
        problems.push(
          `Section ${member.section.key} is in ${seen.get(member.section.key) ?? 0} units.`,
        );

    const ranked: Array<
      ReadonlyArray<RankedComment & { readonly section: string | null }>
    > = [];
    const unitsOut: Array<SettledUnit> = [];
    const guidedCounts: Array<FormedBatch["guided"][number]> = [];
    for (const [at, unit] of units.entries()) {
      const unitRanges = unit.sectionKeys.flatMap(
        (key) => rangesOf.get(key) ?? [],
      );
      const comments: Array<
        UnitComment & {
          readonly comment: Omit<SettledComment, "shown" | "restedOn">;
        }
      > = [];
      const held: Array<{
        readonly id: string;
        readonly reason: WithheldReason;
      }> = [];
      const restsOn: Array<string> = [];
      /**
       * A comment of the unit, or withheld with why: an anchor not inside the unit's owned lines, an
       * impact with no effect or no summary that holds a letter or digit, an ID outside the records'
       * form. One comment per ID in a unit: the same words of the same kind on the same lines are one.
       */
      const add = (
        comment: Omit<SettledComment, "shown" | "restedOn">,
        rank: Omit<UnitComment, "id" | "kind" | "anchor" | "effect">,
      ) => {
        if (
          comments.some((c) => c.id === comment.id) ||
          held.some((c) => c.id === comment.id)
        )
          return;
        const reason: WithheldReason | undefined = !COMMENT_ID.test(comment.id)
          ? "id-form"
          : comment.anchor === undefined || !inside(comment.anchor, unitRanges)
            ? "anchor-outside"
            : comment.kind === "impact" &&
                (comment.effect === undefined ||
                  comment.summary === undefined ||
                  !WORDED.test(comment.summary))
              ? "no-summary"
              : undefined;
        if (reason !== undefined) {
          held.push({ id: comment.id, reason });
          return;
        }
        comments.push({
          id: comment.id,
          kind: comment.kind,
          ...(comment.effect === undefined ? {} : { effect: comment.effect }),
          anchor: comment.anchor!,
          ...rank,
          comment,
        });
      };
      for (const key of unit.sectionKeys) {
        const member = byKey.get(key);
        if (member === undefined) continue;
        const section = member.section;
        const ranges = rangesOf.get(key)!;
        const decision = member.decision as Extract<
          DecideOutput,
          { settled: true }
        >;
        restsOn.push(...decision.restsOn);
        // An excluded file has no reading and no comment, as today's code-only batch has none.
        if (decision.entry.excluded !== undefined) continue;
        const collected = input.collected.get(key);
        const about = testPaths.has(section.path) ? "tests" : "code";
        const cite = (reading: "assess" | "review") => (stable: string) =>
          readingCitation(stable, {
            step: collected?.steps[reading] ?? null,
            planKey: input.planKey,
            proofs: input.proofs,
          });
        // Lane review's comments. A defect claim Verify neither confirmed nor refuted is shown as a
        // question, with its claim's ID; a refuted one stays a defect, never shown or rested on.
        const review =
          collected?.review.judged === true
            ? collected.review.judgement
            : undefined;
        for (const comment of review?.comments ?? []) {
          const anchor = clipTo(
            {
              path: comment.path,
              side: comment.side,
              startLine: comment.startLine,
              endLine: comment.endLine,
            },
            section,
            ranges,
          );
          const id =
            comment.kind === "defect"
              ? claimKey(comment)
              : commentKey({ ...comment, kind: comment.kind });
          const verify =
            comment.kind === "defect"
              ? shownVerify(
                  member.claims.find((claim) => claim.id === id)?.verify,
                )
              : undefined;
          const kind = verify === "unconfirmed" ? "question" : comment.kind;
          add(
            {
              id,
              section: key,
              kind,
              ...(comment.kind === "impact"
                ? {
                    effect: comment.effect ?? ("changed" as const),
                    summary: summaryOf(comment.text),
                  }
                : {}),
              about,
              body: comment.text,
              ...(anchor === undefined ? {} : { anchor }),
              evidence: distinct(comment.cites.flatMap(cite("review"))),
            },
            {
              source: "lane-review",
              ...(kind === "defect" && verify !== undefined ? { verify } : {}),
              cites: comment.cites.length,
            },
          );
        }
        // Assess's impact entries: on the first owned lines a lines cite of it falls on, else on the
        // section's first owned lines. Code's own `removed` entry (`code-facts.ts`) is the removal
        // code's comment below says, by the same rule, so it is not shown a second time.
        const first = ranges.find((range) => range.kind === "lines");
        for (const entry of decision.entry.impact) {
          if (entry.effect === "removed" && entry.text === REMOVED_TEXT)
            continue;
          const cited = entry.cites
            .map((stable) => /^(.+):(old|new):(\d+)-(\d+)$/.exec(stable))
            .flatMap((match) =>
              match === null
                ? []
                : [
                    clipTo(
                      {
                        path: match[1]!,
                        side: match[2] as "old" | "new",
                        startLine: Number(match[3]),
                        endLine: Number(match[4]),
                      },
                      section,
                      ranges,
                    ),
                  ],
            )
            .find((anchor) => anchor !== undefined);
          const anchor =
            cited ??
            (first?.kind === "lines"
              ? {
                  path: first.path,
                  side: first.side,
                  startLine: first.startLine,
                  endLine: first.endLine,
                }
              : undefined);
          add(
            {
              id: commentKey({
                path: anchor?.path ?? section.path,
                side: anchor?.side ?? "new",
                startLine: anchor?.startLine ?? 0,
                endLine: anchor?.endLine ?? 0,
                kind: "impact",
                text: entry.text,
              }),
              section: key,
              kind: "impact",
              effect: entry.effect,
              summary: summaryOf(entry.text),
              about,
              body: entry.text,
              ...(anchor === undefined ? {} : { anchor }),
              evidence: distinct(entry.cites.flatMap(cite("assess"))),
            },
            { source: "assess", cites: entry.cites.length },
          );
        }
        // A removal the code facts show that no kept impact comment of this section names: one
        // withheld (or never added) does not say it, so code's own removal comment still appears.
        const named = comments.some(
          (kept) =>
            kept.comment.section === key &&
            kept.kind === "impact" &&
            kept.effect === "removed",
        );
        if (removesDeclaration(section) && !named) {
          const old = ranges.find(
            (range) => range.kind === "lines" && range.side === "old",
          );
          if (old?.kind === "lines") {
            // The removal sentence of its facts line: what code checked, and no more.
            const text = readerFacts(section, ranges);
            const anchor = {
              path: old.path,
              side: old.side,
              startLine: old.startLine,
              endLine: old.endLine,
            };
            add(
              {
                id: commentKey({ ...anchor, kind: "impact", text }),
                section: key,
                kind: "impact",
                effect: "removed",
                summary: summaryOf(text),
                about,
                body: text,
                anchor,
                evidence: distinct(
                  section.hunkIds.map((hunk) =>
                    citation(`computation:${input.manifestKey}`, hunk),
                  ),
                ),
              },
              { source: "code", cites: section.hunkIds.length },
            );
          }
        }
        // The finders' kept findings this section owns.
        for (const placed of placedOn.get(key) ?? []) {
          const finding = placed.kept.finding;
          // Nothing in this build is about proof: a finding about proof is about its file.
          const own = finding.about === "proof" ? about : finding.about;
          add(
            {
              id: placed.id,
              section: key,
              kind: finding.kind,
              about: own,
              ...(finding.signal !== null && own === finding.about
                ? { signal: finding.signal }
                : {}),
              body: finding.claim,
              anchor: placed.anchor,
              evidence: distinct(
                finding.evidence.flatMap((id) =>
                  finderCitation(id, {
                    manifestKey: input.manifestKey,
                    hunks,
                    findKey: placed.kept.findKey,
                  }),
                ),
              ),
            },
            {
              source: "finder",
              ...(finding.kind === "defect"
                ? { verify: "confirmed" as const }
                : {}),
              cites: finding.evidence.length,
            },
          );
        }
      }
      const rests = [...new Set(restsOn)];
      const order = rankComments(comments, { restsOn: rests });
      ranked.push(
        order.map((entry) => {
          const { comment, ...rest } = entry as typeof entry & {
            readonly comment: { readonly section: string | null };
          };
          return { ...rest, section: comment.section };
        }),
      );
      const byId = new Map(comments.map((c) => [c.id, c.comment]));
      const out = order.map((rankedComment): SettledComment => ({
        ...byId.get(rankedComment.id)!,
        shown: rankedComment.fate === "shown",
        restedOn: rests.includes(rankedComment.id),
      }));
      // A request for changes rests only on comments the unit shows: one withheld leaves it resting
      // on nothing, so the batch fails its checks.
      for (const id of rests) {
        const off = held.find((c) => c.id === id);
        if (off !== undefined)
          problems.push(
            `Unit ${at} rests on comment ${id}, which is withheld (${off.reason}).`,
          );
        else if (!byId.has(id))
          problems.push(
            `Unit ${at} rests on ${id}, which is no comment of the unit.`,
          );
      }
      withheld.push(...held);
      const restsOnNote = `This request for changes rests on ${plural(rests.length, "confirmed defect")}.`;
      const guided = guidedOf({
        unit,
        generated: group.id === GENERATED_GROUP.id,
        rows: groupRows(group, input.frame),
        stratum: input.frame.stratum,
        entries: unit.sectionKeys.flatMap((key) => {
          const decision = byKey.get(key)?.decision;
          return decision?.settled === true ? [decision.entry] : [];
        }),
        titles: new Map(
          unit.sectionKeys.map((key) => [
            key,
            byKey.get(key)?.section.title ?? "",
          ]),
        ),
        collected: input.collected,
        hunks,
        proofs: input.proofs,
        held: heldRows,
        restsOn: restsOnNote,
        citedComment: out.some(
          (comment) => comment.shown && comment.evidence.length > 0,
        ),
        pointers: new Set(
          unit.sectionKeys.filter((key) =>
            isGitlink(
              (byKey.get(key)?.section.hunkIds ?? []).flatMap((id) => {
                const hunk = hunks.get(id);
                return hunk === undefined ? [] : [hunk];
              }),
            ),
          ),
        ),
      });
      guidedCounts.push({
        basis: guided.basis,
        rows: {
          met: guided.rows.filter((row) => row.status === "met").length,
          "not-met": guided.rows.filter((row) => row.status === "not-met")
            .length,
          "no-evidence": guided.rows.filter(
            (row) => row.status === "no-evidence",
          ).length,
        },
        review: guided.review !== null,
        suggestion: guided.suggestion !== null,
        notes: guided.notes.length,
      });
      unitsOut.push({
        path: unit.path,
        lane: unit.lane,
        laneRule: LANE_RULE_VERSION,
        sectionKeys: [...unit.sectionKeys],
        verdict: unit.verdict,
        disposition: unit.disposition,
        ...(unit.disposition === "approve"
          ? { message: unit.proof.text }
          : unit.disposition === "request-changes"
            ? { message: restsOnNote }
            : {}),
        // Proof records only an approval rests on.
        proof: unit.disposition === "approve" ? [...unit.proof.proof] : [],
        comments: out,
        guided,
      });
    }

    for (const unplaced of input.placement.unplaced)
      if (unplaced.group === mapGroup)
        gaps.push(unplacedGap(unplaced.id, unplaced.reason));
    if (input.dropped !== true) gaps.push(...droppedReadingGaps(members));
    if (withheld.length > 0)
      gaps.push({
        key: `comments-withheld:${sha256Hex(
          withheld
            .map((c) => c.id)
            .sort()
            .join("\n"),
        ).slice(0, 16)}`,
        kind: "comments-withheld",
        detail: `${plural(withheld.length, "comment")} on this batch could not be shown as written, so ${withheld.length === 1 ? "it is" : "they are"} withheld.`,
      });

    // Each unit's lead (round 27b): its file's lead, else its first section's Briefed. Only where
    // the review made a briefing, never on the generated batch.
    const briefings = input.briefings;
    for (const [at, unit] of unitsOut.entries()) {
      if (briefings === undefined || group.id === GENERATED_GROUP.id) break;
      // Only a unit with a section a briefing read: never one whose sections no part held.
      if (!unit.sectionKeys.some((key) => briefings.sections.has(key)))
        continue;
      const ordered = [...unit.sectionKeys].sort(
        (a, b) =>
          (byKey.get(a)?.section.first ?? 0) -
          (byKey.get(b)?.section.first ?? 0),
      );
      const of = {
        sectionKeys: ordered,
        fileSections: input.sections
          .filter(
            (s) =>
              s.section.path === unit.path &&
              briefings.sections.has(s.section.key),
          )
          .map((s) => s.section.key),
        lead: briefings.leads?.get(unit.path),
      };
      const briefed = unitLeadOf({
        ...of,
        briefed: (key) =>
          sectionsOut.find((s) => s.identity.key === key)?.content?.briefed ??
          null,
      });
      // The behaviour title written with the file's lead, when that lead is the unit's; else its
      // first section's behaviour title, "and N more"; else the publisher's code title stands.
      const title = unitTitleOf({
        ...of,
        titles: (key) => briefings.sections.get(key)?.title,
      });
      unitsOut[at] = {
        ...unit,
        ...(briefed === undefined ? {} : { briefed }),
        ...(title === undefined ? {} : { title }),
      };
    }
    // The same-batch references by code (round 27b), from the groups' confirmed caller rows.
    const references =
      input.head === undefined
        ? []
        : sameBatchReferences({
            head: input.head,
            base: input.base,
            hunks,
            sections: referenceSections,
            rows: callerRows,
            units: unitsOut.map((unit) => ({
              key: unitKeyOf({ sectionKeys: [...unit.sectionKeys] }),
              sectionKeys: unit.sectionKeys,
            })),
          });

    // The briefing's gaps, one per unit whose sections' briefing failed or was cut (round 27).
    if (input.briefings !== undefined)
      for (const [at, unit] of unitsOut.entries())
        gaps.push(...briefingGaps(unit, at, input.briefings.sections));

    const files = new Set(unitsOut.map((unit) => unit.path)).size;
    const codeDigest = {
      text: `${plural(unitsOut.length, "unit")} in ${plural(files, "file")} for "${oneLine(group.label)}". ${unitsOut
        .map((unit) =>
          unit.sectionKeys
            .map((key) => {
              const section = sectionsOut.find((s) => s.identity.key === key);
              return section === undefined
                ? ""
                : factsLine(section.title, section.ownedRanges);
            })
            .join(" "),
        )
        .join(" ")}`.slice(0, 2_000),
      limitations: [
        "This briefing was put together by code from each unit's facts.",
      ],
    };
    // The briefing's digest where it wrote one, its links turned to units; else code's. Code writes
    // the verification from the checkpoints' proof states and the obligations from Guided rows.
    const unitOfHunk = new Map<string, string>();
    for (const unit of unitsOut)
      for (const key of unit.sectionKeys)
        for (const hunk of byKey.get(key)?.section.hunkIds ?? [])
          if (!unitOfHunk.has(hunk)) unitOfHunk.set(hunk, handleOf(unit));
    const digestBriefing = input.briefings?.digests.get(group.id);
    const digest = digestFrom({
      briefing: group.id === GENERATED_GROUP.id ? undefined : digestBriefing,
      code: codeDigest,
      verification: verificationOf(
        members.flatMap((m) =>
          m.decision?.settled === true
            ? (
                m.decision.entry.assess?.easeOfValidation.requirements ?? []
              ).map((r) => ({
                requirement: r.requirement,
                state: r.proofState,
              }))
            : [],
        ),
      ),
      obligations: obligationsOf(unitsOut),
      unitOf: (hunk) => unitOfHunk.get(hunk),
    });
    // A digest that failed or was cut is disclosed as a gap, whatever its parts wrote.
    const lostDigest =
      group.id === GENERATED_GROUP.id
        ? undefined
        : digestGap(group.id, digestBriefing);
    if (lostDigest !== undefined) gaps.push(lostDigest);
    const sectionStates = members.flatMap((m) => {
      const held = input.briefings?.sections.get(m.section.key);
      return held === undefined ? [] : [held.state];
    });
    const briefingStates = [
      ...sectionStates,
      ...(digestBriefing === undefined || group.id === GENERATED_GROUP.id
        ? []
        : [digestBriefing.state]),
    ];

    const ready = problems.length === 0;
    records.push({
      mapGroup,
      settled: true,
      ready,
      reason: ready ? null : "checks-failed",
      sections: sectionCounts,
      units: units.length,
      problems,
      briefing: {
        state: batchBriefingOf(briefingStates),
        sections: {
          written: sectionStates.filter((s) => s === "written").length,
          failed: sectionStates.filter((s) => s === "failed").length,
          cut: sectionStates.filter((s) => s === "cut").length,
        },
        digest: digest.source,
      },
    });
    formed.push({
      mapGroup: group.id,
      units,
      comments: ranked,
      guided: guidedCounts,
    });
    if (!ready) continue;
    settledGroups.add(group.id);
    batches.push({
      title: group.label,
      focus: group.why,
      paths: group.files.map((file) => file.path),
      sections: sectionsOut,
      units: unitsOut,
      digest,
      ...(references.length === 0 ? {} : { references }),
      ...(gaps.length === 0 ? {} : { gaps }),
      ...(withheld.length === 0 ? {} : { withheld }),
    });
  }

  // A finding whose gap no handed-over batch carries is a gap about the run.
  for (const unplaced of input.placement.unplaced)
    if (!settledGroups.has(unplaced.group))
      runGaps.push(unplacedGap(unplaced.id, unplaced.reason));
  if (unowned > 0)
    runGaps.push({
      key: "sections-unowned",
      kind: "sections-unowned",
      detail: `${plural(unowned, "changed section")} ${unowned === 1 ? "owns" : "own"} no changed lines under the review rules, so ${unowned === 1 ? "it is" : "they are"} not published.`,
    });
  if (unnamed.length > 0)
    runGaps.push({
      key: "sections-excluded-unnamed",
      kind: "sections-excluded-unnamed",
      detail: `${plural(unnamed.length, "changed section")} ${unnamed.length === 1 ? "was" : "were"} left out of the readings for a reason the review's map does not give, so ${unnamed.length === 1 ? "it is" : "they are"} in no batch and still pending.`,
    });
  if (homeless > 0)
    runGaps.push({
      key: "sections-without-batch",
      kind: "sections-without-batch",
      detail: `${plural(homeless, "changed section")} ${homeless === 1 ? "belongs" : "belong"} to no batch of this review, so ${homeless === 1 ? "it is" : "they are"} not published.`,
    });

  return {
    batches,
    records,
    formed,
    totals: { batches: totalBatches, sections: totalSections + unnamed.length },
    gaps: runGaps,
    unplaced: input.placement.unplaced,
  };
};

/** The stable form a stored value takes: JSON, so undefined fields are absent, as the store holds it. */
export const stored = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value)) as T;
