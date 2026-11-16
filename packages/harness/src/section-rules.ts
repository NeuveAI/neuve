import { Effect } from "effect";
import { z } from "zod";
import { Computations, canonicalJson } from "@neuve/records-core";
import {
  SYMBOL_TOKENS_BATCH_BYTES,
  type GraphFileTokens,
} from "@neuve/graph-client";
import {
  blobStructures,
  hunkBlobEntries,
  structureKeyOf,
  structuresByBlob,
} from "./blob-structure.ts";
import {
  answerRetryable,
  blobTokens,
  type BlobTokensAnswer,
  type BlobTokensCounts,
} from "./blob-tokens.ts";
import { cpuWork } from "./budget/cpu.ts";
import {
  groupsBySize,
  lsTree,
  readBlobs,
  treeOf,
  type TreeEntry,
} from "./git-objects.ts";
import { GRAPH_SOURCE_BINDING, type OutlineSource } from "./graph-outline.ts";
import { blobSizes } from "./hunks.ts";
import { LINGUIST_STANDARD, type LinguistMark } from "./linguist/index.ts";
import {
  allUnspecified,
  ambiguousAttributes,
  attributeText,
  CONTROL_FILES_RECIPE,
  isSet,
  keptBy,
  isUnset,
  linguistBlobReadable,
  linguistMarkOf,
  linguistMarkRead,
  listStatesOf,
  readCommitAttributes,
  type AttributeTrust,
  type AttributeValue,
  type ReadAttributeName,
} from "./linguist-lists.ts";
import type { ManifestHunk } from "./manifest.ts";
import {
  importTarget,
  isRelationsGap,
  relationSlices,
  type RelationSlice,
  type RelationsRound,
  type RelationsSide,
  type SliceSubject,
} from "./relations.ts";
import {
  INDEX_BOUNDS,
  blobText,
  decodeJson,
  overSize,
  storedBytes,
} from "./search-index.ts";
import {
  sectionFactsSpec,
  storedSectionFacts,
  type SectionFactsResult,
} from "./section-facts.ts";
import type { SectionIdentity } from "./section-identity.ts";
import {
  DECIDING_RULE_NAMES,
  type DecidingRuleName,
  type RuleDecision,
} from "./section-rule-decision.ts";
import {
  codePoints,
  declarationCounterparts,
  sectionPlace,
  spanIndexAt,
  type BlobStructure,
  type Section,
} from "./sections.ts";
import {
  FAMILY_MIN_MEMBERS,
  FAMILY_MIN_TOKENS,
  SECTION_FAMILIES_RECIPE,
  TOKEN_RULE_NAMES,
  TOKEN_RULE_REASONS,
  sectionFamiliesOf,
  sectionTokenRules,
  type SectionRelations,
  type SectionTokensInput,
  type TokensGap,
} from "./section-token-rules.ts";
import { repositoryOwner } from "./budget/owner.ts";

/**
 * Rule judgements per section: what a code rule read and found, stored and recomputable from its
 * inputs. A judgement states what was read; it never says a reading can be skipped, and it is never
 * an approval. Which holding judgements decide a section, so that it gets no model reading, is said
 * in one place, `ruleDecisionsOf` (decision 14.17); what the plan does with a decided section is the
 * readers' rule, not this module's. Nothing here goes into a prompt.
 *
 * A judgement is emitted only where its rule applies to the section; no judgement means the rule
 * does not apply. Where a rule cannot be sure, the result is `not-held` or `not-evaluated` with a
 * named reason, never a default.
 *
 * The rules, each with its version (raised whenever that rule's logic changes):
 * - `generated`: the repository's declarations and GitHub Linguist's two lists, generated and
 *   vendored (the owner's ruling: both lists mark). Applies to every section of a file with any
 *   signal. The repository's word wins per list in both directions: `linguist-generated` or
 *   `linguist-vendored` set marks the file whatever the standard says; unset or false turns off that
 *   list's marks (a generated header and `-diff` are on the generated list), and leaves the other.
 *   Holds when either list marks the file; `not-held` with the repository's reason when its word
 *   turned the marks off. An attribute is read as Linguist reads it (`lazy_blob.rb` of v9.7.0,
 *   `generated?` and `vendored?`, lines 57 to 71 and 134 to 137): when it is not nil, Linguist's
 *   answer is `attribute != "false" && attribute != false` and its rules are not asked. So set, or
 *   any string but `false` (`true`, `maybe`, `0`, the empty string), marks the file by declaration;
 *   unset, or the string `false`, turns the list off; unspecified leaves the readers and the
 *   standard to decide. The attributes (`linguist-generated`, `linguist-vendored`, `diff`) are read
 *   in a Git directory of their own, over the repository's objects, so only the commit's
 *   `.gitattributes` files count: no local `info/attributes`, system or user file, no
 *   configuration and no `GIT_*` variable of the caller's. The rule vouches for attribute readers
 *   itself: a declared reader of the manifest that reads `.gitattributes` is taken only where this
 *   read gives the same (`-diff` from `diff` unset); one it does not is left out and listed. Where
 *   the read cannot be sure, the file is not evaluated: a `.gitattributes` of the revision over it
 *   holds `<attribute>=unset` or `<attribute>=unspecified` as a literal value and Git printed that
 *   same word for the file, as Git prints a state and a value spelled like it alike; or such a
 *   file over it was not read. A well-known control file (`CONTROL_FILES`) that only the
 *   standard marks is `not-held` with the reason `control-file` (the owner's ruling of 13
 *   November 2026): the lists never exclude it; the repository's attribute set still holds. The lists' states, the attribute values, the isolated read and
 *   the blob read are `linguist-lists.ts`'s, shared with the declarations' `linguist` reader, so
 *   the map's exclusion and this rule decide alike; the reader's suggestions (`standard`) are
 *   never taken as declared readers.
 * - `blank-rows-only`: a section of Graph's symbols whose declaration's text is byte-identical on
 *   both sides (identity `spanSha256` equal to `counterpartSha256`). Holds when every row it owns is
 *   blank and lies outside the lines of Graph's symbols in the declaration on the row's side.
 * - `moved-unchanged`: across files only. An added declaration and a removed one, both named, each
 *   section owning every non-blank line of its declaration and rows on that one side only, with the
 *   same kind, name and span text, paired one to one where their counts are equal. The statement
 *   says only that the text is byte-identical: what the names in it refer to is not read.
 * - `markdown-prose`: a Markdown heading section. Holds when no row it owns is a fence line or lies
 *   inside a fenced code block, on its own side. It reads only fences at column 0, after any front
 *   matter, and refuses (not evaluated) every section of a file side the scan cannot account for:
 *   a fence-like line behind any whitespace, a `>` or a list marker (it may sit in a list item or
 *   a quote); a line outside a fence that may start an HTML block (its first character, after at
 *   most three spaces, is `<`); a carriage return not followed by a line feed anywhere in the text
 *   (CommonMark ends a line there, Git does not); a fence-like line in front matter (a renderer
 *   that does not strip the block reads it). It also refuses a changed row in front matter, an
 *   `.mdx` file and a side whose text was not read.
 * - `whitespace-only`, `comment-only`, `imports-only`, `deletion-only`: from Graph's syntax leaves,
 *   import bindings and relation slices, in `section-token-rules.ts`, which says what each reads.
 *   They give nothing unless `tokens` or `relations` is given.
 *
 * Pure and synchronous, except `storedSectionRules`, which reads what the rules need and stores the
 * judgements (and, with tokens, the pattern families) under `harness.section-rules@1`.
 */
export const SECTION_RULES_RECIPE = "neuve-section-rules-v1";

export const SectionRuleName = z.enum([
  "generated",
  "blank-rows-only",
  "moved-unchanged",
  "markdown-prose",
  ...TOKEN_RULE_NAMES,
]);
export type SectionRuleName = z.infer<typeof SectionRuleName>;

/** Each rule's version; the order here is the order judgements are given in, per section. */
export const SECTION_RULE_VERSIONS = Object.freeze({
  // 2: an attribute is read as Linguist reads it: any string but `false` marks the file.
  // 3: a local attributes file naming either attribute, or a literal `=unset` or `=unspecified`
  // over a file whose printed word is the same, is not evaluated; the system file is not read.
  // 4: attributes are read in an isolated Git directory (no local file, so no refusal for one);
  // `diff` is read too, and attribute readers of the manifest are taken only where the read agrees;
  // the scan reads every `.gitattributes` blob, symbolic links included, up to its first NUL.
  // 5: the scan reads the commit with replace objects off, a partial clone's objects are fetched
  // first and a missing one fails the read, matching ignores the file system's case and Unicode
  // habits, and every path must be answered.
  // 6: a well-known control file (`CONTROL_FILES`) the lists alone mark is not held (`control-file`).
  generated: 6,
  "blank-rows-only": 1,
  // 2: its inputs carry what made each section a candidate.
  "moved-unchanged": 2,
  // 2: fences only at column 0 after front matter; an indented or contained fence-like line, or a
  // line that may start an HTML block, refuses the whole side.
  // 3: a bare carriage return, or a fence-like line in front matter, refuses the whole side.
  "markdown-prose": 3,
  // 2 (each): the gaps between tokens are compared, directives are read only where the reader
  // gives them, and imports compare the touched statements' bindings as multisets.
  // 3 (each): whitespace-only refuses near comments where directives are not read; indentation
  // that is syntax must be the same; imports-only takes in a touched statement's counterpart.
  // 4 (each): leading whitespace must be the same unless the record declares the language
  // free-form (`indentationSignificant` false; null or absent no longer passes); a side with no
  // record says why, and a side that is no text gives nothing.
  "whitespace-only": 4,
  "comment-only": 4,
  // 4: a leaf touches every statement whose bytes hold it, and every statement on a counterpart line
  // joins the comparison.
  // 5: a side the section owns rows on whose tokens were not read is not evaluated, with the reason.
  // 6: a non-comment leaf of whitespace only (Go's statement-ending line feeds) is layout, and need
  // not lie within an import statement.
  // 7: only a leaf of line feeds and carriage returns is layout; a binding that does not fit its
  // file (whitespace in a name, a local name no identifier of the file) is not evaluated.
  "imports-only": 7,
  // 2: a removed symbol whose base callers are all matched by name only is recorded as `name-only`
  // and not counted as still called; a supported one records `trusted`, and `first` is the first
  // shown caller not matched by name only.
  "deletion-only": 2,
} satisfies Record<SectionRuleName, number>);

