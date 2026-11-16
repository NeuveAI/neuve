import * as React from "react"
import { atom, useAtomValue, useSetAtom } from "jotai"
import { AnimatePresence } from "motion/react"

import {
  DELIVERY_STOPS,
  DELIVERY_STOP_LABEL,
  offeredStops,
  useDeliverySettings,
} from "@workspace/ui/neuve/shared/delivery"
import type {
  DeliveryPayload,
  DeliveryStop,
} from "@workspace/ui/neuve/shared/delivery"
import { usePhased } from "@workspace/ui/neuve/review-desk/delivery/delivery-choreography"
import { DeliveryTitleDial } from "@workspace/ui/neuve/review-desk/delivery/delivery-title-dial"
import { DeliveryDockDial } from "@workspace/ui/neuve/review-desk/delivery/delivery-dock-dial"
import { BAR_CHAIN } from "@workspace/ui/neuve/review-desk/delivery/delivery-glyph-shared"
import {
  PhasedLayer,
  layoutTop,
  morphBeatAtom,
} from "@workspace/ui/neuve/review-desk/delivery/phased-layer"
import { useDeliveryMotion } from "@workspace/ui/neuve/review-desk/delivery/delivery-motion"
import {
  deliveryAnchorAtom,
  deliveryGlyphFocusAtom,
  deliveryMoveAtom,
  deliveryTitleAwayAtom,
  setUnitDeliveryStopAtom,
} from "@workspace/ui/neuve/review-desk/delivery/delivery-state"
import {
  CriteriaCard,
  reviewCardCarriesCheck,
} from "@workspace/ui/neuve/review-desk/delivery/criteria-card"
import { FlowCard } from "@workspace/ui/neuve/review-desk/delivery/flow-card"
import { TermsCard } from "@workspace/ui/neuve/review-desk/delivery/terms-card"
import type {
  ContextualMarker,
  ReviewDeskData,
  Reviewer,
} from "@workspace/ui/neuve/types"

/** Stage indices (the storyboard's one integer). */
export const STAGE = {
  facts: DELIVERY_STOPS.indexOf("facts"),
  briefed: DELIVERY_STOPS.indexOf("briefed"),
  explained: DELIVERY_STOPS.indexOf("explained"),
  guided: DELIVERY_STOPS.indexOf("guided"),
} as const

/** Guided shows its check only with rows behind it. */
export function guidedCheck(payload: DeliveryPayload) {
  return payload.check && payload.check.criteria.length > 0
    ? payload.check
    : undefined
}

/**
 * Guided always has a basis: the ticket's "Done when", else its scope, else
 * a scope the harness gathered (round-4.md, "Scope is always gathered"). A
 * unit with no Guided rows is a contract error. Its payload's `stops` leave
 * Guided out, so a reader whose setting or override asks for Guided sees a
 * shallower stop (the clamp); a payload that offers Guided anyway shows it
 * with the diff kept. Either way the desk logs it here, once per unit, so a
 * review that arrives without Guided rows is noticed.
 */
function useReportMissingCheck(
  unitId: string,
  askedGuided: boolean,
  hasCheck: boolean,
  shown: DeliveryStop
) {
  // Effect: reports a contract error to the console (an external system) once per unit while the reader asks for Guided and it has no check.
  React.useEffect(() => {
    if (!askedGuided || hasCheck) return
    console.error(
      `Review delivery contract error: unit ${unitId} has no Guided check (round-4.md, "Scope is always gathered"); showing ${DELIVERY_STOP_LABEL[shown]}.`
    )
  }, [unitId, askedGuided, hasCheck, shown])
}

/**
 * The desk dial's pick, as one write: when the reader is reading the diff
 * below the layers (its top scrolled past), remember where, so the layers
 * opening or closing above don't move their line; then set this unit's stop.
 */
export const pickDeliveryStopAtom = atom(
  null,
  (_get, set, input: Parameters<typeof setUnitDeliveryStopAtom.write>[2]) => {
    const diff = document.querySelector<HTMLElement>(DIFF_ANCHOR)
    const top = diff?.getBoundingClientRect().top
    set(
      deliveryAnchorAtom,
      diff && top !== undefined && top < diffViewportTop(diff)
        ? { unitId: input.unitId, top }
        : null
    )
    set(setUnitDeliveryStopAtom, input)
  }
)

