// Why: cross-boundary observations must survive native/capture removal without modifying frozen
// packages or dispositions; crash replay and verification updates must retain original attribution.
import { afterAll, expect, test } from "bun:test";
import { Effect } from "effect";
import type { FileSystem } from "effect/FileSystem";
import { SqlClient } from "effect/sql/SqlClient";
import { Blobs, ReviewInformation, mintUlid } from "../src/index.ts";
import { freshLocation, removeTemporaryDirectories, runOn } from "./support.ts";

afterAll(removeTemporaryDirectories);
const input = (cycleId = mintUlid()): ReviewInformation.InformationInput => ({
  cycleId,
  runKey: "a".repeat(64),
  runId: "draining-run",
  claim: "cross-boundary-claim",
  producer: { assignment: "original-assignment", task: 2 },
  report: {
    text: "Caller accepts a revoked token",
    references: ["caller.ts:4", "auth.ts:9"],
  },
  source: {
    cycle: cycleId,
    run: "original-run",
    head: "b".repeat(40),
    basis: { source: "committed" },
  },
  anchor: { path: "auth.ts", side: "old", startLine: 9, endLine: 10 },
  destination: {
    kind: "owned",
    assignmentId: "destination",
    sectionKey: "c".repeat(64),
    batchId: "batch-b",
  },
  verify: { task: 3, computation: "d".repeat(64), outcome: "unconfirmed" },
  classification: "later-review-information",
});

const on = <A, E>(
  location: ReturnType<typeof freshLocation>,
  program: Effect.Effect<A, E, SqlClient | FileSystem | Blobs.BlobStore>,
) => runOn(location, program.pipe(Effect.provide(Blobs.layer(location))));

