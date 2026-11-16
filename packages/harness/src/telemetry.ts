import { AsyncLocalStorage } from "node:async_hooks";
import { startLogSpan } from "./log-span.ts";
import {
  registerCompatibilityRefusals,
  refusalRecord,
} from "@neuve/records-schema";
import { compatibilityContext, CompatibilitySource } from "@neuve/records-core";
import { monitorEventLoopDelay } from "node:perf_hooks";
import {
  Clock,
  Context,
  Effect,
  Exit,
  Metric,
  Fiber,
  Option,
  Tracer,
} from "effect";
import type { RunLog } from "./run-log.ts";

/**
 * The harness's telemetry layer (10.97): every timing is an OpenTelemetry span, span event or
 * metric through Effect's tracing and `Metric` module, named after OpenTelemetry's semantic
 * conventions for generative AI (`gen_ai.*`) where they name the measure, and `harness.*`
 * otherwise. Runtime measures use Bun's performance API (`performance.now`,
 * `perf_hooks.monitorEventLoopDelay`). The run log is the local sink: the run-log tracer writes each
 * kept span with its events (run-log.ts), and each attempt ends with a `metric` record per series
 * (`writeMetrics`). OTLP stays an optional copy when the owner names an endpoint (settings.ts).
 * Attributes carry names, counts, offsets and identifiers only, never prompt, source or tool text
 * (10.16).
 */

// Span names

/** The wait for one of the run's call slots (10.27), a child of the model call's span. */
export const SLOT_WAIT_SPAN = "harness.call-slot.wait";
/** One tool call inside a model call (toolkit.ts). */
export const TOOL_CALL_SPAN = "harness.tool-call";

/**
 * Effect's clock as a span timestamp source (Unix nanoseconds), for events and spans ended by hand,
 * so they share the clock Effect stamps span starts and ends with.
 */
export const spanClock = Effect.map(
  Clock.Clock,
  (clock) => () => clock.currentTimeNanosUnsafe(),
);

/** Seconds between two span timestamps. */
export const secondsBetween = (from: bigint, to: bigint) =>
  Number(to - from) / 1e9;

/** Runs `effect` in a span named `name`, with attributes read from its success. */
export const step = <A, E, R>(
  name: string,
  effect: Effect.Effect<A, E, R>,
  attributes?: (value: A) => Record<string, unknown>,
) =>
  effect.pipe(
    Effect.tap((value) =>
      attributes === undefined
        ? Effect.void
        : Effect.annotateCurrentSpan(attributes(value)),
    ),
    Effect.withSpan(name),
  );

/**
 * `effect` under one of `slots`, with the wait for it as a `SLOT_WAIT_SPAN` child of the current
 * span and a slot-wait metric; the permit is held as `Semaphore.withPermits` holds it.
 */
export const withSlot =
  <SlotError = never>(
    slots: {
      readonly withPermits: (
        n: number,
      ) => <A, E, R>(
        self: Effect.Effect<A, E, R>,
      ) => Effect.Effect<A, E | SlotError, R>;
    },
    attributes: Record<string, string>,
  ) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const now = yield* spanClock;
      // Ended by hand, on every exit: when the slot is taken, or when the wait fails or is cut off.
      const wait = yield* Effect.makeSpan(SLOT_WAIT_SPAN);
      for (const [key, value] of Object.entries(attributes))
        wait.attribute(key, value);
      const started = now();
      let waiting = true;
      const endWait = (exit: Exit.Exit<unknown, unknown>) => {
        if (!waiting) return Effect.void;
        waiting = false;
        const ended = now();
        wait.end(ended, exit);
        return Metric.update(
          Metric.withAttributes(METRICS.slotWait, attributes),
          secondsBetween(started, ended),
        );
      };
      return yield* slots
        .withPermits(1)(
          Effect.andThen(
            Effect.suspend(() => endWait(Exit.void)),
            effect,
          ),
        )
        .pipe(Effect.onExit((exit) => endWait(exit)));
    });

/** Per-item distributions, without retaining one log record per file, blob or hunk. */
export const timePrecomputeItem = <A, E, R>(
  phase: string,
  effect: Effect.Effect<A, E, R>,
  source: (value: A) => string = () => "computed",
) =>
  Effect.gen(function* () {
    const started = performance.now();
    let label = "interrupted-or-failed";
    return yield* effect.pipe(
      Effect.tap((value) =>
        Effect.sync(() => {
          label = source(value);
        }),
      ),
      Effect.ensuring(
        Effect.suspend(() =>
          recordLate(
            Metric.update(
              Metric.withAttributes(METRICS.precomputeItem, {
                "harness.phase": phase,
                "harness.source": label,
              }),
              (performance.now() - started) / 1_000,
            ),
          ),
        ),
      ),
    );
  });

