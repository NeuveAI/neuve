import {
  CrossBatchClaimsDoc,
  checkRecord,
  type CheckedCrossBatchClaim,
} from "../cross-batch-claims.ts";
import { childId } from "./children.ts";
import type { Context } from "@earendil-works/chord";
import { defineDoc } from "@earendil-works/pi-durable";
import type {
  Task,
  TaskId,
  TaskOutcome,
  TaskRuntime,
} from "@earendil-works/pi-durable";
import { Log, ReviewFollowOn } from "@neuve/records-core";
import { Clock, Effect, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { logTimed, scopedLogSpan } from "../../log-span.ts";
import type { StageRecord } from "../../pipeline.ts";
import { recordPublishStage } from "../../publish.ts";
import {
  batchKeyOf,
  publishedBatchClaims,
  publishSettled,
  type SectionsPublishSummary,
} from "../../publish-sections.ts";
import type { RunLog } from "../../run-log.ts";
import { definePolicyTask as defineTask } from "../failure-policy.ts";
import {
  childOf,
  disclosureGaps,
  publishingOf,
  type FollowOnAnswer,
  type Reading,
  type ReviewBatches,
  type SettledPublishInput,
  type ReviewStagesPort,
} from "../review-task.ts";
import { storedOutput } from "../../pipeline.ts";
import {
  ClaimStored,
  claimAnchor,
  claimVerdict,
} from "../../readings/claims.ts";
import type { StageServices } from "./services.ts";

export const BATCH_WAITER_TASK = "neuve.batch-waiter";

/**
 * Its place and predecessor. The batches and readings are in the review's
 * `link` checkpoint that created it (`publishingOf`), so the stored inputs grow with the number of
 * batches, not with its square.
 */
export type BatchWaiterInput = {
  /** This waiter's batch, by its place in the review's batches. */
  readonly index: number;
  /** Waiter k-1; null for the first batch. */
  readonly previous: TaskId<BatchWaiterResult> | null;
};
/** What a waiter reads from its review (`publishingOf`). */
type View = NonNullable<ReturnType<typeof publishingOf>>;
export type BatchWaiterResult = {
  /**
   * `published`: its call returned. `not-settled`: its batch is not settled (`kind` says why).
   * `late`: the review was already at Publish, stopped or finishing. `failed`: the call or a read failed. `stopped`: the
   * review stopped.
   */
  readonly status: "published" | "not-settled" | "late" | "failed" | "stopped";
  readonly kind?: "not-reached" | "quota" | "refused";
};
type WaiterCheckpoint =
  | { readonly phase: "wait" }
  | { readonly phase: "publish" }
  | { readonly phase: "write"; readonly input: SettledPublishInput };
type Runtime = TaskRuntime<
  BatchWaiterInput,
  WaiterCheckpoint,
  BatchWaiterResult,
  object
>;
type Readings = NonNullable<ReviewStagesPort["readings"]>;
const BatchTurnDoc = defineDoc<{ passed: boolean }>({
  kind: "neuve.batch-turn",
  version: 1,
  scope: "task",
  initial: () => ({ passed: false }),
});

/** A predecessor releases the next waiter by finishing or by waiting on incoming checks. */
const waitForTurn = async (
  runtime: Runtime,
  previous: TaskId<BatchWaiterResult>,
  context: Context,
) => {
  const watch = await runtime.watchDoc(BatchTurnDoc, previous, context);
  try {
    if (watch?.value?.passed === true) return;
    const ended = runtime.waitForTask(previous, context);
    if (watch === undefined) {
      await ended;
      return;
    }
    const passed = new Promise<void>((resolve) => {
      watch.start(async (value) => {
        if (value?.passed === true) resolve();
      });
    });
    await Promise.race([ended, passed]);
  } finally {
    await watch?.stop();
  }
};

/** What a waiter calls: the readings' `settle` and the review's `publishSettled`. */
export type WaiterPort = {
  readonly settle: NonNullable<Readings["settle"]>;
  readonly publish: (
    input: SettledPublishInput,
    signal: AbortSignal,
  ) => Promise<ReadonlyArray<SectionsPublishSummary["refused"][number]>>;
};

/**
 * The review's view for its waiter, while it may still publish per batch: live, not yet at Publish
 * (`publishingOf` reads only a `link` checkpoint). Undefined otherwise.
 */
const reviewOf = async (
  runtime: Pick<Runtime, "getTask" | "taskId">,
  context: Context,
): Promise<{
  readonly owner: TaskId | undefined;
  readonly view: View | undefined;
}> => {
  const owner = (await runtime.getTask(runtime.taskId, context))?.owner;
  const review =
    owner === undefined ? undefined : await runtime.getTask(owner, context);
  return {
    owner,
    // A review that was stopped, or is finishing, publishes nothing more per batch.
    view:
      review === undefined ||
      review.abortRequested ||
      review.state.checkpoint === undefined
        ? undefined
        : publishingOf(review.state.checkpoint),
  };
};

/** A task's outcome once it is terminal; undefined while it is not. */
export const endedOutcome = async <R>(
  runtime: Pick<Runtime, "getTask">,
  id: TaskId<R>,
  context: Context,
): Promise<TaskOutcome<R> | undefined> => {
  const record = await runtime.getTask(id, context);
  return record?.state.status === "terminal"
    ? (record.state.outcome as TaskOutcome<R>)
    : undefined;
};

/** Only registered Verify children can delay a batch. Later registrations can race selection. */
export const crossBatchChecks = async (
  runtime: Pick<Runtime, "getTask" | "snapshot">,
  context: Context,
  batches?: ReadonlySet<string>,
) => {
  const registered = Object.values(
    (await runtime.snapshot(CrossBatchClaimsDoc, context))?.claims ?? {},
  ).filter((claim) => batches === undefined || batches.has(claim.target.batch));
  const waiting = new Map<string, Array<TaskId<StageRecord>>>();
  const checked: Array<CheckedCrossBatchClaim> = [];
  for (const claim of registered) {
    const id =
      claim.task === null ? undefined : childId<StageRecord>(claim.task);
    const task =
      id === undefined ? undefined : await runtime.getTask(id, context);
    const state = task?.state;
    if (
      id !== undefined &&
      state !== undefined &&
      state.status !== "terminal"
    ) {
      const siblings = waiting.get(claim.target.batch) ?? [];
      siblings.push(id);
      waiting.set(claim.target.batch, siblings);
    }
    const outcome = state?.status === "terminal" ? state.outcome : undefined;
    checked.push(
      checkRecord(
        claim,
        outcome?.status === "completed" ? outcome.result : undefined,
      ),
    );
  }
  return { registered, waiting, checked };
};

export const settleUpTo = async (
  runtime: Pick<Runtime, "getTask">,
  settle: WaiterPort["settle"],
  input: {
    readonly frameKey: string;
    readonly mapKey: string;
    readonly manifestKey: string;
    readonly batches: ReviewBatches;
    readonly readings: ReadonlyArray<Reading>;
    readonly through: number;
    readonly include?: ReadonlySet<string>;
    readonly incoming?: ReadonlyArray<CheckedCrossBatchClaim>;
    readonly last: (batch: string) => boolean;
    readonly final: boolean;
    /** The readings' plan was cut at its cut-off (`Publishing.planCut`). */
    readonly planCut?: boolean | undefined;
  },
  reader: Parameters<WaiterPort["settle"]>[1],
  context: Context,
  signal: AbortSignal,
) => {
  const byName = new Map(input.readings.map((r) => [r.name, r.task]));
  const out: Array<{
    readonly key: string;
    readonly settled: Awaited<ReturnType<WaiterPort["settle"]>>;
  }> = [];
  for (const batch of input.batches.batches.slice(0, input.through + 1)) {
    if (input.include !== undefined && !input.include.has(batch.key)) continue;
    const readings = await Promise.all(
      batch.readings.map(async (name) => {
        const id = byName.get(name);
        return {
          name,
          outcome:
            id === undefined
              ? undefined
              : await endedOutcome(runtime, id, context),
        };
      }),
    );
    out.push({
      key: batch.key,
      settled: await settle(
        {
          frameKey: input.frameKey,
          mapKey: input.mapKey,
          manifestKey: input.manifestKey,
          batch: batch.key,
          readings,
          ...(input.incoming === undefined
            ? {}
            : {
                incoming: input.incoming.filter(
                  (claim) => claim.target.batch === batch.key,
                ),
              }),
          final: input.final,
          last: input.last(batch.key),
          planCut: input.planCut === true,
        },
        reader,
        context,
        signal,
      ),
    });
  }
  return out;
};

export const batchWaiterTask = (
  log: RunLog | undefined,
  port: () => WaiterPort | undefined,
): Task<BatchWaiterInput, WaiterCheckpoint, BatchWaiterResult, object> => {
  const attributes = (runtime: Runtime, phase: string) => ({
    "harness.task_id": runtime.taskId,
    "harness.task_kind": "batch-waiter",
    "harness.phase": phase,
  });
  const commit = (
    runtime: Runtime,
    phase: string,
    next: string,
    work: () => Promise<void>,
  ) =>
    logTimed(
      log,
      "harness.pi.commit",
      { ...attributes(runtime, phase), "harness.next_phase": next },
      work,
    );
  const end = (runtime: Runtime, result: BatchWaiterResult, context: Context) =>
    commit(runtime, "publish", "terminal", () =>
      runtime.commit(
        () => ({
          status: "terminal",
          outcome: { status: "completed", result: { ...result } },
        }),
        context,
      ),
    );
  return defineTask<BatchWaiterInput, WaiterCheckpoint, BatchWaiterResult>({
    name: BATCH_WAITER_TASK,
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      wait: async (task, runtime, context) => {
        using phaseSpan = scopedLogSpan(
          log,
          "harness.pi.phase",
          attributes(runtime, "wait"),
        );
        const input = task.input;
        const { view } = await reviewOf(runtime, context);
        // A review already at Publish: nothing to wait for; the publish phase ends it as late.
        const batch = view?.batches.batches[input.index];
        const byName = new Map(
          (view?.readings ?? []).map((r) => [r.name, r.task]),
        );
        const on: Array<TaskId> =
          view === undefined
            ? []
            : (batch?.readings ?? []).flatMap((name) => {
                const id = byName.get(name);
                return id === undefined ? [] : [id];
              });
        await commit(runtime, "wait", "publish", () =>
          runtime.commit(
            () =>
              on.length === 0
                ? { status: "running", checkpoint: { phase: "publish" } }
                : {
                    status: "waiting",
                    on,
                    policy: "allSettled",
                    checkpoint: { phase: "publish" },
                  },
            context,
          ),
        );
      },
      publish: async (task, runtime, context) => {
        using phaseSpan = scopedLogSpan(
          log,
          "harness.pi.phase",
          attributes(runtime, "publish"),
        );
        const input = task.input;
        if (input.previous !== null)
          await waitForTurn(runtime, input.previous, context);
        const ports = port();
        const { owner, view } = await reviewOf(runtime, context);
        const batch = view?.batches.batches[input.index];
        // One row however it ends: task IDs, the batch's hash, its place and how it ended.
        const finish = (result: BatchWaiterResult) => {
          log?.write({
            type: "publish.waiter",
            taskId: runtime.taskId,
            owner: owner ?? null,
            batch: batch?.key ?? null,
            index: input.index,
            status: result.status,
            kind: result.kind ?? null,
          });
          return end(runtime, result, context);
        };
        if (view === undefined) return finish({ status: "late" });
        if (batch === undefined || ports === undefined)
          return finish({ status: "failed" });
        try {
          const earlier = await Promise.all(
            view.waiters.slice(0, input.index).map(async ({ batch, task }) => {
              const ended = await endedOutcome(runtime, task, context);
              return ended === undefined ||
                (ended.status === "completed" &&
                  ended.result.status === "published")
                ? []
                : [batch];
            }),
          );
          const candidates = new Set([...earlier.flat(), batch.key]);
          const { registered, waiting, checked } = await crossBatchChecks(
            runtime,
            context,
            candidates,
          );
          const ownChecks = waiting.get(batch.key);
          if (ownChecks !== undefined)
            return commit(runtime, "publish", "publish", () =>
              runtime.commit(async (tx) => {
                (await tx.doc(BatchTurnDoc, runtime.taskId)).passed = true;
                return {
                  status: "waiting",
                  on: ownChecks,
                  policy: "allSettled",
                  checkpoint: { phase: "publish" },
                };
              }, context),
            );
          // A later waiter can recover an earlier batch after a transient refusal.
          // An incoming check on an earlier batch must not delay the current one.
          const built = await settleUpTo(
            runtime,
            ports.settle,
            {
              ...view,
              include: new Set(
                [...candidates].filter((key) => !waiting.has(key)),
              ),
              through: input.index,
              last: () => false,
              final: view.final,
              incoming: checked,
            },
            runtime,
            context,
            runtime.signal,
          );
          const own = built.at(-1)?.settled;
          if (own === undefined) return finish({ status: "not-settled" });
          if (!own.settled)
            return finish({ status: "not-settled", kind: own.gap.kind });
          const selected = built.flatMap(({ key, settled }) =>
            settled.settled ? [{ key, batch: settled.batch }] : [],
          );
          const keys = new Set(selected.map(({ key }) => key));
          const seen = registered.filter((claim) =>
            keys.has(claim.target.batch),
          );

          await commit(runtime, "publish", "write", () =>
            runtime.commit(async (tx) => {
              // Select the input in the same native transaction used to register incoming claims.
              // A new Verify child makes this build stale and will wake its retried phase.
              const doc = await tx.doc(CrossBatchClaimsDoc);
              const peers = Object.values(doc.claims).filter((claim) =>
                keys.has(claim.target.batch),
              );
              if (
                peers.length !== seen.length ||
                seen.some((claim) => doc.claims[claim.key]?.task !== claim.task)
              )
                return { status: "running", checkpoint: { phase: "publish" } };
              return {
                status: "running",
                checkpoint: {
                  phase: "write",
                  input: {
                    batches: selected.map(({ batch }) => batch),
                    totals: view.batches.totals,
                    ending: false,
                    gaps: [
                      ...disclosureGaps(view.disclosures),
                      ...view.batches.gaps,
                    ],
                    stages: [],
                  },
                },
              };
            }, context),
          );
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          await finish({ status: "failed" });
        }
      },
      write: async (task, runtime, context) => {
        const ports = port();
        const { input } = task.state.checkpoint;
        const batch = input.batches.at(-1);
        const key = batch === undefined ? null : batchKeyOf(batch.paths);
        let status: BatchWaiterResult["status"] = "failed";
        if (ports !== undefined)
          try {
            const refused = await ports.publish(input, runtime.signal);
            if (!refused.some(({ batch }) => batch === key))
              status = "published";
          } catch (error) {
            if (runtime.signal.aborted) throw error;
          }
        log?.write({
          type: "publish.waiter",
          taskId: runtime.taskId,
          batch: key,
          index: task.input.index,
          status,
          kind: null,
        });
        await end(runtime, { status }, context);
      },
    },
    abort: (_task, runtime, context) =>
      commit(runtime, "abort", "terminal", () =>
        runtime.commit(
          () => ({
            status: "terminal",
            outcome: {
              status: "aborted",
              reason: "stopped",
              result: { status: "stopped" },
            },
          }),
          context,
        ),
      ),
  });
};

