import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { readAsItStands, readWithoutLog } from "@neuve/records-core/read-only";
import { readRunLogs, type LogRecord } from "./run-attribution.ts";

/** Admission is outside run discovery and outside the run's wall time. */
export const readAttributionLogs = (path: string, admission?: string) => {
  const sibling = join(dirname(path), "..", "admission-logs", basename(path));
  const admissionPath =
    admission ??
    (basename(dirname(path)) === "run-logs" && existsSync(sibling)
      ? sibling
      : undefined);
  const before = admissionPath
    ? readRunLogs(admissionPath).flatMap((file) => file.records)
    : [];
  return readRunLogs(path).map((file) => ({
    ...file,
    records: [...before, ...file.records],
  }));
};

interface Interval {
  start: number;
  end: number;
}
interface Work extends Interval {
  name: string;
  stage: string;
  job: string;
  kind: string;
  inFlight: boolean;
  detail?: string | undefined;
}
export interface AttributionTree {
  runId: string;
  start: number;
  end: number;
  wallMs: number;
  attributedMs: number;
  unattributedMs: number;
  work: Work[];
  stages: Work[];
  admission: Work[];
  observationLoss: Array<{
    writer: string;
    recordsLost: number | null;
    pendingRecords: number;
    writeFailures: number;
  }>;
  cutoffs: Array<{ point: string; offsetMs: number }>;
  closePastCutoffMs: number | undefined;
  computations: Array<{
    op: string;
    count: number;
    running: number;
    minMs: number;
    p50Ms: number;
    p95Ms: number;
    maxMs: number;
  }>;
}
const number = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const string = (value: unknown) =>
  typeof value === "string" ? value : undefined;
const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value))
    : {};
const time = (value: unknown) => {
  const ms = Date.parse(string(value) ?? "");
  return Number.isFinite(ms) ? ms : undefined;
};
const union = (intervals: ReadonlyArray<Interval>) => {
  let total = 0;
  let end = -Infinity;
  for (const part of [...intervals].sort((a, b) => a.start - b.start)) {
    total += Math.max(0, part.end - Math.max(end, part.start));
    end = Math.max(end, part.end);
  }
  return total;
};
const clip = (part: Interval, window: Interval) => ({
  start: Math.max(part.start, window.start),
  end: Math.min(part.end, window.end),
});
const intersects = (part: Interval, window: Interval) =>
  part.end > window.start && part.start < window.end;

