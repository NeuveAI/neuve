/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD — Delivery dial glyph bars (jig only)
 *
 * Four bars after the desk's title (DialTitle.dc.html, option B), filled up
 * to the stop. Story-local until the values are approved.
 *
 *    0ms   the first bar that changes starts on SPRING.snappy: its fill
 *          grows from the base (scaleY) and fades in (opacity)
 *  chain   each next bar starts when the previous one has covered
 *          `threshold` of its travel (85%: 127.5ms on SPRING.snappy, solved
 *          from the spring); filling runs left to right, emptying right to
 *          left
 *
 * A change mid-flight: bars that haven't started don't start; bars in
 * motion reverse from where they are. Nothing queues.
 * Reduced motion: no chain; every changing bar crossfades over
 * TIMING.reduced at once.
 * ───────────────────────────────────────────────────────── */

import * as React from "react"
import { createPortal } from "react-dom"
import { Provider, atom, useAtomValue, useSetAtom } from "jotai"
import type { SetStateAction, Setter } from "jotai"
import { atomWithStorage } from "jotai/utils"
import { DialRoot, useDialKit } from "dialkit"
import type { TransitionConfig } from "dialkit"
import "dialkit/styles.css"
import {
  animate,
  motion,
  motionValue,
  useReducedMotionConfig,
} from "motion/react"
import type { MotionValue, ValueTransition } from "motion/react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"

import {
  OFFSET,
  REDUCED_TRANSITION,
  SHARE,
  SPRING,
  ms,
} from "@workspace/ui/lib/motion"
import { goDeliveryDeskFixture } from "@workspace/ui/fixtures/review-batch.fixtures"
import { sampleDeliverySettings } from "@workspace/ui/fixtures/delivery-languages.fixtures"
import { createMemoryReviewCommentRepository } from "@workspace/ui/neuve/review-comments/repository"
import { ReviewDeskScreen } from "@workspace/ui/neuve/review-desk/review-desk-screen"
import { pickDeliveryStopAtom } from "@workspace/ui/neuve/review-desk/delivery/delivery-layers"
import { DeliveryPreview } from "@workspace/ui/neuve/settings/delivery-preview"
import {
  DeliveryChoreographyAtomProvider,
  MORPH_CURVES,
  MORPH_START_OPACITY,
  PHASED_DEFAULTS,
  morphTransition,
  progressCurve,
  timeSpring,
  timeToReach,
} from "@workspace/ui/neuve/review-desk/delivery/delivery-choreography"
import type {
  Bezier,
  PhasedParams,
} from "@workspace/ui/neuve/review-desk/delivery/delivery-choreography"
import {
  DELIVERY_STOPS,
  DeliverySettingsAtomProvider,
  deliveryStopIndex,
} from "@workspace/ui/neuve/shared/delivery"
import type {
  DeliverySettingsAtom,
  DeliveryStop,
} from "@workspace/ui/neuve/shared/delivery"

/* ─── Bars: the glyph after the title ─────────────────────────────────── */

/** Bar heights, short to tall (DialTitle.dc.html: 5 + 3 per bar). */
const BAR_HEIGHTS = [5, 8, 11, 14] as const

interface BarParams {
  /** 0–1: the previous bar's progress at which the next one starts. */
  threshold: number
  spring: ValueTransition
  fillOpacity: boolean
  reduced: boolean
}

/**
 * The bars' motion values and their chain. Driven from the dial's change
 * event (no effect): `set` schedules, retargets or cancels the bars at once.
 * The chain is scheduled by the solved spring time: the next bar starts
 * exactly when the previous one, started at rest on the same spring, reaches
 * `threshold` of its travel (127.5ms at 85% on SPRING.snappy), on motion's
 * clock rather than on whichever frame first sees it past the threshold.
 */
class BarsController {
  readonly scale: Array<MotionValue<number>>
  readonly opacity: Array<MotionValue<number>>
  private target: Array<number>
  /** The target before a scheduled move, restored if it never starts. */
  private prior: Array<number>
  private moving: Array<boolean>
  /** performance.now() at which each bar starts (or started) moving. */
  private startsAt: Array<number>
  private runs: Array<{ stop: () => void } | undefined>

  constructor(level: number) {
    const filled = BAR_HEIGHTS.map((_, bar) => (bar <= level ? 1 : 0))
    this.scale = filled.map((value) => motionValue(value))
    this.opacity = filled.map((value) => motionValue(value))
    this.target = [...filled]
    this.prior = [...filled]
    this.moving = filled.map(() => false)
    this.startsAt = filled.map(() => 0)
    this.runs = filled.map(() => undefined)
  }

  set(level: number, params: BarParams) {
    const now = performance.now()
    const want = this.target.map((_, bar) => (bar <= level ? 1 : 0))
    // Bars scheduled but not started yet don't start.
    this.target.forEach((_, bar) => {
      if (!this.moving[bar] || this.startsAt[bar]! <= now) return
      this.runs[bar]?.stop()
      this.moving[bar] = false
      this.target[bar] = this.prior[bar]!
    })
    if (params.reduced) return this.crossfade(want)
    // Bars in motion toward the old stop reverse from where they are.
    want.forEach((to, bar) => {
      if (this.moving[bar] && this.target[bar] !== to)
        this.start(bar, to, params, 0)
    })
    const idle = want
      .map((to, bar) => bar)
      .filter((bar) => !this.moving[bar] && this.target[bar] !== want[bar])
    if (idle.length === 0) return
    const filling = want[idle[0]!] === 1
    // Filling: left to right. Emptying: right to left.
    const order = filling ? idle : [...idle].reverse()
    const first = order[0]!
    // A bar already moving the same way, just before the chain, leads it.
    const leaders = this.target
      .map((to, bar) => bar)
      .filter(
        (bar) =>
          this.moving[bar] &&
          this.target[bar] === (filling ? 1 : 0) &&
          (filling ? bar < first : bar > first)
      )
    const leader = filling ? leaders.at(-1) : leaders[0]
    const step = timeToReach(params.spring, params.threshold)
    let at =
      leader === undefined
        ? 0
        : Math.max(0, this.startsAt[leader]! + step - now)
    for (const bar of order) {
      this.start(bar, want[bar]!, params, at)
      at += step
    }
  }

  private start(bar: number, to: number, params: BarParams, delay: number) {
    this.runs[bar]?.stop()
    this.prior[bar] = this.target[bar]!
    this.moving[bar] = true
    this.target[bar] = to
    this.startsAt[bar] = performance.now() + delay
    const transition = { ...params.spring, delay: ms(delay) }
    const scale = animate(this.scale[bar]!, to, transition)
    let opacity: { stop: () => void } | undefined
    if (params.fillOpacity)
      opacity = animate(this.opacity[bar]!, to, transition)
    else this.opacity[bar]!.jump(1)
    const run = {
      stop: () => {
        scale.stop()
        opacity?.stop()
      },
    }
    this.runs[bar] = run
    void scale.finished.then(() => {
      if (this.runs[bar] === run) this.moving[bar] = false
    })
  }

  /** Reduced motion: no chain, no growth; changing bars crossfade at once. */
  private crossfade(want: Array<number>) {
    want.forEach((to, bar) => {
      this.runs[bar]?.stop()
      if (this.target[bar] === to && !this.moving[bar]) return
      this.prior[bar] = this.target[bar]!
      this.target[bar] = to
      this.moving[bar] = true
      this.startsAt[bar] = performance.now()
      if (to === 1) this.scale[bar]!.jump(1)
      const fade = animate(this.opacity[bar]!, to, REDUCED_TRANSITION)
      const run = { stop: () => fade.stop() }
      this.runs[bar] = run
      void fade.finished.then(() => {
        if (this.runs[bar] !== run) return
        this.moving[bar] = false
        if (to === 0) this.scale[bar]!.jump(0)
      })
    })
  }
}

