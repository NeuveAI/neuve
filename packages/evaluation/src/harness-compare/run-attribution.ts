import { readRunLog } from "@neuve/harness/run-log";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { gunzipSync } from "node:zlib";

/**
 * Where a review run's time went, read from its run log's standard telemetry only (10.97): the
 * `span` records the run-log tracer writes, with their span events, and the attempt's `metric`
 * records (packages/harness/src/run-log.ts, telemetry.ts). It shows the critical path, the chain of
 * dependent stages that set the run's end time, with each stage's share; each agent's wall time
 * split into slot wait, provider attempts, tool calls and Neuve's own time between them; the
 * stream's split from the attempts' events; Precompute's, Understand setup's and the search
 * prewarm's spans; the seconds every call slot was held; and the metrics.
 *
 * A log written before a span or event existed lacks that part; it reads "not recorded".
 *
 * The critical path is inferred from the stage spans: walking back from the stage that ended last,
 * each stage's predecessor is the stage that finished last before it started, among the stages of
 * an earlier or the same step of the pipeline and, where both name one, the same batch (an
 * Investigate partition's stage span carries its batch). Time between stages on the path is
 * Neuve's own.
 */

export interface LogRecord {
  readonly type: string;
  readonly at?: string;
  readonly [field: string]: unknown;
}

export interface RunLogFile {
  readonly file: string;
  readonly records: ReadonlyArray<LogRecord>;
}

const parseJsonl = (text: string): Array<LogRecord> =>
  text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as LogRecord];
      } catch {
        return [];
      }
    });

/** A `.jsonl` run log, or a stored `.runlogs.json(.gz)` array of `{ file, text }`. */
export const readRunLogs = (path: string): Array<RunLogFile> => {
  if (path.endsWith(".jsonl"))
    return [{ file: basename(path), records: readRunLog(path) }];
  const raw = readFileSync(path);
  const text = (path.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8");
  if (text.trimStart().startsWith("[")) {
    const files = JSON.parse(text) as Array<{ file?: string; text: string }>;
    return files.map((entry, index) => ({
      file: entry.file ?? `#${index + 1}`,
      records: parseJsonl(entry.text),
    }));
  }
  return [{ file: basename(path), records: parseJsonl(text) }];
};

// ---------------------------------------------------------------------------------------------
// Reading

const num = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const str = (value: unknown) => (typeof value === "string" ? value : undefined);
const epoch = (value: unknown) => {
  const text = str(value);
  if (text === undefined) return undefined;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? undefined : ms;
};
const obj = (value: unknown) =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** The span and event names the harness writes (packages/harness/src/telemetry.ts). */
const NAMES = {
  run: "harness.run",
  agent: "harness.agent",
  call: "harness.model-call",
  wait: "harness.call-slot.wait",
  attempt: "LanguageModel.generateText",
  tool: "harness.tool-call",
  prewarm: "harness.prewarm",
  setup: "harness.understand.setup",
} as const;
const EVENT = {
  sent: "harness.request.sent",
  headers: "harness.response.headers",
  firstEvent: "harness.stream.first_event",
  reasoningStart: "harness.stream.reasoning.start",
  reasoningEnd: "harness.stream.reasoning.end",
  firstDelta: "harness.stream.output.first_delta",
  lastDelta: "harness.stream.output.last_delta",
  gap: "harness.stream.gap",
} as const;

interface SpanEvent {
  readonly name: string;
  readonly at: number;
  readonly attributes: Record<string, unknown>;
}

interface Span {
  readonly name: string;
  readonly spanId: string | undefined;
  readonly parentSpanId: string | undefined;
  readonly start: number;
  readonly end: number;
  readonly status: string;
  readonly attributes: Record<string, unknown>;
  readonly events: ReadonlyArray<SpanEvent>;
}

interface Interval {
  readonly start: number;
  readonly end: number;
}

const spansOf = (records: ReadonlyArray<LogRecord>): Array<Span> =>
  records.flatMap((record) => {
    if (record.type !== "span") return [];
    const start = epoch(record["start"]);
    const ms = num(record["durationMs"]);
    const name = str(record["name"]);
    if (start === undefined || ms === undefined || name === undefined)
      return [];
    const events = (
      Array.isArray(record["events"]) ? record["events"] : []
    ).flatMap((raw) => {
      const event = obj(raw);
      const at = epoch(event?.["at"]);
      const offset = num(event?.["offsetMs"]);
      const eventName = str(event?.["name"]);
      if (eventName === undefined || (at === undefined && offset === undefined))
        return [];
      return [
        {
          name: eventName,
          // The offset keeps sub-millisecond order; the ISO time is the fallback.
          at: offset === undefined ? at! : start + offset,
          attributes: obj(event?.["attributes"]) ?? {},
        },
      ];
    });
    return [
      {
        name,
        spanId: str(record["spanId"]),
        parentSpanId: str(record["parentSpanId"]),
        start,
        end: start + ms,
        status: str(record["status"]) ?? "ok",
        attributes: obj(record["attributes"]) ?? {},
        events,
      },
    ];
  });

/** Merges intervals; their union. */
const union = (intervals: ReadonlyArray<Interval>): Array<Interval> => {
  const sorted = [...intervals]
    .filter((interval) => interval.end > interval.start)
    .sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const interval of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && interval.start <= last.end)
      last.end = Math.max(last.end, interval.end);
    else merged.push({ start: interval.start, end: interval.end });
  }
  return merged;
};
const length = (intervals: ReadonlyArray<Interval>) =>
  union(intervals).reduce((sum, item) => sum + (item.end - item.start), 0);
