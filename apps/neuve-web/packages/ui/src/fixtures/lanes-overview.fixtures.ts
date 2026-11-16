/*
 * Real review lanes on the batch overview and the Reviews page (NEU-148,
 * 12 November 2026), built from the scenario every lanes fixture shares
 * (lanes-scenario.fixtures.ts). Every count is derived from its units, as
 * the BFF derives it.
 */
import {
  LANE_ORDER,
  REVIEWER,
  agentChangesOf,
  agentRegistryFixture,
  batchCounts,
} from "@workspace/ui/fixtures/review-batch.fixtures"
import { REVIEWS_NOW } from "@workspace/ui/fixtures/real-reviews.fixtures"
import {
  CARRIED_LABEL,
  EXPIRED_UNIT_ID,
  EXPIRY_PATH,
  EXTEND_UNIT_ID,
  LANES_REVISION,
  LINK_EXPIRY_BATCH_ID,
  LINK_LIST_UNIT_ID,
  NEWER_BATCH_ID,
  RENAME_UNIT_ID,
  TIME_ZONE_UNIT_ID,
  carriedBatches,
  SCENARIO_LOCKFILE_UNITS,
  SCENARIO_STATIC_UNITS,
  SCENARIO_UNITS,
  SUGGESTED_BY_BATCH,
  linkExpiryBatchesFixture,
  publishedBatches,
  unitsIn,
} from "@workspace/ui/fixtures/lanes-scenario.fixtures"
import type { ScenarioUnit } from "@workspace/ui/fixtures/lanes-scenario.fixtures"
import type {
  BatchOverviewData,
  BatchUnit,
  ContextualMarker,
  JudgmentUnit,
  OverviewUnit,
  ReviewBatch,
  ReviewBatches,
  ReviewGateUnit,
  ReviewLane,
  ReviewSummary,
  ReviewsData,
} from "@workspace/ui/neuve/types"

/** A scenario unit as the overview lists it, with the agent's review. */
const overviewUnit = (unit: ScenarioUnit): OverviewUnit => ({
  id: unit.id,
  title: unit.title,
  lane: unit.lane,
  ...(unit.raisedFrom ? { raisedFrom: unit.raisedFrom } : {}),
  ...(unit.noAgentDecision ? { noAgentDecision: true as const } : {}),
  ...(unit.untitled ? { untitled: unit.untitled } : {}),
  ...(unit.excluded ? { excluded: unit.excluded } : {}),
  ...(unit.review
    ? {
        review: {
          actor: { kind: "agent" as const, agent: unit.review.reviewer },
          verdict: unit.review.verdict,
        },
      }
    : {}),
})

/** A human-required scenario unit as "Needs your decision" lists it. */
const judgmentUnit = (unit: ScenarioUnit): JudgmentUnit => ({
  id: unit.id,
  title: unit.title,
  ...(unit.raisedFrom ? { raisedFrom: unit.raisedFrom } : {}),
  ...(unit.noAgentDecision ? { noAgentDecision: true as const } : {}),
  ...(unit.untitled ? { untitled: unit.untitled } : {}),
  ...(unit.agentId ? { agentId: unit.agentId } : {}),
  files: 1,
  hunks: unit.hunks,
  // The desk's units carry no context markers yet.
  markers: 0,
})

/** The overview's lane names and lines for this review. */
const lanesOf = (units: ReadonlyArray<OverviewUnit>) => {
  const agentic = units.filter((unit) => unit.lane === "agentic-review")
  const sentBack = agentic.filter(
    (unit) => unit.review?.verdict === "changes_requested"
  ).length
  return {
    "human-required": {
      name: "Human-required",
      line: "Only you can decide these.",
    },
    "human-suggested": {
      name: "Human-suggested",
      line: "Agent approved. Applies unless you step in.",
    },
    "agentic-review": {
      name: "Agentic review",
      line: `${agentic.length - sentBack} approved · ${sentBack} sent back to the implementer.`,
    },
    "static-automation": {
      name: "Static automation",
      line: "Generated code. All passed.",
    },
  } satisfies Record<ReviewLane, { name: string; line: string }>
}

/* ── The batch digest ─────────────────────────────────────── */

