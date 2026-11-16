// Why: projector 11 must open an existing store unchanged (no table change, no data migration,
// the same rows for every older kind, shown against literal rows), project the new unit and
// assessment into the units table with the newest recording winning across versions, keep the
// log-only kinds (`comment.recorded@3`, `lineage.recorded@1`, `packet.published@2`) out of the
// shared tables, and leave `neuve records stats` with no state-copy false alarm.
import { afterAll, expect, test } from "bun:test";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  Admin,
  Log,
  PROJECTOR_VERSION,
  ReviewStats,
  SCHEMA_VERSION,
  Store,
  mintUlid,
} from "../src/index.ts";
import { combinedChecksum, projectionChecksums } from "../src/rebuild.ts";
import { envelope, agent } from "./support.ts";
import { newShapeReview, reviewEvents } from "./review-fixtures.ts";
import { freshLocation, removeTemporaryDirectories, runOn } from "./support.ts";

afterAll(removeTemporaryDirectories);

const meta = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql<{
    key: string;
    value: number;
  }>`SELECT key, value FROM records_meta ORDER BY key`;
  const [migration] = yield* sql<{
    id: number;
  }>`SELECT max(migration_id) AS id FROM records_migrations`;
  return {
    versions: Object.fromEntries(rows.map((row) => [row.key, row.value])),
    migration: migration?.id,
  };
});

test("a store of older reviews opens at projector 11 with the same projection rows and no migration", async () => {
  expect(PROJECTOR_VERSION).toBe(11);
  const location = freshLocation();
  const fixture = reviewEvents();
  const before = await runOn(
    location,
    Effect.gen(function* () {
      yield* Log.append(fixture.all);
      const checksum = combinedChecksum(yield* projectionChecksums);
      // As a store projector 10 left: the shared baseline 9, its own projections at 10.
      const sql = yield* SqlClient;
      yield* sql`UPDATE records_meta SET value = 10 WHERE key = 'projections_version'`;
      return { checksum, meta: yield* meta };
    }),
  );
  const after = await runOn(
    location,
    Effect.gen(function* () {
      const migrated = yield* Store.migrate;
      const sql = yield* SqlClient;
      return {
        migrated,
        checksum: combinedChecksum(yield* projectionChecksums),
        meta: yield* meta,
        rebuilt: yield* Admin.rebuild,
        units:
          yield* sql`SELECT unit_id, title, owned_range_count, lane, quadrant, complexity,
          validation_gap, grouping_gap_lines, grouping_adjustment, context_reference_count,
          comment_count FROM projection_units ORDER BY unit_id`,
        comments:
          yield* sql`SELECT event_id, anchor_path, unit_count, finding_kind,
          finding_about, finding_signal FROM projection_comments ORDER BY event_id`,
        packets:
          yield* sql`SELECT run_id, complete, units, gaps FROM projection_packets`,
      };
    }),
  );
  expect(before.meta.migration).toBe(SCHEMA_VERSION);
  expect(before.meta.versions["projector_version"]).toBe(9);
  expect(after.migrated.applied).toEqual([]);
  expect(after.checksum).toBe(before.checksum);
  expect(after.meta).toEqual({
    migration: SCHEMA_VERSION,
    versions: { ...before.meta.versions, projections_version: 11 },
  });
  expect(after.rebuilt.afterCombined).toBe(after.rebuilt.beforeCombined);
  // The rows themselves, written out as older projectors give them for these events, so the claim
  // does not rest on this build agreeing with itself.
  const [u1, u2, u3] = fixture.units;
  const unit = (
    unitId: string,
    title: string,
    ownedRangeCount: number,
    lane: string,
    axes: [string | null, string | null, number | null],
    grouping: [number, string | null],
    counts: [number, number],
  ) => ({
    unitId,
    title,
    ownedRangeCount,
    lane,
    quadrant: axes[0],
    complexity: axes[1],
    validationGap: axes[2],
    groupingGapLines: grouping[0],
    groupingAdjustment: grouping[1],
    contextReferenceCount: counts[0],
    commentCount: counts[1],
  });
  expect(after.units).toEqual([
    unit(
      u1,
      "Unit one, merged",
      2,
      "agentic",
      [null, null, null],
      [20, "merge"],
      [1, 1],
    ),
    unit(
      u2,
      "Unit two",
      1,
      "human-suggested",
      ["high-easy", "high", 1],
      [20, null],
      [2, 2],
    ),
    unit(
      u3,
      "Unit three",
      1,
      "human-required",
      ["high-hard", "high", 0],
      [20, null],
      [0, 0],
    ),
  ]);
  expect(after.comments).toEqual([
    {
      eventId: fixture.comments.plain.id,
      anchorPath: null,
      unitCount: 1,
      findingKind: null,
      findingAbout: null,
      findingSignal: null,
    },
    {
      eventId: fixture.comments.defect.id,
      anchorPath: "src/a.ts",
      unitCount: 1,
      findingKind: "defect",
      findingAbout: "tests",
      findingSignal: "forged",
    },
    {
      eventId: fixture.comments.bloat.id,
      anchorPath: null,
      unitCount: 1,
      findingKind: "risk",
      findingAbout: "tests",
      findingSignal: "test-bloat",
    },
  ]);
  expect(after.packets).toEqual([
    { runId: fixture.runId, complete: 1, units: 3, gaps: 2 },
  ]);
});