const clip = (interval: Interval, window: Interval): Interval => ({
  start: Math.max(interval.start, window.start),
  end: Math.min(interval.end, window.end),
});

/** Spans by their parent's ID. */
const childrenIndex = (spans: ReadonlyArray<Span>) => {
  const children = new Map<string, Array<Span>>();
  for (const span of spans)
    if (span.parentSpanId !== undefined)
      children.set(span.parentSpanId, [
        ...(children.get(span.parentSpanId) ?? []),
        span,
      ]);
  return (span: Span) =>
    span.spanId === undefined ? [] : (children.get(span.spanId) ?? []);
};

// ---------------------------------------------------------------------------------------------
// Model calls and agents

export interface StreamSplit {
  /** Attempts whose stream was recorded. */
  readonly calls: number;
  /** Request sent to the response's headers (or first event). */
  readonly firstByteMs: number;
  readonly reasoningMs: number;
  /** First to last output delta. */
  readonly outputMs: number;
  readonly gapsMs: number;
  readonly gaps: number;
}

interface Attempt extends Interval {
  readonly events: ReadonlyArray<SpanEvent>;
  readonly attributes: Record<string, unknown>;
}

interface Call extends Interval {
  readonly agent: string;
  /** Null when the log has no slot-wait span for the call. */
  readonly slotWaitMs: number | null;
  /** The slot is held from the wait's end to the call's end. */
  readonly heldFrom: number;
  readonly attempts: ReadonlyArray<Attempt>;
  /** `ok`, `failed` (every attempt failed), or `cut-off` (the run's cut-off interrupted it). */
  readonly outcome: "ok" | "failed" | "cut-off";
}

const eventAt = (attempt: Attempt, name: string) =>
  attempt.events.find((event) => event.name === name)?.at;

const callsOf = (
  spans: ReadonlyArray<Span>,
  children: (span: Span) => ReadonlyArray<Span>,
) =>
  spans.flatMap((span): Array<Call> => {
    if (span.name !== NAMES.call) return [];
    const agent = str(span.attributes["harness.agent"]);
    if (agent === undefined) return [];
    const direct = children(span);
    const wait = direct.find((child) => child.name === NAMES.wait);
    // Effect AI's attempt span sits under its `Chat.generateText` span, one pair per attempt.
    const attempts: Array<Attempt> = [];
    const visit = (node: Span, depth: number) => {
      for (const child of children(node)) {
        if (child.name === NAMES.attempt)
          attempts.push({
            start: child.start,
            end: child.end,
            events: child.events,
            attributes: child.attributes,
          });
        else if (depth < 3 && child.name !== NAMES.tool)
          visit(child, depth + 1);
      }
    };
    visit(span, 0);
    return [
      {
        agent,
        start: span.start,
        end: span.end,
        slotWaitMs: wait === undefined ? null : wait.end - wait.start,
        heldFrom: wait?.end ?? span.start,
        attempts: attempts.sort((a, b) => a.start - b.start),
        outcome:
          span.status === "ok"
            ? "ok"
            : span.status === "interrupted"
              ? "cut-off"
              : "failed",
      },
    ];
  });

const streamSplit = (attempts: ReadonlyArray<Attempt>): StreamSplit | null => {
  const streamed = attempts.filter(
    (attempt) => eventAt(attempt, EVENT.sent) !== undefined,
  );
  if (streamed.length === 0) return null;
  let firstByteMs = 0;
  let reasoningMs = 0;
  let outputMs = 0;
  let gapsMs = 0;
  let gaps = 0;
  for (const attempt of streamed) {
    const sent = eventAt(attempt, EVENT.sent)!;
    const first =
      eventAt(attempt, EVENT.headers) ?? eventAt(attempt, EVENT.firstEvent);
    if (first !== undefined) firstByteMs += Math.max(0, first - sent);
    const reasoningStart = eventAt(attempt, EVENT.reasoningStart);
    const reasoningEnd = eventAt(attempt, EVENT.reasoningEnd);
    if (reasoningStart !== undefined && reasoningEnd !== undefined)
      reasoningMs += Math.max(0, reasoningEnd - reasoningStart);
    const firstDelta = eventAt(attempt, EVENT.firstDelta);
    const lastDelta = eventAt(attempt, EVENT.lastDelta);
    if (firstDelta !== undefined && lastDelta !== undefined)
      outputMs += Math.max(0, lastDelta - firstDelta);
    for (const event of attempt.events)
      if (event.name === EVENT.gap) {
        gapsMs += num(event.attributes["harness.gap_ms"]) ?? 0;
        gaps++;
      }
    gaps += num(attempt.attributes["harness.stream.gaps_omitted"]) ?? 0;
  }
  return {
    calls: streamed.length,
    firstByteMs,
    reasoningMs,
    outputMs,
    gapsMs,
    gaps,
  };
};