/** Four bars after the title; decorative here (the dial stays below). */
function JigGlyph({ bars }: { bars: BarsController }) {
  return (
    <span
      aria-hidden="true"
      data-jig-glyph=""
      className="ml-2 inline-flex size-8 items-center justify-center align-[4px] text-ink-muted"
    >
      <span className="flex h-3.5 items-end gap-0.5">
        {BAR_HEIGHTS.map((height, bar) => (
          <i
            key={bar}
            data-jig-bar={bar}
            className="relative block w-1 rounded-[1px] shadow-[inset_0_0_0_1px_var(--nv-line-strong)]"
            style={{ height }}
          >
            <motion.b
              className="absolute inset-0 origin-bottom rounded-[1px] bg-current"
              style={{ scaleY: bars.scale[bar], opacity: bars.opacity[bar] }}
            />
          </i>
        ))}
      </span>
    </span>
  )
}

/* ─── The panel ───────────────────────────────────────────────────────── */

const slider = (
  value: number,
  min: number,
  max: number,
  step: number
): [number, number, number, number] => [value, min, max, step]

const BAR_SPRING = timeSpring(SPRING.snappy)
const D = PHASED_DEFAULTS
const CURVES = Object.keys(MORPH_CURVES) as Array<keyof typeof MORPH_CURVES>

const PANEL = {
  Morph: {
    Curve: {
      type: "select" as const,
      options: CURVES,
      default: "standard",
    },
    "Duration (ms)": slider(D.morph.duration * 1000, 80, 800, 10),
    "Exit → morph overlap (ms)": slider(D.overlap, 0, 300, 5),
  },
  Contents: {
    "Start (share of morph, %)": slider(D.contentStart * 100, 0, 100, 1),
    "Step (ms)": slider(D.stagger, 0, 120, 0.5),
    "Rise (px)": slider(D.offset, 0, OFFSET.lift, 0.5),
    "Fade (ms)": slider(D.content, 60, 600, 10),
  },
  Bars: {
    "Next starts at (% of previous)": slider(
      SHARE.chainThreshold * 100,
      0,
      100,
      1
    ),
    Spring: {
      type: "spring" as const,
      visualDuration: BAR_SPRING.visualDuration,
      bounce: BAR_SPRING.bounce,
    },
    "Fill opacity": true,
  },
  Play: { type: "action" as const, label: "Play" },
  "Play step (ms)": slider(1800, 600, 4000, 100),
  "Copy values": { type: "action" as const, label: "Copy values" },
}

/** DialKit's spring or easing control as a motion transition. */
function toTransition(config: TransitionConfig): ValueTransition {
  if (config.type === "easing")
    return { type: "tween", duration: config.duration, ease: config.ease }
  return { ...config }
}

type PanelValues = ReturnType<typeof useDialKit<typeof PANEL>>

function curveOf(values: PanelValues) {
  const curves: Partial<Record<string, Bezier>> = MORPH_CURVES
  return curves[values.Morph.Curve] ?? MORPH_CURVES.standard
}

function phasedOf(values: PanelValues): PhasedParams {
  return {
    contentStart: values.Contents["Start (share of morph, %)"] / 100,
    stagger: values.Contents["Step (ms)"],
    offset: values.Contents["Rise (px)"],
    content: values.Contents["Fade (ms)"],
    overlap: values.Morph["Exit → morph overlap (ms)"],
    morph: {
      duration: ms(values.Morph["Duration (ms)"]),
      ease: curveOf(values),
    },
  }
}

function barsOf(values: PanelValues, reduced: boolean): BarParams {
  return {
    threshold: values.Bars["Next starts at (% of previous)"] / 100,
    spring: toTransition(values.Bars.Spring),
    fillOpacity: values.Bars["Fill opacity"],
    reduced,
  }
}

/** What "Copy values" puts on the clipboard (and the readout shows). */
function readout(values: PanelValues) {
  return JSON.stringify(
    {
      morph: {
        curve: values.Morph.Curve,
        bezier: curveOf(values),
        durationMs: values.Morph["Duration (ms)"],
        exitMorphOverlapMs: values.Morph["Exit → morph overlap (ms)"],
      },
      contents: {
        startShareOfMorphPercent: values.Contents["Start (share of morph, %)"],
        stepMs: values.Contents["Step (ms)"],
        risePx: values.Contents["Rise (px)"],
        fadeMs: values.Contents["Fade (ms)"],
      },
      bars: {
        thresholdPercent: values.Bars["Next starts at (% of previous)"],
        spring: values.Bars.Spring,
        fillOpacity: values.Bars["Fill opacity"],
      },
    },
    null,
    2
  )
}

/* ─── The stack's height over a change (the readout) ──────────────────── */

/** The stack's visual height (transform included). */
function stackHeight(root: ParentNode) {
  return (
    root.querySelector("[data-delivery-stack]")?.getBoundingClientRect()
      .height ?? null
  )
}

interface HeightTrace {
  change: string
  samples: Array<{ t: number; h: number }>
}

/** Largest move against the overall direction (px): 0 when monotonic. */
function reversal(samples: Array<{ h: number }>) {
  if (samples.length < 2) return 0
  const up = samples.at(-1)!.h >= samples[0]!.h
  let worst = 0
  for (let i = 1; i < samples.length; i++) {
    const step = samples[i]!.h - samples[i - 1]!.h
    worst = Math.max(worst, up ? -step : step)
  }
  return worst
}

const traceAtom = atom<HeightTrace | null>(null)

/** A sparkline of the stack's height over the last change. */
function HeightReadout() {
  const trace = useAtomValue(traceAtom)
  if (!trace || trace.samples.length < 2)
    return (
      <p className="m-0 text-xs text-ink-muted">
        Move the dial to trace the stack's height.
      </p>
    )
  const hs = trace.samples.map((point) => point.h)
  const low = Math.min(...hs)
  const high = Math.max(...hs)
  const span = Math.max(1, high - low)
  const end = trace.samples.at(-1)!.t
  const points = trace.samples
    .map(
      (point) =>
        `${((point.t / end) * 276).toFixed(1)},${(52 - ((point.h - low) / span) * 48).toFixed(1)}`
    )
    .join(" ")
  const back = reversal(trace.samples)
  return (
    <figure className="m-0 flex flex-col gap-1">
      <svg
        viewBox="0 0 276 56"
        className="h-14 w-full rounded-lg bg-raised"
        role="img"
        aria-label={`Stack height over ${trace.change}`}
      >
        <polyline
          points={points}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="text-ink-2"
        />
      </svg>
      <figcaption
        data-jig-trace=""
        data-reversal={back.toFixed(1)}
        className="font-mono text-[11px] leading-4 text-ink-2"
      >
        {trace.change}: {Math.round(hs[0]!)} → {Math.round(hs.at(-1)!)}px ·{" "}
        {back <= 0.5 ? "monotonic" : `reverses ${back.toFixed(1)}px`}
      </figcaption>
    </figure>
  )
}

/* ─── The jig ─────────────────────────────────────────────────────────── */

/** How long the readout traces the stack after a change (ms). */
const TRACE_LENGTH = 1200

const PLAY_SEQUENCE: ReadonlyArray<DeliveryStop> = [
  "facts",
  "briefed",
  "explained",
  "guided",
  "briefed",
]

