/**
 * The title check (owner, 25 October: "when the review unit has only one concern the title has
 * better rubric"). Code rules, no model, over the units a run assembled: a unit that joins several
 * sections of one file (10.109) is held to what a one-concern title already does, and single-section
 * units are the reference. The rules are the evaluator's own code, apart from the harness's title
 * step, though they agree on the two hard rules (one statement, plain): the step refuses titles that
 * break those, so after it they catch only regressions, and the quality signal is in the other two.
 * A one-change unit's title is its section's, so it passes those two by construction: the reference
 * shows what a one-concern title is, not how good it is.
 *
 * - oneStatement: at most 90 characters, no semicolon list, no "and N more".
 * - plain: no hunk or line counts, no internal IDs.
 * - namesMain: shares a content word with the section owning the most changed lines, of those that
 *   are not only supporting (any section, when all are).
 * - leavesOutSupporting: names no word only a supporting section has (an import block, as its own
 *   title says, or hunks Understand marked mechanical).
 */

export const TITLE_RULES = [
  "oneStatement",
  "plain",
  "namesMain",
  "leavesOutSupporting",
] as const;
type Rule = (typeof TITLE_RULES)[number];

interface RangeLite {
  readonly kind: string;
  readonly startLine?: number;
  readonly endLine?: number;
}

/** What the check reads of `neuve review show --run <id> --json`. */
export interface ShownTitles {
  readonly assembled?: ReadonlyArray<{
    readonly units: ReadonlyArray<{
      readonly id: string;
      readonly title: string;
      readonly hunkIds: ReadonlyArray<string>;
      readonly ownedRanges: ReadonlyArray<RangeLite>;
      readonly sections?: ReadonlyArray<{
        readonly id: string;
        readonly title: string;
        readonly ownedRanges: ReadonlyArray<
          RangeLite & { readonly hunkId?: string }
        >;
      }>;
    }>;
  }>;
  readonly changeMap?: {
    readonly hunkRoles: ReadonlyArray<{
      readonly hunkId: string;
      readonly role: string;
    }>;
  } | null;
}

/** A unit's concern count, bucketed as the owner's point reads it: one concern, a few, many. */
export const CONCERN_BUCKETS = ["1", "2-3", "4+"] as const;
export type ConcernBucket = (typeof CONCERN_BUCKETS)[number];
export const concernBucket = (count: number): ConcernBucket =>
  count <= 1 ? "1" : count <= 3 ? "2-3" : "4+";

const STOP = new Set(
  "with from that this into their them then than when where which while about after before over under each every only also have been will does more most such onto".split(
    " ",
  ),
);
const words = (text: string) =>
  new Set(
    (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
      (word) => word.length >= 4 && !STOP.has(word),
    ),
  );
const lineCount = (ranges: ReadonlyArray<RangeLite>) =>
  ranges.reduce(
    (sum, range) =>
      range.kind === "lines" &&
      range.startLine !== undefined &&
      range.endLine !== undefined
        ? sum + range.endLine - range.startLine + 1
        : sum,
    0,
  );

export const checkTitle = (
  title: string,
  sections: ReadonlyArray<{
    readonly title: string;
    readonly lines: number;
    readonly supporting: boolean;
  }>,
): Record<Rule, boolean> => {
  const said = words(title);
  // The main change is the largest section that does more than support the others; an import block
  // is never it while the unit holds another change.
  const substantive = sections.some((s) => !s.supporting)
    ? sections.filter((s) => !s.supporting)
    : sections;
  const main = [...substantive].sort((a, b) => b.lines - a.lines)[0];
  const onlySupporting = new Set(
    sections.filter((s) => s.supporting).flatMap((s) => [...words(s.title)]),
  );
  for (const section of sections)
    if (!section.supporting)
      for (const word of words(section.title)) onlySupporting.delete(word);
  return {
    oneStatement:
      title.length <= 90 &&
      !/;\s/.test(title) &&
      !/\band \d+ more\b/i.test(title),
    plain:
      !/\bhunks?\b|\(s\)|\b\d+ (?:changed )?lines?\b/i.test(title) &&
      !/\b[a-z]\d+\.[a-z]?\d+\b|\bh[0-9a-f]{7,}\b/.test(title),
    namesMain:
      main === undefined ||
      [...words(main.title)].some((word) => said.has(word)),
    leavesOutSupporting:
      sections.every((s) => s.supporting) ||
      ![...said].some((word) => onlySupporting.has(word)),
  };
};

/**
 * Every unit's title against the rules, with pass rates for joined and single-section units and by
 * concern count, its sections. (A unit's hunks always serve one change-map behaviour, its batch's,
 * so behaviours add no count of their own.) A run may name its source.
 */