/** Start records survive a cut-off. Older end-only records and computation attempts remain usable. */
export const attributeTree = (
  input: ReadonlyArray<LogRecord>,
  options: { until?: string | undefined; store?: string | undefined } = {},
): AttributionTree => {
  const until = time(options.until);
  if (options.until !== undefined && until === undefined)
    throw new Error("--until needs an ISO timestamp");
  const records = input.filter(
    (row) => until === undefined || (time(row.at) ?? 0) <= until,
  );
  if (records.length === 0)
    throw new Error("No records at the observation time");
  const started = records.find((row) => row.type === "run.started");
  const start =
    time(started?.at) ??
    Math.min(
      ...records.flatMap((row) => time(row.start) ?? time(row.at) ?? []),
    );
  const ended = records.findLast((row) => row.type === "run.completed");
  const end =
    time(ended?.at) ??
    until ??
    Math.max(start, ...records.flatMap((row) => time(row.at) ?? []));
  const window = { start, end };
  const work: Work[] = [];
  const stages: Work[] = [];
  const stageStarts = new Map<string, LogRecord>();
  const spans = new Map<string, LogRecord>();
  const calls = new Map<string, LogRecord>();
  for (const row of records) {
    if (
      (row.type === "span.start" || row.type === "span") &&
      typeof row.spanId === "string"
    ) {
      const previous = spans.get(row.spanId);
      spans.set(row.spanId, {
        ...previous,
        ...row,
        attributes: {
          ...object(previous?.attributes),
          ...object(row.attributes),
        },
      });
    }
    if (row.type.startsWith("model.call") && typeof row.call === "string")
      calls.set(row.call, { ...calls.get(row.call), ...row });
    if (row.type === "stage" && number(row.wallMs) !== undefined) {
      const stop = time(row.at) ?? end;
      stageStarts.delete(string(row.agent) ?? string(row.stage) ?? "?");
      stages.push({
        start: stop - (number(row.wallMs) ?? 0),
        end: stop,
        name: string(row.agent) ?? string(row.stage) ?? "?",
        stage: string(row.stage) ?? "?",
        job: string(row.agent) ?? "code",
        kind: "stage",
        inFlight: false,
      });
    }
    if (row.type === "stage.start")
      stageStarts.set(string(row.agent) ?? string(row.stage) ?? "?", row);
  }
  for (const row of stageStarts.values())
    stages.push({
      start: time(row.startedAt) ?? time(row.at) ?? start,
      end,
      name: string(row.stage) ?? "?",
      stage: string(row.stage) ?? "?",
      job: string(row.agent) ?? "code",
      kind: "stage",
      inFlight: true,
    });
  const stageAt = (at: number) =>
    stages
      .filter((stage) => stage.start <= at && stage.end >= at)
      .sort((a, b) => b.start - a.start)[0]?.stage ?? "between stages";
  for (const row of spans.values()) {
    const name = string(row.name) ?? "?";
    if (name === "harness.run") continue;
    const from = time(row.start) ?? time(row.at) ?? start;
    const duration = number(row.durationMs);
    const attrs = object(row.attributes);
    const taskKind = string(attrs["harness.task_kind"]);
    const phase = string(attrs["harness.phase"]);
    const stage =
      string(attrs["harness.stage"]) ??
      (name.startsWith("harness.stage.")
        ? name.slice("harness.stage.".length).split(".")[0]
        : undefined) ??
      (taskKind === "understand"
        ? "understand"
        : taskKind === "review" && phase === "precompute"
          ? "precompute"
          : name.startsWith("harness.precompute.") ||
              name.startsWith("harness.index.")
            ? "precompute"
            : "between stages");
    work.push({
      start: from,
      end: duration === undefined ? end : from + duration,
      stage,
      job:
        string(attrs["harness.agent"]) ??
        (number(attrs["harness.task_id"]) === undefined
          ? "code"
          : `pi task ${attrs["harness.task_id"]}`),
      name: phase ? `${name}.${phase}` : name,
      kind: name.includes("wait")
        ? "wait"
        : name.includes("tool-call")
          ? "tool"
          : "code",
      inFlight: duration === undefined,
    });
  }
  for (const row of calls.values()) {
    const from = time(row.startedAt) ?? start;
    const duration = number(row.latencyMs);
    const inFlight = row.type !== "model.call";
    // A briefing call's rows say `brief` while its stage row says `verify`,
    // so the agent finds the stage row and a matching label only breaks ties.
    const agent = string(row.agent);
    const finished =
      agent === undefined
        ? []
        : stages.filter(
            (stage) =>
              !stage.inFlight && stage.job === agent && stage.end >= from,
          );
    const terminalStage =
      finished.find((stage) => stage.stage === row.stage) ??
      finished.toSorted((a, b) => a.end - b.end)[0];
    const sent = time(row.sentAt);
    const headers = time(row.headersAt);
    const firstToken = number(row.timeToFirstTokenMs);
    work.push({
      start: from,
      end:
        time(row.streamEndAt) ??
        (duration === undefined
          ? Math.min(end, terminalStage?.end ?? end)
          : from + duration),
      stage: string(row.stage) ?? stageAt(from),
      job: string(row.agent) ?? "unbound",
      name: `call ${row.call}${row.finishReason ? ` (${row.finishReason})` : ""}`,
      kind: "call",
      detail: [
        sent !== undefined && headers !== undefined
          ? `headers wait ${seconds(headers - sent)}`
          : "headers time unavailable",
        firstToken !== undefined
          ? `first token ${seconds(firstToken)}`
          : "first token unavailable",
        ...Object.entries(object(row.blocks)).map(
          ([kind, value]) =>
            `${kind}: ${number(object(value).deltas) ?? 0} deltas, ${number(object(value).characters) ?? 0} characters`,
        ),
      ].join("; "),
      inFlight,
    });
  }
  for (const row of records)
    if (row.type === "tool.call") {
      const stop = time(row.at) ?? end;
      work.push({
        start: time(row.startedAt) ?? stop - (number(row.latencyMs) ?? 0),
        end: stop,
        name: `tool ${string(row.tool) ?? string(row.name) ?? "?"}`,
        stage: string(row.stage) ?? stageAt(stop),
        job: string(row.agent) ?? "code",
        kind: "tool",
        inFlight: false,
      });
    }
  const taskStates = new Map<number, LogRecord>();
  const taskWork = (row: LogRecord, stop: number, inFlight: boolean) => {
    const from = time(row.at) ?? start;
    if (row.status !== "running" && row.status !== "waiting") return;
    work.push({
      start: from,
      end: stop,
      stage: "between stages",
      job: `pi task ${row.taskId}`,
      name: `${row.kind}: ${row.status === "waiting" ? "waiting on children" : "scheduling and code between phases"}`,
      kind: "container",
      inFlight,
    });
  };
  for (const row of records)
    if (row.type === "pi.task" && typeof row.taskId === "number") {
      const previous = taskStates.get(row.taskId);
      if (previous) taskWork(previous, time(row.at) ?? end, false);
      taskStates.set(row.taskId, row);
    }
  for (const row of taskStates.values()) taskWork(row, end, true);
  if (started) {
    const from = time(started.claimedAt);
    const claimedMs = number(started.claimToRunStartMs);
    if (from !== undefined && claimedMs !== undefined)
      work.push({
        start: from,
        end: from + claimedMs,
        stage: "admission",
        job: `job ${started.jobSeq}`,
        name: "claim to run start",
        kind: "wait",
        inFlight: false,
      });
  }
  const computations: AttributionTree["computations"] = [];
  const admission = work.filter(
    (part) =>
      part.start < start &&
      (part.name.startsWith("harness.admission.") ||
        part.stage === "admission"),
  );
  if (options.store) {
    const read = readAsItStands(options.store, (db) => {
      const queue = db
        .prepare(
          "SELECT enqueued_at, started_at, job_seq FROM jobs WHERE event_id = ? ORDER BY job_seq DESC LIMIT 1",
        )
        .get(string(started?.runId) ?? "") as
        | { enqueued_at: string; started_at: string | null; job_seq: number }
        | undefined;
      const queued = time(queue?.enqueued_at) ?? time(started?.enqueuedAt);
      const claimed = time(started?.claimedAt) ?? time(queue?.started_at);
      if (queued !== undefined && claimed !== undefined)
        admission.push({
          start: queued,
          end: claimed,
          stage: "admission",
          job: `job ${queue?.job_seq ?? started?.jobSeq}`,
          name: "queue wait before claim",
          kind: "wait",
          inFlight: false,
        });
      const rows = db
        .prepare(
          `SELECT op, started_at, ended_at FROM computation_attempts WHERE started_at < ? AND (ended_at IS NULL OR ended_at > ?) ORDER BY started_at`,
        )
        .all(
          new Date(end).toISOString(),
          new Date(start).toISOString(),
        ) as Array<{
        op: string;
        started_at: string;
        ended_at: string | null;
      }>;
      for (const op of new Set(rows.map((row) => row.op))) {
        const items = rows.filter((row) => row.op === op);
        const durations = items
          .map((row) =>
            Math.max(
              0,
              Math.min(time(row.ended_at) ?? end, end) -
                Math.max(time(row.started_at) ?? start, start),
            ),
          )
          .sort((a, b) => a - b);
        computations.push({
          op,
          count: items.length,
          running: items.filter((row) => row.ended_at === null).length,
          minMs: durations[0] ?? 0,
          p50Ms:
            durations[Math.max(0, Math.ceil(durations.length * 0.5) - 1)] ?? 0,
          p95Ms:
            durations[Math.max(0, Math.ceil(durations.length * 0.95) - 1)] ?? 0,
          maxMs: durations.at(-1) ?? 0,
        });
      }
    });
    if (read.withoutLog) console.error(readWithoutLog(options.store));
  }
  const clipped = work
    .filter((part) => intersects(part, window))
    .map((part) => ({ ...part, ...clip(part, window) }));
  const attributedMs = union(
    clipped.filter((part) => part.kind !== "container"),
  );
  return {
    runId: string(started?.runId) ?? "?",
    start,
    end,
    wallMs: end - start,
    attributedMs,
    unattributedMs: Math.max(0, end - start - attributedMs),
    work: clipped,
    cutoffs: records
      .filter((row) => row.type === "cutoff")
      .map((row) => ({
        point: string(row.point) ?? "?",
        offsetMs: (time(row.at) ?? end) - start,
      })),
    closePastCutoffMs: number(
      records.findLast((row) => row.type === "close.timing")?.pastCutoffMs,
    ),
    stages,
    admission,
    computations,
    observationLoss: input
      .filter((row) => row.type === "telemetry.loss")
      .map((row) => ({
        writer: string(row.writer) ?? "legacy",
        recordsLost: number(row.recordsLost) ?? null,
        pendingRecords: number(row.pendingRecords) ?? 0,
        writeFailures: number(row.writeFailures) ?? 0,
      })),
  };
};

