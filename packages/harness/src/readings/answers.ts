import { z } from "zod";
import { ProofKind } from "@neuve/records-schema";
import { MAX_ROWS, overlaps } from "../disposition.ts";
import { metProblem, type RowBasis, type RowProof } from "../proof-state.ts";
import type { CodeFactor, CodeFacts } from "./code-facts.ts";

/**
 * What the two readings submit for one reading group, and code's checks of it.
 *
 * Assess asks whether each section needs a person; Lane review asks whether each section is right.
 * Each submits one compact object per group: tables written once, and the sections by index. The
 * schemas and their words are what a model sees, so they hold no field for coverage, proof state,
 * a lane, a quadrant or a floor, and none of those words. Code fills all of them afterwards.
 *
 * Classes. Most sections of a reading get the same judgement, so a model writes each distinct
 * judgement once and lists the sections it applies to: Assess as classes (the two levels, factor
 * and requirement positions, and a person's need and gaps where they apply), the first being the
 * judgement most sections share; Lane review as one list of sections per verdict. Every section of
 * the reading must be listed exactly once. A section listed nowhere or more than once is a problem
 * (`missing-row`, `duplicate-row`), sent back once, and after that the section is not judged: code
 * never gives a section a judgement it was not listed for. Expanded, a class gives exactly the
 * per-section judgement a row with the same values gave, so nothing downstream of `assessExpand`
 * and `laneReviewExpand` reads the class form.
 *
 * What code writes. Code adds each section's size, declared kind and removal factors from the
 * plan's facts (in `codeFactors`, beside the factors the lane rule reads, so they never count as
 * cited evidence for a level), and the `removed` impact entry of a removed declaration
 * (`code-facts.ts`), each citing the plan's fact, when it expands an Assess answer.
 *
 * Cite form. A cite is a short string naming something the reading listed:
 * - lines: `<file><side><start>[-<end>]`, the file's index in the reading, `n` for the new side
 *   or `o` for the old, then a line or a line range in that file: `2n14-20`, `0o7`. It resolves
 *   when it overlaps the owned lines of a section of that file on that side.
 * - a change fact or a proof record: the ID the reading lists for it (`f12`, `p3`).
 * Anything else is unknown. Stored, a lines cite becomes `<path>:<side>:<start>-<end>`, which no
 * longer needs the reading to be read; a fact or proof record keeps its ID.
 *
 * Indices into `factors`, `requirements` and `comments` tables, and class numbers, are 0-based
 * positions; section and file indices are the numbers the reading lists.
 *
 * Scope and tests (`ReadingsConfig.scopeAndTests`, off unless set). Assess answers in the tested
 * form (`AssessTestedAnswer`): a requirement also names the shown test rows that exercise it
 * (`testedBy`, held to `testRow`), beside `testable` and `untested` as before. Lane review answers in the
 * scoped form (`LaneReviewScopedAnswer`): `notAsked` lists the sections it is unsure of because the
 * goal and its done-when conditions do not ask for their change. Neither moves anything code
 * decides: `testedBy` is context and a count, and a section in `notAsked` is decided by its verdict,
 * `unsure`, as every unsure section is. Off, both forms and every function here are as before.
 *
 * Wire form. Both schemas sit inside the provider's strict structured-output subset as written: no
 * tuple anywhere (lists of integers and small objects with short keys), and no optional field (a
 * field that may be absent is present and nullable, so the strict conversion adds nothing and a
 * value the model writes is the value zod reads). `readings-wire.test.ts` holds them to it.
 */

// ---------------------------------------------------------------------------------------------
// Bounds and versions
// ---------------------------------------------------------------------------------------------

export const ANSWER_BOUNDS = {
  sections: 40,
  files: 16,
  /**
   * Per Assess answer: a typical reading needs one or two factors and two or three requirements for
   * all its classes.
   */
  factors: 4,
  requirements: 4,
  /** Cites per Assess factor, requirement or impact entry. */
  assessCites: 2,
  /** Proof record IDs per Assess requirement. */
  proof: 8,
  /** Proof kinds per Assess requirement. */
  kinds: 6,
  /** Characters of a cite, a done-when row ID or a gap's short name, as the model is told. */
  citeText: 80,
  gapKind: 40,
  /** Characters of a Lane review comment, a defect's failure path and an unsure note. */
  commentText: 400,
  failsText: 200,
  unsureText: 200,
  /** Cites per Lane review row or comment. */
  cites: 6,
  commentsPerSection: 3,
  gaps: 4,
  rows: MAX_ROWS,
  /** Characters of an Assess text. */
  factorText: 80,
  requirementText: 90,
  impactText: 90,
  untestedText: 80,
  personWhy: 60,
  gapText: 60,
  /** Characters of a Lane review file's line saying what was checked. */
  checkedText: 80,
  /**
   * Characters of a Lane review row's reading: whether the changed code, and any test the reading
   * shows, does what the row asks. Short enough that code's prefix for a refused met still fits the
   * desk's 300 (`MET_READING`).
   */
  readingText: 240,
} as const;

/**
 * The most entries a list may hold before the answer is not the schema: a sanity ceiling against a
 * runaway answer, far past every cap, and never told to the model. Below it a list over its cap is
 * accepted whole and counted (`over-cap`); text over its bound is clipped for storage and counted
 * (`clipped-text`). Size is never a reason to send an answer back: its tokens are already written.
 */
export const LIST_CEILING = 64;
/** The ceiling of the two lists that may hold several entries per section: comments and unsure notes. */
export const LONG_LIST_CEILING = 256;

/**
 * 2: section rows are objects, absent fields are present and null, and the Assess bounds are smaller.
 * 3: classes of sections instead of one row per section; smaller bounds; size, declared kind and
 * removals are code's, so the model's factor kinds and impact effects leave them out.
 * 4: an empty cite, factor or requirement text, reason or gap is accepted and handled by code
 * (`empty-text`); an empty impact text is still refused.
 * 5: an impact entry whose text is empty or has no letter or digit is accepted and kept, under code's
 * words for its effect (`IMPACT_WORDS`).
 * 6: an impact entry is only for existing behaviour that changes (`added` leaves the model's
 * effects: what a section adds is in its rows); smaller caps and text bounds.
 */
export const ASSESS_ANSWER_VERSION = 6;
/**
 * 2: section rows are objects, and absent fields are present and null.
 * 3: one list of sections per verdict instead of one row per section; a shorter checked line.
 * 4: an empty cite, row ID, checked line, comment or unsure note is accepted and handled by code.
 * 6 (5 is the scope-and-tests form's): each row also gives its reading beside its status (`reading`),
 * and a met that code refuses keeps it, behind code's words (`MET_READING`).
 */
export const LANE_REVIEW_ANSWER_VERSION = 6;
/**
 * The answer forms with scope and tests on (`AssessTestedAnswer`, `LaneReviewScopedAnswer`): each
 * base form's version plus one, keyed only on that setting's steps. The base forms' next versions
 * skip these numbers, so a version never names two forms.
 * Assess 7: version 6, with `testedBy` beside each requirement's `testable` and `untested`.
 * Lane review 5: version 4, with `notAsked`. Lane review 7: version 6, with `notAsked`.
 */
export const ASSESS_TESTED_ANSWER_VERSION = 7;
export const LANE_REVIEW_SCOPED_ANSWER_VERSION = 7;

/**
 * A text the model is told the bound of (the wire form states it in the field's description) and
 * zod does not refuse past it: code clips it for storage and counts it. An empty one is not refused
 * either: a refusal costs the whole answer and is counted nowhere, so code counts it (`empty-text`,
 * or an unknown cite for an empty cite) and treats it as missing, never to the reading's advantage
 * (`assessRepair`, `laneReviewRepair`).
 */
const text = (bound: number) => z.string().meta({ maxLength: bound });
/** A list the model is told the cap of; zod refuses it only past the ceiling. */
const list = <T extends z.ZodType>(
  item: T,
  cap: number,
  ceiling: number = LIST_CEILING,
) => z.array(item).max(ceiling).meta({ maxItems: cap });

/** A cite past its length names nothing the reading lists: it is an unknown cite, dropped. */
const Cite = text(ANSWER_BOUNDS.citeText);
const Cites = list(Cite, ANSWER_BOUNDS.cites);
const AssessCites = list(Cite, ANSWER_BOUNDS.assessCites);
const Index = z.int().min(0);
const Sections = list(Index, ANSWER_BOUNDS.sections);
const Effect = z.enum(["removed", "disabled", "narrowed", "changed", "added"]);
export type Effect = z.infer<typeof Effect>;
/**
 * The effects an Assess impact entry may give: only existing behaviour that changes. A removed
 * declaration is code's (`code-facts.ts`), and that a section adds code is in its rows, so neither
 * is the model's to write.
 */
const AssessEffect = z.enum(["narrowed", "disabled", "changed"]);
/**
 * The effects a stored Assess answer may hold: answers of version 5 and before could also give
 * `added`, and a stored one still reads, as it did then. No new answer holds it.
 */
const StoredAssessEffect = z.enum(["narrowed", "disabled", "changed", "added"]);
type StoredAssessEffect = z.infer<typeof StoredAssessEffect>;

// ---------------------------------------------------------------------------------------------
// Assess
// ---------------------------------------------------------------------------------------------

/**
 * One judgement and the sections it applies to: `S` the section numbers, complexity `c` l|h, ease
 * of validation `v` e|h, factor and requirement positions `F` and `R`.
 */
const AssessClass = z.strictObject({
  S: Sections,
  c: z.enum(["l", "h"]),
  v: z.enum(["e", "h"]),
  F: list(Index, ANSWER_BOUNDS.factors),
  R: list(Index, ANSWER_BOUNDS.requirements),
  person: z
    .strictObject({
      need: z.enum(["yes", "no"]),
      why: text(ANSWER_BOUNDS.personWhy),
    })
    .nullable(),
  gaps: list(
    z.strictObject({
      axis: z.enum(["complexity", "ease-of-validation"]),
      kind: text(ANSWER_BOUNDS.gapKind),
      t: text(ANSWER_BOUNDS.gapText),
    }),
    ANSWER_BOUNDS.gaps,
  ).nullable(),
});

/** A requirement as the Assess answer gives it: whether a test can check it, and if not, why. */
const Requirement = z.strictObject({
  t: text(ANSWER_BOUNDS.requirementText),
  kinds: list(ProofKind, ANSWER_BOUNDS.kinds),
  cites: AssessCites,
  testable: z.boolean(),
  untested: z.string().meta({ maxLength: ANSWER_BOUNDS.untestedText }),
  proof: list(Cite, ANSWER_BOUNDS.proof),
  agree: z.boolean(),
});

