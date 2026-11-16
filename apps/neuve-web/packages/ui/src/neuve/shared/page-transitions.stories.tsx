import type { Meta, StoryObj } from "@storybook/react-vite"

import { multiBatchOverviewFixture } from "@workspace/ui/fixtures/review-batch.fixtures"
import { BatchOverviewScreen } from "@workspace/ui/neuve/batch-overview/batch-overview-screen"
import type { DeskAt } from "@workspace/ui/neuve/story-kit/desk"
import { deskMeta } from "@workspace/ui/neuve/story-kit/desk"
import { expectOneSnapshotAtATime } from "@workspace/ui/neuve/story-kit/play"

/**
 * Router page transitions (view-transitions.ts, globals.css). Whatever
 * persists across pages, the header with its batch menu and Live badge and
 * the desk's rail, holds still with its new snapshot only; page regions
 * leave before the new ones enter. At no frame does a group show two
 * snapshots, which would draw its text twice.
 */
const meta = {
  title: "Shared/Page transitions",
  ...deskMeta(),
} satisfies Meta<typeof DeskAt>

export default meta
type Story = StoryObj<typeof meta>

/** Desk to desk, forward: header, rail, briefing, diff and dock. */
export const DeskForward: Story = {
  play: async ({ canvasElement }) => {
    await expectOneSnapshotAtATime(canvasElement.ownerDocument, ["forward"])
  },
}

/** Desk to desk, back. */
export const DeskBack: Story = {
  play: async ({ canvasElement }) => {
    await expectOneSnapshotAtATime(canvasElement.ownerDocument, ["back"])
  },
}

/** Batch to batch on the overview: the header's batch title changes. */
export const OverviewForward: Story = {
  render: () => <BatchOverviewScreen data={multiBatchOverviewFixture} />,
  play: async ({ canvasElement }) => {
    await expectOneSnapshotAtATime(canvasElement.ownerDocument, ["forward"])
  },
}
