// Why: the attribution report infers a run's critical path from its stage spans, since no record
// names a stage's dependency. Parallel batches end in any order, so "the stage that finished last
// before this one started" is often a stage of another batch; a wrong rule would blame the run's
// end on the wrong stage and nothing else would show it. The report reads only the standard
// telemetry other code writes (10.97): spans by their parent links, span events by name, metric
// records. A misread link or name reads as "not recorded" or as Neuve's time, silently. These pin
// the predecessor rule on a run whose latest finisher is the wrong batch, that an agent's split
// sums to its wall time with tools run inside the provider attempt, as effect/ai runs them, that
// the stream split reads the attempt's events, that Precompute's spans nest by their parents, and
// that the slots' saturation and the metrics are read.
import { expect, test } from "bun:test";
import {
  attribute,
  formatAttribution,
  type LogRecord,
} from "../src/harness-compare/run-attribution.ts";

const T0 = Date.parse("2026-10-21T10:00:00.000Z");
const iso = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

let ids = 0;
/** A span as the run log's tracer writes it (run-log.ts), with its ID for children to name. */
const span = (
  name: string,
  startS: number,
  endS: number,
  attributes: Record<string, unknown> = {},
  more: {
    readonly parent?: LogRecord;
    readonly status?: string;
    readonly events?: ReadonlyArray<
      readonly [string, number, Record<string, unknown>?]
    >;
  } = {},
): LogRecord => ({
  type: "span",
  at: iso(endS),
  name,
  spanId: `s${++ids}`,
  parentSpanId: more.parent?.["spanId"],
  start: iso(startS),
  durationMs: Math.round((endS - startS) * 1000),
  status: more.status ?? "ok",
  attributes,
  ...(more.events === undefined
    ? {}
    : {
        events: more.events.map(([event, atS, eventAttributes]) => ({
          name: event,
          at: iso(atS),
          offsetMs: Math.round((atS - startS) * 1000),
          ...(eventAttributes === undefined
            ? {}
            : { attributes: eventAttributes }),
        })),
      }),
});
const stage = (agent: string, startS: number, endS: number, batch?: string) =>
  span(`harness.stage.${agent.split(".")[0]}`, startS, endS, {
    "harness.agent": agent,
    ...(batch === undefined ? {} : { "harness.batch": batch }),
  });

const run = (extra: ReadonlyArray<LogRecord>): ReadonlyArray<LogRecord> => [
  stage("precompute", 1, 9),
  stage("understand", 11, 100),
  stage("investigate.plan", 100, 100.01),
  stage("investigate.p1", 101, 300, "b1"),
  stage("investigate.p2", 101, 200, "b2"),
  // b2's Assemble ends after p1 and before b1's units: the latest finisher, never b1's dependency.
  stage("assemble.b2", 200.5, 300.1),
  stage("assemble.b1.units", 300.2, 300.3),
  // Dispose runs alongside the batch's digest, and `assemble.b1` waits on both.
  stage("assemble.b1a.digest", 300.3, 305),
  stage("dispose.b1a.u1", 300.3, 318),
  stage("assemble.b1", 318, 320),
  span("harness.stage.publish", 320.5, 321),
  span("harness.run", 0, 322, {
    "harness.run_id": "R1",
    "harness.calls_in_flight": 1,
  }),
  ...extra,
];

test("the critical path follows a stage's own batch, and its kinds sum to the run's wall time", () => {
  const report = attribute(run([]));
  expect(
    report.path.filter((row) => row.kind === "stage").map((row) => row.label),
  ).toEqual([
    "precompute",
    "understand",
    "investigate.plan",
    "investigate.p1",
    "assemble.b1.units",
    "dispose.b1a.u1",
    "assemble.b1",
    "publish",
  ]);
  const total = report.pathKinds.reduce((sum, item) => sum + item.ms, 0);
  expect(total).toBeCloseTo(report.wallMs, 0);
  expect(report.wallMs).toBe(322_000);
  expect(report.runId).toBe("R1");
});

