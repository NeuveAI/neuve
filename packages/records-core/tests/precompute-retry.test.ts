// Why: permanent queue deduplication must not suppress code preparation on a later trigger.
import { afterAll, expect, test } from "bun:test";
import { RecordEvent } from "@neuve/records-schema";
import { Effect, Option } from "effect";
import { JobQueue, Log, mintUlid, sha256Hex } from "../src/index.ts";
import {
  actor,
  cycleEvents,
  freshLocation,
  headOid,
  removeTemporaryDirectories,
  runOn,
} from "./support.ts";
afterAll(removeTemporaryDirectories);

test("later triggers retry failed preparation once while preserving active and completed jobs", async () => {
  const result = await runOn(
    freshLocation(),
    Effect.gen(function* () {
      const queue = yield* JobQueue.JobQueue;
      const input = {
        kind: "commit.prepare@2" as const,
        dedupeKey: "range",
        payload: { kind: "range", range: { baseOid: "b".repeat(40), headOid } },
      };
      const initial = yield* queue.enqueue(input);
      const taken = Option.getOrThrow(yield* queue.take([input.kind]));
      yield* queue.fail(taken.seq, taken.attempts, {
        tag: "Transient",
        message: "failed previously",
        final: true,
      });
      const triggers = yield* Effect.forEach(
        [1, 2],
        () => queue.enqueue(input),
        { concurrency: 2 },
      );
      const retry = Option.getOrThrow(yield* queue.take([input.kind]));
      const active = yield* queue.enqueue(input);
      yield* queue.complete(retry.seq, retry.attempts);
      const completed = yield* queue.enqueue(input);
      return { initial, triggers, retry, active, completed };
    }).pipe(Effect.provide(JobQueue.layer)),
  );
  expect(result.triggers.map((t) => t.status).sort()).toEqual([
    "enqueued",
    "existing",
  ]);
  expect(result.retry.seq).toBe(result.initial.job.seq);
  expect(result.retry.attempts).toBe(2);
  expect(result.retry.lastError).toBeNull();
  expect(result.active.job.state).toBe("active");
  expect(result.completed.job.state).toBe("completed");
});

test("a new review request revives failed discovery for the same range", async () => {
  const location = freshLocation();
  const cycle = cycleEvents(1);
  const opened = RecordEvent.parse(cycle.events[0]);
  if (opened.kind !== "cycle.opened@1")
    throw new Error("Expected opening event");
  const request = (generation: number) => ({
    id: mintUlid(),
    kind: "review.requested@1",
    actor,
    idempotencyKey: `request:${generation}`,
    occurredAt: new Date().toISOString(),
    attribution: {
      cycleId: opened.attribution.cycleId,
      range: { baseRef: "main", baseOid: "b".repeat(40), headOid },
    },
    payload: {
      runKey: sha256Hex(`retry-${generation}`),
      generation,
      pipeline: { version: 10, config: {} },
    },
  });
  const first = request(0),
    second = request(1);
  await runOn(location, Log.append([...cycle.events, first]));
  const result = await runOn(
    location,
    Effect.gen(function* () {
      const queue = yield* JobQueue.JobQueue;
      const job = Option.getOrThrow(yield* queue.take(["commit.prepare@2"]));
      yield* queue.fail(job.seq, job.attempts, {
        tag: "Transient",
        message: "failed discovery",
        final: true,
      });
      yield* Log.append([second]);
      return {
        original: job,
        retry: Option.getOrThrow(yield* queue.take(["commit.prepare@2"])),
      };
    }).pipe(Effect.provide(JobQueue.layer)),
  );
  expect(result.retry.seq).toBe(result.original.seq);
  expect(result.retry.eventId).toBe(second.id);
  expect(result.retry.attempts).toBe(2);
});
