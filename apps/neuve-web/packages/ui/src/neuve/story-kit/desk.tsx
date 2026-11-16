/**
 * Story kit, the review desk at a unit (stories only; never imported by
 * product code).
 *
 * `DeskAt` is the desk composition every screen story renders: the real
 * `ReviewDeskScreen` with a fresh in-memory comment store per mount, inside
 * whatever context a story wraps it in (e.g. a delivery choreography). `deskMeta` is the shared meta (with
 * the in-memory delivery setting), and `deskAt(unit, options)` names a desk
 * state as story args, so a canvas board and its story twin cite one thing.
 */
import * as React from "react"
import type { Meta } from "@storybook/react-vite"

import {
  agentReviewCommentFixtures,
  agenticUnitFixture,
  gatheredDeliveryDeskFixture,
  goDeliveryDeskFixture,
  goDeliveryInLane,
  longFileDeskFixture,
  reviewCommentFixtures,
  reviewDeskFixture,
  reviewDeskLiveFixture,
  reviewDeskWithNewCommitFixture,
  scopeDeliveryDeskFixture,
  staticUnitFixture,
  suggestedUnitFixture,
  unlinkedGatheredDeliveryDeskFixture,
  unlinkedSuggestedDeliveryDeskFixture,
} from "@workspace/ui/fixtures/review-batch.fixtures"
import type { ReviewCommentRecord } from "@workspace/ui/neuve/review-comments/record"
import type { ReviewThread } from "@workspace/ui/neuve/review-comments/thread"
import type {
  DiffLayout,
  DockState,
  ReviewDeskState,
} from "@workspace/ui/neuve/review-desk/atoms"
import { ReviewDeskScreen } from "@workspace/ui/neuve/review-desk/review-desk-screen"
import type { ReviewDeskScreenProps } from "@workspace/ui/neuve/review-desk/review-desk-screen"
import { sampleDeliverySettings } from "@workspace/ui/fixtures/delivery-languages.fixtures"
import type {
  DeliverySettings,
  DeliveryStop,
} from "@workspace/ui/neuve/shared/delivery"
import { withDeliverySettings } from "@workspace/ui/neuve/story-kit/settings"
import { useStoryRepository } from "@workspace/ui/neuve/story-kit/store"
import type { ReviewDeskData, ReviewLane } from "@workspace/ui/neuve/types"

/* ── The composition ───────────────────────────────────── */

export interface DeskAtProps extends ReviewDeskScreenProps {
  /** Records the fresh per-mount comment store starts with. */
  comments?: ReadonlyArray<ReviewCommentRecord>
  /**
   * Wraps the desk in a story's own context, e.g. the jig's choreography:
   * `wrap={(desk) => <DeliveryChoreographyAtomProvider value={a}>{desk}</…>}`.
   * (The desk owns its jotai store, so context providers are how a story
   * substitutes an atom the desk reads.)
   */
  wrap?: (desk: React.ReactNode) => React.ReactNode
}

/** The real desk at a unit, isolated per mounted story. */
export function DeskAt({
  comments,
  wrap,
  commentRepository,
  ...props
}: DeskAtProps) {
  const repository = useStoryRepository(comments, commentRepository)
  const desk = <ReviewDeskScreen {...props} commentRepository={repository} />
  return wrap ? wrap(desk) : desk
}

/* ── Named units ───────────────────────────────────────── */

/** The fixture units a desk story or board twin can open. */
export const DESK_UNITS = {
  /** Revoke cuts off open sessions (Main, the round-2 boards). */
  revoke: reviewDeskFixture,
  /** The same unit with its live agents, threads and records. */
  "revoke-live": reviewDeskLiveFixture,
  /** Revoke with a new commit arriving mid-review. */
  "revoke-new-commit": reviewDeskWithNewCommitFixture,
  /** A unit with a 4,000-line file. */
  "long-file": longFileDeskFixture,
  /** Index writes retry when busy (Delivery, Briefing), human-required. */
  "index-writes": goDeliveryDeskFixture,
  /** Index writes against SHR-212's scope (no "Done when"). */
  "index-writes-scope": scopeDeliveryDeskFixture,
  /** Index writes with a gathered scope linked to an earlier review. */
  "index-writes-gathered": gatheredDeliveryDeskFixture,
  /** Index writes with a gathered scope nothing links to. */
  "index-writes-unlinked": unlinkedGatheredDeliveryDeskFixture,
  /** The unlinked unit, human-suggested. */
  "index-writes-suggested-unlinked": unlinkedSuggestedDeliveryDeskFixture,
  /** The lane units (Lanes.dc.html). */
  suggested: suggestedUnitFixture,
  agentic: agenticUnitFixture,
  static: staticUnitFixture,
} satisfies Record<string, ReviewDeskData>

export type DeskUnit = keyof typeof DESK_UNITS

