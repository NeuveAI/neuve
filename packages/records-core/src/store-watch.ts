import { devNull } from "node:os";
import { basename, dirname, isAbsolute, posix } from "node:path";
import { z } from "zod";
import type { StoreLocation } from "./location.ts";

/** A running observer child: settled `ready` once armed, `failed` if it ends or misbehaves. */
export interface ObserverHandle {
  readonly ready: Promise<void>;
  readonly failed: Promise<Error>;
  /** The child's process ID, for tests that end it from outside. */
  readonly pid: number;
  /** Ends the child; resolves once it has exited. */
  close(): Promise<void>;
}

/**
 * One isolated child process that owns its watches for its lifetime and reports over IPC. `ready`
 * settles on its `ready` message, `failed` on its exit, an error or any message outside `messages`;
 * `close` ends it and resolves when it has exited. Both the worker's database observer and
 * `watchChanges` run on this, so they share one failure behaviour.
 */
export const spawnObserver = <
  const M extends readonly [string, ...string[]],
>(options: {
  readonly script: string;
  readonly argument: string;
  readonly cwd: string;
  /** Names the observer in its errors, as in "Records database watcher". */
  readonly label: string;
  readonly messages: M;
  readonly received: (message: Exclude<M[number], "ready">) => void;
}): ObserverHandle => {
  const Message = z.enum(options.messages);
  const ready = Promise.withResolvers<void>();
  void ready.promise.catch(() => {});
  const failed = Promise.withResolvers<Error>();
  let closed = false;
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      `--config=${devNull}`,
      "--eval",
      options.script,
      options.argument,
    ],
    {
      cwd: options.cwd,
      env: { BUN_BE_BUN: "1", TMPDIR: process.env.TMPDIR },
      stdin: "ignore",
      stdout: "inherit",
      stderr: "pipe",
      ipc(message: unknown) {
        console.error("observer IPC", message);
        if (closed) return;
        const value = Message.safeParse(message);
        if (!value.success) {
          const error = new Error(`Invalid ${options.label} message`);
          ready.reject(error);
          failed.resolve(error);
        } else if (value.data === "ready") ready.resolve();
        else options.received(value.data as Exclude<M[number], "ready">);
      },
    },
  );
  const stderr = new Response(child.stderr).text();
  const exited = child.exited.then(async (code) => {
    const detail = (await stderr).trim();
    if (closed) return;
    const error = new Error(
      `${options.label} exited ${code}${detail ? `: ${detail}` : ""}`,
    );
    ready.reject(error);
    failed.resolve(error);
  });
  return {
    ready: ready.promise,
    failed: failed.promise,
    pid: child.pid,
    async close() {
      closed = true;
      child.kill("SIGTERM");
      await exited;
    },
  };
};

/**
 * How many probe writes a new watch may take before the child gives up on it. A write goes once per
 * event-loop turn until the watch reports it. The most measured on this Mac was 4,385 (internal disk)
 * and 3,884 (LaCie), so this leaves a margin of over 20; reaching it takes a few seconds on LaCie.
 */
export const PROBE_WRITES_MAX = 100_000;

