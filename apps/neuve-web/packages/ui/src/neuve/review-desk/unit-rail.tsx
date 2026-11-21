/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD — Unit rail
 *
 *    0ms   row hover: tone shift (surfaceTone 120ms, CSS)
 *    0ms   collapse / expand (button or "["): the column swaps between
 *          272px and the 60px icon column; the new content fades in
 *          (swap 180ms, standard)
 *    0ms   a shared marker is pointed at or opened: linked units tone-shift
 *          to the suggested tint (linked 160ms, standard); a unit shows a
 *          link glyph, a lane group one dot per linked unit (fade 160ms)
 *  leave   tones return (linked 160ms)
 *    0ms   a lane group expands: chevron turns (chevron 200ms); its units
 *          rise y -4 → 0, opacity 0 → 1 (detail 240ms, emphasized
 *          decelerate); collapse fades them (reduced 150ms)
 *    0ms   a long lane group scrolls inside its bounded list (from 861px);
 *          the open unit's row is scrolled into view there on arrival
 *          (instant). Below 861px "Show all N units" opens the group in a
 *          sheet: scrim, then the sheet rises y 24 → 0, opacity 0 → 1
 *          (detail 240ms, emphasized decelerate); it closes at once
 *    0ms   unit switch (round 3): the clicked row selects at once and its
 *          lane glyph becomes a spinner (workingSpin 900ms turn); the desk
 *          dims the old unit to 45% (switchDim 160ms) once the switch has
 *          taken 150ms (switchWait; review-desk-screen); arrival remounts
 *          the desk
 *    0ms   Units ⇄ Files: the list swaps with a fade (swap 180ms); no fade
 *          on the desk's first paint (AnimatePresence initial={false})
 *
 * Reduced motion: the swap and link marks appear without fading; tone
 * shifts are instant; the spinner holds still; the sheet fades in (150ms).
 * ───────────────────────────────────────────────────────── */

import * as React from "react"
import { atom, useAtomValue, useSetAtom } from "jotai"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronDownIcon,
  EyeOffIcon,
  LinkIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  XIcon,
} from "lucide-react"

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { REDUCED_TRANSITION, TIMING, ms, EASE } from "@workspace/ui/lib/motion"
import { cn } from "@workspace/ui/lib/utils"
import { AgentTag } from "@workspace/ui/neuve/agents/agent-avatar"
import {
  ReviewMark,
  reviewActorShort,
} from "@workspace/ui/neuve/shared/review-mark"
import { agentByIdAtom } from "@workspace/ui/neuve/agents/atoms"
import { LaneGlyph, LaneSpinner } from "@workspace/ui/neuve/shared/lane-glyph"
import { NeuveLink } from "@workspace/ui/neuve/shared/nav-link"
import { batchOverview } from "@workspace/ui/neuve/shared/batch-menu"
import { Segmented } from "@workspace/ui/neuve/shared/segmented"
import { railTransition } from "@workspace/ui/neuve/shared/view-transitions"
import {
  browseModeAtom,
  decidedDock,
  dockAtom,
  hoverHintAtom,
  isDecidedAtom,
  openLanesAtom,
  openMarkerAtom,
  pendingUnitAtom,
  recordedMarkerKey,
  toggleLaneAtom,
  toggleRailAtom,
  useRailCollapsed,
} from "@workspace/ui/neuve/review-desk/atoms"
import type { DockState } from "@workspace/ui/neuve/review-desk/atoms"
import {
  currentFileAtom,
  landOnAtom,
  useViewedFiles,
  viewedKey,
} from "@workspace/ui/neuve/review-desk/landing"
import {
  LANE_NAME,
  MovedUpMark,
  UntitledFolder,
  NOT_READ_LABEL,
  UntitledLines,
  excludedWords,
  movedUpLabel,
  untitledName,
} from "@workspace/ui/neuve/shared/lane-facts"
import type { UntitledNameParts } from "@workspace/ui/neuve/shared/lane-facts"
import type {
  ContextualMarker,
  ElsewhereLane,
  LaneUnit,
  PersonReview,
  RailUnit,
  ReviewDeskData,
  ReviewLane,
} from "@workspace/ui/neuve/types"

const RAIL = {
  swap: { duration: ms(TIMING.swap), ease: EASE.standard },
  lane: { duration: ms(TIMING.detail), ease: EASE.emphasizedDecelerate },
} as const

const TONE_ROW =
  "rounded-lg border-0 text-left no-underline transition-colors duration-rail-tone ease-standard hover:bg-raised motion-reduce:transition-none"

/**
 * A plain primary click (no modifier, not already handled): the link opens
 * in place, so the unit switch starts. Modified clicks open elsewhere.
 */
export function isPlainClick(event: React.MouseEvent) {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  )
}

/**
 * The unit the host router is navigating to, provided by the desk: a unit
 * id, null when no navigation is pending, or undefined for hosts without a
 * router (stories), where the rail's click records the switch instead.
 */
export const HostPendingUnitContext = React.createContext<
  string | null | undefined
>(undefined)

/**
 * The unit being switched to, or null (round 3, item 10; review F3/N1).
 * Derived, never mirrored: with a router host it is the router's pending
 * location (so Back, superseded navigations, errors and refreshes of the
 * current unit settle it); without one it is the clicked unit.
 */
export function useSwitchingTo(current: string): string | null {
  const host = React.useContext(HostPendingUnitContext)
  return switchingTo(host, useAtomValue(pendingUnitAtom), current)
}

/** The derivation behind useSwitchingTo, for the component that provides the host value. */
export function switchingTo(
  host: string | null | undefined,
  clicked: string | null,
  current: string
): string | null {
  if (host === undefined) return clicked
  return host !== null && host !== current ? host : null
}

/**
 * Click handler factory that starts a switch. A router host already marks
 * the navigation pending on the click, so only router-less hosts record it.
 * Opening the current unit again cancels a recorded switch.
 */
export function useStartUnitSwitch(current: string) {
  const host = React.useContext(HostPendingUnitContext)
  const setPending = useSetAtom(pendingUnitAtom)
  return (unitId: string) => (event: React.MouseEvent) => {
    if (host === undefined && isPlainClick(event))
      setPending(unitId === current ? null : unitId)
  }
}

/**
 * Unit switch: the unit the rail shows as selected (the one being opened, or
 * the current one) and the click handler that starts the switch.
 */
function useUnitSwitch(current: string) {
  const pending = useSwitchingTo(current)
  return {
    selected: pending ?? current,
    pending,
    open: useStartUnitSwitch(current),
  }
}

/** A rail card's tag for each decided state of the dock. */
const DOCK_CHIP: Partial<
  Record<DockState, { text: string; className: string }>
> = {
  approved: { text: "approved", className: "bg-raised-2 text-agt-fg" },
  agreed: { text: "agreed", className: "bg-raised-2 text-agt-fg" },
  "changes-requested": {
    text: "changes requested",
    className: "bg-raised-2 text-ink-2",
  },
  commented: { text: "commented", className: "bg-raised-2 text-ink-2" },
}

/**
 * A rail card's tag: the disposition standing on its unit, in the words the
 * dock shows for it, so a card says the same open or not. The open card
 * reads the dock first, which also holds what only it knows (a decision
 * just sent or undone, a comment), then its decision signal, before the
 * standing disposition, as it did before every card showed one.
 */
