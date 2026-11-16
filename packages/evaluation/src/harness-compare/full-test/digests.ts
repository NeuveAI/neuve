import {
  CONCERN_BUCKETS,
  concernBucket,
  type ConcernBucket,
} from "./titles.ts";

/**
 * The digest check (10.139): the owner's desk feedback of 24 and 25 October as deterministic checks,
 * read offline from a run's assembled output, on both levels the desk shows, as the desk shows them:
 * a joined unit's sections are rows under their own titles (`deskSections`). The batch digest is what
 * changed and what to check (the overview's two parts); a unit's briefing is its Briefed text, a
 * summary line and then its claims, and its Explained text. The owner asked that separate claims
 * carry a subheading or a bold lead-in, that a section title not repeat its briefing line, that
 * Explained not repeat Briefed's list of changes, and flagged the longest digests as too long.
 */

/** What the check reads of a run's `review show --json`. */
export interface ShownDigests {
  readonly assembled?: ReadonlyArray<{
    readonly batches: ReadonlyArray<{
      readonly id: string;
      readonly digest?: {
        readonly digest: string;
        readonly verification: string;
      } | null;
    }>;
    /** The batch's references: a ledger entry they hold is a phrase on the desk of each unit they mark. */
    readonly references?: ReadonlyArray<{
      readonly id: string;
      readonly entries?: ReadonlyArray<string>;
      readonly unitIds?: ReadonlyArray<string>;
    }>;
    readonly units: ReadonlyArray<{
      readonly id: string;
      readonly title: string;
      readonly hunkIds?: ReadonlyArray<string>;
      readonly changedLines?: number;
      readonly sections?: ReadonlyArray<{
        readonly id: string;
        readonly title: string;
        readonly content?: {
          readonly briefed?: string | null;
          readonly facts?: { readonly text?: string } | null;
        } | null;
      }>;
      readonly content?: {
        readonly briefed?: string | null;
        readonly explained?: {
          readonly before?: string;
          readonly after?: string;
        } | null;
      } | null;
    }>;
  }>;
}

/** A link's text kept and its target dropped, so `[the helper](h1)` reads as "the helper". */
const unlinked = (text: string) => text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");

const tokens = (text: string) =>
  new Set(
    unlinked(text)
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [],
  );

const jaccard = (a: ReadonlySet<string>, b: ReadonlySet<string>) => {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / (a.size + b.size - shared);
};

export const wordCount = (text: string) =>
  (unlinked(text).match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;

const blocks = (text: string) =>
  text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block !== "");

