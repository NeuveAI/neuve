import * as React from "react"
import { Provider, useAtomValue, useSetAtom, useStore } from "jotai"
import { useHydrateAtoms } from "jotai/utils"
import { MotionConfig } from "motion/react"
import {
  CheckCheckIcon,
  Columns2Icon,
  Rows2Icon,
  WrapTextIcon,
} from "lucide-react"
import { Virtualizer } from "@workspace/diffs"

import { Toggle } from "@workspace/ui/components/toggle"
import { cn } from "@workspace/ui/lib/utils"
import {
  agentsHydration,
  agentRegistryAtom,
  agentConnectionsAtom,
  agentConnectorAtom,
} from "@workspace/ui/neuve/agents/atoms"
import type { AgentConnector } from "@workspace/ui/neuve/agents/atoms"
import { NewCommitNotice } from "@workspace/ui/neuve/cycle/new-commit-notice"
import { Briefing } from "@workspace/ui/neuve/review-desk/briefing"
import { DecisionDock } from "@workspace/ui/neuve/review-desk/decision-dock"
import { DiffFileCard } from "@workspace/ui/neuve/review-desk/diff-file"
import {
  DeliveryDiff,
  DeliveryDockGlyph,
  DeliveryLayers,
  DeliveryTitleGlyph,
  STAGE,
  guidedCheck,
} from "@workspace/ui/neuve/review-desk/delivery/delivery-layers"
import {
  deliveryMoveAtom,
  useDeliveryStop,
} from "@workspace/ui/neuve/review-desk/delivery/delivery-state"
import { DeliveryInstantContext } from "@workspace/ui/neuve/review-desk/delivery/delivery-motion"
import { DeliveryStack } from "@workspace/ui/neuve/review-desk/delivery/phased-layer"
import { flowSourceMarkers } from "@workspace/ui/neuve/review-desk/delivery/flow-card"
import {
  DeskFeedbackContext,
  FeedbackSinkContext,
} from "@workspace/ui/neuve/review-desk/feedback/atoms"
import type { FeedbackSink } from "@workspace/ui/neuve/review-desk/feedback/atoms"
import { DigestFeedback } from "@workspace/ui/neuve/review-desk/feedback/feedback-controls"
import { GeneratedDiff } from "@workspace/ui/neuve/review-desk/generated-diff"
import { ReadOnlyNeighbor } from "@workspace/ui/neuve/review-desk/read-only-neighbor"
import {
  SOURCE_SHEET_ATTRIBUTE,
  notePressOutside,
} from "@workspace/ui/neuve/review-desk/floating"
import { SourceSheet } from "@workspace/ui/neuve/review-desk/source-sheet"
import {
  HostPendingUnitContext,
  UnitRail,
  switchingTo,
} from "@workspace/ui/neuve/review-desk/unit-rail"
import {
  useViewedFiles,
  viewedKey,
} from "@workspace/ui/neuve/review-desk/landing"
import { AppHeader } from "@workspace/ui/neuve/shared/app-header"
import { batchOverview } from "@workspace/ui/neuve/shared/batch-menu"
import { unitDeliveryOverrideAtom } from "@workspace/ui/neuve/shared/delivery"
import {
  explainedShows,
  rowExplained,
} from "@workspace/ui/neuve/shared/explained-rule"
import type {
  DeliveryStop,
  DeliverySuggestion,
} from "@workspace/ui/neuve/shared/delivery"
import { regionTransition } from "@workspace/ui/neuve/shared/view-transitions"
import { Segmented } from "@workspace/ui/neuve/shared/segmented"
import { Button } from "@workspace/ui/components/button"
import {
  approveAtom,
  currentResponsibilityAtom,
  unitFeedbackKindAtom,
  decisionSinkAtom,
  commentSinkAtom,
  undoSinkAtom,
  decisionReceiptAtom,
  decisionPendingAtom,
  decisionErrorAtom,
  clearSelectionAtom,
  closeExpandedAtom,
  diffLayoutAtom,
  draftAtom,
  effectiveLayoutAtom,
  SPLIT_MIN_WIDTH,
  splitFitsAtom,
  escapeComposerAtom,
  lineSelectionAtom,
  commentRepositoryHydration,
  composerAtom,
  diffVirtualizerAtom,
  dismissAllAtom,
  openBodiesAtom,
  dockAtom,
  isolatingAtom,
  openMarkerAtom,
  pendingUnitAtom,
  railHydration,
  reopenAllAtom,
  reviewDeskHydration,
  sendChangesAtom,
  sendSuggestionAtom,
  sendUnitCommentAtom,
  sheetMarkerAtom,
  showResolvedAtom,
  startChangesAtom,
  toggleRailAtom,
  wrapAtom,
} from "@workspace/ui/neuve/review-desk/atoms"
import type {
  ReviewDeskState,
  DecisionSink,
  CommentSink,
  UndoSink,
  DecisionReceipt,
} from "@workspace/ui/neuve/review-desk/atoms"
import { commentMarkersForUnit } from "@workspace/ui/neuve/review-comments/markers"
import {
  reviewCommentRepositoryAtom,
  useReviewCommentRecords,
} from "@workspace/ui/neuve/review-comments/repository"
import type { ReviewCommentRepository } from "@workspace/ui/neuve/review-comments/repository"
import type { ReviewCommentRecord } from "@workspace/ui/neuve/review-comments/record"
import type { ThreadEventSource } from "@workspace/ui/neuve/review-comments/thread"
import {
  applyThreadEventAtom,
  reviewThreadsAtom,
  threadEventSourceAtom,
  threadsHydration,
} from "@workspace/ui/neuve/review-comments/threads"
import type {
  ContextualMarker,
  DiffFile,
  MarkerCheckAction,
  ReviewDeskData,
  ReviewLane,
  UnitHistoryLoader,
} from "@workspace/ui/neuve/types"

