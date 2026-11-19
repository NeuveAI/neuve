// Why: an actual retry deleted a live producer's SQLite source. Exercise the native and disposal
// boundaries, including process death and the stable lock inode outside a recreated run folder.
import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  linkSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Effect, FileSystem } from "effect";
import { storeLocationIn } from "@neuve/records-core";
import { openReviewHost } from "../src/pi/host.ts";
import { SourceOwned, SourceOwnership } from "../src/pi/source-ownership.ts";
import { deleteRunFolder, runFolder } from "../src/run-folder.ts";

const root = mkdtempSync(join(tmpdir(), "pi-source-ownership-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const fixture = join(import.meta.dir, "fixtures/pi-source-owner.ts");
const contender = (source: string) => {
  const child = Bun.spawnSync([process.execPath, fixture, source]);
  expect(child.exitCode).toBe(0);
  return child.stdout.toString().trim();
};

const open = async (
  source: string,
  precompute: () => Promise<void>,
  failExport = false,
) => {
  const ownership = SourceOwnership.acquire(source);
  mkdirSync(source, { recursive: true });
  const unused = async (): Promise<never> => {
    throw new Error("unused");
  };
  try {
    const host = await openReviewHost(
      {
        ownership,
        storage: await openNodeSqliteStorage(join(source, "pi.sqlite")),
        models: createModels(),
        registry: createRegistry(),
        slots: { acquire: async () => () => {} },
        createRouteProvider: () => {
          throw new Error("no network");
        },
        claim: { jobSeq: 1, attempt: 1, claimedAt: "test" },
        run: {
          runId: "test",
          runKey: "key",
          generation: 1,
          cycleId: "cycle",
          range: {
            baseRef: "main",
            baseOid: "a".repeat(40),
            headOid: "b".repeat(40),
          },
          config: {} as never,
          cutoffAt: Date.now() + 60_000,
        },
        stages: () => ({
          extension: defineExtension({ name: "ownership-test" }),
          port: {
            precompute: async () => {
              await precompute();
              return {
                record: {
                  stage: "precompute" as const,
                  status: "computed" as const,
                  wallMs: 0,
                },
              };
            },
            front: unused,
            finder: unused,
            fill: unused,
            link: unused,
            publish: unused,
          },
        }),
        onClose: async ({ reads }) => {
          await reads.scanTasks({}, 100, undefined, context);
          if (failExport) throw new Error("export failed");
          return "closed";
        },
      },
      context,
    );
    return { host, ownership };
  } catch (error) {
    ownership.release();
    throw error;
  }
};

test("pending cleanup retains native ownership after caller release and guards public deletion", async () => {
  const location = storeLocationIn(join(root, "pending"));
  const source = runFolder(location, "one");
  let release = () => {};
  let started = () => {};
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { host, ownership } = await open(source, async () => {
    started();
    await gate;
  });
  await running;
  // The work is held until the gate opens below: a cleanup that waited for it would never return.
  expect(
    await host.cleanup(
      { mode: "interrupted", stop: false, withinMs: 30 },
      context,
    ),
  ).toMatchObject({ kind: "pending", phase: "closing" });
  ownership.release();
  try {
    expect(() => SourceOwnership.acquire(source)).toThrow(SourceOwned);
    expect(contender(source)).toBe("SourceOwned");
    const deleted = await Effect.runPromise(
      Effect.exit(deleteRunFolder(location, "one")).pipe(
        Effect.provide(BunFileSystem.layer),
      ),
    );
    expect(deleted._tag).toBe("Failure");
    expect(existsSync(join(source, "pi.sqlite"))).toBe(true);
    const parallel = await open(runFolder(location, "two"), async () => {});
    await parallel.host.ended(context);
    await parallel.host.close("ended", context);
    parallel.ownership.release();
  } finally {
    release();
    await host.close("interrupted", context);
  }
  expect(contender(source)).toBe("acquired");
});

test("close retains the caller's disposal authority through deletion and recreation", async () => {
  const location = storeLocationIn(join(root, "recreated"));
  const source = runFolder(location, "one");
  const { host, ownership } = await open(source, async () => {});
  await host.ended(context);
  await host.close("ended", context);
  expect(contender(source)).toBe("SourceOwned");
  await Effect.runPromise(
    deleteRunFolder(location, "one", ownership).pipe(
      Effect.provide(BunFileSystem.layer),
    ),
  );
  mkdirSync(source, { recursive: true });
  expect(contender(source)).toBe("SourceOwned");
  ownership.release();
  expect(contender(source)).toBe("acquired");
});

test("failed export with a closed raw database releases ownership after caller disposal", async () => {
  const source = join(root, "failed", "runs", "one");
  const { host, ownership } = await open(source, async () => {}, true);
  await host.ended(context);
  await expect(host.close("ended", context)).rejects.toThrow("export failed");
  ownership.release();
  expect(contender(source)).toBe("acquired");
});

test("process death releases native ownership and preserves SQLite for recovery", async () => {
  const source = join(root, "death", "runs", "one");
  const child = Bun.spawn([process.execPath, fixture, source, "native"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const reader = child.stdout.getReader();
    const started = await reader.read();
    expect(new TextDecoder().decode(started.value)).toContain("native-started");
    expect(contender(source)).toBe("SourceOwned");
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }
  expect(existsSync(join(source, "pi.sqlite"))).toBe(true);
  const recovered = await open(source, async () => {});
  await recovered.host.ended(context);
  await recovered.host.close("ended", context);
  recovered.ownership.release();
  expect(contender(source)).toBe("acquired");
});

test("canonical folder aliases contend and database file aliases refuse admission", () => {
  const source = join(root, "alias", "runs", "one");
  mkdirSync(source, { recursive: true });
  const alias = join(root, "alias-link");
  symlinkSync(join(root, "alias"), alias);
  const owner = SourceOwnership.acquire(source);
  try {
    expect(() => SourceOwnership.acquire(join(alias, "runs", "one"))).toThrow(
      SourceOwned,
    );
    expect(contender(join(alias, "runs", "one"))).toBe("SourceOwned");
  } finally {
    owner.release();
  }
  const native = join(root, "aliased-native.sqlite");
  writeFileSync(native, "sentinel");
  symlinkSync(native, join(source, "pi.sqlite"));
  expect(() => SourceOwnership.acquire(source)).toThrow("database aliases");
  rmSync(join(source, "pi.sqlite"));
  linkSync(native, join(source, "pi.sqlite"));
  expect(() => SourceOwnership.acquire(source)).toThrow("database aliases");
});

for (const { name, first, second } of [
  { name: "case", first: "ONE", second: "one" },
  { name: "normalization", first: "caf\u00e9", second: "cafe\u0301" },
]) {
  test(`${name} equality follows the volume before creation and through recreation`, () => {
    const base = join(root, name);
    mkdirSync(join(base, first), { recursive: true });
    const equivalent = existsSync(join(base, second));
    rmSync(join(base, first), { recursive: true });
    const source = join(base, "RUNS", first);
    const alias = join(base, "runs", second);
    const owner = SourceOwnership.acquire(source);
    try {
      expect(existsSync(source)).toBe(false);
      for (const state of ["absent", "existing", "recreated"]) {
        if (state !== "absent") {
          rmSync(source, { recursive: true, force: true });
          mkdirSync(source, { recursive: true });
        }
        if (equivalent) {
          expect(() => owner.assertDisposable(alias)).not.toThrow();
          expect(() => SourceOwnership.acquire(alias)).toThrow(SourceOwned);
          expect(contender(alias)).toBe("SourceOwned");
          if (state !== "absent")
            expect(statSync(source).ino).toBe(statSync(alias).ino);
        } else {
          const distinct = SourceOwnership.acquire(alias);
          try {
            expect(() => owner.assertDisposable(alias)).toThrow(SourceOwned);
            expect(() => distinct.assertDisposable(alias)).not.toThrow();
          } finally {
            distinct.release();
          }
        }
      }
    } finally {
      owner.release();
    }
    expect(contender(alias)).toBe("acquired");
  });
}

test("missing parent aliases contend while distinct parent folders and SQLite-like names remain parallel", () => {
  const base = join(root, "parent-alias");
  mkdirSync(base, { recursive: true });
  const alias = join(root, "parent-link");
  symlinkSync(base, alias);
  const source = join(base, "runs", "one");
  const owner = SourceOwnership.acquire(source);
  const others: SourceOwnership[] = [];
  try {
    expect(() => SourceOwnership.acquire(join(alias, "runs", "one"))).toThrow(
      SourceOwned,
    );
    expect(() =>
      owner.assertDisposable(join(alias, "runs", "one")),
    ).not.toThrow();
    expect(contender(join(alias, "runs", "one"))).toBe("SourceOwned");
    for (const path of [
      join(base, "other-runs", "one"),
      join(base, "runs", "one.sqlite"),
      join(base, "runs", "one.sqlite-journal"),
      join(base, "runs", "one.sqlite-wal"),
      join(base, "runs", "one.sqlite-shm"),
      join(base, "runs", "x".repeat(255)),
    ]) {
      const distinct = SourceOwnership.acquire(path);
      others.push(distinct);
      expect(() => distinct.assertDisposable(path)).not.toThrow();
    }
  } finally {
    for (const distinct of others) distinct.release();
    owner.release();
  }
});

test("a deletion admitted under a missing case alias cannot admit a live producer", async () => {
  const location = storeLocationIn(join(root, "delete-alias"));
  const source = runFolder(location, "one");
  const alias = runFolder(location, "ONE");
  mkdirSync(source, { recursive: true });
  const equivalent = existsSync(alias);
  rmSync(source, { recursive: true });
  if (!equivalent) return;
  let entered = () => {};
  let resume = () => {};
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const deleting = Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* deleteRunFolder(location, "ONE").pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          exists: (path) =>
            path === alias
              ? Effect.promise(async () => {
                  entered();
                  await gate;
                  return existsSync(path);
                })
              : fs.exists(path),
        }),
      );
    }).pipe(Effect.provide(BunFileSystem.layer)),
  );
  await waiting;
  try {
    expect(() => SourceOwnership.acquire(source)).toThrow(SourceOwned);
    expect(contender(source)).toBe("SourceOwned");
  } finally {
    resume();
  }
  expect(await deleting).toEqual({ removed: false });
  let release = () => {};
  let started = () => {};
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const producer = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { host, ownership } = await open(source, async () => {
    started();
    await producer;
  });
  await running;
  try {
    expect(statSync(source).ino).toBe(statSync(alias).ino);
    const deleted = await Effect.runPromise(
      Effect.exit(deleteRunFolder(location, "ONE")).pipe(
        Effect.provide(BunFileSystem.layer),
      ),
    );
    expect(deleted._tag).toBe("Failure");
    expect(existsSync(join(source, "pi.sqlite"))).toBe(true);
    expect(contender(alias)).toBe("SourceOwned");
  } finally {
    release();
    await host.close("interrupted", context);
  }
  expect(
    await Effect.runPromise(
      deleteRunFolder(location, "ONE", ownership).pipe(
        Effect.provide(BunFileSystem.layer),
      ),
    ),
  ).toEqual({ removed: true });
  ownership.release();
  expect(contender(source)).toBe("acquired");
});
