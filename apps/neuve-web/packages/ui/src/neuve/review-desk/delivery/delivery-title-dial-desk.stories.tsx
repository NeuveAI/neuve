import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, waitFor, within } from "storybook/test"

import {
  ARRIVE_AT,
  DOCK_BAR_CHAIN,
  DOCK_GLYPH_SHIFT,
  FALL_CHAIN,
  FILL_AT,
  SHRINK_AFTER_FILL,
  dockGlyphBeats,
} from "@workspace/ui/neuve/review-desk/delivery/delivery-dock-dial"
import type { DeskAt } from "@workspace/ui/neuve/story-kit/desk"
import { deskAt, deskMeta } from "@workspace/ui/neuve/story-kit/desk"
import { diffRoot } from "@workspace/ui/neuve/story-kit/dom"
import {
  expectFocusVisible,
  expectNoFocusRing,
  expectTabFocusRing,
  focusColor,
  pause,
  tabTo,
} from "@workspace/ui/neuve/story-kit/play"

/**
 * The delivery dial in the desk's title (round 6, B), on the real desk: its
 * placement in the unit column, its press while a marker card is open, and
 * its stability while the delivery stack morphs under the phased
 * choreography. Round 7: once the title has scrolled away, the same glyph
 * and dial in the decision dock.
 */
const meta = {
  title: "Screens/Review desk/Delivery title dial in the desk",
  ...deskMeta("index-writes", { stop: "briefed" }),
} satisfies Meta<typeof DeskAt>

export default meta
type Story = StoryObj<typeof meta>
type Play = NonNullable<Story["play"]>
type UserEvent = Parameters<Play>[0]["userEvent"]

const glyph = (canvasElement: HTMLElement) =>
  canvasElement.querySelector<HTMLElement>("[data-delivery-trigger]")!

const dialGroup = () =>
  document.querySelector<HTMLElement>(
    '[role="radiogroup"][aria-label="Review delivery"]'
  )

const dialLayer = () =>
  document.querySelector<HTMLElement>("[data-delivery-dial-place]")

const card = () => document.querySelector("[data-floating-card]")

/** Every change of the glyph's aria-expanded while `act` runs. */
async function expandedChanges(
  button: HTMLElement,
  act: () => Promise<void>
): Promise<Array<string | null>> {
  const seen: Array<string | null> = []
  const observer = new MutationObserver(() =>
    seen.push(button.getAttribute("aria-expanded"))
  )
  observer.observe(button, { attributeFilter: ["aria-expanded"] })
  await act()
  await new Promise((resolve) => setTimeout(resolve, 300))
  observer.disconnect()
  return seen
}

/**
 * The glyph sits on the title's line: its vertical centre within 2px of the
 * centre of the title's last line of text (the glyph follows the last line
 * when the title wraps).
 */
async function expectGlyphOnTitleLine(canvasElement: HTMLElement) {
  const title = canvasElement.querySelector("h1")!
  // The title's own face, loaded: on a cold page fonts.ready can resolve
  // before the title's font has even been requested, and the fallback's
  // metrics would place the line elsewhere.
  await document.fonts.load(getComputedStyle(title).font)
  await document.fonts.ready
  await new Promise((resolve) => requestAnimationFrame(resolve))
  const text = document.createRange()
  text.selectNodeContents(title)
  const lines = Array.from(text.getClientRects())
  const last = lines[lines.length - 1]!
  const box = glyph(canvasElement).getBoundingClientRect()
  await expect(
    Math.abs((box.top + box.bottom) / 2 - (last.top + last.bottom) / 2)
  ).toBeLessThanOrEqual(2)
  // And it follows that line's last word.
  await expect(box.left).toBeGreaterThanOrEqual(last.right)
  return lines.length
}

/** The desk at Briefed: the glyph after the title opens the dial beside it. */
export const InTheTitle: Story = {
  play: async ({ canvasElement, userEvent }) => {
    await document.fonts.ready
    const button = glyph(canvasElement)
    await expect(button).toHaveAccessibleName("Review delivery: Briefed")
    // The glyph sits in the title's line, after the h1, centred on it.
    const title = canvasElement.querySelector("h1")!
    await expect(title.parentElement!.contains(button)).toBe(true)
    await expectGlyphOnTitleLine(canvasElement)
    await userEvent.click(button)
    await waitFor(() => expect(dialGroup()).not.toBeNull())
    const scroll = canvasElement.querySelector("[data-desk-scroll]")!
    await expect(scroll.contains(dialLayer())).toBe(true)
    await expect(button.getAttribute("aria-controls")).toBe(dialGroup()!.id)
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(dialGroup()).toBeNull())
    await expect(button).toHaveFocus()
    // Still on the title's line once the dial has opened and closed.
    await expectGlyphOnTitleLine(canvasElement)
  },
}

/**
 * With a marker card open, one press on the glyph closes the card and opens
 * the dial: the glyph is a pass-through for the desk's outside press, as a
 * briefing phrase is.
 */
export const CardOpenGlyphPress: Story = {
  args: deskAt("index-writes", { stop: "briefed", open: "go-retry" }),
  play: async ({ canvasElement, userEvent }) => {
    await waitFor(() => expect(card()).not.toBeNull())
    const button = glyph(canvasElement)
    const changes = await expandedChanges(button, () => userEvent.click(button))
    await expect(changes).toEqual(["true"])
    await waitFor(() => expect(card()).toBeNull())
    await expect(dialGroup()).not.toBeNull()
  },
}

/**
 * The negative: with a card open, a press on plain desk text only closes
 * the card; nothing else opens.
 */
export const CardOpenBlankPress: Story = {
  args: deskAt("index-writes", { stop: "briefed", open: "go-retry" }),
  play: async ({ canvasElement, userEvent }) => {
    await waitFor(() => expect(card()).not.toBeNull())
    const button = glyph(canvasElement)
    const heading = within(canvasElement).getByText(/^Human-required/)
    const changes = await expandedChanges(button, () =>
      userEvent.click(heading)
    )
    await expect(changes).toEqual([])
    await waitFor(() => expect(card()).toBeNull())
    await expect(dialGroup()).toBeNull()
  },
}

