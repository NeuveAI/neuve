import { z } from "zod";
import { Computations } from "@neuve/records-core";
import { Sha256, type Range } from "@neuve/records-schema";
import {
  CALLS_IN_FLIGHT,
  RUN_LIFETIME,
  Stage,
  type AgentStage,
  TOOL_RESULT_TOKENS,
  contextCeiling,
  runCutoff,
} from "./budget.ts";
import { Duration, Effect } from "effect";
import type { RuntimeRegistryShape } from "@neuve/runtime";
import { ManifestSettings, defaultManifestSettings } from "./manifest.ts";
import {
  OPUS_ROUTE,
  RouteConfig,
  computationRoute,
  currentReviewRoute,
  routeAccount,
  routeRuntimeError,
  stageCapabilitiesMissing,
  type AnyRouteConfig,
} from "./route.ts";
import type { RetrieverConfig } from "./retriever.ts";
import { GRAPH_DEADLINE_MS, SearchConfig } from "./search-config.ts";
import { BLOB_STRUCTURE_RECIPE, SECTIONS_RECIPE } from "./sections.ts";
import { DEFAULT_READING_BOUNDS } from "./reading-groups.ts";
import { READING_RECIPE_SCOPE_AND_TESTS } from "./readings/plan.ts";
import { StackToolsConfig } from "./stack/settings.ts";

/** A new review shape gets a distinct key; older frozen requests require a compatible build. */
export const PIPELINE_VERSION = 13;
export const REVIEW_OWNERSHIP = "batch-assignment-v1" as const;

/**
 * Development settings for slice H1's stub stages, recorded in the configuration and printed on its
 * receipt. They exist so the runtime's limits can be shown on real runs: holding a stage to reach
 * the 10-minute cut-off, and a lower turn limit to reach the final generation. They go away with the
 * stubs. Every setting that can change an answer (the turn limit, and anything stubbed later) is in
 * the run key and every agent step's key (`keyedStub`), so a real run never reuses a stub's answer;
 * the hold changes only when a stage starts or commits, never what it answers, so it is in no key and
 * a held run and its release are one review.
 */
export const StubSettings = z.strictObject({
  hold: z
    .strictObject({
      stage: Stage,
      seconds: z.int().min(1).max(3_600),
      /** `start` (default): before the stage works; `before-commit`: after it, before its output is stored. */
      at: z.enum(["start", "before-commit"]).optional(),
    })
    .optional(),
  turnLimit: z.int().min(1).max(35).optional(),
  measure: z.boolean().optional(),
});
export type StubSettings = z.infer<typeof StubSettings>;

/**
 * The stub settings as a key holds them: all but the hold, which is timing only; null when nothing
 * else is set, so a run held and one not held share their run key and every step's key.
 */
export const keyedStub = (stub: StubSettings | undefined) => {
  if (stub === undefined) return null;
  const { hold: _hold, ...keyed } = stub;
  return Object.keys(keyed).length === 0
    ? null
    : (JSON.parse(JSON.stringify(keyed)) as Record<string, number | boolean>);
};

/**
 * Responsibility section recipes frozen by a review request. New reviews always include these;
 * historical configurations that omitted them remain readable without filling or relabelling.
 */
export const SectionsConfig = z.strictObject({
  units: z.literal(true),
  /** How sections are cut from a structure (`SECTIONS_RECIPE`). */
  sections: z.string().min(1),
  /** The stored blob structure's shape (`BLOB_STRUCTURE_RECIPE`). */
  structure: z.string().min(1),
});
export type SectionsConfig = z.infer<typeof SectionsConfig>;

/** The block a request freezes when the setting is on; absent otherwise. */
export const sectionsConfig = (
  on: boolean | undefined,
): SectionsConfig | undefined =>
  on === true
    ? {
        units: true,
        sections: SECTIONS_RECIPE,
        structure: BLOB_STRUCTURE_RECIPE,
      }
    : undefined;

