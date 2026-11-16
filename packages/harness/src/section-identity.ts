import { canonicalJson, sha256Hex } from "@neuve/records-core";
import { hunkContentKey } from "./hunks.ts";
import type { ManifestHunk } from "./manifest.ts";
import {
  asStructure,
  declarationCounterparts,
  sectionPlace,
  spanIndexAt,
  type BlobStructure,
  type Section,
  type Structure,
} from "./sections.ts";

/**
 * Section identity: one content key per section, so a judgement made on a section can be found
 * again for the same change.
 *
 * The contract. The same path, side, kind, name, span text, changed rows and ordinal give the same
 * key on any machine, in any process, in any order of input. Nothing from a model, a batch or a run
 * id enters it, and no absolute line number: a changed row's place within its span does. The recipe
 * name is versioned: a change of rule is a new key space, never a silent change. A rename does not
 * carry: the path is in the key, and Git's rename detection stays out of it (`renamedFrom` records
 * it beside the key).
 *
 * The changed rows (`changeSha256`) are each row the section's ranges own, from its hunks' text, as
 * `[sign, text, ends, offset]`: `sign` is `+` or `-`, `text` the row without its sign, `ends` false
 * only when Git's "no newline at end of file" marker follows that row. The marker's own wording is
 * never read, so the value depends on content only. `offset` is the row's place in its span. A
 * section with no span hashes `[sign, text, ends]`: its hunks' content keys already place it. Hunks
 * go in file order, rows in hunk order.
 *
 * In a section on the new side, a row is `[sign, text, ends, offset, rule]`. An added row (`head`):
 * its new line minus the head span's start. A removed row whose base span is the head span's own
 * declaration (`base`: the counterpart by `declarationCounterparts`, as a moved declaration's is):
 * its old line minus that base span's start. Every other removed row (`at`): the new-side line it
 * sits at, as `changedBlocks` counts it, minus the head span's start, clamped to the span: a row
 * that sits before the span's first line is at 0, one after its last line at the span's line count.
 * Such a row sits in the head span or in a block with its added rows, and the clamp keeps rows added
 * to the span above out of its place. The rule's name is hashed, so two rules never give equal rows
 * by accident. In a section on the old side, a row is `[sign, text, ends, offset]`: its old line
 * minus the old span's start. A new-side section's hunks must have their base blob's structure
 * given, so two callers cannot disagree.
 *
 * A new-side section whose head span has a counterpart in the base also carries that counterpart's
 * stored text hash (`counterpartSha256`): it pins everything inside the pair, where a removed row's
 * offset alone cannot, and it does not move with shifted lines or a moved declaration. A removed
 * row's rule and this part depend on counterpart matching, so adding or removing a same-named
 * declaration elsewhere in the file changes the keys of that name's sections; that fails safe, as a
 * judgement is then not carried.
 *
 * Equal keys mean an equal change: two keys are equal only when path, side, kind, name, span text,
 * counterpart text and changed rows with their places are all equal. The ordinal numbers the sections of one file
 * whose other parts are all equal, 1, 2, … in file order, so two equal changes inside one range stay
 * apart. It says nothing about which twin is which across ranges.
 *
 * Pure and synchronous.
 */
export const SECTION_IDENTITY_RECIPE = "neuve-section-identity-v1";

/** The recipe of `sectionKeySetHash`: a set of section keys has its own key space. */
const SECTION_KEY_SET_RECIPE = "neuve-section-key-set-v1";

export interface SectionIdentityParts {
  readonly path: string;
  /** `new`: a span of the head blob. `old`: a span only the base has (a pure removal). `none`: no span. */
  readonly side: "new" | "old" | "none";
  readonly kind: Section["kind"];
  readonly name: string | null;
  /** SHA-256 of the span's text on `side`, from the stored structure. Null when `side` is `none`. */
  readonly spanSha256: string | null;
  /**
   * SHA-256 of the text of the head span's counterpart in the base (`declarationCounterparts`), from
   * the stored structure. Null when the head span has no counterpart, on the old side, and with no
   * span.
   */
  readonly counterpartSha256: string | null;
  /** Only when `side` is `none`: the section's hunks' content keys, sorted. Otherwise empty. */
  readonly hunkContentKeys: ReadonlyArray<string>;
  /** SHA-256 of the section's own changed rows: sign, text and place in the span, in order. */
  readonly changeSha256: string;
  /** 1 for the first section of a file with these parts, 2 for the next, in file order. */
  readonly ordinal: number;
}