const seconds = (ms: number) => `${(ms / 1000).toFixed(3)} s`;
export const formatAttributionTree = (report: AttributionTree) => {
  const lines = [
    `Run ${report.runId}: ${seconds(report.wallMs)} wall`,
    `Attributed: ${seconds(report.attributedMs)} (${((100 * report.attributedMs) / report.wallMs).toFixed(2)}%)`,
    `Unattributed: ${seconds(report.unattributedMs)} (${((100 * report.unattributedMs) / report.wallMs).toFixed(2)}%)`,
    "Tree durations are interval unions; overlapping jobs do not add to wall time. Container states are shown but excluded from coverage.",
  ];
  for (const loss of report.observationLoss)
    lines.push(
      `Telemetry loss at read time (${loss.writer}): ${loss.recordsLost ?? "unknown"} lost, ${loss.pendingRecords} pending, ${loss.writeFailures} write failures; excluded from coverage`,
    );
  for (const stage of new Set([
    ...report.stages.map((part) => part.stage),
    ...report.work.map((part) => part.stage),
  ])) {
    const parts = report.work.filter((part) => part.stage === stage);
    const windows = report.stages
      .filter((part) => part.stage === stage && part.end > part.start)
      .map((part) => clip(part, report));
    const wall = windows.length ? union(windows) : union(parts);
    lines.push(`${stage}: ${seconds(wall)}`);
    if (windows.length)
      lines.push(
        `  unattributed: ${seconds(Math.max(0, wall - union(parts.filter((part) => part.kind !== "container").flatMap((part) => windows.filter((win) => intersects(part, win)).map((win) => clip(part, win))))))}`,
      );
    for (const job of new Set(parts.map((part) => part.job))) {
      const jobs = parts.filter((part) => part.job === job);
      lines.push(`  ${job}: ${seconds(union(jobs))}`);
      const groups = Map.groupBy(jobs, (part) => `${part.kind}: ${part.name}`);
      for (const [name, group] of groups) {
        const durations = group
          .map((part) => part.end - part.start)
          .sort((a, b) => a - b);
        lines.push(
          `    ${name}: ${seconds(union(group))}${group.length > 1 ? `, n=${group.length}, p50=${seconds(durations[Math.max(0, Math.ceil(durations.length * 0.5) - 1)] ?? 0)}, p95=${seconds(durations[Math.max(0, Math.ceil(durations.length * 0.95) - 1)] ?? 0)}` : ""}${group.some((part) => part.inFlight) ? " [in flight at observation end]" : ""}${group[0]?.detail ? `; ${group[0].detail}` : ""}`,
        );
      }
    }
  }
  if (report.admission.length) {
    lines.push("Before run start, outside run wall:");
    for (const part of report.admission)
      lines.push(`  ${part.name}: ${seconds(part.end - part.start)}`);
  }
  for (const marker of report.cutoffs)
    lines.push(`Cut-off ${marker.point}: +${seconds(marker.offsetMs)}`);
  if (report.closePastCutoffMs !== undefined)
    lines.push(`Close ended ${seconds(report.closePastCutoffMs)} past cut-off`);
  if (report.computations.length) {
    lines.push(
      "Concurrent computation attempts, clipped to run window. Association by time only, excluded from coverage:",
    );
    for (const row of report.computations)
      lines.push(
        `  ${row.op}: n=${row.count}, running=${row.running}, min=${seconds(row.minMs)}, p50=${seconds(row.p50Ms)}, p95=${seconds(row.p95Ms)}, max=${seconds(row.maxMs)}`,
      );
  }
  return lines.join("\n");
};

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const path = args[0];
  if (!path)
    throw new Error(
      "usage: run-attribution-tree.ts <runlog> [--admission <jsonl>] [--store <copied.sqlite>] [--until <ISO>] [--json]",
    );
  const flag = (name: string) => {
    const at = args.indexOf(name);
    return at < 0 ? undefined : args[at + 1];
  };
  for (const file of readAttributionLogs(path, flag("--admission"))) {
    const report = attributeTree(file.records, {
      store: flag("--store"),
      until: flag("--until"),
    });
    process.stdout.write(
      `${args.includes("--json") ? JSON.stringify(report, null, 2) : formatAttributionTree(report)}\n`,
    );
  }
}
