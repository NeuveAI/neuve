// Why (25 October 2026, counting rule of 13 November): the Reviews page tells the owner what waits
// on a person across every review. A human-required or human-suggested unit waits while Records'
// closure rule leaves it open (the agent's disposition closes human-suggested work), and a unit the
// review never assessed reads as human-suggested (10.100), never as a lane of its own or as
// human-required. Agentic and static-automation units never wait; nor does a unit no agent read or
// one a newer review took over. Each batch's "to decide" must agree with its row's squares. A
// review that has no batch yet (still running, or failed before publishing) is named by its
// commit's subject. These pin that projection on the shape Records' review list returns; the
// Records reads behind it run on real stores in `reviews-standing.test.ts`.
import { expect, test } from "bun:test"
import type { ReviewList } from "@neuve/records-core"

import { NO_STANDING, summaryOf } from "./reviews.server"

const review = (
  batches: ReviewList.ListedReview["batches"]
): ReviewList.ListedReview => ({
  cycleId: "cycle-1",
  range: {
    baseRef: "refs/heads/main",
    baseOid: "a3a7bd3c".padEnd(40, "0"),
    headOid: "08443d42".padEnd(40, "0"),
  },
  runId: "run-1",
  state: "completed",
  at: "2026-10-25T12:30:29.800Z",
  batches,
  manifestIssue: undefined,
})

test("a review's row counts lanes, a square per human unit and each batch's units to decide", () => {
  const listed = review([
    {
      batchId: "b1",
      title: "Web integration tests run independently",
      units: [
        { unitId: "u1", lane: "human-required" },
        { unitId: "u2", lane: "human-required" },
        { unitId: "u3", lane: "agentic" },
        { unitId: "u4", lane: null },
      ],
    },
    {
      batchId: "b2",
      title: undefined,
      units: [
        { unitId: "u5", lane: "human-required" },
        { unitId: "u6", lane: "static-automation" },
        { unitId: "u7", lane: "human-suggested" },
        { unitId: "u8", lane: "human-suggested" },
      ],
    },
  ])
  // The verdicts Records' closure leaves standing; an agentic unit's draws no square.
  const standing = {
    ...NO_STANDING,
    decided: new Map([
      ["u1", "approve"],
      ["u3", "approve"],
      ["u5", "request-changes"],
      ["u7", "approve"],
    ] as const),
  }
  const summary = summaryOf(listed, standing, new Set(["cycle-1"]), undefined)
  expect(summary).toMatchObject({
    id: "cycle-1",
    title: "Web integration tests run independently",
    range: "a3a7bd3..08443d4",
    state: "completed",
    feedback: true,
    // An unassessed unit joins human-suggested; lanes keep their order.
    lanes: [
      { lane: "human-required", count: 3 },
      { lane: "human-suggested", count: 3 },
      { lane: "agentic-review", count: 1 },
      { lane: "static-automation", count: 1 },
    ],
    gate: [
      { lane: "human-required", mark: "approved" },
      { lane: "human-required", mark: "waiting" },
      { lane: "human-suggested", mark: "waiting" },
      { lane: "human-required", mark: "changes-requested" },
      { lane: "human-suggested", mark: "approved" },
      { lane: "human-suggested", mark: "waiting" },
    ],
    batches: [
      {
        id: "b1",
        title: "Web integration tests run independently",
        unitCount: 4,
        needYou: 2,
      },
      // A batch Records holds no title for is named by its place.
      { id: "b2", title: "Batch 2", unitCount: 4, needYou: 1 },
    ],
  })
})

test("a review with no batch yet is named by its commit's subject, else by its range", () => {
  const running = { ...review([]), state: "running" as const }
  expect(
    summaryOf(running, NO_STANDING, new Set(), "Guard adjudicated units").title
  ).toBe("Guard adjudicated units")
  const unnamed = summaryOf(running, NO_STANDING, new Set(), "")
  expect(unnamed.title).toBe("a3a7bd3..08443d4")
  expect(unnamed).toMatchObject({
    lanes: [],
    gate: [],
    batches: [],
    feedback: false,
  })
})

test("a unit no agent read or a newer review took over draws no square and is not to decide", () => {
  const listed = review([
    {
      batchId: "b1",
      title: "Lockfiles and generated files",
      units: [
        { unitId: "u1", lane: "human-suggested" },
        { unitId: "u2", lane: "human-required" },
        { unitId: "u3", lane: "human-required" },
      ],
    },
  ])
  const standing = {
    ...NO_STANDING,
    notRead: new Set(["u1"]),
    takenOver: new Set(["u2"]),
  }
  const summary = summaryOf(listed, standing, new Set(), undefined)
  // The lanes still show every unit as published.
  expect(summary.lanes).toEqual([
    { lane: "human-required", count: 2 },
    { lane: "human-suggested", count: 1 },
  ])
  expect(summary.gate).toEqual([{ lane: "human-required", mark: "waiting" }])
  expect(summary.batches[0]?.needYou).toBe(1)
  expect(summary.newer).toBeUndefined()
  // Once a newer review holds every unit, the row is the older review's.
  const older = summaryOf(
    listed,
    { ...standing, takenOver: new Set(["u1", "u2", "u3"]) },
    new Set(),
    undefined
  )
  expect(older).toMatchObject({ newer: true, gate: [] })
  expect(older.batches[0]?.needYou).toBe(0)
})
