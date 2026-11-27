import { z } from "zod";
import { addedLines, publicSurface } from "../lane-rule.ts";
import type { ManifestHunk } from "../manifest.ts";
import {
  ReadingBoundsSchema,
  readingGroups,
  type ReadingItem,
} from "../reading-groups.ts";
import {
  matchSymbols,
  sectionFactsOf,
  type SectionFact,
} from "../section-facts.ts";
import { sectionIdentities } from "../section-identity.ts";
import { RuleDecision } from "../section-rule-decision.ts";
import {
  asStructure,
  declarationCounterparts,
  sectionLabel,
  sectionsOf,
  spanIndexAt,
  StructureReason,
  type BlobStructure,
  type Section,
  type Structure,
} from "../sections.ts";
import {
  readingOrder,
  sectionCharacters,
  type ChangeFactInput,
} from "./reading.ts";
import { effortFactsOf, isHigh } from "./effort.ts";
import {
  changedLines,
  groupPairing,
  pairingBlob,
  sectionPairing,
} from "./pairing.ts";

/**
 * The reading plan: which changed sections of a range are read, in which reading groups, and in
 * which order the scheduler takes the groups. Pure and synchronous; the caller runs it off the event
 * loop. It computes the sections (`sectionsOf`) and their identities (`sectionIdentities`) itself
 * from the hunks and the stored structures, so a plan can never pair a section with another run's
 * identity. The value is stored as a computation, so it holds plain arrays only, in one order that
 * does not depend on the order of the input. Before it is stored, `pairPlan` adds each removing
 * section's pairing rows from the commit's blob texts, and changes nothing else.
 *
 * Every changed row the review rules own is in exactly one section of the plan: `sections` (read)
 * and `unread` (not read, with a cause) together. Every section in `sections` is in exactly one
 * group.
 *
 * A submodule pointer (gitlink) section is read in a group of its own (`isGitlink`). A group's
 * readings are keyed by its whole reading text, so a pointer that moves would otherwise make every
 * unchanged section packed with it be read again; its own text is only the two commit IDs, so no
 * other section loses anything it could have been shown.
 */

/**
 * Whether a section is a submodule pointer: one of its hunks has the gitlink file mode `160000` on
 * either side, as the manifest records it from the diff (`HunkRecord.oldMode`, `newMode`). Never
 * guessed from a path.
 */
export const isGitlink = (hunks: ReadonlyArray<ManifestHunk>) =>
  hunks.some((hunk) => hunk.oldMode === "160000" || hunk.newMode === "160000");

/**
 * The reading's own recipe: change it whenever the plan or the rendered reading would change.
 * 2: one context row each side, unlabelled; a signature only where a changed row is on it; no
 * member list; one data block per file; each section's size counts its lines only.
 * 3: a context row is marked "="; a signature is shown where it differs from the other side's.
 * 4: a section may end with the caller and test rows its group was shown, and the legend says what
 * they are when the reading shows one (`readings/evidence.ts`).
 * 5: a caller or test row may be marked unconfirmed, and the legend says what that means.
 * 6: the legend says an unconfirmed row was matched by name only.
 * 7: where the rows' lines are not the calls' own, each row names the function that calls and the
 * legend says its line is that function's first line.
 * 8: a section that removes rows may carry pairing rows (`paired`, `readings/pairing.ts`): lines of
 * its declaration that name what a removed row named, each marked "paired" with its line number,
 * and the legend says what they are when the reading shows one.
 * 9: each caller and test row says what its line shows ("called here", "used here", or "called
 * from" and the calling function, with or without a line), and the legend says what each shown kind
 * is and, when a test row is shown, that a test naming the code proves nothing about what it
 * catches (`EVIDENCE_LEGEND`).
 * 10: a caller row from a file whose test status the reader could not settle is marked "may be a
 * test", and the legend says what that means when the reading shows one (`EVIDENCE_LEGEND`).
 * Version 10 also covers a submodule pointer section read in a group of its own (`isGitlink`):
 * both changes land in one release, so a stored reading misses once, not twice. Do not bump it
 * again for that.
 */
