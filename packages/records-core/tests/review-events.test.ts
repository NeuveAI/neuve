// Why (H4, 11.2): the M3 event versions sit beside version 1 in one log, and a rebuild must never
// lose an event. These check that both versions decode and project side by side, that a rebuild
// reproduces what the append transaction projected whatever the append order, and the boundaries
// the new versions add: the payload cap, the citation rule for requests for changes, and the
// schema refinements that keep a record self-consistent.
import { afterAll, expect, test } from "bun:test";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { PAYLOAD_MAX_BYTES } from "@neuve/records-schema";
import {
  Admin,
  Log,
  ReviewStats,
  canonicalJson,
  mintUlid,
} from "../src/index.ts";
import { receipt, reviewEvents } from "./review-fixtures.ts";
import { freshLocation, removeTemporaryDirectories, runOn } from "./support.ts";

afterAll(removeTemporaryDirectories);

/** Appends `events` in one transaction and returns the failure's tag, or `appended`. */
const appendOutcome = (
  location: ReturnType<typeof freshLocation>,
  events: ReadonlyArray<unknown>,
) =>
  runOn(
    location,
    Effect.match(Log.append(events), {
      onFailure: (error) => (error as { _tag?: string })._tag ?? "untagged",
      onSuccess: () => "appended",
    }),
  );

const rows = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* sql.unsafe<Record<string, unknown>>(
      `SELECT * FROM ${table} ORDER BY 1`,
    );
  });

test("version 1 and version 2 events decode and project side by side, and rebuild loses none", async () => {
  const fixture = reviewEvents();
  const location = freshLocation();
  await runOn(location, Log.append(fixture.all));
  const read = await runOn(
    location,
    Effect.gen(function* () {
      const report = yield* Admin.rebuild;
      return {
        report,
        history: yield* Log.history({ limit: 1_000 }),
        units: yield* rows("projection_units"),
        dispositions: yield* rows("projection_dispositions"),
        comments: yield* rows("projection_comments"),
        stats: yield* ReviewStats.reviewStats(),
      };
    }),
  );

  expect(read.history.map((stored) => stored.event.id)).toEqual(
    fixture.all.map((event) => event.id),
  );
  expect(read.report.events).toBe(fixture.all.length);
  expect(read.report.afterCombined).toBe(read.report.beforeCombined);
  const rowsOf = (table: string) =>
    read.report.after.find((checksum) => checksum.table === table)?.rows;
  expect(rowsOf("projection_stages")).toBe(2);
  expect(rowsOf("projection_runs")).toBe(1);
  expect(rowsOf("projection_gaps")).toBe(2);
  expect(rowsOf("projection_deliveries")).toBe(2);
  expect(rowsOf("projection_packets")).toBe(1);
  expect(rowsOf("projection_context_references")).toBe(2);

  const [u1, u2, u3] = fixture.units;
  const unit = (id: string) => read.units.find((row) => row["unitId"] === id);
  // The newer version 2 recording of u1 wins over its version 1 recording.
  expect(unit(u1)).toMatchObject({
    title: "Unit one, merged",
    ownedRangeCount: 2,
    groupingAdjustment: "merge",
    lane: "agentic",
    quadrant: null,
  });
  expect(unit(u2)).toMatchObject({
    lane: "human-suggested",
    complexity: "high",
    validationGap: 1,
  });
  expect(unit(u3)).toMatchObject({ quadrant: "high-hard", validationGap: 0 });
  expect(
    read.dispositions.map((row) => [row["unitId"], row["restsOnCount"]]),
  ).toEqual(
    expect.arrayContaining([
      [u1, null],
      [u2, 1],
      [u3, 0],
    ]),
  );

  expect(read.stats.signals).toEqual({
    forged: 1,
    testBloat: 1,
    untested: 0,
    staleProof: 0,
  });
  expect(read.stats.highComplexityValidationGapHumanSuggested).toBe(1);
  expect(read.stats.grouping).toEqual({
    byGapLines: [{ gapLines: 20, units: 3 }],
    merges: 1,
    splits: 0,
  });
  expect(read.stats.runs[0]).toMatchObject({
    runId: fixture.runId,
    // Counted from the run's own stage and gap events, not from the receipt's lists.
    stageCount: 2,
    gapCount: 2,
    unitCount10: 4,
    unitCount20: 3,
    unitCount40: 2,
  });
  const uncited = read.stats.agentDispositions.find(
    (row: ReviewStats.AgentDispositionCount) =>
      row.verdict === "request-changes" && row.lane === "human-required",
  );
  expect(uncited).toMatchObject({ dispositions: 1, uncited: 1 });
  const approvals = read.stats.agentDispositions.find(
    (row: ReviewStats.AgentDispositionCount) => row.verdict === "approve",
  );
  // A version 1 approval cannot name proof, so it is counted apart, not as without proof.
  expect(approvals).toMatchObject({
    lane: "agentic",
    withoutProof: 0,
    version1: 1,
  });
});

