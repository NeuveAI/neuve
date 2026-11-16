import type { Meta, StoryObj } from "@storybook/react-vite"

import { realPacketDeskFixtures } from "@workspace/ui/fixtures/real-packet.fixtures"
import { DEFAULT_DELIVERY_SETTINGS } from "@workspace/ui/neuve/shared/delivery"
import type { DeskAt } from "@workspace/ui/neuve/story-kit/desk"
import { deskAt, deskMeta } from "@workspace/ui/neuve/story-kit/desk"
import { visible } from "@workspace/ui/neuve/story-kit/play"
import type { ReviewDeskData, ReviewLane } from "@workspace/ui/neuve/types"

/**
 * The review desk on a real review (M5 S3): units of a packet Records holds,
 * run through the BFF's projection (the generated real-packet fixture),
 * beside the designed desk in "Screens/Review desk". Explained shows the
 * harness's prose once the fixture is regenerated from a packet that
 * carries it ("Screens/Review desk/Explained" shows the layer).
 */
const desks = Object.values(realPacketDeskFixtures)
const inLane = (lane: ReviewLane): ReviewDeskData =>
  desks.find((desk) => desk.unit.lane === lane) ?? desks[0]!
const commented =
  desks.find((desk) =>
    (desk.commentRecords ?? []).some((record) => record.author.kind === "agent")
  ) ?? desks[0]!
const required = inLane("human-required")
const suggested = inLane("human-suggested")

const meta = {
  title: "Screens/Real packet/Review desk",
  ...deskMeta(required, {}, { settings: DEFAULT_DELIVERY_SETTINGS }),
} satisfies Meta<typeof DeskAt>

export default meta
type Story = StoryObj<typeof meta>

/** A human-required unit, with its references in the margin. */
export const HumanRequired: Story = {
  play: async ({ canvas }) => {
    await visible(
      canvas.getByRole("heading", { level: 1, name: required.unit.title })
    )
  },
}

/** The same unit at Guided: the review's rows and its suggested review. */
export const HumanRequiredGuided: Story = {
  args: deskAt(required, { stop: "guided" }),
}

/** The same unit at Facts: one cited sentence. */
export const HumanRequiredFacts: Story = {
  args: deskAt(required, { stop: "facts" }),
}

/** The first reference's card open (L2). */
export const ReferenceCardOpen: Story = {
  args: deskAt(required, {
    open: required.files[0]?.markerAnchors[0]?.markerKey,
  }),
}

/** A human-suggested unit with the agent's review. */
export const HumanSuggested: Story = {
  args: deskAt(suggested),
}

/** A unit with the agent's finding as a review comment in the margin. */
export const AgentComment: Story = {
  args: deskAt(commented, { comments: commented.commentRecords ?? [] }),
}
