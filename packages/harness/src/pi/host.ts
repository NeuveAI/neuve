import { reviewPriority } from "./priority.ts";
import type { AgentRouteBinding } from "./contracts.ts";
import { enqueueTelemetry, type RunLog } from "../run-log.ts";
import { logTimed, startLogSpan } from "../log-span.ts";
import { CUTOFF_GRACE_MS } from "../run-schedule.ts";
import type { Context } from "@earendil-works/chord";
import {
  BACKGROUND_CONTEXT,
  withCancel,
  awaitWithContext,
} from "@earendil-works/chord/context";
import type { MutableModels } from "@earendil-works/pi-ai";
import {
  defineDoc,
  Harness,
  type Extension,
  type HarnessOptions,
  type ConversationId,
  type HarnessSettings,
  type Registry,
  type SettledTask,
  type Storage,
  type TaskId,
} from "@earendil-works/pi-durable";
import type { SourceOwnership } from "./source-ownership.ts";
import { agentRoutes, clearInheritedAgentRoute } from "./bindings.ts";
import { limitProvider, type CallSlots } from "./call-slots.ts";
import type { AgentRouteRuntime, CreateRouteProvider } from "./contracts.ts";
import { nativeRetryAdmission } from "./providers/retry-admission.ts";
import {
  admitResume,
  credentialLost,
  heldNow,
  isRunControl,
  RunControlDoc,
  type HeldStep,
  type ResumeAdmission,
  type RunControlValue,
  type StopCause,
} from "./control.ts";
import {
  reviewExtension,
  reviewTask,
  type ReviewOutcome,
  type ReviewStagesPort,
  type ReviewTaskInput,
} from "./review-task.ts";
import {
  exportingStorage,
  type CloseMode,
  type ExportOnClose,
} from "./storage.ts";

/**
 * One run's native pi host (0014): the harness over the run's own storage, with the review task
 * admitted once per run and resumed on every claim of its job. The job queue still owns the run's
 * lifecycle (10.13); this host only opens, admits, watches and closes.
 */

/**
 * One claim of the job. A held job is released with its attempt uncounted, so its sequence and
 * attempt repeat; the claim time is stamped on every claim and cleared on release, so the next claim
 * differs while a repeated handler call within one claim does not.
 */
export type QueueClaim = {
  readonly jobSeq: number;
  readonly attempt: number;
  readonly claimedAt: string;
};

export const claimNonce = (claim: QueueClaim) =>
  `job:${claim.jobSeq}:attempt:${claim.attempt}:claim:${claim.claimedAt}`;

/**
 * The run's review tasks: the one each claim admitted, and the current one. A run has one current
 * review task; a later claim joins it while it is unfinished or completed, and only a claim after a
 * review that ended otherwise (a failed or stopped attempt the queue retries) admits a new one, with
 * the earlier one kept as history.
 */
const ReviewAdmissionDoc = defineDoc<{
  current: number | null;
  claims: { [nonce: string]: number };
  stopNewWorkMarked?: boolean;
}>({
  kind: "neuve.review-admission",
  version: 1,
  scope: "session",
  initial: () => ({ current: null, claims: {} }),
});

/**
 * The host failed to open, and closing what it had opened failed too: the export or the database's
 * close. Both are kept; the run folder must stay, as after any failed close.
 */
export class HostOpenFailed extends Error {
  constructor(
    override readonly cause: unknown,
    readonly closeError: unknown,
  ) {
    super(
      `${cause instanceof Error ? cause.message : String(cause)}; closing it failed too: ${closeError instanceof Error ? closeError.message : String(closeError)}`,
    );
  }
}

/**
 * A section reading's priority (NEU-148), which takes the place of its stage's: the readings band
 * by its rank, and a re-read or a later turn as continued. Nothing for any other conversation.
 */
