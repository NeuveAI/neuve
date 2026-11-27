import { scanCaptures } from "./pi/capture/fixture.ts";
// Why: removal must verify the ended capture and journal, and retain held, open or uncertain state.
import { afterAll, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  unlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Cause, Effect, Exit, FileSystem, Layer, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Blobs, Store, storeLocationIn } from "@neuve/records-core";
import {
  captureFolder,
  captureNativeRun,
  ensureRunFolder,
  piDatabase,
  removeRunFolder,
  runFolder,
} from "../src/run-folder.ts";
import {
  OBJECTS_DIRECTORY,
  openCaptureJournal,
  sha256Of,
} from "../src/pi/capture/journal.ts";
import { readCapturedDump } from "../src/pi/capture/export.ts";
import { SourceOwned, SourceOwnership } from "../src/pi/source-ownership.ts";

const directory = mkdtempSync(join(tmpdir(), "harness-run-folder-close-"));
afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

const location = storeLocationIn(directory);
const layer = Blobs.layer(location).pipe(
  Layer.provideMerge(Store.layer(location, { create: true })),
  Layer.provideMerge(BunFileSystem.layer),
);
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(
    Effect.andThen(Store.prepareForWrite, effect).pipe(
      Effect.provide(layer),
    ) as Effect.Effect<A, unknown, never>,
  );

const endedNative = async (
  runId: string,
  native = true,
  instructions?: string,
) => {
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
  const database = piDatabase(location, runId);
  if (native) await (await openNodeSqliteStorage(database)).close(context);
  const journal = openCaptureJournal(captureFolder(location, runId), runId);
  journal.capture({
    type: "run.start",
    scope: { runId },
    runKind: "reading",
    sourceRevision: "synthetic",
    route: "local",
    pricing: "subscription",
  });
  if (instructions !== undefined) {
    const scope = { runId };
    journal.capture({
      type: "model.request",
      scope,
      callId: "local",
      route: "local",
      provider: "local",
      model: "local",
      headerNames: [],
      credentialCoverage: "none",
      body: { status: "sent", json: { instructions } },
    });
    journal.capture({
      type: "model.end",
      scope,
      callId: "local",
      outcome: "failed",
    });
  }
  journal.capture({ type: "run.end", scope: { runId }, status: "completed" });
  journal.close();
  const receipt = Option.getOrThrow(
    await run(captureNativeRun(location, runId)),
  );
  await run(scanCaptures(location));
  expect((await run(readCapturedDump(receipt.capture))).sessions).toHaveLength(
    0,
  );
  return { database, receipt };
};

/**
 * The bytes that hold data. An empty WAL and its index hold none, and a connection waiting for
 * collection drops them whenever it goes.
 */
const nativeBytes = (database: string) => {
  const read = (suffix: string) => {
    try {
      return readFileSync(database + suffix);
    } catch {
      return null;
    }
  };
  const hash = (bytes: Buffer | null) =>
    bytes === null ? null : sha256Of(bytes);
  const wal = read("-wal");
  const hasFrames = wal !== null && wal.byteLength > 0;
  return {
    "": hash(read("")),
    "-wal": hasFrames ? hash(wal) : null,
    "-shm": hasFrames ? hash(read("-shm")) : null,
    "-journal": hash(read("-journal")),
  };
};

const refuseStale = async ({
  database,
  receipt,
}: Awaited<ReturnType<typeof endedNative>>) => {
  const before = nativeBytes(database);
  const journal = readFileSync(
    join(captureFolder(location, receipt.runId), "events.jsonl"),
  );
  const exit = await run(
    Effect.exit(
      removeRunFolder(location, receipt.runId, {
        receipt,
        openNative: async () => {
          throw new Error(
            "receipt verification opened writable native storage",
          );
        },
      }),
    ),
  );
  expect(
    Exit.isFailure(exit) ? Cause.squash(exit.cause) : "removed",
  ).toMatchObject({ _tag: "ReceiptMismatch" });
  expect(nativeBytes(database)).toEqual(before);
  expect(
    readFileSync(join(captureFolder(location, receipt.runId), "events.jsonl")),
  ).toEqual(journal);
  expect(existsSync(runFolder(location, receipt.runId))).toBe(true);
  await run(scanCaptures(location));
  expect((await run(readCapturedDump(receipt.capture))).sessions).toHaveLength(
    0,
  );
};