/** The configuration frozen with a review request (`review.requested@1` payload `pipeline.config`). */
export const PipelineConfig = z.strictObject({
  /** Absent only on historical requests; never upgrades a frozen legacy task. */
  ownership: z.literal(REVIEW_OWNERSHIP).optional(),
  externalContext: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  localPlan: Sha256.optional(),
  route: RouteConfig,
  budgets: z.strictObject({
    turnLimits: z.strictObject({
      frame: z.int().min(1).optional(),
      map: z.int().min(1).optional(),
      /** Retained in frozen request JSON; never a current admission knob. */
      find: z.int().min(1).optional(),
      verify: z.int().min(1).optional(),
      // Read-only compatibility for frozen requests. These keys never schedule a stage.
      understand: z.int().min(1).optional(),
      investigate: z.int().min(1).optional(),
      assemble: z.int().min(1).optional(),
      dispose: z.int().min(1).optional(),
      merge: z.int().min(1).optional(),
    }),
    callsInFlight: z.int().min(1),
    contextCeiling: z.int().min(1),
    toolResultTokens: z.int().min(1),
    lifetimeMs: z.int().min(1),
    cutoffMs: z.int().min(1),
  }),
  stub: StubSettings.optional(),
  /**
   * Precompute's settings (slice H5): the retriever (BM25 until M4's winner, XC18), the allowance
   * share and floor (9.17, 9.23) and the route's window. Optional so requests frozen before H5 still
   * parse; those runs use the defaults.
   */
  precompute: ManifestSettings.optional(),
  /**
   * Investigate's search tools beyond BM25 (10.89): Graph's semantic query, E0 and, when the user's
   * settings ask, their fusion, each with the identities its answers depend on. Absent: BM25 only,
   * and the run keeps the key it had before.
   */
  search: SearchConfig.optional(),
  /**
   * The stack tools (11.15, ST2), present only when the user's settings turn them on (`stack.tools`).
   * Absent: no stack tools, no frozen stack state, and the run keeps the key it had before ST2.
   */
  stack: StackToolsConfig.optional(),
  /**
   * Responsibility sections, required on new runs. Optional only to read historical configurations
   * without changing their source, units or computation identity.
   */
  sections: SectionsConfig.optional(),
  /**
   * Required on new comprehensive reviews. Optional only for byte-preserving historical reads;
   * absence never authorizes a current-version run without its sole general reviewer.
   */
  readings: z
    .strictObject({
      mode: z.literal("probe"),
      bounds: z.strictObject({
        maxFiles: z.int().positive(),
        maxCharacters: z.int().positive(),
        maxItems: z.int().positive(),
      }),
      recipe: z.string().min(1),
      /** Effort by risk (`review.sectionReadingsEffort`): present only when the settings set it. */
      effort: z.literal("by-risk").optional(),
      /**
       * Scope and tests are always on for new comprehensive reviews. Optional only so older
       * frozen JSON stays readable without changing its computation identity.
       */
      scopeAndTests: z.literal(true).optional(),
      /**
       * Ignored (round 13): the lift is no switch, and no request freezes this any more
       * (`readingsConfig`). Still parsed so a configuration frozen before is not refused; cleanup
       * deletes it.
       */
      callsLiftGap: z.literal(true).optional(),
      /**
       * Rule skips (`review.sectionReadingsRuleSkips`): present only when the settings set it. A
       * section a code rule decides is planned unread (`rule-decided`) and gets no model reading.
       */
      ruleSkips: z.literal(true).optional(),
    })
    .optional(),
});
export type PipelineConfig = z.infer<typeof PipelineConfig>;

/** Admission guard shared by execution and recomposition; historical JSON still parses unchanged. */
export const currentPipelineProblem = (
  version: number,
  config: unknown,
): string | undefined => {
  if (version !== PIPELINE_VERSION)
    return `This build cannot execute pipeline ${version}; it executes pipeline ${PIPELINE_VERSION}. Use a compatible build for legacy review requests, or request a distinct new review with this build. This refusal does not requeue the old request. Native state keeps its normal retention limit; published packages and durable computations are unchanged.`;
  const parsed = PipelineConfig.safeParse(config);
  if (
    !parsed.success ||
    parsed.data.ownership !== REVIEW_OWNERSHIP ||
    parsed.data.sections === undefined ||
    parsed.data.readings === undefined ||
    parsed.data.readings.scopeAndTests !== true
  )
    return "This review lacks the required batch-owned comprehensive review configuration. It cannot execute or be upgraded in place; request a distinct new review.";
  if (
    parsed.data.budgets.turnLimits.find !== undefined ||
    parsed.data.route.stepEffort?.find !== undefined ||
    parsed.data.stub?.hold?.stage === "find"
  )
    return "This frozen review carries retired finder-only configuration. It cannot execute or be normalized in place; request a distinct review with current configuration.";
  return undefined;
};

