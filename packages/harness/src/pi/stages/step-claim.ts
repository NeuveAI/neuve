import { Cause, Effect, Exit, Option } from "effect";
import { Computations } from "@neuve/records-core";

/**
 * One model step's claim on its computation key, held for as long as its conversation runs in
 * this process (record 0016, `architecture/decisions/0016-shared-work.md`).
 *
 * `begin` starts the step's own `store.run(spec, compute)`. The store's run is the claim: it looks
 * the key up, asks the budget host for it over a socket, makes every other caller with the key
 * wait for the publication, gives a dead holder's key to a waiter, and records how the holder
 * ended so each waiter's own policy decides. `compute` here does no work: it waits for the step to
 * hand over its output (`settle`) or the end of its claim (`fail`), so the whole conversation runs
 * inside it.
 *
 * Only `store.run` decides who runs. The table below maps a task to the claim this process already
 * holds: an entry is written only inside `compute`, which the store enters only once the host has
 * granted this connection the key. So `begin` cannot answer "holder" unless `compute` was entered,
 * and the table never grants, refuses or orders anything. There is no timer, poll, retry loop or
 * process ID here: a waiter wakes on the host's push, and a claim ends with its connection.
 *
 * **Dispatch gate.** pi runs a conversation's model requests in its own tasks, and a resumed run
 * restarts them by itself. So no request leaves for a step's conversation unless that step holds
 * its claim in this process: before each request, pi's generation awaits `admitted` for the step
 * (its kind extension's `beforeRequest` hook, `tools.ts`). `admitted` resolves once the step
 * holds, and only its caller's signal ends the wait otherwise: pi reports a hook's throw and sends
 * the request anyway, so a refusal there must never be a rejection. A step whose `begin` answers
 * stored or failed aborts its conversation, which signals that wait. `granted` is the same gate
 * for a caller that can act on a refusal (the contract engine's phase): it also rejects, as an
 * abort, when `begin` answers stored or failed, or the held claim ends. The gates only hold
 * dispatch back; who runs is the store's decision.
 *
 * **How a claim ends.** `fail` records one of two classes, and every waiter reads it back:
 * - released (`released: true`): the holder gave the claim up with no verdict on the work. It was
 *   cut off or stopped, or it holds and will resume. A waiter gets `released` and claims again.
 * - failed: the work itself failed. A waiter gets `failed` with the tag, the message and the
 *   holder's own retryability.
 * Both travel in the attempt's recorded message (`recorded` below), which only this module writes
 * and reads. A failure it did not write reads as failed and not retryable.
 *
 * Abort: while a caller only waits, its signal stops the wait and leaves the holder's run alone.
 * Once it holds, its signal releases the claim, so the claim is never left open. A `begin` whose
 * signal has already aborted rejects and changes nothing, held or not. The signal a model step
 * passes is its invocation's (`runtime.signal`). That signal spans the step's phases in this
 * process, and aborts when the task is marked aborted, its harness closes or the invocation ends.
 *
 * Inside one process the store runs the first caller's `compute` for a key, and later callers
 * subscribe to it. If that first caller stopped waiting and the key is granted afterwards (by a
 * takeover), its `compute` releases at once, and the other subscribers claim again.
 */

/** The tag a claim records when it is released by its holder's signal or its own stop. */
export const INTERRUPTED = "Interrupted";

/** Runs a store effect to a promise, as a step runs them: `services.run(withRecords(ctx, …), signal)`. */
export type ClaimRunner = <A, E>(
  effect: Effect.Effect<A, E, Computations.ComputationStore>,
  signal: AbortSignal,
) => Promise<A>;

/** What a holder hands over: the stored bytes, their usage and the model. */
export type StepOutput = Computations.Output & Computations.AttemptReport;

/** How a holder ends its claim without an output. */
export interface ClaimEnd {
  readonly tag: string;
  readonly message: string;
  /** The holder's own retryability for this failure. Not read when released. */
  readonly retryable: boolean;
  /** No verdict on the work: the holder was cut off, stopped, or holds and will resume. */
  readonly released?: boolean | undefined;
}

export type ClaimAnswer =
  /** `compute` was entered: this process runs the conversation. */
  | { readonly kind: "holder" }
  /** Another run produced the output: stored before, or shared now. Nothing is to run. */
  | { readonly kind: "stored"; readonly result: Computations.RunResult }
  /** The holder gave the claim up with no verdict on the work: claim again. */
  | {
      readonly kind: "released";
      readonly tag: string;
      readonly message: string;
    }
  /** The holder's work failed, with the holder's own retryability. */
  | {
      readonly kind: "failed";
      readonly tag: string;
      readonly message: string;
      readonly retryable: boolean;
    };