export interface ReviewDeskScreenProps {
  data: ReviewDeskData
  decisionSink?: DecisionSink
  commentSink?: CommentSink
  undoSink?: UndoSink
  decisionReceipt?: DecisionReceipt | null
  /** Seed interaction state (stories, deep links). Defaults to rest. */
  initialState?: Partial<ReviewDeskState>
  /**
   * Where inline review comments are stored. Defaults to the browser-local
   * repository; stories pass a memory or story-scoped one.
   */
  commentRepository?: ReviewCommentRepository
  /**
   * The relay comment threads listen to (ACP through the harness later; a
   * scripted mock in stories). Without one, threads show what they hold.
   */
  threadEvents?: ThreadEventSource
  /** Connects agents from the header (a local mock by default). */
  agentConnector?: AgentConnector
  historyLoader?: UnitHistoryLoader
  /**
   * The unit the host router is navigating to (null when no navigation is
   * pending). The switching state is derived from it (review N1). Omitted by
   * hosts without a router (stories): the rail's click then drives it.
   */
  pendingUnitId?: string | null
  /**
   * Seeds the reader's review-delivery stop for this unit (stories, deep
   * links). Applies only when the data carries a delivery payload.
   */
  initialDeliveryStop?: DeliveryStop
  /**
   * Records the reader's feedback (10.100). With the data's `feedback`, the
   * controls show once the feedback setting is on.
   */
  feedbackSink?: FeedbackSink
}

/** True while typing, so single-key shortcuts ("[") stay out of the way. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  )
}

/**
 * Desk shortcuts: ⌘↵ / Ctrl↵ decides (human-required) or sends the open
 * composer; Escape closes one layer; "[" collapses or expands the rail.
 */
function useDeskShortcuts(
  lane: ReviewLane | undefined,
  /** Guided on a human-required unit: ⌘↵ sends the suggested disposition. */
  suggestion: DeliverySuggestion | undefined
) {
  const store = useStore()
  // Effect: subscribes to document keyboard events (an external system), per "You Might Not Need an Effect".
  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.key === "[" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !isTyping(event.target)
      ) {
        event.preventDefault()
        store.set(toggleRailAtom)
        return
      }
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        // A held ⌘↵ repeats: only the press decides, never its autorepeat.
        if (event.repeat) return
        // A form (feedback, a thread reply) owns ⌘↵ inside it: it saves
        // that form and never decides the unit. Feedback's layers (their
        // header and Close too) and their triggers are fenced whole, so a
        // second ⌘↵ after a save, which lands on the trigger, decides
        // nothing either.
        if (
          event.target instanceof Element &&
          event.target.closest(
            "form, [data-feedback], [data-feedback-layer], [data-feedback-trigger]"
          )
        )
          return
        // The comment composer owns ⌘↵ (save) while it is open.
        if (store.get(composerAtom) !== null) return
        const dock = store.get(dockAtom)
        if (dock === "rest" && lane === "human-required" && suggestion) {
          event.preventDefault()
          store.set(sendSuggestionAtom, suggestion)
        } else if (dock === "rest" && lane === "human-required") {
          event.preventDefault()
          store.set(approveAtom)
        } else if (dock === "composing") {
          event.preventDefault()
          if (
            lane === "human-required" ||
            lane === "human-suggested" ||
            (lane === undefined &&
              store.get(unitFeedbackKindAtom) === "request-changes")
          ) {
            store.set(sendChangesAtom)
          } else {
            store.set(sendUnitCommentAtom)
          }
        }
        return
      }
      if (event.key !== "Escape") return
      // One layer per Escape: composer (cancel or park the draft), then an
      // open card, then the gutter selection. A press that closes one is
      // claimed, so embedded it never also hands focus back to Ace.
      if (store.get(composerAtom) !== null) {
        event.preventDefault()
        store.set(escapeComposerAtom)
      } else if (
        store.get(openMarkerAtom) !== null &&
        store.get(sheetMarkerAtom) === null
      ) {
        event.preventDefault()
        store.set(closeExpandedAtom)
      } else if (store.get(lineSelectionAtom) !== null) {
        event.preventDefault()
        store.set(clearSelectionAtom)
      }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [store, lane, suggestion])
}

