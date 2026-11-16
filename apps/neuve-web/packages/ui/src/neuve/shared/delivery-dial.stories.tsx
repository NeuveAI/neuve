import type { Meta, StoryObj } from "@storybook/react-vite"
import { Provider, atom, useAtom } from "jotai"
import { expect, waitFor } from "storybook/test"

import {
  DeliveryDial,
  DeliveryTicks,
} from "@workspace/ui/neuve/shared/delivery-dial"
import type { DeliveryDialSize } from "@workspace/ui/neuve/shared/delivery-dial"
import type { DeliveryStop } from "@workspace/ui/neuve/shared/delivery"

/** Minimum space between a stop's content and its edge (px). */
const MIN_GAP = 12
const PHONE_MIN_GAP = 8

/**
 * Every stop has the same width, and its content (glyph + label, both
 * states of weight) keeps at least `gap` px from the stop's edges.
 */
async function expectEqualStops(group: HTMLElement, gap: number) {
  const stops = Array.from(group.querySelectorAll("label"))
  const widths = stops.map((stop) => stop.getBoundingClientRect().width)
  await expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(0.5)
  for (const stop of stops) {
    const box = stop.getBoundingClientRect()
    const parts = Array.from(stop.children)
      .filter((child) => child.tagName !== "INPUT")
      .map((child) => child.getBoundingClientRect())
      .filter((rect) => rect.width > 0)
    const left = Math.min(...parts.map((rect) => rect.left))
    const right = Math.max(...parts.map((rect) => rect.right))
    await expect(left - box.left).toBeGreaterThanOrEqual(gap - 0.5)
    await expect(box.right - right).toBeGreaterThanOrEqual(gap - 0.5)
  }
}

/** Story-only stop; each story gets its own jotai store (decorator). */
const storyStopAtom = atom<DeliveryStop>("briefed")

function LiveDial({
  size,
  label = "Review delivery",
  follows,
}: {
  size: DeliveryDialSize
  label?: string
  follows?: boolean
}) {
  const [stop, setStop] = useAtom(storyStopAtom)
  return (
    <DeliveryDial
      size={size}
      label={label}
      value={stop}
      onChange={setStop}
      follows={follows}
    />
  )
}

const meta = {
  title: "Shared/Delivery dial",
  component: DeliveryDial,
  args: {
    size: "compact",
    value: "briefed",
    label: "Review delivery",
    onChange: () => {},
  },
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
        <div className="min-h-svh bg-paper p-8 font-sans text-sm text-ink">
          <Story />
        </div>
      </Provider>
    ),
  ],
} satisfies Meta<typeof DeliveryDial>

export default meta
type Story = StoryObj<typeof meta>

/**
 * The desk toolbar dial: 80px stops, ticks + name. Arrow keys move it.
 * Retired once the title glyph (Popover) replaces the desk's dial row.
 */
export const Compact: Story = {
  render: () => <LiveDial size="compact" />,
  play: async ({ canvas, userEvent }) => {
    // Widths are measured: wait for the web font, or they're the fallback's.
    await document.fonts.ready
    const group = canvas.getByRole("radiogroup", { name: "Review delivery" })
    await expect(group).toBeInTheDocument()
    const briefed = canvas.getByRole("radio", { name: "Briefed" })
    await expect(briefed).toBeChecked()
    await expectEqualStops(group, MIN_GAP)
    const width = group.getBoundingClientRect().width
    // Keyboard: focus the checked stop, then arrow right to Explained.
    await userEvent.click(briefed)
    await userEvent.keyboard("{ArrowRight}")
    await waitFor(() =>
      expect(canvas.getByRole("radio", { name: "Explained" })).toBeChecked()
    )
    await expect(canvas.getByRole("radio", { name: "Explained" })).toHaveFocus()
    // Checking a stop (medium weight) never resizes the dial.
    await expect(group.getBoundingClientRect().width).toBe(width)
    // Click: Guided.
    await userEvent.click(canvas.getByText("Guided"))
    await waitFor(() =>
      expect(canvas.getByRole("radio", { name: "Guided" })).toBeChecked()
    )
    await expectEqualStops(group, MIN_GAP)
  },
}

/** Compact in a 311px column (the desk on a 375px phone): stops shrink. */
export const CompactNarrow: Story = {
  render: () => (
    <div className="w-[311px]">
      <LiveDial size="compact" />
    </div>
  ),
  globals: { viewport: { value: "phone375", isRotated: false } },
  play: async ({ canvas }) => {
    const group = canvas.getByRole("radiogroup", { name: "Review delivery" })
    await expect(group.getBoundingClientRect().width).toBeLessThanOrEqual(311)
    // Phone: the glyph hides and every label keeps 8px from its stop edge.
    await expectEqualStops(group, PHONE_MIN_GAP)
  },
}