export const SectionRuleResult = z.enum(["holds", "not-held", "not-evaluated"]);
export type SectionRuleResult = z.infer<typeof SectionRuleResult>;

export const SectionRuleReason = z.enum([
  // generated
  "repository-declares-not-generated",
  "repository-declares-not-vendored",
  "contents-not-read",
  "standard-not-answered",
  "path-not-utf8",
  // A `.gitattributes` holds the printed word as a literal value: a state and a value read alike.
  "attribute-value-ambiguous",
  // A well-known control file the lists marked (`CONTROL_FILES`): the lists never exclude it.
  "control-file",
  // blank-rows-only
  "owns-non-blank-rows",
  "row-inside-declaration",
  "no-symbols",
  // moved-unchanged
  "ambiguous",
  "same-path",
  // markdown-prose (and `contents-not-read`)
  "fenced-row-changed",
  "not-text",
  "mdx",
  "fence-in-container",
  "html-block",
  // A `\r` not followed by `\n`: CommonMark ends a line there, Git and the scan do not.
  "bare-carriage-return",
  // A fence-like line in front matter: read as a fence wherever the block is not stripped.
  "fence-in-front-matter",
  "front-matter",
  // The token rules' (`section-token-rules.ts`).
  ...TOKEN_RULE_REASONS,
]);
export type SectionRuleReason = z.infer<typeof SectionRuleReason>;

export const SectionRuleJudgement = z
  .strictObject({
    /** `<section identity key>.rule:<rule>`. */
    id: z.string(),
    about: z.strictObject({
      kind: z.literal("section"),
      /** The section's identity key (`sectionIdentities`). */
      key: z.string().regex(/^[0-9a-f]{64}$/),
      path: z.string(),
    }),
    rule: SectionRuleName,
    version: z.int().min(1),
    result: SectionRuleResult,
    /** Null exactly when the rule holds. */
    reason: SectionRuleReason.nullable(),
    /** The values the rule read: its result can be recomputed from them alone. */
    inputs: z.record(z.string(), z.json()),
    /** What was read and found, in one sentence; no claim about meaning or safety. */
    statement: z.string(),
    /** The stored fields the inputs came from. */
    evidence: z.array(z.string()),
  })
  .refine(
    (judgement) =>
      (judgement.result === "holds") === (judgement.reason === null),
    {
      message: "a judgement has a reason exactly when it does not hold",
    },
  )
  .refine(
    (judgement) =>
      judgement.id === `${judgement.about.key}.rule:${judgement.rule}`,
    {
      message: "a judgement's id is its section's key and its rule",
    },
  );
export type SectionRuleJudgement = z.infer<typeof SectionRuleJudgement>;

// The attribute values, the isolated read and the lists' states live in `linguist-lists.ts`, which
// the declarations' `linguist` reader shares; re-exported here for this module's callers.
export {
  AttributeValue,
  AttributesUnreadable,
  linguistMarkOf,
  markablePath,
  type AmbiguousAttribute,
  type AttributeName,
  type AttributeTrust,
  type ReadAttributeName,
} from "./linguist-lists.ts";

/** What the `generated` rule reads of one changed path, beside the hunks' declarations. */
export interface FileSignals {
  /**
   * The commit's attributes for the path, read in an isolated Git directory (`storedSectionRules`).
   * `diff` absent: not read, so no attribute reader of the manifest is vouched for.
   */
  readonly attributes: {
    readonly "linguist-generated": AttributeValue;
    readonly "linguist-vendored": AttributeValue;
    readonly diff?: AttributeValue;
  };
  /**
   * What makes the attributes unsure, as `storedSectionRules` reads it. Absent: the caller gives
   * attributes it read as sure, and none is refused for it.
   */
  readonly trust?: AttributeTrust;
  /** The blob Linguist's rules read: the head blob, or the base blob of a deleted file. */
  readonly blob: string | null;
  /** Whether that blob's bytes were read and given to `linguistMark`. */
  readonly read: boolean;
  /** Null where the path is not one Linguist can be asked about (`markablePath`). */
  readonly mark: LinguistMark | null;
}

/** Linguist's standard as given, carried into every `generated` judgement and the stored key. */
const standardAsGiven = (): z.core.util.JSONType =>
  JSON.parse(JSON.stringify(LINGUIST_STANDARD)) as z.core.util.JSONType;

const EVIDENCE = {
  declaredKind: "fact.declared-kind",
  declaredBy: "hunk.declared[].kind,by",
  attributes: "gitattributes:linguist-generated,linguist-vendored",
  mark: "linguist.generated,vendored,notEvaluated",
  identity: "identity.parts.spanSha256,counterpartSha256",
  identityName: "identity.parts.kind,name,side",
  ranges: "section.ranges",
  text: "hunk.text",
  declaration: "fact.declaration",
  oldOnly: "fact.old-side-only",
  spanSize: "structure.spans[].start,end,lines,characters",
  symbolLines: "structure.spans[].symbols[].startLine,endLine",
  blobText: "blob.text",
} as const;

const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

interface OwnedRow {
  readonly side: "old" | "new";
  readonly line: number;
  readonly text: string;
  /** False only where Git's "no newline at end of file" marker follows the row. */
  newline: boolean;
}

/** Every changed row of a text hunk, with its text, as the section facts read them. */
const changedRows = (hunk: ManifestHunk) => {
  const rows: Array<OwnedRow> = [];
  if (hunk.kind !== "text") return rows;
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  // The changed row just before the current one: the one Git's marker would end.
  let previous: OwnedRow | undefined;
  for (const row of hunk.text.split("\n").slice(1)) {
    if (row.startsWith("\\")) {
      if (previous !== undefined) previous.newline = false;
      previous = undefined;
      continue;
    }
    if (row === "") continue;
    previous = undefined;
    if (row.startsWith("-") || row.startsWith("+")) {
      const side = row.startsWith("-") ? "old" : "new";
      const line = side === "old" ? oldLine++ : newLine++;
      previous = { side, line, text: row.slice(1), newline: true };
      rows.push(previous);
      continue;
    }
    oldLine++;
    newLine++;
  }
  return rows;
};

/** The rows a section owns in one text hunk, from that hunk's changed rows. */
const ownedRows = (
  section: Section,
  hunk: ManifestHunk,
  rows: ReadonlyArray<OwnedRow>,
) => {
  const owned = new Set<string>();
  for (const range of section.ranges)
    if (range.hunkId === hunk.hunkId)
      for (let at = 0; at < range.lineCount; at++)
        owned.add(`${range.side}:${range.startLine + at}`);
  return rows.filter((row) => owned.has(`${row.side}:${row.line}`));
};

const isBlank = (text: string) => text.trim() === "";

/** The one blob all the section's hunks name on a side. */
const blobOn = (
  section: Section,
  hunks: ReadonlyArray<ManifestHunk>,
  side: "old" | "new",
) => {
  const blobs = new Set(
    hunks.map((hunk) => (side === "new" ? hunk.newOid : hunk.oldOid)),
  );
  if (blobs.size !== 1)
    throw new Error(
      `Section of ${section.path} has hunks naming different ${side} blobs`,
    );
  const [blob] = blobs;
  return blob ?? null;
};

/**
 * Whether the rows a section owns on one side take in every non-blank line of the span: all lie in
 * the span, and every line of it they leave out is one newline (told from the span's stored size).
 * A left-out last line of the file is not told (its newline is not shown), and makes this false.
 */
const ownsWholeSpan = (
  span: BlobStructure["spans"][number],
  fileLines: number,
  rows: ReadonlyArray<OwnedRow>,
) => {
  if (rows.some((row) => row.line < span.start || row.line > span.end))
    return false;
  const covered = new Set(rows.map((row) => row.line));
  if (span.end === fileLines && !covered.has(span.end)) return false;
  const used = rows.reduce(
    (sum, row) => sum + codePoints(row.text) + (row.newline ? 1 : 0),
    0,
  );
  return span.characters - used === span.lines - covered.size;
};

// ---------------------------------------------------------------------------------------------
// Markdown fences: CommonMark's fenced code blocks at the top level, and what the scan refuses.

export interface FenceMap {
  /** Lines (from 1) that are a fence line or inside a fenced block; an unclosed fence runs to the end. */
  readonly fenced: ReadonlySet<number>;
  /** Lines of a front-matter block that opens on the first line. */
  readonly frontMatter: ReadonlySet<number>;
  /**
   * A fence-like line (three or more backticks or tildes once its leading whitespace, `>` and list
   * markers are taken off) that does not start at column 0: it may sit in a list item, a quote or an
   * indented block, which the scan does not read.
   */
  readonly containerFence: boolean;
  /** A line outside a fence found so far whose first character, after at most three spaces, is `<`. */
  readonly htmlBlock: boolean;
  /**
   * A `\r` not followed by `\n` anywhere in the text. CommonMark ends a line there; Git and this
   * scan do not, so one row can hide fence lines.
   */
  readonly bareCarriageReturn: boolean;
  /**
   * A fence-like line (three or more backticks or tildes after optional whitespace) in the front
   * matter. Whether a renderer strips the block is not known here; one that does not reads it.
   */
  readonly frontMatterFence: boolean;
}