/**
 * Where the dial sits relative to the glyph on every frame for `ms`
 * milliseconds, while the caller acts.
 */
function sampleOffsets(button: HTMLElement, ms: number) {
  return new Promise<Array<{ x: number; y: number; shown: boolean }>>(
    (resolve) => {
      const samples: Array<{ x: number; y: number; shown: boolean }> = []
      const start = performance.now()
      const frame = () => {
        const layer = dialLayer()
        if (layer) {
          const at = button.getBoundingClientRect()
          const dial = layer.getBoundingClientRect()
          samples.push({
            x: dial.left - at.left,
            y: dial.top - at.top,
            shown: getComputedStyle(layer).visibility !== "hidden",
          })
        }
        if (performance.now() - start < ms) requestAnimationFrame(frame)
        else resolve(samples)
      }
      requestAnimationFrame(frame)
    }
  )
}

/**
 * The stop changes with the dial open (Briefed → Explained, then Guided):
 * the delivery stack morphs and its layers enter and leave around the
 * title, and the dial stays exactly where it opened against the glyph, on
 * every frame, in either placement.
 */
async function noDrift(
  canvasElement: HTMLElement,
  userEvent: UserEvent,
  place: "beside" | "inline"
) {
  await document.fonts.ready
  const button = glyph(canvasElement)
  button.focus()
  await userEvent.keyboard("{Enter}")
  const radio = (name: string) =>
    within(document.body).getByRole("radio", { name })
  await waitFor(() => expect(radio("Briefed")).toHaveFocus())
  await expect(dialLayer()).toHaveAttribute("data-delivery-dial-place", place)
  // Settled after opening (the spring, or the inline slide).
  await new Promise((resolve) => setTimeout(resolve, 700))
  for (const [key, stop] of [
    ["{ArrowRight}", "Explained"],
    ["{ArrowRight}", "Guided"],
  ] as const) {
    const sampling = sampleOffsets(button, 1200)
    await userEvent.keyboard(key)
    const samples = await sampling
    await expect(radio(stop)).toBeChecked()
    await expect(radio(stop)).toHaveFocus()
    await expect(samples.length).toBeGreaterThan(10)
    await expect(samples.every((sample) => sample.shown)).toBe(true)
    const [first] = samples
    const drift = Math.max(
      ...samples.map((sample) =>
        Math.max(Math.abs(sample.x - first!.x), Math.abs(sample.y - first!.y))
      )
    )
    await expect(drift).toBeLessThan(1)
  }
  await userEvent.keyboard("{Escape}")
  await waitFor(() => expect(dialGroup()).toBeNull())
}

/**
 * Rail collapsed, so the title leaves room in the unit column: the dial
 * floats beside it.
 */
export const NoDriftBeside: Story = {
  args: deskAt("index-writes", { stop: "briefed", rail: "collapsed" }),
  play: async ({ canvasElement, userEvent }) => {
    await noDrift(canvasElement, userEvent, "beside")
  },
}

/**
 * Rail open at 1280: the dial doesn't fit beside the title within the unit
 * column, so it opens in flow under it.
 */
export const NoDriftInline: Story = {
  // Its own 1280 viewport: in a wider frame the dial fits beside the title.
  parameters: {
    viewport: {
      options: {
        desk1280: {
          name: "Desk 1280×800",
          styles: { width: "1280px", height: "800px" },
          type: "desktop",
        },
      },
    },
  },
  globals: { viewport: { value: "desk1280", isRotated: false } },
  play: async ({ canvasElement, userEvent }) => {
    await noDrift(canvasElement, userEvent, "inline")
  },
}

/** Phone: in flow under the title. */
export const NoDriftInlinePhone: Story = {
  globals: { viewport: { value: "phone", isRotated: false } },
  play: async ({ canvasElement, userEvent }) => {
    await document.fonts.ready
    // The title wraps here; the glyph follows its last line, centred on it.
    await expectGlyphOnTitleLine(canvasElement)
    await noDrift(canvasElement, userEvent, "inline")
  },
}

/**
 * The window narrows with the dial open beside the title (1500, rail open)
 * until it no longer fits (the 1280 room): the dial moves under the title,
 * still open, and its checked stop keeps focus. The leaving floating layer
 * must not take that focus for focus outside and close the dial.
 */
export const ResizeMovesTheOpenDial: Story = {
  globals: { viewport: { value: "wide1500", isRotated: false } },
  play: async ({ canvasElement, userEvent }) => {
    await document.fonts.ready
    const button = glyph(canvasElement)
    button.focus()
    await userEvent.keyboard("{Enter}")
    const briefed = () =>
      within(document.body).getByRole("radio", { name: "Briefed" })
    await waitFor(() => expect(briefed()).toHaveFocus())
    await expect(dialLayer()).toHaveAttribute(
      "data-delivery-dial-place",
      "beside"
    )
    // A play can't resize its window: the frame narrows to the 1280 room
    // and the window's resize event follows, as a real resize does.
    canvasElement.style.width = "1280px"
    try {
      window.dispatchEvent(new Event("resize"))
      await waitFor(() =>
        expect(dialLayer()).toHaveAttribute(
          "data-delivery-dial-place",
          "inline"
        )
      )
      // Past the floating layer's exit, when its dismiss would land.
      await pause(400)
      await expect(button).toHaveAttribute("aria-expanded", "true")
      await expect(dialLayer()).toHaveAttribute(
        "data-delivery-dial-place",
        "inline"
      )
      await expect(briefed()).toHaveFocus()
      await userEvent.keyboard("{Escape}")
      await waitFor(() => expect(dialGroup()).toBeNull())
      await expect(button).toHaveFocus()
    } finally {
      canvasElement.style.width = ""
    }
  },
}

