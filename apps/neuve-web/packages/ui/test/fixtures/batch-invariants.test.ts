/**
 * Fixture invariants. The canvas boards, the Pen and the stories are all
 * built from these fixtures, so the numbers one
 * surface shows must be the numbers every other surface shows: lane counts
 * sum to the batch, "need you" and the human gate agree between the
 * overview and every desk, unit positions match the rail, one person
 * reviews, and every recorded verdict names who recorded it.
 */
import { describe, expect, test } from "bun:test"

import * as batch from "@workspace/ui/fixtures/review-batch.fixtures"
import * as shell from "@workspace/ui/fixtures/shell.fixtures"
import {
  ADMINS_UNIT_ID,
  LANE_ORDER,
  REVIEWER,
  UNIT_IMPLEMENTERS,
  agentRegistryFixture,
  agenticUnitFixture,
  batchOverviewFixture,
  commitLineageFixture,
  commitLineageWithPendingFixture,
  deskBatchContextFixture,
  gatheredDeliveryDeskFixture,
  goDeliveryDeskFixture,
  goDeliveryInLane,
  longFileDeskFixture,
  mockDeskFixtures,
  newCommitFixture,
  observedCommitLoadFixture,
  reviewDeskFixture,
  reviewDeskLiveFixture,
  reviewDeskLongCardFixture,
  reviewDeskWithNewCommitFixture,
  scopeDeliveryDeskFixture,
  staticUnitFixture,
  suggestedUnitFixture,
  unavailableCommitLoadFixture,
  unlinkedGatheredDeliveryDeskFixture,
  unlinkedSuggestedDeliveryDeskFixture,
} from "@workspace/ui/fixtures/review-batch.fixtures"
import {
  agentChangesOnlyOverviewFixture,
  agentChangesOverviewFixture,
  allApprovedOverviewFixture,
  allDecidedOverviewFixture,
  someDecidedOverviewFixture,
  waitingOverviewFixture,
} from "@workspace/ui/fixtures/decided-overview.fixtures"
import {
  contextualBriefingWithPhraseFixture,
  lastUndecidedDeskFixture,
  liveLaneOverviewFixture,
  nextUndecidedDeskFixture,
  registeredLineageFixture,
} from "@workspace/ui/fixtures/shell.fixtures"
import {
  carriedRailDeskFixture,
  carriedSuggestedDeskFixture,
  carriedUnitDeskFixture,
  earlierVersionDeskFixture,
  lockfileDeskFixture,
  lockfileLongLaneDeskFixture,
  lockfileRailDeskFixture,
  partsOnlyDeskFixture,
  wholeUnitCommentsDeskFixture,
  lanesArrivedDeskFixture,
  lanesDeskFixture,
  lanesWithStaticDeskFixture,
  noAgentDecisionArrivedDeskFixture,
  noAgentDecisionDeskFixture,
  undecidedSectionDeskFixture,
} from "@workspace/ui/fixtures/lanes-desk.fixtures"
import {
  linkExpiryClosureArrivedReviewsFixture,
  linkExpiryClosureCarriedReviewsFixture,
  linkExpiryClosureReviewsFixture,
  linkExpiryOlderReviewsFixture,
} from "@workspace/ui/fixtures/lanes-reviews.fixtures"
import {
  linkExpiryArrivedOverviewFixture,
  linkExpiryCarriedChangesOverviewFixture,
  linkExpiryCarriedOverviewFixture,
  linkExpiryLockfileOverviewFixture,
  linkExpiryLongLinesOverviewFixture,
  linkExpiryReplacedOverviewFixture,
  linkExpiryLimitationsOverviewFixture,
  linkExpiryOverviewFixture,
  linkExpiryStaticOverviewFixture,
  linkExpiryStoppedOverviewFixture,
  linkExpiryWholeOverviewFixture,
} from "@workspace/ui/fixtures/lanes-overview.fixtures"
import {
  markerFamily,
  markerKind,
} from "@workspace/ui/neuve/shared/marker-kind"
import type {
  BatchOverviewData,
  CommitLineage,
  ContextualMarker,
  ReviewDeskData,
  ReviewLane,
  ReviewsData,
} from "@workspace/ui/neuve/types"

const OVERVIEWS: Record<string, BatchOverviewData> = {
  batchOverviewFixture,
  liveLaneOverviewFixture,
  contextualBriefingWithPhraseFixture,
  someDecidedOverviewFixture,
  allDecidedOverviewFixture,
  allApprovedOverviewFixture,
  agentChangesOverviewFixture,
  agentChangesOnlyOverviewFixture,
  waitingOverviewFixture,
  linkExpiryOverviewFixture,
  linkExpiryArrivedOverviewFixture,
  linkExpiryStaticOverviewFixture,
  linkExpiryStoppedOverviewFixture,
  linkExpiryWholeOverviewFixture,
  linkExpiryLimitationsOverviewFixture,
  linkExpiryCarriedOverviewFixture,
  linkExpiryCarriedChangesOverviewFixture,
  linkExpiryLockfileOverviewFixture,
  linkExpiryLongLinesOverviewFixture,
  linkExpiryReplacedOverviewFixture,
}

/** The Reviews pages of the link-expiry review as its batches arrive (Records' closure rule). */
const REVIEWS_PAGES: Record<string, ReviewsData> = {
  linkExpiryClosureReviewsFixture,
  linkExpiryClosureArrivedReviewsFixture,
  linkExpiryClosureCarriedReviewsFixture,
  linkExpiryOlderReviewsFixture,
}

