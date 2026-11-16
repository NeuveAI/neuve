import { PHRASE_LINK, type ExplainedContent } from "@neuve/records-schema";
import { sha256Hex } from "@neuve/records-core";
import { unitHandle, unitKeyOf } from "../publish-sections-input.ts";
import type { DigestText } from "./briefing.ts";

/**
 * The briefing's outcome as a settled batch takes it (NEU-148 round 27): each section's Briefed and
 * Explained, each batch's digest, and the gaps when a briefing failed or was cut. Pure and code
 * only: `settledBatches` (`settled.ts`) calls it with what the collector read from the stored
 * briefings (`readings/collect.ts`). Type-only imports from the step side, so this module and
 * `settled.ts` never load each other.
 */

/** How a section's or a digest's briefing ended: stored, failed (or left unanswered), or cut. */
export type BriefingState = "written" | "failed" | "cut";

/** One section's briefing, as the collector read it from the part that wrote it. */
export interface SectionBriefing {
  readonly state: BriefingState;
  /** The section's behaviour title, where the part wrote one (round 27b). */
  readonly title?: string | null;
  readonly briefed: string | null;
  readonly explained: ExplainedContent | null;
}

/** A file's lead, as a part wrote it for a file it marked as having several sections (round 27b). */
export interface FileLead {
  /** The file's sections the part held, by identity key: the ones the lead speaks for. */
  readonly sections: ReadonlyArray<string>;
  /** The unit's behaviour title, where the part wrote one with the lead. */
  readonly title?: string | null;
  readonly text: string;
}

/** One batch's digest briefing, by its Map group. */
export interface DigestBriefing {
  readonly state: BriefingState;
  readonly text: DigestText | null;
}

/** Everything the briefings stored for a review, by section key and by Map group. */
export interface SettledBriefings {
  readonly sections: ReadonlyMap<string, SectionBriefing>;
  readonly digests: ReadonlyMap<string, DigestBriefing>;
  /** Each marked file's lead, by path; absent or empty where no part wrote one. */
  readonly leads?: ReadonlyMap<string, FileLead> | undefined;
}

/** Code's three texts for a section's Briefed, from its own stored entry (`settled.ts`). */
export interface CodeBriefed {
  /** Round 25's rule (`briefedOf`), with the lean reasons the whole review shares left out. */
  readonly own: string | null;
  /** The same with no lean reason left out: the section's own reason, even if another group's matches. */
  readonly unshared: string | null;
  /** Its Assess factor findings, for the fallback only: said of several sections together. */
  readonly factors: string | null;
}

/**
 * A section's Briefed (round 27b: the model writes it for every section; Assess's text is its input).
 * With no briefing (the generated batch, an unread section, a review with none), code's as round 25
 * wrote it. Wherever the part wrote one, the model's. Only when it wrote none (the part failed, was
 * cut, or left the section unanswered): code's text, its own lean reason even where another group
 * wrote the same words, then factor findings, so the stop is never blank; the unit's gap says why.
 */
export const briefedFrom = (
  briefing: SectionBriefing | undefined,
  code: CodeBriefed,
): string | null => {
  const text =
    briefing === undefined
      ? code.own
      : briefing.briefed !== null && briefing.briefed.length > 0
        ? briefing.briefed
        : (code.own ?? code.unshared ?? code.factors);
  return text === null ? null : wholeSentences(text);
};

/**
 * A sentence ends at ".", "!" or "?" before a space and a capital, a digit or an opening mark, as
 * `claimsOf` and the desk's `briefingClaims` split claims: "e.g. at" and "i.e. the" end none. The one
 * boundary `wholeSentences` and `boundedText` both cut at, so the two never disagree.
 */