/* ── Round 7: the glyph in the dock once the title has scrolled away ── */

/** The desk's scroll column. */
const column = (canvasElement: HTMLElement) =>
  canvasElement.querySelector<HTMLElement>("[data-desk-scroll]")!

/** The dock's delivery glyph (always in the dock; inert while hidden). */
const dockGlyph = (canvasElement: HTMLElement) =>
  canvasElement.querySelector<HTMLElement>("[data-delivery-dock-trigger]")!

/** The extension behind the dock's left edge that holds it. */
const extensionOf = (canvasElement: HTMLElement) =>
  canvasElement.querySelector<HTMLElement>("[data-dock-delivery]")!

const glyphBoxOf = (canvasElement: HTMLElement) =>
  canvasElement.querySelector<HTMLElement>("[data-dock-delivery-glyph]")!

const dockDial = () =>
  document.querySelector<HTMLElement>("[data-delivery-dock-dial]")

/** The dock bar (the rest state's inverse surface). */
const dockBar = (canvasElement: HTMLElement) =>
  canvasElement.querySelector<HTMLElement>('[data-surface="inverse"]')!

/** The dock's body, which never moves. */
const dockBody = (canvasElement: HTMLElement) =>
  dockBar(canvasElement).querySelector<HTMLElement>("[data-dock-body]")!

/** The dock's scope ("Covers …"). */
const dockScope = (canvasElement: HTMLElement) =>
  within(dockBar(canvasElement)).getByText(/^Covers /)

/** The dock's actions: its buttons other than the delivery glyph. */
const dockActions = (canvasElement: HTMLElement) =>
  Array.from(
    dockBar(canvasElement).querySelectorAll<HTMLElement>("button")
  ).filter((button) => !button.hasAttribute("data-delivery-dock-trigger"))

/** The short desk: room to scroll the title well out of the column. */
const SHORT = { viewport: { value: "short", isRotated: false } } as const

/** What is still animating under `root`. */
const running = (root: Element) =>
  root
    .getAnimations({ subtree: true })
    .filter((animation) => animation.playState === "running")

/**
 * Fonts in, the diff rendered (its highlighting is the first load's long
 * task) and the desk settled at the top: the dock has risen and nothing in
 * it moves, so frames are sampled steadily.
 */
async function deskReady(canvasElement: HTMLElement) {
  await document.fonts.ready
  await waitFor(() => expect(glyph(canvasElement)).toBeVisible())
  await diffRoot(canvasElement)
  await waitFor(() => expect(running(dockBar(canvasElement))).toEqual([]), {
    timeout: 3000,
  })
}

const shown = (canvasElement: HTMLElement) =>
  extensionOf(canvasElement).hasAttribute("data-shown")

/** Scrolls the column to its end: the title's glyph leaves it. */
async function scrollTitleAway(canvasElement: HTMLElement) {
  const scroller = column(canvasElement)
  scroller.scrollTop = scroller.scrollHeight
  await waitFor(() => expect(shown(canvasElement)).toBe(true))
}

/** Scrolls the column back to its top: the title's glyph comes back. */
function scrollTitleBack(canvasElement: HTMLElement) {
  column(canvasElement).scrollTop = 0
}

/** The glyph has left the dock: hidden once its exit is over. */
const dockGlyphGone = (canvasElement: HTMLElement) =>
  waitFor(
    () => {
      expect(shown(canvasElement)).toBe(false)
      expect(getComputedStyle(glyphBoxOf(canvasElement)).visibility).toBe(
        "hidden"
      )
    },
    { timeout: 2000 }
  )

/**
 * Tab onto the dock's glyph and check its ring (expectTabFocusRing),
 * starting from the last stop of the column's own controls before the dock:
 * a walk from the top would cross every diff line first.
 */
async function tabToDockGlyph(
  canvasElement: HTMLElement,
  userEvent: UserEvent
) {
  const button = dockGlyph(canvasElement)
  const bar = dockBar(canvasElement)
  const before = Array.from(
    column(canvasElement).querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], input, [tabindex="0"]'
    )
  )
    .filter(
      (element) =>
        !bar.contains(element) &&
        element.compareDocumentPosition(button) &
          Node.DOCUMENT_POSITION_FOLLOWING
    )
    .at(-1)
  before?.focus({ preventScroll: true })
  await expectTabFocusRing(userEvent, button)
  return button
}

interface DockFrame {
  /** Ms since the sampling started. */
  t: number
  /** The glyph's opacity and scale. */
  opacity: number
  scale: number
  /** The extension's left edge, as it shows. */
  extension: number
  /** The body's left and right edges, as they show. */
  body: { left: number; right: number }
  /** Every action's horizontal place, as it shows. */
  actions: string
}

const scaleOf = (element: Element) => {
  const value = getComputedStyle(element).scale
  return value === "none" ? 1 : Number(value.split(" ")[0])
}

/**
 * An element's horizontal place, as it shows. Only x: the sticky dock's
 * top can shift by a subpixel as the column scrolls to its end.
 */
const boxKey = (element: Element) => {
  const box = element.getBoundingClientRect()
  return [box.left, box.right].map((value) => value.toFixed(1)).join(",")
}

/** Samples the dock on every frame for `ms` while the caller acts. */
function sampleDock(canvasElement: HTMLElement, ms: number) {
  return new Promise<Array<DockFrame>>((resolve) => {
    const frames: Array<DockFrame> = []
    const start = performance.now()
    const frame = () => {
      const box = glyphBoxOf(canvasElement)
      const body = dockBody(canvasElement).getBoundingClientRect()
      frames.push({
        t: performance.now() - start,
        opacity: Number(getComputedStyle(box).opacity),
        scale: scaleOf(box),
        extension: extensionOf(canvasElement).getBoundingClientRect().left,
        body: { left: body.left, right: body.right },
        actions: dockActions(canvasElement).map(boxKey).join("|"),
      })
      if (performance.now() - start < ms) requestAnimationFrame(frame)
      else resolve(frames)
    }
    requestAnimationFrame(frame)
  })
}

