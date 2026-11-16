/*
 * The one source of truth for the real-lanes scenario (NEU-148, 12 November
 * 2026), which the batch overview, the Reviews page and the review desk
 * fixtures all build from: one review of acme/docs-app on branch
 * shr-240-link-expiry (SHR-240) in three batches. The first, "Share links
 * expire on a schedule", is published with nine units in three of the four
 * lanes; the other two are still being reviewed and arrive one at a time.
 * Three units come from src/sharing/expiry.ts, one per lane, each with its
 * own concern. One unit no agent decided: it has no written title and is
 * named by its file and the lines it owns. A variant moves one agentic unit
 * out and puts one unit in static automation.
 */
import type {
  ReviewBatch,
  ReviewBatches,
  ReviewLane,
  UnitExclusion,
  UntitledFile,
} from "@workspace/ui/neuve/types"
import type { ReviewVerdict } from "@workspace/ui/neuve/shared/review-mark"

/** The head the first batch reviewed. */
export const LANES_REVISION = "5c1e7a9"

export const R1 = {
  id: "r1",
  short: "R1",
  name: "Reviewer 1",
  role: "reviewer",
} as const
export const R2 = {
  id: "r2",
  short: "R2",
  name: "Reviewer 2",
  role: "reviewer",
} as const

export type ScenarioReviewer = typeof R1 | typeof R2

/** One unit of the scenario, as every surface needs it. */
export interface ScenarioUnit {
  id: string
  title: string
  lane: ReviewLane
  /** The file its changes are in. */
  path: string
  /** git hunks its owned lines fall in. */
  hunks: number
  /** The implementer that owns it. */
  agentId?: string
  /** The agent's review that stands (the lanes other than human-required). */
  review?: { reviewer: ScenarioReviewer; verdict: ReviewVerdict }
  raisedFrom?: ReviewLane
  noAgentDecision?: true
  untitled?: { files: Array<UntitledFile> }
  /** No agent read it: a lockfile or a generated file. */
  excluded?: UnitExclusion
}

export const EXPIRED_UNIT_ID = "expired-links-refuse-new-sessions"
export const EXTEND_UNIT_ID = "admins-extend-expired-links"
export const SCHEDULE_UNIT_ID = "src-sharing-schedule-ts"
export const TIME_ZONE_UNIT_ID = "expiry-dates-accept-a-time-zone"
export const LINK_LIST_UNIT_ID = "link-list-shows-time-left"
export const RENAME_UNIT_ID = "rename-the-expiry-constants"
export const MIDDLEWARE_UNIT_ID = "session-middleware-checks-expiry"
export const DEFAULT_UNIT_ID = "new-links-default-to-30-days"
export const MIGRATION_UNIT_ID = "expiry-column-on-share-links"
export const API_CLIENT_UNIT_ID = "regenerated-api-client"

export const EXPIRY_PATH = "src/sharing/expiry.ts"
export const SCHEDULE_PATH = "src/sharing/schedule.ts"
export const POLICY_PATH = "src/sharing/access-policy.ts"

/** The untitled unit's title: the line code builds from its path. */
export const SCHEDULE_UNIT_TITLE = `Changes to ${SCHEDULE_PATH}`

const approved = (reviewer: ScenarioReviewer) => ({
  review: { reviewer, verdict: "approved" as const },
})
const sentBack = (reviewer: ScenarioReviewer) => ({
  review: { reviewer, verdict: "changes_requested" as const },
})

/** The first batch's units, in packet order. */
export const SCENARIO_UNITS: ReadonlyArray<ScenarioUnit> = [
  {
    id: EXPIRED_UNIT_ID,
    title: "Expired links refuse new sessions",
    lane: "human-required",
    path: EXPIRY_PATH,
    hunks: 3,
    agentId: "i1",
    raisedFrom: "agentic-review",
  },
  {
    id: EXTEND_UNIT_ID,
    title: "Admins can extend an expired link",
    lane: "human-required",
    path: POLICY_PATH,
    hunks: 3,
    agentId: "i2",
  },
  {
    id: SCHEDULE_UNIT_ID,
    title: SCHEDULE_UNIT_TITLE,
    lane: "human-required",
    path: SCHEDULE_PATH,
    hunks: 2,
    agentId: "i2",
    noAgentDecision: true,
    untitled: {
      files: [
        {
          path: SCHEDULE_PATH,
          lines: [
            { start: 12, end: 48 },
            { start: 71, end: 90 },
          ],
        },
      ],
    },
  },
  {
    id: TIME_ZONE_UNIT_ID,
    title: "Expiry dates accept a time zone",
    lane: "human-suggested",
    path: EXPIRY_PATH,
    hunks: 2,
    ...approved(R1),
  },
  {
    id: LINK_LIST_UNIT_ID,
    title: "Link list shows time left",
    lane: "human-suggested",
    path: "src/ui/link-list.tsx",
    hunks: 1,
    raisedFrom: "agentic-review",
    ...sentBack(R1),
  },
  {
    id: RENAME_UNIT_ID,
    title: "Rename the expiry constants",
    lane: "agentic-review",
    path: EXPIRY_PATH,
    hunks: 4,
    ...approved(R2),
  },
  {
    id: MIDDLEWARE_UNIT_ID,
    title: "Session middleware checks expiry",
    lane: "agentic-review",
    path: "src/sessions/middleware.ts",
    hunks: 1,
    ...approved(R2),
  },
  {
    id: DEFAULT_UNIT_ID,
    title: "New links default to 30 days",
    lane: "agentic-review",
    path: "src/sharing/create-link.ts",
    hunks: 1,
    ...sentBack(R2),
  },
  {
    id: MIGRATION_UNIT_ID,
    title: "Expiry column on share links",
    lane: "agentic-review",
    path: "db/migrations/0042_link_expiry.sql",
    hunks: 1,
    ...approved(R1),
  },
]