export interface Breakdown {
  readonly wallMs: number;
  readonly calls: number;
  /** Calls the run's cut-off interrupted. */
  readonly interruptedCalls: number;
  /** Calls whose every attempt failed. */
  readonly failedCalls: number;
  readonly retries: number;
  /** Time inside model calls, from asking for a slot to the stored turn, outside tool calls. */
  readonly modelMs: number;
  /** Null when the log does not record it. */
  readonly slotWaitMs: number | null;
  /** The provider attempts' time, outside the tool calls effect/ai runs inside them. */
  readonly providerMs: number | null;
  readonly firstByteMs: number | null;
  /** The rest of the calls' time: between attempts (backoff), storing the turn. */
  readonly callRestMs: number | null;
  readonly stream: StreamSplit | null;
  /** Null when the log records no tool-call spans (written before they existed). */
  readonly toolCalls: number | null;
  /** Tool calls (parallel calls of a turn count once). */
  readonly toolMs: number | null;
  /** Neuve's own time: the agent's wall time outside model and tool calls. */
  readonly neuveMs: number;
}

const breakdown = (
  window: Interval,
  calls: ReadonlyArray<Call>,
  tools: ReadonlyArray<Interval>,
  toolsRecorded: boolean,
): Breakdown => {
  const inside = calls.filter(
    (call) => call.end > window.start && call.start < window.end,
  );
  const callIntervals = inside.map((call) => clip(call, window));
  const toolIntervals = tools
    .filter((tool) => tool.end > window.start && tool.start < window.end)
    .map((tool) => clip(tool, window));
  // effect/ai runs a turn's tools inside the model call (and its attempt), so a call's own time is
  // its interval outside its tools.
  const toolMs = length(toolIntervals);
  const busyMs = length([...callIntervals, ...toolIntervals]);
  const modelMs = busyMs - toolMs;
  const waits = inside.filter((call) => call.slotWaitMs !== null);
  const slotWaitMs =
    waits.length === 0
      ? null
      : waits.reduce((sum, call) => sum + (call.slotWaitMs ?? 0), 0);
  const attempts = inside.flatMap((call) =>
    call.attempts.map((attempt) => clip(attempt, window)),
  );
  const providerMs =
    attempts.length === 0
      ? null
      : attempts.reduce(
          (sum, attempt) =>
            sum +
            Math.max(
              0,
              attempt.end -
                attempt.start -
                length(
                  toolIntervals
                    .filter(
                      (tool) =>
                        tool.end > attempt.start && tool.start < attempt.end,
                    )
                    .map((tool) => clip(tool, attempt)),
                ),
            ),
          0,
        );
  const allAttempts = inside.flatMap((call) => call.attempts);
  const firstBytes = allAttempts.flatMap((attempt) => {
    const sent = eventAt(attempt, EVENT.sent);
    const headers = eventAt(attempt, EVENT.headers);
    return sent === undefined || headers === undefined ? [] : [headers - sent];
  });
  return {
    wallMs: window.end - window.start,
    calls: inside.length,
    interruptedCalls: inside.filter((call) => call.outcome === "cut-off")
      .length,
    failedCalls: inside.filter((call) => call.outcome === "failed").length,
    retries: inside.reduce(
      (sum, call) => sum + Math.max(0, call.attempts.length - 1),
      0,
    ),
    modelMs,
    slotWaitMs,
    providerMs,
    firstByteMs:
      firstBytes.length === 0
        ? null
        : firstBytes.reduce((sum, ms) => sum + ms, 0),
    callRestMs:
      slotWaitMs === null && providerMs === null
        ? null
        : Math.max(0, modelMs - (slotWaitMs ?? 0) - (providerMs ?? 0)),
    stream: streamSplit(allAttempts),
    toolCalls: toolsRecorded ? toolIntervals.length : null,
    toolMs: toolsRecorded ? toolMs : null,
    neuveMs: window.end - window.start - busyMs,
  };
};