export interface StepClaims {
  readonly begin: (
    taskId: number,
    spec: Computations.ComputationSpec,
    signal: AbortSignal,
  ) => Promise<ClaimAnswer>;
  readonly holds: (taskId: number) => boolean;
  /**
   * Resolves once this process holds the task's claim. Rejects as an abort when `begin` answers
   * stored or failed, or the held claim ends; a released answer leaves it waiting.
   */
  readonly granted: (taskId: number, signal: AbortSignal) => Promise<void>;
  /**
   * Resolves once this process holds the task's claim; only `signal` ends the wait otherwise. For
   * pi's `beforeRequest` hook, which must never let a request out on a rejection.
   */
  readonly admitted: (
    taskId: number,
    signal: AbortSignal | undefined,
  ) => Promise<void>;
  /** Hands the output over; resolves with the stored result once the publication is done. */
  readonly settle: (
    taskId: number,
    output: StepOutput,
  ) => Promise<Computations.RunResult>;
  /** Ends the claim, recorded, so waiters wake. Nothing to end resolves at once. */
  readonly fail: (taskId: number, end: ClaimEnd) => Promise<void>;
}

/** A holder's recorded end. The store records its `_tag` and message as the attempt's (`describeCause`). */
class Recorded extends Error {
  constructor(
    readonly _tag: string,
    message: string,
  ) {
    super(message);
  }
}

/** The class and retryability, written ahead of the message the attempt records. */
const MARK = /^\[step-claim (released|retryable|final)\] /;
const recorded = (end: ClaimEnd) =>
  new Recorded(
    end.tag,
    `[step-claim ${end.released ? "released" : end.retryable ? "retryable" : "final"}] ${end.message}`,
  );
const readRecorded = (tag: string, message: string): ClaimAnswer => {
  const mark = MARK.exec(message);
  const text = mark === null ? message : message.slice(mark[0].length);
  if (mark?.[1] === "released") return { kind: "released", tag, message: text };
  return {
    kind: "failed",
    tag,
    message: text,
    retryable: mark?.[1] === "retryable",
  };
};

const releasing = (message: string): ClaimEnd => ({
  tag: INTERRUPTED,
  message,
  retryable: true,
  released: true,
});

const refusal = () =>
  new DOMException("the step does not hold its claim", "AbortError");

type Handover =
  | { readonly kind: "output"; readonly output: StepOutput }
  | { readonly kind: "end"; readonly end: ClaimEnd };

type RunExit = Exit.Exit<Computations.RunResult, unknown>;

interface Claim {
  state: "waiting" | "held" | "ended";
  readonly handover: PromiseWithResolvers<Handover>;
  /** The store's run, to its exit. */
  readonly done: Promise<RunExit>;
  /** Removes the holder's abort listeners. */
  readonly unwatch: Array<() => void>;
}

interface Waiter {
  /** A refusal rejects it; otherwise only its signal does. */
  readonly refusable: boolean;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
}

/** Waits in `waiters` until resolved or refused; `signal` ends the wait. */
const wait = (
  waiters: Set<Waiter>,
  refusable: boolean,
  signal: AbortSignal | undefined,
) =>
  new Promise<void>((resolve, reject) => {
    const abort = () => {
      waiters.delete(waiter);
      reject(signal?.reason);
    };
    const waiter: Waiter = {
      refusable,
      resolve: () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      },
      reject: (reason) => {
        signal?.removeEventListener("abort", abort);
        reject(reason);
      },
    };
    waiters.add(waiter);
    signal?.addEventListener("abort", abort, { once: true });
  });

const answerOf = (exit: RunExit): ClaimAnswer => {
  if (Exit.isSuccess(exit)) return { kind: "stored", result: exit.value };
  const error = Cause.findErrorOption(exit.cause);
  if (
    Option.isSome(error) &&
    error.value instanceof Computations.SharedAttemptFailed
  )
    return readRecorded(error.value.tag, error.value.message);
  throw Cause.squash(exit.cause);
};

