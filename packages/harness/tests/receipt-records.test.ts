// Why (H4): Records is now the source of truth for the run receipt (10.32), so two failures would
// be silent: a receipt too large for the 64 KB payload cap that fails every Publish (and so the
// job), and a replayed Publish whose new timings conflict with the receipt already recorded. This
// pins that a large receipt goes by reference and reads back whole, that a small one stays inline,
// and that a replay keeps the first receipt instead of failing.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer, Option } from "effect";
import {
  Blobs,
  ReviewStats,
  Store,
  Log,
  canonicalJson,
  mintUlid,
  storeLocationIn,
} from "@neuve/records-core";
import {
  PAYLOAD_MAX_BYTES,
  ReceiptLists,
  RunReceipt,
} from "@neuve/records-schema";
import { defaultConfig } from "../src/config.ts";
import type { StageRecord } from "../src/pipeline.ts";
import {
  buildReceipt,
  formatReceipt,
  receiptFromEvent,
  recordReceipt,
  stageTelemetry,
} from "../src/receipt.ts";
import { SOL_ROUTE } from "../src/route.ts";

import { type RunLogRecord, openRunLog } from "../src/run-log.ts";

const directory = mkdtempSync(join(tmpdir(), "harness-receipt-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const location = storeLocationIn(directory);

const run = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.runPromise(
    Effect.andThen(Store.prepareForWrite, program).pipe(
      Effect.provide(
        Blobs.layer(location).pipe(
          Layer.provideMerge(Store.layer(location, { create: true })),
        ),
      ),
      Effect.provide(BunFileSystem.layer),
    ) as Effect.Effect<A, E, never>,
  );

const receiptFor = (
  runId: string,
  stages: number,
  endedAt: number,
  config = defaultConfig(),
  records: ReadonlyArray<RunLogRecord> = [],
) =>
  buildReceipt({
    runId,
    runKey: "f".repeat(64),
    generation: 0,
    jobSeq: 1,
    range: {
      baseRef: "main",
      baseOid: "b".repeat(40),
      headOid: "a".repeat(40),
    },
    cycleId: mintUlid(),
    config,
    enqueuedAt: new Date(1_000).toISOString(),
    startedAt: 2_000,
    endedAt,
    stages: Array.from({ length: stages }, (_, index): StageRecord => ({
      stage: "find",
      agent: `investigate.p${index + 1}`,
      status: "computed",
      wallMs: 1_000,
      note: "n".repeat(1_000),
    })),
    records,
  });

const readBack = (runId: string) =>
  Effect.gen(function* () {
    const stored = Option.getOrThrow(yield* ReviewStats.runReceipt(runId));
    const event = stored.event;
    if (event.kind !== "run.completed@1") throw new Error(event.kind);
    const blobs = yield* Blobs.BlobStore;
    const receipt = yield* receiptFromEvent(event, (hash) =>
      Effect.map(blobs.get(hash), (read) =>
        ReceiptLists.parse(
          JSON.parse(
            new TextDecoder().decode(
              read._tag === "Present" ? read.bytes : new Uint8Array(),
            ),
          ),
        ),
      ),
    );
    return {
      receipt,
      payloadBytes: new TextEncoder().encode(canonicalJson(event.payload))
        .length,
      refs: event.refs?.length ?? 0,
    };
  });

test("a receipt past the payload cap goes by reference and reads back whole; a small one stays inline", async () => {
  const large = receiptFor(mintUlid(), 120, 60_000);
  const small = receiptFor(mintUlid(), 2, 60_000);
  const [bigRead, smallRead] = await run(
    Effect.gen(function* () {
      yield* recordReceipt(openRunLog(location, large.runId), large);
      yield* recordReceipt(openRunLog(location, small.runId), small);
      return [yield* readBack(large.runId), yield* readBack(small.runId)];
    }),
  );
  expect(new TextEncoder().encode(canonicalJson(large)).length).toBeGreaterThan(
    PAYLOAD_MAX_BYTES,
  );
  expect(bigRead!.payloadBytes).toBeLessThanOrEqual(PAYLOAD_MAX_BYTES);
  expect(bigRead!.refs).toBe(1);
  const { listsByReference, ...restored } = bigRead!.receipt;
  expect(listsByReference?.stages).toBe(120);
  expect(restored).toEqual(large);
  expect(smallRead!.refs).toBe(0);
  expect(smallRead!.receipt).toEqual(small);
});

// Why (10.95): a timed-out run over a large range disclosed 320 gaps. Its payload went by reference
// for size, but the lists blob was written unchecked and read back against the inline cap of 256,
// so the run could not be shown. Lists past an inline cap now go to the blob even when the payload
// would fit, and the blob reads back whole.
test("lists past the event's inline caps go by reference and read back whole", async () => {
  const runId = mintUlid();
  const receipt = {
    ...receiptFor(runId, 2, 60_000),
    gaps: Array.from({ length: 320 }, (_, index) => ({
      stage: "verify",
      kind: "review-gap",
      detail: `u${index}`,
    })),
  };
  expect(
    new TextEncoder().encode(canonicalJson(receipt)).length,
  ).toBeLessThanOrEqual(PAYLOAD_MAX_BYTES);
  expect(RunReceipt.safeParse(receipt).success).toBe(false);
  const read = await run(
    Effect.gen(function* () {
      yield* recordReceipt(openRunLog(location, runId), receipt);
      return yield* readBack(runId);
    }),
  );
  expect(read.refs).toBe(1);
  const { listsByReference, ...restored } = read.receipt;
  expect(listsByReference?.gaps).toBe(320);
  expect(restored).toEqual(receipt);
});

test("a replayed Publish keeps the receipt already recorded", async () => {
  const runId = mintUlid();
  const first = receiptFor(runId, 2, 60_000);
  const replay = { ...receiptFor(runId, 2, 61_000), cycleId: first.cycleId };
  const log = openRunLog(location, runId);
  const read = await run(
    Effect.gen(function* () {
      yield* recordReceipt(log, first);
      yield* recordReceipt(log, replay);
      return yield* readBack(runId);
    }),
  );
  expect(read.receipt.timing.endedAt).toBe(first.timing.endedAt);
  expect(
    log
      .read()
      .filter((record) => record.type === "records")
      .map((record) => record["status"]),
  ).toEqual(["appended", "kept-earlier", "kept-earlier"]);
});

// Why (10.85): the OpenAI route's receipt names the Neuve sign-in instead of a key variable and has
// no USD cost. Records must hold both as they are (exactly one credential named; cost null, never
// 0) through the event, its projection and the printed receipt, or a plan run reads as free.
test("an OpenAI-route receipt records the sign-in and an unknown cost, never 0 USD", async () => {
  const runId = mintUlid();
  const receipt = receiptFor(
    runId,
    2,
    60_000,
    defaultConfig(undefined, SOL_ROUTE),
  );
  expect(receipt.route).toMatchObject({ credentialSource: "neuve-sign-in" });
  expect(receipt.route).not.toHaveProperty("credentialVariable");
  expect(receipt.totals.costUsd).toBeNull();
  const { read, stats } = await run(
    Effect.gen(function* () {
      yield* recordReceipt(openRunLog(location, runId), receipt);
      const read = yield* readBack(runId);
      const stats = yield* ReviewStats.reviewStats({
        cycleId: receipt.cycleId,
      });
      return { read, stats };
    }),
  );
  expect(read.receipt).toEqual(receipt);
  expect(stats.runs.find((r) => r.runId === runId)?.costMicroUsd).toBeNull();
  expect(formatReceipt(read.receipt)).toContain(
    "USD unknown (ChatGPT plan usage)",
  );
  expect(formatReceipt(read.receipt)).toContain("the Neuve sign-in");
  // A receipt names exactly one credential.
  const both = {
    ...receipt,
    route: { ...receipt.route, credentialVariable: "X_KEY" },
  };
  const { credentialSource: _source, ...neither } = receipt.route as Record<
    string,
    unknown
  >;
  const {
    runId: _r,
    range: _g,
    cycleId: _c,
    type: _t,
    ...payload
  } = receipt as Record<string, unknown>;
  expect(RunReceipt.safeParse({ ...payload, route: both.route }).success).toBe(
    false,
  );
  expect(RunReceipt.safeParse({ ...payload, route: neither }).success).toBe(
    false,
  );
  expect(RunReceipt.safeParse(payload).success).toBe(true);
});

// Failure attempts must not change the established completed-call field.
test("receipts keep completed calls separate from failed and aborted attempts", async () => {
  const records = ["toolUse", "error", "aborted"].map(
    (finishReason, index) => ({
      type: "model.call",
      call: String(index),
      agent: "investigate.p1",
      stage: "find",
      finishReason,
      usage: {
        input: 10 * 10 ** index,
        output: 2 * 10 ** index,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        cacheRead: 0,
      },
    }),
  );
  const receipt = receiptFor(mintUlid(), 1, 60000, defaultConfig(), records);
  expect(receipt.totals).toMatchObject({
    modelCalls: 1,
    failedModelCalls: 1,
    abortedModelCalls: 1,
  });
  expect(receipt.stages[0]).toMatchObject({
    modelCalls: 1,
    failedModelCalls: 1,
    abortedModelCalls: 1,
  });
  expect(receipt.totals.usage).toMatchObject({ input: 10, output: 2 });
  expect(receipt.stages[0]?.usage).toMatchObject({ input: 10, output: 2 });
  expect(receipt.totals).toMatchObject({
    costUsd: 0.00008,
    failedUsage: { input: 100, output: 20 },
    failedCostUsd: 0.0008,
    abortedUsage: { input: 1000, output: 200 },
    abortedCostUsd: 0.008,
  });
  const stored = await run(
    Effect.gen(function* () {
      yield* recordReceipt(openRunLog(location, receipt.runId), receipt);
      return {
        receipt: yield* readBack(receipt.runId),
        counters: yield* Log.history({ kind: "model.calls-counted@2" }),
      };
    }),
  );
  expect(stored.receipt.receipt.totals.modelCalls).toBe(1);
  expect(stored.receipt.receipt.totals).not.toHaveProperty("failedModelCalls");
  expect(stored.receipt.receipt.totals.usage).toMatchObject({
    input: 10,
    output: 2,
  });
  expect(stored.receipt.receipt.totals.costUsd).toBe(0.00008);
  expect(stored.counters.map((row) => row.event.payload)).toContainEqual(
    expect.objectContaining({
      modelCalls: 1,
      failedModelCalls: 1,
      abortedModelCalls: 1,
      failedUsage: expect.objectContaining({ input: 100, output: 20 }),
      failedCostUsd: 0.0008,
      abortedUsage: expect.objectContaining({ input: 1000, output: 200 }),
      abortedCostUsd: 0.008,
    }),
  );
});

// Why: old frozen requests must report the same effective cutoff that gates model work.
test("a receipt reserves publication time for an older frozen cutoff", () => {
  const config = defaultConfig();
  const receipt = receiptFor(mintUlid(), 0, 600_000, {
    ...config,
    budgets: { ...config.budgets, cutoffMs: 585_000 },
  });
  expect(receipt.timeout.cutoffAt).toBe(new Date(552_000).toISOString());
});

test("receipt reports observed provider limits and the recovery floor instead of configured eight", () => {
  const receipt = receiptFor(mintUlid(), 0, 3000, defaultConfig(), [
    { type: "budget.receipt", limit: 4, floor: 1 },
    { type: "budget.receipt", limit: 16, floor: 0 },
  ]);
  expect(receipt.route.callsInFlight).toBe(16);
  expect(receipt.route.callsInFlightMin).toBe(4);
  expect(receipt.route.callsInFlightMax).toBe(16);
  expect(receipt.route.budgetFloor).toBe(true);
  expect(formatReceipt(receipt)).toContain("recovery floor used");
});

// The reported defect crosses the log and the exact receipt path used by review show.
test("a newer run.completed route reads through the log and receipt without changing stored bytes", async () => {
  const { SqlClient } = await import("effect/sql/SqlClient");
  const { fingerprintOf } = await import("../../records-core/src/codec.ts");
  const { RecordEvent } = await import("@neuve/records-schema");
  const receipt = receiptFor(mintUlid(), 1, 60_000);
  const { type: _type, runId, range, cycleId, ...payload } = receipt;
  const event = RecordEvent.parse({
    id: mintUlid(),
    kind: "run.completed@1",
    idempotencyKey: `newer-receipt:${runId}`,
    actor: "a".repeat(64),
    occurredAt: "2026-11-01T12:00:00.000Z",
    attribution: { runId, range, cycleId, stage: "publish" },
    payload,
  });
  const stored = canonicalJson({
    ...event,
    payload: {
      ...payload,
      route: {
        ...payload.route,
        futureCallsInFlightMin: 1,
        futureCallsInFlightMax: 8,
        futureConfiguredCallsInFlight: 4,
      },
    },
  });
  const result = await run(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const [row] = yield* sql<{
        seq: number;
      }>`INSERT INTO events ${sql.insert({ id: event.id, kind: event.kind, idempotency_key: event.idempotencyKey, actor_id: event.actor, occurred_at: event.occurredAt, recorded_at: event.occurredAt, envelope: stored, fingerprint: fingerprintOf(JSON.parse(stored)) })} RETURNING seq`;
      yield* sql`INSERT INTO event_cycles(event_seq,cycle_id) VALUES(${row!.seq},${cycleId})`;
      const history = yield* Log.history({
        kind: "run.completed@1",
        limit: 1000,
      });
      const read = yield* readBack(runId);
      const [after] = yield* sql<{
        envelope: string;
      }>`SELECT envelope FROM events WHERE id=${event.id}`;
      return { history, read, after };
    }),
  );
  expect(
    result.history.find((row) => row.event.id === event.id)?.event,
  ).toEqual(event);
  expect(result.read.receipt.route).toEqual(receipt.route);
  expect(result.after?.envelope).toBe(stored);
});

