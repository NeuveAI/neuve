// Migration copies survive old metadata; only expired raw bytes inside the copy justify removal.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Layer, Logger } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { SqlClient } from "effect/sql/SqlClient";
import {
  Blobs,
  Computations,
  JobQueue,
  Retention,
  Store,
  Worker,
} from "../src/index.ts";
import {
  freshLocation,
  removeTemporaryDirectories,
  runExisting,
  runOn,
} from "./support.ts";
afterAll(removeTemporaryDirectories);

for (const shape of ["tombstone", "file", "inline"] as const)
  test(`a real migration backup retains ${shape} metadata unless it holds expired bytes`, async () => {
    const location = freshLocation();
    await runOn(
      location,
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.UTC(2000, 0, 1));
        const blobs = yield* Blobs.BlobStore;
        yield* blobs.put({
          bytes: new TextEncoder().encode(
            "synthetic migration capture".padEnd(
              shape === "file" ? Blobs.INLINE_MAX_BYTES + 1 : 30,
              ".",
            ),
          ),
          mediaType: "text/plain",
          retention: "raw-capture",
        });
        if (shape === "tombstone")
          expect(
            yield* blobs.prune({
              cutoff: "2001-01-01T00:00:00.000Z",
              limit: 10,
            }),
          ).toHaveLength(1);
      }).pipe(
        Effect.provide(Layer.merge(Blobs.layer(location), TestClock.layer())),
      ),
    );
    // The same schema-14 state used by the compatibility tests forces the real migration backup.
    await runExisting(
      location,
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql.unsafe("DROP TABLE projection_review_origins");
        yield* sql.unsafe(
          "DELETE FROM records_migrations WHERE migration_id >= 15",
        );
        yield* sql.unsafe(
          "DELETE FROM records_meta WHERE key = 'projections_version'",
        );
        yield* sql.unsafe(
          "UPDATE records_meta SET value=9 WHERE key='projector_version'",
        );
        yield* sql.unsafe(
          "UPDATE records_meta SET value=13 WHERE key='min_writer_version'",
        );
      }),
    );
    await runExisting(location, Store.prepareForRead);
    const directory = Store.backupDirectory(location.database);
    const copies = readdirSync(directory);
    expect(copies).toHaveLength(1);
    const backup = join(directory, copies[0]!);
    await runOn(
      location,
      Effect.gen(function* () {
        if (shape === "tombstone")
          expect((yield* Retention.wantedPrune)._tag).toBe("None");
        yield* Retention.prune;
        expect(existsSync(backup)).toBe(shape !== "inline");
      }).pipe(Effect.provide(Blobs.layer(location))),
    );
  });

test("an unreadable backup is reported while scheduling, pruning and worker startup continue", async () => {
  const location = freshLocation();
  await runOn(location, Effect.void);
  const directory = Store.backupDirectory(location.database);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "records-garbage.sqlite");
  writeFileSync(path, "not a SQLite database");
  const messages: string[] = [];
  await runOn(
    location,
    Effect.gen(function* () {
      const queue = yield* JobQueue.JobQueue;
      expect((yield* Retention.schedulePrune(queue))._tag).toBe("None");
      expect((yield* Retention.prune).pruned.blobs).toBe(0);
      const { job } = yield* queue.enqueue({
        kind: "worker.probe",
        dedupeKey: "backup-read-containment",
        payload: { sleepMs: 0 },
      });
      expect(
        (yield* Worker.run({
          location,
          handlers: Worker.defaultHandlers,
          idleTimeout: "100 millis",
          pollInterval: "25 millis",
        })).reason,
      ).toBe("idle");
      const inspected = yield* queue.inspect(job.seq);
      expect(inspected._tag === "Some" && inspected.value.state).toBe(
        "completed",
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          JobQueue.layer,
          Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
          Logger.layer([
            Logger.make((event) => {
              messages.push(String(event.message));
            }),
          ]),
        ),
      ),
    ),
  );
  expect(messages).toContain(
    "retention.prune: unreadable migration backup skipped",
  );
  expect(existsSync(path)).toBe(true);
});
