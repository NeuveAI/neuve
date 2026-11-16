import * as React from "react"
import { atom, useAtomValue, useAtomValueRawSync, useStore } from "jotai"
import {
  PresenceContext,
  animate,
  motionValue,
  usePresence,
} from "motion/react"
import type { MotionValue, ValueTransition } from "motion/react"

import { EASE, REDUCED_TRANSITION, TIMING, ms } from "@workspace/ui/lib/motion"
import { cn } from "@workspace/ui/lib/utils"
import {
  blockExit,
  enterDelay,
  leaveTimeline,
  morphTransition,
  timeToReach,
} from "@workspace/ui/neuve/review-desk/delivery/delivery-choreography"
import type { PhasedParams } from "@workspace/ui/neuve/review-desk/delivery/delivery-choreography"
import { useDeliveryMotion } from "@workspace/ui/neuve/review-desk/delivery/delivery-motion"
import type { DeliveryMotion } from "@workspace/ui/neuve/review-desk/delivery/delivery-motion"
import { deliveryMoveAtom } from "@workspace/ui/neuve/review-desk/delivery/delivery-state"

/** Marks a block: the unit the phased choreography staggers. */
export const BLOCK = "data-choreo-block"

/**
 * Spread on a block element. Elements that share a `group` move as one block
 * (a flow row's label and its items).
 */
export function blockProps(group = "") {
  return { [BLOCK]: group }
}

/**
 * The stop change the layers below belong to, when it isn't the desk's
 * (the settings preview: one object per stop it shows).
 */
export const DeliveryMoveContext = React.createContext<object | null>(null)

/** A layer's blocks in reading order; without marked blocks, its content. */
function blocksOf(content: HTMLElement): Array<Array<HTMLElement>> {
  const found = Array.from(content.querySelectorAll<HTMLElement>(`[${BLOCK}]`))
  if (found.length === 0) return [[content]]
  const blocks: Array<Array<HTMLElement>> = []
  const groups = new Map<string, Array<HTMLElement>>()
  for (const element of found) {
    const group = element.getAttribute(BLOCK) ?? ""
    const shared = group ? groups.get(group) : undefined
    if (shared) shared.push(element)
    else {
      const block = [element]
      blocks.push(block)
      if (group) groups.set(group, block)
    }
  }
  return blocks
}

/* ─── Opacity and rise on motion values (motion's JS clock) ───────────── */

interface Values {
  opacity: MotionValue<number>
  y: MotionValue<number>
}

const elementValues = new WeakMap<HTMLElement, Values>()

function valuesOf(element: HTMLElement): Values {
  let values = elementValues.get(element)
  if (!values) {
    const shown = Number.parseFloat(getComputedStyle(element).opacity)
    const opacity = motionValue(Number.isNaN(shown) ? 1 : shown)
    const y = motionValue(0)
    const write = () => {
      element.style.opacity = `${opacity.get()}`
      element.style.transform = y.get() ? `translateY(${y.get()}px)` : ""
    }
    opacity.on("change", write)
    y.on("change", write)
    values = { opacity, y }
    elementValues.set(element, values)
  }
  return values
}

/** The row gap a flex or grid parent puts between its children (px). */
function rowGap(parent: HTMLElement | null) {
  if (!parent) return 0
  return Number.parseFloat(getComputedStyle(parent).rowGap) || 0
}

function place(elements: Array<HTMLElement>, opacity: number, y: number) {
  for (const element of elements) {
    const values = valuesOf(element)
    values.opacity.jump(opacity)
    values.y.jump(y)
    element.style.opacity = `${opacity}`
    element.style.transform = y ? `translateY(${y}px)` : ""
  }
}

interface Run {
  stop: () => void
  finished: Promise<unknown>
}

function fadeTo(
  elements: Array<HTMLElement>,
  opacity: number,
  fade: ValueTransition,
  rise?: ValueTransition
): Run {
  const runs = elements.flatMap((element) => {
    const values = valuesOf(element)
    return [
      animate(values.opacity, opacity, fade),
      ...(rise ? [animate(values.y, 0, rise)] : []),
    ]
  })
  return {
    stop: () => runs.forEach((run) => run.stop()),
    finished: Promise.all(runs.map((run) => run.finished)),
  }
}

/* ─── The morph: one size change for the whole stack, per change ──────── */

/** The stack as it looked when a morph was asked for (visual, px). */
interface StackShape {
  /** The stack's top in the viewport. */
  top: number
  height: number
  /** Each child's top in the viewport. */
  tops: Array<number>
}