/** Every desk of the acme batch a story or `/mock` page renders. */
const DESKS: Record<string, ReviewDeskData> = {
  reviewDeskFixture,
  reviewDeskLiveFixture,
  reviewDeskWithNewCommitFixture,
  reviewDeskLongCardFixture,
  longFileDeskFixture,
  goDeliveryDeskFixture,
  scopeDeliveryDeskFixture,
  gatheredDeliveryDeskFixture,
  unlinkedGatheredDeliveryDeskFixture,
  unlinkedSuggestedDeliveryDeskFixture,
  goDeliveryHumanSuggested: goDeliveryInLane("human-suggested"),
  goDeliveryAgentic: goDeliveryInLane("agentic-review"),
  goDeliveryStatic: goDeliveryInLane("static-automation"),
  suggestedUnitFixture,
  agenticUnitFixture,
  staticUnitFixture,
  lastUndecidedDeskFixture,
  nextUndecidedDeskFixture,
  goDeliveryApproveSuggestedDeskFixture:
    batch.goDeliveryApproveSuggestedDeskFixture,
  goDeliveryPlainBriefingDeskFixture: batch.goDeliveryPlainBriefingDeskFixture,
  goDeliveryPhraseToReviewDeskFixture:
    batch.goDeliveryPhraseToReviewDeskFixture,
  goDeliverySuggestedPassedDeskFixture:
    batch.goDeliverySuggestedPassedDeskFixture,
  goDeliveryCheckMissingDeskFixture: batch.goDeliveryCheckMissingDeskFixture,
  unlinkedSuggestedNoReviewerDeskFixture:
    batch.unlinkedSuggestedNoReviewerDeskFixture,
  ...Object.fromEntries(
    mockDeskFixtures.map((desk) => [`mock:${desk.unit.id}`, desk])
  ),
}

/**
 * Story variants that show the Go unit as if it sat in another lane, to
 * exercise that lane's delivery (`goDeliveryInLane`). They keep the batch's
 * rail, so only the open unit's own lane differs from the batch.
 */
const LANE_VARIANTS = new Set([
  "goDeliveryHumanSuggested",
  "goDeliveryAgentic",
  "goDeliveryStatic",
  "unlinkedSuggestedDeliveryDeskFixture",
  "goDeliveryPhraseToReviewDeskFixture",
  "goDeliverySuggestedPassedDeskFixture",
  "unlinkedSuggestedNoReviewerDeskFixture",
])

const laneCount = (data: BatchOverviewData, lane: string) =>
  data.lanes.find((summary) => summary.lane === lane)?.count

describe("overview numbers", () => {
  for (const [name, data] of Object.entries(OVERVIEWS)) {
    test(`${name}: the lanes sum to the unit count`, () => {
      const lanes = data.lanes.reduce((sum, lane) => sum + lane.count, 0)
      expect(lanes).toBe(data.unitCount)
    })

    test(`${name}: lanes are listed once each, in lane order`, () => {
      expect(data.lanes.map((lane) => lane.lane)).toEqual([...LANE_ORDER])
    })

    test(`${name}: "need you" and the decided units are the human-required lane, each unit once`, () => {
      const decided = data.decided ?? []
      expect(data.needYou + decided.length).toBe(
        laneCount(data, "human-required")!
      )
      expect(data.judgment).toHaveLength(data.needYou)
      const ids = [...data.judgment, ...decided].map((unit) => unit.id)
      expect(new Set(ids).size).toBe(ids.length)
    })

    // Why: the overview lists every unit under its lane from `units`, beside
    // the counts and "Needs your decision"; a fixture where they disagree
    // would show a unit twice, or a lane whose rows don't match its count.
    test(`${name}: the unit rows match the lane counts and the decisions`, () => {
      if (!data.units) return
      for (const lane of LANE_ORDER)
        expect(data.units.filter((unit) => unit.lane === lane)).toHaveLength(
          laneCount(data, lane)!
        )
      const required = data.units.filter(
        (unit) => unit.lane === "human-required"
      )
      expect(
        required.filter((unit) => !unit.review).map((unit) => unit.id)
      ).toEqual(data.judgment.map((unit) => unit.id))
      expect(
        required
          .filter((unit) => unit.review)
          .map((unit) => [unit.id, unit.review!.verdict])
      ).toEqual(
        (data.decided ?? []).map((unit) => [unit.id, unit.review.verdict])
      )
    })

    test(`${name}: the first action opens the first unit that needs you, else the first decided`, () => {
      expect(data.firstUnitId).toBe(
        data.judgment[0]?.id ?? data.decided?.[0]?.id ?? data.units![0]!.id
      )
    })

    // Why: the decision panel names these units instead of saying nothing
    // needs you, and the projection names every one there is. A fixture that
    // named a unit with no agent's request for changes, or one a person
    // decided, or left out a row whose agent requested changes, would show a
    // panel the projection never gives.
    test(`${name}: the units an agent requested changes on are exactly its rows with one no person decided`, () => {
      if (data.agentChanges) expect(data.agentChanges.length).toBeGreaterThan(0)
      const named = new Map(
        (data.agentChanges ?? []).map((unit) => [unit.id, unit])
      )
      const rows = data.units ?? []
      for (const row of rows)
        if (
          row.review?.actor.kind === "agent" &&
          row.review.verdict === "changes_requested"
        )
          expect(named.get(row.id)?.title).toBe(row.title)
      const byId = new Map(rows.map((unit) => [unit.id, unit]))
      for (const unit of named.values()) {
        const row = byId.get(unit.id)
        expect(row?.title).toBe(unit.title)
        // A human-required row shows no agent's review; elsewhere the
        // agent's request is the review that stands.
        if (row?.lane === "human-required") expect(row.review).toBeUndefined()
        else expect(row?.review?.verdict).toBe("changes_requested")
        if (row?.review) expect(row.review.actor.kind).toBe("agent")
      }
    })
  }
})

