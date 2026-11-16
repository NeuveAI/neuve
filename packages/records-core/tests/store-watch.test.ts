// Why: `watchChanges` replaces the desk's once-a-second read of the review mark, so an event it misses
// is a page that never updates, and one it invents is a reload loop. These run a real watch on a
// scratch store and drive the file system.
//
// `ready` means live, so each triggering write is made once, never repeated (a repeat would hide a
// lost event), and its change is awaited under a deadline that fails the test. A "no event" check is
// fenced by a barrier whose own messages are told apart from a change: replacing a watched
// sub-folder in one rename, which arms a new watch before its change. One folder's events reach the
// child in order, so a change the unrelated write caused would be counted before the barrier's
// arming.
import { afterAll, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Store, storeLocationIn, type StoreLocation } from "../src/index.ts";

const created: Array<string> = [];
const watches: Array<Store.StoreWatch> = [];
afterAll(async () => {
  await Promise.all(watches.map((watch) => watch.close()));
  for (const directory of created) {
    chmodSync(directory, 0o700);
    rmSync(directory, { recursive: true, force: true });
  }
});

const DEADLINE_MS = 5_000;
const ROUNDS = 200;
const ROUNDS_RECREATED = 150;

const scratch = (withStore: boolean) => {
  const common = mkdtempSync(join(tmpdir(), "store-watch-"));
  created.push(common);
  const location = storeLocationIn(common);
  if (withStore) {
    mkdirSync(location.directory, { mode: 0o755 });
    writeFileSync(location.database, "");
    writeFileSync(`${location.database}-wal`, "");
  }
  return location;
};

const probes = (folder: string) =>
  existsSync(folder)
    ? readdirSync(folder).filter((name) =>
        name.startsWith(".neuve-watch-probe-"),
      )
    : [];

