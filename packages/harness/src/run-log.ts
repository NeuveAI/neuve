import {
  openTelemetryLedger,
  telemetryLoss,
  pruneTelemetryLedgers,
} from "./telemetry-loss.ts";
import { appendFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { Exit, Option, Tracer } from "effect";
import { isCompiled } from "./compiled.ts";
import {
  STORE_DIRECTORY_MODE,
  STORE_FILE_MODE,
  type StoreLocation,
} from "@neuve/records-core";

/**
 * The run log (proposal §3.8, §12 H1): one JSON line per telemetry record of a run, in
 * `<store>/run-logs/<run-id>.jsonl`. Records is the source of truth for stages, gaps and the
 * receipt (`stage.completed@1`, `gap.disclosed@1`, `run.completed@1`: 10.32); the run log keeps
 * its telemetry role, with copies of those records beside the model calls, tool calls, spans and
 * measurements that only it holds, and is what a run in progress is followed by. It is the local
 * sink of the telemetry layer while enabled (12.55, telemetry.ts): every timing is a `span` record, with its span
 * events, or a `metric` record written at the attempt's end. Prompt bodies, tool content and
 * credentials never enter it: model calls carry usage and shape, tool calls a hash of their
 * arguments, spans and metrics names, counts, offsets and identifiers.
 */

export const runLogDirectory = (location: StoreLocation) =>
  join(location.directory, "run-logs");

export const runLogPath = (location: StoreLocation, runId: string) =>
  join(runLogDirectory(location), `${runId}.jsonl`);

export const admissionLogPath = (location: StoreLocation, requestId: string) =>
  join(location.directory, "admission-logs", `${requestId}.jsonl`);

export interface RunLogRecord {
  readonly type: string;
  readonly at?: string;
  readonly [field: string]: unknown;
}

export interface RunLog {
  readonly path: string;
  readonly telemetryEnabled?: boolean;
  readonly write: (record: RunLogRecord) => void;
  readonly read: () => ReadonlyArray<RunLogRecord>;
  /** Bounded asynchronous observation; failures never reach the observed operation. */
  readonly enqueue?: ((record: RunLogRecord) => void) | undefined;
  readonly flush?: (() => Promise<void>) | undefined;
}

/** Gate both synchronous and queued writers without dropping receipt or progress records. */
export const withTelemetry = (log: RunLog, enabled: boolean): RunLog => {
  const keep = (record: RunLogRecord) =>
    enabled || !["span", "span.start", "metric"].includes(record.type);
  return {
    ...log,
    telemetryEnabled: enabled,
    write: (record) => {
      if (keep(record)) log.write(record);
    },
    ...(log.enqueue === undefined
      ? {}
      : {
          enqueue: (record: RunLogRecord) => {
            if (keep(record)) log.enqueue?.(record);
          },
        }),
  };
};

export const enqueueTelemetry = (
  log: RunLog | undefined,
  record: RunLogRecord,
) => {
  if (!log) return;
  try {
    if (log.enqueue) log.enqueue(record);
    else
      queueMicrotask(() => {
        try {
          log.write(record);
        } catch {
          /* Observation cannot fail the operation. */
        }
      });
  } catch {
    /* A custom observation sink must not change execution. */
  }
};

const readRecords = (path: string): ReadonlyArray<RunLogRecord> => {
  if (!existsSync(path)) return [];
  const seen = new Set<string>();
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      try {
        const record = JSON.parse(line) as RunLogRecord;
        const id = record["telemetryId"];
        if (typeof id === "string") {
          if (seen.has(id)) return [];
          seen.add(id);
        }
        return [record];
      } catch {
        // A line cut short by a crash mid-write; the records before it stand.
        return [];
      }
    });
};

export const readRunLog = (path: string): ReadonlyArray<RunLogRecord> => {
  const loss = telemetryLoss(path);
  const records = readRecords(path);
  return [...records, ...loss(records)];
};

const activeLogs = new Map<
  string,
  { flush: () => Promise<void>; flushSync: () => void }
>();
export const flushRunLogs = async () => {
  await Promise.all([...activeLogs.values()].map((log) => log.flush()));
};
process.on("beforeExit", () => {
  void flushRunLogs();
});
process.on("exit", () => {
  for (const log of activeLogs.values()) log.flushSync();
});

/** Run IDs that have a run log, newest first (run IDs are ULIDs). */
export const listRunLogs = (location: StoreLocation) => {
  const directory = runLogDirectory(location);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => name.slice(0, -".jsonl".length))
    .sort()
    .reverse();
};

/**
 * Opens a run's log. Existing control records append synchronously; observations enqueue into
 * a bounded asynchronous sink. Reads include queued observations without double-counting them.
 */
export const openRunLog = (
  location: StoreLocation,
  runId: string,
  telemetryEnabled = !isCompiled(),
): RunLog => {
  return withTelemetry(
    openLog(runLogDirectory(location), runLogPath(location, runId)),
    telemetryEnabled,
  );
};