/**
 * A review publishes its batches one at a time (12 November 2026): what the
 * overview and the Reviews page say is still being reviewed, and what waits
 * on you, must add up across the batches.
 */
describe("batches still being reviewed", () => {
  for (const [name, data] of Object.entries(OVERVIEWS)) {
    // Why: "N batches not reviewed" stands in for the pending batches; a
    // review that stopped with none unpublished has nothing to say there.
    test(`${name}: a review stops only with batches unpublished`, () => {
      if (data.batches?.stopped) expect(data.batches.pending).toBeGreaterThan(0)
    })

    const batches = data.batches
    if (batches?.pending === undefined) continue
    // Why: an unpublished batch has no units yet, so the overview's "need
    // you" is its own published batch's, never more.
    test(`${name}: "need you" counts only the batch on screen`, () => {
      const own = batches.all.find((each) => each.id === batches.current)
      expect(own?.needYou).toBe(data.needYou)
    })
  }

  // Why: the overview's meta row, the desk's batch menu and the Reviews
  // row's "2 of 3 batches" are built by different code (the Reviews page
  // counts its own pending); they must name the same published batches and
  // the same number still to come. (This replaces a check that restated the
  // builder: published plus pending against the builder's own total.)
  test("the overview, the desk and the Reviews page agree on the batches", () => {
    const pairs = [
      [
        linkExpiryOverviewFixture,
        lanesDeskFixture,
        linkExpiryClosureReviewsFixture,
      ],
      [
        linkExpiryArrivedOverviewFixture,
        lanesArrivedDeskFixture,
        linkExpiryClosureArrivedReviewsFixture,
      ],
    ] as const
    for (const [overview, desk, page] of pairs) {
      const review = page.reviews[0]!
      const ids = overview.batches!.all.map((each) => each.id)
      expect(desk.batches!.all.map((each) => each.id)).toEqual(ids)
      expect(review.batches.map((each) => each.id)).toEqual(ids)
      expect(desk.batches!.pending).toBe(overview.batches!.pending)
      expect(review.pendingBatches).toBe(overview.batches!.pending)
    }
  })

  for (const [name, data] of Object.entries(REVIEWS_PAGES)) {
    // Why: a row's lane counts and its batches describe the same units; a
    // hand-written review whose two disagree draws a review of two sizes.
    test(`${name}: each review's lanes count its batches' units`, () => {
      for (const review of data.reviews)
        expect(review.lanes.reduce((sum, lane) => sum + lane.count, 0)).toBe(
          review.batches.reduce((sum, each) => sum + each.unitCount, 0)
        )
    })

    // Why: only published units exist to be counted; "units wait on you"
    // and each row's "to decide" must come from the published batches alone.
    test(`${name}: what waits on you is in published batches only`, () => {
      const waiting = (review: (typeof data.reviews)[number]) =>
        review.gate.filter((unit) => unit.mark === "waiting").length
      for (const review of data.reviews)
        expect(waiting(review)).toBe(
          review.batches.reduce((sum, each) => sum + each.needYou, 0)
        )
      expect(data.waiting.units).toBe(
        data.reviews.reduce((sum, review) => sum + waiting(review), 0)
      )
    })
  }
})

/** The desks of the real-lanes scenario a story renders. */
const LANE_DESKS: Record<string, ReviewDeskData> = {
  lanesDeskFixture,
  lanesWithStaticDeskFixture,
  lanesArrivedDeskFixture,
  noAgentDecisionDeskFixture,
  noAgentDecisionArrivedDeskFixture,
  undecidedSectionDeskFixture,
  carriedRailDeskFixture,
  carriedUnitDeskFixture,
  carriedSuggestedDeskFixture,
  wholeUnitCommentsDeskFixture,
  earlierVersionDeskFixture,
  lockfileRailDeskFixture,
  lockfileDeskFixture,
  lockfileLongLaneDeskFixture,
  partsOnlyDeskFixture,
}