export interface SectionIdentity {
  /** 64 hex: SHA-256 of canonical JSON of [recipe, parts]. */
  readonly key: string;
  readonly parts: SectionIdentityParts;
  /** Not part of the key. The enclosing span's lines on `side`, for joins by position. */
  readonly where: {
    readonly startLine: number;
    readonly endLine: number;
  } | null;
  /**
   * Not part of the key. The old path when Git reports the file as renamed, else null: so a later
   * lane can show "moved" without guessing. Nothing here acts on it.
   */
  readonly renamedFrom: string | null;
}

const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A section's hunks in file order. Hunks of one file move forward on both sides together. */
const hunksOf = (
  section: Section,
  hunks: ReadonlyMap<string, ManifestHunk>,
): ReadonlyArray<ManifestHunk> =>
  section.hunkIds
    .map((hunkId) => {
      const hunk = hunks.get(hunkId);
      if (hunk === undefined)
        throw new Error(
          `Section of ${section.path} names hunk ${hunkId}, which is not given`,
        );
      if (hunk.path !== section.path)
        throw new Error(
          `Section of ${section.path} names hunk ${hunkId} of ${hunk.path}`,
        );
      return hunk;
    })
    .sort(
      (a, b) =>
        a.newStart - b.newStart ||
        a.oldStart - b.oldStart ||
        byCodeUnits(a.text, b.text) ||
        byCodeUnits(a.hunkId, b.hunkId),
    );

/** One changed row of a text hunk, with both sides' positions as `changedBlocks` counts them. */
interface ChangedRow {
  readonly index: number;
  readonly sign: "+" | "-";
  readonly text: string;
  /** False only when Git's "no newline at end of file" marker follows the row. */
  ends: boolean;
  /** The row's old line, or the old line it sits at (an added row). */
  readonly oldLine: number;
  /** The row's new line, or the new line it sits at (a removed row). */
  readonly newLine: number;
}

/** A text hunk's changed rows by side and line, read once. */
const changedRowsOf = (hunk: ManifestHunk) => {
  const old = new Map<number, ChangedRow>();
  const added = new Map<number, ChangedRow>();
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  let index = 0;
  // The row just before the current one, when it is changed: the one a marker would end.
  let previous: ChangedRow | undefined;
  for (const row of hunk.text.split("\n").slice(1)) {
    if (row.startsWith("\\")) {
      if (previous !== undefined) previous.ends = false;
      previous = undefined;
      continue;
    }
    if (row === "") continue;
    if (row.startsWith("-") || row.startsWith("+")) {
      const sign = row[0] as "+" | "-";
      previous = {
        index: index++,
        sign,
        text: row.slice(1),
        ends: true,
        oldLine,
        newLine,
      };
      if (sign === "-") old.set(oldLine++, previous);
      else added.set(newLine++, previous);
      continue;
    }
    previous = undefined;
    oldLine++;
    newLine++;
  }
  return { old, new: added };
};

type RowTuple =
  | [string, string, boolean]
  | [string, string, boolean, number]
  | [string, string, boolean, number, "head" | "base" | "at"];

/** The span a section claims, from the one blob all its hunks name on that side. */
const spanOf = (
  section: Section,
  hunks: ReadonlyArray<ManifestHunk>,
  side: "new" | "old",
  startLine: number,
  endLine: number,
  structures: ReadonlyMap<string, BlobStructure>,
) => {
  const blobs = new Set(
    hunks.map((hunk) => (side === "new" ? hunk.newOid : hunk.oldOid)),
  );
  const [blob] = blobs;
  if (blobs.size !== 1 || blob === null || blob === undefined)
    throw new Error(
      `Section of ${section.path} claims a ${side}-side span, but its hunks name ${blobs.size === 1 ? "no" : "different"} ${side} blobs`,
    );
  const structure = structures.get(blob);
  if (structure === undefined)
    throw new Error(
      `Section of ${section.path} claims ${side}-side span ${startLine}-${endLine}, but blob ${blob} has no structure given`,
    );
  const index = spanIndexAt(structure, startLine);
  const span = index === undefined ? undefined : structure.spans[index];
  if (span === undefined || span.start !== startLine || span.end !== endLine)
    throw new Error(
      `Section of ${section.path} claims ${side}-side span ${startLine}-${endLine}, which blob ${blob}'s structure does not have`,
    );
  return { structure, index: index!, span };
};

