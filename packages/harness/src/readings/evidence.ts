import { z } from "zod";
import type { ManifestHunk } from "../manifest.ts";
import type {
  RelationSlice,
  SiteShows,
  SliceCaller,
  SliceSubject,
} from "../relations.ts";
import type { PlanSection, ReadingPlan } from "./plan.ts";
import { readingOrder } from "./reading.ts";

/**
 * What a reading group is shown of who calls its changed code (NEU-148 WP6, rounds 6 and 9): for
 * each changed symbol of a section on the head side, at most one caller row from a file that is not
 * a test file and one test row from a test file, each with its path, its line when Graph gave one,
 * that line's text at the head commit, and what that line shows (`shows`, the graph lane's
 * `SliceSite`). Only supported callers (the relations slice's `callers.shown`) are ever used; a name
 * match the slice did not keep is never a row, a symbol's own recursive call is never its caller,
 * and a symbol with `evidence: "none"` gets no row at all: no row is never said to mean no callers or
 * no test. A row with a line is shown only when the head tree gives that line's text (a line past the
 * end of the file, a blob the read leaves out, a path that is no blob or a blank line is no row): a
 * row never names a line code could not confirm. A row that shows only its caller (`caller`) and has
 * no line is shown by its caller's name and path alone.
 *
 * Decided once per group and run, from the relations already stored when the group's first read is
 * prepared (`pi/stages/reading-task.ts`), and stored, so both readings of the group, their re-reads
 * and its claim checks are shown the same rows. Given the head gate (round 20), the readings wait on
 * it first, so the head's relations computed during the review, up to the readings' bound, are
 * stored by then; the decision records how the gate ended (`gate`). Pure here: the caller reads the
 * stored relations, the declarations and the source lines.
 *
 * Which symbols need evidence: for every changed line of the section on the head side, the
 * innermost symbol that encloses it among the slice's symbols (all of them when several share the
 * smallest span); and for every pure removal (`removalPlaces`), the innermost symbols of the two
 * head lines it sits between and of the pair. A section that only removes lines keeps its gap.
 *
 * The gap is "no caller shown" (the coordinator's ruling of 13 November, its reading of decision
 * 14.19, which the owner may overrule). A section has relation evidence (`shown`) only when its head
 * side was read, every changed line there lies inside a symbol, at least one symbol needs evidence,
 * no cap left a caller row out, and every such symbol has a caller row that lifts (`rowLifts`): from
 * a file that a declaration the reader followed classifies as not a test (`testStatusOf`
 * `not-test`), matched by Graph as resolved or by the receiver's type, whose line shows the call
 * itself (`shows` `call`) or hands the name over (`reference`), with that line and its text from the
 * head commit. A row that shows only its caller (`caller`, the calling function's first line or
 * none) is context ("called from this function") and lifts nothing, nor does a row matched by name
 * only, nor one from a file whose test status the reader could not settle (`undecided`: unknown
 * means no lift). That a row lifts only on its own line is the coordinator's ruling, and that a
 * `reference` row lifts as a call does is the coordinator's of round 13 (the engine at `5cfab8c`
 * meets the bar for references).
 *
 * Test rows are context and nothing else (the owner's ruling of 13 November, decision 14.19: a
 * recognised test is a hint for the model, never evidence in code). They are chosen and shown under the same caps, after
 * every caller row of the group, and never count for or against a section's lift: a test row past
 * the cap is left out and changes no state, and a section with test rows only keeps its gap.
 *
 * Anything else keeps code's `relations-unavailable` gap, as one of these states, first that
 * applies: `not-read` (the head's relations were not stored when the group decided, or the
 * section's file was not read there), `over-cap` (more symbols than `SYMBOLS_PER_SECTION`, or a
 * caller row past the group's cap), `partial` (some rows shown), `no-evidence` (read, nothing
 * supported to show).
 *
 * The lift is the readings' behaviour, not a switch (the owner's ruling, round 13): with the
 * readings on it applies; with them off (`review.sectionReadings: "off"`) no decision is made.
 *
 * A section is `shown` only when the plan knows its span lost no symbol (`symbolRemoved` false,
 * from the sections lane's `symbols-removed` fact). A span that lost a symbol keeps its gap whatever
 * it is shown, as does one where that is not known: a removed symbol's callers are on the base side,
 * which this consumer does not read. This holds however the diff groups the removed rows, so a
 * method removed inside a class section keeps the gap even when the diff merges it into another
 * method's replacement block.
 *
 * Every removed row, pure or merged by the diff into a replacement block, is also attributed by
 * the plan to its innermost symbol in the base structure and that symbol's match at the head
 * (`removalAttribution` in `plan.ts`, by the sections' counterpart rules). Each such head symbol
 * (`removedHeads`) needs a caller row that lifts, as a changed line's symbol does; a row that could
 * not be attributed, or where that is not known (`removedAttributed` false or null), keeps the gap,
 * as does a head symbol line at which the slice has no symbol.
 *
 * A row that does not say how it was matched (a slice from an older build), or whose call site is in
 * another file than its caller, is never shown.
 *
 * Which callers are test files is told by the slice itself (`SliceCaller.test`): the reading task
 * cuts the slices with the head commit's declared test files already known, for every caller, by
 * path (`testStatusOf` over the head's declarations read from the whole head tree,
 * `pi/stages/reading-task.ts`), never by a guess from a file's name. A caller whose file is
 * undecided is no test row: the slice cuts it as a caller, and its row is marked `undecided`, shown
 * as context, and lifts nothing.
 *
 * What each rule covers: the per-line rule, added and replaced lines; the removal place, where a
 * pure removal sits at the head (a removal starting the file or ending its hunk keeps the gap);
 * `symbolRemoved`, a span that lost a symbol; `removedAttributed` and `removedHeads`, which symbol
 * every removed row belonged to, so a merged removal from another symbol needs that symbol's
 * evidence. Nothing of the merged case stays open: a removed row the plan cannot attribute keeps
 * the gap.
 */