/** An admission may never produce a run; keep it outside run discovery. */
export const openAdmissionLog = (
  location: StoreLocation,
  requestId: string,
  telemetryEnabled = !isCompiled(),
): RunLog =>
  withTelemetry(
    openLog(
      join(location.directory, "admission-logs"),
      admissionLogPath(location, requestId),
    ),
    telemetryEnabled,
  );

let nextRetentionAt = 0;
const openLog = (directory: string, path: string): RunLog => {
  if (Date.now() >= nextRetentionAt) {
    nextRetentionAt = Date.now() + 60_000;
    pruneTelemetryLedgers(join(directory, "..", "telemetry-state"));
  }
  let openingFailed = false;
  try {
    mkdirSync(directory, {
      recursive: true,
      mode: STORE_DIRECTORY_MODE,
    });
  } catch {
    openingFailed = true;
  }
  const writer = randomUUID();
  let sequence = 0;
  let lost = 0;
  let dropped = 0;
  let failures = openingFailed ? 1 : 0;
  let ledger: ReturnType<typeof openTelemetryLedger> | undefined;
  // Allocate accounting only when observations arrive. Successful flushes retire it.
  let ledgerUnavailable = false;
  const ensureLedger = () => {
    if (ledger || ledgerUnavailable) return;
    try {
      ledger = openTelemetryLedger(path, writer);
    } catch {
      ledgerUnavailable = true;
      failures++;
      try {
        appendFileSync(
          path,
          JSON.stringify({
            type: "telemetry.loss",
            writer,
            recordsLost: null,
            accounting: "unavailable",
          }) + "\n",
          { mode: STORE_FILE_MODE },
        );
      } catch {
        /* No writable telemetry sink remains. */
      }
    }
  };
  const settleLedger = () => {
    ledger?.set("settled", 1);
    if (failures === 0 && dropped === 0) {
      ledger?.remove();
      ledger = undefined;
    }
  };
  const pending = new Map<string, RunLogRecord>();
  let draining: Promise<void> | undefined;
  const drain = async () => {
    while (pending.size > 0) {
      const batch = [...pending.entries()].slice(0, 32);
      try {
        await appendFile(
          path,
          batch
            .map(([, record]) => record)
            .map((record) => JSON.stringify(record) + "\n")
            .join(""),
          { mode: STORE_FILE_MODE },
        );
      } catch {
        lost += batch.length;
        failures++;
        ledger?.set("failures", failures);
      }
      for (const [id] of batch) pending.delete(id);
    }
  };
  const kick = () => {
    if (draining) return;
    draining = Promise.resolve()
      .then(drain)
      .finally(() => {
        draining = undefined;
        if (pending.size) kick();
        else {
          settleLedger();
          activeLogs.delete(writer);
        }
      });
  };
  const flush = async () => {
    while (draining) await draining;
  };
  const flushSync = () => {
    try {
      if (pending.size)
        appendFileSync(
          path,
          [...pending.values()]
            .map((record) => JSON.stringify(record) + "\n")
            .join(""),
          { mode: STORE_FILE_MODE },
        );
    } catch {
      ledger?.set("failures", ++failures);
    }
    pending.clear();
    settleLedger();
    activeLogs.delete(writer);
  };
  return {
    path,
    // These records affect receipts and decisions; an append failure must reach the caller.
    write: (record) => {
      appendFileSync(
        path,
        `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`,
        { mode: STORE_FILE_MODE },
      );
    },
    enqueue: (record) => {
      ensureLedger();
      ledger?.set("settled", 0);
      ledger?.set("attempts", ++sequence);
      if (pending.size >= 1024) {
        lost++;
        ledger?.set("dropped", ++dropped);
        return;
      }
      const id = `${writer}:${sequence}`;
      pending.set(id, {
        at: new Date().toISOString(),
        ...record,
        telemetryId: id,
      });
      activeLogs.set(writer, { flush, flushSync });
      kick();
    },
    flush,
    read: () => {
      const loss = telemetryLoss(path);
      const records = readRecords(path);

      const held = new Set(records.map((record) => record["telemetryId"]));
      const all = [
        ...records,
        ...[...pending]
          .filter(([id]) => !held.has(id))
          .map(([, record]) => record),
        ...(!ledger && (lost || failures)
          ? [
              {
                type: "telemetry.loss",
                recordsLost: lost,
                writeFailures: failures,
              },
            ]
          : []),
      ];
      return [...all, ...loss(all)];
    },
  };
};

/** Spans recorded by the active harness runtime. */
const KEPT_SPANS = /^harness\./;

/**
 * Span events worth keeping: the harness's own, named in code (telemetry.ts). Events Effect makes
 * from log lines are dropped, for the run log and OTLP alike: their name is the log message and
 * their attributes may hold an error's text.
 */
const KEPT_EVENTS = /^(harness\.|gen_ai\.)/;