// Metrics

/**
 * The GenAI conventions' advised boundaries (v1.41.0) for `gen_ai.client.operation.duration` and
 * the per-chunk times, in seconds.
 */
const GENAI_SECONDS = [
  0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48,
  40.96, 81.92,
];
/** The same doubling, extended to the run's 10-minute limit, for the harness's own durations. */
const HARNESS_SECONDS = [...GENAI_SECONDS, 163.84, 327.68, 655.36];
/** Effect's OTLP exporter reads a metric's unit from its `unit` attribute (UCUM). */
const SECONDS = { unit: "s" } as const;

export const METRICS = {
  precomputeItem: Metric.histogram("harness.precompute.item.duration", {
    description: "Per-item precompute time by phase and cache source",
    boundaries: HARNESS_SECONDS,
    attributes: SECONDS,
  }),
  /** A model call's wait for one of the run's call slots. */
  slotWait: Metric.histogram("harness.model_call.slot_wait.duration", {
    description: "Wait for one of the run's call slots per model call",
    boundaries: HARNESS_SECONDS,
    attributes: SECONDS,
  }),
  /** A stage's wall time, by `harness.stage` and `harness.status`. */
  stageDuration: Metric.histogram("harness.stage.duration", {
    description: "Stage wall time",
    boundaries: HARNESS_SECONDS,
    attributes: SECONDS,
  }),
  /** One retriever search for a hunk's leads, by `harness.retriever`, the one that served it. */
  leadsSearch: Metric.histogram("harness.leads.search.duration", {
    description: "One retriever search for preloaded leads",
    boundaries: HARNESS_SECONDS,
    attributes: SECONDS,
  }),
  /** One hunk's leads, its searches and their scoring. */
  leadsHunk: Metric.histogram("harness.leads.hunk.duration", {
    description: "Preloaded leads for one hunk",
    boundaries: HARNESS_SECONDS,
    attributes: SECONDS,
  }),
  /**
   * A review's hunks by where their leads came from (`harness.leads.source`): `ready`, stored
   * before the review (by commit preparation or an earlier review), or `computed` during it; by
   * `harness.retriever`.
   */
  leadsSource: Metric.counter("harness.leads.hunks", {
    description:
      "Hunks whose leads were found ready or computed during the review",
    incremental: true,
  }),
  /**
   * One Graph search's wall time, its waits for the base and the query slot included, by
   * `harness.status`: what its caller waited. Searches overlap (units are reviewed in parallel),
   * so these do not add up to a share of the review; `graphBusy` does.
   */
  graphSearch: Metric.histogram("harness.graph.search.duration", {
    description: "One Graph search, waits included",
    boundaries: HARNESS_SECONDS,
    attributes: SECONDS,
  }),
  /**
   * Seconds during which at least one of the process's Graph searches was waiting or running:
   * the union of their spans, each interval counted once when the last search in it ends. Over an
   * attempt's own duration, the share of the review spent waiting on Graph.
   */
  graphBusy: Metric.counter("harness.graph.busy.duration", {
    description: "Time with at least one Graph search waiting or running",
    incremental: true,
    attributes: SECONDS,
  }),
  /**
   * A caller that stopped waiting on Graph and went on without it (architecture record 0013), by
   * `harness.graph.caller` (`leads`: a hunk got the keyword search's leads; `tool`: an agent's
   * `graph_search` answered with a gap) and `harness.graph.fallback_reason` (`deadline`: not ready
   * within the review's wait; `index-building`: the base's index was still being built;
   * `unavailable`: Graph could not run; `failed`: it failed). Over the calls made, the fallback rate.
   */
  graphFallback: Metric.counter("harness.graph.fallback", {
    description: "Callers that went on without Graph's answer",
    incremental: true,
  }),
  /**
   * Every review-time Graph call, by `harness.graph.caller`, the denominator of the fallback rate.
   */
  graphCalls: Metric.counter("harness.graph.calls", {
    description: "Review-time Graph calls, answered or not",
    incremental: true,
  }),
  /** One Graph search's CPU: the engine's and its git children's, user and system together. */
  graphSearchCpu: Metric.histogram("harness.graph.search.cpu", {
    description: "CPU of one Graph search's commands",
    boundaries: HARNESS_SECONDS,
    attributes: SECONDS,
  }),
} as const;

