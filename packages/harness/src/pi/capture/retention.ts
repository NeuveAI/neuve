import { captureStagingOwner, captureStagingProcessAlive } from "./staging.ts";
import { privateInspectionDirectory } from "./safety.ts";
import { lstat, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Cause, Clock, Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  Retention,
  type StoreLocation,
  type Worker,
} from "@neuve/records-core";

/** Frozen recognition state has exactly the raw capture's retention, including tombstones. */
export const captureCheckpointSweep = (
  location: StoreLocation,
): Retention.RetentionSweep => {
  const due = Effect.gen(function* () {
    const sql = yield* SqlClient;
    const now = yield* Clock.currentTimeMillis;
    const cutoff = Retention.cutoffAt(now);
    const root = join(location.directory, "capture-authorities");
    const names = yield* Effect.tryPromise(async () => {
      try {
        return await readdir(root);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return [];
        throw error;
      }
    });
    const paths: string[] = [];
    const ids = new Set(names.filter((name) => /^[a-f0-9]{64}$/.test(name)));
    const pruned = new Map<string, boolean>();
    if (ids.size > 0) {
      let after = 0;
      for (;;) {
        const rows = yield* sql<{
          seq: number;
          checkpointId: string | null;
          prunedAt: string | null;
        }>`SELECT e.seq,json_extract(e.envelope,'$.payload.checkpoint.id') AS checkpoint_id,b.pruned_at FROM events e JOIN blobs b ON b.hash=json_extract(e.envelope,'$.payload.rawCapture') WHERE e.kind='capture.filed@1' AND e.seq>${after} ORDER BY e.seq LIMIT 128`;
        for (const row of rows) {
          after = row.seq;
          if (row.checkpointId !== null && ids.has(row.checkpointId))
            pruned.set(
              row.checkpointId,
              (pruned.get(row.checkpointId) ?? true) && row.prunedAt !== null,
            );
        }
        if (rows.length < 128) break;
      }
    }
    for (const id of ids) {
      const path = join(root, id);
      const info = yield* Effect.tryPromise(() => lstat(path));
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      const expired = pruned.get(id);
      if (
        expired === true ||
        (expired === undefined && info.mtimeMs < Date.parse(cutoff))
      )
        paths.push(path);
    }
    for (const [directory, pattern] of [
      [join(location.directory, "capture-jobs"), /^job-[A-Za-z0-9]+$/],
      [join(location.directory, "capture-scans"), /^attempt-[A-Za-z0-9]+$/],
      [location.directory, /^\.capture-checkpoint-[A-Za-z0-9]+$/],
    ] as const) {
      const names = yield* Effect.tryPromise(async () => {
        try {
          return await readdir(directory);
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
            return [];
          throw error;
        }
      });
      for (const name of names) {
        if (!pattern.test(name)) continue;
        const path = join(directory, name);
        const info = yield* Effect.tryPromise(() => lstat(path));
        if (!info.isDirectory() || info.isSymbolicLink()) continue;
        const owner = yield* Effect.try(() => captureStagingOwner(path));
        if (owner?.kind === "newer") continue;
        if (owner !== undefined && captureStagingProcessAlive(owner.pid)) {
          if (owner.job === undefined) continue;
          const [live] =
            yield* sql`SELECT 1 FROM jobs WHERE job_seq=${owner.job.seq} AND attempts=${owner.job.attempt} AND state='active'`;
          if (live !== undefined) continue;
        }
        paths.push(path);
      }
    }
    const snapshots = join(
      dirname(
        privateInspectionDirectory(location.directory, location.directory),
      ),
      "snapshots",
    );
    const pending = yield* Effect.tryPromise(async () => {
      try {
        return await readdir(snapshots);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return [];
        throw error;
      }
    });
    for (const name of pending) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue;
      const path = join(snapshots, name);
      const info = yield* Effect.tryPromise(() => lstat(path));
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      const owner = yield* Effect.try(() => captureStagingOwner(path));
      if (owner?.kind === "newer") continue;
      if (
        owner !== undefined
          ? !captureStagingProcessAlive(owner.pid)
          : info.mtimeMs < now - 32 * 60 * 1000
      )
        paths.push(path);
    }
    return paths;
  });
  return {
    name: "capture authority checkpoints",
    wanted: Effect.map(due, (paths) => paths.length > 0),
    sweep: Effect.flatMap(due, (paths) =>
      Effect.forEach(paths, (path) =>
        Effect.as(
          Effect.tryPromise(() => rm(path, { recursive: true, force: true })),
          "removed expired private capture state",
        ),
      ),
    ),
  };
};

/** The core pruner commits blob tombstones first; only then may recognition state be removed. */
export const capturePruneHandler = (
  location: StoreLocation,
  prune: Worker.JobHandler | undefined,
): Worker.JobHandler => {
  if (prune === undefined)
    throw new Error("capture retention requires the core prune handler");
  return (job) =>
    prune(job).pipe(
      Effect.ensuring(
        captureCheckpointSweep(location).sweep.pipe(
          Effect.catch(() =>
            Effect.logWarning(
              "capture checkpoint pruning failed; the next retention sweep will retry",
            ),
          ),
        ),
      ),
    );
};

/** A private-state sweep failure must not skip held-review and ended-run recovery. */
export const captureStartupRecovery = <A, E, R, B, E2, R2>(
  capture: Effect.Effect<A, E, R>,
  harness: Effect.Effect<B, E2, R2>,
) =>
  capture.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning(
            "capture checkpoint recovery failed; a later sweep will retry",
          ),
    ),
    Effect.andThen(harness),
  );