export const READING_RECIPE = "neuve-reading-v10";

/**
 * The readings' recipe with scope and tests on (`ReadingsConfig.scopeAndTests`): `READING_RECIPE`'s
 * reading, plus a Lane review reading's line on each file no done-when row covers and its list of
 * the change's files read separately (`OTHER_FILES`), and an Assess reading's legend sentence on
 * tests (`renderReading`, `scopeAndTests`). It keys those two readings' steps and is frozen into the
 * run's configuration. The plan is the same with it on or off: its recipe and key stay
 * `READING_RECIPE`'s, so a measured pair reads one plan. It moves with `READING_RECIPE`.
 */
export const READING_RECIPE_SCOPE_AND_TESTS = `${READING_RECIPE}+scope-and-tests`;

/**
 * A section whose own rendered reading is over this many characters is not read: even alone it
 * cannot be read whole. It is far above a group's character bound, which only puts a large section
 * in a group of its own.
 */
export const READING_TOO_LARGE = 160_000;

const Side = z.enum(["old", "new"]);

const SectionKind = z.enum([
  "imports",
  "declaration",
  "statement",
  "member",
  "heading",
  "head",
  "tail",
  "hunk",
  "nontext",
]);

/** A section's identity as `sectionIdentities` gives it, whole: its key, its parts and what is not part of the key. */
export const PlanIdentity = z.strictObject({
  key: z.string().regex(/^[0-9a-f]{64}$/),
  parts: z.strictObject({
    path: z.string(),
    side: z.enum(["new", "old", "none"]),
    kind: SectionKind,
    name: z.string().nullable(),
    spanSha256: z.string().nullable(),
    counterpartSha256: z.string().nullable(),
    hunkContentKeys: z.array(z.string()),
    changeSha256: z.string(),
    ordinal: z.int().min(1),
  }),
  where: z.strictObject({ startLine: z.int(), endLine: z.int() }).nullable(),
  renamedFrom: z.string().nullable(),
});
export type PlanIdentity = z.infer<typeof PlanIdentity>;

export const DeclaredSectionKind = z.enum(["test", "doc", "generated"]);
export type DeclaredSectionKind = z.infer<typeof DeclaredSectionKind>;

