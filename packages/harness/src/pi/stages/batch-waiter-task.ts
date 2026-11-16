import type { Context } from "@earendil-works/chord";
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
  publishSettled,
  type SectionsPublishSummary,
} from "../../publish-sections.ts";
import type { RunLog } from "../../run-log.ts";
import { definePolicyTask as defineTask } from "../failure-policy.ts";
import {
  childOf,
  disclosureGaps,
  finderEnds,
  finderResults,
  findersAtLimitGap,
  findersUnfinishedGap,
  publishingOf,
  type FollowOnAnswer,
  type Reading,
  type ReviewBatches,
  type ReviewStagesPort,
  type SettledPublishInput,
} from "../review-task.ts";
import type { FinderInput, FinderResult } from "./finder-task.ts";
import type { StageServices } from "./services.ts";

/**
 * The batch waiters of the publish phase (NEU-148, WP8; the scheduler lane's shape of 13 November,
 * `coordination/neu-148/design/publish-waiter-0016.md`, amended).
 *
 * - **One per batch.** The review creates every waiter in the one commit of its `link` phase that
 *   knows the batches, in batch order; that commit also names them in the review's checkpoint, so a
 *   replayed phase whose commit did not land creates them again and one that landed never does.
 * - **A chain.** Waiter k waits (a durable, pushed wait: `status: "waiting"`, `allSettled`) on its
 *   batch's reading tasks, the four finders (a finder ends after its Verify children) and waiter
 *   k-1. So no batch publishes before the finders end, and the calls are serial and in batch order
 *   by construction: no key, claim, lock, map, poll or timer of its own.
 * - **What it publishes.** On waking, it publishes only when the review is live (not stopped or
 *   finishing), not yet at Publish (it reads the review's `link` checkpoint, `publishingOf`), and
 *   its own batch is settled (`readings.settle`; never while a finder or its Verify has not
 *   completed, unless the run can have no successor): then one `publishSettled` call with every settled
 *   batch up to and including its own, in batch order, `ending: false`, the review's totals, and as
 *   gaps what the review disclosed by Link and the run's gaps from the plan, manifest and Map. A batch already in the run's chain is skipped by the publisher (frozen), so normally
 *   that publishes its own batch alone, and an earlier batch an earlier waiter could not publish is
 *   carried here. Otherwise it ends at once, publishing nothing, with a status that says why.
 * - **The cut-off.** The review waits for its readings, then commits to Publish waiting on every
 *   waiter: one that wakes after that ends `late`, and the review's ending call publishes its
 *   batch with the rest, after the last waiter ended.
 * - **No state of its own.** Its outcome says only how it ended; the chain in the computation store
 *   is the only record of what was published. A failed call is a recorded outcome (`failed`), never
 *   the review's failure, and the next waiter still runs.
 * - **No grant, no slot.** It makes no model call and takes no CPU grant: `publishSettled` runs
 *   through the stage runner, which binds the job's class but holds no grant, so a held publication
 *   key makes it wait for that publication (record 0016), never answer `KeyHeld`.
 */
export const BATCH_WAITER_TASK = "neuve.batch-waiter";