/**
 * The fences of a Markdown text, read only where the scan can be sure of them. Front matter (a
 * `---` first line closed by `---` or `...`) is left out, as GitHub strips it. After it, a fence
 * opens on a line that starts at column 0 with three or more backticks or tildes (a backtick fence's
 * info string holds no backtick), and closes on a line of the same character, at least as long,
 * followed only by spaces or tabs. A column-0 fence cannot be inside a list item or a quote. Any
 * other fence-like line, and any line that may start an HTML block (whose content CommonMark does
 * not read for fences), is only flagged: the caller refuses the whole side. The heading cut
 * (`headingStarts` in `chunker.ts`) reads fences more loosely, and is not used here.
 */
export const fenceMapOf = (text: string): FenceMap => {
  const lines = text
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const fenced = new Set<number>();
  const frontMatter = new Set<number>();
  let containerFence = false;
  let htmlBlock = false;
  let open: { char: string; length: number } | null = null;
  if (lines[0] === "---") {
    const close = lines.findIndex(
      (line, index) => index > 0 && (line === "---" || line === "..."),
    );
    if (close > 0)
      for (let index = 0; index <= close; index++) frontMatter.add(index + 1);
  }
  const frontMatterFence = lines
    .slice(0, frontMatter.size)
    .some((line) => /^\s*(```|~~~)/.test(line));
  for (let index = frontMatter.size; index < lines.length; index++) {
    const line = lines[index]!;
    const number = index + 1;
    const stripped = line.replace(
      /^(?:[\s>]|[-*+](?=\s)|\d{1,9}[.)](?=\s))*/u,
      "",
    );
    if (stripped.length !== line.length && /^(```|~~~)/.test(stripped))
      containerFence = true;
    if (open !== null) {
      fenced.add(number);
      const closing = /^(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (
        closing !== null &&
        closing[1]![0] === open.char &&
        closing[1]!.length >= open.length
      )
        open = null;
      continue;
    }
    if (/^ {0,3}</.test(line)) htmlBlock = true;
    const opening = /^(`{3,}|~{3,})(.*)$/.exec(line);
    if (
      opening !== null &&
      !(opening[1]![0] === "`" && opening[2]!.includes("`"))
    ) {
      open = { char: opening[1]![0]!, length: opening[1]!.length };
      fenced.add(number);
    }
  }
  return {
    fenced,
    frontMatter,
    containerFence,
    htmlBlock,
    bareCarriageReturn: /\r(?!\n)/.test(text),
    frontMatterFence,
  };
};

const isMdx = (path: string | null) => path !== null && /\.mdx$/i.test(path);

// ---------------------------------------------------------------------------------------------
// The generated rule's decision, from one file's signals (the lists' states: `linguist-lists.ts`).

interface GeneratedOutcome {
  readonly result: SectionRuleResult;
  readonly reason: SectionRuleReason | null;
  readonly statement: string;
  readonly inputs: Record<string, z.core.util.JSONType>;
}

/** What Linguist's standard matched a file by: a rule of its generated list, or a vendor pattern. */
type StandardMatch =
  { list: "generated"; rule: string } | { list: "vendored"; pattern: string };

/** The prefix of a declared reader that reads `.gitattributes` (`declarations.ts`). */
const ATTRIBUTE_READER = "gitattributes:";
const DIFF_READER = "gitattributes: -diff";

/**
 * The `generated` judgement of a file, or undefined when no signal applies. The manifest's declared
 * readers that read `.gitattributes` are not taken on trust: `gitattributes: -diff` is taken where
 * the rule's own read gives `diff` unset, and `gitattributes: linguist-generated=<value>` where it
 * gives that value marking the file (the rule then names it from its own read); any other is left
 * out and listed (`declaredNotVouched`), with a sentence only where taking it would change the
 * result. `-diff` from the rule's own read is a declared reader whatever the manifest says. Other
 * readers (the generated-file marker) are taken as given.
 */
const generatedOutcome = (
  signals: FileSignals,
  manifestReaders: ReadonlyArray<string>,
  path: string,
): GeneratedOutcome | undefined => {
  const generated = signals.attributes["linguist-generated"];
  const diff = signals.attributes.diff;
  const vouched = (by: string) => {
    if (by === DIFF_READER) return diff?.state === "unset";
    const value = /^gitattributes: linguist-generated=(.*)$/s.exec(by)?.[1];
    return (
      value !== undefined &&
      isSet(generated) &&
      attributeText(generated) === value
    );
  };
  const notVouched = [
    ...new Set(
      manifestReaders.filter(
        (by) => by.startsWith(ATTRIBUTE_READER) && !vouched(by),
      ),
    ),
  ].sort(byCodeUnits);
  const taken = [
    ...manifestReaders.filter((by) => !by.startsWith(ATTRIBUTE_READER)),
    ...(diff?.state === "unset" ? [DIFF_READER] : []),
  ];
  const outcome = outcomeFrom(signals, taken, notVouched, path);
  if (outcome === undefined || notVouched.length === 0) return outcome;
  const trusted = outcomeFrom(
    signals,
    [...taken, ...notVouched],
    notVouched,
    path,
  );
  if (
    trusted !== undefined &&
    trusted.result === outcome.result &&
    trusted.reason === outcome.reason
  )
    return outcome;
  return {
    ...outcome,
    statement: `${outcome.statement}; the declared ${notVouched.join(" and ")} is not what the commit's attributes give, so it is not taken`,
  };
};

/**
 * The judgement from the readers taken. Each list is read on its own (the owner's ruling: both
 * lists mark): the generated list is a declared reader (a generated header, `-diff`),
 * `linguist-generated` set, or a Linguist generated rule; the vendored list is `linguist-vendored`
 * set, or a Linguist vendor pattern. The repository's word wins per list in both directions: its
 * attribute set marks the file whatever the standard says; unset or false turns that list's marks
 * off. The file holds when either list is on. A path whose attribute read is ambiguous is refused
 * first, whatever else is known. A well-known control file (`CONTROL_FILES`) the standard alone
 * marks is not held, with the reason `control-file` and its entry in the inputs: the lists never
 * exclude it (the owner's ruling of 13 November 2026).
 */
const outcomeFrom = (
  signals: FileSignals,
  declaredReaders: ReadonlyArray<string>,
  declaredNotVouched: ReadonlyArray<string>,
  path: string,
): GeneratedOutcome | undefined => {
  // The lists' states, as the declarations' `linguist` reader reads them (`linguist-lists.ts`).
  const { attributes, mark, rule, pattern, unanswered, lists, control } =
    listStatesOf(signals, declaredReaders, path);
  const linguist = `GitHub Linguist ${LINGUIST_STANDARD.version}`;
  const order = ["generated", "vendored"] as const;
  const turnedOff = order.flatMap((list) => {
    const state = lists[list];
    // Recorded only where the attribute turned a mark off.
    return state.state === "turned-off" && state.over.length > 0
      ? [{ list, by: state.by, over: [...state.over] }]
      : [];
  });
  const ambiguous = signals.trust?.ambiguous ?? [];
  // How each printed value was read: as a state, as a string, or as neither for sure.
  const readOf = (name: ReadAttributeName, value: AttributeValue) => ({
    ...value,
    read: ambiguous.some((entry) => entry.attribute === name)
      ? "ambiguous"
      : value.state === "value"
        ? "value"
        : "state",
  });
  const base = {
    attributes: {
      "linguist-generated": readOf("linguist-generated", attributes.generated),
      "linguist-vendored": readOf("linguist-vendored", attributes.vendored),
      ...(signals.attributes.diff === undefined
        ? {}
        : { diff: readOf("diff", signals.attributes.diff) }),
    },
    declared: [...declaredReaders],
    declaredNotVouched: [...declaredNotVouched],
    blob: signals.blob,
    read: signals.read,
    // The standard's name, version, recipe and reader, as `linguistMark` gives them.
    standard: JSON.parse(
      JSON.stringify(mark?.standard ?? LINGUIST_STANDARD),
    ) as z.core.util.JSONType,
    linguist:
      mark === null
        ? null
        : {
            generated: rule,
            vendored: pattern,
            notEvaluated: [...mark.notEvaluated],
          },
    turnedOff,
  };
  // Refused before anything else is weighed: a state that could not be read may have marked the
  // file, or turned a list off.
  if (ambiguous.length > 0)
    return {
      result: "not-evaluated",
      reason: "attribute-value-ambiguous",
      statement: `Git prints ${ambiguous
        .map((entry) => `${entry.attribute} as ${entry.word}`)
        .join(
          " and ",
        )} for the file, which is the state or a value spelled like it, and ${ambiguous
        .map((entry) =>
          [
            ...(entry.files.length === 0
              ? []
              : [
                  `${entry.files.join(" and ")} at this revision ${entry.files.length === 1 ? "holds" : "hold"} ${entry.attribute}=${entry.word} as a literal value`,
                ]),
            ...(entry.unread.length === 0
              ? []
              : [
                  `${entry.unread.join(" and ")} over it ${entry.unread.length === 1 ? "was" : "were"} not read, so whether ${entry.unread.length === 1 ? "it holds" : "they hold"} ${entry.attribute}=${entry.word} is not known`,
                ]),
          ].join(", and "),
        )
        .join(
          "; ",
        )}, so the repository's declaration for the file could not be read`,
      inputs: {
        ...base,
        by: null,
        ambiguous: ambiguous.map((entry) => ({
          attribute: entry.attribute,
          word: entry.word,
          files: [...entry.files],
          unread: [...entry.unread],
        })),
      },
    };
  const applies =
    unanswered ||
    mark === null ||
    order.some(
      (list) => lists[list].state !== "silent" || isUnset(attributes[list]),
    );
  if (!applies) return undefined;
  const offNote =
    turnedOff.length === 0
      ? ""
      : `; the repository's ${turnedOff.map((entry) => entry.by).join(" and ")} turns off the ${turnedOff.map((entry) => entry.list).join(" and ")} list only`;
  const declared = order.flatMap((list) => {
    const state = lists[list];
    return state.state === "declared" ? [{ list, readers: state.readers }] : [];
  });
  // Typed by its `list`, so every compiler setting keeps the two shapes apart (an inferred union
  // gains an optional `pattern` or `rule` where exact optional properties are off).
  const standard = order.flatMap((list): Array<StandardMatch> => {
    const state = lists[list];
    if (state.state !== "standard") return [];
    return list === "generated"
      ? [{ list, rule: state.match }]
      : [{ list, pattern: state.match }];
  });
  const standardText = standard.map((entry) =>
    entry.list === "generated"
      ? `${linguist}'s generated list fires for this file by its rule ${entry.rule}`
      : `${linguist}'s vendored list matches this path by ${entry.pattern}`,
  );
  if (declared.length > 0) {
    const readers = declared.flatMap((entry) => entry.readers);
    return {
      result: "holds",
      reason: null,
      statement: `the repository declares the file ${declared.map((entry) => entry.list).join(" and ")} (${readers.join("; ")})${standardText.length === 0 ? "" : `, and ${standardText.join(", and ")}`}${offNote}`,
      inputs: { ...base, by: "declaration", readers, lists: standard },
    };
  }
  if (standard.length > 0)
    return {
      result: "holds",
      reason: null,
      statement: `${standardText.join(", and ")}${offNote}`,
      inputs: { ...base, by: "standard", lists: standard },
    };
  // A well-known control file the standard marked: read, whatever rule or pattern fired.
  const kept = order.flatMap((list): Array<StandardMatch> => {
    const state = lists[list];
    if (state.state !== "kept") return [];
    return list === "generated"
      ? [{ list, rule: state.match }]
      : [{ list, pattern: state.match }];
  });
  if (kept.length > 0 && control !== undefined)
    return {
      result: "not-held",
      reason: "control-file",
      statement: `${kept
        .map((entry) =>
          entry.list === "generated"
            ? `${linguist}'s generated list fires for this file by its rule ${entry.rule}`
            : `${linguist}'s vendored list matches this path by ${entry.pattern}`,
        )
        .join(
          ", and ",
        )}, but it is a well-known control file (${control.id}: ${control.convention}, by ${control.documentation}), which the lists never exclude${offNote}`,
      inputs: {
        ...base,
        by: "control-file",
        lists: kept,
        kept: { entry: control.id, by: keptBy(control.id) },
      },
    };
  if (order.some((list) => lists[list].state === "unknown")) {
    const prefix = `nothing declares the file generated or vendored and no ${linguist} list marks it`;
    if (mark === null)
      return {
        result: "not-evaluated",
        reason: "path-not-utf8",
        statement: `${prefix} by what was read: its lists were not asked, as the path as read is not valid UTF-8, or holds a NUL or a lone surrogate${offNote}`,
        inputs: { ...base, by: null },
      };
    return signals.read
      ? {
          result: "not-evaluated",
          reason: "standard-not-answered",
          statement: `${prefix}, but these generated rules gave no answer on its contents: ${mark.notEvaluated.join(", ")}${offNote}`,
          inputs: { ...base, by: null },
        }
      : {
          result: "not-evaluated",
          reason: "contents-not-read",
          statement: `${prefix} by its path, but these generated rules need its contents, which were not read: ${mark.notEvaluated.join(", ")}${offNote}`,
          inputs: { ...base, by: null },
        };
  }
  // Nothing marks the file: the repository's word turned a mark off, or says no with none to turn off.
  const off = order.find((list) => isUnset(attributes[list]))!;
  const overs = turnedOff.flatMap((entry) => entry.over);
  return {
    result: "not-held",
    reason:
      off === "generated"
        ? "repository-declares-not-generated"
        : "repository-declares-not-vendored",
    statement: `the repository's .gitattributes gives ${order
      .filter((list) => isUnset(attributes[list]))
      .map((list) => `linguist-${list} as ${attributeText(attributes[list])}`)
      .join(
        " and ",
      )} for the file${overs.length === 0 ? "" : `, turning off ${overs.join(" and ")}`}, and nothing else marks it`,
    inputs: { ...base, by: "declaration" },
  };
};

// ---------------------------------------------------------------------------------------------
// The judgements.

export interface SectionRulesInput {
  /** What `computeSectionFacts` returns for the hunks and structures. */
  readonly result: SectionFactsResult;
  readonly hunks: ReadonlyArray<ManifestHunk>;
  /** Each blob's stored structure by object id, as the facts were given them. */
  readonly structures: ReadonlyMap<string, BlobStructure>;
  /** Per changed path (`hunk.path`) that has a section. */
  readonly files: ReadonlyMap<string, FileSignals>;
  /** Markdown blobs' text by object id; null where the blob is not UTF-8 text; absent where not read. */
  readonly texts: ReadonlyMap<string, string | null>;
  /** Graph's tokens records by blob object id; absent: the token rules give nothing. */
  readonly tokens?: SectionTokensInput;
  /** Blob bytes by object id, both sides of each changed file, where read. */
  readonly contents?: ReadonlyMap<string, Uint8Array>;
  /** Graph's relations; absent: `deletion-only` gives nothing, `imports-only` is not evaluated. */
  readonly relations?: SectionRelations;
}

interface Candidate {
  readonly section: Section;
  readonly identity: SectionIdentity;
  readonly added: boolean;
  readonly start: number;
  /** What made it a candidate, carried into its judgement's inputs. */
  readonly inputs: Record<string, z.core.util.JSONType>;
}

/**
 * The rule judgements of each section, in the sections' order and, per section, in the order of
 * `SECTION_RULE_VERSIONS`. The same input in any order gives the same output. A section without an
 * identity, a path without its signals, or a section whose span its structure does not have, throws.
 */
export const sectionRulesOf = (
  input: SectionRulesInput,
): ReadonlyArray<SectionRuleJudgement> => {
  const { sections, identities, facts } = input.result;
  const hunks = new Map(input.hunks.map((hunk) => [hunk.hunkId, hunk]));
  const factValue = new Map(facts.map((fact) => [fact.id, fact.value]));
  const judgements = new Map<
    string,
    Map<SectionRuleName, SectionRuleJudgement>
  >();
  const add = (
    section: Section,
    identity: SectionIdentity,
    rule: SectionRuleName,
    result: SectionRuleResult,
    reason: SectionRuleReason | null,
    statement: string,
    inputs: Record<string, z.core.util.JSONType>,
    evidence: ReadonlyArray<string>,
  ) => {
    const held = judgements.get(section.key) ?? new Map();
    held.set(rule, {
      id: `${identity.key}.rule:${rule}`,
      about: { kind: "section", key: identity.key, path: section.path },
      rule,
      version: SECTION_RULE_VERSIONS[rule],
      result,
      reason: result === "holds" ? null : reason,
      inputs,
      statement,
      evidence: [...evidence],
    });
    judgements.set(section.key, held);
  };
  const identityOf = (section: Section) => {
    const identity = identities.get(section.key);
    if (identity === undefined)
      throw new Error(`Section of ${section.path} has no identity given`);
    return identity;
  };
  const hunksOf = (section: Section) =>
    section.hunkIds.map((hunkId) => {
      const hunk = hunks.get(hunkId);
      if (hunk === undefined || hunk.path !== section.path)
        throw new Error(
          `Section of ${section.path} names hunk ${hunkId}, which is not given for it`,
        );
      return hunk;
    });
  const structureOf = (blob: string | null) =>
    blob === null ? undefined : input.structures.get(blob);
  /** The span a section's place claims, by index into the side's structure. */
  const claimed = (
    section: Section,
    structure: BlobStructure | undefined,
    startLine: number,
    endLine: number,
  ) => {
    const index = spanIndexAt(structure, startLine);
    const span = index === undefined ? undefined : structure?.spans[index];
    if (
      index === undefined ||
      span === undefined ||
      span.start !== startLine ||
      span.end !== endLine
    )
      throw new Error(
        `Section of ${section.path} claims span ${startLine}-${endLine}, which its structure does not have`,
      );
    return { index, span };
  };
  const fences = new Map<string, FenceMap>();
  const fencesOf = (blob: string, text: string) => {
    let map = fences.get(blob);
    if (map === undefined) fences.set(blob, (map = fenceMapOf(text)));
    return map;
  };
  const candidates: Array<Candidate> = [];
  // Each hunk's changed rows are read once, however many sections it holds.
  const parsed = new Map<ManifestHunk, ReadonlyArray<OwnedRow>>();
  const rowsOf = (hunk: ManifestHunk) => {
    let rows = parsed.get(hunk);
    if (rows === undefined) parsed.set(hunk, (rows = changedRows(hunk)));
    return rows;
  };

  for (const section of sections) {
    const identity = identityOf(section);
    const own = hunksOf(section);
    const rows = own.flatMap((hunk) => ownedRows(section, hunk, rowsOf(hunk)));
    const place = sectionPlace(section);
    const parts = identity.parts;

    // 1. generated.
    const signals = input.files.get(section.path);
    if (signals === undefined)
      throw new Error(`No file signals given for ${section.path}`);
    const kinds = factValue.get(`${identity.key}.declared-kind`);
    if (!Array.isArray(kinds))
      throw new Error(
        `Section of ${section.path} has no declared-kind fact given`,
      );
    const readers = kinds.includes("generated")
      ? [
          ...new Set(
            own.flatMap((hunk) =>
              hunk.declared
                // The `linguist` reader's suggestions (`standard`) are this rule's own finding,
                // read here from the lists, never as the repository's declaration.
                .filter(
                  (entry) =>
                    entry.kind === "generated" && entry.standard === undefined,
                )
                .map((entry) => entry.by),
            ),
          ),
        ].sort(byCodeUnits)
      : [];
    const generated = generatedOutcome(signals, readers, section.path);
    if (generated !== undefined)
      add(
        section,
        identity,
        "generated",
        generated.result,
        generated.reason,
        generated.statement,
        generated.inputs,
        [
          EVIDENCE.declaredKind,
          EVIDENCE.declaredBy,
          EVIDENCE.attributes,
          EVIDENCE.mark,
        ],
      );

    // 2. blank-rows-only.
    if (
      section.basis === "graph-symbols" &&
      place.side === "new" &&
      parts.spanSha256 !== null &&
      parts.counterpartSha256 !== null &&
      parts.spanSha256 === parts.counterpartSha256
    ) {
      const head = structureOf(blobOn(section, own, "new"));
      const base = structureOf(blobOn(section, own, "old"));
      const headSpan = claimed(section, head, place.startLine, place.endLine);
      const baseIndex = declarationCounterparts(base, head).toBase[
        headSpan.index
      ];
      const baseSpan =
        baseIndex === undefined ? undefined : base?.spans[baseIndex];
      if (baseSpan === undefined)
        throw new Error(
          `Section of ${section.path} has a counterpart its base structure does not have`,
        );
      const spanOn = (side: "old" | "new") =>
        side === "new" ? headSpan.span : baseSpan;
      const symbolLines = (span: BlobStructure["spans"][number]) =>
        span.symbols.map((symbol) => [symbol.startLine, symbol.endLine]);
      const rowInputs = rows.map((row) => ({
        side: row.side,
        line: row.line,
        blank: isBlank(row.text),
      }));
      const inputs = {
        spanSha256: parts.spanSha256,
        counterpartSha256: parts.counterpartSha256,
        rows: rowInputs,
        head: {
          start: headSpan.span.start,
          end: headSpan.span.end,
          symbolLines: symbolLines(headSpan.span),
        },
        base: {
          start: baseSpan.start,
          end: baseSpan.end,
          symbolLines: symbolLines(baseSpan),
        },
      };
      const evidence = [
        EVIDENCE.identity,
        EVIDENCE.ranges,
        EVIDENCE.text,
        EVIDENCE.symbolLines,
      ];
      const nonBlank = rowInputs.filter((row) => !row.blank).length;
      const inside = rows.filter((row) =>
        spanOn(row.side).symbols.some(
          (symbol) =>
            row.line >= symbol.startLine && row.line <= symbol.endLine,
        ),
      ).length;
      const unsymbolled = rows.some(
        (row) => spanOn(row.side).symbols.length === 0,
      );
      if (nonBlank > 0)
        add(
          section,
          identity,
          "blank-rows-only",
          "not-held",
          "owns-non-blank-rows",
          `the declaration's text is byte-identical on both sides, and ${plural(nonBlank, "row")} the section owns ${nonBlank === 1 ? "is" : "are"} not blank`,
          inputs,
          evidence,
        );
      else if (inside > 0)
        add(
          section,
          identity,
          "blank-rows-only",
          "not-held",
          "row-inside-declaration",
          `the declaration's text is byte-identical on both sides and every row the section owns is blank, but ${plural(inside, "row")} ${inside === 1 ? "lies" : "lie"} inside the lines of Graph's symbols in it`,
          inputs,
          evidence,
        );
      else if (unsymbolled)
        add(
          section,
          identity,
          "blank-rows-only",
          "not-evaluated",
          "no-symbols",
          "the declaration's text is byte-identical on both sides and every row the section owns is blank, but Graph gives the span no symbols to tell its own lines by",
          inputs,
          evidence,
        );
      else
        add(
          section,
          identity,
          "blank-rows-only",
          "holds",
          null,
          `the declaration's text is byte-identical on both sides, and each of the ${plural(rows.length, "row")} the section owns is blank and lies outside the lines of Graph's symbols in it`,
          inputs,
          evidence,
        );
    }

    // 3. moved-unchanged: candidates now, groups after every section is seen.
    const named =
      parts.name !== null &&
      parts.name !== "" &&
      parts.spanSha256 !== null &&
      parts.kind !== "imports" &&
      parts.kind !== "head" &&
      parts.kind !== "tail";
    if (named && place.side !== "none" && rows.length > 0) {
      const side = place.side;
      const oneSide = rows.every((row) => row.side === side);
      const isCandidate =
        side === "new"
          ? factValue.get(`${identity.key}.declaration`) === "added"
          : factValue.get(`${identity.key}.old-side-only`) === true;
      if (oneSide && isCandidate) {
        const structure = structureOf(blobOn(section, own, side));
        const { span } = claimed(
          section,
          structure,
          place.startLine,
          place.endLine,
        );
        if (ownsWholeSpan(span, structure!.lines, rows))
          candidates.push({
            section,
            identity,
            added: side === "new",
            start: place.startLine,
            inputs: {
              fact:
                side === "new"
                  ? { declaration: "added" }
                  : { "old-side-only": true },
              span: {
                start: span.start,
                end: span.end,
                lines: span.lines,
                characters: span.characters,
              },
              fileLines: structure!.lines,
              // The rows "owns every non-blank line of the declaration" was told from.
              rows: rows.map((row) => ({
                line: row.line,
                characters: codePoints(row.text),
                newline: row.newline,
                blank: isBlank(row.text),
              })),
            },
          });
      }
    }

    // 4. markdown-prose.
    if (section.basis === "markdown-sections") {
      const sides = {
        old: blobOn(section, own, "old"),
        new: blobOn(section, own, "new"),
      };
      const used = (["old", "new"] as const).filter((side) =>
        rows.some((row) => row.side === side),
      );
      const base = {
        ownedRows: rows.length,
        blobs: Object.fromEntries(used.map((side) => [side, sides[side]])),
      };
      const evidence = [EVIDENCE.ranges, EVIDENCE.text, EVIDENCE.blobText];
      const refuse = (
        reason: SectionRuleReason,
        statement: string,
        extra: Record<string, z.core.util.JSONType> = {},
      ) =>
        add(
          section,
          identity,
          "markdown-prose",
          "not-evaluated",
          reason,
          statement,
          { ...base, ...extra },
          evidence,
        );
      const texts = used.map((side) => ({
        side,
        blob: sides[side],
        text: sides[side] === null ? undefined : input.texts.get(sides[side]!),
      }));
      // Before anything else: a side whose whole text holds a bare `\r` hides lines inside rows.
      if (
        texts.some(
          (entry) =>
            typeof entry.text === "string" &&
            fencesOf(entry.blob!, entry.text).bareCarriageReturn,
        )
      )
        refuse(
          "bare-carriage-return",
          "a side the section owns rows on holds a carriage return not followed by a line feed, where CommonMark ends a line and the scan does not",
        );
      else if (
        isMdx(section.path) ||
        own.some((hunk) => isMdx(hunk.oldPath) || isMdx(hunk.newPath))
      )
        refuse("mdx", "the file is MDX, whose fences the scan does not read");
      else if (texts.some((entry) => entry.text === undefined))
        refuse(
          "contents-not-read",
          "the text of a side the section owns rows on was not read",
        );
      else if (texts.some((entry) => entry.text === null))
        refuse("not-text", "a side the section owns rows on is not UTF-8 text");
      else {
        const maps = new Map(
          texts.map((entry) => [
            entry.side,
            fencesOf(entry.blob!, entry.text!),
          ]),
        );
        const mapOf = (side: "old" | "new") => maps.get(side)!;
        const fencedRows = rows.filter((row) =>
          mapOf(row.side).fenced.has(row.line),
        ).length;
        const frontRows = rows.filter((row) =>
          mapOf(row.side).frontMatter.has(row.line),
        ).length;
        const counted = {
          fencedRows,
          frontMatterRows: frontRows,
          // Owned rows an indented code block could hold: told, not judged.
          indentedRows: rows.filter((row) => /^( {4}|\t)/.test(row.text))
            .length,
        };
        if (used.some((side) => mapOf(side).frontMatterFence))
          refuse(
            "fence-in-front-matter",
            "a side the section owns rows on has a fence-like line in its front matter, which a renderer that does not strip the block reads as a fence",
            counted,
          );
        else if (used.some((side) => mapOf(side).containerFence))
          refuse(
            "fence-in-container",
            "a side the section owns rows on has a fence-like line that does not start at column 0 (behind whitespace, a quote or a list marker), which the scan does not read",
            counted,
          );
        else if (used.some((side) => mapOf(side).htmlBlock))
          refuse(
            "html-block",
            "a side the section owns rows on has a line outside a fence that may start an HTML block, which the scan does not read",
            counted,
          );
        else if (frontRows > 0)
          refuse(
            "front-matter",
            `${plural(frontRows, "row")} the section owns ${frontRows === 1 ? "lies" : "lie"} in front matter`,
            counted,
          );
        else if (fencedRows > 0)
          add(
            section,
            identity,
            "markdown-prose",
            "not-held",
            "fenced-row-changed",
            `${plural(fencedRows, "row")} of the ${plural(rows.length, "row")} the section owns ${fencedRows === 1 ? "is a fence line or lies" : "are fence lines or lie"} inside a fenced code block`,
            { ...base, ...counted },
            evidence,
          );
        else
          add(
            section,
            identity,
            "markdown-prose",
            "holds",
            null,
            `none of the ${plural(rows.length, "row")} the section owns is a fence line or lies inside a fenced code block`,
            { ...base, ...counted },
            evidence,
          );
      }
    }

    // 5. The token rules.
    for (const outcome of sectionTokenRules(
      section,
      own,
      factValue.get(`${identity.key}.old-side-only`) === true,
      input,
    ))
      add(
        section,
        identity,
        outcome.rule,
        outcome.result,
        outcome.reason,
        outcome.statement,
        outcome.inputs,
        outcome.evidence,
      );
  }

  // 3. moved-unchanged: groups by kind, name and span text.
  const groups = new Map<
    string,
    { added: Array<Candidate>; removed: Array<Candidate> }
  >();
  for (const candidate of candidates) {
    const { kind, name, spanSha256 } = candidate.identity.parts;
    const key = canonicalJson([kind, name, spanSha256]);
    const group = groups.get(key) ?? { added: [], removed: [] };
    (candidate.added ? group.added : group.removed).push(candidate);
    groups.set(key, group);
  }
  const byPlace = (a: Candidate, b: Candidate) =>
    byCodeUnits(a.section.path, b.section.path) ||
    a.start - b.start ||
    byCodeUnits(a.identity.key, b.identity.key);
  for (const group of groups.values()) {
    if (group.added.length === 0 || group.removed.length === 0) continue;
    group.added.sort(byPlace);
    group.removed.sort(byPlace);
    const evidence = [
      EVIDENCE.identityName,
      EVIDENCE.identity,
      EVIDENCE.declaration,
      EVIDENCE.oldOnly,
      EVIDENCE.ranges,
      EVIDENCE.text,
      EVIDENCE.spanSize,
    ];
    const inputsOf = (candidate: Candidate, other: Candidate | null) => ({
      kind: candidate.identity.parts.kind,
      name: candidate.identity.parts.name,
      spanSha256: candidate.identity.parts.spanSha256,
      side: candidate.added ? "added" : "removed",
      ...candidate.inputs,
      added: group.added.length,
      removed: group.removed.length,
      other:
        other === null
          ? null
          : { key: other.identity.key, path: other.section.path },
    });
    if (group.added.length !== group.removed.length) {
      for (const candidate of [...group.added, ...group.removed])
        add(
          candidate.section,
          candidate.identity,
          "moved-unchanged",
          "not-held",
          "ambiguous",
          `${plural(group.added.length, "declaration")} of this kind, name and text ${group.added.length === 1 ? "was" : "were"} added and ${group.removed.length} removed, so none is paired`,
          inputsOf(candidate, null),
          evidence,
        );
      continue;
    }
    group.added.forEach((added, index) => {
      const removed = group.removed[index]!;
      for (const [one, other] of [
        [added, removed],
        [removed, added],
      ] as const) {
        if (one.section.path === other.section.path)
          add(
            one.section,
            one.identity,
            "moved-unchanged",
            "not-held",
            "same-path",
            `the declaration of the same kind, name and text it pairs with was ${one.added ? "removed from" : "added in"} the same path`,
            inputsOf(one, other),
            evidence,
          );
        else
          add(
            one.section,
            one.identity,
            "moved-unchanged",
            "holds",
            null,
            `its text is byte-identical to that of the declaration of the same kind and name ${one.added ? "removed from" : "added in"} ${other.section.path}, and the section owns every non-blank line of it`,
            inputsOf(one, other),
            evidence,
          );
      }
    });
  }

  const order = SectionRuleName.options;
  return sections.flatMap((section) => {
    const held = judgements.get(section.key);
    return held === undefined
      ? []
      : order.flatMap((rule) => {
          const judgement = held.get(rule);
          return judgement === undefined ? [] : [judgement];
        });
  });
};

