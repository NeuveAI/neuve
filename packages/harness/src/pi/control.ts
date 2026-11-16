import type { Context } from "@earendil-works/chord";
import { withCancel } from "@earendil-works/chord/context";
import {
  defineDoc,
  type ConversationId,
  type Harness,
  type InputSubmissionDraft,
  type SettledSubmissionRecord,
  type SubmissionId,
  type TaskId,
  type TaskRuntime,
  type Tx,
} from "@earendil-works/pi-durable";
import { heldFailure } from "./failure-policy.ts";
import type { RouteFailure, RouteFailureKind } from "./providers/failure.ts";

/**
 * How a run's agent steps wait out a provider failure without losing their conversation (10.17).
 * A step whose submission settles `unanswered` with `model_error` enters held in the same commit
 * as its own held checkpoint, keeping its task, its owned conversation and every turn pi committed.
 * It wakes when the host admits a resume nonce other than the one current when it held, then
 * resubmits nothing new: an empty input under a request ID bound to the failed submission and the
 * nonce, so the same model request is sent again and a repeated admission joins the same
 * submission. The host admits one nonce per claim of the job, before scheduling resumes.
 */

/** A route failure as the held step stores it: pi documents hold JSON, so absent parts are null. */
export type HeldRouteFailure = {
  readonly kind: RouteFailureKind;
  readonly status: number | null;
  readonly code: string | null;
};

export type HoldRecovery =
  | { readonly kind: "provider-policy" }
  | { readonly kind: "credential-restored" };

/** One held step: what failed, and the nonce that was current when it held. */
export type HeldStep = {
  readonly conversationId: ConversationId;
  readonly failedSubmissionId: SubmissionId;
  readonly reason: string;
  /** pi's error text for the failed request, as its submission settled; for people, never parsed. */
  readonly detail: string | null;
  /**
   * The route's typed failure, as the provider recorded it on the failed turn
   * (`routeFailureOfSubmission`). Null when the turn carries none, which the host discloses
   * instead of guessing a kind.
   */
  readonly failure: HeldRouteFailure | null;
  readonly nonceAtHold: string | null;
  /** Absent only in older persisted holds, which retain provider policy. */
  readonly recovery?: HoldRecovery;
};

export type StopCause = "user-stop" | "cutoff" | "deadline" | "held-failure";

export const composeOnAbort = (cause: StopCause | undefined) =>
  cause === "cutoff" || cause === "deadline";

type RunControl = {
  stopCause?: StopCause;
  resumeNonce: string | null;
  /** By task ID. */
  held: { [taskId: string]: HeldStep };
};

export const RunControlDoc = defineDoc<RunControl>({
  kind: "neuve.run-control",
  version: 1,
  scope: "session",
  initial: () => ({ resumeNonce: null, held: {} }),
});

/** A settled submission a step holds for instead of failing: the provider could not answer it. */
export const holds = (settled: SettledSubmissionRecord) =>
  settled.status === "unanswered" && settled.reason === "model_error";

const detailOf = (settled: SettledSubmissionRecord) =>
  settled.status !== "unanswered" || settled.detail === undefined
    ? null
    : typeof settled.detail === "string"
      ? settled.detail
      : JSON.stringify(settled.detail);

/**
 * Records `taskId` as held. Call it inside the `runtime.commit` that returns the step's held
 * checkpoint, so the two are one commit.
 */
export const enterHeld = async (
  tx: Tx,
  taskId: TaskId,
  input: {
    readonly conversationId: ConversationId;
    readonly settled: SettledSubmissionRecord;
    readonly failure?: RouteFailure | undefined;
  },
): Promise<HeldStep> => {
  if (input.settled.status !== "unanswered")
    throw new Error(
      `submission ${input.settled.id} was answered; there is nothing to hold for`,
    );
  const doc = await tx.doc(RunControlDoc);
  const held: HeldStep = {
    conversationId: input.conversationId,
    failedSubmissionId: input.settled.id,
    reason: input.settled.reason,
    detail: detailOf(input.settled),
    failure:
      input.failure === undefined
        ? null
        : {
            kind: input.failure.kind,
            status: input.failure.status ?? null,
            code: input.failure.code ?? null,
          },
    nonceAtHold: doc.resumeNonce,
    recovery: { kind: "provider-policy" },
  };
  doc.held[String(taskId)] = held;
  return held;
};

/** Removes `taskId` from the held steps; call it in the commit that leaves the held checkpoint. */
export const leaveHeld = async (tx: Tx, taskId: TaskId): Promise<void> => {
  delete (await tx.doc(RunControlDoc)).held[String(taskId)];
};

/** The held watch ended before a resume: the harness closed or the invocation was cancelled. */
export class HeldWatchEnded extends Error {
  constructor(readonly reason: string) {
    super(`the held step stopped waiting: ${reason}`);
  }
}