/**
 * The stack's morph beat: the curve, and the stack's shape just before the
 * change went into layout. The stack runs one FLIP from that shape to its
 * new layout when the beat changes.
 */
export const morphBeatAtom = atom<{
  n: number
  /** The move (stop change) this beat belongs to. */
  move: object | null
  transition: ValueTransition
  from: StackShape | null
  /** Told, once the new layout is measured, whether the stack moves. */
  arrivals: Array<(moves: boolean) => void>
}>({ n: 0, move: null, transition: {}, from: null, arrivals: [] })

/**
 * An element's top in the viewport as laid out, without a running morph's
 * transforms (the stack's and its children's): where it will be once that
 * morph ends.
 */
export function layoutTop(element: HTMLElement) {
  const stack = element.closest<HTMLElement>("[data-delivery-stack]")
  if (!stack?.style.transform) return element.getBoundingClientRect().top
  const moved = [stack, ...(Array.from(stack.children) as Array<HTMLElement>)]
  const kept = moved.map((part) => part.style.transform)
  for (const part of moved) part.style.transform = ""
  const top = element.getBoundingClientRect().top
  moved.forEach((part, index) => (part.style.transform = kept[index]!))
  return top
}

/** The stack's visual shape now (transforms included: a morph in flight). */
function shapeOf(stack: HTMLElement): StackShape {
  const box = stack.getBoundingClientRect()
  return {
    top: box.top,
    height: box.height,
    tops: Array.from(
      stack.children,
      (child) => child.getBoundingClientRect().top
    ),
  }
}

/**
 * One stop change's morph. Leaving layers record when their last block is
 * out; once the commit's effects have run, the morph is scheduled for the
 * latest of those, less the overlap, and fires once: every layer's hook,
 * then the beat, in one store update (one render, one layout measurement).
 */
interface Morph {
  /** Arriving layers' block starts, told whether the stack moves. */
  arrivals: Array<(moves: boolean) => void>
  /** Ms after the fades begin at which the last leaving block is out. */
  out: number
  hooks: Set<() => void>
  scheduled: boolean
}

const morphs = new WeakMap<object, Morph>()
const NO_MOVE = {}

function morphOf(move: object | null): Morph {
  const key = move ?? NO_MOVE
  let morph = morphs.get(key)
  if (!morph) {
    morph = { out: 0, hooks: new Set(), scheduled: false, arrivals: [] }
    morphs.set(key, morph)
  }
  return morph
}

function scheduleMorph(
  morph: Morph,
  params: PhasedParams,
  stack: () => HTMLElement | null,
  beat: (
    transition: ValueTransition,
    from: StackShape | null,
    arrivals: Array<(moves: boolean) => void>
  ) => void
) {
  if (morph.scheduled) return
  morph.scheduled = true
  // On the next frame, when the leaving fades actually begin (motion starts
  // them on its frame loop), after every effect of this commit has recorded
  // its leave.
  requestAnimationFrame(() => {
    const wait = Math.max(0, morph.out - params.overlap)
    window.setTimeout(() => {
      morph.scheduled = false
      if (morph.hooks.size === 0) return
      const hooks = [...morph.hooks]
      morph.hooks.clear()
      morph.out = 0
      // The old shape, before any layer steps in or out.
      const element = stack()
      const from = element ? shapeOf(element) : null
      for (const hook of hooks) hook()
      const arrivals = morph.arrivals
      morph.arrivals = []
      beat(morphTransition(params.morph), from, arrivals)
    }, wait)
  })
}

/**
 * waiting: arriving, not in layout yet; in: in layout; popped: leaving,
 * taking no room but still fading where it was.
 */
type Place =
  | { kind: "waiting" }
  | { kind: "in" }
  | { kind: "popped"; height: number; gap: number }

const WAITING: Place = { kind: "waiting" }
const IN: Place = { kind: "in" }

function placeStyle(where: Place): React.CSSProperties | undefined {
  if (where.kind === "waiting") return { display: "none" }
  // Still in flow (same box, same width), but taking no room: what follows
  // slides over it while it finishes fading.
  if (where.kind === "popped")
    return {
      height: where.height,
      // Its own height, and the gap a flex or grid parent puts after it.
      marginBottom: -(where.height + where.gap),
      overflow: "clip",
      pointerEvents: "none",
    }
  return undefined
}

interface Latest {
  params: PhasedParams
  mode: DeliveryMotion
  move: object | null
}