// The child watches the git common directory for the store folder's own entry, the store folder for
// the database, its WAL and the `also` names, and each folder an `also` path passes through. A
// folder is re-armed only when the inode at its path differs from the one watched (or one appears
// where none was): an attribute change, such as every store open tightening the folder to 0700, is
// not a new folder, and re-arming on it would drop the events pending on the old watch. The folder
// is stat'ed before it is watched, so a replacement between the two leaves a stale identity that the
// replacement's own event in the parent corrects.
//
// Adding or closing any watch in a process briefly blinds the process's other watches (measured by
// the lane's reviewer on the internal disk: closing one watch and writing beside another lost the
// write 12 times in 100, adding one 11 in 100). So after any change to the set of watches, every
// watch that remains proves itself live again: the child writes a probe file,
// `.neuve-watch-probe-<pid>-<round>`, in each watched folder once per event-loop turn (setImmediate,
// no timer) until that watch reports it, then removes it. The probes' own events are never
// reported. Each round names its probe afresh, so an event of an earlier round's write proves
// nothing. Once every watch has reported, the child looks at the folders again, since an event lost
// while it was blind may have been a folder appearing or going; if nothing changed, it reports one
// change (the first time, `ready`), so the caller re-reads and nothing written in the gap is lost. A
// folder that disappears is also reported at once. For the watch on the git common directory the
// probe sits there for the few milliseconds a round takes. A watch that has not reported its probe
// after `probeWrites` writes ends the child.
const storeObserver = `const {watch, statSync, realpathSync, writeFileSync, unlinkSync} = require("node:fs");
const {join, posix, sep} = require("node:path");
const {parent, name, also, probeWrites} = JSON.parse(process.argv.at(-1));
const store = join(parent, name);
const probePrefix = ".neuve-watch-probe-" + process.pid;
const targets = new Set(["records.sqlite", "records.sqlite-wal", ...also]);
const folders = new Set([""]);
for (const path of also) for (let at = posix.dirname(path); at !== "."; at = posix.dirname(at)) folders.add(at);
const within = rel => [...folders].filter(f => f !== "" && posix.dirname(f) === (rel === "" ? "." : rel));
const held = new Map();
let started = false, scheduled = false, rounds = 0, probes = new Map(), probeName = probePrefix;
const missing = code => code === "ENOENT" || code === "ENOTDIR";
const identity = rel => {
  try {
    const stat = statSync(join(store, rel));
    return stat.isDirectory() ? stat.dev + ":" + stat.ino : undefined;
  } catch (error) {
    if (missing(error.code)) return undefined;
    throw error;
  }
};
const isProbe = file => file !== null && file !== undefined && String(file).startsWith(probePrefix);
const unprobe = () => { for (const folder of probes.keys()) try { unlinkSync(join(folder, probeName)); } catch {} };
const fail = message => { unprobe(); console.error(message); process.exit(1); };
const report = () => { if (started) process.send("change"); };
const changedSet = () => { if (!scheduled) { scheduled = true; setImmediate(prove); } };
const prove = () => {
  scheduled = false;
  unprobe();
  rounds += 1;
  probeName = probePrefix + "-" + rounds;
  const round = new Map([[parent, { writes: 0, current: () => true }]]);
  for (const [rel, entry] of held) round.set(entry.folder, { writes: 0, rel, current: () => held.get(rel) === entry });
  probes = round;
  for (const [folder, state] of round) step(round, folder, state);
};
const step = (round, folder, state) => {
  if (probes !== round || round.get(folder) !== state) return;
  if (!state.current()) { round.delete(folder); return finish(round); }
  if (state.writes >= probeWrites)
    fail("the watch on " + folder + " never became live: no event for its probe after " + state.writes + " writes" + (state.lastError ? " (last write: " + state.lastError + ")" : ""));
  state.writes += 1;
  try {
    writeFileSync(join(folder, probeName), "");
  } catch (error) {
    state.lastError = error.code ?? String(error);
    if (missing(error.code) && state.rel !== undefined) sync(state.rel);
  }
  setImmediate(() => step(round, folder, state));
};
const probed = (folder, file) => {
  const round = probes;
  if (String(file) !== probeName || !round.has(folder)) return;
  round.delete(folder);
  try { unlinkSync(join(folder, probeName)); } catch {}
  finish(round);
};
const walk = rel => { sync(rel); if (held.has(rel)) for (const inner of within(rel)) walk(inner); };
const finish = round => {
  if (probes !== round || round.size > 0 || scheduled) return;
  walk("");
  if (scheduled) return;
  for (const entry of held.values()) if (!entry.announced) { entry.announced = true; process.send("armed"); }
  if (started) process.send("change");
  else { started = true; process.send("ready"); }
};
const drop = rel => {
  const entry = held.get(rel);
  if (entry === undefined) return;
  entry.watcher.close();
  held.delete(rel);
  changedSet();
  for (const inner of within(rel)) drop(inner);
};
const inside = folder => {
  const real = realpathSync(folder), root = realpathSync(store);
  return real === root || real.startsWith(root + sep) ? undefined : real;
};
const sync = rel => {
  const now = identity(rel);
  if (held.get(rel)?.id === now) return;
  const had = held.has(rel);
  drop(rel);
  const folder = join(store, rel);
  let entry;
  try {
    if (now === undefined) throw Object.assign(new Error("gone"), { code: "ENOENT" });
    const outside = rel === "" ? undefined : inside(folder);
    if (outside !== undefined) fail("the folder " + rel + " of a watched path resolves outside the store folder, to " + outside);
    const watcher = watch(folder, (event, file) => {
      console.log("watch", folder, event, file);
      // A replaced folder's last events are not the new folder's.
      if (held.get(rel) !== entry) return;
      if (isProbe(file)) probed(folder, file);
      else seen(rel, file);
    });
    entry = { watcher, id: now, folder, announced: false };
  } catch (error) {
    if (!missing(error.code)) throw error;
    return had ? report() : undefined;
  }
  entry.watcher.on("error", error => {
    if (held.get(rel) !== entry) return;
    if (identity(rel) === now) fail(error.message);
    sync(rel);
  });
  held.set(rel, entry);
  changedSet();
  for (const inner of within(rel)) sync(inner);
};
const seen = (rel, file) => {
  if (file === null || file === undefined) {
    for (const inner of within(rel)) sync(inner);
    return report();
  }
  const path = rel === "" ? String(file) : rel + "/" + file;
  if (targets.has(path)) report();
  if (folders.has(path)) sync(path);
};
const top = watch(parent, (_, file) => {
  if (isProbe(file)) probed(parent, file);
  else if (file === null || file === undefined || String(file) === name) sync("");
});
top.on("error", error => fail(error.message));
const stop = () => { unprobe(); top.close(); for (const entry of held.values()) entry.watcher.close(); process.exit(0); };
process.on("disconnect", stop);
process.on("SIGTERM", stop);
sync("");
changedSet();`;