/** Refuse a frozen route whose account would run it through a different provider loop. */
export const routeOwnsLoop = (
  route: RouteConfig,
  runtimes: Pick<RuntimeRegistryShape, "capabilities">,
) =>
  Effect.gen(function* () {
    const account = routeAccount(route);
    if (account === undefined) return false;
    const capabilities = yield* runtimes.capabilities(account.name);
    const { ownsLoop } = capabilities;
    const error = routeRuntimeError(
      route,
      ownsLoop,
      stageCapabilitiesMissing(capabilities),
    );
    if (error !== undefined) return yield* error;
    return ownsLoop;
  });

/**
 * The configuration a run of `generation` runs with, from the one its request froze: the test hold
 * applies only to a first run (generation 0). A follow-on's request copies its request's payload
 * whole (`ReviewFollowOn.requestFollowOn`), hold included, so without this every follow-on would be
 * held and cut again up to the cap; it runs unheld instead. The hold is a test seam for a first
 * run's timing, in no key (`keyedStub`), and production never sets one; every other stub setting
 * stays.
 */
export const runConfig = (
  config: PipelineConfig,
  generation: number,
): PipelineConfig => {
  if (generation === 0 || config.stub?.hold === undefined) return config;
  const { hold: _hold, ...stub } = config.stub;
  const { stub: _stub, ...rest } = config;
  return Object.keys(stub).length === 0 ? rest : { ...rest, stub };
};
export type ReadingsConfig = NonNullable<PipelineConfig["readings"]>;

// Legacy find-steps.ts remains a caller of this fallback. New configs never freeze it;
// remove the fallback with that builder, not from historical PipelineConfig parsing.
const turnLimits = { frame: 1, map: 1, find: 11, verify: 1 } satisfies Record<
  AgentStage,
  number
>;

const currentStub = (
  stub: StubSettings | undefined,
): StubSettings | undefined => {
  if (stub?.hold?.stage !== "find") return stub;
  const { hold: _hold, ...active } = stub;
  return Object.keys(active).length === 0 ? undefined : active;
};

export const defaultConfig = (
  stub?: StubSettings,
  route: RouteConfig = OPUS_ROUTE,
  search?: {
    readonly tools?: SearchConfig | undefined;
    readonly leads?: RetrieverConfig | undefined;
  },
  stack?: StackToolsConfig,
  /**
   * The run's lifetime (`review.deadline`); the 10-minute default when absent. It is in the budgets,
   * so in the run key: a run with more time can produce what a shorter one could not. Agent stages
   * are keyed without it, and the partition plan with the default (`planSpec`), so runs of two
   * lifetimes share every stage both completed.
   */
  lifetime: Duration.Duration = RUN_LIFETIME,
  /** New reviews always own sections; an absent override uses the required default. */
  sections?: SectionsConfig,
  /** The comprehensive readings; absent uses the required default, never disables review. */
  readings?: ReadingsConfig,
): PipelineConfig => {
  const activeStub = currentStub(stub);
  return {
    ownership: REVIEW_OWNERSHIP,
    route: currentReviewRoute(route),
    budgets: {
      turnLimits: {
        frame: turnLimits.frame,
        map: turnLimits.map,
        verify: turnLimits.verify,
      },
      callsInFlight: CALLS_IN_FLIGHT,
      contextCeiling: contextCeiling(route),
      toolResultTokens: TOOL_RESULT_TOKENS,
      lifetimeMs: Duration.toMillis(lifetime),
      cutoffMs: Duration.toMillis(runCutoff(lifetime)),
    },
    ...(activeStub === undefined || Object.keys(activeStub).length === 0
      ? {}
      : { stub: activeStub }),
    precompute: {
      ...defaultManifestSettings(route.window),
      ...(search?.leads === undefined ? {} : { retriever: search.leads }),
      // Graph's lead round waits as long as a review waits on Graph at a time (0013).
      ...(search?.leads?.id === "graph"
        ? { graphWaitMs: search.tools?.graphDeadlineMs ?? GRAPH_DEADLINE_MS }
        : {}),
    },
    ...(search?.tools === undefined ? {} : { search: search.tools }),
    ...(stack === undefined ? {} : { stack }),
    sections: sections ?? sectionsConfig(true)!,
    readings: {
      ...(readings ?? {
        mode: "probe",
        bounds: { ...DEFAULT_READING_BOUNDS },
        recipe: READING_RECIPE_SCOPE_AND_TESTS,
      }),
      scopeAndTests: true,
    },
  };
};