/**
 * Part of the decision's key and its stored form: change it whenever what a group is shown would
 * change. 2: a row is shown only with its line's text; every changed line's innermost symbol needs
 * both rows; a symbol's own call is no caller; `over-cap`; the decision's `outcome`.
 * 3: a pure removal's place at the head needs evidence as a changed line does; at most
 * `CANDIDATES_PER_KIND` call sites are tried per symbol and kind.
 * 4: a section whose span lost a symbol, or where that is not known, keeps its gap.
 * 5: test callers are told only among each symbol's first twenty showable callers.
 * 6: every removed row's head symbol (`removedHeads`) needs both rows; one not attributed keeps the
 * gap.
 * 7: only a row whose edge the engine resolved lifts the gap (`lifts`); another is shown as
 * unconfirmed context (`confirmed`).
 * 8: a stored `shown` section must hold confirmed rows only; a plan's removed row no symbol takes
 * in is not attributed.
 * 9: a row lifts when Graph resolved it or matched it by the receiver's type (`matched`); a row
 * that does not say how it was matched is not shown; every shown caller is told test or not by the
 * slice, not only the first twenty; a stored `shown` section holds at least one row.
 * 10: a caller whose call site is in another file than its own gives no row.
 * 11: the decision records whether the head index's site lines are the calls' own lines
 * (`callLines`); while they are not, no section is `shown`. Each row names the function that calls
 * (`from`).
 * 12: each row stores what its line shows (`shows`), and a `caller` row may have no line; a section
 * lifts on its caller rows alone (`rowLifts`); test rows are context, chosen after every caller row
 * of the group, and count neither for nor against a lift; the decision records the switch (`lift`)
 * in place of `callLines`. A decision stored under 11 fails this literal and is refused.
 * 13: the lift is no longer a switch (the decision's `lift` is gone); a `reference` row lifts as a
 * `call` row does; a caller row from a file whose test status the reader could not settle is marked
 * `undecided` and lifts nothing; the test files are read from the whole head tree.
 */
export const EVIDENCE_RECIPE = "neuve-reading-evidence-v13";

/**
 * The symbols of a section whose callers and tests are shown, innermost first; a section with more
 * keeps its gap. Most sections hold one declaration, so one symbol.
 */
export const SYMBOLS_PER_SECTION = 3;

/** A row's source text at most, in UTF-16 code units, cut between code points. */
export const ROW_TEXT = 160;

/** A symbol's name as a row shows it at most. */
export const ROW_NAME = 80;

/**
 * Rows per group: two for each section a group may hold (`maxItems`, 40 at the default bounds, so
 * 80 rows), taken in reading order, every caller row before any test row; a caller row past it is
 * left out and its section keeps its gap, a test row past it is only left out.
 */
export const rowsPerGroup = (bounds: Pick<ReadingPlan["bounds"], "maxItems">) =>
  2 * bounds.maxItems;

export const RelationsShown = z.enum([
  "shown",
  "partial",
  "no-evidence",
  "over-cap",
  "not-read",
]);
export type RelationsShown = z.infer<typeof RelationsShown>;

/**
 * How a group's decision was made: from the head's stored relations (`read`), with nothing stored
 * for them (`not-stored`, also when there is no Graph engine), from an error (`failed`), or past
 * the decision's time bound (`over-bound`). Under the last three every section is `not-read`.
 */
export const EvidenceOutcome = z.enum([
  "read",
  "not-stored",
  "failed",
  "over-bound",
]);
export type EvidenceOutcome = z.infer<typeof EvidenceOutcome>;

/**
 * How the head gate the group's readings waited on ended (NEU-148 round 20, `relations-task.ts`
 * `headGateOf`), as its result says: the head's relations `stored`, `failed`, its `cutoff` (the
 * readings' bound or the review's came first), the review's packet `published` first, or the
 * review `stopped`. Its own list, so this module takes only types from the relations modules; the
 * reading task checks it against the gate's result type.
 */
export const HeadGateStatus = z.enum([
  "stored",
  "failed",
  "cutoff",
  "published",
  "stopped",
]);
export type HeadGateStatus = z.infer<typeof HeadGateStatus>;

/**
 * The head gate's end, as a decision made after it records it: its status, and the wall time its
 * head read had run (`head.wallMs`; null when it names no head side). A cut-off with no time (null
 * or 0) came before the head's read started: the head tree's index was still being built.
 */
export const HeadGateEnd = z.strictObject({
  status: HeadGateStatus,
  wallMs: z.number().min(0).nullable(),
});
export type HeadGateEnd = z.infer<typeof HeadGateEnd>;