export function railCardChip(
  unit: Pick<RailUnit, "disposition">,
  open?: {
    dock: DockState
    signal: ReviewDeskData["unit"]["decisionSignal"]
  }
) {
  const standing = unit.disposition
    ? DOCK_CHIP[decidedDock(unit.disposition, "human-required")]
    : undefined
  if (!open) return standing ?? null
  return (
    DOCK_CHIP[open.dock] ??
    (open.signal === "conflict"
      ? { text: "conflict", className: "bg-req-tint text-req-ink" }
      : undefined) ??
    standing ??
    null
  )
}

/** Rail chip for the current unit from the dock: its disposition, then its decision signal. */
function useRailChip(signal: ReviewDeskData["unit"]["decisionSignal"]) {
  const dock = useAtomValue(dockAtom)
  return railCardChip({}, { dock, signal })
}

/**
 * The units that share the marker being pointed at or opened. One visual
 * language with the pin's dots: shared context is shown, never footnoted.
 */
function useLinkedUnits(markers: Record<string, ContextualMarker>) {
  const open = useAtomValue(openMarkerAtom)
  const hint = useAtomValue(hoverHintAtom)
  const active = open ?? hint?.markerKey ?? null
  return new Set(
    active ? (markers[recordedMarkerKey(active)]?.sharedWith ?? []) : []
  )
}

function LinkMark({ label }: { label: string }) {
  const reduce = useReducedMotion()
  return (
    <motion.span
      role="img"
      aria-label={label}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={
        reduce
          ? { duration: 0 }
          : { duration: ms(TIMING.linked), ease: EASE.out }
      }
      className="inline-flex shrink-0 items-center gap-[3px] text-sug-fg"
    >
      <LinkIcon aria-hidden="true" className="size-3" strokeWidth={2} />
    </motion.span>
  )
}

function LinkDots({ count, label }: { count: number; label: string }) {
  const reduce = useReducedMotion()
  return (
    <motion.span
      role="img"
      aria-label={label}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={
        reduce
          ? { duration: 0 }
          : { duration: ms(TIMING.linked), ease: EASE.out }
      }
      className="inline-flex items-center gap-[3px]"
    >
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className="size-[5px] rounded-full bg-sug" />
      ))}
    </motion.span>
  )
}

/** Human gate meter: one segment per human-required unit. */
function GateMeter({ data }: { data: ReviewDeskData }) {
  const total = data.humanRequiredTotal
  const decided = useAtomValue(isDecidedAtom)
  const dock = useAtomValue(dockAtom)
  const settledIds = new Set(data.humanDecidedUnitIds)
  // Only a unit the meter counts: never one a carried decision closes.
  if (data.railUnits.some((unit) => unit.id === data.unit.id)) {
    if (dock === "rest") settledIds.delete(data.unit.id)
    else if (
      dock === "approved" ||
      dock === "agreed" ||
      dock === "changes-requested"
    )
      settledIds.add(data.unit.id)
  }
  const settled =
    data.humanDecidedUnitIds === undefined ? (decided ? 1 : 0) : settledIds.size
  return (
    <>
      <span className="ml-auto inline-flex gap-0.5" aria-hidden="true">
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            className={cn(
              "h-1 w-3 rounded-[2px] transition-colors duration-tick ease-standard motion-reduce:transition-none",
              i < settled ? "bg-req" : "bg-req-tint-2"
            )}
          />
        ))}
      </span>
      <span className="font-mono text-[11px] text-ink-muted">
        <span className="sr-only">Decided </span>
        {settled}/{total}
      </span>
    </>
  )
}

type CarriedReview = NonNullable<RailUnit["carriedReview"]> | PersonReview

/** The current row's chip that says the same as a carried review. */
const CARRIED_CHIP: Record<CarriedReview["verdict"], string | undefined> = {
  approved: DOCK_CHIP.approved?.text,
  changes_requested: DOCK_CHIP["changes-requested"]?.text,
}

/** "Carried · You approved", or "You approved" once decided fresh: a row's tooltip. */
function reviewWords(review: CarriedReview) {
  return `${review.carried ? "Carried · " : ""}${reviewActorShort(review.actor)} ${review.verdict === "approved" ? "approved" : "requested changes"}`
}

/**
 * The person's review on a "Decided" row: the 16px review mark (avatar and
 * verdict icon). Its words stay for assistive tech, "Carried · " first while
 * the carried decision stands, as the overview's mark says them; the row's
 * tooltip says them too, with the earlier review's head. Inside the row's
 * link, so it has no provenance button of its own.
 */
function CarriedMark({
  review,
  className,
}: {
  review: CarriedReview
  className?: string
}) {
  return (
    <span
      data-carried-review={review.carried ? "" : undefined}
      className={cn("inline-flex shrink-0 items-center", className)}
    >
      {review.carried && <span className="sr-only">Carried · </span>}
      <ReviewMark
        compact
        size={16}
        verdict={review.verdict}
        actor={review.actor}
      />
    </span>
  )
}

function laneTitle(lane: ReviewLane) {
  return lane === "human-required" ? "needs your decision" : LANE_NAME[lane]
}

/**
 * The agents' and tools' lanes the rail draws: none when every one is
 * empty (a batch whose only other unit no agent read), so no heading or
 * row of zeros stands over nothing; otherwise all of them, zeros included.
 */
function agentLanes(data: ReviewDeskData) {
  return data.elsewhere.some(
    (lane) => lane.count > 0 || (lane.units?.length ?? 0) > 0
  )
    ? data.elsewhere
    : []
}

/**
 * The visible name of a unit with no written title (lane groups and
 * "Needs your decision" share it): the file's name, then its owned lines,
 * with the folder quiet below. The title stays the accessible name, said
 * once in a hidden span with the raised words after it, so the visible
 * parts are hidden from assistive tech. `nameClassName` places and sizes
 * the first line in its row.
 */
function UntitledName({
  title,
  name,
  raisedFrom,
  nameClassName,
}: {
  title: string
  name: UntitledNameParts
  raisedFrom?: ReviewLane
  nameClassName?: string
}) {
  return (
    <>
      <span className="sr-only">
        {title}
        {raisedFrom && `, ${movedUpLabel(raisedFrom)}`}
      </span>
      <span
        aria-hidden="true"
        className={cn("flex min-w-0 items-baseline gap-1.5", nameClassName)}
      >
        <span className="max-w-full shrink-0 truncate">{name.name}</span>
        <UntitledLines name={name} className="min-w-0 truncate" />
        {raisedFrom && (
          <MovedUpMark
            from={raisedFrom}
            named={false}
            className="self-center"
          />
        )}
      </span>
      {/* The folder quiet below; an empty cell keeps the row's grid. */}
      {name.folder ? (
        <UntitledFolder name={name} className="text-[10.5px] leading-4" />
      ) : (
        <span />
      )}
    </>
  )
}

/**
 * A rail row's tooltip, on real pointer hover and keyboard focus: the full
 * title of a unit with no written title, the raised words, and any notes
 * (a "Decided" row's review), with the full title before notes. Rows with
 * none of them have none.
 */