/** The centre of the desk's column (its content box, no scrollbar). */
function columnCentre(canvasElement: HTMLElement) {
  const scroller = column(canvasElement)
  return scroller.getBoundingClientRect().left + scroller.clientWidth / 2
}

/** Two frames of slack for the observer and the frame clock (ms). */
const SLACK = 34

/** The delay of an element's running CSS transition of `property` (ms). */
function transitionDelay(element: Element, property: string) {
  const run = element
    .getAnimations()
    .find(
      (animation) =>
        animation instanceof CSSTransition &&
        animation.transitionProperty === property
    )
  return run?.effect?.getTiming().delay
}

/** The dock glyph's beats at this file's stop (Briefed, two filled bars). */
const BEATS = dockGlyphBeats("briefed")

/**
 * Scroll the title out of the column: the extension slides out from under
 * the dock's body at its left, its bars grow in once it has landed (the
 * glyph itself never scales), and once the bars and fills are up
 * (recentreIn) the whole dock moves right by DOCK_GLYPH_SHIFT, so the two
 * are centred together. Until then the body and the actions don't move.
 * Scroll back: the bars leave, the glyph fades (glyphOut), then the
 * extension slides back (extensionBack), and once it is back (recentreOut)
 * the dock re-centres on its body. Nothing else moves.
 */
export const DockGlyphFollowsTheTitle: Story = {
  globals: SHORT,
  play: async ({ canvasElement }) => {
    await deskReady(canvasElement)
    const extension = extensionOf(canvasElement)
    const body = dockBody(canvasElement)
    const bar = dockBar(canvasElement)
    const centre = columnCentre(canvasElement)
    await expect(shown(canvasElement)).toBe(false)
    // Hidden: the glyph is out of reach, and the extension rests fully
    // under the body, its corners on the body's; the body is centred.
    await expect(extension).toHaveAttribute("inert")
    await expect(getComputedStyle(glyphBoxOf(canvasElement)).visibility).toBe(
      "hidden"
    )
    const rest = extension.getBoundingClientRect()
    const bodyBox = body.getBoundingClientRect()
    await expect(Math.abs(rest.left - bodyBox.left)).toBeLessThan(0.5)
    await expect(rest.right).toBeLessThanOrEqual(bodyBox.right)
    await expect(getComputedStyle(extension).zIndex).toBe("-2")
    await expect(getComputedStyle(body).zIndex).toBe("-1")
    for (const corner of [
      "borderTopLeftRadius",
      "borderTopRightRadius",
      "borderBottomLeftRadius",
      "borderBottomRightRadius",
    ] as const)
      await expect(getComputedStyle(extension)[corner]).toBe(
        getComputedStyle(body).borderTopLeftRadius
      )
    await expect(
      Math.abs((bodyBox.left + bodyBox.right) / 2 - centre)
    ).toBeLessThan(1)
    const before = (await sampleDock(canvasElement, 0))[0]!

    const arriving = sampleDock(canvasElement, 1000)
    await scrollTitleAway(canvasElement)
    // The extension at once, the dock at recentreIn.
    await expect(transitionDelay(extension, "translate")).toBe(0)
    await expect(transitionDelay(bar, "translate")).toBeCloseTo(
      BEATS.recentreIn,
      3
    )
    const arrival = await arriving
    const button = dockGlyph(canvasElement)
    await expect(button).toHaveAccessibleName("Review delivery: Briefed")
    await expect(button).toHaveAttribute("aria-expanded", "false")
    await expect(extension).not.toHaveAttribute("inert")
    await expect(
      extension.compareDocumentPosition(dockScope(canvasElement)) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    // Whatever frames were sampled (the frame clock may be coarse): until
    // the re-centre (counted from before the scroll, so earlier still), the
    // body and the actions have not moved; the glyph never scales.
    const moved = arrival.filter(
      (frame) =>
        frame.t < BEATS.recentreIn &&
        (frame.body.left !== before.body.left ||
          frame.actions !== before.actions)
    )
    await expect(
      moved,
      `body held on arrival: ${JSON.stringify({ before, moved })}`
    ).toEqual([])
    await expect(arrival.filter((frame) => frame.scale !== 1)).toEqual([])
    await waitFor(() => expect(running(bar)).toEqual([]), { timeout: 3000 })
    // The glyph sits centred in its cell as it reads: between the
    // extension's left edge and the middle of the notch the body's rounded
    // corner leaves (half the radius past the body's edge).
    const glyphBox = glyphBoxOf(canvasElement).getBoundingClientRect()
    const notch = parseFloat(getComputedStyle(body).borderTopLeftRadius) / 2
    const cell = {
      left: extension.getBoundingClientRect().left,
      right: body.getBoundingClientRect().left + notch,
    }
    await expect(
      Math.abs(glyphBox.left - cell.left - (cell.right - glyphBox.right))
    ).toBeLessThan(0.5)
    // In: the glyph whole, the dock moved by DOCK_GLYPH_SHIFT, and the
    // extension and the body centred together in the column.
    const inside = (await sampleDock(canvasElement, 0))[0]!
    await expect([inside.opacity, inside.scale]).toEqual([1, 1])
    await expect(inside.body.left - before.body.left).toBeCloseTo(
      DOCK_GLYPH_SHIFT,
      0
    )
    await expect(
      Math.abs((inside.extension + inside.body.right) / 2 - centre)
    ).toBeLessThan(1)

    const leaving = sampleDock(canvasElement, 1000)
    scrollTitleBack(canvasElement)
    // The glyph at glyphOut, the extension at extensionBack, the dock at
    // recentreOut.
    await waitFor(() => expect(shown(canvasElement)).toBe(false))
    await expect(
      transitionDelay(glyphBoxOf(canvasElement), "opacity")
    ).toBeCloseTo(BEATS.glyphOut, 3)
    await expect(transitionDelay(extension, "translate")).toBeCloseTo(
      BEATS.extensionBack,
      3
    )
    await expect(transitionDelay(bar, "translate")).toBeCloseTo(
      BEATS.recentreOut,
      3
    )
    const exit = await leaving
    await dockGlyphGone(canvasElement)
    // While the extension is still out (not yet back under the body), the
    // body and the actions hold where they were.
    await expect(
      exit.filter(
        (frame) =>
          frame.extension < frame.body.left - 0.5 &&
          frame.actions !== inside.actions
      ),
      "body held on exit, inside: " + JSON.stringify(inside)
    ).toEqual([])
    await waitFor(() => expect(running(bar)).toEqual([]), { timeout: 3000 })
    // Back: the body centred again, the actions where they started, and
    // the extension under the body.
    const out = (await sampleDock(canvasElement, 0))[0]!
    await expect(out.actions).toBe(before.actions)
    await expect(
      Math.abs((out.body.left + out.body.right) / 2 - centre)
    ).toBeLessThan(1)
    await expect(out.extension).toBeCloseTo(out.body.left, 0)
  },
}

/** A token's colour as the browser resolves it (read outside waitFor). */
function tokenColor(token: string) {
  const probe = document.createElement("span")
  probe.style.color = `var(${token})`
  document.body.append(probe)
  const color = getComputedStyle(probe).color
  probe.remove()
  return color
}

/** An element's background once its tone transition has settled. */
async function settledBackground(element: HTMLElement) {
  await waitFor(() => expect(element.getAnimations()).toEqual([]), {
    timeout: 3000,
  })
  return getComputedStyle(element).backgroundColor
}

/**
 * From the keyboard: Tab reaches the dock's glyph with the inverse ring;
 * Enter opens the dial above it, wearing the dock (dock fill, dock-hover
 * thumb, dock-fg checked stop), with the checked stop focused in the
 * inverse ring. Rest, focus and open each look different. Escape folds it
 * and returns focus to the dock's glyph; the glyph again folds it too.
 */
export const DockDialFromKeyboard: Story = {
  globals: SHORT,
  play: async ({ canvasElement, userEvent }) => {
    await deskReady(canvasElement)
    await scrollTitleAway(canvasElement)
    await pause(600)
    const rest = await settledBackground(dockGlyph(canvasElement))
    const button = await tabToDockGlyph(canvasElement, userEvent)
    // The dock's ring: the inverse focus colour.
    const inverse = tokenColor("--nv-focus-inverse")
    await expect(getComputedStyle(button).outlineColor).toBe(inverse)
    const focused = await settledBackground(button)
    await userEvent.keyboard("{Enter}")
    await waitFor(() => expect(dockDial()).not.toBeNull())
    await expect(button).toHaveAttribute("aria-expanded", "true")
    // Open is neither rest nor hover and focus.
    const open = await settledBackground(button)
    await expect(new Set([rest, focused, open]).size).toBe(3)
    await expect(open).toBe(tokenColor("--nv-dock-line"))
    await expect(focused).toBe(tokenColor("--nv-dock-hover"))
    const briefed = await within(document.body).findByRole("radio", {
      name: "Briefed",
    })
    await waitFor(() => expect(briefed).toHaveFocus())
    await expectFocusVisible(briefed, { ring: false })
    // The dial wears the dock, and its stop ring is the inverse one.
    const group = within(dockDial()!).getByRole("radiogroup")
    await expect(getComputedStyle(group).backgroundColor).toBe(
      tokenColor("--nv-dock")
    )
    const label = briefed.closest("label")!
    await expect(getComputedStyle(label).color).toBe(tokenColor("--nv-dock-fg"))
    await waitFor(() =>
      expect(getComputedStyle(label).outlineColor).toBe(inverse)
    )
    // Above the glyph.
    await expect(dockDial()!.getBoundingClientRect().bottom).toBeLessThan(
      button.getBoundingClientRect().top
    )
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(dockDial()).toBeNull())
    await expect(button).toHaveFocus()
    await expectFocusVisible(button)
    await expect(button).toHaveAttribute("aria-expanded", "false")
    // The glyph again folds it.
    await userEvent.keyboard("{Enter}")
    await waitFor(() => expect(dockDial()).not.toBeNull())
    await userEvent.click(button)
    await waitFor(() => expect(dockDial()).toBeNull())
  },
}