export const PlanSection = z.strictObject({
  /** The section's identity key (`SectionIdentity.key`). */
  key: z.string().regex(/^[0-9a-f]{64}$/),
  path: z.string().min(1),
  kind: SectionKind,
  name: z.string().nullable(),
  /** The identity whole, as `sectionIdentities` gave it; `identity.key` is `key`. */
  identity: PlanIdentity,
  /** The section's one-line title (`sectionLabel`). */
  title: z.string(),
  /**
   * Its known code facts (`sectionFactsOf`; a fact whose value is not known is left out), by ID and
   * statement, in the order given; none when the facts could not be computed.
   */
  facts: z.array(z.strictObject({ id: z.string(), statement: z.string() })),
  /** From its hunks' declarations: generated before test before doc; null when undeclared. */
  declared: DeclaredSectionKind.nullable(),
  /** Whether its boundaries came from the file's structure or a fallback (one section per hunk). */
  boundaries: z.enum(["structure", "fallback"]),
  /** `Section.basis` as `sectionsOf` gave it: the capability, or why the fallback was taken. */
  basis: z.union([
    z.enum(["graph-symbols", "markdown-sections", "undeclared", "rules"]),
    z.literal("nontext"),
    StructureReason,
  ]),
  /** The enclosing span, on its side, where the section has one. */
  span: z
    .strictObject({
      side: Side,
      startLine: z.int().min(1),
      endLine: z.int().min(1),
    })
    .nullable(),
  /** The changed rows it owns, by hunk and side, with real line numbers. */
  owned: z.array(
    z.strictObject({
      hunkId: z.string().min(1),
      side: Side,
      startLine: z.int().min(1),
      endLine: z.int().min(1),
    }),
  ),
  /** Its hunks, in file order. */
  hunkIds: z.array(z.string().min(1)),
  /** Its first line in the file (`Section.first`): the reading order of a file's sections. */
  first: z.int().min(0),
  /** The size of its rendered reading (`sectionCharacters`); 0 for a section with no text. */
  characters: z.int().min(0),
  /**
   * Whether its span lost a symbol: a symbol of the base span with no match in the head span, by the
   * sections lane's `symbols-removed` fact (`section-facts.ts`), read from the fact's value
   * (`symbolRemovedOf`). Null when that is not known; never a default.
   */
  symbolRemoved: z.boolean().nullable(),
  /**
   * Whether every removed row it owns was attributed to a symbol that still exists at the head
   * (`removalAttribution`): true, false (a row could not be, by a rule below) or null (not known: no
   * structure to attribute by). True when it removes no row.
   */
  removedAttributed: z.boolean().nullable(),
  /**
   * The head symbols its removed rows were attributed to, each by its lines at the head, in line
   * order, each once; empty unless `removedAttributed` is true.
   */
  removedHeads: z.array(
    z.strictObject({ startLine: z.int().min(1), endLine: z.int().min(1) }),
  ),
  /**
   * Its pairing rows (`readings/pairing.ts`, decided by `pairPlan`): lines of its declaration that
   * name what one of its removed rows named, in line order. Absent when it has none, so a plan
   * where no section has any is the plan without them, byte for byte. Not counted in `characters`:
   * `PER_GROUP` bounds them per group instead, so they never move a section to another group.
   */
  paired: z
    .array(
      z.strictObject({
        side: Side,
        line: z.int().min(1),
        text: z.string(),
      }),
    )
    .min(1)
    .optional(),
  /** The schedule order (see `rank`). */
  rank: z.int().min(0).max(1_000_000),
});
export type PlanSection = z.infer<typeof PlanSection>;

/**
 * Why a section gets no reading. `excluded`: a lockfile or declared-generated file, which stays in
 * today's code-only batch. `unreadable`: no text (a binary file, a mode-only change). `too-large`:
 * its own reading is over `READING_TOO_LARGE`. `rule-decided`: a code rule decides it
 * (`ruleDecisionsOf`, given as `PlanInput.decided`), and the section says which (`decidedBy`).
 */
export const UnreadCause = z.enum([
  "excluded",
  "unreadable",
  "too-large",
  "rule-decided",
]);
export type UnreadCause = z.infer<typeof UnreadCause>;

const ReadingNoteSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("oversize"),
    key: z.string(),
    path: z.string(),
  }),
  z.strictObject({
    kind: z.literal("continued"),
    path: z.string(),
    part: z.int().min(1),
    parts: z.int().min(2),
  }),
]);

export const PlanGroup = z.strictObject({
  id: z.string().min(1),
  /** Member section identity keys, in reading order. */
  keys: z.array(z.string()),
  /** Distinct paths, in reading order. */
  paths: z.array(z.string()),
  totals: z.strictObject({
    files: z.int().min(0),
    characters: z.int().min(0),
    items: z.int().min(0),
  }),
  notes: z.array(ReadingNoteSchema),
  /** Its highest section's rank. */
  rank: z.int().min(0).max(1_000_000),
});
export type PlanGroup = z.infer<typeof PlanGroup>;

export const ReadingPlan = z.strictObject({
  recipe: z.literal(READING_RECIPE),
  bounds: z.strictObject({
    maxFiles: z.int().positive(),
    maxCharacters: z.int().positive(),
    maxItems: z.int().positive(),
  }),
  /** The sections that are read, in file order. */
  sections: z.array(PlanSection),
  /** Reading groups over `sections`, in `readingGroups`' order (not by rank). */
  groups: z.array(PlanGroup),
  /**
   * The sections that are not read, in file order, each with its cause; a `rule-decided` one also
   * with its decision (`decidedBy`), which no other section has.
   */
  unread: z.array(
    PlanSection.extend({
      cause: UnreadCause,
      decidedBy: RuleDecision.optional(),
    }).refine(
      (section) =>
        (section.cause === "rule-decided") ===
        (section.decidedBy !== undefined),
      { message: "a section has a decision exactly when a rule decides it" },
    ),
  ),
});
export type ReadingPlan = z.infer<typeof ReadingPlan>;

