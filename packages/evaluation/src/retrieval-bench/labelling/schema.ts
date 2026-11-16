import { z } from "zod";
import { KINDS } from "../corpus.ts";

/**
 * B3 labelling data: the pooled candidates a labeller grades, the label form both labellers fill
 * (kept in the private archive), the cross-family grading of labeller additions
 * (9.16), agreement and the owner's adjudication queue (proposal section 3).
 *
 * Every labeller-facing object is strict and has no optional keys (absent values are null), so the
 * same schema can be handed to a model as a structured-output contract.
 */

export const LABEL_SCHEMA_VERSION = 1;

export const GRADES = [
  "necessary",
  "useful",
  "misleading",
  "irrelevant",
] as const;
export type Grade = (typeof GRADES)[number];
/** Form kinds: the four pool kinds plus history (proposal section 3, source kinds). */
export const FORM_KINDS = [...KINDS, "history"] as const;

/** Where a pooled candidate came from: a retriever arm's frozen top-k, history or a review citation. */
export const CandidateSource = z.strictObject({
  /** An arm id from arms.dev.json, or `history:earlier`, `history:later`, `review-citation`. */
  source: z.string(),
  /** 1-based rank inside that arm's frozen list; null for non-arm sources. */
  rank: z.int().positive().nullable(),
  startLine: z.int().nullable(),
  endLine: z.int().nullable(),
  /** For review citations: the citing document; for history: the commit. */
  ref: z.string().nullable(),
});
export type CandidateSource = z.infer<typeof CandidateSource>;

/** How the case treats a base region: changed in the range is same-batch context (4.12). */
export const RangeStatus = z.enum([
  "committed",
  "same-batch",
  "partly-same-batch",
]);

export const PoolCandidate = z.strictObject({
  /** Labeller-facing id, `c001`…, in path and line order (never rank order). */
  id: z.string().regex(/^c\d{3,}$/),
  type: z.enum(["region", "commit"]),
  /** Region candidates: a span of the base snapshot. */
  path: z.string().nullable(),
  startLine: z.int().positive().nullable(),
  endLine: z.int().positive().nullable(),
  kind: z.enum(FORM_KINDS),
  /** Commit candidates: the commit and whether it is before the base or after the head. */
  commit: z.string().nullable(),
  historyTiming: z.enum(["earlier", "later"]).nullable(),
  rangeStatus: RangeStatus.nullable(),
  /** Changed base lines of the range inside this region (same-batch share). */
  changedBaseLines: z.int().nonnegative(),
  /** Best rank over every arm that returned it; null when no arm did. */
  bestRank: z.int().positive().nullable(),
  sources: z.array(CandidateSource).min(1),
});
export type PoolCandidate = z.infer<typeof PoolCandidate>;

export const HunkPool = z.strictObject({
  schemaVersion: z.literal(LABEL_SCHEMA_VERSION),
  caseId: z.string(),
  hunkId: z.string(),
  repository: z.enum(["neuve_effect", "neuve"]),
  base: z.string(),
  head: z.string(),
  depth: z.int().positive(),
  arms: z.array(z.string()),
  candidates: z.array(PoolCandidate),
});
export type HunkPool = z.infer<typeof HunkPool>;

/**
 * The region a label points at. Base spans are retrievable; documents added or edited in the range,
 * code the range changes (head path and lines, for new code with no base span) and commits are not.
 */
export const LabelRegion = z.strictObject({
  source: z.enum(["base", "range-doc", "range-change", "commit"]),
  path: z.string().nullable(),
  startLine: z.int().positive().nullable(),
  endLine: z.int().positive().nullable(),
  heading: z.string().nullable(),
  commit: z.string().nullable(),
});
export type LabelRegion = z.infer<typeof LabelRegion>;

/** One filled label form (brief, "The label form"). Irrelevant candidates are listed by id instead. */
export const LabelItem = z.strictObject({
  candidateIds: z.array(z.string()),
  added: z.boolean(),
  region: LabelRegion,
  kind: z.enum(FORM_KINDS),
  grade: z.enum(["necessary", "useful", "misleading"]),
  whyItApplies: z.string().nullable(),
  checkBeforeDeciding: z.string().nullable(),
  /** Proposed addition to the form (brief, change 6): one sentence for misleading items. */
  whyItMisleads: z.string().nullable(),
  scopeTrace: z.string(),
  impliedRule: z.string().nullable(),
  historyTiming: z.enum(["earlier", "later"]).nullable(),
});
export type LabelItem = z.infer<typeof LabelItem>;

