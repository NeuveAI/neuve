/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD — Decision dock
 *
 *    0ms   rest dock rises: opacity 0 → 1, y 8 → 0, scale .98 → 1
 *          (dockRise 240ms, emphasized decelerate, origin bottom)
 *    0ms   a button compresses to .97 while held (SCALE.press, pressIn 80ms,
 *          the Button's `press` utility)
 *  swap    current state leaves first (dockExit 120ms, accelerate),
 *          then the next state rises (AnimatePresence mode="wait")
 *          rest → composer · composer → decided · decided → rest (undo)
 *          Guided rest (suggested disposition) swaps the same way
 *
 * Reduced motion: each swap is a 150ms opacity crossfade.
 * ───────────────────────────────────────────────────────── */

import * as React from "react"
import { atom, useAtomValue, useSetAtom, useStore } from "jotai"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import {
  ArrowRightIcon,
  CheckIcon,
  CornerUpLeftIcon,
  InfoIcon,
  MessageCircleIcon,
  XIcon,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

import { NeuveLink, useNeuveMode } from "@workspace/ui/neuve/shared/nav-link"
import type { NeuveDestination } from "@workspace/ui/neuve/shared/nav-link"
import { Button } from "@workspace/ui/components/button"
import { Textarea } from "@workspace/ui/components/textarea"
import {
  EASE,
  REDUCED_TRANSITION,
  TIMING,
  ms,
  OFFSET,
  SCALE,
} from "@workspace/ui/lib/motion"
import { cn } from "@workspace/ui/lib/utils"
import { LaneGlyph } from "@workspace/ui/neuve/shared/lane-glyph"
import { regionTransition } from "@workspace/ui/neuve/shared/view-transitions"
import {
  agreeAtom,
  approveAtom,
  approveInsteadAtom,
  dockOriginAtom,
  editSuggestionAtom,
  requestInsteadAtom,
  sendSuggestionAtom,
  attachmentAtom,
  sendUnitCommentAtom,
  startUnitCommentAtom,
  detachAtom,
  dockAtom,
  draftAtom,
  resetDockAtom,
  undoDecisionAtom,
  decisionSinkAtom,
  decisionReceiptAtom,
  decisionPendingAtom,
  decisionErrorAtom,
  sendChangesAtom,
  startChangesAtom,
  unitFeedbackKindAtom,
} from "@workspace/ui/neuve/review-desk/atoms"
import type {
  DockOrigin,
  DockState,
} from "@workspace/ui/neuve/review-desk/atoms"
import { suggestionText } from "@workspace/ui/neuve/shared/delivery"
import type { DeliverySuggestion } from "@workspace/ui/neuve/shared/delivery"
import { useStartUnitSwitch } from "@workspace/ui/neuve/review-desk/unit-rail"
import {
  DOCK_GLYPH_VARS,
  DOCK_RECENTRE,
} from "@workspace/ui/neuve/review-desk/delivery/delivery-dock-dial"
import type {
  ContextualMarker,
  ReviewDeskData,
} from "@workspace/ui/neuve/types"

const DOCK = {
  offsetY: OFFSET.lift, // px each state rises from
  initialScale: SCALE.enter,
  enter: { duration: ms(TIMING.dockRise), ease: EASE.emphasizedDecelerate },
  exit: { duration: ms(TIMING.dockExit), ease: EASE.emphasizedAccelerate },
} as const

/** The send shortcut, drawn at full strength in its button (at 70% it fell
 * to 3.65:1 on the light accent). */
const SHORTCUT = "⌘↵"

function DockMotion({
  children,
  className,
  ...rest
}: React.ComponentProps<typeof motion.div>) {
  const reduce = useReducedMotion()
  return (
    <motion.div
      initial={
        reduce
          ? { opacity: 0 }
          : { opacity: 0, y: DOCK.offsetY, scale: DOCK.initialScale }
      }
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, transition: reduce ? REDUCED_TRANSITION : DOCK.exit }}
      transition={reduce ? REDUCED_TRANSITION : DOCK.enter}
      style={{ transformOrigin: "bottom center" }}
      className={className}
      {...rest}
    >
      {children}
    </motion.div>
  )
}

/* ── Focus across dock states ──────────────────────────────
 * Each dock state replaces the last, so the control that changed it is
 * gone. A press on a dock step asks the state it leads to (its
 * data-dock-step: composing, decided or rest) to take focus when that
 * state mounts on this unit: the composer's text, the rest dock's matching
 * button (the one that opened the composer or decided, data-dock-opener),
 * or the decided dock's way on. A decision waits for the server however
 * long it takes. The request ends when its state takes it, when a decision
 * ends without reaching it (an error or an early return), on a unit
 * switch, and when focus moves outside the dock (useDockGuards), so it
 * never pulls focus from elsewhere. The ring shows for the keyboard only.
 */

/** The dock state a step leads to (its data-dock-step value). */
type DockKind = "composing" | "decided" | "rest"

/** A pending focus hand-off, for one state on one unit (see above). */
const dockFocusAtom = atom<{
  keyboard: boolean
  unitId: string
  to: DockKind
} | null>(null)