/**
 * What a row's line shows, as the graph lane's `SliceSite.shows` says: closed. Its own list, so this
 * module takes only types from the relations modules; the check below fails to compile when the two
 * lists differ.
 */
export const RowShows = z.enum(["call", "reference", "caller"]);
export type RowShows = z.infer<typeof RowShows>;
const sameShows: [RowShows, SiteShows] extends [SiteShows, RowShows]
  ? true
  : never = true;
void sameShows;

export const EvidenceRow = z
  .strictObject({
    /** `test` when the caller's file is one the head declares a test file (`SliceCaller.test`). */
    kind: z.enum(["caller", "test"]),
    /** The changed symbol's name. */
    symbol: z.string(),
    /** The call site's path at the head commit. */
    path: z.string().min(1),
    /**
     * What the row's line shows (`SliceSite`): `call`, the call itself; `reference`, the name handed
     * over without a call; `caller`, only the calling function, whose first line `line` is, or none.
     */
    shows: RowShows,
    /** The line, as Graph recorded it and the head tree holds it; null only for a `caller` row. */
    line: z.int().min(1).nullable(),
    /** That line's text at the head commit, trimmed and clipped; never blank; null with no line. */
    text: z.string().min(1).nullable(),
    /**
     * The name of the function that calls, clipped (`ROW_NAME`); null when the caller is a file (a
     * call outside every function).
     */
    from: z.string().min(1).nullable(),
    /**
     * Whether Graph's match may be trusted (`lifts`: resolved or by the receiver's type). An
     * unconfirmed row, matched by name only, is shown to the readings, marked so, as context only.
     */
    confirmed: z.boolean(),
    /**
     * Present on a caller row whose file's test status the reader could not settle (`testStatusOf`
     * `undecided`): shown as context, marked so, and it lifts nothing. Absent on every other row.
     */
    undecided: z.literal(true).optional(),
  })
  .refine((row) => (row.line === null) === (row.text === null), {
    message: "a row's line and text are given together",
  })
  .refine((row) => row.line !== null || row.shows === "caller", {
    message: "a row that shows a place has no line",
  })
  .refine((row) => row.undecided === undefined || row.kind === "caller", {
    message: "a test row is marked undecided",
  });
export type EvidenceRow = z.infer<typeof EvidenceRow>;

/**
 * Whether a row lifts its symbol's gap: a caller row from a file a followed declaration classifies
 * as not a test (`kind` `caller` and not `undecided`), trusted (`confirmed`), whose line is the call
 * itself or hands the name over (`shows` `call` or `reference`), with its line and text from the
 * head commit. Nothing else lifts: a `caller` row, a row matched by name only, an undecided file's
 * row, and every test row are context.
 */
export const rowLifts = (row: EvidenceRow) =>
  row.kind === "caller" &&
  row.undecided !== true &&
  row.confirmed &&
  (row.shows === "call" || row.shows === "reference") &&
  row.line !== null &&
  row.text !== null;

export const SectionEvidence = z
  .strictObject({
    key: z.string(),
    relations: RelationsShown,
    rows: z.array(EvidenceRow),
  })
  // `shown` only on caller rows that all lift, and at least one; test rows are not read for it. A
  // stored decision saying otherwise is refused, and a reading or collect that cannot read it shows
  // nothing and keeps the gap.
  .refine(
    (section) =>
      section.relations !== "shown" ||
      section.rows
        .filter((row) => row.kind === "caller")
        .every((row) => rowLifts(row)),
    { message: "a shown section holds a caller row that does not lift" },
  )
  .refine(
    (section) =>
      section.relations !== "shown" ||
      section.rows.some((row) => row.kind === "caller"),
    { message: "a shown section holds no caller row" },
  );
export type SectionEvidence = z.infer<typeof SectionEvidence>;

/**
 * A section's blast radius as the head side of its relations slice gives it, recorded and never
 * read by the lane rule (decision 14.22: no threshold until its parts are measured; the readers'
 * ruling of round 28 records them first). Counts only, over the symbols the section needs evidence
 * for (`needing`, every one, not only the `SYMBOLS_PER_SECTION` a reading is shown), each from one
 * field of the slice's `SliceSymbol`:
 * - `symbols`: how many such symbols;
 * - `callers`: the sum of `callers.total` (every supported caller, test files among them);
 * - `trusted`: the sum of `callers.trusted` (those not matched by name only);
 * - `testCallers`: the sum of `testCallers.total` (the callers from declared test files, counted
 *   apart, also inside `callers`);
 * - `files`: the distinct `callers.shown[].caller.path` over every symbol, the calling files;
 *   `callers.shown` holds at most `CALLERS_PER_SYMBOL` rows per symbol, so `filesComplete` says
 *   whether every symbol's shown rows were all its callers (`shown.length === total`);
 * - `edges`: the sum of `changedEdges.length` (the graph's supported call edges between this
 *   symbol and the request's other changed symbols, in either direction).
 * A symbol whose `callers.evidence` or `testCallers.evidence` is `none` adds nothing to those counts.
 */
export const SectionReach = z.strictObject({
  key: z.string(),
  symbols: z.int().min(0),
  callers: z.int().min(0),
  trusted: z.int().min(0),
  testCallers: z.int().min(0),
  files: z.int().min(0),
  filesComplete: z.boolean(),
  edges: z.int().min(0),
});
export type SectionReach = z.infer<typeof SectionReach>;