describe("the real-lanes desks", () => {
  for (const [name, data] of Object.entries(LANE_DESKS)) {
    // Why: the gate meter, "Needs your decision" and the batch's units are
    // three lists of one thing; a fixture where they disagree draws a gate
    // that never fills or a unit twice.
    test(`${name}: the gate, the rail and the batch agree`, () => {
      expect(data.humanRequiredTotal).toBe(data.railUnits.length)
      // A unit a carried decision closes is in the rail's "Decided" group,
      // never under "Needs your decision".
      const carried = new Set((data.carriedUnits ?? []).map((unit) => unit.id))
      expect(
        [...data.railUnits, ...(data.carriedUnits ?? [])].map((unit) => unit.id)
      ).toEqual(
        data.batchUnits
          .filter((unit) => unit.lane === "human-required")
          .map((unit) => unit.id)
          .sort((a, b) => Number(carried.has(a)) - Number(carried.has(b)))
      )
      // A unit no agent read is in the rail's "Not read" group, never in its
      // lane's group: together they are the lane's units.
      const notRead = new Set((data.notReadUnits ?? []).map((unit) => unit.id))
      for (const unit of data.notReadUnits ?? []) {
        expect(unit.excluded).toBeDefined()
        expect(data.batchUnits.find((each) => each.id === unit.id)?.lane).toBe(
          unit.lane
        )
      }
      for (const group of data.elsewhere) {
        for (const unit of group.units ?? [])
          expect(unit).not.toHaveProperty("excluded")
        expect(group.units!.map((unit) => unit.id)).toEqual(
          data.batchUnits
            .filter((unit) => unit.lane === group.lane && !notRead.has(unit.id))
            .map((unit) => unit.id)
        )
      }
    })

    // Why: the head line's "1 of 3" and the rail's selected row must be the
    // same unit, in its lane.
    test(`${name}: the open unit is its rail row, in its lane`, () => {
      const unit = data.batchUnits.find((each) => each.id === data.unit.id)
      expect(unit?.lane).toBe(data.unit.lane)
      // The head counts it among the batch's units of its lane, in the
      // batch's order, whichever rail group lists it.
      const { index, of } = data.unit.position
      const inLane = data.batchUnits.filter(
        (each) => each.lane === data.unit.lane
      )
      expect(of).toBe(inLane.length)
      expect(inLane[index - 1]?.id).toBe(data.unit.id)
    })

    // Why: the rail's "3 hunks" is read from the scenario; the diff is
    // built change by change. They must count the same hunks.
    test(`${name}: the rail counts the hunks the open unit's diff owns`, () => {
      const owned = new Set(
        data.files.flatMap((file) =>
          (file.responsibility?.ownedSource ?? []).map(
            (source) => source.hunkId
          )
        )
      )
      const rail = [...data.railUnits, ...(data.carriedUnits ?? [])].find(
        (unit) => unit.id === data.unit.id
      )
      // A unit outside human-required work has no count on the rail.
      if (!rail) return
      expect(owned.size).toBe(rail.hunkCount)
      expect(data.unit.hunkCount).toBe(rail.hunkCount)
    })
  }

  // Why: the overview and the desk tell one story; a unit must have the
  // same title, lane, review, rise and hunks wherever the reader meets it.
  test("the overview and the desk describe the same units", () => {
    const pairs = [
      [linkExpiryOverviewFixture, lanesDeskFixture],
      [linkExpiryStaticOverviewFixture, lanesWithStaticDeskFixture],
      [linkExpiryLockfileOverviewFixture, lockfileRailDeskFixture],
      [linkExpiryLockfileOverviewFixture, lockfileDeskFixture],
      [linkExpiryCarriedChangesOverviewFixture, carriedSuggestedDeskFixture],
    ] as const
    for (const [overview, desk] of pairs) {
      expect(desk.revision).toBe(overview.revision)
      expect(
        desk.batchUnits.map(({ id, title, lane }) => ({ id, title, lane }))
      ).toEqual(
        overview.units!.map(({ id, title, lane }) => ({ id, title, lane }))
      )
      for (const row of overview.judgment) {
        const rail = desk.railUnits.find((unit) => unit.id === row.id)!
        expect([row.title, row.hunks, row.agentId]).toEqual([
          rail.title,
          rail.hunkCount,
          rail.agentId,
        ])
        expect(row.raisedFrom).toBe(rail.raisedFrom)
        expect(row.noAgentDecision).toBe(rail.noAgentDecision)
        expect(row.untitled).toEqual(rail.untitled)
      }
      for (const group of desk.elsewhere)
        for (const unit of group.units ?? []) {
          const listed = overview.units!.find((each) => each.id === unit.id)!
          expect(listed.raisedFrom).toBe(unit.raisedFrom)
          // A person's review that stands is the row's on both, else the agent's.
          expect(listed.review?.verdict).toBe(
            unit.personReview?.verdict ?? unit.review?.verdict
          )
          expect(
            listed.review?.actor.kind === "agent"
              ? listed.review.actor.agent.id
              : undefined
          ).toBe(unit.review?.reviewer.id)
          expect(listed.review?.carried).toBe(unit.personReview?.carried)
          expect(listed.excluded).toEqual(unit.excluded)
        }
      for (const unit of desk.notReadUnits ?? []) {
        const listed = overview.units!.find((each) => each.id === unit.id)!
        expect(listed.lane).toBe(unit.lane)
        expect(listed.excluded).toEqual(unit.excluded)
      }
      if (desk.unit.excluded)
        expect(
          overview.units!.find((each) => each.id === desk.unit.id)?.excluded
        ).toEqual(desk.unit.excluded)
    }
  })
})

// Why (14.18): a lockfile or a generated file no agent read never waits on a
// person and is counted once on the overview; a fixture that listed it under
// "Needs your decision", or counted it apart from its rows, would say two
// things.
describe("files no agent read", () => {
  for (const [name, data] of Object.entries(OVERVIEWS)) {
    const excluded = (data.units ?? []).filter((unit) => unit.excluded)
    test(`${name}: the not-read count is its rows, none of them waiting`, () => {
      expect(data.notRead ?? 0).toBe(excluded.length)
      const waiting = new Set(data.judgment.map((unit) => unit.id))
      for (const unit of excluded) {
        expect(waiting.has(unit.id)).toBe(false)
        expect(unit.lane).not.toBe("human-required")
        expect(unit.review).toBeUndefined()
      }
    })
  }
  for (const [name, data] of Object.entries(LANE_DESKS)) {
    test(`${name}: a row no agent read is never under "Needs your decision"`, () => {
      for (const unit of data.railUnits)
        expect(unit).not.toHaveProperty("excluded")
      if (data.unit.excluded)
        expect(data.unit).not.toHaveProperty("attribution")
    })
  }
})

// Why (14.12): a decision on an earlier version counts for nothing here: it
// never makes the unit decided, never moves it out of "Needs your decision"
// and is never the dock's. Only the unit's own decision does those, so a
// fixture whose notes stand alone must read as undecided.
describe("decisions on an earlier version", () => {
  for (const [name, data] of Object.entries(LANE_DESKS)) {
    if (!data.unit.earlierDecisions) continue
    test(`${name}: they count for nothing`, () => {
      const own = data.currentDecision !== undefined
      expect((data.carriedUnits ?? []).map((unit) => unit.id)).not.toContain(
        data.unit.id
      )
      expect((data.humanDecidedUnitIds ?? []).includes(data.unit.id)).toBe(own)
    })
  }
})