export const SCOPE_STRATA = [
  "plan-or-ticket-at-base",
  "plan-in-range",
  "commit-or-pr-text",
  "none",
] as const;

export const LabellerOutput = z.strictObject({
  caseId: z.string(),
  hunkId: z.string(),
  scope: z.strictObject({
    /** The scope sources the labeller traced: paths, `commit text`, or empty. */
    sources: z.array(z.string()),
    stratum: z.enum(SCOPE_STRATA),
    gap: z.string().nullable(),
  }),
  items: z.array(LabelItem),
  irrelevant: z.array(z.string()),
  notes: z.string().nullable(),
});
export type LabellerOutput = z.infer<typeof LabellerOutput>;

/** 9.16: a model from the other family grades each addition before it can enter the gold. */
export const AdditionGrade = z.strictObject({
  additionId: z.string(),
  valid: z.boolean(),
  invalidReason: z.string().nullable(),
  grade: z.enum(GRADES),
  reason: z.string(),
});
export const AdditionGrading = z.strictObject({
  caseId: z.string(),
  hunkId: z.string(),
  grades: z.array(AdditionGrade),
});
export type AdditionGrading = z.infer<typeof AdditionGrading>;

/** Run receipt per labeller per hunk: route, model, usage and wall time. */
export const RunReceipt = z.strictObject({
  caseId: z.string(),
  hunkId: z.string(),
  role: z.enum([
    "labeller",
    "addition-grader",
    "briefing",
    "adjudicator",
    "later-fix-reviewer",
  ]),
  route: z.enum(["codex-exec", "claude-agent", "claude-print"]),
  model: z.string(),
  effort: z.string().nullable(),
  wallSeconds: z.number(),
  inputTokens: z.int().nullable(),
  cachedInputTokens: z.int().nullable(),
  outputTokens: z.int().nullable(),
  reasoningTokens: z.int().nullable(),
  totalTokens: z.int().nullable(),
  toolCalls: z.int().nullable(),
  /** What the run would cost at API list prices, when the route reports it; runs bill the plan. */
  apiEquivalentUsd: z.number().nullable().default(null),
  /** Paths outside the run directory and the snapshot that the run's logged tool calls touched. */
  outsideReads: z.array(z.string()).default([]),
  /** Which Claude credential route ran it (never the value); null for Codex and older receipts. */
  credentialRoute: z
    .enum(["subscription-token", "api-key"])
    .nullable()
    .default(null),
  /** The variable name that carried it (never the value). */
  credentialVariable: z
    .enum(["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"])
    .nullable()
    .default(null),
  note: z.string().nullable(),
});
export type RunReceipt = z.infer<typeof RunReceipt>;

export const QUEUE_REASONS = [
  "disagreement",
  "necessary",
  "both-irrelevant-sample",
  "agreed-misleading-sample",
  "addition-conflict",
] as const;

export const QueueEntry = z.strictObject({
  key: z.string(),
  split: z.enum(["dev", "held-out"]),
  caseId: z.string(),
  hunkId: z.string(),
  reason: z.enum(QUEUE_REASONS),
  candidateId: z.string().nullable(),
  region: z.string(),
  labels: z.record(z.string(), z.enum(GRADES)),
  addition: z
    .strictObject({
      by: z.string(),
      grader: z.string(),
      graderGrade: z.enum(GRADES),
      valid: z.boolean(),
    })
    .nullable(),
  /** Filled by the owner. */
  ownerGrade: z.enum(GRADES).nullable(),
  ownerNote: z.string().nullable(),
});
export type QueueEntry = z.infer<typeof QueueEntry>;

/** JSON Schema for a structured-output contract (strict: every key required, nulls explicit). */
export const jsonSchemaOf = (schema: z.ZodType) => {
  const json = z.toJSONSchema(schema, { target: "draft-7" }) as Record<
    string,
    unknown
  >;
  delete json["$schema"];
  return stripBounds(json) as Record<string, unknown>;
};

/** Integer bounds are checked by validation; structured-output contracts accept fewer keywords. */
const BOUNDS = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minItems",
  "pattern",
]);
const stripBounds = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(stripBounds)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => !BOUNDS.has(key))
            .map(([key, inner]) => [key, stripBounds(inner)]),
        )
      : value;
