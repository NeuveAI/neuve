import { createHash } from "node:crypto";
import { z } from "zod";
import { lengths, repeatsLine, wordCount } from "./digests.ts";
import {
  checkPairs,
  pairedRubricRates,
  pairedShareInterval,
  shuffled,
  type PairRubricKey,
  type TitlePair,
} from "./titles-compare.ts";

/**
 * A joined unit's lead line (10.139): the sentence above its section rows on the desk, which the
 * title step writes with the title. A title candidate changes both, so its lead lines are judged
 * beside its titles: by code (whether the lead restates the unit's title, the owner's "basically a
 * 1:1 repetition", and its words) and by a blind rubric that reads each lead against what the title
 * step had, the sections' titles and Facts.
 */

interface UnitLite {
  readonly id: string;
  readonly title: string;
  readonly content?: { readonly briefed?: string | null } | null;
  readonly sections?: ReadonlyArray<{
    readonly title: string;
    readonly content?: {
      readonly facts?: { readonly text?: string } | null;
    } | null;
  }>;
}

const joinedOf = (shown: Record<string, unknown>) =>
  (
    (shown["assembled"] ?? []) as ReadonlyArray<{
      readonly units: ReadonlyArray<UnitLite>;
    }>
  ).flatMap((batch) =>
    batch.units.filter((unit) => (unit.sections ?? []).length > 1),
  );

/** A joined unit's lead: its Briefed text's first paragraph. */
export const leadOf = (unit: UnitLite) =>
  (unit.content?.briefed ?? "")
    .replace(/\r\n?/g, "\n")
    .split(/\n[^\S\n]*\n\s*/)[0]
    ?.trim() ?? "";

/**
 * The lead lines, both arms: the share that restates the unit's title (lower is better), with its
 * delta and the paired case bootstrap's interval, and the words per arm.
 */
export const leadComparison = (pairs: ReadonlyArray<TitlePair>) => {
  checkPairs(pairs);
  const perCase = pairs.map((pair) => {
    const read = (shown: Record<string, unknown>) =>
      joinedOf(shown).map((unit) => {
        const lead = leadOf(unit);
        return {
          repeats: lead !== "" && repeatsLine(unit.title, lead),
          words: wordCount(lead),
        };
      });
    return { base: read(pair.baseline), next: read(pair.candidate) };
  });
  const units = perCase.reduce((sum, entry) => sum + entry.base.length, 0);
  const count = (side: "base" | "next") =>
    perCase.reduce(
      (sum, entry) => sum + entry[side].filter((row) => row.repeats).length,
      0,
    );
  const share = (part: number) =>
    units === 0 ? null : Math.round((part / units) * 1_000) / 1_000;
  const baseline = share(count("base"));
  const candidate = share(count("next"));
  return {
    units,
    repeatsTitle: {
      baseline,
      candidate,
      delta:
        baseline === null || candidate === null
          ? null
          : Math.round((candidate - baseline) * 1_000) / 1_000,
      interval: pairedShareInterval(
        perCase.map((entry) => ({
          units: entry.base.length,
          base: entry.base.filter((row) => row.repeats).length,
          next: entry.next.filter((row) => row.repeats).length,
        })),
        "lead:repeatsTitle",
      ),
    },
    words: {
      baseline: lengths(
        perCase.flatMap((entry) => entry.base.map((row) => row.words)),
      ),
      candidate: lengths(
        perCase.flatMap((entry) => entry.next.map((row) => row.words)),
      ),
    },
  };
};

/** One lead line to judge, with what the title step had: each section's title and Facts. */
export const LeadRubricItem = z.strictObject({
  id: z.string().regex(/^l[0-9a-f]{12}$/),
  lead: z.string(),
  sections: z.array(z.strictObject({ title: z.string(), facts: z.string() })),
});

const Answer = z.enum(["yes", "no", "unsure"]);

export const LeadRubricAnswer = z.strictObject({
  id: z.string().regex(/^l[0-9a-f]{12}$/),
  /** It says what the unit's changes are together. */
  together: Answer,
  /** Every claim it makes is supported by the sections' titles and Facts. */
  supported: Answer,
  /** It adds nothing the sections do not say. */
  addsNothing: Answer,
  /** One sentence: why, for any "no". */
  reason: z.string(),
});