/** Applies the relay's thread events, in order, while the desk is mounted. */
function useThreadEvents(source: ThreadEventSource | undefined) {
  const apply = useSetAtom(applyThreadEventAtom)
  // Effect: subscribes to the thread relay (an external event stream: ACP through the harness, or a story's mock).
  React.useEffect(() => {
    if (!source) return
    return source.subscribe((event) => apply(event))
  }, [source, apply])
}

/**
 * What a press closes the expanded layer for and then reaches, in one step:
 * a briefing phrase or citation chip (round 5b), the title's delivery
 * glyph, which then opens its dial (round 6), the dock's delivery glyph
 * (round 7), and the dock's controls (its steps).
 */
const PASS_THROUGH =
  "[data-briefing-link], [data-delivery-trigger], [data-delivery-dock-trigger], [data-dock-step]"

/** Where a press does not close the expanded layer: the layer itself. */
const INSIDE_EXPANDED = [
  "[data-floating-card]",
  `[${SOURCE_SHEET_ATTRIBUTE}]`,
  // The file being commented on stays live while composing (diff-file.tsx).
  "[data-composing]",
  // A popper opened from the card (a menu, a tooltip) belongs to it.
  "[data-radix-popper-content-wrapper]",
].join(",")

/**
 * The one expanded layer (an L2 card or the comment composer) closes on a
 * press outside it. A document-level listener, not a click catcher over the
 * desk, so hover keeps working underneath: phrases and chips light their
 * lines while a card is open (round 5b).
 *
 * - A press on a briefing phrase or citation chip closes the layer and the
 *   reference follows on its own click, in one step (round 5b, option B);
 *   so does a press on the title's delivery glyph, which opens its dial.
 * - Any other outside press only closes it: the press and its click never
 *   reach what is underneath.
 * - Touch and pen close on the tap rather than the press, so a scroll
 *   gesture over the desk keeps the card open.
 * - Escape and focus return are unchanged; after a pointer close, focus
 *   stays where the press put it (floating.tsx).
 */
function OutsidePressDismiss() {
  const isolating = useAtomValue(isolatingAtom)
  const closeExpanded = useSetAtom(closeExpandedAtom)
  const store = useStore()
  // Effect: listens to presses on the window (an external event source) while a layer is expanded, to close it on an outside press.
  React.useEffect(() => {
    if (!isolating) return
    // The whole composed path: a press inside the diff's shadow root (the
    // composing file's gutter) is inside its host's file card.
    const inPath = (event: Event, selector: string) =>
      event
        .composedPath()
        .some((node) => node instanceof Element && node.matches(selector))
    const close = () => {
      // Only a card returns focus to its pin on close (floating.tsx); the
      // composer has no such rule, so nothing is noted for it.
      if (
        store.get(openMarkerAtom) !== null &&
        store.get(composerAtom) === null
      )
        notePressOutside()
      closeExpanded()
    }
    // The pointer that pressed last: a click that names no known pointer
    // type (a synthetic one) belongs to it.
    let pressedWith = "mouse"
    const POINTERS = ["mouse", "touch", "pen"]
    const onPointerDown = (event: PointerEvent) => {
      pressedWith = event.pointerType
      if (event.button !== 0 || inPath(event, INSIDE_EXPANDED)) return
      const reference = inPath(event, PASS_THROUGH)
      // Touch and pen close on the tap (the click), so a scroll that starts
      // over the desk leaves the card open; nothing underneath reacts to the
      // touch meanwhile, and the native scroll still runs.
      if (event.pointerType === "touch" || event.pointerType === "pen") {
        if (!reference) event.stopPropagation()
        return
      }
      close()
      if (reference) return
      // Nothing underneath reacts: not this press (line selection, focus,
      // text selection) and not the click that follows it.
      event.preventDefault()
      event.stopPropagation()
      swallowNextClick()
    }
    const onTap = (event: MouseEvent) => {
      const own = (event as Partial<PointerEvent>).pointerType
      const type = own && POINTERS.includes(own) ? own : pressedWith
      if (type !== "touch" && type !== "pen") return
      if (inPath(event, INSIDE_EXPANDED)) return
      close()
      if (inPath(event, PASS_THROUGH)) return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener("pointerdown", onPointerDown, true)
    window.addEventListener("click", onTap, true)
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true)
      window.removeEventListener("click", onTap, true)
    }
  }, [isolating, closeExpanded, store])
  return null
}

/**
 * Swallows the click that ends a press which only closed the layer. Its own
 * listener (the layer is gone by the time the click arrives), dropped at
 * the next press if no click came.
 */