// ---------------------------------------------------------------------------------------------
// Rule decisions: the sections code decides, so they skip the model readings (decision 14.17).
// What a decision is lives in `section-rule-decision.ts`, which the reading plan reads alone.

export {
  DECIDING_RULE_NAMES,
  DecidingRuleName,
  RULE_SKIPS_RECIPE,
  RuleDecision,
} from "./section-rule-decision.ts";

/**
 * Each deciding rule's stated limit, when it has one. The rules not in `DECIDING_RULE_NAMES` keep
 * their sections' reading: `comment-only` (a tool that scans source text, comments included, is not
 * seen), `markdown-prose` (prose is acted on literally) and `deletion-only` (not in 14.17's list).
 */
const LIMITS: Readonly<Record<DecidingRuleName, string | null>> = {
  generated: null,
  "blank-rows-only": null,
  "whitespace-only": null,
  "imports-only": null,
  "moved-unchanged":
    "the names the declaration uses are not checked to mean the same in the new file",
};
// Keyed by `SectionRuleName`, so a deciding rule that is no rule does not compile.
const DECIDING = new Map<
  SectionRuleName,
  { rank: number; rule: DecidingRuleName }
>(DECIDING_RULE_NAMES.map((rule, rank) => [rule, { rank, rule }]));

/**
 * An imports-only hold decides only when its inputs show no module load added, none dropped and
 * the value imports in the same order: each changes what runs, or in which order, when the file
 * loads. An input that is absent or not of its type (an array, a boolean) decides nothing.
 */