export interface PlanInput {
  /** The range's hunks (the range manifest's). */
  readonly hunks: ReadonlyArray<ManifestHunk>;
  /** Each blob's stored structure, by object ID. */
  readonly structures: ReadonlyMap<string, BlobStructure>;
  /** The reading bounds; the defaults when absent. */
  readonly bounds?: z.input<typeof ReadingBoundsSchema> | undefined;
  /** The paths the map excluded as lockfiles or declared-generated files (`MapManifest.excluded`). */
  readonly excluded?:
    | ReadonlyArray<{
        readonly path: string;
        readonly reason:
          | "lockfile"
          | "declared-generated"
          | "linguist-generated"
          | "linguist-vendored";
      }>
    | undefined;
  /** Map assigns each changed file to one batch. Pack each batch independently. */
  readonly batches?: ReadonlyArray<ReadonlySet<string>> | undefined;
  /** Affinity keys per path for `readingGroups`, such as a Map group. */
  readonly affinity?: ReadonlyMap<string, ReadonlyArray<string>> | undefined;
  /** Change facts, so each section's size counts the facts its reading shows. */
  readonly facts?: ReadonlyArray<ChangeFactInput> | undefined;
  /**
   * Effort by risk: `"by-risk"` packs the reading groups within each class (`readings/effort.ts`):
   * the high-class sections' groups, then the medium-class sections'. Absent, the groups are exactly
   * as before.
   */
  readonly split?: "by-risk" | undefined;
  /**
   * The sections a code rule decides, by section identity key (`ruleDecisionsOf`): each is not
   * read, with cause `rule-decided` and its decision, and is in no group. A lockfile or
   * declared-generated file stays `excluded`. Absent, the plan is exactly as before.
   */
  readonly decided?: ReadonlyMap<string, RuleDecision> | undefined;
}

const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const DECLARED_ORDER: ReadonlyArray<DeclaredSectionKind> = [
  "generated",
  "test",
  "doc",
];

/**
 * The schedule order, "riskiest first": an integer from 0 to 1,000,000 that the scheduler takes,
 * higher first, from code facts only. Undeclared source is above tests, tests above documentation;
 * within a kind, a section that adds a public name (`publicSurface`) is above one that removes
 * lines (more removed rows than added ones, so a pure removal counts and a one-for-one replacement
 * does not), which is above one that does neither; more changed rows break the remaining ties. It is a
 * schedule order only: never recorded on a unit, never shown, and never a score (decision 10.22).
 */
const rankOf = (
  declared: DeclaredSectionKind | null,
  facts: {
    readonly publicName: boolean;
    readonly removes: boolean;
    readonly rows: number;
  },
) =>
  (declared === null
    ? 3
    : declared === "test"
      ? 2
      : declared === "doc"
        ? 1
        : 0) *
    250_000 +
  (facts.publicName ? 120_000 : 0) +
  (facts.removes ? 80_000 : 0) +
  Math.min(facts.rows, 49_999);

const hunkOrder = (a: ManifestHunk, b: ManifestHunk) =>
  a.newStart - b.newStart ||
  a.oldStart - b.oldStart ||
  byCodeUnits(a.hunkId, b.hunkId);

