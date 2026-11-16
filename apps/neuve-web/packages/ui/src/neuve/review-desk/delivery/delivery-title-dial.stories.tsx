import * as React from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { Provider, atom, useAtom } from "jotai"
import { expect, waitFor, within } from "storybook/test"

import {
  GO_UNIT_TITLE,
  goDeliveryUnit,
} from "@workspace/ui/fixtures/delivery.fixtures"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover"
import { DeliveryTitleDial } from "@workspace/ui/neuve/review-desk/delivery/delivery-title-dial"
import {
  expectFocusVisible,
  expectNoFocusRing,
} from "@workspace/ui/neuve/story-kit/play"
import type { DeliveryStop } from "@workspace/ui/neuve/shared/delivery"

/** Story-only stop; each story gets its own jotai store (decorator). */
const storyStopAtom = atom<DeliveryStop>("briefed")

/**
 * The desk's title block (briefing.tsx): the h1 with the glyph after it,
 * then the unit's briefing, its phrases as links, so Tab has somewhere to
 * go after the dial.
 */
function TitleBlock({
  stop,
  width,
  boundToFrame = false,
  barDelay,
  flow,
  after,
}: {
  stop?: DeliveryStop
  /** Between the title and the briefing (the desk's "Reported gaps"). */
  after?: React.ReactNode
  /** The region the inline dial pushes (DeliveryTitleDial `flow`). */
  flow?: React.RefObject<HTMLElement | null>
  /** Milliseconds between ticks when the stop changes. */
  barDelay?: number
  width?: number
  /** The dial fits beside the glyph only inside this frame. */
  boundToFrame?: boolean
}) {
  const stopAtom = React.useMemo(
    () => (stop ? atom<DeliveryStop>(stop) : storyStopAtom),
    [stop]
  )
  const [value, setValue] = useAtom(stopAtom)
  const frame = React.useRef<HTMLDivElement | null>(null)
  return (
    <div
      ref={frame}
      data-title-frame=""
      className="flex flex-col gap-3"
      style={{ maxWidth: width ?? 1060 }}
    >
      <div className="leading-[34px]">
        <h1 className="m-0 inline text-[28px] leading-[34px] font-semibold tracking-[-0.025em]">
          {GO_UNIT_TITLE}
        </h1>
        <DeliveryTitleDial
          className="ml-2"
          value={value}
          onChange={setValue}
          boundary={boundToFrame ? frame : undefined}
          barDelay={barDelay}
          flow={flow}
        />
      </div>
      {after}
      <p className="m-0 max-w-[660px] text-[15px] leading-6 text-ink-2">
        {goDeliveryUnit.briefing.map((segment, index) =>
          segment.kind === "text" ? (
            // The citation chips are left out here, with the space before
            // each.
            <React.Fragment key={index}>
              {goDeliveryUnit.briefing[index + 1]?.kind === "cite"
                ? segment.text.trimEnd()
                : segment.text}
            </React.Fragment>
          ) : segment.kind === "phrase" ? (
            <a
              key={index}
              href={`#phrase-${index}`}
              className="underline decoration-line-strong underline-offset-4 focus-visible:outline-2 focus-visible:outline-focus"
            >
              {segment.text}
            </a>
          ) : null
        )}
      </p>
    </div>
  )
}

const meta = {
  title: "Screens/Review desk/Delivery title dial",
  component: DeliveryTitleDial,
  args: { value: "briefed", onChange: () => {} },
  parameters: {
    viewport: {
      options: {
        phone375: {
          name: "Phone 375",
          styles: { width: "375px", height: "812px" },
          type: "mobile",
        },
      },
    },
  },
  decorators: [
    (Story) => (
      <Provider>
        {/* pt-16: the room the desk's eyebrow row leaves above the title. */}
        <div className="min-h-svh bg-paper px-8 pt-16 pb-5 font-sans text-sm text-ink max-sm:px-4">
          <Story />
        </div>
      </Provider>
    ),
  ],
} satisfies Meta<typeof DeliveryTitleDial>

export default meta
type Story = StoryObj<typeof meta>

type Canvas = Parameters<NonNullable<Story["play"]>>[0]["canvas"]

const trigger = (canvas: Canvas) =>
  canvas.getByRole("button", { name: /^Review delivery: / })

/** The whole document: the floating dial is portaled to the body. */
const page = () => within(document.body)

/** The open dial, anywhere in the document. */
const dialGroup = () =>
  document.querySelector<HTMLElement>(
    '[role="radiogroup"][aria-label="Review delivery"]'
  )

/** The dial's layer: its placement (beside or inline) and its motion. */
const dialLayer = () =>
  document.querySelector<HTMLElement>("[data-delivery-dial-place]")

/** How opaque the open dial looks: its opacity times its ancestors'. */
function shownOpacity() {
  let shown = 1
  for (
    let element: HTMLElement | null = dialGroup();
    element;
    element = element.parentElement
  )
    shown *= Number(getComputedStyle(element).opacity)
  return shown
}

/** The briefing after the title: the first content that follows. */
const briefing = (canvasElement: HTMLElement) =>
  canvasElement.querySelector<HTMLElement>("[data-title-frame] > p")!

/**
 * The element's top on every frame for `ms` milliseconds (transforms
 * included), while the caller acts.
 */
function sampleTops(element: HTMLElement, ms: number) {
  return new Promise<Array<number>>((resolve) => {
    const tops: Array<number> = []
    const start = performance.now()
    const frame = () => {
      tops.push(element.getBoundingClientRect().top)
      if (performance.now() - start < ms) requestAnimationFrame(frame)
      else resolve(tops)
    }
    requestAnimationFrame(frame)
  })
}

