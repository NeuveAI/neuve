import { publicCloseReason } from "../../src/pi/capture/close-diagnostic.ts";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect, Exit } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import type { FileSystem } from "effect/FileSystem";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Blobs, Computations, storeLocationIn } from "@neuve/records-core";
import { spyOn } from "bun:test";
import {
  ensureRunFolder,
  runFolder,
  captureFolder,
  piDatabase,
  removeRunFolder,
} from "../../src/run-folder.ts";
import { SourceOwnership } from "../../src/pi/source-ownership.ts";
import { privateInspectionDirectory } from "../../src/pi/capture/safety.ts";
import { PrivateInspection } from "../../src/pi/capture/private-inspection.ts";
import { openCaptureJournal } from "../../src/pi/capture/journal.ts";
import { runIn, value, scanCaptures } from "../pi/capture/fixture.ts";
import { scanStatus } from "../../src/pi/capture/records.ts";
import { readRawManifest } from "../../src/pi/capture/raw.ts";
import { openAttempt } from "../../src/pi/attempt.ts";
import { openRunLog } from "../../src/run-log.ts";
import { defaultConfig } from "../../src/config.ts";
import { SOL_ROUTE } from "../../src/route.ts";

const [root, mode, fault] = process.argv.slice(2);
if (root === undefined || mode === undefined || fault === undefined)
  throw new Error("fixture arguments missing");
const location = storeLocationIn(join(root, "store"));
const run = runIn(location);
const runId = "authority-boundary";
value(
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
  ),
);
const source = runFolder(location, runId);
const directory = privateInspectionDirectory(source, location.directory);
fs.mkdirSync(dirname(directory), { recursive: true, mode: 0o700 });
await (
  await openNodeSqliteStorage(piDatabase(location, runId))
).close(BACKGROUND_CONTEXT);
const journal = openCaptureJournal(captureFolder(location, runId), runId);
journal.capture({
  type: "run.start",
  scope: { runId },
  runKind: "coding",
  sourceRevision: "synthetic",
  route: "local",
  pricing: "subscription",
});
journal.close();
const ownership = SourceOwnership.acquire(source);
const authority = PrivateInspection.create({
  ownership,
  source,
  directory,
  excludedRoots: [source],
});
authority.close();
ownership.release();
if (fault === "empty" || fault === "garbage")
  fs.writeFileSync(
    join(directory, "authority.sqlite"),
    fault === "empty" ? "" : "synthetic garbage".repeat(256),
    { mode: 0o600 },
  );
let closeNumber = 0;
let closeCalls = 0;
const originalOpen = fs.openSync;
const originalExec = Database.prototype.exec;
const patches = [];
if (fault === "EMFILE")
  patches.push(
    spyOn(fs, "openSync").mockImplementation(
      (...args: Parameters<typeof fs.openSync>) => {
        if (
          String(args[0]).includes("/snapshots/") &&
          String(args[0]).endsWith("/authority.sqlite") &&
          (mode !== "reset" || closeNumber !== 3)
        )
          throw Object.assign(
            new Error(
              "PRIVATE-AUTHORITY-PATH /private/synthetic/credential/checkpoint",
            ),
            { code: "EMFILE" },
          );
        return originalOpen(...args);
      },
    ),
  );
if (
  fault === "OPEN_EMFILE" ||
  fault === "OPEN_EIO" ||
  fault.startsWith("COUNT_")
)
  patches.push(
    spyOn(fs, "openSync").mockImplementation(
      (...args: Parameters<typeof fs.openSync>) => {
        if (
          fault.startsWith("COUNT_") &&
          String(args[0]).includes(".capture-authority-failures.json")
        )
          throw Object.assign(new Error("synthetic retry metadata I/O"), {
            code: fault.slice(6),
          });
        if (
          fault.startsWith("COUNT_") &&
          mode === "attempt" &&
          String(args[0]).includes("/snapshots/") &&
          String(args[0]).endsWith("/authority.sqlite")
        )
          throw Object.assign(
            new Error(
              "PRIVATE-AUTHORITY-PATH /private/synthetic/credential/checkpoint",
            ),
            { code: "EMFILE" },
          );
        if (
          (mode !== "attempt" || !fault.startsWith("COUNT_")) &&
          String(args[0]) ===
            join(fs.realpathSync(directory), "authority.sqlite")
        )
          throw Object.assign(
            new Error(
              "PRIVATE-AUTHORITY-PATH /private/synthetic/credential/checkpoint",
            ),
            {
              code: fault.startsWith("COUNT_") ? "EMFILE" : fault.slice(5),
            },
          );
        return originalOpen(...args);
      },
    ),
  );
if (fault.startsWith("COUNT_")) {
  const old = new Date(Date.now() - 2 * 86_400_000);
  fs.utimesSync(source, old, old);
}
if (fault.startsWith("SQLITE_"))
  patches.push(
    spyOn(Database.prototype, "exec").mockImplementation(function (
      this: Database,
      sql: string,
    ) {
      if (
        this.filename.includes("/snapshots/") &&
        sql.startsWith("BEGIN IMMEDIATE")
      )
        throw Object.assign(
          new Error(
            "PRIVATE-AUTHORITY-PATH /private/synthetic/credential/checkpoint",
          ),
          { code: fault },
        );
      return originalExec.call(this, sql);
    }),
  );