/**
 * A press outside the dial (here on the dock's own scope) folds it; focus
 * stays where the press put it.
 */
export const DockDialOutsidePress: Story = {
  globals: SHORT,
  play: async ({ canvasElement, userEvent }) => {
    await deskReady(canvasElement)
    await scrollTitleAway(canvasElement)
    await pause(600)
    await userEvent.click(dockGlyph(canvasElement))
    await waitFor(() => expect(dockDial()).not.toBeNull())
    // A pointer open: the checked stop takes focus without a ring.
    const briefed = await within(document.body).findByRole("radio", {
      name: "Briefed",
    })
    await waitFor(() => expect(briefed).toHaveFocus())
    await expectNoFocusRing(briefed)
    await userEvent.click(dockScope(canvasElement))
    await waitFor(() => expect(dockDial()).toBeNull())
    await expect(dockGlyph(canvasElement)).toHaveAttribute(
      "aria-expanded",
      "false"
    )
    await expect(dockGlyph(canvasElement)).not.toHaveFocus()
  },
}

/**
 * Guided from the dock's dial: the dial stays open with Guided checked and
 * focused, the dock keeps its glyph (it adds no decision), and the dock
 * swaps to the lane's verbs for the suggested review. The title shows the
 * same stop.
 */
export const DockDialChoosesGuided: Story = {
  globals: SHORT,
  play: async ({ canvasElement, userEvent }) => {
    await deskReady(canvasElement)
    await scrollTitleAway(canvasElement)
    await pause(600)
    await userEvent.click(dockGlyph(canvasElement))
    await waitFor(() => expect(dockDial()).not.toBeNull())
    await userEvent.keyboard("{ArrowRight}{ArrowRight}")
    const bar = () => within(dockBar(canvasElement))
    await waitFor(() =>
      expect(bar().getByRole("button", { name: "Edit request" })).toBeVisible()
    )
    await waitFor(() => expect(dockDial()).not.toBeNull())
    const guided = await within(document.body).findByRole("radio", {
      name: "Guided",
    })
    await expect(guided).toBeChecked()
    await waitFor(() => expect(guided).toHaveFocus())
    await expect(shown(canvasElement)).toBe(true)
    await expect(dockGlyph(canvasElement)).toHaveAccessibleName(
      "Review delivery: Guided"
    )
    await expect(glyph(canvasElement)).toHaveAccessibleName(
      "Review delivery: Guided"
    )
    // The suggested review's verbs, once the new dock state has risen.
    await waitFor(() => {
      expect(
        bar().getByRole("button", { name: /^Request changes/ })
      ).toBeVisible()
      expect(bar().getByRole("button", { name: "Approve" })).toBeVisible()
    })
  },
}

