import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect } from "storybook/test"

import { goDeliveryDeskFixture } from "@workspace/ui/fixtures/review-batch.fixtures"
import type { DeskAt } from "@workspace/ui/neuve/story-kit/desk"
import { deskAt, deskMeta } from "@workspace/ui/neuve/story-kit/desk"
import { visible } from "@workspace/ui/neuve/story-kit/play"
import type { ReviewDeskData } from "@workspace/ui/neuve/types"

/**
 * Explained as the harness writes it (10.60): before and after paragraphs
 * and its terms, as written, in the briefing. Real units carry this shape
 * and no flow diagram, so the desk here drops the designed unit's flow and
 * its line-tied terms and keeps prose written for the same change.
 */
const prose: ReviewDeskData = {
  ...goDeliveryDeskFixture,
  delivery: {
    ...goDeliveryDeskFixture.delivery!,
    flow: undefined,
    terms: undefined,
    explained: {
      before:
        "Commit opened its write transaction once. When the database was busy, BeginTx failed and Commit returned that error to its caller.",
      after:
        "Commit tries commitOnce up to three times. A busy error, wrapped or not, waits for the backoff and tries again; after the third busy attempt Commit returns ErrIndexBusy. A cancelled context does not cut the wait short, and no test covers the busy path.",
      terms: [
        {
          term: "for attempt := range maxAttempts",
          meaning:
            "Counts attempt from 0 up to maxAttempts − 1. Ranging over an integer is new in Go 1.22.",
        },
        {
          term: "errors.Is(err, sqlite.ErrBusy)",
          meaning:
            "True when err is ErrBusy or wraps it, so a wrapped busy error still retries.",
        },
        {
          term: "time.Sleep(backoff(attempt))",
          meaning:
            "Pauses the goroutine for the whole wait. Nothing can interrupt it, including a cancelled ctx.",
        },
      ],
    },
  },
}

const meta = {
  title: "Screens/Review desk/Explained",
  ...deskMeta(prose, { stop: "explained" }),
} satisfies Meta<typeof DeskAt>

export default meta
type Story = StoryObj<typeof meta>

/**
 * The Explained stop, in the briefing (merged briefing, 25 October): Before
 * beside After, the change's links folded into one line under them, then
 * its terms. No second card says it again.
 */
export const Prose: Story = {
  play: async ({ canvas }) => {
    await visible(canvas.getByText(prose.delivery!.explained!.after))
    await expect(canvas.getByText("Before")).toBeVisible()
    await expect(canvas.getAllByRole("term")).toHaveLength(3)
    await expect(
      canvas.queryByRole("region", { name: "How it changes" })
    ).toBeNull()
  },
}

/** Briefed: the claims come back, Before and After leave. */
export const AtBriefed: Story = {
  args: deskAt(prose, { stop: "briefed" }),
  play: async ({ canvas }) => {
    await expect(
      canvas.queryByText(prose.delivery!.explained!.after)
    ).toBeNull()
    await expect(canvas.queryAllByRole("term")).toHaveLength(0)
  },
}

/** At phone width the labels sit above their paragraphs. */
export const Phone: Story = {
  args: deskAt(prose, { stop: "explained", rail: "collapsed" }),
  globals: { viewport: { value: "phone", isRotated: false } },
}