/** Asks `to`, the next state on `unitId`, to take focus. */
function handOff(
  store: ReturnType<typeof useStore>,
  hand: { keyboard: boolean; unitId: string; to: DockKind }
) {
  store.set(dockFocusAtom, hand)
}

/** What kind of dock state `dock` is. */
function kindOf(dock: DockState): DockKind {
  return dock === "rest" || dock === "composing" ? dock : "decided"
}

/** The dock button that last opened the composer or decided. */
const dockOpenerAtom = atom<string | null>(null)

/**
 * A ref for a dock state's root: when it mounts as the state a hand-off
 * asked for, on its unit, focus goes to `pick(root)`, or the state's first
 * control. A hand-off for another unit is stale and ends here.
 */
function useDockLanding(
  pick: (root: HTMLElement) => HTMLElement | null,
  kind: DockKind,
  unitId: string
) {
  const store = useStore()
  return React.useCallback(
    (root: HTMLElement | null) => {
      if (!root) return
      const request = store.get(dockFocusAtom)
      if (!request) return
      // Backup. A unit switch can swap the state in one commit (DockRest and
      // DockLaneRest share the key "rest", the composers "composing"), and
      // this landing then runs before the root re-attaches
      // (useDockGuards). Only a decision's request can be pending at a
      // switch, and the `to` check keeps any other state from taking it.
      // Keep it anyway.
      if (request.unitId !== unitId) {
        store.set(dockFocusAtom, null)
        return
      }
      if (request.to !== kind) return
      store.set(dockFocusAtom, null)
      const target =
        pick(root) ??
        root.querySelector<HTMLElement>(
          "button:not(:disabled), a[href], [tabindex='0']"
        )
      target?.focus({ preventScroll: true, focusVisible: request.keyboard })
    },
    [store, pick, kind, unitId]
  )
}

/** Rest: the button that opened the composer or decided, if this rest has it. */
function pickOpener(store: ReturnType<typeof useStore>) {
  return (root: HTMLElement) => {
    const opener = store.get(dockOpenerAtom)
    return opener
      ? root.querySelector<HTMLElement>(
          `[data-dock-opener="${opener}"]:not(:disabled)`
        )
      : null
  }
}

function useRestLanding(unitId: string) {
  const store = useStore()
  const pick = React.useMemo(() => pickOpener(store), [store])
  return useDockLanding(pick, "rest", unitId)
}

const pickText = (root: HTMLElement) => root.querySelector("textarea")

/**
 * A dock composer never shrinks while it is open: it holds the tallest
 * height it has had, and its text fills the room. The dock sits in flow at
 * the unit's end, so a composer that shrank there (the draft offer leaving
 * on the first keystroke, a line deleted) would shorten the scroll and pull
 * the code down under the reader. A ref callback owns the ResizeObserver,
 * so no effect is needed.
 */
function holdHeight(node: HTMLElement) {
  if (typeof ResizeObserver === "undefined") return
  let held = 0
  const observer = new ResizeObserver(([entry]) => {
    const height = entry?.borderBoxSize[0]?.blockSize ?? 0
    if (height <= held) return
    held = height
    node.style.minHeight = `${held}px`
  })
  observer.observe(node)
  return () => observer.disconnect()
}

/** A dock composer's root ref: its landing, and it holds its height. */
function useComposerRoot(landing: (root: HTMLElement | null) => void) {
  return React.useCallback(
    (node: HTMLElement | null) => {
      landing(node)
      return node ? holdHeight(node) : undefined
    },
    [landing]
  )
}

/**
 * The dock composers' text. It grows with its text up to 40% of the
 * viewport, then scrolls itself, so the caret stays in view. (The desk drops
 * its scroll padding while anything in the dock has focus, so the caret
 * reveal never scrolls the desk: see DecisionDock.)
 */
const DOCK_TEXT = "max-h-[40dvh] flex-auto"

/**
 * Drafts set aside with Escape (Cancel discards), one per opener. Reopening
 * the composer from that opener on the same unit restores its draft (the
 * dock's click handler, after the opener's own), so a detour through
 * another opener keeps it. A draft never shows in another opener's
 * composer, and a unit switch drops them all (useDockGuards).
 */
const parkedDockDraftsAtom = atom<
  Readonly<Record<string, { unitId: string; text: string }>>
>({})

const pickWayOn = (root: HTMLElement) =>
  root.querySelector<HTMLElement>("[data-dock-way-on]")

/** What the decision covers: the unit's scope label, or its hunks counted. */
function coversText(unit: ReviewDeskData["unit"]) {
  return (
    unit.scopeLabel ??
    `${unit.hunkCount} ${unit.hunkCount === 1 ? "hunk" : "hunks"}`
  )
}

/**
 * The dock's one shadow treatment (round 7), on every dock state, rest,
 * composer and decided: a drop-shadow filter, which follows whatever shape
 * the dock takes (the delivery glyph's extension included).
 */
const DOCK_SHADOW =
  "[filter:drop-shadow(0_0_0.5px_var(--nv-dock-ring))_drop-shadow(0_16px_40px_var(--nv-dock-drop))]"

