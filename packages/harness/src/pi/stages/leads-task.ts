import type { Context } from "@earendil-works/chord";
import type { Task, TaskRuntime } from "@earendil-works/pi-durable";
import { Computations } from "@neuve/records-core";
import { Effect, Option } from "effect";
import { CpuWork } from "../../budget/cpu.ts";
import type { Priority } from "../../budget/scheduler.ts";
import { withCodeWork } from "../../code-work.ts";
import { precomputeSettings } from "../../config.ts";
import { captureOutlineSource } from "../../graph-outline.ts";
import { logTimed, scopedLogSpan } from "../../log-span.ts";
import {
  RangeManifest,
  leadSettings,
  rangeLeads,
  rangeLeadsSpec,
} from "../../manifest.ts";
import { cutoffAt, storedOutput, type RunContext } from "../../pipeline.ts";
import { indexOf } from "../../retrievers.ts";
import { definePolicyTask as defineTask } from "../failure-policy.ts";
import type { StageServices } from "./services.ts";

/**
 * The range's leads, and the head tree's index, as work the review starts and no review step waits
 * for (NEU-148). Its owner is the review task: it creates this task in the commit that creates the
 * front task, once Precompute stored the range manifest, and never waits for it or reads its outcome.
 *
 * - **Keys.** The leads are the `harness.range-leads` computation, keyed by the range manifest, the
 *   leads retriever and the index recipe (`rangeLeadsSpec`). The head index is `treeIndex`'s one run
 *   per tree and recipe (record 0016): this task is a subscriber like any other caller, so a
 *   finder's `uses` that comes first or later joins the same run, never a second one. The base index
 *   is built only when lead search needs it (a hunk whose leads are not stored), inside the leads.
 * - **The head index first, the leads after it.** Finders wait for the head index (their `uses` and
 *   `defs` join its build) and nothing waits for the leads, so the head index is built alone and the
 *   leads, with the base index they build, start only once it has ended, ready or failed. Two trees
 *   built at once share most blobs' chunks, and whichever build claims a blob first computes it at
 *   its own rank: built together, the head index waited on chunk work running behind the review.
 *   Built after it, the base index finds the blobs both trees hold already chunked.
 * - **The review publishes first.** Publish never waits for this task. The review's committed
 *   outcome holds as `completing` while this task runs, and the review becomes terminal when it ends
 *   (pi-durable, "Finishing"), so the leads are still stored for reuse.
 * - **The review is stopped.** pi aborts a task's owned work before the task itself (bottom-up),
 *   also while the review is `completing`, so this task's invocation is cancelled and its abort
 *   commits `stopped`. A computation it was the only subscriber of is withdrawn; a run another caller
 *   still wants keeps running for that caller.
 * - **The cut-off.** At the review's cut-off the task stops its own work and completes as `cutoff`;
 *   the host's backstop would abort it a grace later otherwise.
 * - **The worker process exits.** The task is durable: the next attempt of the review resumes it and
 *   finds what was stored. A claim held by the dead process ended with its connection (0016).
 * - **A failure** (the index, the retriever, the store) never fails or delays the review and is not
 *   on the reader's surface: the task completes with `failed`. Each end is written to the run log
 *   with its key (`range.leads`, `index.prefetch`), never with source text.
 */

export const LEADS_TASK = "neuve.leads";
export type LeadsInput = {
  /** The range manifest's computation key, from Precompute's output. */
  readonly manifest: string;
  readonly cutoffAt: number;
};
export type LeadsResult = {
  readonly status: "stored" | "failed" | "cutoff" | "stopped";
  /** The leads' computation key. */
  readonly key: string;
  readonly detail?: string;
};
type LeadsCheckpoint = { readonly phase: "run" };
type Runtime = TaskRuntime<LeadsInput, LeadsCheckpoint, LeadsResult, object>;

/** Behind the review's own steps in the same CPU budget: Precompute and the tools rank first. */
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

const describe = (failure: unknown) =>
  `${String((failure as { _tag?: unknown })._tag ?? "error")}: ${String((failure as { message?: unknown }).message ?? failure).slice(0, 300)}`;

/** The leads' computation key for a manifest, under the run's settings. */
export const leadsKey = (ctx: RunContext["Service"], manifest: string) =>
  Computations.computationKey(
    rangeLeadsSpec(
      manifest,
      leadSettings(precomputeSettings(ctx.config)),
      captureOutlineSource(),
    ),
  ).key;

/**
 * Prefetches the head tree's index, then computes the range's leads. The prefetch runs first and
 * alone, at the rank the review's own tools build at (the stage runner's), so a finder's `uses` or
 * `defs` that joins it waits at the rank it would have built at itself, and no other tree's build
 * started here competes with it or claims its blobs' chunks at a lower rank. The leads start only
 * when the prefetch has ended, ready or failed, and run behind the review; their base index then
 * reuses the chunks the head build stored. The order changes when work runs, never what it
 * computes, so the leads' key and stored output are the same. A failed prefetch is written and
 * dropped: `uses` then answers `index-unavailable` as before, from its own attempt, and the leads
 * still run. A stop or the cut-off during the prefetch ends this work there, before the leads.
 */