if (fault === "DIR_SYNC") {
  const probe = await fsp.open(join(directory, "authority.sqlite"), "r");
  const prototype = Object.getPrototypeOf(probe);
  const original = probe.sync;
  patches.push(
    spyOn(prototype, "sync").mockImplementation(async function (
      this: Awaited<ReturnType<typeof fsp.open>>,
    ) {
      const target = join(location.directory, "capture-authorities");
      if (
        fs.existsSync(target) &&
        fs.fstatSync(this.fd).ino === fs.statSync(target).ino
      )
        throw Object.assign(new Error("synthetic sync I/O"), { code: "EIO" });
      return original.call(this);
    }),
  );
  await probe.close();
}
const outcomes = [];
const publicFailures: string[] = [];
const visibleFailures: string[] = [];
const counters = [];
let capture: string | undefined;
try {
  for (let attempt = 1; attempt <= (mode === "reset" ? 4 : 3); attempt++) {
    closeNumber = attempt;
    let ok = false;
    if (mode === "attempt" || mode === "reset") {
      const owner = SourceOwnership.acquire(source);
      try {
        const exit = await run(
          Effect.gen(function* () {
            const records = yield* Effect.context<
              | SqlClient
              | FileSystem
              | Blobs.BlobStore
              | Computations.ComputationStore
            >();
            return yield* Effect.promise(async () => {
              const opened = await openAttempt({
                ctx: {
                  location,
                  repository: root,
                  runId,
                  runKey: runId,
                  range: {
                    baseRef: "main",
                    baseOid: "a".repeat(40),
                    headOid: "b".repeat(40),
                  },
                  cycleId: "synthetic-cycle",
                  config: defaultConfig(undefined, SOL_ROUTE),
                  log: openRunLog(location, runId),
                  startedAt: Date.now(),
                  reconciliationId: "synthetic",
                  records,
                },
                generation: 1,
                ownership: owner,
                claim: {
                  jobSeq: 1,
                  attempt,
                  claimedAt: new Date().toISOString(),
                },
                integrations: { status: "absent", path: "synthetic" },
                clients: {
                  integrations: { status: "absent", path: "synthetic" },
                  get: () => Effect.die("no integration"),
                },
                runSlot: (effect, signal) =>
                  Effect.runPromise(effect, { signal }),
                fetch: Object.assign(
                  async () => {
                    throw new Error("no network");
                  },
                  { preconnect: () => {} },
                ),
              });
              closeCalls++;
              return opened.host.close("ended", BACKGROUND_CONTEXT);
            });
          }).pipe(Effect.provide(Computations.layer)),
        );
        if (Exit.isFailure(exit)) {
          publicFailures.push(publicCloseReason(exit.cause));
          visibleFailures.push(String(exit.cause));
        }
        ok = Exit.isSuccess(exit);
        if (Exit.isSuccess(exit)) capture = exit.value.capture;
      } finally {
        owner.release();
      }
    } else {
      const exit = await run(removeRunFolder(location, runId));
      if (Exit.isFailure(exit))
        publicFailures.push(publicCloseReason(exit.cause));
      ok = Exit.isSuccess(exit);
      if (Exit.isSuccess(exit)) capture = exit.value.captures[0] ?? capture;
    }
    const count = value(
      await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const [row] = yield* sql<{
            n: number;
          }>`SELECT count(*) AS n FROM events WHERE kind='capture.filed@1'`;
          return row?.n;
        }),
      ),
    );
    outcomes.push({ ok, source: fs.existsSync(source), filed: count });
    const retry = join(source, ".capture-authority-failures.json");
    counters.push(
      fs.existsSync(retry) ? JSON.parse(fs.readFileSync(retry, "utf8")) : null,
    );
    if (mode === "remove" && attempt === 2 && fs.existsSync(retry)) {
      const data = JSON.parse(fs.readFileSync(retry, "utf8"));
      data.firstFailureAt = Date.now() - 600_001;
      fs.writeFileSync(retry, JSON.stringify(data));
    }
  }
} finally {
  for (const patch of patches) patch.mockRestore();
}
let status, unscannable;
if (capture !== undefined) {
  unscannable = value(await run(readRawManifest(capture))).unscannable;
  value(await run(scanCaptures(location)));
  status = value(await run(scanStatus(capture))).status;
}
const checkpoints = join(location.directory, "capture-authorities");
const snapshots = join(dirname(directory), "snapshots");
console.log(
  JSON.stringify({
    outcomes,
    closeCalls,
    publicFailures,
    visibleFailures,
    counters,
    status,
    unscannable,
    leftovers: [checkpoints, snapshots].flatMap((path) =>
      fs.existsSync(path) ? fs.readdirSync(path) : [],
    ),
  }),
);