/**
 * What one group was shown, as stored. A section it does not list was shown nothing and counts as
 * `not-read` (a decision that could not be made lists none).
 */
export const GroupEvidence = z
  .strictObject({
    recipe: z.literal(EVIDENCE_RECIPE),
    group: z.string().min(1),
    outcome: EvidenceOutcome,
    /**
     * The stored relations reads it was decided from, by computation key: the head commit's, and the
     * merge base's; null where that read was not stored when the group decided. Only the head's is
     * read for rows.
     */
    relations: z.strictObject({
      head: z.string().nullable(),
      base: z.string().nullable(),
    }),
    sections: z.array(SectionEvidence),
    /**
     * Each section's blast radius (`SectionReach`), for the sections whose head side was read;
     * shown to no reading. Absent on a decision stored before it was recorded, or one that read
     * nothing.
     */
    reach: z.array(SectionReach).optional(),
    /**
     * How the head gate the readings waited on had ended when the group decided (round 20). Absent
     * when they waited on none (readings given no gate, a decision from before), so a person reads
     * the gap as before.
     */
    gate: HeadGateEnd.optional(),
  })
  // A decision that read nothing never says a section is `shown`.
  .refine(
    (decision) =>
      decision.outcome === "read" ||
      decision.sections.every((section) => section.relations !== "shown"),
    { message: "a section is shown by a decision that read nothing" },
  );
export type GroupEvidence = z.infer<typeof GroupEvidence>;

/** A decision that shows nothing: every section of the group not read, or none listed. */
export const notRead = (
  group: string,
  outcome: Exclude<EvidenceOutcome, "read">,
  relations: GroupEvidence["relations"] = { head: null, base: null },
  keys: ReadonlyArray<string> = [],
): GroupEvidence => ({
  recipe: EVIDENCE_RECIPE,
  group,
  outcome,
  relations: { ...relations },
  sections: keys.map((key) => ({ key, relations: "not-read", rows: [] })),
});

/**
 * Why a section keeps code's relations gap, as the person reads it (`readings/decide.ts`): the
 * callers were `unavailable` (today's words), or the head's relations were not stored when the
 * group decided because the head gate ended first at its cut-off with the head's read running
 * (`computing`) or not yet started (`not-started`), or the review's packet was `published` or the
 * review `stopped` first. When the head's relations were read (round 23), the section's own
 * evidence state names it: no caller shows how it is used (`no-evidence`), callers for part of it
 * (`partial`), too many functions to show their callers (`over-cap`), or shown whole and held
 * (`held`).
 */
export type RelationsGapCause =
  | "unavailable"
  | "no-evidence"
  | "partial"
  | "over-cap"
  /**
   * The read did not reach the section's file (round 23): `not-read` in general, or, where the
   * stored data says why, a submodule pointer (`submodule-pointer`).
   */
  | "not-read"
  | "submodule-pointer"
  | "computing"
  | "not-started"
  | "published"
  | "stopped"
  /**
   * The hold (round 22, `collect.ts`): the callers were read, shown whole to both readings, and
   * the gap is kept while what they lift is measured.
   */
  | "held";

/**
 * The cause of a section's relations gap, from its group's decision and the section's state in it
 * (`section`: for `shown`, the state the lift would show whole, which the hold keeps; a `shown`
 * the lift would not take is `partial`, as the collector records it).
 *
 * - A decision that read the head (`read`): the section's state names the cause, through an
 *   exhaustive switch, so no state of a read decision says the callers were not available: a
 *   section the read did not reach says callers are not read for its kind of file, naming a
 *   submodule pointer where the stored data says it is one (`file`).
 * - A decision that found the head not stored (`not-stored`) after its readings waited on the head
 *   gate names the gate's end. A gate that ended `stored` or `failed` while the decision still
 *   found nothing stored is `unavailable`: the callers were not to be had.
 * - No decision, one that failed or passed its bound, and one made with no gate: `unavailable`.
 *
 * By design, a follow-on run of the same chain (the same cycle and run key) shows the chain's one
 * decision (`evidenceSpec`), and so this same gap with these same words, even when the head's
 * relations were stored in between: a group's evidence is never reversed within a chain, so its
 * readings meet the same text and reuse their answers. Do not "fix" it by deciding again in a
 * follow-on.
 */
export const relationsGapCause = (
  evidence: Pick<GroupEvidence, "outcome" | "gate"> | undefined,
  section: RelationsShown,
  /**
   * What the stored data already says of the section's file, for a section the read did not reach:
   * whether it is a submodule pointer (`isGitlink` over its own manifest hunks). Nothing is looked
   * up for it.
   */
  file: { readonly gitlink: boolean } = { gitlink: false },
): RelationsGapCause => {
  if (evidence?.outcome === "read")
    switch (section) {
      case "shown":
        return "held";
      case "partial":
        return "partial";
      case "over-cap":
        return "over-cap";
      case "no-evidence":
        return "no-evidence";
      case "not-read":
        return file.gitlink ? "submodule-pointer" : "not-read";
      default:
        // A new state fails the typecheck here until it has its own words.
        return section satisfies never;
    }
  const gate = evidence?.gate;
  if (evidence?.outcome !== "not-stored" || gate === undefined)
    return "unavailable";
  switch (gate.status) {
    case "stored":
    case "failed":
      return "unavailable";
    case "cutoff":
      return gate.wallMs === null || gate.wallMs === 0
        ? "not-started"
        : "computing";
    case "published":
      return "published";
    case "stopped":
      return "stopped";
  }
};