// Run logs are deliberately open telemetry objects. A newer worker's fields must remain readable.
test("a receipt consumes a newer run log record with additive fields", () => {
  const { runId } = receiptFor(mintUlid(), 0, 60_000);
  const log = openRunLog(location, runId);
  log.write({
    type: "model.call",
    usage: {
      input: 7,
      output: 3,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      futureUsage: true,
    },
    finishReason: "stop",
    futureTelemetry: true,
  });
  const records = log.read();
  expect(records[0]?.["futureTelemetry"]).toBe(true);
  const receipt = receiptFor(runId, 0, 60_000, defaultConfig(), records);
  expect(receipt.totals.modelCalls).toBe(1);
  expect(receipt.totals.usage.input).toBe(7);
});

// An unused Verify: one its finder started when the finding was recorded, for a claim the finder's
// final list does not hold (finder-task.ts). It is no stage of the review, but its own `stage` row
// is in the run log and its calls are in the totals.
const unusedFixture = (() => {
  const call = (
    agent: string,
    index: number,
    finishReason: "toolUse" | "aborted" | "error" = "toolUse",
  ) => ({
    type: "model.call",
    call: `${agent}:${index}`,
    agent,
    stage: agent.split(".")[0],
    finishReason,
    usage: {
      input: 10,
      output: 2,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 0,
    },
  });
  const find: StageRecord = {
    stage: "find",
    agent: "find.correctness",
    status: "computed",
    wallMs: 3_000,
  };
  const used: StageRecord = {
    stage: "verify",
    agent: "verify.correctness.aaaaaaaa",
    status: "computed",
    key: "1".repeat(64),
    wallMs: 1_000,
  };
  const review = [find, used];
  const runId = mintUlid();
  const cycleId = mintUlid();
  const receiptOf = (records: ReadonlyArray<RunLogRecord>) =>
    buildReceipt({
      runId,
      runKey: "f".repeat(64),
      generation: 0,
      jobSeq: 1,
      range: {
        baseRef: "main",
        baseOid: "b".repeat(40),
        headOid: "a".repeat(40),
      },
      cycleId,
      config: defaultConfig(),
      enqueuedAt: new Date(1_000).toISOString(),
      startedAt: 2_000,
      endedAt: 60_000,
      stages: review,
      records,
    });
  // The review's own rows: Find with one call, the used Verify with one call and its stage row.
  const reviewRecords: RunLogRecord[] = [
    call(find.agent!, 0),
    call(used.agent!, 1),
    { type: "stage", ...used },
  ];
  return { call, find, used, review, receiptOf, reviewRecords };
})();

