/**
 * Story kit, frames (stories only; never imported by product code).
 *
 * The surfaces a component story renders on, chosen once: paper, the page
 * column, the rail and dock slots, the margin's floating widths, the unit
 * column scroller and a file card at desk width. A width or tone change is
 * made here, so the stories can't drift from each other or from the desk.
 */
import * as React from "react"
import { Provider } from "jotai"
import { useHydrateAtoms } from "jotai/utils"
import { fn } from "storybook/test"
import type { Decorator } from "@storybook/react-vite"

import { cn } from "@workspace/ui/lib/utils"
import {
  ownedRangesContext,
  ownedRangesMarkers,
} from "@workspace/ui/fixtures/owned-ranges.fixtures"
import {
  goDeliveryDeskFixture,
  reviewCommentFixtures,
  reviewDeskFixture,
} from "@workspace/ui/fixtures/review-batch.fixtures"
import type { ReviewCommentRecord } from "@workspace/ui/neuve/review-comments/record"
import type { ReviewThread } from "@workspace/ui/neuve/review-comments/thread"
import { dockAtom, dockOriginAtom } from "@workspace/ui/neuve/review-desk/atoms"
import type {
  DockOrigin,
  DockState,
} from "@workspace/ui/neuve/review-desk/atoms"
import { ContextCard } from "@workspace/ui/neuve/review-desk/context-margin"
import type { groupMarkerAnchors } from "@workspace/ui/neuve/review-desk/context-margin"
import { CriteriaCard } from "@workspace/ui/neuve/review-desk/delivery/criteria-card"
import { DiffFileCard } from "@workspace/ui/neuve/review-desk/diff-file"
import { useVirtualizerRoot } from "@workspace/ui/neuve/review-desk/review-desk-screen"
import { SourceSheet } from "@workspace/ui/neuve/review-desk/source-sheet"
import { ThreadCard } from "@workspace/ui/neuve/review-desk/thread-card"
import { UnitRail } from "@workspace/ui/neuve/review-desk/unit-rail"
import {
  AppHeader,
  LiveStatusProvider,
} from "@workspace/ui/neuve/shared/app-header"
import type { LiveStatus } from "@workspace/ui/neuve/shared/app-header"
import type {
  ContextualMarker,
  DiffFile,
  ReviewDeskData,
} from "@workspace/ui/neuve/types"

/** The product's paper: background, type and ink. */
export const PAPER = "bg-paper font-sans text-sm text-ink"

/* ── Paper ────────────────────────────────────── */

/** Padded paper canvas for component stories. */
export const onPaper: Decorator = (Story) => (
  <div className={`min-h-svh p-8 ${PAPER}`}>
    <Story />
  </div>
)

/** Unpadded paper, as the header and chrome sit on it. */
export const onBarePaper: Decorator = (Story) => (
  <div className={PAPER}>
    <Story />
  </div>
)

/** The decision dock's slot: content sits at the bottom of a 420px column. */
export const atDock: Decorator = (Story) => (
  <div className={`flex min-h-[420px] flex-col justify-end ${PAPER}`}>
    <Story />
  </div>
)

/* ── In Ace's Review tab ───────────────────────────────── */

/**
 * Ace's Review tab (shared/embedded.ts): full, the tab beside Ace's sidebar
 * on a 1440px laptop; split, beside the chat, about half of it.
 */
export const ACE_VIEWPORTS = {
  aceTab: {
    name: "Ace tab 1180×820",
    styles: { width: "1180px", height: "820px" },
    type: "desktop",
  },
  aceSplit: {
    name: "Ace split 640×820",
    styles: { width: "640px", height: "820px" },
    type: "desktop",
  },
} as const

export const AT_ACE_TAB = {
  globals: { viewport: { value: "aceTab", isRotated: false } },
} as const
export const AT_ACE_SPLIT = {
  globals: { viewport: { value: "aceSplit", isRotated: false } },
} as const

/** The screen embedded, as Ace's Review tab shows it (the `embedded:` styles). */
export const inAceTab: Decorator = (Story) => (
  <div data-embedded="">
    <Story />
  </div>
)

