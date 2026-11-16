import { SqlClient } from "effect/sql/SqlClient";
// Why (12.35, 8.19): carried claims must support correction/retraction without changing old readers'
// shared projections. Their findings and dispositions must remain present in review statistics.
import { afterAll, expect, test } from "bun:test";
import { RecordEvent } from "@neuve/records-schema";
import { Effect } from "effect";
import {
  Admin,
  Dispositions,
  Log,
  ReviewStats,
  mintUlid,
} from "../src/index.ts";
import {
  actor,
  cycleEvents,
  freshLocation,
  headOid,
  removeTemporaryDirectories,
  runOn,
} from "./support.ts";

afterAll(removeTemporaryDirectories);
const from = {
  review: "earlier",
  cycle: mintUlid(),
  head: headOid,
  judgement: "a".repeat(64),
  output: "b".repeat(64),
  savedMs: 100,
};

test("carried claims can be superseded by fresh, carried and retracted records", async () => {
  const location = freshLocation();
  const data = cycleEvents(1);
  const opened = RecordEvent.parse(data.events[0]);
  if (opened.kind !== "cycle.opened@1")
    throw new Error("fixture must open a cycle");
  const cycleId = opened.attribution.cycleId;
  const attribution = { cycleId, unitIds: data.unitIds };
  const next = (kind: string, supersedes: string, payload: unknown) => ({
    id: mintUlid(),
    kind,
    actor,
    occurredAt: new Date().toISOString(),
    idempotencyKey: mintUlid(),
    causation: { supersedes },
    attribution,
    payload,
  });
  const result = await runOn(
    location,
    Effect.gen(function* () {
      yield* Log.append(data.events);
      const payload = {
        verdict: "approve",
        reviewedHeadOid: headOid,
        restsOn: [],
        proof: [],
      };
      const carried = next("disposition.carried@1", data.events.at(-1)!.id, {
        ...payload,
        lineage: "carried",
        from,
      });
      yield* Log.append([carried]);
      const first = yield* Dispositions.current({ cycleId });
      const fresh = next("disposition.recorded@2", carried.id, payload);
      yield* Log.append([fresh]);
      const second = yield* Dispositions.current({ cycleId });
      const again = next("disposition.carried@1", fresh.id, {
        ...payload,
        lineage: "carried",
        from,
      });
      yield* Log.append([again]);
      const third = yield* Dispositions.current({ cycleId });
      yield* Log.append([
        next("disposition.retracted@1", again.id, {
          reason: "Correcting the claim",
        }),
      ]);
      const retracted = yield* Dispositions.current({ cycleId });
      const checks = yield* Admin.fsck(location);
      return {
        ids: [first[0]?.eventId, second[0]?.eventId, third[0]?.eventId],
        expected: [carried.id, fresh.id, again.id],
        retracted,
        checks,
      };
    }),
  );
  expect(result.ids).toEqual(result.expected);
  expect(result.retracted).toEqual([]);
  expect(result.checks.filter((check) => check.status !== "ok")).toEqual([]);
});

test("review statistics include log-only carried dispositions and findings", async () => {
  const location = freshLocation();
  const data = cycleEvents(1);
  const opened = RecordEvent.parse(data.events[0]);
  if (opened.kind !== "cycle.opened@1")
    throw new Error("fixture must open a cycle");
  const cycleId = opened.attribution.cycleId;
  const attribution = { cycleId, unitIds: data.unitIds };
  const comment = {
    id: mintUlid(),
    kind: "comment.carried@1",
    actor,
    occurredAt: new Date().toISOString(),
    idempotencyKey: mintUlid(),
    attribution,
    payload: {
      body: "Synthetic carried defect",
      finding: { kind: "defect", about: "code", evidence: [] },
      lineage: "carried",
      from,
    },
  };
  const result = await runOn(
    location,
    Effect.gen(function* () {
      yield* Log.append([
        {
          id: mintUlid(),
          kind: "actor.registered@1",
          actor,
          occurredAt: new Date().toISOString(),
          idempotencyKey: mintUlid(),
          payload: {
            actorKind: "agent",
            harness: "test",
            sessionId: "session",
          },
        },
        ...data.events,
        comment,
        {
          id: mintUlid(),
          kind: "disposition.carried@1",
          actor,
          occurredAt: new Date().toISOString(),
          idempotencyKey: mintUlid(),
          attribution,
          causation: { supersedes: data.events.at(-1)!.id },
          payload: {
            verdict: "request-changes",
            reviewedHeadOid: headOid,
            restsOn: [comment.id],
            proof: [],
            lineage: "carried",
            from,
          },
        },
      ]);
      return yield* ReviewStats.reviewStats({ cycleId });
    }),
  );
  expect(
    result.agentDispositions.map((row) => [row.verdict, row.dispositions]),
  ).toEqual([["request-changes", 1]]);
  expect(
    result.findings.map((row) => [row.kind, row.about, row.comments]),
  ).toEqual([["defect", "code", 1]]);
});

// Why (8.19): even an optional supersession must not let a log-only kind alter old projections.
test("judgement telemetry with causation leaves shared projections unchanged", async () => {
  const location = freshLocation();
  const data = cycleEvents(1);
  const opened = RecordEvent.parse(data.events[0]);
  if (opened.kind !== "cycle.opened@1")
    throw new Error("fixture must open a cycle");
  const result = await runOn(
    location,
    Effect.gen(function* () {
      yield* Log.append(data.events);
      yield* Log.append([
        {
          id: mintUlid(),
          kind: "judgement.counted@1",
          actor,
          occurredAt: new Date().toISOString(),
          idempotencyKey: mintUlid(),
          attribution: {
            cycleId: opened.attribution.cycleId,
            range: opened.attribution.range,
            runId: "fixture",
          },
          causation: { supersedes: data.events.at(-1)!.id },
          payload: {
            fresh: 0,
            carried: 0,
            shadowChecked: 0,
            shadowAgreed: 0,
            savedSeconds: 0,
          },
        },
      ]);
      const sql = yield* SqlClient;
      return yield* sql<{
        n: number;
      }>`SELECT count(*) AS n FROM projection_supersessions`;
    }),
  );
  expect(result[0]?.n).toBe(0);
});
