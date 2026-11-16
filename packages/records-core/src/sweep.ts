import { dirname } from "node:path";
import { Effect, Option } from "effect";
import { FileSystem } from "effect/FileSystem";
import type { JobKind } from "@neuve/records-schema";
import { pendingSpoolFiles } from "./ingest.ts";
import { storeLocationIn } from "./location.ts";
import * as Queue from "./queue.ts";
import { wantedPrune } from "./retention.ts";
import { readRegistry, registryPath } from "./registry.ts";
import { ensureWorkerAt, type StartResult } from "./starter.ts";
import * as Store from "./store.ts";
import { defaultHandlers } from "./worker.ts";

export interface SweepEntry {
  readonly repository: string;
  readonly spoolFiles: number;
  readonly queuedJobs: number;
  /** Raw captures are past retention and no prune job covers them yet; a worker start enqueues it. */
  readonly pruneWanted: boolean;
  readonly outcome:
    | { readonly status: "idle" }
    | { readonly status: "missing" }
    | { readonly status: "error"; readonly message: string }
    | StartResult;
}

const describe = (error: unknown) =>
  typeof error === "object" && error !== null && "_tag" in error
    ? String((error as { _tag: unknown })._tag)
    : String(error);

/**
 * The launchd sweep (D19): for every registered repository with spooled events, queued jobs this
 * build can run, or raw captures past retention that no prune job covers, run the starter.
 * Repositories with nothing to do get no worker.
 */
export const sweep = (options: {
  readonly command?: ReadonlyArray<string>;
  readonly registry?: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const registry = yield* readRegistry(options.registry ?? registryPath());
    const kinds = Object.keys(defaultHandlers) as Array<JobKind>;
    const entries: Array<SweepEntry> = [];
    for (const { store, repository } of registry.repositories) {
      const location = storeLocationIn(dirname(store));
      if (!(yield* fs.exists(repository)) || !(yield* fs.exists(store))) {
        entries.push({
          repository,
          spoolFiles: 0,
          queuedJobs: 0,
          pruneWanted: false,
          outcome: { status: "missing" },
        });
        continue;
      }
      const spoolFiles = (yield* pendingSpoolFiles(location)).length;
      const queued = yield* Effect.result(
        Effect.gen(function* () {
          if (!(yield* fs.exists(location.database)))
            return { jobs: 0, pruneWanted: false };
          return yield* Effect.gen(function* () {
            yield* Store.prepareForRead;
            const queue = yield* Queue.JobQueue;
            return {
              jobs: (yield* queue.outstanding(kinds)).queued,
              pruneWanted: Option.isSome(yield* wantedPrune),
            };
          }).pipe(
            Effect.provide(Queue.layer),
            Effect.provide(Store.layer(location, { create: false })),
          );
        }),
      );
      if (queued._tag === "Failure") {
        entries.push({
          repository,
          spoolFiles,
          queuedJobs: 0,
          pruneWanted: false,
          outcome: { status: "error", message: describe(queued.failure) },
        });
        continue;
      }
      const { jobs, pruneWanted } = queued.success;
      if (spoolFiles === 0 && jobs === 0 && !pruneWanted) {
        entries.push({
          repository,
          spoolFiles,
          queuedJobs: 0,
          pruneWanted,
          outcome: { status: "idle" },
        });
        continue;
      }
      const started = yield* Effect.result(
        ensureWorkerAt(location, {
          repository,
          ...(options.command === undefined
            ? {}
            : { command: options.command }),
        }),
      );
      entries.push({
        repository,
        spoolFiles,
        queuedJobs: jobs,
        pruneWanted,
        outcome:
          started._tag === "Success"
            ? started.success
            : { status: "error", message: describe(started.failure) },
      });
    }
    return entries;
  });