const NO_BATCH =
  "unit counts at 10, 20 and 40 lines (10.70): no batch was assembled in this run";

/** The evaluation's rule (`packages/evaluation` `executionOf`): every listed stage done. */
const everyRowDone = (receipt: ReturnType<typeof buildReceipt>) =>
  receipt.stages.every(
    (row) => row.status === "computed" || row.status === "reused",
  );

// Why: 497ec87e listed an unused Verify as a row of `stages`. Readers treat every row as a stage of
// the review, so an unused Verify cut off at the deadline turned a completed run "partial" for the
// evaluation and left it out of token ratios. The rule: an unused Verify never changes how a run
// ends, for any reader. So `stages` is exactly the review's stages, interrupted or computed, and
// outcome, timeout and disclosures are those of the review alone; the receipt says once, in
// `notMeasured`, how many Verify steps ran unused and how many model calls of the totals are theirs.
for (const [status, finishReason, attempts] of [
  ["interrupted", "aborted", " (failed attempts: 0, aborted: 1)"],
  ["computed", "toolUse", ""],
] as const)
  test(`an unused Verify that ended ${status} is no stage row and moves no outcome; the note counts it`, () => {
    const { call, review, receiptOf, reviewRecords } = unusedFixture;
    const unused: StageRecord = {
      stage: "verify",
      agent: "verify.correctness.bbbbbbbb",
      status,
      wallMs: 50_000,
      ...(status === "interrupted"
        ? { note: "interrupted at the run's cut-off (10.42)" }
        : { key: "2".repeat(64) }),
    };
    const records: RunLogRecord[] = [
      ...reviewRecords,
      call(unused.agent!, 2),
      call(unused.agent!, 3, finishReason),
      { type: "stage", ...unused },
      // A replayed finalization writes its row again; the note counts the Verify once.
      { type: "stage", ...unused },
    ];
    const receipt = receiptOf(records);
    const config = defaultConfig();
    expect(receipt.stages).toEqual(
      review.map((stage) => stageTelemetry(stage, records, config)),
    );
    expect(everyRowDone(receipt)).toBe(true);
    expect(receipt.outcome).toBe("completed");
    expect(receipt.timeout.reached).toBe(false);
    expect(receipt.timeout.published).toEqual([
      "find.correctness",
      "verify.correctness.aaaaaaaa",
    ]);
    expect(receipt.timeout.disclosed).toEqual([]);
    expect(receipt.gaps).toEqual([]);
    const callCount = finishReason === "aborted" ? 1 : 2;
    expect(receipt.notMeasured).toEqual({
      unitCounts: NO_BATCH,
      unusedVerifies: `1 Verify step ran for a claim its finder's final list does not hold, so it gave no verdict and no stage row lists it; model calls of the totals that are theirs: ${callCount}${attempts}`,
    });
    // The note's text never carries the Verify's own note, key or agent name.
    expect(receipt.notMeasured["unusedVerifies"]).not.toContain("verify.");
    expect(receipt.notMeasured["unusedVerifies"]).not.toContain("cut-off");
    // The schema Records stores the receipt under accepts the note.
    expect(
      RunReceipt.shape.notMeasured.safeParse(receipt.notMeasured).success,
    ).toBe(true);
    expect(formatReceipt(receipt)).toContain(
      `  not measured (unusedVerifies): 1 Verify step ran`,
    );
  });