/**
 * A requirement as the Assess answer gives it with scope and tests on: `testable` and `untested`
 * exactly as in `Requirement`, plus `testedBy`, the line cites of the shown test rows that exercise
 * it (changed rows of a section in a file declared test), or none. `testedBy` is context and a count
 * only: no code reads it to set a gap, a level, a lane, a proof state or a decision (owner ruling, 13
 * November: a recognised test is a hint, never evidence), and `untested` keeps its meaning, so
 * everything code decides from a requirement is what it is with the setting off.
 */
const TestedRequirement = z.strictObject({
  t: text(ANSWER_BOUNDS.requirementText),
  kinds: list(ProofKind, ANSWER_BOUNDS.kinds),
  cites: AssessCites,
  testable: z.boolean(),
  untested: z.string().meta({ maxLength: ANSWER_BOUNDS.untestedText }),
  testedBy: AssessCites,
  proof: list(Cite, ANSWER_BOUNDS.proof),
  agree: z.boolean(),
});

/**
 * A requirement as stored: either form, `testedBy` present only on the tested form. A stored reader
 * takes one object, never a union of two that overlap.
 */
const StoredRequirement = z.strictObject({
  ...Requirement.shape,
  testedBy: AssessCites.optional(),
});

/** The Assess answer's schema over the effects its impact entries may give. */
const assessAnswerOf = <E extends z.ZodType<string>>(effect: E) =>
  z.strictObject({
    factors: list(
      z.strictObject({
        /** `size` only as the reason a class is high: code records every section's size itself. */
        f: z.enum([
          "architectural-role",
          "security",
          "impact",
          "connections",
          "dependency-position",
          "size",
        ]),
        t: text(ANSWER_BOUNDS.factorText),
        cites: AssessCites,
      }),
      ANSWER_BOUNDS.factors,
    ),
    requirements: list(Requirement, ANSWER_BOUNDS.requirements),
    /**
     * Only where existing behaviour changes; capped by the number of sections of the reading, so
     * every such section's impact can be said.
     */
    impact: list(
      z.strictObject({
        s: Index,
        effect,
        t: text(ANSWER_BOUNDS.impactText),
        cites: AssessCites,
      }),
      ANSWER_BOUNDS.sections,
    ),
    /** The first class is the judgement most sections share. */
    classes: list(AssessClass, ANSWER_BOUNDS.sections),
  });

/** A new Assess answer: what the model is given and what its submission is held to. */
export const AssessAnswer = assessAnswerOf(AssessEffect);
export type AssessAnswer = z.infer<typeof AssessAnswer>;
/**
 * A new Assess answer with scope and tests on: `AssessAnswer` with each requirement also saying
 * `testedBy` (`TestedRequirement`), every other key as it is, in the same order.
 */
export const AssessTestedAnswer = z.strictObject({
  ...AssessAnswer.shape,
  requirements: list(TestedRequirement, ANSWER_BOUNDS.requirements),
});
export type AssessTestedAnswer = z.infer<typeof AssessTestedAnswer>;
/** A new Assess answer of either form. */
export type AnyAssessAnswer = AssessAnswer | AssessTestedAnswer;

/** A requirement of either form, as stored (`testedBy` only on the tested form). */
type AnyRequirement = z.infer<typeof StoredRequirement>;

/** An answer's requirements, of whichever form it is (every one of one form). */
const requirementsOf = (answer: {
  readonly requirements: ReadonlyArray<AnyRequirement>;
}): ReadonlyArray<AnyRequirement> => answer.requirements;
/**
 * An Assess answer as stored: a new one of either form, or one of an older version, whose impact
 * entries may give `added`. Only what reads a stored answer takes it (`AssessStored`,
 * `assessExpand`). One object, whose requirements carry `testedBy` only where the tested form gave
 * it, so an answer stored before scope and tests reads exactly as it did.
 */
export const StoredAssessAnswer = z.strictObject({
  ...assessAnswerOf(StoredAssessEffect).shape,
  requirements: list(StoredRequirement, ANSWER_BOUNDS.requirements),
});
export type StoredAssessAnswer = z.infer<typeof StoredAssessAnswer>;

// ---------------------------------------------------------------------------------------------
// Lane review
// ---------------------------------------------------------------------------------------------

/**
 * One done-when row of a file: its reading (what the changed code, and any test the reading shows,
 * does about the row, never a status) beside its status, and the cites both rest on.
 */
const LaneReviewRow = z.strictObject({
  row: Cite,
  reading: text(ANSWER_BOUNDS.readingText),
  status: z.enum(["met", "not-met", "no-evidence"]),
  cites: Cites,
});

const laneReviewFiles = <R extends z.ZodType>(row: R) =>
  list(
    z.strictObject({
      f: Index,
      checked: text(ANSWER_BOUNDS.checkedText),
      /** Null for a file judged on no done-when row. */
      rows: list(row, ANSWER_BOUNDS.rows).nullable(),
    }),
    ANSWER_BOUNDS.files,
  );

export const LaneReviewAnswer = z.strictObject({
  files: laneReviewFiles(LaneReviewRow),
  /** The sections by verdict: a (approve), r (request changes) and u (unsure); each listed once. */
  sections: z.strictObject({ a: Sections, r: Sections, u: Sections }),
  comments: list(
    z.strictObject({
      s: Index,
      side: z.enum(["old", "new"]),
      start: z.int().min(1),
      end: z.int().min(1),
      kind: z.enum(["defect", "risk", "question", "pattern-note", "impact"]),
      /** What an impact comment says happens to existing behaviour; null on any other comment. */
      effect: Effect.nullable(),
      /** Past its bound a comment is withheld alone (`long-comment`), never clipped. */
      t: text(ANSWER_BOUNDS.commentText),
      cites: Cites,
      fails: z.string().meta({ maxLength: ANSWER_BOUNDS.failsText }),
      row: Cite.nullable(),
    }),
    ANSWER_BOUNDS.sections * ANSWER_BOUNDS.commentsPerSection,
    LONG_LIST_CEILING,
  ),
  unsure: list(
    z.strictObject({ s: Index, t: text(ANSWER_BOUNDS.unsureText) }),
    ANSWER_BOUNDS.sections,
    LONG_LIST_CEILING,
  ),
});
export type LaneReviewAnswer = z.infer<typeof LaneReviewAnswer>;

/**
 * A Lane review answer with scope and tests on: also `notAsked`, the numbers of the sections it is
 * unsure of because neither the goal nor its done-when conditions ask for their change. The
 * smallest closed addition that code and the run log can count: no existing field says why a
 * section is unsure in closed words (an unsure note is free text), and a list of section numbers
 * leaves the verdict lists and the unsure notes exactly as they are. Every section it names must
 * also be under `u`; it moves no section anywhere (code's decision reads the verdict lists only).
 */
export const LaneReviewScopedAnswer = z.strictObject({
  ...LaneReviewAnswer.shape,
  notAsked: Sections,
});
export type LaneReviewScopedAnswer = z.infer<typeof LaneReviewScopedAnswer>;
/** A new Lane review answer of either form. */
export type AnyLaneReviewAnswer = LaneReviewAnswer | LaneReviewScopedAnswer;

/**
 * An answer's `notAsked`, or undefined for the base form. Read through one optional key, as the
 * stored form has it: the scoped form is assignable to the base one, so a union of the two can be
 * reduced to the base and an `in` check would read nothing.
 */
const notAskedOf = (
  answer: AnyLaneReviewAnswer,
): ReadonlyArray<number> | undefined =>
  (answer as { readonly notAsked?: ReadonlyArray<number> }).notAsked;
/**
 * A Lane review answer as stored: either form, as one object whose `notAsked` is present only on
 * the scoped form (a stored reader takes one object, never a union of two that overlap). Every
 * answer stored before scope and tests reads exactly as it did.
 */
export const StoredLaneReviewAnswer = z.strictObject({
  ...LaneReviewAnswer.shape,
  /** A row stored before version 6 (scoped 7) has no reading. */
  files: laneReviewFiles(
    z.strictObject({
      ...LaneReviewRow.shape,
      reading: LaneReviewRow.shape.reading.optional(),
    }),
  ),
  notAsked: Sections.optional(),
});

/**
 * An answer whose rows were written before they gave a reading (a stored one of an older version),
 * read as one whose every row gave an empty reading; anything else as it is. Repair and the checks
 * both read through it, so a stored answer reads as it did, with no reading to show.
 */
const withReadings = (raw: unknown): unknown => {
  if (typeof raw !== "object" || raw === null) return raw;
  const files = (raw as { readonly files?: unknown }).files;
  if (!Array.isArray(files)) return raw;
  return {
    ...raw,
    files: files.map((file: unknown) => {
      if (typeof file !== "object" || file === null) return file;
      const rows = (file as { readonly rows?: unknown }).rows;
      if (!Array.isArray(rows)) return file;
      return {
        ...file,
        rows: rows.map((row: unknown) =>
          typeof row === "object" && row !== null && !("reading" in row)
            ? { ...row, reading: "" }
            : row,
        ),
      };
    }),
  };
};

const VERDICT_KEYS = ["a", "r", "u"] as const;
type VerdictKey = (typeof VERDICT_KEYS)[number];

/** Each section a Lane review answer lists, with its verdict, in the order the lists give them. */
const verdictsOf = (answer: LaneReviewAnswer) =>
  VERDICT_KEYS.flatMap((v) => answer.sections[v].map((s) => ({ s, v })));

// ---------------------------------------------------------------------------------------------
// What a reading listed
// ---------------------------------------------------------------------------------------------

export interface OwnedLines {
  readonly side: "old" | "new";
  readonly startLine: number;
  readonly endLine: number;
}

/** A file of the reading: its index, its path and the done-when rows it may be judged on. */
export interface ReadingFile {
  readonly index: number;
  readonly path: string;
  readonly rows: ReadonlyArray<RowBasis>;
}

/**
 * A section of the reading: its index, its identity key, its file's index, its owned lines, and
 * what code writes into its Assess judgement from the plan (none when absent).
 */
export interface ReadingSection {
  readonly index: number;
  readonly key: string;
  readonly file: number;
  readonly owned: ReadonlyArray<OwnedLines>;
  readonly code?: CodeFacts | undefined;
  /**
   * The kind its file is declared as (the plan's `declared`): a `testedBy` cite must fall on a
   * section declared `test`. Absent where the index was built without it.
   */
  readonly declared?: "test" | "doc" | "generated" | null | undefined;
}

/** A change fact the reading listed, about one section. */
export interface ReadingFact {
  readonly id: string;
  readonly section: number;
}