/**
 * The milliseconds during which every one of the run's call slots was held, from each call's slot
 * (the end of its wait) to its end; a slot handed on at one instant is not two held.
 */
export const allSlotsHeld = (
  calls: ReadonlyArray<Pick<Call, "heldFrom" | "end">>,
  slots: number,
) => {
  const edges: Array<{ readonly at: number; readonly step: 1 | -1 }> = [];
  for (const call of calls)
    edges.push({ at: call.heldFrom, step: 1 }, { at: call.end, step: -1 });
  edges.sort((a, b) => a.at - b.at || a.step - b.step);
  let held = 0;
  let saturated = 0;
  let since = 0;
  for (const edge of edges) {
    if (held >= slots) saturated += edge.at - since;
    held += edge.step;
    since = edge.at;
  }
  return saturated;
};

// ---------------------------------------------------------------------------------------------
// Stages and the critical path

export interface StageSpan extends Interval {
  readonly label: string;
  readonly status: string;
  /** The batch an Investigate partition's stage span names. */
  readonly batch?: string | undefined;
}

/** The pipeline's step order: a stage waits only on stages of an earlier or the same step. */
const stepRank = (label: string) => {
  if (label === "precompute") return 0;
  if (/^understand(\.u\d+)?$/.test(label)) return 1;
  if (label.startsWith("understand.")) return 2;
  if (label === "investigate.plan") return 3;
  if (label.startsWith("investigate.")) return 4;
  // Dispose runs alongside a batch's digest and `assemble.bN` waits on both, so they share a step;
  // the batch filter keeps a stage's predecessors within its batch.
  if (label.startsWith("assemble.") || label.startsWith("dispose.")) return 5;
  if (label === "publish") return 7;
  return undefined;
};

const batchOf = (stage: StageSpan) =>
  /^investigate\.p\d+$/.test(stage.label)
    ? stage.batch
    : // A resplit batch (b1a, b1b) belongs to its candidate batch (b1).
      /^(?:assemble|dispose)\.(b\d+)[a-z]*(?:\.|$)/.exec(stage.label)?.[1];

const TOLERANCE_MS = 5;

export const criticalPath = (
  stages: ReadonlyArray<StageSpan>,
): Array<StageSpan> => {
  const last = [...stages].sort(
    (a, b) => b.end - a.end || b.end - b.start - (a.end - a.start),
  )[0];
  if (last === undefined) return [];
  const path = [last];
  let current = last;
  for (;;) {
    const rank = stepRank(current.label);
    const batch = batchOf(current);
    const candidates = stages.filter((stage) => {
      if (stage === current || path.includes(stage)) return false;
      if (stage.end > current.start + TOLERANCE_MS) return false;
      const theirs = stepRank(stage.label);
      if (rank !== undefined && theirs !== undefined && theirs > rank)
        return false;
      const other = batchOf(stage);
      return batch === undefined || other === undefined || other === batch;
    });
    const previous = candidates.sort(
      (a, b) => b.end - a.end || b.end - b.start - (a.end - a.start),
    )[0];
    if (previous === undefined) break;
    path.unshift(previous);
    current = previous;
  }
  return path;
};

// ---------------------------------------------------------------------------------------------
// The attribution

export interface TimelineRow {
  readonly step: string;
  readonly depth: number;
  readonly startMs: number;
  readonly ms: number;
  readonly status: string;
  readonly fields?: Record<string, unknown> | undefined;
  /** Time inside the step not covered by its sub-steps. */
  readonly untimedMs?: number | undefined;
}

export interface PathRow {
  readonly label: string;
  readonly kind: "stage" | "between";
  readonly startMs: number;
  readonly ms: number;
  readonly share: number;
  readonly agents: ReadonlyArray<string>;
}

export interface PrewarmRow {
  readonly step: string;
  readonly startMs: number;
  readonly ms: number;
  readonly ok: boolean;
  /** Time spent alongside each critical-path stage it overlapped. */
  readonly overlaps: ReadonlyArray<{
    readonly label: string;
    readonly ms: number;
  }>;
  /** How long before (negative: after) the first search-using stage began it finished. */
  readonly readyBeforeInvestigateMs: number | null;
}

export interface MetricRow {
  readonly name: string;
  readonly kind: string;
  readonly attributes: Record<string, unknown>;
  readonly count?: number | undefined;
  readonly sum?: number | undefined;
  readonly max?: number | undefined;
  readonly value?: number | undefined;
}