function swallowNextClick() {
  const swallow = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    done()
  }
  const done = () => {
    window.removeEventListener("click", swallow, true)
    window.removeEventListener("pointerdown", done, true)
  }
  window.addEventListener("click", swallow, true)
  // A press that ends elsewhere sends no click: the next press drops it.
  setTimeout(() => window.addEventListener("pointerdown", done, true))
}

/** One unit's review comments as markers for the given files. */
function unitComments(
  records: ReadonlyArray<ReviewCommentRecord>,
  unitId: string,
  revision: string,
  files: ReadonlyArray<DiffFile>,
  showResolved: boolean
) {
  const unitRecords = records.filter((r) => r.unitId === unitId)
  const resolvedCount = unitRecords.filter(
    (r) => r.status === "resolved"
  ).length
  // Less is more: resolved comments leave the margin until asked for.
  const shown = showResolved
    ? unitRecords
    : unitRecords.filter((r) => r.status !== "resolved")
  const comments = commentMarkersForUnit(shown, unitId, revision, files)
  const byMarker: Record<string, ReviewCommentRecord> = {}
  for (const record of shown) {
    const key = Object.keys(comments.markers).find(
      (k) => comments.markers[k]?.trace?.commentId === record.id
    )
    if (key) byMarker[key] = record
  }
  return {
    markers: comments.markers,
    anchors: comments.anchors,
    records: byMarker,
    resolvedCount,
  }
}

/**
 * Records → `review comment` markers for this unit and revision, merged with
 * the retrieved markers, so every surface (margin, rail, dock attachment,
 * source sheet) sees one marker map. The read-only neighbor's comments
 * belong to its own unit and stay separate.
 */
function useUnitMarkers(data: ReviewDeskData) {
  const repository = useAtomValue(reviewCommentRepositoryAtom)
  const allRecords = useReviewCommentRecords(repository)
  const showResolved = useAtomValue(showResolvedAtom)
  return React.useMemo(() => {
    const generated = data.unit.attribution?.generatedDiff?.file
    const generatedFiles =
      data.unit.generatedDiffs?.map((value) => value.file) ?? []
    const unit = unitComments(
      allRecords,
      data.unit.id,
      data.revision,
      [...data.files, ...generatedFiles, ...(generated ? [generated] : [])],
      showResolved
    )
    const neighbor = data.neighbor
      ? unitComments(
          allRecords,
          data.neighbor.unitId,
          data.revision,
          [data.neighbor.file],
          showResolved
        )
      : undefined
    return {
      markers: { ...data.markers, ...unit.markers },
      commentAnchors: unit.anchors,
      commentRecords: unit.records,
      resolvedCount: unit.resolvedCount + (neighbor?.resolvedCount ?? 0),
      neighbor,
    }
  }, [allRecords, showResolved, data])
}

/**
 * Dismiss every open annotation at once (comment bodies and any expanded
 * layer), or reopen every review-comment body. Both labels share one grid
 * cell, so the button keeps the longer one's width and the toolbar never
 * moves when a card opens.
 */
function OverlayToggle({
  commentKeys,
}: {
  commentKeys: ReadonlyArray<string>
}) {
  const openBodies = useAtomValue(openBodiesAtom)
  const expanded = useAtomValue(isolatingAtom)
  const dismissAll = useSetAtom(dismissAllAtom)
  const reopenAll = useSetAtom(reopenAllAtom)
  const anyOpen = openBodies.length > 0 || expanded
  return (
    <Button
      type="button"
      variant="quiet"
      size="compact"
      disabled={!anyOpen && commentKeys.length === 0}
      onClick={() => (anyOpen ? dismissAll() : reopenAll(commentKeys))}
    >
      <span className="grid justify-items-center">
        <span
          className={cn("col-start-1 row-start-1", !anyOpen && "invisible")}
        >
          Dismiss all
        </span>
        <span className={cn("col-start-1 row-start-1", anyOpen && "invisible")}>
          Show comments
        </span>
      </span>
    </Button>
  )
}

/**
 * Resolved comments are hidden by default; this reveals them (muted) and
 * hides them again. Absent when the unit has none.
 */
function ResolvedToggle({ count }: { count: number }) {
  const showResolved = useAtomValue(showResolvedAtom)
  const setShowResolved = useSetAtom(showResolvedAtom)
  if (count === 0) return null
  return (
    <Button
      type="button"
      variant="quiet"
      size="compact"
      aria-pressed={showResolved}
      onClick={() => setShowResolved(!showResolved)}
    >
      <CheckCheckIcon aria-hidden="true" className="size-3.5" />
      {showResolved ? "Hide resolved" : `${count} resolved`}
    </Button>
  )
}

/**
 * The unit column's scroll container hosts the diff Virtualizer: only rows
 * near the viewport render, and the overlay layer stays aligned because it
 * lives inside each diff host and scrolls with it.
 */