function RowTip({
  title,
  untitled,
  raisedFrom,
  notes = [],
  children,
}: {
  title: string
  untitled: boolean
  raisedFrom?: ReviewLane
  notes?: ReadonlyArray<string>
  children: React.ReactElement
}) {
  if (!untitled && !raisedFrom && notes.length === 0) return children
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        side="right"
        align="start"
        className="flex-col items-start gap-0.5"
      >
        {untitled ? (
          <span className="font-mono wrap-anywhere">{title}</span>
        ) : (
          notes.length > 0 && <span className="font-medium">{title}</span>
        )}
        {raisedFrom && <span>{movedUpLabel(raisedFrom)}</span>}
        {notes.map((note) => (
          <span key={note}>{note}</span>
        ))}
      </TooltipContent>
    </Tooltip>
  )
}

function ExpandedRail({
  data,
  markers,
}: {
  data: ReviewDeskData
  markers: Record<string, ContextualMarker>
}) {
  const chip = useRailChip(data.unit.decisionSignal)
  const dock = useAtomValue(dockAtom)
  const linked = useLinkedUnits(markers)
  const agents = useAtomValue(agentByIdAtom)
  const toggle = useSetAtom(toggleRailAtom)
  const unitSwitch = useUnitSwitch(data.unit.id)
  const mode = useAtomValue(browseModeAtom)
  const setMode = useSetAtom(browseModeAtom)
  const reduce = useReducedMotion()
  const laneOf = new Map(data.batchUnits.map((unit) => [unit.id, unit.lane]))
  const elsewhere = agentLanes(data)

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="Collapse sidebar"
            aria-keyshortcuts="["
            onClick={toggle}
            className="absolute top-[22px] right-2.5 z-2 inline-flex size-[30px] items-center justify-center rounded-lg border-0 bg-transparent text-ink-muted transition-colors duration-surface-tone ease-standard hover:bg-raised hover:text-ink motion-reduce:transition-none"
          >
            <PanelLeftCloseIcon aria-hidden="true" className="size-[15px]" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">Collapse sidebar · [</TooltipContent>
      </Tooltip>

      <NeuveLink
        destination={batchOverview(data.batches)}
        className="group/back grid grid-cols-[32px_minmax(0,1fr)] items-center gap-x-3 gap-y-0.5 rounded-[10px] py-2.5 pr-10 pl-2.5 text-ink no-underline transition-colors duration-surface-tone ease-standard hover:bg-raised hover:text-ink motion-reduce:transition-none"
      >
        <span className="row-span-2 inline-flex size-8 items-center justify-center rounded-lg bg-raised text-ink-2 group-hover/back:bg-raised-2 group-hover/back:text-ink">
          <ArrowLeftIcon
            aria-hidden="true"
            strokeWidth={1.9}
            className="size-4 transition-transform duration-nudge ease-ios-out group-hover/back:-translate-x-(--nv-offset-nudge) motion-reduce:transition-none"
          />
        </span>
        <span className="text-xs text-ink-muted">Batch overview</span>
        <span className="text-sm leading-[19px] font-semibold tracking-[-0.01em]">
          {data.batchTitle}
        </span>
      </NeuveLink>

      <div className="flex px-0.5">
        <Segmented
          label="Rail view"
          options={[
            { value: "units", label: "Units" },
            { value: "files", label: "Files" },
          ]}
          value={mode}
          onValueChange={setMode}
        />
      </div>

      {/* Fades only when the view swaps, never on the desk's first paint. */}
      <AnimatePresence initial={false}>
        <motion.div
          key={mode}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={reduce ? REDUCED_TRANSITION : RAIL.swap}
          // From 861px the sections share the rail's height (LaneGroup).
          className="flex flex-col gap-6 shell:min-h-0 shell:flex-auto"
        >
          {mode === "files" ? (
            <FilesList data={data} />
          ) : (
            <>
              {data.humanRequiredTotal > 0 && (
                <section
                  className="flex flex-col gap-0.5"
                  aria-label="Needs your decision"
                >
                  <div className="flex items-center gap-2 px-2.5 pb-2">
                    <LaneGlyph lane="human-required" />
                    <span className="text-xs font-semibold text-req-fg">
                      Needs your decision
                    </span>
                    <GateMeter data={data} />
                  </div>
                  {data.railUnits.map((unit) => {
                    const here = unit.id === data.unit.id
                    const current = unit.id === unitSwitch.selected
                    const busy = unit.id === unitSwitch.pending
                    const isLinked = linked.has(unit.id)
                    const agent = unit.agentId
                      ? agents[unit.agentId]
                      : undefined
                    const name = untitledName(unit.untitled)
                    const tag = railCardChip(
                      unit,
                      here && !unitSwitch.pending
                        ? { dock, signal: data.unit.decisionSignal }
                        : undefined
                    )
                    return (
                      <RowTip
                        key={unit.id}
                        title={unit.title}
                        untitled={name !== null}
                        raisedFrom={unit.raisedFrom}
                      >
                        <NeuveLink
                          destination={{ to: "unit", unitId: unit.id }}
                          aria-current={here ? "page" : undefined}
                          aria-busy={busy || undefined}
                          onClick={unitSwitch.open(unit.id)}
                          data-linked={isLinked ? "" : undefined}
                          className={cn(
                            TONE_ROW,
                            "flex flex-col gap-1 p-2.5 text-ink hover:text-ink",
                            current
                              ? "bg-select hover:bg-select"
                              : isLinked
                                ? "bg-sug-tint hover:bg-sug-tint"
                                : "bg-transparent"
                          )}
                        >
                          {/* The title keeps one weight and the whole row
                        width whatever the row's state, so selecting,
                        switching or linking never rewraps it and the rows
                        below stay put; the selection is the tone. A unit
                        with no written title is named by its file and
                        lines, as in a lane group. */}
                          {name ? (
                            <span className="flex flex-col gap-px text-[13.5px] font-medium text-ink">
                              <UntitledName title={unit.title} name={name} />
                            </span>
                          ) : (
                            <span className="text-[13.5px] font-medium text-ink">
                              {unit.title}
                            </span>
                          )}
                          <span className="flex items-center gap-2">
                            <span className="font-mono text-[11px] text-ink-muted">
                              {unit.scopeLabel ??
                                `${unit.hunkCount} ${unit.hunkCount === 1 ? "hunk" : "hunks"}`}
                            </span>
                            {/* Beside the second line, so the title never
                          rewraps; the busy and link marks follow it. */}
                            {unit.raisedFrom && (
                              <MovedUpMark from={unit.raisedFrom} />
                            )}
                            {busy && <LaneSpinner lane="human-required" />}
                            {isLinked && (
                              <LinkMark label="Shares the open context" />
                            )}
                            {tag && (
                              <span
                                className={cn(
                                  "rounded-sm px-1.5 py-px font-mono text-[10.5px]",
                                  tag.className
                                )}
                              >
                                {tag.text}
                              </span>
                            )}
                            {agent && (
                              <AgentTag agent={agent} className="ml-auto" />
                            )}
                          </span>
                        </NeuveLink>
                      </RowTip>
                    )
                  })}
                </section>
              )}
              {data.carriedUnits && data.carriedUnits.length > 0 && (
                <CarriedGroup
                  units={data.carriedUnits}
                  current={data.unit.id}
                  selected={unitSwitch.selected}
                  pending={unitSwitch.pending}
                  onOpen={unitSwitch.open}
                  linked={linked}
                  chip={chip}
                />
              )}
              {(elsewhere.length > 0 ||
                (data.notReadUnits && data.notReadUnits.length > 0)) && (
                // One container for the agents' lanes and the "Not read"
                // group, with the lanes' one height rule: they scroll and
                // shrink together, so nothing is drawn over anything. Each
                // is its own region (`contents` keeps its children in this
                // container's flow).
                <div className="flex flex-col gap-0.5 shell:min-h-0">
                  {elsewhere.length > 0 && (
                    <section
                      className="contents"
                      aria-label="Decided by agents and tools"
                    >
                      <span className="px-2.5 pb-1.5 label-mono">
                        Decided by agents and tools
                      </span>
                      {elsewhere.map((lane) => (
                        <LaneGroup
                          key={lane.lane}
                          lane={lane}
                          current={data.unit.id}
                          selected={unitSwitch.selected}
                          pending={unitSwitch.pending}
                          onOpen={unitSwitch.open}
                          linked={linked}
                          linkedCount={
                            [...linked].filter(
                              (id) => laneOf.get(id) === lane.lane
                            ).length
                          }
                        />
                      ))}
                    </section>
                  )}
                  {data.notReadUnits && data.notReadUnits.length > 0 && (
                    <NotReadGroup
                      units={data.notReadUnits}
                      current={data.unit.id}
                      selected={unitSwitch.selected}
                      pending={unitSwitch.pending}
                      onOpen={unitSwitch.open}
                      linked={linked}
                    />
                  )}
                </div>
              )}
            </>
          )}
        </motion.div>
      </AnimatePresence>
    </>
  )
}

