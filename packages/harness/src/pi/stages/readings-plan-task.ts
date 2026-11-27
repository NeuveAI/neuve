import type { Task, TaskRuntime, Tx } from "@earendil-works/pi-durable";
import { preparationDeadline } from "../../budget.ts";
import { logTimed, scopedLogSpan, startLogSpan } from "../../log-span.ts";
import { outcomeOf, resultOf } from "./children.ts";
import type { RunLog } from "../../run-log.ts";
import { definePolicyTask as defineTask } from "../failure-policy.ts";
import {
  childOf,
  type Reading,
  type ReadingsPrepareInput,
  type ReviewStagesPort,
} from "../review-task.ts";

/** Waits for Map, then prepares and creates the review's reading tasks in a single commit. */
export const READINGS_PLAN_TASK = "neuve.readings-plan";
export type ReadingsPlanInput = ReadingsPrepareInput;
export type ReadingsPlanResult = {
  /** `published`: its plan came back after the review went to Publish, so it created no reading. */
  readonly status: "ok" | "failed" | "cutoff" | "stopped" | "published";
  /** The readings `create` made, in creation order; empty unless `ok`. */
  readonly readings: ReadonlyArray<Reading>;
};
type Readings = NonNullable<ReviewStagesPort["readings"]>;
type Prepared = Awaited<ReturnType<Readings["prepare"]>>;
type PlanCheckpoint = { readonly phase: "run" };
type Runtime = TaskRuntime<
  ReadingsPlanInput,
  PlanCheckpoint,
  ReadingsPlanResult,
  object
>;
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
/** A label that may be counted: a short word of letters and underscores. */
const LABEL = /^[A-Za-z_]{1,40}$/;
/**
 * A failure's kind as a label, never its text: its `_tag`, else an error's name (`ZodError` for a
 * schema the plan's tasks did not fit), else `Error`.
 */
const failureTag = (error: unknown): string => {
  const tag = (error as { _tag?: unknown } | null | undefined)?._tag;
  if (typeof tag === "string" && LABEL.test(tag)) return tag;
  const name = error instanceof Error ? error.name : undefined;
  return name !== undefined && LABEL.test(name) ? name : "Error";
};
/** Whether the review may still read readings: live, and not yet at Publish. */
const reading = (review: Awaited<ReturnType<Tx["task"]>>) =>
  review?.state.checkpoint !== undefined &&
  (review.state.checkpoint as { readonly phase?: unknown }).phase !== "publish";