/**
 * The dock bar, dark in both themes: an inverse surface. Its body is drawn
 * by DockBody under its parts, and its shadow is DOCK_SHADOW, so the
 * review-delivery glyph's extension (round 7, delivery-dock-dial.tsx) can
 * slide out from under the body with the shadow following both. The filter
 * makes the bar a stacking context for them.
 */
const DOCK_BAR = cn(
  "relative isolate flex items-center gap-1.5 rounded-[14px] py-1.5 pr-1.5 pl-3.5 text-dock-fg",
  DOCK_SHADOW,
  // Re-centres around the delivery glyph's extension while it shows.
  DOCK_RECENTRE
)

/** The dock bar's body: its fill, under its parts and over the extension. */
function DockBody() {
  return (
    <span
      aria-hidden="true"
      data-dock-body=""
      className="pointer-events-none absolute inset-0 -z-1 rounded-[14px] bg-dock"
    />
  )
}

/**
 * The decision's scope ("Covers 1 hunk") with its note as a tooltip on hover
 * and keyboard focus, described to screen readers. Every human dock rest
 * shows it, Guided included.
 */
function DockScope({ unit }: { unit: ReviewDeskData["unit"] }) {
  return (
    <span
      tabIndex={0}
      aria-describedby="dock-scope-note"
      className="group/scope relative inline-flex items-center gap-2 pr-2 text-[13px] text-dock-muted"
    >
      {unit.lane ? (
        <LaneGlyph lane={unit.lane} />
      ) : (
        <InfoIcon aria-hidden="true" className="size-4" />
      )}
      Covers {coversText(unit)}
      <span
        id="dock-scope-note"
        role="tooltip"
        className="pointer-events-none absolute bottom-[34px] -left-2 z-2 w-[232px] -translate-y-(--nv-offset-hint) rounded-lg bg-peek px-2.5 py-2 text-left font-sans text-xs leading-[17px] whitespace-normal text-peek-fg opacity-0 transition-[opacity,transform] duration-hint ease-ios-out group-focus-within/scope:translate-y-0 group-focus-within/scope:opacity-100 group-hover/scope:translate-y-0 group-hover/scope:opacity-100 motion-reduce:translate-y-0 motion-reduce:transition-none"
      >
        {unit.scopeNote}
      </span>
    </span>
  )
}

/**
 * The review-delivery glyph a rest dock shows at its left while the title's
 * has scrolled away (round 7): the desk passes it. It adds no decision.
 */
type DeliveryGlyph = { deliveryGlyph?: React.ReactNode }

/** Rest: decision scope + Request changes / Approve. */
function DockRest({
  unit,
  deliveryGlyph,
}: { unit: ReviewDeskData["unit"] } & DeliveryGlyph) {
  const startChanges = useSetAtom(startChangesAtom)
  const approve = useSetAtom(approveAtom)
  const startComment = useSetAtom(startUnitCommentAtom)
  const landing = useRestLanding(unit.id)
  return (
    <DockMotion
      key="rest"
      ref={landing}
      data-surface="inverse"
      className={cn(DOCK_BAR, "flex-wrap")}
    >
      <DockBody />
      {deliveryGlyph}
      <DockScope unit={unit} />
      <span aria-hidden="true" className="h-5 w-px bg-dock-line" />
      <Button
        type="button"
        variant="dock-ghost"
        size="dock"
        data-dock-step="composing"
        data-dock-opener="request-changes"
        onClick={() => startChanges(unit.defaultAttachment)}
      >
        Request changes
      </Button>
      {unit.lane !== undefined ? (
        <Button
          type="button"
          variant="dock-primary"
          size="dock"
          data-dock-step="decided"
          data-dock-opener="approve"
          onClick={approve}
          aria-keyshortcuts="Meta+Enter"
        >
          Approve
          <span className="font-mono text-[11px]">{SHORTCUT}</span>
        </Button>
      ) : (
        <Button
          type="button"
          variant="dock-ghost"
          size="dock"
          data-dock-step="composing"
          data-dock-opener="comment"
          onClick={startComment}
        >
          Comment
        </Button>
      )}
    </DockMotion>
  )
}

/**
 * Rest at Guided on a human-required unit (Delivery.dc.html): the
 * harness's suggested disposition, sent as the reader's own, edited first,
 * or decided the other way. The same two decisions the lane offers, in the
 * lane's own words; the suggested one is primary (⌘↵).
 *
 *   suggests request changes   Approve · Edit request · [Request changes ⌘↵]
 *   suggests approve           Request changes · [Approve ⌘↵]
 */