/** A proof record the reading listed, with its currency for each file path it was listed for. */
export interface ReadingProof {
  readonly id: string;
  readonly kind: RowProof["kind"];
  readonly requirement: string;
  readonly currency: Readonly<Record<string, string>>;
}

export type Resolved =
  | {
      readonly kind: "lines";
      readonly stable: string;
      readonly file: number;
      readonly path: string;
      readonly side: "old" | "new";
      readonly startLine: number;
      readonly endLine: number;
      /** The sections whose owned lines it overlaps. */
      readonly sections: ReadonlyArray<number>;
    }
  | {
      readonly kind: "fact";
      readonly stable: string;
      readonly section: number;
    }
  | { readonly kind: "proof"; readonly stable: string }
  | { readonly kind: "unknown"; readonly cite: string };

export interface ReadingIndex {
  readonly files: ReadonlyArray<ReadingFile>;
  readonly sections: ReadonlyArray<ReadingSection>;
  readonly facts: ReadonlyArray<ReadingFact>;
  readonly proofs: ReadonlyArray<ReadingProof>;
  /** What a cite names, or that it is unknown. */
  readonly resolve: (cite: string) => Resolved;
}

const LINES = /^(\d+)([no])(\d+)(?:-(\d+))?$/;

/** The largest line number a cite or a comment's anchor may name; anything past it names nothing. */
export const MAX_LINE = 10_000_000;

/** Whether a line range is well formed: positive lines, no larger than `MAX_LINE`, end not before start. */
const wellFormed = (startLine: number, endLine: number) =>
  Number.isSafeInteger(startLine) &&
  Number.isSafeInteger(endLine) &&
  startLine >= 1 &&
  endLine >= startLine &&
  endLine <= MAX_LINE;

/** A reading index with its `resolve`, from what the reading listed. */
export const readingIndex = (
  data: Omit<ReadingIndex, "resolve">,
): ReadingIndex => {
  const facts = new Map(data.facts.map((fact) => [fact.id, fact]));
  const proofs = new Set(data.proofs.map((proof) => proof.id));
  const files = new Map(data.files.map((file) => [file.index, file]));
  const resolve = (cite: string): Resolved => {
    const fact = facts.get(cite);
    if (fact !== undefined)
      return { kind: "fact", stable: cite, section: fact.section };
    if (proofs.has(cite)) return { kind: "proof", stable: cite };
    const match = LINES.exec(cite);
    const file = match === null ? undefined : files.get(Number(match[1]));
    if (match === null || file === undefined) return { kind: "unknown", cite };
    const side = match[2] === "n" ? "new" : "old";
    const startLine = Number(match[3]);
    const endLine = match[4] === undefined ? startLine : Number(match[4]);
    if (!wellFormed(startLine, endLine)) return { kind: "unknown", cite };
    const sections = data.sections
      .filter(
        (section) =>
          section.file === file.index &&
          section.owned.some(
            (owned) =>
              owned.side === side && overlaps(owned, { startLine, endLine }),
          ),
      )
      .map((section) => section.index);
    if (sections.length === 0) return { kind: "unknown", cite };
    return {
      kind: "lines",
      stable: `${file.path}:${side}:${startLine}-${endLine}`,
      file: file.index,
      path: file.path,
      side,
      startLine,
      endLine,
      sections,
    };
  };
  return { ...data, resolve };
};

/** Whether a text holds at least one letter or digit: an impact's text must, to be shown as a summary. */
export const WORDED = /[\p{L}\p{N}]/u;

/**
 * Code's own words for an impact entry whose text has no letter or digit: the entry is kept with
 * its effect and cites (an effect can only raise a lane: `floorsOf`), and is shown in these words,
 * never as a summary with none. `added` is for a stored answer of an older version.
 */
export const IMPACT_WORDS: Readonly<Record<StoredAssessEffect, string>> = {
  narrowed: "The reading marks existing behaviour here as narrowed.",
  disabled: "The reading marks existing behaviour here as disabled.",
  changed: "The reading marks behaviour here as changed.",
  added: "The reading marks behaviour here as added.",
};

const known = (index: ReadingIndex, cites: ReadonlyArray<string>) =>
  cites.filter((cite) => index.resolve(cite).kind !== "unknown");

/**
 * Whether a cite names a shown test row: changed lines of a section of the reading whose file is
 * declared test (`ReadingSection.declared`). The one rule a `testedBy` cite is held to.
 */
export const testRow = (index: ReadingIndex, cite: string) => {
  const resolved = index.resolve(cite);
  return (
    resolved.kind === "lines" &&
    index.sections.some(
      (section) =>
        section.declared === "test" &&
        resolved.sections.includes(section.index),
    )
  );
};

/** Whether a reading shows any test row: a section of a file declared test. */
export const showsTests = (index: ReadingIndex) =>
  index.sections.some((section) => section.declared === "test");

const unknownOf = (index: ReadingIndex, cites: ReadonlyArray<string>) =>
  cites.filter((cite) => index.resolve(cite).kind === "unknown");

const stableOf = (index: ReadingIndex, cites: ReadonlyArray<string>) => [
  ...new Set(
    cites.flatMap((cite) => {
      const resolved = index.resolve(cite);
      return resolved.kind === "unknown" ? [] : [resolved.stable];
    }),
  ),
];

// ---------------------------------------------------------------------------------------------
// Problems and their classes
// ---------------------------------------------------------------------------------------------

/**
 * The closed list of what code's checks find wrong with an answer. A class names the rule broken,
 * never anything the answer says, so counts by class may be written where model text may not.
 */
export const PROBLEM_CLASSES = [
  "not-the-schema",
  "missing-row",
  "duplicate-row",
  "unknown-section",
  "unknown-file",
  "duplicate-file",
  "index-out-of-range",
  "unknown-cite",
  "empty-text",
  "unknown-proof",
  // No longer found: a wordless impact entry is now kept in code's words (`empty-text`). The class
  // stays so counts stored before read back.
  "bad-impact-text",
  "row-not-given",
  "row-judged-twice",
  "met-refused",
  "comment-off-lines",
  "impact-without-effect",
  "effect-off-impact",
  "too-many-comments",
  "clipped-text",
  "over-cap",
  "long-comment",
  "request-without-defect",
  "request-defect-off-lines",
  "approval-beside-defect",
  "approval-beside-not-met-row",
  "approval-beside-unsure",
  "nothing-checked",
  "orphan",
  // Scope and tests only (added last, so counts of the classes above keep their order):
  // a `testedBy` cite that is not a changed row of a shown test section, sent back once, then
  // dropped; a section named not asked for that is not under `u`, sent back once, then dropped from
  // `notAsked`.
  "unknown-test",
  "not-asked-off-unsure",
] as const;
export type ProblemClass = (typeof PROBLEM_CLASSES)[number];

/** One problem of an answer: its class, and its plain words for the repair turn. */
export interface Problem {
  readonly class: ProblemClass;
  readonly text: string;
}

/** Counts of problems by class; a class with none is absent. */
export const ProblemCounts = z.partialRecord(
  z.enum(PROBLEM_CLASSES),
  z.int().min(1),
);
export type ProblemCounts = z.infer<typeof ProblemCounts>;

/** The count of each class among some problems, in the closed list's order. */
export const problemCounts = (
  problems: ReadonlyArray<Pick<Problem, "class">>,
): ProblemCounts => {
  const out: Partial<Record<ProblemClass, number>> = {};
  for (const name of PROBLEM_CLASSES) {
    const count = problems.filter((p) => p.class === name).length;
    if (count > 0) out[name] = count;
  }
  return out;
};

const problem = (name: ProblemClass, text: string): Problem => ({
  class: name,
  text,
});

/** The schema's issues in plain words, each one problem of the class `not-the-schema`. */
const schemaProblems = (error: z.ZodError): Array<Problem> =>
  error.issues
    .slice(0, 12)
    .map((issue) =>
      problem(
        "not-the-schema",
        `${issue.path.length === 0 ? "The answer" : issue.path.join(".")}: ${issue.message}.`,
      ),
    );

/** Where an answer lists one section: the section number and the list's name in plain words. */
interface Placement {
  readonly s: number;
  readonly where: string;
}

/** The words of a missing or repeated listing, which differ between the two answers. */
interface ListingWords {
  readonly missing: (section: number) => string;
  readonly repeated: (section: number, count: number) => string;
}

/**
 * Section indices listed exactly once, and the problems of the others: a number the reading does
 * not list (`unknown-section`, which judges nothing), a section listed nowhere (`missing-row`) and
 * one listed more than once, in one list or several (`duplicate-row`). Neither of the last two is
 * ever given a judgement: it is unanswered, read once more, then not judged.
 */
