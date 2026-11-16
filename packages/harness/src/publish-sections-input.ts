import { canonicalJson, sha256Hex } from "@neuve/records-core";
import {
  AssembledReference,
  AssessedSection,
  Citation,
  FindingAbout,
  FindingKindV3,
  FindingSignal,
  GapKind,
  ImpactEffect,
  Lane,
  OwnedRange,
  SectionContent,
  SectionSide,
  Side,
  UnitSections,
  type Citation as CitationValue,
} from "@neuve/records-schema";
import { z } from "zod";
import { clipText } from "./publish.ts";
import { sectionKeySetHash } from "./section-identity.ts";

/**
 * What the new publisher (`publish-sections.ts`) is handed: one plain value per settled batch,
 * checked at the door by these schemas, and the pure checks and cleaning that decide what of it is
 * written. Nothing here reads Records.
 */

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "Expected 64 hex");

/** A section's identity as the sections lane's `sectionIdentities` gives it, whole. */
export const SettledIdentity = z.strictObject({
  key: Sha256Hex,
  parts: z.looseObject({
    path: z.string().min(1).max(4_096),
    kind: z.string(),
    name: z.string().nullable(),
    side: SectionSide.optional(),
  }),
  where: z
    .strictObject({ startLine: z.int().min(1), endLine: z.int().min(1) })
    .nullable(),
  renamedFrom: z.string().nullable(),
});

export const SettledSection = z.strictObject({
  identity: SettledIdentity,
  /** The sections lane's label, one line. */
  title: z.string(),
  /** At least one, each with its path and side; `whole-nontext` for a binary or mode-only change. */
  ownedRanges: z.array(OwnedRange).min(1),
  /**
   * The hunk ID of each owned range, in `ownedRanges`' order and one per range (`h` and 15 hex), so
   * a hunk resolves to its own lines. Absent keeps the blob as before. The checks hold it to that;
   * the schema takes any strings so a bad one refuses only its batch.
   */
  rangeHunks: z.array(z.string()).optional(),
  /** The judgement entry exactly as the lane rule read it; `entry.key` equals `identity.key`. */
  entry: AssessedSection,
  /**
   * The section's own Facts, Briefed and Explained. Briefed and Explained are the readers' briefing
   * step's when it ran for the section, and null when it did not.
   */
  content: SectionContent.optional(),
});
export type SettledSection = z.infer<typeof SettledSection>;

export const SettledComment = z.strictObject({
  /**
   * The caller's own ID, derived from the comment's content (a claim key, a stable hash or a
   * finder's ID): printable ASCII without spaces, at most 128 characters, unique in its unit. The
   * checks hold it to that; the schema takes any string so a bad one refuses only its batch.
   */
  id: z.string(),
  /** The section key it is about; null for the whole unit. */
  section: z.string().nullable(),
  kind: FindingKindV3,
  /** Required on an impact comment. */
  effect: ImpactEffect.optional(),
  /** Required on an impact comment: one line, at most 300 characters. */
  summary: z.string().optional(),
  about: FindingAbout,
  signal: FindingSignal.optional(),
  body: z.string(),
  anchor: z
    .strictObject({
      path: z.string().min(1).max(4_096),
      side: Side,
      startLine: z.int().min(1),
      endLine: z.int().min(1),
    })
    .optional(),
  /** Already in the records' Citation form; one that does not parse is left out. */
  evidence: z.array(
    z.strictObject({ ref: z.string(), entry: z.string().optional() }),
  ),
  /** The desk shows it (the top of the ranking). */
  shown: z.boolean(),
  /** The unit's request for changes rests on it. */
  restedOn: z.boolean(),
});
export type SettledComment = z.infer<typeof SettledComment>;