/**
 * Height containment. In the desk's app shell (`shell:`: from 861px, or
 * embedded at any width) the rail is one column of the viewport's height
 * and its sections share it: "Needs your decision" and the lane headers keep
 * their full height, and an open lane group longer than LANE_SHRINK_FROM
 * rows gives up height down to about four rows, scrolling inside its own
 * bounded list (the longest group gives up the most). Below 861px on the
 * app's own address (`stacked:`) the page is the one scroll container, so
 * nothing nests: a long group lists LANE_PREVIEW rows and "Show all N units"
 * opens the group in a sheet.
 */
const LANE_SHRINK_FROM = 5
const LANE_PREVIEW = 6
const LANE_PREVIEW_SLACK = 2

/**
 * The rows a group shows below 861px: the first LANE_PREVIEW, or, when the
 * open unit lies past them, a window that starts one row above it so it is
 * in view with its neighbours. Null when the group lists every unit.
 */
export function laneWindow(
  count: number,
  currentIndex: number
): { start: number; end: number } | null {
  if (count <= LANE_PREVIEW + LANE_PREVIEW_SLACK) return null
  const start =
    currentIndex < LANE_PREVIEW
      ? 0
      : Math.min(currentIndex - 1, count - LANE_PREVIEW)
  return { start, end: start + LANE_PREVIEW }
}

/** The lane group open in the phone sheet, if any (reset per desk). */
const laneSheetAtom = atom<string | null>(null)

/**
 * Each lane list's scroll position, by its key, kept across desks: the desk
 * remounts per unit, so without it a click on a visible row would open the
 * next desk with its list back at the top. Scroll memory, like the
 * browser's, not app state.
 */
const laneScroll = new Map<string, number>()

/**
 * Ref for a lane list. The first time the list is laid out bounded (its
 * first resize that overflows: on a client navigation that can come after
 * the rows' refs ran), it goes back to where the reader left it and shows
 * the open unit's row. Later resizes leave it alone.
 */
function settleLaneScroll(list: HTMLElement | null) {
  if (!list) return
  const observer = new ResizeObserver(() => {
    if (
      list.dataset.settled !== undefined ||
      list.scrollHeight <= list.clientHeight
    )
      return
    list.dataset.settled = ""
    const saved = laneScroll.get(list.dataset.laneScroll ?? "")
    if (saved !== undefined) list.scrollTop = saved
    const here = list.querySelector<HTMLElement>(
      '[role="listitem"]:has([aria-current="page"])'
    )
    if (here) reveal(list, here)
  })
  observer.observe(list)
  return () => observer.disconnect()
}

/** Scrolls `list` the least that shows `row` whole (block nearest). */
function reveal(list: HTMLElement, row: HTMLElement) {
  const inset = 4
  const top = row.offsetTop
  const bottom = top + row.offsetHeight
  if (top < list.scrollTop + inset) list.scrollTop = top - inset
  else if (bottom > list.scrollTop + list.clientHeight - inset)
    list.scrollTop = bottom - list.clientHeight + inset
}

/**
 * Ref for the open unit's row; React calls it whenever a row becomes the
 * open one (arrival, Back, Forward, Find). Inside a bounded lane list it
 * scrolls only if the row is outside the visible part, so a click on a
 * visible row never moves the list (on a new desk settleLaneScroll first puts
 * the list back where it was). When the row is below the rail's fold, it
 * scrolls the rail.
 * Below 861px neither is a scroll container and nothing moves.
 */
function keepInView(node: HTMLElement | null) {
  if (!node) return
  const list = node.closest<HTMLElement>("[data-lane-scroll]")
  if (list) reveal(list, node)
  const rail = node.closest("nav")
  if (!rail || getComputedStyle(rail).overflowY !== "auto") return
  const row = node.getBoundingClientRect()
  const view = rail.getBoundingClientRect()
  const margin = 48
  if (row.bottom > view.bottom)
    rail.scrollTop += row.bottom - view.bottom + margin
  else if (row.top < view.top) rail.scrollTop -= view.top - row.top + margin
}

/**
 * Opens the sheet as modal once it is in the page, then shows the open
 * unit's row in its list (the rows' own refs ran before the dialog showed,
 * when nothing in it had a layout).
 */
function showModal(node: HTMLDialogElement | null) {
  if (!node || node.open) return
  node.showModal()
  const here = node.querySelector<HTMLElement>(
    '[role="listitem"]:has([aria-current="page"])'
  )
  const list = here?.closest<HTMLElement>("[data-lane-scroll]")
  if (here && list) reveal(list, here)
}

/** Whether the reader opened or closed the "Decided" group (reset per desk). */
const decidedGroupAtom = atom<boolean | null>(null)

/**
 * The human-required units a person's decision carried from an earlier
 * review closes: never under "Needs your decision" nor in its meter, they
 * are listed in a collapsed group of their own, "Decided", drawn as a lane
 * group. It is open when the open unit is one of them. A row shows the
 * person's review with the carried mark, or, on the open unit once the
 * dock says otherwise, the dock's chip.
 */