const SENTENCE_END = /[.!?](?=\s+[\p{Lu}\p{Nd}"'([\u201c\u2018])/gu;

/** Where each sentence of `text` ends: the UTF-16 index just after its stop (`SENTENCE_END`). */
export const sentenceEnds = (text: string): ReadonlyArray<number> =>
  [...text.matchAll(SENTENCE_END)].map((match) => match.index + 1);

/**
 * A text that ends in a sentence cut with "…" (a bound that cut at a word, in a briefing stored
 * before every cut kept whole sentences, or code's clipped Assess text) ends instead after its last
 * full sentence, when one comes before the cut. With none, it stays as it is: "…" only when not even
 * the first sentence fits. A sentence end inside a link never counts. Text with no trailing "…" is
 * returned as it is.
 */
export const wholeSentences = (text: string): string => {
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith("\u2026")) return text;
  const links: Array<readonly [number, number]> = [];
  for (const match of trimmed.matchAll(PHRASE_LINK))
    links.push([match.index, match.index + match[0].length]);
  let end = 0;
  for (const at of sentenceEnds(trimmed))
    if (!links.some(([s, e]) => at > s && at < e)) end = at;
  return end > 0 ? trimmed.slice(0, end) : text;
};

/** A unit's lead, at most, in Unicode code points: records refuses a longer one and never clips. */
export const LEAD_POINTS = 600;

const pointsOf = (text: string) => [...text];

/**
 * Text within `bound` code points, cut after the last full sentence that fits (`sentenceEnds`, as
 * `wholeSentences` ends one: "e.g." before a lower-case word is none), else (not even one
 * sentence fits) before a space with an ellipsis, and never inside a `[phrase](id)` link. Text with no such
 * place keeps its links' phrases alone and is cut again. Text within the bound is returned as it is.
 */
/**
 * Cut text with no dangling link opener: a "[" that opens no whole `[phrase](id)` link and is never
 * closed after it is taken out, and so is a link's cut tail (`](id` with no closing bracket) at the end.
 */
const undangled = (text: string) => {
  const whole: Array<readonly [number, number]> = [];
  for (const match of text.matchAll(PHRASE_LINK))
    whole.push([match.index, match.index + match[0].length]);
  let out = "";
  for (let at = 0; at < text.length; at++) {
    const char = text[at]!;
    if (
      char === "[" &&
      !whole.some(([s, e]) => at >= s && at < e) &&
      !text.slice(at + 1).includes("]")
    )
      continue;
    out += char;
  }
  return out.replace(/\]\([^)\s]*(\u2026)?$/u, "$1");
};

export const boundedText = (text: string, bound: number): string => {
  const points = pointsOf(text);
  if (points.length <= bound) return text;
  return undangled(cutText(text, points, bound));
};

const cutText = (
  text: string,
  points: ReadonlyArray<string>,
  bound: number,
): string => {
  if (bound <= 1) return points.slice(0, Math.max(0, bound)).join("");
  const spans: Array<readonly [number, number]> = [];
  for (const match of text.matchAll(PHRASE_LINK)) {
    const start = pointsOf(text.slice(0, match.index)).length;
    spans.push([start, start + pointsOf(match[0]).length]);
  }
  // A cut at `at` keeps points [0, at): never strictly inside a link.
  const inLink = (at: number) => spans.some(([s, e]) => at > s && at < e);
  // Full sentences end where `wholeSentences` ends them (`sentenceEnds`), as code points; what
  // follows the cut decides it, so "e.g." before a lower-case word is never an end.
  const ends = new Set(
    sentenceEnds(text).map((end) => pointsOf(text.slice(0, end)).length),
  );
  let sentence = 0;
  let word = 0;
  for (let at = 1; at <= bound; at++) {
    if (inLink(at)) continue;
    const next = points[at];
    const space = next !== undefined && /\s/u.test(next);
    if (ends.has(at)) sentence = at;
    if (space && at <= bound - 1) word = at;
  }
  // The last full sentence that fits, however short: never a sentence cut off with "…" (the desk's
  // final pictures); a word cut with "…" only when not even one sentence fits.
  if (sentence > 0) return points.slice(0, sentence).join("").trimEnd();
  if (word > 0) return `${points.slice(0, word).join("").trimEnd()}\u2026`;
  const plain = text.replace(PHRASE_LINK, (_whole, phrase: string) => phrase);
  if (plain !== text) return cutText(plain, pointsOf(plain), bound);
  return `${points.slice(0, bound - 1).join("")}\u2026`;
};

/**
 * A unit's lead (round 27b): the model's lead of its file when the unit holds every read section of
 * the file and the lead speaks for all of them; otherwise its first section's Briefed, and the
 * desk's rows carry the rest. Within `LEAD_POINTS` (`boundedText`); undefined when there is none.
 */