/** Several elements' tops on every frame for `ms` milliseconds. */
function sampleEach(elements: Array<HTMLElement>, ms: number) {
  return new Promise<Array<Array<number>>>((resolve) => {
    const tops: Array<Array<number>> = elements.map(() => [])
    const start = performance.now()
    const frame = () => {
      elements.forEach((element, index) =>
        tops[index]!.push(element.getBoundingClientRect().top)
      )
      if (performance.now() - start < ms) requestAnimationFrame(frame)
      else resolve(tops)
    }
    requestAnimationFrame(frame)
  })
}

/**
 * Each step moves the same way (or not at all): one movement, no overshoot.
 * Half a pixel of slack: on a cold first run Chrome once reported one
 * half-pixel step back (device-pixel snapping); an overshoot is pixels.
 */
async function expectMonotonic(tops: Array<number>, direction: 1 | -1) {
  const steps = tops
    .slice(1)
    .map((top, index) => (top - tops[index]!) * direction)
  await expect(Math.min(...steps)).toBeGreaterThanOrEqual(-0.5)
}

/** Distinct positions (to the half pixel) the samples passed through. */
const positions = (tops: Array<number>) =>
  new Set(tops.map((top) => Math.round(top * 2) / 2)).size

/**
 * One slide in `direction` by `distance`: monotonic, through positions in
 * between (a snap has only two), from `start` to `start + distance`.
 */
async function expectOneSlide(
  tops: Array<number>,
  direction: 1 | -1,
  distance: number
) {
  await expectMonotonic(tops, direction)
  await expect(positions(tops)).toBeGreaterThan(2)
  await expect(Math.abs(tops.at(-1)! - tops[0]! - distance)).toBeLessThan(1)
}

/** Never moved in the samples. */
async function expectStill(tops: Array<number>) {
  await expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(0.5)
}

const tooltip = () =>
  document.querySelector<HTMLElement>("[data-delivery-title-tip]")

const filled = (canvasElement: HTMLElement) =>
  canvasElement.querySelectorAll(
    "[data-delivery-trigger] [data-delivery-ticks] i[data-filled]"
  ).length

async function openByPointer(
  canvas: Canvas,
  userEvent: Parameters<NonNullable<Story["play"]>>[0]["userEvent"]
) {
  await userEvent.click(trigger(canvas))
  await waitFor(() => expect(dialGroup()).not.toBeNull())
  // The dial is in, and anything it moved has settled.
  await waitFor(() => expect(shownOpacity()).toBe(1), { timeout: 2000 })
  await new Promise((resolve) => setTimeout(resolve, 300))
}

const folded = () => waitFor(() => expect(dialGroup()).toBeNull())

/** At rest: the ticks filled to Briefed (two of four), the dial closed. */
export const Rest: Story = {
  render: () => <TitleBlock />,
  play: async ({ canvas, canvasElement }) => {
    const button = trigger(canvas)
    await expect(button).toHaveAccessibleName("Review delivery: Briefed")
    await expect(button).toHaveAttribute("aria-expanded", "false")
    await expect(button).toHaveAttribute("aria-controls")
    await expect(filled(canvasElement)).toBe(2)
    const box = button.getBoundingClientRect()
    await expect(box.width).toBe(32)
    await expect(box.height).toBe(32)
    await expect(dialGroup()).toBeNull()
  },
}

/** Hover: the name above the glyph, not read twice as a description. */
export const HoverTooltip: Story = {
  render: () => <TitleBlock />,
  play: async ({ canvas, userEvent }) => {
    const button = trigger(canvas)
    await userEvent.hover(button)
    await waitFor(() => expect(tooltip()).not.toBeNull())
    await expect(tooltip()).toHaveTextContent("Review delivery: Briefed")
    await expect(button).not.toHaveAttribute("aria-describedby")
    // Above the glyph.
    await expect(tooltip()!.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      button.getBoundingClientRect().top
    )
  },
}

/** Keyboard focus: the ring, the raised fill and the name. */
export const KeyboardFocus: Story = {
  render: () => <TitleBlock />,
  play: async ({ canvas, userEvent }) => {
    await userEvent.tab()
    const button = trigger(canvas)
    await expectFocusVisible(button)
    await waitFor(() => expect(tooltip()).not.toBeNull())
  },
}

/**
 * Pressed: the dial opens beside the title, focus on the checked stop
 * without a ring (it came from a pointer).
 */
export const OpenBeside: Story = {
  render: () => <TitleBlock />,
  play: async ({ canvas, userEvent }) => {
    await openByPointer(canvas, userEvent)
    const button = trigger(canvas)
    await expect(button).toHaveAttribute("aria-expanded", "true")
    await expect(button.getAttribute("aria-controls")).toBe(dialGroup()!.id)
    await expect(dialLayer()).toHaveAttribute(
      "data-delivery-dial-place",
      "beside"
    )
    const briefed = page().getByRole("radio", { name: "Briefed" })
    await expect(briefed).toBeChecked()
    await expectNoFocusRing(briefed)
    // Beside: starts right of the glyph, vertically centred on it.
    const glyph = button.getBoundingClientRect()
    const dial = dialLayer()!.getBoundingClientRect()
    await expect(dial.left).toBeGreaterThan(glyph.right)
    await expect(
      Math.abs(dial.top + dial.height / 2 - (glyph.top + glyph.height / 2))
    ).toBeLessThan(1)
    // Hidden while open.
    await expect(tooltip()).toBeNull()
  },
}

/**
 * Opens in flow below the title row and checks the push: the briefing moves
 * down by the dial's block in one movement, nothing overlaps, and closing
 * reverses it.
 */