test("version 1 and version 2 recordings of a unit project the same rows in either order", async () => {
  const fixture = reviewEvents();
  const [, , unitV1, unitV2] = fixture.structure;
  const rest = fixture.all.filter(
    (event) => event !== unitV1 && event !== unitV2,
  );
  const checksum = Effect.map(Admin.rebuild, (report) => ({
    verified: report.afterCombined === report.beforeCombined,
    combined: report.afterCombined,
  }));

  const forward = freshLocation();
  await runOn(forward, Log.append(fixture.all));
  const reversed = freshLocation();
  // The newer version 2 recording first, then the older version 1 one, each in its own transaction.
  await runOn(reversed, Log.append([unitV2]));
  await runOn(reversed, Log.append([unitV1]));
  await runOn(reversed, Log.append(rest));

  const one = await runOn(forward, checksum);
  const two = await runOn(reversed, checksum);
  expect(one.verified).toBe(true);
  expect(two).toEqual(one);
});

test("a request for changes rests only on comments on its own unit and cycle", async () => {
  const fixture = reviewEvents();
  const location = freshLocation();
  const before = fixture.all.filter(
    (event) => event !== fixture.dispositions.cited,
  );
  await runOn(location, Log.append(before));
  const cited = fixture.dispositions.cited;
  // Resting on a comment recorded on another unit, and on an ID that is no comment at all.
  const otherUnit = {
    ...cited,
    id: mintUlid(),
    idempotencyKey: "disposition:other-unit",
    payload: {
      ...(cited.payload as object),
      restsOn: [fixture.comments.plain.id],
    },
  };
  const notAComment = {
    ...cited,
    id: mintUlid(),
    idempotencyKey: "disposition:not-a-comment",
    payload: { ...(cited.payload as object), restsOn: [fixture.packet.id] },
  };
  expect(await appendOutcome(location, [otherUnit])).toBe(
    "WorkflowRuleViolation",
  );
  expect(await appendOutcome(location, [notAComment])).toBe(
    "WorkflowRuleViolation",
  );
  // A retry that mints fresh IDs for the comment and the disposition still links to the stored comment.
  const retriedComment = { ...fixture.comments.defect, id: mintUlid() };
  const retried = {
    ...cited,
    id: mintUlid(),
    payload: { ...(cited.payload as object), restsOn: [retriedComment.id] },
  };
  const results = await runOn(location, Log.append([retriedComment, retried]));
  expect(results.map((result) => result.status)).toEqual([
    "existing",
    "appended",
  ]);
  const stored = await runOn(location, Log.get(results[1]!.id));
  expect(
    stored._tag === "Some" &&
      stored.value.event.kind === "disposition.recorded@2"
      ? stored.value.event.payload.restsOn
      : [],
  ).toEqual([fixture.comments.defect.id]);
});

