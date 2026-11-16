import type { Context } from "@earendil-works/chord";
import {
  defineDoc,
  type DocumentWatch,
  type Task,
  type TaskId,
  type TaskRuntime,
  type Tx,
} from "@earendil-works/pi-durable";
import { Computations } from "@neuve/records-core";
import { Effect, Exit, Fiber, Option } from "effect";
import { CpuWork } from "../../budget/cpu.ts";
import type { Priority } from "../../budget/scheduler.ts";
import { withCodeWork } from "../../code-work.ts";
import { captureOutlineSource } from "../../graph-outline.ts";
import { logTimed, scopedLogSpan } from "../../log-span.ts";
import { RangeManifest } from "../../manifest.ts";
import { cutoffAt, storedOutput, type RunContext } from "../../pipeline.ts";
import {
  relationsComputation,
  relationsGapOf,
  relationsGraphDirectory,
  relationsRecords,
  holdWaitedOn,
  relationsSpec,
  holdReadInFlight,
} from "../../relations-index.ts";
import { indexOf } from "../../retrievers.ts";
import { definePolicyTask as defineTask } from "../failure-policy.ts";
import type { StageServices } from "./services.ts";

/**
 * The relations of the range's base and head commits (`relations-index.ts`), started as early as the
 * range is known, as work the review starts and no review step waits for (NEU-148 WP11). Its owner is
 * the review task: it creates this task in the commit that creates the front task, beside the leads,
 * and only when the run's frozen configuration has the readings setting (`pi/stages/index.ts`).
 *
 * - **Keys.** Each side is `relationsComputation`'s one stored index per commit, engine and recipe
 *   (`relationsSpec`). This task is a subscriber like any other caller (record 0016): a consumer's
 *   `relationsRound` for the same commit, before, during or after this task's read, joins the one run
 *   or reads it stored, never a second one.
 * - **The commits.** Head is the manifest's `headOid`. The base is its `mergeBase`: the range's diff is
 *   taken against it (`diffTrees(repository, merge, headOid)` in `manifest.ts`), so a section's `old`
 *   ranges are lines of the merge base, and the slices join them to the base index.
 * - **The head index first.** The finders' first `uses` and `defs` wait for the head tree's index,
 *   which the leads task builds first and alone. This task subscribes to that same shared build
 *   (`indexOf`, the call the leads task makes, without its prefetch span or row) and starts its reads
 *   only once it has ended, ready or failed, so a cold read's engine is not started while that build
 *   runs. Without the leads task (some tests) this call starts the build; that build is the one the
 *   finders need anyway.
 * - **Nobody waits on it.** The engine runs in Graph's slot (`withGraphSlot`) at the class of a read
 *   no round waits on: this task never counts as waiting. A consumer's `relationsRound` that joins
 *   the read makes it waited on for the length of its own bounded wait (`relationsRound`'s count).
 *   Head first, then the base, each to its end.
 * - **The review publishes first.** Publish never waits for this task. The review's committed outcome
 *   holds as `completing` while it runs, and the review becomes terminal when it ends.
 * - **The packet is published.** No consumer of this review reads either side after its packet is
 *   published: the readings look both sides up stored, before Link (`reading-task.ts`, head only
 *   used), and nothing after Publish reads them. So the review marks its published packet in the
 *   commit that holds its outcome (`markReviewPublished`), this task watches that mark the way it
 *   watches the cut-off, and at the mark it stops its own work and completes as `published`, each
 *   side not ended named with its wall time so far. A side already stored stays stored.
 * - **The cut-off.** At the review's cut-off the task stops its own work and completes as `cutoff`,
 *   whatever path the review took (a fallback Frame or Map included): its bound is its own input.
 *   The read in flight then, head or base, is not withdrawn (NEU-148 round 22): its subscription
 *   goes on detached, counted in flight so the worker stays up for it (`holdReadInFlight`), to its
 *   own bound (`CONTINUED_READ_BOUND_MS`), and stores its index for whoever asks next; the side is
 *   `continued`. No side not yet started is started. From the cut-off on the read is no review's:
 *   the review's packet and its stop no longer reach it, as they never reach a round's detached read.
 * - **The review is stopped.** pi aborts the review's owned work before the review itself, so this
 *   task's invocation is cancelled and its abort commits `stopped`. In this case and at the published
 *   packet, and for a read still running at a continuation's own bound, a read this task was the
 *   only subscriber of is withdrawn (its shared run has no subscriber left, so `SharedWork` stops
 *   it), and a read another caller subscribed to keeps running for that caller.
 * - **A failure** (no engine, an engine without the capability, a clone that cannot be made, a failed
 *   read, an unreadable manifest) never fails or delays the review: the task completes with `failed`,
 *   with what was stored for the side that worked. Each side's end is written to the run log
 *   (`range.relations`) with its commit, key, outcome, wall time and records, never source text.
 * - **No task.** A review that started before this task existed, one with readings off, and one whose
 *   Precompute gave no manifest have none, and the task stores nothing for a side that failed: a
 *   consumer treats "no task, no stored output" as the normal missing case and reads its own gap.
 *
 * **The head gate** (NEU-148 round 20) is a second task of this kind, created in the same commit
 * (`headGateOf`), that the readings wait on (`on: [gate]`, `allSettled`) so they decide with the head
 * relations when these come in time. It is the same work for the head side alone (`headGate` in its
 * input): it waits for the head tree's index as the reads do, then subscribes to the head's one run
 * (it joins the reads' run, or the reads join its own), and its cut-off is the readings' bound
 * (`HEAD_GATE_BOUND_MS`). At the bound only its own subscription goes: the readings wake and decide
 * with the head "still being computed", while the reads keep the run going to the review's cut-off.
 * The published packet and the review's stop end it as they end the reads. A side the gate had not
 * read when it ended carries the wall time its read had run, so `wallMs: 0` there says the read had
 * not started (the head tree's index was still being built). The gate never continues a read: at any
 * cut-off of its own only its subscription goes.
 */