/** The publish phase's note on its stage record, from what the ending call published. */
export const settledNote = (summary: SectionsPublishSummary) =>
  `packet ${summary.complete ? "complete" : "incomplete"}${summary.ordinal === null ? "" : ` (publication ${summary.ordinal})`}: ${summary.counts.batches} batch(es), ${summary.counts.units} unit(s); pending ${summary.pending.batches} batch(es), ${summary.pending.sections} section(s); ${summary.frozen.length} already published, ${summary.refused.length} refused${summary.manifest === null ? "" : `; manifest blob ${summary.manifest.slice(0, 12)}`}`;

/** The follow-on runs a review may ask for (14.6). */
export const FOLLOW_ON_CAP = 8;

/**
 * The publish phase's part of the review's stage port, given only when the run's frozen
 * configuration has the readings and the readers' port gives `batches` and `settle`: the waiter's
 * starter, `publishSettled` and the follow-on ask. The waiter task is returned either way, for the
 * stages extension to register, so a review that created waiters always resumes them.
 */
export const settledStages = (
  services: StageServices,
  readings: Readings | undefined,
) => {
  const { ctx } = services;
  const publication = (signal: AbortSignal) =>
    services.run(publishedBatchClaims(ctx.cycleId, ctx.runKey), signal);
  const write = (input: SettledPublishInput, signal?: AbortSignal) =>
    services.run(
      Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis;
        const summary = yield* publishSettled(ctx, {
          batches: [...input.batches],
          totals: input.totals,
          ending: input.ending,
          gaps: [...input.gaps],
          stages: input.stages.map((stage) => ({ ...stage })),
        });
        // Each call's outcome, as counts and keys only; the ending call also records the stage.
        ctx.log.write({
          type: "publish.settled",
          ending: input.ending,
          handed: input.batches.length,
          ordinal: summary.ordinal,
          packetEventId: summary.packetEventId,
          complete: summary.complete,
          pending: summary.pending,
          frozen: summary.frozen.length,
          refused: summary.refused.map((r) => r.check),
          closure: summary.closure,
        });
        if (!input.ending) return { stages: [], refused: summary.refused };
        const done: StageRecord = {
          stage: "publish",
          status: "computed",
          wallMs: (yield* Clock.currentTimeMillis) - started,
          note: settledNote(summary),
        };
        ctx.log.write({ type: "stage", ...done });
        yield* recordPublishStage(ctx, done, summary.manifest);
        return { stages: [done], refused: summary.refused };
      }).pipe(Effect.withSpan("harness.stage.publish")),
      signal,
    );
  const publish: NonNullable<ReviewStagesPort["publishSettled"]> = async (
    input,
    signal,
  ) => (await write(input, signal)).stages;
  const retainUnpublishedClaims: NonNullable<
    ReviewStagesPort["retainUnpublishedClaims"]
  > = async (claims, signal) => {
    if (claims.length === 0) return;
    const published = await publication(signal);
    const logged = new Set(
      ctx.log
        .read()
        .filter((row) => row.type === "review.claim-unpublished")
        .map((row) => row["claim"]),
    );
    for (const { key, verifyKey, target, comment, from, answer } of claims) {
      const fate = published.get(target.batch)?.find(({ id }) => id === key);
      if (fate?.fate === "published" || logged.has(key)) continue;
      const verify =
        verifyKey === null
          ? undefined
          : Option.getOrUndefined(
              await services.run(
                Effect.option(storedOutput(ctx, verifyKey, ClaimStored)),
                signal,
              ),
            );
      const reason =
        fate?.reason ??
        (verify === undefined || verify.claim !== key
          ? "check-not-completed"
          : claimVerdict(verify) !== "confirmed"
            ? "check-not-confirmed"
            : published.has(target.batch)
              ? "batch-published"
              : "batch-pending");
      ctx.log.write({
        type: "review.claim-unpublished",
        claim: key,
        batch: target.batch,
        section: target.section,
        reason,
        from,
        answer,
        verify: verifyKey,
        kind: comment.kind,
        anchor: claimAnchor(comment),
      });
    }
  };
  const followOn: NonNullable<ReviewStagesPort["followOn"]> = async (signal) =>
    services.run(
      ReviewFollowOn.requestFollowOn({
        requestId: ctx.runId,
        cap: FOLLOW_ON_CAP,
      }).pipe(
        Effect.map((answer): FollowOnAnswer =>
          answer._tag === "Requested" ? "requested" : "cap-reached",
        ),
        // Refused: this run is not the one going (no unfinished job of its own), or the next
        // generation's job is another request's. No follow-on is asked; the batches stay pending.
        Effect.catchTag("InvalidEvent", () =>
          Effect.succeed("refused" as const),
        ),
        Effect.tap((answer) =>
          Effect.sync(() =>
            ctx.log.write({ type: "publish.follow-on", answer }),
          ),
        ),
      ),
      signal,
    );
  const followOnLeft: NonNullable<ReviewStagesPort["followOnLeft"]> = async (
    signal,
  ) =>
    services.run(
      Effect.map(
        ReviewFollowOn.followOnsOf({ requestId: ctx.runId }),
        (behind) => behind < FOLLOW_ON_CAP,
      ),
      signal,
    );
  // The newest packet of this run key's chain, by its idempotency key (`publish-sections.ts`
  // namespaces each packet `review:<cycle>:<run key>:packet:`): its counts cover the review so far,
  // published and pending, so their sum is the review's totals.
  const chainTotals: NonNullable<ReviewStagesPort["chainTotals"]> = async (
    signal,
  ) =>
    services.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const prefix = `review:${ctx.cycleId}:${ctx.runKey}:packet:`;
        const [row] = yield* sql<{ id: string }>`SELECT id FROM events
          WHERE kind = 'packet.published@2' AND idempotency_key >= ${prefix}
            AND idempotency_key < ${`${prefix}\u{10FFFF}`} ORDER BY seq DESC LIMIT 1`;
        if (row === undefined) return undefined;
        const event = Option.getOrUndefined(yield* Log.get(row.id))?.event;
        if (event?.kind !== "packet.published@2") return undefined;
        const { counts } = event.payload;
        return {
          batches: counts.batches + counts.pending.batches,
          sections: counts.sections + counts.pending.sections,
        };
      }),
      signal,
    );
  const ready =
    ctx.config.readings !== undefined &&
    readings?.batches !== undefined &&
    readings.settle !== undefined;
  let waiterPort: WaiterPort | undefined;
  const task = batchWaiterTask(ctx.log, () => waiterPort);
  if (ready && readings.settle !== undefined)
    waiterPort = {
      settle: readings.settle,
      publish: async (input, signal) => (await write(input, signal)).refused,
    };
  const start = childOf(task);
  const port: Pick<
    ReviewStagesPort,
    | "batchWaiter"
    | "publishSettled"
    | "followOnLeft"
    | "followOn"
    | "chainTotals"
    | "retainUnpublishedClaims"
  > = ready
    ? {
        batchWaiter: async (tx, input, owner) => {
          const id = await start(tx, input, owner);
          await tx.doc(BatchTurnDoc, id);
          return id;
        },
        publishSettled: publish,
        followOnLeft,
        followOn,
        chainTotals,
        retainUnpublishedClaims,
      }
    : {};
  return { task, port };
};
