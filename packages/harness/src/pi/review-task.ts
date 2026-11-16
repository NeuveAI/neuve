import { readData } from "@neuve/records-core";
import type { Context } from "@earendil-works/chord";
import {
  defineExtension,
  type Extension,
  type Task,
  type TaskDefinition,
  type TaskId,
  type TaskOutcome,
  type TaskRuntime,
  type Tx,
  type DocumentReader,
} from "@earendil-works/pi-durable";
import { Blobs, Computations } from "@neuve/records-core";
import { Effect, Option } from "effect";
import { z } from "zod";
import { findDeadline } from "../budget.ts";
import { releaseRelationsCache } from "../relations-index.ts";
import { releaseIndexCache } from "../search-index.ts";
import { FINDERS } from "../find.ts";
import type { Freshness } from "../freshness.ts";
import type { FillResult } from "../link.ts";
import { logTimed, scopedLogSpan, waitSpans } from "../log-span.ts";
import type { PrecomputeOutput, StageRecord } from "../pipeline.ts";
import type { PublishCandidate } from "../publish.ts";
import type { SettledBatch } from "../publish-sections.ts";
import type { RunLog } from "../run-log.ts";
import type { ReviewRunInput } from "./contracts.ts";
import { definePolicyTask as defineTask } from "./failure-policy.ts";
import type { FrontInput, FrontResult } from "./stages/front-task.ts";
import {
  finderEndOf,
  type FinderEnd,
  type FinderInput,
  type FinderResult,
  type FinderStatus,
} from "./stages/finder-task.ts";
import type { LeadsInput, LeadsResult } from "./stages/leads-task.ts";
import type {
  ReadingsPlanInput,
  ReadingsPlanResult,
} from "./stages/readings-plan-task.ts";
import {
  markReviewPublished,
  type RelationsInput,
  type RelationsResult,
} from "./stages/relations-task.ts";
import {
  NO_READINGS,
  droppedPlanGap,
  findersHeldBy,
} from "../readings/batches.ts";
import {
  settleUpTo,
  type BatchWaiterInput,
  type BatchWaiterResult,
} from "./stages/batch-waiter-task.ts";

export type PublishInput = {
  readonly findings?: ReadonlyArray<string> | undefined;
  readonly stages: ReadonlyArray<StageRecord>;
  readonly candidates: ReadonlyArray<PublishCandidate>;
  readonly sources: {
    readonly manifest: string | null;
    readonly changeMap: string | null;
    readonly scope: string | null;
  };
  readonly strongestStratum: string;
  readonly disclosures: Freshness["disclosures"];
  readonly reason?: string | undefined;
};

export type StartChild<I, R> = (
  tx: Tx,
  input: I,
  owner: TaskId,
) => Promise<TaskId<R>>;
export const childOf =
  <I, S extends { phase: string }, R, H extends object>(
    task: Task<I, S, R, H>,
  ): StartChild<I, R> =>
  (tx, input, owner) =>
    tx.createTask(task, input, { ownership: { kind: "task", taskId: owner } });

type LinkResult = Effect.Success<ReturnType<typeof import("../link.ts").link>>;

type MapInput = { readonly mapKey: string; readonly manifestKey: string };
/** A gap about the run, or about a batch that is not settled, as `publishSettled` takes it. */
export type PublishGap = {
  readonly key: string;
  readonly kind: string;
  readonly detail: string;
  readonly cause?: string | undefined;
};
/** One batch of the review as its waiter knows it (NEU-148, the publish phase). */
export type ReviewBatch = {
  /** `batchKeyOf(paths)`: the batch's key, which names its waiter. */
  readonly key: string;
  /** The names of the reading tasks that read any section of this batch. */
  readonly readings: ReadonlyArray<string>;
};
/** The review's batches, in its batch order, with the totals and the run's gaps `publishSettled` takes. */
export type ReviewBatches = {
  readonly batches: ReadonlyArray<ReviewBatch>;
  readonly totals: { readonly batches: number; readonly sections: number };
  /** About the run, not one batch: equal on every call of the run, so never repeated per packet. */
  readonly gaps: ReadonlyArray<PublishGap>;
};
/** One batch built for `publishSettled`, or why it is not settled. */
export type Settled =
  | { readonly settled: true; readonly batch: SettledBatch }
  | {
      readonly settled: false;
      /**
       * `not-reached`: a reading of the batch was not started, was interrupted by the cut-off, or has
       * not ended; a follow-on run can read it. `quota`: a provider quota refusal; pending, and the
       * review asks for no follow-on run. `refused`: a check `publishSettled` makes failed; pending.
       */
      readonly gap: {
        readonly key: string;
        readonly kind: "not-reached" | "quota" | "refused";
        readonly detail: string;
      };
    };
/** What `publishSettled` is handed for one call, apart from the run's context. */
export type SettledPublishInput = {
  readonly batches: ReadonlyArray<SettledBatch>;
  readonly totals: ReviewBatches["totals"];
  readonly ending: boolean;
  readonly gaps: ReadonlyArray<PublishGap>;
  readonly stages: ReadonlyArray<StageRecord>;
};
/** How the run's ask for its follow-on run ended (`ReviewFollowOn.requestFollowOn`, cap 8). */
export type FollowOnAnswer = "requested" | "cap-reached" | "refused";
/** A reading task the readings' plan created for the review, by the name its collector knows it by. */
export type Reading = { readonly name: string; readonly task: TaskId<unknown> };
/** What the readings' `prepare` hands their `create`; opaque to the review, which only passes it on. */
type ReadingsPrepared = Readonly<Record<string, unknown>>;
/**
 * What the readings' plan reads: only what exists when Precompute ends. A reading that needs the
 * Frame or the Map waits on the front task itself.
 */
export type ReadingsPrepareInput = {
  readonly manifestKey: string;
  readonly cutoffAt: number;
  readonly front: TaskId<FrontResult>;
  /** The head gate the readings wait on; given only with readings on. */
  readonly relations?: TaskId<RelationsResult>;
};
/** What the readings' collector returns, for Link to add to the run's stages and disclosures. */
type Read = Awaited<
  ReturnType<NonNullable<ReviewStagesPort["readings"]>["collect"]>
