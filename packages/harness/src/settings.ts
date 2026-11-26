import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ConfigProvider,
  Duration,
  Effect,
  Layer,
  Metric,
  Option,
  Tracer,
} from "effect";
import { FetchHttpClient } from "effect/http";
import {
  OtlpExporter,
  OtlpMetrics,
  OtlpSerialization,
  OtlpTracer,
} from "effect/observability";
import { z } from "zod";
import { JOB_POLICIES } from "@neuve/records-core";
import { RUN_LIFETIME } from "./budget.ts";
import { runLogTracer, type RunLog } from "./run-log.ts";
import { StackSettings } from "./stack/settings.ts";
import { StepEffort } from "./route.ts";
import { isCompiled } from "./compiled.ts";

/**
 * The user's own Neuve settings, outside any repository (10.32, proposal §2.1 and §3.8). Only this
 * file can turn on the OTLP export, so a repository's `.env` or environment, which Bun loads in
 * development, can never send a worker's spans anywhere. The path is built from the home directory
 * only: no environment variable such as `XDG_CONFIG_HOME` chooses it.
 */
export const settingsPath = (home = homedir()) =>
  process.platform === "darwin"
    ? join(home, "Library", "Application Support", "Neuve", "settings.json")
    : join(home, ".config", "neuve", "settings.json");

/** The routes `review.route` can name: the two direct routes and the built-in Claude account. */
export const ReviewRouteName = z.enum(["anthropic", "openai", "claude"]);
export type ReviewRouteName = z.infer<typeof ReviewRouteName>;

