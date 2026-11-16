// Why (16 November 2026): the home page lists every batch with its batch digest, its lanes and
// what waits on the reader (14.30, 14.31, 14.33). Two things are new and must hold. The digest
// reads as plain prose in a list: a phrase link reads as its phrase and a bare local ID is dropped,
// so no `[phrase](u.…)` markup or ID reaches the reader. A batch's waiting count and the unit its
// desk opens on follow the Reviews load's rule: a unit waits until Records' closure decides it, a
// batch of an older review asks for nothing, and the desk opens on the first unit that waits. The
// Records reads behind the standing run on real stores in `reviews-standing.test.ts`.
import { expect, test } from "bun:test"
import type { ReviewList } from "@neuve/records-core"

import { homeBatchOf, plainDigest } from "./home.server"
import { NO_STANDING, summaryOf } from "./reviews.server"
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

test("a batch counts its lanes and what waits, and its desk opens on the first unit that waits", () => {
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
  expect(batch.deskUnitId).toBe("u3")
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
