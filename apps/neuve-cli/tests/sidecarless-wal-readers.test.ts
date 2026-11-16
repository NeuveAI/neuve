// Why: Apple's SQLite, which Bun loads on macOS, refuses a read-only open of a WAL file with no WAL,
// and Bun's node:sqlite removes the WAL at close, while Linux reads the file as whole and writes the
// sidecars beside it. A reader that only runs on Linux can't show this. So every read path meets a
// real sidecar-less file here, in check:remote's macOS parts, with and without forced collection.
// Each must read it without writing beside it and say so, or refuse and say why.
import { Database } from "bun:sqlite";
import { afterAll, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Exit } from "effect";
import { rearmWaitingReviews } from "../src/review-worker.ts";
import { attributeTree } from "../../../packages/evaluation/src/harness-compare/run-attribution-tree.ts";
import {
  benchChunkSpec,
  VectorStoreReader,
} from "../../../packages/harness/src/e0.ts";
import {
  Computations,
  Store,
  storeLocationIn,
} from "../../../packages/records-core/src/index.ts";
import {
  openStoreReader,
  readAsItStands,
} from "../../../packages/records-core/src/read-only.ts";

const root = mkdtempSync(join(tmpdir(), "sidecarless-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const repoRoot = resolve(import.meta.dir, "../../..");
const NO_LOG = /no WAL beside it/;
const environment = {
  PATH: process.env["PATH"] ?? "/usr/bin:/bin",
  HOME: root,
  TMPDIR: root,
  NEUVE_MODE: "check",
};
const run = async (command: ReadonlyArray<string>, env = environment) => {
  const child = Bun.spawn([...command], {
    env,
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
};

const sidecars = (database: string) =>
  [`${database}-wal`, `${database}-shm`].filter((path) => existsSync(path));

/** A connection's clean close, which is what removes the sidecars on every SQLite here. */
const settle = (path: string) => {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  database.close();
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
  expect(sidecars(path)).toEqual([]);
};

let cases = 0;
const closedStore = async () => {
  const repository = join(root, `repository-${cases++}`);
  mkdirSync(repository);
  const common = join(repository, ".git");
  mkdirSync(common);
  const created = await run([
    process.execPath,
    "--no-env-file",
    join(import.meta.dir, "fixtures/closed-records-store.ts"),
    common,
  ]);
  expect(created.code, created.stderr).toBe(0);
  const location = storeLocationIn(common);
  settle(location.database);
  return { repository, directory: location.directory, location };
};

test("Apple's SQLite still refuses this file, or these tests no longer show anything", async () => {
  const { location } = await closedStore();
  const read = () =>
    new Database(location.database, { readonly: true })
      .query("SELECT count(*) AS n FROM jobs")
      .get();
  const library = new Database(":memory:")
    .query<{ id: string }, []>("SELECT sqlite_source_id() AS id")
    .get()!.id;
  if (process.platform === "darwin") {
    expect(library).toEndWith("aapl");
    expect(read).toThrow("unable to open");
  } else expect(read()).toEqual({ n: 1 });
});

test("re-arming finds the waiting review, writes nothing and says what it read", async () => {
  const { repository, directory, location } = await closedStore();
  const registry = join(root, `registry-${cases++}.json`);
  writeFileSync(
    registry,
    JSON.stringify({
      version: 1,
      repositories: [{ store: directory, repository }],
    }),
  );
  const said: Array<string> = [];
  const armed = await rearmWaitingReviews({
    within: root,
    registry,
    say: (line) => said.push(line),
    keep: async () => undefined,
  });
  expect(armed.map((job) => job.project)).toEqual([repository]);
  expect(said).toHaveLength(1);
  expect(said[0]).toMatch(NO_LOG);
  expect(sidecars(location.database)).toEqual([]);
});

test("re-arming reports a store it can't read instead of skipping it quietly", async () => {
  const { repository, directory, location } = await closedStore();
  writeFileSync(location.database, "not a database, and longer than a header");
  const registry = join(root, `registry-${cases++}.json`);
  writeFileSync(
    registry,
    JSON.stringify({
      version: 1,
      repositories: [{ store: directory, repository }],
    }),
  );
  const said: Array<string> = [];
  expect(
    await rearmWaitingReviews({
      within: root,
      registry,
      say: (line) => said.push(line),
      keep: async () => undefined,
    }),
  ).toEqual([]);
  expect(said.join("\n")).toContain(location.database);
});

test("the E0 vector reader reads a whole vector and writes nothing", () => {
  const common = join(root, `vectors-${cases++}`);
  const location = storeLocationIn(common);
  mkdirSync(location.directory, { recursive: true });
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const spec = benchChunkSpec(hash, "src/file.ts");
  const writer = new DatabaseSync(location.database);
  writer.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE computations (key TEXT PRIMARY KEY, op TEXT, output_hash TEXT); CREATE TABLE blobs (hash TEXT PRIMARY KEY, placement TEXT, content BLOB, pruned_at TEXT)",
  );
  writer
    .prepare("INSERT INTO computations VALUES (?, ?, ?)")
    .run(Computations.computationKey(spec).key, spec.op, hash);
  writer
    .prepare("INSERT INTO blobs VALUES (?, 'inline', ?, NULL)")
    .run(hash, bytes);
  writer.close();
  settle(location.database);
  const reader = new VectorStoreReader(common);
  try {
    expect(reader.withoutLog).toBe(true);
    expect(reader.output(spec)).toEqual(bytes);
    expect(sidecars(location.database)).toEqual([]);
  } finally {
    reader.close();
  }
});

// Why: an immutable connection caches what it read and takes no locks, so without looking again a
// reader that stays open would miss every vector stored after it opened.
test("the E0 vector reader sees what a writer stores after it opened", () => {
  const common = join(root, `vectors-${cases++}`);
  const location = storeLocationIn(common);
  mkdirSync(location.directory, { recursive: true });
  const writer = new DatabaseSync(location.database);
  writer.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE computations (key TEXT PRIMARY KEY, op TEXT, output_hash TEXT); CREATE TABLE blobs (hash TEXT PRIMARY KEY, placement TEXT, content BLOB, pruned_at TEXT)",
  );
  writer.close();
  settle(location.database);
  const reader = new VectorStoreReader(common);
  try {
    const bytes = new Uint8Array([5, 6, 7, 8]);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const spec = benchChunkSpec(hash, "src/later.ts");
    expect(reader.withoutLog).toBe(true);
    expect(reader.output(spec)).toBeUndefined();
    const later = new DatabaseSync(location.database);
    later
      .prepare("INSERT INTO computations VALUES (?, ?, ?)")
      .run(Computations.computationKey(spec).key, spec.op, hash);
    later
      .prepare("INSERT INTO blobs VALUES (?, 'inline', ?, NULL)")
      .run(hash, bytes);
    expect(reader.output(spec)).toEqual(bytes);
    later.exec("SELECT 1");
    later.close();
    expect(reader.output(spec)).toEqual(bytes);
  } finally {
    reader.close();
  }
});

test("the attribution tree reads its store, writes nothing and says what it read", async () => {
  const { location } = await closedStore();
  const said = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const at = "2026-11-07T00:00:00.000Z";
    attributeTree(
      [
        { type: "run.started", runId: "none", at },
        { type: "run.completed", runId: "none", at },
      ],
      { store: location.database },
    );
    expect(said.mock.calls.flat().join("\n")).toMatch(NO_LOG);
  } finally {
    said.mockRestore();
  }
  expect(sidecars(location.database)).toEqual([]);
});

test("the proof export reads a copied store, writes nothing and says what it read", async () => {
  const { directory, location } = await closedStore();
  const commits = join(root, `commits-${cases}`);
  const out = join(root, `proofs-${cases}.json`);
  writeFileSync(commits, "");
  const exported = await run([
    process.execPath,
    "--no-env-file",
    "packages/evaluation/src/harness-compare/harness-side.ts",
    "export-proofs",
    "--commits",
    commits,
    "--source-store",
    directory,
    "--out",
    out,
  ]);
  expect(exported.code, exported.stderr).toBe(0);
  expect(exported.stderr).toMatch(NO_LOG);
  expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({
    events: [],
    blobs: [],
  });
  expect(sidecars(location.database)).toEqual([]);
});

test("the shared export reads a store, leaves its bytes alone and says what it read", async () => {
  const { repository, location } = await closedStore();
  const initialized = await run(["git", "init", "-q", repository]);
  expect(initialized.code, initialized.stderr).toBe(0);
  const before = readFileSync(location.database);
  const out = join(root, `shared-${cases++}.json`);
  const exported = await run([
    process.execPath,
    "--no-env-file",
    "packages/evaluation/src/harness-compare/harness-side.ts",
    "export",
    "--ops",
    "scope-only",
    "--from",
    repository,
    "--out",
    out,
  ]);
  expect(exported.code, exported.stderr).toBe(0);
  expect(exported.stderr).toMatch(NO_LOG);
  expect(readFileSync(out, "utf8")).toContain(
    Buffer.from("SHARED-OUTPUT").toString("base64"),
  );
  expect(sidecars(location.database)).toEqual([]);
  expect(readFileSync(location.database).equals(before)).toBe(true);
});

test("a reader that must see every commit is refused, with the reason", async () => {
  const { location } = await closedStore();
  expect(() => openStoreReader(location.database)).toThrow(NO_LOG);
  expect(sidecars(location.database)).toEqual([]);
});

test("a read as it stands refuses when a writer arrived during it", async () => {
  const { location } = await closedStore();
  expect(() =>
    readAsItStands(location.database, () => {
      const writer = new DatabaseSync(location.database);
      writer.exec("BEGIN IMMEDIATE; DELETE FROM jobs; COMMIT");
      writer.close();
      rmSync(`${location.database}-shm`, { force: true });
    }),
  ).toThrow("changed while it was read");
});

test("a store in a location that can't hold a WAL is refused with the reason, not SQLite's", async () => {
  const { directory, location } = await closedStore();
  chmodSync(directory, 0o500);
  try {
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.andThen(
          Store.layer(location, { create: false }).pipe((layer) =>
            Effect.provide(Effect.void, layer),
          ),
          Effect.void,
        ),
      ).pipe(Effect.provide(BunFileSystem.layer)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toMatch(NO_LOG);
  } finally {
    chmodSync(directory, 0o700);
  }
  expect(readdirSync(directory)).not.toContain("records.sqlite-wal");
});

test("a writer's open accepts the file as it stands, which is what the refusal offers", async () => {
  const { location } = await closedStore();
  const reopened = await Effect.runPromiseExit(
    Effect.provide(
      Store.prepareForWrite,
      Store.layer(location, { create: false }),
    ).pipe(Effect.provide(BunFileSystem.layer)),
  );
  expect(Exit.isSuccess(reopened)).toBe(true);
});
