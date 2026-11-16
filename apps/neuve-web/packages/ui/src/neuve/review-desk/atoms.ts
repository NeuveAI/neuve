import * as React from "react"
import { atom, useAtomValue, useAtomValueRawSync } from "jotai"
import { atomWithStorage } from "jotai/utils"
import type { Virtualizer } from "@workspace/diffs"

import {
  commentThreadAuthor,
  createReviewCommentRecord,
} from "@workspace/ui/neuve/review-comments/record"
import type {
  ReviewCommentAnchor,
  ReviewCommentAuthor,
  ReviewCommentRecord,
} from "@workspace/ui/neuve/review-comments/record"
import {
  defaultReviewCommentRepository,
  reviewCommentRepositoryAtom,
} from "@workspace/ui/neuve/review-comments/repository"
import type { ReviewCommentRepository } from "@workspace/ui/neuve/review-comments/repository"
import { openThreadAtom } from "@workspace/ui/neuve/review-comments/threads"
import { embeddedOnPage } from "@workspace/ui/neuve/shared/embedded"
import { suggestionText } from "@workspace/ui/neuve/shared/delivery"
import type { DeliverySuggestion } from "@workspace/ui/neuve/shared/delivery"
// Read only inside write functions, so the mutual import is safe.
import {
  cardFromLineAtom,
  openLineAtom,
} from "@workspace/ui/neuve/review-desk/marker-atoms"
import {
  rangeEquals,
  rangeKey,
} from "@workspace/ui/neuve/review-desk/diff-model"
import type {
  DiffSide,
  LineRange,
  ReviewLane,
  ReviewDeskData,
} from "@workspace/ui/neuve/types"

/**
 * Review desk interaction state.
 *
 * The screen mounts its own jotai <Provider>, so these module-level atoms are
 * scoped per screen instance (and per story). Data comes in through props;
 * atoms only hold what the reviewer is doing with it.
 *
 * State machine (from Main.dc.html):
 *
 *   margin   closed ⇄ card(marker) → sheet(marker) → card(marker)
 *   lines    none ⇄ selected(file, range) — gutter click/drag/Shift/keys
 *            selected → composer(range) — chip, Enter/C, or the gutter "+"
 *            composer → saved (collapses into a pin) | cancelled | parked draft
 *   comment  pin ⇄ thread (the expanded layer, like a card)
 *            Show comments → compact previews; Dismiss all → pins
 *   dock     rest → composing → changes-requested ─┐
 *            rest ──────────────→ approved ────────┤ undo → rest
 *            composing ── cancel ──→ rest           │
 */

/**
 * Decision dock (13.25). Human-required units: approve or request changes.
 * Suggested units: approve or request changes at any time; approve is
 * agree when the agent approved, and the person's decision overrides the
 * agent's. Agentic units: request changes, or a comment (context for the
 * unit's next cycle); approvals there are the agent's. Static units: their
 * check result only. Decisions are always per unit, never per lane.
 */
export type DockState =
  | "rest"
  | "composing"
  | "approved"
  | "changes-requested"
  | "agreed"
  | "commented"

export type DiffLayout = "stacked" | "split"
export type BrowseMode = "units" | "files"
/** New-commit notice: shown, parked as a corner pill, or none. */
export type NoticeState = "shown" | "parked" | "hidden"

/** The pin that owns its file's single shared hint (the layer places it). */
export interface HoverHint {
  filePath: string
  markerKey: string
}

/** Lines selected in one file's gutter (one selection across the desk). */
export interface LineSelection {
  filePath: string
  range: LineRange
}

/** Where the inline comment composer is open: the selected range. */
export type ComposerTarget = LineSelection

/** A comment draft set aside with Escape; it shows as a "Draft" pin. */
export interface ParkedDraft {
  id: string
  filePath: string
  range: LineRange
  text: string
}