export const SettledUnit = z.strictObject({
  path: z.string().min(1).max(4_096),
  lane: Lane,
  /** Any order; the publisher orders them. */
  sectionKeys: z.array(z.string()).min(1),
  verdict: z.enum(["approve", "request-changes"]).nullable(),
  /** What `applyLane` gave; absent records none. */
  disposition: z.enum(["approve", "request-changes"]).optional(),
  /** The disposition's note. */
  message: z.string().optional(),
  /** Proof record IDs an approval rests on. */
  proof: z.array(z.string()),
  /** Every comment on the unit, from readings and finders alike, in rank order. */
  comments: z.array(SettledComment),
  /** The Guided stop's content, when there is one. */
  guided: z.unknown().optional(),
  /** Only when an agent wrote one; otherwise the publisher writes it by code. */
  title: z.string().optional(),
  /**
   * The unit's lead, its Briefed stop: plain text with `[phrase](id)` links, at most
   * `BRIEFED_MAX` code points and not empty once trimmed. Absent writes no Briefed stop. The checks
   * hold it to that; the schema takes any string so a bad one refuses only its batch.
   */
  briefed: z.string().optional(),
  /**
   * The lane rule's version the unit's lane was applied under. Not in the contract's interface,
   * which gives none; absent means `SECTION_LANE_RULE`.
   */
  laneRule: z.int().min(3).max(1_000).optional(),
});
export type SettledUnit = z.infer<typeof SettledUnit>;

/** A gap about one batch (`unit` indexes `units`) or about the run. */
const SettledGap = z.strictObject({
  key: z.string().min(1),
  kind: GapKind,
  detail: z.string(),
  cause: z.string().optional(),
});

/** A context reference, as an assembled batch holds it; `unitIds` name units by key or handle. */
export const SettledReference = AssembledReference.extend({
  id: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, "Expected a short local ID"),
});

/** One done-when row of a batch digest, its units named by their index in the batch's `units`. */
const SettledObligation = z.strictObject({
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
});

export const SettledBatch = z.strictObject({
  /** The Map group's label. */
  title: z.string(),
  focus: z.string(),
  /** Every file of the group; the batch's key is the hash of these, sorted. */
  paths: z.array(z.string().min(1)).min(1),
  sections: z.array(SettledSection).min(1),
  units: z.array(SettledUnit).min(1),
  digest: z.strictObject({
    text: z.string(),
    verification: z.string().optional(),
    uncertainty: z.array(z.string()).optional(),
    limitations: z.array(z.string()).optional(),
    /** Who wrote `text`, `uncertainty` and `limitations`: the briefing step's model, or code. Absent is `code`. */
    source: z.enum(["agent", "code"]).optional(),
    /**
     * Each done-when row's status across the batch's units, as `BatchDigestContent.obligations`
     * holds it, except that `units[].unit` is the unit's index in `units`: the publisher gives the
     * handle. An index the batch does not hold refuses the batch (`checkBatch`).
     */
    obligations: z.array(SettledObligation).optional(),
  }),
  references: z.array(SettledReference).optional(),
  gaps: z
    .array(
      SettledGap.omit({ cause: true }).extend({
        unit: z.int().min(0).optional(),
      }),
    )
    .optional(),
});
export type SettledBatch = z.infer<typeof SettledBatch>;

export const SettledInput = z.strictObject({
  /** Settled since the last call, in the review's batch order; may be empty. */
  batches: z.array(SettledBatch),
  /** Of the whole review, for the pending counts. */
  totals: z.strictObject({
    batches: z.int().min(0),
    sections: z.int().min(0),
  }),
  /** This run publishes nothing after this call. */
  ending: z.boolean(),
  /** About the run, not one batch. */
  gaps: z.array(SettledGap),
  /** Every stage record so far, for completeness; only `status` is read. */
  stages: z.array(z.looseObject({ stage: z.string(), status: z.string() })),
});
export type SettledInput = z.infer<typeof SettledInput>;

/** The lane rule a unit's lane was applied under when the caller names none. */
export const SECTION_LANE_RULE = 3;

/** Comment IDs: printable ASCII without spaces, at most 128 characters. */
const COMMENT_ID = /^[\x21-\x7e]{1,128}$/;

/** A hunk ID as the harness writes it (`hunks.ts`): `h` and the first 15 hex of a SHA-256. */
const HUNK_ID = /^h[0-9a-f]{15}$/;

/** The most code points a unit's lead (`SettledUnit.briefed`) holds. */
export const BRIEFED_MAX = 600;