interface Running {
  token: number
  runs: Array<Run>
  /** Leaves the morph this layer joined, if it hasn't fired. */
  unhook?: () => void
}

function stopAll(running: Running) {
  for (const run of running.runs) run.stop()
  running.runs = []
  running.unhook?.()
  running.unhook = undefined
}

/**
 * One layer under the phased choreography, as a direct child of an
 * AnimatePresence in "sync" mode. It never animates its own size: it steps
 * into or out of layout at the stack's morph, while it is unseen, and fades
 * by blocks around it. The card itself fades with the first block in
 * reading order.
 */
export function PhasedLayer({
  params,
  name,
  className,
  children,
}: {
  params: PhasedParams
  /** For evidence and plays: data-choreo-layer. */
  name: string
  className?: string
  children: React.ReactNode
}) {
  const mode = useDeliveryMotion()
  const deskMove = useAtomValue(deliveryMoveAtom)
  const move = React.useContext(DeliveryMoveContext) ?? deskMove
  const store = useStore()
  const [isPresent, safeToRemove] = usePresence()
  // The latest removal callback: AnimatePresence hands a new one whenever it
  // re-renders (a morph beat re-renders the diff's), and that must not re-run
  // the choreography (a leaving layer's fade would restart from where it is).
  const remove = React.useRef(safeToRemove)
  // Present on its AnimatePresence's first render (initial={false}): in.
  const firstRender = React.useRef(
    React.useContext(PresenceContext)?.initial === false
  )
  // Full and reduced motion step in at the change's beat (the morph, or
  // reduced motion's swap). Instant layers are in layout from their first
  // render.
  const startsIn = React.useRef(firstRender.current || mode === "instant")
  const placeAtom = React.useMemo(
    () => atom<Place>(startsIn.current ? IN : WAITING),
    []
  )
  // Raw sync: sees a place set during the mount's own layout effect (jotai 3's
  // useAtomValue can miss a set made before its subscription).
  const placed = useAtomValueRawSync(placeAtom)
  const frame = React.useRef<HTMLDivElement>(null)
  const content = React.useRef<HTMLDivElement>(null)
  const running = React.useRef<Running>({ token: 0, runs: [] })
  const latest = React.useRef<Latest>({ params, mode, move })
  const mounted = React.useRef(false)
  // Effect: hands the latest tuned values and removal callback to the running choreography (motion's imperative animations, an external system) without restarting it.
  React.useLayoutEffect(() => {
    latest.current = { params, mode, move }
    remove.current = safeToRemove
  }, [params, mode, move, safeToRemove])

  // Effect: drives this layer's place (jotai, measured by motion at the morph) and its fades (motion's imperative animate, an external system) when AnimatePresence adds or removes it.
  React.useLayoutEffect(() => {
    const card = content.current
    const frameElement = frame.current
    if (!card || !frameElement) return
    const state = running.current
    const fresh = !mounted.current
    mounted.current = true
    const token = ++state.token
    const live = () => state.token === token
    stopAll(state)
    const { params: p, mode: m } = latest.current
    const blocks = blocksOf(card)
    // The card fades with the first block (unless the card is the block).
    const shell = blocks[0]!.includes(card) ? [] : [card]
    const everything = [...shell, ...blocks.flat()]
    const now = store.get(placeAtom)
    const thisMove = latest.current.move
    const beat = (
      transition: ValueTransition,
      from: StackShape | null,
      arrivals: Array<(moves: boolean) => void>
    ) =>
      store.set(morphBeatAtom, (current) => ({
        n: current.n + 1,
        move: thisMove,
        transition,
        from,
        arrivals,
      }))
    const stack = () =>
      frameElement.closest<HTMLElement>("[data-delivery-stack]")
    const morph = morphOf(thisMove)
    const join = (hook: () => void) => {
      morph.hooks.add(hook)
      state.unhook = () => morph.hooks.delete(hook)
    }
    // Arrivals as the canvas: opacity over the fade (TIMING.hint), the rise
    // over TIMING.card, both standard decelerate, from the same moment.
    const fade = (delay: number): ValueTransition => ({
      duration: ms(p.content),
      ease: EASE.standardDecelerate,
      delay: ms(delay),
    })
    const rise = (delay: number): ValueTransition => ({
      duration: ms(TIMING.card),
      ease: EASE.standardDecelerate,
      delay: ms(delay),
    })

    if (isPresent) {
      if (fresh && firstRender.current) return
      if (m === "instant") {
        store.set(placeAtom, IN)
        place(everything, 1, 0)
        return
      }
      if (m === "reduced") {
        // No morph and no phases: in at the swap; contents fade together.
        if (fresh) place(everything, 0, 0)
        if (!fresh && now.kind === "in") {
          state.runs = [fadeTo(everything, 1, REDUCED_TRANSITION)]
          return
        }
        join(() => {
          if (!live()) return
          frameElement.style.transform = ""
          frameElement.style.clipPath = ""
          store.set(placeAtom, IN)
          morph.arrivals.push(() => {
            if (live()) state.runs = [fadeTo(everything, 1, REDUCED_TRANSITION)]
          })
        })
        scheduleSwap(morph, beat)
        return
      }
      if (!fresh && now.kind === "in") {
        // Back before the morph took it out: fade back at once, together.
        state.runs = [fadeTo(everything, 1, fade(0), rise(0))]
        return
      }
      if (fresh) {
        place(shell, 0, 0)
        for (const block of blocks) place(block, 0, p.offset)
      }
      // In at the morph, unseen; blocks from `contentStart` of its travel.
      join(() => {
        if (!live()) return
        store.set(placeAtom, IN)
        // Held at its target place while the stack morphs, so nothing shows
        // past the stack's moving edge (the stack clears it).
        frameElement.setAttribute(ARRIVING, "")
        // Blocks from `contentStart` of the movement, or at once when the
        // stack doesn't move (the stack says which once it has measured).
        morph.arrivals.push((moves) => {
          if (!live()) return
          const { params: q } = latest.current
          const start = moves
            ? timeToReach(morphTransition(q.morph), q.contentStart)
            : 0
          state.runs = blocks.map((block, index) => {
            const delay = start + enterDelay(index, q)
            const elements = index === 0 ? [...shell, ...block] : block
            return fadeTo(elements, 1, fade(delay), rise(delay))
          })
        })
      })
      scheduleMorph(morph, p, stack, beat)
      return
    }

    // Leaving: fade out last-first (fade only); out of layout at the morph;
    // removed once both are done.
    let faded = false
    let out = now.kind !== "in"
    // Removed on a later frame, never inside this layout effect: usePresence
    // registers the exit in a passive effect, and a removal before that is
    // lost (the layer would stay mounted, unseen).
    const finish = () => {
      if (!live() || !faded || !out) return
      requestAnimationFrame(() => {
        if (live()) remove.current?.()
      })
    }
    if (now.kind === "waiting" || m === "instant") {
      faded = true
      out = true
      return finish()
    }
    if (m === "reduced") {
      // No phases: it fades where it was. At the swap it stops taking room
      // (the height snaps once, with the arrivals) and is held at its old
      // place, not moved by what steps in above it.
      const run = fadeTo(everything, 0, REDUCED_TRANSITION)
      state.runs = [run]
      void run.finished.then(() => {
        faded = true
        finish()
      })
      if (out) return
      join(() => {
        const before = frameElement.getBoundingClientRect().top
        store.set(placeAtom, {
          kind: "popped",
          height: frameElement.offsetHeight,
          gap: rowGap(frameElement.parentElement),
        })
        morph.arrivals.push(() => {
          const box = frameElement.getBoundingClientRect()
          frameElement.style.transform =
            before === box.top ? "" : `translateY(${before - box.top}px)`
          // Nothing shows past the stack's new edge (a shorter stack).
          const edge = stack()?.getBoundingClientRect().bottom
          const past = edge === undefined ? 0 : before + box.height - edge
          if (past > 0) frameElement.style.clipPath = `inset(0 0 ${past}px 0)`
          out = true
          finish()
        })
      })
      scheduleSwap(morph, beat)
      return
    }
    const timeline = leaveTimeline(blocks.length, p)
    morph.out = Math.max(morph.out, timeline.contentsOut)
    const reversed = [...blocks].reverse()
    state.runs = reversed.map((block, k) =>
      fadeTo(k === reversed.length - 1 ? [...shell, ...block] : block, 0, {
        duration: ms(blockExit(p)),
        ease: EASE.emphasizedAccelerate,
        delay: ms(timeline.delays[k]!),
      })
    )
    void Promise.all(state.runs.map((run) => run.finished)).then(() => {
      faded = true
      finish()
    })
    if (!out) {
      join(() => {
        // Out of layout, still fading where it was.
        store.set(placeAtom, {
          kind: "popped",
          height: frameElement.offsetHeight,
          gap: rowGap(frameElement.parentElement),
        })
        // Removed after the morph, never during it, so the morph's target
        // layout holds.
        const { params: q } = latest.current
        window.setTimeout(() => {
          out = true
          finish()
        }, q.morph.duration * 1000)
      })
      scheduleMorph(morph, p, stack, beat)
    }
  }, [isPresent, placeAtom, store])

  // Effect: stops this layer's motion animations (an external system) and leaves its morph when it unmounts.
  React.useLayoutEffect(
    () => () => {
      running.current.token++
      stopAll(running.current)
    },
    []
  )

  return (
    <div
      ref={frame}
      data-choreo-layer={name}
      data-place={placed.kind}
      // Its own block formatting context: a child's margin stays inside the
      // frame, so the room it holds when popped is all the room it took.
      className="flow-root"
      style={placeStyle(placed)}
    >
      <div ref={content} className={className}>
        {children}
      </div>
    </div>
  )
}