function CarriedGroup({
  units,
  current,
  selected,
  pending,
  onOpen,
  linked,
  chip,
}: {
  units: ReadonlyArray<RailUnit>
  current: string
  selected: string
  pending: string | null
  onOpen: (unitId: string) => (event: React.MouseEvent) => void
  linked: ReadonlySet<string>
  chip: ReturnType<typeof useRailChip>
}) {
  const toggled = useAtomValue(decidedGroupAtom)
  const setToggled = useSetAtom(decidedGroupAtom)
  const open = toggled ?? units.some((unit) => unit.id === current)
  const reviews = new Map(units.map((unit) => [unit.id, unit.carriedReview]))
  const rows: Array<LaneUnit> = units.map((unit) => ({
    id: unit.id,
    title: unit.title,
    result: "carried",
    ...(unit.untitled ? { untitled: unit.untitled } : {}),
    ...(unit.raisedFrom ? { raisedFrom: unit.raisedFrom } : {}),
  }))
  return (
    <div className="flex flex-col gap-0.5 shell:min-h-0" data-decided-group="">
      <LaneGroup
        lane={{
          lane: "human-required",
          label: "Decided",
          count: units.length,
          units: rows,
        }}
        current={current}
        selected={selected}
        pending={pending}
        onOpen={onOpen}
        linked={linked}
        linkedCount={units.filter((unit) => linked.has(unit.id)).length}
        open={open}
        onToggle={() => setToggled(!open)}
        notes={(row) => {
          const review = reviews.get(row.id)
          return review
            ? [reviewWords(review), ...(review.carried ? [review.carried] : [])]
            : undefined
        }}
        result={(row) => {
          const review = reviews.get(row.id)
          if (!review) return null
          // The carried review stands until the dock says otherwise: one
          // of the chip and the mark, never both.
          if (
            row.id === current &&
            pending === null &&
            chip &&
            chip.text !== CARRIED_CHIP[review.verdict]
          )
            return (
              <span
                className={cn(
                  "rounded-sm px-1.5 py-px font-mono text-[10.5px]",
                  chip.className
                )}
              >
                {chip.text}
              </span>
            )
          return <CarriedMark review={review} />
        }}
      />
    </div>
  )
}

/** Whether the reader opened or closed the "Not read" group (reset per desk). */
const notReadGroupAtom = atom<boolean | null>(null)

/** The "Not read" group's glyph: an eye struck through, quiet, sized as a lane glyph. */
function NotReadGlyph({ className }: { className?: string }) {
  return (
    <EyeOffIcon
      aria-hidden="true"
      strokeWidth={1.75}
      className={cn("size-[11px] text-ink-muted", className)}
    />
  )
}

/**
 * The units no agent read (lockfiles and generated files): no agent decided
 * them, so they are a collapsed group of their own, "Not read", below the
 * lanes decided by agents and tools, drawn as a lane group. It is open when
 * the open unit is one of them; each row says its state.
 */
function NotReadGroup({
  units,
  current,
  selected,
  pending,
  onOpen,
  linked,
}: {
  units: ReadonlyArray<LaneUnit & { lane: ReviewLane }>
  current: string
  selected: string
  pending: string | null
  onOpen: (unitId: string) => (event: React.MouseEvent) => void
  linked: ReadonlySet<string>
}) {
  const toggled = useAtomValue(notReadGroupAtom)
  const setToggled = useSetAtom(notReadGroupAtom)
  const open = toggled ?? units.some((unit) => unit.id === current)
  return (
    // Below the agents' lanes, set apart by a hairline as the icon column
    // sets it apart: it is no lane decided by agents and tools. It shrinks
    // with them, as a lane group does.
    <section
      aria-label={NOT_READ_LABEL}
      className="mt-3 flex flex-col gap-0.5 border-t border-line pt-3 shell:min-h-0"
      data-not-read-group=""
    >
      <LaneGroup
        lane={{
          lane: units[0]?.lane ?? "human-suggested",
          label: NOT_READ_LABEL,
          count: units.length,
          units: [...units],
        }}
        groupKey="not-read"
        glyph={<NotReadGlyph />}
        current={current}
        selected={selected}
        pending={pending}
        onOpen={onOpen}
        linked={linked}
        linkedCount={units.filter((unit) => linked.has(unit.id)).length}
        open={open}
        onToggle={() => setToggled(!open)}
      />
    </section>
  )
}

/**
 * A lane decided by agents and tools: the group row expands in place to
 * list its units with their result (Lanes.dc.html); a unit navigates to its
 * desk. Shared-marker links tone-shift the group (and the linked unit).
 * The list is a list of N items to assistive tech; Tab moves through its rows
 * and the browser keeps the focused row in view inside the bounded list. The
 * header sticks to the rail's top edge (-top-4 cancels the rail's top
 * padding, which sticky offsets count from) when the rail itself scrolls.
 */
