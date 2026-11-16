import { createHash } from "node:crypto";
import { z } from "zod";
import { quantile, random } from "../../retrieval-bench/score/stats.ts";
import { claimsLed, lengths, wordCount } from "./digests.ts";
import {
  checkPairs,
  pairedRubricRates,
  type PairRubricKey,
  type TitlePair,
} from "./titles-compare.ts";

/**
 * A batch-digest candidate against its baseline (10.139): the same development cases recomposed
 * twice, read in pairs. The digest is written after placement and nothing else reads it, so both
 * arms must hold the same units in full (placement, titles, briefings, every unit field) and the
 * same batches; only the batch digests may differ. Kept only when the led shares rise beyond the
 * paired case bootstrap's interval, the words do not rise at the median or the top tenth, no rubric
 * row falls beyond its interval, and accuracy and misleading claims do not fall at all (overseer).
 */

export const DIGESTS_BOOTSTRAP_SEED = "neuve-digests-compare-v1";
export const DIGESTS_DRAWS = 2_000;

interface BatchLite {
  readonly id: string;
  readonly title?: string;
  readonly focus?: string;
  readonly obligationIds?: ReadonlyArray<string>;
  readonly digest?: {
    /** Who wrote it: the agent, or code when the digest call gave no answer. */
    readonly source?: string;
    readonly digest: string;
    readonly verification: string;
    readonly uncertainty?: ReadonlyArray<string>;
    readonly limitations?: ReadonlyArray<string>;
  } | null;
}

interface UnitLite {
  readonly id: string;
  readonly batchId?: string;
  readonly path?: string;
  readonly hunkIds?: ReadonlyArray<string>;
  readonly title: string;
  readonly content?: {
    readonly facts?: {
      readonly text?: string;
      readonly cites?: ReadonlyArray<string>;
    };
  } | null;
  readonly assessment?: {
    readonly validation?: {
      readonly requirements?: ReadonlyArray<{
        readonly requirement: string;
        readonly coverage?: string;
        readonly proof?: ReadonlyArray<string>;
      }>;
    } | null;
  } | null;
}

const assembledOf = (shown: Record<string, unknown>) =>
  (shown["assembled"] ?? []) as ReadonlyArray<{
    readonly batches: ReadonlyArray<BatchLite>;
    readonly units: ReadonlyArray<UnitLite>;
    /** The composition's disclosures, a digest over its word budget among them. */
    readonly gaps?: ReadonlyArray<string>;
    readonly references?: ReadonlyArray<{
      readonly id: string;
      readonly entries?: ReadonlyArray<string>;
      readonly unitIds?: ReadonlyArray<string>;
    }>;
  }>;

/**
 * Refuses a pair in which anything but the batch digests differs: placement (titles-compare's
 * check), every unit in full, and the batches' IDs.
 */
export const checkDigestPairs = (pairs: ReadonlyArray<TitlePair>) => {
  checkPairs(pairs);
  for (const pair of pairs) {
    // Sorting by ID compares like with like only when each ID is one unit or one batch.
    for (const [arm, shown] of [
      ["baseline", pair.baseline],
      ["candidate", pair.candidate],
    ] as const) {
      const ids = [
        ...assembledOf(shown).flatMap((batch) =>
          batch.units.map((u) => `unit ${u.id}`),
        ),
        ...assembledOf(shown).flatMap((batch) =>
          batch.batches.map((b) => `batch ${b.id}`),
        ),
      ];
      const twice = ids.find((id, index) => ids.indexOf(id) !== index);
      if (twice !== undefined)
        throw new Error(`${pair.caseId}: the ${arm} run holds ${twice} twice`);
    }
    // By ID: composed batches can come in another order in a run, their units the same.
    const units = (shown: Record<string, unknown>) =>
      JSON.stringify(
        assembledOf(shown)
          .flatMap((batch) => batch.units)
          .sort((a, b) => (a.id < b.id ? -1 : 1)),
      );
    const batches = (shown: Record<string, unknown>) =>
      JSON.stringify(
        assembledOf(shown)
          .flatMap((batch) => batch.batches.map((b) => b.id))
          .sort(),
      );
    if (
      units(pair.baseline) !== units(pair.candidate) ||
      batches(pair.baseline) !== batches(pair.candidate)
    )
      throw new Error(
        `${pair.caseId}: the candidate changed more than the batch digests; a digest candidate only rewrites them`,
      );
  }
  return pairs;
};