/**
 * Reduced motion's change: no morph and no fades to wait for. Once this
 * commit's effects have run (a microtask, before the frame paints), every
 * layer's hook runs, then the beat, in one store update: the height snaps
 * once, leaving layers measured where they were before anything moved.
 */
function scheduleSwap(
  morph: Morph,
  beat: (
    transition: ValueTransition,
    from: StackShape | null,
    arrivals: Array<(moves: boolean) => void>
  ) => void
) {
  if (morph.scheduled) return
  morph.scheduled = true
  queueMicrotask(() => {
    morph.scheduled = false
    if (morph.hooks.size === 0) return
    const hooks = [...morph.hooks]
    morph.hooks.clear()
    morph.out = 0
    for (const hook of hooks) hook()
    const arrivals = morph.arrivals
    morph.arrivals = []
    beat({ duration: 0 }, null, arrivals)
  })
}

/**
 * The delivery stack (briefing, layers and diff): the one thing that changes
 * size, once per change, in a single FLIP by transform. The stack scales from
 * its old height to its new one (top anchored); each child is counter-scaled
 * to its natural size and slides from its old place to its new one, and
 * arriving layers sit at their target place. A stack with rounded corners
 * (the settings preview's card) keeps them round while it scales.
 */
export function DeliveryStack({
  children,
  className,
  ...attributes
}: {
  children: React.ReactNode
  className?: string
} & Pick<React.ComponentProps<"div">, "role" | "aria-label">) {
  return (
    <MorphingStack className={className} attributes={attributes}>
      {children}
    </MorphingStack>
  )
}