export interface Attribution {
  readonly runId: string;
  /** The run span's status: ok, error or interrupted. */
  readonly outcome: string | undefined;
  readonly range: string | undefined;
  readonly wallMs: number;
  readonly path: ReadonlyArray<PathRow>;
  /** The critical path's time by kind, summing to the run's wall time. */
  readonly pathKinds: ReadonlyArray<{
    readonly kind: string;
    readonly ms: number;
  }>;
  readonly pathSplitRecorded: boolean;
  readonly precompute: {
    readonly wallMs: number;
    readonly rows: ReadonlyArray<TimelineRow>;
  } | null;
  readonly setup: ReadonlyArray<TimelineRow> | null;
  /** Null when the log predates the setup and prewarm spans. */
  readonly prewarm: ReadonlyArray<PrewarmRow> | null;
  /** The run's call slots and the time all of them were held; null without the slot count. */
  readonly slots: { readonly count: number; readonly allHeldMs: number } | null;
  readonly agents: ReadonlyArray<{
    readonly agent: string;
    readonly startMs: number;
    readonly onPath: boolean;
    readonly breakdown: Breakdown;
  }>;
  readonly metrics: ReadonlyArray<MetricRow>;
}

/** Attributes worth showing on a step: the harness's own, without the ones every span repeats. */
const fieldsOf = (attributes: Record<string, unknown>) => {
  const fields = Object.fromEntries(
    Object.entries(attributes)
      .filter(
        ([key]) =>
          key.startsWith("harness.") &&
          ![
            "harness.stage",
            "harness.agent",
            "harness.base",
            "harness.head",
          ].includes(key),
      )
      .map(([key, value]) => [key.slice("harness.".length), value]),
  );
  return Object.keys(fields).length === 0 ? undefined : fields;
};

/** A span and its descendants, depth first in start order, each with its untimed time. */
const spanRows = (
  root: Span,
  children: (span: Span) => ReadonlyArray<Span>,
  at: (ms: number) => number,
  includeRoot: boolean,
): Array<TimelineRow> => {
  const rows: Array<TimelineRow> = [];
  const visit = (span: Span, depth: number) => {
    const kids = [...children(span)].sort((a, b) => a.start - b.start);
    rows.push({
      step: span.name,
      depth,
      startMs: at(span.start),
      ms: span.end - span.start,
      status: span.status,
      fields: fieldsOf(span.attributes),
      ...(kids.length === 0
        ? {}
        : {
            untimedMs:
              span.end -
              span.start -
              length(kids.map((kid) => clip(kid, span))),
          }),
    });
    if (depth < 12) for (const kid of kids) visit(kid, depth + 1);
  };
  if (includeRoot) visit(root, 0);
  else
    for (const kid of [...children(root)].sort((a, b) => a.start - b.start))
      visit(kid, 0);
  return rows;
};

const metricsOf = (records: ReadonlyArray<LogRecord>): Array<MetricRow> =>
  records.flatMap((record): Array<MetricRow> => {
    if (record.type !== "metric") return [];
    const name = str(record["name"]);
    const kind = str(record["kind"]);
    const state = obj(record["state"]);
    if (name === undefined || kind === undefined || state === undefined)
      return [];
    const attributes = obj(record["attributes"]) ?? {};
    if (kind === "Histogram")
      return [
        {
          name,
          kind,
          attributes,
          count: num(state["count"]),
          sum: num(state["sum"]),
          max: num(state["max"]),
        },
      ];
    if (kind === "Gauge" || kind === "Counter")
      return [
        {
          name,
          kind,
          attributes,
          value: num(state["value"]) ?? num(state["count"]),
        },
      ];
    return [];
  });

