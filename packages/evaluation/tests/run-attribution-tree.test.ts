// Why: a cut-off must preserve a live call, and concurrent jobs must never double-count wall time.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attributeTree,
  formatAttributionTree,
  readAttributionLogs,
} from "../src/harness-compare/run-attribution-tree.ts";
const iso = (ms: number) =>
  new Date(Date.parse("2026-11-02T10:00:00Z") + ms).toISOString();
const start = { type: "run.started", runId: "cutoff", at: iso(0) };

test("separate admission logs join the report without expanding run coverage", () => {
  const root = mkdtempSync(join(tmpdir(), "admission-attribution-"));
  try {
    mkdirSync(join(root, "run-logs"));
    mkdirSync(join(root, "admission-logs"));
    const path = join(root, "run-logs", "r.jsonl");
    writeFileSync(
      path,
      [start, { type: "run.completed", at: iso(1000) }]
        .map((record) => JSON.stringify(record))
        .join("\n"),
    );
    writeFileSync(
      join(root, "admission-logs", "r.jsonl"),
      JSON.stringify({
        type: "span",
        name: "harness.admission.review-submit",
        spanId: "submit",
        start: iso(-100),
        durationMs: 100,
        at: iso(0),
      }),
    );
    const report = attributeTree(readAttributionLogs(path)[0]!.records);
    expect(report.wallMs).toBe(1000);
    expect(report.attributedMs).toBe(0);
    expect(formatAttributionTree(report)).toContain(
      "harness.admission.review-submit: 0.100 s",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a snapshot at cut-off attributes a call that has no terminal record", () => {
  const report = attributeTree(
    [
      start,
      {
        type: "stage.start",
        stage: "understand",
        agent: "understand",
        at: iso(0),
      },
      {
        type: "model.call.start",
        call: "c1",
        stage: "understand",
        agent: "understand",
        startedAt: iso(0),
        at: iso(0),
      },
      {
        type: "model.call.progress",
        call: "c1",
        at: iso(950),
        blocks: { toolArguments: { deltas: 30, characters: 70 } },
      },
      { type: "model.call", call: "c1", streamEndAt: iso(1200), at: iso(1200) },
    ],
    { until: iso(1000) },
  );
  expect(report.wallMs).toBe(1000);
  expect(report.attributedMs).toBe(1000);
  expect(report.unattributedMs).toBe(0);
  expect(report.work).toEqual([
    expect.objectContaining({
      stage: "understand",
      job: "understand",
      kind: "call",
      inFlight: true,
      end: Date.parse(iso(1000)),
    }),
  ]);
  expect(formatAttributionTree(report)).toContain(
    "[in flight at observation end]",
  );
});

test("an in-flight briefing call ends at its agent's finished stage whatever the labels say", () => {
  const report = attributeTree([
    start,
    {
      type: "model.call.start",
      call: "part",
      stage: "brief",
      agent: "brief.g1",
      startedAt: iso(100),
      at: iso(100),
    },
    {
      type: "model.call.start",
      call: "digest",
      stage: "verify",
      agent: "digest.b.1",
      startedAt: iso(200),
      at: iso(200),
    },
    {
      type: "stage",
      stage: "verify",
      agent: "brief.g1",
      wallMs: 500,
      at: iso(600),
    },
    {
      type: "stage",
      stage: "verify",
      agent: "digest.b.1",
      wallMs: 500,
      at: iso(700),
    },
    { type: "run.completed", at: iso(1000) },
  ]);
  const calls = report.work.filter((work) => work.kind === "call");
  expect(calls).toEqual([
    expect.objectContaining({
      job: "brief.g1",
      stage: "brief",
      inFlight: true,
      end: Date.parse(iso(600)),
    }),
    expect.objectContaining({
      job: "digest.b.1",
      stage: "verify",
      inFlight: true,
      end: Date.parse(iso(700)),
    }),
  ]);
});

test("overlapping calls and phase spans count each millisecond once", () => {
  const report = attributeTree([
    start,
    {
      type: "span",
      spanId: "phase",
      name: "harness.stage.publish",
      start: iso(0),
      durationMs: 1000,
      at: iso(1000),
    },
    {
      type: "model.call",
      call: "a",
      stage: "investigate",
      agent: "a",
      startedAt: iso(100),
      latencyMs: 600,
      at: iso(700),
    },
    {
      type: "model.call",
      call: "b",
      stage: "investigate",
      agent: "b",
      startedAt: iso(200),
      latencyMs: 600,
      at: iso(800),
    },
    { type: "run.completed", at: iso(1000) },
  ]);
  expect(report.attributedMs).toBe(1000);
  expect(report.unattributedMs).toBe(0);
  expect(report.work[0]?.stage).toBe("publish");
});

test("an old end-only stage does not turn missing model telemetry into code time", () => {
  const report = attributeTree([
    start,
    {
      type: "stage",
      stage: "understand",
      agent: "understand",
      wallMs: 1000,
      at: iso(1000),
    },
    {
      type: "model.call",
      call: "a",
      stage: "understand",
      agent: "understand",
      startedAt: iso(0),
      latencyMs: 200,
      at: iso(200),
    },
    { type: "run.completed", at: iso(1000) },
  ]);
  expect(report.unattributedMs).toBe(800);
  expect(formatAttributionTree(report)).toContain(
    "understand: 1.000 s\n  unattributed: 0.800 s",
  );
});

test("an old running computation is clipped to the observation end and never claimed as run coverage", () => {
  const directory = mkdtempSync(join(tmpdir(), "attribution-attempts-"));
  const path = join(directory, "records.sqlite");
  const db = new Database(path);
  db.exec(
    "CREATE TABLE computation_attempts(op TEXT, started_at TEXT, ended_at TEXT); CREATE TABLE jobs(event_id TEXT, job_seq INTEGER, enqueued_at TEXT, started_at TEXT)",
  );
  db.query("INSERT INTO computation_attempts VALUES (?, ?, NULL)").run(
    "harness.range-manifest",
    iso(100),
  );
  db.close();
  try {
    const report = attributeTree(
      [start, { type: "run.completed", at: iso(1000) }],
      { store: path },
    );
    expect(report.computations).toEqual([
      {
        op: "harness.range-manifest",
        count: 1,
        running: 1,
        minMs: 900,
        p50Ms: 900,
        p95Ms: 900,
        maxMs: 900,
      },
    ]);
    expect(report.unattributedMs).toBe(1000);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// A different batch can be in another stage at the same time. A timestamp is not ownership.
test("pi scheduling and unscoped phases do not inherit another job's overlapping stage", () => {
  const report = attributeTree([
    start,
    {
      type: "stage",
      stage: "dispose",
      agent: "dispose.other",
      wallMs: 1000,
      at: iso(1000),
    },
    {
      type: "span",
      spanId: "phase",
      name: "harness.pi.phase",
      start: iso(200),
      durationMs: 200,
      at: iso(400),
      attributes: { "harness.task_kind": "batch", "harness.task_id": 7 },
    },
    {
      type: "pi.task",
      taskId: 7,
      kind: "neuve.batch",
      status: "running",
      at: iso(100),
    },
    {
      type: "pi.task",
      taskId: 7,
      kind: "neuve.batch",
      status: "terminal",
      at: iso(500),
    },
    { type: "run.completed", at: iso(1000) },
  ]);
  expect(
    report.work.every((part) => part.stage === "between stages"),
  ).toBeTrue();
});

test("repeated phase distributions report the nearest-rank tail and retain admission before run start", () => {
  const report = attributeTree([
    {
      ...start,
      enqueuedAt: iso(-100),
      claimedAt: iso(-30),
      claimToRunStartMs: 30,
      jobSeq: 2,
    },
    {
      type: "span",
      spanId: "one",
      name: "harness.precompute.tree-index",
      start: iso(0),
      durationMs: 100,
      at: iso(100),
    },
    {
      type: "span",
      spanId: "two",
      name: "harness.precompute.tree-index",
      start: iso(100),
      durationMs: 800,
      at: iso(900),
    },
    { type: "run.completed", at: iso(1000) },
  ]);
  expect(formatAttributionTree(report)).toContain("p95=0.800 s");
  expect(report.admission).toEqual([
    expect.objectContaining({
      name: "claim to run start",
      start: Date.parse(iso(-30)),
      end: Date.parse(iso(0)),
    }),
  ]);
});

// Regression from independent review: a parent waiting is no evidence of its child's work.
test("a waiting parent does not explain an unrecorded Understand call", () => {
  const report = attributeTree([
    start,
    {
      type: "pi.task",
      taskId: 1,
      kind: "neuve.review",
      status: "running",
      at: iso(0),
    },
    {
      type: "span",
      spanId: "setup",
      name: "harness.run.setup",
      start: iso(0),
      durationMs: 1000,
      at: iso(1000),
    },
    {
      type: "pi.task",
      taskId: 1,
      kind: "neuve.review",
      status: "waiting",
      at: iso(1000),
    },
    {
      type: "stage.start",
      stage: "understand",
      agent: "understand",
      at: iso(1000),
    },
    {
      type: "pi.task",
      taskId: 1,
      kind: "neuve.review",
      status: "running",
      at: iso(100000),
    },
    { type: "run.completed", at: iso(100000) },
  ]);
  expect(report.attributedMs).toBe(1000);
  expect(report.unattributedMs).toBe(99000);
  expect(formatAttributionTree(report)).toContain("waiting on children");
  expect(formatAttributionTree(report)).toContain(
    "Unattributed: 99.000 s (99.00%)",
  );
});

test("the gap before a later task phase is not measured scheduling time", () => {
  const report = attributeTree([
    start,
    {
      type: "pi.task",
      taskId: 7,
      kind: "neuve.batch",
      status: "running",
      at: iso(0),
    },
    {
      type: "span",
      spanId: "later",
      name: "harness.pi.phase",
      start: iso(90000),
      durationMs: 10000,
      at: iso(100000),
      attributes: { "harness.task_id": 7 },
    },
    { type: "run.completed", at: iso(100000) },
  ]);
  expect(report.attributedMs).toBe(10000);
  expect(report.unattributedMs).toBe(90000);
});

// A recovered forced-exit loss must be visible in the command's human-readable result.
test("the attribution report discloses observation loss independently of coverage", () => {
  const report = attributeTree([
    start,
    {
      type: "telemetry.loss",
      writer: "w",
      recordsLost: 2,
      pendingRecords: 0,
      writeFailures: 1,
    },
    { type: "run.completed", at: iso(1000) },
  ]);
  expect(report.unattributedMs).toBe(1000);
  expect(formatAttributionTree(report)).toContain(
    "Telemetry loss at read time (w): 2 lost, 0 pending, 1 write failures",
  );
});
