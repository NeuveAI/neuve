// Why: an installed neuve older than a store once paused capture silently: hooks kept spooling and
// every worker they started refused the store, with nothing outside worker.log to say so. These tests
// pin the guards across the processes involved, which no single unit shows: the worker refuses with
// the versions and the fix and leaves a marker; `neuve jobs` prints it; a hook still spools, logs one
// line and holds off a worker that would refuse, then retries; and `records migrate` from a checkout
// warns and marks the store when it leaves the installed copy below the store's minimum writer, the
// one refusal left since 12.24, and never installs. Scratch
// repositories and a scratch HOME only.
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import {
  PROJECTOR_VERSION,
  SCHEMA_VERSION,
  WRITER_VERSION,
  resolveStoreLocation,
} from "@neuve/records-core";
import { runHook } from "../src/capture/hook-cli.ts";
import { installLocalCli } from "../scripts/install-local.ts";
import {
  SKEW_RETRY_MS,
  holdWorkerStart,
  readSkew,
  refusalFrom,
  skewPath,
  writeSkew,
} from "../src/version-skew.ts";

const CLI = resolve(import.meta.dir, "../src/cli.ts");

const directories: Array<string> = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

const scratch = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "neuve-skew-")));
  directories.push(root);
  const repo = join(root, "repo");
  const home = join(root, "home");
  await mkdir(home);
  Bun.spawnSync(["git", "init", "-q", repo]);
  for (const [key, value] of [
    ["user.email", "dev@example.com"],
    ["user.name", "Dev"],
  ])
    Bun.spawnSync(["git", "-C", repo, "config", key!, value!]);
  await writeFile(join(repo, "a"), "a\n");
  Bun.spawnSync(["git", "-C", repo, "add", "a"]);
  Bun.spawnSync(["git", "-C", repo, "commit", "-qm", "init"]);
  const location = await Effect.runPromise(resolveStoreLocation(repo));
  return { root, repo, home, location };
};

/** The scratch HOME, and its install prefix whatever the caller's environment names. */
const scratchEnv = (home: string) => ({
  ...process.env,
  HOME: home,
  NEUVE_INSTALL_PREFIX: join(home, ".local"),
});

