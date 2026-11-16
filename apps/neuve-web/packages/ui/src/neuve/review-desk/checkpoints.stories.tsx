import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"

import {
  allStatesDesk,
  allStatesLeadLine,
  checkpointLines,
  sharedLineDesk,
  twoLinesDesk,
} from "@workspace/ui/fixtures/checkpoint.fixtures"
import { DEFAULT_DELIVERY_SETTINGS } from "@workspace/ui/neuve/shared/delivery"
import type { DeskAt } from "@workspace/ui/neuve/story-kit/desk"
import { deskAt, deskMeta } from "@workspace/ui/neuve/story-kit/desk"
import {
  expectNoLayoutShift,
  pause,
  visible,
} from "@workspace/ui/neuve/story-kit/play"

/**
 * Checkpoints (10.110, 11.16): each sits beside the line's reference pin
 * with its proof state; the briefing names only those no line meets
 * (11.17), since they have no pin (the owner's markup of 25 October). Real
 * units of the packet with the checkpoints Records holds for them
 * (checkpoint.fixtures.ts); "Every state" restates them, as the review
 * recorded only Missing.
 */
const [onFirst, onSecond] = checkpointLines(twoLinesDesk)
const [shared] = checkpointLines(sharedLineDesk)
/** A line's pin when both of its checkpoints are Missing. */
const bothMissing = (line: { lineNumber: number }) =>
  `2 checkpoints on line ${line.lineNumber}, missing, missing`

const meta = {
  title: "Screens/Review desk/Checkpoints",
  ...deskMeta(twoLinesDesk, {}, { settings: DEFAULT_DELIVERY_SETTINGS }),
} satisfies Meta<typeof DeskAt>

export default meta
type Story = StoryObj<typeof meta>

/**
 * Two checkpoints, both Missing, on the first of the lines they mark: a pin
 * in the margin, and no rows in the briefing.
 */
export const PlanUnit: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.queryByRole("list", { name: "Checkpoints" })).toBeNull()
    // The margin places its marks once the diff has laid out.
    await waitFor(
      () =>
        expect(
          canvas.getByRole("button", { name: bothMissing(onFirst!) })
        ).toBeVisible(),
      { timeout: 5000 }
    )
  },
}

/** Both checkpoints on one line, beside its references. */
export const SharedLine: Story = {
  args: deskAt(sharedLineDesk),
  play: async ({ canvas }) => {
    await waitFor(
      () =>
        expect(
          canvas.getByRole("button", { name: bothMissing(shared!) })
        ).toBeVisible(),
      { timeout: 5000 }
    )
  },
}

/**
 * Every proof state, and a ticket item no requirement covers, anchored to
 * the unit as a whole: only that one is a row in the briefing. Records that
 * disagree lead the first line's pin, as an unmet state, over the thin one
 * beside it.
 */
export const EveryState: Story = {
  args: deskAt(allStatesDesk),
  play: async ({ canvas }) => {
    const list = canvas.getByRole("list", { name: "Checkpoints" })
    await expect(within(list).getAllByRole("listitem")).toHaveLength(1)
    await visible(within(list).getByText("Nothing names what proves it."))
    await expect(within(list).queryByText("Conflicting")).toBeNull()
    await waitFor(
      () =>
        expect(
          canvas.getByRole("button", {
            name: `2 checkpoints on line ${allStatesLeadLine.lineNumber}, conflicting, thin`,
          })
        ).toBeVisible(),
      { timeout: 5000 }
    )
  },
}

/** The card, opened from the margin: the line's checkpoints in full. */
export const CardOpen: Story = {
  args: deskAt(sharedLineDesk),
  play: async ({ canvas, canvasElement }) => {
    const mark = await canvas.findByRole(
      "button",
      { name: bothMissing(shared!) },
      { timeout: 5000 }
    )
    await userEvent.click(mark)
    const body = within(canvasElement.ownerDocument.body)
    const card = await body.findByRole("dialog", { name: "2 checkpoints" })
    await expect(within(card).getAllByRole("listitem")).toHaveLength(2)
    await userEvent.keyboard("{Escape}")
    await waitFor(() =>
      expect(body.queryByRole("dialog", { name: "2 checkpoints" })).toBeNull()
    )
  },
}

/**
 * Opening a checkpoint's card from its pin turns the toolbar's Show
 * comments into Dismiss all, and nothing on the page moves. The toggle is
 * measured as well: it starts disabled, and Chrome reports no layout shift
 * for an element that becomes enabled as it changes, so the shift check
 * alone would miss the toolbar moving on this first open.
 */
export const CardOpenMovesNothing: Story = {
  play: async ({ canvas, canvasElement }) => {
    const pin = await canvas.findByRole(
      "button",
      { name: bothMissing(onFirst!) },
      { timeout: 5000 }
    )
    // The desk's own scroll on arrival settles before the pin opens.
    await pause(1000)
    const toggle = canvas.getByRole("button", { name: "Show comments" })
    const before = toggle.getBoundingClientRect()
    await expectNoLayoutShift(async () => {
      await userEvent.click(pin)
      await visible(
        within(canvasElement.ownerDocument.body).getByRole("dialog", {
          name: "2 checkpoints",
        })
      )
    })
    await expect(toggle).toHaveAccessibleName("Dismiss all")
    const after = toggle.getBoundingClientRect()
    await expect({
      left: after.left,
      top: after.top,
      width: after.width,
    }).toEqual({ left: before.left, top: before.top, width: before.width })
  },
}

/**
 * The unit's checkpoints mark several ranges that only unchanged lines
 * separate, so they show once, on the first of them: no pin on the second
 * line, and the first line's card lists both.
 */
export const OnceAcrossItsLines: Story = {
  play: async ({ canvas, canvasElement }) => {
    const first = await canvas.findByRole(
      "button",
      { name: bothMissing(onFirst!) },
      { timeout: 5000 }
    )
    await expect(
      canvas.queryByRole("button", { name: bothMissing(onSecond!) })
    ).toBeNull()
    await expect(
      canvasElement.querySelectorAll("[data-checkpoint-mark]")
    ).toHaveLength(1)
    // The desk's own scroll on arrival settles before the pin opens.
    await pause(1000)
    await userEvent.click(first)
    const card = await waitFor(
      () => {
        const found = within(canvasElement.ownerDocument.body).getByRole(
          "dialog",
          { name: "2 checkpoints" }
        )
        expect(found).toBeVisible()
        return found
      },
      { timeout: 5000 }
    )
    await expect(within(card).getAllByRole("listitem")).toHaveLength(2)
    await expect(first).toHaveAttribute("aria-expanded", "true")
  },
}

/** At phone width, the rail folded away. */
export const Phone: Story = {
  args: deskAt(twoLinesDesk, { rail: "collapsed" }),
  globals: { viewport: { value: "phone", isRotated: false } },
}
