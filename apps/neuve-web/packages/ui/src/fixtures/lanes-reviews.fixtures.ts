/*
 * The link-expiry review on the Reviews page as Records' closure rule counts
 * it (NEU-148, 13 November 2026), built from the scenario every lanes
 * fixture shares (lanes-scenario.fixtures.ts). A unit waits on you while its
 * closure still needs a person: every human-required unit no person has
 * decided. A human-suggested unit arrives with the agent's review, which
 * stands until you add yours, so it is decided. The branch's earlier review
 * is listed, but a newer review holds all of its units: it asks for nothing.
 */
import { LANE_ORDER } from "@workspace/ui/fixtures/review-batch.fixtures"
import { REVIEWS_NOW } from "@workspace/ui/fixtures/real-reviews.fixtures"
import { linkExpiryReviewsFixture } from "@workspace/ui/fixtures/lanes-overview.fixtures"
import {
  EARLIER_HEAD,
  EXPIRED_UNIT_ID,
  LANES_REVISION,
  SCENARIO_UNITS,
  SUGGESTED_BY_BATCH,
  linkExpiryBatchesFixture,
  unitsIn,
} from "@workspace/ui/fixtures/lanes-scenario.fixtures"
import type {
  ReviewBatch,
  ReviewGateUnit,
  ReviewSummary,
  ReviewsData,
} from "@workspace/ui/neuve/types"

const minutesBefore = (minutes: number) =>
  new Date(REVIEWS_NOW.getTime() - minutes * 60_000).toISOString()

/** The agent's review on each human-suggested unit of the first batch, as its square reads it. */
const FIRST_BATCH_SUGGESTED: ReadonlyArray<ReviewGateUnit> = unitsIn(
  SCENARIO_UNITS,
  "human-suggested"
).map((unit) => ({
  lane: "human-suggested",
  mark:
    unit.review?.verdict === "changes_requested"
      ? "changes-requested"
      : "approved",
}))

/**
 * Each published batch's human units in packet order: its human-required
 * ones waiting, unless `decided` names their place in the review's gate,
 * then its human-suggested ones under the agent's review (a later batch's
 * approved).
 */
function gateOf(
  published: number,
  decided: ReadonlySet<number> = new Set()
): Array<ReviewGateUnit> {
  return linkExpiryBatchesFixture
    .slice(0, published)
    .flatMap((batch, i): Array<ReviewGateUnit> => [
      ...Array.from({ length: batch.needYou }, () => ({
        lane: "human-required" as const,
        mark: "waiting" as const,
      })),
      ...(i === 0
        ? FIRST_BATCH_SUGGESTED
        : Array.from({ length: SUGGESTED_BY_BATCH[i]! }, () => ({
            lane: "human-suggested" as const,
            mark: "approved" as const,
          }))),
    ])
    .map((unit, index) =>
      decided.has(index) ? { ...unit, mark: "approved" as const } : unit
    )
}

/** The link-expiry review, `published` of its batches out; `decided` as in `gateOf`. */
function linkExpiryReview(
  published: number,
  decided: ReadonlySet<number> = new Set()
): ReviewSummary {
  const gate = gateOf(published, decided)
  // A batch's human-required units lead its part of the gate.
  let at = 0
  const batches: Array<ReviewBatch> = linkExpiryBatchesFixture
    .slice(0, published)
    .map((batch, i) => {
      const own = gate.slice(at, at + batch.needYou + SUGGESTED_BY_BATCH[i]!)
      at += own.length
      return {
        ...batch,
        needYou: own.filter((unit) => unit.mark === "waiting").length,
      }
    })
  const required = linkExpiryBatchesFixture
    .slice(0, published)
    .reduce((sum, batch) => sum + batch.needYou, 0)
  const suggested = SUGGESTED_BY_BATCH.slice(0, published).reduce(
    (a, b) => a + b,
    0
  )
  const units = batches.reduce((sum, batch) => sum + batch.unitCount, 0)
  const counts = { required, suggested, agentic: units - required - suggested }
  return {
    id: "cycle-shr-240",
    title: "Share links expire on a schedule",
    range: `4b1e9a0..${LANES_REVISION}`,
    at: minutesBefore(25),
    state: "running",
    lanes: LANE_ORDER.map((lane) => ({
      lane,
      count:
        lane === "human-required"
          ? counts.required
          : lane === "human-suggested"
            ? counts.suggested
            : lane === "agentic-review"
              ? counts.agentic
              : 0,
    })).filter((entry) => entry.count > 0),
    gate,
    feedback: false,
    batches,
    pendingBatches: linkExpiryBatchesFixture.length - published,
  }
}

/**
 * The branch's earlier review, at the head your approval of the admins unit
 * was made on. The link-expiry review holds every one of its units now, so
 * its row shows no square and nothing to decide, and says a newer review
 * holds it.
 */
export const EARLIER_LINK_EXPIRY_REVIEW: ReviewSummary = {
  id: "cycle-shr-240-earlier",
  title: "Share links expire on a schedule",
  range: `4b1e9a0..${EARLIER_HEAD}`,
  at: minutesBefore(3 * 60),
  state: "completed",
  lanes: [
    { lane: "human-required", count: 2 },
    { lane: "human-suggested", count: 1 },
    { lane: "agentic-review", count: 3 },
  ],
  gate: [],
  feedback: false,
  batches: [
    {
      id: "batch-link-expiry-earlier",
      title: "Share links expire on a schedule",
      unitCount: 6,
      needYou: 0,
    },
  ],
  newer: true,
}

/** Another branch's review, every human unit decided (the overview fixtures' own). */
const REVOKE_REVIEW = linkExpiryReviewsFixture.reviews[1]!

function reviewsPage(
  running: ReviewSummary,
  options: { readonly earlier?: boolean } = {}
): ReviewsData {
  const reviews = [
    running,
    ...(options.earlier ? [EARLIER_LINK_EXPIRY_REVIEW] : []),
    REVOKE_REVIEW,
  ]
  const waiting = (review: ReviewSummary) =>
    review.gate.filter((unit) => unit.mark === "waiting").length
  const waitingReviews = reviews.filter((review) => waiting(review) > 0)
  return {
    repo: "acme/docs-app",
    reviews,
    filter: "all",
    page: 1,
    pageSize: 10,
    total: reviews.length,
    counts: { all: reviews.length, waiting: waitingReviews.length },
    waiting: {
      units: reviews.reduce((sum, review) => sum + waiting(review), 0),
      reviews: waitingReviews.length,
      nextUnitId: EXPIRED_UNIT_ID,
    },
  }
}

/** The running review with its first batch out: its three human-required units wait. */
export const linkExpiryClosureReviewsFixture = reviewsPage(linkExpiryReview(1))

/** The same page once the second batch arrived: its human-required unit waits too. */
export const linkExpiryClosureArrivedReviewsFixture = reviewsPage(
  linkExpiryReview(2)
)

/**
 * Your earlier approval of the admins unit carried: its square reads
 * approved (the admins unit is the gate's second), and one fewer waits.
 */
export const linkExpiryClosureCarriedReviewsFixture = reviewsPage(
  linkExpiryReview(1, new Set([1]))
)

/**
 * The same, with the branch's earlier review listed under it: a newer
 * review holds its units, so nothing of it waits on you and the
 * "Waiting on you" filter leaves it out.
 */
export const linkExpiryOlderReviewsFixture = reviewsPage(
  linkExpiryReview(1, new Set([1])),
  { earlier: true }
)