export interface ReviewDeskState {
  openMarker: string | null
  sheetMarker: string | null
  neighborOpen: boolean
  dock: DockState
  draft: string
  attachment: string | null
  hoverHint: HoverHint | null
  /**
   * Review comments shown as compact previews in the margin ("Show
   * comments"). They do not isolate; a comment's thread opens as the one
   * expanded layer through `openMarker`, like a context card.
   */
  openBodies: ReadonlyArray<string>
  lineSelection: LineSelection | null
  composer: ComposerTarget | null
  commentDraft: string
  parkedDrafts: ReadonlyArray<ParkedDraft>
  /** Resolved review comments stay out of the margin unless asked for. */
  showResolved: boolean
  layout: DiffLayout
  wrap: boolean
  browse: BrowseMode
  notice: NoticeState
  generatedOpen: boolean
  openLanes: ReadonlyArray<ReviewLane>
  /** The rail unit the reviewer just opened, while the desk still shows this one. */
  pendingUnit: string | null
  /** Seeds the per-viewer stored value (stories only). */
  railCollapsed?: boolean
  /** What an open lane composer records (stories only; it defaults to a request). */
  feedbackKind?: "request-changes" | "comment"
}

export const INITIAL_REVIEW_DESK_STATE: ReviewDeskState = {
  openMarker: null,
  sheetMarker: null,
  neighborOpen: false,
  dock: "rest",
  draft: "",
  attachment: null,
  hoverHint: null,
  openBodies: [],
  lineSelection: null,
  composer: null,
  commentDraft: "",
  parkedDrafts: [],
  showResolved: false,
  layout: "stacked",
  wrap: true,
  browse: "units",
  notice: "shown",
  generatedOpen: false,
  openLanes: [],
  pendingUnit: null,
}

/* ── Primitive atoms ───────────────────────────────────── */

export const openMarkerAtom = atom<string | null>(null)

/**
 * A marker the margin shows on a further line than Records anchored it to
 * (a checkpoint's pin in another section its range touches) takes a key of
 * its own there, so its card and hint stay on that pin.
 */
export function pinMarkerKey(
  markerKey: string,
  side: DiffSide,
  lineNumber: number
): string {
  return `${markerKey}@pin:${side}:${lineNumber}`
}

/** The recorded marker behind a margin key: what leaves the margin names. */
export function recordedMarkerKey(key: string): string {
  return key.replace(/@pin:(?:additions|deletions):\d+$/, "")
}

export const showResolvedAtom = atom(false)
export const sheetMarkerAtom = atom<string | null>(null)
export const neighborOpenAtom = atom(false)
export const dockAtom = atom<DockState>("rest")
export const draftAtom = atom("")
export const attachmentAtom = atom<string | null>(null)
export const hoverHintAtom = atom<HoverHint | null>(null)
export const openBodiesAtom = atom<ReadonlyArray<string>>([])
export const lineSelectionAtom = atom<LineSelection | null>(null)
export const composerAtom = atom<ComposerTarget | null>(null)
export const commentDraftAtom = atom("")
export const parkedDraftsAtom = atom<ReadonlyArray<ParkedDraft>>([])
/**
 * The composer that just closed, kept in the overlay until its exit motion
 * (collapsing toward the pin row) finishes. Cleared by the exit callback.
 */
export const closingComposerAtom = atom<ComposerTarget | null>(null)

/**
 * The review desk's diff Virtualizer, created by the unit column's scroll
 * container. `"pending"` inside the desk until the scroll root has mounted
 * (diff hosts wait rather than build a throwaway renderer); null outside the
 * desk, where component stories render every row.
 */
/** The read-by tree row whose full path tooltip is showing. */
export const treeTipAtom = atom<string | null>(null)

/** Stacked or split diff (split pairs removed and added rows). */
export const diffLayoutAtom = atom<DiffLayout>("stacked")
/** Wrap long lines (on by default); off scrolls each file sideways. */
export const wrapAtom = atom(true)
/** Units / Files view of the rail. */
export const browseModeAtom = atom<BrowseMode>("units")
export const noticeAtom = atom<NoticeState>("shown")
/** The static unit's generated diff, collapsed by default. */
export const generatedOpenAtom = atom(false)
/**
 * Unit switch (round 3) for hosts without a router (stories): the rail row
 * the reviewer clicked. With a router host the switching state is derived
 * from the router's pending location instead (unit-rail useSwitchingTo);
 * this atom is then unused. The desk remounts per unit, which clears it.
 */
export const pendingUnitAtom = atom<string | null>(null)
/** Rail lane groups expanded in place (Lanes.dc.html). */
export const openLanesAtom = atom<ReadonlyArray<ReviewLane>>([])
/**
 * Whether the unit column is wide enough for Split (980px, measured on the
 * column, not the viewport). Below it Split falls back to Stacked.
 */
