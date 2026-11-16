import { z } from "zod";

/**
 * The route's configuration and accounting: what a run freezes, how its usage is read and priced.
 * The provider clients and the sign-in are in `route-provider.ts`, so a module that only freezes a
 * route (the review request) links no provider code.
 */

/**
 * The kinds of review step an effort can be set for (12 November): the four agent stages, and the
 * readers' assessment, lane review and briefing.
 */
export const StepKind = z.enum([
  "frame",
  "map",
  "find",
  "verify",
  "assess",
  "lane-review",
  "brief",
]);
export type StepKind = z.infer<typeof StepKind>;

/**
 * The effort each kind of step runs at when it is not the route's (`review.stepEffort`). It is part
 * of the frozen route, so of the run key; a stage's key has only the effort its step runs at.
 */
export const StepEffort = z.partialRecord(
  StepKind,
  z.enum(["low", "medium", "high"]),
);
export type StepEffort = z.infer<typeof StepEffort>;

/**
 * A model route frozen into each run's configuration (0008): the provider, the model, its effort,
 * its window and output cap from the provider's own documentation, where the credential comes from
 * (named, never its value: 10.5, 10.16) and the price table cost is computed from (10.32).
 */
export const AnthropicRouteConfig = z.strictObject({
  provider: z.literal("anthropic"),
  model: z.string().min(1),
  effort: z.enum(["low", "medium", "high"]),
  window: z.int().min(1),
  maxOutputTokens: z.int().min(1),
  credentialVariable: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  /** USD per million tokens; cache writes and reads as multiples of the input price. */
  price: z.strictObject({
    input: z.number().min(0),
    output: z.number().min(0),
    cacheWrite5m: z.number().min(0),
    cacheWrite1h: z.number().min(0),
    cacheRead: z.number().min(0),
  }),
  /** Absent unless some kind of step runs at another effort, so a default run keeps its key. */
  stepEffort: StepEffort.optional(),
});
export type AnthropicRouteConfig = z.infer<typeof AnthropicRouteConfig>;

/**
 * The OpenAI route on the owner's ChatGPT plan (10.85). Its credential is the Neuve sign-in
 * (`neuve auth login openai`), never an environment variable; the receipt names that source. The
 * plan has no per-token price, so `price` is null and cost is recorded as unknown, beside the
 * tokens. The output cap cannot be sent on this route; usage is checked after the call (0008).
 */
export const OpenAiRouteConfig = z.strictObject({
  provider: z.literal("openai"),
  model: z.string().min(1),
  effort: z.enum(["low", "medium", "high"]),
  window: z.int().min(1),
  maxOutputTokens: z.int().min(1),
  credentialSource: z.literal("neuve-sign-in"),
  price: z.null(),
  /**
   * Telemetry only: ask for the model's reasoning summary on every call, so each stored turn
   * carries it beside the encrypted reasoning. A summary is never replayed to the model
   * (`toInput`), so the model's input is the same with or without it. Absent on every route a
   * measured run uses; a run that sets it keys its stages apart (`computationRoute`).
   */
  reasoningSummary: z.literal("detailed").optional(),
  /** As on the Anthropic route. */
  stepEffort: StepEffort.optional(),
});
export type OpenAiRouteConfig = z.infer<typeof OpenAiRouteConfig>;

/** Every route the harness can run. */
export const AnyRouteConfig = z.discriminatedUnion("provider", [
  AnthropicRouteConfig,
  OpenAiRouteConfig,
]);
export type AnyRouteConfig = z.infer<typeof AnyRouteConfig>;

/** The route a run's configuration accepts: either provider (10.85). */
export const RouteConfig = AnyRouteConfig;
export type RouteConfig = z.infer<typeof RouteConfig>;

/**
 * Opus 5.5 through the Anthropic API (2.12): 1,000,000 input tokens and 128,000 output tokens; 4 and
 * 20 USD per million input and output tokens; cache writes at 1.25 times input for 5 minutes and 2
 * times for 1 hour, cache reads at 0.05 times (proposal §3.8). Effect is `medium` everywhere (10.19).
 */
export const OPUS_ROUTE: AnthropicRouteConfig = {
  provider: "anthropic",
  model: "claude-opus-5-5",
  effort: "medium",
  window: 1_000_000,
  maxOutputTokens: 128_000,
  credentialVariable: "ANTHROPIC_API_KEY",
  price: {
    input: 4,
    output: 20,
    cacheWrite5m: 1.25,
    cacheWrite1h: 2,
    cacheRead: 0.05,
  },
};

/**
 * GPT-6.1 Sol on the ChatGPT plan (10.85), at `medium` effort (10.19). OpenAI's model page
 * (developers.openai.com/api/docs/models/gpt-6.1-sol): a 1,050,000-token window (922,000 input at
 * most, above the 525,000-token ceiling half the window gives) and 128,000 output tokens.
 */
export const SOL_ROUTE: OpenAiRouteConfig = {
  provider: "openai",
  model: "gpt-6.1-sol",
  effort: "medium",
  window: 1_050_000,
  maxOutputTokens: 128_000,
  credentialSource: "neuve-sign-in",
  price: null,
};