const EXPIRY_DOC = "docs/sharing/expiry.md"
const MARKERS: Record<string, ContextualMarker> = {
  doc: {
    key: "doc",
    tone: "doc",
    short: "Doc",
    peek: "Links without a date expire after 30 days.",
    kindLabel: "Doc · committed",
    title: EXPIRY_DOC,
    meta: "§ Links without a date · 5e2a07c",
    quote:
      "A link created without an expiry date expires 30 days after it is created.",
    excerpt: {
      kind: "quote",
      text: "A link created without an expiry date expires 30 days after it is created.",
    },
    applies:
      "The removal follows the rule the doc sets for links without a date.",
    check:
      "Links created before this change have no date either; the doc does not say whether their 30 days count from creation or from the release.",
    sharedWith: [],
    source: {
      kind: "Doc",
      chips: [{ text: "Committed", tone: "neutral" }],
      title: "Share link expiry",
      subtitle: `${EXPIRY_DOC} · § Links without a date`,
      actions: [
        { kind: "editor", editor: "VS Code", path: EXPIRY_DOC },
        { kind: "editor", editor: "Cursor", path: EXPIRY_DOC },
        { kind: "editor", editor: "Zed", path: EXPIRY_DOC },
        { kind: "copy-path", path: EXPIRY_DOC },
      ],
      facts: [
        { label: "Owner", value: "Docs team" },
        { label: "Changed", value: "2026-11-03" },
      ],
      blocks: [
        {
          kind: "text",
          text: "Every share link carries an expiry date. A person can choose one when they share, in their own time zone.",
        },
        {
          kind: "quote",
          text: "A link created without an expiry date expires 30 days after it is created.",
        },
        {
          kind: "text",
          text: "An expired link refuses new sessions. Workspace admins can extend it.",
        },
      ],
      citedBy: ["Share links expire on a schedule"],
    },
  },
}

const BRIEFING = {
  removed: [
    {
      kind: "text" as const,
      text: "Links with no expiry date no longer stay open for ever: they now expire after 30 days.",
    },
    {
      kind: "cite" as const,
      label: "Share link expiry",
      markerKey: "doc",
      ariaLabel: "Doc, Share link expiry",
    },
    { kind: "text" as const, text: "\n\n" },
    {
      kind: "phrase" as const,
      text: "ShareLink.neverExpires",
      // The unit whose change removes it (its Facts say so on the desk).
      target: { kind: "unit" as const, unitId: EXPIRED_UNIT_ID },
    },
    { kind: "text" as const, text: " is removed." },
  ],
  segments: [
    {
      kind: "text" as const,
      text: "Share links now carry an expiry date, and ",
    },
    {
      kind: "phrase" as const,
      text: "an expired link refuses new sessions",
      target: { kind: "unit" as const, unitId: EXPIRED_UNIT_ID },
    },
    {
      kind: "text" as const,
      text: ". Admins can extend a link after it expires, and the link list shows the time each one has left.",
    },
  ],
  toCheck: [
    {
      kind: "text" as const,
      text: "Tests cover a link that expired and one extended after expiry. Nothing yet covers a date given in another time zone.",
    },
  ],
  markers: MARKERS,
  limitations: [],
} satisfies BatchOverviewData["contextualBriefing"]

/* ── The overviews ────────────────────────────────────────── */

/**
 * An overview's unit rows replaced: `units`, and the units an agent
 * requested changes on named again from them, as the projection would.
 */
const withUnits = (
  units: Array<OverviewUnit>
): Pick<BatchOverviewData, "units" | "agentChanges"> => ({
  units,
  agentChanges: agentChangesOf(units).agentChanges,
})

function overview(
  scenario: ReadonlyArray<ScenarioUnit>,
  batches: ReviewBatches
): BatchOverviewData {
  const units = scenario.map(overviewUnit)
  return {
    repo: "acme/docs-app",
    title: "Share links expire on a schedule",
    ticket: "SHR-240",
    branch: "shr-240-link-expiry",
    revision: LANES_REVISION,
    briefing:
      "Share links now carry an expiry date, and an expired link refuses new sessions.",
    contextualBriefing: BRIEFING,
    ...batchCounts(
      units.map(({ id, title, lane }): BatchUnit => ({ id, title, lane })),
      lanesOf(units)
    ),
    units,
    ...agentChangesOf(units),
    judgment: unitsIn(scenario, "human-required").map(judgmentUnit),
    // The unit no agent decided has none: checkpoints come from an agent's
    // reading.
    checkpoints: {
      [EXPIRED_UNIT_ID]: { total: 3, unmet: 1 },
      [EXTEND_UNIT_ID]: { total: 2, unmet: 0 },
      [LINK_LIST_UNIT_ID]: { total: 2, unmet: 1 },
    },
    batches,
    agents: agentRegistryFixture,
  }
}

/**
 * The first batch, published while the other two are still being reviewed:
 * three of the four lanes hold units; static automation has none.
 */
export const linkExpiryOverviewFixture = overview(
  SCENARIO_UNITS,
  publishedBatches(1)
)

/** The same screen once the second batch has arrived: one still pending. */
export const linkExpiryArrivedOverviewFixture = overview(
  SCENARIO_UNITS,
  publishedBatches(2)
)

/** The same screen once the last batch has arrived: the review is whole. */
export const linkExpiryWholeOverviewFixture = overview(
  SCENARIO_UNITS,
  publishedBatches(3)
)