/** A case's batch digests: each part led or not, and its words. */
const digestsOf = (shown: Record<string, unknown>) =>
  assembledOf(shown).flatMap((assembled) =>
    assembled.batches.flatMap((batch) =>
      batch.digest === undefined || batch.digest === null
        ? []
        : [
            {
              batch: batch.id,
              byCode: batch.digest.source === "code",
              // Disclosed by the composition as over the batch's word budget (10.139's b′).
              overBudget: (assembled.gaps ?? []).some(
                (gap) =>
                  gap.startsWith(`Batch ${batch.id}'s digest runs `) &&
                  gap.includes("over its budget"),
              ),
              whatChangedLed: claimsLed(batch.digest.digest),
              whatToCheckLed: claimsLed(batch.digest.verification),
              words:
                wordCount(batch.digest.digest) +
                wordCount(batch.digest.verification),
            },
          ],
    ),
  );

const share = (part: number, whole: number) =>
  whole === 0 ? null : Math.round((part / whole) * 1_000) / 1_000;

const LED = ["whatChangedLed", "whatToCheckLed"] as const;

/**
 * The digest check, both arms: each led share with its delta and the paired case bootstrap's 95%
 * interval, and the words as median, top tenth and longest per arm.
 */
export const digestComparison = (pairs: ReadonlyArray<TitlePair>) => {
  checkDigestPairs(pairs);
  const perCase = pairs.map((pair) => ({
    base: digestsOf(pair.baseline),
    next: digestsOf(pair.candidate),
  }));
  const led = Object.fromEntries(
    LED.map((measure) => {
      const counts = perCase.map((entry) => ({
        units: entry.base.length,
        base: entry.base.filter((d) => d[measure]).length,
        next: entry.next.filter((d) => d[measure]).length,
      }));
      const batches = counts.reduce((sum, c) => sum + c.units, 0);
      const baseline = share(
        counts.reduce((sum, c) => sum + c.base, 0),
        batches,
      );
      const candidate = share(
        counts.reduce((sum, c) => sum + c.next, 0),
        batches,
      );
      const next = random(`${DIGESTS_BOOTSTRAP_SEED}:${measure}`);
      const deltas: Array<number> = [];
      if (counts.some((c) => c.units > 0))
        for (let draw = 0; draw < DIGESTS_DRAWS; draw++) {
          let units = 0;
          let gained = 0;
          for (let index = 0; index < counts.length; index++) {
            const c =
              counts[
                Math.min(counts.length - 1, Math.floor(next() * counts.length))
              ]!;
            units += c.units;
            gained += c.next - c.base;
          }
          if (units > 0) deltas.push(gained / units);
        }
      deltas.sort((a, b) => a - b);
      return [
        measure,
        {
          batches,
          baseline,
          candidate,
          delta:
            baseline === null || candidate === null
              ? null
              : Math.round((candidate - baseline) * 1_000) / 1_000,
          interval:
            deltas.length === 0
              ? null
              : ([
                  Math.round(quantile(deltas, 0.025) * 1_000) / 1_000,
                  Math.round(quantile(deltas, 0.975) * 1_000) / 1_000,
                ] as const),
        },
      ];
    }),
  ) as Record<
    (typeof LED)[number],
    {
      batches: number;
      baseline: number | null;
      candidate: number | null;
      delta: number | null;
      interval: readonly [number, number] | null;
    }
  >;
  return {
    cases: pairs.length,
    // Digests code wrote when the call gave no answer, per arm: read before any keep.
    byCode: {
      baseline: perCase.reduce(
        (sum, entry) => sum + entry.base.filter((d) => d.byCode).length,
        0,
      ),
      candidate: perCase.reduce(
        (sum, entry) => sum + entry.next.filter((d) => d.byCode).length,
        0,
      ),
    },
    // Digests disclosed over their word budget, per arm: a digest kept past its one rewrite.
    overBudget: {
      baseline: perCase.reduce(
        (sum, entry) => sum + entry.base.filter((d) => d.overBudget).length,
        0,
      ),
      candidate: perCase.reduce(
        (sum, entry) => sum + entry.next.filter((d) => d.overBudget).length,
        0,
      ),
    },
    led,
    words: {
      baseline: lengths(
        perCase.flatMap((entry) => entry.base.map((d) => d.words)),
      ),
      candidate: lengths(
        perCase.flatMap((entry) => entry.next.map((d) => d.words)),
      ),
    },
  };
};

/**
 * One batch digest to judge: the digest's parts, and what the digest's writer was given about its
 * batch (title, focus, obligations with their basis and hunks, and each unit's ID, path, hunks,
 * title, facts with what they cite, references, and validation requirements with their coverage and
 * proof records), so every claim, links included, can be checked. Never its arm: the units are
 * compared in full by the pair check, and the rest is read from the baseline for both arms' items.
 */