/** The routes by the name `neuve review --route` and the worker setting use. */
export const ROUTES = { anthropic: OPUS_ROUTE, openai: SOL_ROUTE } as const;
export type RouteName = keyof typeof ROUTES;
export const RouteName = z.enum(["anthropic", "openai"]);

/** An effort a route can be frozen with. */
export type RouteEffort = AnyRouteConfig["effort"];

/**
 * A route by its name, the Anthropic route when none is given, at the effort given, else the
 * route's own. The effort is part of the frozen route, so the run key and every agent stage's key
 * (`computationRoute`) differ between efforts and runs at two efforts never share a stage. Reasoning
 * summaries apply to the OpenAI route only, whose reasoning is otherwise stored encrypted. The
 * per-kind efforts are set only when they name at least one kind, so a route without them is
 * frozen exactly as before.
 */
export const routeByName = (
  name: RouteName | undefined,
  effort?: RouteEffort | undefined,
  reasoningSummaries?: boolean | undefined,
  stepEffort?: StepEffort | undefined,
): AnyRouteConfig => {
  const route = ROUTES[name ?? "anthropic"];
  const atEffort = effort === undefined ? route : { ...route, effort };
  const withSteps =
    stepEffort === undefined || Object.keys(stepEffort).length === 0
      ? atEffort
      : { ...atEffort, stepEffort };
  return reasoningSummaries === true && withSteps.provider === "openai"
    ? { ...withSteps, reasoningSummary: "detailed" }
    : withSteps;
};

/**
 * The effort a step runs at: its own when it names one, else its kind's in the route's per-kind
 * efforts, else the route's.
 */
export const stepEffortOf = (
  route: AnyRouteConfig,
  kind: StepKind,
  own?: RouteEffort | undefined,
): RouteEffort => own ?? route.stepEffort?.[kind] ?? route.effort;

/**
 * The route with `effort` in place of its own and nothing else changed: what a step at that effort
 * keys on and sends. The route itself when the effort is its own.
 */
export const routeAtEffort = <R extends AnyRouteConfig>(
  route: R,
  effort: RouteEffort,
): R => (effort === route.effort ? route : { ...route, effort });

/** Where the route's credential comes from, as receipts and status lines name it (never its value). */
export const credentialName = (route: AnyRouteConfig) =>
  route.provider === "anthropic"
    ? route.credentialVariable
    : "the Neuve sign-in (neuve auth login openai)";

/** The route as the computation store keys it (proposal §3: provider, model, reasoning setting). */
export const computationRoute = (route: AnyRouteConfig) => ({
  provider: route.provider,
  model: route.model,
  reasoning: route.effort,
  // Only a run that asks for summaries keys apart, so a measured run's keys stay as they were.
  ...(route.provider === "openai" && route.reasoningSummary !== undefined
    ? { reasoningSummary: route.reasoningSummary }
    : {}),
});

/** Token usage of one model call, from the provider's raw usage (the Effect provider drops thinking). */
export interface CallUsage {
  readonly input: number;
  readonly cacheWrite5m: number;
  readonly cacheWrite1h: number;
  readonly cacheRead: number;
  readonly output: number;
  /** Part of `output`, when the provider reports it. */
  readonly thinking?: number | undefined;
}

export const zeroUsage: CallUsage = {
  input: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
  output: 0,
};

export const addUsage = (a: CallUsage, b: CallUsage): CallUsage => ({
  input: a.input + b.input,
  cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
  cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
  cacheRead: a.cacheRead + b.cacheRead,
  output: a.output + b.output,
  thinking:
    a.thinking === undefined && b.thinking === undefined
      ? undefined
      : (a.thinking ?? 0) + (b.thinking ?? 0),
});

/**
 * Cost in USD: usage times the route's frozen price table (10.32). A route without a per-token price
 * (the ChatGPT plan) has no cost in USD: it is `null`, recorded as unknown, never as 0.
 */
export function costOf(route: AnthropicRouteConfig, usage: CallUsage): number;
export function costOf(route: AnyRouteConfig, usage: CallUsage): number | null;
export function costOf(route: AnyRouteConfig, usage: CallUsage): number | null {
  const perToken = (usd: number) => usd / 1_000_000;
  const { price } = route;
  if (price === null) return null;
  return (
    usage.input * perToken(price.input) +
    usage.cacheWrite5m * perToken(price.input * price.cacheWrite5m) +
    usage.cacheWrite1h * perToken(price.input * price.cacheWrite1h) +
    usage.cacheRead * perToken(price.input * price.cacheRead) +
    usage.output * perToken(price.output)
  );
}

/** The usage the computation store keeps per attempt (cache writes of both TTLs together). */
export const storedUsage = (usage: CallUsage) => ({
  input: usage.input,
  cacheCreation: usage.cacheWrite5m + usage.cacheWrite1h,
  cacheRead: usage.cacheRead,
  output: usage.output,
});
