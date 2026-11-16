import { z } from "zod";

/**
 * The harness's stage and run telemetry as Records holds it (proposal §3.8, §10.2; 10.32, 10.73):
 * `stage.completed@1` carries one `StageTelemetry`, `run.completed@1` the `RunReceipt`. Both are
 * metadata only: usage, timing, counts and the route, never prompt or tool content. Costs are USD
 * computed from usage and the price table frozen with the route.
 */

const count = z.int().min(0);
const shortText = z.string().min(1).max(512);
const note = z.string().min(1).max(2_000);

/** Completed calls keep their established meaning; errors and aborts are separate attempts. */
export const ModelCallCounts = z.strictObject({
  modelCalls: count,
  failedModelCalls: count,
  abortedModelCalls: count,
});

/** One call's or one stage's token usage with the cache-write durations, from the provider's raw usage; `thinking` is part of `output` when reported. */
export const CallTokenUsage = z.strictObject({
  input: count,
  cacheWrite5m: count,
  cacheWrite1h: count,
  cacheRead: count,
  output: count,
  thinking: count.optional(),
});

/** Failed and aborted billing is separate from the established completed-call totals. */
export const ModelCallAttempts = ModelCallCounts.extend({
  failedUsage: CallTokenUsage,
  failedCostUsd: z.number().min(0).nullable(),
  abortedUsage: CallTokenUsage,
  abortedCostUsd: z.number().min(0).nullable(),
});
export type ModelCallAttempts = z.infer<typeof ModelCallAttempts>;

/** A stage's outcome: its output was computed, found stored, cut off at 9:45, never started, or a stub. */
export const StageStatus = z.enum([
  "computed",
  "reused",
  "interrupted",
  "skipped",
  "stub",
]);

/** What ended an agent's loop (proposal §3.4). */
export const EndedBy = z.enum([
  "submit",
  "turn-limit",
  "ceiling",
  "continuations",
  "overflow",
  "timeout",
]);

/** An agent's turns against its ruled limit (10.7, 10.28, 10.41) and whether the final generation ran (10.11). */
export const AgentTurns = z.strictObject({
  turnsUsed: count,
  turnLimit: z.int().min(1),
  ruledLimit: shortText.optional(),
  limitReached: z.boolean(),
  finalGeneration: z.boolean(),
  endedBy: EndedBy,
  resumedTurns: count,
  restarted: z.boolean(),
});

/** One stage's telemetry: wall time against its expected time, turns, calls, tokens and cost. */
export const StageTelemetry = z.strictObject({
  stage: shortText,
  agent: shortText,
  status: StageStatus,
  wallMs: count,
  expectedMs: count.optional(),
  turns: AgentTurns.optional(),
  modelCalls: count,
  usage: CallTokenUsage,
  /** Null when the route has no per-token price (the ChatGPT plan, 10.85): unknown, never 0. */
  costUsd: z.number().min(0).nullable(),
  note: note.optional(),
});

/** A gap the run recorded, as the receipt lists it; each is also its own `gap.disclosed@1` unless the harness keeps it out of the packet as plumbing. */
export const ReceiptGap = z.strictObject({
  stage: shortText,
  agent: shortText.optional(),
  kind: shortText,
  detail: note,
});

/**
 * Unit counts at 10, 20 and 40 lines (10.70): how many units the range would have at each
 * unchanged-line gap. Only the run knows them, so the receipt carries them. The other day-one counts
 * of 10.73 (10.55, 10.62, 10.63, merges and splits) are facts of the cycle's events, so they have one
 * definition, in the projections, and are read from there (`ReviewStats.reviewStats`), never copied
 * onto the receipt.
 */
export const UnitCounts = z.strictObject({
  at10: count,
  at20: count,
  at40: count,
});

/**
 * The run receipt (PU6). The run, its range and its cycle are the event's attribution, not copied
 * here. `stubSettings` is the harness's development configuration, stored without interpretation.
 */