function LaneGroup({
  lane,
  current,
  selected,
  pending,
  onOpen,
  linked,
  linkedCount,
  open: openProp,
  onToggle,
  result,
  notes,
  groupKey,
  glyph,
}: {
  lane: Omit<ElsewhereLane, "lane"> & { lane: ReviewLane }
  current: string
  /** The unit shown as selected: the one being opened, else the current. */
  selected: string
  pending: string | null
  onOpen: (unitId: string) => (event: React.MouseEvent) => void
  linked: ReadonlySet<string>
  linkedCount: number
  /** Open state kept by the caller (the "Decided" group); else the lanes' own. */
  open?: boolean
  onToggle?: () => void
  /** A row's result in place of the lane unit's own (the carried mark). */
  result?: (unit: LaneUnit) => React.ReactNode
  /** A row's tooltip notes (a "Decided" row's review). */
  notes?: (unit: LaneUnit) => ReadonlyArray<string> | undefined
  /** The group's own key when it is not a lane's (the "Not read" group). */
  groupKey?: string
  /** The group's glyph in place of the lane's. */
  glyph?: React.ReactNode
}) {
  const openLanes = useAtomValue(openLanesAtom)
  const toggleLane = useSetAtom(toggleLaneAtom)
  const sheet = useAtomValue(laneSheetAtom)
  const setSheet = useSetAtom(laneSheetAtom)
  const reduce = useReducedMotion()
  const open = openProp ?? openLanes.includes(lane.lane)
  const toggle = onToggle ?? (() => toggleLane(lane.lane))
  const key = groupKey ?? lane.lane
  const listId = `lane-${key}`
  const units = lane.units ?? []
  const shrinks = units.length >= LANE_SHRINK_FROM
  // One batch's lane: its first unit's ID tells batches apart.
  const scrollKey = `${key}:${units[0]?.id ?? ""}`
  const range = laneWindow(
    units.length,
    units.findIndex((unit) => unit.id === current)
  )

  const row = (unit: LaneUnit, index: number, inSheet = false) => (
    <LaneUnitRow
      key={unit.id}
      unit={unit}
      lane={lane.lane}
      here={unit.id === current}
      selected={unit.id === selected}
      busy={unit.id === pending}
      isLinked={linked.has(unit.id)}
      tooltip={!inSheet}
      {...(result ? { result: result(unit) } : {})}
      {...(notes ? { notes: notes(unit) } : {})}
      onOpen={(event) => {
        onOpen(unit.id)(event)
        // A row in the sheet opens its unit: the sheet makes way.
        if (inSheet && isPlainClick(event))
          event.currentTarget.closest("dialog")?.close()
      }}
      // Below 861px only the window shows in the rail; the sheet lists all.
      className={
        !inSheet && range && (index < range.start || index >= range.end)
          ? "stacked:hidden"
          : undefined
      }
    />
  )

  return (
    <div
      className={cn(
        "flex flex-col gap-px",
        // Room for the header and the list's least height (8.5rem).
        open && shrinks && "shell:min-h-[11rem]"
      )}
    >
      <button
        type="button"
        aria-expanded={units.length > 0 ? open : undefined}
        aria-controls={units.length > 0 ? listId : undefined}
        onClick={() => units.length > 0 && toggle()}
        data-linked={linkedCount > 0 ? "" : undefined}
        className={cn(
          TONE_ROW,
          "grid shrink-0 grid-cols-[14px_minmax(0,1fr)_auto_14px] items-center gap-x-2.5 px-2.5 py-[9px] shell:sticky shell:-top-4 shell:z-1",
          lane.note ? "gap-y-0.5" : "gap-y-2.5",
          linkedCount > 0 ? "bg-sug-tint hover:bg-sug-tint" : "bg-paper"
        )}
      >
        {glyph ?? <LaneGlyph lane={lane.lane} />}
        <span className="text-[13px]">{lane.label}</span>
        {/* The dots sit out of flow to the count's left, so the count never
        slides when a shared marker is pointed at. */}
        <span className="relative inline-flex items-center">
          {linkedCount > 0 && (
            <span className="absolute top-1/2 right-full mr-1.5 flex -translate-y-1/2">
              <LinkDots
                count={linkedCount}
                label={`${linkedCount} ${lane.label.toLowerCase()} unit${linkedCount > 1 ? "s" : ""} share the open context`}
              />
            </span>
          )}
          <span className="font-mono text-[11px] text-ink-muted">
            {lane.count}
          </span>
        </span>
        <ChevronDownIcon
          aria-hidden="true"
          className={cn(
            "size-[13px] text-faint transition-transform duration-chevron ease-standard motion-reduce:transition-none",
            open && "rotate-180",
            units.length === 0 && "invisible"
          )}
        />
        {lane.note && (
          <>
            <span />
            <span className="col-span-3 text-[11.5px] text-ink-muted">
              {lane.note}
            </span>
          </>
        )}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="units"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: REDUCED_TRANSITION }}
            transition={reduce ? REDUCED_TRANSITION : RAIL.lane}
            className={cn("flex flex-col gap-px", shrinks && "shell:min-h-0")}
          >
            <div
              id={listId}
              role="list"
              aria-label={`${lane.label} units`}
              data-lane-scroll={scrollKey}
              ref={settleLaneScroll}
              onScroll={(event) =>
                laneScroll.set(scrollKey, event.currentTarget.scrollTop)
              }
              className={cn(
                // The 4px inset keeps focus rings inside the scroll box.
                "relative flex flex-col gap-px shell:-mx-1 shell:scroll-py-1 shell:overflow-y-auto shell:p-1",
                shrinks
                  ? // A hairline ends the bounded list above the next header.
                    "shell:min-h-[8.5rem] shell:shrink shell:border-b shell:border-line"
                  : "shrink-0"
              )}
            >
              {units.map((unit, index) => row(unit, index))}
            </div>
            {range && (
              <button
                type="button"
                aria-haspopup="dialog"
                onClick={() => setSheet(key)}
                className={cn(
                  TONE_ROW,
                  "w-full bg-transparent py-[7px] pr-2.5 pl-[34px] text-[12px] text-ink-2 hover:text-ink shell:hidden"
                )}
              >
                Show all {units.length} units
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
      {sheet === key && (
        <dialog
          ref={showModal}
          aria-labelledby={`${listId}-sheet`}
          onClose={() => setSheet(null)}
          // Light dismiss: a press on the scrim (the dialog box itself).
          onClick={(event) => {
            if (event.target === event.currentTarget)
              event.currentTarget.close()
          }}
          className="mx-0 mt-auto mb-0 max-h-[85svh] w-full max-w-full rounded-t-2xl border-0 bg-paper p-0 text-ink backdrop:bg-scrim"
        >
          <motion.div
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={reduce ? REDUCED_TRANSITION : RAIL.lane}
            className="flex max-h-[85svh] flex-col"
          >
            <div className="flex shrink-0 items-center gap-2.5 px-4 pt-4 pb-2">
              {glyph ?? <LaneGlyph lane={lane.lane} />}
              <h2 id={`${listId}-sheet`} className="m-0 text-sm font-semibold">
                {lane.label}
              </h2>
              <span className="font-mono text-[11px] text-ink-muted">
                {lane.count}
              </span>
              <button
                type="button"
                aria-label="Close"
                onClick={(event) =>
                  event.currentTarget.closest("dialog")?.close()
                }
                className="ml-auto inline-flex size-9 items-center justify-center rounded-lg border-0 bg-transparent text-ink-muted transition-colors duration-surface-tone ease-standard hover:bg-raised hover:text-ink motion-reduce:transition-none"
              >
                <XIcon aria-hidden="true" className="size-4" />
              </button>
            </div>
            <div
              role="list"
              aria-label={`${lane.label} units`}
              data-lane-scroll=""
              className="relative flex flex-col gap-px overflow-y-auto overscroll-contain px-2 pt-1 pb-4"
            >
              {units.map((unit, index) => row(unit, index, true))}
            </div>
          </motion.div>
        </dialog>
      )}
    </div>
  )
}

/**
 * One unit in a lane group. A written title reads as one line. A unit with
 * no written title (`untitled`, set by the projection) reads as its file's
 * name, then the lines it owns there, with the folder quiet below, its end
 * kept ("…/batch-overview"); its title stays the accessible name and is the
 * tooltip. A unit whose lane rose since the last run shows the raised mark
 * after its name, and its words in the tooltip.
 */