>;
export interface ReviewStagesPort {
  readonly front: StartChild<FrontInput, FrontResult>;
  /**
   * Unused: the front task starts the finders when Frame lands (front-task.ts). Kept optional only
   * because the runtime's wiring (`pi/attempt.ts`) still passes it; remove with that line.
   */
  readonly finder?: StartChild<FinderInput, FinderResult>;
  /** The range's leads and tree indexes, which no step waits for (NEU-148); absent in some tests. */
  readonly leads?: StartChild<LeadsInput, LeadsResult>;
  /** The range's commits' relations, which no step waits for (NEU-148); given only with readings on. */
  readonly relations?: StartChild<RelationsInput, RelationsResult>;
  /**
   * The head gate the readings wait on (NEU-148 round 20, `headGateOf`): the head's relations to the
   * readings' bound. Given with `relations`, created in the same commit.
   */
  readonly headGate?: StartChild<RelationsInput, RelationsResult>;
  readonly coverage?: (signal?: AbortSignal) => Promise<Prepared>;
  readonly precompute: (
    signal?: AbortSignal,
    deadline?: number,
  ) => Promise<Prepared>;
  readonly fill: (
    input: MapInput,
    reader: DocumentReader,
    context: Context,
    signal?: AbortSignal,
  ) => Promise<FillResult>;
  readonly link: (
    input: MapInput & {
      readonly frameKey: string;
      readonly fill: FillResult | null;
      readonly finders: ReadonlyArray<FinderResult>;
    },
    reader: DocumentReader,
    context: Context,
    signal?: AbortSignal,
  ) => Promise<LinkResult & { readonly fillRecord?: StageRecord }>;
  readonly publish: (
    input: PublishInput,
    signal?: AbortSignal,
  ) => Promise<ReadonlyArray<StageRecord>>;
  /**
   * Starts the readings' plan (`pi/stages/readings-plan-task.ts`), which calls `readings.prepare`
   * and `readings.create`; given together with `readings` (`readingsStages`). Absent, or without
   * `readings`, the review plans none.
   */
  readonly readingsPlan?: StartChild<ReadingsPlanInput, ReadingsPlanResult>;
  /**
   * The publish phase (NEU-148, WP8), given only when the run's frozen configuration has the
   * readings: one waiter per batch (`pi/stages/batch-waiter-task.ts`), the call to records'
   * `publishSettled`, and the ask for the follow-on run. The review publishes through them only
   * when the readings port also gives `batches` and `settle`; otherwise it publishes as before
   * (`publish`). A run publishes through one of the two, never both.
   */
  readonly batchWaiter?: StartChild<BatchWaiterInput, BatchWaiterResult>;
  /**
   * One serial `publishSettled` call with its stage record (`recordPublishStage`) when `ending`;
   * outside any CPU grant and model-call slot. It rejects when the publisher fails.
   */
  readonly publishSettled?: (
    input: SettledPublishInput,
    signal?: AbortSignal,
  ) => Promise<ReadonlyArray<StageRecord>>;
  /**
   * Whether a follow-on run is left under the cap: read only (`ReviewFollowOn.followOnsOf`), so the
   * ending call can be made before the ask. Absent, or when the read fails, none is left.
   */
  readonly followOnLeft?: (signal?: AbortSignal) => Promise<boolean>;
  /**
   * The review's totals as the newest packet of this run key's chain states them (its batches and
   * sections, published and pending): what a follow-on run that made no batches of its own hands its
   * ending call, so that packet's pending counts stay current. Undefined when the chain has no
   * packet. Read only.
   */
  readonly chainTotals?: (
    signal?: AbortSignal,
  ) => Promise<ReviewBatches["totals"] | undefined>;
  /**
   * Asks for the run's follow-on run, once per run, only after the ending call is stored (records'
   * own key makes a repeat the same ask).
   */
  readonly followOn?: (signal?: AbortSignal) => Promise<FollowOnAnswer>;
  /** The model readings of the changed sections (NEU-148); absent, the review has none. */
  readonly readings?: {
    /**
     * Everything slow, outside any commit: no transaction is open. The readings' plan task calls it
     * as soon as Precompute's commit created that task beside the front task, so it runs beside
     * Frame and Map, and nothing but Link waits for that task. Deterministic for its input, so a
     * replayed plan may call it again. Its signal aborts at a stop and at the bound measured as the
     * plan starts (`findDeadline`, at most 75 s before the cut-off), and it must honour it: the plan
     * does not wait for one that ignores it but ends without readings at that bound, and that call
     * keeps running unowned, a defect of the port's implementation. When it throws or that bound
     * ends it, the review goes on without readings. What stays true by design: Link waits for the
     * reading tasks themselves, so a slow reading delays Link; bounding them is the port owner's.
     */
    readonly prepare: (
      input: ReadingsPrepareInput,
      signal: AbortSignal,
    ) => Promise<ReadingsPrepared>;
    /**
     * Creates every reading task inside the caller's commit, from what `prepare` returned; no slow
     * work. That commit is the plan task's own terminal one; `owner` is the review, which owns every
     * reading. Idempotent by task name and never throws. Returns them in creation order. They include
     * each reading group's briefing task (`brief.…`), so a slow briefing delays Link and its
     * batch only because Link waits on the reader tasks returned here, never through a wait of its own.
     */
    readonly create: (
      tx: Tx,
      prepared: ReadingsPrepared,
      owner: TaskId,
    ) => Promise<ReadonlyArray<Reading>>;
    /** Turns the reading tasks' outcomes into stage records and disclosures. It never throws for a failed reading. */
    readonly collect: (
      input: MapInput & {
        readonly frameKey: string;
        readonly readings: ReadonlyArray<{
          readonly name: string;
          readonly outcome: TaskOutcome<unknown> | undefined;
        }>;
        /** The finders' results exactly as Link gets them, the review's own entry for a cut-short one included. */
        readonly finders?: ReadonlyArray<FinderResult>;
        /** The readings' plan task ended cut at its cut-off (`Publishing.planCut`). */
        readonly planCut?: boolean | undefined;
      },
      reader: DocumentReader,
      context: Context,
      signal: AbortSignal,
    ) => Promise<{
      readonly stages: ReadonlyArray<StageRecord>;
      readonly disclosures: Freshness["disclosures"];
    }>;
    /**
     * The review's batches, in its batch order, each with the reading tasks its sections wait on,
     * and the review's totals and run gaps: code only, deterministic for its input. Called once the
     * plan named its readings, before the commit that creates the waiters, and once more by the
     * ending call with the finders' results, whose run gaps (a finding that could not be read, or
     * one no section of any batch owns) only that call carries. A batch's waited-on readings include
     * the briefing tasks of the groups that hold its sections, so it publishes once those briefings
     * are in, without holding back a batch that is already published.
     */
    readonly batches?: (
      input: MapInput & {
        readonly frameKey: string;
        readonly readings: ReadonlyArray<Reading>;
        readonly finders?: ReadonlyArray<FinderResult> | undefined;
        /** The readings' plan task ended cut at its cut-off (`Publishing.planCut`). */
        readonly planCut?: boolean | undefined;
      },
      reader: DocumentReader,
      context: Context,
      signal: AbortSignal,
    ) => Promise<ReviewBatches>;
    /**
     * One batch, settled for `publishSettled`, or why not: code only, deterministic for its input,
     * never throwing for a failed or missing reading (a failed reading settles its sections as
     * human-required, cause `failed`). `last` is true only on the ending call of the last run the
     * review is allowed (the follow-on cap is reached, or a quota refusal asks for none): a section
     * no reading reached then settles as human-required, cause `not-reached`.
     */
    readonly settle?: (
      input: MapInput & {
        readonly frameKey: string;
        readonly batch: string;
        readonly readings: ReadonlyArray<{
          readonly name: string;
          readonly outcome: TaskOutcome<unknown> | undefined;
        }>;
        readonly finders: ReadonlyArray<FinderResult>;
        /**
         * How each of the review's finders ended (`finderEnds`), a lens the front task never started
         * `skipped`: unless `final`, a batch settles only when every one completed.
         */
        readonly findersEnded: ReadonlyArray<LensEnd>;
        /**
         * No later run of this run key can change the batch: the review decided at Link that no
         * follow-on is left under the cap, or the ending call met a quota refusal. Unfinished
         * finders then hold no batch, and the packet says they did not finish.
         */
        readonly final: boolean;
        readonly last: boolean;
        /** The readings' plan task ended cut at its cut-off (`Publishing.planCut`). */
        readonly planCut?: boolean | undefined;
      },
      reader: DocumentReader,
      context: Context,
      signal: AbortSignal,
    ) => Promise<Settled>;
  };
}
type Prepared = {
  readonly record: StageRecord;
  readonly facts?:
    { readonly key: string; readonly output: PrecomputeOutput } | undefined;
};
export type ReviewTaskInput = ReviewRunInput & { readonly cutoffAt: number };
export type ReviewOutcome = { readonly stages: ReadonlyArray<StageRecord> };
type Sources = Omit<PublishInput, "stages" | "candidates" | "reason">;
type Ready = {
  readonly stages: ReadonlyArray<StageRecord>;
  readonly sources: Sources;
  readonly frameKey: string;
  readonly mapKey: string;
  readonly manifestKey: string;
  readonly finders: ReadonlyArray<{
    readonly lens: FinderInput["lens"];
    readonly task: TaskId<FinderResult>;
  }>;
  /** The readings' plan task, created with the front task; absent when the review plans no readings. */
  readonly plan?: TaskId<ReadingsPlanResult>;
  /**
   * The readings the plan created, in creation order: named by the `link` phase's own commit that
   * waits on them, once the plan ended with a plan; absent before that and when it gave none.
   */
  readonly readings?: ReadonlyArray<Reading>;
  /**
   * Set by the `link` commit that waits on the readings when no batch could publish them (the
   * batches failed, or none holds a section): the old packet then says so.
   */
  readonly unbatched?: true;
  /**
   * The publish phase's batches and their waiters, in batch order: named by the same `link` commit
   * that names the readings, when the review publishes per batch; absent otherwise.
   */
  readonly publishing?: Publishing;
};
type Publishing = {
  readonly batches: ReviewBatches;
  /** Link's entry for a finder with no result, fixed when the batches were made: every call's. */
  readonly reason: "cutoff" | "stopped";
  /**
   * Whether this run can have no successor, decided once, read only, in the commit that made the
   * waiters, before any of them ran: no follow-on is left under the cap (`followOnLeft`). Absent in
   * a checkpoint of an earlier build: its waiters read it as false, and the ending call reads the cap.
   */
  readonly final?: boolean;
  /**
   * The readings' plan task ended cut at its cut-off, with no plan: the readers' stand-in plan's
   * sections are then not reached, never failed. Fixed when the batches were made: every call's.
   */
  readonly planCut?: true;
  readonly waiters: ReadonlyArray<{
    readonly batch: string;
    readonly task: TaskId<BatchWaiterResult>;
  }>;
};
type ReviewCheckpoint =
  | { readonly phase: "precompute"; readonly coverage?: Prepared }
  | {
      readonly phase: "front";
      readonly stages: ReadonlyArray<StageRecord>;
      readonly facts: NonNullable<Prepared["facts"]>;
      readonly front: TaskId<FrontResult>;
      readonly disclosures: Freshness["disclosures"];
      readonly plan?: TaskId<ReadingsPlanResult>;
    }
  | (Ready & { readonly phase: "find+fill" })
  | (Ready & { readonly phase: "link"; readonly fill: FillResult | null })
  | {
      readonly phase: "publish";
      readonly stages: ReadonlyArray<StageRecord>;
      readonly sources: Sources;
      readonly candidates: ReadonlyArray<PublishCandidate>;
      readonly reason?: string | undefined;
      /**
       * Present when the review publishes per batch: what its one `ending: true` call reads, once
       * every waiter ended. Absent, it publishes the old packet (`publish`).
       */
      readonly settled?: Publishing & {
        readonly frameKey: string;
        readonly mapKey: string;
        readonly manifestKey: string;
        readonly readings: ReadonlyArray<Reading>;
        readonly finders: Ready["finders"];
      };
      /**
       * Set by the commit after the ending call, before the follow-on ask: a retried phase does not
       * make the call again, so no ending call of this run can follow its follow-on run's packet.
       */
      readonly ended?: {
        readonly published: ReadonlyArray<StageRecord>;
        readonly ask: boolean;
      };
    };