export const RunReceipt = z.strictObject({
  runKey: z.string().regex(/^[0-9a-f]{64}$/),
  generation: z.int().min(0).max(1_000),
  jobSeq: z.int().min(1),
  route: z
    .strictObject({
      provider: shortText,
      model: shortText,
      effort: shortText,
      maxOutputTokens: z.int().min(1),
      contextCeiling: z.int().min(1),
      callsInFlight: z.int().min(1),
      callsInFlightMin: z.int().min(1).optional(),
      callsInFlightMax: z.int().min(1).optional(),
      configuredCallsInFlight: z.int().min(1).optional(),
      budgetFloor: z.boolean().optional(),
      /** The variable that supplied the key, never its value (10.5, 10.16). */
      credentialVariable: z
        .string()
        .regex(/^[A-Z][A-Z0-9_]{0,127}$/)
        .optional(),
      /** Or the Neuve sign-in the route's token came from (10.85), never its value. */
      credentialSource: z.literal("neuve-sign-in").optional(),
      organization: shortText.nullable(),
      price: z.record(z.string().min(1).max(64), z.number().min(0)),
    })
    .refine(
      (route) =>
        (route.credentialVariable === undefined) !==
        (route.credentialSource === undefined),
      "a route names exactly one credential: its key variable or the Neuve sign-in",
    ),
  outcome: z.enum(["completed", "timed-out"]),
  timeout: z.strictObject({
    lifetimeMs: z.int().min(1),
    cutoffAt: z.iso.datetime(),
    reached: z.boolean(),
    published: z.array(shortText).max(512),
    disclosed: z
      .array(
        z.strictObject({
          stage: shortText,
          status: StageStatus,
          note: note.optional(),
        }),
      )
      .max(512),
  }),
  timing: z.strictObject({
    enqueuedAt: z.iso.datetime(),
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime(),
    wallMs: count,
    queueWaitMs: z.int(),
    attempts: count,
  }),
  stages: z.array(StageTelemetry).max(512),
  totals: z.strictObject({
    modelCalls: count,
    retries: count,
    usage: CallTokenUsage,
    /** Null when the route has no per-token price (the ChatGPT plan, 10.85). */
    costUsd: z.number().min(0).nullable(),
  }),
  gaps: z.array(ReceiptGap).max(256),
  disclosures: z.array(note).max(32),
  /** Absent until Assemble groups units (H7); never reported as zeros. */
  unitCounts: UnitCounts.optional(),
  /** What the receipt cannot measure yet and why, instead of zeros. */
  notMeasured: z.record(z.string().min(1).max(64), note),
  stubSettings: z.json().optional(),
  /**
   * Set when the receipt's lists would take its event past the 64 KB payload cap: the lists are then
   * empty here and held whole by the event's `lists` blob (`ReceiptLists`), and these are their sizes.
   */
  listsByReference: z
    .strictObject({
      stages: count,
      gaps: count,
      published: count,
      disclosed: count,
    })
    .optional(),
});

/**
 * The receipt's lists, as the `lists` blob of a `run.completed@1` too large to carry them holds them.
 * The blob is not bound by the event's 64 KB payload, so its lists take the receipt's item shapes
 * with caps sized for the largest real pull requests (10.95): a timed-out run over a range of 115
 * units disclosed 320 gaps, past the inline cap of 256.
 */
const LIST_MAX = 65_536;
export const ReceiptLists = z.strictObject({
  stages: RunReceipt.shape.stages.element.array().max(LIST_MAX),
  gaps: RunReceipt.shape.gaps.element.array().max(LIST_MAX),
  published: RunReceipt.shape.timeout.shape.published.element
    .array()
    .max(LIST_MAX),
  disclosed: RunReceipt.shape.timeout.shape.disclosed.element
    .array()
    .max(LIST_MAX),
});

export type CallTokenUsage = z.infer<typeof CallTokenUsage>;
export type StageTelemetry = z.infer<typeof StageTelemetry>;
export type RunReceipt = z.infer<typeof RunReceipt>;
export type UnitCounts = z.infer<typeof UnitCounts>;
export type ReceiptLists = z.infer<typeof ReceiptLists>;