export const RELATIONS_TASK = "neuve.relations";
export type RelationsInput = {
  /** The range manifest's computation key, from Precompute's output. */
  readonly manifest: string;
  readonly cutoffAt: number;
  /** The head gate: the head side alone, to the readings' bound (`headGateOf`). Absent: the reads. */
  readonly headGate?: true;
};

/**
 * The readings' bound: the head gate ends at most this long after the review started, so a reading
 * waiting on it never waits longer. Decided by the coordinator for NEU-148 round 20, following the
 * readers lane's design and sizing (`reports/readers-19-lift-fires.md`, "The shape").
 */
export const HEAD_GATE_BOUND_MS = 180_000;

/**
 * How long a read the review's cut-off left running may run in all, from its start, before its own
 * subscription is withdrawn (NEU-148 round 22). The longest head read measured is t3code's 468 s
 * (332 to 468 s, the gates lane); 600 s gives it about a quarter more. A read starts before the
 * cut-off (550 s into the default 10-minute run), so a continued read ends by about 1 150 s into
 * the run, well inside the 30-minute deadline of the review's job (`REVIEW_MARKER_MAX_MS`), the
 * longest a review's work may keep the worker. A read still running at this bound leaves nothing
 * stored when it was the run's last subscriber: the next review reads from zero. Its row says
 * `bound`.
 */
export const CONTINUED_READ_BOUND_MS = 600_000;

/**
 * The head gate's starter, for the review's port (`ReviewStagesPort.headGate`). Its cut-off is
 * absolute: the earlier of the review's cut-off and the review's start plus the bound. The start is
 * the run clock's (`RunContext.startedAt`, from the run's first attempt that started work, 10.26),
 * the one the review's own cut-off is measured from (`cutoffAt` in `pipeline.ts`), so a restart
 * never moves either; and it is fixed in the gate's input when the gate is created.
 */
export const headGateOf =
  <S extends { phase: string }, H extends object>(
    task: Task<RelationsInput, S, RelationsResult, H>,
    ctx: Pick<RunContext["Service"], "startedAt">,
  ) =>
  (tx: Tx, input: RelationsInput, owner: TaskId) =>
    tx.createTask(
      task,
      {
        manifest: input.manifest,
        cutoffAt: Math.min(input.cutoffAt, ctx.startedAt + HEAD_GATE_BOUND_MS),
        headGate: true,
      },
      { ownership: { kind: "task", taskId: owner } },
    );
