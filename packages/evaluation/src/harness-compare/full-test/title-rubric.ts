import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * The title rubric (10.139): a blind judgement of unit titles by the replay thread's labellers, a
 * majority of two with a third on ties (10.135). The owner's point is that one-concern units title
 * well and joined ones don't, so the sample is every development unit of two or more concerns and a
 * same-sized seeded sample of one-concern units, stratified by source. An item carries what a
 * reviewer would see beside the title, never which harness or run made it.
 */

export const TITLE_RUBRIC_VERSION = 1;

/** One title to judge: the title, the briefing lines of the changes it heads, and the files they touch. */
export const TitleRubricItem = z.strictObject({
  /** Opaque: a hash of the unit's place, so answers join back without naming the run. */
  id: z.string().regex(/^t[0-9a-f]{12}$/),
  title: z.string().min(1),
  /** Each change the unit holds, as its briefing line: one for a one-concern unit. */
  changes: z.array(z.string().min(1)).min(1),
  paths: z.array(z.string().min(1)).min(1),
});
export type TitleRubricItem = z.infer<typeof TitleRubricItem>;

const Answer = z.enum(["yes", "no", "unsure"]);

/** One judge's answers on one title. */
export const TitleRubricAnswer = z.strictObject({
  id: z.string().regex(/^t[0-9a-f]{12}$/),
  /** The title names the main change. */
  namesMain: Answer,
  /** It covers the other changes or says how they relate; not applicable with one change. */
  coversRest: z.enum(["yes", "no", "unsure", "not-applicable"]),
  /** It is one statement, not a list joined together. */
  oneStatement: Answer,
  /** A reviewer reading it would know where to look. */
  whereToLook: Answer,
  /** One sentence: why, for any "no". */
  reason: z.string(),
});
export type TitleRubricAnswer = z.infer<typeof TitleRubricAnswer>;

/** A call's answers: one per item it was given, in any order. */
export const TitleRubricPass = z.strictObject({
  answers: z.array(TitleRubricAnswer),
});

/** The questions as the judge reads them, with the items in the prompt. */
export const TITLE_RUBRIC_QUESTIONS = [
  "namesMain: does the title name the unit's main change? (yes, no or unsure)",
  "coversRest: when the unit holds more than one change, does the title cover the others or say how they relate to the main one? (yes, no, unsure, or not-applicable for one change)",
  "oneStatement: is it one statement, not several titles joined with commas, semicolons or 'and'? (yes, no or unsure)",
  "whereToLook: would a reviewer reading only the title know where in the change to look? (yes, no or unsure)",
] as const;

/** What the sampler reads of a run: its assembled units with their sections' briefing lines. */
export interface ShownRubricUnits {
  readonly assembled?: ReadonlyArray<{
    readonly units: ReadonlyArray<{
      readonly id: string;
      readonly title: string;
      readonly ownedPaths?: ReadonlyArray<string>;
      readonly sections?: ReadonlyArray<{
        readonly title: string;
        readonly content?: { readonly briefed?: string | null } | null;
      }>;
      readonly content?: { readonly briefed?: string | null } | null;
    }>;
  }>;
}

const firstSentence = (text: string) =>
  (
    text
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .split(/\n\s*\n/)[0]
      ?.split(/(?<=[.!?])\s+/)[0] ?? ""
  ).trim();

/** A seeded shuffle (mulberry32 over the seed's hash), so a sample can be drawn again. */
const shuffled = <T>(items: ReadonlyArray<T>, seed: string) => {
  let state = createHash("sha256").update(seed).digest().readUInt32LE(0);
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
};

/**
 * The rubric's sample over development runs: every unit of two or more concerns, and as many
 * one-concern units drawn per source as that source has of the others (fewer where it has fewer),
 * seeded. Items come back shuffled, so a call rarely holds several of one run's units.
 */
