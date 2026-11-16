// Raw content must leave free SQLite pages and migration copies when its retention expires.
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { Blobs, Retention, Store } from "../src/index.ts";
import { freshLocation, removeTemporaryDirectories, runOn } from "./support.ts";
afterAll(removeTemporaryDirectories);

test("pruning clears inline bytes securely on its connection", async () => {
  const location = freshLocation();
  const marker = "synthetic-expired-capture-unique-marker-447733";
  await runOn(
    location,
    Effect.gen(function* () {
      const blobs = yield* Blobs.BlobStore;
      yield* blobs.put({
        bytes: new TextEncoder().encode(marker.repeat(400)),
        mediaType: "text/plain",
        retention: "raw-capture",
      });
      const removed = yield* blobs.prune({
        cutoff: "2999-01-01T00:00:00.000Z",
        limit: 10,
      });
      expect(removed).toHaveLength(1);
      const sql = yield* SqlClient;
      const [secure] = yield* sql<{
        secureDelete: number;
      }>`PRAGMA secure_delete`;
      expect(secure?.secureDelete).toBe(1);
    }).pipe(Effect.provide(Blobs.layer(location))),
  );
  const db = new Database(location.database);
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  expect(readFileSync(location.database).includes(Buffer.from(marker))).toBe(
    false,
  );
});

test("an expired raw capture in a migration copy schedules pruning even without a live due blob", async () => {
  const location = freshLocation();
  await runOn(location, Effect.void);
  const directory = Store.backupDirectory(location.database);
  mkdirSync(directory, { recursive: true });
  const paths = ["old", "recent", "durable"].map((name) =>
    join(directory, `${basename(location.database, ".sqlite")}-${name}.sqlite`),
  );
  for (const [index, path] of paths.entries()) {
    const copy = new Database(path);
    copy.run(
      "CREATE TABLE blobs(retention TEXT,captured_at TEXT,content BLOB,pruned_at TEXT)",
    );
    copy.run("INSERT INTO blobs VALUES(?,?,?,NULL)", [
      index === 2 ? "durable" : "raw-capture",
      index === 1 ? "2999-01-01T00:00:00.000Z" : "2000-01-01T00:00:00.000Z",
      Buffer.from("synthetic capture in migration copy"),
    ]);
    copy.close();
  }
  await runOn(
    location,
    Effect.gen(function* () {
      expect((yield* Retention.wantedPrune)._tag).toBe("Some");
      yield* Retention.prune;
      expect(paths.map((path) => existsSync(path))).toEqual([
        false,
        true,
        true,
      ]);
      expect((yield* Retention.wantedPrune)._tag).toBe("None");
    }).pipe(Effect.provide(Blobs.layer(location))),
  );
});