export const LeadRubricDecided = z.strictObject({
  version: z.literal(1),
  answers: z.array(LeadRubricAnswer),
  /** The judge's prompt wording (sha256), so paired reads stay within one wording; absent before it was recorded. */
  promptDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});

export const LEAD_RUBRIC_QUESTIONS = [
  "together: does the line say what the unit's changes are together, rather than describing one of them? It may leave out changes that only support the others, such as an import block or formatting. (yes, no or unsure)",
  "supported: is every claim it makes supported by the sections' titles and Facts? (yes, no or unsure)",
  "addsNothing: does it add nothing the sections do not say: no new claim, no stronger or weaker one? (yes, no or unsure)",
] as const;

export const LEAD_RUBRIC_ROWS = [
  { name: "together", good: "yes", bad: "no" },
  { name: "supported", good: "yes", bad: "no" },
  { name: "addsNothing", good: "yes", bad: "no" },
] as const;

/**
 * The blind rubric over both arms' lead lines: each lead an item of its own, both arms shuffled
 * together, a lead both arms wrote judged once for both. The sections come from the baseline for
 * both arms' items (the pair check makes them the same); the unit's title is not shown, so the lead
 * is read on its own, as the title step wrote it from the sections.
 */
export const leadPairRubricSample = (
  pairs: ReadonlyArray<TitlePair>,
  seed: string,
) => {
  checkPairs(pairs);
  const entries = pairs.flatMap((pair) => {
    const next = new Map(
      joinedOf(pair.candidate).map((unit) => [unit.id, unit]),
    );
    return joinedOf(pair.baseline).flatMap((unit) => {
      const sections = (unit.sections ?? []).map((section) => ({
        title: section.title,
        facts: section.content?.facts?.text ?? "",
      }));
      const leads = [
        { arm: "baseline" as const, lead: leadOf(unit) },
        { arm: "candidate" as const, lead: leadOf(next.get(unit.id)!) },
      ];
      return [...new Set(leads.map((entry) => entry.lead))]
        .filter((lead) => lead !== "")
        .map((lead) => ({
          id: `l${createHash("sha256").update(`${seed}|${pair.caseId}|${unit.id}|${lead}`).digest("hex").slice(0, 12)}`,
          lead,
          sections,
          key: {
            caseId: pair.caseId,
            unit: unit.id,
            source: pair.source,
            arms: leads
              .filter((entry) => entry.lead === lead)
              .map((entry) => entry.arm),
          },
        }));
    });
  });
  const items = shuffled(entries, `${seed}|order`);
  return {
    version: 1 as const,
    seed,
    items: items.map(({ key: _key, ...item }) => LeadRubricItem.parse(item)),
    key: Object.fromEntries(
      items.map((entry) => [entry.id, entry.key]),
    ) as PairRubricKey,
  };
};

export const leadRubricComparison = (
  decided: z.infer<typeof LeadRubricDecided>,
  key: PairRubricKey,
) => pairedRubricRates(decided.answers, key, LEAD_RUBRIC_ROWS, "lead-rubric");

/** The lead check in plain lines. */
export const describeLeadComparison = (
  result: ReturnType<typeof leadComparison>,
) => {
  const pct = (value: number | null) =>
    value === null ? "n/a" : `${Math.round(value * 1_000) / 10}%`;
  const points = (value: number) =>
    `${value >= 0 ? "+" : ""}${Math.round(value * 1_000) / 10}`;
  const length = (l: ReturnType<typeof lengths>) =>
    l.n === 0 ? "n/a" : `median ${l.p50}, top tenth ${l.p90}, longest ${l.max}`;
  const row = result.repeatsTitle;
  return [
    `  lead lines (${result.units} joined units): restating the unit's title ${pct(row.baseline)} → ${pct(row.candidate)}${row.delta === null ? "" : ` (${points(row.delta)} points${row.interval === null ? "" : `, 95% interval ${points(row.interval[0])} to ${points(row.interval[1])}`})`}; words baseline ${length(result.words.baseline)}, candidate ${length(result.words.candidate)}.`,
  ];
};
