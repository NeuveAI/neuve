import { readData } from "@neuve/records-core";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { Cause, Clock, Effect, Option } from "effect";
import {
  Blobs,
  Computations,
  JobQueue,
  Log,
  REVIEW_RUN_KINDS,
  isReviewRun,
  mintUlid,
  type StoreLocation,
} from "@neuve/records-core";
import { RecordEvent } from "@neuve/records-schema";
import { CompletedRun, currentPipelineProblem } from "./config.ts";
import { reviewRunHandler } from "./handler.ts";
import type { Receipt } from "./receipt.ts";

/**
 * Recompose (10.137, 10.139): a completed run's review run again, as a new run in the store it is
 * given, reusing every stored stage. Its use is scoring a candidate change to placement, titles or
 * the digest on the replay cases without a new review: the store is a scratch copy of a case's,
 * never the case's own, and the new run's records (its stages, gaps and published packet) go only to
 * that copy. Every agent step must find its stored output, except the steps `allowModel` names,
 * which may call the model; any other step that would need it stops the run, naming it. Code steps
 * compute as usual. With nothing allowed the run has no model, client or credential at all, and no
 * preflight.
 */

/** The agent steps a recompose may let call the model, by the name a caller gives them. */
export const RECOMPOSE_STEPS = {
  frame: "harness.frame",
  map: "harness.map",
  find: "harness.find",
  verify: "harness.verify",
} as const;
export type RecomposeStep = keyof typeof RECOMPOSE_STEPS;

/** How each step of the new run came to its output. */
export type StepOutcome =
  | "reused"
  | "code-filled"
  | "recomputed with the model"
  | "interrupted"
  | "skipped";

export class RecomposeRefused extends Error {}

/**
 * Whether a store sits in a git directory (`<git dir>/neuve`): a repository's own store, which
 * reviews of it write and a worker may run jobs in, whatever the checkout's layout (a work tree's
 * `.git`, a submodule's or `--separate-git-dir`'s git dir, a bare repository). Git decides, with
 * the folder named as the git directory, so no repository around it is discovered instead; when
 * git cannot run, a store counts as in one. A recompose runs only in a scratch store outside one.
 */
export const inGitDirectory = (directory: string) => {
  const parent = dirname(realpathSync(directory));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
  const result = spawnSync(
    "git",
    ["--git-dir", parent, "rev-parse", "--git-dir"],
    { encoding: "utf8", env },
  );
  // Git that could not run gives no answer, so the store counts as a repository's own.
  if (result.error !== undefined || result.status === null) return true;
  return result.status === 0;
};

