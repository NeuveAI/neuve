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
      jobSeq: 999999,
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

const { sweepEndedRuns } = await import("../../src/handler.ts");
const realOpen = fs.openSync;
const patch = spyOn(fs, "openSync").mockImplementation(
  (...args: Parameters<typeof fs.openSync>) => {
    if (
      String(args[0]) === join(fs.realpathSync(directory), "authority.sqlite")
    )
      throw Object.assign(new Error("synthetic open I/O"), { code: "EMFILE" });
    return realOpen(...args);
  },
);
const results = [];
try {
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (attempt === 4) {
      const path = join(source, ".capture-authority-failures.json");
      const data = JSON.parse(fs.readFileSync(path, "utf8"));
      data.firstFailureAt = Date.now() - 600_001;
      fs.writeFileSync(path, JSON.stringify(data));
    }
    const swept = await run(sweepEndedRuns(location));
    const next = `next-review-${attempt}`;
    value(
      await run(
        ensureRunFolder(location, {
          runId: next,
          runKey: next,
          pipelineVersion: 1,
          jobSeq: 999999,
          range: {
            baseRef: "main",
            baseOid: "a".repeat(40),
            headOid: "b".repeat(40),
          },
        }),
      ),
    );
    const owner = SourceOwnership.acquire(runFolder(location, next));
    let review;
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
                runId: next,
                runKey: next,
                range: {
                  baseRef: "main",
                  baseOid: "a".repeat(40),
                  headOid: "b".repeat(40),
                },
                cycleId: "synthetic-cycle",
                config: defaultConfig(undefined, SOL_ROUTE),
                log: openRunLog(location, next),
                startedAt: Date.now(),
                reconciliationId: "synthetic",
                records,
              },
              generation: 1,
              ownership: owner,
              claim: {
                jobSeq: 999999,
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
            return opened.host.close("ended", BACKGROUND_CONTEXT);
          });
        }).pipe(Effect.provide(Computations.layer)),
      );

      review = Exit.isSuccess(exit);
    } finally {
      owner.release();
    }
    results.push({
      sweep: Exit.isSuccess(swept),
      source: fs.existsSync(source),
      review,
    });
  }
} finally {
  patch.mockRestore();
}
console.log(JSON.stringify({ results }));
