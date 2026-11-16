import { createHash } from "node:crypto";
import { z } from "zod";
import type { V1Params } from "../rescoring.ts";
import type { V4Params } from "./variants.ts";

/**
 * The frozen configuration a held-out run applies (9.58): everything dev selected or tuned, read back
 * from the committed dev report and never derived again. Held-out selects nothing and tunes nothing:
 * the best dense, fusion and topology arms are dev's `selection`, each variant's setting is dev's
 * `tuning.chosen`, and the rule's settings (share, comparison count, resamples, seed) are dev's.
 * Anything missing or in an unexpected form is refused, naming what is missing.
 */

const Tuned = z.object({ chosen: z.unknown() });
const Interval = z.object({
  level: z.number(),
  lower: z.number().nullable(),
  upper: z.number().nullable(),
});
/** What the held-out report sets beside each held-out comparison: dev's reading of it. */
const DevComparison = z.object({
  name: z.string(),
  other: z.string(),
  default: z.string(),
  excludedHunks: z.number(),
  noAnswer: z.array(z.unknown()),
  hunksRemaining: z.number(),
  mixedDepth: z.array(z.unknown()),
  pairedHunks: z.number(),
  families: z.number(),
  delta: z.number().nullable(),
  interval: Interval,
  relevant: z.object({
    pairedHunks: z.number(),
    families: z.number(),
    delta: z.number().nullable(),
    interval: Interval,
  }),
  guard: z.object({
    measurable: z.boolean(),
    defaultMisleading: z.number().nullable(),
    otherMisleading: z.number().nullable(),
  }),
  decision: z.object({
    winner: z.string(),
    outcome: z.string(),
    failed: z.string().nullable(),
    reason: z.string(),
  }),
});
export type DevComparison = z.infer<typeof DevComparison>;
const DevReport = z.object({
  split: z.literal("dev"),
  settings: z.object({
    decideAt: z.enum(["opus", "sol"]),
    comparisons: z.number().int(),
    resamples: z.number().int().positive(),
    seed: z.string().min(1),
  }),
  selection: z.object({
    bestDense: z.string().min(1),
    bestFusion: z.string().min(1),
    bestTopology: z.string().min(1),
  }),
  comparisons: z.object({
    list: z.array(DevComparison),
    otherShare: z.array(DevComparison),
  }),
  variants: z.object({
    list: z.array(
      z.object({
        arm: z.string().min(1),
        of: z.string().min(1),
        inputs: z.array(z.string().min(1)),
        tuning: Tuned.nullable(),
      }),
    ),
  }),
});

const V1Setting = z.object({ alpha: z.number(), m: z.number() }).strict();
const V2Setting = z.object({ lambda: z.number() }).strict();
const V4Setting = z
  .object({
    weights: z.tuple([z.number(), z.number(), z.number()]),
    beta: z.number(),
  })
  .strict();

export interface FrozenVariant {
  readonly arm: string;
  readonly of: string;
  readonly inputs: ReadonlyArray<string>;
  /** Dev's chosen setting; null for V3a (R itself, nothing tuned). */
  readonly chosen: unknown;
}

export interface FrozenConfig {
  readonly source: { readonly path: string; readonly sha256: string };
  readonly settings: z.infer<typeof DevReport>["settings"];
  readonly selection: z.infer<typeof DevReport>["selection"];
  /** Dev's selection scores, copied for the report (never recomputed). */
  readonly devSelectionScores: unknown;
  readonly variants: ReadonlyMap<string, FrozenVariant>;
  /** Dev's six comparisons at the decision share and the other share, for the side-by-side. */
  readonly devComparisons: {
    readonly list: ReadonlyArray<DevComparison>;
    readonly otherShare: ReadonlyArray<DevComparison>;
  };
}

/** Reads the frozen configuration from the dev report's text; refuses what it cannot read back. */
export const frozenFromDevReport = (
  text: string,
  path: string,
): FrozenConfig => {
  const json: unknown = JSON.parse(text);
  const parsed = DevReport.safeParse(json);
  if (!parsed.success)
    throw new Error(
      `${path}: the dev report does not record dev's choices in a form held-out can read back: ${z.prettifyError(parsed.error)}`,
    );
  const report = parsed.data;
  const variants = new Map<string, FrozenVariant>();
  for (const entry of report.variants.list) {
    if (variants.has(entry.arm))
      throw new Error(`${path}: variant ${entry.arm} is listed twice`);
    const chosen = entry.tuning?.chosen ?? null;
    const setting =
      entry.arm.startsWith("V1(") || entry.arm.startsWith("V3b(")
        ? V1Setting
        : entry.arm.startsWith("V2(")
          ? V2Setting
          : entry.arm.startsWith("V4(")
            ? V4Setting
            : entry.arm.startsWith("V3a(")
              ? z.null()
              : undefined;
    if (setting === undefined)
      throw new Error(`${path}: variant ${entry.arm} is of no known kind`);
    const check = setting.safeParse(chosen);
    if (!check.success)
      throw new Error(
        `${path}: variant ${entry.arm}'s chosen setting cannot be read back: ${z.prettifyError(check.error)}`,
      );
    variants.set(entry.arm, {
      arm: entry.arm,
      of: entry.of,
      inputs: entry.inputs,
      chosen,
    });
  }
  return {
    source: {
      path,
      sha256: createHash("sha256").update(text).digest("hex"),
    },
    settings: report.settings,
    selection: report.selection,
    devSelectionScores:
      (json as { selection?: { scores?: unknown } }).selection?.scores ?? null,
    variants,
    devComparisons: report.comparisons,
  };
};

/** Dev's chosen setting for a variant arm, refusing an arm dev did not tune. */
export const frozenSetting = <P>(
  config: FrozenConfig,
  arm: string,
  of: string,
): P => {
  const entry = config.variants.get(arm);
  if (entry === undefined)
    throw new Error(
      `${arm} is not in the dev report's variants (${config.source.path}); held-out never tunes one`,
    );
  if (entry.of !== of)
    throw new Error(
      `${arm}: dev ran it over ${entry.of}, held-out would run it over ${of}`,
    );
  return entry.chosen as P;
};

export type { V1Params, V4Params };