export const readingsPlanTask = (
  log: RunLog | undefined,
  readings: Readings | undefined,
): Task<ReadingsPlanInput, PlanCheckpoint, ReadingsPlanResult, object> => {
  const attributes = (runtime: Runtime) => ({
    "harness.task_id": runtime.taskId,
    "harness.task_kind": "readings-plan",
    "harness.phase": "run",
  });
  /** The terminal commit, as its own span like every other phase-end commit. */
  const commit = (runtime: Runtime, work: () => Promise<void>) =>
    logTimed(
      log,
      "harness.pi.commit",
      { ...attributes(runtime), "harness.next_phase": "terminal" },
      work,
    );
  /**
   * `prepare`, bounded by `bound`. It never fails the plan: when it throws (even synchronously) or
   * the bound ends it, the plan ends without readings. A stop still stops: with the task's own
   * signal aborted, its error propagates. Its span is in-process work, not a durable wait, and ends
   * once; one `readings.prepare` row says how it ended, except at a stop.
   */
  const prepare = async (
    runtime: Runtime,
    port: Readings,
    input: Parameters<Readings["prepare"]>[0],
    owner: number,
    bound: number,
  ): Promise<
    | { readonly status: "ok"; readonly prepared: Prepared }
    | { readonly status: "failed" | "cutoff" }
  > => {
    const end = startLogSpan(
      log,
      "harness.readings.prepare",
      attributes(runtime),
    );
    const from = runtime.now();
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), Math.max(0, bound - from));
    const signal = AbortSignal.any([runtime.signal, stop.signal]);
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    // A synchronous throw becomes a rejection; a call left behind by the race never goes unhandled.
    let call: Promise<Prepared>;
    try {
      call = Promise.resolve(port.prepare(input, signal));
    } catch (error) {
      call = Promise.reject(error);
    }
    call.catch(() => {});
    aborted.catch(() => {});
    let ended:
      | { readonly status: "ok"; readonly prepared: Prepared }
      | { readonly status: "cutoff" }
      | { readonly status: "failed"; readonly tag?: string }
      | { readonly status: "stopped"; readonly error: unknown };
    try {
      const prepared = await Promise.race([call, aborted]);
      ended = runtime.signal.aborted
        ? { status: "stopped", error: runtime.signal.reason }
        : // Past the bound its plan is not used, even when it returned one.
          stop.signal.aborted
          ? { status: "cutoff" }
          : { status: "ok", prepared };
    } catch (error) {
      ended = runtime.signal.aborted
        ? { status: "stopped", error }
        : stop.signal.aborted
          ? { status: "cutoff" }
          : { status: "failed", tag: failureTag(error) };
    } finally {
      clearTimeout(timer);
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    }
    if (ended.status === "stopped") {
      end("error");
      throw ended.error ?? new Error("the readings plan was stopped");
    }
    log?.write({
      type: "readings.prepare",
      taskId: owner,
      status: ended.status,
      // What kind of failure it was, so a failed plan names itself: a label, never its text.
      ...(ended.status === "failed" && ended.tag !== undefined
        ? { tag: ended.tag }
        : {}),
      durationMs: Math.max(0, runtime.now() - from),
    });
    end(ended.status === "ok" ? "ok" : "error");
    return ended;
  };
  return defineTask<ReadingsPlanInput, PlanCheckpoint, ReadingsPlanResult>({
    name: READINGS_PLAN_TASK,
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      run: async (task, runtime, context) => {
        using phaseSpan = scopedLogSpan(
          log,
          "harness.pi.phase",
          attributes(runtime),
        );
        const owner = (await runtime.getTask(runtime.taskId, context))?.owner;
        if (owner === undefined)
          throw new Error("a readings plan is always owned by its review");
        // The head gate, when the review created one, goes on to every reading (`readingTaskInputs`).
        const front = resultOf(
          await outcomeOf(runtime, task.input.front, context),
        );
        const input = {
          manifestKey: task.input.manifestKey,
          cutoffAt: task.input.cutoffAt,
          frameKey: front?.frameKey,
          mapKey: front?.mapKey,
          ...(task.input.relations === undefined
            ? {}
            : { relations: task.input.relations }),
        };
        let ended: Awaited<ReturnType<typeof prepare>>;
        if (
          readings === undefined ||
          input.frameKey == null ||
          input.mapKey == null
        ) {
          log?.write({
            type: "readings.prepare",
            taskId: owner,
            status: "failed",
            durationMs: 0,
          });
          ended = { status: "failed" };
        } else
          ended = await prepare(
            runtime,
            readings,
            { ...input, frameKey: input.frameKey, mapKey: input.mapKey },
            owner,
            preparationDeadline(runtime.now(), task.input.cutoffAt),
          );
        let created: ReadonlyArray<Reading> = [];
        await commit(runtime, () =>
          runtime.commit(async (tx) => {
            // The readings start in this commit; the review, which owns them, waits on them. A
            // review that already went to Publish (its Frame or Map fell back) reads none, and one
            // that is completing can own no new task: neither gets a reading.
            const late =
              ended.status === "ok" && !reading(await tx.task(owner));
            created =
              ended.status === "ok" && !late && readings !== undefined
                ? (await readings.create(tx, ended.prepared, owner)).map(
                    ({ name, task: id }) => ({ name, task: id }),
                  )
                : [];
            return {
              status: "terminal",
              outcome: {
                status: "completed",
                result: json({
                  status: late ? "published" : ended.status,
                  readings: created,
                }),
              },
            };
          }, context),
        );
        for (const reading of created)
          log?.write({
            type: "task.inputs",
            taskId: reading.task,
            owner,
            kind: "reading",
            inputs: {
              manifest: `computation:${task.input.manifestKey}`,
              map: `computation:${input.mapKey}`,
            },
          });
      },
    },
    abort: (_task, runtime, context) =>
      commit(runtime, () =>
        runtime.commit(
          () => ({
            status: "terminal",
            outcome: {
              status: "aborted",
              reason: "stopped",
              result: { status: "stopped", readings: [] },
            },
          }),
          context,
        ),
      ),
  });
};

/**
 * The readings' part of the review's stage port, from the readers' port when the run's
 * configuration has one: the port and the plan's starter together, or neither. The plan task is
 * returned either way, for the stages extension to register.
 */
export const readingsStages = (
  log: RunLog | undefined,
  readings: Readings | undefined,
) => {
  const task = readingsPlanTask(log, readings);
  const port: Pick<ReviewStagesPort, "readings" | "readingsPlan"> =
    readings === undefined ? {} : { readings, readingsPlan: childOf(task) };
  return { task, port };
};
