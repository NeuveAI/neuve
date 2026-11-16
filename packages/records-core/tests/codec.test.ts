// Cross-build reads must accept additive fields without relaxing producer input or hiding corruption.
import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { z } from "zod";
import {
  RecordEvent,
  safeRead,
  preserveUnknown,
  compatibilityNotice,
} from "@neuve/records-schema";
import {
  Admin,
  Blobs,
  Computations,
  JobQueue,
  Log,
  Worker,
  PROJECTOR_VERSION,
  canonicalJson,
} from "../src/index.ts";
import { decodeEnvelope, fingerprintOf, parseEvent } from "../src/codec.ts";
import {
  commitEvent,
  cycleEvents,
  freshLocation,
  removeTemporaryDirectories,
  runOn,
} from "./support.ts";

afterAll(removeTemporaryDirectories);

test("the shared read rule handles nested unions but keeps missing fields and wrong types corrupt", async () => {
  const schema = z.strictObject({
    nested: z.union([
      z.strictObject({ type: z.literal("a"), count: z.number() }),
      z.strictObject({ type: z.literal("b"), label: z.string() }),
    ]),
  });
  const original = {
    nested: { type: "a", count: 2, future: "never printed" },
    futureRoot: true,
  };
  const result = safeRead(schema, original);
  expect(result.success && result.data).toEqual({
    nested: { type: "a", count: 2 },
  });
  expect(result.success && result.droppedKeys.toSorted()).toEqual([
    "futureRoot",
    "nested.future",
  ]);
  expect(original.nested.future).toBe("never printed");
  // Stored output arrays can contain unions with overlapping valid branches. Try candidates lazily.
  const branch = z.strictObject({ count: z.number() });
  expect(
    safeRead(
      z.array(z.union([branch, branch])),
      Array.from({ length: 40 }, () => ({ count: 1, future: true })),
    ).success,
  ).toBe(true);

  expect(
    safeRead(schema, { nested: { type: "a", future: true } }).success,
  ).toBe(false);
  expect(
    safeRead(schema, { nested: { type: "a", count: "bad", future: true } })
      .success,
  ).toBe(false);
  expect(
    safeRead(schema, { nested: { type: "c", count: 2, future: true } }).success,
  ).toBe(false);
});

test("log, fsck and rebuild accept additive envelope, payload and nested fields and keep original integrity", async () => {
  const location = freshLocation();
  const { events } = cycleEvents(1);
  await runOn(location, Log.append(events.slice(0, 2)));
  const read = await runOn(
    location,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const event = RecordEvent.parse(events[2]);
      if (event.kind !== "unit.recorded@1") throw new Error(event.kind);
      const newer = {
        ...event,
        futureEnvelope: true,
        payload: {
          ...event.payload,
          futurePayload: true,
          ownedRanges: event.payload.ownedRanges.map((range) => ({
            ...range,
            futureRange: true,
          })),
        },
      };
      const stored = canonicalJson(newer);
      const [inserted] = yield* sql<{
        seq: number;
      }>`INSERT INTO events ${sql.insert({ id: event.id, kind: event.kind, idempotency_key: event.idempotencyKey, fingerprint: fingerprintOf(newer), actor_id: event.actor, occurred_at: event.occurredAt, recorded_at: event.occurredAt, envelope: stored })} RETURNING seq`;
      for (const unitId of event.attribution.unitIds)
        yield* sql`INSERT INTO event_units(event_seq,unit_id) VALUES(${inserted!.seq},${unitId})`;
      if (event.attribution.cycleId)
        yield* sql`INSERT INTO event_cycles(event_seq,cycle_id) VALUES(${inserted!.seq},${event.attribution.cycleId})`;
      const history = yield* Log.history({});
      yield* Admin.rebuild;
      const check = yield* Admin.fsck(location);
      const [after] = yield* sql<{
        envelope: string;
        fingerprint: string;
      }>`SELECT envelope, fingerprint FROM events WHERE id=${event.id}`;
      const [marker] = yield* sql<{
        value: number;
      }>`SELECT value FROM records_meta WHERE key='projections_version'`;
      return { event, history, check, stored, after, marker };
    }),
  );
  expect(read.history.at(-1)?.event).toEqual(read.event);
  expect(read.check.filter((check) => check.status === "fail")).toEqual([]);
  expect(read.after?.envelope).toBe(read.stored);
  expect(read.marker?.value).toBe(PROJECTOR_VERSION);
});