const readingPriority = (
  binding: Pick<AgentRouteBinding, "reading">,
  context:
    { readonly messages: ReadonlyArray<{ readonly role: string }> } | undefined,
) =>
  binding.reading === undefined
    ? {}
    : reviewPriority(
        binding.reading.kind,
        context === undefined ||
          binding.reading.reread === true ||
          context.messages.some((message) => message.role === "assistant"),
        binding.reading.rank,
      );

/** How this claim came to its review task. */
export type Admitted = "created" | "continued" | "joined";

/** The run's review task this claim admitted, in the root conversation of the run's pi storage. */
export type ReviewAdmission = {
  readonly runId: string;
  readonly conversationId: ConversationId;
  readonly taskId: TaskId<ReviewOutcome>;
  readonly admitted: Admitted;
};

/** pi's settings for a review run (stages-interfaces): pi's own retries only, no compaction. */
export const REVIEW_SETTINGS: HarnessSettings = {
  // One request attempt is one provider call: the SDK's own retries would duplicate pi's.
  stream: { maxRetries: 0 },
  // Four attempts in all, as the route's retry policy had.
  retry: { enabled: true, maxRetries: 3, baseDelayMs: 2_000 },
  compaction: { enabled: false },
};

/** How long after the run's cut-off the host stops stage work the stages did not stop themselves. */
export { CUTOFF_GRACE_MS } from "../run-schedule.ts";

export interface OpenReviewHostOptions<Receipt> {
  readonly log?: RunLog | undefined;
  /** The run's raw pi storage; the host closes it through the export barrier. */
  readonly storage: Storage;
  readonly ownership: SourceOwnership;
  readonly models: MutableModels;
  readonly createRouteProvider: CreateRouteProvider;
  /** The run's model-call slots, shared by every agent conversation's routed provider. */
  readonly slots: CallSlots;
  /** Every other extension the run needs; the host installs the stages' and the review task's. */
  readonly registry: Registry;
  readonly run: ReviewTaskInput;
  readonly claim: QueueClaim;
  /**
   * Builds the stages over the open harness and the run's routes, before anything runs. `restore`
   * runs after the routes are restored and before scheduling resumes.
   */
  readonly stages: (input: {
    readonly harness: Harness;
    readonly routes: AgentRouteRuntime;
  }) => {
    readonly port: ReviewStagesPort;
    readonly extension: Extension;
    readonly restore?:
      ((harness: Harness, context: Context) => Promise<void>) | undefined;
  };
  readonly onClose: ExportOnClose<Receipt>;
  readonly settings?: HarnessSettings | undefined;
  readonly env?: HarnessOptions["env"];
  readonly onReport?: ((error: unknown) => void) | undefined;
  readonly now?: (() => number) | undefined;
  readonly cutoffGraceMs?: number | undefined;
}

/** Why the host stopped waiting: the review settled, or steps held in this claim. */
export type HostEnd =
  | { readonly kind: "settled"; readonly task: SettledTask<ReviewOutcome> }
  | {
      readonly kind: "held";
      readonly steps: ReadonlyArray<HeldStep & { readonly taskId: TaskId }>;
    };

export type HostClosed<Receipt> = {
  readonly kind: "closed";
  readonly mode: CloseMode;
  readonly receipt: Receipt;
};

export type HostCleanup<Receipt> =
  | HostClosed<Receipt>
  | {
      readonly kind: "pending";
      readonly phase: "stopping" | "closing";
      readonly settled: Promise<HostClosed<Receipt>>;
    };