export const DigestRubricItem = z.strictObject({
  id: z.string().regex(/^d[0-9a-f]{12}$/),
  whatChanged: z.string(),
  whatToCheck: z.string(),
  uncertainty: z.array(z.string()),
  limitations: z.array(z.string()),
  batch: z.strictObject({ title: z.string(), focus: z.string() }),
  obligations: z.array(
    z.strictObject({
      id: z.string(),
      text: z.string(),
      basis: z.string(),
      hunkIds: z.array(z.string()),
    }),
  ),
  units: z.array(
    z.strictObject({
      id: z.string(),
      path: z.string(),
      hunkIds: z.array(z.string()),
      title: z.string(),
      facts: z.string(),
      /** What Facts cites: the hunks and ledger entries its claims rest on. */
      factsCites: z.array(z.string()),
      /** The references the unit takes part in: their ledger entries and the other units they span. */
      references: z.array(
        z.strictObject({
          id: z.string(),
          entries: z.array(z.string()),
          units: z.array(z.string()),
        }),
      ),
      requirements: z.array(
        z.strictObject({
          requirement: z.string(),
          coverage: z.string(),
          proof: z.array(z.string()),
        }),
      ),
    }),
  ),
});
export type DigestRubricItem = z.infer<typeof DigestRubricItem>;

const Answer = z.enum(["yes", "no", "unsure"]);

/** One judge's answers on one digest: the owner's digest rows (10.107), as the desk asks them. */
export const DigestRubricAnswer = z.strictObject({
  id: z.string().regex(/^d[0-9a-f]{12}$/),
  /** Every claim it makes matches the units' facts. */
  accurate: Answer,
  /** It covers what the batch does and what to check, with nothing a reviewer needs left out. */
  complete: Answer,
  /** Whether any claim would mislead a reviewer. */
  misleadingClaim: z.enum(["none", "some", "unsure"]),
  /** It says nothing that decides the review before the reviewer does. */
  neutralBeforeVerdict: Answer,
  /** One sentence: why, for any "no" or "some". */
  reason: z.string(),
});

export const DigestRubricDecided = z.strictObject({
  version: z.literal(1),
  answers: z.array(DigestRubricAnswer),
  /** The judge's prompt wording (sha256), so paired reads stay within one wording; absent before it was recorded. */
  promptDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});

export const DIGEST_RUBRIC_QUESTIONS = [
  "accurate: is every claim the digest makes, its links included, supported by the batch's units, facts, obligations and requirements with their coverage? (yes, no or unsure)",
  "complete: does it cover what the batch does and what to check, leaving out nothing a reviewer needs? (yes, no or unsure)",
  "misleadingClaim: would any claim mislead a reviewer? (none, some or unsure)",
  "neutralBeforeVerdict: does it avoid deciding the review for the reviewer: no approval, no verdict, no lane? (yes, no or unsure)",
] as const;

/** The rows, as pairedRubricRates reads them; for misleadingClaim the good answer is none. */
export const DIGEST_RUBRIC_ROWS = [
  { name: "accurate", good: "yes", bad: "no" },
  { name: "complete", good: "yes", bad: "no" },
  { name: "misleadingClaim", good: "none", bad: "some" },
  { name: "neutralBeforeVerdict", good: "yes", bad: "no" },
] as const;

/**
 * The blind rubric over both arms' batch digests: each digest an item of its own, both arms shuffled
 * together, a digest both arms wrote judged once for both. The key names each item's case, batch and
 * arms; its `unit` field holds the batch, so the call split that keeps a unit's two titles apart
 * keeps a batch's two digests apart too.
 */