const loadsUnchanged = (inputs: SectionRuleJudgement["inputs"]) => {
  const added = inputs.newModuleLoads;
  const dropped = inputs.droppedModuleLoads;
  const reordered = inputs.valueImportOrderChanged;
  return (
    Array.isArray(added) &&
    Array.isArray(dropped) &&
    added.length === 0 &&
    dropped.length === 0 &&
    reordered === false
  );
};

/**
 * The sections code decides, by section identity key (`about.key`, the key `sectionIdentities`
 * gives and the reading plan uses), from the stored rule judgements. A section is decided only by a
 * judgement of it that holds, of a rule in `DECIDING_RULE_NAMES`; an imports-only hold also needs
 * `loadsUnchanged`. Two decisions of one section: the first in `DECIDING_RULE_NAMES`' order. Pure.
 */
export const ruleDecisionsOf = (
  rules: ReadonlyArray<SectionRuleJudgement>,
): ReadonlyMap<string, RuleDecision> => {
  const chosen = new Map<string, { rank: number; decision: RuleDecision }>();
  for (const judgement of rules) {
    if (judgement.result !== "holds") continue;
    const deciding = DECIDING.get(judgement.rule);
    if (deciding === undefined) continue;
    if (judgement.rule === "imports-only" && !loadsUnchanged(judgement.inputs))
      continue;
    const before = chosen.get(judgement.about.key);
    if (before !== undefined && before.rank <= deciding.rank) continue;
    chosen.set(judgement.about.key, {
      rank: deciding.rank,
      decision: {
        rule: deciding.rule,
        version: judgement.version,
        judgement: judgement.id,
        statement: judgement.statement,
        limit: LIMITS[deciding.rule],
      },
    });
  }
  return new Map(
    [...chosen].map(([key, { decision }]) => [key, decision] as const),
  );
};