test("a missing native source refuses the receipt", async () => {
  const fixture = await endedNative("RECEIPT-MISSING");
  unlinkSync(fixture.database);
  await refuseStale(fixture);
});

test("a missing journal object invalidates an otherwise unchanged close receipt", async () => {
  const instructions = "Evidence kept in the closed journal object.";
  const fixture = await endedNative("RECEIPT-OBJECT", true, instructions);
  const sha256 = sha256Of(Buffer.from(JSON.stringify(instructions)));
  const protectedObjects = await run(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      return yield* sql<{
        part: string;
      }>`SELECT part_hash AS part FROM raw_capture_parts WHERE capture_hash = ${fixture.receipt.capture}`;
    }),
  );
  expect(protectedObjects).toContainEqual({ part: sha256 });
  unlinkSync(
    join(
      captureFolder(location, fixture.receipt.runId),
      OBJECTS_DIRECTORY,
      sha256,
    ),
  );
  await refuseStale(fixture);
  const dump = await run(readCapturedDump(fixture.receipt.capture));
  expect(dump.unjoined[0]?.body).toEqual({
    status: "sent",
    json: { instructions },
  });
});

// Receipt removal now trusts the stopped writer's capture and never opens its closed database.
test("an unreadable source can be removed by its ended receipt", async () => {
  const fixture = await endedNative("RECEIPT-UNREADABLE");
  chmodSync(fixture.database, 0o000);
  expect(
    await run(
      removeRunFolder(location, fixture.receipt.runId, {
        receipt: fixture.receipt,
      }),
    ),
  ).toMatchObject({ removed: true });
});

test("an unchanged ended receipt removes the source without opening it", async () => {
  const { database, receipt } = await endedNative("RECEIPT-UNCHANGED");
  expect(
    await run(
      removeRunFolder(location, receipt.runId, {
        receipt,
        openNative: async () => {
          throw new Error("writable native open");
        },
      }),
    ),
  ).toMatchObject({ removed: true, captures: [receipt.capture] });
  expect(existsSync(database)).toBe(false);
});

for (const suffix of ["-wal", "-shm", "-journal"]) {
  test(`an absent native source with an unobserved ${suffix} sidecar is retained`, async () => {
    const fixture = await endedNative(`RECEIPT-ABSENT${suffix}`, false);
    writeFileSync(fixture.database + suffix, "uncaptured sidecar");
    await refuseStale(fixture);
  });
}

test("receipt removal keeps source ownership through verification and deletion", async () => {
  const fixture = await endedNative("RECEIPT-LEASE");
  const folder = runFolder(location, fixture.receipt.runId);
  let entered = () => {};
  let resume = () => {};
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const deleting = run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* removeRunFolder(location, fixture.receipt.runId, {
        receipt: fixture.receipt,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          exists: (path) =>
            path === folder
              ? Effect.promise(async () => {
                  entered();
                  await gate;
                  return existsSync(path);
                })
              : fs.exists(path),
        }),
      );
    }),
  );
  await waiting;
  try {
    expect(() => SourceOwnership.acquire(folder)).toThrow(SourceOwned);
  } finally {
    resume();
  }
  expect(await deleting).toMatchObject({ removed: true });
});

test("a live owner refuses receipt removal and an unchanged journal cannot bypass it", async () => {
  const fixture = await endedNative("RECEIPT-LIVE");
  const owner = SourceOwnership.acquire(
    runFolder(location, fixture.receipt.runId),
  );
  const release = owner.retainNative({});
  const before = nativeBytes(fixture.database);
  try {
    const exit = await run(
      Effect.exit(
        removeRunFolder(location, fixture.receipt.runId, {
          receipt: fixture.receipt,
          ownership: owner,
        }),
      ),
    );
    expect(
      Exit.isFailure(exit) ? Cause.squash(exit.cause) : "removed",
    ).toMatchObject({ _tag: "SourceOwned" });
    expect(nativeBytes(fixture.database)).toEqual(before);
  } finally {
    release();
    owner.release();
  }
});