/**
 * The event-loop delay over an attempt, from `perf_hooks.monitorEventLoopDelay`, as the Node.js
 * runtime conventions' gauges (seconds). `eventLoopUtilization` returns zeros in Bun 1.4, so it is
 * not recorded.
 */
const EVENT_LOOP = {
  min: Metric.gauge("nodejs.eventloop.delay.min", { attributes: SECONDS }),
  max: Metric.gauge("nodejs.eventloop.delay.max", { attributes: SECONDS }),
  mean: Metric.gauge("nodejs.eventloop.delay.mean", { attributes: SECONDS }),
  stddev: Metric.gauge("nodejs.eventloop.delay.stddev", {
    attributes: SECONDS,
  }),
  p50: Metric.gauge("nodejs.eventloop.delay.p50", { attributes: SECONDS }),
  p90: Metric.gauge("nodejs.eventloop.delay.p90", { attributes: SECONDS }),
  p99: Metric.gauge("nodejs.eventloop.delay.p99", { attributes: SECONDS }),
} as const;

/** The GenAI attributes of a route's calls, for its spans and metrics. */
export const genAiAttributes = (route: {
  readonly provider: string;
  readonly model: string;
}) => ({
  "gen_ai.operation.name": "chat",
  "gen_ai.provider.name": route.provider,
  "gen_ai.request.model": route.model,
});

const jsonValue = (value: unknown): unknown =>
  typeof value === "bigint"
    ? value.toString()
    : Array.isArray(value)
      ? value.map(jsonValue)
      : typeof value === "number" && !Number.isFinite(value)
        ? null
        : value !== null && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value).map(([key, inner]) => [
                key,
                jsonValue(inner),
              ]),
            )
          : value;

/** Writes one `metric` record per series in `registry`: its name, kind, attributes and state. */
export const writeMetrics = (log: RunLog, registry: Metric.MetricRegistry) => {
  if (log.telemetryEnabled === false) return;
  const context = Context.make(Metric.MetricRegistry, registry);
  for (const snapshot of Metric.snapshotUnsafe(
    context as Context.Context<never>,
  ))
    log.write({
      type: "metric",
      name: snapshot.id,
      kind: snapshot.type,
      ...(snapshot.description === undefined
        ? {}
        : { description: snapshot.description }),
      attributes: { ...(snapshot.attributes ?? {}) },
      state: jsonValue(snapshot.state),
    });
};

/**
 * The attempt a fiber works for: its run log, whether it has stopped taking metric updates into
 * its registry (its records are being or have been written), and how many updates are landing in
 * it now. Unset outside a review attempt.
 */
export interface AttemptMetrics {
  readonly log: RunLog;
  settled: boolean;
  landing: number;
}

export const CurrentAttempt = Context.Reference<AttemptMetrics | undefined>(
  "@neuve/harness/CurrentAttempt",
  { defaultValue: () => undefined },
);

/**
 * Metric updates from work that can end after its attempt has written its records (a Graph search
 * a review stopped waiting for). While the attempt runs they go into its registry, so its run log
 * and its OTLP copy carry them; after, into a registry of their own, written to the attempt's run
 * log at once. Each update lands in exactly one record, so none is lost or written twice. Outside
 * an attempt they go into the ambient registry, as any other update does.
 */
export const recordLate = <A, E, R>(updates: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const attempt = yield* CurrentAttempt;
    if (attempt === undefined) return yield* updates;
    // Whether the attempt still takes updates, and counting this one in, in one synchronous step,
    // released on every exit: no interruption leaves the count up and the attempt's settle waiting.
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        if (attempt.settled) return false;
        attempt.landing++;
        return true;
      }),
      (counted) => {
        if (counted) return updates;
        const registry: Metric.MetricRegistry = new Map();
        return updates.pipe(
          Effect.provideService(Metric.MetricRegistry, registry),
          Effect.ensuring(
            Effect.sync(() => writeMetrics(attempt.log, registry)),
          ),
        );
      },
      (counted) =>
        Effect.sync(() => {
          if (counted) attempt.landing--;
        }),
    );
  });