test("the new kinds fill the units table, the newest recording wins across versions, and the log-only kinds (packets included) project nothing", async () => {
  // Minted before the review, so their ULIDs order before every event of it.
  const olderUnit = mintUlid();
  const olderAssessment = mintUlid();
  const location = freshLocation();
  const old = reviewEvents();
  const fixture = newShapeReview({
    earlier: { unitId: old.units[1], cycleId: old.cycleId },
  });
  const { large, small } = fixture.units;
  const read = await runOn(
    location,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* Log.append(old.all);
      const oldChecksum = combinedChecksum(yield* projectionChecksums);
      // The old review registered the same actors.
      yield* Log.append(
        fixture.all.filter((event) => event.kind !== "actor.registered@1"),
      );
      const unitRow = (unitId: string) =>
        sql<
          Record<string, unknown>
        >`SELECT * FROM projection_units WHERE unit_id = ${unitId}`;
      const rows = {
        large: (yield* unitRow(large))[0],
        small: (yield* unitRow(small))[0],
        earlier: (yield* unitRow(old.units[1]))[0],
        packets:
          yield* sql`SELECT event_id, run_id, complete, units, gaps FROM projection_packets
          WHERE cycle_id = ${fixture.cycleId} ORDER BY event_id`,
        supersessions:
          yield* sql`SELECT target_id, by_event_id FROM projection_supersessions
          WHERE by_event_id IN (${fixture.events.second.id}, ${fixture.events.lineage.id})`,
        comments:
          yield* sql`SELECT event_id FROM projection_comments WHERE cycle_id = ${fixture.cycleId}`,
      };
      // An older version recorded with an older ULID, appended later: the version 3 row stands.
      const unitEvent = fixture.events.units.large as { attribution: unknown };
      yield* Log.append([
        {
          ...envelope(
            "unit.recorded@2",
            `unit:${large}:older`,
            agent,
            unitEvent.attribution,
            {
              title: "An older recording",
              ownedRanges: [
                {
                  kind: "lines",
                  path: "src/large.ts",
                  side: "new",
                  startLine: 1,
                  endLine: 2,
                },
              ],
              grouping: { gapLines: 20 },
            },
          ),
          id: olderUnit,
        },
        {
          ...envelope(
            "assessment.recorded@3",
            `assessment:${large}:older`,
            agent,
            { cycleId: fixture.cycleId, unitIds: [large] },
            {
              lane: "agentic",
              quadrant: "low-easy",
              complexity: { level: "low", factors: [] },
              easeOfValidation: { level: "easy", requirements: [] },
              movement: [],
              gaps: [],
              rationale: "An older assessment.",
            },
          ),
          id: olderAssessment,
        },
      ]);
      const afterOlder = (yield* unitRow(large))[0];
      // A newer version 2 assessment wins over version 4 and fills the axis columns again.
      yield* Log.append([
        envelope(
          "assessment.recorded@2",
          `assessment:${large}:newer`,
          agent,
          { cycleId: fixture.cycleId, unitIds: [large] },
          {
            lane: "agentic",
            quadrant: "high-hard",
            complexity: { level: "high", factors: [] },
            easeOfValidation: { level: "hard", requirements: [] },
            movement: [],
            gaps: [],
            rationale: "A newer assessment.",
          },
        ),
      ]);
      const afterNewer = (yield* unitRow(large))[0];
      const rebuilt = yield* Admin.rebuild;
      return {
        oldChecksum,
        rows,
        afterOlder,
        afterNewer,
        rebuilt,
        stats: yield* Admin.stats(location),
        findings: (yield* ReviewStats.reviewStats({ cycleId: fixture.cycleId }))
          .findings,
      };
    }),
  );
  expect(read.rows.large).toMatchObject({
    title: "Large file",
    ownedRangeCount: 1_100,
    lane: "human-suggested",
    assessmentEventId: fixture.events.assessments.large.id,
    recordedEventId: fixture.events.units.large.id,
    groupingGapLines: null,
    groupingAdjustment: null,
    quadrant: null,
    complexity: null,
    validationGap: null,
    // The impact comment is read from the log, not counted here.
    commentCount: 0,
  });
  expect(read.rows.small).toMatchObject({
    lane: "human-required",
    ownedRangeCount: 1,
  });
  // Lineage names the earlier unit but changes nothing of its row.
  expect(read.rows.earlier).toMatchObject({ lane: "human-suggested" });
  // Round 2: version 2 packets are read from the log; only their supersession is projected, so
  // an older build's entity count of the packets table never reads them as a state copy.
  expect(read.rows.packets).toEqual([]);
  expect(read.rows.supersessions).toEqual([
    {
      targetId: fixture.events.first.id,
      byEventId: fixture.events.second.id,
    },
  ]);
  expect(read.rows.comments).toEqual([]);
  expect(read.afterOlder).toMatchObject({
    title: "Large file",
    ownedRangeCount: 1_100,
    lane: "human-suggested",
    quadrant: null,
  });
  expect(read.afterNewer).toMatchObject({
    lane: "agentic",
    quadrant: "high-hard",
    complexity: "high",
  });
  expect(read.rebuilt.afterCombined).toBe(read.rebuilt.beforeCombined);
  expect(read.oldChecksum).not.toBe(read.rebuilt.afterCombined);
  expect(read.stats.stateCopies).toEqual([]);
  // The impact finding still counts in the stats, read from the log.
  expect(read.findings).toEqual([
    { kind: "impact", about: "code", signal: null, comments: 1 },
  ]);
});