const storySettingsAtom = atom(sampleDeliverySettings)
/** The title's slot for the glyph, once the desk has rendered its title. */
const titleSlotAtom = atom<HTMLElement | null>(null)
const copiedAtom = atom(false)

const DIAL = '[role="radiogroup"][aria-label="Review delivery"]'

/**
 * The desk's delivery dial: in its toolbar, or the one the title's glyph
 * opens (in a popover, outside the desk's element).
 */
function dialGroup(root: ParentNode | null) {
  return (
    root?.querySelector<HTMLElement>(DIAL) ??
    document.querySelector<HTMLElement>(DIAL)
  )
}

/** Opens the title glyph's dial when the desk has no dial showing. */
function openDial(root: ParentNode | null) {
  if (dialGroup(root)) return false
  root?.querySelector<HTMLButtonElement>("[data-delivery-trigger]")?.click()
  return true
}

function dialInput(root: HTMLElement | null, stop: DeliveryStop) {
  return dialGroup(root)?.querySelector<HTMLInputElement>(
    `input[value="${stop}"]`
  )
}

function DeliveryJig({
  initialStop,
  theme,
  settings = storySettingsAtom,
}: {
  /** The reader's stop for the unit; none follows the workspace setting. */
  initialStop: DeliveryStop | undefined
  theme: "light" | "dark"
  /** The workspace setting the desk reads (in memory by default). */
  settings?: DeliverySettingsAtom
}) {
  const reduced = useReducedMotionConfig() ?? false
  const desk = React.useRef<HTMLDivElement>(null)
  const bars = React.useRef<BarsController | null>(null)
  bars.current ??= new BarsController(
    deliveryStopIndex(initialStop ?? "explained")
  )
  const timers = React.useRef<Array<number>>([])
  const slot = useAtomValue(titleSlotAtom)
  const setSlot = useSetAtom(titleSlotAtom)
  const copied = useAtomValue(copiedAtom)
  const setCopied = useSetAtom(copiedAtom)
  const setTrace = useSetAtom(traceAtom)
  const tracing = React.useRef(0)
  /** Samples the stack's visual height every frame for a while. */
  const traceChange = (change: string) => {
    const id = ++tracing.current
    const start = performance.now()
    const samples: HeightTrace["samples"] = []
    const tick = () => {
      if (tracing.current !== id) return
      const h = desk.current ? stackHeight(desk.current) : null
      if (h !== null) samples.push({ t: performance.now() - start, h })
      if (performance.now() - start < TRACE_LENGTH) requestAnimationFrame(tick)
      else setTrace({ change, samples })
    }
    requestAnimationFrame(tick)
  }
  const values = useDialKit("Delivery choreography", PANEL, {
    onAction: (action) => {
      if (action === "Play") {
        for (const timer of timers.current) window.clearTimeout(timer)
        // The title's dial opens first (it stays open while stops change).
        const opening = openDial(desk.current) ? values["Play step (ms)"] : 0
        timers.current = PLAY_SEQUENCE.map((stop, step) =>
          window.setTimeout(
            () => dialInput(desk.current, stop)?.click(),
            opening + step * values["Play step (ms)"]
          )
        )
      }
      if (action === "Copy values") {
        setCopied(false)
        navigator.clipboard.writeText(readout(values)).then(
          () => setCopied(true),
          () => setCopied(false)
        )
      }
    },
  })
  const choreography = phasedOf(values)
  const key = JSON.stringify(choreography)
  const deskChoreography = React.useMemo(
    () => atom<PhasedParams>(JSON.parse(key) as PhasedParams),
    [key]
  )
  // Effect: places the jig's glyph slot after the desk's title, a node the desk renders (story-only DOM).
  React.useEffect(() => {
    const title = desk.current?.querySelector("h1")
    if (!title) return
    const span = document.createElement("span")
    title.append(span)
    setSlot(span)
    return () => {
      span.remove()
      setSlot(null)
    }
  }, [setSlot])
  return (
    <div className="flex h-svh bg-paper">
      <div
        ref={desk}
        className="relative min-w-0 flex-auto overflow-auto"
        onChange={(event) => {
          const input = event.target
          if (
            input instanceof HTMLInputElement &&
            input.type === "radio" &&
            input.closest('[aria-label="Review delivery"]')
          ) {
            const stop = input.value as DeliveryStop
            bars.current?.set(deliveryStopIndex(stop), barsOf(values, reduced))
            traceChange(`→ ${stop}`)
          }
        }}
      >
        <DeliverySettingsAtomProvider value={settings}>
          <DeliveryChoreographyAtomProvider value={deskChoreography}>
            <ReviewDeskScreen
              data={goDeliveryDeskFixture}
              commentRepository={createMemoryReviewCommentRepository()}
              initialState={{ railCollapsed: true }}
              initialDeliveryStop={initialStop}
            />
          </DeliveryChoreographyAtomProvider>
        </DeliverySettingsAtomProvider>
        {slot && createPortal(<JigGlyph bars={bars.current} />, slot)}
      </div>
      <aside
        aria-label="Choreography values"
        className="flex w-[300px] flex-none flex-col gap-3 overflow-auto bg-surface p-3 shadow-[0_0_0_1px_var(--nv-line)]"
      >
        <DialRoot mode="inline" theme={theme} productionEnabled />
        <div className="flex items-baseline justify-between">
          <h2 className="m-0 label-mono text-ink-muted">Values</h2>
          <span role="status" className="text-xs text-ink-muted">
            {copied ? "Copied" : ""}
          </span>
        </div>
        <h2 className="m-0 label-mono text-ink-muted">Stack height</h2>
        <HeightReadout />
        <pre
          data-jig-values=""
          className="m-0 overflow-auto rounded-lg bg-raised p-2 font-mono text-[11px] leading-4 text-ink-2"
        >
          {readout(values)}
        </pre>
      </aside>
    </div>
  )
}

/**
 * A tuning jig for the phased delivery choreography (the app's motion) and
 * the glyph's bars on the real desk (the Index-writes unit). The panel's
 * values apply to this story's desk only.
 */
const meta = {
  title: "Jigs/Delivery choreography",
  parameters: { layout: "fullscreen" },
  args: { initialStop: "briefed" as DeliveryStop },
  argTypes: {
    initialStop: { control: "inline-radio", options: [...DELIVERY_STOPS] },
  },
  render: (args, context) => (
    // Its own store: the jig's slot and status, apart from the desk's.
    <Provider>
      <DeliveryJig
        key={args.initialStop}
        initialStop={args.initialStop}
        theme={context.globals.theme === "dark" ? "dark" : "light"}
      />
    </Provider>
  ),
} satisfies Meta<{ initialStop: DeliveryStop }>

export default meta
type Story = StoryObj<typeof meta>

/* ─── Play helpers ────────────────────────────────────────────────────── */

function dial(canvasElement: HTMLElement) {
  return within(dialGroup(canvasElement)!)
}

/** The dial showing (the title's opened), for plays that pick stops. */
async function dialShown(canvasElement: HTMLElement) {
  openDial(canvasElement)
  await waitFor(() => expect(dialGroup(canvasElement)).not.toBeNull())
}

const frame = () =>
  new Promise<number>((resolve) => requestAnimationFrame(resolve))

/**
 * Samples `read` every frame for `duration` ms after the call. `t` is the
 * frame's own rAF timestamp (the clock motion animates on), from the first
 * frame, so frame-to-frame speeds carry no scheduling jitter.
 */
async function sample<T>(duration: number, read: () => T) {
  const start = performance.now()
  const frames: Array<T & { t: number }> = []
  let first: number | undefined
  while (performance.now() - start < duration) {
    const stamp = await frame()
    first ??= stamp
    frames.push({ ...read(), t: stamp - first })
  }
  return frames
}