export const digestPairRubricSample = (
  pairs: ReadonlyArray<TitlePair>,
  seed: string,
) => {
  checkDigestPairs(pairs);
  // The change map's obligations by ID, as the digest's task lists them.
  const obligationsOf = (shown: Record<string, unknown>) =>
    new Map(
      (
        ((shown["changeMap"] as { behaviours?: ReadonlyArray<unknown> } | null)
          ?.behaviours ?? []) as ReadonlyArray<{
          obligations?: ReadonlyArray<{
            id: string;
            text: string;
            basis?: string;
            hunkIds?: ReadonlyArray<string>;
          }>;
        }>
      ).flatMap((behaviour) =>
        (behaviour.obligations ?? []).map((o) => [o.id, o] as const),
      ),
    );
  const entries = pairs.flatMap((pair) =>
    assembledOf(pair.baseline).flatMap((assembled) =>
      assembled.batches.flatMap((batch) => {
        // The candidate's batch by ID: its run can list composed batches in another order.
        const other = assembledOf(pair.candidate)
          .flatMap((entry) => entry.batches)
          .find((b) => b.id === batch.id)!;
        if (
          batch.digest === undefined ||
          batch.digest === null ||
          other.digest === undefined ||
          other.digest === null
        )
          return [];
        const units = assembled.units
          .filter(
            (unit) => unit.batchId === undefined || unit.batchId === batch.id,
          )
          .map((unit) => ({
            id: unit.id,
            path: unit.path ?? "",
            hunkIds: [...(unit.hunkIds ?? [])],
            title: unit.title,
            facts: unit.content?.facts?.text ?? "",
            factsCites: [...(unit.content?.facts?.cites ?? [])],
            references: (assembled.references ?? [])
              .filter((reference) =>
                (reference.unitIds ?? []).includes(unit.id),
              )
              .map((reference) => ({
                id: reference.id,
                entries: [...(reference.entries ?? [])],
                units: (reference.unitIds ?? []).filter((id) => id !== unit.id),
              })),
            requirements: (unit.assessment?.validation?.requirements ?? []).map(
              (r) => ({
                requirement: r.requirement,
                coverage: r.coverage ?? "",
                proof: [...(r.proof ?? [])],
              }),
            ),
          }));
        const obligations = obligationsOf(pair.baseline);
        const digests = [
          { arm: "baseline" as const, digest: batch.digest },
          { arm: "candidate" as const, digest: other.digest },
        ];
        const text = (d: (typeof digests)[number]["digest"]) =>
          JSON.stringify([
            d.digest,
            d.verification,
            d.uncertainty ?? [],
            d.limitations ?? [],
          ]);
        const distinct = [...new Set(digests.map((d) => text(d.digest)))];
        return distinct.map((written) => {
          const of = digests.find((d) => text(d.digest) === written)!.digest;
          return {
            id: `d${createHash("sha256").update(`${seed}|${pair.caseId}|${batch.id}|${written}`).digest("hex").slice(0, 12)}`,
            whatChanged: of.digest,
            whatToCheck: of.verification,
            uncertainty: [...(of.uncertainty ?? [])],
            limitations: [...(of.limitations ?? [])],
            batch: { title: batch.title ?? "", focus: batch.focus ?? "" },
            obligations: (batch.obligationIds ?? []).map((id) => ({
              id,
              text: obligations.get(id)?.text ?? "",
              basis: obligations.get(id)?.basis ?? "",
              hunkIds: [...(obligations.get(id)?.hunkIds ?? [])],
            })),
            units,
            key: {
              caseId: pair.caseId,
              unit: batch.id,
              source: pair.source,
              arms: digests
                .filter((d) => text(d.digest) === written)
                .map((d) => d.arm),
            },
          };
        });
      }),
    ),
  );
  const next = random(`${seed}|order`);
  const items = [...entries];
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(next() * (i + 1)));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return {
    version: 1 as const,
    seed,
    items: items.map(({ key: _key, ...item }) => DigestRubricItem.parse(item)),
    key: Object.fromEntries(
      items.map((entry) => [entry.id, entry.key]),
    ) as PairRubricKey,
  };
};

/** Each digest rubric row's good share per arm, the delta and its interval. */
export const digestRubricComparison = (
  decided: z.infer<typeof DigestRubricDecided>,
  key: PairRubricKey,
) =>
  pairedRubricRates(decided.answers, key, DIGEST_RUBRIC_ROWS, "digest-rubric");

/** The comparison in plain lines. */
export const describeDigestComparison = (
  result: ReturnType<typeof digestComparison>,
) => {
  const pct = (value: number | null) =>
    value === null ? "n/a" : `${Math.round(value * 1_000) / 10}%`;
  const points = (value: number) =>
    `${value >= 0 ? "+" : ""}${Math.round(value * 1_000) / 10}`;
  const length = (l: ReturnType<typeof lengths>) =>
    l.n === 0 ? "n/a" : `median ${l.p50}, top tenth ${l.p90}, longest ${l.max}`;
  return [
    `${result.cases} case(s), each recomposed by the baseline and the candidate.`,
    ...LED.map((measure) => {
      const row = result.led[measure];
      return `  ${measure === "whatChangedLed" ? "What changed" : "What to check"} led (${row.batches} batches): ${pct(row.baseline)} → ${pct(row.candidate)}${row.delta === null ? "" : ` (${points(row.delta)} points${row.interval === null ? "" : `, 95% interval ${points(row.interval[0])} to ${points(row.interval[1])}`})`}.`;
    }),
    `  Words: baseline ${length(result.words.baseline)}; candidate ${length(result.words.candidate)}.`,
    `  Digests written by code (no answer from the call): baseline ${result.byCode.baseline}, candidate ${result.byCode.candidate}.`,
    `  Digests disclosed over their word budget: baseline ${result.overBudget.baseline}, candidate ${result.overBudget.candidate}.`,
  ];
};