// ---------------------------------------------------------------------------------------------
// Stored.

/** The blob Linguist reads for a path: its head blob, or the base blob where the file is deleted. */
const linguistBlobOf = (hunks: ReadonlyArray<ManifestHunk>) => {
  const head = hunks.find((hunk) => hunk.newOid !== null);
  if (head !== undefined) return { oid: head.newOid!, mode: head.newMode };
  const base = hunks.find((hunk) => hunk.oldOid !== null);
  return base === undefined ? null : { oid: base.oldOid!, mode: base.oldMode };
};

/** A pattern family as stored (`SectionFamily` of `section-token-rules.ts`). */
export const StoredSectionFamily = z.strictObject({
  family: z.string(),
  representative: z.string(),
  members: z.array(z.string()),
  kind: z.string(),
  tokens: z.int().min(0),
});
export type StoredSectionFamily = z.infer<typeof StoredSectionFamily>;

/** `families` only where tokens were asked for: without them the stored bytes are what they were. */
const SectionRulesOutput = z.strictObject({
  rules: z.array(SectionRuleJudgement),
  families: z.array(StoredSectionFamily).optional(),
});

/** What `storedSectionRules` reads beyond the rules that need no Graph. Neither: as before. */
export interface SectionRulesOptions {
  /**
   * Read Graph's syntax leaves of both sides of every changed text file (`blobTokens`) when the
   * stored judgements are not found, for the token rules and the pattern families. Off unless given.
   */
  readonly tokens?: boolean;
  /** What `relationsRound` gave for the range's base and head commits. */
  readonly relations?: RelationsRound;
}

/**
 * A relations side as the key names it: the read (the index's format, which is its recipe, and the
 * commit, tree, profile and engine), or its gap. An index of another recipe is another read.
 */
const relationsIdentity = (side: RelationsSide): z.core.util.JSONType =>
  isRelationsGap(side)
    ? { gap: side.gap, tag: side.tag }
    : {
        format: side.format,
        commit: side.coverage.commit,
        tree: side.coverage.tree,
        profile: side.coverage.profile,
        engine: {
          name: side.coverage.provider.name,
          version: side.coverage.provider.version,
          identityRevision: side.coverage.provider.identityRevision,
          sha256: side.coverage.provider.executable.sha256,
        },
      };

/**
 * Whether no other file named as `manifest` sits in a nearer ancestor folder of `importer`, in a
 * tree's set of paths; false where the manifest's folder is no ancestor of the importer at all.
 */