// Why: the reconciliation is the point. The stage rows' model calls plus the note's count are the
// totals, and so are the failed and aborted attempts, so totals above the rows always say why. That
// includes an unused Verify that ended by failing or a thrown fault, which writes no `stage` row:
// it is found by its model calls, as the finder's own count finds it.
test("the stage rows' model calls plus the unused Verifies' count equal the totals", () => {
  const { call, receiptOf, reviewRecords } = unusedFixture;
  const unusedRow = (key: string, status: StageRecord["status"]) => ({
    type: "stage",
    stage: "verify",
    agent: `verify.${key}`,
    status,
    wallMs: 2_000,
  });
  const records: RunLogRecord[] = [
    ...reviewRecords,
    call("verify.correctness.bbbbbbbb", 2),
    call("verify.correctness.bbbbbbbb", 3),
    call("verify.security.cccccccc", 4),
    call("verify.security.cccccccc", 5, "aborted"),
    unusedRow("correctness.bbbbbbbb", "computed"),
    unusedRow("security.cccccccc", "interrupted"),
    // A third unused Verify ended by a thrown fault: its calls, and no `stage` row.
    call("verify.security.dddddddd", 6),
    call("verify.security.dddddddd", 7, "error"),
  ];
  const receipt = receiptOf(records);
  const note = receipt.notMeasured["unusedVerifies"] ?? "";
  expect(note).toBe(
    "3 Verify steps ran for claims their finders' final lists do not hold, so they gave no verdict and no stage row lists them; model calls of the totals that are theirs: 4 (failed attempts: 1, aborted: 1)",
  );
  const [, calls, failed, aborted] =
    /theirs: (\d+) \(failed attempts: (\d+), aborted: (\d+)\)$/.exec(note) ??
    [];
  const sum = (pick: (row: (typeof receipt.stages)[number]) => number) =>
    receipt.stages.reduce((total, row) => total + pick(row), 0);
  expect(sum((row) => row.modelCalls) + Number(calls)).toBe(
    receipt.totals.modelCalls,
  );
  expect(sum((row) => row.failedModelCalls ?? 0) + Number(failed)).toBe(
    receipt.totals.failedModelCalls!,
  );
  expect(sum((row) => row.abortedModelCalls ?? 0) + Number(aborted)).toBe(
    receipt.totals.abortedModelCalls!,
  );
  expect(receipt.totals.modelCalls).toBe(6);
  expect(receipt.totals.failedModelCalls).toBe(1);
  expect(receipt.stages.map((row) => row.agent)).toEqual([
    "find.correctness",
    "verify.correctness.aaaaaaaa",
  ]);
  expect(receipt.outcome).toBe("completed");
  expect(everyRowDone(receipt)).toBe(true);
});

// Why: nothing else may move. A run whose Verifies were all used has no note, and the stage rows
// of its used Verifies change nothing in the receipt; `notMeasured` is exactly what it was.
test("a run without an unused Verify has the receipt it had before", () => {
  const { review, receiptOf, reviewRecords } = unusedFixture;
  const receipt = receiptOf(reviewRecords);
  expect(receipt.notMeasured).toEqual({ unitCounts: NO_BATCH });
  expect(Object.keys(receipt.notMeasured)).toEqual(["unitCounts"]);
  expect(receipt.stages).toEqual(
    review.map((stage) =>
      stageTelemetry(stage, reviewRecords, defaultConfig()),
    ),
  );
  // The used Verify's own `stage` row is read for nothing else: the same receipt without it.
  expect(
    canonicalJson(
      receiptOf(reviewRecords.filter((record) => record.type !== "stage")),
    ),
  ).toBe(canonicalJson(receipt));
  // With a batch assembled, `notMeasured` stays empty.
  const assembled = receiptOf([
    ...reviewRecords,
    { type: "assemble.grouping", candidate: "c1", at10: 1, at20: 1, at40: 1 },
  ]);
  expect(assembled.notMeasured).toEqual({});
});
