import { Readable } from "node:stream";
import { Socket } from "node:net";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { Data, Effect } from "effect";
import {
  STORE_DIRECTORY_MODE,
  STORE_FILE_MODE,
  resolveStoreLocation,
  type StoreLocation,
} from "./location.ts";
import type { WorkerBuild } from "./worker.ts";
import {
  acceptedCurrentWorker,
  isLive,
  reachStoreWorker,
  requireCurrentWorkerClaim,
  socketPathFor,
} from "./worker-socket.ts";

/** The worker's output goes here when a starter spawns it. */
export const workerLogPath = (location: StoreLocation) =>
  join(location.directory, "worker.log");

const sourceConfigPath = resolve(import.meta.dir, "../../../bunfig.toml");

/**
 * What bun is told when it runs this checkout from source in another folder, such as a reviewed
 * project: load no `.env` and read only the checkout's own `bunfig.toml`. Without them bun reads
 * the folder's `.env` into a process that holds route credentials, and runs its `bunfig.toml`
 * preload. The compiled build turns both off when it is built (`build.ts`).
 */
export const sourceRunFlags = (): ReadonlyArray<string> => [
  "--no-env-file",
  `--config=${sourceConfigPath}`,
];

export const currentWorkerBuild = (): WorkerBuild =>
  Bun.main.startsWith("/$bunfs/")
    ? { kind: "compiled", path: process.execPath }
    : { kind: "source", path: sourceConfigPath };

export const currentCliCommand = (
  sourceEntry = Bun.main,
): ReadonlyArray<string> => {
  const build = currentWorkerBuild();
  return build.kind === "compiled"
    ? [build.path]
    : [process.execPath, ...sourceRunFlags(), sourceEntry];
};

export class WorkerSpawnFailed extends Data.TaggedError("WorkerSpawnFailed")<{
  readonly command: ReadonlyArray<string>;
  readonly cause: unknown;
}> {
  override get message() {
    return "The background worker didn't finish starting.\nRun the command again.";
  }
}

export type StartResult =
  | { readonly status: "running"; readonly socket: string }
  | {
      readonly status: "spawned";
      readonly pid: number | undefined;
      readonly log: string;
      readonly ready?: Effect.Effect<
        void,
        | WorkerSpawnFailed
        | Effect.Error<ReturnType<typeof requireCurrentWorkerClaim>>
      >;
    };

export interface StartOptions {
  /** A path inside the repository or any of its worktrees. */
  readonly repository: string;
  /** How to run `neuve`. Default: `neuve` on PATH. */
  readonly command?: ReadonlyArray<string>;
  /** Subscribers await the child's pushed bind acknowledgement, never readiness polling. */
  readonly waitForReady?: boolean;
  /** Retain this spawn's acknowledgement for a later subscriber without keeping the caller alive. */
  readonly deferReady?: boolean;
}

/**
 * The starter (D19). Every process that writes the spool or enqueues a job calls this after its
 * write is durable. It sends "wake" over one connection: a worker that answers or accepts is
 * running; otherwise a worker is spawned, detached. The spawned worker claims the socket under
 * SQLite's write lock (see `Worker.run`), so concurrent starters may each spawn one and exactly one
 * keeps running; a refused connection is never taken as proof that no worker runs. A worker idling
 * out releases its socket before its final rescan, so work written before this wake is either seen
 * by that rescan or finds no live socket here and gets a new worker.
 */
export const ensureWorker = (options: StartOptions) =>
  Effect.gen(function* () {
    const location = yield* resolveStoreLocation(options.repository);
    return yield* ensureWorkerAt(location, options);
  });

export const ensureWorkerAt = (
  location: StoreLocation,
  options: Omit<StartOptions, "repository"> & { readonly repository?: string },
) =>
  Effect.gen(function* () {
    const mayWake = yield* requireCurrentWorkerClaim(location).pipe(
      Effect.as(true),
      Effect.catchTag("StoreChangedDuringRead", () =>
        Effect.flatMap(socketPathFor(location), (socket) =>
          acceptedCurrentWorker(location, socket),
        ),
      ),
    );
    const { socket, reach } = mayWake
      ? yield* reachStoreWorker(location, "wake", "500 millis")
      : { socket: yield* socketPathFor(location), reach: undefined };
    if (reach !== undefined && isLive(reach)) {
      const result: StartResult = { status: "running", socket };
      return result;
    }
    const repository = options.repository;
    const cwd = repository ?? location.directory;
    const environment =
      repository === undefined
        ? {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: cwd,
            TMPDIR: cwd,
          }
        : process.env;
    const command = [
      ...(options.command ?? ["neuve"]),
      "worker",
      "run",
      ...(repository === undefined
        ? ["--store", location.directory]
        : ["--repo", repository]),
    ];
    // An uncertain read delegates acceptance to the worker, including when no socket exists yet.
    const waitForReady = options.waitForReady || !mayWake;
    const captureReady = waitForReady || options.deferReady;
    const log = workerLogPath(location);
    const spawned = yield* Effect.try({
      try: () => {
        mkdirSync(location.directory, {
          recursive: true,
          mode: STORE_DIRECTORY_MODE,
        });
        const output = openSync(log, "a", STORE_FILE_MODE);
        try {
          const [file, ...args] = command;
          const child = spawn(file ?? "neuve", args, {
            detached: true,
            stdio: captureReady
              ? ["ignore", output, output, "pipe"]
              : ["ignore", output, output],
            cwd,
            env: captureReady
              ? { ...environment, NEUVE_WORKER_READY_FD: "3" }
              : environment,
          });
          child.on("error", () => {});
          child.unref();
          const pipe = child.stdio[3];
          let timer: ReturnType<typeof setTimeout> | undefined;
          const ready = captureReady
            ? new Promise<void>((resolve, reject) => {
                if (!(pipe instanceof Readable)) {
                  reject(new Error("worker readiness pipe missing"));
                  return;
                }
                const finish = (cause?: unknown) => {
                  clearTimeout(timer);
                  pipe.destroy();
                  cause === undefined ? resolve() : reject(cause);
                };
                timer = setTimeout(
                  () => finish(new Error("worker did not acknowledge startup")),
                  10_000,
                );
                pipe.once("data", () => finish());
                pipe.once("end", () =>
                  finish(
                    new Error("worker closed before acknowledging startup"),
                  ),
                );
                pipe.once("error", finish);
                child.once("error", finish);
              })
            : undefined;
          if (ready) void ready.catch(() => {});
          if (!waitForReady) {
            if (pipe instanceof Socket) pipe.unref();
            timer?.unref();
          }
          return {
            pid: child.pid,
            ready:
              ready === undefined
                ? undefined
                : () => {
                    if (pipe instanceof Socket) pipe.ref();
                    timer?.ref();
                    return ready;
                  },
          };
        } finally {
          closeSync(output);
        }
      },
      catch: (cause) => new WorkerSpawnFailed({ command, cause }),
    });
    const readiness =
      spawned.ready === undefined
        ? undefined
        : Effect.tryPromise({
            try: spawned.ready,
            catch: (cause) => new WorkerSpawnFailed({ command, cause }),
          }).pipe(
            Effect.catchTag("WorkerSpawnFailed", (error) =>
              Effect.andThen(
                requireCurrentWorkerClaim(location),
                Effect.fail(error),
              ),
            ),
          );
    if (readiness && waitForReady) yield* readiness;
    const result: StartResult = {
      status: "spawned",
      pid: spawned.pid,
      log,
      ...(options.deferReady && readiness ? { ready: readiness } : {}),
    };
    return result;
  });