export const titleRubricSample = (
  runs: ReadonlyArray<
    ShownRubricUnits & { readonly caseId: string; readonly source: string }
  >,
  seed: string,
) => {
  const units = runs.flatMap((run) =>
    (run.assembled ?? []).flatMap((batch) =>
      batch.units.flatMap((unit) => {
        const sections = unit.sections ?? [];
        const changes =
          sections.length > 1
            ? sections.map(
                (section) =>
                  firstSentence(section.content?.briefed ?? "") ||
                  section.title,
              )
            : [firstSentence(unit.content?.briefed ?? "") || unit.title];
        return [
          {
            source: run.source,
            joined: sections.length > 1,
            key: `${run.caseId}|${unit.id}`,
            item: {
              id: `t${createHash("sha256").update(`${run.caseId}|${unit.id}`).digest("hex").slice(0, 12)}`,
              title: unit.title,
              changes,
              paths:
                unit.ownedPaths !== undefined && unit.ownedPaths.length > 0
                  ? [...unit.ownedPaths]
                  : ["(unknown)"],
            },
          },
        ];
      }),
    ),
  );
  const sources = [...new Set(units.map((unit) => unit.source))].sort();
  const picked = sources.flatMap((source) => {
    const joined = units.filter((u) => u.source === source && u.joined);
    const single = shuffled(
      units.filter((u) => u.source === source && !u.joined),
      `${seed}|${source}`,
    ).slice(0, joined.length);
    return [...joined, ...single];
  });
  const items = shuffled(picked, `${seed}|order`);
  return {
    version: TITLE_RUBRIC_VERSION,
    seed,
    items: items.map((entry) => TitleRubricItem.parse(entry.item)),
    // Kept by the evaluator only: which unit each item is, by source and kind.
    key: Object.fromEntries(
      items.map((entry) => [
        entry.item.id,
        { unit: entry.key, source: entry.source, joined: entry.joined },
      ]),
    ),
  };
};

/** The items in calls of at most `size`, so one call judges many titles. */
export const rubricChunks = <T>(items: ReadonlyArray<T>, size = 25) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  );

/** The decided answers (the replay thread's majority per item), joined back to their units. */
export const TitleRubricDecided = z.strictObject({
  version: z.literal(TITLE_RUBRIC_VERSION),
  answers: z.array(TitleRubricAnswer),
  /** The judge's prompt wording (sha256), so paired reads stay within one wording; absent before it was recorded. */
  promptDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});

const RubricKey = z.record(
  z.string(),
  z.strictObject({
    unit: z.string(),
    source: z.string(),
    joined: z.boolean(),
  }),
);

const RUBRIC_ROWS = [
  "namesMain",
  "coversRest",
  "oneStatement",
  "whereToLook",
] as const;

/** Each question's yes share, for joined and one-concern units and by source; unsure is left out. */
export const rubricRates = (
  decided: z.infer<typeof TitleRubricDecided>,
  key: z.infer<typeof RubricKey>,
) => {
  const ids = decided.answers.map((answer) => answer.id);
  const twice = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (twice.length > 0)
    throw new Error(
      `the decided answers name ${[...new Set(twice)].join(", ")} more than once`,
    );
  const rows = decided.answers.flatMap((answer) => {
    const unit = key[answer.id];
    return unit === undefined ? [] : [{ ...unit, answer }];
  });
  const rates = (of: typeof rows) => ({
    titles: of.length,
    // How many titles each yes share rests on: unsure and not-applicable answers are left out.
    judged: Object.fromEntries(
      RUBRIC_ROWS.map((row) => [
        row,
        of.filter((r) => r.answer[row] === "yes" || r.answer[row] === "no")
          .length,
      ]),
    ) as Record<(typeof RUBRIC_ROWS)[number], number>,
    ...(Object.fromEntries(
      RUBRIC_ROWS.map((row) => {
        const judged = of.filter(
          (r) => r.answer[row] === "yes" || r.answer[row] === "no",
        );
        return [
          row,
          judged.length === 0
            ? null
            : Math.round(
                (judged.filter((r) => r.answer[row] === "yes").length /
                  judged.length) *
                  1_000,
              ) / 1_000,
        ];
      }),
    ) as Record<(typeof RUBRIC_ROWS)[number], number | null>),
  });
  const sources = [...new Set(rows.map((r) => r.source))].sort();
  return {
    joined: rates(rows.filter((r) => r.joined)),
    single: rates(rows.filter((r) => !r.joined)),
    bySource: Object.fromEntries(
      sources.map((source) => [
        source,
        {
          joined: rates(rows.filter((r) => r.source === source && r.joined)),
          single: rates(rows.filter((r) => r.source === source && !r.joined)),
        },
      ]),
    ),
    unmatched: decided.answers.length - rows.length,
  };
};

export const readRubricKey = (text: string) =>
  RubricKey.parse(JSON.parse(text));
