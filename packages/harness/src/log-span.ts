import { randomUUID } from "node:crypto";
import { enqueueTelemetry, type RunLog } from "./run-log.ts";

/** A synchronous start survives interruption before the operation's promise settles. */
export const startLogSpan = (
  log: RunLog | undefined,
  name: string,
  attributes: Record<string, string | number> = {},
) => {
  if (log === undefined || log.telemetryEnabled === false)
    return (_status = "ok") => {};
  const spanId = randomUUID();
  const start = new Date().toISOString();
  const from = performance.now();
  enqueueTelemetry(log, {
    type: "span.start",
    name,
    spanId,
    start,
    attributes,
  });
  return (status = "ok") =>
    enqueueTelemetry(log, {
      type: "span",
      name,
      spanId,
      start,
      durationMs: performance.now() - from,
      attributes,
      status,
    });
};

export const logTimed = async <T>(
  log: RunLog | undefined,
  name: string,
  attributes: Record<string, string | number>,
  work: () => Promise<T>,
): Promise<T> => {
  const end = startLogSpan(log, name, attributes);
  try {
    const result = await work();
    end();
    return result;
  } catch (error) {
    end("error");
    throw error;
  }
};

/**
 * A durable task's waits as `harness.pi.wait` spans: one opens after a `waiting` commit, naming what
 * it waits on, and ends when the task's next phase (or its abort) starts in this process. Telemetry
 * only, held per task factory; a wait a restart cut short keeps its `span.start` and no end, and the
 * host's `harness.pi.task` span for the `waiting` status still measures it.
 */
export const waitSpans = (log: RunLog | undefined) => {
  const open = new Map<number, (status?: string) => void>();
  return {
    waiting: (task: number, attributes: Record<string, string | number>) => {
      open.get(task)?.("superseded");
      open.set(task, startLogSpan(log, "harness.pi.wait", attributes));
    },
    resumed: (task: number) => {
      open.get(task)?.();
      open.delete(task);
    },
  };
};

/** Scope-local bookkeeping around a pi phase, including its synchronous work before a commit. */
export const scopedLogSpan = (
  log: RunLog | undefined,
  name: string,
  attributes: Record<string, string | number>,
) => ({ [Symbol.dispose]: startLogSpan(log, name, attributes) });