type Runtime = TaskRuntime<
  ReviewTaskInput,
  ReviewCheckpoint,
  ReviewOutcome,
  object
>;
export const REVIEW_TASK = "neuve.review";
/**
 * 3: Precompute's checkpoint names stage keys of the NEU-148 shape (the manifest without leads),
 * and the leads task is the review's child. 4: the front task starts the finders when Frame lands
 * and returns them. 5: the readings' plan task is created with the front task, and the `front`,
 * `find+fill` and `link` checkpoints name it; `find+fill` no longer plans. 6: the publish phase
 * (NEU-148, WP8): the `link` checkpoint may name the batches and their waiters, and the `publish`
 * checkpoint what the ending call reads, waiting on the waiters. An older live review restarts from
 * Precompute (`migrate`): its checkpoints name stage keys and children of an earlier shape.
 */
export const REVIEW_TASK_VERSION = 6;
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const failure = (
  outcome: TaskOutcome<unknown>,
): TaskOutcome<never> | undefined =>
  outcome.status === "failed" || outcome.status === "faulted"
    ? { status: outcome.status, error: outcome.error }
    : outcome.status === "orphaned"
      ? {
          status: "failed",
          error: { message: `a stage task was orphaned: ${outcome.reason}` },
        }
      : undefined;
/**
 * What a batch waiter reads from its review: the `link` checkpoint that created it names the
 * batches, the readings and the finders. Undefined once the review is at Publish (or ended), when a
 * waiter publishes nothing.
 */
export const publishingOf = (checkpoint: unknown) => {
  const at = checkpoint as Partial<Ready> & { readonly phase?: unknown };
  return at?.phase === "link" && at.publishing !== undefined
    ? {
        frameKey: at.frameKey!,
        mapKey: at.mapKey!,
        manifestKey: at.manifestKey!,
        finders: at.finders ?? [],
        readings: at.readings ?? [],
        batches: at.publishing.batches,
        reason: at.publishing.reason,
        final: at.publishing.final ?? false,
        planCut: at.publishing.planCut === true,
        /** What the review disclosed by Link: Precompute's, the front's and the finders' start. */
        disclosures: at.sources?.disclosures ?? [],
      }
    : undefined;
};

/**
 * The review's disclosures as run gaps, keyed by their place as the old packet keys them
 * (`freshness:<index>`): the ones known when the waiters were made are a prefix of the ending
 * call's, so each keeps its key on every call.
 */
export const disclosureGaps = (
  disclosures: Freshness["disclosures"],
): Array<PublishGap> =>
  disclosures.map((disclosure, index) => ({
    key: `freshness:${index}`,
    kind: disclosure.kind,
    detail: disclosure.detail,
    ...(disclosure.cause === undefined ? {} : { cause: disclosure.cause }),
  }));

/** The publish phase's ports, when the review publishes per batch: all of them, or none. */
const publisher = (stages: ReviewStagesPort) => {
  const { batchWaiter, publishSettled } = stages;
  const batches = stages.readings?.batches;
  const settle = stages.readings?.settle;
  return batchWaiter === undefined ||
    publishSettled === undefined ||
    batches === undefined ||
    settle === undefined
    ? undefined
    : {
        batchWaiter,
        publishSettled,
        batches,
        settle,
        followOnLeft: stages.followOnLeft,
        followOn: stages.followOn,
        chainTotals: stages.chainTotals,
      };
};

/** The old packet's disclosure when the readings ran but no batch could publish them. */
const UNBATCHED = {
  kind: "section-readings",
  detail:
    "Section readings: the review's batches could not be made, so no section in this packet was decided by a reading.",
};

/** Whether a stage was cut short: what makes the run's receipt say `timed-out` (`receipt.ts`). */
const cutShort = (stage: StageRecord) =>
  stage.status === "interrupted" || stage.status === "skipped";
/** The run gap that says why batches are still pending at the end of a run, and where they go. */
const notReachedGap = (why: string, where: string): PublishGap => ({
  key: "run:batches-not-reached",
  kind: "batches-not-reached",
  detail: `${why}: ${where}.`,
});
const resultOf = <R>(outcome: TaskOutcome<R>): R | undefined =>
  outcome.status === "completed" || outcome.status === "aborted"
    ? outcome.result
    : undefined;

/**
 * How a finder that left no result ended, by its task's outcome: failed, or cut off or stopped as
 * the review's entry says (`reason`, fixed in its checkpoint, so every call reads the same).
 */
const missingEnd = (
  outcome: TaskOutcome<FinderResult> | undefined,
  reason: "cutoff" | "stopped",
): FinderEnd => {
  if (outcome === undefined) return { find: reason, verify: reason };
  switch (outcome.status) {
    case "completed":
    case "aborted":
      return { find: reason, verify: reason };
    case "failed":
    case "faulted":
    case "orphaned":
      return { find: "failed", verify: "failed" };
  }
};

/**
 * The finders' results as Link gets them, each with how it ended (`end`): each finder's own, or for
 * one that has none (cut short, stopped or failed) the review's own entry, an interrupted find with
 * no findings, whose `end` says how it ended, never `completed`. A result of an earlier build has no
 * `end`: it is read from its records, as the finder sets it. The batch waiters and the publish phase
 * read them the same way.
 */
export const finderResults = (
  finders: ReadonlyArray<{
    readonly lens: FinderInput["lens"];
    readonly task: TaskId<FinderResult>;
  }>,
  outcomes: ReadonlyArray<TaskOutcome<FinderResult> | undefined>,
  reason: "cutoff" | "stopped",
): Array<FinderResult> =>
  finders.map((child, index): FinderResult => {
    const outcome = outcomes[index];
    const result = outcome === undefined ? undefined : resultOf(outcome);
    if (result !== undefined)
      return (result as Partial<FinderResult>).end !== undefined
        ? result
        : {
            ...result,
            end: finderEndOf(
              result.stages.find((stage) => stage.stage === "find"),
              result.stages.filter(
                (stage) =>
                  stage.stage === "verify" &&
                  stage.agent?.startsWith("verify.") === true,
              ),
              reason,
            ),
          };
    return {
      lens: child.lens,
      findKey: null,
      findings: [],
      stages: [
        {
          stage: "find",
          agent: `find.${child.lens}`,
          status: "interrupted",
          wallMs: 0,
          disclosure: null,
        },
      ],
      reason,
      end: missingEnd(outcome, reason),
    };
  });