type Hunks = ReadonlyMap<string, ManifestHunk>;
type Section = Pick<
  PlanSection,
  | "key"
  | "path"
  | "owned"
  | "hunkIds"
  | "symbolRemoved"
  | "removedAttributed"
  | "removedHeads"
>;

/**
 * Where a section's pure removals sit at the head (round 6c). A removal is a run of removed rows
 * the section owns, in one block of a hunk's changed rows, that holds no added row the section also
 * owns (a replacement's added rows already sit in their own symbol). It sits between two head
 * lines: `line`, the last new-side line before the block, and `line + 1`, the new-side line right
 * after it (the next context or added row). Both stand for the removal: each needs its innermost
 * symbol's evidence, and so does the innermost symbol that encloses both (`needing`).
 * `undetermined` when a removal's place cannot be told: its hunk is missing or has no text, the file
 * has no head path (deleted), the removal starts the file (no line before it) or ends its hunk (no
 * line after it is known). It keeps the section's gap.
 */
export const removalPlaces = (
  section: Section,
  hunks: Hunks,
): {
  readonly places: ReadonlyArray<{
    readonly path: string;
    readonly line: number;
  }>;
  readonly undetermined: boolean;
} => {
  const places: Array<{ path: string; line: number }> = [];
  let undetermined = false;
  for (const hunkId of new Set(section.hunkIds)) {
    const owned = (side: "old" | "new", line: number) =>
      section.owned.some(
        (range) =>
          range.hunkId === hunkId &&
          range.side === side &&
          range.startLine <= line &&
          line <= range.endLine,
      );
    if (!section.owned.some((r) => r.hunkId === hunkId && r.side === "old"))
      continue;
    const hunk = hunks.get(hunkId);
    if (hunk === undefined || hunk.kind !== "text" || hunk.newPath === null) {
      undetermined = true;
      continue;
    }
    // Each row with its line on its side, and the next new-side line where it stands, counted as
    // the reading counts them (`reading.ts` `diffRows`).
    const rows: Array<{ sign: string; old: number; new: number }> = [];
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const row of hunk.text.split("\n").slice(1)) {
      if (row === "" || row.startsWith("\\")) continue;
      const sign = row[0]!;
      rows.push({ sign, old: oldLine, new: newLine });
      if (sign === "-") oldLine++;
      else if (sign === "+") newLine++;
      else {
        oldLine++;
        newLine++;
      }
    }
    for (let at = 0; at < rows.length;) {
      if (rows[at]!.sign === " ") {
        at++;
        continue;
      }
      let end = at;
      while (end < rows.length && rows[end]!.sign !== " ") end++;
      const block = rows.slice(at, end);
      const removes = block.some((r) => r.sign === "-" && owned("old", r.old));
      const adds = block.some((r) => r.sign === "+" && owned("new", r.new));
      if (removes && !adds) {
        const line = rows[at]!.new - 1;
        if (line < 1 || end >= rows.length) undetermined = true;
        else places.push({ path: hunk.newPath, line });
      }
      at = end;
    }
  }
  return { places, undetermined };
};

/**
 * Every read section of the plan as a relations subject: its owned new-side ranges and, for each
 * of its pure removals, the two head lines it sits between (`removalPlaces`), each with its file's
 * path on the head side. The base side is never read for rows, so no old range is given. All of
 * them in one call, as the slices want (a caller is "changed" only against every range).
 */
export const relationSubjects = (
  plan: Pick<ReadingPlan, "sections">,
  hunks: Hunks,
): Array<SliceSubject> =>
  plan.sections.map((section) => ({
    key: section.key,
    ranges: [
      ...section.owned
        .filter((range) => range.side === "new")
        .map((range) => ({
          side: "new" as const,
          path: hunks.get(range.hunkId)?.newPath ?? section.path,
          startLine: range.startLine,
          lineCount: range.endLine - range.startLine + 1,
        })),
      ...removalPlaces(section, hunks).places.map((place) => ({
        side: "new" as const,
        path: place.path,
        startLine: place.line,
        lineCount: 2,
      })),
      // The first line of each head symbol its removed rows were attributed to, so the slice holds
      // that symbol (`removedHeads`).
      ...section.removedHeads.map((symbol) => ({
        side: "new" as const,
        path: hunks.get(section.hunkIds[0] ?? "")?.newPath ?? section.path,
        startLine: symbol.startLine,
        lineCount: 1,
      })),
    ],
  }));

/** Text cut to at most `limit` UTF-16 code units, between code points. */
const clip = (text: string, limit: number) => {
  let out = "";
  for (const point of text) {
    if (out.length + point.length > limit) break;
    out += point;
  }
  return out;
};

type SliceHead = RelationSlice["head"];
type SliceSymbolEntry = SliceHead["symbols"][number];

/** Whether a section's head side was read: the side, and every one of its files, parsed whole. */
const headRead = (head: SliceHead | undefined): head is SliceHead =>
  head !== undefined &&
  head.read.kind === "read" &&
  // A file not in the snapshot, or one Graph failed on in part: its relations are no evidence.
  head.paths.every(
    (path) => path.snapshot.kind === "read" && path.snapshot.parsed,
  );