function DockSuggestedRest({
  unit,
  suggestion,
  deliveryGlyph,
}: {
  unit: ReviewDeskData["unit"]
  suggestion: DeliverySuggestion
} & DeliveryGlyph) {
  const send = useSetAtom(sendSuggestionAtom)
  const edit = useSetAtom(editSuggestionAtom)
  const approveInstead = useSetAtom(approveInsteadAtom)
  const requestInstead = useSetAtom(requestInsteadAtom)
  const requests = suggestion.decision === "request_changes"
  const landing = useRestLanding(unit.id)
  return (
    <DockMotion
      key="rest"
      ref={landing}
      data-surface="inverse"
      className={cn(DOCK_BAR, "flex-wrap")}
    >
      <DockBody />
      {deliveryGlyph}
      <DockScope unit={unit} />
      <span aria-hidden="true" className="h-5 w-px bg-dock-line" />
      {requests ? (
        <>
          <Button
            type="button"
            variant="dock-ghost"
            size="dock"
            data-dock-step="decided"
            data-dock-opener="approve"
            onClick={approveInstead}
          >
            Approve
          </Button>
          <Button
            type="button"
            variant="dock-ghost"
            size="dock"
            data-dock-step="composing"
            data-dock-opener="edit-request"
            onClick={() => edit(suggestionText(suggestion))}
          >
            Edit request
          </Button>
          <Button
            type="button"
            variant="dock-primary"
            size="dock"
            data-dock-step="decided"
            data-dock-opener="request-changes"
            onClick={() => send(suggestion)}
            aria-keyshortcuts="Meta+Enter"
          >
            Request changes
            <span className="font-mono text-[11px]">{SHORTCUT}</span>
          </Button>
        </>
      ) : (
        <>
          <Button
            type="button"
            variant="dock-ghost"
            size="dock"
            data-dock-step="composing"
            data-dock-opener="request-changes"
            onClick={requestInstead}
          >
            Request changes
          </Button>
          <Button
            type="button"
            variant="dock-primary"
            size="dock"
            data-dock-step="decided"
            data-dock-opener="approve"
            onClick={() => send(suggestion)}
            aria-keyshortcuts="Meta+Enter"
          >
            Approve
            <span className="font-mono text-[11px]">{SHORTCUT}</span>
          </Button>
        </>
      )}
    </DockMotion>
  )
}

/**
 * Escape in a dock composer closes it as Cancel does, but sets the draft
 * aside (parkedDockDraftsAtom) instead of discarding it: a stray Escape
 * keeps what was typed. It goes no further (the desk's own Escape would
 * close a card or a selection next).
 */
function useComposerEscape(cancel: () => void, unitId: string) {
  const store = useStore()
  return React.useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      event.stopPropagation()
      const text = store.get(draftAtom)
      const opener = store.get(dockOpenerAtom)
      if (text.trim() && opener)
        store.set(parkedDockDraftsAtom, {
          ...store.get(parkedDockDraftsAtom),
          [opener]: { unitId, text },
        })
      handOff(store, { keyboard: true, unitId, to: "rest" })
      cancel()
    },
    [store, cancel, unitId]
  )
}

/** Composer: draft suggestion, comment, attached context, send. */
function DockComposer({
  unit,
  markers,
}: {
  unit: ReviewDeskData["unit"]
  markers: Record<string, ContextualMarker>
}) {
  const draft = useAtomValue(draftAtom)
  const setDraft = useSetAtom(draftAtom)
  const attachment = useAtomValue(attachmentAtom)
  const detach = useSetAtom(detachAtom)
  const cancel = useSetAtom(resetDockAtom)
  const send = useSetAtom(sendChangesAtom)
  const origin = useAtomValue(dockOriginAtom)
  const attached = attachment ? markers[attachment] : undefined
  const landing = useComposerRoot(
    useDockLanding(pickText, "composing", unit.id)
  )
  const text = React.useRef<HTMLTextAreaElement>(null)
  const onKeyDown = useComposerEscape(cancel, unit.id)

  return (
    <DockMotion
      key="composing"
      ref={landing}
      role="dialog"
      aria-label="Request changes"
      onKeyDown={onKeyDown}
      className={cn(
        "box-border flex w-[min(620px,calc(100vw-64px))] flex-col gap-3 rounded-[14px] bg-surface px-4 py-3.5",
        DOCK_SHADOW
      )}
    >
      <div className="flex items-center gap-2.5">
        <span className="text-sm font-semibold">Request changes</span>
        <span className="font-mono text-[11px] text-ink-muted">
          {coversText(unit)}
        </span>
        <span className="flex-auto" />
        {origin === "suggestion" && (
          <span className="rounded-sm border border-dashed border-line-strong px-1.5 py-0.5 font-mono text-[11px] text-ink-muted">
            from the suggested review
          </span>
        )}
        <Button
          type="button"
          variant="quiet"
          size="icon-card"
          aria-label="Cancel"
          data-dock-step="rest"
          onClick={cancel}
        >
          <XIcon aria-hidden="true" className="size-3" />
        </Button>
      </div>
      {draft === "" && unit.draftSuggestion && (
        <button
          type="button"
          // The offer leaves once used: the text takes focus.
          onClick={() => {
            setDraft(unit.draftSuggestion)
            text.current?.focus()
          }}
          className="flex items-start gap-2.5 rounded-[10px] border-0 bg-paper px-3 py-2.5 text-left transition-colors duration-surface-tone ease-standard hover:bg-raised motion-reduce:transition-none"
        >
          <span className="rounded-sm bg-sug-tint px-1.5 py-0.5 font-mono text-[10.5px] whitespace-nowrap text-sug-ink">
            Draft
          </span>
          <span className="flex-auto text-[13px] leading-[19px] text-ink-2">
            {unit.draftSuggestion}
          </span>
          <span className="text-[12.5px] whitespace-nowrap text-ink-muted">
            Use ↵
          </span>
        </button>
      )}
      <label htmlFor="dock-comment" className="sr-only">
        What needs to change
      </label>
      <Textarea
        ref={text}
        id="dock-comment"
        rows={3}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="What needs to change?"
        aria-keyshortcuts="Meta+Enter"
        className={cn(
          DOCK_TEXT,
          "min-h-[76px] resize-y rounded-[10px] border-0 bg-raised p-3 text-sm leading-[21px] text-ink shadow-none focus-visible:ring-0 md:text-sm dark:bg-raised"
        )}
      />
      <div className="flex flex-wrap items-center gap-2">
        {attached && (
          <span className="inline-flex h-7 items-center gap-1.5 rounded-md bg-raised pr-1 pl-2.5 font-mono text-[11.5px] text-ink-2">
            {attached.short} attached
            <Button
              type="button"
              variant="quiet"
              size="icon-xs"
              aria-label="Remove attached context"
              // The chip leaves with its button: the text takes focus.
              onClick={() => {
                detach()
                text.current?.focus()
              }}
              className="size-[22px]"
            >
              <XIcon aria-hidden="true" className="size-[9px]" />
            </Button>
          </span>
        )}
        <span className="flex-auto" />
        <Button
          type="button"
          variant="quiet"
          size="dock"
          className="px-3 font-normal"
          data-dock-step="rest"
          onClick={cancel}
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="ink"
          size="dock"
          data-dock-step="decided"
          onClick={send}
        >
          Send to implementer
          <span className="font-mono text-[11px]">{SHORTCUT}</span>
        </Button>
      </div>
    </DockMotion>
  )
}