const listingsOf = (
  placements: ReadonlyArray<Placement>,
  index: ReadingIndex,
  words: ListingWords,
) => {
  const listed = new Set(index.sections.map((section) => section.index));
  const counts = new Map<number, number>();
  const problems: Array<Problem> = [];
  for (const { s, where } of placements) {
    if (!listed.has(s)) {
      problems.push(
        problem(
          "unknown-section",
          `${where} lists section ${s}, which this reading does not list.`,
        ),
      );
      continue;
    }
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  for (const section of index.sections) {
    const count = counts.get(section.index) ?? 0;
    if (count === 0)
      problems.push(problem("missing-row", words.missing(section.index)));
    else if (count > 1)
      problems.push(
        problem("duplicate-row", words.repeated(section.index, count)),
      );
  }
  const single = new Set(
    [...counts].filter(([, count]) => count === 1).map(([section]) => section),
  );
  const unanswered = index.sections
    .map((section) => section.index)
    .filter((section) => !single.has(section));
  return { problems, single, unanswered };
};

const ASSESS_LISTING: ListingWords = {
  missing: (s) =>
    `Section ${s} is in no class; list every section in exactly one class.`,
  repeated: (s, count) =>
    `Section ${s} is listed ${count} times; list it once, in exactly one class.`,
};

const REVIEW_LISTING: ListingWords = {
  missing: (s) => `Section ${s} has no verdict; list it once, under a, r or u.`,
  repeated: (s, count) =>
    `Section ${s} is listed ${count} times; list it once, under one of a, r or u.`,
};

const assessPlacements = (
  answer: Pick<StoredAssessAnswer, "classes">,
): Array<Placement> =>
  answer.classes.flatMap((entry, at) =>
    entry.S.map((s) => ({ s, where: `Class ${at}` })),
  );

const reviewPlacements = (answer: LaneReviewAnswer): Array<Placement> =>
  verdictsOf(answer).map(({ s, v }) => ({ s, where: `The ${v} list` }));

/**
 * How an answer's sections fall into its classes, as numbers only, from the answer as the reading
 * gave it: how many classes (Assess; null for Lane review, whose lists are its verdicts) and how
 * many of the reading's sections are outside the largest class (or verdict list). Null when the
 * answer is not the schema.
 */
export const groupingOf = (
  kind: "assess" | "lane-review",
  raw: unknown,
  index: ReadingIndex,
): { readonly classes: number | null; readonly outside: number } | null => {
  const listed = new Set(index.sections.map((section) => section.index));
  const largest = (lists: ReadonlyArray<ReadonlyArray<number>>) =>
    Math.max(
      0,
      ...lists.map((list) => new Set(list.filter((s) => listed.has(s))).size),
    );
  if (kind === "assess") {
    // Either form: only the classes are read here. The base form first, as before.
    const base = AssessAnswer.safeParse(raw);
    const parsed = base.success ? base : AssessTestedAnswer.safeParse(raw);
    if (!parsed.success) return null;
    return {
      classes: parsed.data.classes.length,
      outside:
        index.sections.length -
        largest(parsed.data.classes.map((entry) => entry.S)),
    };
  }
  const base = LaneReviewAnswer.safeParse(raw);
  const parsed = base.success ? base : LaneReviewScopedAnswer.safeParse(raw);
  if (!parsed.success) return null;
  return {
    classes: null,
    outside:
      index.sections.length -
      largest(VERDICT_KEYS.map((v) => parsed.data.sections[v])),
  };
};

/**
 * The classes of problem code repairs without spending a turn on them, counted but never sent
 * back: an unknown cite is dropped; an empty text is treated as missing (`empty-text`); text over its bound is clipped; a list over its cap, comments
 * past three in a section included, is kept whole; a comment over its bound is withheld alone.
 * Every other class is sent back once, as before.
 */
export const REPAIRED_WITHOUT_A_TURN: ReadonlySet<ProblemClass> = new Set([
  "unknown-cite",
  "empty-text",
  "clipped-text",
  "over-cap",
  "too-many-comments",
  "long-comment",
]);

// ---------------------------------------------------------------------------------------------
// Size: clipped text and lists over their caps
// ---------------------------------------------------------------------------------------------

/** A text's length in characters (code points), as its bound counts it. */
const lengthOf = (t: string) => [...t].length;

/** The ellipsis a clipped text ends with. */
export const CLIPPED = "\u2026";

/**
 * A text clipped to its bound in characters, never inside a character: when it is cut, it is cut
 * at the last word boundary inside the bound and ends with an ellipsis, which the bound counts. A
 * text with no boundary there (one long word) is cut at the bound, still with the ellipsis.
 */
export const clip = (t: string, bound: number) => {
  if (lengthOf(t) <= bound) return t;
  if (bound <= 0) return "";
  const points = [...t];
  const room = points.slice(0, bound - 1);
  // A cut that falls just before a space keeps the whole last word.
  const whole = /\s/u.test(points[bound - 1] ?? "");
  let end = room.length;
  if (!whole) {
    const space = room.findLastIndex((point) => /\s/u.test(point));
    if (space > 0) end = space;
  }
  return `${room.slice(0, end).join("").trimEnd()}${CLIPPED}`;
};

/** A text over its bound: it is clipped for storage, never sent back. */
const overLength = (
  problems: Array<Problem>,
  label: string,
  t: string,
  bound: number,
) => {
  const length = lengthOf(t);
  if (length > bound)
    problems.push(
      problem(
        "clipped-text",
        `${label} is ${length} characters; at most ${bound}. It is kept clipped to ${bound}.`,
      ),
    );
};

/** A list over its cap: it is kept whole and counted, never sent back. */
const overCap = (
  problems: Array<Problem>,
  label: string,
  count: number,
  cap: number,
) => {
  if (count > cap)
    problems.push(
      problem(
        "over-cap",
        `${label} has ${count} entries; at most ${cap}. Every one is kept.`,
      ),
    );
};

/** Whether a text holds nothing but white space: code treats it as missing. */
const blank = (t: string) => t.trim() === "";

/**
 * An empty text: counted, never sent back. What code does with it is in the repair: a reason for a
 * person's need, a comment and an unsure note are taken as not given; a factor's or requirement's
 * text, a gap's name or words and a checked line are kept empty. No decision reads those words: the
 * lane rule reads a factor's and a requirement's cites, a requirement's coverage (from its proof)
 * and a gap's axis, so the entry decides exactly what it would with words; and an empty checked
 * line still leaves nothing checked for an approval (`nothing-checked`).
 */
const emptyText = (problems: Array<Problem>, label: string, t: string) => {
  if (blank(t)) problems.push(problem("empty-text", `${label} is empty.`));
};

/** An Assess answer's texts over their bounds and lists over their caps. */
const assessSizes = (answer: AnyAssessAnswer, index: ReadingIndex) => {
  const out: Array<Problem> = [];
  const B = ANSWER_BOUNDS;
  const sections = index.sections.length;
  overCap(out, "The factor table", answer.factors.length, B.factors);
  overCap(
    out,
    "The requirement table",
    answer.requirements.length,
    B.requirements,
  );
  overCap(out, "The impact table", answer.impact.length, sections);
  overCap(out, "The class list", answer.classes.length, sections);
  answer.factors.forEach((f, i) => {
    emptyText(out, `Factor ${i}'s text`, f.t);
    overLength(out, `Factor ${i}'s text`, f.t, B.factorText);
    overCap(out, `Factor ${i}'s cites`, f.cites.length, B.assessCites);
  });
  requirementsOf(answer).forEach((r, i) => {
    emptyText(out, `Requirement ${i}'s text`, r.t);
    overLength(out, `Requirement ${i}'s text`, r.t, B.requirementText);
    overLength(out, `Requirement ${i}'s untested`, r.untested, B.untestedText);
    if (r.testedBy !== undefined)
      overCap(
        out,
        `Requirement ${i}'s testedBy`,
        r.testedBy.length,
        B.assessCites,
      );
    overCap(out, `Requirement ${i}'s cites`, r.cites.length, B.assessCites);
    overCap(out, `Requirement ${i}'s proof`, r.proof.length, B.proof);
    overCap(out, `Requirement ${i}'s kinds`, r.kinds.length, B.kinds);
  });
  answer.impact.forEach((entry, i) => {
    overLength(out, `Impact entry ${i}'s text`, entry.t, B.impactText);
    overCap(
      out,
      `Impact entry ${i}'s cites`,
      entry.cites.length,
      B.assessCites,
    );
  });
  answer.classes.forEach((entry, i) => {
    overCap(out, `Class ${i}'s sections`, entry.S.length, B.sections);
    overCap(out, `Class ${i}'s factors`, entry.F.length, B.factors);
    overCap(out, `Class ${i}'s requirements`, entry.R.length, B.requirements);
    if (entry.person !== null) {
      emptyText(out, `Class ${i}'s reason`, entry.person.why);
      overLength(out, `Class ${i}'s reason`, entry.person.why, B.personWhy);
    }
    overCap(out, `Class ${i}'s gaps`, (entry.gaps ?? []).length, B.gaps);
    (entry.gaps ?? []).forEach((gap, g) => {
      emptyText(out, `Class ${i}'s gap ${g} name`, gap.kind);
      emptyText(out, `Class ${i}'s gap ${g}`, gap.t);
      overLength(out, `Class ${i}'s gap ${g} name`, gap.kind, B.gapKind);
      overLength(out, `Class ${i}'s gap ${g}`, gap.t, B.gapText);
    });
  });
  return out;
};

/** A Lane review comment over its bound: withheld alone, never clipped (`long-comment`). */
const tooLong = (comment: { readonly t: string }) =>
  lengthOf(comment.t) > ANSWER_BOUNDS.commentText;

/** A Lane review answer's texts over their bounds and lists over their caps. */
const reviewSizes = (answer: LaneReviewAnswer) => {
  const out: Array<Problem> = [];
  const B = ANSWER_BOUNDS;
  overCap(out, "The file list", answer.files.length, B.files);
  answer.files.forEach((entry, i) => {
    emptyText(out, `File entry ${i}'s checked line`, entry.checked);
    overLength(
      out,
      `File entry ${i}'s checked line`,
      entry.checked,
      B.checkedText,
    );
    overCap(out, `File entry ${i}'s rows`, (entry.rows ?? []).length, B.rows);
    // An empty reading is not counted: it shows nothing, and no decision reads a reading.
    (entry.rows ?? []).forEach((row, r) => {
      overLength(
        out,
        `File entry ${i}'s row ${r} reading`,
        row.reading,
        B.readingText,
      );
      overCap(
        out,
        `File entry ${i}'s row ${r} cites`,
        row.cites.length,
        B.cites,
      );
    });
  });
  for (const v of VERDICT_KEYS)
    overCap(out, `The ${v} list`, answer.sections[v].length, B.sections);
  overCap(
    out,
    "The comment list",
    answer.comments.length,
    B.sections * B.commentsPerSection,
  );
  answer.comments.forEach((comment, i) => {
    emptyText(out, `Comment ${i}`, comment.t);
    overCap(out, `Comment ${i}'s cites`, comment.cites.length, B.cites);
    overLength(out, `Comment ${i}'s failure path`, comment.fails, B.failsText);
    if (tooLong(comment))
      out.push(
        problem(
          "long-comment",
          `Comment ${i} is ${lengthOf(comment.t)} characters; at most ${B.commentText}, so it is withheld.`,
        ),
      );
  });
  overCap(out, "The unsure list", answer.unsure.length, B.sections);
  answer.unsure.forEach((entry, i) => {
    emptyText(out, `Unsure entry ${i}`, entry.t);
    overLength(out, `Unsure entry ${i}`, entry.t, B.unsureText);
  });
  return out;
};

// ---------------------------------------------------------------------------------------------
// Assess: problems, repair, expand
// ---------------------------------------------------------------------------------------------

/** Every hard problem of an Assess answer, with its class and its plain words for a repair turn. */
export const assessIssues = (
  raw: unknown,
  index: ReadingIndex,
  /** Scope and tests: the answer is held to `AssessTestedAnswer` instead. */
  scopeAndTests = false,
): ReadonlyArray<Problem> => {
  const parsed = scopeAndTests
    ? AssessTestedAnswer.safeParse(raw)
    : AssessAnswer.safeParse(raw);
  if (!parsed.success) return schemaProblems(parsed.error);
  const answer: AnyAssessAnswer = parsed.data;
  const problems = [
    ...listingsOf(assessPlacements(answer), index, ASSESS_LISTING).problems,
    ...assessSizes(answer, index),
  ];
  const proofs = new Set(index.proofs.map((proof) => proof.id));
  const listed = new Set(index.sections.map((section) => section.index));
  const cited = (label: string, cites: ReadonlyArray<string>) => {
    const unknown = unknownOf(index, cites);
    if (unknown.length > 0)
      problems.push(
        problem(
          "unknown-cite",
          `${label} cites ${unknown.join(", ")}, which this reading does not list.`,
        ),
      );
  };
  answer.factors.forEach((f, i) => cited(`Factor ${i}`, f.cites));
  requirementsOf(answer).forEach((r, i) => {
    cited(`Requirement ${i}`, r.cites);
    if (r.testedBy !== undefined) {
      // An empty cite names nothing: an unknown cite, dropped without a turn. Any other cite that
      // is not a changed row of a shown test section is refused and sent back once.
      cited(
        `Requirement ${i}'s testedBy`,
        r.testedBy.filter((cite) => blank(cite)),
      );
      const off = r.testedBy.filter(
        (cite) => !blank(cite) && !testRow(index, cite),
      );
      if (off.length > 0)
        problems.push(
          problem(
            "unknown-test",
            `Requirement ${i}'s testedBy cites ${off.join(", ")}, which ${off.length === 1 ? "is not a changed row" : "are not changed rows"} of a file declared test that this reading shows.`,
          ),
        );
    }
    // An empty proof ID names nothing: an unknown cite, dropped without a turn.
    cited(
      `Requirement ${i}'s proof list`,
      r.proof.filter((id) => blank(id)),
    );
    const unknown = r.proof.filter((id) => !blank(id) && !proofs.has(id));
    if (unknown.length > 0)
      problems.push(
        problem(
          "unknown-proof",
          `Requirement ${i} names ${unknown.join(", ")}, which ${unknown.length === 1 ? "is" : "are"} not a proof record of this reading.`,
        ),
      );
  });
  answer.impact.forEach((entry, i) => {
    if (!listed.has(entry.s))
      problems.push(
        problem(
          "unknown-section",
          `Impact entry ${i} names section ${entry.s}, which this reading does not list.`,
        ),
      );
    // Counted, never sent back: the entry is kept under code's words for its effect.
    if (!WORDED.test(entry.t))
      problems.push(
        problem(
          "empty-text",
          `Impact entry ${i} has no letter or digit, so it is kept in code's words for its effect.`,
        ),
      );
    cited(`Impact entry ${i}`, entry.cites);
  });
  for (const [at, { F, R }] of answer.classes.entries()) {
    for (const f of F)
      if (f >= answer.factors.length)
        problems.push(
          problem(
            "index-out-of-range",
            `Class ${at} names factor ${f}; there ${answer.factors.length === 1 ? "is 1 factor" : `are ${answer.factors.length} factors`} (numbered from 0).`,
          ),
        );
    for (const r of R)
      if (r >= answer.requirements.length)
        problems.push(
          problem(
            "index-out-of-range",
            `Class ${at} names requirement ${r}; there ${answer.requirements.length === 1 ? "is 1 requirement" : `are ${answer.requirements.length} requirements`} (numbered from 0).`,
          ),
        );
  }
  return problems;
};

/** Every hard problem of an Assess answer, in plain words for a repair turn. */
export const assessProblems = (
  raw: unknown,
  index: ReadingIndex,
): ReadonlyArray<string> => assessIssues(raw, index).map((p) => p.text);

/**
 * What code does when the reading does not fix its answer: cites that do not resolve and proof
 * IDs that are not the reading's are dropped (a factor or requirement left with none is uncited),
 * indices that name nothing are dropped, and impact entries on no listed section are dropped; one
 * whose text has no letter or digit is kept with its effect and cites, in code's words for its
 * effect (`IMPACT_WORDS`), so no effect is lost and no summary is shown with none. Text over its bound is
 * clipped to it; a list over its cap is kept whole, so no factor, requirement, class or section is
 * ever dropped to fit a cap. A section listed in no
 * class, or more than once, is taken out of every class and returned as unanswered: the caller
 * reads it once more, then records it not judged; a class left with no section is dropped. A
 * non-schema answer leaves every section unanswered. Repairing the result again changes nothing.
 * A new answer is held to `AssessAnswer`, so one whose impact entry gives `added` is not the schema.
 * With scope and tests on it is held to `AssessTestedAnswer`, and a `testedBy` cite that is not a
 * shown test row (`testRow`) is dropped.
 */
export function assessRepair(
  raw: unknown,
  index: ReadingIndex,
  scopeAndTests?: false,
): {
  readonly answer: AssessAnswer | null;
  readonly unanswered: ReadonlyArray<number>;
};
export function assessRepair(
  raw: unknown,
  index: ReadingIndex,
  scopeAndTests: boolean,
): {
  readonly answer: AnyAssessAnswer | null;
  readonly unanswered: ReadonlyArray<number>;
};
export function assessRepair(
  raw: unknown,
  index: ReadingIndex,
  scopeAndTests = false,
): {
  readonly answer: AnyAssessAnswer | null;
  readonly unanswered: ReadonlyArray<number>;
} {
  const parsed = scopeAndTests
    ? AssessTestedAnswer.safeParse(raw)
    : AssessAnswer.safeParse(raw);
  return parsed.success
    ? repairParsed(parsed.data as AnyAssessAnswer, index)
    : {
        answer: null,
        unanswered: index.sections.map((section) => section.index),
      };
}

/** The repair of a parsed answer, new or stored; it keeps every impact entry's effect as given. */
function repairParsed(
  answer: AssessAnswer,
  index: ReadingIndex,
): {
  readonly answer: AssessAnswer;
  readonly unanswered: ReadonlyArray<number>;
};
function repairParsed(
  answer: AnyAssessAnswer,
  index: ReadingIndex,
): {
  readonly answer: AnyAssessAnswer;
  readonly unanswered: ReadonlyArray<number>;
};
function repairParsed(
  answer: StoredAssessAnswer,
  index: ReadingIndex,
): {
  readonly answer: StoredAssessAnswer;
  readonly unanswered: ReadonlyArray<number>;
};
function repairParsed(
  answer: StoredAssessAnswer,
  index: ReadingIndex,
): {
  readonly answer: StoredAssessAnswer;
  readonly unanswered: ReadonlyArray<number>;
} {
  const B = ANSWER_BOUNDS;
  const proofs = new Set(index.proofs.map((proof) => proof.id));
  const listed = new Set(index.sections.map((section) => section.index));
  const { single, unanswered } = listingsOf(
    assessPlacements(answer),
    index,
    ASSESS_LISTING,
  );
  return {
    answer: {
      factors: answer.factors.map((f) => ({
        ...f,
        t: clip(f.t, B.factorText),
        cites: known(index, f.cites),
      })),
      requirements: requirementsOf(answer).map((r) => ({
        ...r,
        t: clip(r.t, B.requirementText),
        untested: clip(r.untested, B.untestedText),
        cites: known(index, r.cites),
        proof: r.proof.filter((id) => proofs.has(id)),
        // The tested form only: a cite that is not a shown test row is dropped.
        ...(r.testedBy === undefined
          ? {}
          : { testedBy: r.testedBy.filter((cite) => testRow(index, cite)) }),
      })),
      impact: answer.impact
        .filter((entry) => listed.has(entry.s))
        .map((entry) => ({
          ...entry,
          t: WORDED.test(entry.t)
            ? clip(entry.t, B.impactText)
            : IMPACT_WORDS[entry.effect],
          cites: known(index, entry.cites),
        })),
      classes: answer.classes
        .map((entry) => ({
          ...entry,
          S: entry.S.filter((s) => single.has(s)),
          F: entry.F.filter((f) => f < answer.factors.length),
          R: entry.R.filter((r) => r < answer.requirements.length),
          // A person's need with no reason is no answer, which counts as yes (`assessExpand`).
          person:
            entry.person === null || blank(entry.person.why)
              ? null
              : { ...entry.person, why: clip(entry.person.why, B.personWhy) },
          gaps:
            entry.gaps === null
              ? null
              : entry.gaps.map((gap) => ({
                  ...gap,
                  kind: clip(gap.kind, B.gapKind),
                  t: clip(gap.t, B.gapText),
                })),
        }))
        .filter((entry) => entry.S.length > 0),
      // Every requirement is of the answer's one form, so the repaired answer is of that form.
    } as StoredAssessAnswer,
    unanswered,
  };
}

export interface Anchor {
  readonly path: string;
  readonly side: "old" | "new";
  readonly startLine: number;
  readonly endLine: number;
}

/** One section's Assess judgement as code expands it; `decide.ts` adds coverage and proof state. */
export interface AssessJudgement {
  readonly complexity: {
    readonly level: "low" | "high";
    readonly factors: ReadonlyArray<{
      readonly factor: string;
      readonly finding: string;
      readonly cites: ReadonlyArray<string>;
      readonly uncited: boolean;
    }>;
  };
  readonly easeOfValidation: {
    readonly level: "easy" | "hard";
    readonly requirements: ReadonlyArray<{
      readonly requirement: string;
      readonly cites: ReadonlyArray<string>;
      readonly proof: ReadonlyArray<string>;
      readonly kinds: ReadonlyArray<RowProof["kind"]>;
      readonly agree: boolean;
      readonly testable: boolean;
      readonly untested: string;
      /** The cited lines that fall on this section's owned lines; none anchors it to the section. */
      readonly anchors: ReadonlyArray<Anchor>;
      /**
       * Scope and tests only: the shown test rows the reading said exercise it, stored cites.
       * Context and a count: nothing that sets a gap, a level, a lane or a decision reads it.
       */
      readonly testedBy?: ReadonlyArray<string>;
    }>;
  };
  /**
   * What code wrote from the plan's facts (`code-facts.ts`), with their fact cites: beside the
   * factors the lane rule reads, never among them. A fact written for every section is not evidence
   * that a level is high, so nothing that weighs cited evidence counts these.
   */
  readonly codeFactors: ReadonlyArray<{
    readonly factor: CodeFactor["factor"];
    readonly finding: string;
    readonly cites: ReadonlyArray<string>;
  }>;
  readonly movement: ReadonlyArray<never>;
  readonly lean: {
    readonly lane: "agentic" | "human-suggested";
    readonly reason: string;
  } | null;
  readonly gaps: ReadonlyArray<{
    readonly axis: "complexity" | "ease-of-validation";
    readonly kind: string;
    readonly detail: string;
  }>;
  readonly impact: ReadonlyArray<{
    readonly effect: Effect;
    readonly text: string;
    readonly cites: ReadonlyArray<string>;
  }>;
}

/** The lines cites of a list that fall on a section's owned lines, clipped to them. */
const anchorsOf = (
  cites: ReadonlyArray<string>,
  section: ReadingSection,
  index: ReadingIndex,
): Array<Anchor> => {
  const out = new Map<string, Anchor>();
  for (const cite of cites) {
    const resolved = index.resolve(cite);
    if (resolved.kind !== "lines" || resolved.file !== section.file) continue;
    for (const owned of section.owned)
      if (owned.side === resolved.side && overlaps(owned, resolved)) {
        const anchor = {
          path: resolved.path,
          side: resolved.side,
          startLine: Math.max(owned.startLine, resolved.startLine),
          endLine: Math.min(owned.endLine, resolved.endLine),
        };
        out.set(`${anchor.side}:${anchor.startLine}-${anchor.endLine}`, anchor);
      }
  }
  return [...out.values()];
};

/**
 * Per answered section, in reading order, the Assess judgement in the stored form, after repair:
 * the values of the one class that lists it, the model's factors and impact entries followed by
 * code's (`ReadingSection.code`). A complex, easily validated section leans to a person unless the
 * reading said no person is needed; an absent answer counts as yes. A section no class lists is
 * not in the result: it is never given a judgement.
 *
 * It reads a stored answer (`StoredAssessAnswer`), so an older version's `added` impact entry
 * expands as it did then; a new answer never holds one, as the step stores only what passed
 * `AssessAnswer`.
 */
export const assessExpand = (
  raw: unknown,
  index: ReadingIndex,
): ReadonlyArray<{
  readonly section: number;
  readonly key: string;
  readonly judgement: AssessJudgement;
}> => {
  const parsed = StoredAssessAnswer.safeParse(raw);
  if (!parsed.success) return [];
  const { answer } = repairParsed(parsed.data, index);
  // After repair, every listed section is in exactly one class.
  const classOf = new Map(
    answer.classes.flatMap((entry) => entry.S.map((s) => [s, entry] as const)),
  );
  return index.sections.flatMap((section) => {
    const s = section.index;
    const entry = classOf.get(s);
    if (entry === undefined) return [];
    const { F: factors, R: requirements, person } = entry;
    const complex = entry.c === "h";
    const easy = entry.v === "e";
    const judgement: AssessJudgement = {
      complexity: {
        level: complex ? "high" : "low",
        factors: [
          ...factors.map((i) => {
            const f = answer.factors[i]!;
            const cites = stableOf(index, f.cites);
            return {
              factor: f.f,
              finding: f.t,
              cites,
              uncited: cites.length === 0,
            };
          }),
        ],
      },
      codeFactors: (section.code?.factors ?? []).map((f) => ({
        factor: f.factor,
        finding: f.finding,
        cites: [...f.cites],
      })),
      easeOfValidation: {
        level: easy ? "easy" : "hard",
        requirements: requirements.map((i) => {
          const r = requirementsOf(answer)[i]!;
          return {
            requirement: r.t,
            cites: stableOf(index, r.cites),
            proof: [...new Set(r.proof)],
            kinds: [...new Set(r.kinds)],
            agree: r.agree,
            testable: r.testable,
            untested: r.untested,
            anchors: anchorsOf(r.cites, section, index),
            // Context only: no gap, level, lane, proof state or decision reads it (`testedBy`).
            ...(r.testedBy === undefined
              ? {}
              : { testedBy: stableOf(index, r.testedBy) }),
          };
        }),
      },
      movement: [],
      lean:
        complex && easy
          ? person?.need === "no"
            ? { lane: "agentic", reason: person.why }
            : {
                lane: "human-suggested",
                reason:
                  person?.why ??
                  "The reading did not say whether a person is needed, so one is suggested.",
              }
          : null,
      gaps: (entry.gaps ?? []).map((gap) => ({
        axis: gap.axis,
        kind: gap.kind,
        detail: gap.t,
      })),
      impact: [
        ...answer.impact
          .filter((impact) => impact.s === s)
          .map((impact) => ({
            effect: impact.effect,
            text: impact.t,
            cites: stableOf(index, impact.cites),
          })),
        ...(section.code?.impact ?? []).map((impact) => ({
          effect: impact.effect,
          text: impact.text,
          cites: [...impact.cites],
        })),
      ],
    };
    return [{ section: s, key: section.key, judgement }];
  });
};

// ---------------------------------------------------------------------------------------------
// Lane review: problems, repair, expand
// ---------------------------------------------------------------------------------------------

type Comment = LaneReviewAnswer["comments"][number];

/** Whether a comment's lines are owned lines of its section, as `anchorResolves` reads an anchor. */
const onOwnedLines = (comment: Comment, section: ReadingSection) =>
  wellFormed(comment.start, comment.end) &&
  section.owned.some(
    (owned) =>
      owned.side === comment.side &&
      overlaps(owned, { startLine: comment.start, endLine: comment.end }),
  );

/** Whether any of a list of cites falls in a section: its owned lines, or a change fact about it. */
const fallsIn = (
  cites: ReadonlyArray<string>,
  section: number,
  index: ReadingIndex,
) =>
  cites.some((cite) => {
    const resolved = index.resolve(cite);
    return resolved.kind === "lines"
      ? resolved.sections.includes(section)
      : resolved.kind === "fact" && resolved.section === section;
  });

/** The proof records a file's rows may cite, with their currency for that file. */
const fileProofs = (index: ReadingIndex, path: string) =>
  new Map<string, RowProof>(
    index.proofs.map((proof) => [
      proof.id,
      {
        id: proof.id,
        kind: proof.kind,
        requirement: proof.requirement,
        currency: proof.currency[path],
      },
    ]),
  );

const proofCites = (index: ReadingIndex, cites: ReadonlyArray<string>) =>
  cites.filter((cite) => index.resolve(cite).kind === "proof");

/**
 * What in an answer has no target: a defect comment on a section the reading does not list, and a
 * not-met row under a file it does not list, each with its words for an unsure note.
 */
const orphansOf = (answer: LaneReviewAnswer, index: ReadingIndex) => {
  const sections = new Set(index.sections.map((s) => s.index));
  const files = new Set(index.files.map((f) => f.index));
  return [
    ...answer.comments
      .filter((c) => c.kind === "defect" && !sections.has(c.s))
      .map((c) =>
        written(
          `(Written for section ${c.s}, which this reading does not list.)`,
          c.t,
          UNSURE_TEXT,
        ),
      ),
    ...answer.files
      .filter((entry) => !files.has(entry.f))
      .flatMap((entry) =>
        (entry.rows ?? [])
          .filter((row) => row.status === "not-met")
          .map(
            (row) =>
              `Row ${row.row} was marked not met on file ${entry.f}, which this reading does not list.`,
          ),
      ),
  ];
};

/** A comment's words behind a note of where it was written, the words clipped to the text bound, never the note. */
const written = (note: string, text: string, bound: number) =>
  `${note} ${clip(text, Math.max(0, bound - lengthOf(note) - 1))}`;

/** The text bounds of a comment and of an unsure entry. */
const COMMENT_TEXT = ANSWER_BOUNDS.commentText;
const UNSURE_TEXT = ANSWER_BOUNDS.unsureText;

const linesWords = (comment: Comment) =>
  comment.start === comment.end
    ? `${comment.side} line ${comment.start}`
    : `${comment.side} lines ${comment.start}-${comment.end}`;

/**
 * The verdict breaches of each section row, judged on the answer as the reading wrote it, before
 * anything is dropped, so repair can never remove the evidence against an approval and let it
 * stand. A request for changes must rest on a defect comment anchored on its section's owned
 * lines. An approval cannot sit beside a defect comment in its section, anchored or not; beside a
 * not-met row whose cites fall in it, or that lands in no section of its file (a not-met row cannot
 * sit beside an approval); beside an unsure entry for it; without its file saying what was
 * checked; or anywhere in a reading whose answer holds an orphan (a defect comment on a section the
 * reading does not list, or a not-met row under a file it does not list), which has no target.
 * Every row a file entry holds counts, repeated or not given.
 */
const breachesOf = (answer: LaneReviewAnswer, index: ReadingIndex) => {
  const sections = new Map(index.sections.map((s) => [s.index, s]));
  const out = new Map<number, Map<string, Problem>>();
  const add = (s: number, name: ProblemClass, text: string) =>
    out.set(s, (out.get(s) ?? new Map()).set(text, problem(name, text)));
  const orphaned = orphansOf(answer, index).length > 0;
  for (const { s, v: verdict } of verdictsOf(answer)) {
    const section = sections.get(s);
    if (section === undefined || verdict === "u") continue;
    const defects = answer.comments.filter(
      (c) => c.s === s && c.kind === "defect",
    );
    if (verdict === "r") {
      // A request rests only on a defect that can be shown: one over its bound is withheld, and one
      // with no words is dropped, so neither can carry it.
      const shown = defects.filter((c) => !tooLong(c) && !blank(c.t));
      if (defects.length === 0)
        add(
          s,
          "request-without-defect",
          `Section ${s} requests changes with no defect comment in it; a request rests on a defect you found, or mark it a (approve) or u (unsure).`,
        );
      else if (shown.length === 0)
        add(
          s,
          // Counted as what dropped the last defect: an empty one, else a withheld one. Neither
          // costs a turn, and the section is unsure in the first repair.
          defects.some((c) => blank(c.t)) ? "empty-text" : "long-comment",
          `Section ${s} requests changes, but every defect comment in it is empty or over ${COMMENT_TEXT} characters and withheld, so the request cannot rest on one.`,
        );
      else if (!shown.some((c) => onOwnedLines(c, section)))
        add(
          s,
          "request-defect-off-lines",
          `Section ${s} requests changes, but none of its defect comments is on lines it owns; anchor the defect on the section's changed lines, or mark it u (unsure).`,
        );
      continue;
    }
    if (orphaned)
      add(
        s,
        "orphan",
        `Section ${s} is approved, but this answer holds a defect comment or a not-met row on a section or file this reading does not list; place it on a listed one, or mark the approvals u (unsure).`,
      );
    if (defects.length > 0)
      add(
        s,
        "approval-beside-defect",
        `Section ${s} is approved beside a defect comment in it; request changes, or record the concern as a risk or a question.`,
      );
    const entries = answer.files.filter((entry) => entry.f === section.file);
    const siblings = index.sections.filter((x) => x.file === section.file);
    for (const row of entries.flatMap((entry) => entry.rows ?? [])) {
      if (row.status !== "not-met") continue;
      if (fallsIn(row.cites, s, index))
        add(
          s,
          "approval-beside-not-met-row",
          `Section ${s} is approved, but row ${row.row} is not met on its lines; request changes resting on the defect, or mark the row no-evidence.`,
        );
      else if (!siblings.some((x) => fallsIn(row.cites, x.index, index)))
        add(
          s,
          "approval-beside-not-met-row",
          `Section ${s} is approved, but row ${row.row} is not met and its cites fall on no changed section of this file; an approval cannot sit beside a not-met row. Request changes resting on the defect, or mark the row no-evidence.`,
        );
    }
    if (answer.unsure.some((entry) => entry.s === s))
      add(
        s,
        "approval-beside-unsure",
        `Section ${s} is approved and also listed as unsure; mark it u, or remove its unsure entry.`,
      );
    if (entries.length === 0 || entries[0]!.checked.trim() === "")
      add(
        s,
        "nothing-checked",
        `Section ${s} is approved, but its file has no entry saying what was checked; add one.`,
      );
  }
  return out;
};

/** Every hard problem of a Lane review answer, with its class and its plain words for a repair turn. */
export const laneReviewIssues = (
  raw: unknown,
  index: ReadingIndex,
  /** Scope and tests: the answer is held to `LaneReviewScopedAnswer` instead. */
  scopeAndTests = false,
): ReadonlyArray<Problem> => {
  const parsed = scopeAndTests
    ? LaneReviewScopedAnswer.safeParse(withReadings(raw))
    : LaneReviewAnswer.safeParse(withReadings(raw));
  if (!parsed.success) return schemaProblems(parsed.error);
  const answer: AnyLaneReviewAnswer = parsed.data;
  const problems = [
    ...listingsOf(reviewPlacements(answer), index, REVIEW_LISTING).problems,
    ...reviewSizes(answer),
  ];
  const files = new Map(index.files.map((file) => [file.index, file]));
  const sections = new Map(index.sections.map((s) => [s.index, s]));
  const cited = (label: string, cites: ReadonlyArray<string>) => {
    const unknown = unknownOf(index, cites);
    if (unknown.length > 0)
      problems.push(
        problem(
          "unknown-cite",
          `${label} cites ${unknown.join(", ")}, which this reading does not list.`,
        ),
      );
  };
  const seenFiles = new Set<number>();
  for (const entry of answer.files) {
    const file = files.get(entry.f);
    if (file === undefined) {
      problems.push(
        problem(
          "unknown-file",
          `File ${entry.f} is not a file of this reading.`,
        ),
      );
      continue;
    }
    if (seenFiles.has(entry.f))
      problems.push(
        problem("duplicate-file", `File ${entry.f} has more than one entry.`),
      );
    seenFiles.add(entry.f);
    const rows = new Map(file.rows.map((row) => [row.row, row]));
    const proofs = fileProofs(index, file.path);
    const seenRows = new Set<string>();
    for (const row of entry.rows ?? []) {
      if (blank(row.row)) {
        problems.push(
          problem(
            "empty-text",
            `File ${entry.f} judges a row with an empty ID, so it is taken as not given.`,
          ),
        );
        continue;
      }
      if (!rows.has(row.row)) {
        problems.push(
          problem(
            "row-not-given",
            `File ${entry.f} judges row ${row.row}, which it was not given; its rows are ${[...rows.keys()].join(", ") || "none"}.`,
          ),
        );
        continue;
      }
      if (seenRows.has(row.row))
        problems.push(
          problem(
            "row-judged-twice",
            `File ${entry.f} judges row ${row.row} more than once.`,
          ),
        );
      seenRows.add(row.row);
      cited(`Row ${row.row} of file ${entry.f}`, row.cites);
      if (row.status === "met") {
        const why = metProblem(
          { row: row.row, cites: proofCites(index, row.cites) },
          rows.get(row.row),
          proofs,
        );
        if (why !== undefined) problems.push(problem("met-refused", `${why}.`));
      }
    }
  }
  const perSection = new Map<number, Array<Comment>>();
  for (const [i, comment] of answer.comments.entries()) {
    const section = sections.get(comment.s);
    if (section === undefined) {
      problems.push(
        problem(
          "unknown-section",
          `Comment ${i} names section ${comment.s}, which this reading does not list.`,
        ),
      );
      continue;
    }
    perSection.set(comment.s, [...(perSection.get(comment.s) ?? []), comment]);
    if (!onOwnedLines(comment, section))
      problems.push(
        problem(
          "comment-off-lines",
          `Comment ${i} is on ${comment.side} lines ${comment.start}-${comment.end}, which are not lines section ${comment.s} owns; anchor it on that section's changed lines.`,
        ),
      );
    if (comment.kind === "impact" && comment.effect === null)
      problems.push(
        problem(
          "impact-without-effect",
          `Comment ${i} is an impact comment with no effect; say whether something is removed, disabled, narrowed, changed or added.`,
        ),
      );
    if (comment.kind !== "impact" && comment.effect !== null)
      problems.push(
        problem(
          "effect-off-impact",
          `Comment ${i} gives an effect, which only an impact comment carries.`,
        ),
      );
    if (comment.row !== null && blank(comment.row))
      problems.push(
        problem(
          "empty-text",
          `Comment ${i} names an empty row, so it is taken as naming none.`,
        ),
      );
    else if (comment.row !== null) {
      const rows = files.get(section.file)?.rows ?? [];
      if (!rows.some((row) => row.row === comment.row))
        problems.push(
          problem(
            "row-not-given",
            `Comment ${i} names row ${comment.row}, which section ${comment.s}'s file was not given.`,
          ),
        );
    }
    cited(`Comment ${i}`, comment.cites);
  }
  for (const [s, comments] of perSection)
    if (comments.length > ANSWER_BOUNDS.commentsPerSection)
      problems.push(
        problem(
          "too-many-comments",
          `Section ${s} has ${comments.length} comments; keep at most ${ANSWER_BOUNDS.commentsPerSection}, the ones that matter most.`,
        ),
      );
  for (const breaches of breachesOf(answer, index).values())
    problems.push(...breaches.values());
  for (const [i, entry] of answer.unsure.entries())
    if (!sections.has(entry.s))
      problems.push(
        problem(
          "unknown-section",
          `Unsure entry ${i} names section ${entry.s}, which this reading does not list.`,
        ),
      );
  const notAsked = notAskedOf(answer);
  if (notAsked !== undefined) {
    overCap(
      problems,
      "The notAsked list",
      notAsked.length,
      ANSWER_BOUNDS.sections,
    );
    const unsure = new Set(answer.sections.u);
    for (const s of notAsked)
      if (!sections.has(s))
        problems.push(
          problem(
            "unknown-section",
            `The notAsked list names section ${s}, which this reading does not list.`,
          ),
        );
      else if (!unsure.has(s))
        problems.push(
          problem(
            "not-asked-off-unsure",
            `Section ${s} is in the notAsked list but not under u; mark it u (unsure), or take it out of notAsked.`,
          ),
        );
  }
  return problems;
};

/** Every hard problem of a Lane review answer, in plain words for a repair turn. */
export const laneReviewProblems = (
  raw: unknown,
  index: ReadingIndex,
): ReadonlyArray<string> => laneReviewIssues(raw, index).map((p) => p.text);

/**
 * Unsure entries within the schema's bounds: past the entry count, the overflow folds into the
 * last entry as a count in plain words, never dropped silently.
 */
const boundedNotes = (
  entries: ReadonlyArray<{ readonly s: number; readonly t: string }>,
): Array<{ s: number; t: string }> => {
  const limit = ANSWER_BOUNDS.sections;
  if (entries.length <= limit)
    return entries.map((entry) => ({
      s: entry.s,
      t: clip(entry.t, UNSURE_TEXT),
    }));
  // The notes folded into the last entry beyond itself.
  const more = entries.length - limit;
  const tail = ` (and ${more} more ${more === 1 ? "note" : "notes"})`;
  const last = entries[limit - 1]!;
  return [
    ...entries
      .slice(0, limit - 1)
      .map((entry) => ({ s: entry.s, t: clip(entry.t, UNSURE_TEXT) })),
    { s: last.s, t: clip(last.t, UNSURE_TEXT - tail.length) + tail },
  ];
};

/**
 * What code does when the reading does not fix its Lane review answer. First, every section in
 * breach on the answer as written (`breachesOf`) becomes unsure: code never turns a request for
 * changes into an approval or the reverse, and never lets an approval stand once the evidence
 * against it is dropped; a request whose every defect comment is empty or over its bound is such
 * a breach, so it is unsure after this first repair and a second repair finds nothing to change.
 * Then: comments and unsure notes with no words are dropped; cites that do not resolve are dropped; file entries and rows the
 * reading did not give are dropped (the first entry of a repeated one is kept); a row's reading is
 * clipped to its bound; a row that cannot read met reads no-evidence and keeps its reading behind
 * code's words (`MET_READING`); a defect comment off its section's owned lines becomes a question on
 * the section's lines (its own side where the section owns lines there), its words behind a note
 * of where it was written, or an unsure note where the section owns no lines, and any other
 * comment off them is dropped; an orphan's words become an unsure note of the first answered section; a row
 * a comment names that its file was not given is cleared; an impact comment with no effect reads
 * changed and an effect on any other comment is cleared; unsure notes are clipped to their bound
 * and past forty fold into the last as a count. Comments past three in a section are kept. A
 * section listed under no verdict, or more than once, is taken out of every list and is
 * unanswered; each list keeps its sections in reading order. The repaired answer is always a valid
 * answer of the schema, and repairing it again gives it back unchanged.
 */
/** Code's words before the reading of a met that code refused: the code reads as meeting the row. */
export const MET_READING = "The code reads as meeting this";

/**
 * A refused met's reading: code's words, then the reading's own, clipped to the reading's bound. A
 * reading that already begins with code's words is not given them twice, and an empty one is
 * code's words alone.
 */
const metReading = (reading: string) => {
  const own = reading.trim();
  return clip(
    own.length === 0
      ? `${MET_READING}.`
      : own.startsWith(MET_READING)
        ? own
        : `${MET_READING}: ${own}`,
    ANSWER_BOUNDS.readingText,
  );
};

export function laneReviewRepair(
  raw: unknown,
  index: ReadingIndex,
  scopeAndTests?: false,
): {
  readonly answer: LaneReviewAnswer | null;
  readonly unanswered: ReadonlyArray<number>;
};
export function laneReviewRepair(
  raw: unknown,
  index: ReadingIndex,
  scopeAndTests: boolean,
): {
  readonly answer: AnyLaneReviewAnswer | null;
  readonly unanswered: ReadonlyArray<number>;
};
export function laneReviewRepair(
  raw: unknown,
  index: ReadingIndex,
  /**
   * Scope and tests: held to `LaneReviewScopedAnswer`, and `notAsked` keeps, in reading order and
   * once each, only the sections the repaired answer has under `u`.
   */
  scopeAndTests = false,
): {
  readonly answer: AnyLaneReviewAnswer | null;
  readonly unanswered: ReadonlyArray<number>;
} {
  const parsed = scopeAndTests
    ? LaneReviewScopedAnswer.safeParse(withReadings(raw))
    : LaneReviewAnswer.safeParse(withReadings(raw));
  if (!parsed.success)
    return {
      answer: null,
      unanswered: index.sections.map((section) => section.index),
    };
  const answer: AnyLaneReviewAnswer = parsed.data;
  const files = new Map(index.files.map((file) => [file.index, file]));
  const sections = new Map(index.sections.map((s) => [s.index, s]));
  const seenFiles = new Set<number>();
  const repairedFiles = answer.files.flatMap((entry) => {
    const file = files.get(entry.f);
    if (file === undefined || seenFiles.has(entry.f)) return [];
    seenFiles.add(entry.f);
    const rows = new Map(file.rows.map((row) => [row.row, row]));
    const proofs = fileProofs(index, file.path);
    const seenRows = new Set<string>();
    const kept = (entry.rows ?? []).flatMap((row) => {
      if (!rows.has(row.row) || seenRows.has(row.row)) return [];
      seenRows.add(row.row);
      const cites = known(index, row.cites);
      const refused =
        row.status === "met" &&
        metProblem(
          { row: row.row, cites: proofCites(index, cites) },
          rows.get(row.row),
          proofs,
        ) !== undefined;
      return [
        {
          ...row,
          // A refused met keeps the reading's words behind code's, never as a status.
          reading: refused
            ? metReading(row.reading)
            : clip(row.reading, ANSWER_BOUNDS.readingText),
          cites,
          status: refused ? ("no-evidence" as const) : row.status,
        },
      ];
    });
    return [
      {
        f: entry.f,
        checked: clip(entry.checked, ANSWER_BOUNDS.checkedText),
        rows: entry.rows === null ? null : kept,
      },
    ];
  });
  const commentsBySection = new Map<
    number,
    Array<{ readonly comment: Comment; readonly place: number }>
  >();
  // Words that survive with nowhere to anchor: unsure notes, by section.
  const notes: Array<{ s: number; t: string }> = [];
  for (const [place, comment] of answer.comments.entries()) {
    const section = sections.get(comment.s);
    if (section === undefined) continue;
    // A comment with no words says nothing to act on: it is dropped. The verdicts were judged on
    // the answer as written, so an approval beside it is still in breach, and a request whose only
    // defect it was rests on none and is not taken as a confirmed defect.
    if (blank(comment.t)) continue;
    // A comment over its bound is withheld alone; a defect's words stay, as an unsure note.
    if (tooLong(comment)) {
      if (comment.kind === "defect")
        notes.push({
          s: comment.s,
          t: written("(Withheld: too long to show.)", comment.t, UNSURE_TEXT),
        });
      continue;
    }
    const anchored = onOwnedLines(comment, section);
    if (!anchored && comment.kind !== "defect") continue;
    // A defect that cannot be anchored is never lost. It moves onto its section as a question, on
    // its own side where the section owns lines there, else on the section's first owned lines,
    // its words behind a note of where it was written. A section that owns no lines keeps the
    // words as an unsure note.
    const target = anchored
      ? undefined
      : (section.owned.find((owned) => owned.side === comment.side) ??
        section.owned[0]);
    const where = `(Written on ${linesWords(comment)}.)`;
    if (!anchored && target === undefined) {
      notes.push({ s: comment.s, t: written(where, comment.t, UNSURE_TEXT) });
      continue;
    }
    const rows = files.get(section.file)?.rows ?? [];
    const { effect, row, ...rest } = comment;
    const repaired: Comment = {
      ...rest,
      ...(target === undefined
        ? {}
        : {
            kind: "question" as const,
            side: target.side,
            start: target.startLine,
            end: target.endLine,
            t: written(where, comment.t, COMMENT_TEXT),
          }),
      cites: known(index, comment.cites),
      fails: clip(comment.fails, ANSWER_BOUNDS.failsText),
      effect: comment.kind === "impact" ? (effect ?? "changed") : null,
      row: row !== null && rows.some((r) => r.row === row) ? row : null,
    };
    commentsBySection.set(comment.s, [
      ...(commentsBySection.get(comment.s) ?? []),
      { comment: repaired, place },
    ]);
  }
  // Every kept comment stays, past three in a section too: the cap is a problem for the reading
  // to fix, and the unit's ranking already cuts what is shown while every comment keeps its rank
  // and fate. Cutting here lost comments, and a moved defect, now a question, would be cut by a
  // second repair of this repair's own output.
  const keptComments = [...commentsBySection.values()]
    .flat()
    .sort((a, b) => a.place - b.place)
    .map(({ comment }) => comment);
  // Breaches are judged on the answer as written, before anything above was dropped.
  const breaches = breachesOf(answer, index);
  const { single, unanswered } = listingsOf(
    reviewPlacements(answer),
    index,
    REVIEW_LISTING,
  );
  // An orphan's words go to the first answered section's unsure notes; with none answered, every
  // section is read again and there is nothing to put them on.
  const firstAnswered = index.sections.find((section) =>
    single.has(section.index),
  );
  if (firstAnswered !== undefined)
    for (const t of orphansOf(answer, index))
      notes.push({ s: firstAnswered.index, t });
  const placed = new Map(
    verdictsOf(answer)
      .filter(({ s }) => single.has(s))
      .map(({ s, v }) => [s, breaches.has(s) ? ("u" as const) : v] as const),
  );
  const listOf = (v: VerdictKey) =>
    index.sections
      .map((section) => section.index)
      .filter((s) => placed.get(s) === v);
  const repairedSections = { a: listOf("a"), r: listOf("r"), u: listOf("u") };
  return {
    answer: {
      files: repairedFiles,
      sections: repairedSections,
      comments: keptComments,
      unsure: boundedNotes([
        ...answer.unsure.filter(
          (entry) => sections.has(entry.s) && !blank(entry.t),
        ),
        ...notes,
      ]),
      ...(notAskedOf(answer) === undefined
        ? {}
        : {
            notAsked: repairedSections.u.filter((s) =>
              notAskedOf(answer)!.includes(s),
            ),
          }),
    },
    unanswered,
  };
}

/** One section's Lane review judgement as code expands it. */
export interface LaneReviewJudgement {
  readonly verdict: "approve" | "request-changes" | "unsure";
  readonly comments: ReadonlyArray<{
    readonly path: string;
    readonly side: "old" | "new";
    readonly startLine: number;
    readonly endLine: number;
    readonly kind: Comment["kind"];
    readonly effect?: Effect | undefined;
    readonly text: string;
    readonly cites: ReadonlyArray<string>;
    readonly fails: string;
    readonly row: string | null;
  }>;
  /** What was checked, once per file: the section takes its file's line. */
  readonly checked: string;
  readonly rows: ReadonlyArray<{
    readonly row: string;
    readonly status: "met" | "not-met" | "no-evidence";
    readonly cites: ReadonlyArray<string>;
    /**
     * What the reading says the changed code does about the row, never a status; empty or absent
     * where it gave none (an answer stored before readings, or a judgement built without one).
     */
    readonly reading?: string | undefined;
  }>;
  /**
   * The number of proof records the reading listed for this section's file: those of the stored
   * output's `listed.proofs` whose `currency` names the file's path, as the reading shows each
   * under "for file N". Absent where the judgement was built without the reading's index.
   */
  readonly fileProofs?: number | undefined;
  /** Why the reading was unsure of this section, where it said. */
  readonly unsure: ReadonlyArray<string>;
  /**
   * Scope and tests only: present, true, on a section the reading is unsure of because neither the
   * goal nor its done-when conditions ask for its change. A count only: the decision reads the
   * verdict, which is `unsure` wherever this is set.
   */
  readonly notAsked?: true;
}

const VERDICTS = {
  a: "approve",
  r: "request-changes",
  u: "unsure",
} as const;

/**
 * Per answered section, in reading order, the Lane review judgement in the stored form, after
 * repair. A section no list holds is not in the result: it is never given a verdict.
 */
export const laneReviewExpand = (
  raw: unknown,
  index: ReadingIndex,
): ReadonlyArray<{
  readonly section: number;
  readonly key: string;
  readonly judgement: LaneReviewJudgement;
}> => {
  // A stored answer of either form: the scoped one is repaired as the scoped form.
  const { answer } = laneReviewRepair(
    raw,
    index,
    LaneReviewScopedAnswer.safeParse(withReadings(raw)).success,
  );
  if (answer === null) return [];
  const notAsked = new Set(notAskedOf(answer) ?? []);
  const sections = new Map(index.sections.map((s) => [s.index, s]));
  const files = new Map(index.files.map((file) => [file.index, file]));
  const verdictOf = new Map(verdictsOf(answer).map(({ s, v }) => [s, v]));
  return index.sections.flatMap(({ index: s }) => {
    const verdict = verdictOf.get(s);
    if (verdict === undefined) return [];
    const section = sections.get(s)!;
    const path = files.get(section.file)?.path ?? "";
    const entry = answer.files.find((file) => file.f === section.file);
    return [
      {
        section: s,
        key: section.key,
        judgement: {
          verdict: VERDICTS[verdict],
          comments: answer.comments
            .filter((comment) => comment.s === s)
            .map((comment) => ({
              path,
              side: comment.side,
              startLine: comment.start,
              endLine: comment.end,
              kind: comment.kind,
              ...(comment.effect === null ? {} : { effect: comment.effect }),
              text: comment.t,
              cites: stableOf(index, comment.cites),
              fails: comment.fails,
              row: comment.row ?? null,
            })),
          checked: entry?.checked ?? "",
          rows: (entry?.rows ?? []).map((row) => ({
            row: row.row,
            status: row.status,
            cites: stableOf(index, row.cites),
            reading: row.reading,
          })),
          fileProofs: index.proofs.filter(
            (proof) => proof.currency[path] !== undefined,
          ).length,
          unsure: answer.unsure
            .filter((entry) => entry.s === s)
            .map((entry) => entry.t),
          ...(notAsked.has(s) ? { notAsked: true as const } : {}),
        },
      },
    ];
  });
};