async function opensInline(
  canvas: Canvas,
  canvasElement: HTMLElement,
  userEvent: Parameters<NonNullable<Story["play"]>>[0]["userEvent"]
) {
  // A late web font would move the briefing on its own.
  await document.fonts.ready
  const paragraph = briefing(canvasElement)
  const restTop = paragraph.getBoundingClientRect().top
  const opening = sampleTops(paragraph, 450)
  await userEvent.click(trigger(canvas))
  const openTops = await opening
  await waitFor(() => expect(shownOpacity()).toBe(1))
  await expect(dialLayer()).toHaveAttribute(
    "data-delivery-dial-place",
    "inline"
  )
  // In flow: the briefing moved down by the dial's block.
  const block = dialLayer()!.getBoundingClientRect()
  const openTop = paragraph.getBoundingClientRect().top
  await expect(Math.abs(openTop - restTop - block.height)).toBeLessThan(1)
  // One slide down, through positions in between, no overshoot.
  await expectOneSlide(openTops, 1, openTop - restTop)
  // Nothing overlaps: the title row, the dial, the briefing.
  const group = dialGroup()!.getBoundingClientRect()
  const glyph = trigger(canvas).getBoundingClientRect()
  const title = canvasElement.querySelector("h1")!.getBoundingClientRect()
  await expect(group.top).toBeGreaterThanOrEqual(glyph.bottom)
  await expect(group.top).toBeGreaterThanOrEqual(title.bottom - 0.5)
  await expect(group.bottom).toBeLessThanOrEqual(openTop)
  await expect(group.left).toBeGreaterThanOrEqual(0)
  await expect(group.right).toBeLessThanOrEqual(window.innerWidth)
  // Choosing keeps it open and in place.
  await userEvent.click(page().getByText("Guided"))
  await expect(dialGroup()).not.toBeNull()
  // Escape: the reverse, back to where the briefing was.
  const closing = sampleTops(paragraph, 600)
  await userEvent.keyboard("{Escape}")
  const closeTops = await closing
  await folded()
  // The reverse: one slide up, back to where the briefing was.
  await expectOneSlide(closeTops, -1, restTop - openTop)
  await expect(paragraph.getBoundingClientRect().top).toBeCloseTo(restTop, 0)
  await expect(trigger(canvas)).toHaveFocus()
  // Focus restored by Escape: no name shown.
  await expect(tooltip()).toBeNull()
}

/**
 * A column with the title on one line and no room after it: the dial
 * opens in flow below the title row and pushes the briefing down.
 */
export const OpenInlineNarrow: Story = {
  render: () => <TitleBlock width={720} boundToFrame />,
  play: async ({ canvas, canvasElement, userEvent }) =>
    opensInline(canvas, canvasElement, userEvent),
}

/** A 343px phone column: the dial opens in flow, inside the screen. */
export const OpenInlinePhone: Story = {
  render: () => <TitleBlock width={343} boundToFrame />,
  globals: { viewport: { value: "phone375", isRotated: false } },
  play: async ({ canvas, canvasElement, userEvent }) =>
    opensInline(canvas, canvasElement, userEvent),
}

/**
 * The desk's shape: the title in a scroll column (the region it pushes)
 * with a sticky dock at its bottom, and a column beside it. Opening and
 * closing inline slide only what follows in the column: the dock and the
 * side column never move.
 */
function DeskShell({
  width = 640,
  titleWidth,
}: {
  width?: number
  /** Wraps the title, so its last line (and the glyph) ends early. */
  titleWidth?: number
}) {
  const scroll = React.useRef<HTMLDivElement | null>(null)
  return (
    <div
      className="flex h-[560px] max-w-full overflow-hidden rounded-xl border border-line"
      style={{ width }}
    >
      <div
        ref={scroll}
        data-desk-scroll=""
        className="min-w-0 flex-1 overflow-y-auto px-4 pt-6"
      >
        <TitleBlock flow={scroll} width={titleWidth} />
        <div
          data-shell-content=""
          aria-hidden="true"
          className="flex h-[1200px] flex-col gap-2 pt-6"
        >
          {[78, 64, 90, 52].map((share) => (
            <span
              key={share}
              className="h-3 rounded bg-raised"
              style={{ width: `${share}%` }}
            />
          ))}
        </div>
        <div
          data-shell-dock=""
          aria-hidden="true"
          className="sticky bottom-5 h-12 rounded-lg bg-raised"
        />
      </div>
      <div
        data-shell-side=""
        aria-hidden="true"
        className="w-40 shrink-0 bg-raised"
      />
    </div>
  )
}

export const InlineInDeskShell: Story = {
  render: () => <DeskShell />,
  play: async ({ canvas, canvasElement, userEvent }) => {
    await document.fonts.ready
    const pick = (selector: string) =>
      canvasElement.querySelector<HTMLElement>(selector)!
    const content = pick("[data-shell-content]")
    const dock = pick("[data-shell-dock]")
    const side = pick("[data-shell-side]")
    const paragraph = briefing(canvasElement)
    const watched = [paragraph, content, dock, side]
    const rest = paragraph.getBoundingClientRect().top
    const opening = sampleEach(watched, 450)
    await userEvent.click(trigger(canvas))
    const [briefOpen, contentOpen, dockOpen, sideOpen] = await opening
    await expect(dialLayer()).toHaveAttribute(
      "data-delivery-dial-place",
      "inline"
    )
    const height = dialLayer()!.getBoundingClientRect().height
    // What follows in the column slides down once; the dock and the side
    // column stay put.
    await expectOneSlide(briefOpen!, 1, height)
    await expectOneSlide(contentOpen!, 1, height)
    await expectStill(dockOpen!)
    await expectStill(sideOpen!)
    const closing = sampleEach(watched, 600)
    await userEvent.keyboard("{Escape}")
    const [briefClose, contentClose, dockClose, sideClose] = await closing
    await folded()
    await expectOneSlide(briefClose!, -1, -height)
    await expectOneSlide(contentClose!, -1, -height)
    await expectStill(dockClose!)
    await expectStill(sideClose!)
    await expect(paragraph.getBoundingClientRect().top).toBeCloseTo(rest, 0)
  },
}

