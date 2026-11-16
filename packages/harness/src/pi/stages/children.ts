import type { Context } from "@earendil-works/chord";
import type {
  SettledTask,
  Task,
  TaskId,
  TaskOutcome,
  Tx,
} from "@earendil-works/pi-durable";
import { ChildrenDoc } from "./docs.ts";

/** What starting and joining children needs of a stage task's runtime. */
export interface ChildHost {
  readonly taskId: TaskId;
  commit(
    change: (tx: Tx) => Promise<undefined>,
    context: Context,
  ): Promise<void>;
  waitForTask<T>(id: TaskId<T>, context: Context): Promise<SettledTask<T>>;
}

/**
 * Starts a child task under `name`, once: the child is created in the same commit that records it
 * in the parent's `ChildrenDoc`, so a phase that runs again after a crash finds the child it
 * started instead of starting another.
 */
export const spawn = async <
  I,
  S extends { phase: string },
  R,
  H extends object,
>(
  runtime: ChildHost,
  name: string,
  task: Task<I, S, R, H>,
  input: I,
  context: Context,
): Promise<TaskId<R>> => {
  let id: number | undefined;
  await runtime.commit(async (tx) => {
    const doc = await tx.doc(ChildrenDoc, runtime.taskId);
    const held = doc.children[name];
    if (held !== undefined) {
      id = held;
      return undefined;
    }
    id = await tx.createTask(task, input, {
      ownership: { kind: "task", taskId: runtime.taskId },
    });
    doc.children[name] = id;
    return undefined;
  }, context);
  if (id === undefined) throw new Error(`child ${name} was not created`);
  return childId<R>(id);
};

/**
 * A child's ID as a document or checkpoint holds it: a number, which pi's task IDs are. The task it
 * names was created with a result of type `R` by the code that stored it.
 */
export const childId = <R>(id: number): TaskId<R> => id as TaskId<R>;

/** Waits for a child and returns its outcome. */
export const outcomeOf = async <R>(
  runtime: ChildHost,
  id: TaskId<R>,
  context: Context,
): Promise<TaskOutcome<R>> =>
  (await runtime.waitForTask(id, context)).state.outcome;

/** The result a stage child ended with, completed or cut off; undefined when it failed. */
export const resultOf = <R>(outcome: TaskOutcome<R>): R | undefined =>
  outcome.status === "completed" || outcome.status === "aborted"
    ? outcome.result
    : undefined;

/**
 * A child that failed fails its parent with the same error, as a failed stage failed the run
 * before; a child cut off by the run's cut-off is not a failure.
 */
export const failureOf = (
  outcomes: ReadonlyArray<TaskOutcome<unknown>>,
): TaskOutcome<never> | undefined => {
  for (const outcome of outcomes)
    if (outcome.status === "failed" || outcome.status === "faulted")
      return { status: outcome.status, error: outcome.error };
    else if (outcome.status === "orphaned")
      return {
        status: "failed",
        error: { message: `a stage task was orphaned: ${outcome.reason}` },
      };
  return undefined;
};