export type RelationsSideName = "head" | "base";
/** How one side ended: its index had (`stored`, `computed`, `shared`), its gap, or the cut-off. */
export type RelationsSideEnd = {
  readonly commit: string;
  /** The side's computation key (`relationsSpec`). */
  readonly key: string;
  readonly outcome:
    | "stored"
    | "computed"
    | "shared"
    | "graph-unavailable"
    | "failed"
    | "cutoff"
    /** The review's cut-off came while this side's read ran: the read goes on past it. */
    | "continued"
    /** The review's packet was published while this side had not ended: its read was stopped. */
    | "published";
  readonly wallMs: number;
  /** Records the read covered, for an index had. */
  readonly records?: number;
  /** The failure's tag (`RelationsReadFailed`'s reason, or the error's tag), never its text. */
  readonly error?: string;
};
export type RelationsResult = {
  readonly status: "stored" | "failed" | "cutoff" | "published" | "stopped";
  readonly head?: RelationsSideEnd;
  readonly base?: RelationsSideEnd;
  readonly detail?: string;
};
type RelationsCheckpoint = { readonly phase: "run" };
type Runtime = TaskRuntime<
  RelationsInput,
  RelationsCheckpoint,
  RelationsResult,
  object
>;

/** The store's Graph folder, where every relations read finds its clone (`relations-index.ts`). */
export { relationsGraphDirectory };

/** What the work got to: the sides it planned and how each that ended ended. */
type Progress = {
  planned: ReadonlyArray<{
    readonly side: RelationsSideName;
    readonly commit: string;
    readonly key: string;
  }>;
  readonly ended: Partial<Record<RelationsSideName, RelationsSideEnd>>;
  /** The side whose read is running, and when it started (`performance.now()`). */
  reading?: { readonly side: RelationsSideName; readonly started: number };
  /** The side whose read went on past the cut-off (`continueAtCutoff`). */
  continued?: RelationsSideName;
};

/**
 * For the reads, never the gate: asked as the work is interrupted, true when the interruption is the
 * review's cut-off alone, so the read in flight goes on, to `boundMs` from its start.
 */
type ContinueAtCutoff = {
  readonly atCutoff: () => boolean;
  readonly boundMs: number;
};

/**
 * The review's published packet, as the review marks it on itself (scope `task`, the review's ID):
 * what this task, its child, watches. Created by the first of the two to write it; pi retires it
 * when the review becomes terminal.
 */
const ReviewPublishedDoc = defineDoc<{ published: boolean }>({
  kind: "neuve.review-published",
  version: 1,
  scope: "task",
  initial: () => ({ published: false }),
});

/**
 * Marks the review's packet published. The review calls it in the commit that holds its completed
 * outcome, after the packet is stored, so its relations task stops at once (`relationsTask`).
 */
export const markReviewPublished = async (tx: Tx, review: TaskId) => {
  (await tx.doc(ReviewPublishedDoc, review)).published = true;
};

const describe = (failure: unknown) =>
  `${String((failure as { _tag?: unknown })._tag ?? "error")}: ${String((failure as { message?: unknown }).message ?? failure).slice(0, 300)}`;

/**
 * Behind the review's own steps in the same CPU budget, as the leads task runs its leads
 * (`leads-task.ts`, `behindTheReview`): nobody waits for these reads. Only the reads: the head
 * index's wait keeps the rank the finders' lookups build it at. The rank is the request's, taken
 * when the engine asks for its grant, so a round that joins the read makes it waited on in Graph's
 * slot but leaves its CPU rank as it is.
 */
const BEHIND_THE_REVIEW: Priority = {
  class: "interactive",
  position: "new",
  stage: 0,
};
const behindTheReview = <A, E, R>(work: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const held = yield* Effect.serviceOption(CpuWork);
    // A child already inside a grant keeps it; without a budget service the job's own one applies.
    if (Option.isNone(held) || held.value.inherited) return yield* work;
    return yield* Effect.provideService(work, CpuWork, {
      ...held.value,
      priority: BEHIND_THE_REVIEW,
    });
  });

const had = (end: RelationsSideEnd | undefined) =>
  end?.outcome === "stored" ||
  end?.outcome === "computed" ||
  end?.outcome === "shared";