/** One lens's end, as the settle decision, the disclosure, the follow-on and the receipt read it. */
export type LensEnd = { readonly lens: FinderInput["lens"] } & FinderEnd;

/**
 * Every lens's end, in the finders' order: a started finder's `end`, and `skipped` for a lens the
 * front task never started (too little time remained when Frame landed).
 */
export const finderEnds = (
  results: ReadonlyArray<FinderResult>,
): Array<LensEnd> =>
  FINDERS.map((lens) => {
    const result = results.find((r) => r.lens === lens);
    return result === undefined
      ? { lens, find: "skipped", verify: "skipped" }
      : { lens, find: result.end.find, verify: result.end.verify };
  });

/** Whether a step's end leaves the finding search unfinished, as a person is told it. */
const unfinished = (status: FinderStatus): boolean => {
  switch (status) {
    case "completed":
      return false;
    case "cutoff":
    case "stopped":
    case "skipped":
    case "failed":
      return true;
  }
};

/**
 * The run gap a run with no successor publishes when it settles batches while finders had not
 * finished: in plain words, so a person knows the findings are incomplete. None when every finder
 * completed, or when the run can still have a successor (then no batch settled).
 */
export const findersUnfinishedGap = (
  ended: ReadonlyArray<LensEnd>,
  final: boolean,
): Array<PublishGap> =>
  final && ended.some((e) => unfinished(e.find) || unfinished(e.verify))
    ? [
        {
          key: "run:finders-unfinished",
          kind: "finders-unfinished",
          detail:
            "The finders did not finish before this review ended, so its findings are incomplete: a change shown with no finding may still have one.",
        },
      ]
    : [];

/**
 * Whether any finder answered at its own time limit: a Find or Verify step the finders' deadline
 * before the cut-off made give its final answer (`agent-step.ts`, `toFinal` with `timeout`), its
 * record computed or reused with `endedBy: "timeout"` and `finalGeneration: true`. Its status stays
 * `completed`; only the packet and the receipt say it, in one plain line each.
 */
export const findersAtLimit = (finders: ReadonlyArray<FinderResult>) =>
  finders.some((finder) =>
    finder.stages.some(
      (stage) =>
        (stage.stage === "find" || stage.stage === "verify") &&
        // A stored answer reused by a later run keeps how it ended: the same line.
        (stage.status === "computed" || stage.status === "reused") &&
        stage.agentResult?.endedBy === "timeout" &&
        stage.agentResult.finalGeneration === true,
    ),
  );
/** The packet's line when any finder answered at its time limit (`findersAtLimit`). */
export const FINDERS_AT_LIMIT = {
  kind: "finders-at-limit",
  detail:
    "The finders answered at their time limit, so their findings are what they had found by then.",
};
/** The run gap a per-batch call carries when any finder answered at its time limit. */
export const findersAtLimitGap = (
  finders: ReadonlyArray<FinderResult>,
): Array<PublishGap> =>
  findersAtLimit(finders)
    ? [{ key: "run:finders-at-limit", ...FINDERS_AT_LIMIT }]
    : [];

/**
 * Whether a follow-on run of this run key runs a step of this finder again: one that completed is
 * stored and reused (its Find and Verify keys hold no run), every other one runs again.
 */
const runsAgain = (status: FinderStatus): boolean => {
  switch (status) {
    case "completed":
      return false;
    case "cutoff":
    case "stopped":
    case "skipped":
    case "failed":
      return true;
  }
};

/** The finders' ends as the run log keeps them for the receipt (`receipt.ts`, `finders.ended`). */
export const findersEndedRow = (
  ended: ReadonlyArray<LensEnd>,
  atLimit = false,
) => ({
  type: "finders.ended",
  finders: ended.map((e) => ({
    lens: e.lens,
    find: e.find,
    verify: e.verify,
    again: runsAgain(e.find) || runsAgain(e.verify),
  })),
  // Only when a finder answered at its time limit (`findersAtLimit`), so the row is as before.
  ...(atLimit ? { atLimit: true } : {}),
});

/** Reads the actual output, including an interrupted step's partial envelope. */
export const outputOf = <O>(record: StageRecord, schema: z.ZodType<O>) =>
  Effect.gen(function* () {
    if (
      record.key === undefined ||
      !["computed", "reused", "interrupted"].includes(record.status)
    )
      return undefined;
    const store = yield* Computations.ComputationStore;
    const blobs = yield* Blobs.BlobStore;
    const computation = Option.getOrThrow(yield* store.lookup(record.key));
    const blob = yield* blobs.get(computation.outputHash);
    if (blob._tag === "Pruned")
      return yield* Effect.die(`stage output ${record.key} was pruned`);
    const value: unknown = JSON.parse(new TextDecoder().decode(blob.bytes));
    const envelope = z.object({ output: z.unknown() }).safeParse(value);
    return readData(schema, envelope.success ? envelope.data.output : value);
  });

/**
 * Reviews running in this process, across every review host it opened. A review counts once, from
 * the first phase or abort handler its task runs here until one of them ends with the task terminal
 * or `completing`, or ends by throwing (pi then faults the task, or the Harness is closing, so this
 * definition runs no more of it). A review waiting on its children (front, finders, readings,
 * waiters) stays counted. When the count falls to none, this process's tree indexes and decoded
 * relations indexes are released: the next review builds or decodes them again.
 */
let reviewsRunning = 0;

/**
 * The review task, counted in `reviewsRunning`. `reviewTask` is called once per review host, and a
 * host admits one review task, so one flag per definition is one review: a resumed review opens a
 * new host and counts again from its first phase.
 *
 * Where the count can stay up: a host that closes while its review waits (an interrupted or held
 * claim) runs no phase that could see it, and a phase that returns without progress is faulted by
 * pi after it returned. Then the caches stay held until the process exits, as before this count.
 * A read of the task that fails after a phase counts the review as ended; if it still runs, its
 * next phase counts it again, and the release in between only costs a rebuild.
 */
const countedReview = <I, S extends { phase: string }, R, H extends object>(
  task: Task<I, S, R, H>,
): Task<I, S, R, H> => {
  let running = false;
  const enter = () => {
    if (running) return;
    running = true;
    reviewsRunning += 1;
  };
  const leave = () => {
    if (!running) return;
    running = false;
    reviewsRunning -= 1;
    if (reviewsRunning > 0) return;
    releaseIndexCache();
    releaseRelationsCache();
  };
  const ended = async (
    runtime: TaskRuntime<I, S, R, H>,
    context: Context,
  ): Promise<boolean> => {
    try {
      const status = (await runtime.getTask(runtime.taskId, context))?.state
        .status;
      return (
        status === undefined || status === "terminal" || status === "completing"
      );
    } catch {
      return true;
    }
  };
  const { definition } = task;
  const phases: {
    -readonly [P in keyof TaskDefinition<I, S, R, H>["phases"]]: TaskDefinition<
      I,
      S,
      R,
      H
    >["phases"][P];
  } = { ...definition.phases };
  const wrap = <P extends S["phase"]>(phase: P) => {
    const run = definition.phases[phase];
    phases[phase] = async (current, runtime, context) => {
      enter();
      try {
        await run(current, runtime, context);
      } catch (error) {
        leave();
        throw error;
      }
      if (await ended(runtime, context)) leave();
    };
  };
  for (const phase in phases) wrap(phase);
  return {
    definition: {
      ...definition,
      phases,
      abort: async (current, runtime, context) => {
        enter();
        try {
          await definition.abort(current, runtime, context);
        } finally {
          leave();
        }
      },
    },
  };
};