export const recompose = (options: {
  readonly location: StoreLocation;
  readonly repository: string;
  /** The completed run to compose again: its review request's event ID. */
  readonly runId: string;
  readonly allowModel: ReadonlyArray<RecomposeStep>;
}) =>
  Effect.gen(function* () {
    // Never a repository's own store: a recompose appends a generation's own reviews, which only a
    // scratch copy may hold.
    if (inGitDirectory(options.location.directory))
      return yield* Effect.fail(
        new RecomposeRefused(
          `${options.location.directory} is in a git directory, so it is a repository's own store; a recompose runs only on a scratch copy outside one`,
        ),
      );
    const stored = Option.getOrUndefined(yield* Log.get(options.runId))?.event;
    if (stored === undefined || stored.kind !== "review.requested@1")
      return yield* Effect.fail(
        new RecomposeRefused("--run must name a review request in this store."),
      );
    const problem = currentPipelineProblem(
      stored.payload.pipeline.version,
      stored.payload.pipeline.config,
    );
    if (problem !== undefined)
      return yield* Effect.fail(new RecomposeRefused(problem));
    // Only a completed run's stages are all stored: anything less would call the model.
    const store = yield* Computations.ComputationStore;
    const completed = Option.getOrUndefined(
      yield* store.lookup(stored.payload.runKey),
    );
    const blobs = yield* Blobs.BlobStore;
    const completedBy =
      completed === undefined
        ? undefined
        : yield* Effect.map(blobs.get(completed.outputHash), (read) =>
            read._tag === "Present"
              ? readData(
                  CompletedRun,
                  JSON.parse(new TextDecoder().decode(read.bytes)),
                ).runId
              : undefined,
          );
    if (completedBy !== options.runId)
      return yield* Effect.fail(
        new RecomposeRefused(
          "The run selected by --run did not complete in this store. Use the ID of a completed run.",
        ),
      );
    const queue = yield* JobQueue.JobQueue;
    // The new run is the only review job: a waiting one would be taken in its place.
    const pending = (yield* queue.list({
      states: ["waiting", "delayed", "active"],
      limit: 10_000,
    })).filter((job) => isReviewRun(job.kind));
    if (pending.length > 0)
      return yield* Effect.fail(
        new RecomposeRefused(
          `this store has ${pending.length} review job(s) waiting or running; recompose runs only in a store with none`,
        ),
      );
    // A new generation of the same request, so the run joins no earlier job of its key.
    const requests = (yield* Log.history({
      kind: "review.requested@1",
      limit: 10_000,
    })).filter(
      (entry) =>
        entry.event.kind === "review.requested@1" &&
        entry.event.payload.runKey === stored.payload.runKey,
    );
    const generation =
      Math.max(
        ...requests.map((entry) =>
          entry.event.kind === "review.requested@1"
            ? entry.event.payload.generation
            : 0,
        ),
      ) + 1;
    const id = mintUlid();
    const event = RecordEvent.parse({
      id,
      kind: "review.requested@1",
      idempotencyKey: `review.requested:${id}`,
      actor: stored.actor,
      occurredAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
      attribution: stored.attribution,
      payload: {
        runKey: stored.payload.runKey,
        generation,
        pipeline: stored.payload.pipeline,
      },
    });
    yield* Log.append([event]);
    // The request also queues its stack fetch; a recompose reads stored stages only, so it is
    // dropped before any worker on this store could run it.
    const fetch = (yield* queue.list({
      states: ["waiting", "delayed"],
      limit: 10_000,
    })).find(
      (entry) =>
        entry.kind === "stack.fetch" &&
        entry.dedupeKey ===
          `stack.fetch:review:${stored.payload.runKey}:${generation}`,
    );
    if (fetch !== undefined) yield* queue.drop(fetch.seq);
    const job = Option.getOrUndefined(yield* queue.take([...REVIEW_RUN_KINDS]));
    if (
      job === undefined ||
      job.dedupeKey !== `review.run:${stored.payload.runKey}:${generation}`
    )
      return yield* Effect.fail(
        new RecomposeRefused(
          "the recompose's review job was not the one taken",
        ),
      );
    const allow = new Set(
      options.allowModel.map((step) => RECOMPOSE_STEPS[step]),
    );
    const outcome = yield* Effect.exit(
      reviewRunHandler({
        location: options.location,
        repository: options.repository,
        recompose: { allow },
      })(job).pipe(Effect.provide(JobQueue.layer)),
    );
    // The job ends either way, so no worker on this store ever runs it again.
    if (outcome._tag === "Success")
      yield* queue.complete(job.seq, job.attempts);
    else
      yield* queue.fail(job.seq, job.attempts, {
        tag: "Recompose",
        message: `the recompose stopped: ${Cause.pretty(outcome.cause).split("\n")[0]?.slice(0, 500) ?? ""}`,
        final: true,
      });
    if (outcome._tag === "Failure")
      return yield* Effect.failCause(outcome.cause);
    const receipt = outcome.value as Receipt;
    const steps = receipt.stages.map((stage) => ({
      stage: stage.stage,
      agent: stage.agent,
      outcome: (stage.status === "reused"
        ? "reused"
        : stage.status === "computed"
          ? stage.modelCalls > 0
            ? "recomputed with the model"
            : "code-filled"
          : stage.status === "interrupted"
            ? "interrupted"
            : "skipped") as StepOutcome,
      modelCalls: stage.modelCalls,
    }));
    return { runId: id, original: options.runId, generation, steps, receipt };
  });
