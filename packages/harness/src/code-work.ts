import { knownIndexSnapshot } from "./index-snapshot.ts";
import { safeRead } from "@neuve/records-schema";
import { mkdir, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { withStoreLock } from "./stack/store.ts";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Context, Data, Duration, Effect } from "effect";
import { JOB_POLICIES, type StoreLocation } from "@neuve/records-core";
import { z } from "zod";

export const CodeWork = Context.Reference<
  { readonly directory: string; readonly background: boolean } | undefined
>("@neuve/harness/CodeWork", { defaultValue: () => undefined });
export const codeOwnerAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};
export const REVIEW_MARKER_MAX_MS = Duration.toMillis(
  JOB_POLICIES["review.run@2"].deadline,
);
const Marker = z.strictObject({
  pid: z.int().positive(),
  start: z.string().min(1).nullable(),
  createdAt: z.number().finite(),
  expiresAt: z.number().finite(),
});
const starts = new Map<number, { at: number; start: string | null }>();
/** Linux exposes a precise kernel fingerprint; ps supplies the portable second-resolution value. */
export const codeProcessStart = (pid: number): string | null => {
  const saved = starts.get(pid),
    now = Date.now();
  if (saved && now - saved.at < 1000) return saved.start;
  let start: string | null = null;
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      if (ticks)
        start = `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${ticks}`;
    } else {
      const result = Bun.spawnSync(
        ["/bin/ps", "-o", "lstart=", "-p", String(pid)],
        { env: { LC_ALL: "C", TZ: "UTC" }, stdout: "pipe", stderr: "ignore" },
      );
      if (result.exitCode === 0)
        start = result.stdout.toString().trim() || null;
    }
  } catch {}
  starts.set(pid, { at: now, start });
  while (starts.size > 64) {
    const oldest = starts.keys().next().value;
    if (oldest !== undefined) starts.delete(oldest);
  }
  return start;
};
const liveMarker = (value: unknown, source: string, now = Date.now()) => {
  const parsed = safeRead(Marker, value, { source });
  if (!parsed.success) return true;
  const marker = parsed.data;
  if (
    marker.createdAt > now ||
    marker.expiresAt <= now ||
    marker.expiresAt - marker.createdAt > REVIEW_MARKER_MAX_MS ||
    !codeOwnerAlive(marker.pid)
  )
    return false;
  const current = codeProcessStart(marker.pid);
  return marker.start === null || current === null || current === marker.start;
};
// Liveness uses known fields; deleting a marker must also preserve newer fields.
const knownMarker = (value: unknown, source: string) => {
  const parsed = safeRead(Marker, value, { source });
  return parsed.success && parsed.droppedKeys.length === 0;
};
const readMarker = (path: string) => {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value;
  } catch {
    return undefined;
  }
};
const publishMarker = async (path: string, marker: z.infer<typeof Marker>) => {
  const temporary = `${path}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(marker), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
};
const reviews = (directory: string) => join(directory, "code-work", "reviews");

export const IndexLease = Context.Reference<boolean>(
  "@neuve/harness/IndexLease",
  { defaultValue: () => false },
);
export class PreparationYielded extends Data.TaggedError(
  "PreparationYielded",
)<{}> {}

/** A builder releases its lease before waiting; ordinary preparation pauses in place. */
export const reviewPrecomputeActive = (directory: string) => {
  const folder = reviews(directory);
  let blocked = false;
  try {
    for (const entry of readdirSync(folder)) {
      if (entry.endsWith(".tmp")) continue;
      const marker = readMarker(join(folder, entry));
      if (liveMarker(marker, join(folder, entry))) blocked = true;
      else if (knownMarker(marker, join(folder, entry)))
        rmSync(join(folder, entry), { force: true });
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  return blocked;
};
export const codeCheckpoint = Effect.gen(function* () {
  const work = yield* CodeWork;
  if (!work?.background) return;
  let waiting = false;
  while (reviewPrecomputeActive(work.directory)) {
    if (yield* IndexLease) return yield* new PreparationYielded();
    if (!waiting)
      yield* Effect.logInfo(
        "commit.prepare: yielding code work to review Precompute",
      );
    waiting = true;
    yield* Effect.sleep(25);
  }
  if (waiting)
    yield* Effect.logInfo(
      "commit.prepare: review Precompute finished; code work resumed",
    );
});

const reapActors = async (directory: string) => {
  const actors = join(directory, "code-work", "actors");
  await mkdir(actors, { recursive: true, mode: 0o700 });
  const live = [];
  for (const name of await readdir(actors)) {
    const marker = readMarker(join(actors, name));
    if (liveMarker(marker, join(actors, name))) live.push(name);
    else if (knownMarker(marker, join(actors, name)))
      await rm(join(actors, name), { force: true });
  }
  return live;
};
const clearSnapshots = async (directory: string) => {
  const indexes = join(directory, "code-work", "indexes");
  await mkdir(indexes, { recursive: true, mode: 0o700 });
  const builds = join(indexes, "build");
  for (const name of await readdir(builds).catch(() => [])) {
    if (!/^[a-f0-9]{64}$/.test(name)) continue;
    // A released lease leaves an empty folder. Any remaining file may belong to a newer writer.
    await rmdir(join(builds, name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
    });
  }
  for (const name of await readdir(indexes)) {
    if (
      name.endsWith(".index") &&
      (await knownIndexSnapshot(join(indexes, name)))
    )
      await rm(join(indexes, name), { force: true });
  }
};

/** Snapshots exist only while code-work actors overlap. Last release removes them;
 * a new actor reaps abandoned snapshots before starting. Nothing per tree is retained. */
export const withCodeWork = <A, E, R>(
  location: StoreLocation,
  background: boolean,
  effect: Effect.Effect<A, E, R>,
  expiresAt?: number,
) =>
  Effect.acquireUseRelease(
    Effect.tryPromise(async () =>
      withStoreLock(
        join(location.directory, "code-work", "lifecycle"),
        async () => {
          if ((await reapActors(location.directory)).length === 0)
            await clearSnapshots(location.directory);
          const createdAt = Date.now();
          const marker = {
            pid: process.pid,
            start: codeProcessStart(process.pid),
            createdAt,
            expiresAt: Math.min(
              expiresAt ?? createdAt + REVIEW_MARKER_MAX_MS,
              createdAt + REVIEW_MARKER_MAX_MS,
            ),
          };
          const name = `${process.pid}-${randomUUID()}`;
          const actor = join(location.directory, "code-work", "actors", name);
          const review = background
            ? undefined
            : join(reviews(location.directory), name);
          await mkdir(reviews(location.directory), {
            recursive: true,
            mode: 0o700,
          });
          await publishMarker(actor, marker);
          try {
            if (review) await publishMarker(review, marker);
          } catch (error) {
            await rm(actor, { force: true });
            throw error;
          }
          return { actor, review };
        },
      ),
    ),
    () =>
      effect.pipe(
        Effect.provideService(CodeWork, {
          directory: location.directory,
          background,
        }),
      ),
    (held) =>
      Effect.promise(async () =>
        withStoreLock(
          join(location.directory, "code-work", "lifecycle"),
          async () => {
            if (held.review) await rm(held.review, { force: true });
            await rm(held.actor, { force: true });
            if ((await reapActors(location.directory)).length === 0)
              await clearSnapshots(location.directory);
          },
        ),
      ),
  );