export const attribute = (records: ReadonlyArray<LogRecord>): Attribution => {
  const spans = spansOf(records);
  const children = childrenIndex(spans);
  const runSpan = spans.find((span) => span.name === NAMES.run);
  const stageSpans = spans.filter((span) =>
    span.name.startsWith("harness.stage."),
  );
  const runStart =
    runSpan?.start ?? Math.min(...stageSpans.map((span) => span.start));
  const runEnd =
    runSpan?.end ?? Math.max(...stageSpans.map((span) => span.end));
  const wallMs = runEnd - runStart;
  const at = (ms: number) => ms - runStart;

  const stages: Array<StageSpan> = stageSpans.map((span) => ({
    label:
      str(span.attributes["harness.agent"]) ??
      span.name.slice("harness.stage.".length),
    start: span.start,
    end: span.end,
    status: span.status,
    batch: str(span.attributes["harness.batch"]),
  }));

  const calls = callsOf(spans, children);
  const tools = new Map<string, Array<Interval>>();
  for (const span of spans) {
    if (span.name !== NAMES.tool) continue;
    const agent = str(span.attributes["harness.agent"]);
    if (agent === undefined) continue;
    tools.set(agent, [
      ...(tools.get(agent) ?? []),
      { start: span.start, end: span.end },
    ]);
  }
  const agentSpans = spans
    .filter((span) => span.name === NAMES.agent)
    .flatMap((span) => {
      const agent = str(span.attributes["harness.agent"]);
      return agent === undefined
        ? []
        : [{ agent, start: span.start, end: span.end }];
    });
  // A log with the call's slot-wait spans was written with tool-call spans too: no tool span then
  // means no tool call. An older log's tool time is not recorded, not zero.
  const toolsRecorded = spans.some(
    (span) => span.name === NAMES.tool || span.name === NAMES.wait,
  );
  const agentBreakdown = (agent: string, window: Interval) =>
    breakdown(
      window,
      calls.filter((call) => call.agent === agent),
      tools.get(agent) ?? [],
      toolsRecorded,
    );

  // The critical path, with Neuve's time before, between and after its stages.
  const chain = criticalPath(stages);
  const path: Array<PathRow> = [];
  const kinds = new Map<string, number>();
  const add = (kind: string, ms: number) => {
    if (ms > 0) kinds.set(kind, (kinds.get(kind) ?? 0) + ms);
  };
  let pathSplitRecorded = false;
  let cursor = runStart;
  const between = (
    until: number,
    before: string | undefined,
    after: string,
  ) => {
    if (until - cursor <= 0) return;
    path.push({
      label:
        before === undefined
          ? `Neuve, before ${after}`
          : `Neuve, between ${before} and ${after}`,
      kind: "between",
      startMs: at(cursor),
      ms: until - cursor,
      share: (until - cursor) / wallMs,
      agents: [],
    });
    add("Neuve between stages", until - cursor);
  };
  chain.forEach((stage, index) => {
    between(stage.start, chain[index - 1]?.label, stage.label);
    const start = Math.max(stage.start, cursor);
    const window = { start, end: stage.end };
    const agents = agentSpans.filter(
      (span) =>
        span.agent === stage.label &&
        span.end > window.start &&
        span.start < window.end,
    );
    path.push({
      label: stage.label,
      kind: "stage",
      startMs: at(start),
      ms: window.end - window.start,
      share: (window.end - window.start) / wallMs,
      agents: agents.map((span) => span.agent),
    });
    let agentWall = 0;
    for (const span of agents) {
      const part = agentBreakdown(span.agent, clip(span, window));
      agentWall += part.wallMs;
      if (part.slotWaitMs !== null || part.providerMs !== null) {
        pathSplitRecorded = true;
        add("model calls: slot wait", part.slotWaitMs ?? 0);
        add("model calls: provider attempts", part.providerMs ?? 0);
        add(
          "model calls: rest (backoff between attempts, storing the turn)",
          part.callRestMs ?? 0,
        );
      } else
        add(
          part.toolMs === null
            ? "model calls (slot wait and tool calls not split in this log)"
            : "model calls (slot wait not split in this log)",
          part.modelMs,
        );
      if (part.toolMs !== null) add("tool calls", part.toolMs);
      add("Neuve inside agents", part.neuveMs);
    }
    const outside = window.end - window.start - agentWall;
    add(
      stage.label === "precompute"
        ? "preparation (precompute)"
        : agents.length === 0
          ? "Neuve stage work (no agent)"
          : "Neuve stage work around agents",
      outside,
    );
    cursor = Math.max(cursor, stage.end);
  });
  if (runEnd > cursor) {
    path.push({
      label: `Neuve, after ${chain.at(-1)?.label ?? "the stages"}`,
      kind: "between",
      startMs: at(cursor),
      ms: runEnd - cursor,
      share: (runEnd - cursor) / wallMs,
      agents: [],
    });
    add("Neuve between stages", runEnd - cursor);
  }

  // Precompute and Understand's setup: their spans, nested as they ran.
  const precomputeSpan = stageSpans.find(
    (span) => span.name === "harness.stage.precompute",
  );
  const precompute =
    precomputeSpan === undefined
      ? null
      : {
          wallMs: precomputeSpan.end - precomputeSpan.start,
          rows: spanRows(precomputeSpan, children, at, false),
        };
  const setupSpan = spans.find((span) => span.name === NAMES.setup);
  const setup =
    setupSpan === undefined ? null : spanRows(setupSpan, children, at, true);

  // The search prewarm, beside the critical path.
  const firstSearchStage = stages
    .filter((stage) => (stepRank(stage.label) ?? 0) >= 4)
    .sort((a, b) => a.start - b.start)[0];
  // Written beside the setup's span: a log without it predates both.
  const prewarm: Array<PrewarmRow> | null =
    setupSpan === undefined
      ? null
      : spans.flatMap((span) => {
          if (span.name !== NAMES.prewarm) return [];
          return [
            {
              step: str(span.attributes["harness.prewarm.step"]) ?? "?",
              startMs: at(span.start),
              ms: span.end - span.start,
              ok: span.status === "ok",
              overlaps: chain.flatMap((stage) => {
                const overlap =
                  Math.min(stage.end, span.end) -
                  Math.max(stage.start, span.start);
                return overlap > 0 ? [{ label: stage.label, ms: overlap }] : [];
              }),
              readyBeforeInvestigateMs:
                firstSearchStage === undefined
                  ? null
                  : firstSearchStage.start - span.end,
            },
          ];
        });

  const slotCount = num(runSpan?.attributes["harness.calls_in_flight"]);
  const onPath = new Set(chain.map((stage) => stage.label));
  const base = str(runSpan?.attributes["harness.range.base_oid"]);
  const head = str(runSpan?.attributes["harness.range.head_oid"]);
  return {
    runId: str(runSpan?.attributes["harness.run_id"]) ?? "?",
    outcome: runSpan?.status,
    range:
      base === undefined || head === undefined
        ? undefined
        : `${base.slice(0, 8)}..${head.slice(0, 8)}`,
    wallMs,
    path,
    pathKinds: [...kinds]
      .map(([kind, ms]) => ({ kind, ms }))
      .sort((a, b) => b.ms - a.ms),
    pathSplitRecorded,
    precompute,
    setup,
    prewarm,
    slots:
      slotCount === undefined || !spans.some((span) => span.name === NAMES.wait)
        ? null
        : { count: slotCount, allHeldMs: allSlotsHeld(calls, slotCount) },
    agents: agentSpans
      .sort((a, b) => a.start - b.start)
      .map((span) => ({
        agent: span.agent,
        startMs: at(span.start),
        onPath: onPath.has(span.agent),
        breakdown: agentBreakdown(span.agent, span),
      })),
    metrics: metricsOf(records),
  };
};