/**
 * Rest for units outside the human-required lane (Lanes.dc.html). When an
 * agent recorded a review, that review is said once, in the briefing's
 * review card; the dock says what the decision covers ("Covers 1 hunk"),
 * as the human dock does (Option A, round 4.2; review F8 for the agentic
 * lane). Without an agent review (static automation, or still waiting) the
 * dock keeps its status line.
 */
function DockLaneRest({
  unit,
  deliveryGlyph,
}: { unit: ReviewDeskData["unit"] } & DeliveryGlyph) {
  const startChanges = useSetAtom(startChangesAtom)
  const startComment = useSetAtom(startUnitCommentAtom)
  const agree = useSetAtom(agreeAtom)
  const approve = useSetAtom(approveAtom)
  const suggested = unit.lane === "human-suggested"
  const outcome = unit.attribution?.outcome
  const reviewed = outcome === "approved" || outcome === "changes-requested"
  const text =
    outcome === "passed"
      ? "Passed static automation"
      : unit.lane === "static-automation"
        ? "Awaiting static automation"
        : "Awaiting agent review"
  const landing = useRestLanding(unit.id)
  return (
    <DockMotion
      key="rest"
      ref={landing}
      data-surface="inverse"
      className={cn(DOCK_BAR, (suggested || reviewed) && "flex-wrap")}
    >
      <DockBody />
      {deliveryGlyph}
      {suggested || reviewed ? (
        <>
          <DockScope unit={unit} />
          <span aria-hidden="true" className="h-5 w-px bg-dock-line" />
        </>
      ) : (
        <span className="inline-flex items-center gap-2 pr-2 text-[13px] text-dock-muted">
          {unit.lane ? (
            <LaneGlyph lane={unit.lane} />
          ) : (
            <InfoIcon aria-hidden="true" className="size-4" />
          )}
          {text}
        </span>
      )}
      {suggested ? (
        <>
          <Button
            type="button"
            variant="dock-ghost"
            size="dock"
            data-dock-step="composing"
            data-dock-opener="request-changes"
            onClick={() => startChanges(unit.defaultAttachment)}
          >
            Request changes
          </Button>
          {(outcome === "approved" || outcome === "changes-requested") && (
            <Button
              type="button"
              variant="dock-primary"
              size="dock"
              data-dock-step="decided"
              data-dock-opener="approve"
              onClick={outcome === "approved" ? agree : approve}
            >
              {outcome === "approved" ? "Agree" : "Approve"}
            </Button>
          )}
        </>
      ) : (
        <Button
          type="button"
          variant="dock-ghost"
          size="dock"
          data-dock-step="composing"
          data-dock-opener="comment"
          onClick={startComment}
          className="shadow-[inset_0_0_0_1px_var(--nv-dock-line)]"
        >
          <MessageCircleIcon aria-hidden="true" data-icon="inline-start" />
          Comment
        </Button>
      )}
    </DockMotion>
  )
}

/**
 * Composer for units outside the human-required lane: Request changes on a
 * suggested unit (overrides the agent's approval, goes to the implementer)
 * or a Comment on an agentic or static unit (context for its next cycle).
 */