/**
 * A wide desk: the dial floats beside the title, inside the scroll column
 * (not portaled). It is positioned fixed, so the column doesn't clip it,
 * and it stays with the glyph when the column scrolls.
 */
export const BesideInDeskShell: Story = {
  render: () => <DeskShell width={1100} titleWidth={420} />,
  play: async ({ canvas, canvasElement, userEvent }) => {
    await openByPointer(canvas, userEvent)
    await expect(dialLayer()).toHaveAttribute(
      "data-delivery-dial-place",
      "beside"
    )
    const scroll =
      canvasElement.querySelector<HTMLElement>("[data-desk-scroll]")!
    // Inside the column in the DOM, and drawn whole: what the page shows
    // at the dial's centre and corners is the dial.
    await expect(scroll.contains(dialLayer())).toBe(true)
    const shown = (rect: DOMRect) =>
      [
        [rect.left + rect.width / 2, rect.top + rect.height / 2],
        [rect.left + 4, rect.top + 4],
        [rect.right - 4, rect.bottom - 4],
      ].every(([x, y]) =>
        dialLayer()!.contains(document.elementFromPoint(x!, y!))
      )
    await expect(shown(dialLayer()!.getBoundingClientRect())).toBe(true)
    // The column scrolls: the dial follows the glyph.
    scroll.scrollTop = 24
    await waitFor(() => {
      const glyph = trigger(canvas).getBoundingClientRect()
      const dial = dialLayer()!.getBoundingClientRect()
      expect(
        Math.abs(dial.top + dial.height / 2 - (glyph.top + glyph.height / 2))
      ).toBeLessThan(1)
    })
    await userEvent.keyboard("{Escape}")
    await folded()
  },
}

/**
 * The column scrolls the title (and the glyph) out of view while focus is
 * on the glyph, not in the dial: the floating dial hides rather than float
 * over what is above the column, stays open, and shows again when the
 * glyph comes back.
 */
export const HiddenWhenScrolledAway: Story = {
  render: () => <DeskShell width={1100} titleWidth={420} />,
  play: async ({ canvas, canvasElement, userEvent }) => {
    await openByPointer(canvas, userEvent)
    await expect(dialLayer()).toHaveAttribute(
      "data-delivery-dial-place",
      "beside"
    )
    // Back to the glyph (its anchor): the dial stays open.
    await userEvent.tab({ shift: true })
    await expect(trigger(canvas)).toHaveFocus()
    const scroll =
      canvasElement.querySelector<HTMLElement>("[data-desk-scroll]")!
    scroll.scrollTop = 400
    await waitFor(() =>
      expect(trigger(canvas).getBoundingClientRect().bottom).toBeLessThan(
        scroll.getBoundingClientRect().top
      )
    )
    await waitFor(() =>
      expect(getComputedStyle(dialLayer()!).visibility).toBe("hidden")
    )
    await expect(trigger(canvas)).toHaveAttribute("aria-expanded", "true")
    scroll.scrollTop = 0
    await waitFor(() =>
      expect(getComputedStyle(dialLayer()!).visibility).toBe("visible")
    )
    await userEvent.keyboard("{Escape}")
    await folded()
  },
}

/**
 * Focus on a stop when the glyph scrolls fully out of the column (PageDown
 * from a stop, say): the dial closes and focus comes back to the glyph,
 * with its ring and without the tooltip, rather than dropping to the body.
 */
export const ClosesWhenScrolledAwayWithFocus: Story = {
  render: () => <DeskShell width={1100} titleWidth={420} />,
  play: async ({ canvas, canvasElement, userEvent }) => {
    const button = trigger(canvas)
    button.focus()
    await userEvent.keyboard("{Enter}")
    const briefed = page().getByRole("radio", { name: "Briefed" })
    await waitFor(() => expect(briefed).toHaveFocus())
    await expect(dialLayer()).toHaveAttribute(
      "data-delivery-dial-place",
      "beside"
    )
    const scroll =
      canvasElement.querySelector<HTMLElement>("[data-desk-scroll]")!
    scroll.scrollTop = 400
    await folded()
    await expectFocusVisible(button)
    await expect(button).toHaveAttribute("aria-expanded", "false")
    await new Promise((resolve) => setTimeout(resolve, 200))
    await expect(tooltip()).toBeNull()
    // Focus came back without scrolling the glyph into view.
    await expect(scroll.scrollTop).toBe(400)
  },
}

/**
 * Only the region the caller names slides. Here the region is the title
 * block alone: the briefing inside it slides, and a box after the region
 * takes its new place at once, untouched. (The desk names its scroll
 * column, so nothing outside the region moves at all.)
 */
function RegionAndAfter() {
  const region = React.useRef<HTMLDivElement | null>(null)
  return (
    <div>
      <div ref={region} data-shell-region="">
        <TitleBlock width={720} boundToFrame flow={region} />
      </div>
      <div
        data-shell-after=""
        aria-hidden="true"
        className="mt-6 h-3 w-[60%] rounded bg-raised"
      />
    </div>
  )
}