/** One table per step definition; `run` reaches the step's computation store. */
export const stepClaims = (run: ClaimRunner): StepClaims => {
  /** Bookkeeping only: the claims whose `compute` this process is inside. */
  const held = new Map<number, Claim>();
  /** The callers awaiting each task's grant: a step's phase, and its generations' requests. */
  const grants = new Map<number, Set<Waiter>>();

  const admit = (taskId: number) => {
    for (const waiter of grants.get(taskId) ?? []) waiter.resolve();
    grants.delete(taskId);
  };

  /** No grant for the task now: refusable waiters are refused; requests keep waiting. */
  const refuse = (taskId: number) => {
    const waiters = grants.get(taskId);
    for (const waiter of waiters ?? [])
      if (waiter.refusable) {
        waiters?.delete(waiter);
        waiter.reject(refusal());
      }
    if (waiters?.size === 0) grants.delete(taskId);
  };

  const waitFor = (
    taskId: number,
    refusable: boolean,
    signal: AbortSignal | undefined,
  ) => {
    if (held.get(taskId)?.state === "held") return Promise.resolve();
    if (signal?.aborted) return Promise.reject(signal.reason);
    let waiters = grants.get(taskId);
    if (waiters === undefined) grants.set(taskId, (waiters = new Set()));
    return wait(waiters, refusable, signal);
  };

  const release = (taskId: number, claim: Claim) => {
    if (held.get(taskId) === claim) held.delete(taskId);
    claim.state = "ended";
    for (const stop of claim.unwatch.splice(0)) stop();
    refuse(taskId);
  };

  /** Ends a held claim with `handover` and returns its run, or nothing when the task holds none. */
  const end = (taskId: number, handover: Handover) => {
    const claim = held.get(taskId);
    if (claim === undefined || claim.state !== "held") return undefined;
    release(taskId, claim);
    claim.handover.resolve(handover);
    return claim.done;
  };

  const watch = (taskId: number, claim: Claim, signal: AbortSignal) => {
    const abort = () => {
      // Nobody awaits this ending: the claim's run publishes it for its waiters.
      void end(taskId, {
        kind: "end",
        end: releasing(
          "the step's run was interrupted while it held the claim",
        ),
      })?.catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    claim.unwatch.push(() => signal.removeEventListener("abort", abort));
  };

  const begin: StepClaims["begin"] = (taskId, spec, signal) => {
    // An aborted caller changes nothing, whether or not its task holds.
    if (signal.aborted) return Promise.reject(signal.reason);
    const current = held.get(taskId);
    if (current !== undefined) {
      watch(taskId, current, signal);
      return Promise.resolve({ kind: "holder" });
    }
    const answer = Promise.withResolvers<ClaimAnswer>();
    // Only a waiter's run is ever stopped through this; a holder's ends by its handover.
    const stop = new AbortController();
    const finished = Promise.withResolvers<RunExit>();
    const claim: Claim = {
      state: "waiting",
      handover: Promise.withResolvers<Handover>(),
      done: finished.promise,
      unwatch: [],
    };
    const waiting = () => {
      if (claim.state !== "waiting") return;
      claim.state = "ended";
      stop.abort(signal.reason);
      answer.reject(signal.reason);
    };
    const compute = Effect.suspend(() => {
      // The store enters this only for the connection the host granted the key. A caller that
      // stopped waiting releases it at once, so the process's other subscribers claim again.
      if (claim.state !== "waiting")
        return Effect.fail(
          recorded(
            releasing(
              "the step stopped waiting before it was granted the claim",
            ),
          ),
        );
      claim.state = "held";
      held.set(taskId, claim);
      signal.removeEventListener("abort", waiting);
      watch(taskId, claim, signal);
      admit(taskId);
      answer.resolve({ kind: "holder" });
      return Effect.flatMap(
        Effect.promise(() => claim.handover.promise),
        (handed): Effect.Effect<StepOutput, Recorded> =>
          handed.kind === "output"
            ? Effect.succeed(handed.output)
            : Effect.fail(recorded(handed.end)),
      );
    });
    signal.addEventListener("abort", waiting, { once: true });
    run(
      Effect.gen(function* () {
        const store = yield* Computations.ComputationStore;
        return yield* Effect.exit(store.run(spec, compute));
      }),
      stop.signal,
    ).then(finished.resolve, finished.reject);
    const answered = (outcome: () => ClaimAnswer) => {
      signal.removeEventListener("abort", waiting);
      // The store ended a held claim before the step handed anything over.
      if (claim.state === "held") return release(taskId, claim);
      if (claim.state !== "waiting") return;
      claim.state = "ended";
      let result: ClaimAnswer;
      try {
        result = outcome();
      } catch (error) {
        refuse(taskId);
        return answer.reject(error);
      }
      // A released claim is claimed again, so its callers keep waiting.
      if (result.kind !== "released") refuse(taskId);
      answer.resolve(result);
    };
    claim.done.then(
      (exit) => answered(() => answerOf(exit)),
      (error: unknown) =>
        answered(() => {
          throw error;
        }),
    );
    return answer.promise;
  };

  return {
    begin,
    holds: (taskId) => held.get(taskId)?.state === "held",
    granted: (taskId, signal) => waitFor(taskId, true, signal),
    admitted: (taskId, signal) => waitFor(taskId, false, signal),
    settle: async (taskId, output) => {
      const done = end(taskId, { kind: "output", output });
      if (done === undefined)
        throw new Error(`task ${taskId} holds no claim to settle`);
      const exit = await done;
      if (Exit.isSuccess(exit)) return exit.value;
      throw Cause.squash(exit.cause);
    },
    fail: async (taskId, ending) => {
      const done = end(taskId, { kind: "end", end: ending });
      if (done === undefined) return;
      const exit = await done;
      if (Exit.isSuccess(exit)) return;
      const error = Cause.findErrorOption(exit.cause);
      if (Option.isSome(error) && error.value instanceof Recorded) return;
      throw Cause.squash(exit.cause);
    },
  };
};