type Read = ReturnType<typeof relationsComputation>;
type ReadExit = Exit.Exit<Effect.Success<Read>, Effect.Error<Read>>;

/** How a side's read ended: its index had, or its gap, with the failure's tag. */
const endOf = (
  commit: string,
  key: string,
  exit: ReadExit,
  wallMs: number,
): RelationsSideEnd => {
  if (Exit.isSuccess(exit)) {
    const { status, index } = exit.value.read;
    return {
      commit,
      key,
      outcome: status === "reused" ? "stored" : status,
      wallMs,
      records: relationsRecords(index),
    };
  }
  const gap = relationsGapOf(exit.cause);
  return {
    commit,
    key,
    outcome: gap.gap === "graph-unavailable" ? gap.gap : "failed",
    wallMs,
    ...(gap.tag === null ? {} : { error: gap.tag }),
  };
};

/**
 * Runs `read` as a fiber of its own and waits for it. Interrupted, it interrupts the read, which
 * withdraws its subscription, unless `atCutoff()` says the interruption is the review's cut-off:
 * then the read is handed to `detach` and goes on. The fork and the watch are one step, so no
 * interruption falls between them.
 */
const continuable = <A, E, R>(
  read: Effect.Effect<A, E, R>,
  atCutoff: () => boolean,
  detach: (fiber: Fiber.Fiber<A, E>) => Effect.Effect<void>,
) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.flatMap(Effect.forkDetach(read), (fiber) =>
      restore(Fiber.join(fiber)).pipe(
        Effect.onInterrupt(() =>
          atCutoff() ? detach(fiber) : Fiber.interrupt(fiber),
        ),
      ),
    ),
  );

/**
 * Reads the manifest, waits for the head tree's index to end, then reads the head's relations and
 * then the base's, each to its end. Every side's end is written to `progress` and the run log as it
 * happens, so a cut-off or a stop keeps what ended before it. Fails only when the manifest cannot be
 * read; a side's failure is its outcome. With `continueAtCutoff`, the read in flight at the cut-off
 * goes on detached, counted in flight, to its bound; its end is a row of its own (`continued`).
 */