/** A batch's key: SHA-256 of the canonical JSON of its sorted paths. */
export const batchKeyOf = (paths: ReadonlyArray<string>) =>
  sha256Hex(
    canonicalJson(
      [...new Set(paths)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
  );

export const unitKeyOf = (unit: Pick<SettledUnit, "sectionKeys">) =>
  sectionKeySetHash(unit.sectionKeys);

export const unitHandle = (key: string) => `u.${key.slice(0, 16)}`;
export const batchHandle = (key: string) => `b.${key.slice(0, 16)}`;

/** The first 16 hex of a SHA-256: how a caller's text is named in a position key. */
export const short = (text: string) => sha256Hex(text).slice(0, 16);

const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Which check refused a batch, in a reader's words, and the technical cause for the run log. */
export interface Refusal {
  readonly check: string;
  readonly reason: string;
  readonly cause: string;
}

const refusal = (check: string, reason: string, cause: string): Refusal => ({
  check,
  reason,
  cause,
});

/** A line range on a path and side, or the file as a whole. */
type Owned = OwnedRange;

const sameFile = (a: Owned, b: Owned) => a.path === b.path && a.side === b.side;
const meets = (a: Owned, b: Owned) =>
  sameFile(a, b) &&
  (a.kind === "whole-nontext" ||
    b.kind === "whole-nontext" ||
    (a.startLine <= b.endLine && b.startLine <= a.endLine));

/** A lane's place in the order from static automation (0) to human-required (3). */
const laneRank = (lane: Lane) => Lane.options.indexOf(lane);

/**
 * Whether an entry's treatment holds together on its own and with its pattern's representative
 * (records design for code rules and families): an entry no agent decided is not also decided by a
 * rule alone, kept as context or another section's judgement; an excluded file carries no rule or
 * pattern; a rule's judgement names its rule; a pattern's member names another section, and when
 * that section is in the batch, both share the pattern's key and the member holds its judgement
 * (axes and review) whole. A representative may be in another batch, so its absence is no refusal.
 */
const treatmentRefusal = (
  key: string,
  entry: SettledSection["entry"],
  sections: ReadonlyMap<string, SettledSection>,
): Refusal | undefined => {
  const representative = entry.family?.representative;
  const member = representative !== undefined && representative !== key;
  const ruled = (entry.rules ?? []).length > 0;
  if (entry.undecided !== undefined) {
    const cause = entry.undecided.cause;
    if (entry.context === true)
      return refusal(
        "undecided-context",
        "a change marked as not decided was also kept as context of its file",
        `section ${key} is undecided (${cause}) and context`,
      );
    if (entry.origin?.assess === "rule" && entry.origin.review === "none")
      return refusal(
        "undecided-ruled",
        "a change marked as not decided was also marked as decided by a code rule alone",
        `section ${key} is undecided (${cause}) with origin rule and no review`,
      );
    if (member)
      return refusal(
        "undecided-pattern",
        "a change marked as not decided also carries the judgement of another change",
        `section ${key} is undecided (${cause}) and a member of ${representative}`,
      );
  }
  if (entry.excluded !== undefined && (ruled || entry.family !== undefined))
    return refusal(
      "excluded-judged",
      "a file marked as not read also carries a code rule's judgement or another change's",
      `section ${key} is excluded and holds ${ruled ? "rules" : "a family"}`,
    );
  if (entry.origin?.assess === "rule" && !ruled)
    return refusal(
      "rule-unnamed",
      "a change marked as judged by a code rule names no rule",
      `section ${key} has origin assess rule and no rules`,
    );
  if (entry.origin?.review === "family" && !member)
    return refusal(
      "pattern-unnamed",
      "a change marked as judged with another change of the same pattern names no other change",
      `section ${key} has origin review family and ${entry.family === undefined ? "no family" : "names itself"}`,
    );
  if (!member) return undefined;
  const held = sections.get(representative!)?.entry;
  if (held === undefined) return undefined;
  if (
    held.family?.key !== entry.family!.key ||
    canonicalJson(held.assess) !== canonicalJson(entry.assess) ||
    canonicalJson(held.review) !== canonicalJson(entry.review)
  )
    return refusal(
      "pattern-disagrees",
      "a change with the same pattern as another doesn't carry the same judgement",
      `section ${key} is a member of ${representative}, whose ${held.family?.key !== entry.family!.key ? "family key" : "judgement"} differs`,
    );
  return undefined;
};

/**
 * The checks before a batch is written (contract, "Checks before writing"): every section in
 * exactly one unit; a unit's sections all in its lane (a context section's at or below it), of its
 * one file, not all context; each entry the judgement of its own section, its treatment holding
 * together (`treatmentRefusal`); no owned line owned twice; each comment about a section of its
 * unit, with a usable ID that no other comment of the unit holds; each unit's sections as Records
 * stores them; and each of the digest's obligations naming units the batch holds, each once. The
 * first that fails refuses the whole batch.
 */
export const checkBatch = (batch: SettledBatch): Refusal | undefined => {
  const sections = new Map<string, SettledSection>();
  for (const section of batch.sections) {
    if (sections.has(section.identity.key))
      return refusal(
        "section-repeated",
        "one of its sections is listed twice",
        `section ${section.identity.key} is given twice`,
      );
    sections.set(section.identity.key, section);
  }
  const home = new Map<string, number>();
  for (const [index, unit] of batch.units.entries())
    for (const key of unit.sectionKeys) {
      if (!sections.has(key))
        return refusal(
          "section-in-no-unit",
          "a unit names a section the batch doesn't hold",
          `unit ${index} names section ${key}, which the batch does not hold`,
        );
      if (home.has(key))
        return refusal(
          "section-in-no-unit",
          "a section is in more than one unit",
          `section ${key} is in units ${home.get(key)} and ${index}`,
        );
      home.set(key, index);
    }
  for (const key of sections.keys())
    if (!home.has(key))
      return refusal(
        "section-in-no-unit",
        "a section is in no unit",
        `section ${key} is in no unit`,
      );
  const paths = new Set(batch.paths);
  for (const [index, unit] of batch.units.entries()) {
    if (!paths.has(unit.path))
      return refusal(
        "unit-path",
        "a unit's file isn't one of the batch's files",
        `unit ${index} is of ${unit.path}, not one of the batch's paths`,
      );
    for (const key of unit.sectionKeys) {
      const section = sections.get(key)!;
      if (section.entry.key !== section.identity.key)
        return refusal(
          "entry-key",
          "a section's judgement belongs to another section",
          `section ${key} carries the judgement of ${section.entry.key}`,
        );
      // A file marked as not read cannot also be one no agent decided: one of the two is wrong.
      if (
        section.entry.undecided !== undefined &&
        (section.entry as { excluded?: unknown }).excluded !== undefined
      )
        return refusal(
          "excluded-undecided",
          "a file marked as not read was also marked as not decided",
          `section ${key} has both excluded and undecided (${section.entry.undecided.cause})`,
        );
      const treated = treatmentRefusal(key, section.entry, sections);
      if (treated !== undefined) return treated;
      // The backstop: a section no agent decided is a person's to decide, so it sits at
      // human-required in a human-required unit. Nothing here raises or lowers a lane.
      if (
        section.entry.undecided !== undefined &&
        (section.entry.lane.applied !== "human-required" ||
          unit.lane !== "human-required")
      )
        return refusal(
          "undecided-not-for-person",
          "a part of it no agent decided wasn't marked for a person to decide",
          `section ${key} is undecided (${section.entry.undecided.cause}) at lane ${section.entry.lane.applied} in unit ${index} at ${unit.lane}`,
        );
      // A change kept as context takes no part in its unit's lane: its own may be lower, never
      // higher. Every other change sits in its unit's lane.
      if (section.entry.context === true) {
        if (laneRank(section.entry.lane.applied) > laneRank(unit.lane))
          return refusal(
            "context-lane",
            "a change kept as context of its file sits in a higher review lane than its unit",
            `context section ${key} has lane ${section.entry.lane.applied}; unit ${index} is ${unit.lane}`,
          );
      } else if (section.entry.lane.applied !== unit.lane)
        return refusal(
          "unit-lane",
          "a unit's sections don't all sit in its review lane",
          `section ${key} has lane ${section.entry.lane.applied}; unit ${index} is ${unit.lane}`,
        );
      if (section.identity.parts.path !== unit.path)
        return refusal(
          "unit-path",
          "a unit holds sections of more than one file",
          `section ${key} is of ${section.identity.parts.path}; unit ${index} is of ${unit.path}`,
        );
    }
    // A unit is made of the changes it judges: one holding only context would have no lane of its
    // own. An import-only file with nothing else is its own unit, with no context mark.
    if (
      unit.sectionKeys.every((key) => sections.get(key)!.entry.context === true)
    )
      return refusal(
        "context-only",
        "a unit holds only changes kept as context of its file",
        `unit ${index} holds only context sections`,
      );
    const ids = new Set<string>();
    const held = new Set(unit.sectionKeys);
    for (const comment of unit.comments) {
      if (!COMMENT_ID.test(comment.id) || ids.has(comment.id))
        return refusal(
          "comment-id",
          "a comment has no usable ID, or two comments of one unit share one",
          `unit ${index}: comment ID ${JSON.stringify(comment.id.slice(0, 140))} is ${ids.has(comment.id) ? "repeated" : "not printable ASCII of 1 to 128 characters without spaces"}`,
        );
      ids.add(comment.id);
      if (comment.section !== null && !held.has(comment.section))
        return refusal(
          "comment-section",
          "a comment is about a section its unit doesn't hold",
          `unit ${index}: comment ${comment.id} is about section ${comment.section}`,
        );
    }
    for (const key of unit.sectionKeys) {
      const { rangeHunks, ownedRanges } = sections.get(key)!;
      if (rangeHunks === undefined) continue;
      if (rangeHunks.length !== ownedRanges.length)
        return refusal(
          "range-hunks",
          "a section doesn't name one hunk for each of its changed line ranges",
          `section ${key} names ${rangeHunks.length} range hunks for ${ownedRanges.length} owned ranges`,
        );
      const bad = rangeHunks.find((id) => !HUNK_ID.test(id));
      if (bad !== undefined)
        return refusal(
          "range-hunks",
          "a section names a hunk with an ID that isn't a hunk's",
          `section ${key} names range hunk ${JSON.stringify(bad.slice(0, 40))}, not h and 15 hex`,
        );
    }
    if (unit.briefed !== undefined) {
      const points = [...unit.briefed].length;
      if (unit.briefed.trim() === "" || points > BRIEFED_MAX)
        return refusal(
          "unit-briefed",
          points > BRIEFED_MAX
            ? `a unit's lead is longer than ${BRIEFED_MAX} characters`
            : "a unit's lead is empty",
          `unit ${index}: briefed holds ${points} code points${points > BRIEFED_MAX ? "" : ", all space"}`,
        );
    }
    const blob = UnitSections.safeParse(unitSections(unit, sections));
    if (!blob.success)
      return refusal(
        "unit-sections",
        "the place of one of its sections in its file doesn't hold together",
        `unit ${index}: ${blob.error.issues[0]?.path.join(".") ?? ""}: ${blob.error.issues[0]?.message ?? blob.error.message}`,
      );
  }
  // No owned line owned twice: ranges sorted by file and start, each against the ones it can meet.
  const owned = batch.sections.flatMap((section) =>
    section.ownedRanges.map((range) => ({ range, key: section.identity.key })),
  );
  owned.sort(
    (a, b) =>
      byCodeUnits(a.range.path, b.range.path) ||
      byCodeUnits(a.range.side, b.range.side) ||
      (a.range.kind === "lines" ? a.range.startLine : 0) -
        (b.range.kind === "lines" ? b.range.startLine : 0),
  );
  for (let i = 0; i < owned.length; i++)
    for (let j = i + 1; j < owned.length; j++) {
      const a = owned[i]!;
      const b = owned[j]!;
      if (!sameFile(a.range, b.range)) break;
      if (
        b.range.kind === "lines" &&
        a.range.kind === "lines" &&
        b.range.startLine > a.range.endLine
      )
        break;
      if (meets(a.range, b.range))
        return refusal(
          "owned-twice",
          "two of its sections claim the same changed lines",
          `sections ${a.key} and ${b.key} both own lines of ${a.range.path} (${a.range.side})`,
        );
    }
  // An obligation names units by their index in `units`: each one the batch holds, once.
  for (const [index, obligation] of (
    batch.digest.obligations ?? []
  ).entries()) {
    const named = new Set<number>();
    for (const { unit } of obligation.units) {
      if (unit >= batch.units.length)
        return refusal(
          "obligation-unit",
          "an obligation of its digest names a unit the batch doesn't hold",
          `obligation ${index} (row ${JSON.stringify(obligation.row.slice(0, 64))}) names unit ${unit}; the batch holds ${batch.units.length}`,
        );
      if (named.has(unit))
        return refusal(
          "obligation-unit",
          "an obligation of its digest names one unit twice",
          `obligation ${index} (row ${JSON.stringify(obligation.row.slice(0, 64))}) names unit ${unit} twice`,
        );
      named.add(unit);
    }
  }
  return undefined;
};

const lineCount = (ranges: ReadonlyArray<Owned>) =>
  ranges.reduce(
    (n, range) =>
      range.kind === "lines" ? n + range.endLine - range.startLine + 1 : n,
    0,
  );

/** One line, control characters replaced, at most `max` characters; never empty. */
const oneLine = (text: string, max: number) =>
  clipText(text.replace(/[\n\t\r\u0085\u2028\u2029]/g, " "), max);

/** A unit's `sections` blob: its sections in key order, each whole as `UnitSection` stores it. */
export const unitSections = (
  unit: Pick<SettledUnit, "sectionKeys">,
  sections: ReadonlyMap<string, SettledSection>,
) => ({
  sections: [...new Set(unit.sectionKeys)].sort(byCodeUnits).map((key) => {
    const section = sections.get(key)!;
    // In file order, so the blob never follows the order the ranges arrived in; each range's hunk
    // ID, when given, moves with it.
    const paired = section.ownedRanges
      .map((range, at) => ({ range, hunk: section.rangeHunks?.[at] }))
      .sort(
        ({ range: a }, { range: b }) =>
          byCodeUnits(a.path, b.path) ||
          byCodeUnits(a.side, b.side) ||
          (a.kind === "lines" ? a.startLine : 0) -
            (b.kind === "lines" ? b.startLine : 0) ||
          (a.kind === "lines" ? a.endLine : 0) -
            (b.kind === "lines" ? b.endLine : 0),
      );
    return {
      key,
      parts: section.identity.parts,
      where: section.identity.where,
      renamedFrom: section.identity.renamedFrom,
      title: oneLine(section.title, 512),
      ownedRanges: paired.map(({ range }) => range),
      ...(section.rangeHunks === undefined
        ? {}
        : { rangeHunks: paired.map(({ hunk }) => hunk ?? "") }),
      ...(section.content === undefined ? {} : { content: section.content }),
    };
  }),
});

/** What `unit.recorded@3` counts of its blob: its ranges and the lines they cover. */
export const rangeCounts = (blob: ReturnType<typeof unitSections>) => {
  const ranges = blob.sections.flatMap((section) => section.ownedRanges);
  return { count: ranges.length, lines: lineCount(ranges) };
};

/**
 * A section's title without the unit's own file, which the unit's title names first. Section titles
 * name their file as `sectionLabel` writes them: "<name> in <file>", "imports in <file>",
 * "<file> at line <n>", or the file alone for a section with no lines; these read as "<name>",
 * "imports", "line <n>" and nothing. A title that names another file is kept whole.
 */
const withoutFile = (title: string, file: string) => {
  if (title === file) return undefined;
  if (title.endsWith(` in ${file}`))
    return title.slice(0, -` in ${file}`.length) || title;
  if (title.startsWith(`${file} at line `)) return title.slice(file.length + 4);
  return title;
};

/** The most characters a code-built unit title has. */
export const TITLE_MAX = 120;

/**
 * Text on one line (control characters replaced) of at most `max` characters, never empty. A longer
 * one ends at the last word boundary that fits, followed by "…", which counts inside `max`. A word
 * that alone is longer than that room is cut instead (at a code-point boundary) and ends with "…",
 * since no boundary would keep any of it.
 */
export const boundTitle = (text: string, max = TITLE_MAX) => {
  const line = text
    .replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]/g, " ")
    .trim();
  if (line === "") return "-";
  if (line.length <= max) return line;
  const hard = clipText(line, max - 1);
  // The cut falls between words when the next character is a space (or `clipText` trimmed one).
  if (/\s/.test(line[hard.length] ?? " ")) return `${hard}…`;
  // Otherwise it falls inside the word that starts here and ends at the next space.
  const start = hard.search(/\S*$/);
  const after = line.slice(hard.length).search(/\s/);
  const end = after === -1 ? line.length : hard.length + after;
  return start === 0 || end - start > max - 1
    ? `${hard}…`
    : `${hard.slice(0, start).trimEnd()}…`;
};