/** A watch whose changes are counted, each tagged with how many folders were armed when it came. */
const start = async (
  location: StoreLocation,
  also?: ReadonlyArray<string>,
  onChange?: () => void,
) => {
  const changes: Array<number> = [];
  const waiting: Array<() => void> = [];
  const watch = Store.watchChanges(
    location,
    () => {
      changes.push(watch.armings);
      onChange?.();
      for (const wake of waiting.splice(0)) wake();
    },
    also === undefined ? undefined : { also },
  );
  watches.push(watch);
  await watch.ready;
  /** Makes `act` once, then waits for a change satisfying `done`; fails past the deadline. */
  const until = async (act: () => void, done: () => boolean) => {
    const end = performance.now() + DEADLINE_MS;
    act();
    while (!done()) {
      const left = end - performance.now();
      if (left <= 0)
        throw new Error(
          `no expected change within ${DEADLINE_MS} ms (${changes.length} seen)`,
        );
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        waiting.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  };
  /** Makes `act` once and waits for a change after it. */
  const expectChange = async (act: () => void) => {
    const before = changes.length;
    await until(act, () => changes.length > before);
  };
  return { watch, changes, until, expectChange };
};

/** Replaces `folder` in one rename, so it is never missing: the watch re-arms it, then reports. */
const replaceFolder = (folder: string, fill?: (fresh: string) => void) => {
  const fresh = `${folder}.next`;
  mkdirSync(fresh);
  fill?.(fresh);
  renameSync(fresh, folder);
};

/** Replaces the folder `gate` and waits for the change of its new watch; returns the arming count. */
const barrier = async (
  run: Awaited<ReturnType<typeof start>>,
  gate: string,
) => {
  const armed = run.watch.armings;
  await run.until(
    () => replaceFolder(gate),
    () => (run.changes.at(-1) ?? 0) > armed,
  );
  return run.watch.armings;
};

test("a write to records.sqlite calls changed", async () => {
  const location = scratch(true);
  const run = await start(location);
  await run.expectChange(() => appendFileSync(location.database, "x"));
});

test("a change to the WAL alone calls changed", async () => {
  const location = scratch(true);
  const run = await start(location);
  await run.expectChange(() => appendFileSync(`${location.database}-wal`, "x"));
});

// What this proves: a write made as `ready` resolves is reported. What it does not: that `ready`
// waits for the watch to be live. Without the handshake it still passed (0 misses in 200, here and
// for the reviewer), because a write that early is usually caught; the re-arm, re-creation and
// closed-watch tests below are the ones that fail without the rounds of probes.
test(
  "a write in the tick ready resolves is reported, every time",
  async () => {
    let missed = 0;
    for (let round = 0; round < ROUNDS; round += 1) {
      // A fresh, empty store folder: no earlier event of a watched file can stand in for the write.
      const location = scratch(false);
      mkdirSync(location.directory);
      let wrote = false;
      let seen: () => void = () => {};
      const reported = new Promise<void>((resolve) => (seen = resolve));
      const watch = Store.watchChanges(location, () => {
        if (wrote) seen();
      });
      watches.push(watch);
      await watch.ready.then(() => {
        wrote = true;
        writeFileSync(location.database, "x");
      });
      const timer = Promise.withResolvers<"missed">();
      const handle = setTimeout(() => timer.resolve("missed"), DEADLINE_MS);
      if ((await Promise.race([reported, timer.promise])) === "missed")
        missed += 1;
      clearTimeout(handle);
      await watch.close();
      expect(probes(location.directory)).toEqual([]);
      expect(probes(dirname(location.directory))).toEqual([]);
    }
    expect(missed).toBe(0);
  },
  { timeout: 120_000 },
);

test(
  "a write in the tick a re-arm's change is reported is reported, every time",
  async () => {
    const location = scratch(true);
    let pending: { armings: number; write: () => void } | undefined;
    const run = await start(location, undefined, () => {
      // A change that comes with a higher count is the new folder's watch going live.
      if (pending !== undefined && run.watch.armings > pending.armings) {
        const { write } = pending;
        pending = undefined;
        write();
      }
    });
    for (let round = 0; round < ROUNDS; round += 1) {
      let wrote = 0;
      pending = {
        armings: run.watch.armings,
        write: () => {
          wrote = run.changes.length;
          appendFileSync(location.database, "x");
        },
      };
      await run.until(
        () =>
          // The new folder starts empty, so the write after it goes live creates the database.
          replaceFolder(location.directory, () =>
            renameSync(location.directory, `${location.directory}.old`),
          ),
        () => wrote > 0 && run.changes.length > wrote,
      );
      rmSync(`${location.directory}.old`, { recursive: true, force: true });
    }
  },
  { timeout: 120_000 },
);

test(
  "the store removed and created again at once is watched, and its writes are seen",
  async () => {
    const location = scratch(true);
    let recreate = false;
    let created = -1;
    const run = await start(location, undefined, () => {
      // In the tick the removal is reported: the moment closing its watch blinds the parent's.
      if (!recreate) return;
      recreate = false;
      mkdirSync(location.directory);
      writeFileSync(location.database, "");
      created = run.changes.length;
    });
    for (let round = 0; round < ROUNDS_RECREATED; round += 1) {
      const old = `${location.directory}.old`;
      recreate = true;
      created = -1;
      await run.until(
        () => renameSync(location.directory, old),
        () => created >= 0 && run.changes.length > created,
      );
      await run.expectChange(() => appendFileSync(location.database, "x"));
      rmSync(old, { recursive: true, force: true });
    }
  },
  { timeout: 120_000 },
);

test(
  "a write in the tick a closed watch is reported is not lost",
  async () => {
    const location = scratch(true);
    const harness = join(location.directory, "harness");
    mkdirSync(harness);
    let dropping = false;
    let wrote = -1;
    const run = await start(location, ["harness/held-reviews.json"], () => {
      // The empty folder's removal is the only event, so this change is its watch being closed.
      if (!dropping) return;
      dropping = false;
      appendFileSync(location.database, "x");
      wrote = run.changes.length;
    });
    for (let round = 0; round < ROUNDS_RECREATED; round += 1) {
      dropping = true;
      wrote = -1;
      await run.until(
        () => rmSync(harness, { recursive: true }),
        () => wrote >= 0 && run.changes.length > wrote,
      );
      const armed = run.watch.armings;
      await run.until(
        () => mkdirSync(harness),
        () => (run.changes.at(-1) ?? 0) > armed,
      );
    }
  },
  { timeout: 120_000 },
);

test("a folder named in also that is also on the way to another is watched when it appears", async () => {
  const location = scratch(true);
  const sub = join(location.directory, "sub");
  const run = await start(location, ["sub", "sub/x"]);
  const armed = run.watch.armings;
  await run.until(
    () => mkdirSync(sub),
    () => (run.changes.at(-1) ?? 0) > armed,
  );
  await run.expectChange(() => writeFileSync(join(sub, "x"), "x"));
});

test("an also folder that leads outside the store folder is refused, and nothing is written there", async () => {
  const location = scratch(true);
  const outside = mkdtempSync(join(tmpdir(), "store-watch-outside-"));
  created.push(outside);
  symlinkSync(outside, join(location.directory, "link"));
  const watch = Store.watchChanges(location, () => {}, { also: ["link/x"] });
  watches.push(watch);
  await expect(watch.ready).rejects.toThrow(
    /the folder link of a watched path resolves outside the store folder/,
  );
  expect(() => process.kill(watch.pid, 0)).toThrow();
  expect(probes(outside)).toEqual([]);
});

test("an unrelated file in the store folder does not call changed", async () => {
  const location = scratch(true);
  const gate = join(location.directory, "gate");
  mkdirSync(gate);
  const run = await start(location, ["gate/never"]);
  const fenced = await barrier(run, gate);
  const before = run.changes.filter((armings) => armings === fenced).length;
  // Creating, changing, renaming and deleting other files, also in a folder Records does not name.
  const other = join(location.directory, "other.txt");
  writeFileSync(other, "x");
  appendFileSync(other, "y");
  renameSync(other, `${other}.moved`);
  rmSync(`${other}.moved`);
  mkdirSync(join(location.directory, "spool-like"));
  writeFileSync(join(location.directory, "spool-like", "line"), "x");
  writeFileSync(`${location.database}-shm`, "x");
  const after = await barrier(run, gate);
  expect(after).toBe(fenced + 1);
  // Only the first barrier's own change carries its arming count.
  expect(run.changes.filter((armings) => armings === fenced).length).toBe(
    before,
  );
});

test("a file named in also is seen, also when its folder is created after the watch", async () => {
  const location = scratch(true);
  const harness = join(location.directory, "harness");
  const held = join(harness, "held-reviews.json");
  const run = await start(location, ["harness/held-reviews.json"]);
  const armed = run.watch.armings;
  await run.until(
    () => {
      mkdirSync(harness, { recursive: true });
      writeFileSync(held, "[]");
    },
    () => (run.changes.at(-1) ?? 0) > armed,
  );
  expect(run.watch.armings).toBe(armed + 1);
  await run.expectChange(() => appendFileSync(held, " "));
});

test("a file named in also directly in the store folder is seen", async () => {
  const location = scratch(true);
  const run = await start(location, ["marker.json"]);
  await run.expectChange(() =>
    writeFileSync(join(location.directory, "marker.json"), "{}"),
  );
});

test("the store folder created after the watch starts is seen, and later writes are", async () => {
  const location = scratch(false);
  const run = await start(location);
  expect(run.watch.armings).toBe(0);
  await run.until(
    () => mkdirSync(location.directory),
    () => run.changes.at(-1) === 1,
  );
  await run.expectChange(() => appendFileSync(location.database, "x"));
  await run.expectChange(() => appendFileSync(`${location.database}-wal`, "x"));
});

test("the store folder replaced is seen, and writes to the new one are", async () => {
  const location = scratch(true);
  const run = await start(location);
  await run.expectChange(() => appendFileSync(location.database, "x"));
  const armed = run.watch.armings;
  await run.until(
    () =>
      replaceFolder(location.directory, () =>
        renameSync(location.directory, `${location.directory}.old`),
      ),
    () => (run.changes.at(-1) ?? 0) > armed,
  );
  expect(run.watch.armings).toBe(armed + 1);
  await run.expectChange(() => appendFileSync(location.database, "x"));
});

test("a mode change of the store folder does not re-arm, and the write after it is seen", async () => {
  const location = scratch(true);
  const gate = join(location.directory, "gate");
  mkdirSync(gate);
  const run = await start(location, ["gate/never"]);
  const armed = await barrier(run, gate);
  const seen = run.changes.length;
  // As every store open does: tighten the folder, then write at once.
  await run.until(
    () => {
      chmodSync(location.directory, 0o700);
      appendFileSync(location.database, "x");
    },
    () => run.changes.length > seen,
  );
  // The barrier arms exactly one folder, so a re-arm of the store folder would show here.
  expect(await barrier(run, gate)).toBe(armed + 1);
});

test("close ends the child", async () => {
  const location = scratch(true);
  const run = await start(location);
  await run.watch.close();
  expect(() => process.kill(run.watch.pid, 0)).toThrow();
});

test("a killed child settles failed", async () => {
  const location = scratch(true);
  const run = await start(location);
  process.kill(run.watch.pid, "SIGKILL");
  const error = await run.watch.failed;
  expect(error.message).toMatch(/^Records store watcher exited/);
});

test(
  "a watch that can never become live fails by the bound and leaves nothing behind",
  async () => {
    // The probe cannot be written: in the git common directory, then in the store folder.
    for (const locked of ["parent", "store"] as const) {
      const location = scratch(true);
      const folder =
        locked === "parent" ? dirname(location.directory) : location.directory;
      chmodSync(folder, 0o500);
      const watch = Store.watchChanges(location, () => {});
      watches.push(watch);
      await expect(watch.ready).rejects.toThrow(
        new RegExp(
          `the watch on ${folder.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")} never became live: no event for its probe after ${Store.PROBE_WRITES_MAX} writes \\(last write: EACCES\\)`,
        ),
      );
      expect((await watch.failed).message).toMatch(/never became live/);
      expect(() => process.kill(watch.pid, 0)).toThrow();
      chmodSync(folder, 0o700);
      expect(probes(location.directory)).toEqual([]);
      expect(probes(dirname(location.directory))).toEqual([]);
    }
  },
  // The bound counts writes, not time: on LaCie each variant takes a few seconds to reach it.
  { timeout: 60_000 },
);

test("a missing git common directory settles failed and rejects ready", async () => {
  const location = storeLocationIn(join(scratch(false).directory, "absent"));
  const watch = Store.watchChanges(location, () => {});
  watches.push(watch);
  await expect(watch.ready).rejects.toThrow(/Records store watcher exited/);
  expect((await watch.failed).message).toMatch(/ENOENT|no such file/i);
});

test("a path outside the store directory is refused", () => {
  const location = scratch(false);
  for (const path of ["", "/etc/passwd", "../x", "a/../../x", "."])
    expect(() =>
      Store.watchChanges(location, () => {}, { also: [path] }),
    ).toThrow(RangeError);
});