/**
 * Review delivery in the desk's title (round 6, B): the glyph after the h1
 * and the dial it opens. It writes this unit's override; moving back to the
 * workspace's stop clears it.
 */
export function DeliveryTitleGlyph({
  unitId,
  payload,
  stop,
  flow,
}: {
  unitId: string
  payload: DeliveryPayload
  stop: DeliveryStop
  /**
   * The desk's scroll column: what the inline dial pushes, and (as the
   * dial's default boundary) the room it may float beside the title in.
   */
  flow: React.RefObject<HTMLElement | null>
}) {
  const pick = useSetAtom(pickDeliveryStopAtom)
  const settings = useDeliverySettings()
  const setAway = useSetAtom(deliveryTitleAwayAtom)
  const setHandOff = useSetAtom(deliveryGlyphFocusAtom)
  // Round 7: while this glyph is out of view the dock shows its own; focus
  // that was in this dial goes to the dock's glyph as it arrives.
  const onAway = React.useCallback(
    (away: boolean, focus: { ring: boolean } | null) => {
      setHandOff(away && focus ? { to: "dock", ring: focus.ring } : null)
      setAway(away)
    },
    [setAway, setHandOff]
  )
  return (
    <DeliveryTitleDial
      className="ml-2"
      value={stop}
      barDelay={BAR_CHAIN}
      flow={flow}
      onAway={onAway}
      offered={offeredStops(payload)}
      onChange={(next) =>
        pick({
          unitId,
          language: payload.language,
          stop: next,
          settings,
          offered: offeredStops(payload),
        })
      }
    />
  )
}

/**
 * Review delivery in the decision dock (round 7, B): the title's glyph and
 * dial, at the dock's left while the title's glyph is out of view. The same
 * stop and the same pick as the title's, so the two never disagree.
 */
export function DeliveryDockGlyph({
  unitId,
  payload,
  stop,
}: {
  unitId: string
  payload: DeliveryPayload
  stop: DeliveryStop
}) {
  const pick = useSetAtom(pickDeliveryStopAtom)
  const settings = useDeliverySettings()
  const away = useAtomValue(deliveryTitleAwayAtom)
  return (
    <DeliveryDockDial
      shown={away}
      value={stop}
      offered={offeredStops(payload)}
      onChange={(next) =>
        pick({
          unitId,
          language: payload.language,
          stop: next,
          settings,
          offered: offeredStops(payload),
        })
      }
    />
  )
}

/**
 * One layer of the stack under the phased choreography: it steps into or out
 * of layout at the stack's morph and fades by blocks around it
 * (delivery-choreography.ts).
 */
function Layer({
  name,
  className,
  children,
}: {
  /** The layer's key, for evidence and plays. */
  name: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <PhasedLayer params={usePhased()} name={name} className={className}>
      {children}
    </PhasedLayer>
  )
}

/**
 * The layers between the briefing and the diff: a designed flow + terms
 * (Explained), the flow + the check against the ticket (Guided). Leaving
 * layers fade where they are and stop taking room at the stack's morph; the
 * flow card stays put from Explained to Guided.
 */