const span = (entry: SliceSymbolEntry) =>
  entry.symbol.endLine - entry.symbol.startLine;

/**
 * The symbols a section's changed lines need evidence for, innermost first as the slice orders
 * them: each changed head line's innermost enclosing symbol among the slice's symbols (every one
 * that shares the smallest span), the two head lines around each pure removal counting as changed
 * lines (they are among the slice's ranges, `relationSubjects`), and for each removal also the
 * innermost symbol that encloses both of those lines. `outside` when a changed line lies inside no
 * symbol, when no symbol encloses a removal's two lines (the symbol it was in is gone, or it sat
 * between two symbols), or when the section's head ranges name more than one file (a slice's symbol
 * carries no path, so which file a symbol is in cannot be told): each keeps the gap.
 */
const needing = (
  head: SliceHead,
  places: ReadonlyArray<{ readonly line: number }>,
  removedHeads: ReadonlyArray<{ readonly startLine: number }> = [],
) => {
  const ranges = head.ranges.filter((range) => range.lineCount > 0);
  if (new Set(ranges.map((range) => range.path)).size > 1)
    return { symbols: [] as Array<SliceSymbolEntry>, outside: true };
  const ids = new Set<string>();
  let outside = false;
  const innermostOf = (from: number, to: number) => {
    const enclosing = head.symbols.filter(
      (entry) => entry.symbol.startLine <= from && to <= entry.symbol.endLine,
    );
    if (enclosing.length === 0) {
      outside = true;
      return;
    }
    const smallest = Math.min(...enclosing.map(span));
    for (const entry of enclosing)
      if (span(entry) === smallest) ids.add(entry.symbol.id);
  };
  for (const range of ranges)
    for (
      let line = range.startLine;
      line < range.startLine + range.lineCount;
      line++
    )
      innermostOf(line, line);
  for (const place of places) innermostOf(place.line, place.line + 1);
  // Each head symbol a removed row was attributed to: every slice symbol that starts on its first
  // line. None there keeps the gap.
  for (const removed of removedHeads) {
    const at = head.symbols.filter(
      (entry) => entry.symbol.startLine === removed.startLine,
    );
    if (at.length === 0) outside = true;
    for (const entry of at) ids.add(entry.symbol.id);
  }
  return {
    symbols: head.symbols.filter((entry) => ids.has(entry.symbol.id)),
    outside,
  };
};

/**
 * Call sites tried per symbol and kind (caller, test), in the slice's order: it bounds the files a
 * decision reads to at most 3 symbols x 2 kinds x 5 per section, so widely used code cannot carry a
 * group past the decision's time bound. If none of the first five has its line, there is no row.
 */
export const CANDIDATES_PER_KIND = 5;

/**
 * Whether Graph's match of a caller may be trusted: it resolved the call, or matched it by the
 * receiver's type (`matched`), in the caller's own file or from another. Both receiver-type shapes
 * were hand-checked on a real index of this repository: from another file, 34 of 34 and 20 of 20
 * right; inside the caller's own file, 40 of 40 and, with a receiver other than `this` or `self`,
 * 20 of 20 (`coordination/neu-148/reviews/graph-9b-receiver-type-hand-check.md`). A match by name
 * only, which can point at another function of the same name, is never trusted; nor is a row that
 * does not say how it was matched (a slice from an older build). Trust alone lifts nothing: a row
 * lifts only as `rowLifts` says.
 */
export const lifts = (caller: { readonly matched?: SliceCaller["matched"] }) =>
  caller.matched === "resolved" || caller.matched === "receiver-type";

/**
 * A symbol's callers a row could show, in the slice's order: every one of `callers.shown` (at most
 * the slice's 50, each already told test or not by the slice), except the symbol's own recursive
 * call, a caller Graph gave no site for, a call site in another file than its caller, and a row
 * that does not say how it was matched. A site with no line is kept only as `caller` (the type
 * gives a line to every other).
 */
const showable = (entry: SliceSymbolEntry) => {
  const callers = entry.callers;
  if (callers.evidence !== "supported") return [];
  return callers.shown.filter(
    (caller) =>
      // A recursive call is no evidence of use.
      !(
        caller.caller.kind === "symbol" && caller.caller.id === entry.symbol.id
      ) &&
      caller.site !== null &&
      // A caller is told test or not by its own path, and the row shows its call site's: a site in
      // another file could make one line both a caller row and a test row. Graph puts a call site
      // in its caller's file, so this only refuses a row that would say something else.
      caller.site.path === caller.caller.path &&
      // An older build's row, which cannot say whether it is a match by name only: never shown,
      // so an unconfirmed row is always one matched by name only.
      (caller as { readonly matched?: unknown }).matched !== undefined,
  );
};

/**
 * Whether no caller row of a symbol can lift, decided from the slice's counts before any row is
 * chosen: no trusted caller outside a test file shows a place (`placed`, which counts the kept edges
 * that are not name-only and show a call or a reference, past the slice's cap too, test callers
 * among them). It only ever keeps a gap early: whether one goes is decided on each row
 * (`rowLifts`), never on this count, which also counts callers from undecided files.
 */
const cannotLift = (entry: SliceSymbolEntry) => {
  const callers = entry.callers;
  if (callers.evidence !== "supported") return true;
  const tests =
    entry.testCallers.evidence === "supported"
      ? (entry.testCallers.placed ?? 0)
      : 0;
  return (callers.placed ?? 0) - tests <= 0;
};