/**
 * Whether a section's span lost a symbol, from the sections lane's facts' own values
 * (`section-facts.ts` writes `symbols-removed` for every section it gives facts for):
 * - `true`: `symbols-removed` names at least one symbol (a base-span symbol with no match in the
 *   head span, by kind, container, name and occurrence);
 * - `false`: it names none; or its value is not known because the declaration is not on both sides
 *   (`no-counterpart`) and the `declaration` fact says `added` and the section owns no old line, so
 *   there was no base span to lose a symbol from;
 * - `null`: the facts could not be computed (the plan holds none), the fact is absent, or its value
 *   is not known for any other reason: the section has no span (`section-basis:*`), or the
 *   declaration was removed or cannot be told (`no-counterpart` without `added`).
 */
export const symbolRemovedOf = (
  removed: SectionFact | undefined,
  declaration: SectionFact | undefined,
  owned: ReadonlyArray<{ readonly side: "old" | "new" }>,
): boolean | null => {
  if (removed === undefined) return null;
  if (Array.isArray(removed.value)) return removed.value.length > 0;
  if (
    removed.value === null &&
    removed.reason === "no-counterpart" &&
    declaration?.value === "added" &&
    owned.every((range) => range.side === "new")
  )
    return false;
  return null;
};

type StoredSymbol = BlobStructure["spans"][number]["symbols"][number];

/**
 * Where a section's removed rows are at the head (round 6d): each removed row it owns, pure or merged
 * into a replacement block, attributed to a symbol of the base structure and found at the head.
 * - The row's base span: the span of the base structure holding its line (`spanIndexAt`).
 * - Its base symbol: among the span's symbols whose lines (Graph's `startLine`-`endLine`, both
 *   included) take in the row, the one with the fewest lines (all of them on a tie, each attributed
 *   alone). Where none takes it in, it is not attributed (round 6f), as a changed head line inside
 *   no symbol keeps the gap.
 * - Its head span: the base span's counterpart (`declarationCounterparts`, the one rule the
 *   sections and their facts pair spans by). Its head symbol: the base symbol's match among the two
 *   spans' symbols (`matchSymbols`, the facts' rule: kind, container, name, then occurrence).
 * Not attributed (`false`), when a row: lies in no base span, or in a span with no head counterpart;
 * has no symbol by the rule above (a top-level statement, a comment or statement the span holds
 * past its declaration, a span with no symbols); has a base symbol
 * whose kind, container and name occur more than once in either span (an overload, a getter and
 * setter, a redeclaration: occurrence is only order there, so a pair may be two different symbols);
 * or whose symbol has no match (removed, renamed, moved to another container). Not known (`null`)
 * when the file has no head blob or either side has no symbol structure (none, a fallback, or
 * Markdown, which has no symbols). True when it removes no row.
 */
