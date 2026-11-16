import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, waitFor } from "storybook/test"

import { reviewDeskFixture } from "@workspace/ui/fixtures/review-batch.fixtures"
import {
  DraftPin,
  HiddenMarkersPin,
  MarginLine,
  MarginPin,
  groupMarkerAnchors,
} from "@workspace/ui/neuve/review-desk/context-margin"
import { onPaper } from "@workspace/ui/neuve/story-kit/frames"
import { withReviewDeskState } from "@workspace/ui/neuve/story-kit/store"
import { expectTabFocusRing } from "@workspace/ui/neuve/story-kit/play"
import type { MarkerAnchor } from "@workspace/ui/neuve/types"

const markers = reviewDeskFixture.markers

/**
 * Keyboard focus in the context margin: each play tabs to its control and
 * asserts the focus ring a reviewer sees (real focus-visible, not forced).
 */
const meta = {
  title: "Review desk/Context margin focus ring",
  component: MarginPin,
  decorators: [onPaper],
  args: {
    marker: markers["conflict"]!,
    on: false,
    disabled: false,
    onToggle: fn(),
    onHintStart: fn(),
    onHintEnd: fn(),
  },
} satisfies Meta<typeof MarginPin>

export default meta
type Story = StoryObj<typeof meta>

/** A marker pin. */
export const Pin: Story = {
  play: async ({ canvas, userEvent }) => {
    await expectTabFocusRing(
      userEvent,
      canvas.getByRole("button", { name: /^Conflict/ })
    )
  },
}

/** The parked draft pin. */
export const Draft: Story = {
  render: () => (
    <DraftPin
      label="L20–23"
      excerpt="Should this also clear the link cache?"
      disabled={false}
      onOpen={fn()}
    />
  ),
  play: async ({ canvas, userEvent }) => {
    await expectTabFocusRing(
      userEvent,
      canvas.getByRole("button", { name: /^Draft comment on L20–23/ })
    )
  },
}

/** The pin for markers in collapsed lines. */
export const HiddenLines: Story = {
  render: () => <HiddenMarkersPin count={2} onOpen={fn()} />,
  play: async ({ canvas, userEvent }) => {
    await expectTabFocusRing(
      userEvent,
      canvas.getByRole("button", {
        name: "2 markers in hidden lines. Show the lines",
      })
    )
  },
}

const lineAnchor = (markerKey: string): MarkerAnchor => ({
  markerKey,
  side: "additions",
  lineNumber: 23,
})

/** A row of a shared line's list (the ring sits inset). */
export const LineListRow: Story = {
  decorators: [withReviewDeskState()],
  render: () => (
    <div className="flex w-[300px]">
      <MarginLine
        group={
          groupMarkerAnchors(
            ["doc", "batch", "conflict"].map(lineAnchor),
            markers
          )[0]!
        }
        filePath={reviewDeskFixture.files[0]!.path}
        reviewer={reviewDeskFixture.reviewer}
        agentId="i1"
      />
    </div>
  ),
  play: async ({ canvas, canvasElement, userEvent }) => {
    // Opened from the keyboard: a pointer open lands focus without a ring.
    canvas.getByRole("button", { name: /^Conflict on line 23/ }).focus()
    await userEvent.keyboard("{Enter}")
    const list = await waitFor(() => {
      const found =
        canvasElement.ownerDocument.querySelector<HTMLElement>(
          "[data-line-list]"
        )
      expect(found).toBeVisible()
      return found!
    })
    await expectTabFocusRing(
      userEvent,
      list.querySelector<HTMLButtonElement>("button")!
    )
  },
}