/**
 * The review stopped after its first batch (a failed run): the other two
 * were never reviewed, and nothing is running.
 */
export const linkExpiryStoppedOverviewFixture = overview(SCENARIO_UNITS, {
  ...publishedBatches(1),
  stopped: true,
})

/**
 * A batch with no digest whose limitations still arrive: a plain briefing
 * line, empty digest segments and two limitations.
 */
export const linkExpiryLimitationsOverviewFixture: BatchOverviewData = {
  ...linkExpiryOverviewFixture,
  briefing: "Share links now carry an expiry date.",
  contextualBriefing: {
    segments: [],
    markers: {},
    limitations: [
      "The batch digest couldn't be read, so it isn't shown.",
      "Some of this batch's context couldn't be read, so some of its links and context references may not be shown.",
    ],
  },
}

/**
 * The variant with one unit in static automation: the regenerated API
 * client takes the place of one agentic unit, so all four lanes hold units.
 */
export const linkExpiryStaticOverviewFixture = overview(
  SCENARIO_STATIC_UNITS,
  publishedBatches(1)
)

/* ── Your earlier decision carried ────────────────────────── */

/** Your approval from the earlier review, as the decided rows show it. */
const CARRIED_REVIEW = {
  actor: { kind: "person", person: REVIEWER, isYou: true },
  verdict: "approved",
  carried: CARRIED_LABEL,
} as const

/**
 * The first batch once your approval of "Admins can extend an expired
 * link" carried from the branch's earlier review (its changes are all
 * unchanged): two units need your decision, and the admins unit is under
 * "Decided" with the carried mark.
 */
export const linkExpiryCarriedOverviewFixture: BatchOverviewData = (() => {
  const base = overview(SCENARIO_UNITS, carriedBatches())
  const judgment = base.judgment.filter((unit) => unit.id !== EXTEND_UNIT_ID)
  const extend = SCENARIO_UNITS.find((unit) => unit.id === EXTEND_UNIT_ID)!
  return {
    ...base,
    needYou: judgment.length,
    judgment,
    decided: [{ id: extend.id, title: extend.title, review: CARRIED_REVIEW }],
    ...withUnits(
      base.units!.map((unit) =>
        unit.id === EXTEND_UNIT_ID ? { ...unit, review: CARRIED_REVIEW } : unit
      )
    ),
    firstUnitId: judgment[0]!.id,
  }
})()

/**
 * The carried review's variant where your request for changes on "Expiry
 * dates accept a time zone" carried too: on human-suggested work it stands
 * over the agent's approval, so its row shows yours, marked carried. It
 * needs nothing more of you: human-required work alone counts.
 */
export const linkExpiryCarriedChangesOverviewFixture: BatchOverviewData = {
  ...linkExpiryCarriedOverviewFixture,
  ...withUnits(
    linkExpiryCarriedOverviewFixture.units!.map((unit) =>
      unit.id === TIME_ZONE_UNIT_ID
        ? {
            ...unit,
            review: {
              actor: CARRIED_REVIEW.actor,
              verdict: "changes_requested",
              carried: CARRIED_LABEL,
            },
          }
        : unit
    )
  ),
}

/**
 * The variant whose batch also updated the lockfile: no agent read it, so
 * its row says "Lockfile, not read", the lanes count it where Records puts
 * it, and the overview says once how many files were not read. Nothing more
 * needs you.
 */
export const linkExpiryLockfileOverviewFixture: BatchOverviewData = (() => {
  const batches = publishedBatches(1)
  return {
    ...overview(SCENARIO_LOCKFILE_UNITS, {
      ...batches,
      all: batches.all.map((batch) =>
        batch.id === LINK_EXPIRY_BATCH_ID
          ? { ...batch, unitCount: SCENARIO_LOCKFILE_UNITS.length }
          : batch
      ),
    }),
    notRead: SCENARIO_LOCKFILE_UNITS.filter((unit) => unit.excluded).length,
  }
})()

/**
 * The same overview, reloaded after a newer review of this work replaced
 * this one: the page is as it was, and the header links to the newer one.
 */
export const linkExpiryReplacedOverviewFixture: BatchOverviewData = {
  ...linkExpiryOverviewFixture,
  newer: { batchId: NEWER_BATCH_ID },
}

/* ── The Reviews page ─────────────────────────────────────── */

const minutesBefore = (minutes: number) =>
  new Date(REVIEWS_NOW.getTime() - minutes * 60_000).toISOString()

/** A batch as the Reviews page counts it: human-suggested units wait too. */
const onReviewsPage = (batch: ReviewBatch, suggested: number): ReviewBatch => ({
  ...batch,
  needYou: batch.needYou + suggested,
})