/** One model call's spans: the call, its slot wait, and each attempt under its chat span. */
const call = (
  turn: number,
  startS: number,
  endS: number,
  waitS: number,
  attempts: ReadonlyArray<{
    readonly startS: number;
    readonly endS: number;
    readonly status?: string;
    readonly events?: ReadonlyArray<
      readonly [string, number, Record<string, unknown>?]
    >;
  }>,
  status = "ok",
): Array<LogRecord> => {
  const parent = span(
    "harness.model-call",
    startS,
    endS,
    {
      "harness.agent": "understand",
      "harness.turn": turn,
      "harness.call": "turn",
    },
    { status },
  );
  return [
    parent,
    span("harness.call-slot.wait", startS, startS + waitS, {}, { parent }),
    ...attempts.flatMap((attempt) => {
      const chat = span(
        "Chat.generateText",
        attempt.startS,
        attempt.endS,
        {},
        {
          parent,
          ...(attempt.status === undefined ? {} : { status: attempt.status }),
        },
      );
      return [
        chat,
        span(
          "LanguageModel.generateText",
          attempt.startS,
          attempt.endS,
          {},
          {
            parent: chat,
            ...(attempt.status === undefined ? {} : { status: attempt.status }),
            ...(attempt.events === undefined ? {} : { events: attempt.events }),
          },
        ),
      ];
    }),
  ];
};

test("an agent's split reads the call's child spans and the attempt's events, and counts tools inside attempts once", () => {
  const report = attribute(
    run([
      span("harness.agent", 11, 100, { "harness.agent": "understand" }),
      // Waits 20 s, then one attempt of 29 s whose stream the events mark; the tool runs inside it.
      ...call(1, 11, 61, 20, [
        {
          startS: 31,
          endS: 60,
          events: [
            ["harness.request.sent", 31],
            ["harness.response.headers", 34],
            ["harness.stream.reasoning.start", 35],
            ["harness.stream.gap", 37, { "harness.gap_ms": 2_000 }],
            ["harness.stream.reasoning.end", 41],
            ["harness.stream.output.first_delta", 41],
            ["harness.stream.output.last_delta", 58],
            ["harness.stream.completed", 58],
          ],
        },
      ]),
      span("harness.tool-call", 59.5, 60.5, {
        "harness.agent": "understand",
        "gen_ai.tool.name": "hunk",
      }),
      // No wait; a failed attempt, 2 s of backoff, then the attempt that answered.
      ...call(2, 62, 92, 0, [
        { startS: 62, endS: 67, status: "error" },
        { startS: 69, endS: 91 },
      ]),
      // Every attempt failed: a call with its slot wait, not a cut-off one.
      ...call(
        3,
        92,
        96,
        1,
        [{ startS: 93, endS: 96, status: "error" }],
        "error",
      ),
      // The run's cut-off interrupted it while it waited for the provider.
      ...call(
        4,
        96,
        99,
        0,
        [{ startS: 96, endS: 99, status: "interrupted" }],
        "interrupted",
      ),
    ]),
  );
  const understand = report.agents.find(
    (entry) => entry.agent === "understand",
  );
  expect(understand?.onPath).toBe(true);
  const part = understand!.breakdown;
  expect(part.calls).toBe(4);
  expect(part.failedCalls).toBe(1);
  expect(part.interruptedCalls).toBe(1);
  expect(part.retries).toBe(1);
  expect(part.wallMs).toBe(89_000);
  expect(part.toolMs).toBe(1_000);
  expect(part.modelMs).toBe(86_000);
  expect(part.slotWaitMs).toBe(21_000);
  // Attempts: 29 less the tool's 0.5 s inside it, 5, 22, 3, 3.
  expect(part.providerMs).toBe(61_500);
  expect(part.callRestMs).toBe(3_500);
  expect(part.firstByteMs).toBe(3_000);
  expect(part.neuveMs).toBe(2_000);
  expect(part.modelMs + part.toolMs! + part.neuveMs).toBe(part.wallMs);
  expect(part.stream).toEqual({
    calls: 1,
    firstByteMs: 3_000,
    reasoningMs: 6_000,
    outputMs: 17_000,
    gapsMs: 2_000,
    gaps: 1,
  });
  expect(report.pathSplitRecorded).toBe(true);
  // One slot: held from each wait's end to its call's end, without overlap here.
  expect(report.slots).toEqual({
    count: 1,
    allHeldMs: 30_000 + 30_000 + 3_000 + 3_000,
  });
});