export const SPLIT_MIN_WIDTH = 980
export const splitFitsAtom = atom(true)
/** The layout the diff renders: the reviewer's choice unless Split can't fit. */
export const effectiveLayoutAtom = atom<DiffLayout>((get) =>
  get(diffLayoutAtom) === "split" && !get(splitFitsAtom)
    ? "stacked"
    : get(diffLayoutAtom)
)

export const toggleLaneAtom = atom(null, (get, set, lane: ReviewLane) => {
  const open = get(openLanesAtom)
  set(
    openLanesAtom,
    open.includes(lane) ? open.filter((l) => l !== lane) : [...open, lane]
  )
})

/**
 * The rail collapsed to its 60px icon column, remembered per viewer
 * (browser storage). Toggled by its button or the `[` shortcut.
 */
export const RAIL_COLLAPSED_STORAGE_KEY = "neuve.rail-collapsed.v1"
export const railCollapsedAtom = atomWithStorage(
  RAIL_COLLAPSED_STORAGE_KEY,
  false
)

/**
 * The desk in Ace's split view: embedded (shared/embedded.ts) and narrower
 * than this, the `narrow:` variant in globals.css. There the rail starts as
 * its icon column whatever the viewer stored for the wide desk, and opening
 * it holds only while this desk is mounted (narrowRailOpenAtom), so the
 * stored choice never changes from a split pane.
 */
export const NARROW_QUERY = "(width < 960px)"

export const narrowRailOpenAtom = atom(false)

function isNarrowDesk(): boolean {
  return window.matchMedia(NARROW_QUERY).matches && embeddedOnPage()
}

function subscribeNarrow(onChange: () => void) {
  const query = window.matchMedia(NARROW_QUERY)
  query.addEventListener("change", onChange)
  return () => query.removeEventListener("change", onChange)
}

/** Whether the desk is in split view; server render and hydration see `false`. */
export function useNarrowDesk(): boolean {
  return React.useSyncExternalStore(subscribeNarrow, isNarrowDesk, () => false)
}

/**
 * Whether the rail is collapsed, read through useSyncExternalStore. jotai 3's
 * useAtomValue misses the value atomWithStorage loads on mount unless it is
 * the first reader; server render and hydration see `false`, then storage.
 * In split view, collapsed unless opened there.
 */
export function useRailCollapsed(): boolean {
  const stored = useAtomValueRawSync(railCollapsedAtom)
  const narrow = useNarrowDesk()
  const narrowOpen = useAtomValue(narrowRailOpenAtom)
  return narrow ? !narrowOpen : stored
}

export const toggleRailAtom = atom(null, (get, set) => {
  if (isNarrowDesk()) set(narrowRailOpenAtom, !get(narrowRailOpenAtom))
  else set(railCollapsedAtom, !get(railCollapsedAtom))
})

export const diffVirtualizerAtom = atom<Virtualizer | null | "pending">(null)

/** Every primitive atom with its value, for hydration in screens and stories. */
export function reviewDeskHydration(state: Partial<ReviewDeskState>) {
  const s = { ...INITIAL_REVIEW_DESK_STATE, ...state }
  return [
    [openMarkerAtom, s.openMarker],
    [sheetMarkerAtom, s.sheetMarker],
    [neighborOpenAtom, s.neighborOpen],
    [dockAtom, s.dock],
    [draftAtom, s.draft],
    [attachmentAtom, s.attachment],
    [hoverHintAtom, s.hoverHint],
    [openBodiesAtom, s.openBodies],
    [lineSelectionAtom, s.lineSelection],
    [composerAtom, s.composer],
    [commentDraftAtom, s.commentDraft],
    [parkedDraftsAtom, s.parkedDrafts],
    [showResolvedAtom, s.showResolved],
    [diffLayoutAtom, s.layout],
    [wrapAtom, s.wrap],
    [browseModeAtom, s.browse],
    [noticeAtom, s.notice],
    [generatedOpenAtom, s.generatedOpen],
    [openLanesAtom, s.openLanes],
    [pendingUnitAtom, s.pendingUnit],
    [unitFeedbackKindAtom, s.feedbackKind ?? "request-changes"],
  ] as const
}

/** Seeds the stored rail state only when a story asks for one. */
export function railHydration(state: Partial<ReviewDeskState>) {
  const values = new Map<typeof railCollapsedAtom, boolean>()
  if (state.railCollapsed !== undefined) {
    values.set(railCollapsedAtom, state.railCollapsed)
  }
  return values
}

