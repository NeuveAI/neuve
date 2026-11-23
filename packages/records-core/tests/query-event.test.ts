import { expect, test } from "bun:test";
import { RecordEvent } from "@neuve/records-schema";

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