const opacityOf = (element: Element) =>
  Number(getComputedStyle(element).opacity)

/** A phased layer around the section named `name`: its place and blocks. */
function layer(root: HTMLElement, name: string) {
  const frameElement = root
    .querySelector(`section[aria-label="${name}"]`)
    ?.closest<HTMLElement>("[data-choreo-layer]")
  if (!frameElement) return null
  const blocks = Array.from(
    frameElement.querySelectorAll<HTMLElement>("[data-choreo-block]")
  )
  return {
    place: frameElement.dataset.place,
    opacities: blocks.map(opacityOf),
  }
}

/** A bar's fill scaleY, read from its computed transform. */
function barScale(root: HTMLElement, bar: number) {
  const fill = root.querySelector(`[data-jig-bar="${bar}"] > b`)
  if (!fill) return 0
  const transform = getComputedStyle(fill).transform
  if (transform === "none") return 1
  return new DOMMatrixReadOnly(transform).d
}

function barOpacity(root: HTMLElement, bar: number) {
  const fill = root.querySelector(`[data-jig-bar="${bar}"] > b`)
  return fill ? opacityOf(fill) : 0
}

async function ready(canvasElement: HTMLElement) {
  await waitFor(() =>
    expect(canvasElement.querySelector("[data-jig-glyph]")).not.toBeNull()
  )
  await dialShown(canvasElement)
  // Let the first render settle: the diff renders its rows after mount, so
  // wait until the stack's height holds still for a quarter second.
  let last = -1
  let still = 0
  const start = performance.now()
  while (still < 15 && performance.now() - start < 4000) {
    await frame()
    const height = stackHeight(canvasElement) ?? 0
    still = Math.abs(height - last) < 0.5 ? still + 1 : 0
    last = height
  }
}

/* ─── Stories ─────────────────────────────────────────────────────────── */

/** The jig: tune with the panel, press Play, copy the values. */
export const Jig: Story = {}

/**
 * Phased defaults, Briefed → Explained: the stack morphs once to its new
 * height while the arriving cards are still unseen; their blocks start at
 * about 75% of the morph's travel.
 */
export const MorphBeforeContents: Story = {
  play: async ({ canvasElement }) => {
    await ready(canvasElement)
    const from = stackHeight(canvasElement)!
    await userEvent.click(dial(canvasElement).getByLabelText("Explained"))
    const frames = await sample(1400, () => {
      const flow = layer(canvasElement, "How Commit changes")
      return {
        height: stackHeight(canvasElement)!,
        opacity: flow ? Math.max(0, ...flow.opacities) : 0,
      }
    })
    const to = frames.at(-1)!.height
    await expect(Math.abs(to - from)).toBeGreaterThan(20)
    const share = (height: number) => (height - from) / (to - from)
    const moving = frames.filter((f) => share(f.height) > 0.02)
    await expect(moving.length).toBeGreaterThan(0)
    // The stack moves before any arriving content shows.
    await expect(moving[0]!.opacity).toBe(0)
    const firstVisible = frames.find((f) => f.opacity > 0)
    await expect(firstVisible).toBeDefined()
    await expect(share(firstVisible!.height)).toBeGreaterThan(
      PHASED_DEFAULTS.contentStart - 0.05
    )
  },
}

/**
 * Phased defaults, Explained → Briefed: the stack keeps its size while the
 * terms card's blocks fade out, last first; it morphs only once they are out,
 * less the overlap (13ms, where the last block is at most 30% opaque): at
 * the morph's first frame every leaving block is at or below 0.3, and every
 * block outside the overlap window is out.
 */
export const ContentsBeforeMorph: Story = {
  args: { initialStop: "explained" },
  play: async ({ canvasElement }) => {
    await ready(canvasElement)
    const from = stackHeight(canvasElement)!
    await userEvent.click(dial(canvasElement).getByLabelText("Briefed"))
    const frames = await sample(1400, () => ({
      height: stackHeight(canvasElement)!,
      terms: layer(canvasElement, "Go in this unit"),
    }))
    const morphing = frames.find((f) => Math.abs(f.height - from) > 0.5)
    await expect(morphing).toBeDefined()
    await expect(morphing!.terms).not.toBeNull()
    const { stagger, overlap } = PHASED_DEFAULTS
    const inOverlap = overlap > 0 ? Math.ceil(overlap / stagger) : 0
    const opacities = morphing!.terms!.opacities
    for (const opacity of opacities.slice(inOverlap))
      await expect(opacity).toBeLessThanOrEqual(0.01)
    for (const opacity of opacities)
      await expect(opacity).toBeLessThanOrEqual(MORPH_START_OPACITY)
    // Fade only: no block has dropped.
    for (const element of canvasElement.querySelectorAll<HTMLElement>(
      '[data-choreo-layer][data-place="popped"] [data-choreo-block]'
    ))
      await expect(element.style.transform).toBe("")
    // Gone at the end.
    await expect(frames.at(-1)!.terms).toBeNull()
  },
}

/** The stack's visual height over a change, sampled every frame. */
async function heights(canvasElement: HTMLElement, stop: string) {
  await userEvent.click(dial(canvasElement).getByLabelText(stop))
  return sample(1200, () => {
    const stack = canvasElement.querySelector<HTMLElement>(
      "[data-delivery-stack]"
    )!
    return {
      h: stack.getBoundingClientRect().height,
      // The morph runs as a layout animation: a transform, never a height.
      morphing: !["", "none"].includes(stack.style.transform),
      height: stack.style.height,
    }
  })
}

/**
 * One movement, never a dip and rise. Explained → Guided → Explained →
 * Briefed → Explained → Facts → Guided → Explained: on each change the
 * stack's visual height only moves toward its new size, by transform (its
 * style height is never set), and the readout calls it monotonic.
 * Returns during the hold or the morph (Explained → Guided → Explained at
 * +180, +230, +260, +300, +330 and +450ms; Facts → Guided → Facts at +300ms)
 * retarget from where the stack is: its visual and layout heights stay in
 * the band between the two totals, it never moves faster than the morph's
 * curve at its peak (rAF clock), and it ends where it started.
 */