export const removalAttribution = (
  owned: ReadonlyArray<{
    readonly hunkId: string;
    readonly side: "old" | "new";
    readonly startLine: number;
    readonly endLine: number;
  }>,
  own: ReadonlyArray<ManifestHunk>,
  structures: ReadonlyMap<string, BlobStructure>,
): {
  readonly removedAttributed: boolean | null;
  readonly removedHeads: Array<{ startLine: number; endLine: number }>;
} => {
  const removed = owned.filter((range) => range.side === "old");
  if (removed.length === 0)
    return { removedAttributed: true, removedHeads: [] };
  const unknown = { removedAttributed: null, removedHeads: [] };
  const not = { removedAttributed: false, removedHeads: [] };
  const oldOids = new Set(own.map((hunk) => hunk.oldOid));
  const newOids = new Set(own.map((hunk) => hunk.newOid));
  if (oldOids.size !== 1 || newOids.size !== 1) return unknown;
  const [oldOid] = oldOids;
  const [newOid] = newOids;
  if (oldOid === null || oldOid === undefined) return unknown;
  if (newOid === null || newOid === undefined) return unknown;
  const base = structures.get(oldOid);
  const head = structures.get(newOid);
  if (
    base?.capability !== "graph-symbols" ||
    head?.capability !== "graph-symbols"
  )
    return unknown;
  const counterparts = declarationCounterparts(base, head);
  const sameName = (a: StoredSymbol, b: StoredSymbol) =>
    a.kind === b.kind && a.container === b.container && a.name === b.name;
  const heads = new Map<string, { startLine: number; endLine: number }>();
  for (const range of removed)
    for (let line = range.startLine; line <= range.endLine; line++) {
      const index = spanIndexAt(base, line);
      if (index === undefined) return not;
      const baseSpan = base.spans[index]!;
      const headIndex = counterparts.toHead[index];
      if (headIndex === undefined) return not;
      const headSpan = head.spans[headIndex]!;
      const taking = baseSpan.symbols.filter(
        (symbol) => symbol.startLine <= line && line <= symbol.endLine,
      );
      const size = (symbol: StoredSymbol) => symbol.endLine - symbol.startLine;
      const fewest = Math.min(...taking.map(size));
      // A row no symbol's lines take in (a comment or statement past the declaration's last line
      // that the span still holds) is not attributed, as a changed head line inside no symbol keeps
      // the gap. A symbol's first and last lines are its own.
      const symbols = taking.filter((symbol) => size(symbol) === fewest);
      if (symbols.length === 0) return not;
      const { matched } = matchSymbols(baseSpan.symbols, headSpan.symbols);
      for (const symbol of symbols) {
        if (
          baseSpan.symbols.filter((other) => sameName(other, symbol)).length >
            1 ||
          headSpan.symbols.filter((other) => sameName(other, symbol)).length > 1
        )
          return not;
        const pair = matched.find((entry) => entry.base === symbol);
        if (pair === undefined) return not;
        heads.set(`${pair.head.startLine}:${pair.head.endLine}`, {
          startLine: pair.head.startLine,
          endLine: pair.head.endLine,
        });
      }
    }
  return {
    removedAttributed: true,
    removedHeads: [...heads.values()].sort(
      (a, b) => a.startLine - b.startLine || a.endLine - b.endLine,
    ),
  };
};