export const SlideStaysInRegion: Story = {
  render: () => <RegionAndAfter />,
  play: async ({ canvas, canvasElement, userEvent }) => {
    await document.fonts.ready
    const after =
      canvasElement.querySelector<HTMLElement>("[data-shell-after]")!
    const paragraph = briefing(canvasElement)
    const restAfter = after.getBoundingClientRect().top
    const opening = sampleEach([paragraph, after], 450)
    await userEvent.click(trigger(canvas))
    const [inside, outside] = await opening
    const height = dialLayer()!.getBoundingClientRect().height
    await expectOneSlide(inside!, 1, height)
    // Outside the region: no slide, only its old place and its new one.
    await expect(positions([restAfter, ...outside!])).toBeLessThanOrEqual(2)
    await expect(
      Math.abs(after.getBoundingClientRect().top - restAfter - height)
    ).toBeLessThan(1)
    await userEvent.keyboard("{Escape}")
    await folded()
  },
}

/** Inline, dark. */
export const OpenInlineNarrowDark: Story = {
  render: () => <TitleBlock width={720} boundToFrame />,
  globals: { theme: "dark" },
  play: async ({ canvas, userEvent }) => openByPointer(canvas, userEvent),
}

/**
 * Reduced motion, inline: the flow snaps (the briefing is at its new place
 * on the first frame), then the contents fade.
 */
export const ReducedMotionInline: Story = {
  render: () => <TitleBlock width={720} boundToFrame />,
  globals: { reducedMotion: "reduce" },
  play: async ({ canvas, canvasElement, userEvent }) => {
    await document.fonts.ready
    const paragraph = briefing(canvasElement)
    const opening = sampleTops(paragraph, 300)
    await userEvent.click(trigger(canvas))
    const tops = await opening
    // No in-between positions: only the old place, then the new one.
    await expect(
      new Set(tops.map((top) => Math.round(top))).size
    ).toBeLessThanOrEqual(2)
    await waitFor(() => expect(shownOpacity()).toBe(1))
  },
}

/** Every stop at rest: one to four ticks filled. */
export const EveryStop: Story = {
  render: () => (
    <div className="flex flex-col gap-10">
      <TitleBlock stop="facts" />
      <TitleBlock stop="briefed" />
      <TitleBlock stop="explained" />
      <TitleBlock stop="guided" />
    </div>
  ),
  play: async ({ canvas }) => {
    const names = canvas
      .getAllByRole("button", { name: /^Review delivery: / })
      .map((button) => button.getAttribute("aria-label"))
    await expect(names).toEqual([
      "Review delivery: Facts",
      "Review delivery: Briefed",
      "Review delivery: Explained",
      "Review delivery: Guided",
    ])
  },
}

/** Guided: all four ticks filled. */
export const Guided: Story = {
  render: () => <TitleBlock stop="guided" />,
  play: async ({ canvas, canvasElement }) => {
    await expect(trigger(canvas)).toHaveAccessibleName(
      "Review delivery: Guided"
    )
    await expect(filled(canvasElement)).toBe(4)
  },
}

/**
 * Opened from the keyboard: focus on the checked stop with its ring.
 * Escape folds the dial and returns focus to the glyph; pressing the glyph
 * folds it too.
 */
export const ClosesOnTriggerAndEscape: Story = {
  render: () => <TitleBlock />,
  play: async ({ canvas, userEvent }) => {
    await userEvent.tab()
    await userEvent.keyboard("{Enter}")
    await waitFor(() => expect(dialGroup()).not.toBeNull())
    const briefed = page().getByRole("radio", { name: "Briefed" })
    await waitFor(() => expect(briefed).toHaveFocus())
    // The stop's ring is drawn by its label (has-[input:focus-visible]).
    await expectFocusVisible(briefed, { ring: false })
    await userEvent.keyboard("{Escape}")
    await folded()
    await expect(trigger(canvas)).toHaveFocus()
    await expect(trigger(canvas)).toHaveAttribute("aria-expanded", "false")
    // Escape on the glyph folds it too.
    await userEvent.keyboard("{Enter}")
    await waitFor(() => expect(dialGroup()).not.toBeNull())
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}")
    await expect(trigger(canvas)).toHaveFocus()
    await userEvent.keyboard("{Escape}")
    await folded()
    // A press on the glyph opens and folds it.
    await openByPointer(canvas, userEvent)
    await userEvent.click(trigger(canvas))
    await folded()
    await expect(trigger(canvas)).toHaveFocus()
  },
}

/**
 * Escape puts focus back on the glyph by script: the name was just heard,
 * so that focus shows no tooltip. The next hover or keyboard focus does.
 */
export const EscapeReturnsFocusQuietly: Story = {
  render: () => <TitleBlock />,
  play: async ({ canvas, userEvent }) => {
    await userEvent.tab()
    await waitFor(() => expect(tooltip()).not.toBeNull())
    await userEvent.keyboard("{Enter}")
    await waitFor(() => expect(dialGroup()).not.toBeNull())
    await expect(tooltip()).toBeNull()
    await userEvent.keyboard("{Escape}")
    await folded()
    const button = trigger(canvas)
    await expect(button).toHaveFocus()
    await new Promise((resolve) => setTimeout(resolve, 300))
    await expect(tooltip()).toBeNull()
    // Hover shows it.
    await userEvent.hover(button)
    await waitFor(() => expect(tooltip()).not.toBeNull())
    await userEvent.unhover(button)
    // So does the next keyboard focus: away and back.
    await userEvent.tab()
    await waitFor(() => expect(tooltip()).toBeNull())
    await userEvent.tab({ shift: true })
    await expect(button).toHaveFocus()
    await waitFor(() => expect(tooltip()).not.toBeNull())
  },
}

type UserEvent = Parameters<NonNullable<Story["play"]>>[0]["userEvent"]

