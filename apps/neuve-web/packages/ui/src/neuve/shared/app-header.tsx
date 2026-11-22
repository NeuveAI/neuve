import * as React from "react"
import { motion, useReducedMotion } from "motion/react"
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  SearchIcon,
  SettingsIcon,
} from "lucide-react"

import { buttonVariants } from "@workspace/ui/components/button"
import { TIMING, ms, EASE, OPACITY } from "@workspace/ui/lib/motion"
import { cn } from "@workspace/ui/lib/utils"

import { AgentsControl } from "@workspace/ui/neuve/agents/agents-control"
import { BatchArrivalsAnnouncer } from "@workspace/ui/neuve/shared/batch-arrivals"
import {
  BatchMenu,
  batchOverview,
  hasBatchMenu,
} from "@workspace/ui/neuve/shared/batch-menu"
import { BrandMark } from "@workspace/ui/neuve/shared/brand-mark"
import { useEmbedded } from "@workspace/ui/neuve/shared/embedded"
import { NeuveLink } from "@workspace/ui/neuve/shared/nav-link"
import type { NeuveDestination } from "@workspace/ui/neuve/shared/nav-link"
import { ThemeToggle } from "@workspace/ui/neuve/shared/theme-toggle"
import { headerTransition } from "@workspace/ui/neuve/shared/view-transitions"
import type {
  BatchOverviewData,
  ReviewBatches,
  ReviewDeskData,
} from "@workspace/ui/neuve/types"

/**
 * Live status of the records feed, provided by the host (the app's live
 * routes). Absent in mock pages and stories that don't set it: no indicator.
 *
 *   connecting    first snapshot not confirmed yet: nothing shown
 *   live          the event stream is open ("● Live")
 *   reconnecting  the stream dropped; the page shows the last loaded state
 */
export type LiveStatus =
  | { kind: "connecting" }
  | { kind: "live" }
  | { kind: "reconnecting"; detail: string }

const LiveStatusContext = React.createContext<LiveStatus | null>(null)

export function LiveStatusProvider({
  status,
  children,
}: {
  status: LiveStatus | null
  children: React.ReactNode
}) {
  return (
    <LiveStatusContext.Provider value={status}>
      {children}
    </LiveStatusContext.Provider>
  )
}

/**
 * A newer review of the work on screen replaced this screen's review while
 * the reader was on it (`ReviewDeskData.newer`, `BatchOverviewData.newer`):
 * the unit that holds the work now, or where the newer review starts.
 */
export type NewerReview = NonNullable<
  ReviewDeskData["newer"] | BatchOverviewData["newer"]
>

const NewerReviewContext = React.createContext<NewerReview | undefined>(
  undefined
)

/**
 * Provided by the host around a screen (the live routes, from their load):
 * the header then says once that a newer review is ready, and links to it.
 * Nothing else on the screen changes.
 */
export function NewerReviewProvider({
  newer,
  children,
}: {
  newer: NewerReview | undefined
  children: React.ReactNode
}) {
  return (
    <NewerReviewContext.Provider value={newer}>
      {children}
    </NewerReviewContext.Provider>
  )
}

/** Where "Newer review" goes: the successor unit, else the newer review's overview. */
export function newerReviewDestination(newer: NewerReview): NeuveDestination {
  return "unitId" in newer
    ? { to: "unit", unitId: newer.unitId }
    : batchOverview(undefined, newer.batchId)
}

/**
 * "Newer review": quiet and persistent beside the batch menu, in its
 * trigger's language (no banner, no toast). It is in the row's flow at a
 * fixed height, so the header keeps its height and nothing below moves.
 */
function NewerReviewLink({ className }: { className?: string }) {
  const newer = React.useContext(NewerReviewContext)
  if (!newer) return null
  return (
    <NeuveLink
      destination={newerReviewDestination(newer)}
      data-newer-review=""
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[13px] font-medium whitespace-nowrap text-ink no-underline transition-colors duration-surface-tone ease-standard hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus focus-visible:outline-solid motion-reduce:transition-none",
        className
      )}
    >
      Newer review
      <ArrowRightIcon
        aria-hidden="true"
        strokeWidth={1.75}
        className="size-3.5 shrink-0 text-ink-muted"
      />
    </NeuveLink>
  )
}

const PULSE = {
  dimmed: OPACITY.livePulse,
  transition: {
    duration: ms(TIMING.working),
    ease: EASE.inOut,
    repeat: Infinity,
    repeatType: "reverse",
  },
} as const

/**
 * "● Live" after the commit chip, or "Reconnecting" with an amber dot that
 * pulses (static under reduced motion). One polite status region, so the
 * change is announced once; the dot is decorative.
 */