export const Settings = z.strictObject({
  version: z.literal(1),
  telemetry: z
    .strictObject({
      enabled: z.boolean().optional(),
      otlp: z
        .strictObject({
          /** The collector's base URL; traces go to `<baseUrl>/v1/traces`, metrics to `<baseUrl>/v1/metrics`. */
          baseUrl: z.url(),
          headers: z.record(z.string(), z.string()).optional(),
        })
        .optional(),
    })
    .optional(),
  /** Stack sources (11.15): off switch, total cap, git hosts, private default registry. */
  stack: StackSettings.optional(),
  /**
   * `route`: the route a review runs on when `neuve review` names none, and the one a worker checks
   * it can serve (10.85, 10.17); the Anthropic route when absent. `claude` is the Claude
   * subscription through Claude Code's own sign-in (12.59): the built-in `claude` account, exactly
   * what `neuve review --route claude` freezes. Accounts added with `neuve auth add` are named only
   * with `--route <name>`. `effort`: the effort every review
   * this user requests freezes into its route, whichever route it names; the route's own (`medium`,
   * 10.19) when absent. Research runs set `high` in a settings file of their own (10.126).
   * `deadline`: the lifetime in minutes every review this user requests freezes into its budgets,
   * from the 10-minute default up to the longest a review job allows; 10 when absent. Replay runs
   * over large trees set a longer one, so Investigate leaves Assemble and Dispose time to run.
   * `reasoningSummaries`: telemetry for reading runs only, off when absent. On the OpenAI route,
   * every agent turn also stores the model's reasoning summary; the model never sees it again, but
   * the run's stages key apart from a measured run's.
   * `responsibilitySections` (10.109): the units stage cuts each file's changed lines at the file's
   * own structure (an import block, a declaration, a function, a test, a heading section), read from
   * the structures Precompute stored. Legacy false/off settings remain parseable but cannot
   * disable sections or comprehensive review in a new request.
   * `stepEffort`: the effort a kind of step runs at instead of `effort` (`frame`, `map`, `find`,
   * `verify`, `assess`, `lane-review`, `brief`); a kind it does not name runs at `effort`. The section
   * readings' steps differ. With their effort by risk off, Assess and Lane review run at their entry,
   * else at the lower of `effort` and medium (`READING_EFFORT` in `readings/effort.ts`), and a claim
   * check at the `verify` entry, else `effort`. With it on (`sectionReadingsEffort`), all three run
   * at fixed levels whatever this names. Only the steps that run at another effort key apart.
   */
  review: z
    .strictObject({
      route: ReviewRouteName.optional(),
      effort: z.enum(["low", "medium", "high"]).optional(),
      stepEffort: StepEffort.optional(),
      reasoningSummaries: z.boolean().optional(),
      responsibilitySections: z.boolean().optional(),
      /** Legacy setting accepted for compatibility; neither value disables new comprehensive reviews. */
      sectionReadings: z.enum(["probe", "off"]).optional(),
      /**
       * `"by-risk"`, with the readings on: code decides from the plan which sections'
       * readings run at high effort, packs the reading groups by that class, and sets each reading
       * step's effort from it (`readings/effort.ts`). Absent: Assess and Lane review run at the
       * effort a `review.stepEffort` entry names for them, else at the lower of the route's effort
       * and medium; a claim check at its stage's effort.
       */
      sectionReadingsEffort: z.literal("by-risk").optional(),
      /** Legacy setting accepted on read; new comprehensive review always includes scope/tests. */
      sectionReadingsScopeAndTests: z.boolean().optional(),
      /**
       * Ignored (round 13): the call-line lift is the readings' behaviour, not a switch, so it
       * applies whenever the readings are on (`readings/evidence.ts`). Still parsed so a settings
       * file that names it is not refused; cleanup deletes it.
       */
      sectionReadingsCallsLiftGap: z.boolean().optional(),
      /**
       * `true`, beside the section readings: a section a code rule decides (`ruleDecisionsOf` in
       * `section-rules.ts`, decision 14.17) gets no model reading; the plan lists it unread with
       * cause `rule-decided` and the rule's decision. Read only when the readings are on, whatever
       * their mode. Absent or false: the plan, the readings and every key are exactly as before.
       * NOT FOR USE YET: until the readings' settled entry for a rule-decided section exists, such a
       * section is treated downstream as unreadable (no text to read), not as the rule decided it.
       */
      sectionReadingsRuleSkips: z.boolean().optional(),
      deadline: z
        .int()
        .min(Duration.toMinutes(RUN_LIFETIME))
        .max(Duration.toMinutes(JOB_POLICIES["review.run"].deadline))
        .optional(),
    })
    .optional(),
  /**
   * Investigate's search tools beyond BM25 (10.89) and the retriever its leads come from, with
   * what each needs on this machine (`search-config.ts`). Absent: BM25 only, as before. The paths
   * are never part of a computation key; the identities they resolve to are.
   */
  search: z
    .strictObject({
      /** `graph_search`: the Neuve Graph engine; the installed one beside the CLI when unnamed. */
      graph: z
        .strictObject({ executable: z.string().min(1).optional() })
        .optional(),
      /**
       * `semantic_search` (E0): the Python and model snapshot `@neuve/semantic-client` runs, and the
       * Records store that holds the chunk vectors under the benchmark's encoding contract.
       */
      e0: z
        .strictObject({
          python: z.string().min(1),
          snapshot: z.string().min(1),
          vectorStore: z.string().min(1),
          worker: z.string().min(1).optional(),
        })
        .optional(),
      /**
       * Hybrid leads (10.117-10.119): fused Graph, BM25 and E0 leads, reranked, computed at commit
       * time on this machine. Self-contained, so setting it up never gives reviews' agents E0 or
       * Graph search (those stay `e0` and `graph`): the Python that runs both models, E0's snapshot,
       * the reranker's, and Graph's engine (the installed one beside the CLI when unnamed).
       * `prepare` turns the commit-time model work on; it is off unless set, and on only in
       * measured slots.
       */
      hybrid: z
        .strictObject({
          prepare: z.boolean().optional(),
          /** Where the chunk vectors and reranker scores are computed. */
          device: z.enum(["cpu", "mps"]),
          python: z.string().min(1),
          e0: z.strictObject({
            snapshot: z.string().min(1),
            worker: z.string().min(1).optional(),
          }),
          reranker: z.strictObject({
            snapshot: z.string().min(1),
            worker: z.string().min(1).optional(),
          }),
          graph: z
            .strictObject({ executable: z.string().min(1).optional() })
            .optional(),
          /**
           * At most this many model processes resident at once (1 unless set): with 1, a job
           * encodes first, closes the encoder, then reranks one hunk at a time.
           */
          models: z.int().min(1).max(4).optional(),
          /** A job pauses before a hunk when free disk or swap passes these (13 and 15 GiB). */
          limits: z
            .strictObject({
              minFreeDiskGiB: z.number().min(1).optional(),
              maxSwapUsedGiB: z.number().min(1).optional(),
            })
            .optional(),
        })
        .optional(),
      /** Where the preloaded leads come from: BM25 (default), a live retriever, or a frozen file. */
      leads: z
        .union([
          z.enum(["bm25", "e0", "graph", "hybrid"]),
          z.strictObject({
            frozen: z.strictObject({
              candidate: z.string().min(1).max(64),
              file: z.string().min(1),
            }),
          }),
        ])
        .optional(),
    })
    .optional(),
});
export type Settings = z.infer<typeof Settings>;

/** The review route the user's settings name, if any. */
export const reviewRoute = (settings: Option.Option<Settings>) =>
  Option.getOrUndefined(settings)?.review?.route;

