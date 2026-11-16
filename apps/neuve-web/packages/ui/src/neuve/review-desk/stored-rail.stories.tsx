import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, waitFor } from "storybook/test"

import { reviewDeskFixture } from "@workspace/ui/fixtures/review-batch.fixtures"
import {
  RAIL_COLLAPSED_STORAGE_KEY,
  useRailCollapsed,
} from "@workspace/ui/neuve/review-desk/atoms"
import { UnitRail } from "@workspace/ui/neuve/review-desk/unit-rail"
import { RailFrame } from "@workspace/ui/neuve/story-kit/frames"
import { withReviewDeskState } from "@workspace/ui/neuve/story-kit/store"

/**
 * The rail as browser storage left it. No story state seeds the rail, so the
 * stored value is the only source: hydration would write storage instead.
 */
const meta = {
  title: "Review desk/Stored rail",
  component: UnitRail,
  args: { data: reviewDeskFixture },
  decorators: [withReviewDeskState()],
} satisfies Meta<typeof UnitRail>

export default meta
type Story = StoryObj<typeof meta>

/** Subscribes before the rail does (effects run in sibling order). */
function EarlierReader() {
  useRailCollapsed()
  return null
}

/**
 * Collapsed in storage: the rail opens collapsed after a reload, even when
 * another reader loaded the stored value first.
 */
export const StoredCollapsed: Story = {
  beforeEach: () => {
    localStorage.setItem(RAIL_COLLAPSED_STORAGE_KEY, "true")
    return () => localStorage.removeItem(RAIL_COLLAPSED_STORAGE_KEY)
  },
  render: (args) => (
    <RailFrame data={args.data}>
      <EarlierReader />
    </RailFrame>
  ),
  play: async ({ canvasElement }) => {
    const nav = canvasElement.querySelector("nav")!
    await waitFor(() => expect(nav).toHaveAttribute("data-collapsed"))
    await waitFor(() => expect(nav.getBoundingClientRect().width).toBe(60))
  },
}