test("unknown producer keys remain refused, and a malformed known event stays CorruptRecord", async () => {
  const event = commitEvent("a".repeat(40));
  expect(
    (
      await Effect.runPromise(
        Effect.flip(parseEvent({ ...event, future: true })),
      )
    )._tag,
  ).toBe("InvalidEvent");
  for (const payload of [
    { ...event.payload, oid: 42, future: true },
    { future: true },
  ]) {
    const result = await Effect.runPromise(
      Effect.flip(
        decodeEnvelope(canonicalJson({ ...event, payload }), "stored row"),
      ),
    );
    expect(result._tag).toBe("CorruptRecord");
  }
});

test("a worker decodes a directly stored newer job payload while enqueue stays strict", async () => {
  const location = freshLocation();
  const read = await runOn(
    location,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const queue = yield* JobQueue.JobQueue;
      const invalid = yield* Effect.flip(
        queue.enqueue({
          kind: "worker.probe",
          dedupeKey: "invalid",
          payload: { future: true },
        }),
      );
      yield* sql`INSERT INTO jobs (kind,dedupe_key,payload) VALUES ('worker.probe','newer',${canonicalJson({ sleepMs: 0, failAttempts: 0, future: true })})`;
      const job = Option.getOrThrow(yield* queue.take(["worker.probe"]));
      yield* Worker.probeHandler(job);
      yield* queue.complete(job.seq, job.attempts);
      const [stored] = yield* sql<{
        payload: string;
      }>`SELECT payload FROM jobs WHERE dedupe_key='newer'`;
      return { invalid, job, stored };
    }).pipe(
      Effect.provide(JobQueue.layer),
      Effect.provide(
        Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
      ),
    ),
  );
  expect(read.invalid._tag).toBe("InvalidJobPayload");
  expect(read.job.payload).toEqual({ sleepMs: 0, failAttempts: 0 });
  expect(JSON.parse(read.stored!.payload)).toEqual({
    sleepMs: 0,
    failAttempts: 0,
    future: true,
  });
});

test("compatible reads emit one stderr line per process with paths and no payload values", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "fixtures/stored-record-notice.ts"),
    ],
    { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" },
  );
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(stderr.trim().split("\n")).toEqual([
      "neuve: compatibility mode; this build read fields a newer build added (newer) and left them to that build; projection rebuilds requiring those fields are left to that build",
    ]);
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
});

test("a newer shared-work socket reply is accepted across the process boundary", async () => {
  const { createServer } = await import("node:net");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { sharedWorkOwnership } = await import("../src/shared-work-socket.ts");
  const directory = mkdtempSync("/tmp/neu130-socket-");
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.once("data", () =>
      socket.end(
        JSON.stringify({ kind: "ownership", live: true, future: true }) + "\n",
      ),
    );
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(`${directory}/budget.sock`, resolve);
    });
    expect(await sharedWorkOwnership("store", "key", directory)).toBe("live");
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("spool ingestion leaves a newer event intact instead of publishing a stripped record", async () => {
  const { mkdirSync, writeFileSync, readFileSync } = await import("node:fs");
  const { Ingest, Spool } = await import("../src/index.ts");
  const location = freshLocation();
  const event = { ...commitEvent("c".repeat(40)), future: true };
  const text = canonicalJson({ spool: 1, event }) + "\n";
  mkdirSync(location.spool, { recursive: true });
  const path = `${location.spool}/${Spool.spoolFileName(event.id)}`;
  writeFileSync(path, text);
  const report = await runOn(location, Ingest.ingestSpool(location));
  expect(report).toEqual({
    appended: 0,
    existing: 0,
    keptEarlier: 0,
    rejected: [],
  });
  expect(readFileSync(path, "utf8")).toBe(text);
  expect(await runOn(location, Log.history({}))).toEqual([]);
});