/** Hydration for the comment repository (the local one unless injected). */
export function commentRepositoryHydration(
  repository: ReviewCommentRepository | undefined
) {
  return [
    [reviewCommentRepositoryAtom, repository ?? defaultReviewCommentRepository],
  ] as const
}

/* ── Derived atoms ─────────────────────────────────────── */

/**
 * One expanded layer is isolating the margin: an L2 card (with no L3 sheet
 * covering it) or the inline comment composer.
 */
export const isolatingAtom = atom(
  (get) =>
    (get(openMarkerAtom) !== null && get(sheetMarkerAtom) === null) ||
    get(composerAtom) !== null
)

export const isDecidedAtom = atom((get) => {
  const dock = get(dockAtom)
  return (
    dock === "approved" ||
    dock === "changes-requested" ||
    dock === "agreed" ||
    dock === "commented"
  )
})

/* ── Actions ───────────────────────────────────────────── */

/**
 * Pin click: open its card, or close it when it is already open. Every
 * opener below also clears a grouped line's list (openLineAtom), so only
 * one layer is ever expanded.
 */
export const toggleMarkerAtom = atom(null, (get, set, markerKey: string) => {
  set(openMarkerAtom, get(openMarkerAtom) === markerKey ? null : markerKey)
  set(sheetMarkerAtom, null)
  set(hoverHintAtom, null)
  set(composerAtom, null)
  set(openLineAtom, null)
  set(cardFromLineAtom, null)
})

/** Briefing citation: always opens (never toggles) the cited marker. */
export const openCitationAtom = atom(null, (_get, set, markerKey: string) => {
  set(openMarkerAtom, markerKey)
  set(sheetMarkerAtom, null)
  set(hoverHintAtom, null)
  set(composerAtom, null)
  set(openLineAtom, null)
  set(cardFromLineAtom, null)
})

export const closeCardAtom = atom(null, (_get, set) => {
  set(openMarkerAtom, null)
})

/** Outside click or Escape: close whichever layer is expanded (draft kept). */
export const closeExpandedAtom = atom(null, (get, set) => {
  set(openMarkerAtom, null)
  set(openLineAtom, null)
  if (get(composerAtom) !== null) set(escapeComposerAtom)
})

export const openSheetAtom = atom(null, (get, set) => {
  const open = get(openMarkerAtom)
  set(sheetMarkerAtom, open === null ? null : recordedMarkerKey(open))
})

/** "Back to unit": the sheet closes and the card it came from stays open. */
export const closeSheetAtom = atom(null, (_get, set) => {
  set(sheetMarkerAtom, null)
})

export const toggleNeighborAtom = atom(null, (get, set) => {
  set(neighborOpenAtom, !get(neighborOpenAtom))
})

export const startChangesAtom = atom(
  null,
  (get, set, fallbackAttachment: string) => {
    set(dockOriginAtom, null)
    set(unitFeedbackKindAtom, "request-changes")
    set(dockAtom, "composing")
    const open = get(openMarkerAtom)
    set(
      attachmentAtom,
      open === null ? fallbackAttachment : recordedMarkerKey(open)
    )
  }
)

