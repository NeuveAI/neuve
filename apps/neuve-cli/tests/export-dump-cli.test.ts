import { stopStoreWorker } from "../../../packages/records-core/tests/worker-process.ts";
import { scanCaptures } from "../../../packages/harness/tests/pi/capture/fixture.ts";
import type { SqlClient } from "effect/sql/SqlClient";
// Why (NEU-58): the replay's fresh candidate files each run's session dump for scoring with
// `neuve review export-dump`. If it filed a snapshot the run's final close did not record (a held one
// a later close superseded, an older one behind a malformed or failed latest close, another run's
// behind a stale mapping), or overwrote a dataset folder, a review would be scored on the wrong
// evidence. These run the real command over a real store: a capture stored in Records through the
// capture lane's public API, and run logs written as the worker writes them.
import { afterAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer, Option } from "effect";
import {
  Blobs,
  JobQueue,
  Store,
  resolveStoreLocation,
  storeLocationIn,
  type StoreLocation,
} from "@neuve/records-core";
import { RunLog } from "@neuve/harness";
import {
  CaptureRecords,
  captureRunDump,
  openCaptureJournal,
} from "@neuve/harness/session-dump";

const base = realpathSync(mkdtempSync(join(tmpdir(), "neuve-export-dump-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const CLI = join(import.meta.dir, "..", "src", "cli.ts");

const RUN_A = "01M5V9FNPH0GA6XREDPJR5KWC8";
const RUN_B = "01M5V9FNPH0GA6XREDPJR5KWC9";
const RUN_C = "01M5V9FNPH0GA6XREDPJR5KWCA";

const git = (...args: Array<string>) => {
  const done = Bun.spawnSync(["git", ...args], {
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  if (done.exitCode !== 0) throw new Error(done.stderr.toString());
};

const repo = join(base, "repo");
git("init", "-q", repo);
const location: StoreLocation = await Effect.runPromise(
  resolveStoreLocation(repo),
);

const records = (target: StoreLocation) =>
  Blobs.layer(target).pipe(
    Layer.provideMerge(Store.layer(target, { create: true })),
    Layer.provideMerge(BunFileSystem.layer),
  );
const inStore = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | Blobs.BlobStore
    | SqlClient
    | import("effect/FileSystem").FileSystem
    | import("@neuve/records-core").Computations.ComputationStore
  >,
  target: StoreLocation = location,
) =>
  Effect.runPromise(
    Effect.andThen(Store.prepareForWrite, effect).pipe(
      Effect.provide(records(target)),
    ) as Effect.Effect<A, E, never>,
  );

/** A scored run's capture stored in Records through the public API: journal events, then the dump. */
const stored = async (runId: string, target: StoreLocation = location) => {
  const folder = join(base, "journals", runId);
  const journal = openCaptureJournal(folder, runId);
  const scope = { runId };
  journal.capture({
    type: "run.start",
    scope,
    runKind: "scored",
    sourceRevision: "a".repeat(40),
    route: "openai",
    pricing: "subscription",
  });
  journal.capture({ type: "run.end", scope, status: "completed" });
  journal.close();
  const dump = await inStore(
    captureRunDump({ runId, journal: folder }),
    target,
  );
  await inStore(scanCaptures(target), target);
  const mark = await inStore(CaptureRecords.scanStatus(dump.capture), target);
  if (mark.status !== "clean") throw new Error("synthetic capture scan failed");
  return mark.capture;
};

/** The run log as the worker writes it: per attempt run.admitted, one close record, then the end. */
const runLog = (
  runId: string,
  lines: ReadonlyArray<Record<string, unknown>>,
  target: StoreLocation = location,
) => {
  const log = RunLog.openRunLog(target, runId);
  log.write({ type: "run.started" });
  for (const line of lines) log.write(line as RunLog.RunLogRecord);
};
const admitted = {
  type: "run.admitted",
  taskId: 1,
  admitted: true,
  resume: false,
  claim: "c",
};
const snapshot = (capture: string, mode = "ended") => ({
  type: "run.snapshot",
  mode,
  capture,
  snapshotId: capture,
  complete: true,
  gaps: [],
  execution: mode === "ended" ? "ended" : "open",
  backup: "unavailable",
});
const completed = {
  type: "run.completed",
  outcome: "completed",
  runFolderRemoved: true,
  captures: [],
};

/** The command over a fresh dataset folder, as candidate.sh makes one. */
const exportDumpFrom = (
  repository: string,
  runId: string,
  root: string,
  ...more: Array<string>
) => {
  mkdirSync(root, { recursive: true });
  const done = Bun.spawnSync(
    [
      "bun",
      CLI,
      "review",
      "export-dump",
      "--run",
      runId,
      "--root",
      root,
      "--repo",
      repository,
      ...more,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  return {
    code: done.exitCode,
    stdout: done.stdout.toString(),
    stderr: done.stderr.toString(),
  };
};

const exportDump = (runId: string, root: string, ...more: string[]) =>
  exportDumpFrom(repo, runId, root, ...more);

const captureA = await stored(RUN_A);

test("a run's latest snapshot is filed once, as its close recorded it, never an older one", () => {
  const held = "f".repeat(64);
  runLog(RUN_A, [
    admitted,
    snapshot(held, "held"),
    admitted,
    snapshot(captureA),
    completed,
  ]);
  const root = join(base, "datasets-a");
  const first = exportDump(RUN_A, root);
  expect(first.code).toBe(0);
  const filed = JSON.parse(first.stdout);
  expect({ ...filed, run: undefined }).toEqual({
    directory: join(root, "restricted", "scored", RUN_A, captureA),
    runId: RUN_A,
    snapshotId: captureA,
    redaction: "restricted",
    reused: false,
    run: undefined,
    close: {
      mode: "ended",
      execution: "ended",
      // A run with no findings owes no lead fates (12.41).
      complete: true,
      gaps: [],
    },
  });
  expect(filed.run.runId).toBe(RUN_A);
  expect(readdirSync(filed.directory).sort()).toEqual([
    "export.json",
    "manifest.json",
    "objects",
  ]);
  // Again: the folder is verified and reused, never written over.
  expect(JSON.parse(exportDump(RUN_A, root).stdout).reused).toBe(true);
  // Portable only when asked for.
  const portable = JSON.parse(
    exportDump(RUN_A, root, "--redaction", "portable").stdout,
  );
  expect([portable.directory, portable.redaction]).toEqual([
    join(root, "portable", "scored", RUN_A, captureA),
    "portable",
  ]);
});

test("a held or interrupted latest close is filed with its execution open", async () => {
  const run = "01M5V9FNPH0GA6XREDPJR5KWCG";
  const capture = await stored(run);
  runLog(run, [admitted, snapshot(capture, "held")]);
  const root = join(base, "datasets-held");
  const done = exportDump(run, root);
  expect(done.code).toBe(0);
  const filed = JSON.parse(done.stdout);
  expect([filed.directory, filed.runId, filed.snapshotId]).toEqual([
    join(root, "restricted", "scored", run, capture),
    run,
    capture,
  ]);
  expect(filed.close).toEqual({
    mode: "held",
    execution: "open",
    complete: true,
    gaps: [],
  });
});

test("an attempt admitted after the last close exits 3 and files nothing", () => {
  const unclosed = "01M5V9FNPH0GA6XREDPJR5KWCB";
  runLog(unclosed, [admitted]);
  const newer = "01M5V9FNPH0GA6XREDPJR5KWCC";
  runLog(newer, [admitted, snapshot(captureA, "interrupted"), admitted]);
  const root = join(base, "datasets-pending");
  const one = exportDump(unclosed, root);
  expect(one.code).toBe(3);
  expect(one.stderr).toContain("its attempt has not closed yet");
  const two = exportDump(newer, root);
  expect(two.code).toBe(3);
  expect(two.stderr).toContain(
    "a newer attempt was admitted after its last close and has not closed yet",
  );
  expect(readdirSync(root)).toEqual([]);
});

test("a failed or malformed latest close is refused, never replaced by an older snapshot", () => {
  const failed = "01M5V9FNPH0GA6XREDPJR5KWCD";
  runLog(failed, [
    admitted,
    snapshot(captureA, "held"),
    admitted,
    { type: "run.close-failed", mode: "ended", error: "export failed: ENOSPC" },
    { type: "run.failed", attempt: 2, runFolderRemoved: false, captures: [] },
  ]);
  const malformed = "01M5V9FNPH0GA6XREDPJR5KWCE";
  runLog(malformed, [
    admitted,
    snapshot(captureA),
    admitted,
    { ...snapshot(captureA), capture: "not-a-hash" },
    completed,
  ]);
  const root = join(base, "datasets-refused");
  const one = exportDump(failed, root);
  expect(one.code).toBe(2);
  expect(one.stderr).toContain("its latest close failed: ENOSPC");
  const two = exportDump(malformed, root);
  expect(two.code).toBe(2);
  expect(two.stderr).toContain("its latest run.snapshot is malformed (capture");
  expect(readdirSync(root)).toEqual([]);
});

test("a run log naming another run's capture, or none Records holds, is refused", async () => {
  runLog(RUN_B, [admitted, snapshot(captureA), completed]);
  const root = join(base, "datasets-stale");
  const stale = exportDump(RUN_B, root);
  expect(stale.code).toBe(2);
  expect(stale.stderr).toContain(
    `its run log names capture ${captureA}, which is run ${RUN_A}'s`,
  );
  runLog(RUN_C, [admitted, snapshot("e".repeat(64)), completed]);
  const unknown = exportDump(RUN_C, root);
  expect(unknown.code).toBe(2);
  expect(unknown.stderr).toContain(
    "capture scan has not passed; export refused",
  );
  expect(readdirSync(root)).toEqual([]);
});

test("an outside alias into the Records store is refused before filing any dataset", () => {
  runLog(RUN_A, [admitted, snapshot(captureA), completed]);
  const alias = join(base, "store-alias");
  symlinkSync(location.directory, alias, "dir");
  const nested = join(location.directory, "nested-export");
  mkdirSync(nested);
  const before = readdirSync(location.directory, { recursive: true }).sort();
  for (const root of [alias, join(alias, "nested-export")]) {
    const done = exportDump(RUN_A, root);
    expect(done.code).toBe(2);
    expect(done.stderr).toContain("is inside the store");
    expect(done.stdout).toBe("");
  }
  expect(readdirSync(location.directory, { recursive: true }).sort()).toEqual(
    before,
  );
});

test("an outside dataset alias files the capture at its canonical outside root", () => {
  runLog(RUN_A, [admitted, snapshot(captureA), completed]);
  const root = join(base, "alias-dataset");
  mkdirSync(root);
  const alias = join(base, "dataset-alias");
  symlinkSync(root, alias, "dir");
  const done = exportDump(RUN_A, alias);
  expect(done.code).toBe(0);
  expect(JSON.parse(done.stdout).directory).toBe(
    join(root, "restricted", "scored", RUN_A, captureA),
  );
  expect(
    readdirSync(join(root, "restricted", "scored", RUN_A, captureA)).sort(),
  ).toEqual(["export.json", "manifest.json", "objects"]);
});

test("a pruned capture is refused by name", async () => {
  const run = "01M5V9FNPH0GA6XREDPJR5KWCF";
  const isolatedRepo = join(base, "pruned-repo");
  git("init", "-q", isolatedRepo);
  const target = await Effect.runPromise(resolveStoreLocation(isolatedRepo));
  const capture = await stored(run, target);
  runLog(run, [admitted, snapshot(capture), completed], target);
  await inStore(
    Effect.gen(function* () {
      const blobs = yield* Blobs.BlobStore;
      return yield* blobs.prune({
        cutoff: "2999-01-01T00:00:00.000Z",
        limit: 10_000,
      });
    }),
    target,
  );
  const done = exportDumpFrom(isolatedRepo, run, join(base, "datasets-pruned"));
  expect(done.code).toBe(2);
  expect(done.stderr).toContain("raw capture pruned on");
});

test("its arguments are checked before the store is read", () => {
  const cases: ReadonlyArray<[ReadonlyArray<string>, string]> = [
    [["--root", base], "needs --run <run-id>"],
    [["--run", "not-a-run", "--root", base], "needs --run <run-id>"],
    [["--run", RUN_A], "needs --root <dir>"],
    [
      ["--run", RUN_A, "--root", base, "--redaction", "raw"],
      "--redaction is restricted or portable",
    ],
    [
      ["--run", RUN_A, "--root", join(base, "no-such-folder")],
      "--root must be an existing folder",
    ],
    [["--run", RUN_A, "--root", location.directory], "is inside the store"],
    [["--run", RUN_A, "--root", base, "--force"], "Unknown option '--force'"],
  ];
  for (const [args, why] of cases) {
    const done = Bun.spawnSync(
      ["bun", CLI, "review", "export-dump", ...args, "--repo", repo],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(done.exitCode).toBe(2);
    expect(done.stderr.toString()).toContain(why);
  }
}, 60_000);

test("a marked capture in an explicit coding store exports without a Git repository", async () => {
  const target = storeLocationIn(join(base, "isolated-coding-store"));
  const capture = await stored(RUN_C, target);
  const root = join(base, "coding-export");
  mkdirSync(root);
  const result = Bun.spawnSync([
    process.execPath,
    "--no-env-file",
    CLI,
    "review",
    "export-dump",
    "--capture",
    capture,
    "--store",
    target.directory,
    "--repo",
    join(base, "not-a-repository"),
    "--root",
    root,
  ]);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toMatchObject({
    runId: RUN_C,
    snapshotId: capture,
  });
});

test("send all back reports a pruned capture and continues with the next failed job", async () => {
  const file = async (runId: string) => {
    const journal = openCaptureJournal(join(base, "admin", runId), runId);
    journal.capture({
      type: "run.start",
      scope: { runId },
      runKind: "coding",
      sourceRevision: "synthetic",
      route: "local",
      pricing: "subscription",
    });
    journal.close();
    return inStore(captureRunDump({ runId, journal: journal.directory }));
  };
  const first = await file("admin-pruned");
  const metadata = await inStore(
    Effect.flatMap(Blobs.BlobStore, (blobs) => blobs.inspect(first.capture)),
  );
  await Bun.sleep(5);
  await file("admin-retry");
  const failed = await inStore(
    Effect.gen(function* () {
      const queue = yield* JobQueue.JobQueue;
      const jobs = [];
      for (let i = 0; i < 2; i++) {
        const job = Option.getOrThrow(yield* queue.take(["capture.scan"]));
        jobs.push(job);
        yield* queue.fail(job.seq, job.attempts, {
          tag: "ScanAttemptFailed",
          message: "capture scan failed; retry later",
          final: true,
        });
      }
      const blobs = yield* Blobs.BlobStore;
      yield* blobs.prune({
        cutoff: new Date(
          Date.parse(Option.getOrThrow(metadata).capturedAt) + 1,
        ).toISOString(),
        limit: 1000,
      });
      return jobs;
    }).pipe(Effect.provide(JobQueue.layer)),
  );
  const result = Bun.spawnSync([
    process.execPath,
    "--no-env-file",
    CLI,
    "review",
    "dead-letter",
    "send-back",
    "--all",
    "--store",
    location.directory,
    "--repo",
    join(base, "not-a-repository"),
  ]);
  try {
    expect(result.exitCode).toBe(0);
    const sent = JSON.parse(result.stdout.toString());
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      jobSeq: failed[0]!.seq,
      status: "refused",
    });
    expect(sent[1].seq).toBeGreaterThan(failed[1]!.seq);
    expect(sent[1].eventId).toBe(failed[1]!.eventId);
  } finally {
    await stopStoreWorker(location);
  }
});