export interface ReviewHost<Receipt> {
  readonly harness: Harness;
  readonly routes: AgentRouteRuntime;
  readonly admission: ReviewAdmission;
  readonly resume: ResumeAdmission;
  /** Resolves when the review settles or a step holds in this claim, whichever comes first. */
  readonly ended: (context: Context) => Promise<HostEnd>;
  /**
   * A stop (the person's drop, the attempt's deadline): aborts the review task, whose owned stage
   * work pi aborts first, and waits up to `withinMs` for it to settle.
   */
  readonly stop: (
    context: Context,
    withinMs: number,
    cause?: StopCause,
  ) => Promise<SettledTask<ReviewOutcome> | undefined>;
  /**
   * Closes the harness without aborting anything; the storage exports under `mode`, then closes.
   * Resolves with the export's receipt only when both succeeded.
   */
  readonly close: (mode: CloseMode, context: Context) => Promise<Receipt>;
  /** One waiter budget for stop and close. A pending caller must join `settled` before releasing resources. */
  readonly cleanup: (
    input: {
      readonly mode: CloseMode;
      readonly stop: boolean;
      readonly stopCause?: StopCause;
      readonly withinMs: number;
      readonly beforeClose?: (mode: CloseMode) => void;
    },
    context: Context,
  ) => Promise<HostCleanup<Receipt>>;
}

type Admission =
  | { readonly kind: "active"; readonly admission: ReviewAdmission }
  | {
      readonly kind: "completed";
      readonly admission: ReviewAdmission;
      readonly task: SettledTask<ReviewOutcome>;
      readonly resume: "none" | "joined";
    };

const completedAdmission = async (
  harness: Harness,
  runId: string,
  nonce: string,
  context: Context,
): Promise<Extract<Admission, { kind: "completed" }> | undefined> => {
  const previous = await harness.snapshot(ReviewAdmissionDoc, context);
  const claimed = previous?.claims[nonce];
  const currentId = claimed ?? previous?.current;
  if (currentId == null) return undefined;
  const current = await harness.getTask(
    currentId as TaskId<ReviewOutcome>,
    context,
  );
  if (
    current?.state.status !== "terminal" ||
    current.state.outcome.status !== "completed"
  )
    return undefined;
  const inspection = await harness.inspect(context);
  if (inspection.tasks.length > 0 || inspection.submissions.length > 0)
    return undefined;
  const control = await harness.snapshot(RunControlDoc, context);
  const { memos: _memos, ...settled } = current;
  return {
    kind: "completed",
    admission: {
      runId,
      conversationId: current.conversationId,
      taskId: current.id,
      admitted: claimed === undefined ? "continued" : "joined",
    },
    task: { ...settled, state: current.state },
    resume: control?.resumeNonce === nonce ? "joined" : "none",
  };
};

const admit = (
  harness: Harness,
  task: ReturnType<typeof reviewTask>,
  run: ReviewTaskInput,
  nonce: string,
  context: Context,
) =>
  harness.root(context).then((root) =>
    harness.commit(async (tx) => {
      const doc = await tx.doc(ReviewAdmissionDoc);
      const answer = (taskId: number, admitted: Admitted) => {
        doc.claims[nonce] = taskId;
        return {
          runId: run.runId,
          conversationId: root.id,
          taskId: taskId as TaskId<ReviewOutcome>,
          admitted,
        };
      };
      const claimed = doc.claims[nonce];
      if (claimed !== undefined) return answer(claimed, "joined");
      if (doc.current !== null) {
        const current = await tx.task(doc.current as TaskId);
        if (
          current !== undefined &&
          (current.state.status !== "terminal" ||
            current.state.outcome.status === "completed")
        )
          return answer(doc.current, "continued");
      }
      const created = await tx.createTask(task, run, {
        ownership: { kind: "conversation" },
        conversationId: root.id,
      });
      doc.current = created;
      return answer(created, "created");
    }, context),
  );

/**
 * Opens the run's harness with scheduling paused, installs the stages and the review task, restores
 * every agent route, admits the review task and this claim's resume nonce, and only then resumes.
 * Every fork and task-owned conversation is created without its parent's route
 * (`clearInheritedAgentRoute`), so a conversation no stage bound fails instead of running as another.
 */