export const nearestManifest =
  (paths: ReadonlySet<string>) =>
  (importer: string, manifest: string): boolean => {
    const slash = manifest.lastIndexOf("/");
    const name = manifest.slice(slash + 1);
    const home = slash === -1 ? "" : manifest.slice(0, slash);
    for (
      let folder = importer.includes("/")
        ? importer.slice(0, importer.lastIndexOf("/"))
        : "";
      ;
      folder = folder.includes("/")
        ? folder.slice(0, folder.lastIndexOf("/"))
        : ""
    ) {
      if (folder === home) return true;
      if (paths.has(folder === "" ? name : `${folder}/${name}`)) return false;
      if (folder === "") return false;
    }
  };

/**
 * The relations the token rules read, from a round: `importTarget` at either side, and the relation
 * slice of a section, cut once for every section of the range so a caller another section changed
 * counts as changed. Test callers are not read by any rule, so no file is taken for a test.
 */
const relationsOf = (
  round: RelationsRound,
  sections: ReadonlyArray<Section>,
  hunks: ReadonlyArray<ManifestHunk>,
  manifestIsNearest: (importer: string, manifest: string) => boolean,
): SectionRelations => {
  let slices: ReadonlyMap<string, RelationSlice> | undefined;
  const byId = new Map(hunks.map((hunk) => [hunk.hunkId, hunk]));
  return {
    importTarget: (side, path, specifier) =>
      importTarget(side === "head" ? round.head : round.base, path, specifier),
    slice: (key) => {
      if (slices === undefined) {
        const subjects = sections.map((section): SliceSubject => ({
          key: section.key,
          ranges: section.ranges.map((range) => {
            const hunk = byId.get(range.hunkId);
            return {
              side: range.side,
              path:
                (range.side === "old" ? hunk?.oldPath : hunk?.newPath) ??
                section.path,
              startLine: range.startLine,
              lineCount: range.lineCount,
            };
          }),
        }));
        slices = new Map(
          relationSlices(round, subjects, {
            base: () => false,
            head: () => false,
          }).map((slice) => [slice.key, slice]),
        );
      }
      return slices.get(key);
    },
    manifestIsNearest,
  };
};

/**
 * Tokens records by blob object id, from answers by path and blob. A blob read under two paths
 * whose answers differ gets none, with the gap `conflicting-paths`, as structures do.
 */
const tokensByBlob = (
  entries: ReadonlyArray<TreeEntry>,
  answers: ReadonlyMap<string, BlobTokensAnswer>,
): SectionTokensInput => {
  const byBlob = new Map<string, BlobTokensAnswer>();
  const conflicting = new Set<string>();
  for (const entry of entries) {
    const answer = answers.get(structureKeyOf(entry.path, entry.oid));
    if (answer === undefined || conflicting.has(entry.oid)) continue;
    const held = byBlob.get(entry.oid);
    if (held !== undefined && JSON.stringify(held) !== JSON.stringify(answer))
      conflicting.add(entry.oid);
    else byBlob.set(entry.oid, answer);
  }
  const records = new Map<string, GraphFileTokens>();
  const notRead = new Map<string, TokensGap>();
  for (const [oid, answer] of byBlob) {
    if (conflicting.has(oid))
      notRead.set(oid, { reason: "conflicting-paths", retryable: false });
    else if (answer.status === "read") records.set(oid, answer.tokens);
    else
      notRead.set(oid, { reason: answer.reason, retryable: answer.retryable });
  }
  return { byBlob: records, notRead };
};

/**
 * The rule judgements of a manifest's hunks, stored as `harness.section-rules@1`. The facts come
 * through `storedSectionFacts`; the two attributes are read at `revision` for every changed path,
 * in a Git directory of their own (`readAttributes`), with the revision's `.gitattributes` files
 * read for a literal `=unset` or `=unspecified` (`ambiguousAttributes`), both in the key;
 * the blobs read are the head blob of each changed file (the base blob of a deleted one) for
 * Linguist, and both sides of each Markdown file, with the repository's batched reader. A blob over
 * the index's size bound, a submodule, a symlink or a blob the reader does not return is not read,
 * and the rules say so. Keyed by the facts' key, this recipe and the rule versions, the Linguist
 * recipe, the attribute values and the blobs read; computed off the event loop, once per key. Not
 * wired into any stage.
 *
 * `options.tokens`: when the stable key misses, both sides of every changed text file are read with
 * Graph's syntax leaves (`blobTokens`), and the token rules and pattern families are computed from
 * them; tokens are never stored. The key then also names the blobs read, the engine and the
 * families' recipe. A read that fails never fails the call: the token rules say they were not
 * evaluated and why. A retryable answer keeps the judgements off the stable key.
 * `options.relations`: `relationsRound`'s sides, for `deletion-only` and the targets of added
 * imports, named in the key by each side's read or gap; with tokens, the nearest manifest is told
 * from the tree at `revision`. With neither option, the stored output and its key are what they were.
 */
/**
 * The spec a rules run with tokens stores its judgements under: the stable spec when every blob's
 * tokens were settled, else the stable spec whose configuration names each unsettled blob as
 * `[path, "git-blob:<oid>", reason]`, so a call with other gaps does not find the same output.
 */
export const rulesRunSpec = (
  spec: Computations.ComputationSpec,
  unsettled: ReadonlyArray<readonly [string, string, string]>,
): Computations.ComputationSpec =>
  unsettled.length === 0
    ? spec
    : {
        ...spec,
        config: {
          ...(spec.config as Record<string, z.core.util.JSONType>),
          retryable: unsettled.map((entry) => [...entry]),
        },
      };