function DockLaneComposer({ unit }: { unit: ReviewDeskData["unit"] }) {
  const mode = useNeuveMode()
  const pending = useAtomValue(decisionPendingAtom)
  const draft = useAtomValue(draftAtom)
  const setDraft = useSetAtom(draftAtom)
  const cancel = useSetAtom(resetDockAtom)
  const sendChanges = useSetAtom(sendChangesAtom)
  const sendComment = useSetAtom(sendUnitCommentAtom)
  const suggested = unit.lane === "human-suggested"
  const liveStatic = mode === "live" && unit.lane === "static-automation"
  const title = suggested
    ? "Request changes on this unit"
    : "Comment on this unit"
  const landing = useComposerRoot(
    useDockLanding(pickText, "composing", unit.id)
  )
  const onKeyDown = useComposerEscape(cancel, unit.id)
  return (
    <DockMotion
      key="composing"
      ref={landing}
      role="dialog"
      aria-label={title}
      onKeyDown={onKeyDown}
      className={cn(
        "box-border flex w-[min(560px,calc(100vw-64px))] flex-col gap-2.5 rounded-[14px] bg-surface px-4 py-3.5",
        DOCK_SHADOW
      )}
    >
      <span className="flex items-baseline gap-2">
        <span className="text-sm font-semibold">{title}</span>
        <span className="text-xs text-ink-muted">
          {suggested
            ? unit.attribution?.outcome === "approved"
              ? "Overrides the agent’s approval"
              : "Adds your request for changes"
            : "Adds context for this unit’s next cycle"}
        </span>
      </span>
      <label htmlFor="dock-lane-comment" className="sr-only">
        {suggested ? "What needs to change" : "Comment"}
      </label>
      <Textarea
        id="dock-lane-comment"
        rows={3}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="What should the next cycle know?"
        aria-keyshortcuts="Meta+Enter"
        className={cn(
          DOCK_TEXT,
          "min-h-[68px] resize-none rounded-[10px] border-0 bg-raised px-3 py-2.5 text-[13.5px] leading-5 text-ink shadow-none focus-visible:ring-0 md:text-[13.5px] dark:bg-raised"
        )}
      />
      <span className="flex justify-end gap-2">
        <Button
          type="button"
          variant="quiet"
          size="dock"
          className="h-[34px] px-3 font-normal"
          data-dock-step="rest"
          onClick={cancel}
        >
          Cancel
        </Button>
        {liveStatic && (
          <Button
            type="button"
            variant="quiet"
            size="dock"
            className="h-[34px] px-3 font-normal"
            disabled={pending}
            data-dock-step="decided"
            onClick={sendChanges}
          >
            Request changes
          </Button>
        )}
        <Button
          type="button"
          variant="ink"
          size="dock"
          className="h-[34px]"
          disabled={liveStatic && pending}
          data-dock-step="decided"
          onClick={suggested ? sendChanges : sendComment}
        >
          {suggested ? "Send to implementer" : "Add comment"}
        </Button>
      </span>
    </DockMotion>
  )
}

/**
 * The dock is dark in both themes, so its result badges use the dock badge
 * tokens (dark-theme lane inks, Polish.dc.html), not the page's lane inks.
 */
const DOCK_TONE = {
  approved: "bg-dock-ok-tint text-dock-ok",
  changes: "bg-dock-req-tint text-dock-req",
} as const

const DECIDED: Record<
  Exclude<DockState, "rest" | "composing">,
  { text: string; icon: LucideIcon; tone: string }
> = {
  approved: {
    text: "You approved this unit",
    icon: CheckIcon,
    tone: DOCK_TONE.approved,
  },
  // Agree records an approval (user decision D1, round 3.1).
  agreed: {
    text: "You approved this unit",
    icon: CheckIcon,
    tone: DOCK_TONE.approved,
  },
  "changes-requested": {
    text: "You requested changes",
    icon: CornerUpLeftIcon,
    tone: DOCK_TONE.changes,
  },
  commented: {
    text: "Comment added as context",
    icon: MessageCircleIcon,
    tone: "bg-dock-line text-dock-fg",
  },
}

/**
 * At Guided the decided state says where the decision started (round-4.md
 * "States"); the reader is the actor either way.
 */
const ORIGIN_TEXT: Record<
  DockOrigin,
  Partial<Record<Exclude<DockState, "rest" | "composing">, string>>
> = {
  suggestion: {
    "changes-requested":
      "Changes requested · suggested by the harness, sent by you",
    approved: "Approved · suggested by the harness, sent by you",
  },
  "against-suggestion": {
    approved: "Approved · against the suggested review",
    "changes-requested": "Changes requested · against the suggested review",
  },
}

/**
 * Decided (Polish.dc.html): what you did, Undo, and the next unit that still
 * needs a decision. "Back to batch" only when none remains. On a phone
 * (600px and narrower) what you did takes the first row and Undo and the
 * way on the second, so the bar fits a 320px screen.
 */