export const relationsWork = (
  ctx: RunContext["Service"],
  manifestKey: string,
  progress: Progress,
  headGate = false,
  continueAtCutoff?: ContinueAtCutoff,
) =>
  Effect.gen(function* () {
    const source = captureOutlineSource();
    const manifest = yield* storedOutput(ctx, manifestKey, RangeManifest);
    const { headOid, mergeBase, headTree } = manifest.range;
    progress.planned = (
      [
        ["head", headOid],
        ["base", mergeBase],
      ] as const
    )
      .filter(([side]) => !headGate || side === "head")
      .map(([side, commit]) => ({
        side,
        commit,
        key: Computations.computationKey(relationsSpec(commit, source)).key,
      }));
    const record = (side: RelationsSideName, end: RelationsSideEnd) => {
      progress.ended[side] = end;
      ctx.log.write({
        type: "range.relations",
        manifest: manifestKey,
        ...gateRow(headGate),
        side,
        ...end,
      });
    };
    if (!("sha256" in source.key)) {
      // No engine: nothing to wait for and nothing to start.
      for (const { side, commit, key } of progress.planned)
        record(side, { commit, key, outcome: "graph-unavailable", wallMs: 0 });
      return;
    }
    // The head index's shared build, ready or failed: its outcome is the leads' and the finders'.
    yield* Effect.exit(indexOf(ctx.repository, headTree, source));
    const graphDirectory = relationsGraphDirectory(ctx.location);
    for (const { side, commit, key } of progress.planned) {
      const started = performance.now();
      progress.reading = { side, started };
      const read = behindTheReview(
        relationsComputation(ctx.repository, commit, source, graphDirectory),
      );
      /**
       * The read past the cut-off: counted in flight from this moment, watched to its end or its
       * bound from its start, at which it is interrupted (its subscription withdrawn). Its end is
       * one row, with its whole wall time and the part after the cut-off.
       */
      const detach =
        (bound: number) =>
        (fiber: Fiber.Fiber<Effect.Success<Read>, Effect.Error<Read>>) =>
          Effect.suspend(() => {
            const release = holdReadInFlight();
            const cut = performance.now();
            progress.continued = side;
            return Effect.asVoid(
              Effect.forkDetach(
                Fiber.await(fiber).pipe(
                  Effect.timeoutOption(Math.max(0, started + bound - cut)),
                  Effect.flatMap((ended) =>
                    Option.isSome(ended)
                      ? Effect.succeed(ended.value)
                      : Effect.as(Fiber.interrupt(fiber), undefined),
                  ),
                  Effect.flatMap((exit) =>
                    Effect.sync(() => {
                      const now = performance.now();
                      const wallMs = Math.round(now - started);
                      try {
                        ctx.log.write({
                          type: "range.relations",
                          manifest: manifestKey,
                          side,
                          continued: true,
                          ...(exit === undefined
                            ? { commit, key, outcome: "bound", wallMs }
                            : endOf(commit, key, exit, wallMs)),
                          afterCutoffMs: Math.round(now - cut),
                        });
                      } catch {
                        // The run's log can no longer be written: only the row is lost.
                      }
                    }),
                  ),
                  Effect.ensuring(Effect.sync(release)),
                ),
              ),
            );
          });
      // The gate counts as always waited on, so its read takes the waited-on class in Graph's slot
      // while it subscribes. Wrong only for a review where no reading waits on the gate. The proper
      // version, a waiter document the readers set as they commit `waiting` (about 10 lines in
      // `relations-index.ts`, 25 here, 1 for the readers), is a Linear follow-up.
      const exit = yield* Effect.exit(
        headGate
          ? Effect.acquireUseRelease(
              Effect.sync(() => holdWaitedOn(key)),
              () => read,
              (release) => Effect.sync(release),
            )
          : continueAtCutoff === undefined
            ? read
            : continuable(
                read,
                continueAtCutoff.atCutoff,
                detach(continueAtCutoff.boundMs),
              ),
      );
      const wallMs = Math.round(performance.now() - started);
      delete progress.reading;
      record(side, endOf(commit, key, exit, wallMs));
    }
  }).pipe((work) => withCodeWork(ctx.location, false, work, cutoffAt(ctx)));

/** The head gate's run-log rows say so; the reads' rows are as before. */
const gateRow = (headGate: boolean | undefined) =>
  headGate === true ? { headGate: true } : {};

/** The reasons the task's own stop carries. */
const CUTOFF = "cutoff";
const PUBLISHED = "published";

/**
 * Watches the owning review's publish mark (`markReviewPublished`) and calls `published` once it is
 * set: at once when it already is (a task run again after a restart, its review already
 * `completing`), else when the review's commit sets it. The mark is created here when absent, in a
 * commit that leaves this task's state as it is, so it can be watched before the review writes it.
 * A task no review owns has no mark to watch.
 */
const watchPublished = async (
  runtime: Runtime,
  owner: TaskId | undefined,
  context: Context,
  published: () => void,
) => {
  if (owner === undefined) return undefined;
  await runtime.commit(async (tx) => {
    await tx.doc(ReviewPublishedDoc, owner);
    return undefined;
  }, context);
  const watch = await runtime.watchDoc(ReviewPublishedDoc, owner, context);
  if (watch === undefined) return undefined;
  if (watch.value?.published === true) published();
  else
    watch.start(async (value) => {
      if (value?.published === true) published();
    });
  return watch;
};