/** Comment stores a desk can start with, by name. */
export const DESK_COMMENTS = {
  none: [],
  seeded: reviewCommentFixtures,
  agents: agentReviewCommentFixtures,
} satisfies Record<string, ReadonlyArray<ReviewCommentRecord>>

export interface DeskOptions {
  /** The reader's delivery stop for the unit. */
  stop?: DeliveryStop
  /** The marker whose card is open (L2). */
  open?: string
  /** The marker whose source sheet is open (L3). */
  sheet?: string
  layout?: DiffLayout
  wrap?: boolean
  rail?: "open" | "collapsed"
  dock?: DockState
  /** The comment store's records: a named set or the records themselves. */
  comments?: keyof typeof DESK_COMMENTS | ReadonlyArray<ReviewCommentRecord>
  /** The unit's comment threads (replaces the fixture's). */
  threads?: ReadonlyArray<ReviewThread>
  /** Index writes only: the unit in another lane. */
  lane?: Exclude<ReviewLane, "human-required">
  /** Any other desk state to seed. */
  state?: Partial<ReviewDeskState>
}

/** Desk state with the composer open on a range (and the range selected). */
export function composingAt(
  filePath: string,
  start: number,
  end = start,
  side: "additions" | "deletions" = "additions"
): Partial<ReviewDeskState> {
  const range = { start, side, end }
  return { lineSelection: { filePath, range }, composer: { filePath, range } }
}

/**
 * Story args for the desk at `unit` (a named unit or any desk data) in the
 * state `options` names. Rail open unless asked otherwise.
 */
export function deskAt(
  unit: DeskUnit | ReviewDeskData,
  options: DeskOptions = {}
): Partial<DeskAtProps> & { data: ReviewDeskData } {
  const { stop, open, sheet, layout, wrap, rail, dock, comments, threads } =
    options
  let data: ReviewDeskData =
    typeof unit === "string"
      ? options.lane && unit === "index-writes"
        ? goDeliveryInLane(options.lane)
        : DESK_UNITS[unit]
      : unit
  if (threads) data = { ...data, threads: [...threads] }
  const state: Partial<ReviewDeskState> = {
    railCollapsed: rail === "collapsed",
    ...(open !== undefined && { openMarker: open }),
    ...(sheet !== undefined && { sheetMarker: sheet }),
    ...(layout && { layout }),
    ...(wrap !== undefined && { wrap }),
    ...(dock && { dock }),
    ...options.state,
  }
  return {
    data,
    initialState: state,
    ...(stop && { initialDeliveryStop: stop }),
    ...(comments !== undefined && {
      comments:
        typeof comments === "string" ? DESK_COMMENTS[comments] : comments,
    }),
  }
}

/* ── The shared meta ───────────────────────────────────── */

/** Extra viewports desk stories use (`globals.viewport.value`). */
export const DESK_VIEWPORTS = {
  phone: {
    name: "Phone 375",
    styles: { width: "375px", height: "812px" },
    type: "mobile",
  },
  phone390: {
    name: "Phone 390",
    styles: { width: "390px", height: "844px" },
    type: "mobile",
  },
  phone320: {
    name: "Phone 320",
    styles: { width: "320px", height: "568px" },
    type: "mobile",
  },
  short: {
    name: "Short 1100×520",
    styles: { width: "1100px", height: "520px" },
    type: "desktop",
  },
  wide1500: {
    name: "Wide 1500×900",
    styles: { width: "1500px", height: "900px" },
    type: "desktop",
  },
} as const

/**
 * The desk meta without its title (spread it into a literal that names the
 * title, so Storybook's indexer reads it statically):
 *
 *   const meta = { title: "Screens/Review desk/Delivery", ...deskMeta() }
 *     satisfies Meta<typeof DeskAt>
 *
 * The component is the real desk through `DeskAt`; the workspace delivery
 * setting is in memory and fresh per story; the comment store is too.
 */
export function deskMeta(
  unit: DeskUnit | ReviewDeskData = "revoke-live",
  options: DeskOptions = {},
  {
    settings = sampleDeliverySettings,
  }: {
    /** The in-memory workspace delivery setting (the sample by default). */
    settings?: DeliverySettings
  } = {}
) {
  return {
    component: DeskAt,
    args: deskAt(unit, options),
    decorators: [withDeliverySettings(settings)],
    argTypes: {
      commentRepository: { control: false },
      comments: { control: false },
      wrap: { control: false },
      threadEvents: { control: false },
      agentConnector: { control: false },
      initialDeliveryStop: {
        control: "inline-radio",
        options: ["facts", "briefed", "explained", "guided"],
      },
    },
    parameters: { viewport: { options: DESK_VIEWPORTS } },
  } satisfies Omit<Meta<typeof DeskAt>, "title">
}