export function DeliveryLayers({
  unit,
  payload,
  stage,
  asked,
  markers,
  reviewer,
}: {
  unit: ReviewDeskData["unit"]
  payload: DeliveryPayload
  stage: number
  /** The stop the reader's override or setting asked for (useDeliveryStop). */
  asked: DeliveryStop
  markers: Record<string, ContextualMarker>
  /** The reader, for the sent suggested review's avatar. */
  reviewer: Reviewer
}) {
  const check = guidedCheck(payload)
  useReportMissingCheck(
    unit.id,
    asked === "guided",
    check !== undefined,
    DELIVERY_STOPS[stage]!
  )
  const showFlow = stage >= STAGE.explained && payload.flow
  const showTerms =
    stage === STAGE.explained && payload.terms && payload.terms.length > 0
  // Human-suggested units with an agent review: the briefing's review card
  // carries the rows behind "Why" (Option A), so no check layer here.
  const showCheck =
    stage === STAGE.guided && check && !reviewCardCarriesCheck(unit)
  // The harness's own Explained prose (10.60) is the briefing's: each
  // change's Before beside its After, in its row.
  if (!payload.flow && !payload.terms?.length && !check) return null
  return (
    <div className="flex max-w-[calc(980px+64px)] flex-col px-8 narrow:px-4">
      {/* auto-fill keeps the flow's column when the terms leave. */}
      {/* Each card keeps its own height, so one leaving never resizes the other. */}
      <div className="relative grid grid-cols-[repeat(auto-fill,minmax(min(340px,100%),1fr))] items-start gap-x-3">
        <AnimatePresence initial={false}>
          {showFlow && (
            <Layer key="flow" name="flow" className="pt-[18px]">
              <FlowCard
                flow={payload.flow!}
                unitId={unit.id}
                lands={stage < STAGE.guided}
              />
            </Layer>
          )}
          {showTerms && (
            <Layer key="terms" name="terms" className="pt-[18px]">
              <TermsCard
                terms={payload.terms!}
                unitId={unit.id}
                languageName={payload.languageName}
              />
            </Layer>
          )}
        </AnimatePresence>
      </div>
      <div className="relative">
        <AnimatePresence initial={false}>
          {showCheck && (
            <Layer key="check" name="check" className="pt-3">
              <CriteriaCard
                check={check}
                unit={unit}
                markers={markers}
                reviewer={reviewer}
              />
            </Layer>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

/** The diff region's stable wrapper (present while delivery is on). */
const DIFF_ANCHOR = "[data-delivery-diff]"

/** The top of the reader's view: the desk's scroll container, or the page. */
function scrollerOf(element: HTMLElement): HTMLElement | null {
  const desk = element.closest<HTMLElement>("[data-desk-scroll]")
  return desk && desk.scrollHeight > desk.clientHeight ? desk : null
}

function diffViewportTop(element: HTMLElement) {
  return scrollerOf(element)?.getBoundingClientRect().top ?? 0
}

/**
 * The diff region (toolbar, files, neighbor, and with them the margin)
 * under delivery: one phased layer that leaves at Guided and returns from
 * it; the stack's morph moves it when the layers above change.
 */
export function DeliveryDiff({
  unitId,
  show,
  stage,
  children,
}: {
  unitId: string
  show: boolean
  stage: number
  children: React.ReactNode
}) {
  const phased = usePhased()
  const mode = useDeliveryMotion()
  const move = useAtomValue(deliveryMoveAtom)
  const beat = useAtomValue(morphBeatAtom)
  const anchor = useAtomValue(deliveryAnchorAtom)
  const setAnchor = useSetAtom(deliveryAnchorAtom)
  const ref = React.useRef<HTMLDivElement>(null)
  /** The reader's line, kept for the move's beat (full and reduced motion). */
  const pending = React.useRef<{ top: number; move: object | null } | null>(
    null
  )
  /**
   * Scrolls so the diff's top is at `top`: where it shows now, or (`laid`)
   * where it is laid out, so a morph still running from the previous change
   * doesn't leave the line off by what it had left to travel.
   */
  const restore = React.useCallback((top: number, laid = false) => {
    const wrapper = ref.current
    if (!wrapper) return
    const now = laid ? layoutTop(wrapper) : wrapper.getBoundingClientRect().top
    const delta = now - top
    if (delta === 0) return
    const scroller = scrollerOf(wrapper)
    if (scroller) scroller.scrollTop += delta
    else window.scrollBy(0, delta)
  }, [])
  // Effect: restores the reader's scroll position (the DOM's scroll offset, an external system) after the layers above the diff changed height.
  React.useLayoutEffect(() => {
    if (!anchor || anchor.unitId !== unitId) return
    setAnchor(null)
    // Under full and reduced motion the layers step into and out of layout
    // at the move's beat (the morph, or the reduced swap), not at this
    // commit: the line is restored again then.
    pending.current =
      show && mode !== "instant" ? { top: anchor.top, move } : null
    if (show) restore(anchor.top)
  }, [stage, anchor, unitId, show, mode, move, setAnchor, restore])
  // Effect: restores the reader's scroll position (the DOM's scroll offset, an external system) at the morph beat, before the stack measures its new layout (this child's layout effect runs first).
  React.useLayoutEffect(() => {
    const line = pending.current
    if (!line || beat.move !== line.move) return
    pending.current = null
    restore(line.top, true)
  }, [beat, restore])
  return (
    <div ref={ref} data-delivery-diff="" className="relative">
      <AnimatePresence initial={false}>
        {show && (
          <PhasedLayer key="diff" name="diff" params={phased}>
            {children}
          </PhasedLayer>
        )}
      </AnimatePresence>
    </div>
  )
}