type BlobSection = ReturnType<typeof unitSections>["sections"][number];

/**
 * Where a section starts in its file, for ordering a unit's parts: the new side's start line (its
 * span's, else its first new-side owned line), else, for a section with only an old side, where it
 * was (its old span's start, else its first old-side owned line); 0, before every line, for a
 * section with no lines (file-level).
 */
const startInFile = (section: BlobSection) => {
  const owned = section.ownedRanges.flatMap((range) =>
    range.kind === "lines" ? [range] : [],
  );
  if (section.where !== null && section.parts.side !== "old")
    return section.where.startLine;
  const onNew = owned.filter((range) => range.side === "new");
  if (onNew.length > 0)
    return Math.min(...onNew.map((range) => range.startLine));
  if (section.where !== null) return section.where.startLine;
  return owned.length === 0
    ? 0
    : Math.min(...owned.map((range) => range.startLine));
};

/**
 * The lines a section covers in its file, read as `startInFile` reads its start: the new side's span,
 * else its new-side owned lines, else where it was on the old side (its old span, else its old-side
 * owned lines); none for a section with no lines (file-level).
 */
const linesInFile = (section: BlobSection) => {
  const owned = section.ownedRanges.flatMap((range) =>
    range.kind === "lines" ? [range] : [],
  );
  const spanOf = (ranges: ReadonlyArray<(typeof owned)[number]>) => ({
    startLine: Math.min(...ranges.map((range) => range.startLine)),
    endLine: Math.max(...ranges.map((range) => range.endLine)),
  });
  if (section.where !== null && section.parts.side !== "old")
    return section.where;
  const onNew = owned.filter((range) => range.side === "new");
  if (onNew.length > 0) return spanOf(onNew);
  if (section.where !== null) return section.where;
  return owned.length === 0 ? undefined : spanOf(owned);
};