function LaneUnitRow({
  unit,
  lane,
  here,
  selected,
  busy,
  isLinked,
  onOpen,
  tooltip,
  className,
  result: resultOverride,
  notes,
}: {
  unit: LaneUnit
  lane: ReviewLane
  /** The desk's own unit (aria-current). */
  here: boolean
  /** Shown as selected: the unit being opened, else the current one. */
  selected: boolean
  busy: boolean
  isLinked: boolean
  onOpen: (event: React.MouseEvent<HTMLAnchorElement>) => void
  /** Off in the sheet: a tooltip would open beneath the modal layer. */
  tooltip: boolean
  className?: string
  /** What the row shows in place of its result (the carried mark). */
  result?: React.ReactNode
  /** Tooltip notes after the title (a "Decided" row's review). */
  notes?: ReadonlyArray<string> | undefined
}) {
  const path = untitledName(unit.untitled)
  // A group that names no lane: the title's left-out lane words follow it.
  const spoken = unit.laneWords
    ? `${unit.title} (${unit.laneWords})`
    : unit.title
  const excluded = unit.excluded ? excludedWords(unit.excluded) : undefined
  // A person's decision on the row, and a file no agent read, say their
  // words in the row's tooltip as a "Decided" row does.
  const rowNotes =
    notes ??
    (unit.personReview
      ? [
          reviewWords(unit.personReview),
          ...(unit.personReview.carried ? [unit.personReview.carried] : []),
        ]
      : excluded
        ? [excluded.state, excluded.rule]
        : undefined)
  const result = (
    <span className="flex shrink-0 items-center gap-1.5">
      {/* The agent's review as the 16px mark (avatar + verdict icon; the
      words stay for screen readers). The verdict is said in words only in
      the unit's review card. A person's that stands takes its place. */}
      {resultOverride !== undefined ? (
        resultOverride
      ) : unit.personReview ? (
        <CarriedMark review={unit.personReview} />
      ) : excluded && !unit.review ? (
        <span className="font-mono text-[10.5px] text-ink-muted">
          {excluded.state}
          <span className="sr-only">. {excluded.rule}</span>
        </span>
      ) : unit.review ? (
        <ReviewMark
          compact
          size={16}
          verdict={unit.review.verdict}
          actor={{ kind: "agent", agent: unit.review.reviewer }}
        />
      ) : (
        <span
          className={cn(
            "font-mono text-[10.5px]",
            unit.tone === "req" ? "text-req-fg" : "text-ink-muted"
          )}
        >
          {unit.result}
        </span>
      )}
    </span>
  )
  const link = (
    <NeuveLink
      destination={{ to: "unit", unitId: unit.id }}
      data-unit-id={unit.id}
      aria-current={here ? "page" : undefined}
      aria-busy={busy || undefined}
      onClick={onOpen}
      data-linked={isLinked ? "" : undefined}
      className={cn(
        TONE_ROW,
        "relative w-full py-[7px] pr-2.5 pl-[34px] text-[13px] text-ink hover:text-ink",
        path
          ? "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-px"
          : "flex items-center justify-between gap-2",
        // One weight in every state: the selection is the tone, and the
        // line text beside the name never slides.
        selected
          ? "bg-select hover:bg-select"
          : isLinked
            ? "bg-sug-tint hover:bg-sug-tint"
            : "bg-transparent"
      )}
    >
      {/* The spinner, or else the link glyph, sits in the row's left
      gutter, out of flow: neither one narrows the title or moves the
      result. */}
      {(busy || isLinked) && (
        <span
          className={cn(
            "absolute left-3.5 flex -translate-y-1/2",
            path ? "top-[15px]" : "top-1/2"
          )}
        >
          {busy ? (
            <LaneSpinner lane={lane} />
          ) : (
            <LinkMark label="Shares the open context" />
          )}
        </span>
      )}
      {path ? (
        <>
          <UntitledName
            title={spoken}
            name={path}
            raisedFrom={unit.raisedFrom}
            nameClassName="col-span-2"
          />
          {result}
        </>
      ) : (
        <>
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate">
              {unit.title}
              {unit.laneWords && (
                <span className="sr-only">{` (${unit.laneWords})`}</span>
              )}
            </span>
            {unit.raisedFrom && <MovedUpMark from={unit.raisedFrom} />}
          </span>
          {result}
        </>
      )}
    </NeuveLink>
  )
  return (
    <div
      role="listitem"
      ref={here ? keepInView : undefined}
      className={className}
    >
      {tooltip ? (
        <RowTip
          title={unit.title}
          untitled={path !== null}
          raisedFrom={unit.raisedFrom}
          {...(rowNotes ? { notes: rowNotes } : {})}
        >
          {link}
        </RowTip>
      ) : (
        link
      )}
    </div>
  )
}

function splitPath(path: string) {
  const cut = path.lastIndexOf("/") + 1
  return { dir: path.slice(0, cut), base: path.slice(cut) }
}

/**
 * Files tab (Sticky.dc.html): the unit's files in diff order. The file under
 * the sticky header is current (tone shift + aria-current); viewed files show
 * a check and step back in ink. A row lands its file below the sticky header
 * (and expands it) through the shared landing contract.
 */