const sentences = (text: string) =>
  unlinked(text)
    .split(/(?<=[.!?])\s+(?=[A-Z0-9[(*`])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "");

/** A line opens with a Markdown heading or a bold lead-in, after an optional list marker. */
const led = (line: string) =>
  /^(?:[-*+]\s+|\d+[.)]\s+)?(?:#{1,6}\s+\S|\*\*[^*\n]+\*\*|__[^_\n]+__)/.test(
    line.trim(),
  );

/** A list item's line. */
const listed = (line: string) => /^(?:[-*+]|\d+[.)])\s+/.test(line.trim());

/**
 * Whether a text's separate claims are each marked. The first line is the summary. Every later line
 * that starts a claim (the first line of a block, a list item, or a line that opens with a heading
 * or bold) must open with a heading or a bold lead-in, list marker allowed; a plain line that goes on
 * from the one before is part of its claim. A text with no such line is one paragraph, which passes
 * only with one or two sentences: a summary and at most one claim.
 */
export const claimsLed = (text: string) => {
  const starts: Array<string> = [];
  const parts = blocks(text);
  parts.forEach((block, index) => {
    const lines = block.split("\n").filter((line) => line.trim() !== "");
    lines.forEach((line, at) => {
      if (index === 0 && at === 0) return;
      if (at === 0 || listed(line) || led(line)) starts.push(line);
    });
  });
  if (starts.length === 0) return sentences(text).length <= 2;
  return starts.every(led);
};

/**
 * A joined unit's briefing as the review desk shows it: the lead line, then each section as a row
 * headed by its title, its body that section's own Briefed (the desk's `joinedBriefing`). A unit
 * whose sections do not all carry content is split as the desk's fallback splits it: the lead, then
 * one block per section opening with "<title>: ". Null when neither applies, and the desk shows the
 * text whole.
 */
export const deskSections = (
  briefed: string,
  sections: ReadonlyArray<{
    readonly title: string;
    readonly content?: {
      readonly briefed?: string | null;
      readonly facts?: { readonly text?: string } | null;
    } | null;
  }>,
) => {
  if (sections.length < 2) return null;
  const paragraphs = briefed.replace(/\r\n?/g, "\n").split(/\n[^\S\n]*\n\s*/);
  if (sections.every((section) => section.content != null))
    return {
      lead: paragraphs[0] ?? "",
      sections: sections.map((section) => ({
        title: section.title,
        // The desk shows a section's Facts where it has no Briefed (a section nobody assessed).
        body: section.content?.briefed ?? section.content?.facts?.text ?? "",
      })),
    };
  if (paragraphs.length !== sections.length + 1) return null;
  const split = sections.map((section, index) => {
    const paragraph = paragraphs[index + 1]!;
    const prefix = `${section.title}: `;
    return paragraph.startsWith(prefix)
      ? { title: section.title, body: paragraph.slice(prefix.length) }
      : undefined;
  });
  return split.some((entry) => entry === undefined)
    ? null
    : {
        lead: paragraphs[0] ?? "",
        sections: split as Array<{ title: string; body: string }>,
      };
};

/**
 * A briefing as the desk's claim rows show it (review-desk/briefing-claims.ts): a new row at a blank
 * line and after a sentence's end before a capital, a digit, a quote or an opening mark. A link the
 * desk lands (a hunk of the unit's own, a ledger entry or reference that marks the unit:
 * `phraseIds`) is a phrase, never split and closing the sentence before it; any other link is shown
 * as its phrase's text, so it breaks a row only when that text starts a new sentence. Without
 * `phraseIds`, a hunk link is taken as a phrase. Links are kept as written.
 */
const DESK_BREAK = /[A-Z0-9“"‘'([]/;
const DESK_SENTENCE_END = /(?<=[.!?])\s+(?=[A-Z0-9“"‘'([\u0001])/;
export const deskRows = (
  text: string,
  phraseIds?: ReadonlySet<string> | undefined,
) => {
  const links: Array<string> = [];
  // A link is held out of the split: a hunk link as a phrase, which a sentence end before it closes;
  // any other as text that breaks only when its phrase does.
  const held = text.replace(
    /\[([^\]]*)\]\(([^)]*)\)/g,
    (link, phrase: string, id: string) => {
      links.push(link);
      const at = links.length - 1;
      const lands =
        phraseIds === undefined ? /^h[0-9a-f]+$/.test(id) : phraseIds.has(id);
      return lands || DESK_BREAK.test(phrase[0] ?? "")
        ? `\u0001${at}\u0002`
        : `\u0003${at}\u0002`;
    },
  );
  return held
    .split(/\n[^\S\n]*\n\s*/)
    .flatMap((paragraph) => paragraph.split(DESK_SENTENCE_END))
    .map((row) =>
      row
        .replace(
          /[\u0001\u0003](\d+)\u0002/g,
          (_, at: string) => links[Number(at)]!,
        )
        .trim(),
    )
    .filter((row) => row !== "");
};

/**
 * Whether the desk shows each of a briefing's claims on a row of its own: every row it makes holds
 * one sentence and no line break between text. The desk collapses a single line break, so a line of
 * its own the desk does not break at (a list item, a bold label) merges into the row before; and it
 * does not break before a bold label or code (`**`, a backtick) after a sentence's end.
 */
export const claimRows = (
  text: string,
  phraseIds?: ReadonlySet<string> | undefined,
) =>
  deskRows(text, phraseIds).every(
    (row) => sentences(row).length <= 1 && !/\S[^\S\n]*\n\s*\S/.test(row),
  );

/** Words that carry no content of their own, left out when one text is read for another's words. */
const FILLER = new Set(
  "the a an of to in for and or with on by from that this into its it is are be as at".split(
    " ",
  ),
);
const contentWords = (text: string) =>
  new Set([...tokens(text)].filter((word) => !FILLER.has(word)));

/** The share of `a`'s content words that `b` also says. */
const contained = (a: ReadonlySet<string>, b: ReadonlySet<string>) => {
  if (a.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / a.size;
};

/**
 * A title repeats its briefing line when the line restates it: at least 80% of the title's content
 * words (three or more of them) appear in the line, the briefing's first sentence.
 */
export const REPEAT_SHARE = 0.8;
export const repeatsLine = (title: string, briefed: string) => {
  const line = sentences(blocks(briefed)[0] ?? "")[0] ?? "";
  const said = contentWords(title);
  return (
    line !== "" &&
    said.size >= 3 &&
    contained(said, contentWords(line)) >= REPEAT_SHARE
  );
};

/**
 * Briefed's claims, the list of changes Explained should not repeat: the blocks after its summary,
 * or, for a briefing of one block, its sentences after the first. None when Briefed is its summary alone.
 */
const claimsOf = (briefed: string) => {
  const parts = blocks(briefed);
  return parts.length > 1
    ? sentences(parts.slice(1).join(" "))
    : sentences(briefed).slice(1);
};

/**
 * An Explained sentence repeats Briefed's list of changes when at least 70% of its content words
 * (six or more, so a stock phrase such as "No execution proof is recorded" is not counted) appear in
 * one of Briefed's claims. Null when Briefed has no claim to repeat, so such a unit is left out.
 */
export const SENTENCE_SHARE = 0.7;
export const repeatedSentences = (explained: string, briefed: string) => {
  const claims = claimsOf(briefed).map(contentWords);
  if (claims.length === 0) return null;
  return sentences(explained).filter((sentence) => {
    const said = contentWords(sentence);
    return (
      said.size >= 6 &&
      claims.some((claim) => contained(said, claim) >= SENTENCE_SHARE)
    );
  }).length;
};

const LINE_BUCKETS = ["≤20", "21-100", ">100"] as const;
type LineBucket = (typeof LINE_BUCKETS)[number];
const lineBucket = (lines: number): LineBucket =>
  lines <= 20 ? "≤20" : lines <= 100 ? "21-100" : ">100";

const round = (value: number) => Math.round(value * 1_000) / 1_000;

/** The median, the top tenth's floor and the maximum of a list of word counts. */
export const lengths = (counts: ReadonlyArray<number>) => {
  if (counts.length === 0) return { n: 0, p50: null, p90: null, max: null };
  const sorted = [...counts].sort((a, b) => a - b);
  const at = (share: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(share * sorted.length) - 1)]!;
  return { n: sorted.length, p50: at(0.5), p90: at(0.9), max: sorted.at(-1)! };
};

const share = (part: number, whole: number) =>
  whole === 0 ? null : round(part / whole);

/** Every unit's briefing and every batch digest of the runs, checked and measured. */
export const digestCheck = (
  runs: ReadonlyArray<ShownDigests & { readonly source?: string }>,
) => {
  const units = runs.flatMap((shown) =>
    (shown.assembled ?? []).flatMap((batch) =>
      batch.units.flatMap((unit) => {
        const briefed = unit.content?.briefed ?? null;
        if (briefed === null || briefed === "") return [];
        const explained = [
          unit.content?.explained?.before ?? "",
          unit.content?.explained?.after ?? "",
        ]
          .filter((part) => part !== "")
          .join(" ");
        const sections = unit.sections ?? [];
        const concerns = Math.max(1, sections.length);
        // A joined unit's section titles head their own briefing lines; a one-section unit's title heads the unit's.
        const headings =
          sections.length > 1
            ? sections.map((section) => ({
                title: section.title,
                briefed: section.content?.briefed ?? "",
              }))
            : [{ title: unit.title, briefed }];
        // As the desk shows it: a joined unit's sections are rows under their titles, so each row's
        // body is read as a briefing of its own, the title its heading.
        const shownAs = deskSections(briefed, sections);
        // The links the desk lands as phrases for this unit: its own hunks, and the ledger entries
        // (and IDs) of the references that mark it.
        const phraseIds = new Set([
          ...(unit.hunkIds ?? []),
          ...(batch.references ?? [])
            .filter((reference) => (reference.unitIds ?? []).includes(unit.id))
            .flatMap((reference) => [
              reference.id,
              ...(reference.entries ?? []),
            ]),
        ]);
        const words =
          shownAs === null
            ? wordCount(briefed)
            : wordCount(shownAs.lead) +
              shownAs.sections.reduce(
                (sum, row) => sum + wordCount(row.title) + wordCount(row.body),
                0,
              );
        return [
          {
            unit: unit.id,
            source: shown.source ?? null,
            concerns,
            changedLines: unit.changedLines ?? 0,
            claimsLed:
              shownAs === null
                ? claimsLed(briefed)
                : shownAs.sections.every((row) => claimsLed(row.body)),
            // As the desk shows them today: one row per claim (the lead and each section's body).
            claimRows:
              shownAs === null
                ? claimRows(briefed, phraseIds)
                : claimRows(shownAs.lead, phraseIds) &&
                  shownAs.sections.every((row) =>
                    claimRows(row.body, phraseIds),
                  ),
            repeatedTitles: headings.filter(
              (heading) =>
                heading.briefed !== "" &&
                repeatsLine(heading.title, heading.briefed),
            ).length,
            headings: headings.length,
            // Only a unit whose Briefed has claims, and that has an Explained, can repeat them.
            ...(() => {
              const repeats =
                explained === "" ? null : repeatedSentences(explained, briefed);
              return repeats === null
                ? { explainedSentences: 0, explainedRepeats: 0 }
                : {
                    explainedSentences: sentences(explained).length,
                    explainedRepeats: repeats,
                  };
            })(),
            overlap:
              explained === ""
                ? null
                : round(jaccard(tokens(briefed), tokens(explained))),
            words,
            explainedWords: wordCount(explained),
            wordsPerConcern: round(words / concerns),
          },
        ];
      }),
    ),
  );
  const batches = runs.flatMap((shown) =>
    (shown.assembled ?? []).flatMap((assembled) =>
      assembled.batches.flatMap((batch) =>
        batch.digest === undefined || batch.digest === null
          ? []
          : [
              {
                batch: batch.id,
                source: shown.source ?? null,
                units: assembled.units.length,
                digestLed: claimsLed(batch.digest.digest),
                verificationLed: claimsLed(batch.digest.verification),
                words:
                  wordCount(batch.digest.digest) +
                  wordCount(batch.digest.verification),
              },
            ],
      ),
    ),
  );
  const unitSummary = (of: typeof units) => ({
    units: of.length,
    claimsLed: share(of.filter((u) => u.claimsLed).length, of.length),
    claimRows: share(of.filter((u) => u.claimRows).length, of.length),
    titlesRepeatingLine: share(
      of.reduce((sum, u) => sum + u.repeatedTitles, 0),
      of.reduce((sum, u) => sum + u.headings, 0),
    ),
    explainedRepeatingBriefed: share(
      of.reduce((sum, u) => sum + u.explainedRepeats, 0),
      of.reduce((sum, u) => sum + u.explainedSentences, 0),
    ),
    overlap: lengths(
      of.flatMap((u) =>
        u.overlap === null ? [] : [Math.round(u.overlap * 100)],
      ),
    ),
    words: lengths(of.map((u) => u.words)),
    explainedWords: lengths(of.map((u) => u.explainedWords)),
    wordsPerConcern: lengths(of.map((u) => Math.round(u.wordsPerConcern))),
  });
  return {
    units: unitSummary(units),
    byConcerns: Object.fromEntries(
      CONCERN_BUCKETS.map((bucket) => [
        bucket,
        unitSummary(units.filter((u) => concernBucket(u.concerns) === bucket)),
      ]),
    ) as Record<ConcernBucket, ReturnType<typeof unitSummary>>,
    byChangedLines: Object.fromEntries(
      LINE_BUCKETS.map((bucket) => [
        bucket,
        unitSummary(units.filter((u) => lineBucket(u.changedLines) === bucket)),
      ]),
    ) as Record<LineBucket, ReturnType<typeof unitSummary>>,
    batches: {
      batches: batches.length,
      digestLed: share(
        batches.filter((b) => b.digestLed).length,
        batches.length,
      ),
      verificationLed: share(
        batches.filter((b) => b.verificationLed).length,
        batches.length,
      ),
      words: lengths(batches.map((b) => b.words)),
    },
    // The longest briefings, for a person to read.
    longest: [...units]
      .sort((a, b) => b.words - a.words)
      .slice(0, 10)
      .map(({ unit, source, words, concerns }) => ({
        unit,
        source,
        words,
        concerns,
      })),
  };
};

/** The check in a few plain lines. */
export const describeDigests = (check: ReturnType<typeof digestCheck>) => {
  const pct = (value: number | null) =>
    value === null ? "n/a" : `${Math.round(value * 100)}%`;
  const length = (l: ReturnType<typeof lengths>) =>
    l.n === 0 ? "n/a" : `median ${l.p50}, top tenth ${l.p90}, longest ${l.max}`;
  const unitLine = (
    label: string,
    s: ReturnType<typeof digestCheck>["units"],
  ) =>
    `${label} (${s.units} unit(s)): claims each on a desk row of their own ${pct(s.claimRows)}; claims each led in the text ${pct(s.claimsLed)}; titles repeating their briefing line ${pct(s.titlesRepeatingLine)}; Explained sentences repeating Briefed ${pct(s.explainedRepeatingBriefed)}; Briefed words ${length(s.words)}; words per concern ${length(s.wordsPerConcern)}.`;
  return [
    unitLine("Unit briefings", check.units),
    `  Briefed and Explained share ${length(check.units.overlap)} percent of their words; Explained words ${length(check.units.explainedWords)}.`,
    ...CONCERN_BUCKETS.map((bucket) =>
      unitLine(`  ${bucket} concern(s)`, check.byConcerns[bucket]),
    ),
    ...(["≤20", "21-100", ">100"] as const).map((bucket) =>
      unitLine(`  ${bucket} changed lines`, check.byChangedLines[bucket]),
    ),
    `Batch digests (${check.batches.batches}): what changed led ${pct(check.batches.digestLed)}, what to check led ${pct(check.batches.verificationLed)}; words ${length(check.batches.words)}.`,
  ].join("\n");
};