// ---------------------------------------------------------------------------------------------
// The report

const seconds = (ms: number | null | undefined) =>
  ms === null || ms === undefined ? "-" : `${(ms / 1000).toFixed(1)} s`;
const percent = (share: number) => `${(share * 100).toFixed(1)}%`;
const pad = (text: string, width: number) => text.padEnd(width);
const padLeft = (text: string, width: number) => text.padStart(width);

const fieldText = (fields: Record<string, unknown> | undefined): string => {
  if (fields === undefined) return "";
  const flat = (value: unknown): string => {
    const nested = obj(value);
    if (nested === undefined) return String(value);
    return `{${Object.entries(nested)
      .map(([key, inner]) => `${key} ${flat(inner)}`)
      .join(", ")}}`;
  };
  return Object.entries(fields)
    .map(([key, value]) => `${key} ${flat(value)}`)
    .join("; ");
};

const timelineText = (rows: ReadonlyArray<TimelineRow>) =>
  rows.flatMap((row) => {
    const indent = "  ".repeat(row.depth);
    const line = `  ${padLeft(seconds(row.startMs), 9)}  ${padLeft(seconds(row.ms), 8)}  ${indent}${row.step}${row.status === "ok" ? "" : ` [${row.status}]`}${row.fields === undefined ? "" : `  (${fieldText(row.fields)})`}`;
    return row.untimedMs === undefined || row.untimedMs < 50
      ? [line]
      : [
          line,
          `  ${padLeft("", 9)}  ${padLeft(seconds(row.untimedMs), 8)}  ${indent}  (not timed by a sub-step)`,
        ];
  });

const attributeText = (attributes: Record<string, unknown>) =>
  Object.entries(attributes)
    .filter(
      ([key]) =>
        !["gen_ai.operation.name", "gen_ai.request.model"].includes(key),
    )
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");

