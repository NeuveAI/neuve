import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Option } from "effect";
import { SharedWork } from "@neuve/records-core/shared-work";
import { Worker } from "@neuve/records-core";
import { canonicalStoreIdentity } from "@neuve/records-core/shared-work-socket";
import {
  JobQueue,
  Registry,
  Starter,
  resolveStoreLocation,
} from "@neuve/records-core";
import { readAsItStands, readWithoutLog } from "@neuve/records-core/read-only";
import { execute, withStore } from "./records-cli";
import { within } from "./volume-within";
import { thisBuild } from "./cli-command.ts";

export { thisBuild };

/** Keep one repository/job through pushed settlement, reconnecting only on socket loss. */
const upkeep = new SharedWork<string | undefined>();

/** The previous public interval remains for existing consumers; upkeep has no re-check timer. */
export const WORKER_RECHECK_MS = 2_000;
export const WORKER_WATCH_MS = 30 * 60_000;

const ensure = (project: string, command: ReadonlyArray<string>) =>
  Effect.runPromise(
    Starter.ensureWorker({
      repository: project,
      command,
      waitForReady: true,
    }).pipe(
      Effect.catchTag("OlderWorkerHeld", (error) =>
        Effect.andThen(
          Effect.logWarning(error.message),
          Effect.succeed({ status: "older-worker" as const }),
        ),
      ),
    ),
  ).catch(() => undefined);

/** The job's state, or undefined when it cannot be read (then the watch stops). */
const jobState = (project: string, seq: number) =>
  execute(
    withStore(project, "read", () =>
      JobQueue.JobQueue.use((queue) => queue.inspect(seq)).pipe(
        Effect.provide(JobQueue.layer),
      ),
    ),
  ).then(
    (job) => (Option.isSome(job) ? job.value.state : undefined),
    () => undefined,
  );

export interface KeptWorker {
  /** Settles when the job left waiting (or the watch ended): the state it was last seen in. */
  readonly settled: Promise<string | undefined>;
}

/** Start this build's worker and subscribe through terminal settlement, a hold, or the deadline. */
export const keepWorkerFor = async (
  input: Readonly<{
    project: string;
    job: number;
    command?: ReadonlyArray<string>;
    recheckMs?: number;
    watchMs?: number;
  }>,
): Promise<KeptWorker> => {
  const command = input.command ?? thisBuild();
  const store = await canonicalStoreIdentity(input.project);
  const location = await Effect.runPromise(resolveStoreLocation(input.project));
  const settled = upkeep
    .run({
      scope: store,
      key: `keep-worker@1:${input.job}`,
      keepRunning: true,
      run: async () => {
        const deadline = AbortSignal.timeout(input.watchMs ?? WORKER_WATCH_MS);
        const start = () => ensure(input.project, command);
        const initial = await jobState(input.project, input.job);
        if (
          initial === undefined ||
          initial === "completed" ||
          initial === "failed"
        ) {
          if (initial === undefined) await ensure(input.project, command);
          return { kind: "succeeded", value: initial };
        }
        if ((await start())?.status === "older-worker")
          return { kind: "succeeded", value: "held" };
        // Reconnection is driven by socket loss. A pending subscription never runs a job.
        while (!deadline.aborted) {
          const prior = await jobState(input.project, input.job);
          if (
            prior === undefined ||
            prior === "completed" ||
            prior === "failed"
          )
            return { kind: "succeeded", value: prior };
          let subscription:
            Awaited<ReturnType<typeof Worker.subscribeJob>> | undefined;
          try {
            subscription = await Worker.subscribeJob(
              location,
              input.job,
              deadline,
            );
            const state = await jobState(input.project, input.job);
            if (
              state === undefined ||
              state === "completed" ||
              state === "failed"
            )
              return { kind: "succeeded", value: state };
            for (;;) {
              if ((await subscription.next()) === "held")
                return { kind: "succeeded", value: "held" };
              const next = await jobState(input.project, input.job);
              if (
                next === undefined ||
                next === "completed" ||
                next === "failed"
              )
                return { kind: "succeeded", value: next };
            }
          } catch (error) {
            if (deadline.aborted) break;
            if (!(error instanceof Worker.WorkerSubscriptionLost)) throw error;
            // Read the committed state before ensuring the replacement worker.
            const state = await jobState(input.project, input.job);
            if (
              state === undefined ||
              state === "completed" ||
              state === "failed"
            )
              return { kind: "succeeded", value: state };
            if ((await start())?.status === "older-worker")
              return { kind: "succeeded", value: "held" };
          } finally {
            subscription?.close();
          }
        }
        return {
          kind: "succeeded",
          value: await jobState(input.project, input.job),
        };
      },
    })
    .then((result) =>
      result.outcome.kind === "succeeded" ? result.outcome.value : undefined,
    );
  return { settled };
};

/** How many registered repositories, and waiting reviews in each, one host start looks at. */
export const REARM_REPOSITORIES = 64;
export const REARM_JOBS = 16;

/**
 * Re-arms the watch when the workspace host starts: a review this build queued before the host last
 * stopped may still wait for a worker of this build. The repositories are the user's registry of
 * stores (workers register theirs), kept to those under `within`, the workspace's volume. Each
 * store is read without writing to it, so looking migrates nothing, and only its waiting or delayed
 * `review.run@2` jobs get a keeper. Bounded, and never throws: a store it can't read, or one with no
 * WAL to show it's whole, is said on `say`.
 */
export const rearmWaitingReviews = async (
  input: Readonly<{
    within: string;
    registry?: string;
    say?: (line: string) => void;
    keep?: (job: {
      readonly project: string;
      readonly job: number;
    }) => Promise<unknown>;
  }>,
): Promise<
  ReadonlyArray<{ readonly project: string; readonly job: number }>
> => {
  const registry = await Effect.runPromise(
    Registry.readRegistry(input.registry).pipe(
      Effect.provide(BunFileSystem.layer),
    ),
  ).catch(() => ({
    repositories: [] as ReadonlyArray<{ store: string; repository: string }>,
  }));
  const say = input.say ?? ((line: string) => console.error(line));
  const root = resolve(input.within);
  const armed: Array<{ readonly project: string; readonly job: number }> = [];
  for (const entry of registry.repositories.slice(0, REARM_REPOSITORIES)) {
    const store = resolve(entry.store);
    if (!within(root, store)) continue;
    const database = join(store, "records.sqlite");
    // A store that has gone from the registry holds nothing to re-arm.
    if (!existsSync(database)) continue;
    let jobs: ReadonlyArray<number> = [];
    try {
      const read = readAsItStands(database, (reader) =>
        reader
          .prepare(
            "SELECT job_seq AS seq FROM jobs WHERE kind = 'review.run@2' AND state IN ('waiting', 'delayed') ORDER BY job_seq LIMIT ?",
          )
          .all(REARM_JOBS)
          .map((row) => row["seq"] as number),
      );
      jobs = read.value;
      // Only a hint: the worker it starts opens the store for writing and finds its own jobs.
      if (read.withoutLog) say(readWithoutLog(database));
    } catch (error) {
      say(
        `could not check ${database} for reviews to re-arm: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    for (const job of jobs) {
      const target = { project: entry.repository, job };
      await (input.keep ?? keepWorkerFor)(target).catch(() => undefined);
      armed.push(target);
    }
  }
  return armed;
};
