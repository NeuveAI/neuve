// Why (16 November 2026): the home page lists every batch with its batch digest, its lanes and
// what waits on the reader (14.30, 14.31, 14.33). Two things are new and must hold. The digest
// reads as plain prose in a list: a phrase link reads as its phrase and a bare local ID is dropped,
// so no `[phrase](u.…)` markup or ID reaches the reader. A batch's waiting count and the unit its
// desk opens on follow the Reviews load's rule: a unit waits until Records' closure decides it, a
// batch of an older review asks for nothing, and the desk opens on the first human-required unit
// that waits, else the first unit that waits (NEU-434). The
// Records reads behind the standing run on real stores in `reviews-standing.test.ts`.
import { expect, test } from "bun:test"
import type { ReviewList } from "@neuve/records-core"

import { homeBatchOf, homeBatchesOf, plainDigest } from "./home.server"
import {
  NO_STANDING,
  afterClear,
  defaultListOf,
  summaryOf,
  waitingOf,
} from "./reviews.server"
import type { UnitStanding } from "./reviews.server"

test("a digest reads as plain prose: phrase links as their phrase, local IDs dropped", () => {
  expect(
    plainDigest(
      "The batch connects [untouched command output](u.7e172f0a5c19826b) to [archive validation](u.7e172f0a5c19826b) (h47dffd01, b1.r3). **Risk:** none."
    )
  ).toBe(
    "The batch connects untouched command output to archive validation. **Risk:** none."
  )
  // A parenthesis that isn't only local IDs stays as written.
  expect(plainDigest("Checks run (twice) before upload.")).toBe(
    "Checks run (twice) before upload."
  )
  expect(plainDigest("  ")).toBeUndefined()
  expect(plainDigest(undefined)).toBeUndefined()
})

const listed: ReviewList.ListedBatch = {
  batchId: "b1",
  title: "Refusal and cleanup hardening",
  units: [
    { unitId: "u1", lane: "agentic" },
    { unitId: "u2", lane: "human-required" },
    { unitId: "u3", lane: "human-suggested" },
    { unitId: "u4", lane: "human-required" },
  ],
}

const review: ReviewList.ListedReview = {
  cycleId: "cycle-1",
  range: {
    baseRef: "refs/heads/main",
    baseOid: "a3a7bd3c".padEnd(40, "0"),
    headOid: "08443d42".padEnd(40, "0"),
  },
  runId: "run-1",
  state: "completed",
  at: "2026-11-15T18:18:42.349Z",
  batches: [listed],
  manifestIssue: undefined,
}

// u2 is decided; u3 (human-suggested) and u4 still wait.
const standing: UnitStanding = {
  ...NO_STANDING,
  decided: new Map([["u2", "approve"]]),
}

test("a batch counts its lanes and what waits, and its desk opens on the first human-required unit that waits", () => {
  const summary = summaryOf(review, standing, new Set(), undefined)
  const batch = homeBatchOf(
    listed,
    summary.batches[0],
    undefined,
    standing,
    false
  )
  expect(batch.lanes).toEqual([
    { lane: "human-required", count: 2 },
    { lane: "human-suggested", count: 1 },
    { lane: "agentic-review", count: 1 },
  ])
  expect(batch.needYou).toBe(2)
  expect(batch.asked).toBe(3)
  // u4 before u3: human-required work first.
  expect(batch.deskUnitId).toBe("u4")
  // No packet read: no digest, and the page still has the batch.
  expect(batch.digest).toBeUndefined()
})

test("an older review's batch asks for nothing, and its desk opens on its first unit", () => {
  const summary = summaryOf(review, standing, new Set(), undefined)
  const batch = homeBatchOf(
    listed,
    summary.batches[0],
    undefined,
    standing,
    true
  )
  expect(batch.needYou).toBe(0)
  expect(batch.asked).toBe(0)
  expect(batch.deskUnitId).toBe("u1")
})

test("a cycle's own address puts the batches with human-required work first; the list keeps packet order", () => {
  // Why (NEU-434): the page a person lands on from a cycle's address must lead with what they decide.
  const batches: Array<ReviewList.ListedBatch> = [
    {
      batchId: "b1",
      title: "One",
      units: [{ unitId: "v1", lane: "human-suggested" }],
    },
    { batchId: "b2", title: "Two", units: [{ unitId: "v2", lane: "agentic" }] },
    {
      batchId: "b3",
      title: "Three",
      units: [{ unitId: "v3", lane: "human-required" }],
    },
    {
      batchId: "b4",
      title: "Four",
      units: [{ unitId: "v4", lane: "human-required" }],
    },
  ]
  const cycle = { ...review, batches }
  // b4's human-required unit is decided: it no longer leads.
  const decidedFour: UnitStanding = {
    ...NO_STANDING,
    decided: new Map([["v4", "approve"]]),
  }
  const summary = summaryOf(cycle, decidedFour, new Set(), undefined)
  const order = (requiredFirst: boolean) =>
    homeBatchesOf(summary, cycle, undefined, decidedFour, requiredFirst).map(
      (batch) => batch.id
    )
  expect(order(true)).toEqual(["b3", "b1", "b2", "b4"])
  expect(order(false)).toEqual(["b1", "b2", "b3", "b4"])
})

// Why (22 November 2026, NEU-460): a review sits under a title a person reads, not its hour and
// hash. Its head commit's subject names it; a commit git no longer has (an empty subject) falls
// back to its first batch's title, and a review with neither reads as its range.
test("a review's title is its head commit's subject, else its first batch's title, else its range", () => {
  const titled = (subject: string, batches = review.batches) =>
    summaryOf({ ...review, batches }, standing, new Set(), subject).title
  expect(titled("Keep cleanup off refused runs")).toBe(
    "Keep cleanup off refused runs"
  )
  expect(titled("")).toBe("Refusal and cleanup hardening")
  expect(titled("", [])).toBe("a3a7bd3..08443d4")
})

// Why (22 November 2026, NEU-460): "Clear" empties "Waiting on you" of the current reviews, the
// owner's "clear current batches", but waiting human-required work is never lost. After a clear
// the list holds only reviews run after it, human-required ones from before included in the
// hiding, while what waits on you (the count and Open next) still counts them. Undo is the list
// read with no clear, so it holds what it held before.
test("after a clear, the default list holds only later reviews while earlier waiting work still counts, and undo restores it", () => {
  const lanes = (
    id: string,
    at: string,
    lane: ReviewList.ListedUnit["lane"]
  ): ReviewList.ListedReview => ({
    ...review,
    cycleId: id,
    at,
    batches: [{ ...listed, units: [{ unitId: `${id}-u`, lane }] }],
  })
  const reviews = [
    lanes("later", "2026-11-22T12:00:00.000Z", "human-suggested"),
    lanes("required", "2026-11-21T09:00:00.000Z", "human-required"),
    lanes("earlier", "2026-11-21T08:00:00.000Z", "human-suggested"),
  ]
  const waiting = defaultListOf(reviews, NO_STANDING, new Map())
  const listedIds = (cleared?: string) =>
    afterClear(waiting, cleared).map((entry) => entry.cycleId)
  expect(listedIds("2026-11-22T10:00:00.000Z")).toEqual(["later"])
  // The count still holds the hidden human-required review, and Open next leads to it first.
  const counted = waitingOf(waiting, NO_STANDING)
  expect(counted.units).toBe(3)
  expect(counted.nextUnitId).toBe("required-u")
  expect(listedIds()).toEqual(["required", "later", "earlier"])
})
