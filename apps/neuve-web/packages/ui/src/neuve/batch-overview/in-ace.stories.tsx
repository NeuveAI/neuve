import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"

import {
  batchOverviewFixture,
  multiBatchOverviewFixture,
} from "@workspace/ui/fixtures/review-batch.fixtures"
import { BatchOverviewScreen } from "@workspace/ui/neuve/batch-overview/batch-overview-screen"
import {
  ACE_VIEWPORTS,
  AT_ACE_SPLIT,
  AT_ACE_TAB,
  inAceTab,
} from "@workspace/ui/neuve/story-kit/frames"

/**
 * The batch overview in Ace's Review tab (decision 12.16): the header gives
 * way to one thin row, project / branch and commit, and the page is
 * otherwise the overview on its own address ("Screens/Batch overview").
 */
const meta = {
  title: "Screens/Batch overview/In Ace",
  component: BatchOverviewScreen,
  args: { data: batchOverviewFixture },
  decorators: [inAceTab],
  parameters: { viewport: { options: ACE_VIEWPORTS } },
} satisfies Meta<typeof BatchOverviewScreen>

export default meta
type Story = StoryObj<typeof meta>

const dark = { theme: "dark" } as const

/** The row says where the review stands; the brand, Find, agents and theme are Ace's. */
async function expectThinRow(canvas: ReturnType<typeof within>) {
  const row = canvas.getByRole("banner")
  await expect(row).toHaveTextContent(batchOverviewFixture.repo)
  await expect(row).toHaveTextContent(batchOverviewFixture.branch)
  await expect(row).toHaveTextContent(
    batchOverviewFixture.revision.slice(0, 12)
  )
  await expect(row.getBoundingClientRect().height).toBeLessThanOrEqual(40)
  await expect(canvas.queryByRole("button", { name: "Find" })).toBeNull()
  await expect(
    canvas.queryByRole("button", { name: /Switch to (dark|light) theme/ })
  ).toBeNull()
}

/** The full-width tab. */
export const Tab: Story = {
  ...AT_ACE_TAB,
  play: async ({ canvas }) => expectThinRow(canvas),
}
export const TabDark: Story = {
  globals: { ...AT_ACE_TAB.globals, ...dark },
}

/** Split beside the chat: the page fits its half without scrolling sideways. */
export const Split: Story = {
  ...AT_ACE_SPLIT,
  play: async ({ canvas, canvasElement }) => {
    const doc = canvasElement.ownerDocument
    await expect(doc.documentElement.clientWidth, "A 640px tab").toBe(640)
    await expectThinRow(canvas)
    await expect(doc.documentElement.scrollWidth).toBe(640)
  },
}
export const SplitDark: Story = {
  globals: { ...AT_ACE_SPLIT.globals, ...dark },
}

/**
 * Several batches: the row carries the batch menu, and it is the page's
 * only one (the hidden header renders none), so it opens alone.
 */
export const SeveralBatches: Story = {
  ...AT_ACE_SPLIT,
  args: { data: multiBatchOverviewFixture },
  play: async ({ canvas, canvasElement }) => {
    const doc = canvasElement.ownerDocument
    const row = canvas.getByRole("banner")
    const trigger = await within(row).findByRole("button", {
      name: /batch 1 of 3/,
    })
    await userEvent.click(trigger)
    await waitFor(() =>
      expect(within(doc.body).getAllByRole("menu")).toHaveLength(1)
    )
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(within(doc.body).queryByRole("menu")).toBeNull())
    await expect(trigger).toHaveFocus()
  },
}