test("late facts reopen durably, replay once across drains, and verification is information not a disposition", async () => {
  const location = freshLocation();
  const fact = input();
  const first = await on(location, ReviewInformation.record(fact));
  const result = await on(
    location,
    Effect.gen(function* () {
      const replay = yield* ReviewInformation.record({
        ...fact,
        runId: "later-draining-host",
      });
      const checked = yield* ReviewInformation.record({
        ...fact,
        verify: { ...fact.verify, outcome: "confirmed" },
      });
      const page = yield* ReviewInformation.read({
        cycleId: fact.cycleId,
        runKey: fact.runKey,
      });
      const sql = yield* SqlClient;
      const [row] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM events
      WHERE kind IN ('disposition.recorded@1', 'disposition.recorded@2', 'packet.published@1', 'packet.published@2', 'comment.recorded@3')`;
      return { replay, checked, page, decisions: row!.n };
    }),
  );
  expect(result.replay).toMatchObject({ status: "existing", id: first.id });
  expect(result.checked.id).not.toBe(first.id);
  expect(result.decisions).toBe(0);
  expect(result.page.items).toHaveLength(2);
  expect(result.page.items[0]!.event.payload.producer).toEqual(fact.producer);
  expect(result.page.items[0]!.event.attribution.runId).toBe("draining-run");
  expect(result.page.items[0]!.details).toEqual({
    status: "available",
    value: { report: fact.report, source: fact.source },
  });
  expect(
    result.page.items.map((row) => row.event.payload.verify.outcome),
  ).toEqual(["unconfirmed", "confirmed"]);
  // Retained source/report are durable, never a 30-day raw capture.
  const retention = await on(
    location,
    Effect.gen(function* () {
      const blobs = yield* Blobs.BlobStore;
      const pruned = yield* blobs.prune({
        cutoff: "2099-01-01T00:00:00.000Z",
        limit: 100,
      });
      return {
        pruned,
        page: yield* ReviewInformation.read({
          cycleId: fact.cycleId,
          runKey: fact.runKey,
        }),
      };
    }),
  );
  expect(
    retention.page.items.every((row) => row.details.status === "available"),
  ).toBe(true);
});

test("unknown ownership stays visible, pages disclose remaining facts, and source/run isolation holds", async () => {
  const location = freshLocation();
  const fact = input();
  const page = await on(
    location,
    Effect.gen(function* () {
      yield* ReviewInformation.record({
        ...fact,
        destination: {
          kind: "unassigned",
          reason: "No changed section owns the primary anchor",
          sectionKeys: [],
        },
        classification: "unknown-ownership",
      });
      yield* ReviewInformation.record({ ...fact, claim: "second" });
      const first = yield* ReviewInformation.read({
        cycleId: fact.cycleId,
        runKey: fact.runKey,
        limit: 1,
      });
      const second = yield* ReviewInformation.read({
        cycleId: fact.cycleId,
        runKey: fact.runKey,
        afterSeq: first.nextSeq,
        limit: 1,
      });
      const other = yield* ReviewInformation.read({
        cycleId: mintUlid(),
        runKey: fact.runKey,
      });
      return { first, second, other };
    }),
  );
  expect(page.first.hasMore).toBe(true);
  expect(page.first.items[0]!.event.payload.destination.kind).toBe(
    "unassigned",
  );
  expect(page.first.items[0]!.event.payload.classification).toBe(
    "unknown-ownership",
  );
  expect(page.second.items[0]!.event.payload.claim).toBe("second");
  expect(page.second.hasMore).toBe(false);
  expect(page.other.items).toEqual([]);
});

test("invalid anchors and oversized detail refuse retention, never manufacture a reviewed outcome", async () => {
  const location = freshLocation();
  const fact = input();
  const refused = await on(
    location,
    Effect.gen(function* () {
      const invalid = yield* Effect.result(
        ReviewInformation.record({
          ...fact,
          anchor: { ...fact.anchor, endLine: 1 },
        }),
      );
      const large = yield* Effect.result(
        ReviewInformation.record({
          ...fact,
          report: { text: "x".repeat(1_048_577) },
        }),
      );
      return {
        invalid,
        large,
        page: yield* ReviewInformation.read({
          cycleId: fact.cycleId,
          runKey: fact.runKey,
        }),
      };
    }),
  );
  expect(refused.invalid._tag).toBe("Failure");
  expect(refused.large._tag).toBe("Failure");
  expect(refused.page.items).toEqual([]);
});

test("bounded projection does not load oversized details, while full original facts remain durably readable", async () => {
  const location = freshLocation();
  const fact = { ...input(), report: { references: Array(30_000).fill(0) } };
  const result = await on(
    location,
    Effect.gen(function* () {
      yield* ReviewInformation.record(fact);
      const bounded = yield* ReviewInformation.read({
        cycleId: fact.cycleId,
        runKey: fact.runKey,
        detailsBytes: 1_000,
      });
      const full = yield* ReviewInformation.read({
        cycleId: fact.cycleId,
        runKey: fact.runKey,
        detailsBytes: 100_000,
      });
      return { bounded, full };
    }),
  );
  expect(result.bounded.items[0]!.details).toMatchObject({
    status: "unavailable",
    reason: expect.stringContaining("omitted from this bounded view"),
  });
  expect(result.full.items[0]!.details).toEqual({
    status: "available",
    value: { report: fact.report, source: fact.source },
  });
  expect(result.bounded.items[0]!.event.payload.details).toBe(
    result.full.items[0]!.event.payload.details,
  );
});

test("concurrent drains join one immutable information fact", async () => {
  const location = freshLocation();
  const fact = input();
  const result = await on(
    location,
    Effect.gen(function* () {
      const writes = yield* Effect.all(
        Array.from({ length: 6 }, (_, i) =>
          ReviewInformation.record({ ...fact, runId: `drain-${i}` }),
        ),
        { concurrency: "unbounded" },
      );
      const page = yield* ReviewInformation.read({
        cycleId: fact.cycleId,
        runKey: fact.runKey,
      });
      return { writes, page };
    }),
  );
  expect(new Set(result.writes.map((write) => write.id)).size).toBe(1);
  expect(
    result.writes.filter((write) => write.status === "appended"),
  ).toHaveLength(1);
  expect(result.page.items).toHaveLength(1);
  expect(result.page.items[0]!.event.payload.producer).toEqual(fact.producer);
});