export const StackMovesOnce: Story = {
  args: { initialStop: "explained" },
  play: async ({ canvasElement }) => {
    await ready(canvasElement)
    const totals: Record<string, number> = {}
    // Explained ⇄ Guided (the totals are close), then Explained ⇄ Briefed
    // (a large change, where an overshoot or a dip would show most).
    // Facts ⇄ Guided swaps the paragraph too (a leaving layer in a flex
    // column with a gap).
    for (const stop of [
      "Guided",
      "Explained",
      "Briefed",
      "Explained",
      "Facts",
      "Guided",
      "Explained",
    ]) {
      const trace = await heights(canvasElement, stop)
      await expect(reversal(trace)).toBeLessThanOrEqual(0.5)
      await expect(trace.some((f) => f.morphing)).toBe(true)
      await expect(trace.every((f) => f.height === "")).toBe(true)
      totals[stop] = trace.at(-1)!.h
      await sample(400, () => ({}))
    }
    // The readout says so too.
    await waitFor(() =>
      expect(
        canvasElement.ownerDocument.querySelector("[data-jig-trace]")
      ).toHaveTextContent(/monotonic/)
    )
    // Returns during the hold or the morph: the stack stays in the band
    // between the two totals (its visual and its layout height), never moves
    // faster than the morph's curve at its peak, and ends where it started.
    const cases: Array<[DeliveryStop, DeliveryStop, number]> = [
      ...[180, 230, 260, 300, 330, 450].map(
        (back) =>
          ["explained", "guided", back] as [DeliveryStop, DeliveryStop, number]
      ),
      ["facts", "guided", 300],
    ]
    for (const [home, away, back] of cases) {
      dialInput(canvasElement, home)?.click()
      await sample(900, () => ({}))
      const trace = await returnTrace(canvasElement, away, home, back)
      const homeTotal = totals[label(home)]!
      const awayTotal = totals[label(away)]!
      const low = Math.min(homeTotal, awayTotal) - 0.5
      const high = Math.max(homeTotal, awayTotal) + 0.5
      for (const f of trace) {
        await expect(f.h).toBeGreaterThanOrEqual(low)
        await expect(f.h).toBeLessThanOrEqual(high)
        await expect(f.layout).toBeGreaterThanOrEqual(low)
        await expect(f.layout).toBeLessThanOrEqual(high)
        await expect(f.height).toBe("")
      }
      // Never faster than the morph's own curve at its peak (a jump would
      // be): px per ms over two frames (motion's clock and the sampled rAF
      // stamps differ by part of a frame), against the band's travel.
      const peak = peakSpeed(high - low)
      for (let i = 2; i < trace.length; i++) {
        const step = Math.abs(trace[i]!.h - trace[i - 2]!.h)
        const elapsed = Math.max(1, trace[i]!.t - trace[i - 2]!.t)
        await expect(step / elapsed).toBeLessThanOrEqual(peak * 1.1 + 0.05)
      }
      await expect(Math.abs(trace.at(-1)!.h - homeTotal)).toBeLessThan(0.5)
    }
  },
}

/** The morph's peak speed (px/ms) over `travel` px: its steepest slope. */
function peakSpeed(travel: number) {
  const morph = morphTransition(PHASED_DEFAULTS.morph)
  const progress = progressCurve(morph)
  let peak = 0
  for (let time = 0; time < PHASED_DEFAULTS.morph.duration * 1000; time++)
    peak = Math.max(peak, progress(time + 1) - progress(time))
  return peak * travel
}

/** The dial's label for a stop ("guided" → "Guided"). */
const label = (stop: DeliveryStop) => stop[0]!.toUpperCase() + stop.slice(1)

/**
 * Moves to `away`, then back to `home` `back` ms later, sampling the stack's
 * visual height, its layout height and its style height every frame.
 */
async function returnTrace(
  canvasElement: HTMLElement,
  away: DeliveryStop,
  home: DeliveryStop,
  back: number
) {
  const stack = () =>
    canvasElement.querySelector<HTMLElement>("[data-delivery-stack]")!
  dialInput(canvasElement, away)?.click()
  let returnedAt: number | undefined
  const returned = window.setTimeout(() => {
    dialInput(canvasElement, home)?.click()
    returnedAt = performance.now()
  }, back)
  const trace = await sample(back + 1100, () => ({
    /** The return has happened by this frame. */
    back: returnedAt !== undefined,
    h: stack().getBoundingClientRect().height,
    layout: stack().offsetHeight,
    height: stack().style.height,
    morphing: !["", "none"].includes(stack().style.transform),
    check: layer(
      canvasElement,
      "Done when: Index writes fail when the database is busy"
    ),
    terms: layer(canvasElement, "Go in this unit"),
  }))
  window.clearTimeout(returned)
  return trace
}

/**
 * A return before the morph (Explained → Guided, back at +180ms): the
 * leaving blocks fade back at once and the height never moves; the Guided
 * card never steps in.
 */
export const QuickReturnBeforeMorph: Story = {
  args: { initialStop: "explained" },
  play: async ({ canvasElement }) => {
    await ready(canvasElement)
    const from = stackHeight(canvasElement)!
    const trace = await returnTrace(canvasElement, "guided", "explained", 180)
    for (const f of trace) {
      await expect(f.morphing).toBe(false)
      await expect(Math.abs(f.h - from)).toBeLessThan(0.5)
      await expect(f.check?.place ?? "gone").not.toBe("in")
    }
    // The fade back is immediate: from two frames after the return, no
    // terms block gets fainter, and every block is rising again by then.
    const returned = trace.findIndex((f) => f.back)
    await expect(returned).toBeGreaterThan(0)
    const after = trace.slice(returned + 2).filter((f) => f.terms)
    await expect(after.length).toBeGreaterThan(2)
    for (let i = 1; i < after.length; i++) {
      const was = after[i - 1]!.terms!.opacities
      for (const [block, opacity] of after[i]!.terms!.opacities.entries())
        await expect(opacity).toBeGreaterThanOrEqual(was[block]! - 0.001)
    }
    const low = after[0]!.terms!.opacities
    const next = after[2]!.terms!.opacities
    for (const [block, opacity] of next.entries())
      if (low[block]! < 0.99) await expect(opacity).toBeGreaterThan(low[block]!)
    const end = trace.at(-1)!
    // The Guided card, which never stepped in, is gone (not left mounted).
    await expect(end.check).toBeNull()
    await expect(end.terms).not.toBeNull()
    for (const opacity of end.terms!.opacities)
      await expect(opacity).toBeGreaterThanOrEqual(0.99)
  },
}

/** A short window, so the reader can be past the diff's top. */
function shortWindow(canvasElement: HTMLElement) {
  const desk = canvasElement.querySelector<HTMLElement>(
    "[data-reader-window] > *"
  )!
  desk.style.height = "560px"
  desk.style.minHeight = "0"
}

/** The first diff line's top: the reader's line. */
function readerLine(canvasElement: HTMLElement) {
  return (
    canvasElement.querySelector("diffs-container")?.getBoundingClientRect()
      .top ?? Number.NaN
  )
}

/** Scrolls the desk so the reader is `depth` px into the diff. */
async function readIntoDiff(canvasElement: HTMLElement, depth: number) {
  const scroller =
    canvasElement.querySelector<HTMLElement>("[data-desk-scroll]")!
  const diff = canvasElement.querySelector<HTMLElement>("[data-delivery-diff]")!
  scroller.scrollTop +=
    diff.getBoundingClientRect().top -
    scroller.getBoundingClientRect().top +
    depth
  await frame()
  await frame()
  await expect(diff.getBoundingClientRect().top).toBeLessThan(
    scroller.getBoundingClientRect().top
  )
}

/** Waits until the stack's height holds still for 15 frames. */
async function settled(canvasElement: HTMLElement) {
  let last = -1
  for (let still = 0, n = 0; still < 15 && n < 240; n++) {
    await frame()
    const height = stackHeight(canvasElement) ?? 0
    still = Math.abs(height - last) < 0.5 ? still + 1 : 0
    last = height
  }
}

const READER_KEY = "neuve.review-delivery.jig-reader"
const readerSettingsAtom = atomWithStorage(READER_KEY, sampleDeliverySettings)

/**
 * The workspace's stored setting changes (another tab, say: the storage
 * event) while the reader is inside the diff, its top scrolled past. A
 * person can't reach the dial from there (it sits in the title, and closes
 * when its glyph scrolls away), so this is how the stop changes under a
 * reader in the diff. The line they're reading holds on every frame.
 */