/**
 * The whole page embedded, <html> marked as the app's inline script marks
 * it, so the message bridge (useAceBridge) runs. Marked in a layout effect,
 * before any passive effect reads it; unmarked when the story leaves.
 */
export const inAcePage: Decorator = (Story) => {
  // Effect: marks <html>, outside React's tree, for this story only; the cleanup unmarks it.
  React.useLayoutEffect(() => {
    const root = document.documentElement
    root.setAttribute("data-embedded", "")
    return () => root.removeAttribute("data-embedded")
  }, [])
  return <Story />
}

/* ── Chrome ────────────────────────────────────────────── */

/** The app header for a desk's batch, optionally with a live status. */
export function HeaderFrame({
  data = reviewDeskFixture,
  status,
}: {
  data?: ReviewDeskData
  status?: LiveStatus
}) {
  const header = (
    <AppHeader
      repo={data.repo}
      branch={data.branch}
      commit={data.revision}
      batches={data.batches}
    />
  )
  return (
    <div className={PAPER}>
      {status ? (
        <LiveStatusProvider status={status}>{header}</LiveStatusProvider>
      ) : (
        header
      )}
    </div>
  )
}

/**
 * The rail in its desk slot: 300px wide, 720px tall. `children` render
 * before the rail (readers that must subscribe first).
 */
export function RailFrame({
  data = reviewDeskFixture,
  height = 720,
  children,
}: {
  data?: ReviewDeskData
  height?: number
  children?: React.ReactNode
}) {
  return (
    <div className={`flex w-[300px] ${PAPER}`} style={{ height }}>
      {children}
      <UnitRail data={data} />
    </div>
  )
}

/* ── The margin's floating layers ──────────────────────── */

/**
 * A floating layer at the margin's width: 300px, or 260px in the narrow
 * margin (≤1180px viewports).
 */
export function FloatingFrame({
  width = 300,
  children,
}: {
  width?: 300 | 260
  children: React.ReactNode
}) {
  return (
    <div className="relative" style={{ width }}>
      {children}
    </div>
  )
}

/** A marker's L2 card, its actions stubbed. */
export function CardFrame({ marker }: { marker: ContextualMarker }) {
  return (
    <FloatingFrame>
      <ContextCard
        marker={marker}
        onClose={fn()}
        onOpenSource={fn()}
        onCheckAction={fn()}
      />
    </FloatingFrame>
  )
}

/** A comment's thread card (the seeded sessions comment by default). */
export function ThreadFrame({
  thread,
  record = reviewCommentFixtures[0]!,
  rangeLabel = "L22–23",
  width,
}: {
  thread: ReviewThread | undefined
  record?: ReviewCommentRecord
  rangeLabel?: string
  width?: 300 | 260
}) {
  return (
    <FloatingFrame width={width}>
      <ThreadCard
        record={record}
        rangeLabel={rangeLabel}
        thread={thread}
        fallbackAgentId="i1"
        reviewer={reviewDeskFixture.reviewer}
        onDismiss={fn()}
        onToggleStatus={fn()}
      />
    </FloatingFrame>
  )
}

/**
 * The source sheet inside a positioned unit column, as in the desk.
 * `children` render in the column beneath it.
 */
export function SheetFrame({
  markers,
  height = 640,
  className,
  children,
}: {
  markers: Record<string, ContextualMarker>
  height?: number
  /** Extra classes for the column (e.g. padding around `children`). */
  className?: string
  children?: React.ReactNode
}) {
  return (
    <main className={cn("relative", PAPER, className)} style={{ height }}>
      {children}
      <SourceSheet markers={markers} />
    </main>
  )
}

/* ── Files and lines ───────────────────────────────────── */

const revokeFile = reviewDeskFixture.files[0]!

/** The revoke unit's comment context (comments save to its unit). */
export const revokeCommentContext = {
  unitId: reviewDeskFixture.unit.id,
  revision: reviewDeskFixture.revision,
  author: reviewDeskFixture.reviewer,
  agentId: "i1",
}