const neuve = (home: string, ...args: Array<string>) => {
  const result = Bun.spawnSync([process.execPath, CLI, ...args], {
    env: scratchEnv(home),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};

const setMinWriter = (database: string, value: number) => {
  const db = new Database(database);
  try {
    db.run(
      `UPDATE records_meta SET value = ${value} WHERE key = 'min_writer_version'`,
    );
  } finally {
    db.close();
  }
};

test("an older build's worker refuses with the fix and a marker that jobs and hooks act on", async () => {
  const { root, repo, home, location } = await scratch();
  expect(neuve(home, "records", "migrate", "--repo", repo).code).toBe(0);
  const needs = WRITER_VERSION + 1;
  setMinWriter(location.database, needs);

  const worker = neuve(
    home,
    "worker",
    "run",
    "--repo",
    repo,
    "--idle-seconds",
    "1",
  );
  const sentence = `this neuve checkout (writer ${WRITER_VERSION}) is older than this store (needs ${needs})`;
  expect(worker.code).not.toBe(0);
  expect(worker.stdout).toContain(`refusing to start: ${sentence}`);
  // The CLI capitalizes the sentence it exits with.
  expect(worker.stderr.toLowerCase()).toContain(sentence.toLowerCase());
  const marker = readSkew(location.directory);
  expect(marker).toMatchObject({
    kind: "copy-older",
    by: "worker",
    binary: await realpath(process.execPath),
  });

  // The hook's worker command runs this same bun, so the marker applies to it. Were a worker
  // started, the stand-in would leave a file behind.
  const started = join(root, "worker-started");
  const standIn = join(root, "stand-in.ts");
  await writeFile(
    standIn,
    `await Bun.write(${JSON.stringify(started)}, "started");\n`,
  );
  await writeFile(
    join(location.directory, "capture.json"),
    JSON.stringify({
      version: 1,
      command: [process.execPath, standIn],
      hookCommand: [process.execPath, CLI, "hook"],
      gitHooks: [],
      agents: ["claude-code"],
      sessionTrailer: false,
    }),
  );
  // capture.json starts its worker with the marker's binary, so jobs reports paused capture.
  const jobs = neuve(home, "jobs", "--repo", repo);
  expect(jobs.stderr).toContain("capture is paused since");
  expect(jobs.stderr).toContain(sentence);
  expect(jobs.code).not.toBe(0);

  const hook = () =>
    runHook(
      ["claude-code", "session-start"],
      JSON.stringify({ session_id: "s-1", cwd: repo, source: "startup" }),
    );

  expect(await hook()).toBe(0);
  const spooled = (await readdir(location.spool)).filter((name) =>
    name.endsWith(".json"),
  );
  expect(spooled.length).toBeGreaterThan(0);
  const log = await readFile(join(location.directory, "worker.log"), "utf8");
  const paused = log
    .split("\n")
    .filter((line) => line.includes("WARN    capture paused:"));
  expect(paused).toHaveLength(1);
  expect(paused[0]).toContain(sentence);
  expect(paused[0]).toContain(`${spooled.length} event(s) wait in the spool`);
  await Bun.sleep(500);
  expect(await Bun.file(started).exists()).toBe(false);

  // Past the retry window the hook starts the worker again, which checks the store for itself.
  await writeFile(
    skewPath(location.directory),
    JSON.stringify({
      ...marker,
      at: new Date(Date.now() - 11 * 60_000).toISOString(),
    }),
  );
  expect(await hook()).toBe(0);
  for (let waited = 0; waited < 5000; waited += 100) {
    if (await Bun.file(started).exists()) break;
    await Bun.sleep(100);
  }
  expect(await Bun.file(started).exists()).toBe(true);
}, 60_000);

test("migrate from a checkout warns and marks the store when the installed copy falls behind", async () => {
  const { root, repo, home, location } = await scratch();
  const cli = join(root, "build/neuve");
  const graph = join(root, "build/entire-graph");
  await Bun.write(cli, "cli");
  await Bun.write(graph, "graph");
  const prefix = join(home, ".local");
  // Today's manifests have no version record; reinstalling over one must still work.
  await Bun.write(
    join(prefix, "lib/neuve/install.json"),
    JSON.stringify({
      schemaVersion: 1,
      installedAt: "2026-10-19T18:59:18.227Z",
      cli: { path: join(prefix, "bin/neuve"), sha256: "0".repeat(64) },
      graph: {
        path: join(prefix, "lib/neuve/entire-graph"),
        sha256: "0".repeat(64),
        version: "dev",
        workspaceRevision: null,
      },
    }),
  );
  const manifest = await installLocalCli({
    cli,
    graph,
    prefix,
    graphVersion: "dev",
    graphWorkspaceRevision: null,
    records: { schemaVersion: 0, writerVersion: 0, projectorVersion: 0 },
    source: { commit: "abc1234def", dirty: true },
  });
  expect(manifest.records).toEqual({
    schemaVersion: 0,
    writerVersion: 0,
    projectorVersion: 0,
  });

  const migrate = neuve(home, "records", "migrate", "--repo", repo);
  expect(migrate.code).toBe(0);
  // Migrating never installs and never advises a migrate; an install it names is an integration
  // branch's.
  expect(migrate.stderr).not.toContain("records migrate");
  expect(migrate.stderr).toContain(
    "from a clean checkout of an integration branch that has it",
  );
  expect(migrate.stderr).toContain(
    "this checkout migrated the store past the installed copy: the installed neuve (writer 0) is older than this store (needs",
  );
  expect(readSkew(location.directory)).toMatchObject({
    kind: "copy-older",
    by: "migrate",
    binary: await realpath(join(prefix, "bin/neuve")),
  });

  const check = Bun.spawnSync(
    [process.execPath, resolve(import.meta.dir, "../src/installed-copy.ts")],
    { env: scratchEnv(home), stdout: "pipe", stderr: "pipe" },
  );
  expect(check.exitCode).toBe(0);
  // `check:installed` reads only: git cannot place this copy's commit, so it is left alone.
  expect(check.stderr.toString()).toContain(
    "was built from a commit this checkout does not know; leave it",
  );
  expect(check.stderr.toString()).not.toContain("install:cli");
}, 60_000);

// Why (8.19): a newer build that upgraded the store past this build's schema still admits it, and
// main's own install gives the same schema, so migrate must change nothing and say so, never
// advising a reinstall. The gate's refusals name the build that would help, never this build's own.
test("migrate leaves a store a newer build upgraded, and no refusal advises reinstalling this build", async () => {
  const { repo, home, location } = await scratch();
  expect(neuve(home, "records", "migrate", "--repo", repo).code).toBe(0);
  const db = new Database(location.database);
  const rows = () =>
    JSON.stringify([
      db.query("SELECT * FROM records_meta ORDER BY key").all(),
      db.query("SELECT migration_id FROM records_migrations").all(),
    ]);
  try {
    db.run(
      `INSERT INTO records_migrations (migration_id, name) VALUES (${SCHEMA_VERSION + 1}, 'newer'), (${SCHEMA_VERSION + 2}, 'newest')`,
    );
    const before = rows();
    const migrate = neuve(home, "records", "migrate", "--repo", repo);
    expect(migrate.code).toBe(0);
    expect(migrate.stdout.trim()).toBe(
      `A newer build already upgraded this store (schema ${SCHEMA_VERSION + 2}); this build (schema ${SCHEMA_VERSION}) keeps working with it, so nothing was changed.`,
    );
    expect(migrate.stderr).toBe("");
    expect(rows()).toBe(before);
    expect(readSkew(location.directory)).toBeUndefined();
  } finally {
    db.close();
  }

  const versions = { schemaVersion: 14, projectorVersion: 9 };
  for (const installed of [true, false])
    for (const error of [
      { _tag: "WriterTooOld", writerVersion: 13, minWriterVersion: 16 },
      {
        _tag: "StoreNewer",
        stored: { ...versions, projectorVersion: 10 },
        current: versions,
      },
      {
        _tag: "MigrationRequired",
        stored: { ...versions, schemaVersion: 13 },
        current: versions,
      },
    ]) {
      const message = refusalFrom(error, installed)?.message ?? "";
      expect(message).not.toMatch(/; run `bun run install:cli`$/);
      if (error._tag !== "MigrationRequired")
        expect(message).toContain(
          error._tag === "WriterTooOld"
            ? "a build with writer 16 or newer"
            : "a build with projector 10 or newer",
        );
    }
}, 60_000);

// Why: the hold rests on the marker's time alone. A time that does not parse, or lies in the
// future (a bad clock, a damaged file), must not hold the worker off for good.
test("a hook holds off the worker only while the marker's time is valid and recent", async () => {
  const { location } = await scratch();
  await mkdir(location.directory, { recursive: true });
  const marker = writeSkew(location.directory, {
    refusal: { kind: "copy-older", message: "older" },
    by: "worker",
    binary: process.execPath,
  });
  expect(marker).toBeDefined();
  const log = join(location.directory, "worker.log");
  const holdsAt = async (at: string, now = Date.now()) => {
    await writeFile(
      skewPath(location.directory),
      JSON.stringify({ ...marker, at }),
    );
    return holdWorkerStart(location, [process.execPath], log, now);
  };
  const now = Date.now();
  expect(await holdsAt(new Date(now - 1000).toISOString(), now)).toBe(true);
  expect(await holdsAt("not a time", now)).toBe(false);
  expect(await holdsAt(new Date(now + 60_000).toISOString(), now)).toBe(false);
  expect(await holdsAt(new Date(now - SKEW_RETRY_MS).toISOString(), now)).toBe(
    false,
  );
});