test("a changed journal refuses an otherwise unchanged native receipt", async () => {
  const fixture = await endedNative("RECEIPT-JOURNAL");
  const journal = openCaptureJournal(
    captureFolder(location, fixture.receipt.runId),
    fixture.receipt.runId,
  );
  journal.close();
  await refuseStale(fixture);
});

test("an unchanged committed WAL image can be removed by the receipt that captured it", async () => {
  const fixture = await endedNative("RECEIPT-CAPTURED-WAL");
  const database = new DatabaseSync(fixture.database);
  try {
    database.exec(
      "PRAGMA wal_autocheckpoint=0; CREATE TABLE captured_wal(value TEXT); INSERT INTO captured_wal VALUES ('captured')",
    );
    expect(existsSync(`${fixture.database}-wal`)).toBe(true);
    const receipt = Option.getOrThrow(
      await run(captureNativeRun(location, fixture.receipt.runId)),
    );
    expect(
      await run(removeRunFolder(location, receipt.runId, { receipt })),
    ).toMatchObject({ removed: true });
  } finally {
    database.close();
  }
});

/** What a finished close leaves on every Bun: a connection waiting for collection has only an empty WAL to drop. */
const finishClose = (database: string) => {
  if (existsSync(`${database}-wal`))
    expect(statSync(`${database}-wal`).size).toBe(0);
  rmSync(`${database}-wal`, { force: true });
  rmSync(`${database}-shm`, { force: true });
};

test("a clean close that deleted the WAL is removed by the receipt that captured it", async () => {
  const { database, receipt } = await endedNative("RECEIPT-CLEAN-CLOSE");
  finishClose(database);
  expect(readFileSync(database)[18]).toBe(2);
  expect(
    await run(
      removeRunFolder(location, receipt.runId, {
        receipt,
        openNative: async () => {
          throw new Error("writable native open");
        },
      }),
    ),
  ).toMatchObject({ removed: true, captures: [receipt.capture] });
  expect(existsSync(database)).toBe(false);
});

test("an ended receipt with no native source can remove the folder, then removal is idempotent", async () => {
  const { receipt } = await endedNative("RECEIPT-ABSENT-UNCHANGED", false);
  expect(
    await run(removeRunFolder(location, receipt.runId, { receipt })),
  ).toMatchObject({ removed: true });
  expect(await run(removeRunFolder(location, receipt.runId))).toMatchObject({
    removed: false,
  });
});

test("an unmarked legacy receipt verifies and removes its source without refiling", async () => {
  const { database, receipt } = await endedNative("legacy-receipt");
  finishClose(database);
  const held = await run(readCapturedDump(receipt.capture));
  const { scan, ...legacy } = held.manifest;
  const { encodeManifest } = await import("../src/pi/capture/archive.ts");
  const { DUMP_MEDIA_TYPE } = await import("../src/pi/capture/export.ts");
  const { Log } = await import("@neuve/records-core");
  const stored = await run(
    Effect.flatMap(Blobs.BlobStore, (blobs) =>
      blobs.put({
        bytes: encodeManifest(legacy),
        mediaType: DUMP_MEDIA_TYPE,
        retention: "raw-capture",
      }),
    ),
  );
  const { pendingScan, ...oldReceipt } = receipt;
  const before = (await run(Log.history({}))).length;
  chmodSync(database, 0o000);
  const removed = await run(
    removeRunFolder(location, receipt.runId, {
      receipt: {
        ...oldReceipt,
        capture: stored.blob.hash,
        snapshotId: stored.blob.hash,
      },
      openNative: async () => {
        throw new Error("must not refile");
      },
    }),
  );
  expect(removed.removed).toBe(true);
  expect((await run(Log.history({}))).length).toBe(before);
});