/**
 * The title comes back while the dock's dial is open with focus in it: the
 * dial closes with the dock's glyph, and focus lands on the title's glyph
 * (with the ring, as it had one), never on the page.
 */
export const TitleBackClosesDockDial: Story = {
  globals: SHORT,
  play: async ({ canvasElement, userEvent }) => {
    await deskReady(canvasElement)
    await scrollTitleAway(canvasElement)
    await pause(600)
    await tabToDockGlyph(canvasElement, userEvent)
    await userEvent.keyboard("{Enter}")
    await waitFor(() => expect(dockDial()).not.toBeNull())
    scrollTitleBack(canvasElement)
    await dockGlyphGone(canvasElement)
    await waitFor(() => expect(dockDial()).toBeNull())
    await expect(glyph(canvasElement)).toHaveFocus()
    await expectFocusVisible(glyph(canvasElement))
    await expect(glyph(canvasElement)).toHaveAttribute("aria-expanded", "false")
  },
}

/**
 * The title scrolls out while its own dial is open with focus in it: the
 * dial closes, and focus moves to the dock's glyph as it arrives.
 */
export const TitleAwayClosesTitleDial: Story = {
  globals: SHORT,
  play: async ({ canvasElement, userEvent }) => {
    await deskReady(canvasElement)
    await tabTo(glyph(canvasElement), userEvent)
    await userEvent.keyboard("{Enter}")
    await waitFor(() =>
      expect(
        within(document.body).getByRole("radio", { name: "Briefed" })
      ).toHaveFocus()
    )
    await scrollTitleAway(canvasElement)
    await waitFor(() => expect(dockGlyph(canvasElement)).toHaveFocus())
    await expectFocusVisible(dockGlyph(canvasElement))
    await expect(glyph(canvasElement)).toHaveAttribute("aria-expanded", "false")
    await waitFor(() => expect(dialLayer()).toBeNull())
  },
}

/**
 * Human-suggested: at Guided the code leaves and the review card carries
 * the check, so the column gets shorter and the title comes back. Choosing
 * Guided from the dock's dial closes it that way, focus on the title's
 * glyph.
 */
export const GuidedBringsTheTitleBack: Story = {
  args: deskAt("index-writes", { stop: "briefed", lane: "human-suggested" }),
  // Tall enough for the Guided column (600px) to fit, short enough for the
  // Briefed one to scroll the title away.
  parameters: {
    viewport: {
      options: {
        desk1100x700: {
          name: "Desk 1100×700",
          styles: { width: "1100px", height: "700px" },
          type: "desktop",
        },
      },
    },
  },
  globals: { viewport: { value: "desk1100x700", isRotated: false } },
  play: async ({ canvasElement, userEvent }) => {
    await deskReady(canvasElement)
    await scrollTitleAway(canvasElement)
    await pause(600)
    await tabToDockGlyph(canvasElement, userEvent)
    await userEvent.keyboard("{Enter}")
    await waitFor(() => expect(dockDial()).not.toBeNull())
    await userEvent.keyboard("{ArrowRight}{ArrowRight}")
    await dockGlyphGone(canvasElement)
    await waitFor(() => expect(dockDial()).toBeNull())
    await expect(glyph(canvasElement)).toHaveAccessibleName(
      "Review delivery: Guided"
    )
    await waitFor(() => expect(glyph(canvasElement)).toHaveFocus())
  },
}

/**
 * Reduced motion: the glyph, the extension and the dock's re-centring
 * change in one step, in and out.
 */
export const DockGlyphReducedMotion: Story = {
  globals: { ...SHORT, reducedMotion: "reduce" },
  play: async ({ canvasElement }) => {
    await deskReady(canvasElement)
    const before = (await sampleDock(canvasElement, 0))[0]!
    await scrollTitleAway(canvasElement)
    // From the first frame after the change, it is all the way in, and
    // nothing in the dock animates.
    const arrival = await sampleDock(canvasElement, 100)
    const inside = arrival[0]!
    await expect(inside.extension).toBeLessThan(before.extension - 20)
    await expect(inside.body.left - before.body.left).toBeCloseTo(
      DOCK_GLYPH_SHIFT,
      0
    )
    await expect(
      arrival.every(
        (frame) =>
          frame.opacity === 1 &&
          frame.scale === 1 &&
          frame.extension === inside.extension &&
          frame.actions === inside.actions
      )
    ).toBe(true)
    await expect(running(dockBar(canvasElement))).toEqual([])
    scrollTitleBack(canvasElement)
    await waitFor(() => expect(shown(canvasElement)).toBe(false))
    // And back in one step.
    const exit = await sampleDock(canvasElement, 100)
    await expect(
      exit.every(
        (frame) =>
          frame.opacity === 0 &&
          frame.extension === before.extension &&
          frame.actions === before.actions
      )
    ).toBe(true)
    await expect(running(dockBar(canvasElement))).toEqual([])
  },
}