/** A lane's rank: 0 is human-required, the highest. */
const rank = (lane: ReviewLane) => LANE_ORDER.indexOf(lane)

describe("a unit's lane facts", () => {
  for (const [name, data] of Object.entries(OVERVIEWS)) {
    const units = data.units ?? []

    // Why: a briefing phrase that names a unit opens it; one that names a
    // unit outside the batch leads nowhere.
    test(`${name}: the briefing's unit links open units of the batch`, () => {
      const briefing = data.contextualBriefing
      if (!briefing || units.length === 0) return
      const ids = new Set(units.map((unit) => unit.id))
      for (const segment of [
        ...(briefing.removed ?? []),
        ...briefing.segments,
        ...(briefing.toCheck ?? []),
      ])
        if (segment.kind === "phrase" && segment.target.kind === "unit")
          expect(ids.has(segment.target.unitId)).toBe(true)
    })

    // Why: "No agent decision in this run" is said only where a person must
    // decide, and such a unit never shows an agent's review; a person's
    // review stands on it once they decide.
    test(`${name}: a unit no agent decided is human-required, with no agent's review`, () => {
      for (const unit of units.filter((each) => each.noAgentDecision)) {
        expect(unit.lane).toBe("human-required")
        expect(unit.review?.actor.kind).not.toBe("agent")
      }
      const flagged = new Set(
        units.filter((unit) => unit.noAgentDecision).map((unit) => unit.id)
      )
      for (const row of data.judgment.filter((each) => each.noAgentDecision))
        if (units.length > 0) expect(flagged.has(row.id)).toBe(true)
    })

    // Why: "Moved up from …" names where the unit came from; a lane that is
    // not lower than its own would say it moved down, or nowhere.
    test(`${name}: a unit moved up from a lower lane than its own`, () => {
      for (const unit of units)
        if (unit.raisedFrom)
          expect(rank(unit.raisedFrom)).toBeGreaterThan(rank(unit.lane))
      for (const row of data.judgment)
        if (row.raisedFrom)
          expect(rank(row.raisedFrom)).toBeGreaterThan(rank("human-required"))
    })
  }
})

describe("overview and desk agree", () => {
  const desk = reviewDeskFixture
  const overview = batchOverviewFixture

  test("the batch has as many units as the overview counts", () => {
    expect(desk.batchUnits).toHaveLength(overview.unitCount)
    expect(new Set(desk.batchUnits.map((unit) => unit.id)).size).toBe(
      overview.unitCount
    )
  })

  test("each lane's count is the number of its units", () => {
    for (const lane of LANE_ORDER)
      expect(laneCount(overview, lane)).toBe(
        desk.batchUnits.filter((unit) => unit.lane === lane).length
      )
  })

  test("the rail's lane groups list every unit they count", () => {
    for (const group of desk.elsewhere) {
      expect(group.units).toHaveLength(group.count)
      expect(group.count).toBe(laneCount(overview, group.lane)!)
      expect(group.units!.map((unit) => unit.id)).toEqual(
        desk.batchUnits
          .filter((unit) => unit.lane === group.lane)
          .map((unit) => unit.id)
      )
    }
    expect(deskBatchContextFixture.elsewhere).toEqual(desk.elsewhere)
  })

  test("the human gate counts the units the overview says need you", () => {
    expect(desk.humanRequiredTotal).toBe(overview.needYou)
    expect(desk.railUnits.map((unit) => unit.id)).toEqual(
      overview.judgment.map((row) => row.id)
    )
  })

  test("each judgment row describes its unit's rail row and desk", () => {
    for (const row of overview.judgment) {
      const rail = desk.railUnits.find((unit) => unit.id === row.id)!
      expect(row.title).toBe(rail.title)
      expect(row.hunks).toBe(rail.hunkCount)
      expect(row.agentId).toBe(rail.agentId)
      const unitDesk = mockDeskFixtures.find((d) => d.unit.id === row.id)
      if (!unitDesk) continue
      expect(row.files).toBe(unitDesk.files.length)
      expect(row.markers).toBe(Object.keys(unitDesk.markers).length)
      expect(row.hunks).toBe(unitDesk.unit.hunkCount)
    }
  })

  test("the agentic lane line counts its verdicts", () => {
    const units =
      desk.elsewhere.find((group) => group.lane === "agentic-review")?.units ??
      []
    const approved = units.filter(
      (unit) => unit.review?.verdict === "approved"
    ).length
    const sentBack = units.filter(
      (unit) => unit.review?.verdict === "changes_requested"
    ).length
    expect(approved + sentBack).toBe(units.length)
    expect(
      overview.lanes.find((lane) => lane.lane === "agentic-review")?.line
    ).toBe(`${approved} approved · ${sentBack} sent back to the implementer.`)
  })
})