export const unitLeadOf = (input: {
  /** The unit's sections, first section first. */
  readonly sectionKeys: ReadonlyArray<string>;
  /** Every read section of the unit's file, by identity key: those a part briefed. */
  readonly fileSections: ReadonlyArray<string>;
  readonly lead: FileLead | undefined;
  /** Each section's Briefed as settled (`briefedFrom`). */
  readonly briefed: (key: string) => string | null;
}): string | undefined => {
  const lead = fileLeadOf(input);
  const text = wholeSentences(
    lead !== undefined
      ? lead.text
      : (input.briefed(input.sectionKeys[0] ?? "") ?? "").trim(),
  );
  return text.length === 0 ? undefined : boundedText(text, LEAD_POINTS);
};

/**
 * The file's lead when it is the unit's: the unit holds every read section of the file, the file has
 * several, and the lead speaks for all of them; else undefined.
 */
export const fileLeadOf = (input: {
  readonly sectionKeys: ReadonlyArray<string>;
  readonly fileSections: ReadonlyArray<string>;
  readonly lead: FileLead | undefined;
}): FileLead | undefined => {
  const { lead, fileSections, sectionKeys } = input;
  return lead !== undefined &&
    fileSections.length > 1 &&
    fileSections.every((key) => sectionKeys.includes(key)) &&
    lead.sections.length === fileSections.length &&
    fileSections.every((key) => lead.sections.includes(key))
    ? lead
    : undefined;
};

/**
 * A unit's behaviour title (round 27b): the one the part wrote with its file's lead, when that lead is
 * the unit's (`fileLeadOf`); else the behaviour title of its first section in file order that has
 * one, with " and N more" for its other sections, as the code title phrases it, and never a file
 * name; else undefined, and the publisher's code title stands (no section was read, or every part
 * failed or was cut).
 */
export const unitTitleOf = (input: {
  /** The unit's sections, in file order. */
  readonly sectionKeys: ReadonlyArray<string>;
  readonly fileSections: ReadonlyArray<string>;
  readonly lead: FileLead | undefined;
  /** Each section's behaviour title as the part wrote it, where it did. */
  readonly titles?: ((key: string) => string | null | undefined) | undefined;
}): string | undefined => {
  const title = fileLeadOf(input)?.title?.trim();
  if (title !== undefined && title.length > 0) return title;
  const first = input.sectionKeys
    .map((key) => input.titles?.(key)?.trim())
    .find((each) => each !== undefined && each.length > 0);
  if (first === undefined) return undefined;
  const more = input.sectionKeys.length - 1;
  return more === 0 ? first : `${first} and ${more} more`;
};

/** The limitation of a digest code wrote because the written one failed. */
export const DIGEST_FAILED =
  "The written briefing for this batch did not complete; this one was put together by code.";
/** The limitation of a digest code wrote because the written one was cut at the cut-off. */
export const DIGEST_CUT =
  "The written briefing for this batch was not reached before the review's cut-off; this one was put together by code.";

/**
 * A digest's text with each `[phrase](hunk ID)` link turned into a link to the unit that owns the
 * hunk's section (`unitOf`), so the overview links to units; a hunk no unit of the batch owns keeps
 * its phrase alone.
 */
export const unitLinked = (
  text: string,
  unitOf: (hunk: string) => string | undefined,
) =>
  text.replace(PHRASE_LINK, (_whole, phrase: string, id: string) => {
    // A cite of lines in a hunk (`h…@82-84`) names that hunk's unit.
    const unit = unitOf(id.split("@")[0]!);
    return unit === undefined ? phrase : `[${phrase}](${unit})`;
  });

/** A unit's published handle, as the publisher names it. */
export const handleOf = (unit: {
  readonly sectionKeys: ReadonlyArray<string>;
}) => unitHandle(unitKeyOf({ sectionKeys: [...unit.sectionKeys] }));

/** One done-when row across a batch's units (records' `BatchDigestContent.obligations`, by index). */
export interface SettledObligation {
  readonly row: string;
  readonly text: string;
  readonly basis?: string;
  readonly overall: string;
  readonly units: ReadonlyArray<{
    readonly unit: number;
    readonly status: string;
    readonly required: boolean;
  }>;
}

/**
 * Each done-when row's status across the batch's units, from their Guided rows (10.87), in the
 * order rows first appear; each unit once per row, by its index. `overall` in the Guided statuses'
 * own words: not met when any required unit is, met when all are, met on n of m units, else no
 * evidence, as the old publisher wrote it.
 */