/**
 * The dismissal contract, the same in both placements, each rule with its
 * negative:
 * - choosing a stop (click, arrows, Enter, Space) never closes it;
 * - the glyph toggles it, and a press on it closes it once (no reopen);
 * - a press outside closes it (on plain text too, where no focus moves),
 *   and focus stays where the press put it;
 * - Escape closes it and returns focus to the glyph, with no tooltip;
 * - focus moving outside (Tab) closes it; Shift+Tab back to the glyph,
 *   its anchor, doesn't.
 */
async function dismissalContract(
  canvas: Canvas,
  canvasElement: HTMLElement,
  userEvent: UserEvent,
  place: "beside" | "inline"
) {
  await document.fonts.ready
  const button = trigger(canvas)
  const links = canvas.getAllByRole("link")
  const stillOpen = async () => {
    await new Promise((resolve) => setTimeout(resolve, 300))
    await expect(dialGroup()).not.toBeNull()
    await expect(button).toHaveAttribute("aria-expanded", "true")
  }
  const stillClosed = async () => {
    await new Promise((resolve) => setTimeout(resolve, 300))
    await expect(dialGroup()).toBeNull()
    await expect(button).toHaveAttribute("aria-expanded", "false")
  }

  // Choosing a stop, by pointer or keyboard, never closes it.
  await openByPointer(canvas, userEvent)
  await expect(dialLayer()).toHaveAttribute("data-delivery-dial-place", place)
  await userEvent.click(page().getByText("Guided"))
  await waitFor(() =>
    expect(page().getByRole("radio", { name: "Guided" })).toBeChecked()
  )
  await expect(filled(canvasElement)).toBe(4)
  await userEvent.keyboard("{ArrowLeft}")
  await waitFor(() =>
    expect(page().getByRole("radio", { name: "Explained" })).toBeChecked()
  )
  await userEvent.keyboard("{Enter}")
  await userEvent.keyboard(" ")
  await stillOpen()

  // A press on the glyph closes it, once: it doesn't close on the press
  // and open again on the click.
  await userEvent.click(button)
  await folded()
  await stillClosed()
  await expect(button).toHaveFocus()

  // A press outside on nothing focusable (the title's text) closes it.
  await openByPointer(canvas, userEvent)
  await userEvent.click(canvasElement.querySelector("h1")!)
  await folded()
  await expect(tooltip()).toBeNull()

  // A press outside on a link closes it; focus goes where the press put it.
  await openByPointer(canvas, userEvent)
  await userEvent.click(links[1]!)
  await folded()
  await expect(links[1]).toHaveFocus()
  await expect(tooltip()).toBeNull()

  // Escape closes it and returns focus to the glyph, quietly.
  button.focus()
  await userEvent.keyboard("{Enter}")
  await waitFor(() => expect(dialGroup()).not.toBeNull())
  await userEvent.keyboard("{Escape}")
  await folded()
  await expect(button).toHaveFocus()
  await new Promise((resolve) => setTimeout(resolve, 200))
  await expect(tooltip()).toBeNull()

  // Shift+Tab back to the glyph keeps it open; Tab away closes it, and
  // focus goes on to the briefing.
  await userEvent.keyboard("{Enter}")
  await waitFor(() =>
    expect(page().getByRole("radio", { name: "Explained" })).toHaveFocus()
  )
  await userEvent.tab({ shift: true })
  await expect(button).toHaveFocus()
  await stillOpen()
  await userEvent.tab()
  await waitFor(() =>
    expect(page().getByRole("radio", { name: "Explained" })).toHaveFocus()
  )
  await userEvent.tab()
  await folded()
  await expect(links[0]).toHaveFocus()
}

/** The contract, floating beside the title. */
export const DismissalBeside: Story = {
  render: () => <TitleBlock />,
  play: async ({ canvas, canvasElement, userEvent }) =>
    dismissalContract(canvas, canvasElement, userEvent, "beside"),
}

/** The same contract in flow (a column with no room beside the glyph). */
export const DismissalInline: Story = {
  render: () => <TitleBlock width={720} boundToFrame />,
  play: async ({ canvas, canvasElement, userEvent }) =>
    dismissalContract(canvas, canvasElement, userEvent, "inline"),
}

/**
 * A layer that stays open on outside presses, and the dial opened over it:
 * Escape closes only the topmost layer, the dial, then the one below.
 */
function UnderLayer() {
  return (
    <div className="flex flex-col gap-8">
      <Popover defaultOpen>
        <PopoverTrigger className="w-max rounded-md bg-raised px-3 py-1.5 text-sm">
          Layer
        </PopoverTrigger>
        <PopoverContent
          side="bottom"
          align="start"
          data-under-layer=""
          onInteractOutside={(event) => event.preventDefault()}
        >
          <span aria-hidden="true" className="h-3 w-40 rounded bg-raised" />
        </PopoverContent>
      </Popover>
      <TitleBlock />
    </div>
  )
}

export const EscapeClosesTopmostLayer: Story = {
  render: () => <UnderLayer />,
  play: async ({ canvas, userEvent }) => {
    const under = () => document.querySelector("[data-under-layer]")
    await waitFor(() => expect(under()).not.toBeNull())
    await openByPointer(canvas, userEvent)
    await expect(dialLayer()).toHaveAttribute(
      "data-delivery-dial-place",
      "beside"
    )
    await expect(under()).not.toBeNull()
    // The dial is on top: Escape closes it alone.
    await userEvent.keyboard("{Escape}")
    await folded()
    await new Promise((resolve) => setTimeout(resolve, 300))
    await expect(under()).not.toBeNull()
    await expect(trigger(canvas)).toHaveFocus()
    // Then the layer below.
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(under()).toBeNull())
  },
}