export const relationsTask = (
  services: StageServices,
  /** The continuation's bound (`CONTINUED_READ_BOUND_MS`); tests shorten it. */
  continuedReadBoundMs = CONTINUED_READ_BOUND_MS,
): Task<RelationsInput, RelationsCheckpoint, RelationsResult, object> => {
  const { ctx } = services;
  /** The terminal commit, as its own span like every other phase-end commit. */
  const commit = (runtime: Runtime, work: () => Promise<unknown>) =>
    logTimed(
      ctx.log,
      "harness.pi.commit",
      {
        "harness.task_id": runtime.taskId,
        "harness.task_kind": "relations",
        "harness.phase": "run",
        "harness.next_phase": "terminal",
      },
      work,
    );
  return defineTask<RelationsInput, RelationsCheckpoint, RelationsResult>({
    name: RELATIONS_TASK,
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      run: async (task, runtime, context: Context) => {
        using phaseSpan = scopedLogSpan(ctx.log, "harness.pi.phase", {
          "harness.task_id": runtime.taskId,
          "harness.phase": "run",
          "harness.task_kind": "relations",
        });
        // Its reason says which came first: the cut-off or the review's published packet.
        const stop = new AbortController();
        const timer = setTimeout(
          () => stop.abort(CUTOFF),
          Math.max(0, task.input.cutoffAt - runtime.now()),
        );
        let watch: DocumentWatch<{ published: boolean }> | undefined;
        const progress: Progress = { planned: [], ended: {} };
        let result: RelationsResult;
        try {
          try {
            watch = await watchPublished(runtime, task.owner, context, () =>
              stop.abort(PUBLISHED),
            );
          } catch (error) {
            if (runtime.signal.aborted) throw error;
            // Without the mark the task runs as it did before it: to its end or its cut-off.
          }
          const headGate = task.input.headGate === true;
          await services.run(
            relationsWork(
              ctx,
              task.input.manifest,
              progress,
              headGate,
              // The reads' read in flight goes on at the cut-off; never at a stop or the packet.
              headGate
                ? undefined
                : {
                    atCutoff: () =>
                      stop.signal.reason === CUTOFF && !runtime.signal.aborted,
                    boundMs: continuedReadBoundMs,
                  },
            ),
            AbortSignal.any([runtime.signal, stop.signal]),
          );
          // Stored when every side this task reads was had: both for the reads, the head for the gate.
          result = {
            status:
              progress.planned.length > 0 &&
              progress.planned.every(({ side }) => had(progress.ended[side]))
                ? "stored"
                : "failed",
            ...progress.ended,
          };
        } catch (error) {
          // pi's own cancellation goes to `abort`; anything else ends this task, never the review.
          if (runtime.signal.aborted) throw error;
          if (stop.signal.aborted) {
            const outcome =
              stop.signal.reason === PUBLISHED ? "published" : "cutoff";
            const now = performance.now();
            const reading = progress.reading;
            // Every side that had not ended is the cut-off's or the published packet's, with the
            // wall time its read had run: 0 for a side whose read had not started. The side whose
            // read went on is `continued`, its bound named; its end is its own row.
            for (const { side, commit, key } of progress.planned)
              if (progress.ended[side] === undefined) {
                const continued = progress.continued === side;
                const end: RelationsSideEnd = {
                  commit,
                  key,
                  outcome: continued ? "continued" : outcome,
                  wallMs:
                    reading?.side === side
                      ? Math.round(now - reading.started)
                      : 0,
                };
                progress.ended[side] = end;
                ctx.log.write({
                  type: "range.relations",
                  manifest: task.input.manifest,
                  ...gateRow(task.input.headGate),
                  side,
                  ...end,
                  ...(continued ? { boundMs: continuedReadBoundMs } : {}),
                });
              }
            if (progress.planned.length === 0)
              ctx.log.write({
                type: "range.relations",
                manifest: task.input.manifest,
                ...gateRow(task.input.headGate),
                outcome,
              });
            result = {
              status: outcome,
              ...progress.ended,
              detail:
                outcome === "published"
                  ? "the review's packet was published first"
                  : task.input.headGate === true
                    ? "the gate's cut-off (the readings' bound or the review's) came first"
                    : "the review's cut-off came first",
            };
          } else {
            const detail = describe(error);
            ctx.log.write({
              type: "range.relations",
              manifest: task.input.manifest,
              ...gateRow(task.input.headGate),
              outcome: "failed",
              error: String((error as { _tag?: unknown })._tag ?? "error"),
            });
            result = { status: "failed", ...progress.ended, detail };
          }
        } finally {
          clearTimeout(timer);
          await watch?.stop();
        }
        await commit(runtime, () =>
          runtime.commit(
            () => ({
              status: "terminal",
              outcome: { status: "completed", result },
            }),
            context,
          ),
        );
      },
    },
    abort: async (task, runtime, context) => {
      ctx.log.write({
        type: "range.relations",
        manifest: task.input.manifest,
        ...gateRow(task.input.headGate),
        outcome: "stopped",
      });
      await commit(runtime, () =>
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
      );
    },
  });
};