/** What the plan reads, in which groups and in which order: see the module comment. */
export const planReadings = (input: PlanInput): ReadingPlan => {
  const bounds = ReadingBoundsSchema.parse(input.bounds ?? {});
  const hunks = new Map(input.hunks.map((hunk) => [hunk.hunkId, hunk]));
  const sections = sectionsOf(
    input.hunks,
    new Map<string, Structure>(
      [...input.structures].map(([oid, stored]) => [oid, asStructure(stored)]),
    ),
  );
  const identities = sectionIdentities(sections, hunks, input.structures);
  // Code facts per section, from the same sections, identities and structures. When they cannot be
  // computed, no section has any, rather than the plan stopping.
  const factsOf = new Map<string, Array<{ id: string; statement: string }>>();
  // The two facts `symbolRemovedOf` reads, whole (their values, which the plan does not keep).
  const removedFacts = new Map<string, SectionFact>();
  const declarationFacts = new Map<string, SectionFact>();
  try {
    for (const fact of sectionFactsOf(
      sections,
      identities,
      hunks,
      input.structures,
    )) {
      if (fact.fact === "symbols-removed")
        removedFacts.set(fact.about.key, fact);
      if (fact.fact === "declaration")
        declarationFacts.set(fact.about.key, fact);
      if (fact.value !== null)
        factsOf.set(fact.about.key, [
          ...(factsOf.get(fact.about.key) ?? []),
          { id: fact.id, statement: fact.statement },
        ]);
    }
  } catch {
    factsOf.clear();
    removedFacts.clear();
    declarationFacts.clear();
  }
  const excluded = new Set((input.excluded ?? []).map((entry) => entry.path));
  const sources = {
    hunks,
    structures: input.structures,
    facts: input.facts,
  };

  const drafts = sections.map((section: Section) => {
    const identity = identities.get(section.key)!;
    const own = section.hunkIds.map((id) => hunks.get(id)!).sort(hunkOrder);
    const owned = section.ranges
      .filter((range) => range.lineCount > 0)
      .map((range) => ({
        hunkId: range.hunkId,
        side: range.side,
        startLine: range.startLine,
        endLine: range.startLine + range.lineCount - 1,
      }))
      .sort(
        (a, b) =>
          byCodeUnits(a.side, b.side) ||
          a.startLine - b.startLine ||
          byCodeUnits(a.hunkId, b.hunkId),
      );
    const kinds = new Set(
      own.flatMap((hunk) => hunk.declared.map((d) => d.kind)),
    );
    const declared = DECLARED_ORDER.find((kind) => kinds.has(kind)) ?? null;
    const span =
      identity.where === null || identity.parts.side === "none"
        ? null
        : { side: identity.parts.side, ...identity.where };
    const shape = {
      key: identity.key,
      path: section.path,
      kind: section.kind,
      name: section.name ?? null,
      declared,
      boundaries:
        section.basis === "graph-symbols" ||
        section.basis === "markdown-sections"
          ? ("structure" as const)
          : ("fallback" as const),
      basis: section.basis,
      span,
      owned,
      hunkIds: own.map((hunk) => hunk.hunkId),
      first: section.first,
    };
    const text = section.kind !== "nontext";
    const characters = text ? sectionCharacters(shape, sources) : 0;
    const newPath = own[0]?.newPath ?? section.path;
    const added = addedLines(
      owned
        .filter((range) => range.side === "new")
        .map((range) => ({ kind: "lines", path: newPath, ...range })),
      own,
    );
    const count = (side: "old" | "new") =>
      owned
        .filter((range) => range.side === side)
        .reduce((sum, range) => sum + range.endLine - range.startLine + 1, 0);
    const rank = rankOf(declared, {
      publicName: publicSurface(added).length > 0,
      removes: count("old") > count("new"),
      rows: count("old") + count("new"),
    });
    const decidedBy = input.decided?.get(identity.key);
    const cause: UnreadCause | null = excluded.has(section.path)
      ? "excluded"
      : decidedBy !== undefined
        ? "rule-decided"
        : !text
          ? "unreadable"
          : characters > READING_TOO_LARGE
            ? "too-large"
            : null;
    return {
      section: {
        ...shape,
        identity: {
          key: identity.key,
          parts: {
            ...identity.parts,
            hunkContentKeys: [...identity.parts.hunkContentKeys],
          },
          where: identity.where === null ? null : { ...identity.where },
          renamedFrom: identity.renamedFrom,
        },
        title: sectionLabel(section),
        facts: factsOf.get(identity.key) ?? [],
        symbolRemoved: symbolRemovedOf(
          removedFacts.get(identity.key),
          declarationFacts.get(identity.key),
          owned,
        ),
        ...removalAttribution(owned, own, input.structures),
        characters,
        rank,
      },
      cause,
      gitlink: isGitlink(own),
      decidedBy: cause === "rule-decided" ? decidedBy : undefined,
    };
  });
  drafts.sort(
    (a, b) =>
      byCodeUnits(a.section.path, b.section.path) ||
      a.section.first - b.section.first ||
      byCodeUnits(a.section.key, b.section.key),
  );

  const read = drafts
    .filter((draft) => draft.cause === null)
    .map((draft) => draft.section);
  const items: Array<ReadingItem> = read.map((section) => {
    const affinity = input.affinity?.get(section.path);
    return {
      key: section.key,
      path: section.path,
      characters: section.characters,
      position: section.first,
      ...(affinity === undefined ? {} : { affinity: [...affinity] }),
    };
  });
  const ranks = new Map(read.map((section) => [section.key, section.rank]));
  const packed = (of: ReadonlyArray<ReadingItem>) =>
    readingGroups(of, bounds).groups.map((group) => ({
      id: group.id,
      keys: [...group.keys],
      paths: [...group.paths],
      totals: { ...group.totals },
      notes: group.notes.map((note) => ({ ...note })),
      rank: Math.max(0, ...group.keys.map((key) => ranks.get(key) ?? 0)),
    }));
  // Every other section packed as it would be with no pointer in the range, then each submodule
  // pointer alone, after them: a pointer that moves changes only its own group.
  const gitlinks = new Set(
    drafts
      .filter((draft) => draft.cause === null && draft.gitlink)
      .map((draft) => draft.section.key),
  );
  const packApart = (of: ReadonlyArray<ReadingItem>) => {
    const rest = of.filter((item) => !gitlinks.has(item.key));
    return [
      ...(rest.length === 0 && of.length > 0 ? [] : packed(rest)),
      ...of
        .filter((item) => gitlinks.has(item.key))
        .flatMap((item) => packed([item])),
    ];
  };
  // Effort by risk: one packing per class, with the same bounds and directory fallback. A group's ID
  // is the hash of its member keys (`readingGroups`), and the classes' keys are disjoint, so the IDs
  // differ between them.
  const classes =
    input.split === "by-risk" ? effortFactsOf(read, hunks) : undefined;
  const pack = (members: ReadonlyArray<ReadingItem>) =>
    classes === undefined
      ? packApart(members)
      : [true, false].flatMap((high) => {
          const of = members.filter(
            (item) => isHigh(classes.get(item.key)) === high,
          );
          return of.length === 0 ? [] : packApart(of);
        });
  const groups =
    input.batches === undefined
      ? pack(items)
      : input.batches.flatMap((paths) =>
          pack(items.filter((item) => paths.has(item.path))),
        );

  return ReadingPlan.parse({
    recipe: READING_RECIPE,
    bounds,
    sections: read,
    groups,
    unread: drafts.flatMap((draft) =>
      draft.cause === null
        ? []
        : [
            {
              ...draft.section,
              cause: draft.cause,
              ...(draft.decidedBy === undefined
                ? {}
                : { decidedBy: { ...draft.decidedBy } }),
            },
          ],
    ),
  });
};