/** Each unit of a run, with its concern count and the rules its title passes. */
export const titleRows = (
  shown: ShownTitles & { readonly source?: string },
) => {
  const mechanical = new Set(
    (shown.changeMap?.hunkRoles ?? [])
      .filter((role) => role.role === "mechanical")
      .map((role) => role.hunkId),
  );
  return (shown.assembled ?? []).flatMap((batch) =>
    batch.units.map((unit) => {
      const sections = (
        unit.sections ?? [
          { id: unit.id, title: unit.title, ownedRanges: unit.ownedRanges },
        ]
      ).map((section) => {
        const hunks = [
          ...new Set(
            section.ownedRanges.flatMap((r) =>
              "hunkId" in r && r.hunkId !== undefined ? [r.hunkId] : [],
            ),
          ),
        ];
        return {
          title: section.title,
          lines: lineCount(section.ownedRanges),
          supporting:
            /^imports?\b/i.test(section.title.trim()) ||
            (hunks.length > 0 && hunks.every((id) => mechanical.has(id))),
        };
      });
      return {
        unit: unit.id,
        title: unit.title,
        source: shown.source ?? null,
        joined: sections.length > 1,
        concerns: sections.length,
        rules: checkTitle(unit.title, sections),
      };
    }),
  );
};

export const titleCheck = (
  runs: ReadonlyArray<ShownTitles & { readonly source?: string }>,
) => {
  const rows = runs.flatMap(titleRows);
  const ratesOf = (of: typeof rows) => {
    return {
      units: of.length,
      ...(Object.fromEntries(
        TITLE_RULES.map((rule) => [
          rule,
          of.length === 0
            ? null
            : Math.round(
                (of.filter((row) => row.rules[rule]).length / of.length) *
                  1_000,
              ) / 1_000,
        ]),
      ) as Record<Rule, number | null>),
      allRules:
        of.length === 0
          ? null
          : Math.round(
              (of.filter((row) => TITLE_RULES.every((rule) => row.rules[rule]))
                .length /
                of.length) *
                1_000,
            ) / 1_000,
    };
  };
  const bucketed = (count: (row: (typeof rows)[number]) => number) =>
    Object.fromEntries(
      CONCERN_BUCKETS.map((bucket) => [
        bucket,
        ratesOf(rows.filter((row) => concernBucket(count(row)) === bucket)),
      ]),
    ) as Record<ConcernBucket, ReturnType<typeof ratesOf>>;
  const sources = [
    ...new Set(
      rows.flatMap((row) => (row.source === null ? [] : [row.source])),
    ),
  ].sort();
  return {
    joined: ratesOf(rows.filter((row) => row.joined)),
    single: ratesOf(rows.filter((row) => !row.joined)),
    bySections: bucketed((row) => row.concerns),
    bySource: Object.fromEntries(
      sources.map((source) => [
        source,
        (() => {
          const of = rows.filter((row) => row.source === source);
          return Object.fromEntries(
            CONCERN_BUCKETS.map((bucket) => [
              bucket,
              ratesOf(
                of.filter((row) => concernBucket(row.concerns) === bucket),
              ),
            ]),
          ) as Record<ConcernBucket, ReturnType<typeof ratesOf>>;
        })(),
      ]),
    ),
    failing: rows
      .filter(
        (row) => row.joined && !TITLE_RULES.every((rule) => row.rules[rule]),
      )
      .map((row) => ({
        unit: row.unit,
        title: row.title,
        fails: TITLE_RULES.filter((rule) => !row.rules[rule]),
      })),
  };
};

/** The check in a few plain lines. */
export const describeTitles = (check: ReturnType<typeof titleCheck>) => {
  const pct = (value: unknown) =>
    typeof value === "number" ? `${Math.round(value * 100)}%` : "n/a";
  const line = (
    label: string,
    rates: ReturnType<typeof titleCheck>["joined"],
  ) =>
    `${label}: ${rates.units} unit(s); every rule ${pct(rates.allRules)} (one statement ${pct(rates.oneStatement)}, plain ${pct(rates.plain)}, names the main change ${pct(rates.namesMain)}, supporting left out ${pct(rates.leavesOutSupporting)}).`;
  return [
    line("Titles of joined units", check.joined),
    line("Titles of one-change units", check.single),
    ...CONCERN_BUCKETS.map((bucket) =>
      line(`Units of ${bucket} section(s)`, check.bySections[bucket]),
    ),
    ...Object.entries(check.bySource).map(
      ([source, buckets]) =>
        `${source}: every rule ${CONCERN_BUCKETS.map((bucket) => `${pct(buckets[bucket].allRules)} at ${bucket} (${buckets[bucket].units})`).join(", ")}.`,
    ),
    "One statement and plain are the title step's own hard rules, so they catch regressions; naming the main change and leaving supporting changes out are the quality signal.",
  ].join("\n");
};