/**
 * A unit's title written by code: its file's name, then the name of its first part in file order
 * (its section's title without that file) and how many parts follow ("and N more"), bounded at
 * `TITLE_MAX`. No lane is ever named: two units of one file are told apart by their parts. A section
 * titled by the file alone adds nothing to the file's name: the first part named is the first that
 * adds a name, a unit whose sections are all of that kind is titled by its file alone, and "N more"
 * counts every other part. `withLines` adds the named part's lines ("(lines 40–88)"; the first part
 * with lines when none is named) after it, outside the bound's cut, for two units of one file that
 * would otherwise share a title (`codeTitles`).
 */
export const codeTitle = (
  unit: SettledUnit,
  blob: ReturnType<typeof unitSections>,
  withLines = false,
) => {
  const file = unit.path.slice(unit.path.lastIndexOf("/") + 1) || unit.path;
  const inFile = [...blob.sections].sort(
    (a, b) => startInFile(a) - startInFile(b) || byCodeUnits(a.key, b.key),
  );
  const named = inFile.find(
    (section) => withoutFile(section.title, file) !== undefined,
  );
  const first =
    named === undefined ? undefined : withoutFile(named.title, file)!;
  const more =
    first === undefined || inFile.length === 1
      ? ""
      : ` and ${inFile.length - 1} more`;
  const span = withLines
    ? [named, ...inFile]
        .map((section) =>
          section === undefined ? undefined : linesInFile(section),
        )
        .find((lines) => lines !== undefined)
    : undefined;
  const lines =
    span === undefined
      ? ""
      : span.startLine === span.endLine
        ? ` (line ${span.startLine})`
        : ` (lines ${span.startLine}–${span.endLine})`;
  const head = first === undefined ? file : `${file}: ${first}`;
  if (lines === "") return boundTitle(`${head}${more}`);
  const tail = `${lines}${more}`;
  return `${boundTitle(head, TITLE_MAX - tail.length)}${tail}`;
};