/**
 * Files whose test status the reader could not settle (`testStatusOf` `undecided`), by path: their
 * caller rows are marked and lift nothing. None when every file is settled.
 */
export type UndecidedFiles = ReadonlySet<string>;
const NONE_UNDECIDED: UndecidedFiles = new Set();

/**
 * How early a caller is tried: one that could lift (trusted, its line the call or the name handed
 * over, from a file that is not undecided) first, then every other with a line, then one with no
 * line, each in the slice's order.
 */
const rank = (caller: SliceCaller, undecided: UndecidedFiles) =>
  lifts(caller) &&
  (caller.site?.shows === "call" || caller.site?.shows === "reference") &&
  !undecided.has(caller.caller.path)
    ? 0
    : caller.site?.line != null
      ? 1
      : 2;

/**
 * A symbol's callers of a kind that may be shown, among the showable ones (`showable`), told test
 * or not by the slice, in `rank` order and at most `CANDIDATES_PER_KIND` in all, so the files read
 * stay bounded.
 */
const candidatesOf = (
  entry: SliceSymbolEntry,
  test: boolean,
  undecided: UndecidedFiles,
) =>
  showable(entry)
    .filter((caller) => caller.test === test)
    .map((caller, at) => ({ caller, at }))
    .sort(
      (a, b) =>
        rank(a.caller, undecided) - rank(b.caller, undecided) || a.at - b.at,
    )
    .slice(0, CANDIDATES_PER_KIND)
    .map(({ caller }) => ({
      path: caller.site!.path,
      line: caller.site!.line,
      shows: caller.site!.shows,
      confirmed: lifts(caller),
      ...(!test && undecided.has(caller.caller.path)
        ? { undecided: true as const }
        : {}),
      // The calling function's name; a symbol the index does not hold is named by its ID.
      from:
        caller.caller.kind === "file"
          ? null
          : clip(caller.caller.symbol?.name ?? caller.caller.id, ROW_NAME) ||
            null,
    }));

/**
 * The first candidate of a kind (`candidatesOf`) that can be shown: one with a line whose text the
 * head tree holds, or a `caller` one with no line, shown by its caller alone. None when no candidate
 * qualifies.
 */
const firstOf = (
  entry: SliceSymbolEntry,
  test: boolean,
  lineAt: (path: string, line: number) => string | null,
  undecided: UndecidedFiles,
): Omit<EvidenceRow, "kind" | "symbol"> | undefined => {
  for (const site of candidatesOf(entry, test, undecided)) {
    if (site.line === null) return { ...site, shows: "caller", text: null };
    const text = lineAt(site.path, site.line)?.trim() ?? "";
    if (text !== "") return { ...site, text: clip(text, ROW_TEXT) };
  }
  return undefined;
};

/** Each section of a group in reading order, with its slice's head side when it was read. */
const sectionsOf = (
  plan: ReadingPlan,
  groupId: string,
  slices: ReadonlyMap<string, RelationSlice> | null,
  hunks: Hunks,
) => {
  const byKey = new Map(plan.sections.map((section) => [section.key, section]));
  return readingOrder(plan, groupId).map((key) => {
    const head = slices?.get(key)?.head;
    const section = byKey.get(key)!;
    if (!headRead(head)) return { key, section, head: undefined };
    const removal = removalPlaces(section, hunks);
    return {
      key,
      section,
      head,
      removal,
      needed: needing(head, removal.places, section.removedHeads),
    };
  });
};

/** Every symbol a section of the group needs evidence for, within `SYMBOLS_PER_SECTION`. */
const groupSymbols = (
  plan: ReadingPlan,
  groupId: string,
  slices: ReadonlyMap<string, RelationSlice>,
  hunks: Hunks,
) =>
  sectionsOf(plan, groupId, slices, hunks).flatMap(
    (entry) => entry.needed?.symbols.slice(0, SYMBOLS_PER_SECTION) ?? [],
  );

/**
 * The call sites whose line a group's rows may show: the candidates (`candidatesOf`) with a line of
 * each kind for every symbol a section of the group needs evidence for, within
 * `SYMBOLS_PER_SECTION`. The caller reads these files at the head commit.
 */
export const callSitePaths = (
  plan: ReadingPlan,
  groupId: string,
  slices: ReadonlyMap<string, RelationSlice>,
  hunks: Hunks,
  /** The undecided files (`UndecidedFiles`), as `chooseRows` is given them. */
  undecided: UndecidedFiles = NONE_UNDECIDED,
): Array<string> => {
  const paths = new Set<string>();
  for (const symbol of groupSymbols(plan, groupId, slices, hunks))
    for (const test of [false, true])
      for (const site of candidatesOf(symbol, test, undecided))
        if (site.line !== null) paths.add(site.path);
  return [...paths].sort();
};

/**
 * Each section's state and rows, in reading order (see the module comment), from the head side of
 * each section's slice, the range's hunks (where a pure removal sits) and each call site's line at
 * the head commit (`lineAt`: null where the head tree has no such line). `slices` is null when the
 * head's relations were not stored; a section without a slice is not read. A section that adds no
 * line, or one whose removal's place cannot be told, keeps its gap whatever it is shown. The slices
 * say which callers are test files, and `undecided` which callers' files the reader could not
 * settle.
 *
 * The group's caller rows are chosen first, in reading order, then its test rows with what is left
 * of the cap: a test row is never why a caller row is left out, and one past the cap is left out
 * with no effect on its section's state. Within a section each symbol's caller row comes before its
 * test row.
 */
