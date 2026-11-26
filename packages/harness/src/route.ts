import { Data } from "effect";
import { z } from "zod";
import {
  AccountKind,
  AccountName,
  RuntimeCapability,
  type RuntimeCapabilities,
} from "@neuve/runtime";

/**
 * The route's configuration and accounting: what a run freezes, how its usage is read and priced.
 * The provider clients and the sign-in are in `route-provider.ts`, so a module that only freezes a
 * route (the review request) links no provider code.
 */

/** The account identity frozen with a route, without its credential reference. */
export const RouteAccount = z.strictObject({
  name: AccountName,
  kind: AccountKind,
});
export type RouteAccount = z.infer<typeof RouteAccount>;

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
 * its window and output cap from the provider's own documentation, the account and legacy credential
 * reference (never its value: 10.5, 10.16) and the price table cost is computed from (10.32).
 */
export const AnthropicRouteConfig = z.strictObject({
  provider: z.literal("anthropic"),
  model: z.string().min(1),
  effort: z.enum(["low", "medium", "high"]),
  window: z.int().min(1),
  maxOutputTokens: z.int().min(1),
  credentialVariable: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  /** Optional only for routes frozen before accounts were named. */
  account: RouteAccount.extend({
    kind: z.literal("anthropic-api-key"),
  }).optional(),
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
  /** Optional only for routes frozen before accounts were named. */
  account: RouteAccount.extend({
    kind: z.literal("chatgpt-subscription"),
  }).optional(),
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

/** Routes executed by pi through a direct provider transport. */
export const DirectRouteConfig = z.discriminatedUnion("provider", [
  AnthropicRouteConfig,
  OpenAiRouteConfig,
]);
export type DirectRouteConfig = z.infer<typeof DirectRouteConfig>;

/** A Claude Code route uses only its named subscription account's sign-in. */
export const ClaudeRouteConfig = z.strictObject({
  provider: z.literal("claude"),
  account: RouteAccount.extend({ kind: z.literal("claude-subscription") }),
  model: z.string().min(1),
  effort: z.enum(["low", "medium", "high"]),
  window: z.int().min(1),
  maxOutputTokens: z.int().min(1),
  price: z.null(),
  /** As on the Anthropic route. */
  stepEffort: StepEffort.optional(),
});
export type ClaudeRouteConfig = z.infer<typeof ClaudeRouteConfig>;

/** Direct routes and routes executed by an account's loop-owning runtime. */
export const AnyRouteConfig = z.discriminatedUnion("provider", [
  AnthropicRouteConfig,
  OpenAiRouteConfig,
  ClaudeRouteConfig,
]);
export type AnyRouteConfig = z.infer<typeof AnyRouteConfig>;

/** The route a run's configuration accepts. */
export const RouteConfig = AnyRouteConfig;
export type RouteConfig = z.infer<typeof RouteConfig>;

export class RouteRuntimeMismatch extends Data.TaggedError(
  "RouteRuntimeMismatch",
)<{
  readonly account: RouteAccount["name"];
  readonly provider: AnyRouteConfig["provider"];
  readonly retryable: false;
  /** What a review stage needs that the account's runtime, which runs its own loop, lacks. */
  readonly missing?: ReadonlyArray<RuntimeCapability>;
}> {
  constructor(
    account: RouteAccount["name"],
    provider: AnyRouteConfig["provider"],
    missing: ReadonlyArray<RuntimeCapability> = [],
  ) {
    super({
      account,
      provider,
      retryable: false,
      ...(missing.length > 0 ? { missing } : {}),
    });
  }
  override get message() {
    return this.missing === undefined
      ? `Account ${this.account}'s runtime disagrees with route provider ${this.provider}.`
      : `Account ${this.account}'s runtime runs its own loop but can't run review stages: it lacks ${this.missing.map((capability) => STAGE_NEEDS[capability] ?? capability).join(", ")}.`;
  }
}

/**
 * What a review stage needs of a runtime that runs its own loop: a submit tool ends the round, a
 * held stage resumes inside its turn, and each request's usage feeds the context ceiling.
 */
const STAGE_NEEDS: Partial<Record<RuntimeCapability, string>> = {
  toolEndsTurn: "ending a turn from a tool",
  resumeInTurn: "resuming inside a turn",
  perMessageUsage: "usage for each message",
};
export const stageCapabilitiesMissing = (capabilities: RuntimeCapabilities) =>
  capabilities.ownsLoop
    ? RuntimeCapability.options.filter(
        (capability) =>
          STAGE_NEEDS[capability] !== undefined && !capabilities[capability],
      )
    : [];

/** The same agreement applies when a request freezes and when its stage opens. */
export const routeRuntimeError = (
  route: AnyRouteConfig,
  ownsLoop: boolean,
  missing: ReadonlyArray<RuntimeCapability> = [],
) => {
  const account = routeAccount(route);
  return account !== undefined &&
    (ownsLoop !== (route.provider === "claude") || missing.length > 0)
    ? new RouteRuntimeMismatch(
        account.name,
        route.provider,
        ownsLoop === (route.provider === "claude") ? missing : [],
      )
    : undefined;
};

/**
 * Opus 5.5 through the Anthropic API, at medium effort.
 * https://platform.claude.com/docs/en/models/opus-5-5/overview
 */
export const OPUS_ROUTE: AnthropicRouteConfig = {
  provider: "anthropic",
  model: "claude-opus-5-5",
  effort: "medium",
  window: 1_000_000,
  maxOutputTokens: 128_000,
  credentialVariable: "ANTHROPIC_API_KEY",
  account: { name: AccountName.parse("anthropic"), kind: "anthropic-api-key" },
  price: {
    input: 4,
    output: 20,
    cacheWrite5m: 1.25,
    cacheWrite1h: 2,
    cacheRead: 0.05,
  },
};

/**
 * GPT-6.1 Sol on the ChatGPT plan, at medium effort.
 * Decision 2.11 sets the usable window. pi-ai's OpenAI model catalogue gives the output cap.
 */
export const SOL_ROUTE: OpenAiRouteConfig = {
  provider: "openai",
  model: "gpt-6.1-sol",
  effort: "medium",
  window: 475_000,
  maxOutputTokens: 128_000,
  credentialSource: "neuve-sign-in",
  account: { name: AccountName.parse("chatgpt"), kind: "chatgpt-subscription" },
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
): DirectRouteConfig => {
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

/** The frozen account, or the default implied by a legacy route's credential reference. */
export const routeAccount = (
  route: AnyRouteConfig,
): RouteAccount | undefined => {
  if (route.account !== undefined) return route.account;
  if (route.provider === "anthropic")
    return route.credentialVariable === "ANTHROPIC_API_KEY"
      ? OPUS_ROUTE.account
      : undefined;
  return route.provider === "openai" &&
    route.credentialSource === "neuve-sign-in"
    ? SOL_ROUTE.account
    : undefined;
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
    : route.provider === "claude"
      ? `the Claude Code sign-in of account ${route.account.name}`
      : "the Neuve sign-in (neuve auth login openai)";

export class SubscriptionRouteRequiresRuntime extends Data.TaggedError(
  "SubscriptionRouteRequiresRuntime",
)<{ readonly account: RouteAccount["name"]; readonly retryable: false }> {
  constructor(account: RouteAccount["name"]) {
    super({ account, retryable: false });
  }
  override get message() {
    return `Claude subscription account ${this.account} requires its runtime.`;
  }
}

/** Refuse subscription routes before any direct transport or credential operation. */
export const requireDirectRoute = (
  route: AnyRouteConfig,
): DirectRouteConfig => {
  if (route.provider === "claude")
    throw new SubscriptionRouteRequiresRuntime(route.account.name);
  return route;
};

/** The direct API's environment reference; OpenAI uses its sign-in instead. */
export function routeCredentialVariable(route: AnthropicRouteConfig): string;
export function routeCredentialVariable(
  route: AnyRouteConfig,
): string | undefined;
export function routeCredentialVariable(
  route: AnyRouteConfig,
): string | undefined {
  const direct = requireDirectRoute(route);
  return direct.provider === "anthropic"
    ? direct.credentialVariable
    : undefined;
}

/**
 * The route as the computation store keys it (proposal §3: provider, model, reasoning setting).
 * Stage keys omit the account and credential so the same computation is reused across accounts.
 */
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