/** One file card with its margin, at desk width. */
export function FileFrame({
  file = revokeFile,
  markers = reviewDeskFixture.markers,
  commentContext = revokeCommentContext,
}: Partial<React.ComponentProps<typeof DiffFileCard>>) {
  return (
    <div className="max-w-[1100px]">
      <DiffFileCard
        file={file}
        markers={markers}
        commentContext={commentContext}
      />
    </div>
  )
}

/**
 * One line of the margin on a real diff row: the file card (the revoke file
 * by default) with only `group`'s markers, anchored on its line. The row,
 * gutter and margin are the desk's own, never drawn here.
 */
export function MarginLineFrame({
  group,
  file = revokeFile,
}: {
  group: ReturnType<typeof groupMarkerAnchors>[number]
  file?: DiffFile
}) {
  return (
    <FileFrame
      file={{
        ...file,
        markerAnchors: group.entries.map((entry) => entry.anchor),
      }}
      markers={Object.fromEntries(
        group.entries.map((entry) => [entry.marker.key, entry.marker])
      )}
    />
  )
}

const SCROLLER = "min-h-0 flex-auto overflow-y-auto px-8 pb-24"

/** The scroller with the desk's own scroll root (its diff Virtualizer). */
function VirtualizedScroller({ children }: { children: React.ReactNode }) {
  const scrollRoot = useVirtualizerRoot()
  return (
    <div ref={scrollRoot} data-story-scroller="" className={SCROLLER}>
      {children}
    </div>
  )
}

/**
 * The desk's unit column: file cards in a scroller whose edge the sticky
 * headers hold (`data-story-scroller`). `virtualized` gives the scroller the
 * desk's own scroll root (`useVirtualizerRoot`, the diff Virtualizer);
 * without it files render every row. `children` render above the scroller.
 */
export function UnitColumnFrame({
  files,
  markers = ownedRangesMarkers,
  commentContext = ownedRangesContext,
  virtualized = false,
  children,
}: {
  files: Array<DiffFile>
  markers?: Record<string, ContextualMarker>
  commentContext?: React.ComponentProps<typeof DiffFileCard>["commentContext"]
  /** Give the scroller the desk's scroll root and its Virtualizer. */
  virtualized?: boolean
  children?: React.ReactNode
}) {
  // No padding on the scroller itself: sticky headers stick to its edge, as
  // in the desk's unit column.
  const cards = (
    <div className="flex flex-col gap-5 pt-6">
      {files.map((file, index) => (
        <DiffFileCard
          key={file.path}
          file={file}
          markers={markers}
          commentContext={commentContext}
          position={{ index: index + 1, of: files.length }}
        />
      ))}
    </div>
  )
  return (
    <div className={`flex h-svh flex-col ${PAPER}`}>
      {children}
      {virtualized ? (
        <VirtualizedScroller>{cards}</VirtualizedScroller>
      ) : (
        <div data-story-scroller="" className={SCROLLER}>
          {cards}
        </div>
      )}
    </div>
  )
}

/* ── Delivery ──────────────────────────────────────────── */

function DockSeed({
  dock,
  children,
}: {
  dock: { state: DockState; origin: DockOrigin }
  children: React.ReactNode
}) {
  useHydrateAtoms(
    new Map<typeof dockAtom | typeof dockOriginAtom, DockState | DockOrigin>([
      [dockAtom, dock.state],
      [dockOriginAtom, dock.origin],
    ])
  )
  return children
}

/**
 * The Guided check's card alone on paper, in its own store, with the dock
 * seeded (e.g. a sent suggestion) when given.
 */
export function CriteriaCardFrame({
  data = goDeliveryDeskFixture,
  reviewer = reviewDeskFixture.reviewer,
  dock,
}: {
  data?: ReviewDeskData
  reviewer?: ReviewDeskData["reviewer"]
  dock?: { state: DockState; origin: DockOrigin }
}) {
  const card = (
    <div className={`min-h-svh p-8 ${PAPER}`}>
      <div className="max-w-[980px]">
        <CriteriaCard
          check={data.delivery!.check!}
          unit={data.unit}
          markers={data.markers}
          reviewer={reviewer}
        />
      </div>
    </div>
  )
  return (
    <Provider>{dock ? <DockSeed dock={dock}>{card}</DockSeed> : card}</Provider>
  )
}