/**
 * The title's glyph: rest, hover and keyboard focus, and open each look
 * different (open is raised-2 with a line edge, never the hover fill).
 */
export const TitleGlyphOpenState: Story = {
  play: async ({ canvasElement, userEvent }) => {
    await deskReady(canvasElement)
    const button = glyph(canvasElement)
    const rest = await settledBackground(button)
    await tabTo(button, userEvent)
    const focused = await settledBackground(button)
    await userEvent.keyboard("{Enter}")
    await waitFor(() => expect(dialGroup()).not.toBeNull())
    await expect(button).toHaveAttribute("aria-expanded", "true")
    const open = await settledBackground(button)
    await expect(new Set([rest, focused, open]).size).toBe(3)
    await expect(focused).toBe(tokenColor("--nv-raised"))
    await expect(open).toBe(tokenColor("--nv-raised-2"))
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(dialGroup()).toBeNull())
  },
}

/**
 * Quick reversals turn back from where things are: the title back while
 * the extension is still sliding out sends it straight back (no beat), and
 * the title away again before the exit is over brings the glyph straight
 * in without replaying its bars' rise.
 */
export const DockGlyphQuickReversal: Story = {
  globals: SHORT,
  play: async ({ canvasElement }) => {
    await deskReady(canvasElement)
    const extension = extensionOf(canvasElement)
    const rest = extension.getBoundingClientRect().left
    await scrollTitleAway(canvasElement)
    // Part-way out (the frame clock moves it; wait for that, not a time).
    await waitFor(() =>
      expect(extension.getBoundingClientRect().left).toBeLessThan(rest - 0.5)
    )
    // Back mid-slide: the extension turns at once (no beat), from where it
    // is.
    scrollTitleBack(canvasElement)
    await waitFor(() => expect(shown(canvasElement)).toBe(false))
    const back = extension
      .getAnimations()
      .find(
        (run) =>
          run instanceof CSSTransition && run.transitionProperty === "translate"
      )!
    await expect(back.effect!.getTiming().delay).toBe(0)
    // Away again at once, while the exit is still moving: the glyph comes
    // at once, and its bars' rise is never started again (whatever runs is
    // the first one).
    await expect(back.playState).toBe("running")
    await expect(running(dockBar(canvasElement)).length).toBeGreaterThan(0)
    const ticks = Array.from(
      glyphBoxOf(canvasElement).querySelectorAll("i, i > b")
    )
    const rising = new Set(ticks.flatMap((tick) => tick.getAnimations()))
    await scrollTitleAway(canvasElement)
    await waitFor(() =>
      expect(getComputedStyle(glyphBoxOf(canvasElement)).opacity).toBe("1")
    )
    await expect(
      ticks
        .flatMap((tick) => tick.getAnimations())
        .every((run) => rising.has(run))
    ).toBe(true)
  },
}

/** The dock bar's own re-centre (its `translate`), as computed now (px). */
const recentre = (canvasElement: HTMLElement) => {
  const value = getComputedStyle(dockBar(canvasElement)).translate
  return value === "none" ? 0 : parseFloat(value)
}

/**
 * A dock that has just mounted (the composer opened and closed again) is
 * not mid-change: the first arrival after it plays the whole storyboard.
 * The extension at once, the re-centre at recentreIn, and the body holds
 * still until then.
 */