export const obligationsOf = (
  units: ReadonlyArray<{
    readonly guided: {
      readonly rows: ReadonlyArray<{
        readonly row: string;
        readonly text: string;
        readonly basis: string;
        readonly status: string;
        readonly required: boolean;
      }>;
    };
  }>,
): Array<SettledObligation> => {
  const rows = new Map<
    string,
    {
      text: string;
      basis: string;
      units: Array<{ unit: number; status: string; required: boolean }>;
    }
  >();
  for (const [unit, held] of units.entries())
    for (const row of held.guided.rows) {
      const entry = rows.get(row.row) ?? {
        text: row.text,
        basis: row.basis,
        units: [],
      };
      if (!entry.units.some((u) => u.unit === unit))
        entry.units.push({ unit, status: row.status, required: row.required });
      rows.set(row.row, entry);
    }
  return [...rows].map(([row, entry]) => {
    const required = entry.units.filter((u) => u.required);
    const met = required.filter((u) => u.status === "met").length;
    const overall = required.some((u) => u.status === "not-met")
      ? "not-met"
      : required.length > 0 && met === required.length
        ? "met"
        : met > 0
          ? `met on ${met} of ${required.length} units`
          : "no-evidence";
    return {
      row,
      text: entry.text,
      basis: entry.basis,
      overall,
      units: entry.units,
    };
  });
};

const STATE_WORDS = [
  ["proven", "proven"],
  ["thin", "thinly proven"],
  ["out-of-date", "out of date"],
  ["conflicting", "conflicting"],
  ["missing", "without proof"],
] as const;

/**
 * The batch's verification, by code from its checkpoints' proof states (11.16): how many checkpoints
 * its units' sections name, each distinct requirement and state once, and how many are in each state.
 */
export const verificationOf = (
  checkpoints: ReadonlyArray<{
    readonly requirement: string;
    readonly state: string;
  }>,
): string => {
  const distinct = new Map(
    checkpoints.map((c) => [JSON.stringify([c.requirement, c.state]), c.state]),
  );
  const states = [...distinct.values()];
  if (states.length === 0) return "No unit of this batch names a checkpoint.";
  const parts = STATE_WORDS.flatMap(([state, words]) => {
    const n = states.filter((s) => s === state).length;
    return n === 0 ? [] : [`${n} ${words}`];
  });
  const listed =
    parts.length <= 1
      ? parts.join("")
      : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return `${states.length} ${states.length === 1 ? "checkpoint" : "checkpoints"} across this batch's units: ${listed}.`;
};

/** A batch's digest as `SettledBatch.digest` holds it. */
export interface BriefedDigest {
  readonly text: string;
  readonly verification: string;
  readonly uncertainty?: ReadonlyArray<string>;
  readonly limitations: ReadonlyArray<string>;
  readonly source: "agent" | "code";
  readonly obligations: ReadonlyArray<SettledObligation>;
}

/**
 * The batch's digest: the model's, its links turned to units, where its briefing wrote it; else
 * code's, with the limitation that says why. Code writes `verification` and `obligations` on both.
 * `source` is always named, `code` included.
 */
export const digestFrom = (input: {
  readonly briefing: DigestBriefing | undefined;
  readonly code: {
    readonly text: string;
    readonly limitations: ReadonlyArray<string>;
  };
  readonly verification: string;
  readonly obligations: ReadonlyArray<SettledObligation>;
  readonly unitOf: (hunk: string) => string | undefined;
}): BriefedDigest => {
  const { briefing } = input;
  if (briefing?.state === "written" && briefing.text !== null)
    return {
      text: unitLinked(wholeSentences(briefing.text.digest), input.unitOf),
      verification: input.verification,
      uncertainty: [...briefing.text.uncertainty],
      limitations: [...briefing.text.limitations],
      source: "agent",
      obligations: input.obligations,
    };
  return {
    text: input.code.text,
    verification: input.verification,
    limitations:
      briefing === undefined
        ? [...input.code.limitations]
        : [briefing.state === "cut" ? DIGEST_CUT : DIGEST_FAILED],
    source: "code",
    obligations: input.obligations,
  };
};

/**
 * A unit's gaps for its sections' briefing: one `briefing-failed` when any section's failed or was
 * left unanswered, one `briefing-cut` when any was cut at the cut-off, each saying how many.
 */