export const storedSectionRules = (
  repository: string,
  revision: string,
  hunks: ReadonlyArray<ManifestHunk>,
  source: OutlineSource,
  options: SectionRulesOptions = {},
) =>
  Effect.gen(function* () {
    const withTokens = options.tokens === true;
    const relations = options.relations;
    const store = yield* Computations.ComputationStore;
    const facts = yield* storedSectionFacts(repository, hunks, source);
    // The structures the facts were computed from: stored, so this reads the store, not Graph. A
    // retryable structure read again can differ; then the facts' key no longer matches, and this
    // fails rather than judge sections against another cut.
    const entries = hunkBlobEntries(hunks);
    const read = yield* blobStructures(
      repository,
      [...entries.values()],
      source,
    );
    const structures = yield* cpuWork(
      repositoryOwner(repository),
      Effect.sync(() => {
        const joined = structuresByBlob(
          entries.values(),
          read.structures,
        ).byBlob;
        return {
          byBlob: joined,
          key: Computations.computationKey(sectionFactsSpec(hunks, joined)).key,
        };
      }),
    );
    if (structures.key !== facts.key)
      return yield* Effect.fail(
        new Error(
          "Blob structures changed between the section facts and their rules; run again",
        ),
      );

    const paths = [
      ...new Set(facts.sections.map((section) => section.path)),
    ].sort(byCodeUnits);
    // The commit's attributes, and what makes them unsure: a literal word as the value.
    const commitAttributes = yield* readCommitAttributes(
      repository,
      revision,
      paths,
    );
    const attributes = commitAttributes.values;
    const ambiguous = ambiguousAttributes(
      commitAttributes.files,
      attributes,
      paths,
    );
    const hunksByPath = new Map<string, Array<ManifestHunk>>();
    for (const hunk of hunks) {
      const held = hunksByPath.get(hunk.path);
      if (held === undefined) hunksByPath.set(hunk.path, [hunk]);
      else held.push(hunk);
    }
    const markdownPaths = new Set(
      facts.sections
        .filter((section) => section.basis === "markdown-sections")
        .map((section) => section.path),
    );
    // What to read: per path its Linguist blob, and both sides of a Markdown file.
    const linguistBlobs = new Map<
      string,
      { oid: string; readable: boolean } | null
    >();
    const wanted = new Map<
      string,
      { linguist: Array<string>; markdown: boolean }
    >();
    const want = (oid: string, use: { path?: string; markdown?: boolean }) => {
      const held = wanted.get(oid) ?? { linguist: [], markdown: false };
      if (use.path !== undefined) held.linguist.push(use.path);
      if (use.markdown === true) held.markdown = true;
      wanted.set(oid, held);
    };
    for (const path of paths) {
      const own = hunksByPath.get(path) ?? [];
      const blob = linguistBlobOf(own);
      const readable = blob !== null && linguistBlobReadable(path, blob.mode);
      linguistBlobs.set(
        path,
        blob === null ? null : { oid: blob.oid, readable },
      );
      if (readable) want(blob.oid, { path });
      if (markdownPaths.has(path))
        for (const hunk of own)
          for (const [oid, mode] of [
            [hunk.oldOid, hunk.oldMode],
            [hunk.newOid, hunk.newMode],
          ] as const)
            if (oid !== null && mode !== "160000" && mode !== "120000")
              want(oid, { markdown: true });
    }
    const oids = [...wanted.keys()].sort(byCodeUnits);
    const sizes = yield* blobSizes(repository, oids);
    const toRead = oids.flatMap((oid) => {
      const size = sizes.get(oid);
      return size === undefined || size > INDEX_BOUNDS.maxFileBytes
        ? []
        : [{ oid, size }];
    });
    const marks = new Map<string, LinguistMark>();
    const texts = new Map<string, string | null>();
    const readOids = new Set<string>();
    // Groups are bounded by size; bytes are dropped once each group's marks and texts are taken.
    for (const group of groupsBySize(toRead)) {
      const bytes = yield* readBlobs(
        repository,
        group.map((entry) => entry.oid),
      );
      const done = yield* cpuWork(
        repositoryOwner(repository),
        Effect.sync(() =>
          group.flatMap(({ oid }) => {
            const blob = bytes.get(oid);
            if (blob === undefined || overSize(blob)) return [];
            const use = wanted.get(oid)!;
            return [
              {
                oid,
                // The shared reading of a blob (`linguist-lists.ts`), as the `linguist` reader's.
                marks: use.linguist.flatMap((path) => {
                  const { read, mark } = linguistMarkRead(path, blob);
                  return read && mark !== null ? [[path, mark] as const] : [];
                }),
                text: use.markdown ? (blobText(blob) ?? null) : undefined,
              },
            ];
          }),
        ),
      );
      for (const entry of done) {
        readOids.add(entry.oid);
        for (const [path, mark] of entry.marks) marks.set(path, mark);
        if (entry.text !== undefined) texts.set(entry.oid, entry.text);
      }
    }
    const files = new Map<string, FileSignals>();
    for (const path of paths) {
      const blob = linguistBlobs.get(path) ?? null;
      const read = blob !== null && blob.readable && readOids.has(blob.oid);
      files.set(path, {
        attributes: attributes.get(path) ?? allUnspecified(),
        trust: { ambiguous: ambiguous.get(path) ?? [] },
        blob: blob?.oid ?? null,
        read,
        mark: (read ? marks.get(path) : undefined) ?? linguistMarkOf(path),
      });
    }
    // Both sides of every changed text hunk, each blob under each path once, in a fixed order.
    const tokenEntries = withTokens
      ? [...hunkBlobEntries(hunks).values()].sort(
          (a, b) => byCodeUnits(a.path, b.path) || byCodeUnits(a.oid, b.oid),
        )
      : [];
    // The nearest manifest is told from the head tree's paths: read only where imports-only can ask.
    let headTree: string | undefined;
    let manifestIsNearest: (
      importer: string,
      manifest: string,
    ) => boolean = () => false;
    // The tree's id is in the key; its listing is read only when the stored key misses.
    if (withTokens && relations !== undefined)
      headTree = yield* treeOf(repository, revision);
    const config = {
      recipe: SECTION_RULES_RECIPE,
      versions: SECTION_RULE_VERSIONS,
      linguist: standardAsGiven(),
      controlFiles: CONTROL_FILES_RECIPE,
      bounds: INDEX_BOUNDS,
      ...(withTokens
        ? {
            tokens: {
              source: source.key,
              sourceBinding: GRAPH_SOURCE_BINDING,
              batchBytes: SYMBOL_TOKENS_BATCH_BYTES,
            },
            families: {
              recipe: SECTION_FAMILIES_RECIPE,
              minTokens: FAMILY_MIN_TOKENS,
              minMembers: FAMILY_MIN_MEMBERS,
            },
          }
        : {}),
    };
    const spec: Computations.ComputationSpec = {
      op: "harness.section-rules",
      opVersion: 1,
      inputs: {
        facts: facts.key,
        // The facts' key keeps declared kinds only; the judgements also name the readers.
        declared: paths.map((path) => [
          path,
          [
            ...new Map(
              (hunksByPath.get(path) ?? [])
                .flatMap((hunk) => hunk.declared)
                .map((entry) => [canonicalJson([entry.kind, entry.by]), entry]),
            ).values(),
          ]
            .sort(
              (a, b) => byCodeUnits(a.kind, b.kind) || byCodeUnits(a.by, b.by),
            )
            .map((entry) => ({ kind: entry.kind, by: entry.by })),
        ]),
        // Each path's three printed values, and which read alike as a state and a value, where.
        attributes: paths.map((path) => {
          const values = files.get(path)!.attributes;
          return [
            path,
            values["linguist-generated"],
            values["linguist-vendored"],
            values.diff ?? null,
            (ambiguous.get(path) ?? []).map((entry) => [
              entry.attribute,
              entry.word,
              [...entry.files],
              [...entry.unread],
            ]),
          ];
        }),
        linguistBlobs: paths.map((path) => {
          const file = files.get(path)!;
          return [
            path,
            file.blob === null ? null : `git-blob:${file.blob}`,
            file.read,
          ];
        }),
        markdownBlobs: oids
          .filter((oid) => wanted.get(oid)!.markdown)
          .map((oid) => [`git-blob:${oid}`, texts.has(oid)]),
        // With tokens: both sides of every changed text file are read, by path, blob and mode. What
        // Graph answers for them is fixed by the engine below, except a retryable answer, which
        // takes another key (`retryable`).
        ...(withTokens
          ? {
              tokens: tokenEntries.map((entry) => [
                entry.path,
                `git-blob:${entry.oid}`,
                entry.mode,
              ]),
            }
          : {}),
        // Each side's stored read (commit, tree, profile, engine), or its gap; and with tokens the
        // head tree whose paths tell the nearest manifest.
        ...(relations === undefined
          ? {}
          : {
              relations: {
                base: relationsIdentity(relations.base),
                head: relationsIdentity(relations.head),
                ...(withTokens ? { tree: `git-tree:${headTree}` } : {}),
              },
            }),
      },
      config,
    };
    const compute = (
      tokens: SectionTokensInput | undefined,
      contents: ReadonlyMap<string, Uint8Array> | undefined,
    ) =>
      cpuWork(
        repositoryOwner(repository),
        Effect.sync(() => {
          const given = {
            ...(tokens === undefined ? {} : { tokens }),
            ...(contents === undefined ? {} : { contents }),
          };
          return {
            bytes: new TextEncoder().encode(
              JSON.stringify({
                rules: sectionRulesOf({
                  result: facts,
                  hunks,
                  structures: structures.byBlob,
                  files,
                  texts,
                  ...given,
                  ...(relations === undefined
                    ? {}
                    : {
                        relations: relationsOf(
                          relations,
                          facts.sections,
                          hunks,
                          manifestIsNearest,
                        ),
                      }),
                }),
                ...(withTokens
                  ? {
                      families: sectionFamiliesOf({
                        result: facts,
                        hunks,
                        ...given,
                      }),
                    }
                  : {}),
              }),
            ),
            mediaType: "application/json",
          };
        }),
      );
    // Without tokens: one run per key, as before. With tokens, the stable key is looked up first and
    // Graph is read only when it misses; a retryable answer (Graph unavailable, a partial failure,
    // a blob not returned) gives judgements keyed by its reasons beside the stable key, so the
    // stable key never holds them and the next call reads again (as `blobStructureSpec` keys a
    // retryable structure).
    let run: {
      status: Computations.RunResult["status"];
      output: Uint8Array;
    };
    let tokensRead:
      | { counts: BlobTokensCounts; wallMs: number; startedAtMs: number }
      | undefined;
    let retryable: ReadonlyArray<string> = [];
    // The spec the judgements returned are stored under: the stable one, unless a retryable
    // tokens read stored them beside it.
    let ran = spec;
    if (!withTokens)
      run = yield* store.run(spec, compute(undefined, undefined));
    else {
      const [held] = yield* storedBytes([spec]);
      if (held !== undefined) run = { status: "reused", output: held.bytes };
      else {
        if (headTree !== undefined) {
          const listed = yield* lsTree(repository, headTree);
          manifestIsNearest = nearestManifest(
            new Set(listed.map((entry) => entry.path)),
          );
        }
        const startedAtMs = Date.now();
        const begun = performance.now();
        const read = yield* blobTokens(repository, tokenEntries, source);
        tokensRead = {
          counts: read.counts,
          wallMs: Math.round(performance.now() - begun),
          startedAtMs,
        };
        // Each blob whose answer may change, with its reason: the retryable key names exactly which
        // blobs went without, so a later call with the same gaps finds the same judgements and one
        // with other gaps does not.
        const unsettled = tokenEntries.flatMap((entry) => {
          const answer = read.answers.get(
            structureKeyOf(entry.path, entry.oid),
          );
          if (answer === undefined || !answerRetryable(answer)) return [];
          const reason =
            answer.status === "not-read"
              ? answer.reason
              : answer.tokens.status === "unavailable"
                ? answer.tokens.reason
                : "retryable";
          return [[entry.path, `git-blob:${entry.oid}`, reason] as const];
        });
        retryable = [...new Set(unsettled.map(([, , reason]) => reason))].sort(
          byCodeUnits,
        );
        const tokens = tokensByBlob(tokenEntries, read.answers);
        ran = rulesRunSpec(spec, unsettled);
        run = yield* store.run(ran, compute(tokens, read.bytes));
      }
    }
    const result = run;
    const output = yield* cpuWork(
      repositoryOwner(repository),
      Effect.sync(() => decodeJson(result.output, SectionRulesOutput)),
    );
    const counts: Record<string, number> = {};
    for (const judgement of output.rules) {
      const label = `harness.section_rules.${judgement.rule}.${judgement.result}`;
      counts[label] = (counts[label] ?? 0) + 1;
    }
    yield* Effect.annotateCurrentSpan({
      "harness.section_rules.status": result.status,
      "harness.section_rules.judgements": output.rules.length,
      "harness.section_rules.blobs_read": readOids.size,
      "harness.section_rules.tokens": withTokens,
      "harness.section_rules.relations": relations !== undefined,
      "harness.section_rules.families": output.families?.length ?? 0,
      "harness.section_rules.retryable": retryable.join(","),
      ...counts,
    });
    return {
      ...facts,
      rules: output.rules,
      families: output.families ?? [],
      /** The stable key; a retryable outcome was stored beside it (`rulesRetryable`). */
      rulesKey: Computations.computationKey(spec).key,
      /**
       * The key these judgements are stored under: the retryable spec's (`rulesRunSpec`, naming
       * each blob that went without tokens and why) when there were gaps, else `rulesKey`. What
       * is built from the judgements keys on this one.
       */
      rulesRunKey: Computations.computationKey(ran).key,
      rulesStatus: result.status,
      /** The retryable reasons that kept these judgements off the stable key; empty when none. */
      rulesRetryable: retryable,
      /** The tokens read this call made; null where none was (no tokens, or the stable key held). */
      tokensRead: tokensRead ?? null,
    };
  }).pipe(Effect.withSpan("harness.section-rules"));