/**
 * What follows the title in Tab order, as the desk can have it: "Reported
 * gaps" (a details), a button out of the Tab order, a radio group with its
 * second radio checked, an inert block with a link in it, then the
 * briefing's links.
 */
function TabStops() {
  return (
    <div className="flex flex-col items-start gap-2 text-sm">
      <details data-tab-id="details">
        <summary data-tab-id="summary">Reported gaps · 1</summary>
        <span aria-hidden="true" className="block h-3 w-40 rounded bg-raised" />
      </details>
      <button type="button" tabIndex={-1} data-tab-id="skipped">
        Out of the Tab order
      </button>
      <div role="radiogroup" aria-label="Choice" className="flex gap-3">
        <label>
          <input type="radio" name="tab-case" value="a" data-tab-id="radio-a" />{" "}
          A
        </label>
        <label>
          <input
            type="radio"
            name="tab-case"
            value="b"
            defaultChecked
            data-tab-id="radio-b"
          />{" "}
          B
        </label>
      </div>
      <div inert>
        <a href="#inert" data-tab-id="inert-link">
          Inert
        </a>
      </div>
    </div>
  )
}

/** Where focus is, by its story id (or its tag and name). */
function focusId() {
  const element = document.activeElement as HTMLElement | null
  if (!element || element === document.body) return "body"
  return (
    element.getAttribute("data-tab-id") ??
    element.getAttribute("data-delivery-trigger") ??
    `${element.tagName.toLowerCase()}:${element.textContent.slice(0, 24)}`
  )
}

/**
 * Tab out of the open dial reaches what Tab from the glyph reaches with
 * the dial closed, in the same order: the dial sits in the DOM right after
 * the glyph and adds nothing to the order but its own stop.
 */
async function tabOrderMatchesClosed(
  canvas: Canvas,
  userEvent: UserEvent,
  place: "beside" | "inline"
) {
  await document.fonts.ready
  const button = trigger(canvas)
  const steps = 5
  // Closed: from the glyph.
  button.focus()
  const closed: Array<string> = []
  for (let step = 0; step < steps; step++) {
    await userEvent.tab()
    closed.push(focusId())
  }
  // Open from the keyboard: Tab leaves the dial for the same stops.
  button.focus()
  await userEvent.keyboard("{Enter}")
  await waitFor(() =>
    expect(page().getByRole("radio", { name: "Briefed" })).toHaveFocus()
  )
  await expect(dialLayer()).toHaveAttribute("data-delivery-dial-place", place)
  const open: Array<string> = []
  for (let step = 0; step < steps; step++) {
    await userEvent.tab()
    open.push(focusId())
  }
  await expect(open).toEqual(closed)
  // The desk's case: "Reported gaps" comes first.
  await expect(closed[0]).toBe("summary")
  await folded()
}

export const TabOrderBeside: Story = {
  render: () => <TitleBlock after={<TabStops />} />,
  play: async ({ canvas, userEvent }) =>
    tabOrderMatchesClosed(canvas, userEvent, "beside"),
}

export const TabOrderInline: Story = {
  render: () => <TitleBlock width={720} boundToFrame after={<TabStops />} />,
  play: async ({ canvas, userEvent }) =>
    tabOrderMatchesClosed(canvas, userEvent, "inline"),
}

/**
 * At the dial's edges, Tab leaves it as it would leave any radio group:
 * from the last stop (Guided) Tab goes on to the briefing and closes the
 * dial; from the first (Facts) Shift+Tab goes back to the glyph and keeps
 * it open. Neither loops round to the other end of the dial.
 */
async function openAtStop(
  canvas: Canvas,
  userEvent: UserEvent,
  place: "beside" | "inline",
  stop: "Facts" | "Guided"
) {
  await document.fonts.ready
  trigger(canvas).focus()
  await userEvent.keyboard("{Enter}")
  await waitFor(() =>
    expect(page().getByRole("radio", { name: "Briefed" })).toHaveFocus()
  )
  await expect(dialLayer()).toHaveAttribute("data-delivery-dial-place", place)
  await userEvent.keyboard(
    stop === "Guided" ? "{ArrowRight}{ArrowRight}" : "{ArrowLeft}"
  )
  await waitFor(() =>
    expect(page().getByRole("radio", { name: stop })).toHaveFocus()
  )
}

/** From Guided, Tab leaves for the briefing (the closed order) and closes. */
async function tabFromLastStop(
  canvas: Canvas,
  userEvent: UserEvent,
  place: "beside" | "inline"
) {
  await openAtStop(canvas, userEvent, place, "Guided")
  await userEvent.tab()
  await expect(canvas.getAllByRole("link")[0]).toHaveFocus()
  await folded()
}

/** From Facts, Shift+Tab goes back to the glyph; the dial stays open. */
async function shiftTabFromFirstStop(
  canvas: Canvas,
  userEvent: UserEvent,
  place: "beside" | "inline"
) {
  await openAtStop(canvas, userEvent, place, "Facts")
  await userEvent.tab({ shift: true })
  await expect(trigger(canvas)).toHaveFocus()
  await expect(dialGroup()).not.toBeNull()
  await userEvent.keyboard("{Escape}")
  await folded()
}

export const TabFromGuidedBeside: Story = {
  render: () => <TitleBlock />,
  play: async ({ canvas, userEvent }) =>
    tabFromLastStop(canvas, userEvent, "beside"),
}

export const ShiftTabFromFactsBeside: Story = {
  render: () => <TitleBlock />,
  play: async ({ canvas, userEvent }) =>
    shiftTabFromFirstStop(canvas, userEvent, "beside"),
}