const SIDE_ORDER = { new: 0, old: 1, none: 2 } as const;

/** The section's first owned line: its lowest new-side line, else its lowest old-side line. */
const firstOwnedLine = (section: Section) => {
  const lowest = (side: "old" | "new") =>
    Math.min(
      ...section.ranges
        .filter((range) => range.side === side)
        .map((range) => range.startLine),
    );
  const line = lowest("new");
  if (Number.isFinite(line)) return line;
  const old = lowest("old");
  return Number.isFinite(old) ? old : 0;
};

/**
 * One identity per section, by `Section.key`. `hunks` holds the sections' hunks by hunk id and
 * `structures` each blob's stored structure by object id. A section that names a hunk not given, or
 * claims a span whose structure or span is not given, throws: a fallback would change keys between
 * runs.
 */
export const sectionIdentities = (
  sections: ReadonlyArray<Section>,
  hunks: ReadonlyMap<string, ManifestHunk>,
  structures: ReadonlyMap<string, BlobStructure>,
): ReadonlyMap<string, SectionIdentity> => {
  // Each hunk's rows are read once, and each structure converted once, per call.
  const rowsByHunk = new Map<ManifestHunk, ReturnType<typeof changedRowsOf>>();
  const rowsOf = (hunk: ManifestHunk) => {
    let rows = rowsByHunk.get(hunk);
    if (rows === undefined) rowsByHunk.set(hunk, (rows = changedRowsOf(hunk)));
    return rows;
  };
  const cuts = new Map<BlobStructure, Structure>();
  const cutOf = (structure: BlobStructure) => {
    let cut = cuts.get(structure);
    if (cut === undefined) cuts.set(structure, (cut = asStructure(structure)));
    return cut;
  };
  /**
   * A new-side section's base structure, the counterparts of its spans, and the head span's own
   * counterpart's text hash. All the section's text hunks name one base blob, whose structure must
   * be given.
   */
  const pairOf = (
    section: Section,
    own: ReadonlyArray<ManifestHunk>,
    claimed: ReturnType<typeof spanOf> | undefined,
    side: "new" | "old" | "none",
  ): {
    readonly base: BlobStructure | undefined;
    readonly toHead: ReadonlyArray<number | undefined>;
    readonly counterpartSha256: string | null;
  } => {
    const none = { base: undefined, toHead: [], counterpartSha256: null };
    if (claimed === undefined || side !== "new") return none;
    const blobs = new Set(
      own.flatMap((hunk) =>
        hunk.kind === "text" && hunk.oldOid !== null ? [hunk.oldOid] : [],
      ),
    );
    if (blobs.size > 1)
      throw new Error(
        `Section of ${section.path} is on the new side, but its hunks name different old blobs`,
      );
    const [blob] = blobs;
    if (blob === undefined) return none;
    const base = structures.get(blob);
    if (base === undefined)
      throw new Error(
        `Section of ${section.path} is on the new side, but its base blob ${blob} has no structure given`,
      );
    const { toHead, toBase } = declarationCounterparts(
      cutOf(base),
      cutOf(claimed.structure),
    );
    const counterpart = toBase[claimed.index];
    return {
      base,
      toHead,
      counterpartSha256:
        counterpart === undefined
          ? null
          : (base.spans[counterpart]?.textSha256 ?? null),
    };
  };
  /** The rows a section owns, from its hunks' text, each with its place (see the module comment). */
  const changeSha256Of = (
    section: Section,
    own: ReadonlyArray<ManifestHunk>,
    claimed: ReturnType<typeof spanOf> | undefined,
    side: "new" | "old" | "none",
    pair: ReturnType<typeof pairOf>,
  ) => {
    const tuples: Array<RowTuple> = [];
    for (const hunk of own) {
      if (hunk.kind !== "text") continue;
      const rows = rowsOf(hunk);
      const owned = new Set<ChangedRow>();
      for (const range of section.ranges)
        if (range.hunkId === hunk.hunkId)
          for (let at = 0; at < range.lineCount; at++) {
            const row = rows[range.side].get(range.startLine + at);
            if (row !== undefined) owned.add(row);
          }
      const ordered = [...owned].sort((a, b) => a.index - b.index);
      const { base, toHead } = pair;
      for (const row of ordered) {
        const content: RowTuple = [row.sign, row.text, row.ends];
        if (claimed === undefined) tuples.push(content);
        else if (side === "old")
          tuples.push([...content, row.oldLine - claimed.span.start]);
        else if (row.sign === "+")
          tuples.push([...content, row.newLine - claimed.span.start, "head"]);
        else {
          const baseIndex =
            base === undefined ? undefined : spanIndexAt(base, row.oldLine);
          tuples.push(
            baseIndex !== undefined && toHead[baseIndex] === claimed.index
              ? [
                  ...content,
                  row.oldLine - base!.spans[baseIndex]!.start,
                  "base",
                ]
              : [
                  ...content,
                  Math.min(
                    Math.max(row.newLine - claimed.span.start, 0),
                    claimed.span.end - claimed.span.start + 1,
                  ),
                  "at",
                ],
          );
        }
      }
    }
    return sha256Hex(canonicalJson(tuples));
  };
  const drafts = sections.map((section) => {
    const own = hunksOf(section, hunks);
    const place = sectionPlace(section);
    const spanned = place.side === "none" ? undefined : place;
    const renamed = own.find((hunk) => hunk.status === "renamed");
    const claimed =
      spanned === undefined
        ? undefined
        : spanOf(
            section,
            own,
            spanned.side,
            spanned.startLine,
            spanned.endLine,
            structures,
          );
    const pair = pairOf(section, own, claimed, place.side);
    return {
      section,
      parts: {
        path: section.path,
        side: place.side,
        kind: section.kind,
        name: section.name ?? null,
        spanSha256: claimed?.span.textSha256 ?? null,
        counterpartSha256: pair.counterpartSha256,
        hunkContentKeys:
          spanned === undefined
            ? [
                ...new Set(
                  own.map((hunk) => hunk.contentKey ?? hunkContentKey(hunk)),
                ),
              ].sort(byCodeUnits)
            : [],
        changeSha256: changeSha256Of(section, own, claimed, place.side, pair),
      },
      where:
        spanned === undefined
          ? null
          : { startLine: spanned.startLine, endLine: spanned.endLine },
      renamedFrom: renamed?.oldPath ?? null,
      firstOwned: firstOwnedLine(section),
    };
  });
  // Ordinals: within one path, sections whose other parts are equal are numbered in file order.
  const groups = new Map<string, Array<(typeof drafts)[number]>>();
  for (const draft of drafts) {
    const same = canonicalJson(draft.parts);
    const group = groups.get(same) ?? [];
    group.push(draft);
    groups.set(same, group);
  }
  // File order: `Section.first`, then the first owned line, then side. The internal key only
  // breaks a tie no two sections `sectionsOf` makes can reach, so the order never rests on input.
  const fileOrder = (a: (typeof drafts)[number], b: (typeof drafts)[number]) =>
    byCodeUnits(a.section.path, b.section.path) ||
    a.section.first - b.section.first ||
    a.firstOwned - b.firstOwned ||
    SIDE_ORDER[a.parts.side] - SIDE_ORDER[b.parts.side] ||
    byCodeUnits(a.section.key, b.section.key);
  const identities = new Map<string, SectionIdentity>();
  for (const group of groups.values()) {
    group.sort(fileOrder);
    for (const [index, draft] of group.entries()) {
      if (identities.has(draft.section.key))
        throw new Error(
          `Section key of ${draft.section.path} is given twice: ${draft.section.key}`,
        );
      const parts: SectionIdentityParts = {
        ...draft.parts,
        ordinal: index + 1,
      };
      identities.set(draft.section.key, {
        key: sha256Hex(canonicalJson([SECTION_IDENTITY_RECIPE, parts])),
        parts,
        where: draft.where,
        renamedFrom: draft.renamedFrom,
      });
    }
  }
  // The map's own order is file order too, whatever the input's order.
  return new Map(
    [...drafts]
      .sort(fileOrder)
      .map((draft) => [draft.section.key, identities.get(draft.section.key)!]),
  );
};

/** The one canonical order of section keys: ascending by key, code-unit order, duplicates removed. */
export const orderedSectionKeys = (
  keys: Iterable<string>,
): ReadonlyArray<string> => [...new Set(keys)].sort(byCodeUnits);

/** 64 hex: SHA-256 over a recipe name and the ordered keys. The one rule for hashing a set of sections. */
export const sectionKeySetHash = (keys: Iterable<string>): string =>
  sha256Hex(canonicalJson([SECTION_KEY_SET_RECIPE, orderedSectionKeys(keys)]));