function FilesList({ data }: { data: ReviewDeskData }) {
  const current = useAtomValue(currentFileAtom)
  const viewed = useViewedFiles()
  const landOn = useSetAtom(landOnAtom)
  if (data.files.length === 0)
    return (
      <p className="m-0 px-2.5 text-[13px] text-ink-muted">
        No files in this unit.
      </p>
    )
  return (
    <section aria-label="Files in this unit" className="flex flex-col gap-0.5">
      <span className="px-2.5 pb-1.5 label-mono">In this unit</span>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {data.files.map((file) => {
          const { dir, base } = splitPath(file.path)
          const isCurrent = file.path === current
          const isViewed =
            viewed[viewedKey(data.unit.id, data.revision, file.path)] === true
          return (
            <li key={file.path}>
              <button
                type="button"
                aria-current={isCurrent ? "true" : undefined}
                title={file.path}
                onClick={() =>
                  landOn({ unitId: data.unit.id, filePath: file.path })
                }
                className={cn(
                  TONE_ROW,
                  "grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 px-2.5 py-2 text-ink",
                  isCurrent ? "bg-select hover:bg-select" : "bg-transparent"
                )}
              >
                <span
                  className={cn(
                    "truncate font-mono text-[12.5px]",
                    isViewed ? "text-ink-muted" : "text-ink"
                  )}
                >
                  {base}
                </span>
                <span className="inline-flex items-center gap-1.5 font-mono text-[11px]">
                  {isViewed && (
                    <CheckIcon
                      role="img"
                      aria-label="Viewed"
                      strokeWidth={2.25}
                      className="size-[13px] text-agt"
                    />
                  )}
                  <span className="text-add-fg">
                    <span className="sr-only">Added </span>+{file.additions}
                  </span>
                  <span className="text-del-fg">
                    <span className="sr-only">Removed </span>−{file.deletions}
                  </span>
                </span>
                {dir && (
                  <span className="col-span-2 truncate font-mono text-[11px] text-ink-muted">
                    {dir}
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

const ICON_BUTTON =
  "relative inline-flex size-9 items-center justify-center rounded-[9px] border-0 text-ink-muted no-underline transition-colors duration-rail-tone ease-standard hover:bg-raised hover:text-ink motion-reduce:transition-none"

function IconTip({
  label,
  children,
}: {
  label: string
  children: React.ReactElement
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )
}

/**
 * The 60px icon column: identical 36px buttons — expand, back, divider,
 * the units to decide as their lane glyph (selected = tone shift), divider,
 * the lane groups as glyph + a small count badge. No loose text; names are
 * tooltips.
 */
function CollapsedRail({
  data,
  markers,
}: {
  data: ReviewDeskData
  markers: Record<string, ContextualMarker>
}) {
  const toggle = useSetAtom(toggleRailAtom)
  const openLanes = useAtomValue(openLanesAtom)
  const toggleLane = useSetAtom(toggleLaneAtom)
  const linked = useLinkedUnits(markers)
  const unitSwitch = useUnitSwitch(data.unit.id)
  // A lane glyph expands the rail with that lane's units listed.
  const openLaneFromIcon = (lane: ElsewhereLane["lane"]) => {
    if (!openLanes.includes(lane)) toggleLane(lane)
    toggle()
  }
  const laneOf = new Map(data.batchUnits.map((unit) => [unit.id, unit.lane]))
  const elsewhere = agentLanes(data)
  return (
    <div className="flex flex-col items-center gap-1">
      <IconTip label="Expand sidebar · [">
        <button
          type="button"
          aria-label="Expand sidebar"
          aria-keyshortcuts="["
          onClick={toggle}
          className={cn(ICON_BUTTON, "bg-transparent")}
        >
          <PanelLeftOpenIcon aria-hidden="true" className="size-4" />
        </button>
      </IconTip>
      <IconTip label="Batch overview">
        <NeuveLink
          destination={batchOverview(data.batches)}
          aria-label="Batch overview"
          className={cn(ICON_BUTTON, "bg-transparent")}
        >
          <ArrowLeftIcon aria-hidden="true" className="size-4" />
        </NeuveLink>
      </IconTip>
      {/* Each group's hairline only above a group that is drawn. */}
      {data.railUnits.length > 0 && (
        <span aria-hidden="true" className="my-1.5 h-px w-5 bg-line" />
      )}
      {data.railUnits.map((unit) => {
        const current = unit.id === unitSwitch.selected
        const busy = unit.id === unitSwitch.pending
        const isLinked = linked.has(unit.id)
        const label = [
          unit.title,
          laneTitle("human-required"),
          unit.raisedFrom && movedUpLabel(unit.raisedFrom),
        ]
          .filter(Boolean)
          .join(" · ")
        return (
          <IconTip key={unit.id} label={label}>
            <NeuveLink
              destination={{ to: "unit", unitId: unit.id }}
              aria-label={label}
              aria-current={unit.id === data.unit.id ? "page" : undefined}
              aria-busy={busy || undefined}
              onClick={unitSwitch.open(unit.id)}
              data-linked={isLinked ? "" : undefined}
              className={cn(
                ICON_BUTTON,
                current
                  ? "bg-select hover:bg-select"
                  : isLinked
                    ? "bg-sug-tint hover:bg-sug-tint"
                    : "bg-transparent"
              )}
            >
              {busy ? (
                <LaneSpinner lane="human-required" className="size-[11px]" />
              ) : (
                <LaneGlyph
                  lane="human-required"
                  outline={!current}
                  className="size-[11px]"
                />
              )}
            </NeuveLink>
          </IconTip>
        )
      })}
      {data.carriedUnits && data.carriedUnits.length > 0 && (
        // A group of its own, as in the expanded rail: set apart from the
        // units that need a decision.
        <span aria-hidden="true" className="my-1.5 h-px w-5 bg-line" />
      )}
      {data.carriedUnits && data.carriedUnits.length > 0 && (
        <CollapsedGroup
          name="Decided"
          glyph={<LaneGlyph lane="human-required" className="size-[11px]" />}
          openAtom={decidedGroupAtom}
          count={data.carriedUnits.length}
          linked={data.carriedUnits.some((unit) => linked.has(unit.id))}
          holdsOpenUnit={data.carriedUnits.some(
            (unit) => unit.id === data.unit.id
          )}
          onOpen={toggle}
        />
      )}
      {elsewhere.length > 0 && (
        <span aria-hidden="true" className="my-1.5 h-px w-5 bg-line" />
      )}
      {elsewhere.map((lane) => {
        const label = `${lane.label} · ${lane.count} ${lane.count === 1 ? "unit" : "units"}`
        const count = [...linked].filter(
          (id) => laneOf.get(id) === lane.lane
        ).length
        return (
          <IconTip key={lane.lane} label={label}>
            <button
              type="button"
              aria-label={label}
              onClick={() => openLaneFromIcon(lane.lane)}
              data-linked={count > 0 ? "" : undefined}
              className={cn(
                ICON_BUTTON,
                count > 0 ? "bg-sug-tint hover:bg-sug-tint" : "bg-transparent"
              )}
            >
              <LaneGlyph lane={lane.lane} className="size-[11px]" />
              <span
                aria-hidden="true"
                className="absolute -top-[3px] -right-[5px] box-border h-4 min-w-4 rounded-lg bg-raised-2 px-1 text-center font-mono text-[9.5px] leading-4 text-ink-2 shadow-[0_0_0_2px_var(--nv-bg)]"
              >
                {lane.count}
              </span>
            </button>
          </IconTip>
        )
      })}
      {data.notReadUnits && data.notReadUnits.length > 0 && (
        <span aria-hidden="true" className="my-1.5 h-px w-5 bg-line" />
      )}
      {data.notReadUnits && data.notReadUnits.length > 0 && (
        <CollapsedGroup
          name={NOT_READ_LABEL}
          glyph={<NotReadGlyph />}
          openAtom={notReadGroupAtom}
          count={data.notReadUnits.length}
          linked={data.notReadUnits.some((unit) => linked.has(unit.id))}
          holdsOpenUnit={data.notReadUnits.some(
            (unit) => unit.id === data.unit.id
          )}
          onOpen={toggle}
        />
      )}
    </div>
  )
}

/**
 * A group of its own in the icon column ("Decided", "Not read"): its glyph
 * and count, as a lane group's; it expands the rail with the group open.
 */
function CollapsedGroup({
  name,
  glyph,
  openAtom,
  count,
  linked,
  holdsOpenUnit,
  onOpen,
}: {
  name: string
  glyph: React.ReactNode
  /** The group's open state in the expanded rail. */
  openAtom: typeof decidedGroupAtom
  count: number
  linked: boolean
  /** The open unit is one of the group's: selected, as a unit's icon is. */
  holdsOpenUnit: boolean
  onOpen: () => void
}) {
  const setToggled = useSetAtom(openAtom)
  const label = `${name} · ${count} ${count === 1 ? "unit" : "units"}`
  return (
    <IconTip label={label}>
      <button
        type="button"
        aria-label={label}
        onClick={() => {
          setToggled(true)
          onOpen()
        }}
        data-linked={linked ? "" : undefined}
        className={cn(
          ICON_BUTTON,
          holdsOpenUnit
            ? "bg-select hover:bg-select"
            : linked
              ? "bg-sug-tint hover:bg-sug-tint"
              : "bg-transparent"
        )}
      >
        {glyph}
        <span
          aria-hidden="true"
          className="absolute -top-[3px] -right-[5px] box-border h-4 min-w-4 rounded-lg bg-raised-2 px-1 text-center font-mono text-[9.5px] leading-4 text-ink-2 shadow-[0_0_0_2px_var(--nv-bg)]"
        >
          {count}
        </span>
      </button>
    </IconTip>
  )
}

/**
 * Left rail: back to the batch overview, the units that need a decision
 * (current one selected by tone, never by an edge bar) with the human-gate
 * meter, and the lanes decided by agents and tools. Collapses to a 60px icon
 * column, remembered per viewer.
 */
export function UnitRail({
  data,
  markers = data.markers,
}: {
  data: ReviewDeskData
  /** Every marker of the unit (retrieved + review comments). */
  markers?: Record<string, ContextualMarker>
}) {
  const collapsed = useRailCollapsed()
  const reduce = useReducedMotion()
  return (
    <TooltipProvider delayDuration={300}>
      <nav
        aria-label="Review units"
        data-collapsed={collapsed ? "" : undefined}
        {...railTransition}
        className={cn(
          "relative box-border flex max-w-full flex-col gap-6 border-r border-line shell:overflow-y-auto",
          collapsed
            ? "flex-[0_0_60px] px-0 py-4"
            : "flex-[1_1_272px] pt-4 pr-3 pb-5 pl-4"
        )}
      >
        <AnimatePresence initial={false}>
          <motion.div
            key={collapsed ? "collapsed" : "expanded"}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={reduce ? REDUCED_TRANSITION : RAIL.swap}
            className="flex flex-col gap-6 shell:min-h-0 shell:flex-auto"
          >
            {collapsed ? (
              <CollapsedRail data={data} markers={markers} />
            ) : (
              <ExpandedRail data={data} markers={markers} />
            )}
          </motion.div>
        </AnimatePresence>
      </nav>
    </TooltipProvider>
  )
}
