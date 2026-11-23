import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect, Layer } from "effect";
import { RecordEvent } from "@neuve/records-schema";
import { Blobs, ByteStorage, Log, Queries } from "../src/index.ts";
import { freshLocation, removeTemporaryDirectories, runOn } from "./support.ts";

afterAll(removeTemporaryDirectories);

// The event boundary must keep question text out of the log and refuse invalid run data.
test("refuses inline questions and malformed query runs", () => {
  const at = "2026-11-23T00:00:00.000Z";
  const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const event = {
    id,
    kind: "query.recorded@1",
    idempotencyKey: `query:${id}`,
    actor: "b".repeat(64),
    occurredAt: at,
    refs: [{ role: "question", ref: `blob:${"c".repeat(64)}` }],
    payload: {
      revision: "a".repeat(40),
      maxResults: 5,
      maxContextBytes: 4096,
      cache: "reuse",
      profile: "full",
      relationshipPlanSize: 1,
      outcome: "completed",
      candidatesReturned: 2,
      relationships: 1,
      resultBytes: 50,
      resultsDroppedByBudget: 0,
      snippetsTruncatedByBudget: 0,
      startedAt: at,
      elapsedMs: 100,
    },
  };
  expect(RecordEvent.safeParse(event).success).toBe(true);
  for (const invalid of [
    { question: "x".repeat(65_537) },
    { revision: "abcdef0" },
    { revision: null },
    { elapsedMs: -1 },
    { outcome: "unknown" },
  ]) {
    expect(
      RecordEvent.safeParse({
        ...event,
        payload: { ...event.payload, ...invalid },
      }).success,
    ).toBe(false);
  }
  expect(RecordEvent.safeParse({ ...event, refs: [] }).success).toBe(false);
});

// Writing a file-backed question must leave the Records writer available during byte storage.
test("stores question bytes before the query event takes the write lock", async () => {
  const location = freshLocation();
  const question = "q".repeat(Blobs.INLINE_MAX_BYTES + 1);
  const storage = Layer.effect(
    ByteStorage.ByteStorage,
    Effect.map(ByteStorage.ByteStorage, (local) => ({
      ...local,
      put: (object) =>
        Effect.andThen(
          Effect.sync(() => {
            using connection = new Database(location.database);
            connection.exec(
              "PRAGMA busy_timeout = 0; BEGIN IMMEDIATE; ROLLBACK",
            );
          }),
          local.put(object),
        ),
    })),
  ).pipe(Layer.provide(ByteStorage.localFileSystem(location)));
  const history = await runOn(
    location,
    Effect.gen(function* () {
      const id = yield* Queries.record({
        actor: "b".repeat(64),
        question,
        attribution: undefined,
        payload: {
          revision: null,
          maxResults: 5,
          maxContextBytes: 4096,
          cache: "reuse",
          profile: "full",
          relationshipPlanSize: 0,
          outcome: "failed",
          candidatesReturned: 0,
          relationships: 0,
          resultBytes: 0,
          resultsDroppedByBudget: 0,
          snippetsTruncatedByBudget: 0,
          startedAt: "2026-11-23T00:00:00.000Z",
          elapsedMs: 100,
        },
      });
      return { id, events: yield* Log.history({ kind: "query.recorded@1" }) };
    }).pipe(
      Effect.provide(
        Blobs.layerOnStorage(location).pipe(Layer.provide(storage)),
      ),
    ),
  );
  expect(history.events.map(({ event }) => [event.id, event.kind])).toEqual([
    [history.id, "query.recorded@1"],
  ]);
});