export type LiveDecision = {
  kind: "approve" | "request-changes" | "comment"
  body: string
  /**
   * The marker the composer shows attached, when it shows one: the comment
   * is about that marker's lines. Without it the comment is on the whole
   * unit (decision 10.102).
   */
  attachment?: string
}
export const currentResponsibilityAtom = atom<ReviewDeskData["unit"] | null>(
  null
)
export const unitFeedbackKindAtom = atom<"request-changes" | "comment">(
  "request-changes"
)
export type DecisionReceipt = {
  commandId: string
  kind: "disposition" | "comment"
  applicability?: "current" | "historical"
  dispatch?:
    | { kind: "admitted"; bindingId: string; threadId: string }
    | { kind: "saved-not-sent"; detail: string }
}
export type DecisionSink = (
  decision: LiveDecision
) => Promise<DecisionReceipt | void>
export type CommentSink = (
  input: SaveCommentInput & { body: string; commandId: string }
) => Promise<ReviewCommentRecord>
export type UndoSink = (receipt: DecisionReceipt) => Promise<void>
function callbackAtom<T>() {
  const value = atom<{ callback: T | undefined }>({ callback: undefined })
  return atom(
    (get) => get(value).callback,
    (_get, set, callback: T | undefined) => set(value, { callback })
  )
}
export const commentSinkAtom = callbackAtom<CommentSink>()
export const undoSinkAtom = callbackAtom<UndoSink>()
export const decisionReceiptAtom = atom<DecisionReceipt | null>(null)
export const decisionSinkAtom = callbackAtom<DecisionSink>()
export const decisionPendingAtom = atom(false)
export const decisionErrorAtom = atom<string | null>(null)
const submitDecisionAtom = atom(
  null,
  async (get, set, decision: LiveDecision, dock: DockState) => {
    if (get(decisionPendingAtom)) return
    const responsibility = get(currentResponsibilityAtom)
    if (
      decision.kind === "approve" &&
      responsibility?.lane === undefined &&
      responsibility !== null
    ) {
      set(decisionErrorAtom, "The assessment must be resolved before approval.")
      return
    }
    const responsibilityKey = JSON.stringify([
      responsibility?.id,
      responsibility?.responsibility,
      responsibility?.lane,
    ])
    const sink = get(decisionSinkAtom)
    set(decisionErrorAtom, null)
    set(decisionPendingAtom, true)
    try {
      if (sink) {
        const receipt = await sink(decision)
        set(decisionReceiptAtom, receipt ?? null)
        const current = get(currentResponsibilityAtom)
        if (
          receipt?.applicability === "historical" ||
          (decision.kind === "approve" &&
            responsibilityKey !==
              JSON.stringify([
                current?.id,
                current?.responsibility,
                current?.lane,
              ]))
        ) {
          set(
            decisionErrorAtom,
            "The acknowledgment is historical. Inspect current review state before deciding."
          )
          set(dockAtom, "rest")
          return
        }
        if (receipt?.dispatch?.kind === "saved-not-sent") {
          set(decisionErrorAtom, receipt.dispatch.detail)
          return
        }
      }
      set(dockAtom, dock)
      set(openMarkerAtom, null)
      set(sheetMarkerAtom, null)
    } catch (cause) {
      set(
        decisionErrorAtom,
        cause instanceof Error && cause.message
          ? cause.message
          : "Review operation was rejected"
      )
    } finally {
      set(decisionPendingAtom, false)
    }
  }
)
export const approveAtom = atom(null, (_get, set) =>
  set(
    submitDecisionAtom,
    { kind: "approve", body: "Approved by human reviewer" },
    "approved"
  )
)
/** The attached marker a request sends; only the human-required composer shows one. */
const requestAttachmentAtom = atom((get) =>
  get(currentResponsibilityAtom)?.lane === "human-required"
    ? get(attachmentAtom) || null
    : null
)
/**
 * Whether the open request has something to send. A request rests on a
 * comment saying what to change (10.69): with no words and no attached
 * comment there is nothing to send, and ⌘↵ hands focus nowhere.
 */
export const requestSendableAtom = atom(
  (get) => get(draftAtom).trim() !== "" || get(requestAttachmentAtom) !== null
)
export const sendChangesAtom = atom(null, (get, set) => {
  const attachment = get(requestAttachmentAtom)
  const body = get(draftAtom).trim()
  if (!get(requestSendableAtom)) return
  return set(
    submitDecisionAtom,
    {
      kind: "request-changes",
      body,
      ...(attachment ? { attachment } : {}),
    },
    "changes-requested"
  )
})
export const agreeAtom = atom(null, (_get, set) =>
  set(
    submitDecisionAtom,
    {
      kind: "approve",
      body: "Human reviewer agreed with this unit disposition",
    },
    "agreed"
  )
)
export const startUnitCommentAtom = atom(null, (_get, set) => {
  set(unitFeedbackKindAtom, "comment")
  set(dockAtom, "composing")
})
export const sendUnitCommentAtom = atom(null, (get, set) =>
  set(
    submitDecisionAtom,
    { kind: "comment", body: get(draftAtom).trim() },
    "commented"
  )
)

/** Cancel the composer or undo a decision: back to rest with no draft. */
export const resetDockAtom = atom(null, (_get, set) => {
  set(dockAtom, "rest")
  set(draftAtom, "")
  set(dockOriginAtom, null)
})

/* ── Suggested disposition (review delivery, Guided) ───────
 * On a human-required unit at Guided the dock sends the harness's
 * suggested disposition as the reader's own, opens it for editing, or
 * decides the other way. The reader is the actor either way; the origin
 * only changes the dock's wording. Mock only this round: recording
 * "started from the harness's suggestion" in review history is a backend
 * follow-up (round-4.md).
 */