export function useVirtualizerRoot() {
  const setVirtualizer = useSetAtom(diffVirtualizerAtom)
  const rootRef = React.useRef<HTMLDivElement | null>(null)
  // Effect: connects the diff Virtualizer (an external system) to the scroll root; parent effects run after children subscribe, so they see it.
  React.useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const virtualizer = new Virtualizer()
    virtualizer.setup(root)
    setVirtualizer(virtualizer)
    return () => {
      setVirtualizer("pending")
      virtualizer.cleanUp()
    }
  }, [setVirtualizer])
  return rootRef
}

/**
 * Measures the unit column (not the viewport): below SPLIT_MIN_WIDTH, Split
 * falls back to Stacked. A ref callback owns the ResizeObserver, so no
 * effect is needed.
 */
function useSplitFit() {
  const setFits = useSetAtom(splitFitsAtom)
  return React.useCallback(
    (column: HTMLElement | null) => {
      if (!column || typeof ResizeObserver === "undefined") return
      const observer = new ResizeObserver(([entry]) => {
        if (entry) setFits(entry.contentRect.width >= SPLIT_MIN_WIDTH)
      })
      observer.observe(column)
      return () => observer.disconnect()
    },
    [setFits]
  )
}

/**
 * Stacked / Split and Wrap: Pierre's own diffStyle and overflow options.
 * When the column is too narrow for Split, the toggle shows Stacked with
 * Split unavailable and says why; widening the column restores Split.
 */
function DiffToolbarControls() {
  const layout = useAtomValue(diffLayoutAtom)
  const effective = useAtomValue(effectiveLayoutAtom)
  const fits = useAtomValue(splitFitsAtom)
  const setLayout = useSetAtom(diffLayoutAtom)
  const wrap = useAtomValue(wrapAtom)
  const setWrap = useSetAtom(wrapAtom)
  const fallback = layout === "split" && effective === "stacked"
  return (
    <>
      <Segmented
        label="Diff layout"
        options={[
          { value: "stacked", label: "Stacked", icon: Rows2Icon },
          {
            value: "split",
            label: "Split",
            icon: Columns2Icon,
            disabled: !fits,
            description: fits ? undefined : "Split needs a column of 980px",
          },
        ]}
        value={effective}
        onValueChange={setLayout}
      />
      <Toggle
        pressed={wrap}
        onPressedChange={setWrap}
        aria-label="Wrap long lines"
        className="h-[30px] gap-1.5 rounded-[7px] px-2.5 text-[12.5px] font-normal text-ink-muted hover:bg-raised hover:text-ink data-[state=on]:bg-raised data-[state=on]:text-ink"
      >
        <WrapTextIcon aria-hidden="true" className="size-3.5" />
        Wrap
      </Toggle>
      {/* Always mounted, so screen readers announce the text when it fills
          in. Empty, it's taken out of the flex flow (no extra gap). */}
      <span
        role="status"
        data-split-fallback={fallback ? "" : undefined}
        className="font-mono text-[11px] text-ink-muted empty:absolute"
      >
        {fallback ? "Split shows as stacked below 980px" : null}
      </span>
    </>
  )
}

/**
 * The next unit that still needs your decision, after this one in rail
 * order (wrapping). Undefined when every other human-required unit is
 * decided, so the dock offers "Back to batch". Without recorded decisions
 * (stories, fixtures) it is simply the next unit in the rail.
 */
export function nextUndecidedUnitId(data: ReviewDeskData) {
  const units = data.railUnits
  const index = units.findIndex((unit) => unit.id === data.unit.id)
  if (data.humanDecidedUnitIds === undefined) return units[index + 1]?.id
  const decided = new Set(data.humanDecidedUnitIds)
  const after =
    index < 0 ? units : [...units.slice(index + 1), ...units.slice(0, index)]
  return after.find((unit) => unit.id !== data.unit.id && !decided.has(unit.id))
    ?.id
}

/**
 * "N/M viewed": the toolbar's only meta (round 6 trimmed the unit's stats
 * and the "Split from 980px" hint; the Split segment says why it's off).
 */
function ViewedCount({ data }: { data: ReviewDeskData }) {
  const viewed = useViewedFiles()
  const total = data.files.length
  if (total === 0) return null
  const count = data.files.filter(
    (file) => viewed[viewedKey(data.unit.id, data.revision, file.path)]
  ).length
  return (
    <span className="font-mono text-[11.5px] text-ink-muted">
      {count}/{total} viewed
    </span>
  )
}