/** Settings hero: each stop with its description; 2×2 below 520px. */
export const Large: Story = {
  render: () => (
    <div className="max-w-[760px]">
      <LiveDial size="large" label="Review delivery for this workspace" />
    </div>
  ),
  play: async ({ canvas, userEvent }) => {
    const facts = canvas.getByRole("radio", { name: "Facts" })
    await expect(facts).toHaveAccessibleDescription(
      "One cited sentence, then the code."
    )
    await userEvent.click(canvas.getByText("Explained"))
    await waitFor(() =>
      expect(canvas.getByRole("radio", { name: "Explained" })).toBeChecked()
    )
  },
}

/** The large dial in a narrow container: two columns, no travelling thumb. */
export const LargeNarrow: Story = {
  render: () => (
    <div className="max-w-[343px]">
      <LiveDial size="large" label="Review delivery for this workspace" />
    </div>
  ),
}

/** Language rows: a set language shows a solid thumb. */
export const Mini: Story = {
  render: () => <LiveDial size="mini" label="Go delivery" />,
  play: async ({ canvas }) => {
    await expectEqualStops(
      canvas.getByRole("radiogroup", { name: "Go delivery" }),
      MIN_GAP
    )
  },
}

/** Following the workspace default: outline thumb, muted label. */
export const MiniFollows: Story = {
  render: () => <LiveDial size="mini" label="SQL delivery" follows />,
}

/**
 * Opened from the title glyph (DeliveryTitleDial): the card surface, a
 * raised thumb with a hairline ring, 9px stop padding, equal stops.
 */
export const Popover: Story = {
  render: () => <LiveDial size="popover" />,
  play: async ({ canvas, userEvent }) => {
    // Widths are measured: wait for the web font, or they're the fallback's.
    await document.fonts.ready
    const group = canvas.getByRole("radiogroup", { name: "Review delivery" })
    await expectEqualStops(group, 9)
    const width = group.getBoundingClientRect().width
    await userEvent.click(canvas.getByText("Guided"))
    await waitFor(() =>
      expect(canvas.getByRole("radio", { name: "Guided" })).toBeChecked()
    )
    await expect(group.getBoundingClientRect().width).toBe(width)
  },
}

/** The popover on a phone: ticks hidden, stops keep 8px from their edges. */
export const PopoverNarrow: Story = {
  render: () => (
    <div className="w-[343px]">
      <LiveDial size="popover" />
    </div>
  ),
  globals: { viewport: { value: "phone375", isRotated: false } },
  play: async ({ canvas }) => {
    const group = canvas.getByRole("radiogroup", { name: "Review delivery" })
    await expect(group.getBoundingClientRect().width).toBeLessThanOrEqual(343)
    await expectEqualStops(group, PHONE_MIN_GAP)
  },
}

/**
 * The ticks: four ascending bars, filled to the stop, hollow after it. Every
 * stop's glyph in every dial reads the same; 1–4 filled here.
 */
export const Ticks: Story = {
  render: () => (
    <div className="flex items-end gap-6 text-ink-muted">
      {(["facts", "briefed", "explained", "guided"] as const).map((stop) => (
        <DeliveryTicks key={stop} stop={stop} size="title" />
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    const glyphs = Array.from(
      canvasElement.querySelectorAll("[data-delivery-ticks]")
    )
    await expect(
      glyphs.map((glyph) => glyph.querySelectorAll("[data-filled]").length)
    ).toEqual([1, 2, 3, 4])
  },
}

/** Every size and the follows state together, for theme checks. */
export const AllSizes: Story = {
  render: () => (
    <div className="flex max-w-[760px] flex-col gap-8">
      <LiveDial size="compact" />
      <LiveDial size="popover" />
      <LiveDial size="large" label="Review delivery for this workspace" />
      <div className="flex flex-col gap-3">
        <LiveDial size="mini" label="Go delivery" />
        <LiveDial size="mini" label="SQL delivery" follows />
      </div>
    </div>
  ),
}

export const AllSizesDark: Story = {
  ...AllSizes,
  globals: { theme: "dark" },
}

/** Reduced motion: the thumb snaps to the stop, no spring. */
export const ReducedMotion: Story = {
  render: () => <LiveDial size="compact" />,
  globals: { reducedMotion: "reduce" },
  play: async ({ canvas, canvasElement, userEvent }) => {
    await userEvent.click(canvas.getByText("Guided"))
    const thumb = canvasElement.querySelector("[data-dial-thumb]")
    // Snapped: the very next frame already sits on the fourth stop.
    await new Promise((resolve) => requestAnimationFrame(resolve))
    await expect(thumb).not.toBeNull()
    await expect((thumb as HTMLElement).style.transform).toContain(
      "translateX(300%)"
    )
  },
}