export const TabFromGuidedInline: Story = {
  render: () => <TitleBlock width={720} boundToFrame />,
  play: async ({ canvas, userEvent }) =>
    tabFromLastStop(canvas, userEvent, "inline"),
}

export const ShiftTabFromFactsInline: Story = {
  render: () => <TitleBlock width={720} boundToFrame />,
  play: async ({ canvas, userEvent }) =>
    shiftTabFromFirstStop(canvas, userEvent, "inline"),
}

/** Inline: Escape with focus on the glyph closes it, quietly. */
export const EscapeOnGlyphInline: Story = {
  render: () => <TitleBlock width={720} boundToFrame />,
  play: async ({ canvas, userEvent }) => {
    const button = trigger(canvas)
    button.focus()
    await userEvent.keyboard("{Enter}")
    await waitFor(() => expect(dialGroup()).not.toBeNull())
    await expect(dialLayer()).toHaveAttribute(
      "data-delivery-dial-place",
      "inline"
    )
    await userEvent.tab({ shift: true })
    await expect(button).toHaveFocus()
    await expect(dialGroup()).not.toBeNull()
    await userEvent.keyboard("{Escape}")
    await folded()
    await expect(button).toHaveFocus()
    await new Promise((resolve) => setTimeout(resolve, 200))
    await expect(tooltip()).toBeNull()
  },
}

/** A touch pointer's events on `target`, as the browser sends them. */
function touch(target: Element, type: string, init: PointerEventInit = {}) {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerType: "touch",
      isPrimary: true,
      pointerId: 7,
      button: 0,
      ...init,
    })
  )
}

/**
 * Inline, on touch: a scroll gesture that starts outside (the browser
 * cancels the pointer; no click follows) leaves the dial open; a tap
 * outside closes it.
 */
export const InlineTouchScrollAndTap: Story = {
  render: () => <TitleBlock width={720} boundToFrame />,
  play: async ({ canvas, canvasElement, userEvent }) => {
    await openByPointer(canvas, userEvent)
    await expect(dialLayer()).toHaveAttribute(
      "data-delivery-dial-place",
      "inline"
    )
    const outside = briefing(canvasElement)
    // Scroll gesture: down, move, cancelled.
    touch(outside, "pointerdown")
    touch(outside, "pointermove", { clientY: 200 })
    touch(outside, "pointercancel")
    await new Promise((resolve) => setTimeout(resolve, 300))
    await expect(dialGroup()).not.toBeNull()
    await expect(trigger(canvas)).toHaveAttribute("aria-expanded", "true")
    // Tap: down, up, click.
    touch(outside, "pointerdown")
    touch(outside, "pointerup")
    touch(outside, "click")
    await folded()
  },
}

/** Each tick's fill scale, read off the screen. */
const fillScales = (canvasElement: HTMLElement) =>
  Array.from(
    canvasElement.querySelectorAll<HTMLElement>("[data-delivery-trigger] b")
  ).map((fill) => {
    const matrix = getComputedStyle(fill).transform
    return matrix === "none" ? 1 : Number(matrix.split(",")[3])
  })

/**
 * With a delay between ticks (the motion track's chain; 0 by default):
 * filling runs left to right, emptying right to left.
 */
export const BarDelay: Story = {
  render: () => <TitleBlock stop="facts" barDelay={150} />,
  play: async ({ canvas, canvasElement, userEvent }) => {
    await openByPointer(canvas, userEvent)
    await userEvent.click(page().getByText("Guided"))
    // Mid-chain: the second tick leads the third, the third the fourth.
    await waitFor(() => {
      const [, second, third, fourth] = fillScales(canvasElement)
      expect(second!).toBeGreaterThan(0.5)
      expect(third!).toBeGreaterThan(fourth!)
    })
    await waitFor(() =>
      expect(Math.min(...fillScales(canvasElement))).toBeGreaterThan(0.95)
    )
    await userEvent.click(page().getByText("Facts"))
    // Emptying: the fourth tick leaves first.
    await waitFor(() => {
      const [, second, , fourth] = fillScales(canvasElement)
      expect(fourth!).toBeLessThan(0.5)
      expect(second!).toBeGreaterThan(fourth!)
    })
  },
}

/**
 * Reduced motion: the dial fades in and out with no scale; the ticks
 * crossfade without growing.
 */
export const ReducedMotion: Story = {
  render: () => <TitleBlock />,
  globals: { reducedMotion: "reduce" },
  play: async ({ canvas, canvasElement, userEvent }) => {
    await userEvent.click(trigger(canvas))
    await waitFor(() => expect(dialLayer()).not.toBeNull())
    // No scale at any frame.
    await new Promise((resolve) => requestAnimationFrame(resolve))
    await expect(getComputedStyle(dialLayer()!).transform).toMatch(
      /^(none|matrix\(1, 0, 0, 1, 0, 0\))$/
    )
    await userEvent.click(page().getByText("Guided"))
    await expect(trigger(canvas)).toHaveAccessibleName(
      "Review delivery: Guided"
    )
    await new Promise((resolve) => requestAnimationFrame(resolve))
    await expect(fillScales(canvasElement)).toEqual([1, 1, 1, 1])
    await userEvent.keyboard("{Escape}")
    await folded()
  },
}

/** Dark, open beside the title. */
export const DarkOpen: Story = {
  render: () => <TitleBlock />,
  globals: { theme: "dark" },
  play: async ({ canvas, userEvent }) => {
    await openByPointer(canvas, userEvent)
  },
}

/** Dark, every stop at rest. */
export const DarkEveryStop: Story = {
  ...EveryStop,
  globals: { theme: "dark" },
}