/**
 * How the current dock decision relates to the suggestion: sent (or
 * edited) from it, or decided against it. Null outside Guided.
 */
export type DockOrigin = "suggestion" | "against-suggestion"
export const dockOriginAtom = atom<DockOrigin | null>(null)

/**
 * The primary "Request changes" / "Approve" (⌘↵): the suggestion's
 * decision, sent as yours.
 */
export const sendSuggestionAtom = atom(
  null,
  (_get, set, suggestion: DeliverySuggestion) => {
    set(dockOriginAtom, "suggestion")
    if (suggestion.decision === "approve") return set(approveAtom)
    set(unitFeedbackKindAtom, "request-changes")
    set(attachmentAtom, null)
    set(draftAtom, suggestionText(suggestion))
    return set(sendChangesAtom)
  }
)

/** "Edit request": the composer opens with the suggested message. */
export const editSuggestionAtom = atom(null, (_get, set, message: string) => {
  set(dockOriginAtom, "suggestion")
  set(unitFeedbackKindAtom, "request-changes")
  set(attachmentAtom, null)
  set(draftAtom, message)
  set(dockAtom, "composing")
})

/**
 * "Approve" where the suggestion requests changes: decided against it
 * (the origin, not the label, records that).
 */
export const approveInsteadAtom = atom(null, (_get, set) => {
  set(dockOriginAtom, "against-suggestion")
  return set(approveAtom)
})

/**
 * "Request changes" where the suggestion approves: decided against it,
 * with an empty composer.
 */
export const requestInsteadAtom = atom(null, (_get, set) => {
  set(dockOriginAtom, "against-suggestion")
  set(unitFeedbackKindAtom, "request-changes")
  set(attachmentAtom, null)
  set(draftAtom, "")
  set(dockAtom, "composing")
})

export const undoDecisionAtom = atom(null, async (get, set) => {
  if (get(decisionPendingAtom)) return
  const sink = get(undoSinkAtom)
  const receipt = get(decisionReceiptAtom)
  if (!get(decisionSinkAtom)) {
    set(resetDockAtom)
    return
  }
  if (!sink || !receipt || receipt.kind !== "disposition") return
  set(decisionPendingAtom, true)
  set(decisionErrorAtom, null)
  try {
    await sink(receipt)
    set(decisionReceiptAtom, null)
    set(resetDockAtom)
  } catch (cause) {
    set(
      decisionErrorAtom,
      cause instanceof Error && cause.message
        ? cause.message
        : "Could not withdraw decision"
    )
  } finally {
    set(decisionPendingAtom, false)
  }
})

export const detachAtom = atom(null, (_get, set) => {
  set(attachmentAtom, null)
})

/* ── Overlay annotations: dismiss / reopen ─────────────── */

/** Collapse one open annotation back to its pin (L0). */
export const dismissMarkerAtom = atom(null, (get, set, markerKey: string) => {
  set(
    openBodiesAtom,
    get(openBodiesAtom).filter((key) => key !== markerKey)
  )
  if (get(openMarkerAtom) === markerKey) set(openMarkerAtom, null)
})

/** Reopen a dismissed annotation's body. */
export const reopenMarkerAtom = atom(null, (get, set, markerKey: string) => {
  const current = get(openBodiesAtom)
  if (!current.includes(markerKey)) set(openBodiesAtom, [...current, markerKey])
})

/** Dismiss all: every open body collapses and any expanded layer closes. */
export const dismissAllAtom = atom(null, (_get, set) => {
  set(openBodiesAtom, [])
  set(openMarkerAtom, null)
  set(sheetMarkerAtom, null)
  set(composerAtom, null)
  set(hoverHintAtom, null)
})

/** Reopen all: every review-comment body opens again. */
export const reopenAllAtom = atom(
  null,
  (_get, set, markerKeys: ReadonlyArray<string>) => {
    set(openBodiesAtom, [...markerKeys])
  }
)

/* ── Inline comments ───────────────────────────────────── */

/**
 * The gutter selection changed (pointer, keyboard or touch). One selection
 * exists across the desk; an open composer in the same file follows it, so
 * dragging in the gutter re-targets the comment live.
 */