test("Precompute's spans nest by their parents, with each step's untimed time and its attributes", () => {
  const records = run([]);
  const precompute = records.find(
    (record) => record["name"] === "harness.stage.precompute",
  )!;
  const computation = span(
    "harness.precompute.computation",
    1,
    9,
    {
      "harness.computation.status": "computed",
    },
    { parent: precompute },
  );
  const manifest = span(
    "harness.precompute.manifest",
    1,
    8,
    {},
    {
      parent: computation,
    },
  );
  const report = attribute([
    ...records,
    computation,
    manifest,
    span(
      "harness.precompute.range-diff",
      1.1,
      1.6,
      { "harness.files": 12 },
      {
        parent: manifest,
      },
    ),
    span("harness.precompute.tree-index", 2, 6, {}, { parent: manifest }),
    // Starts the instant the manifest ends: its parent, not its interval, places it.
    span("harness.precompute.scope", 8, 8.1, {}, { parent: computation }),
  ]);
  expect(
    report.precompute?.rows.map((row) => [
      row.step,
      row.depth,
      row.startMs,
      row.untimedMs,
    ]),
  ).toEqual([
    ["harness.precompute.computation", 0, 1_000, 900],
    ["harness.precompute.manifest", 1, 1_000, 2_500],
    ["harness.precompute.range-diff", 2, 1_100, undefined],
    ["harness.precompute.tree-index", 2, 2_000, undefined],
    ["harness.precompute.scope", 1, 8_000, undefined],
  ]);
  expect(report.precompute?.rows[2]?.fields).toEqual({ files: 12 });
});

test("the prewarm's spans and the attempt's metric records are read", () => {
  const report = attribute(
    run([
      span("harness.understand.setup", 9.5, 10.5),
      span("harness.prewarm", 10, 120, {
        "harness.prewarm.step": "graph-snapshot",
      }),
      {
        type: "metric",
        name: "gen_ai.client.operation.duration",
        kind: "Histogram",
        attributes: { "gen_ai.provider.name": "openai" },
        state: { buckets: [], count: 4, min: 1, max: 9, sum: 20 },
      },
      {
        type: "metric",
        name: "nodejs.eventloop.delay.p99",
        kind: "Gauge",
        attributes: {},
        state: { value: 0.031 },
      },
    ]),
  );
  expect(report.prewarm).toEqual([
    {
      step: "graph-snapshot",
      startMs: 10_000,
      ms: 110_000,
      ok: true,
      overlaps: [
        { label: "understand", ms: 89_000 },
        { label: "investigate.plan", ms: 10 },
        { label: "investigate.p1", ms: 19_000 },
      ],
      // p1 began at 101 s, before the prewarm ended at 120 s.
      readyBeforeInvestigateMs: -19_000,
    },
  ]);
  expect(report.metrics).toEqual([
    {
      name: "gen_ai.client.operation.duration",
      kind: "Histogram",
      attributes: { "gen_ai.provider.name": "openai" },
      count: 4,
      sum: 20,
      max: 9,
    },
    {
      name: "nodejs.eventloop.delay.p99",
      kind: "Gauge",
      attributes: {},
      value: 0.031,
    },
  ]);
});

// Why: a log written before the tool-call, slot-wait and setup spans existed must read "not
// recorded" for those parts, never 0 s of tools or "no prewarm", which would misstate the run.
test("an older log's missing parts read as not recorded, not as zero", () => {
  const report = attribute(
    run([
      span("harness.agent", 11, 100, { "harness.agent": "understand" }),
      span("harness.model-call", 11, 61, {
        "harness.agent": "understand",
        "harness.turn": 1,
      }),
    ]),
  );
  const part = report.agents[0]!.breakdown;
  expect(part.toolMs).toBeNull();
  expect(part.toolCalls).toBeNull();
  expect(part.slotWaitMs).toBeNull();
  expect(report.prewarm).toBeNull();
  expect(report.setup).toBeNull();
  const text = formatAttribution(report);
  expect(text).toContain("Search prewarm: not recorded in this log");
  expect(text).toContain("Between Precompute and Understand: not recorded");
  expect(text).not.toMatch(/^\s+tool calls\s/m);
  expect(text).toContain("slot wait and tool calls not split");
  // Without slot-wait spans, when a slot was taken is not known either.
  expect(report.slots).toBeNull();
});