/** The review effort the user's settings name, if any. */
export const reviewEffort = (settings: Option.Option<Settings>) =>
  Option.getOrUndefined(settings)?.review?.effort;

/** The per-kind step efforts the user's settings name, if any. */
export const reviewStepEffort = (settings: Option.Option<Settings>) =>
  Option.getOrUndefined(settings)?.review?.stepEffort;

/** Whether the user's settings ask for reasoning summaries (telemetry for reading runs). */
export const reviewReasoningSummaries = (settings: Option.Option<Settings>) =>
  Option.getOrUndefined(settings)?.review?.reasoningSummaries;

/** Legacy off switches are accepted on read but cannot disable new reviews' owned sections. */
export const reviewResponsibilitySections = (
  _settings: Option.Option<Settings>,
): boolean => true;

/** The review deadline the user's settings name, if any. */
export const reviewDeadline = (settings: Option.Option<Settings>) => {
  const minutes = Option.getOrUndefined(settings)?.review?.deadline;
  return minutes === undefined ? undefined : Duration.minutes(minutes);
};

/** The settings, or none when the file is absent. A file that does not parse is refused loudly. */
export const readSettings = (
  path = settingsPath(),
): Option.Option<Settings> => {
  if (!existsSync(path)) return Option.none();
  return Option.some(Settings.parse(JSON.parse(readFileSync(path, "utf8"))));
};

export type TelemetryMode = "off" | "logs" | "otlp";

/** Resolve the owner's switch before opening a log or constructing an exporter (12.55). */
export const telemetryMode = (
  settings: Option.Option<Settings>,
  compiled = isCompiled(),
): TelemetryMode => {
  const telemetry = Option.getOrUndefined(settings)?.telemetry;
  if (telemetry?.enabled === false) return "off";
  if (telemetry?.otlp !== undefined) return "otlp";
  return telemetry?.enabled === true || !compiled ? "logs" : "off";
};

/** Where the run's spans go, for the run log's first record. */
export const otlpTarget = (
  settings: Option.Option<Settings>,
  mode = telemetryMode(settings),
) =>
  mode === "otlp"
    ? Option.flatMap(settings, (s) =>
        Option.fromNullishOr(s.telemetry?.otlp?.baseUrl),
      )
    : Option.none<string>();

/**
 * The run's telemetry (12.55): when on, its tracer writes to the run log. In OTLP mode,
 * spans also go to OTLP (`<baseUrl>/v1/traces`) and the attempt's
 * metrics, from `registry`, to `<baseUrl>/v1/metrics`. The run log receives the metrics at the
 * attempt's end while telemetry is on (telemetry.ts). The OTLP exporters are built from those explicit options
 * with an empty configuration provider, so no `OTEL_*` variable is read, and they have their own
 * HTTP client, never the provider's.
 */
export const tracerLayer = (
  log: RunLog,
  settings: Option.Option<Settings>,
  registry?: Metric.MetricRegistry,
  mode = telemetryMode(settings),
) => {
  if (mode === "off") return Layer.succeed(Tracer.Tracer, Tracer.nativeTracer);
  const otlp = Option.getOrUndefined(
    Option.flatMap(settings, (s) => Option.fromNullishOr(s.telemetry?.otlp)),
  );
  if (mode === "logs" || otlp === undefined)
    return Layer.succeed(Tracer.Tracer, runLogTracer(log));
  const baseUrl = otlp.baseUrl.replace(/\/$/, "");
  const resource = { serviceName: "neuve-harness", attributes: {} };
  const headers = otlp.headers === undefined ? {} : { headers: otlp.headers };
  const emptyConfig = Layer.succeed(
    ConfigProvider.ConfigProvider,
    ConfigProvider.fromUnknown({}),
  );
  const tracer = Layer.effect(
    Tracer.Tracer,
    Effect.map(
      OtlpTracer.make({ url: `${baseUrl}/v1/traces`, resource, ...headers }),
      (inner) => runLogTracer(log, inner),
    ),
  ).pipe(Layer.provide(OtlpExporter.layerFlusher));
  const metrics =
    registry === undefined
      ? Layer.empty
      : OtlpMetrics.layer({
          url: `${baseUrl}/v1/metrics`,
          resource,
          ...headers,
        }).pipe(Layer.provide(Layer.succeed(Metric.MetricRegistry, registry)));
  return Layer.mergeAll(tracer, metrics).pipe(
    Layer.provide(emptyConfig),
    Layer.provide(OtlpSerialization.layerJson),
    Layer.provide(FetchHttpClient.layer),
  );
};