export const selectLinesAtom = atom(
  null,
  (get, set, filePath: string, range: LineRange | null) => {
    const current = get(lineSelectionAtom)
    if (range === null) {
      // Another file clearing its own selection must not clear this one.
      if (current?.filePath === filePath) set(lineSelectionAtom, null)
      return
    }
    if (current?.filePath !== filePath || !rangeEquals(current.range, range)) {
      set(lineSelectionAtom, { filePath, range })
    }
    set(openLineAtom, null)
    const composer = get(composerAtom)
    if (
      composer?.filePath === filePath &&
      !rangeEquals(composer.range, range)
    ) {
      set(composerAtom, { filePath, range })
    }
  }
)

export const clearSelectionAtom = atom(null, (_get, set) => {
  set(lineSelectionAtom, null)
})

/**
 * Open the composer on a range (the chip, Enter/C, the gutter "+", or a
 * Draft pin). It becomes the one expanded layer; a parked draft for the same
 * range comes back.
 */
export const openComposerAtom = atom(
  null,
  (get, set, target: ComposerTarget) => {
    const key = rangeKey(target.filePath, target.range)
    const parked = get(parkedDraftsAtom).find((draft) => draft.id === key)
    if (parked) {
      set(
        parkedDraftsAtom,
        get(parkedDraftsAtom).filter((draft) => draft.id !== key)
      )
      set(commentDraftAtom, parked.text)
    } else if (get(composerAtom) === null) {
      set(commentDraftAtom, "")
    }
    set(lineSelectionAtom, target)
    set(composerAtom, target)
    set(openMarkerAtom, null)
    set(sheetMarkerAtom, null)
    set(hoverHintAtom, null)
    set(openLineAtom, null)
  }
)

/**
 * Escape (or an outside click): an empty composer cancels; one with text is
 * set aside under its range and collapses to a "Draft" pin.
 */
export const escapeComposerAtom = atom(null, (get, set) => {
  const composer = get(composerAtom)
  if (!composer) return
  const text = get(commentDraftAtom)
  if (text.trim()) {
    const id = rangeKey(composer.filePath, composer.range)
    set(parkedDraftsAtom, [
      ...get(parkedDraftsAtom).filter((draft) => draft.id !== id),
      { id, filePath: composer.filePath, range: composer.range, text },
    ])
  }
  set(closingComposerAtom, composer)
  set(composerAtom, null)
  set(commentDraftAtom, "")
  set(lineSelectionAtom, null)
})

/** Cancel: drop the draft, close the composer and the selection. */
export const discardCommentAtom = atom(null, (get, set) => {
  set(closingComposerAtom, get(composerAtom))
  set(composerAtom, null)
  set(commentDraftAtom, "")
  set(lineSelectionAtom, null)
})

export interface SaveCommentInput {
  unitId: string
  revision: string
  author: ReviewCommentAuthor
  anchor: ReviewCommentAnchor
  /** The unit's agent: a saved comment opens a thread with it. */
  agentId?: string
}

/**
 * Persist the draft as a review comment record. The record becomes a
 * `review comment` marker on the next render (records → markers is derived):
 * the composer collapses into the new pin, and the selection clears.
 */
export const saveCommentAtom = atom(
  null,
  async (get, set, input: SaveCommentInput) => {
    const body = get(commentDraftAtom).trim()
    if (!body) return null
    const { agentId, ...fields } = input
    const sink = get(commentSinkAtom)
    let record: ReviewCommentRecord
    if (sink) {
      if (get(decisionPendingAtom)) return null
      set(decisionPendingAtom, true)
      set(decisionErrorAtom, null)
      try {
        record = await sink({ ...input, body, commandId: crypto.randomUUID() })
      } catch (cause) {
        set(
          decisionErrorAtom,
          cause instanceof Error && cause.message
            ? cause.message
            : "Comment was rejected"
        )
        return null
      } finally {
        set(decisionPendingAtom, false)
      }
    } else {
      if (get(decisionSinkAtom))
        throw Error("Live line comment persistence is unavailable")
      record = createReviewCommentRecord({ ...fields, body })
    }
    set(get(reviewCommentRepositoryAtom).saveAtom, record)
    if (agentId && !sink) {
      set(openThreadAtom, record.id, agentId, {
        id: `${record.id}:comment`,
        author: commentThreadAuthor(record.author),
        body: record.body,
        at: record.createdAt,
      })
    }
    set(commentDraftAtom, "")
    set(closingComposerAtom, get(composerAtom))
    set(composerAtom, null)
    set(lineSelectionAtom, null)
    return record
  }
)
