import type { Meta, StoryObj } from "@storybook/react-vite"

import { realPacketOverviewFixtures } from "@workspace/ui/fixtures/real-packet.fixtures"
import { BatchOverviewScreen } from "@workspace/ui/neuve/batch-overview/batch-overview-screen"
import { visible } from "@workspace/ui/neuve/story-kit/play"

/**
 * The batch overview on a real review (M5 S3): the generated fixture is a
 * packet Records holds, run through the BFF's projection, beside the
 * designed batch in "Screens/Batch overview".
 */
const meta = {
  title: "Screens/Real packet/Batch overview",
  component: BatchOverviewScreen,
  args: { data: realPacketOverviewFixtures[0]! },
} satisfies Meta<typeof BatchOverviewScreen>

export default meta
type Story = StoryObj<typeof meta>

/** The packet's first batch, as `/batch/<id>` opens it. */
export const FirstBatch: Story = {
  play: async ({ canvas, args }) => {
    await visible(
      canvas.getByRole("heading", { level: 1, name: args.data.title })
    )
  },
}

/** The packet's second batch, as `/batch/<id>` opens it. */
export const SecondBatch: Story = {
  args: {
    data: realPacketOverviewFixtures[1] ?? realPacketOverviewFixtures[0]!,
  },
}

export const FirstBatchDark: Story = { globals: { theme: "dark" } }