describe("every desk", () => {
  for (const [name, data] of Object.entries(DESKS)) {
    test(`${name}: the gate, the rail and the batch agree`, () => {
      const required = data.batchUnits.filter(
        (unit) => unit.lane === "human-required"
      )
      expect(data.humanRequiredTotal).toBe(data.railUnits.length)
      expect(data.railUnits.map((unit) => unit.id)).toEqual(
        required.map((unit) => unit.id)
      )
      expect(data.humanRequiredTotal).toBe(batchOverviewFixture.needYou)
    })

    test(`${name}: the open unit is in the batch, in its lane`, () => {
      const unit = data.batchUnits.find((entry) => entry.id === data.unit.id)
      expect(unit).toBeDefined()
      if (!LANE_VARIANTS.has(name)) expect(unit?.lane).toBe(data.unit.lane)
    })

    test(`${name}: a human-required unit's position is its rail row`, () => {
      if (data.unit.lane !== "human-required") return
      const { index, of } = data.unit.position
      expect(of).toBe(data.railUnits.length)
      expect(data.railUnits[index - 1]?.id).toBe(data.unit.id)
    })

    test(`${name}: the reviewer is the one reviewer`, () => {
      expect(data.reviewer).toEqual(REVIEWER)
    })

    test(`${name}: decided units are human-required units`, () => {
      const rail = new Set(data.railUnits.map((unit) => unit.id))
      for (const id of data.humanDecidedUnitIds ?? [])
        expect(rail.has(id)).toBe(true)
    })
  }

  test("after the last undecided unit nothing else needs you; before it, the admins unit does", () => {
    const others = (data: ReviewDeskData) =>
      data.railUnits.filter((unit) => unit.id !== data.unit.id)
    const decided = new Set(lastUndecidedDeskFixture.humanDecidedUnitIds)
    expect(
      others(lastUndecidedDeskFixture).every((unit) => decided.has(unit.id))
    ).toBe(true)
    const next = others(nextUndecidedDeskFixture).find(
      (unit) => !nextUndecidedDeskFixture.humanDecidedUnitIds?.includes(unit.id)
    )
    expect(next?.id).toBe(ADMINS_UNIT_ID)
  })
})

describe("one reviewer identity", () => {
  const all = JSON.stringify({ ...batch, ...shell })

  test("no fixture draws the placeholder initials", () => {
    expect(all).not.toContain('"initials":"YO"')
  })

  test("everything the reviewer authored carries the same identity", () => {
    const records = [
      ...batch.reviewCommentFixtures,
      ...batch.mockReviewCommentFixtures,
      ...batch.longFileCommentFixtures,
      batch.crossSideCommentFixture,
    ]
    for (const record of records)
      if (record.author.id === REVIEWER.id)
        expect(record.author).toEqual(REVIEWER)
    expect(batch.followUpReply.author).toEqual({ kind: "human", ...REVIEWER })
  })

  test("the registered lineage's viewer is the reviewer, and only they read You", () => {
    const view = registeredLineageFixture
    const authors = [
      ...(view.before?.units ?? []),
      ...view.after.units,
    ].flatMap((unit) => unit.dispositions.map((entry) => entry.author))
    if (view.relations.kind === "recorded")
      authors.push(...view.relations.records.map((record) => record.author))
    for (const author of authors) {
      expect(author.viewer).toBe(
        author.kind === "human" && author.id === REVIEWER.id
      )
      if (author.kind === "agent")
        expect(
          agentRegistryFixture.agents.some((agent) => agent.id === author.id)
        ).toBe(true)
    }
    expect(authors.some((author) => author.viewer)).toBe(true)
  })
})

describe("lineage verdicts name who recorded them", () => {
  const lineage = commitLineageFixture
  const TONE = { approved: "approved", changes: "changes_requested" } as const

  const LINEAGES: Record<string, CommitLineage> = {
    commitLineageFixture,
    commitLineageWithPendingFixture,
  }

  for (const [name, each] of Object.entries(LINEAGES))
    test(`${name}: need you and carried forward are counted from the entries`, () => {
      expect(each.needYou).toBe(
        each.entries.filter((entry) => entry.needsYou).length
      )
      expect(each.carried).toBe(
        each.entries.filter((entry) => entry.relation === "carried").length
      )
    })

  test("the notice, the desk and the lineage describe one commit pair", () => {
    expect(newCommitFixture.needYou).toBe(lineage.needYou)
    expect(newCommitFixture.reviewing).toBe(reviewDeskFixture.revision)
    expect(lineage.from).toBe(reviewDeskFixture.revision)
    expect(lineage.to).toBe(newCommitFixture.commit)
    expect(lineage.cycle).toBe(reviewDeskFixture.cycle + 1)
    expect(observedCommitLoadFixture.commit.from).toBe(lineage.from)
    expect(observedCommitLoadFixture.commit.to).toBe(lineage.to)
    expect(unavailableCommitLoadFixture.batch.revision).toBe(lineage.from)
    expect(unavailableCommitLoadFixture.commit).toBe(lineage.to)
  })

  /** Words that claim a verdict: "you ✓", "agent ✕", "R1 approved"… */
  const VERDICT_WORDS = /✓|✕|approved|requested changes/i

  test("a status without a review claims no verdict", () => {
    const unreviewed = Object.values(LINEAGES)
      .flatMap((each) => each.entries.flatMap((entry) => entry.before))
      .filter((unit) => !unit.review)
    expect(unreviewed.length).toBeGreaterThan(0)
    for (const unit of unreviewed)
      expect(unit.result).not.toMatch(VERDICT_WORDS)
  })

  test("every earlier verdict carries its actor, matching its words", () => {
    const units = Object.values(LINEAGES).flatMap((each) =>
      each.entries.flatMap((entry) => entry.before)
    )
    for (const unit of units) {
      const review = unit.review
      if (!review) continue
      expect(unit.result).toMatch(VERDICT_WORDS)
      const { actor } = review
      if (actor.kind === "person") {
        expect(actor.isYou).toBe(true)
        expect(actor.person).toEqual(REVIEWER)
        expect(review.verdict).toBe(TONE[unit.tone as keyof typeof TONE])
      } else {
        const agent = agentRegistryFixture.agents.find(
          (entry) => entry.id === actor.agent.id
        )!
        expect(actor.agent).toEqual({
          id: agent.id,
          short: agent.short,
          name: agent.name,
          role: agent.role,
        })
        expect(unit.tone).toBe("agent")
      }
    }
  })

  test("a carried verdict is the one the rail shows for that unit", () => {
    const rail = reviewDeskFixture.elsewhere.flatMap((group) => group.units!)
    for (const unit of lineage.entries.flatMap((entry) => entry.before)) {
      const listed = rail.find((entry) => entry.title === unit.title)
      if (!listed?.review || unit.review?.actor.kind !== "agent") continue
      expect(unit.review.actor.agent.id).toBe(listed.review.reviewer.id)
      expect(unit.review.verdict).toBe(listed.review.verdict)
    }
  })

  test("a registered unit's status agrees with its current disposition", () => {
    const view = registeredLineageFixture
    for (const unit of [...(view.before?.units ?? []), ...view.after.units]) {
      const current = [...unit.dispositions]
        .reverse()
        .find((entry) => entry.current && !entry.retracted)
      if (!current) {
        expect(unit.result).not.toMatch(/approved|requested changes/)
        continue
      }
      expect(unit.result).toBe(
        `${current.author.kind === "human" ? "Human" : "Agent"} ${
          current.decision === "approve" ? "approved" : "requested changes"
        }`
      )
    }
  })
})