/** Each published batch's human units, in packet order: none decided yet. */
function gateOf(published: number): Array<ReviewGateUnit> {
  return linkExpiryBatchesFixture.slice(0, published).flatMap((batch, i) => [
    ...Array.from({ length: batch.needYou }, () => ({
      lane: "human-required" as const,
      mark: "waiting" as const,
    })),
    ...Array.from({ length: SUGGESTED_BY_BATCH[i]! }, () => ({
      lane: "human-suggested" as const,
      mark: "waiting" as const,
    })),
  ])
}

/** The link-expiry review on the Reviews page, `published` of its batches out. */
function linkExpiryReview(published: number): ReviewSummary {
  const batches = linkExpiryBatchesFixture
    .slice(0, published)
    .map((batch, i) => onReviewsPage(batch, SUGGESTED_BY_BATCH[i]!))
  const counts = LANE_ORDER.map((lane) => ({
    lane,
    count:
      lane === "human-required"
        ? linkExpiryBatchesFixture
            .slice(0, published)
            .reduce((sum, batch) => sum + batch.needYou, 0)
        : lane === "human-suggested"
          ? SUGGESTED_BY_BATCH.slice(0, published).reduce((a, b) => a + b, 0)
          : lane === "agentic-review"
            ? batches.reduce(
                (sum, batch) => sum + batch.unitCount - batch.needYou,
                0
              )
            : 0,
  })).filter((entry) => entry.count > 0)
  return {
    id: "cycle-shr-240",
    title: "Share links expire on a schedule",
    range: `4b1e9a0..${LANES_REVISION}`,
    at: minutesBefore(25),
    state: "running",
    lanes: counts,
    gate: gateOf(published),
    feedback: false,
    batches,
    pendingBatches: linkExpiryBatchesFixture.length - published,
  }
}

/** The review before it on the same repository, every human unit decided. */
const REVOKE_REVIEW: ReviewSummary = {
  id: "cycle-shr-212",
  title: "Revoked share links stop working immediately",
  range: "1f0c2d4..a3f9c2e",
  at: minutesBefore(26 * 60),
  state: "completed",
  lanes: [
    { lane: "human-required", count: 4 },
    { lane: "human-suggested", count: 3 },
    { lane: "agentic-review", count: 7 },
    { lane: "static-automation", count: 12 },
  ],
  gate: [
    ...Array.from({ length: 4 }, () => ({
      lane: "human-required" as const,
      mark: "approved" as const,
    })),
    ...Array.from({ length: 3 }, () => ({
      lane: "human-suggested" as const,
      mark: "approved" as const,
    })),
  ],
  feedback: true,
  batches: [
    {
      id: "batch-revoke-links",
      title: "Revoked share links stop working immediately",
      unitCount: 19,
      needYou: 0,
    },
    {
      id: "batch-share-dialog",
      title: "The share dialog lists active links only",
      unitCount: 4,
      needYou: 0,
    },
    {
      id: "batch-session-index",
      title: "Session lookup by link uses the new index",
      unitCount: 3,
      needYou: 0,
    },
  ],
}

function reviewsPage(published: number): ReviewsData {
  const running = linkExpiryReview(published)
  const reviews = [running, REVOKE_REVIEW]
  // Only published units exist to be counted.
  const units = reviews.reduce(
    (sum, each) =>
      sum + each.gate.filter((unit) => unit.mark === "waiting").length,
    0
  )
  const waitingReviews = reviews.filter((each) =>
    each.gate.some((unit) => unit.mark === "waiting")
  )
  return {
    repo: "acme/docs-app",
    reviews,
    filter: "all",
    page: 1,
    pageSize: 10,
    total: reviews.length,
    counts: { all: reviews.length, waiting: waitingReviews.length },
    waiting: {
      units,
      reviews: waitingReviews.length,
      nextUnitId: EXPIRED_UNIT_ID,
    },
  }
}

/**
 * The Reviews page as it counted before Records' closure rule (every
 * human-suggested unit waiting). No story shows it; the Reviews page's
 * fixtures are `lanes-reviews.fixtures.ts`, which takes the branch's other
 * review row from it.
 */
export const linkExpiryReviewsFixture = reviewsPage(1)

/**
 * The first batch where code titled one agentic unit, which owns many short
 * runs of lines: its name lists every run, and the list wraps within the
 * title's column, never under the row's review.
 */
export const linkExpiryLongLinesOverviewFixture: BatchOverviewData = {
  ...linkExpiryOverviewFixture,
  ...withUnits(
    linkExpiryOverviewFixture.units!.map((unit) =>
      unit.id === RENAME_UNIT_ID
        ? {
            ...unit,
            title: `Changes to ${EXPIRY_PATH}`,
            untitled: {
              files: [
                {
                  path: EXPIRY_PATH,
                  lines: Array.from({ length: 14 }, (_, i) => ({
                    start: 1 + i * 14,
                    end: 5 + i * 14,
                  })),
                },
              ],
            },
          }
        : unit
    )
  ),
}