/** The run's Precompute settings: frozen with the request, or the defaults for an older request. */
export const precomputeSettings = (config: PipelineConfig) =>
  config.precompute ?? defaultManifestSettings(config.route.window);

// Naming the account its credential already implies must preserve completed runs' keys.
const keyedRoute = (route: AnyRouteConfig) => {
  if (route.provider === "claude") return route;
  const { account, ...legacy } = route;
  const implied = routeAccount(legacy);
  return account?.name === implied?.name && account?.kind === implied?.kind
    ? legacy
    : route;
};

/**
 * The run configuration a published manifest stores, with the route keyed as the run key keys it:
 * a route naming only the account its credential implies publishes the bytes an earlier build wrote.
 */
export const publishedConfig = (config: PipelineConfig): unknown =>
  JSON.parse(JSON.stringify({ ...config, route: keyedRoute(config.route) }));

/**
 * The run's computation key (proposal §1): the range's OIDs (never its branch name), the pipeline
 * version, the configuration and the route. It is the `review.run` job's key, with the generation.
 */
export const runSpec = (
  range: Range,
  config: PipelineConfig,
): Computations.ComputationSpec => ({
  op: "review.run",
  opVersion: PIPELINE_VERSION,
  inputs: { baseOid: range.baseOid, headOid: range.headOid },
  config: JSON.parse(
    JSON.stringify({
      ...(config.ownership === undefined
        ? {}
        : { ownership: config.ownership }),
      budgets: config.budgets,
      stub: keyedStub(config.stub),
      route: keyedRoute(config.route),
      ...(config.precompute === undefined
        ? {}
        : { precompute: config.precompute }),
      ...(config.search === undefined ? {} : { search: config.search }),
      ...(config.stack === undefined ? {} : { stack: config.stack }),
      ...(config.sections === undefined ? {} : { sections: config.sections }),
      ...(config.readings === undefined ? {} : { readings: config.readings }),
      ...(config.externalContext === undefined
        ? {}
        : { externalContext: config.externalContext }),
      ...(config.localPlan === undefined
        ? {}
        : { localPlan: config.localPlan }),
    }),
  ) as never,
  route: computationRoute(config.route),
});

export const runKeyFor = (range: Range, config: PipelineConfig) =>
  Computations.computationKey(runSpec(range, config)).key;

/**
 * What a complete run stores under its run key (the `review.run` computation): which job and
 * generation produced it. Only a run that published every stage stores it, so a timed-out run is
 * retried as a new generation that reuses every stored stage (10.42).
 */
export const CompletedRun = z.strictObject({
  runId: z.string().min(1),
  generation: z.int().min(0),
  jobSeq: z.int().min(1),
});
export type CompletedRun = z.infer<typeof CompletedRun>;

/** The turn limit an agent of a stage runs with: the ruled one unless a stub setting lowers it. */
export const turnLimitFor = (config: PipelineConfig, stage: AgentStage) =>
  config.stub?.turnLimit ??
  config.budgets.turnLimits[stage] ??
  turnLimits[stage];
