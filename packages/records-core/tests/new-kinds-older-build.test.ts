// Why (8.19, 12.24): an older build shares the store with this one. Over a cycle reviewed in the
// new shape it must skip every new kind in its log and queue readers, pass fsck, leave rebuild to
// the newer build, show no standing packet for the cycle (the older packet the chain superseded
// stays superseded), and refuse a person's disposition on a new unit cleanly as an unknown unit.
// As `newer-build.test.ts` does, this build stands in for the older one: the new kinds' real
// envelopes are stored under kind names it does not know (`@9x`), with the projection rows the
// newer build's projector writes for them.
import { afterAll, expect, test } from "bun:test";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { RecordEvent } from "@neuve/records-schema";
import {
  Admin,
  Blobs,
  HumanCommands,
  Lineage,
  Log,
  PublishedPackets,
  ReviewProgress,
  canonicalJson,
  mintUlid,
} from "../src/index.ts";
import { fingerprintOf } from "../src/codec.ts";
import { project } from "../src/projectors.ts";
import { contentLayer, storeContent } from "./new-shape-support.ts";
import { newShapeReview } from "./review-fixtures.ts";
import {
  agent,
  envelope,
  freshLocation,
  headOid,
  removeTemporaryDirectories,
  runOn,
} from "./support.ts";

afterAll(removeTemporaryDirectories);

const range = { baseRef: "refs/heads/main", baseOid: "b".repeat(40), headOid };

/** The kind names this build does not know, one per new kind. */
const RENAMED: Readonly<Record<string, string>> = {
  "unit.recorded@3": "unit.recorded@93",
  "assessment.recorded@4": "assessment.recorded@94",
  "comment.recorded@3": "comment.recorded@93",
  "lineage.recorded@1": "lineage.recorded@91",
  "packet.published@2": "packet.published@92",
};

type Row = Record<string, unknown> & {
  id: string;
  kind: string;
  idempotencyKey: string;
  actor: string;
  occurredAt: string;
  attribution?: { cycleId?: string; unitIds?: ReadonlyArray<string> };
};

/** Inserts an event row as the newer build's append does: canonical envelope, fingerprint, index rows. */
const insertRow = (event: Row) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const [row] = yield* sql<{ seq: number }>`INSERT INTO events ${sql.insert({
      id: event.id,
      kind: event.kind,
      idempotency_key: event.idempotencyKey,
      fingerprint: fingerprintOf(event as never),
      actor_id: event.actor,
      occurred_at: event.occurredAt,
      recorded_at: "2026-11-12T10:00:01.000Z",
      envelope: canonicalJson(event),
    })} RETURNING seq`;
    for (const unit_id of event.attribution?.unitIds ?? [])
      yield* sql`INSERT INTO event_units ${sql.insert({ unit_id, event_seq: row!.seq })}`;
    if (event.attribution?.cycleId !== undefined)
      yield* sql`INSERT INTO event_cycles ${sql.insert({ cycle_id: event.attribution.cycleId, event_seq: row!.seq })}`;
  });

const olderBuildStore = async () => {
  const location = freshLocation();
  const earlier = { unitId: mintUlid(), cycleId: mintUlid() };
  const fixture = newShapeReview({ earlier });
  const ids = await runOn(
    location,
    Effect.gen(function* () {
      const blobs = yield* Blobs.BlobStore;
      yield* storeContent(fixture);
      const manifest = yield* blobs.put({
        bytes: new TextEncoder().encode('{"batches":[]}'),
        mediaType: "application/json",
        retention: "durable",
      });
      // An earlier configuration's packet in the same cycle, of the shape the older build reads.
      const legacy = {
        ...envelope(
          "packet.published@1",
          `review:${fixture.runId}:legacy`,
          agent,
          {
            cycleId: fixture.cycleId,
            range,
            runId: `${fixture.runId}-legacy`,
          },
          {
            complete: true,
            counts: {
              batches: 0,
              units: 0,
              contextReferences: 0,
              assessments: 0,
              deliveries: 0,
              dispositions: 0,
              comments: 0,
              gaps: 0,
            },
          },
        ),
        refs: [{ ref: `blob:${manifest.blob.hash}`, role: "manifest" }],
      };
      const firstEvent = {
        ...fixture.events.first,
        causation: { supersedes: legacy.id },
      };
      const known: Array<unknown> = [];
      const newer: Array<Row> = [];
      // In the fixture's causal order, with the legacy packet before the chain.
      const all = fixture.all.map((e) =>
        e.id === firstEvent.id ? firstEvent : e,
      );
      yield* Log.append([...all.slice(0, 5), legacy]);
      for (const event of all.slice(5)) {
        const renamed = RENAMED[event.kind];
        if (renamed === undefined) {
          yield* Log.append([event]);
          known.push(event);
          continue;
        }
        const row = { ...(event as unknown as Row), kind: renamed };
        yield* insertRow(row);
        newer.push(row);
        // The rows the newer build's projector wrote for it.
        yield* project(RecordEvent.parse(event));
      }
      return { legacy: legacy.id, newer: newer.map((row) => row.id) };
    }).pipe(Effect.provide(contentLayer(location))),
  );
  return { location, fixture, earlier, ...ids };
};