test("the new versions refuse inconsistent records and payloads over the cap", async () => {
  const fixture = reviewEvents();
  const location = freshLocation();
  await runOn(location, Log.append(fixture.all));
  const [, u2] = fixture.units;
  const assessment = fixture.structure.find(
    (event) => event.kind === "assessment.recorded@2",
  )!;
  const tags = await Promise.all(
    [
      // A quadrant that does not match the axis levels.
      {
        ...assessment,
        id: mintUlid(),
        idempotencyKey: "assessment:mismatch",
        payload: { ...(assessment.payload as object), quadrant: "low-easy" },
      },
      // An approval that names comments it rests on.
      {
        ...fixture.dispositions.cited,
        id: mintUlid(),
        idempotencyKey: "disposition:approval-resting",
        payload: {
          ...(fixture.dispositions.cited.payload as object),
          verdict: "approve",
        },
      },
      // A forged-evidence sign on a risk: forged or bogus evidence is a defect (10.63).
      {
        ...fixture.comments.bloat,
        id: mintUlid(),
        idempotencyKey: "comment:forged-risk",
        payload: {
          body: "Forged, but only a risk?",
          finding: {
            kind: "risk",
            about: "tests",
            signal: "forged",
            evidence: [],
          },
        },
      },
      // A batch digest that names a unit.
      {
        ...fixture.delivery[0]!,
        id: mintUlid(),
        idempotencyKey: "delivery:digest-with-unit",
        attribution: {
          ...(fixture.delivery[0]!.attribution as object),
          unitIds: [u2],
        },
      },
      // A receipt past the 64 KB payload cap: it goes by reference, never inline.
      {
        ...fixture.telemetry.at(-1)!,
        id: mintUlid(),
        idempotencyKey: "review:big:run.completed",
        payload: receipt("f".repeat(64), 40),
      },
    ].map((event) => appendOutcome(location, [event])),
  );
  expect(tags).toEqual([
    "InvalidEvent",
    "InvalidEvent",
    "InvalidEvent",
    "InvalidEvent",
    "PayloadTooLarge",
  ]);
});

test("the largest assessment the schema accepts fits the payload cap", async () => {
  const fixture = reviewEvents();
  const location = freshLocation();
  await runOn(location, Log.append(fixture.all));
  // Every count and length at its bound, text in a 3-byte character (the most a character can take
  // once control characters are refused), and every citation at its longest.
  const text = (length: number) => "語".repeat(length);
  const cites = Array.from({ length: 6 }, () => ({
    ref: `computation:${"c".repeat(64)}`,
    entry: "e".repeat(128),
  }));
  const assessment = fixture.structure.find(
    (event) => event.kind === "assessment.recorded@2",
  )!;
  const largest = {
    ...assessment,
    id: mintUlid(),
    idempotencyKey: "assessment:largest",
    payload: {
      lane: "human-required",
      quadrant: "high-hard",
      complexity: {
        level: "high",
        factors: Array.from({ length: 8 }, () => ({
          factor: `f${"x".repeat(63)}`,
          finding: text(300),
          cites,
        })),
      },
      easeOfValidation: {
        level: "hard",
        requirements: Array.from({ length: 8 }, () => ({
          requirement: text(300),
          cites,
          coverage: "shallow",
          proof: Array.from({ length: 8 }, () => mintUlid()),
        })),
      },
      movement: Array.from({ length: 6 }, () => ({
        signal: "blast-radius",
        finding: text(300),
        axis: "ease-of-validation",
        direction: "away-from-human",
        cites,
      })),
      lean: { lane: "human-suggested", reason: text(300) },
      gaps: Array.from({ length: 6 }, () => ({
        axis: "ease-of-validation",
        kind: `g${"x".repeat(63)}`,
        detail: text(300),
      })),
      rationale: text(1_000),
    },
  };
  const bytes = new TextEncoder().encode(canonicalJson(largest.payload)).length;
  expect(bytes).toBeLessThanOrEqual(PAYLOAD_MAX_BYTES);
  expect(await appendOutcome(location, [largest])).toBe("appended");
  // One more character in any field is refused by the schema, never by the cap.
  const over = {
    ...largest,
    id: mintUlid(),
    idempotencyKey: "assessment:over",
    payload: { ...largest.payload, rationale: text(1_001) },
  };
  expect(await appendOutcome(location, [over])).toBe("InvalidEvent");
});