export const openReviewHost = async <Receipt>(
  options: OpenReviewHostOptions<Receipt>,
  context: Context,
): Promise<ReviewHost<Receipt>> => {
  let mode: CloseMode = "interrupted";
  const retry = nativeRetryAdmission(options.settings ?? REVIEW_SETTINGS);
  const now = options.now ?? Date.now;
  const releaseNative = options.ownership.retainNative(options.storage);
  const ownedStorage = new Proxy(options.storage, {
    get: (target, key) => {
      if (key === "commit")
        return (writes: Parameters<Storage["commit"]>[0], context: Context) =>
          logTimed(options.log, "harness.storage.commit", {}, () =>
            target.commit(writes, context),
          );
      if (key === "close")
        return async (context: Context) => {
          await target.close(context);
          releaseNative();
        };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const barrier = exportingStorage(ownedStorage, {
    mode: () => mode,
    onClose: options.onClose,
  });
  // An open that fails still closes through the export barrier, and says when that failed too.
  const failOpen = async (error: unknown, close: () => Promise<void>) => {
    const closed = await close()
      .finally(() => options.log?.flush?.())
      .then(
        () => ({ kind: "closed" as const }),
        (closeError: unknown) => ({ kind: "failed" as const, closeError }),
      );
    throw closed.kind === "closed"
      ? error
      : new HostOpenFailed(error, closed.closeError);
  };
  const harness = await Harness.open(
    barrier.storage,
    {
      models: options.models,
      registry: options.registry,
      settings: retry.settings,
      conversationCreated: clearInheritedAgentRoute,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.onReport === undefined ? {} : { onReport: options.onReport }),
      now,
    },
    context,
  ).catch((error: unknown) =>
    failOpen(error, () => barrier.storage.close(context)),
  );
  try {
    const routes = agentRoutes({
      harness,
      models: options.models,
      runId: options.run.runId,
      createProvider: (binding, readBinding) =>
        retry.provider(
          limitProvider(
            options.createRouteProvider(binding, readBinding),
            options.slots,
            {
              provider: binding.physicalProvider,
              model: binding.physicalModel,
              stage: binding.stage,
              agent: binding.agent,
              conversationId: binding.conversationId,
            },
            (context) => ({
              ...reviewPriority(
                binding.stage,
                context === undefined ||
                  context.messages.some(
                    (message) => message.role === "assistant",
                  ),
              ),
              ...readingPriority(binding, context),
              class: "interactive",
            }),
          ),
          {
            harness,
            conversationId: binding.conversationId,
            onReport: options.onReport,
            log: options.log,
          },
        ),
    });
    const stages = options.stages({ harness, routes });
    const task = reviewTask(stages.port, options.log);
    options.registry.install(stages.extension);
    options.registry.install(reviewExtension(task));
    const nonce = claimNonce(options.claim);
    const completed = await completedAdmission(
      harness,
      options.run.runId,
      nonce,
      context,
    );
    let admitted: Admission;
    let resume: ResumeAdmission;
    if (completed !== undefined) {
      admitted = completed;
      resume = completed.resume;
    } else {
      await routes.restoreAgentRoutes(context);
      await stages.restore?.(harness, context);
      admitted = {
        kind: "active",
        admission: await admit(harness, task, options.run, nonce, context),
      };
      resume = await admitResume(harness, nonce, context);
    }
    const { admission } = admitted;

    // Steps held in this claim, from here on: subscribed before scheduling resumes, so none is missed.
    let onHeld: ((steps: ReturnType<typeof heldNow>) => void) | undefined;
    const held = new Promise<HostEnd>((resolve) => {
      onHeld = (steps) => {
        if (steps.length > 0) resolve({ kind: "held", steps });
      };
    });
    const taskSpans = new Map<
      number,
      { status: string; end: ReturnType<typeof startLogSpan> }
    >();
    const unsubscribe = harness.subscribeCommits(({ changes }) => {
      for (const change of changes) {
        if (change.type === "task") {
          const previous = taskSpans.get(change.value.id);
          const status = change.value.state.status;
          if (previous?.status !== status) {
            previous?.end();
            taskSpans.delete(change.value.id);
            if (status !== "terminal")
              taskSpans.set(change.value.id, {
                status,
                end: startLogSpan(options.log, "harness.pi.task", {
                  "harness.task_id": change.value.id,
                  "harness.task_kind": change.value.kind,
                  "harness.task_status": status,
                  "harness.owner": change.value.owner ?? 0,
                }),
              });
          }
        }
        if (change.type === "task")
          enqueueTelemetry(options.log, {
            type: "pi.task",
            taskId: change.value.id,
            owner: change.value.owner,
            conversationId: change.value.conversationId,
            kind: change.value.kind,
            status: change.value.state.status,
          });
        if (change.type === "document" && isRunControl(change.record))
          onHeld?.(heldNow(change.value as RunControlValue | null));
      }
    });
    if (admitted.kind === "active")
      onHeld?.(heldNow(await harness.snapshot(RunControlDoc, context)));

    const ensureStopNewWorkMarker = () => {
      if (
        options.log
          ?.read()
          .some(
            (record) =>
              record.type === "cutoff" && record["point"] === "stop-new-work",
          )
      )
        return;
      enqueueTelemetry(options.log, {
        type: "cutoff",
        point: "stop-new-work",
        at: new Date(options.run.cutoffAt).toISOString(),
        cutoffAt: new Date(options.run.cutoffAt).toISOString(),
        observedAt: new Date(now()).toISOString(),
      });
    };
    // The durable flag is the intent. Repair a missing observation after a crash or failed append.
    if (
      (await harness.snapshot(ReviewAdmissionDoc, context))?.stopNewWorkMarked
    )
      ensureStopNewWorkMarker();

    // The cut-off backstop: stage work still live a grace after the cut-off is aborted, never the
    // review task, which then publishes what its stages kept.
    const reportTimerFailure = (error: unknown) => {
      try {
        options.onReport?.(error);
      } catch {
        enqueueTelemetry(options.log, {
          type: "telemetry.loss",
          operation: "cutoff-report",
          recordsLost: 1,
        });
      }
    };
    const stopNewWork =
      admitted.kind === "completed"
        ? undefined
        : setTimeout(
            () => {
              void harness
                .commit(async (tx) => {
                  const doc = await tx.doc(ReviewAdmissionDoc);
                  doc.stopNewWorkMarked = true;
                }, context)
                .then(ensureStopNewWorkMarker)
                .catch(reportTimerFailure);
            },
            Math.max(0, options.run.cutoffAt - now()),
          );
    const backstop =
      admitted.kind === "completed"
        ? undefined
        : setTimeout(
            () => {
              enqueueTelemetry(options.log, {
                type: "cutoff",
                point: "child-abort",
                at: new Date(
                  options.run.cutoffAt +
                    (options.cutoffGraceMs ?? CUTOFF_GRACE_MS),
                ).toISOString(),
                observedAt: new Date(now()).toISOString(),
                cutoffAt: new Date(options.run.cutoffAt).toISOString(),
              });
              void (async () => {
                await harness.commit(async (tx) => {
                  const doc = await tx.doc(RunControlDoc);
                  doc.stopCause ??= "cutoff";
                }, context);
                const inspection = await harness.inspect(context);
                for (const live of inspection.tasks)
                  if (live.record.owner === admission.taskId)
                    await harness.abortTask(live.record.id, context);
              })().catch(reportTimerFailure);
            },
            Math.max(
              0,
              options.run.cutoffAt +
                (options.cutoffGraceMs ?? CUTOFF_GRACE_MS) -
                now(),
            ),
          );

    if (admitted.kind === "active") harness.resume();

    let closing: Promise<Receipt> | undefined;
    let cleaning: Promise<HostClosed<Receipt>> | undefined;
    let phase: "stopping" | "closing" = "closing";
    const host: ReviewHost<Receipt> = {
      harness,
      routes,
      admission,
      resume,
      ended: async (context) => {
        if (admitted.kind === "completed")
          return { kind: "settled", task: admitted.task };
        const waiting = withCancel(context);
        try {
          return await Promise.race([
            held,
            harness
              .waitForTask(admission.taskId, waiting.context)
              .then((task): HostEnd => ({ kind: "settled", task })),
          ]);
        } finally {
          waiting.cancel("ended");
        }
      },
      stop: async (context, withinMs, cause = "user-stop") => {
        if (admitted.kind === "completed") return admitted.task;
        const bounded = withCancel(context);
        let elapsed = false;
        const timer = setTimeout(() => {
          elapsed = true;
          bounded.cancel("stop bound");
        }, withinMs);
        try {
          await harness.commit(async (tx) => {
            const doc = await tx.doc(RunControlDoc);
            if (doc.stopCause !== "user-stop") doc.stopCause = cause;
          }, bounded.context);
          await harness.abortTask(admission.taskId, bounded.context);
          return await harness.waitForTask(admission.taskId, bounded.context);
        } catch (error) {
          if (elapsed) return undefined;
          throw error;
        } finally {
          clearTimeout(timer);
          bounded.cancel("stop ended");
        }
      },
      cleanup: async (input, context) => {
        cleaning ??= (async () => {
          phase = input.stop ? "stopping" : "closing";
          let settled: boolean;
          try {
            settled =
              !input.stop ||
              (await host.stop(
                BACKGROUND_CONTEXT,
                input.withinMs,
                input.stopCause,
              )) !== undefined;
          } catch (error) {
            await host.close("interrupted", BACKGROUND_CONTEXT);
            throw error;
          }
          if (settled) phase = "closing";
          const closeMode = settled ? input.mode : "interrupted";
          let beforeError: unknown;
          try {
            input.beforeClose?.(closeMode);
          } catch (error) {
            beforeError = error;
          }
          const receipt = await host.close(closeMode, BACKGROUND_CONTEXT);
          if (beforeError !== undefined) throw beforeError;
          return { kind: "closed", mode: closeMode, receipt };
        })();
        const bounded = withCancel(context);
        const timer = setTimeout(
          () => bounded.cancel("cleanup deadline"),
          input.withinMs,
        );
        try {
          return await awaitWithContext(cleaning, bounded.context);
        } catch (error) {
          if (bounded.context.abortSignal?.aborted)
            return { kind: "pending", phase, settled: cleaning };
          throw error;
        } finally {
          clearTimeout(timer);
          bounded.cancel("cleanup ended");
        }
      },
      close: (closeMode, context) =>
        awaitWithContext(
          (closing ??= Promise.resolve().then(async () => {
            const context = BACKGROUND_CONTEXT;
            mode = closeMode;
            const closeStarted = now();
            const endClose = startLogSpan(options.log, "harness.close", {
              "harness.mode": closeMode,
            });
            try {
              if (closeMode === "held") await credentialLost(harness, context);
            } finally {
              clearTimeout(backstop);
              clearTimeout(stopNewWork);
              unsubscribe();
              for (const span of taskSpans.values()) span.end("interrupted");
              taskSpans.clear();
              try {
                await harness.close(context);
              } finally {
                endClose();
                enqueueTelemetry(options.log, {
                  type: "close.timing",
                  startedAt: new Date(closeStarted).toISOString(),
                  durationMs: now() - closeStarted,
                  pastCutoffMs: Math.max(0, now() - options.run.cutoffAt),
                });
                await options.log?.flush?.();
              }
            }
            // Harness.close awaited the barrier; this joins it for its receipt.
            return barrier.closed(context);
          })),
          context,
        ),
    };
    return host;
  } catch (error) {
    return failOpen(error, () => harness.close(context));
  }
};