/**
 * A watch on a store. `armings` counts the store and `also` folders whose watch has gone live so far
 * (the parent's is not counted), for tests: a live watch's change comes right after its count rises.
 */
export interface StoreWatch extends ObserverHandle {
  readonly armings: number;
}

const relativeAlso = (path: string) => {
  const normal = posix.normalize(path);
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    normal === "." ||
    normal === ".." ||
    normal.startsWith("../") ||
    normal.endsWith("/")
  )
    throw new RangeError(
      `watchChanges: ${JSON.stringify(path)} is not a file path inside the store directory`,
    );
  return normal;
};

/**
 * Calls `changed` for each file-system event that may have changed what the store holds: in the
 * store directory, `records.sqlite`, `records.sqlite-wal` or an event that names no file (as the
 * worker's observer counts them); each file in `options.also`, relative to the store directory,
 * also inside a sub-folder that does not exist yet; and the store directory appearing, disappearing
 * or being replaced, seen through its parent (the git common directory), after which the new
 * folder is watched. Records names no other package's files: a caller passes them in `also`. One
 * isolated child owns the watches, so nothing here opens Records and nothing polls or times: every
 * call is caused by an event. `failed` settles if the child exits, errors or misbehaves; `close`
 * ends it and resolves when it has exited.
 *
 * `ready` means live. Bun's `fs.watch` gives no stream-started signal and misses a write made right
 * after `watch()` returns (the desk lane measured, on its own watcher, 10 to 12 of 40 runs on the
 * internal disk and 5 of 40 on LaCie missing a write in the first 10 ms; one probe write alone was
 * lost 1 run in 8), and adding or closing a watch briefly blinds the others in the same process (the
 * reviewer measured 11 and 12 in 100 on the internal disk). So after every change to its set of
 * watches, the child has each one report a probe file before it relies on it, then looks at the
 * folders again and reports one change. `ready` resolves after the first such round, the parent's
 * watch included whether or not the store exists yet; the store folder appearing, disappearing or
 * replaced, or an `also` folder appearing or going, ends in one change once every remaining watch is
 * live, and a folder that disappears is also reported at once. The rounds are bounded by
 * `PROBE_WRITES_MAX` writes per watch, not by time: past it the child ends, `ready` rejects and
 * `failed` says which watch never became live. Measured on this Mac in round one of this helper (50
 * starts and 50 store replacements per disk), a watch reported its probe after a median of 9 to 20
 * writes and at most 4,385, and `ready` came a median of 14 ms after the call and at most 118 ms.
 * An `also` folder that resolves outside the store folder (through a symbolic link) is refused: the
 * child ends with that error instead of watching or writing there.
 *
 * Hold one connection across reads. Closing the last connection to the store writes to
 * `records.sqlite` and its WAL, which raises the events this counts: a caller that opens a
 * connection per read while watching wakes itself in a loop (the desk lane measured 112 reads in
 * 3 seconds with no writer).
 */
export const watchChanges = (
  location: StoreLocation,
  changed: () => void,
  options?: { readonly also?: ReadonlyArray<string> },
): StoreWatch => {
  const also = (options?.also ?? []).map(relativeAlso);
  let armings = 0;
  const handle = spawnObserver({
    script: storeObserver,
    argument: JSON.stringify({
      parent: dirname(location.directory),
      name: basename(location.directory),
      also,
      probeWrites: PROBE_WRITES_MAX,
    }),
    // The child's paths are absolute; the root always exists, so a missing parent is its error.
    cwd: "/",
    label: "Records store watcher",
    messages: ["ready", "change", "armed"],
    received: (message) => {
      if (message === "armed") armings += 1;
      else changed();
    },
  });
  return {
    ...handle,
    get armings() {
      return armings;
    },
  };
};