const lerp = (from: number, to: number, progress: number) =>
  from + (to - from) * progress

/** Marks a layer that stepped in at this morph (it sits at its target). */
const ARRIVING = "data-arriving"

function arrivingIn(part: HTMLElement) {
  return Array.from(part.querySelectorAll<HTMLElement>(`[${ARRIVING}]`))
}

/** Clears the morph's transforms; `settled` also releases arriving layers. */
function clearMorph(stack: HTMLElement, settled = true) {
  stack.style.transform = ""
  stack.style.transformOrigin = ""
  stack.style.borderRadius = ""
  for (const child of Array.from(stack.children) as Array<HTMLElement>) {
    child.style.transform = ""
    child.style.transformOrigin = ""
    for (const frame of arrivingIn(child)) {
      frame.style.transform = ""
      if (settled) frame.removeAttribute(ARRIVING)
    }
  }
}

function MorphingStack({
  children,
  className,
  attributes,
}: {
  children: React.ReactNode
  className?: string
  attributes: Pick<React.ComponentProps<"div">, "role" | "aria-label">
}) {
  const request = useAtomValue(morphBeatAtom)
  const stack = React.useRef<HTMLDivElement>(null)
  const running = React.useRef<{ stop: () => void } | null>(null)
  // Effect: runs the stack's single FLIP (transforms written to the DOM by motion's animate, an external system) once a change's new layout has committed.
  React.useLayoutEffect(() => {
    const element = stack.current
    const tell = (moves: boolean) => {
      for (const arrive of request.arrivals) arrive(moves)
    }
    if (!element || !request.from) return tell(true)
    running.current?.stop()
    // Measure the new layout untransformed; layers arriving now stay marked.
    clearMorph(element, false)
    const parts = Array.from(element.children) as Array<HTMLElement>
    const radius =
      Number.parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0
    /** The stack's own translation now (its layout top is under it). */
    let shift = 0
    /**
     * The layout now, in the viewport (offsets ignore transforms). Viewport
     * positions, so a reader scrolled into the diff stays put: when the
     * scroll is anchored across the change (the browser's scroll anchoring,
     * or DeliveryDiff restoring the reader's line at this beat), the line's
     * old and new places agree and it doesn't move.
     */
    const layout = (): StackShape => {
      const top = element.getBoundingClientRect().top - shift
      return {
        top,
        height: element.offsetHeight,
        tops: parts.map((child) => top + child.offsetTop),
      }
    }
    /** Same layout, wherever the page has scrolled. */
    const same = (a: StackShape, b: StackShape) =>
      Math.abs(a.height - b.height) <= 0.5 &&
      a.tops.every(
        (top, index) =>
          Math.abs(top - a.top - ((b.tops[index] ?? top) - b.top)) <= 0.5
      )
    /** Frames a new layout must hold before the morph heads for it. */
    const SETTLE_FRAMES = 3
    const morph = (start: StackShape, first: StackShape) => {
      if (first.height <= 0) return
      // The visual follows the curve from `from` to `target`, whatever the
      // layout does meanwhile. Every frame reads the layout and scales
      // against it, so a child that re-measures for a frame (the diff
      // rendering extra rows) changes nothing the reader sees. Only a layout
      // that holds for SETTLE_FRAMES becomes the new target, reached by a
      // fresh movement from where the stack is, without a jump.
      const from = start
      const target = first
      let candidate: StackShape | null = null
      let held = 0
      const apply = (progress: number) => {
        const now = layout()
        if (now.height <= 0) return
        if (same(now, target)) candidate = null
        else if (candidate && same(now, candidate)) held++
        else {
          candidate = now
          held = 1
        }
        if (candidate && held >= SETTLE_FRAMES && progress < 1) {
          // A new layout that holds: one fresh movement from where the
          // stack is now to it (rebasing the running curve would steepen it).
          const here: StackShape = {
            top: lerp(from.top, target.top, progress),
            height: lerp(from.height, target.height, progress),
            tops: target.tops.map((end, index) =>
              lerp(from.tops[index] ?? end, end, progress)
            ),
          }
          running.current?.stop()
          return morph(here, candidate)
        }
        const top = lerp(from.top, target.top, progress)
        const scale = lerp(from.height, target.height, progress) / now.height
        shift = top - now.top
        element.style.transformOrigin = "0 0"
        element.style.transform = `translateY(${shift}px) scaleY(${scale})`
        // Round corners stay round: vertical radii in the scaled space.
        if (radius > 0)
          element.style.borderRadius = `${radius}px / ${radius / scale}px`
        // No clip: a clip on the stack (overflow or clip-path) makes the
        // diff's visibility-driven rendering swap to its skeleton on
        // alternate frames (review r5-jig-1, F2). Nothing needs one: what
        // arrives is unseen until 75%, and what leaves fades in place.
        parts.forEach((child, index) => {
          const end = target.tops[index] ?? now.tops[index]!
          const at = lerp(from.tops[index] ?? end, end, progress)
          const offset = now.tops[index]! - now.top
          child.style.transformOrigin = "0 0"
          child.style.transform = `translateY(${(at - top) / scale - offset}px) scaleY(${1 / scale})`
          // Arriving layers sit at their target place, not where the child
          // is on its way (the child is counter-scaled to natural size).
          for (const frame of arrivingIn(child))
            frame.style.transform = `translateY(${end - at}px)`
        })
      }
      apply(0)
      running.current = animate(0, 1, {
        ...request.transition,
        onUpdate: apply,
        onComplete: () => {
          clearMorph(element)
          shift = 0
          // Settled somewhere else after the end (rows that mounted late):
          // one more movement from where this one ended, never a snap.
          const settled = layout()
          if (!same(settled, target)) morph(target, settled)
        },
      })
    }
    const first = layout()
    const moves =
      Math.abs(first.height - request.from.height) >= 1 ||
      Math.abs(first.top - request.from.top) >= 1 ||
      first.tops.some(
        (top, index) => Math.abs(top - (request.from!.tops[index] ?? top)) > 0.5
      )
    tell(moves)
    if (moves) morph(request.from, first)
    else clearMorph(element)
  }, [request])
  // Effect: stops a running morph (motion's animate, an external system) when the stack unmounts.
  React.useLayoutEffect(() => () => running.current?.stop(), [])
  return (
    <div
      ref={stack}
      data-delivery-stack=""
      className={cn("relative flex flex-none flex-col", className)}
      {...attributes}
    >
      {React.Children.map(children, (child) =>
        child ? <div className="relative">{child}</div> : null
      )}
    </div>
  )
}
