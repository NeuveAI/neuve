// Why: Apple's SQLite refuses a closed WAL file with no WAL. Capture must use pi's live connection,
// and receipt removal must never reopen the closed file. A dead process must still be swept through
// a writer's open of its surviving WAL. Real pi and SQLite run here; chmod denies any second read.
import { afterAll, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Effect, Option } from "effect";
import { storeLocationIn } from "@neuve/records-core";
import {
  captureFolder,
  ensureRunFolder,
  exportOnClose,
  piDatabase,
  removeRunFolder,
  runFolder,
} from "../../../src/run-folder.ts";
import { SourceOwnership } from "../../../src/pi/source-ownership.ts";
import {
  exportingStorage,
  openNativeStorage,
} from "../../../src/pi/storage.ts";
import { openCaptureJournal } from "../../../src/pi/capture/journal.ts";
import { readRawCapture } from "../../../src/pi/capture/raw.ts";
import { readBackup } from "../../../src/pi/capture/sources.ts";
import { runIn, value } from "./fixture.ts";

const root = mkdtempSync(join(tmpdir(), "capture-own-connection-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const location = storeLocationIn(root);
const run = async <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  value(await runIn(location)(effect));
const prepare = async (runId: string) => {
  await run(
    ensureRunFolder(location, {
      runId,
      runKey: runId,
      pipelineVersion: 1,
      jobSeq: 1,
      range: {
        baseRef: "main",
        baseOid: "a".repeat(40),
        headOid: "b".repeat(40),
      },
    }),
  );
};

const assertCapturedConversation = async (capture: string) => {
  const raw = await run(readRawCapture(capture));
  expect(raw.manifest.lifecycle).toEqual({
    runEnded: true,
    workInFlight: false,
  });
  const bytes = raw.files.get("native/pi.sqlite");
  if (bytes === undefined) throw new Error("native backup missing");
  expect((await readBackup(bytes)).conversations).toHaveLength(1);
};

test("pi closes and removes an ended run while its database is unreadable by any new connection", async () => {
  const runId = "own-connection";
  await prepare(runId);
  const owner = SourceOwnership.acquire(runFolder(location, runId));
  const database = piDatabase(location, runId);
  try {
    const storage = await owner.openNative(database, openNativeStorage);
    const journal = openCaptureJournal(captureFolder(location, runId), runId);
    const hook = exportOnClose({ location, runId, journal });
    const barrier = exportingStorage(storage, {
      mode: () => "ended",
      onClose: (close) => run(hook({ runId, ...close })),
    });
    const harness = await Harness.open(
      barrier.storage,
      {
        models: createModels(),
        registry: createRegistry(),
      },
      context,
    );
    await harness.createConversation(
      { ownership: { kind: "ownerless" } },
      context,
    );
    journal.capture({ type: "run.end", scope: { runId }, status: "completed" });
    chmodSync(database, 0o000);
    expect(() => readFileSync(database)).toThrow();
    await harness.close(context);
    const receipt = await barrier.closed(context);
    // Bun 1.4.3 can defer the physical close until GC. Empty sidecars contain no committed data.
    if (existsSync(database + "-wal"))
      expect(statSync(database + "-wal").size).toBe(0);
    rmSync(database + "-wal", { force: true });
    rmSync(database + "-shm", { force: true });
    expect(() => readFileSync(database)).toThrow();
    expect(
      await run(
        removeRunFolder(location, runId, { ownership: owner, receipt }),
      ),
    ).toMatchObject({
      removed: true,
      captures: [receipt.capture],
    });
    expect(existsSync(database)).toBe(false);
    await assertCapturedConversation(receipt.capture);
    console.info(
      JSON.stringify({
        event: "capture.own-connection",
        runId,
        removed: true,
        conversations: 1,
      }),
    );
  } finally {
    owner.release();
  }
});

test("the ended-run sweep captures a dead process's surviving WAL on its writer connection", async () => {
  const runId = "dead-process";
  await prepare(runId);
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "../../fixtures/capture-own-connection.ts"),
      piDatabase(location, runId),
      captureFolder(location, runId),
      runId,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ code, stderr, signal: child.signalCode }).toEqual({
    code: 137,
    stderr: "",
    signal: "SIGKILL",
  });
  expect(JSON.parse(stdout)).toEqual({
    event: "pi.writer-exited-without-close",
    conversations: 1,
  });
  const database = piDatabase(location, runId);
  expect(statSync(database + "-wal").size).toBeGreaterThan(0);
  const removed = await run(
    removeRunFolder(location, runId, {
      openNative: async (path) => {
        // The sweep is allowed its writer's open. Once open, forbid capture from opening it again.
        const storage = await openNativeStorage(path);
        chmodSync(path, 0o000);
        return storage;
      },
    }),
  );
  expect(removed.removed).toBe(true);
  const receipt = Option.getOrThrow(removed.dump);
  await assertCapturedConversation(receipt.capture);
  expect(existsSync(runFolder(location, runId))).toBe(false);
  console.info(
    JSON.stringify({
      event: "capture.dead-process-sweep",
      runId,
      removed: true,
      conversations: 1,
    }),
  );
});