export const ReaderLineStays: StoryObj = {
  loaders: [
    () => {
      try {
        localStorage.setItem(
          READER_KEY,
          JSON.stringify({
            ...sampleDeliverySettings,
            byLanguage: {
              ...sampleDeliverySettings.byLanguage,
              go: "explained",
            },
          })
        )
      } catch {
        // Storage unavailable: the play fails at its first change.
      }
      return {}
    },
  ],
  render: () => (
    <div data-reader-window="">
      <DeliverySettingsAtomProvider value={readerSettingsAtom}>
        <ReviewDeskScreen
          data={goDeliveryDeskFixture}
          commentRepository={createMemoryReviewCommentRepository()}
          initialState={{ railCollapsed: true }}
        />
      </DeliverySettingsAtomProvider>
    </div>
  ),
  play: async ({ canvasElement }) => {
    shortWindow(canvasElement)
    await waitFor(() => expect(readerLine(canvasElement)).not.toBeNaN())
    await settled(canvasElement)
    for (const stop of ["briefed", "facts", "explained", "briefed"] as const) {
      await readIntoDiff(canvasElement, 120)
      const before = readerLine(canvasElement)
      const height = stackHeight(canvasElement)!
      const value = JSON.stringify({
        ...sampleDeliverySettings,
        byLanguage: { ...sampleDeliverySettings.byLanguage, go: stop },
      })
      localStorage.setItem(READER_KEY, value)
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: READER_KEY,
          newValue: value,
          storageArea: localStorage,
        })
      )
      const frames = await sample(700, () => ({
        line: readerLine(canvasElement),
      }))
      for (const f of frames)
        await expect(Math.abs(f.line - before)).toBeLessThan(2)
      // The stop did change: the layers above the diff did.
      await expect(
        Math.abs(stackHeight(canvasElement)! - height)
      ).toBeGreaterThan(10)
      await settled(canvasElement)
    }
  },
}

/**
 * Reduced motion, Facts → Guided: no morph (the stack jumps to its new size
 * at once) and every block fades together (no stagger); the bars crossfade
 * at once, with no chain.
 */
export const ReducedNoStagger: Story = {
  args: { initialStop: "facts" },
  globals: { reducedMotion: "reduce" },
  play: async ({ canvasElement }) => {
    await ready(canvasElement)
    const from = stackHeight(canvasElement)!
    await userEvent.click(dial(canvasElement).getByLabelText("Guided"))
    const frames = await sample(600, () => ({
      height: stackHeight(canvasElement)!,
      check: layer(
        canvasElement,
        "Done when: Index writes fail when the database is busy"
      ),
      bars: [1, 2, 3].map((bar) => barOpacity(canvasElement, bar)),
    }))
    // Never in between: the stack is at its old or its new size.
    const to = frames.at(-1)!.height
    for (const f of frames)
      await expect(
        Math.min(Math.abs(f.height - from), Math.abs(f.height - to))
      ).toBeLessThan(1)
    const present = frames.filter((f) => f.check?.opacities.length)
    await expect(present.length).toBeGreaterThan(0)
    for (const f of present) {
      const spread =
        Math.max(...f.check!.opacities) - Math.min(...f.check!.opacities)
      await expect(spread).toBeLessThan(0.05)
    }
    for (const f of frames) {
      const spread = Math.max(...f.bars) - Math.min(...f.bars)
      await expect(spread).toBeLessThan(0.05)
    }
    // And the arriving content is there: in layout, visible, fully opaque.
    await expect(to).toBeGreaterThan(from)
    await arrived(canvasElement, [
      "Done when: Index writes fail when the database is busy",
      "How Commit changes",
    ])
  },
}

/** Each named layer has stepped in, shows, and is fully opaque. */
async function arrived(canvasElement: HTMLElement, names: Array<string>) {
  for (const name of names) {
    const section = canvasElement.querySelector<HTMLElement>(
      `section[aria-label="${name}"]`
    )
    await expect(section).not.toBeNull()
    const frameElement = section!.closest<HTMLElement>("[data-choreo-layer]")!
    await expect(frameElement.dataset.place).toBe("in")
    await expect(frameElement.offsetHeight).toBeGreaterThan(0)
    await expect(section).toBeVisible()
    await expect(opacityOf(frameElement.firstElementChild!)).toBeGreaterThan(
      0.99
    )
    for (const opacity of layer(canvasElement, name)!.opacities)
      await expect(opacity).toBeGreaterThan(0.99)
  }
}

/**
 * Not the reader's move (the stored setting resolves Go to Guided just after
 * mount): the phased layers snap in, as on a first render. They step into
 * layout at once and show at full opacity.
 */
const INSTANT_KEY = "neuve.review-delivery.jig-instant"
const instantSettingsAtom = atomWithStorage(INSTANT_KEY, sampleDeliverySettings)

export const InstantSettingAfterMount: Story = {
  loaders: [
    () => {
      try {
        localStorage.setItem(
          INSTANT_KEY,
          JSON.stringify({
            ...sampleDeliverySettings,
            byLanguage: { go: "guided" },
          })
        )
      } catch {
        // Storage unavailable: the desk stays at Explained.
      }
      return {}
    },
  ],
  render: (_, context) => (
    <Provider>
      <DeliveryJig
        initialStop={undefined}
        settings={instantSettingsAtom}
        theme={context.globals.theme === "dark" ? "dark" : "light"}
      />
    </Provider>
  ),
  play: async ({ canvasElement }) => {
    await waitFor(
      () =>
        expect(
          canvasElement.querySelector(
            'section[aria-label="Done when: Index writes fail when the database is busy"]'
          )
        ).not.toBeNull(),
      { timeout: 4000 }
    )
    await sample(200, () => ({}))
    await arrived(canvasElement, [
      "Done when: Index writes fail when the database is busy",
      "How Commit changes",
    ])
    // What left is gone, not left mounted unseen.
    await expect(layer(canvasElement, "Go in this unit")).toBeNull()
    await expect(
      canvasElement.querySelector('[data-choreo-layer="diff"]')
    ).toBeNull()
    // Snapped: nothing morphed.
    await expect(
      canvasElement.querySelector<HTMLElement>("[data-delivery-stack]")!.style
        .transform
    ).toBe("")
  },
}

/**
 * Bars, Facts → Guided: left to right, each next bar starts when the
 * previous one is at 85% of its travel (±0.03). Measured, not assumed: on
 * the first frame a bar shows, its value and the previous bar's value are
 * both read back through the spring's curve to the moment it started.
 */
export const BarsChain: Story = {
  args: { initialStop: "facts" },
  play: async ({ canvasElement }) => {
    await ready(canvasElement)
    await userEvent.click(dial(canvasElement).getByLabelText("Guided"))
    const frames = await sample(1500, () => ({
      scale: [0, 1, 2, 3].map((bar) => barScale(canvasElement, bar)),
    }))
    const curve = progressCurve(BAR_SPRING)
    // Ms since a bar started, from its value (rising, before any overshoot).
    const elapsed = (value: number) => {
      for (let time = 0; time <= 1000; time += 0.25)
        if (curve(time) >= value) return time
      return 1000
    }
    for (const bar of [2, 3]) {
      const first = frames.find((f) => f.scale[bar]! > 0.002)
      await expect(first).toBeDefined()
      const previous = first!.scale[bar - 1]!
      await expect(previous).toBeLessThan(1)
      const previousAtStart = curve(
        elapsed(previous) - elapsed(first!.scale[bar]!)
      )
      await expect(Math.abs(previousAtStart - 0.85)).toBeLessThanOrEqual(0.03)
    }
    await expect(
      frames.at(-1)!.scale.every((value) => Math.abs(value - 1) < 0.01)
    ).toBe(true)
  },
}

/**
 * Bars, a change mid-flight: Facts → Guided, then Facts while bar 2 is
 * still filling. Bars 3 and 4 never start; bar 2 reverses and empties.
 */