function DockDecided({
  unitId,
  nextUnitId,
  backTo,
}: {
  unitId: string
  nextUnitId?: string
  backTo: NeuveDestination
}) {
  const dock = useAtomValue(dockAtom)
  const undo = useSetAtom(undoDecisionAtom)
  const live = useAtomValue(decisionSinkAtom)
  const receipt = useAtomValue(decisionReceiptAtom)
  const pending = useAtomValue(decisionPendingAtom)
  const startSwitch = useStartUnitSwitch(unitId)
  const canUndo = !pending && (!live || receipt?.kind === "disposition")
  const origin = useAtomValue(dockOriginAtom)
  const landing = useDockLanding(pickWayOn, "decided", unitId)
  if (dock === "rest" || dock === "composing") return null
  const decided = DECIDED[dock]
  const text = (origin && ORIGIN_TEXT[origin][dock]) ?? decided.text
  return (
    <DockMotion
      key="decided"
      ref={landing}
      role="status"
      data-surface="inverse"
      className={cn(
        DOCK_BAR,
        "gap-2.5 pl-2 max-[600px]:grid max-[600px]:grid-cols-[auto_minmax(0,1fr)] max-[600px]:gap-y-1.5 max-[600px]:pt-2.5"
      )}
    >
      <DockBody />
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex size-[22px] items-center justify-center rounded-md",
          decided.tone
        )}
      >
        <decided.icon className="size-3" strokeWidth={2.25} />
      </span>
      <span className="text-[13px] font-medium max-[600px]:pr-1.5">{text}</span>
      <span
        aria-hidden="true"
        className="h-[18px] w-px bg-dock-line max-[600px]:hidden"
      />
      <span className="contents max-[600px]:col-span-full max-[600px]:flex max-[600px]:justify-end max-[600px]:gap-1.5">
        {/* A recorded comment cannot be withdrawn: no Undo after one. */}
        {(!live || receipt?.kind !== "comment") && (
          <Button
            type="button"
            variant="dock-ghost"
            size="dock"
            disabled={!canUndo}
            data-dock-step="rest"
            onClick={undo}
          >
            Undo
          </Button>
        )}
        <Button asChild variant="dock-primary" size="dock">
          <NeuveLink
            data-dock-way-on=""
            destination={
              nextUnitId ? { to: "unit", unitId: nextUnitId } : backTo
            }
            onClick={nextUnitId ? startSwitch(nextUnitId) : undefined}
          >
            {nextUnitId ? "Next unit" : "Back to batch"}
            <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />
          </NeuveLink>
        </Button>
      </span>
    </DockMotion>
  )
}

/**
 * The dock root's ref: publishes its height (measureDock) and ends a
 * pending hand-off that can no longer be taken: when a decision ends
 * without reaching the asked-for state (an error or an early return), when
 * focus moves outside the dock, and on a unit switch (the ref is per unit,
 * so a switch re-attaches it), which also drops parked drafts from other
 * units.
 */
function useDockGuards(unitId: string) {
  const store = useStore()
  return React.useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return
      const stopMeasuring = measureDock(node)
      const end = () => store.set(dockFocusAtom, null)
      if (store.get(dockFocusAtom)?.unitId !== unitId) end()
      const parked = store.get(parkedDockDraftsAtom)
      store.set(
        parkedDockDraftsAtom,
        Object.fromEntries(
          Object.entries(parked).filter(([, draft]) => draft.unitId === unitId)
        )
      )
      // A decision that ends (pending true → false) without reaching the
      // state its step asked for leaves nothing behind. Today every pending
      // path in submitDecisionAtom either reaches its target or sets an
      // error (ended below), so this never fires on its own; it is the
      // general rule for a future early return that does neither. Keep it.
      let wasPending = store.get(decisionPendingAtom)
      const stopPending = store.sub(decisionPendingAtom, () => {
        const isPending = store.get(decisionPendingAtom)
        const request = store.get(dockFocusAtom)
        if (
          wasPending &&
          !isPending &&
          request &&
          request.to !== kindOf(store.get(dockAtom))
        )
          end()
        wasPending = isPending
      })
      const stopError = store.sub(decisionErrorAtom, () => {
        if (store.get(decisionErrorAtom)) end()
      })
      const doc = node.ownerDocument
      const onFocusIn = (event: FocusEvent) => {
        if (!node.contains(event.target as Node)) end()
      }
      doc.addEventListener("focusin", onFocusIn, true)
      return () => {
        stopMeasuring?.()
        stopPending()
        stopError()
        doc.removeEventListener("focusin", onFocusIn, true)
      }
    },
    [store, unitId]
  )
}

/**
 * Publishes the dock's height to the desk's scroll container as
 * `--nv-dock-h`, so the container's scroll padding keeps landings, keyboard
 * focus and selections clear of the dock (round 3, item 11). A ref callback
 * owns the ResizeObserver, so no effect is needed.
 */
function measureDock(node: HTMLDivElement | null) {
  const scroller = node?.closest<HTMLElement>("[data-desk-scroll]")
  if (!node || !scroller || typeof ResizeObserver === "undefined") return
  const observer = new ResizeObserver(([entry]) => {
    if (!entry) return
    const height = entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height
    scroller.style.setProperty("--nv-dock-h", `${Math.ceil(height)}px`)
  })
  observer.observe(node)
  return () => {
    observer.disconnect()
    scroller.style.removeProperty("--nv-dock-h")
  }
}