/**
 * Colour by meaning (vocabulary.md, "Marker kind"): magenta (`req`) means a
 * decision is needed; amber (`sug`) means evidence is missing or failed. A
 * source-sheet chip, fact or row that reports missing, failed or unresolved
 * evidence must never be magenta.
 */
describe("missing or failed evidence is amber, never magenta", () => {
  const EVIDENCE_WORDS =
    /\b(no evidence|missing|failed|unresolved|unavailable|not covered|gap)\b/i
  const markers: Array<[string, ContextualMarker]> = [
    ...Object.values(DESKS).flatMap((desk) =>
      Object.entries(desk.markers).map(
        ([key, marker]): [string, ContextualMarker] => [
          `${desk.unit.id}:${key}`,
          marker,
        ]
      )
    ),
    ...Object.entries(batch.markerKindFixtures),
  ]

  test("no source-sheet entry about missing evidence uses req", () => {
    const offenders: string[] = []
    for (const [where, marker] of markers) {
      const source = marker.source
      const entries = [
        ...source.chips.map((chip) => ({ text: chip.text, tone: chip.tone })),
        ...source.facts.map((fact) => ({
          text: `${fact.label} ${fact.value}`,
          tone: fact.tone,
        })),
        ...source.blocks.flatMap((block) =>
          block.kind === "rows"
            ? block.rows.map((row) => ({
                text: [row.mark, row.label, row.meta].join(" "),
                tone: row.tone,
              }))
            : []
        ),
      ]
      for (const entry of entries)
        if (entry.tone === "req" && EVIDENCE_WORDS.test(entry.text))
          offenders.push(`${where}: ${entry.text}`)
    }
    expect(offenders).toEqual([])
  })
})

/**
 * Literal anchors. Every other number in these fixtures is derived, so a
 * deleted, added or reassigned unit would move every surface at once.
 * These make that a deliberate edit. Change them together with what draws
 * them:
 * - the Header board: each agent's "N units" and the 0/N gate;
 * - the Overview board: the unit count, "need you" and the lane counts;
 * - the Main board: "1 of N" and the 0/N gate;
 * - the Cycle board: "N of M";
 * - the Pen screens that draw the same numbers.
 * The boards are `design/neuve-web/design-export/*.dc.html` in the Neuve
 * repository.
 */
describe("the numbers the canvas shows", () => {
  test("26 units, 4 need you, lanes 4/3/7/12", () => {
    expect(batchOverviewFixture.unitCount).toBe(26)
    expect(batchOverviewFixture.needYou).toBe(4)
    expect(batchOverviewFixture.lanes.map((lane) => lane.count)).toEqual([
      4, 3, 7, 12,
    ])
  })

  test('the desk reads "1 of 4" and its gate counts 4', () => {
    expect(reviewDeskFixture.unit.position).toEqual({ index: 1, of: 4 })
    expect(reviewDeskFixture.humanRequiredTotal).toBe(4)
  })

  test("the agents read I1 9, I2 5, R1 7, R2 3 units", () => {
    expect(
      Object.fromEntries(
        agentRegistryFixture.agents.map((agent) => [
          agent.short,
          agent.unitCount,
        ])
      )
    ).toEqual({ I1: 9, I2: 5, R1: 7, R2: 3 })
  })
})

/**
 * An agent's "N units" counts the units bound to it, as the live server
 * counts a binding's units: the units an implementer implements, and the
 * units a reviewer reviewed.
 */