// Why (11.17): version 3 adds each checkpoint's kinds, agreement, anchors and sources to the same
// 64 KB payload, with 96 bytes to spare at every bound; a bound loosened later would make Publish's
// largest assessment unrecordable, and only measuring it shows that.
test("the largest version 3 assessment the schema accepts fits the payload cap", async () => {
  const fixture = reviewEvents();
  const location = freshLocation();
  await runOn(location, Log.append(fixture.all));
  const text = (length: number) => "語".repeat(length);
  const cites = Array.from({ length: 6 }, () => ({
    ref: `computation:${"c".repeat(64)}`,
    entry: "e".repeat(128),
  }));
  const assessment = fixture.structure.find(
    (event) => event.kind === "assessment.recorded@2",
  )!;
  const largest = {
    ...assessment,
    id: mintUlid(),
    kind: "assessment.recorded@3",
    idempotencyKey: "assessment:largest-v3",
    payload: {
      lane: "human-required",
      quadrant: "high-hard",
      complexity: {
        level: "high",
        factors: Array.from({ length: 8 }, () => ({
          factor: `f${"x".repeat(63)}`,
          finding: text(300),
          cites,
        })),
      },
      easeOfValidation: {
        level: "hard",
        requirements: Array.from({ length: 8 }, () => ({
          requirement: text(300),
          cites,
          coverage: "shallow",
          proof: Array.from({ length: 8 }, () => mintUlid()),
          kinds: [
            "static-analysis",
            "test-run",
            "telemetry",
            "log",
            "screenshot",
            "video",
          ],
          agree: false,
          testable: false,
          anchors: [1016, 1017, 1018, 1019, 1020, 1021, 1022, 1023],
          sources: ["Rabcdef014", "Rabcdef015", "Rabcdef016", "Rabcdef017"],
        })),
      },
      movement: Array.from({ length: 6 }, () => ({
        signal: "blast-radius",
        finding: text(300),
        axis: "ease-of-validation",
        direction: "away-from-human",
        cites,
      })),
      lean: { lane: "human-suggested", reason: text(300) },
      gaps: Array.from({ length: 6 }, () => ({
        axis: "ease-of-validation",
        kind: `g${"x".repeat(63)}`,
        detail: text(300),
      })),
      rationale: text(1_000),
    },
  };
  const bytes = new TextEncoder().encode(canonicalJson(largest.payload)).length;
  if (process.env["PRINT_BYTES"] === "1") console.log("v3 bytes", bytes);
  expect(bytes).toBeLessThanOrEqual(PAYLOAD_MAX_BYTES);
  expect(await appendOutcome(location, [largest])).toBe("appended");
  // A fifth source, or a ninth anchor, is refused by the schema, never by the cap.
  const over = (requirement: Record<string, unknown>) => ({
    ...largest,
    id: mintUlid(),
    idempotencyKey: `assessment:over-v3:${mintUlid()}`,
    payload: {
      ...largest.payload,
      easeOfValidation: {
        ...largest.payload.easeOfValidation,
        requirements: [
          {
            ...largest.payload.easeOfValidation.requirements[0]!,
            ...requirement,
          },
        ],
      },
    },
  });
  expect(
    await appendOutcome(location, [
      over({ sources: ["R1", "R2", "R3", "R4", "R5"] }),
    ]),
  ).toBe("InvalidEvent");
  expect(
    await appendOutcome(location, [
      over({ anchors: [0, 1, 2, 3, 4, 5, 6, 7, 8] }),
    ]),
  ).toBe("InvalidEvent");
});