test("an older build skips the new kinds, passes fsck, leaves rebuild, shows no review for the cycle and refuses a decision on a new unit cleanly", async () => {
  const store = await olderBuildStore();
  const { fixture, location } = store;
  const read = await runOn(
    location,
    Effect.gen(function* () {
      const history = yield* Log.history({ limit: 1_000 });
      const cycle = yield* Log.history({
        cycleId: fixture.cycleId,
        limit: 1_000,
      });
      const gets = yield* Effect.forEach(store.newer, (id) => Log.get(id));
      const newerKind = yield* Log.newerEventKind(
        fixture.events.units.large.id,
      );
      const sequence = yield* ReviewProgress.reviewSequence;
      const checks = yield* Admin.fsck(location);
      const stats = yield* Admin.stats(location);
      const rebuilt = yield* Admin.rebuild;
      const standing = yield* PublishedPackets.standingPacket(fixture.cycleId);
      const readStanding = yield* PublishedPackets.readStanding(
        fixture.cycleId,
      );
      const standingId = yield* PublishedPackets.standingPacketId(
        fixture.cycleId,
      );
      const successors = yield* Lineage.successors(store.earlier.unitId);
      const refused = yield* Effect.flip(
        HumanCommands.recordDisposition({
          person: { email: "owner@example.com" },
          unitId: fixture.units.large,
          verdict: "approve",
        }),
      );
      const feedback = yield* Effect.flip(
        HumanCommands.recordFeedback({
          person: { email: "owner@example.com" },
          answer: {
            on: "unit",
            target: fixture.events.units.large.id,
            harnessCallVisible: true,
            lane: "human-required",
          },
        }),
      );
      return {
        history,
        cycle,
        gets,
        newerKind,
        sequence,
        checks,
        stats,
        rebuilt,
        standing,
        readStanding,
        standingId,
        successors,
        refused,
        feedback,
      };
    }).pipe(Effect.provide(contentLayer(location))),
  );
  const kinds = read.history.map((e) => e.event.kind);
  for (const renamed of Object.values(RENAMED))
    expect(kinds).not.toContain(renamed);
  expect(read.cycle.map((e) => e.event.kind)).not.toContain(
    "packet.published@92",
  );
  expect(read.gets.every(Option.isNone)).toBe(true);
  expect(read.newerKind).toEqual(Option.some("unit.recorded@93"));
  expect(read.sequence).toBeGreaterThan(0);
  expect(read.checks.filter((check) => check.status === "fail")).toEqual([]);
  // Round 2: no projection row of a new kind reads to it as a state copy (a version 2 packet
  // projects only its supersession).
  expect(read.stats.stateCopies).toEqual([]);
  expect(
    read.checks.find((check) => check.name.startsWith("envelopes"))?.detail,
  ).toContain("8 of kinds this build does not know, left for a newer build");
  expect(read.rebuilt).toMatchObject({ events: 0, newerEvents: 8 });
  expect(read.rebuilt.afterCombined).toBe(read.rebuilt.beforeCombined);
  // The packet the chain superseded stays superseded; the chain is not one it can read.
  expect(read.standing).toBeUndefined();
  expect(read.readStanding).toBeUndefined();
  expect(read.standingId).toBeUndefined();
  expect(read.successors).toEqual([]);
  expect(read.refused).toMatchObject({
    _tag: "HumanCommandRefused",
    reason: "unknown-unit",
  });
  expect(read.feedback).toMatchObject({
    _tag: "HumanCommandRefused",
    reason: "unknown-feedback-target",
  });
});