/**
 * The blobs `pairPlan` reads, each once and sorted: the declaration blob (`pairingBlob`) of every
 * read section that removes rows in code cut by Graph's symbols.
 */
export const pairingBlobs = (
  plan: ReadingPlan,
  hunks: ReadonlyMap<string, ManifestHunk>,
): Array<string> =>
  [
    ...new Set(
      plan.sections.flatMap((section) => {
        const blob = pairingBlob(section, hunks);
        return blob === null ? [] : [blob];
      }),
    ),
  ].sort(byCodeUnits);

/**
 * The plan with each read section's pairing rows (`readings/pairing.ts`), from the texts of the
 * blobs `pairingBlobs` names at the commit (a blob whose text is not given gives its sections
 * none): per section by the rule, then per group in reading order under the group's bound. Every
 * other part of the plan is kept as it is, so the groups, sizes and ranks do not move, and a section
 * with no rows is byte for byte what it was.
 */
export const pairPlan = (
  plan: ReadingPlan,
  hunks: ReadonlyMap<string, ManifestHunk>,
  texts: ReadonlyMap<string, string>,
): ReadingPlan => {
  const changed = changedLines(hunks);
  const byKey = new Map(plan.sections.map((section) => [section.key, section]));
  const paired = new Map<string, ReadonlyArray<unknown>>();
  for (const group of plan.groups)
    for (const [key, rows] of groupPairing(
      readingOrder(plan, group.id),
      (key) => sectionPairing(byKey.get(key)!, hunks, texts, changed),
    ))
      paired.set(key, rows);
  return ReadingPlan.parse({
    ...plan,
    sections: plan.sections.map((section) => {
      const rest: Record<string, unknown> = { ...section };
      delete rest["paired"];
      const rows = paired.get(section.key);
      return rows === undefined ? rest : { ...rest, paired: rows };
    }),
  });
};

/** The group of a plan with this id; throws when the plan has none. */
export const planGroup = (plan: ReadingPlan, groupId: string): PlanGroup => {
  const group = plan.groups.find((candidate) => candidate.id === groupId);
  if (group === undefined)
    throw new Error(`The reading plan has no group ${groupId}`);
  return group;
};
