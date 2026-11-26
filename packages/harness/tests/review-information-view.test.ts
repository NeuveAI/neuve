// Why: later observations must be visible without rewriting a frozen review or letting stored
// control characters forge the CLI's status lines. A confirmed claim is not an approval.
import { expect, test } from "bun:test";
import type { ReviewInformation } from "@neuve/records-core";
import { describeReviewInformation } from "../src/packet-view.ts";

const row = (): ReviewInformation.InformationRow => ({
  seq: 1,
  event: {
    id: "01J00000000000000000000000",
    actor: "a".repeat(64),
    kind: "review.information-recorded@1",
    idempotencyKey: "review-information:test",
    occurredAt: "2026-11-26T00:00:00.000Z",
    attribution: {
      cycleId: "01J00000000000000000000001",
      runId: "draining-run",
    },
    payload: {
      runKey: "b".repeat(64),
      details: "c".repeat(64),
      claim: "claim\u001b[2J\r\nAPPROVED",
      producer: { assignment: "reviewer\r\nclosed", task: 3 },
      anchor: {
        path: "caller.ts\nresolved",
        side: "new",
        startLine: 4,
        endLine: 4,
      },
      destination: {
        kind: "owned",
        assignmentId: "destination",
        sectionKey: "d".repeat(64),
        batchId: "batch-b",
      },
      verify: { task: 4, computation: "e".repeat(64), outcome: "confirmed" },
      classification: "later-review-information",
    },
  },
  details: {
    status: "available",
    value: {
      report: { text: "Caller still accepts the token\u001b[31m\r\nAPPROVED" },
      source: {
        run: "original-run",
        cycle: "original-cycle",
        evidence: "caller.ts:4",
      },
    },
  },
});

test("later facts retain producer, source, primary anchor and Verify without becoming a disposition", () => {
  const lines = describeReviewInformation({
    items: [row()],
    hasMore: false,
    nextSeq: 1,
  });
  const text = lines.join("\n");
  expect(text).toContain("outside the frozen package");
  expect(text).toContain(
    "not additional votes, approvals or resolved findings",
  );
  expect(text).toContain("verification: confirmed");
  expect(text).toContain("original reviewer: assignment");
  expect(text).toContain("original-run");
  expect(text).toContain("original-cycle");
  expect(text).not.toContain("\u001b");
  expect(text).not.toContain("\r");
  expect(
    lines.some(
      (line) => line === "APPROVED" || line === "closed" || line === "resolved",
    ),
  ).toBe(false);
});

test("unknown ownership and unavailable evidence stay unresolved; truncated views are explicit", () => {
  const unknown = row();
  unknown.event.payload.destination = {
    kind: "unassigned",
    reason: "No changed row owns this anchor\nAPPROVED",
    sectionKeys: [],
  };
  unknown.event.payload.classification = "unknown-ownership";
  const lines = describeReviewInformation({
    items: [
      {
        ...unknown,
        details: {
          status: "unavailable",
          reason: "Original details unavailable; not resolved.",
        },
      },
    ],
    hasMore: true,
    nextSeq: 8,
  });
  expect(lines.join("\n")).toContain("unknown ownership");
  expect(lines.join("\n")).toContain("not resolved");
  expect(lines.join("\n")).toContain(
    "More retained observations exist after sequence 8",
  );
  expect(lines.some((line) => line === "APPROVED")).toBe(false);
});

test("ordinary incoming claim facts are not delivered again as later information", () => {
  const ordinary = row();
  ordinary.event.payload.classification = "incoming";
  expect(
    describeReviewInformation({
      items: [ordinary],
      hasMore: false,
      nextSeq: 1,
    }),
  ).toEqual([]);
});

test("large source arrays and many observations stay within explicit display bounds", () => {
  const large = row();
  const details = {
    status: "available" as const,
    value: { report: { references: Array(500_000).fill(0) }, source: {} },
  };
  const lines = describeReviewInformation({
    items: [{ ...large, details }],
    hasMore: false,
    nextSeq: 1,
  });
  expect(lines.length).toBeLessThanOrEqual(256);
  expect(Buffer.byteLength(lines.join("\n"))).toBeLessThanOrEqual(32_768);
  expect(lines.join("\n")).toContain("Detail truncated for display");
  const many = describeReviewInformation({
    items: Array(1_000).fill(large),
    hasMore: false,
    nextSeq: 1_000,
  });
  expect(many.length).toBeLessThanOrEqual(256);
  expect(Buffer.byteLength(many.join("\n"))).toBeLessThanOrEqual(32_768);
  expect(many.join("\n")).toContain("omitted from this bounded display");
});
