// Why (25 October 2026, counting rule of 13 November): the Reviews page tells the owner what waits
// on a person across every review. A human-required or human-suggested unit waits while Records'
// closure rule leaves it open (the agent's disposition closes human-suggested work), and a unit the
// review never assessed reads as human-suggested (10.100), never as a lane of its own or as
// human-required. Agentic and static-automation units never wait; nor does a unit no agent read or
// one a newer review took over. Each batch's "to decide" must agree with its row's squares. A
// review that has no batch yet (still running, or failed before publishing) is named by its
// commit's subject. These pin that projection on the shape Records' review list returns; the
// Records reads behind it run on real stores in `reviews-standing.test.ts`.
//
// Why (21 November 2026, NEU-433 and NEU-434): "Waiting on you" became the default list. Which
// reviews it holds and in what order decide what a person opens first, so they are pinned here: a
// review a later review's range holds is never counted beside it, a landed review stays only while
// a human-required unit waits, and human-required work comes first. A cycle's own address counts
// its lanes across every batch and its desk opens on the first human-required unit that waits,
// even when that unit is in a later batch.
import { expect, test } from "bun:test"
import type { ReviewList } from "@neuve/records-core"

import {
  NO_STANDING,
  defaultListOf,
  entryUnitOf,
  replacedOf,
  summaryOf,
  waitingOf,
} from "./reviews.server"

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

test("a cycle whose human-required units are in later batches counts them, and its desk opens on the first", () => {
  const listed = review([
    {
      batchId: "b1",
      title: "Batch one",
      units: [
        { unitId: "u1", lane: "agentic" },
        { unitId: "u2", lane: "human-suggested" },
      ],
    },
    {
      batchId: "b2",
      title: "Batch two",
      units: [{ unitId: "u3", lane: "agentic" }],
    },
    {
      batchId: "b3",
      title: "Batch three",
      units: [{ unitId: "u4", lane: "human-required" }],
    },
    {
      batchId: "b4",
      title: "Batch four",
      units: [{ unitId: "u5", lane: "human-required" }],
    },
  ])
  const summary = summaryOf(listed, NO_STANDING, new Set(), undefined)
  expect(summary.lanes).toEqual([
    { lane: "human-required", count: 2 },
    { lane: "human-suggested", count: 1 },
    { lane: "agentic-review", count: 2 },
  ])
  expect(summary.batches.map((batch) => batch.needYou)).toEqual([1, 0, 1, 1])
  const all = listed.batches.flatMap((batch) => batch.units)
  // The first human-required unit that waits, past the human-suggested one before it.
  expect(entryUnitOf(all, NO_STANDING)).toBe("u4")
  const decided = (...ids: Array<string>) => ({
    ...NO_STANDING,
    decided: new Map(ids.map((id) => [id, "approve" as const])),
  })
  expect(entryUnitOf(all, decided("u4"))).toBe("u5")
  // No human-required unit waits: the first unit that does.
  expect(entryUnitOf(all, decided("u4", "u5"))).toBe("u2")
  // Nothing waits: none, and the caller opens the first unit.
  expect(entryUnitOf(all, decided("u2", "u4", "u5"))).toBeUndefined()
})

/** A review of `base..head`, opened as `cycleId` (ULIDs order by time), with `units` in one batch. */
const ranged = (
  cycleId: string,
  base: string,
  head: string,
  units: ReviewList.ListedBatch["units"] = [
    { unitId: `${cycleId}-u`, lane: "human-required" },
  ]
): ReviewList.ListedReview => ({
  ...review(
    units.length > 0
      ? [{ batchId: `${cycleId}-b`, title: undefined, units }]
      : []
  ),
  cycleId,
  range: { baseRef: "main", baseOid: base, headOid: head },
})

test("a later published review whose range holds an earlier one replaces it", () => {
  // History: o <- a <- b <- c, and x off a.
  const parent: Record<string, string> = { a: "o", b: "a", c: "b", x: "a" }
  const descends = (ancestor: string, descendant: string) => {
    for (let at: string | undefined = descendant; at; at = parent[at])
      if (at === ancestor) return true
    return false
  }
  const reviews = [
    ranged("01A", "a", "b"),
    // Same base, head past it.
    ranged("01B", "a", "c"),
    // An earlier base, a head past the first one's.
    ranged("01C", "o", "c"),
    // The same range again, later: the earlier of the two is replaced, never both.
    ranged("01D", "o", "c"),
    // Another branch: holds nothing of the others.
    ranged("01E", "a", "x"),
    // A later base: it did not review what the earlier base held.
    ranged("01F", "b", "c"),
    // Published nothing: it replaces nothing.
    ranged("01G", "o", "c", []),
    // Stopped with batches unpublished: it replaces nothing either.
    { ...ranged("01H", "o", "c"), pendingBatches: 2 },
  ]
  expect([...replacedOf(reviews, descends)].sort()).toEqual([
    "01A",
    "01B",
    "01C",
  ])
})

test("Waiting on you lists open human-required work first, then landed, then the rest; Open next opens human-required work", () => {
  const units = (
    cycleId: string,
    ...lanes: Array<"human-required" | "human-suggested">
  ) => lanes.map((lane, index) => ({ unitId: `${cycleId}-${index}`, lane }))
  // Newest run first, as Records lists them.
  const reviews = [
    ranged("01H", "a", "b", units("01H", "human-suggested")),
    ranged("01G", "a", "b", units("01G", "human-required")),
    ranged("01F", "a", "b", units("01F", "human-suggested", "human-required")),
    ranged("01E", "a", "b", units("01E", "human-suggested")),
    ranged("01D", "a", "b", units("01D", "human-required")),
    ranged("01C", "a", "b", units("01C", "human-required")),
    ranged("01B", "a", "b", units("01B", "human-suggested")),
  ]
  const standing = {
    ...NO_STANDING,
    decided: new Map([["01B-0", "approve" as const]]),
  }
  const ends = new Map([
    ["01G", "landed" as const],
    ["01E", "landed" as const],
    ["01D", "gone" as const],
  ])
  const listed = defaultListOf(reviews, standing, ends)
  // 01F and 01C are open with human-required work; 01G landed and 01D is gone with some; 01H is
  // open with human-suggested work. A landed review with only human-suggested work (01E) and one
  // with nothing waiting (01B) are under All only.
  expect(listed.map((each) => each.cycleId)).toEqual([
    "01F",
    "01C",
    "01G",
    "01D",
    "01H",
  ])
  const across = waitingOf(listed, standing)
  expect(across).toMatchObject({ units: 6, nextUnitId: "01F-1" })
  expect(across.waiting).toHaveLength(5)
})