export const BarsRetarget: Story = {
  args: { initialStop: "facts" },
  play: async ({ canvasElement }) => {
    await ready(canvasElement)
    await userEvent.click(dial(canvasElement).getByLabelText("Guided"))
    await waitFor(
      () => {
        const scale = barScale(canvasElement, 1)
        expect(scale).toBeGreaterThan(0.15)
        expect(scale).toBeLessThan(0.7)
      },
      { interval: 5, timeout: 1000 }
    )
    await userEvent.click(dial(canvasElement).getByLabelText("Facts"))
    const frames = await sample(900, () => ({
      scale: [1, 2, 3].map((bar) => barScale(canvasElement, bar)),
    }))
    for (const f of frames) {
      await expect(f.scale[1]).toBeLessThan(0.001)
      await expect(f.scale[2]).toBeLessThan(0.001)
      await expect(f.scale[0]).toBeLessThan(0.95)
    }
    await expect(frames.at(-1)!.scale[0]).toBeLessThan(0.01)
  },
}

/**
 * The app's default is the phased choreography: a plain desk (no jig, no
 * substituted atom) morphs its stack and fades its layers by blocks.
 */
export const PhasedIsTheDefault: StoryObj = {
  render: () => (
    <DeliverySettingsAtomProvider value={storySettingsAtom}>
      <ReviewDeskScreen
        data={goDeliveryDeskFixture}
        commentRepository={createMemoryReviewCommentRepository()}
        initialState={{ railCollapsed: true }}
        initialDeliveryStop="briefed"
      />
    </DeliverySettingsAtomProvider>
  ),
  play: async ({ canvasElement }) => {
    await dialShown(canvasElement)
    await userEvent.click(dial(canvasElement).getByLabelText("Explained"))
    const trace = await sample(900, () => ({
      morphing: !["", "none"].includes(
        canvasElement.querySelector<HTMLElement>("[data-delivery-stack]")!.style
          .transform
      ),
    }))
    await expect(trace.some((f) => f.morphing)).toBe(true)
    await arrived(canvasElement, ["How Commit changes", "Go in this unit"])
  },
}

/* ─── The default desk: nothing past the stack, leaving layers in place ── */

/** A plain desk (no jig) at `stop`. */
function plainDesk(stop: DeliveryStop) {
  return (
    <DeliverySettingsAtomProvider value={storySettingsAtom}>
      <ReviewDeskScreen
        data={goDeliveryDeskFixture}
        commentRepository={createMemoryReviewCommentRepository()}
        initialState={{ railCollapsed: true }}
        initialDeliveryStop={stop}
      />
    </DeliverySettingsAtomProvider>
  )
}

/** Opacity as painted: the element's and every ancestor's up to `until`. */
function shownOpacity(element: Element, until: Element) {
  let opacity = 1
  for (let at: Element | null = element; at && at !== until;) {
    opacity *= opacityOf(at)
    at = at.parentElement
  }
  return opacity
}

/**
 * Each phased layer this frame: its place, its top, its most visible
 * block's opacity, and how far a visible block reaches past the stack's
 * visual bottom (inside the layer's own clip, if any).
 */