test("fsck detects a changed additive field through the original stored fingerprint", async () => {
  const location = freshLocation();
  const event = RecordEvent.parse(commitEvent("d".repeat(40)));
  const newer = { ...event, future: true };
  const checks = await runOn(
    location,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql`INSERT INTO events ${sql.insert({ id: event.id, kind: event.kind, idempotency_key: event.idempotencyKey, actor_id: event.actor, occurred_at: event.occurredAt, recorded_at: event.occurredAt, envelope: canonicalJson(newer), fingerprint: fingerprintOf(event) })}`;
      expect(Option.isSome(yield* Log.get(event.id))).toBe(true);
      return yield* Admin.fsck(location);
    }),
  );
  expect(
    checks.find((check) => check.name.startsWith("envelopes")),
  ).toMatchObject({ status: "fail" });
  expect(
    checks.find((check) => check.name.startsWith("envelopes"))?.detail,
  ).toContain("fingerprint mismatch");
});

// Notices are the privacy boundary; internal paths must still identify the stored entry for restoration.
test("record keys and collection positions are redacted by schema before disclosures are deduplicated", () => {
  const value = z.strictObject({ used: z.number() });
  const schema = z.strictObject({
    records: z
      .record(
        z.string(),
        z.union([value, z.strictObject({ other: z.boolean() })]),
      )
      .optional(),
    maps: z.map(z.string(), value),
    sets: z.set(value),
    arrays: z.array(value),
    tuples: z.tuple([value]),
  });
  const stored = {
    records: {
      privateIdentifier: { used: 1, future: true },
      "path/to/private.ts": { used: 2, future: true },
    },
    maps: new Map([["mapSecret", { used: 1, future: true }]]),
    sets: new Set([{ used: 1, future: true }]),
    arrays: [
      { used: 1, future: true },
      { used: 2, future: true },
    ],
    tuples: [{ used: 1, future: true }],
  };
  const read = safeRead(schema, stored, { notice: false });
  expect(read.success).toBe(true);
  if (!read.success) throw read.error;
  expect(read.droppedKeys).toEqual([
    "records.[entry].future",
    "maps.[entry].future",
    "sets.[entry].future",
    "arrays.[].future",
    "tuples.[].future",
  ]);
  const notice = compatibilityNotice(read.droppedKeys);
  expect(notice).not.toContain("privateIdentifier");
  expect(notice).not.toContain("path/to/private.ts");
  expect(notice).not.toContain("mapSecret");
  expect(notice).toContain("records.[entry].future");
  expect(read.droppedPaths).toContainEqual([
    "records",
    "privateIdentifier",
    "future",
  ]);
  expect(read.droppedPaths).toContainEqual([
    "records",
    "path/to/private.ts",
    "future",
  ]);
  expect(read.droppedPaths).toContainEqual(["maps", "mapSecret", "future"]);
  expect(read.droppedPaths).toContainEqual(["sets", 0, "future"]);
  expect(read.droppedPaths).toContainEqual(["arrays", 1, "future"]);
  const recordSchema = z.record(z.string(), value);
  expect(
    preserveUnknown(recordSchema, stored.records, {
      privateIdentifier: { used: 3 },
      "path/to/private.ts": { used: 4 },
    }),
  ).toEqual({
    privateIdentifier: { used: 3, future: true },
    "path/to/private.ts": { used: 4, future: true },
  });
});

test("an unknown enum-record entry is redacted even when the dropped key is the entry itself", () => {
  const schema = z.record(z.enum(["known"]), z.number());
  const stored = { known: 1, privateRecordEntry: 2 };
  const read = safeRead(schema, stored, { notice: false });
  expect(read.success).toBe(true);
  if (!read.success) throw read.error;
  expect(read.droppedKeys).toEqual(["[entry]"]);
  expect(read.droppedPaths).toEqual([["privateRecordEntry"]]);
  expect(compatibilityNotice(read.droppedKeys)).not.toContain(
    "privateRecordEntry",
  );
  expect(preserveUnknown(schema, stored, { known: 3 })).toEqual({
    known: 3,
    privateRecordEntry: 2,
  });
});