type Woken = { readonly nonce: string; readonly held: HeldStep };

/**
 * Waits, without polling, until the host admits a resume nonce other than the one current when
 * this task held, or until `until` (the run's cut-off) when given. Rejects with `HeldWatchEnded`
 * when the harness closes, which pi treats as a cancelled invocation, not a fault: the step stays
 * held and waits again after the harness reopens.
 */
export const awaitResume = async (
  runtime: Pick<
    TaskRuntime<unknown, { phase: string }, unknown, object>,
    "taskId" | "watchDoc" | "sleep"
  >,
  context: Context,
  until?: number,
): Promise<Woken | "cutoff"> => {
  const watch = await runtime.watchDoc(RunControlDoc, context);
  if (watch === undefined)
    throw new Error(`task ${runtime.taskId} is not held: no run control`);
  const held = watch.value?.held[String(runtime.taskId)];
  if (held === undefined) throw new Error(`task ${runtime.taskId} is not held`);
  const timer = withCancel(context);
  try {
    return await new Promise<Woken | "cutoff">((resolve, reject) => {
      const wake = (value: Readonly<RunControl> | null) => {
        const nonce = value?.resumeNonce ?? null;
        if (nonce !== null && nonce !== held.nonceAtHold)
          resolve({ nonce, held });
      };
      wake(watch.value);
      watch.start(async (value) => wake(value));
      void watch.closed.then((end) => reject(new HeldWatchEnded(end.reason)));
      if (until !== undefined)
        runtime.sleep(until, timer.context).then(
          () => resolve("cutoff"),
          () => undefined,
        );
    });
  } finally {
    timer.cancel("resumed");
    await watch.stop();
  }
};

/** The resume input of a held step: nothing new, bound to the failed submission and the nonce. */
export const resumeSubmission = (
  failedSubmissionId: SubmissionId,
  nonce: string,
): InputSubmissionDraft & { readonly requestId: string } => ({
  type: "input",
  content: [],
  requestId: `resume:${failedSubmissionId}:${nonce}`,
});

/**
 * What admitting a nonce did: `joined` when this claim's nonce was already admitted, so a repeated
 * admission wakes nothing twice; otherwise `committed` when it wakes held steps, `none` when none
 * was held. `blocked` keeps a terminal refusal until its recorded recovery condition is met.
 */
export type ResumeAdmission = "none" | "committed" | "joined" | "blocked";

/**
 * The host's admission of one claim's resume nonce, before scheduling resumes. Every claim's nonce
 * is recorded, held steps or not, so a step that holds later in this claim records it and waits for
 * the next claim; reopening within the same claim wakes nothing. Steps whose task already ended (a
 * cut-off or an abort reached them while held) are dropped first.
 */
export const admitResume = (
  harness: Pick<Harness, "commit">,
  nonce: string,
  context: Context,
): Promise<ResumeAdmission> =>
  harness.commit(async (tx) => {
    const doc = await tx.doc(RunControlDoc);
    for (const key of Object.keys(doc.held)) {
      const task = await tx.task(Number(key) as TaskId);
      if (task === undefined || task.state.status === "terminal")
        delete doc.held[key];
    }
    if (doc.resumeNonce === nonce) return "joined";
    if (
      Object.values(doc.held).some(
        (held) =>
          held.recovery?.kind !== "credential-restored" &&
          !heldFailure([held]).retryable,
      )
    )
      return "blocked";
    delete doc.stopCause;
    doc.resumeNonce = nonce;
    return Object.keys(doc.held).length === 0 ? "none" : "committed";
  }, context);

/** The steps held in the current claim: they wait for the next one. */
export const heldNow = (
  control: Readonly<RunControl> | null | undefined,
): ReadonlyArray<HeldStep & { readonly taskId: TaskId }> =>
  control === null || control === undefined
    ? []
    : Object.entries(control.held)
        .filter(([, held]) => held.nonceAtHold === control.resumeNonce)
        .map(([taskId, held]) => ({
          ...held,
          taskId: Number(taskId) as TaskId,
        }));

/** Whether a commit publication's document change is the run control. */
export const isRunControl = (record: { readonly kind: string }) =>
  record.kind === RunControlDoc.definition.kind;

export type RunControlValue = Readonly<RunControl>;

/** Only an observed credential loss authorizes a later credential-bearing claim to recover a terminal refusal. */
export const credentialLost = (
  harness: Pick<Harness, "commit">,
  context: Context,
) =>
  harness.commit(async (tx) => {
    const doc = await tx.doc(RunControlDoc);
    for (const [id, held] of Object.entries(doc.held))
      doc.held[id] = { ...held, recovery: { kind: "credential-restored" } };
  }, context);