/**
 * The code-built titles of a batch's units, in the order given. Two units of one file whose titles
 * would be the same each add their named part's lines (`codeTitle`'s `withLines`); a title that
 * still repeats is the publisher's to number.
 */
export const codeTitles = (
  entries: ReadonlyArray<{
    readonly unit: SettledUnit;
    readonly blob: ReturnType<typeof unitSections>;
  }>,
) => {
  const plain = entries.map(({ unit, blob }) => codeTitle(unit, blob));
  const seen = new Map<string, number>();
  const keyOf = (i: number) => canonicalJson([entries[i]!.unit.path, plain[i]]);
  for (let i = 0; i < entries.length; i++)
    seen.set(keyOf(i), (seen.get(keyOf(i)) ?? 0) + 1);
  return entries.map(({ unit, blob }, i) =>
    seen.get(keyOf(i))! > 1 ? codeTitle(unit, blob, true) : plain[i]!,
  );
};

/** Which finding kinds a sign may sit on; as the records' own rule (`signalMatches`). */
const signalFits = (
  kind: string,
  about: string,
  signal: string | undefined,
): boolean =>
  signal === undefined ||
  (about !== "code" &&
    (signal === "forged") === (kind === "defect") &&
    (signal !== "stale-proof" || about === "proof") &&
    (signal === "forged" || kind === "risk"));

