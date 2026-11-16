import type { Task, TaskRuntime, Tx } from "@earendil-works/pi-durable";
import { findDeadline } from "../../budget.ts";
import { logTimed, scopedLogSpan, startLogSpan } from "../../log-span.ts";
import type { RunLog } from "../../run-log.ts";
import { definePolicyTask as defineTask } from "../failure-policy.ts";
import {
  childOf,
  type Reading,
  type ReadingsPrepareInput,
  type ReviewStagesPort,
} from "../review-task.ts";

/**
 * The readings' plan (NEU-148): the review creates this task in the commit that creates the front
 * task, the moment its only inputs (the range manifest's key and the front task's ID) exist. It runs
 * the readings' `prepare` beside Frame and Map, then creates the reading tasks in its own terminal
 * commit, and its result names them in creation order.
 *
 * - **Owner.** The review owns this task and every reading it creates (`create`'s owner is this
 *   task's owner), as it owns the finders the front task creates. The review waits for this task
 *   beside the finders, before Link, and then on the readings it names; nothing else waits for it.
 * - **The bound.** `prepare` is bounded by `findDeadline` measured as the plan starts (at most 75 s
 *   before the cut-off), and raced against its signal: one that throws, is cut off or ignores its
 *   signal ends the plan without readings, with one `readings.prepare` row saying how (`taskId` is
 *   the review's), and nothing in the packet. A call that ignored its signal keeps running
 *   unowned, a defect of the port's implementation.
 * - **A stop.** The review's stop aborts this task first (pi aborts owned work bottom-up): its
 *   `prepare` is signalled, its commit rejects, and its abort commits `stopped` with no readings.
 *   No row then; the review's own abort says it.
 * - **A replay.** Before its commit lands, a replayed plan calls `prepare` again (deterministic for
 *   its input) and `create` again (idempotent by task name), so each reading is created once.
 * - **The port absent.** Registered whatever the run's configuration says, so a review that created
 *   this task always resumes it; without the port it ends at once with no readings.
 */
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
    input: ReadingsPlanInput,
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
        const input: ReadingsPlanInput = {
          manifestKey: task.input.manifestKey,
          cutoffAt: task.input.cutoffAt,
          front: task.input.front,
          ...(task.input.relations === undefined
            ? {}
            : { relations: task.input.relations }),
        };
        let ended: Awaited<ReturnType<typeof prepare>>;
        if (readings === undefined) {
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
            input,
            owner,
            findDeadline(runtime.now(), task.input.cutoffAt),
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
        // A reading exists before the Frame and the Map do: it is logged as reading the manifest only.
        for (const reading of created)
          log?.write({
            type: "task.inputs",
            taskId: reading.task,
            owner,
            kind: "reading",
            inputs: { manifest: `computation:${task.input.manifestKey}` },
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