describe("agents count the units bound to them", () => {
  const laneUnits = reviewDeskFixture.elsewhere.flatMap(
    (group) => group.units ?? []
  )
  const bound = (agentId: string, role: string) =>
    role === "implementer"
      ? reviewDeskFixture.batchUnits.filter(
          (unit) => UNIT_IMPLEMENTERS[unit.id] === agentId
        ).length
      : laneUnits.filter((unit) => unit.review?.reviewer.id === agentId).length

  for (const agent of agentRegistryFixture.agents)
    test(`${agent.short}: "${agent.unitCount} units" are its bound units`, () => {
      expect(agent.unitCount).toBe(bound(agent.id, agent.role))
    })

  test("every recorded implementer is an implementer on the branch, bound to a unit of the batch", () => {
    const units = new Set(reviewDeskFixture.batchUnits.map((unit) => unit.id))
    for (const [unitId, agentId] of Object.entries(UNIT_IMPLEMENTERS)) {
      expect(units.has(unitId)).toBe(true)
      expect(
        agentRegistryFixture.agents.find((agent) => agent.id === agentId)?.role
      ).toBe("implementer")
    }
  })

  test("the rail, the judgment table and every desk name the bound implementer", () => {
    for (const unit of reviewDeskFixture.railUnits)
      expect(unit.agentId).toBe(UNIT_IMPLEMENTERS[unit.id])
    for (const row of batchOverviewFixture.judgment)
      expect(row.agentId).toBe(UNIT_IMPLEMENTERS[row.id])
    for (const [name, data] of Object.entries(DESKS)) {
      if (LANE_VARIANTS.has(name)) continue
      expect([name, data.unit.agentId]).toEqual([
        name,
        UNIT_IMPLEMENTERS[data.unit.id],
      ])
    }
  })

  test("every reviewer verdict is by a reviewer on the branch", () => {
    for (const unit of laneUnits)
      if (unit.review)
        expect(
          agentRegistryFixture.agents.find(
            (agent) => agent.id === unit.review!.reviewer.id
          )?.role
        ).toBe("reviewer")
  })
})

/**
 * Colour by kind: a neutral marker kind (test, captured source, graph,
 * history, doc, contextual signal) informs and asks nothing, so nothing on
 * its source sheet is magenta. A decision it raises is said in its "Before
 * you decide" text, not by colour.
 */
describe("neutral marker kinds never ask for a decision by colour", () => {
  test("no neutral-kind source sheet uses req", () => {
    const sheets: Array<[string, ContextualMarker]> = [
      ...Object.values(DESKS).flatMap((desk) =>
        Object.entries(desk.markers).map(
          ([key, marker]): [string, ContextualMarker] => [
            `${desk.unit.id}:${key}`,
            marker,
          ]
        )
      ),
      ...Object.entries(batch.markerKindFixtures),
    ]
    const offenders: string[] = []
    for (const [where, marker] of sheets) {
      if (markerFamily(markerKind(marker)) !== "neutral") continue
      const source = marker.source
      const tones = [
        ...source.chips.map((chip) => [chip.text, chip.tone] as const),
        ...source.facts.map((fact) => [fact.label, fact.tone] as const),
        ...source.blocks.flatMap((block) =>
          block.kind === "rows"
            ? block.rows.map((row) => [row.label, row.tone] as const)
            : []
        ),
      ]
      for (const [text, tone] of tones)
        if (tone === "req") offenders.push(`${where}: ${text}`)
    }
    expect(offenders).toEqual([])
  })
})

// Why (12 November 2026, the owner's ruling): a person's decision carried from an earlier review
// closes its unit. A surface that still counted it as waiting, beside one that shows it decided,
// would ask the reader for a decision they never owe.
describe("a carried decision", () => {
  for (const [name, data] of Object.entries(OVERVIEWS)) {
    const carried = [...(data.decided ?? []), ...(data.units ?? [])]
      .filter((unit) => unit.review?.carried !== undefined)
      .map((unit) => unit.id)
    if (carried.length === 0) continue
    test(`${name}: a unit with a carried decision is never in "need you"`, () => {
      const waiting = new Set(data.judgment.map((unit) => unit.id))
      for (const id of carried) expect(waiting.has(id)).toBe(false)
      const own = data.batches?.all.find(
        (each) => each.id === data.batches?.current
      )
      expect(own?.needYou).toBe(data.needYou)
    })
  }
  for (const [name, data] of Object.entries(LANE_DESKS)) {
    const carried = data.carriedUnits ?? []
    if (carried.length === 0) continue
    // The rule (12 November 2026): the meter's total is the human-required
    // units that did not arrive closed by a person's carried decision (those
    // are the rail's "Decided" group for the whole review), and what it
    // counts decided is what the batch menu no longer counts as needing you.
    test(`${name}: the meter counts the human-required units no carried decision arrived on`, () => {
      for (const unit of carried) expect(unit.carriedReview).toBeDefined()
      for (const unit of data.railUnits)
        expect(unit).not.toHaveProperty("carriedReview")
      const required = data.batchUnits.filter(
        (unit) => unit.lane === "human-required"
      ).length
      expect(data.humanRequiredTotal).toBe(required - carried.length)
      for (const unit of carried)
        expect(data.humanDecidedUnitIds ?? []).not.toContain(unit.id)
      const own = data.batches?.all.find(
        (each) => each.id === data.batches?.current
      )
      expect(own?.needYou).toBe(
        data.humanRequiredTotal - (data.humanDecidedUnitIds ?? []).length
      )
    })
  }
})

// Why: the overview and the desk of one batch must agree on what still needs
// the reader when a decision carried: the overview's "need you" is the
// desk meter's total less what it counts decided.
test("the carried overview and desk agree on what needs you", () => {
  const overview = linkExpiryCarriedOverviewFixture
  for (const desk of [carriedRailDeskFixture, carriedUnitDeskFixture]) {
    expect(overview.needYou).toBe(
      desk.humanRequiredTotal - (desk.humanDecidedUnitIds ?? []).length
    )
    expect(desk.railUnits.map((unit) => unit.id)).toEqual(
      overview.judgment.map((row) => row.id)
    )
    expect((desk.carriedUnits ?? []).map((unit) => unit.id)).toEqual(
      (overview.decided ?? [])
        .filter((unit) => unit.review.carried !== undefined)
        .map((unit) => unit.id)
    )
  }
})
