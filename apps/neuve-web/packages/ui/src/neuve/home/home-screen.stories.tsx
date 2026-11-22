import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, within } from "storybook/test"

import {
  HOME_NOW,
  HOME_TIME_ZONE,
  realHome,
  realHomeWaiting,
} from "@workspace/ui/fixtures/real-home.fixtures"
import {
  startAfterFailureFixture,
  startPreviewFixture,
} from "@workspace/ui/fixtures/review-start.fixtures"
import type { HomeData, HomeReview } from "@workspace/ui/neuve/home/home-data"
import { HomeScreen } from "@workspace/ui/neuve/home/home-screen"
import { visible } from "@workspace/ui/neuve/story-kit/play"

/**
 * The home page (`/`) on the Neuve repository's own reviews, read through
 * the page's BFF load (fixtures/real-home.fixtures.ts). The state stories
 * change one real review where Records had no example: a run still going,
 * one that failed, one still publishing its batches, nothing waiting.
 */
const meta = {
  title: "Screens/Home",
  component: HomeScreen,
  args: { data: realHome, now: HOME_NOW, timeZone: HOME_TIME_ZONE },
  parameters: {
    layout: "fullscreen",
    viewport: {
      options: {
        phone390: {
          name: "Phone 390",
          styles: { width: "390px", height: "844px" },
          type: "mobile",
        },
      },
    },
  },
} satisfies Meta<typeof HomeScreen>

export default meta
type Story = StoryObj<typeof meta>

const withFirst = (data: HomeData, change: Partial<HomeReview>): HomeData => ({
  ...data,
  reviews: data.reviews.map((review, index) =>
    index === 0 ? { ...review, ...change } : review
  ),
})

/**
 * The first page: what waits on you, then each review under its day with
 * its batches, each batch with its digest, lanes and what waits on you.
 * Nothing is opened for the reader.
 */
export const FirstPage: Story = {
  play: async ({ canvas }) => {
    await visible(canvas.getByRole("heading", { level: 1, name: "Reviews" }))
    await visible(canvas.getByText("1–10 of 481 reviews"))
    const card = canvas.getByRole("article", {
      name: "Refusal and cleanup hardening",
    })
    const batch = within(card)
    await expect(
      batch.getByRole("link", { name: "Refusal and cleanup hardening" })
    ).toHaveAttribute("href", expect.stringContaining("/batch/"))
    await expect(batch.getByText("1 to decide")).toBeVisible()
    await expect(
      batch.getByRole("link", { name: "Open desk" })
    ).toHaveAttribute("href", expect.stringContaining("/review/"))
  },
}

export const FirstPageDark: Story = {
  ...FirstPage,
  globals: { theme: "dark" },
}

export const FirstPagePhone: Story = {
  ...FirstPage,
  globals: { viewport: { value: "phone390", isRotated: false } },
}

/** "Waiting on you": only the reviews with a unit that waits on you. */
export const WaitingOnYou: Story = {
  args: { data: realHomeWaiting },
  play: async ({ canvas }) => {
    await expect(
      canvas.getByRole("radio", { name: /Waiting on you/ })
    ).toHaveAttribute("aria-checked", "true")
  },
}

/**
 * The branch's earlier review, under the newer one that holds its units:
 * it says a newer review replaced it, and its batches ask for nothing.
 */
export const OlderReview: Story = {
  play: async ({ canvas }) => {
    const older = canvas
      .getByText("Replaced by a newer review")
      .closest("section")
    await expect(older).not.toBeNull()
    await expect(
      within(older as HTMLElement).queryByText(/to decide/)
    ).toBeNull()
  },
}

/** The newest review is running and has published none of its batches yet. */
export const Running: Story = {
  args: {
    data: withFirst(realHome, {
      state: "running",
      title: "Preserve listed member whitespace",
      lanes: [],
      gate: [],
      batches: [],
    }),
  },
  play: async ({ canvas }) => {
    await visible(
      canvas.getByText("Its batches appear here as the review publishes them.")
    )
  },
}

/** A running review that has published one batch of three. */
export const RunningWithBatches: Story = {
  args: {
    data: withFirst(realHome, {
      state: "running",
      batches: realHome.reviews[0]!.batches.slice(0, 1),
      pendingBatches: 2,
    }),
  },
  play: async ({ canvas }) => {
    await visible(canvas.getByText("1 of 3 batches"))
    await visible(canvas.getByText("Reviewing 2 more batches"))
  },
}

/** The newest run failed before it published a batch. */
export const Failed: Story = {
  args: {
    data: withFirst(realHome, {
      state: "failed",
      lanes: [],
      gate: [],
      batches: [],
    }),
  },
  play: async ({ canvas }) => {
    await visible(canvas.getByText("This review published no batch."))
  },
}

/** Every human unit is decided: the panel says so and offers no action. */
export const NothingWaits: Story = {
  args: {
    data: {
      ...realHome,
      counts: { ...realHome.counts, waiting: 0 },
      waiting: { units: 0, reviews: 0 },
      reviews: realHome.reviews.map((review) => ({
        ...review,
        batches: review.batches.map((batch) => ({ ...batch, needYou: 0 })),
      })),
    },
  },
  play: async ({ canvas }) => {
    await visible(canvas.getByText("Nothing waits on you"))
  },
}

/** Nothing waits, yet All lists reviews: Clear, which clears both lists, is offered here too. */
export const NothingWaitsUnderWaiting: Story = {
  args: {
    data: {
      ...realHomeWaiting,
      reviews: [],
      total: 0,
      counts: { ...realHomeWaiting.counts, waiting: 0 },
      waiting: { units: 0, reviews: 0 },
    },
    onClear: async () => {},
  },
  play: async ({ canvas }) => {
    await visible(canvas.getByText("Nothing waits on you."))
    await visible(canvas.getByRole("button", { name: "Clear" }))
  },
}

/** The branch moved past the newest review: Start a review offers the new work. */
export const NewWork: Story = {
  args: { start: startPreviewFixture, onStartReview: async () => {} },
}

/** The newest review failed: Start a review again, with what went wrong. */
export const StartAfterFailure: Story = {
  args: { start: startAfterFailureFixture, onStartReview: async () => {} },
}
