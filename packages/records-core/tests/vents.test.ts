// Why: the vent limits (8.8, 8.16) are the only guard against an agent flooding Records with vents,
// and losing one is silent: every extra vent still reads as a success. Vent text expiring (8.17) is
// just as silent when it fails, since the text keeps reading back. These cases pin that a second vent
// keeps the first as an ordinary outcome and stores nothing of itself, that the limit is per actor and
// reconciliation ID (falling back to the session), that the log's unique index refuses a bypass, that
// a second vent through the spool is answered without stopping ingestion while an inline-text vent, or
// one pointing at a durable blob that would never expire, is refused, and that a vent past retention
// reads as pruned while its event keeps the attribution.
import { afterAll, expect, test } from "bun:test";
import { Duration, Effect, Layer } from "effect";
import type { FileSystem } from "effect/FileSystem";
import { SqlClient } from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { RecordEvent, TEXT_CAPTURE_MEDIA_TYPE } from "@neuve/records-schema";
import {
  Blobs,
  Identity,
  Ingest,
  Log,
  Retention,
  Spool,
  Vents,
  mintUlid,
  type StoreLocation,
} from "../src/index.ts";
import { freshLocation, removeTemporaryDirectories, runOn } from "./support.ts";

afterAll(removeTemporaryDirectories);

const withBlobs = <A, E>(
  location: StoreLocation,
  program: Effect.Effect<A, E, Blobs.BlobStore | SqlClient | FileSystem>,
) => runOn(location, Effect.provide(program, Blobs.layer(location)));

const bypassRow = (actor: string, kind: string, envelope: unknown) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* Effect.result(
      sql`INSERT INTO events ${sql.insert({
        id: mintUlid(),
        kind,
        idempotency_key: `other-producer:${mintUlid()}`,
        fingerprint: "f",
        actor_id: actor,
        occurred_at: new Date().toISOString(),
        recorded_at: new Date().toISOString(),
        envelope: JSON.stringify(envelope),
      })}`,
    );
  });

test("one vent per actor and session: a second keeps the first, stores nothing, and the log refuses a bypass", async () => {
  const location = freshLocation();
  const result = await withBlobs(
    location,
    Effect.gen(function* () {
      const first = yield* Vents.ventAsCaller(location, {
        text: "  The fixture database is not running, so I cannot verify the change.  ",
        override: "claude-code:session-a",
      });
      const second = yield* Vents.ventAsCaller(location, {
        text: "Another complaint.",
        override: "claude-code:session-a",
      });
      const other = yield* Vents.ventAsCaller(location, {
        text: "The plan names a function that no longer exists.",
        override: "codex:session-b",
      });
      const actor = Identity.agentFingerprint({
        harness: "claude-code",
        sessionId: "session-a",
      });
      // A producer that writes the row itself, skipping `Log.append`'s check, meets the index.
      const bypass = yield* bypassRow(actor, "vent.recorded@2", {
        attribution: { sessionId: "session-a" },
        payload: {},
      });
      const sql = yield* SqlClient;
      const [blobs] = yield* sql<{
        n: number;
      }>`SELECT count(*) AS n FROM blobs`;
      return {
        first,
        second,
        other,
        bypass,
        blobs: blobs?.n,
        vents: yield* Vents.list({}),
      };
    }),
  );
  expect(result.first.status).toBe("recorded");
  expect(result.second.status).toBe("kept-earlier");
  if (
    result.first.status === "recorded" &&
    result.second.status === "kept-earlier"
  )
    expect(result.second.earlier.id).toBe(result.first.vent.id);
  expect(result.other.status).toBe("recorded");
  expect(
    result.bypass._tag === "Failure" && result.bypass.failure.reason._tag,
  ).toBe("UniqueViolation");
  expect(result.blobs).toBe(2);
  expect(result.vents.map((vent) => [vent.sessionId, vent.text])).toEqual([
    [
      "session-a",
      "The fixture database is not running, so I cannot verify the change.",
    ],
    ["session-b", "The plan names a function that no longer exists."],
  ]);
});