export const chooseRows = (
  plan: ReadingPlan,
  groupId: string,
  slices: ReadonlyMap<string, RelationSlice> | null,
  lineAt: (path: string, line: number) => string | null,
  hunks: Hunks,
  /** The callers' files whose test status is undecided: their rows are marked and never lift. */
  undecided: UndecidedFiles = NONE_UNDECIDED,
): Array<SectionEvidence> => {
  const cap = rowsPerGroup(plan.bounds);
  let used = 0;
  const sections = sectionsOf(plan, groupId, slices, hunks);
  const take = (
    entry: SliceSymbolEntry,
    kind: EvidenceRow["kind"],
  ): EvidenceRow | "missing" | "over-cap" => {
    const site = firstOf(entry, kind === "test", lineAt, undecided);
    if (site === undefined) return "missing";
    if (used >= cap) return "over-cap";
    used++;
    return { kind, symbol: clip(entry.symbol.name, ROW_NAME), ...site };
  };
  // The caller rows of every section first, then the test rows.
  const callers = sections.map(({ needed, removal }) => {
    if (needed === undefined || removal === undefined) return undefined;
    let overCap = needed.symbols.length > SYMBOLS_PER_SECTION;
    let missing = false;
    // A caller row that does not lift is shown as context and leaves its symbol's requirement
    // unmet; so does a symbol the slice's counts say no caller row of can lift (`cannotLift`).
    let unlifted = false;
    const rows = needed.symbols.slice(0, SYMBOLS_PER_SECTION).map((entry) => {
      if (cannotLift(entry)) unlifted = true;
      const row = take(entry, "caller");
      if (row === "missing") missing = true;
      else if (row === "over-cap") overCap = true;
      else if (!rowLifts(row)) unlifted = true;
      return typeof row === "string" ? undefined : row;
    });
    return { rows, overCap, missing, unlifted };
  });
  const tests = sections.map(({ needed }, at) =>
    callers[at] === undefined || needed === undefined
      ? []
      : needed.symbols.slice(0, SYMBOLS_PER_SECTION).map((entry) => {
          const row = take(entry, "test");
          return typeof row === "string" ? undefined : row;
        }),
  );
  return sections.map(
    ({ key, section, needed, removal }, at): SectionEvidence => {
      const chosen = callers[at];
      if (needed === undefined || removal === undefined || chosen === undefined)
        return { key, relations: "not-read", rows: [] };
      const rows = chosen.rows.flatMap((row, symbol) =>
        [row, tests[at]![symbol]].filter(
          (one): one is EvidenceRow => one !== undefined,
        ),
      );
      const whole =
        needed.symbols.length > 0 &&
        !needed.outside &&
        !removal.undetermined &&
        // A section that only removes lines keeps its gap (decision 4), and so does one whose span
        // lost a symbol, or where that is not known: its callers are on the base side, not read.
        section.owned.some((range) => range.side === "new") &&
        section.symbolRemoved === false &&
        // Every removed row attributed to a symbol that still exists at the head.
        section.removedAttributed === true &&
        !chosen.overCap &&
        !chosen.missing &&
        !chosen.unlifted;
      return {
        key,
        relations: whole
          ? "shown"
          : chosen.overCap
            ? "over-cap"
            : rows.length > 0
              ? "partial"
              : "no-evidence",
        rows,
      };
    },
  );
};

/**
 * Each section's blast radius (`SectionReach`), in reading order, for every section of the group
 * whose slice's head side was read; a section whose head was not read has none, and so is never
 * said to reach nothing.
 */
export const reachOf = (
  plan: ReadingPlan,
  groupId: string,
  slices: ReadonlyMap<string, RelationSlice> | null,
  hunks: Hunks,
): Array<SectionReach> =>
  sectionsOf(plan, groupId, slices, hunks).flatMap(({ key, needed }) => {
    if (needed === undefined) return [];
    const files = new Set<string>();
    let callers = 0;
    let trusted = 0;
    let testCallers = 0;
    let edges = 0;
    let filesComplete = true;
    for (const entry of needed.symbols) {
      if (entry.callers.evidence === "supported") {
        callers += entry.callers.total;
        trusted += entry.callers.trusted;
        for (const caller of entry.callers.shown) files.add(caller.caller.path);
        if (entry.callers.shown.length < entry.callers.total)
          filesComplete = false;
      }
      if (entry.testCallers.evidence === "supported")
        testCallers += entry.testCallers.total;
      edges += entry.changedEdges.length;
    }
    return [
      {
        key,
        symbols: needed.symbols.length,
        callers,
        trusted,
        testCallers,
        files: files.size,
        filesComplete,
        edges,
      },
    ];
  });

/** A section's state and rows in a decision; `not-read` and none when it lists no such section. */
export const sectionEvidence = (
  evidence: GroupEvidence | undefined,
  key: string,
): SectionEvidence =>
  evidence?.sections.find((section) => section.key === key) ?? {
    key,
    relations: "not-read",
    rows: [],
  };