function ReviewDesk({
  data,
  initialState = {},
  commentRepository,
  threadEvents,
  agentConnector,
  decisionSink,
  commentSink,
  undoSink,
  decisionReceipt,
  historyLoader,
  pendingUnitId,
  initialDeliveryStop,
}: ReviewDeskScreenProps) {
  // A unit outside the human-required lane opens its rail lane group.
  useHydrateAtoms(
    reviewDeskHydration({
      openLanes:
        data.unit.lane === "human-required" || data.unit.lane === undefined
          ? []
          : [data.unit.lane],
      ...initialState,
    })
  )
  useHydrateAtoms([
    [currentResponsibilityAtom, data.unit],
    [decisionSinkAtom, decisionSink],
    [commentSinkAtom, commentSink],
    [undoSinkAtom, undoSink],
    [decisionReceiptAtom, decisionReceipt ?? null],
  ] as const)
  const decisionPending = useAtomValue(decisionPendingAtom)
  const decisionError = useAtomValue(decisionErrorAtom)
  useHydrateAtoms(railHydration(initialState))
  useHydrateAtoms(commentRepositoryHydration(commentRepository))
  useHydrateAtoms(threadsHydration(data.threads, threadEvents))
  useHydrateAtoms(agentsHydration(data.agents, agentConnector))
  useHydrateAtoms([[diffVirtualizerAtom, "pending"]] as const)
  useHydrateAtoms(
    new Map(
      data.delivery && initialDeliveryStop
        ? [[unitDeliveryOverrideAtom, { [data.unit.id]: initialDeliveryStop }]]
        : []
    )
  )
  const store = useStore()
  // Effect: synchronizes external Jotai stores and the comment repository with authoritative backend snapshots.
  React.useEffect(() => {
    if (!decisionSink) return
    store.set(decisionSinkAtom, decisionSink)
    store.set(commentSinkAtom, commentSink)
    store.set(undoSinkAtom, undoSink)
    store.set(threadEventSourceAtom, threadEvents ?? null)
    store.set(agentRegistryAtom, data.agents)
    store.set(agentConnectionsAtom, data.agents.connections)
    if (agentConnector) store.set(agentConnectorAtom, agentConnector)
    const threads = Object.fromEntries(
      (data.threads ?? []).map((thread) => [thread.commentId, thread])
    )
    const previousThreads = store.get(reviewThreadsAtom)
    for (const [id, previous] of Object.entries(previousThreads)) {
      const next = threads[id]
      if (
        !next ||
        (previous.snapshotSequence !== undefined &&
          next.snapshotSequence !== undefined &&
          previous.snapshotSequence > next.snapshotSequence)
      )
        threads[id] = previous
    }
    store.set(reviewThreadsAtom, threads)
    if (commentRepository)
      store.set(
        commentRepository.replaceAtom,
        data.commentRecords ?? [],
        data.commentSnapshotSequence
      )
  }, [
    store,
    data,
    decisionSink,
    commentSink,
    undoSink,
    threadEvents,
    agentConnector,
    commentRepository,
  ])

  const responsibilityKey = JSON.stringify([
    data.unit.id,
    data.revision,
    data.unit.responsibility,
    data.unit.lane,
    data.currentDecision?.commandId,
  ])
  const lastDecision = React.useRef(responsibilityKey)
  // Effect: synchronizes the external decision and dock stores with persisted decision receipts.
  React.useEffect(() => {
    store.set(currentResponsibilityAtom, data.unit)
    if (lastDecision.current === responsibilityKey) return
    lastDecision.current = responsibilityKey
    const decision = data.currentDecision
    store.set(
      decisionReceiptAtom,
      decision ? { commandId: decision.commandId, kind: "disposition" } : null
    )
    if (decision)
      store.set(
        dockAtom,
        decision.decision === "approve" ? "approved" : "changes-requested"
      )
    else if (store.get(dockAtom) !== "composing") store.set(dockAtom, "rest")
  }, [store, data.unit, data.currentDecision, responsibilityKey])
  // Review delivery (round 4): only units whose data carries a payload.
  const delivery = useDeliveryStop(data.unit.id, data.delivery)
  const stage = delivery?.stage ?? STAGE.briefed
  const guided = delivery !== null && stage === STAGE.guided
  // What Guided takes away (the diff, the checkpoint list) goes only when
  // its check is there to take their place, so Guided never empties the
  // page, even on a payload that offers it without one.
  const guidedShowsCheck =
    guided && data.delivery !== undefined && !!guidedCheck(data.delivery)
  const suggestion =
    guided && data.delivery && data.unit.lane === "human-required"
      ? guidedCheck(data.delivery)?.suggestion
      : undefined
  useDeskShortcuts(data.unit.lane, suggestion)
  // The Explained layers on screen (as DeliveryLayers shows them), or the
  // briefing's Explained, the unit's or its changes' rows (explainedShows).
  const explainedShown =
    delivery !== null &&
    stage >= STAGE.explained &&
    (data.delivery?.flow !== undefined ||
      (stage === STAGE.explained &&
        ((data.delivery?.terms?.length ?? 0) > 0 ||
          explainedShows(
            data.delivery?.explained,
            rowExplained(data.unit.sections)
          ) !== undefined)))
  // Only the reader's own dial move animates the layers. A stop the stored
  // workspace setting resolves after mount snaps, like a first render.
  const move = useAtomValue(deliveryMoveAtom)
  const readerMoved =
    delivery !== null &&
    move?.unitId === data.unit.id &&
    move.to === delivery.stop
  useThreadEvents(threadEvents)
  const switching =
    switchingTo(pendingUnitId, useAtomValue(pendingUnitAtom), data.unit.id) !==
    null
  const scrollRoot = useVirtualizerRoot()
  const measureColumn = useSplitFit()
  const startChanges = useSetAtom(startChangesAtom)
  const setDraft = useSetAtom(draftAtom)
  const { markers, commentAnchors, commentRecords, resolvedCount, neighbor } =
    useUnitMarkers(data)
  // At Guided the flow's boxes open their lines in the source sheet.
  const sheetMarkers = React.useMemo(
    () =>
      data.delivery
        ? { ...markers, ...flowSourceMarkers(data.delivery.flow, data.files) }
        : markers,
    [markers, data.delivery, data.files]
  )
  const commentContext = React.useMemo(
    () => ({
      unitId: data.unit.id,
      revision: data.revision,
      author: data.reviewer,
      agentId: data.unit.agentId,
    }),
    [data.unit.id, data.revision, data.reviewer, data.unit.agentId]
  )
  // "Ask the implementer" / "Request a check": a change request for this
  // unit with the marker attached (it goes to the implementer).
  const onCheckAction = React.useCallback(
    (marker: ContextualMarker, action: MarkerCheckAction) => {
      startChanges(marker.key)
      if (action.kind === "request-check" && marker.check) {
        setDraft(`Please add a check: ${marker.check}`)
      }
    },
    [startChanges, setDraft]
  )
  const commentKeys = [
    ...Object.keys(markers),
    ...Object.keys(neighbor?.markers ?? {}),
  ].filter(
    (key) =>
      (markers[key] ?? neighbor?.markers[key])?.sourceKind === "review comment"
  )

  // The diff region: toolbar, files and neighbor (with their margins). At
  // Guided it leaves; the delivery layers above it take its place.
  const diffRegion = (
    <>
      {(data.files.length > 0 || data.unit.generatedDiffs?.length) && (
        <div className="flex flex-wrap items-center gap-4 px-8 pb-3 narrow:gap-3 narrow:px-4">
          <DiffToolbarControls />
          <ViewedCount data={data} />
          <span className="flex-auto" />
          <ResolvedToggle count={resolvedCount} />
          <OverlayToggle commentKeys={commentKeys} />
        </div>
      )}
      <div className="flex flex-col gap-5 px-8 pb-6 narrow:px-4">
        {data.unit.generatedDiffs?.map((generated) => (
          <GeneratedDiff
            key={generated.file.path}
            label={generated.label}
            file={generated.file}
            provenance={generated.provenance}
            markers={markers}
            commentAnchors={commentAnchors[generated.file.path]}
            comments={commentRecords}
            commentContext={commentContext}
          />
        ))}
        {data.unit.attribution?.generatedDiff && (
          <GeneratedDiff
            label={data.unit.attribution.generatedDiff.label}
            file={data.unit.attribution.generatedDiff.file}
            markers={markers}
            commentAnchors={
              commentAnchors[data.unit.attribution.generatedDiff.file.path]
            }
            comments={commentRecords}
            commentContext={commentContext}
          />
        )}
        {data.files.map((file, i) => (
          <DiffFileCard
            key={file.path}
            file={file}
            position={{ index: i + 1, of: data.files.length }}
            markers={markers}
            commentAnchors={commentAnchors[file.path]}
            comments={commentRecords}
            commentContext={commentContext}
            onCheckAction={onCheckAction}
          />
        ))}
        {data.neighbor && (
          <ReadOnlyNeighbor
            neighbor={data.neighbor}
            markers={neighbor?.markers}
            commentAnchors={neighbor?.anchors[data.neighbor.file.path]}
            comments={neighbor?.records}
            commentContext={commentContext}
          />
        )}
      </div>
    </>
  )

  return (
    <HostPendingUnitContext.Provider value={pendingUnitId}>
      <DeliveryInstantContext.Provider value={!readerMoved}>
        <div className="flex min-h-svh flex-col bg-paper font-sans text-sm text-ink shell:h-svh">
          {decisionPending && (
            <p role="status" className="border-b px-6 py-2 text-sm">
              Saving review operation…
            </p>
          )}
          {decisionError && (
            <p role="alert" className="border-b px-6 py-3 text-sm text-red-700">
              {decisionError}
            </p>
          )}
          <AppHeader
            repo={data.repo}
            branch={data.branch}
            commit={data.revision.slice(0, 12)}
            batches={data.batches}
          />
          {/* App shell from 861px, and at any width embedded (`shell:`): rail
          and unit column scroll independently, so
          the source sheet and its scrim cover exactly the unit column. */}
          <div className="flex flex-auto flex-wrap items-stretch shell:min-h-0 shell:flex-nowrap">
            <UnitRail data={data} markers={markers} />
            <main
              ref={measureColumn}
              className="relative flex min-w-0 flex-[999_1_560px] content-fade flex-col"
            >
              {/* The desk's scroll container: the scroll ancestor of every
              sticky file header, and what a unit switch dims and resets.
              Scroll padding keeps targets clear of the dock, except while
              focus is in the dock: the padding covers the dock's own
              controls, and the focus or caret reveal would scroll to them. */}
              <div
                ref={scrollRoot}
                data-desk-scroll=""
                data-switching={switching ? "" : undefined}
                aria-busy={switching || undefined}
                className="flex flex-auto scroll-pb-[calc(var(--nv-dock-h,64px)+44px)] flex-col transition-opacity duration-switch-dim ease-standard has-[[data-decision-dock]:focus-within]:scroll-pb-0 data-switching:opacity-(--nv-opacity-switching) data-switching:delay-switch-wait motion-reduce:duration-0 shell:absolute shell:inset-0 shell:overflow-y-auto"
              >
                <OutsidePressDismiss />
                {/* The phased choreography morphs this stack
                once per change. */}
                <DeliveryStack>
                  <div
                    {...regionTransition("desk-briefing", 1)}
                    className="pt-4"
                  >
                    <Briefing
                      unit={data.unit}
                      revision={data.revision}
                      markers={markers}
                      // Guided shows no diff: citations open their source.
                      files={guidedShowsCheck ? [] : data.files}
                      delivery={
                        delivery && data.delivery
                          ? {
                              glyph: (
                                <DeliveryTitleGlyph
                                  unitId={data.unit.id}
                                  payload={data.delivery}
                                  stop={delivery.stop}
                                  flow={scrollRoot}
                                />
                              ),
                              facts: data.delivery.facts,
                              factsOnly: stage === STAGE.facts,
                              atExplained: stage === STAGE.explained,
                              explained: data.delivery.explained,
                              guided,
                              guidedCheck: guided
                                ? guidedCheck(data.delivery)
                                : undefined,
                            }
                          : undefined
                      }
                    />
                  </div>
                  {delivery && data.delivery && (
                    <DeliveryLayers
                      unit={data.unit}
                      payload={data.delivery}
                      stage={stage}
                      asked={delivery.asked}
                      markers={markers}
                      reviewer={data.reviewer}
                    />
                  )}
                  {explainedShown && (
                    // The Explained digest's rubric, under its flow and terms.
                    <DigestFeedback
                      content="explained"
                      harnessCallVisible={
                        !!suggestion || data.unit.attribution !== undefined
                      }
                      className="pr-8 pb-4 pl-6 narrow:px-4"
                    />
                  )}
                  {guided && (
                    // The Guided digest's rubric, under its rows.
                    <DigestFeedback
                      content="guided"
                      harnessCallVisible={
                        !!suggestion || data.unit.attribution !== undefined
                      }
                      className="pr-8 pb-4 pl-6 narrow:px-4"
                    />
                  )}
                  <div {...regionTransition("desk-diff", 2)}>
                    {delivery ? (
                      <DeliveryDiff
                        unitId={data.unit.id}
                        show={!guidedShowsCheck}
                        stage={stage}
                      >
                        {diffRegion}
                      </DeliveryDiff>
                    ) : (
                      diffRegion
                    )}
                  </div>
                </DeliveryStack>
                <DecisionDock
                  unit={data.unit}
                  markers={markers}
                  nextUnitId={nextUndecidedUnitId(data)}
                  backTo={batchOverview(data.batches)}
                  suggestion={suggestion}
                  deliveryGlyph={
                    delivery && data.delivery ? (
                      <DeliveryDockGlyph
                        unitId={data.unit.id}
                        payload={data.delivery}
                        stop={delivery.stop}
                      />
                    ) : undefined
                  }
                />
              </div>
              {data.newCommit && <NewCommitNotice event={data.newCommit} />}
              <SourceSheet
                markers={sheetMarkers}
                historyLoader={historyLoader}
              />
            </main>
          </div>
        </div>
      </DeliveryInstantContext.Provider>
    </HostPendingUnitContext.Provider>
  )
}

/**
 * Review desk — one review unit with its briefing, diff, context margin
 * (L0–L3 disclosure), read-only neighbor and decision dock.
 *
 * Owns a jotai Provider so every instance (route or story) has isolated
 * interaction state. MotionConfig honours the OS reduced-motion setting for
 * every motion component below.
 */
export function ReviewDeskScreen({
  feedbackSink,
  ...props
}: ReviewDeskScreenProps) {
  return (
    <Provider>
      <MotionConfig reducedMotion="user">
        {/* Feedback (10.100): what each control answers on, and its sink. */}
        <DeskFeedbackContext.Provider value={props.data.feedback}>
          <FeedbackSinkContext.Provider value={feedbackSink}>
            <ReviewDesk {...props} />
          </FeedbackSinkContext.Provider>
        </DeskFeedbackContext.Provider>
      </MotionConfig>
    </Provider>
  )
}
