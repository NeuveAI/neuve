// Why: retention fails silently both ways. Pruning a durable blob or a capture still inside its 30
// days loses data that nothing recomputes (8.10), and a prune that leaves bytes behind keeps session
// data past its limit (5.8); either still reads as a working store. This pins what is pruned, that
// tombstones keep provenance (fsck stays clean), that an interrupted prune's file is finished by the
// next one, that a stray file in the blob folders (a Finder `.DS_Store`) never stops pruning, and
// that capturing pruned bytes again restores them as a new capture with their file.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Duration, Effect, Layer } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { SqlClient } from "effect/sql/SqlClient";
import { Admin, Blobs, Retention } from "../src/index.ts";
import { freshLocation, removeTemporaryDirectories, runOn } from "./support.ts";

afterAll(removeTemporaryDirectories);

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);
const daysAgo = (days: number) => NOW - Duration.toMillis(Duration.days(days));
const bytes = (text: string, size = text.length) =>
  new TextEncoder().encode(text.padEnd(size, "."));

test("prune tombstones only raw captures past 30 days, finishes an interrupted prune, and a new capture restores pruned bytes", async () => {
  const location = freshLocation();
  const large = bytes("large raw capture", Blobs.INLINE_MAX_BYTES + 1);
  const result = await runOn(
    location,
    Effect.gen(function* () {
      const blobs = yield* Blobs.BlobStore;
      yield* TestClock.setTime(daysAgo(40));
      const oldInline = yield* blobs.put({
        bytes: bytes("old inline raw capture"),
        mediaType: "application/jsonl",
        retention: "raw-capture",
      });
      const oldFile = yield* blobs.put({
        bytes: large,
        mediaType: "application/jsonl",
        retention: "raw-capture",
      });
      const oldDurable = yield* blobs.put({
        bytes: bytes("old durable output"),
        mediaType: "application/json",
        retention: "durable",
      });
      yield* TestClock.setTime(daysAgo(29));
      const recent = yield* blobs.put({
        bytes: bytes("recent raw capture"),
        mediaType: "application/jsonl",
        retention: "raw-capture",
      });
      yield* TestClock.setTime(NOW);
      const path = Blobs.blobPath(location, oldFile.blob.hash);
      // Files and folders that are not blob folders, as Finder or a person may leave them.
      writeFileSync(join(location.blobs, "sha256", ".DS_Store"), "finder");
      writeFileSync(join(location.blobs, "sha256", "notes.txt"), "stray");
      mkdirSync(join(location.blobs, "sha256", "zz"));
      const plan = yield* Retention.plan;
      const first = yield* Retention.prune;
      const fileGone = !existsSync(path);
      const reads = {
        oldInline: (yield* blobs.get(oldInline.blob.hash))._tag,
        oldFile: (yield* blobs.get(oldFile.blob.hash))._tag,
        oldDurable: (yield* blobs.get(oldDurable.blob.hash))._tag,
        recent: (yield* blobs.get(recent.blob.hash))._tag,
      };
      // A crash between the tombstone's commit and the file's removal leaves the file behind.
      writeFileSync(path, large);
      const leftoverPlan = yield* Retention.plan;
      const fsckWithLeftover = yield* Admin.fsck(location);
      const second = yield* Retention.prune;
      const leftoverGone = !existsSync(path);
      yield* TestClock.setTime(NOW + 1_000);
      const again = yield* blobs.put({
        bytes: large,
        mediaType: "application/jsonl",
        retention: "raw-capture",
      });
      return {
        plan,
        first,
        fileGone,
        reads,
        leftoverPlan,
        fsckWithLeftover,
        second,
        leftoverGone,
        again,
        restoredRead: (yield* blobs.get(oldFile.blob.hash))._tag,
        restoredFile: existsSync(path),
        third: yield* Retention.prune,
        checks: yield* Admin.fsck(location),
      };
    }).pipe(
      Effect.provide(Layer.merge(Blobs.layer(location), TestClock.layer())),
    ),
  );
  expect(result.plan.due).toMatchObject({ blobs: 2 });
  expect(result.plan.durable.blobs).toBe(1);
  expect(result.plan.retained.blobs).toBe(1);
  expect(result.first.pruned).toMatchObject({ blobs: 2, inline: 1, files: 1 });
  expect(result.fileGone).toBe(true);
  expect(result.reads).toEqual({
    oldInline: "Pruned",
    oldFile: "Pruned",
    oldDurable: "Present",
    recent: "Present",
  });
  expect(result.leftoverPlan.leftoverFiles).toBe(1);
  expect(result.fsckWithLeftover.every((c) => c.status === "ok")).toBe(true);
  expect(result.second).toMatchObject({
    leftoverFilesRemoved: 1,
    pruned: { blobs: 0 },
  });
  expect(result.leftoverGone).toBe(true);
  expect(result.again.status).toBe("restored");
  expect(result.again.blob.capturedAt).toBe(
    new Date(NOW + 1_000).toISOString(),
  );
  expect(result.restoredRead).toBe("Present");
  expect(result.restoredFile).toBe(true);
  expect(result.third.pruned.blobs).toBe(0);
  expect(result.checks.filter((c) => c.status !== "ok")).toEqual([]);
});