function LiveIndicator() {
  const status = React.useContext(LiveStatusContext)
  const reduce = useReducedMotion()
  if (status === null) return null
  const reconnecting = status.kind === "reconnecting"
  return (
    <span
      role="status"
      title={reconnecting ? status.detail : undefined}
      className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap text-ink-2"
    >
      {status.kind !== "connecting" && (
        <>
          <motion.span
            key={status.kind}
            aria-hidden="true"
            animate={
              reconnecting && !reduce
                ? { opacity: [1, PULSE.dimmed] }
                : undefined
            }
            transition={PULSE.transition}
            className={
              reconnecting
                ? "size-[7px] rounded-full bg-warn"
                : "size-[7px] rounded-full bg-agt"
            }
          />
          {reconnecting ? "Reconnecting" : "Live"}
          {reconnecting && <span className="sr-only">. {status.detail}</span>}
        </>
      )}
    </span>
  )
}

export type AppHeaderProps = {
  /** Absent when there is no review batch yet: brand and theme only. */
  repo?: string
  branch?: string
  /** Commit chip text, e.g. "a3f9c2e" or "b71e5aa · cycle 3". */
  commit?: string
  /** The review's batches: a menu of them once there are several. */
  batches?: ReviewBatches
  /** The header destination this page is (marks its link current). */
  current?: "settings" | "reviews"
}

/**
 * The header's place in Ace's Review tab (shared/embedded.ts): one thin row
 * of where the review stands, the project (to its Reviews page), the branch
 * and the commit, then the batch menu and the live status. Ace's own chrome
 * holds the brand, the theme and the agents, so they give way; Settings
 * stays, at the row's end. Without a review, the row leads back to it.
 * Rendered beside the full header and shown only embedded, so the first
 * paint is already the right one; a page with a header of its own renders
 * it beside that one.
 */
export function EmbeddedRow({
  repo,
  branch,
  commit,
  batches,
  current,
}: AppHeaderProps) {
  const back = batchOverview(batches)
  // One batch menu per screen: its open state is shared (batchMenuOpenAtom).
  const embedded = useEmbedded()
  return (
    <header
      {...headerTransition}
      className="hidden min-h-9 items-center gap-2 border-b border-line px-4 py-1 text-[12.5px] text-ink-muted embedded:flex"
    >
      <div className="flex min-w-0 flex-auto items-center gap-2">
        {repo && current === "reviews" ? (
          <nav
            aria-label="Breadcrumb"
            className="flex min-w-0 items-center gap-2"
          >
            <span className="min-w-0 truncate">{repo}</span>
            <span aria-hidden="true">/</span>
            <span aria-current="page" className="font-medium text-ink">
              Reviews
            </span>
          </nav>
        ) : repo && branch ? (
          <>
            <NeuveLink
              destination={{ to: "reviews" }}
              className="min-w-0 shrink-[2] truncate rounded-sm text-ink-muted no-underline transition-colors duration-surface-tone ease-standard hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus focus-visible:outline-solid motion-reduce:transition-none"
            >
              {repo}
            </NeuveLink>
            <span aria-hidden="true">/</span>
            <span className="min-w-0 truncate font-medium text-ink">
              {branch}
            </span>
            {commit && (
              <span className="shrink-0 rounded-sm bg-raised px-1.5 py-px font-mono text-[11px] whitespace-nowrap text-ink-2">
                {commit}
              </span>
            )}
            {embedded && batches && hasBatchMenu(batches) && (
              <span className="flex min-w-0 items-center gap-2">
                <span aria-hidden="true">/</span>
                <BatchMenu batches={batches} />
              </span>
            )}
            {embedded && (
              <NewerReviewLink className="-ml-1 h-6 text-[12.5px]" />
            )}
            <LiveIndicator />
          </>
        ) : (
          <NeuveLink
            destination={back}
            className={cn(
              buttonVariants({ variant: "quiet", size: "compact" }),
              "-ml-2 h-7"
            )}
          >
            <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
            {back.to === "overview" ? "Batch overview" : "Reviews"}
          </NeuveLink>
        )}
      </div>
      <NeuveLink
        destination={{ to: "settings" }}
        aria-label="Settings"
        aria-current={current === "settings" ? "page" : undefined}
        title="Settings"
        className={cn(
          buttonVariants({ variant: "quiet", size: "icon-nav" }),
          "-mr-1.5 size-7 shrink-0 aria-[current=page]:bg-raised aria-[current=page]:text-ink"
        )}
      >
        <SettingsIcon aria-hidden="true" className="size-3.5" />
      </NeuveLink>
    </header>
  )
}

/**
 * The one header for every screen (option A bar): logo + logotype (to the
 * Reviews page), the branch, the commit chip, the batch menu when the review
 * has several batches (published or still being reviewed), the Agents control, Find ⌘K,
 * Settings and the theme toggle. The live status follows the commit chip (round 3:
 * the full-width status strip is gone). The human gate and Units/Files live in the unit
 * column, not here.
 *
 * On a phone (600px and narrower) the bar takes two rows: the logomark and
 * the controls, then the breadcrumb on one line, where the
 * branch shortens before anything wraps. The agents' avatars and Find's
 * label and ⌘K give way, and the logotype below 360px; each control keeps
 * its name, and the agents' count and the batch menu stay. Several batches
 * put the menu on a line of its own below.
 *
 * Embedded in Ace's Review tab it gives way to the thin row (EmbeddedRow).
 * A batch that arrives while the screen is open is announced once, politely
 * (batch-arrivals.tsx).
 */