/**
 * Runs one attempt with its own metric registry, so its `metric` records are its own, and the
 * event-loop delay monitored; at its end, success or not, the delay gauges are set and every
 * series is written to the run log. Work the attempt leaves running records through `recordLate`.
 */
export const withAttemptMetrics =
  (log: RunLog, registry: Metric.MetricRegistry) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      const delay = monitorEventLoopDelay({ resolution: 20 });
      delay.enable();
      const attempt: AttemptMetrics = { log, settled: false, landing: 0 };
      const settle = Effect.gen(function* () {
        // Updates from work still running land after this in records of their own (`recordLate`);
        // those already landing finish first, so the attempt's records hold them.
        attempt.settled = true;
        while (attempt.landing > 0) yield* Effect.yieldNow;
        delay.disable();
        if (delay.count > 0) {
          const seconds = (nanos: number) => nanos / 1e9;
          yield* Metric.update(EVENT_LOOP.min, seconds(delay.min));
          yield* Metric.update(EVENT_LOOP.max, seconds(delay.max));
          yield* Metric.update(EVENT_LOOP.mean, seconds(delay.mean));
          yield* Metric.update(EVENT_LOOP.stddev, seconds(delay.stddev));
          yield* Metric.update(EVENT_LOOP.p50, seconds(delay.percentile(50)));
          yield* Metric.update(EVENT_LOOP.p90, seconds(delay.percentile(90)));
          yield* Metric.update(EVENT_LOOP.p99, seconds(delay.percentile(99)));
        }
        writeMetrics(log, registry);
      });
      return effect.pipe(
        Effect.ensuring(settle),
        Effect.provideService(CurrentAttempt, attempt),
      );
    }).pipe(Effect.provideService(Metric.MetricRegistry, registry));

const compatibilityRefusals = Metric.counter("harness.compatibility.refusals");
const nativeCompatibility = new AsyncLocalStorage<{
  readonly log: RunLog;
  readonly source: string;
  readonly context: Context.Context<never> | undefined;
  readonly attempt: AttemptMetrics | undefined;
}>();

/** Native pi tasks inherit this run's capture across awaits, independently of other runs. */
export const withCompatibilityRun = <A>(
  log: RunLog,
  source: string,
  body: () => A,
): A => {
  const fiber = Fiber.getCurrent();
  return nativeCompatibility.run(
    {
      log,
      source,
      context: fiber?.context,
      attempt: fiber?.getRef(CurrentAttempt),
    },
    body,
  );
};

// Registration point for reads inside a run, using the fiber or native async context.
registerCompatibilityRefusals((shape, context) => {
  const fiber = Fiber.getCurrent();
  const native = nativeCompatibility.getStore();
  const attempt = fiber?.getRef(CurrentAttempt) ?? native?.attempt;
  const log = attempt?.log ?? native?.log;
  if (!log) return false;
  const record = refusalRecord(
    shape,
    compatibilityContext({
      ...context,
      source:
        context.source ??
        fiber?.getRef(CompatibilitySource) ??
        native?.source ??
        log.path,
    }),
  );
  log.write({ ...record });
  if (log.telemetryEnabled !== false) {
    const attributes = {
      "harness.compatibility.kind": record.kind,
      "harness.compatibility.path": record.path,
      "harness.compatibility.source": record.source,
      "harness.compatibility.reading_build": record.readingBuild,
      "harness.compatibility.writing_build": record.writingBuild,
    };
    const parent = fiber
      ? Context.getOption(fiber.context, Tracer.ParentSpan)
      : Option.none();
    if (Option.isSome(parent) && parent.value._tag === "Span")
      parent.value.event(
        "harness.compatibility.refused",
        BigInt(Date.now()) * 1_000_000n,
        attributes,
      );
    else
      startLogSpan(log, "harness.compatibility.refused", attributes)("error");
    const ambient = fiber?.context ?? native?.context;
    if (ambient && attempt && !attempt.settled)
      Metric.withAttributes(compatibilityRefusals, attributes).updateUnsafe(
        1,
        ambient,
      );
    else {
      const registry: Metric.MetricRegistry = new Map();
      Metric.withAttributes(compatibilityRefusals, attributes).updateUnsafe(
        1,
        Context.make(Metric.MetricRegistry, registry),
      );
      writeMetrics(log, registry);
    }
  }
  return true;
});