test("a blob folder that cannot be read never stops tombstoning; the prune reports it", async () => {
  const location = freshLocation();
  const unreadable = join(location.blobs, "sha256", "ab");
  const result = await runOn(
    location,
    Effect.gen(function* () {
      const blobs = yield* Blobs.BlobStore;
      yield* TestClock.setTime(daysAgo(31));
      yield* blobs.put({
        bytes: bytes("old inline raw capture"),
        mediaType: "application/jsonl",
        retention: "raw-capture",
      });
      yield* TestClock.setTime(NOW);
      mkdirSync(join(location.blobs, "sha256"), { recursive: true });
      mkdirSync(unreadable, { mode: 0o000 });
      return {
        plan: yield* Retention.plan,
        report: yield* Retention.prune,
        // fsck reports the folder as a failed check rather than aborting (S6 review follow-up).
        checks: yield* Admin.fsck(location),
      };
    }).pipe(
      Effect.provide(Layer.merge(Blobs.layer(location), TestClock.layer())),
      Effect.ensuring(Effect.sync(() => chmodSync(unreadable, 0o700))),
    ),
  );
  expect(
    result.checks
      .filter((check) => check.status !== "ok")
      .map((check) => check.detail),
  ).toEqual([expect.stringContaining("blob folders could not be listed")]);
  expect(result.plan.due.blobs).toBe(1);
  expect(result.plan.leftoverFiles).toBeNull();
  expect(result.report.pruned.blobs).toBe(1);
  expect(result.report.leftoverFilesRemoved).toBeNull();
  expect(result.report.leftoverError).toContain("BlobScanFailed");
});

test("a shared journal object expires with the last raw capture that names it", async () => {
  const location = freshLocation();
  const outcome = await runOn(
    location,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const blobs = yield* Blobs.BlobStore;
      const put = (text: string) =>
        blobs.put({
          bytes: bytes(text),
          mediaType: "application/json",
          retention: "raw-capture",
        });
      yield* TestClock.setTime(daysAgo(40));
      const { blob: object } = yield* put("shared request object");
      const { blob: older } = yield* put("older raw capture");
      yield* TestClock.setTime(daysAgo(29));
      const { blob: newer } = yield* put("newer raw capture");
      yield* sql`INSERT INTO raw_capture_parts (capture_hash, part_hash) VALUES (${older.hash}, ${object.hash}), (${newer.hash}, ${object.hash})`;
      yield* TestClock.setTime(NOW);
      yield* sql`UPDATE blobs SET pruned_at = ${new Date(NOW).toISOString()}, content = NULL WHERE hash = ${object.hash}`;
      const due = (yield* Retention.plan).due.blobs;
      const first = yield* Retention.prune;
      const status = () =>
        Effect.forEach([older, newer, object], ({ hash }) =>
          Effect.map(blobs.get(hash), ({ _tag }) => _tag),
        );
      const during = yield* status();
      yield* TestClock.setTime(NOW + 2 * (NOW - daysAgo(1)));
      const second = yield* Retention.prune;
      const expired = yield* status();
      return {
        due,
        first: first.pruned.blobs,
        during,
        second: second.pruned.blobs,
        expired,
      };
    }).pipe(
      Effect.provide(Layer.merge(Blobs.layer(location), TestClock.layer())),
    ),
  );
  expect(outcome).toEqual({
    due: 1,
    first: 1,
    during: ["Pruned", "Present", "Present"],
    second: 2,
    expired: ["Pruned", "Pruned", "Pruned"],
  });
});