const DOCK_TRANSITION = regionTransition("desk-dock", 3)

/**
 * Sticky decision dock at the bottom of the unit. It is the only place a
 * disposition is made, always per unit (never per lane), and it states its
 * scope: this unit's hunks, never the read-only neighbor. Suggested units
 * take Agree / Request changes; agentic and static units take a Comment.
 *
 * It stays in flow at the end of the unit, so when the unit is scrolled to
 * its end the last code line sits a 24px gap above it (the content's bottom
 * padding); while scrolling it floats over the code and the scroll padding
 * keeps targets clear of it.
 */
export function DecisionDock({
  unit,
  markers,
  nextUnitId,
  backTo = { to: "overview" },
  suggestion,
  deliveryGlyph,
}: {
  nextUnitId?: string
  /** Where "Back to batch" goes: this unit's batch. */
  backTo?: NeuveDestination
  /**
   * Review delivery's glyph and dial (round 7): every rest dock shows it at
   * its left while the title's glyph is out of view, on every lane and at
   * every stop. The lane still decides the dock's actions.
   */
  deliveryGlyph?: React.ReactNode
  /**
   * The suggested disposition at Guided. The desk passes it only for a
   * human-required unit; every other lane keeps its own dock.
   */
  suggestion?: DeliverySuggestion
  unit: ReviewDeskData["unit"]
  markers: Record<string, ContextualMarker>
}) {
  const dock = useAtomValue(dockAtom)
  const feedbackKind = useAtomValue(unitFeedbackKindAtom)
  const store = useStore()
  const guards = useDockGuards(unit.id)
  const human = unit.lane === "human-required"
  const pending = unit.lane === undefined
  return (
    <div
      ref={guards}
      {...DOCK_TRANSITION}
      // A dock step hands focus to the state it leads to (see
      // dockFocusAtom). A click from a key has detail 0; a pointer click
      // counts presses.
      onClickCapture={(event) => {
        const step = (event.target as Element).closest<HTMLElement>(
          "[data-dock-step]"
        )
        if (!step || step.matches(":disabled")) return
        handOff(store, {
          keyboard: event.detail === 0,
          unitId: unit.id,
          to: step.dataset.dockStep as DockKind,
        })
        const opener = step.dataset.dockOpener
        if (opener) store.set(dockOpenerAtom, opener)
      }}
      // After an opener's own handler: if it opened the composer, it gets
      // back the draft Escape set aside from it on this unit.
      onClick={(event) => {
        const opener = (event.target as Element).closest<HTMLElement>(
          "[data-dock-step]"
        )?.dataset.dockOpener
        const parked = opener
          ? store.get(parkedDockDraftsAtom)[opener]
          : undefined
        if (!opener || !parked || store.get(dockAtom) !== "composing") return
        const { [opener]: _restored, ...rest } = store.get(parkedDockDraftsAtom)
        store.set(parkedDockDraftsAtom, rest)
        if (parked.unitId === unit.id) store.set(draftAtom, parked.text)
      }}
      // ⌘↵ in the dock sends or decides: the decided state takes focus.
      onKeyDownCapture={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
          handOff(store, { keyboard: true, unitId: unit.id, to: "decided" })
      }}
      // The desk drops its scroll padding while focus is anywhere in here
      // (review-desk-screen.tsx). The padding keeps landings clear of the
      // dock, but it covers the dock's own controls too, so the browser's
      // focus and caret reveal would scroll the desk to uncover them: Tab
      // from a composer to its Cancel, or each keystroke in its text.
      data-decision-dock=""
      // With the delivery glyph's beats and sizes, for the bar and its
      // extension.
      style={{ ...DOCK_TRANSITION.style, ...DOCK_GLYPH_VARS }}
      className="sticky bottom-5 z-10 mx-8 mt-auto mb-5 max-w-[calc(100%-64px)] self-center"
    >
      <AnimatePresence mode="wait">
        {dock === "rest" &&
          (human && suggestion ? (
            <DockSuggestedRest
              key="rest-suggested"
              unit={unit}
              suggestion={suggestion}
              deliveryGlyph={deliveryGlyph}
            />
          ) : human || pending ? (
            <DockRest key="rest" unit={unit} deliveryGlyph={deliveryGlyph} />
          ) : (
            <DockLaneRest
              key="rest"
              unit={unit}
              deliveryGlyph={deliveryGlyph}
            />
          ))}
        {dock === "composing" &&
          (human || (pending && feedbackKind === "request-changes") ? (
            <DockComposer key="composing" unit={unit} markers={markers} />
          ) : (
            <DockLaneComposer key="composing" unit={unit} />
          ))}
        {dock !== "rest" && dock !== "composing" && (
          <DockDecided
            key="decided"
            unitId={unit.id}
            nextUnitId={nextUnitId}
            backTo={backTo}
          />
        )}
      </AnimatePresence>
    </div>
  )
}