const SUMMARY_SAYS = /(?![\u115f\u1160\u3164\uffa0])[\p{L}\p{N}]/u;

/** Why a comment is withheld from Records. `below-the-cut` is not disclosed: the caller ranked it out. */
export type WithheldReason =
  "below-the-cut" | "impact-without-summary" | "anchor-outside-unit";

/**
 * A comment as `comment.recorded@3`'s payload, cleaned and bounded (control characters replaced,
 * the body at 10,600 characters, the summary on one line at 300, evidence that parses, a sign only
 * where the records' rule lets it sit), or why it is withheld. Nothing else is cut.
 */
export const cleanComment = (
  comment: SettledComment,
  owned: ReadonlyArray<Owned>,
):
  | { readonly payload: Record<string, unknown> }
  | { readonly withheld: WithheldReason } => {
  if (!comment.shown && !comment.restedOn) return { withheld: "below-the-cut" };
  const impact = comment.kind === "impact";
  const summary =
    impact && comment.summary !== undefined
      ? oneLine(comment.summary, 300)
      : undefined;
  if (
    impact &&
    (comment.effect === undefined ||
      summary === undefined ||
      !SUMMARY_SAYS.test(summary))
  )
    return { withheld: "impact-without-summary" };
  const anchor =
    comment.anchor === undefined
      ? undefined
      : {
          path: comment.anchor.path,
          side: comment.anchor.side,
          startLine: comment.anchor.startLine,
          endLine: Math.max(comment.anchor.startLine, comment.anchor.endLine),
        };
  if (
    anchor !== undefined &&
    !owned.some((range) => meets({ kind: "lines", ...anchor }, range))
  )
    return { withheld: "anchor-outside-unit" };
  const seen = new Set<string>();
  const evidence: Array<CitationValue> = [];
  for (const cited of comment.evidence) {
    const parsed = Citation.safeParse(cited);
    const value = parsed.success
      ? parsed.data
      : Citation.safeParse({ ref: cited.ref }).data;
    if (value === undefined) continue;
    const key = `${value.ref}#${value.entry ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    evidence.push(value);
    if (evidence.length === 32) break;
  }
  const signal = signalFits(comment.kind, comment.about, comment.signal)
    ? comment.signal
    : undefined;
  return {
    payload: {
      body: clipText(comment.body, 10_600),
      ...(anchor === undefined ? {} : { anchor }),
      // The section it is about, which `checkBatch` holds to its unit's; absent for the whole unit.
      ...(comment.section === null ? {} : { section: comment.section }),
      finding: {
        kind: comment.kind,
        about: comment.about,
        ...(signal === undefined ? {} : { signal }),
        ...(impact ? { effect: comment.effect, summary } : {}),
        evidence,
      },
    },
  };
};