/**
 * Only its place and its predecessor: the batches, the readings and the finders are in the review's
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
  { readonly phase: "wait" } | { readonly phase: "publish" };
type Runtime = TaskRuntime<
  BatchWaiterInput,
  WaiterCheckpoint,
  BatchWaiterResult,
  object
>;
type Readings = NonNullable<ReviewStagesPort["readings"]>;
/** What a waiter calls: the readings' `settle` and the review's `publishSettled`. */
export type WaiterPort = {
  readonly settle: NonNullable<Readings["settle"]>;
  readonly publishSettled: NonNullable<ReviewStagesPort["publishSettled"]>;
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

/**
 * Every batch of `batches` up to and including `last`, settled or not, in batch order: what both a
 * waiter and the review's ending call hand on. Each batch's readings are read as they stand: one
 * not yet ended reads as undefined, which `settle` takes as not reached. Every call hands `settle`
 * each lens's end (`finderEnds`) and whether the run can have no successor (`final`): unless it is
 * final, a batch settles only once every finder completed.
 */
export const settleUpTo = async (
  runtime: Pick<Runtime, "getTask">,
  settle: WaiterPort["settle"],
  input: {
    readonly frameKey: string;
    readonly mapKey: string;
    readonly manifestKey: string;
    readonly batches: ReviewBatches;
    readonly readings: ReadonlyArray<Reading>;
    readonly finders: ReadonlyArray<FinderResult>;
    readonly through: number;
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
  const findersEnded = finderEnds(input.finders);
  const out: Array<{
    readonly key: string;
    readonly settled: Awaited<ReturnType<WaiterPort["settle"]>>;
  }> = [];
  for (const batch of input.batches.batches.slice(0, input.through + 1)) {
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
          finders: input.finders,
          findersEnded,
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
            : [
                ...(batch?.readings ?? []).flatMap((name) => {
                  const id = byName.get(name);
                  return id === undefined ? [] : [id as TaskId];
                }),
                ...view.finders.map((f) => f.task as TaskId),
                ...(input.previous === null ? [] : [input.previous as TaskId]),
              ];
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
        let result: BatchWaiterResult;
        try {
          const outcomes = await Promise.all(
            view.finders.map((f) => endedOutcome(runtime, f.task, context)),
          );
          // Link's entry for a finder with no result, fixed in the review's checkpoint: a replayed
          // waiter hands the same call.
          const finders = finderResults(view.finders, outcomes, view.reason);
          // With no successor (decided when the waiters were made), unfinished finders hold no
          // batch, and the packet says they did not finish.
          const settled = await settleUpTo(
            runtime,
            ports.settle,
            {
              ...view,
              finders,
              through: input.index,
              last: () => false,
              final: view.final,
            },
            runtime,
            context,
            runtime.signal,
          );
          const own = settled.at(-1)?.settled;
          if (own === undefined || !own.settled)
            result = {
              status: "not-settled",
              ...(own === undefined || own.settled
                ? {}
                : { kind: own.gap.kind }),
            };
          else {
            await ports.publishSettled(
              {
                batches: settled.flatMap(({ settled: s }) =>
                  s.settled ? [s.batch] : [],
                ),
                totals: view.batches.totals,
                ending: false,
                // On every call: what the review disclosed by Link (Precompute, the front's
                // freshness, the finders' start) and the run's gaps from the plan, manifest, Map
                // and finders, so no packet that holds agent decisions hides them. Link's and the
                // readings' own disclosures come on the ending call.
                gaps: [
                  ...disclosureGaps(view.disclosures),
                  ...view.batches.gaps,
                  ...findersUnfinishedGap(finderEnds(finders), view.final),
                  ...findersAtLimitGap(finders),
                ],
                // Read only for completeness, which a call that is not the ending one never has.
                stages: [],
              },
              runtime.signal,
            );
            result = { status: "published" };
          }
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          result = { status: "failed" };
        }
        await finish(result);
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
  const publish: NonNullable<ReviewStagesPort["publishSettled"]> = async (
    input,
    signal,
  ) =>
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
        if (!input.ending) return [] as ReadonlyArray<StageRecord>;
        const done: StageRecord = {
          stage: "publish",
          status: "computed",
          wallMs: (yield* Clock.currentTimeMillis) - started,
          note: settledNote(summary),
        };
        ctx.log.write({ type: "stage", ...done });
        yield* recordPublishStage(ctx, done, summary.manifest);
        return [done] as ReadonlyArray<StageRecord>;
      }).pipe(Effect.withSpan("harness.stage.publish")),
      signal,
    );
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
    waiterPort = { settle: readings.settle, publishSettled: publish };
  const port: Pick<
    ReviewStagesPort,
    | "batchWaiter"
    | "publishSettled"
    | "followOnLeft"
    | "followOn"
    | "chainTotals"
  > = ready
    ? {
        batchWaiter: childOf(task),
        publishSettled: publish,
        followOnLeft,
        followOn,
        chainTotals,
      }
    : {};
  return { task, port };
};