export function AppHeader(props: AppHeaderProps) {
  const newer = React.useContext(NewerReviewContext)
  return (
    <>
      <FullHeader {...props} />
      <EmbeddedRow {...props} />
      {/* One for both rows: only one of them is ever shown. */}
      <BatchArrivalsAnnouncer
        batches={props.batches}
        newer={newer !== undefined}
      />
    </>
  )
}

function FullHeader({
  repo,
  branch,
  commit,
  batches,
  current,
}: AppHeaderProps) {
  const embedded = useEmbedded()
  return (
    <header
      {...headerTransition}
      className="relative box-border flex min-h-14 flex-wrap items-center gap-4 border-b border-line px-5 py-2 max-[600px]:gap-x-2 max-[600px]:gap-y-1 max-[600px]:px-4 embedded:hidden"
    >
      <NeuveLink
        destination={{ to: "reviews" }}
        aria-label="Neuve — Reviews"
        className="no-underline max-[600px]:mr-auto"
      >
        <BrandMark logotypeClassName="max-[360px]:hidden" />
      </NeuveLink>
      {/* The logo leads to the Reviews page, so its one crumb is the page. */}
      {repo && current === "reviews" && (
        <span
          aria-current="page"
          className="flex min-w-0 items-center text-[13px] font-medium text-ink max-[600px]:order-last max-[600px]:min-h-[21px] max-[600px]:basis-full"
        >
          Reviews
        </span>
      )}
      {repo && branch && current !== "reviews" && (
        // On a phone at least the loading header's second row
        // (skeletons.tsx), so the page below holds still as it loads.
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-muted max-[600px]:order-last max-[600px]:min-h-[21px] max-[600px]:basis-full">
          {/* On a phone one line: it fits by shortening the branch (basis 0,
              growing to its full width where there is room), so the live
              status stays beside the commit. The logo leads to the Reviews
              page, so the breadcrumb starts at the range. */}
          <span className="contents max-[600px]:flex max-[600px]:max-w-max max-[600px]:min-w-0 max-[600px]:grow max-[600px]:basis-0 max-[600px]:items-center max-[600px]:gap-2">
            <span className="truncate font-medium text-ink">{branch}</span>
            {commit && (
              <span className="shrink-0 rounded-md bg-raised px-2 py-0.5 font-mono text-[11.5px] whitespace-nowrap text-ink-2">
                {commit}
              </span>
            )}
          </span>
          {!embedded && batches && hasBatchMenu(batches) ? (
            // On a phone the batch menu takes its own line, below the live
            // status; a newer review's link stays beside it there.
            <span className="flex min-w-0 items-center gap-2 max-[600px]:order-last max-[600px]:basis-full">
              <span aria-hidden="true" className="max-[600px]:hidden">
                /
              </span>
              <BatchMenu batches={batches} />
              <NewerReviewLink className="-ml-1" />
            </span>
          ) : (
            // With no batch menu, where it would be: on a phone in the
            // breadcrumb's one line, which shortens to make room.
            !embedded && <NewerReviewLink className="-ml-1" />
          )}
          <LiveIndicator />
        </div>
      )}
      <div className="flex-auto max-[600px]:hidden" />
      <AgentsControl />
      {repo && (
        <button
          type="button"
          aria-keyshortcuts="Meta+K"
          className="inline-flex h-8 items-center gap-2 rounded-lg border-0 bg-raised pr-2 pl-2.5 text-[12.5px] text-ink-muted transition-colors duration-surface-tone ease-standard hover:bg-raised-2 hover:text-ink motion-reduce:transition-none max-[600px]:w-8 max-[600px]:justify-center max-[600px]:px-0"
        >
          <SearchIcon aria-hidden="true" className="size-3.5" />
          <span className="max-[600px]:sr-only">Find</span>
          <kbd className="rounded-sm bg-raised-2 px-[5px] py-px font-mono text-[10.5px] text-ink-2 max-[600px]:hidden">
            ⌘K
          </kbd>
        </button>
      )}
      <NeuveLink
        destination={{ to: "settings" }}
        aria-label="Settings"
        aria-current={current === "settings" ? "page" : undefined}
        title="Settings"
        className={cn(
          buttonVariants({ variant: "quiet", size: "icon-nav" }),
          "aria-[current=page]:bg-raised aria-[current=page]:text-ink"
        )}
      >
        <SettingsIcon aria-hidden="true" className="size-[15px]" />
      </NeuveLink>
      <ThemeToggle />
    </header>
  )
}
