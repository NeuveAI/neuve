import { z } from "zod";
import type { Cost, PriceRate, Totals } from "./dump.ts";
import type { RoutePricing, TokenUsage } from "./types.ts";

export const PiUsage = z.object({
  input: z.int(),
  output: z.int(),
  cacheRead: z.int(),
  cacheWrite: z.int(),
  reasoning: z.int().optional(),
  cacheWrite1h: z.int().optional(),
  totalTokens: z.int(),
  cost: z.object({
    input: z.number().optional(),
    output: z.number().optional(),
    cacheRead: z.number().optional(),
    cacheWrite: z.number().optional(),
    total: z.number(),
  }),
});
export type PiUsage = z.infer<typeof PiUsage>;
export const PiUsageDoc = z.object({
  models: z.record(z.string(), PiUsage),
  tools: z.record(z.string(), PiUsage),
});
export type PiUsageDoc = z.infer<typeof PiUsageDoc>;
export const ZERO: TokenUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
};

export const addTokens = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  ...(a.reasoning === undefined && b.reasoning === undefined
    ? {}
    : { reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0) }),
  totalTokens: a.totalTokens + b.totalTokens,
});

export const sameTokens = (a: TokenUsage, b: TokenUsage) =>
  a.input === b.input &&
  a.output === b.output &&
  a.cacheRead === b.cacheRead &&
  a.cacheWrite === b.cacheWrite &&
  a.totalTokens === b.totalTokens &&
  (a.reasoning === undefined ||
    b.reasoning === undefined ||
    a.reasoning === b.reasoning);

export const tokensOf = (usage: PiUsage): TokenUsage => ({
  input: usage.input,
  output: usage.output,
  cacheRead: usage.cacheRead,
  cacheWrite: usage.cacheWrite,
  ...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
  totalTokens: usage.totalTokens,
});

export type UsageBucket = keyof PiUsageDoc;
export type UsageMeasure = Omit<PiUsage, "cost"> & { cost?: PiUsage["cost"] };
export type UsageAccounting = Map<
  number,
  Record<UsageBucket, Map<string, UsageMeasure>>
>;

export const accountUsage = (
  accounting: UsageAccounting,
  conversationId: number,
  bucket: UsageBucket,
  key: string,
  usage: UsageMeasure,
) => {
  const conversation = accounting.get(conversationId) ?? {
    models: new Map<string, UsageMeasure>(),
    tools: new Map<string, UsageMeasure>(),
  };
  const prior = conversation[bucket].get(key);
  const total: UsageMeasure =
    prior === undefined
      ? structuredClone(usage)
      : {
          ...addTokens(prior, usage),
          ...(prior.cacheWrite1h === undefined &&
          usage.cacheWrite1h === undefined
            ? {}
            : {
                cacheWrite1h:
                  (prior.cacheWrite1h ?? 0) + (usage.cacheWrite1h ?? 0),
              }),
          ...(prior.cost === undefined || usage.cost === undefined
            ? {}
            : {
                cost: { total: prior.cost.total + usage.cost.total },
              }),
        };
  if (
    prior?.cost !== undefined &&
    usage.cost !== undefined &&
    total.cost !== undefined
  )
    for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const)
      if (prior.cost[field] !== undefined || usage.cost[field] !== undefined)
        total.cost[field] = (prior.cost[field] ?? 0) + (usage.cost[field] ?? 0);
  conversation[bucket].set(key, total);
  accounting.set(conversationId, conversation);
};

export const sameUsage = (a: UsageMeasure, b: UsageMeasure) => {
  if (
    !sameTokens(a, b) ||
    a.reasoning !== b.reasoning ||
    a.cacheWrite1h !== b.cacheWrite1h
  )
    return false;
  return (
    ["input", "output", "cacheRead", "cacheWrite", "total"] as const
  ).every((field) => {
    const left = a.cost?.[field];
    const right = b.cost?.[field];
    return (
      left === right ||
      (left !== undefined &&
        right !== undefined &&
        Math.abs(left - right) <=
          Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right)) * 32)
    );
  });
};

export const sameUsageBucket = (
  a: Map<string, UsageMeasure>,
  b: Map<string, UsageMeasure>,
) =>
  a.size === b.size &&
  [...a].every(([key, usage]) => {
    const source = b.get(key);
    return source !== undefined && sameUsage(usage, source);
  });

/** Prices one usage: the route's own price where it bills per token, unknown otherwise; an estimate only with a named rate. */
export const costOf = (
  tokens: TokenUsage,
  piTotal: number,
  pricing: RoutePricing | null,
  rate: PriceRate | null,
): Cost => ({
  recorded:
    pricing === "metered" && (piTotal !== 0 || tokens.totalTokens === 0)
      ? { status: "recorded", total: piTotal, currency: "USD" }
      : {
          status: "unknown",
          reason:
            pricing === "subscription"
              ? "subscription route: no per-token price"
              : pricing === "metered"
                ? "pi reported zero cost for non-zero usage without price provenance"
                : "no run.start: the route's pricing is unknown",
        },
  estimate:
    rate === null
      ? null
      : {
          rate: `${rate.name}@${rate.version}`,
          total:
            (tokens.input * rate.perMillionTokens.input +
              tokens.cacheRead * rate.perMillionTokens.cacheRead +
              tokens.cacheWrite * rate.perMillionTokens.cacheWrite +
              tokens.output * rate.perMillionTokens.output) /
            1_000_000,
        },
});

export const addCost = (a: Cost, b: Cost): Cost => ({
  recorded:
    a.recorded.status === "unknown"
      ? a.recorded
      : b.recorded.status === "unknown"
        ? b.recorded
        : {
            status: "recorded",
            total: a.recorded.total + b.recorded.total,
            currency: "USD",
          },
  estimate:
    a.estimate === null || b.estimate === null
      ? (a.estimate ?? b.estimate)
      : { rate: a.estimate.rate, total: a.estimate.total + b.estimate.total },
});

export const addTotals = (a: Totals, b: Totals): Totals => ({
  tokens: addTokens(a.tokens, b.tokens),
  cost: addCost(a.cost, b.cost),
});