export const briefingGaps = (
  unit: { readonly sectionKeys: ReadonlyArray<string> },
  at: number,
  states: ReadonlyMap<string, SectionBriefing>,
): Array<{ key: string; kind: string; detail: string; unit: number }> => {
  const of = (state: BriefingState) =>
    unit.sectionKeys.filter((key) => states.get(key)?.state === state).length;
  const sections = (n: number) =>
    n === 1 ? "one of its sections" : `${n} of its sections`;
  const out: Array<{
    key: string;
    kind: string;
    detail: string;
    unit: number;
  }> = [];
  const failed = of("failed");
  const cut = of("cut");
  const tag = sha256Hex(unit.sectionKeys.join("\n")).slice(0, 16);
  if (failed > 0)
    out.push({
      key: `briefing-failed:${tag}`,
      kind: "briefing-failed",
      detail: `The written briefing of ${sections(failed)} did not complete, so code's text stands in for it.`,
      unit: at,
    });
  if (cut > 0)
    out.push({
      key: `briefing-cut:${tag}`,
      kind: "briefing-cut",
      detail: `The written briefing of ${sections(cut)} was not reached before the review's cut-off, so code's text stands in for it.`,
      unit: at,
    });
  return out;
};

/**
 * A batch's gap for its digest when the digest call failed or was cut while its parts may have
 * written every section: the digest code put together in its place is then disclosed as a gap, as
 * any failed or cut briefing is, not only as its limitation. None when the digest was written.
 */
export const digestGap = (
  mapGroup: string,
  briefing: DigestBriefing | undefined,
): { key: string; kind: string; detail: string } | undefined => {
  if (
    briefing === undefined ||
    (briefing.state === "written" && briefing.text !== null)
  )
    return undefined;
  const tag = sha256Hex(`digest\0${mapGroup}`).slice(0, 16);
  return briefing.state === "cut"
    ? {
        key: `briefing-cut:${tag}`,
        kind: "briefing-cut",
        detail:
          "The written digest of this batch was not reached before the review's cut-off, so code's digest stands in for it.",
      }
    : {
        key: `briefing-failed:${tag}`,
        kind: "briefing-failed",
        detail:
          "The written digest of this batch did not complete, so code's digest stands in for it.",
      };
};

/** A batch's briefing in one label, for its record: cut wins, then failed, then written; none ran. */
export type BatchBriefing = "none" | "written" | "failed" | "cut";

export const batchBriefingOf = (
  states: ReadonlyArray<BriefingState>,
): BatchBriefing =>
  states.includes("cut")
    ? "cut"
    : states.includes("failed")
      ? "failed"
      : states.length > 0
        ? "written"
        : "none";

// ---------------------------------------------------------------------------------------------
// Cites of a hunk's lines (records' line-cite rule), shared by the briefing and the Guided rows
// ---------------------------------------------------------------------------------------------

/** One owned row of a section, by its hunk: the lines a cite of that hunk may narrow to. */
export interface HunkRange {
  readonly hunk: string;
  /** The section that owns the row, by identity key. */
  readonly key?: string;
  readonly side: "old" | "new";
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * A hunk's side as a cite of its lines reads it: new when the hunk has any new-side row, else old
 * (a deletion). Records' resolve rule.
 */
export const citeSide = (ranges: ReadonlyArray<Pick<HunkRange, "side">>) =>
  ranges.some((range) => range.side === "new") ? "new" : "old";

/**
 * A cite of a hunk's lines (`h…@82-84`, `h…@82`) narrowed as Records resolves it: on the hunk's side
 * for the batch (`side`, by default from `ranges`), inside one of `ranges` on that side, the row
 * where the range starts, else the first row it reaches into; start and end positive, start no later
 * than end. Undefined when nothing is left, so a section with no row on the hunk's side, the removed
 * half of a replacement another section adds to, never cites lines Records would read as the other's.
 */
export const narrowedCite = (
  hunk: string,
  ranges: ReadonlyArray<HunkRange>,
  start: number,
  end: number,
  side: "old" | "new" = citeSide(ranges),
): string | undefined => {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return;
  if (start < 1 || end < start) return undefined;
  const on = ranges
    .filter((range) => range.side === side)
    .sort((a, b) => a.startLine - b.startLine);
  const home =
    on.find((range) => range.startLine <= start && start <= range.endLine) ??
    on.find((range) => start < range.startLine && range.startLine <= end);
  if (home === undefined) return undefined;
  const from = Math.max(start, home.startLine);
  const to = Math.min(end, home.endLine);
  return from === to ? `${hunk}@${from}` : `${hunk}@${from}-${to}`;
};
