import { Metric } from "effect";

/**
 * Stack sources' telemetry (10.97): every timing is an OpenTelemetry span, span event or metric
 * through Effect, never a bespoke record. Tool calls already run in `harness.tool-call` spans
 * (toolkit.ts), which the stack tools annotate and time here; the fetch and index jobs run in
 * `harness.stack.fetch` and `harness.stack.index` spans in the worker, with one span event per
 * entry, tree or stop, written to the job's log by the run-log tracer (stack/handler.ts).
 * Attributes carry names, counts, sizes and identifiers only, never fetched text (10.16).
 */

export const STACK_SPANS = {
  fetch: "harness.stack.fetch",
  index: "harness.stack.index",
  freeze: "harness.stack.freeze",
} as const;

/** Span events on a job's span, one per thing the child did, at the time it happened. */
export const STACK_EVENTS = {
  packageFetched: "harness.stack.package.fetched",
  packageReused: "harness.stack.package.reused",
  gap: "harness.stack.gap",
  upstreamFetched: "harness.stack.upstream.fetched",
  /** The watchdog killed an upstream fetch: its cap, its time limit, or the job's end. */
  upstreamStopped: "harness.stack.upstream.stopped",
  evicted: "harness.stack.evicted",
  indexBuilt: "harness.stack.index.built",
} as const;

/** What the child reports per event: its name, its time (Unix ms) and metadata attributes. */
export interface StackEvent {
  readonly name: string;
  readonly at: number;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
}

const SECONDS = { unit: "s" } as const;
const BYTES = { unit: "By" } as const;
/** Seconds, from 10 ms to about 20 minutes, doubling. */
const STACK_SECONDS = Array.from({ length: 18 }, (_, i) => 0.01 * 2 ** i);
/** Bytes, from 4 KiB to 1 GiB, by fours. */
const STACK_BYTES = Array.from({ length: 10 }, (_, i) => 4096 * 4 ** i);

export const STACK_METRICS = {
  /** One stack tool call, by `harness.stack.tool` and `harness.status` (answered, empty, gap). */
  toolDuration: Metric.histogram("harness.stack.tool.duration", {
    description: "One stack tool call",
    boundaries: STACK_SECONDS,
    attributes: SECONDS,
  }),
  /** One job, by `harness.stack.job` (fetch, index) and `harness.status`. */
  jobDuration: Metric.histogram("harness.stack.job.duration", {
    description: "One stack.fetch or stack.index job, child included",
    boundaries: STACK_SECONDS,
    attributes: SECONDS,
  }),
  /** Entries a fetch job handled, by `harness.stack.outcome` (fetched, reused, or the gap's reason). */
  entries: Metric.counter("harness.stack.fetch.entries", {
    description: "Stack entries a fetch job handled, by outcome",
  }),
  /** Bytes a fetch wrote to the store per entry or tree, by `harness.stack.kind`. */
  fetchedBytes: Metric.histogram("harness.stack.fetch.bytes", {
    description: "Bytes on disk one fetched package or upstream tree takes",
    boundaries: STACK_BYTES,
    attributes: BYTES,
  }),
  /** One tree's index build. */
  indexDuration: Metric.histogram("harness.stack.index.duration", {
    description: "One store tree's index build",
    boundaries: STACK_SECONDS,
    attributes: SECONDS,
  }),
  /** The store's total size after a job. */
  storeBytes: Metric.gauge("harness.stack.store.bytes", {
    description: "The stack store's size after a job",
    attributes: BYTES,
  }),
} as const;