export const leadsWork = (ctx: RunContext["Service"], manifestKey: string) =>
  Effect.gen(function* () {
    const source = captureOutlineSource();
    const settings = leadSettings(precomputeSettings(ctx.config));
    const key = leadsKey(ctx, manifestKey);
    const manifest = yield* storedOutput(ctx, manifestKey, RangeManifest);
    const { headTree } = manifest.range;
    const prefetch = (revision: "head", tree: string) =>
      Effect.result(indexOf(ctx.repository, tree, source)).pipe(
        Effect.tap((result) =>
          Effect.annotateCurrentSpan(
            result._tag === "Success"
              ? {
                  "harness.outcome": "ready",
                  "harness.index.from_memory": result.success.cached,
                  "harness.index.chunks": result.success.index.chunks.length,
                }
              : { "harness.outcome": "failed" },
          ),
        ),
        Effect.withSpan("harness.index.prefetch", {
          attributes: { "harness.revision": revision, "harness.tree": tree },
        }),
        Effect.tap((result) =>
          Effect.sync(() => {
            if (result._tag === "Failure")
              ctx.log.write({
                type: "index.prefetch",
                revision,
                tree,
                ok: false,
                error: describe(result.failure),
              });
          }),
        ),
      );
    // The head index first and alone; the leads only once it has ended, ready or failed.
    yield* prefetch("head", headTree);
    const leads = yield* Effect.result(
      behindTheReview(
        rangeLeads(
          ctx.repository,
          { key: manifestKey, value: manifest },
          settings,
          source,
        ),
      ),
    );
    if (leads._tag === "Failure") {
      const detail = describe(leads.failure);
      ctx.log.write({
        type: "range.leads",
        key,
        manifest: manifestKey,
        retriever: settings.retriever.id,
        status: "failed",
        error: detail,
      });
      return { status: "failed", key, detail } satisfies LeadsResult;
    }
    const { value } = leads.success;
    ctx.log.write({
      type: "range.leads",
      key: leads.success.key,
      manifest: manifestKey,
      retriever: settings.retriever.id,
      status: leads.success.status,
      hunks: value.hunks.filter((entry) => entry.leads !== null).length,
      counts: value.counts,
      index: value.index,
    });
    return { status: "stored", key } satisfies LeadsResult;
  }).pipe((work) => withCodeWork(ctx.location, false, work, cutoffAt(ctx)));

export const leadsTask = (
  services: StageServices,
): Task<LeadsInput, LeadsCheckpoint, LeadsResult, object> => {
  const { ctx } = services;
  /** The terminal commit, as its own span like every other phase-end commit. */
  const commit = (runtime: Runtime, work: () => Promise<unknown>) =>
    logTimed(
      ctx.log,
      "harness.pi.commit",
      {
        "harness.task_id": runtime.taskId,
        "harness.task_kind": "leads",
        "harness.phase": "run",
        "harness.next_phase": "terminal",
      },
      work,
    );
  const end = (runtime: Runtime, result: LeadsResult, context: Context) =>
    commit(runtime, () =>
      runtime.commit(
        () => ({
          status: "terminal",
          outcome: { status: "completed", result },
        }),
        context,
      ),
    );
  return defineTask<LeadsInput, LeadsCheckpoint, LeadsResult>({
    name: LEADS_TASK,
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      run: async (task, runtime, context) => {
        using phaseSpan = scopedLogSpan(ctx.log, "harness.pi.phase", {
          "harness.task_id": runtime.taskId,
          "harness.phase": "run",
          "harness.task_kind": "leads",
        });
        const stop = new AbortController();
        const timer = setTimeout(
          () => stop.abort(),
          Math.max(0, task.input.cutoffAt - runtime.now()),
        );
        let result: LeadsResult;
        try {
          result = await services.run(
            leadsWork(ctx, task.input.manifest),
            AbortSignal.any([runtime.signal, stop.signal]),
          );
        } catch (error) {
          // pi's own cancellation goes to `abort`; anything else ends this task, never the review.
          if (runtime.signal.aborted) throw error;
          const key = leadsKey(ctx, task.input.manifest);
          const detail = stop.signal.aborted
            ? "the review's cut-off came first"
            : describe(error);
          ctx.log.write({
            type: "range.leads",
            key,
            manifest: task.input.manifest,
            status: stop.signal.aborted ? "cutoff" : "failed",
            error: detail,
          });
          result = {
            status: stop.signal.aborted ? "cutoff" : "failed",
            key,
            detail,
          };
        } finally {
          clearTimeout(timer);
        }
        await end(runtime, result, context);
      },
    },
    abort: async (task, runtime, context) => {
      const key = leadsKey(ctx, task.input.manifest);
      ctx.log.write({
        type: "range.leads",
        key,
        manifest: task.input.manifest,
        status: "stopped",
      });
      await commit(runtime, () =>
        runtime.commit(
          () => ({
            status: "terminal",
            outcome: {
              status: "aborted",
              reason: "stopped",
              result: { status: "stopped", key },
            },
          }),
          context,
        ),
      );
    },
  });
};