export const formatAttribution = (report: Attribution): string => {
  const lines: Array<string> = [];
  lines.push(
    `Run ${report.runId}${report.range === undefined ? "" : ` over ${report.range}`}${report.outcome === undefined ? "" : `, ${report.outcome}`}: ${seconds(report.wallMs)} wall`,
  );
  lines.push("");
  lines.push(
    "Critical path (each stage waits on the one before it; offsets from the run's start)",
  );
  lines.push(
    `  ${padLeft("start", 9)}  ${padLeft("wall", 8)}  ${padLeft("share", 6)}  stage`,
  );
  for (const row of report.path)
    lines.push(
      `  ${padLeft(seconds(row.startMs), 9)}  ${padLeft(seconds(row.ms), 8)}  ${padLeft(percent(row.share), 6)}  ${row.label}`,
    );
  lines.push("");
  lines.push("Critical path by kind of time");
  for (const { kind, ms } of report.pathKinds)
    lines.push(
      `  ${pad(kind, 62)} ${padLeft(seconds(ms), 8)}  ${padLeft(percent(ms / report.wallMs), 6)}`,
    );
  const total = report.pathKinds.reduce((sum, item) => sum + item.ms, 0);
  lines.push(
    `  ${pad("total", 62)} ${padLeft(seconds(total), 8)}  ${padLeft(percent(total / report.wallMs), 6)}`,
  );
  if (!report.pathSplitRecorded)
    lines.push(
      "  (this log records no slot-wait or attempt spans; model calls are not split)",
    );
  if (report.slots !== null)
    lines.push(
      `  all ${report.slots.count} call slots held for ${seconds(report.slots.allHeldMs)}`,
    );

  lines.push("");
  if (report.precompute === null)
    lines.push("Preparation: no precompute stage in this log");
  else {
    lines.push(
      `Preparation (precompute, ${seconds(report.precompute.wallMs)})`,
    );
    if (report.precompute.rows.length === 0)
      lines.push("  its steps are not recorded in this log");
    else {
      lines.push(`  ${padLeft("start", 9)}  ${padLeft("wall", 8)}  span`);
      lines.push(...timelineText(report.precompute.rows));
    }
  }
  lines.push("");
  if (report.setup === null)
    lines.push("Between Precompute and Understand: not recorded in this log");
  else {
    lines.push("Between Precompute and Understand");
    lines.push(...timelineText(report.setup));
  }

  lines.push("");
  if (report.prewarm === null)
    lines.push("Search prewarm: not recorded in this log");
  else if (report.prewarm.length === 0)
    lines.push("Search prewarm: none in this log");
  else {
    lines.push(
      "Search prewarm (in the background; overlap with critical-path stages)",
    );
    for (const row of report.prewarm)
      lines.push(
        `  ${padLeft(seconds(row.startMs), 9)}  ${padLeft(seconds(row.ms), 8)}  ${pad(row.step, 15)} ${row.ok ? "ok    " : "failed"}  alongside ${row.overlaps.map((item) => `${item.label} ${seconds(item.ms)}`).join(", ") || "nothing"}${row.readyBeforeInvestigateMs === null ? "" : row.readyBeforeInvestigateMs >= 0 ? `; ready ${seconds(row.readyBeforeInvestigateMs)} before Investigate began` : `; still running ${seconds(-row.readyBeforeInvestigateMs)} into Investigate`}`,
      );
  }

  lines.push("");
  lines.push(
    "Agents (wall; model calls with slot wait, provider attempts and first byte; tools; Neuve's own time)",
  );
  lines.push(
    `  ${pad("agent", 22)} ${padLeft("start", 8)} ${padLeft("wall", 8)} ${padLeft("calls", 7)} ${padLeft("model", 8)} ${padLeft("slot", 7)} ${padLeft("provider", 8)} ${padLeft("1st byte", 8)} ${padLeft("tools", 7)} ${padLeft("n", 4)} ${padLeft("Neuve", 7)}  stream`,
  );
  for (const { agent, startMs, onPath, breakdown: part } of report.agents)
    lines.push(
      `  ${pad(`${onPath ? "*" : " "}${agent}`, 22)} ${padLeft(seconds(startMs), 8)} ${padLeft(seconds(part.wallMs), 8)} ${padLeft(`${part.calls - part.interruptedCalls - part.failedCalls}${part.failedCalls > 0 ? `+${part.failedCalls}f` : ""}${part.interruptedCalls > 0 ? `+${part.interruptedCalls}x` : ""}`, 7)} ${padLeft(seconds(part.modelMs), 8)} ${padLeft(seconds(part.slotWaitMs), 7)} ${padLeft(seconds(part.providerMs), 8)} ${padLeft(seconds(part.firstByteMs), 8)} ${padLeft(seconds(part.toolMs), 7)} ${padLeft(part.toolCalls === null ? "-" : String(part.toolCalls), 4)} ${padLeft(seconds(part.neuveMs), 7)}  ${part.stream === null ? "-" : `reasoning ${seconds(part.stream.reasoningMs)}, output ${seconds(part.stream.outputMs)}, gaps ${seconds(part.stream.gapsMs)} (${part.stream.gaps})`}`,
    );
  lines.push(
    "  * on the critical path; calls n+kf+mx: k failed in every attempt, m cut off; '-' not recorded in this log",
  );

  if (report.metrics.length > 0) {
    lines.push("");
    lines.push("Metrics (the attempt's metric records)");
    for (const row of report.metrics)
      lines.push(
        `  ${pad(row.name, 46)} ${row.kind === "Histogram" ? `n ${row.count ?? 0}, mean ${row.count ? ((row.sum ?? 0) / row.count).toFixed(3) : "-"}, max ${row.max === undefined ? "-" : row.max.toFixed(3)}` : `${row.value ?? "-"}`}  ${attributeText(row.attributes)}`,
      );
  }
  return lines.join("\n");
};

/** Every run in a run-log file that ran stages, attributed. */
export const attributeFile = (path: string, runId?: string) =>
  readRunLogs(path)
    .filter((file) =>
      file.records.some(
        (record) => record.type === "span" && record["name"] === NAMES.run,
      ),
    )
    .map((file) => attribute(file.records))
    .filter((report) => runId === undefined || report.runId === runId);