function layersNow(root: HTMLElement) {
  const stack = root.querySelector<HTMLElement>("[data-delivery-stack]")!
  const edge = stack.getBoundingClientRect().bottom
  return {
    morphing: !["", "none"].includes(stack.style.transform),
    layers: Array.from(
      root.querySelectorAll<HTMLElement>("[data-choreo-layer]"),
      (frameElement) => {
        const marked = Array.from(
          frameElement.querySelectorAll("[data-choreo-block]")
        )
        const blocks = marked.length
          ? marked
          : [frameElement.firstElementChild!]
        const box = frameElement.getBoundingClientRect()
        const clip = /inset\(0(?:px)? 0(?:px)? ([\d.]+)px/.exec(
          frameElement.style.clipPath
        )
        const bottom = clip ? box.bottom - Number(clip[1]) : Infinity
        let opacity = 0
        let spill = 0
        for (const block of blocks) {
          const shown = shownOpacity(block, frameElement.parentElement!)
          opacity = Math.max(opacity, shown)
          if (shown > 0.01)
            spill = Math.max(
              spill,
              Math.min(block.getBoundingClientRect().bottom, bottom) - edge
            )
        }
        return {
          name: frameElement.dataset.choreoLayer!,
          place: frameElement.dataset.place,
          top: box.top,
          opacity,
          spill,
        }
      }
    ),
  }
}

/** Picks `stop` on the dial (no focus), then samples the layers for `duration` ms. */
async function pick(
  canvasElement: HTMLElement,
  stop: DeliveryStop,
  duration = 700
) {
  const before = layersNow(canvasElement)
  dial(canvasElement).getByLabelText<HTMLInputElement>(label(stop)).click()
  return {
    before,
    frames: await sample(duration, () => layersNow(canvasElement)),
  }
}

/**
 * Nothing shows past the stack's moving edge: arriving blocks wait at their
 * target place (at most 5px past, a frame's rounding), and a leaving layer is
 * gone (≤1% opacity) from the frame after the morph's first. Covers the
 * arriving diff and Guided card, and the diff leaving under the Guided card.
 */
export const NothingPastTheStack: StoryObj = {
  render: () => plainDesk("briefed"),
  play: async ({ canvasElement }) => {
    await dialShown(canvasElement)
    await sample(600, () => ({}))
    for (const stop of [
      "guided",
      "explained",
      "guided",
      "facts",
      "guided",
      "briefed",
    ] as const) {
      const { frames } = await pick(canvasElement, stop)
      const spills = frames.flatMap((f) =>
        f.layers.map((l) => ({ stop, layer: l.name, spill: l.spill }))
      )
      for (const s of spills) await expect(s.spill).toBeLessThanOrEqual(5)
      const start = frames.findIndex((f) => f.morphing)
      await expect(start).toBeGreaterThanOrEqual(0)
      for (const f of frames.slice(start + 1))
        for (const leaving of f.layers.filter((l) => l.place === "popped"))
          await expect(leaving.opacity).toBeLessThanOrEqual(0.01)
      await sample(400, () => ({}))
    }
  },
}

/**
 * Reduced motion: a leaving layer fades where it was. It stops taking room
 * at the swap (the height snaps once) but stays at its old place while it
 * fades, not under what stepped in above it; nothing shows past the stack.
 */
export const ReducedLeavesInPlace: StoryObj = {
  render: () => plainDesk("explained"),
  globals: { reducedMotion: "reduce" },
  play: async ({ canvasElement }) => {
    await dialShown(canvasElement)
    await sample(600, () => ({}))
    for (const stop of ["guided", "facts", "guided", "explained"] as const) {
      const { before, frames } = await pick(canvasElement, stop, 500)
      const was = new Map(before.layers.map((l) => [l.name, l.top]))
      let seen = 0
      for (const f of frames)
        for (const l of f.layers) {
          await expect(l.spill).toBeLessThanOrEqual(5)
          if (l.place !== "popped" || l.opacity <= 0.01) continue
          seen++
          await expect(Math.abs(l.top - was.get(l.name)!)).toBeLessThan(1)
        }
      // Something left, and was seen fading.
      await expect(seen).toBeGreaterThan(0)
    }
  },
}

/* ─── Guards: each fails without the fix it names ─────────────────────── */

/** Something a play does in the desk's own jotai store. */
interface DeskCommand {
  inDesk: (set: Setter) => void
}

const deskChoreographyBase = atom<PhasedParams>(PHASED_DEFAULTS)

/**
 * The desk's store, for a play. The desk owns its jotai Provider, so the
 * story kit's store (StoryStoreProvider, HydrateDesk) sits outside it; a
 * story reaches it through an atom the desk reads from context, the
 * choreography's. This one reads as the defaults. Written params replace
 * them (an equal new object re-renders every layer's parent); a written
 * DeskCommand runs in the desk's store. onMount hands the play that writer.
 */
const deskChoreographyAtom = atom(
  (get) => get(deskChoreographyBase),
  (_get, set, update: SetStateAction<PhasedParams> | DeskCommand) => {
    if (typeof update === "object" && "inDesk" in update) update.inDesk(set)
    else set(deskChoreographyBase, update)
  }
)
const desk: {
  write: ((update: PhasedParams | DeskCommand) => void) | null
} = { write: null }
deskChoreographyAtom.onMount = (write) => {
  desk.write = write
  return () => {
    desk.write = null
  }
}

/**
 * A leaving layer's fade never restarts (review r5-phased-1, F1). Briefed →
 * Guided; once the diff has started fading, its parent re-renders. The fade
 * carries on: the diff is at most MORPH_START_OPACITY (+0.05) when the morph
 * starts and gone (≤1%) from the next frame. Re-running the layer's
 * choreography on the new removal callback restarts the fade from where it
 * is, and the diff is still near opaque as the morph starts.
 */
export const LeaveNeverRestarts: StoryObj = {
  render: () => (
    <DeliveryChoreographyAtomProvider value={deskChoreographyAtom}>
      {plainDesk("briefed")}
    </DeliveryChoreographyAtomProvider>
  ),
  play: async ({ canvasElement }) => {
    await dialShown(canvasElement)
    await settled(canvasElement)
    await expect(desk.write).not.toBeNull()
    dial(canvasElement).getByLabelText<HTMLInputElement>("Guided").click()
    const diff = () =>
      layersNow(canvasElement).layers.find((l) => l.name === "diff")
    // Once the diff's fade is under way: re-render its parent.
    for (let n = 0; n < 30 && (diff()?.opacity ?? 0) > 0.9; n++) await frame()
    await expect(diff()?.opacity ?? 1).toBeLessThan(0.9)
    desk.write!({ ...PHASED_DEFAULTS })
    const frames = await sample(600, () => ({
      ...layersNow(canvasElement),
      diff: diff(),
    }))
    const start = frames.findIndex((f) => f.morphing)
    await expect(start).toBeGreaterThanOrEqual(0)
    await expect(frames[start]!.diff?.opacity ?? 0).toBeLessThanOrEqual(
      MORPH_START_OPACITY + 0.05
    )
    for (const f of frames.slice(start + 1))
      await expect(f.diff?.opacity ?? 0).toBeLessThanOrEqual(0.01)
  },
}

const previewStopAtom = atom<DeliveryStop>("explained")

/** The settings preview with its own stop picker. */
function PreviewHarness() {
  const stop = useAtomValue(previewStopAtom)
  const setStop = useSetAtom(previewStopAtom)
  return (
    <div className="flex w-[380px] flex-col gap-3 p-6">
      <div role="radiogroup" aria-label="Preview stop" className="flex gap-3">
        {DELIVERY_STOPS.map((value) => (
          <label key={value} className="flex items-center gap-1 text-xs">
            <input
              type="radio"
              name="preview-stop"
              value={value}
              checked={value === stop}
              onChange={() => setStop(value)}
            />
            {label(value)}
          </label>
        ))}
      </div>
      <DeliveryPreview
        stop={stop}
        rowName="Workspace default"
        termsLabel="Language terms"
      />
    </div>
  )
}

/**
 * The settings preview's morph ends where it ends: no snap after it (review
 * r5-phased-1, F3). Per frame, the stack's height is monotonic and settles
 * at its last morphed height. Covers every change to Guided (flow and terms
 * leave) and Guided → Explained and Facts (the check card leaves; its top
 * margin is the margin case). Without phased layers containing their
 * children's margins (flow-root), a popped layer leaves that margin behind
 * until it's removed: 428 → 416, 329 → 309.
 */
export const PreviewEndsWithoutSnap: StoryObj = {
  render: () => (
    <Provider>
      <PreviewHarness />
    </Provider>
  ),
  play: async ({ canvasElement }) => {
    const show = (stop: DeliveryStop) =>
      within(
        within(canvasElement).getByRole("radiogroup", { name: "Preview stop" })
      )
        .getByLabelText<HTMLInputElement>(label(stop))
        .click()
    const snaps: Array<string> = []
    for (const [from, to] of [
      ["facts", "guided"],
      ["guided", "explained"],
      ["briefed", "guided"],
      ["guided", "facts"],
      ["explained", "guided"],
    ] as const) {
      show(from)
      await sample(500, () => ({}))
      await settled(canvasElement)
      show(to)
      const frames = await sample(700, () => ({
        h: stackHeight(canvasElement)!,
        morphing: !["", "none"].includes(
          canvasElement.querySelector<HTMLElement>("[data-delivery-stack]")!
            .style.transform
        ),
      }))
      const morphed = frames.filter((f) => f.morphing)
      await expect(morphed.length).toBeGreaterThan(0)
      const back = reversal(frames)
      const snap = Math.abs(frames.at(-1)!.h - morphed.at(-1)!.h)
      if (back > 1 || snap > 1)
        snaps.push(
          `${from} → ${to}: ${Math.round(back)}px back, ${Math.round(snap)}px snap`
        )
    }
    // Every pair, so a failure names each change that snapped.
    await expect(snaps).toEqual([])
  },
}

/**
 * The desk dial's pick (pickDeliveryStopAtom: the reader's anchor, then the
 * stop), made in the desk's store. No person can change the stop with the
 * reader past the diff's top (the dial is in the title and closes when its
 * glyph scrolls away); this makes the dial's own pick from there, to guard
 * the line's arithmetic.
 */
function pickInDesk(stop: DeliveryStop) {
  desk.write!({
    inDesk: (set) =>
      set(pickDeliveryStopAtom, {
        unitId: goDeliveryDeskFixture.unit.id,
        language: goDeliveryDeskFixture.delivery!.language,
        stop,
        settings: sampleDeliverySettings,
      }),
  })
}

/**
 * A return during the morph keeps the reader's line (the restore at the
 * beat reads the diff's laid-out top). Explained → Briefed, back to
 * Explained at +330ms (the first morph nearly done), the reader 120px into
 * the diff: the line holds within 0.75px on every frame. Restoring against the
 * diff's top as shown (mid-transform) leaves it 7px off.
 */
export const ReturnKeepsTheLine: StoryObj = {
  render: () => (
    <div data-reader-window="">
      <DeliveryChoreographyAtomProvider value={deskChoreographyAtom}>
        {plainDesk("explained")}
      </DeliveryChoreographyAtomProvider>
    </div>
  ),
  play: async ({ canvasElement }) => {
    shortWindow(canvasElement)
    await waitFor(() => expect(readerLine(canvasElement)).not.toBeNaN())
    await settled(canvasElement)
    await expect(desk.write).not.toBeNull()
    for (const depth of [120, 40]) {
      canvasElement.querySelector<HTMLElement>(
        "[data-desk-scroll]"
      )!.scrollTop = 0
      await frame()
      await readIntoDiff(canvasElement, depth)
      const before = readerLine(canvasElement)
      const startedAt = performance.now()
      pickInDesk("briefed")
      let back = false
      const frames = await sample(1200, () => {
        if (!back && performance.now() - startedAt >= 330) {
          pickInDesk("explained")
          back = true
        }
        return { line: readerLine(canvasElement) }
      })
      await expect(back).toBe(true)
      for (const f of frames)
        await expect(Math.abs(f.line - before)).toBeLessThan(0.75)
      await settled(canvasElement)
    }
  },
}