/** The static-automation unit the variant adds. */
const API_CLIENT_UNIT: ScenarioUnit = {
  id: API_CLIENT_UNIT_ID,
  title: "Regenerated API client",
  lane: "static-automation",
  path: "src/gen/api-client.ts",
  hunks: 6,
}

/**
 * The variant with one static-automation unit: the migration leaves the
 * batch and the regenerated API client joins it.
 */
export const SCENARIO_STATIC_UNITS: ReadonlyArray<ScenarioUnit> = [
  ...SCENARIO_UNITS.filter((unit) => unit.id !== MIGRATION_UNIT_ID),
  API_CLIENT_UNIT,
]

/* ── A lockfile no agent read ─────────────────────────────── */

export const LOCKFILE_UNIT_ID = "pnpm-lock-yaml"
export const LOCKFILE_PATH = "pnpm-lock.yaml"

/**
 * The lockfile the change updated: no agent read it, so it is not read,
 * never waits on a person and is never approved by the mark. It keeps the
 * lane Records gives it.
 */
const LOCKFILE_UNIT: ScenarioUnit = {
  id: LOCKFILE_UNIT_ID,
  title: `Changes to ${LOCKFILE_PATH}`,
  lane: "human-suggested",
  path: LOCKFILE_PATH,
  hunks: 2,
  excluded: { reason: "lockfile" },
  untitled: {
    files: [
      {
        path: LOCKFILE_PATH,
        lines: [
          { start: 9, end: 10 },
          { start: 29, end: 29 },
        ],
      },
    ],
  },
}

/** The variant whose batch also updated the lockfile: in packet order, after the human-suggested units. */
export const SCENARIO_LOCKFILE_UNITS: ReadonlyArray<ScenarioUnit> = [
  ...SCENARIO_UNITS.filter((unit) => unit.lane !== "agentic-review"),
  LOCKFILE_UNIT,
  ...SCENARIO_UNITS.filter((unit) => unit.lane === "agentic-review"),
]

export const unitsIn = (units: ReadonlyArray<ScenarioUnit>, lane: ReviewLane) =>
  units.filter((unit) => unit.lane === lane)

/* ── The review's batches ─────────────────────────────────── */

export const LINK_EXPIRY_BATCH_ID = "batch-link-expiry"

/** Every batch of the review in packet order, published or not. */
export const linkExpiryBatchesFixture: ReadonlyArray<ReviewBatch> = [
  {
    id: LINK_EXPIRY_BATCH_ID,
    title: "Share links expire on a schedule",
    unitCount: SCENARIO_UNITS.length,
    needYou: unitsIn(SCENARIO_UNITS, "human-required").length,
  },
  {
    id: "batch-expiry-reminders",
    title: "Expiry reminders by email",
    unitCount: 5,
    needYou: 1,
  },
  {
    id: "batch-expiry-cleanup",
    title: "Expired links are cleaned up nightly",
    unitCount: 4,
    needYou: 1,
  },
]

/** Human-suggested units in each batch, beside its human-required ones. */
export const SUGGESTED_BY_BATCH: ReadonlyArray<number> = [
  unitsIn(SCENARIO_UNITS, "human-suggested").length,
  1,
  0,
]

/** The review's first `published` batches, with the rest still pending. */
export function publishedBatches(published: number): ReviewBatches {
  const all = linkExpiryBatchesFixture.slice(0, published)
  return {
    current: LINK_EXPIRY_BATCH_ID,
    newest: true,
    all,
    pending: linkExpiryBatchesFixture.length - all.length,
  }
}

/* ── A decision carried from the earlier review ───────────── */

/**
 * The head of the branch's earlier review. Your approval there of "Admins
 * can extend an expired link", whose changes are all unchanged since,
 * carries and closes it in this review.
 */
export const EARLIER_HEAD = "2d7f0c1"

/** The carried mark's label, as the server writes it. */
export const CARRIED_LABEL = `Earlier review, head ${EARLIER_HEAD}`

/**
 * Your request for changes on "Expiry dates accept a time zone" in the
 * earlier review carried too (its changes are unchanged): on human-suggested
 * work it stands over the agent's approval, with the comment it rests on,
 * on the whole unit.
 */
export const CARRIED_CHANGES_COMMENT =
  "Keep the link's own time zone when the owner sets one; the server's zone surprises anyone abroad."

/** The review's batches once the admins unit's decision carried: one fewer needs you. */
export function carriedBatches(published = 1): ReviewBatches {
  const batches = publishedBatches(published)
  return {
    ...batches,
    all: batches.all.map((batch) =>
      batch.id === LINK_EXPIRY_BATCH_ID
        ? { ...batch, needYou: batch.needYou - 1 }
        : batch
    ),
  }
}

/* ── A newer review replaced this one under the reader ────── */

/** The unit that holds the admins unit's work in the newer review. */
export const NEWER_EXTEND_UNIT_ID = "admins-extend-expired-links-2"

/** Where the newer review starts: its first batch. */
export const NEWER_BATCH_ID = "batch-link-expiry-2"