export const DockGlyphAfterDockRemount: Story = {
  globals: SHORT,
  play: async ({ canvasElement, userEvent }) => {
    await deskReady(canvasElement)
    const bar = () => within(dockBar(canvasElement))
    await userEvent.click(
      bar().getByRole("button", { name: /^Request changes/ })
    )
    await waitFor(() =>
      expect(within(canvasElement).getByRole("dialog")).toBeVisible()
    )
    // The composer may have moved the column (its attached context): the
    // title back in view before the rest dock returns.
    scrollTitleBack(canvasElement)
    await waitFor(() =>
      expect(glyph(canvasElement).getBoundingClientRect().top).toBeGreaterThan(
        column(canvasElement).getBoundingClientRect().top
      )
    )
    await userEvent.keyboard("{Escape}")
    // The rest dock is back, freshly mounted with the glyph hidden: scroll
    // at once.
    await waitFor(() => {
      const fresh = canvasElement.querySelector(
        '[data-surface="inverse"] [data-dock-delivery]'
      )
      expect(fresh).toBeTruthy()
      expect(fresh).not.toHaveAttribute("data-shown")
    })
    const frames: Array<{ t: number; shift: number }> = []
    let start = 0
    let sampling = true
    const frame = () => {
      if (shown(canvasElement)) {
        start ||= performance.now()
        frames.push({
          t: performance.now() - start,
          shift: recentre(canvasElement),
        })
      }
      if (sampling) requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
    await scrollTitleAway(canvasElement)
    await expect(transitionDelay(extensionOf(canvasElement), "translate")).toBe(
      0
    )
    await expect(
      transitionDelay(dockBar(canvasElement), "translate")
    ).toBeCloseTo(BEATS.recentreIn, 3)
    // Until the re-centre is over (frames may come far apart), then one
    // last sample.
    await waitFor(() => expect(running(dockBar(canvasElement))).toEqual([]), {
      timeout: 3000,
    })
    sampling = false
    frames.push({
      t: performance.now() - start,
      shift: recentre(canvasElement),
    })
    // The body holds until the re-centre, then moves by DOCK_GLYPH_SHIFT.
    const moving = frames.find((at) => at.shift > 0.01)!
    await expect(moving.t).toBeGreaterThanOrEqual(BEATS.recentreIn - SLACK)
    await expect(frames.at(-1)!.shift).toBeCloseTo(DOCK_GLYPH_SHIFT, 1)
  },
}

/** The glyph's four bars, first to last. */
const barsOfGlyph = (canvasElement: HTMLElement) =>
  Array.from(glyphBoxOf(canvasElement).querySelectorAll<HTMLElement>("i"))

/** The fill inside a bar. */
const fillOf = (bar: Element) => bar.querySelector(":scope > b")!

/** An element's run whose first keyframe has this transform. */
const runFrom = (element: Element, transform: string) =>
  element
    .getAnimations()
    .find(
      (run) =>
        (run.effect as KeyframeEffect | null)?.getKeyframes()[0]?.transform ===
        transform
    )

/**
 * On a clean arrival the glyph never scales: its four bars grow from their
 * base in turn, the first at ARRIVE_AT and each next DOCK_BAR_CHAIN later, and a
 * filled bar's fill rises FILL_AT after its bar starts (once the bar has
 * made SHARE.fillStart of its height).
 */
export const DockGlyphTicksRise: Story = {
  globals: SHORT,
  play: async ({ canvasElement }) => {
    await deskReady(canvasElement)
    await scrollTitleAway(canvasElement)
    const bars = barsOfGlyph(canvasElement)
    await expect(bars).toHaveLength(4)
    const grows = bars.map((bar) => runFrom(bar, "scaleY(0)"))
    await expect(grows.every(Boolean)).toBe(true)
    await expect(grows.map((run) => run!.effect!.getTiming().delay)).toEqual(
      bars.map((_, index) => ARRIVE_AT + index * DOCK_BAR_CHAIN)
    )
    // Briefed: the first two bars are filled.
    const filled = bars.filter((bar) => bar.hasAttribute("data-filled"))
    await expect(filled).toEqual(bars.slice(0, 2))
    const fills = filled.map((bar) => runFrom(fillOf(bar), "scaleY(0)"))
    await expect(fills.map((run) => run?.effect?.getTiming().delay)).toEqual(
      filled.map((_, index) => ARRIVE_AT + index * DOCK_BAR_CHAIN + FILL_AT)
    )
    await expect(getComputedStyle(glyphBoxOf(canvasElement)).scale).toBe("none")
  },
}

/**
 * On a clean exit the bars leave before the glyph does, the last first, at
 * twice the arrival's speed: each bar FALL_CHAIN after the one after it,
 * its fill falling first and the bar shrinking SHRINK_AFTER_FILL later; the
 * glyph fades as the first bar shrinks (glyphOut). Back again while they
 * leave: what has started turns back from where it is, what hasn't is
 * left, and nothing rises again.
 */
export const DockGlyphTicksFall: Story = {
  globals: SHORT,
  play: async ({ canvasElement }) => {
    await deskReady(canvasElement)
    await scrollTitleAway(canvasElement)
    await waitFor(() => expect(running(dockBar(canvasElement))).toEqual([]), {
      timeout: 3000,
    })
    const bars = barsOfGlyph(canvasElement)
    scrollTitleBack(canvasElement)
    await waitFor(() => expect(shown(canvasElement)).toBe(false))
    const shrinks = bars.map((bar) => runFrom(bar, "scaleY(1)"))
    await expect(shrinks.every(Boolean)).toBe(true)
    await expect(shrinks.map((run) => run!.effect!.getTiming().delay)).toEqual(
      bars.map(
        (_, index) => (bars.length - 1 - index) * FALL_CHAIN + SHRINK_AFTER_FILL
      )
    )
    // Briefed: only the first two bars have a fill to drop.
    const drops = bars.map((bar) => runFrom(fillOf(bar), "scaleY(1)"))
    await expect(drops.map((run) => run?.effect?.getTiming().delay)).toEqual([
      3 * FALL_CHAIN,
      2 * FALL_CHAIN,
      undefined,
      undefined,
    ])
    await expect(
      transitionDelay(glyphBoxOf(canvasElement), "opacity")
    ).toBeCloseTo(BEATS.glyphOut, 3)
    // Away again while the last bar is shrinking: it turns back from where
    // it is; the others turn back too if they had started, or are left if
    // not. No rise starts.
    const last = shrinks.at(-1)!
    await waitFor(() =>
      expect(last.effect!.getComputedTiming().progress).toBeGreaterThan(0)
    )
    await scrollTitleAway(canvasElement)
    // A reversed run takes its new rate once it is ready.
    const leaving = [...shrinks, ...drops].filter(Boolean) as Array<Animation>
    await Promise.all(leaving.map((run) => run.ready))
    await expect(last.playbackRate).toBe(-1)
    await expect(
      leaving.every(
        (run) => run.playbackRate === -1 || run.playState === "idle"
      )
    ).toBe(true)
    await expect(
      bars
        .flatMap((bar) => [bar, fillOf(bar)])
        .flatMap((element) => element.getAnimations())
        .map((run) => (run.effect as KeyframeEffect).getKeyframes()[0])
        .filter((at) => at?.transform === "scaleY(0)" || at?.opacity === "0")
    ).toEqual([])
    // Back up: the shrink has no effect left.
    await waitFor(() => expect(last.playState).toBe("finished"))
    await expect(getComputedStyle(bars.at(-1)!).transform).toBe("none")
  },
}

/**
 * Tab out of the dock's dial (from its checked stop) moves on to the dock's
 * scope, and the dial closes, as focus leaving any popover layer does.
 */
export const DockDialTabOut: Story = {
  globals: SHORT,
  play: async ({ canvasElement, userEvent }) => {
    await deskReady(canvasElement)
    await scrollTitleAway(canvasElement)
    await tabToDockGlyph(canvasElement, userEvent)
    await userEvent.keyboard("{Enter}")
    await waitFor(() => expect(dockDial()).not.toBeNull())
    const briefed = await within(document.body).findByRole("radio", {
      name: "Briefed",
    })
    await waitFor(() => expect(briefed).toHaveFocus())
    await userEvent.tab()
    await waitFor(() => expect(dockDial()).toBeNull())
    await expect(dockScope(canvasElement)).toHaveFocus()
    await expect(dockGlyph(canvasElement)).toHaveAttribute(
      "aria-expanded",
      "false"
    )
  },
}