/** At most this many events per span; later ones are counted on the span record. */
export const MAX_SPAN_EVENTS = 256;

/** Span attributes that describe a call, never its content. */
const isMetadataAttribute = (key: string) =>
  (/^(gen_ai\.|harness\.|error\.type$|http\.response\.status_code$|http\.response\.header\.x-codex-safety-buffering-)/.test(
    key,
  ) ||
    ["toolChoice", "concurrency", "objectName"].includes(key)) &&
  !/prompt|completion|content|parameters|result|message/i.test(key);

const metadataOf = (attributes: Record<string, unknown> | undefined) =>
  Object.fromEntries(
    Object.entries(attributes ?? {}).filter(([key]) =>
      isMetadataAttribute(key),
    ),
  );

const nanosToIso = (nanos: bigint) =>
  new Date(Number(nanos / 1_000_000n)).toISOString();

/** Milliseconds between two span timestamps, to 0.1 ms. */
const nanosToMs = (nanos: bigint) => Number(nanos / 100_000n) / 10;

const jsonValue = (value: unknown): unknown => {
  if (typeof value === "bigint") return value.toString();
  if (value === null || ["string", "number", "boolean"].includes(typeof value))
    return value;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return String(value);
  }
};

/**
 * A tracer that writes each kept span to the run log when it ends, as a `span` record with its
 * attributes and its events (telemetry.ts). Each event carries its time
 * and its offset from the span's start. It wraps another tracer, Effect's native one or the OTLP
 * exporter the user configured, so enabled telemetry reaches the run log and OTLP stays a copy for the
 * user's own tools (10.32).
 */
export const runLogTracer = (
  log: RunLog,
  inner: Tracer.Tracer = Tracer.nativeTracer,
): Tracer.Tracer => {
  if (log.telemetryEnabled === false) return Tracer.nativeTracer;
  return Tracer.make({
    span: (options) => {
      const span = inner.span(options);
      // Content never enters a span, for the run log or OTLP: Effect's AI spans also carry a tool
      // call's parameters, so only metadata attributes are kept (proposal §3.8).
      const attribute = span.attribute.bind(span);
      span.attribute = (key: string, value: unknown) => {
        if (isMetadataAttribute(key)) attribute(key, value);
      };
      const kept = KEPT_SPANS.test(options.name);
      const events: Array<{
        readonly name: string;
        readonly at: string;
        readonly offsetMs: number;
        readonly attributes?: Record<string, unknown>;
      }> = [];
      let eventsDropped = 0;
      const event = span.event.bind(span);
      span.event = (
        name: string,
        startTime: bigint,
        attributes?: Record<string, unknown>,
      ) => {
        if (!KEPT_EVENTS.test(name)) return;
        const metadata = metadataOf(attributes);
        event(name, startTime, metadata);
        if (!kept) return;
        if (events.length >= MAX_SPAN_EVENTS) {
          eventsDropped += 1;
          return;
        }
        events.push({
          name,
          at: nanosToIso(startTime),
          offsetMs: nanosToMs(startTime - options.startTime),
          ...(Object.keys(metadata).length === 0
            ? {}
            : {
                attributes: Object.fromEntries(
                  Object.entries(metadata).map(([key, value]) => [
                    key,
                    jsonValue(value),
                  ]),
                ),
              }),
        });
      };
      if (!kept) return span;
      enqueueTelemetry(log, {
        type: "span.start",
        name: span.name,
        traceId: span.traceId,
        spanId: span.spanId,
        parentSpanId: Option.getOrUndefined(span.parent)?.spanId,
        start: nanosToIso(options.startTime),
        attributes: Object.fromEntries(
          [...span.attributes]
            .filter(([key]) => isMetadataAttribute(key))
            .map(([key, value]) => [key, jsonValue(value)]),
        ),
      });
      const end = span.end.bind(span);
      span.end = (endTime: bigint, exit: Exit.Exit<unknown, unknown>) => {
        end(endTime, exit);
        const parent = Option.getOrUndefined(span.parent);
        enqueueTelemetry(log, {
          type: "span",
          name: span.name,
          traceId: span.traceId,
          spanId: span.spanId,
          parentSpanId: parent?.spanId,
          start: nanosToIso(options.startTime),
          durationMs: Number((endTime - options.startTime) / 1_000_000n),
          status: Exit.isSuccess(exit)
            ? "ok"
            : Exit.hasInterrupts(exit)
              ? "interrupted"
              : "error",
          attributes: Object.fromEntries(
            [...span.attributes]
              .filter(([key]) => isMetadataAttribute(key))
              .map(([key, value]) => [key, jsonValue(value)]),
          ),
          ...(events.length === 0 ? {} : { events }),
          ...(eventsDropped === 0 ? {} : { eventsDropped }),
        });
      };
      return span;
    },
    ...(inner.context === undefined ? {} : { context: inner.context }),
  });
};
