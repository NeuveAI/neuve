import { scanCaptures } from "./pi/capture/fixture.ts";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openCaptureJournal } from "../src/pi/capture/journal.ts";
import { readCapturedDump } from "../src/pi/capture/export.ts";
// Why: the sweep must retain active resume state and capture native state before removing ended runs.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer, Option } from "effect";
import {
  Blobs,
  JobQueue,
  Store,
  mintUlid,
  storeLocationIn,
} from "@neuve/records-core";
import { runFolderSweep, sweepEndedRuns } from "../src/handler.ts";
import {
  ensureRunFolder,
  runFolderExists,
  piDatabase,
  captureFolder,
} from "../src/run-folder.ts";

const directory = mkdtempSync(join(tmpdir(), "harness-sweep-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

test("the sweep captures native state before removing ended, jobless and 30-day-old run folders", async () => {
  const location = storeLocationIn(directory);
  const range = {
    baseRef: "main",
    baseOid: "b".repeat(40),
    headOid: "a".repeat(40),
  };
  const result = await Effect.runPromise(
    Effect.andThen(
      Store.prepareForWrite,
      Effect.gen(function* () {
        const queue = yield* JobQueue.JobQueue;
        const job = (key: string) =>
          Effect.map(
            queue.enqueue({ kind: "review.run", dedupeKey: key }),
            (enqueued) => enqueued.job.seq,
          );
        const waiting = yield* job("waiting");
        const active = yield* job("active");
        const completed = yield* job("completed");
        const oldWaiting = yield* job("old-waiting");
        // Taken in sequence order (one kind, oldest first): waiting, then active, then completed.
        yield* queue.take(["review.run"]);
        yield* queue.take(["review.run"]);
        const done = Option.getOrThrow(yield* queue.take(["review.run"]));
        yield* queue.complete(done.seq, done.attempts);
        // `waiting` went active with the first take; put it back to waiting as a stop would.
        yield* queue.release(waiting, 1);
        const runs = {
          waiting: mintUlid(),
          active: mintUlid(),
          completed: mintUlid(),
          jobless: mintUlid(),
          // A ULID minted in early 2024: the run's own timestamp ages its folder, not file times.
          old: "01HQ0000000000000000000000",
        };
        const folder = (runId: string, jobSeq: number) =>
          ensureRunFolder(location, {
            runId,
            runKey: `key-${runId}`,
            pipelineVersion: 1,
            range,
            jobSeq,
          });
        yield* folder(runs.waiting, waiting);
        yield* folder(runs.active, active);
        yield* folder(runs.completed, completed);
        yield* folder(runs.jobless, 999);
        yield* folder(runs.old, oldWaiting);
        yield* Effect.promise(async () => {
          await (
            await openNodeSqliteStorage(piDatabase(location, runs.completed))
          ).close(context);
          const journal = openCaptureJournal(
            captureFolder(location, runs.completed),
            runs.completed,
          );
          journal.capture({
            type: "run.start",
            scope: { runId: runs.completed },
            runKind: "reading",
            sourceRevision: "synthetic",
            route: "local",
            pricing: "subscription",
          });
          journal.capture({
            type: "run.end",
            scope: { runId: runs.completed },
            status: "completed",
          });
          journal.close();
        });

        const sweep = runFolderSweep(location);
        const wantedBefore = yield* sweep.wanted;
        const swept = yield* sweepEndedRuns(location);
        const wantedAfter = yield* sweep.wanted;
        yield* scanCaptures(location);
        const capture = yield* readCapturedDump(
          swept.find((run) => run.runId === runs.completed)?.captures[0] ?? "",
        );
        return {
          runs,
          wantedBefore,
          wantedAfter,
          swept,
          capturedRunId: capture.run.runId,
          kept: {
            waiting: yield* runFolderExists(location, runs.waiting),
            active: yield* runFolderExists(location, runs.active),
          },
        };
      }),
    ).pipe(
      Effect.provide(Layer.merge(JobQueue.layer, Blobs.layer(location))),
      Effect.provide(Store.layer(location, { create: true })),
      Effect.provide(BunFileSystem.layer),
    ),
  );
  const reasons = Object.fromEntries(
    result.swept.map((run) => [run.runId, run]),
  );
  expect(result.wantedBefore).toBe(true);
  expect(result.wantedAfter).toBe(false);
  expect(result.kept).toEqual({ waiting: true, active: true });
  expect(Object.keys(reasons).sort()).toEqual(
    [result.runs.completed, result.runs.jobless, result.runs.old].sort(),
  );
  expect(reasons[result.runs.completed]?.reason).toMatch(/is completed/);
  expect(reasons[result.runs.completed]?.captures).toHaveLength(1);
  expect(result.capturedRunId).toBe(result.runs.completed);
  expect(reasons[result.runs.jobless]?.reason).toMatch(/no longer exists/);
  // Past the bound, a folder goes whatever its job's state, without a new capture of old content.
  expect(reasons[result.runs.old]?.reason).toMatch(/older than 30 days/);
  expect(reasons[result.runs.old]?.captures).toEqual([]);
});

// Unknown is not absent. Compatible manifests and unknown job kinds cannot authorize removal.
test("sweep keeps a current-age active review.run@99 and compatible ended manifest, but universal 30-day retention still applies", async () => {
  const { SqlClient } = await import("effect/sql/SqlClient");
  const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
  const { runFolder, deleteRunFolder } = await import("../src/run-folder.ts");
  const location = storeLocationIn(join(directory, "newer"));
  const result = await Effect.runPromise(
    Effect.andThen(
      Store.prepareForWrite,
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql`INSERT INTO jobs(kind,dedupe_key,state) VALUES('review.run@99','newer-active','active')`;
        const [job] = yield* sql<{
          jobSeq: number;
        }>`SELECT job_seq FROM jobs WHERE dedupe_key='newer-active'`;
        const runs = {
          unknown: mintUlid(),
          compatible: mintUlid(),
          both: mintUlid(),
          old: "01HQ0000000000000000000001",
        };
        for (const [kind, runId] of Object.entries(runs)) {
          const folder = runFolder(location, runId);
          mkdirSync(folder, { recursive: true });
          writeFileSync(
            join(folder, "run.json"),
            JSON.stringify({
              runId,
              runKey: runId,
              pipelineVersion: 1,
              jobSeq: kind === "compatible" ? 999 : job!.jobSeq,
              range: {
                baseRef: "main",
                baseOid: "a".repeat(40),
                headOid: "b".repeat(40),
              },
              ...(kind === "unknown" ? {} : { future: true }),
            }),
          );
          writeFileSync(join(folder, "newer-state.json"), "newer work");
        }
        const { abandonSuperseded } = yield* Effect.promise(
          () => import("../src/handler.ts"),
        );
        yield* abandonSuperseded(
          location,
          mintUlid(),
          "a".repeat(40),
          "b".repeat(40),
        );
        expect(
          Object.values(runs).every((id) =>
            existsSync(runFolder(location, id)),
          ),
        ).toBe(true);
        const unknown = yield* deleteRunFolder(location, runs.unknown);
        expect(unknown.removed).toBe(false);
        const direct = yield* deleteRunFolder(location, runs.compatible);
        const swept = yield* sweepEndedRuns(location);
        return {
          direct,
          swept,
          exists: Object.fromEntries(
            Object.entries(runs).map(([kind, id]) => [
              kind,
              existsSync(runFolder(location, id)),
            ]),
          ),
          jobs: yield* sql`SELECT state FROM jobs WHERE job_seq=${job!.jobSeq}`,
        };
      }),
    ).pipe(
      Effect.provide(JobQueue.layer),
      Effect.provide(Blobs.layer(location)),
      Effect.provide(Store.layer(location, { create: true })),
      Effect.provide(BunFileSystem.layer),
    ),
  );
  expect(result.direct.removed).toBe(false);
  expect(result.exists).toEqual({
    unknown: true,
    compatible: true,
    both: true,
    old: false,
  });
  expect(result.swept).toHaveLength(1);
  expect(result.jobs).toEqual([{ state: "active" }]);
});