export const reviewTask = (
  stages: ReviewStagesPort,
  log?: RunLog,
): Task<ReviewTaskInput, ReviewCheckpoint, ReviewOutcome, object> => {
  const waits = waitSpans(log);
  const span = (runtime: Runtime, phase: string) => {
    // The wait this phase resumes from ends where the phase starts (telemetry only).
    waits.resumed(runtime.taskId);
    return scopedLogSpan(log, "harness.pi.phase", {
      "harness.task_id": runtime.taskId,
      "harness.phase": phase,
      "harness.task_kind": "review",
    });
  };
  /** A phase-end commit, as its own span: creating children and the store write take time. */
  const commit = <T>(
    runtime: Runtime,
    phase: string,
    next: string,
    work: () => Promise<T>,
  ) =>
    logTimed(
      log,
      "harness.pi.commit",
      {
        "harness.task_id": runtime.taskId,
        "harness.task_kind": "review",
        "harness.phase": phase,
        "harness.next_phase": next,
      },
      work,
    );
  /** The wait a waiting commit starts, naming what it waits on. */
  const waiting = (
    runtime: Runtime,
    next: string,
    on: ReadonlyArray<{ readonly kind: string; readonly task: TaskId }>,
  ) =>
    waits.waiting(runtime.taskId, {
      "harness.task_id": runtime.taskId,
      "harness.task_kind": "review",
      "harness.next_phase": next,
      "harness.waiting_on": on.map((entry) => entry.kind).join(","),
      "harness.waiting_on_ids": on.map((entry) => entry.task).join(","),
    });
  /** Which computation each new child reads, so a collector joins it with its producer's end. */
  const inputs = (
    runtime: Runtime,
    task: TaskId,
    kind: string,
    read: Record<string, string>,
  ) =>
    log?.write({
      type: "task.inputs",
      taskId: task,
      owner: runtime.taskId,
      kind,
      inputs: read,
    });
  /**
   * To Publish, at once: it never waits for the leads task. The review's outcome, once Publish
   * commits it, holds as `completing` while that task, which the review owns, still runs, and the
   * review becomes terminal when it ends (pi-durable, "Finishing").
   */
  const toPublish = (
    runtime: Runtime,
    phase: string,
    next: Omit<Extract<ReviewCheckpoint, { phase: "publish" }>, "phase">,
    context: Context,
    /**
     * The batch waiters, when the review publishes per batch: it commits to Publish first and then
     * waits for every one of them, so a waiter that wakes now sees Publish and publishes nothing,
     * and the ending call comes after the last of them.
     */
    waiters: ReadonlyArray<TaskId> = [],
  ) =>
    commit(runtime, phase, "publish", () =>
      runtime.commit(
        () =>
          waiters.length === 0
            ? {
                status: "running",
                checkpoint: json({ phase: "publish", ...next }),
              }
            : {
                status: "waiting",
                on: [...waiters],
                policy: "allSettled",
                checkpoint: json({ phase: "publish", ...next }),
              },
        context,
      ),
    );
  const fail = (
    runtime: Runtime,
    outcome: TaskOutcome<never>,
    context: Context,
  ) => runtime.commit(() => ({ status: "terminal", outcome }), context);
  /**
   * Whether a follow-on run is left under the cap: read only, so it is decided before anything is
   * published. A read that fails counts as one left (a successor may exist, so nothing is taken for
   * final): a logged outcome, never a failed phase. The ask then decides, and an ask that fails
   * leaves the batches pending under the ending call's gap. A port with no read has no follow-on.
   */
  const followOnLeft = async (
    port: NonNullable<ReturnType<typeof publisher>>,
    runtime: Runtime,
  ) => {
    if (port.followOnLeft === undefined) return false;
    try {
      return await port.followOnLeft(runtime.signal);
    } catch (error) {
      if (runtime.signal.aborted) throw error;
      log?.write({ type: "publish.follow-on-left", failed: true });
      return true;
    }
  };
  /**
   * The review's one `ending: true` call, after every waiter ended (the review committed to Publish
   * waiting on all of them): every settled batch in batch order, the review's totals, and as gaps
   * what the review disclosed, the run's gaps and one for each batch still not settled. It returns
   * whether to ask for the follow-on run: when a batch was not reached, no reading met a quota
   * refusal and a follow-on is left under the cap. The ask comes after the call is stored, once per
   * run; records' own key (`review-follow-on:<request>`) makes a replayed ask the same ask.
   */
  const publishEnding = async (
    settled: NonNullable<
      Extract<ReviewCheckpoint, { phase: "publish" }>["settled"]
    >,
    records: ReadonlyArray<StageRecord>,
    disclosures: Freshness["disclosures"],
    runtime: Runtime,
    context: Context,
  ) => {
    const port = publisher(stages);
    if (port === undefined)
      throw new Error("a review that publishes per batch has no publisher");
    const finders = finderResults(
      settled.finders,
      await runtime.outcomes(
        settled.finders.map((f) => f.task),
        context,
      ),
      settled.reason,
    );
    const ended = finderEnds(finders);
    // No successor, as the commit that made the waiters decided it (an earlier build's checkpoint
    // has none: the cap is read now). Unfinished finders then hold no batch.
    const noSuccessor = settled.final ?? !(await followOnLeft(port, runtime));
    const settleAll = (last: (batch: string) => boolean, final: boolean) =>
      settleUpTo(
        runtime,
        port.settle,
        {
          ...settled,
          finders,
          through: settled.batches.batches.length - 1,
          last,
          final,
        },
        runtime,
        context,
        runtime.signal,
      );
    let built = await settleAll(() => false, noSuccessor);
    const notReached = new Set(
      built.flatMap(({ key, settled: s }) =>
        !s.settled && s.gap.kind === "not-reached" ? [key] : [],
      ),
    );
    const quota = built.some(
      ({ settled: s }) => !s.settled && s.gap.kind === "quota",
    );
    // The last run the review is allowed: a quota refusal asks for no follow-on run, and past the
    // cap none is left. Its batches not reached (a reading, or the finders, unfinished) then settle,
    // a section no reading reached as human-required, `not-reached`; otherwise they stay pending
    // and the follow-on is asked for after this call is stored.
    const last = notReached.size > 0 && (quota || noSuccessor);
    if (last) built = await settleAll((batch) => notReached.has(batch), true);
    // Batches the cut-off left pending: one run gap says where they go, true whether the follow-on
    // ask after this call succeeds or fails, and a cut-short stage keeps the run from being taken
    // for the range's complete review (its receipt says `timed-out`) when no stage already is.
    const pending = notReached.size > 0 && !last;
    const decided = built.some(({ settled: s }) => s.settled);
    // Why the finders hold the batches, if they do: only the cut-off is named as the cut-off.
    const heldBy = findersHeldBy(ended);
    const cut: ReadonlyArray<StageRecord> =
      pending && !records.some(cutShort)
        ? [
            {
              stage: "link",
              agent: "link.batches",
              status: "interrupted",
              wallMs: 0,
              note: `${notReached.size} batch(es) not reached ${heldBy === "other" ? "because the finders did not finish" : "by the cut-off"}`,
              disclosure: null,
            },
          ]
        : [];
    const published = await port.publishSettled(
      {
        batches: built.flatMap(({ settled: s }) =>
          s.settled ? [s.batch] : [],
        ),
        totals: settled.batches.totals,
        ending: true,
        // What the review disclosed (Precompute, the finders' start, Link, the readings), keyed as
        // the old packet keys them, then the run's gaps and each batch still not settled.
        gaps: [
          ...disclosureGaps(disclosures),
          // A plan cut off says its sections wait while they do; settled now, a person decides.
          ...settled.batches.gaps.map((gap) =>
            last && gap.detail === droppedPlanGap("not-reached", false).detail
              ? droppedPlanGap("not-reached")
              : gap,
          ),
          ...(pending
            ? [
                notReachedGap(
                  decided
                    ? `${notReached.size} of ${settled.batches.batches.length} batch(es) were not reached before the cut-off`
                    : heldBy === "cutoff"
                      ? "The finders did not finish before the cut-off, so no batch was decided"
                      : heldBy === "other"
                        ? "The finders did not finish, so no batch was decided yet"
                        : "The review ran out of time before any batch was decided",
                  "they wait for a follow-on run, or for the next request when none starts",
                ),
              ]
            : []),
          ...findersUnfinishedGap(ended, noSuccessor || last),
          ...findersAtLimitGap(finders),
          ...built.flatMap(({ settled: s }) => (s.settled ? [] : [s.gap])),
        ],
        stages: [...records, ...cut],
      },
      runtime.signal,
    );
    return { published: [...cut, ...published], ask: pending };
  };
  const review = defineTask<ReviewTaskInput, ReviewCheckpoint, ReviewOutcome>({
    name: REVIEW_TASK,
    version: REVIEW_TASK_VERSION,
    initial: () => ({ phase: "precompute" }),
    // An older live review starts again from Precompute; every stage it completed is keyed, so what
    // the new shape still reads is reused, and what moved is computed again once.
    migrate: (input) => ({
      input: input as unknown as ReviewTaskInput,
      checkpoint: { phase: "precompute" },
    }),
    phases: {
      precompute: async (task, runtime, context) => {
        using phaseSpan = span(runtime, "precompute");
        const at = task.state.checkpoint;
        if (at.coverage === undefined && stages.coverage !== undefined) {
          const coverage = await stages.coverage(runtime.signal);
          await commit(runtime, "precompute", "precompute", () =>
            runtime.commit(
              () => ({
                status: "running",
                checkpoint: json({ phase: "precompute", coverage }),
              }),
              context,
            ),
          );
          return;
        }
        const stop = new AbortController();
        const timer = setTimeout(
          () => stop.abort(),
          Math.max(0, task.input.cutoffAt - runtime.now()),
        );
        let prepared: Prepared;
        try {
          prepared = await stages.precompute(
            AbortSignal.any([runtime.signal, stop.signal]),
            task.input.cutoffAt,
          );
        } catch (error) {
          if (!stop.signal.aborted || runtime.signal.aborted) throw error;
          prepared = {
            record: {
              stage: "precompute",
              status: "skipped",
              wallMs: 0,
              note: "Precompute reached the cut-off.",
            },
          };
        } finally {
          clearTimeout(timer);
        }
        const facts = prepared.facts ?? at.coverage?.facts;
        const initial = [
          ...(at.coverage === undefined ? [] : [at.coverage.record]),
          prepared.record,
        ];
        const disclosures =
          prepared.facts === undefined
            ? [
                {
                  kind: "precompute",
                  detail:
                    "Precompute did not finish; available committed-range coverage is published without its enrichment or scope.",
                },
              ]
            : [];
        if (facts === undefined)
          return toPublish(
            runtime,
            "precompute",
            {
              stages: initial,
              sources: {
                sources: { manifest: null, changeMap: null, scope: null },
                strongestStratum: "nothing",
                disclosures,
              },
              candidates: [],
              reason:
                "the range manifest was unavailable when Precompute stopped",
            },
            context,
          );
        const created: {
          front?: TaskId<FrontResult>;
          leads?: TaskId<LeadsResult>;
          relations?: TaskId<RelationsResult>;
          headGate?: TaskId<RelationsResult>;
          plan?: TaskId<ReadingsPlanResult>;
        } = {};
        await commit(runtime, "precompute", "front", () =>
          runtime.commit(async (tx) => {
            const front = await stages.front(
              tx,
              { cutoffAt: task.input.cutoffAt, precompute: facts.key },
              runtime.taskId,
            );
            // The leads only of a manifest Precompute enriched: a coverage-only one has no queries.
            // Nothing in the review waits for this child or reads its outcome; the review owns it,
            // so its own outcome holds as `completing` until the child ends.
            const leads =
              prepared.facts === undefined || stages.leads === undefined
                ? undefined
                : await stages.leads(
                    tx,
                    {
                      manifest: prepared.facts.output.manifest,
                      cutoffAt: task.input.cutoffAt,
                    },
                    runtime.taskId,
                  );
            // Like the leads: never waited for or read, held by the review's `completing`.
            const relations =
              stages.relations === undefined
                ? undefined
                : await stages.relations(
                    tx,
                    {
                      manifest: facts.output.manifest,
                      cutoffAt: task.input.cutoffAt,
                    },
                    runtime.taskId,
                  );
            // The head gate the readings wait on, beside the reads; the review never waits for it.
            const headGate =
              stages.headGate === undefined
                ? undefined
                : await stages.headGate(
                    tx,
                    {
                      manifest: facts.output.manifest,
                      cutoffAt: task.input.cutoffAt,
                    },
                    runtime.taskId,
                  );
            // The readings' plan, in this same commit: the manifest key and the front task's ID, all
            // it reads, exist now. The review never waits for it here; only Link does, beside the
            // finders, so however slow its `prepare` is, Frame, the finders, Map and Fill never wait.
            const plan =
              stages.readings === undefined || stages.readingsPlan === undefined
                ? undefined
                : await stages.readingsPlan(
                    tx,
                    {
                      manifestKey: facts.output.manifest,
                      cutoffAt: task.input.cutoffAt,
                      front,
                      ...(headGate === undefined
                        ? {}
                        : { relations: headGate }),
                    },
                    runtime.taskId,
                  );
            created.front = front;
            if (leads !== undefined) created.leads = leads;
            if (relations !== undefined) created.relations = relations;
            if (headGate !== undefined) created.headGate = headGate;
            if (plan !== undefined) created.plan = plan;
            return {
              status: "waiting",
              on: [front],
              policy: "allSettled",
              checkpoint: json({
                phase: "front",
                stages: initial,
                facts,
                front,
                disclosures,
                ...(plan === undefined ? {} : { plan }),
              }),
            };
          }, context),
        );
        if (created.front === undefined) return;
        inputs(runtime, created.front, "front", {
          precompute: `computation:${facts.key}`,
        });
        if (created.leads !== undefined)
          inputs(runtime, created.leads, "leads", {
            manifest: `computation:${facts.output.manifest}`,
          });
        if (created.relations !== undefined)
          inputs(runtime, created.relations, "relations", {
            manifest: `computation:${facts.output.manifest}`,
          });
        if (created.headGate !== undefined)
          inputs(runtime, created.headGate, "relations-head-gate", {
            manifest: `computation:${facts.output.manifest}`,
          });
        if (created.plan !== undefined)
          inputs(runtime, created.plan, "readings-plan", {
            manifest: `computation:${facts.output.manifest}`,
          });
        waiting(runtime, "front", [{ kind: "front", task: created.front }]);
      },
      front: async (task, runtime, context) => {
        using phaseSpan = span(runtime, "front");
        const at = task.state.checkpoint;
        const [outcome] = await runtime.outcomes([at.front], context);
        if (outcome === undefined) throw new Error("front outcome is missing");
        const failed = failure(outcome);
        if (failed !== undefined) return fail(runtime, failed, context);
        const front = resultOf(outcome);
        const sources: Sources = {
          sources: {
            manifest: front?.manifestKey ?? at.facts.output.manifest,
            changeMap: null,
            scope: front?.scopeKey ?? at.facts.output.scope,
          },
          strongestStratum:
            front?.strongestStratum ?? at.facts.output.strongestStratum,
          disclosures: [...at.disclosures, ...(front?.disclosures ?? [])],
        };
        const records = [...at.stages, ...(front?.stages ?? [])];
        if (front?.frameKey == null || front.mapKey == null)
          return toPublish(
            runtime,
            "front",
            {
              stages: records,
              sources,
              candidates: [],
              reason: front?.reason ?? "the frame or map is unavailable",
            },
            context,
          );
        // The finders started when Frame landed, in the front task's commit that started Map, and
        // that commit decided the start rule. A front task that never got there started none: the
        // review records the schedule then, skipped, as it did when it started them itself.
        const started = front.finders;
        const start = started?.started === true;
        if (
          started === undefined &&
          !log
            ?.read()
            .some(
              (entry) =>
                entry.type === "review.schedule" &&
                entry["taskId"] === runtime.taskId,
            )
        ) {
          const now = runtime.now();
          log?.write({
            type: "review.schedule",
            taskId: runtime.taskId,
            start: now,
            deadline: findDeadline(now, task.input.cutoffAt),
            cutoffAt: task.input.cutoffAt,
            finders: 0,
            skipped: true,
          });
        }

        const frameKey = front.frameKey,
          mapKey = front.mapKey;
        const finders = started?.finders ?? [];
        // No readings here: their plan task, created with the front task, creates them, and Link
        // waits for it beside the finders.
        await commit(runtime, "front", "find+fill", () =>
          runtime.commit(() => {
            return {
              status: "running",
              checkpoint: json({
                phase: "find+fill",
                stages: [
                  ...records,
                  ...(start
                    ? []
                    : FINDERS.map((lens): StageRecord => ({
                        stage: "find",
                        agent: `find.${lens}`,
                        status: "skipped",
                        wallMs: 0,
                        disclosure: null,
                      }))),
                ],
                sources: {
                  ...sources,
                  disclosures: [
                    ...sources.disclosures,
                    ...(start
                      ? []
                      : [
                          {
                            kind: "finders-skipped",
                            detail:
                              "The finding searches did not start because too little review time remained. The published units have code coverage without a finding search.",
                          },
                        ]),
                  ],
                },
                frameKey,
                mapKey,
                manifestKey: front.manifestKey,
                finders,
                ...(at.plan === undefined ? {} : { plan: at.plan }),
              }),
            };
          }, context),
        );
        // The finders' inputs are logged by the front task, which created them.
      },
      "find+fill": async (task, runtime, context) => {
        using phaseSpan = span(runtime, "find+fill");
        const at = task.state.checkpoint;
        const stop = new AbortController();
        const timer = setTimeout(
          () => stop.abort(),
          Math.max(0, task.input.cutoffAt - runtime.now()),
        );
        let fill: FillResult | null;
        try {
          fill = await stages.fill(
            { mapKey: at.mapKey, manifestKey: at.manifestKey },
            runtime,
            context,
            AbortSignal.any([runtime.signal, stop.signal]),
          );
        } catch (error) {
          if (!stop.signal.aborted || runtime.signal.aborted) throw error;
          fill = null;
        } finally {
          clearTimeout(timer);
        }
        // Link waits for the finders and the readings' plan alike; the plan's readings are waited
        // on in the `link` phase, once the plan has named them.
        const on = [
          ...at.finders.map((f) => ({
            kind: `finder.${f.lens}`,
            task: f.task as TaskId,
          })),
          ...(at.plan === undefined
            ? []
            : [{ kind: "readings-plan", task: at.plan as TaskId }]),
        ];
        await commit(runtime, "find+fill", "link", () =>
          runtime.commit(() => {
            const checkpoint = json({ ...at, phase: "link" as const, fill });
            return on.length === 0
              ? { status: "running", checkpoint }
              : {
                  status: "waiting",
                  on: on.map((entry) => entry.task),
                  policy: "allSettled",
                  checkpoint,
                };
          }, context),
        );
        if (on.length > 0) waiting(runtime, "link", on);
      },
      link: async (task, runtime, context) => {
        using phaseSpan = span(runtime, "link");
        const at = task.state.checkpoint;
        const outcomes = await runtime.outcomes(
          at.finders.map((f) => f.task),
          context,
        );
        for (const outcome of outcomes) {
          const failed = failure(outcome);
          if (failed !== undefined) return fail(runtime, failed, context);
        }
        // The plan's readings: once it ended with a plan, the review waits on them itself, as their
        // owner, in a commit of this phase that names them. A plan that failed, was cut off or
        // faulted leaves none, never the review's failure. One that failed (admission refused
        // included) still publishes per batch, from the plan that stands in for it, every section
        // the person's, and the run's gap says the plan failed (`readings/collect.ts`,
        // `DROPPED_PLAN_GAP`).
        let readings = at.readings;
        // The review could not publish its readings per batch: the old packet says so.
        let unbatched = at.unbatched === true;
        if (readings === undefined && at.plan !== undefined) {
          const [planned] = await runtime.outcomes([at.plan], context);
          const plan =
            planned?.status === "completed" ? planned.result : undefined;
          const planEnd: ReadingsPlanResult["status"] =
            plan?.status ??
            (planned?.status === "aborted" ? "stopped" : "failed");
          // A plan that failed, or was cut at its cut-off, goes on from the plan that stands in for
          // it, where the readers can make its batches. Failed, its sections settle as the
          // person's. Cut off, they are not reached, as a reading cut off is: every batch waits, the
          // ending call asks for the follow-on, which plans again, and a run with no successor
          // settles them as human-required, cause `not-reached`. A stopped plan stops no run on its
          // own: its review is stopping too, and publishes nothing.
          if (
            plan?.status === "ok" ||
            ((planEnd === "failed" || planEnd === "cutoff") &&
              publisher(stages) !== undefined)
          ) {
            const named =
              plan?.status === "ok"
                ? plan.readings.map(({ name, task }) => ({ name, task }))
                : [];
            // Publishing per batch: the batches, and one waiter for each in this commit, chained in
            // batch order (`pi/stages/batch-waiter-task.ts`). The review waits for the readings
            // here, as without them; it waits for the waiters only once it is at Publish.
            const port = publisher(stages);
            let batches: ReviewBatches | undefined;
            // The finders have ended: their run gaps are in every call's, all equal.
            const early: Publishing["reason"] =
              runtime.now() >= task.input.cutoffAt ? "cutoff" : "stopped";
            if (port !== undefined)
              try {
                batches = await port.batches(
                  {
                    frameKey: at.frameKey,
                    mapKey: at.mapKey,
                    manifestKey: at.manifestKey,
                    readings: named,
                    finders: finderResults(at.finders, outcomes, early),
                    ...(planEnd === "cutoff" ? { planCut: true } : {}),
                  },
                  runtime,
                  context,
                  runtime.signal,
                );
              } catch (error) {
                if (runtime.signal.aborted) throw error;
                // No batches: the review publishes the old packet, as with no plan.
                log?.write({ type: "publish.batches", failed: true });
              }
            // Only a review with a batch to publish publishes per batch: with none, it publishes the
            // old packet, as with no plan, so it never publishes an empty or complete packet.
            if (
              port !== undefined &&
              batches !== undefined &&
              batches.batches.length > 0
            ) {
              const known = batches;
              // No successor, decided once, read only, before any waiter runs.
              const final = !(await followOnLeft(port, runtime));
              const on: Array<{ kind: string; task: TaskId }> = [];
              await commit(runtime, "link", "link", () =>
                runtime.commit(async (tx) => {
                  on.length = 0;
                  const waiters: Array<Publishing["waiters"][number]> = [];
                  // Each waiter reads the batches, readings and finders from this checkpoint.
                  for (const [index, batch] of known.batches.entries()) {
                    const id = await port.batchWaiter(
                      tx,
                      { index, previous: waiters.at(-1)?.task ?? null },
                      runtime.taskId,
                    );
                    waiters.push({ batch: batch.key, task: id });
                  }
                  on.push(
                    ...named.map((r) => ({ kind: "reading", task: r.task })),
                  );
                  const checkpoint = json({
                    ...at,
                    readings: named,
                    publishing: {
                      batches: known,
                      reason: early,
                      final,
                      ...(planEnd === "cutoff"
                        ? { planCut: true as const }
                        : {}),
                      waiters,
                    },
                  });
                  return on.length === 0
                    ? { status: "running", checkpoint }
                    : {
                        status: "waiting",
                        on: on.map((entry) => entry.task),
                        policy: "allSettled",
                        checkpoint,
                      };
                }, context),
              );
              if (on.length > 0) waiting(runtime, "link", on);
              return;
            }
            // Readings with no batch to publish them in (the batches failed, or none holds them):
            // the old packet, which says no section in it was decided by a reading. A review with
            // nothing to read has no reading and no batch, and says nothing.
            unbatched =
              port !== undefined && (batches === undefined || named.length > 0);
            if (named.length > 0) {
              const on = named.map((r) => ({ kind: "reading", task: r.task }));
              await commit(runtime, "link", "link", () =>
                runtime.commit(
                  () => ({
                    status: "waiting",
                    on: on.map((entry) => entry.task),
                    policy: "allSettled",
                    checkpoint: json({
                      ...at,
                      readings: named,
                      ...(unbatched ? { unbatched: true as const } : {}),
                    }),
                  }),
                  context,
                ),
              );
              waiting(runtime, "link", on);
              return;
            }
            readings = named;
          }
        }
        const reason =
          at.publishing?.reason ??
          (runtime.now() >= task.input.cutoffAt ? "cutoff" : "stopped");
        const finders = finderResults(at.finders, outcomes, reason);
        log?.write(
          findersEndedRow(finderEnds(finders), findersAtLimit(finders)),
        );
        // A reading's failure is the collector's "not judged", never the review's: no `failure()`.
        let read: Read | undefined;
        if (readings !== undefined && stages.readings !== undefined) {
          const ended = await runtime.outcomes(
            readings.map((r) => r.task),
            context,
          );
          read = await stages.readings.collect(
            {
              frameKey: at.frameKey,
              mapKey: at.mapKey,
              manifestKey: at.manifestKey,
              readings: readings.map((r, index) => ({
                name: r.name,
                outcome: ended[index],
              })),
              finders,
              // Only a cut plan says so, so the input is as before otherwise.
              ...(at.publishing?.planCut === true ? { planCut: true } : {}),
            },
            runtime,
            context,
            runtime.signal,
          );
        }
        const linked = await stages.link(
          {
            frameKey: at.frameKey,
            mapKey: at.mapKey,
            manifestKey: at.manifestKey,
            fill: at.fill,
            finders,
          },
          runtime,
          context,
          runtime.signal,
        );
        const fillRecord = at.fill?.record ?? linked.fillRecord;
        // Readings on, but no batches to publish: the old packet is published, as with the readings
        // off. When no reading was collected (no plan task, or a review that planned readings its
        // run then has no port for: off by accident), or readings ran that no batch could publish,
        // it says so; nothing to read says nothing.
        const fellBack =
          at.publishing !== undefined
            ? []
            : read === undefined &&
                (publisher(stages) !== undefined || at.plan !== undefined)
              ? [NO_READINGS]
              : publisher(stages) !== undefined && unbatched
                ? [UNBATCHED]
                : [];
        await toPublish(
          runtime,
          "link",
          {
            stages: [
              ...at.stages,
              ...(fillRecord === undefined ? [] : [fillRecord]),
              ...finders.flatMap((f) => f.stages),
              ...(read?.stages ?? []),
              linked.record,
            ],
            sources: {
              ...at.sources,
              findings: finders.flatMap((finder) =>
                finder.findings
                  .filter((finding) => finding.status === "kept")
                  .map((finding) => finding.id),
              ),
              sources: {
                ...at.sources.sources,
                changeMap: linked.changeMapKey,
              },
              disclosures: [
                ...at.sources.disclosures,
                // Per batch, findings are placed on the new units by anchor (the readers'
                // `finding-unplaced` gaps say which were not); Link's placement on the old units
                // would say a finding the new units publish was not published.
                ...(at.publishing === undefined
                  ? linked.disclosures
                  : linked.disclosures.filter(
                      (d) => d.kind !== "finding-unanchored",
                    )),
                // A dropped plan published per batch: its run gap already says no reading ran.
                ...(read?.disclosures ?? []).filter(
                  (d) =>
                    at.publishing === undefined ||
                    d.detail !== NO_READINGS.detail,
                ),
                ...fellBack,
                // Per batch, every call carries it as a run gap (`findersAtLimitGap`).
                ...(at.publishing === undefined && findersAtLimit(finders)
                  ? [FINDERS_AT_LIMIT]
                  : []),
              ],
            },
            candidates: linked.candidates,
            ...(at.publishing === undefined
              ? {}
              : {
                  settled: {
                    ...at.publishing,
                    frameKey: at.frameKey,
                    mapKey: at.mapKey,
                    manifestKey: at.manifestKey,
                    readings: readings ?? [],
                    finders: at.finders,
                  },
                }),
          },
          context,
          at.publishing?.waiters.map((w) => w.task as TaskId) ?? [],
        );
      },
      publish: async (task, runtime, context) => {
        using phaseSpan = span(runtime, "publish");
        const at = task.state.checkpoint;
        // Per batch: the ending call, then a commit that holds it, and only then the follow-on ask,
        // so a retried attempt never makes this run's ending call after its follow-on published.
        if (at.settled !== undefined && at.ended === undefined) {
          const ended = await publishEnding(
            at.settled,
            at.stages,
            at.sources.disclosures,
            runtime,
            context,
          );
          await commit(runtime, "publish", "publish", () =>
            runtime.commit(
              () => ({
                status: "running",
                checkpoint: json({ ...at, ended }),
              }),
              context,
            ),
          );
          return;
        }
        // A follow-on run never publishes the old packet, by whichever path it reached Publish
        // without batches (Precompute or Front with no Frame or Map, or Link with no plan or no
        // batches): that packet would become the cycle's packet of record over the per-batch chain
        // an earlier run of the sequence published (only a per-batch ending call asks for a
        // follow-on). Nor does it fail for having no batches: a retry reads the same stored work and
        // ends here again, and
        // a run that fails every attempt leaves no receipt and no gap. It ends with a cut-short stage
        // (its receipt says `timed-out`, so the next request starts the next generation) and one
        // ending call that adds no batch, so the chain's newest packet says why and its pending
        // counts stay current. Cut off, it then asks for the next follow-on as the per-batch ending
        // does (a fresh run, with its own clock and the cap of 8), after a commit that holds the
        // call; otherwise the reason would repeat, and the next request reads the batches.
        const noBatches = publisher(stages);
        if (
          at.settled === undefined &&
          at.ended === undefined &&
          noBatches !== undefined &&
          task.input.generation > 0
        ) {
          const past = runtime.now() >= task.input.cutoffAt;
          const why = past
            ? "This follow-on review ran out of time before any batch was decided"
            : `This follow-on review made no batches to publish${at.reason === undefined ? "" : ` (${at.reason})`}`;
          const where = past
            ? "the batches not yet published wait for a follow-on run, or for the next request when none starts"
            : "the batches not yet published wait for the next request";
          const cut: StageRecord = {
            stage: "link",
            agent: "link.batches",
            status: past ? "interrupted" : "skipped",
            wallMs: 0,
            note: why,
            disclosure: null,
          };
          // A failed read of the totals or a failed ending call is a real error, not a lack of time:
          // it fails the run, to be retried, as on the per-batch ending call, before `ended` is
          // committed, so no follow-on is asked for until this run's ending call is stored.
          const totals = await noBatches.chainTotals?.(runtime.signal);
          const published: ReadonlyArray<StageRecord> =
            totals === undefined
              ? []
              : await noBatches.publishSettled(
                  {
                    batches: [],
                    totals,
                    ending: true,
                    gaps: [
                      ...disclosureGaps(at.sources.disclosures),
                      notReachedGap(why, where),
                    ],
                    stages: [...at.stages, cut],
                  },
                  runtime.signal,
                );
          log?.write({
            type: "publish.no-batches",
            generation: task.input.generation,
            cutoff: past,
            chain: totals !== undefined,
            published: published.length > 0,
          });
          const ended = { published: [cut, ...published], ask: past };
          await commit(runtime, "publish", "publish", () =>
            runtime.commit(
              () => ({
                status: "running",
                checkpoint: json({ ...at, ended }),
              }),
              context,
            ),
          );
          return;
        }
        if (at.ended?.ask === true) {
          // A follow-on that cannot be asked for is a recorded outcome, never the review's failure:
          // the batches not reached stay pending, and the stored packet's gap says they wait for
          // the next request when no follow-on run starts.
          let answer: FollowOnAnswer = "refused";
          try {
            if (stages.followOn !== undefined)
              answer = await stages.followOn(runtime.signal);
          } catch (error) {
            if (runtime.signal.aborted) throw error;
            log?.write({ type: "publish.follow-on", answer, failed: true });
          }
        }
        // A review with the readings on that reached Publish from Precompute or Front (it has a
        // reason, and no Map for any batch) ran none of them: its old packet says so, as Link's does.
        const unread =
          at.reason !== undefined &&
          stages.readings !== undefined &&
          !at.sources.disclosures.some((d) => d.kind === NO_READINGS.kind)
            ? [NO_READINGS]
            : [];
        const published =
          at.ended !== undefined
            ? at.ended.published
            : await stages.publish(
                {
                  stages: at.stages,
                  candidates: at.candidates,
                  ...at.sources,
                  disclosures: [...at.sources.disclosures, ...unread],
                  ...(at.reason === undefined ? {} : { reason: at.reason }),
                },
                runtime.signal,
              );
        // With the leads task still running this outcome holds as `completing` (see `toPublish`).
        await commit(runtime, "publish", "terminal", () =>
          runtime.commit(async (tx) => {
            // The packet is stored: the relations task stops reads nobody here needs any more.
            if (stages.relations !== undefined || stages.headGate !== undefined)
              await markReviewPublished(tx, runtime.taskId);
            return {
              status: "terminal",
              outcome: {
                status: "completed",
                result: json({ stages: [...at.stages, ...published] }),
              },
            };
          }, context),
        );
      },
    },
    // An attempt abort publishes nothing. Children retain their committed partial work.
    abort: async (task, runtime, context) => {
      waits.resumed(runtime.taskId);
      const at = task.state.checkpoint;
      await runtime.commit(
        () => ({
          status: "terminal",
          outcome: {
            status: "aborted",
            reason: "stopped",
            result: json({ stages: "stages" in at ? at.stages : [] }),
          },
        }),
        context,
      );
    },
  });
  return countedReview(review);
};
export const reviewExtension = (
  task: ReturnType<typeof reviewTask>,
): Extension => defineExtension({ name: REVIEW_TASK, tasks: [task] });
export type ReviewTask = ReturnType<typeof reviewTask>;