test("lanes sharing a parent session each vent once under their own reconciliation ID", async () => {
  const location = freshLocation();
  const parent = "claude-code:harness-parent";
  const result = await withBlobs(
    location,
    Effect.gen(function* () {
      const vent = (text: string, reconciliationId?: string) =>
        Vents.ventAsCaller(location, {
          text,
          override: parent,
          reconciliationId,
        });
      const laneA = yield* vent("Lane A: the fixture is stale.", "cycle-a");
      const laneB = yield* vent("Lane B: the graph is not built.", "cycle-b");
      const laneAgain = yield* vent("Lane A again.", "cycle-a");
      const session = yield* vent("The parent session itself.");
      const actor = Identity.agentFingerprint({
        harness: "claude-code",
        sessionId: "harness-parent",
      });
      const bypass = yield* bypassRow(actor, "vent.recorded@2", {
        attribution: { sessionId: "harness-parent" },
        payload: { reconciliationId: "cycle-b" },
      });
      return {
        statuses: [laneA, laneB, laneAgain, session].map((r) => r.status),
        bypass,
        vents: (yield* Vents.list({})).map((v) => [v.reconciliationId, v.text]),
      };
    }),
  );
  expect(result.statuses).toEqual([
    "recorded",
    "recorded",
    "kept-earlier",
    "recorded",
  ]);
  expect(
    result.bypass._tag === "Failure" && result.bypass.failure.reason._tag,
  ).toBe("UniqueViolation");
  expect(result.vents).toEqual([
    ["cycle-a", "Lane A: the fixture is stale."],
    ["cycle-b", "Lane B: the graph is not built."],
    [null, "The parent session itself."],
  ]);
});

test("through the spool, a second vent keeps the earlier one, and inline or durable vent text is refused; ingestion goes on", async () => {
  const location = freshLocation();
  const actor = Identity.agentFingerprint({
    harness: "claude-code",
    sessionId: "s1",
  });
  const result = await withBlobs(
    location,
    Effect.gen(function* () {
      const blobs = yield* Blobs.BlobStore;
      const text = yield* blobs.put({
        bytes: new TextEncoder().encode("A second."),
        mediaType: TEXT_CAPTURE_MEDIA_TYPE,
        retention: "raw-capture",
      });
      const durable = yield* blobs.put({
        bytes: new TextEncoder().encode("Kept forever."),
        mediaType: TEXT_CAPTURE_MEDIA_TYPE,
        retention: "durable",
      });
      const spooled = (kind: string, sessionId: string, extra: object) =>
        RecordEvent.parse({
          id: mintUlid(),
          kind,
          idempotencyKey: `spooled:${mintUlid()}`,
          actor,
          occurredAt: new Date().toISOString(),
          attribution: { sessionId },
          ...extra,
        });
      const first = yield* Vents.record({
        actorId: actor,
        sessionId: "s1",
        text: "The first vent.",
      });
      yield* Spool.writeSpoolLine(
        location.spool,
        spooled("vent.recorded@2", "s1", {
          payload: {},
          refs: [{ ref: `blob:${text.blob.hash}`, role: "vent" }],
        }),
      );
      yield* Spool.writeSpoolLine(
        location.spool,
        spooled("vent.recorded@1", "s2", { payload: { text: "Inline." } }),
      );
      yield* Spool.writeSpoolLine(
        location.spool,
        spooled("vent.recorded@2", "s3", {
          payload: {},
          refs: [{ ref: `blob:${durable.blob.hash}`, role: "vent" }],
        }),
      );
      const ingested = yield* Ingest.ingestSpool(location);
      return {
        first,
        ingested,
        left: (yield* Ingest.pendingSpoolFiles(location)).length,
        vents: (yield* Vents.list({})).map((v) => [v.sessionId, v.text]),
      };
    }),
  );
  expect(result.first.status).toBe("recorded");
  expect(result.ingested).toMatchObject({ appended: 0, keptEarlier: 1 });
  expect(result.ingested.rejected).toHaveLength(2);
  expect(result.left).toBe(0);
  expect(result.vents).toEqual([["s1", "The first vent."]]);
});

test("a vent's text is pruned after 30 days and reads as pruned; the event keeps its attribution", async () => {
  const location = freshLocation();
  const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);
  const result = await runOn(
    location,
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW - Duration.toMillis(Duration.days(31)));
      const old = yield* Vents.ventAsCaller(location, {
        text: "An old difficulty.",
        override: "claude-code:old-session",
      });
      yield* TestClock.setTime(NOW - Duration.toMillis(Duration.days(2)));
      yield* Vents.ventAsCaller(location, {
        text: "A recent difficulty.",
        override: "claude-code:new-session",
      });
      yield* TestClock.setTime(NOW);
      const report = yield* Retention.prune;
      const stored =
        old.status === "recorded" ? yield* Log.get(old.vent.id) : undefined;
      return { report, vents: yield* Vents.list({}), stored };
    }).pipe(
      Effect.provide(Layer.merge(Blobs.layer(location), TestClock.layer())),
    ),
  );
  expect(result.report.pruned.blobs).toBe(1);
  expect(
    result.vents.map((v) => [v.sessionId, v.text, v.textPrunedAt]),
  ).toEqual([
    ["old-session", null, new Date(NOW).toISOString()],
    ["new-session", "A recent difficulty.", null],
  ]);
  expect(JSON.stringify(result.stored)).not.toContain("An old difficulty");
});
