import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, userEvent, within } from "storybook/test"

import {
  REVIEWS_NOW,
  REVIEWS_TIME_ZONE,
  realReviews,
  realReviewsPage2,
  realReviewsWaiting,
} from "@workspace/ui/fixtures/real-reviews.fixtures"
import {
  EARLIER_LINK_EXPIRY_REVIEW,
  linkExpiryClosureArrivedReviewsFixture,
  linkExpiryClosureCarriedReviewsFixture,
  linkExpiryClosureReviewsFixture,
  linkExpiryOlderReviewsFixture,
} from "@workspace/ui/fixtures/lanes-reviews.fixtures"
import {
  startAfterFailureFixture,
  startPreviewFixture,
} from "@workspace/ui/fixtures/review-start.fixtures"
import { ReviewsScreen } from "@workspace/ui/neuve/reviews/reviews-screen"
import {
  expectNoLayoutShift,
  visible,
} from "@workspace/ui/neuve/story-kit/play"
import type { ReviewSummary, ReviewsData } from "@workspace/ui/neuve/types"

/**
 * The Reviews page (`/`) on the Neuve repository's own reviews, read through
 * the page's BFF load (fixtures/real-reviews.fixtures.ts). The state stories
 * change one real review where Records had no example: a run still going,
 * one that failed, nothing waiting.
 */
const meta = {
  title: "Screens/Reviews",
  component: ReviewsScreen,
  args: { data: realReviews, now: REVIEWS_NOW, timeZone: REVIEWS_TIME_ZONE },
  parameters: {
    layout: "fullscreen",
    viewport: {
      options: {
        phone375: {
          name: "Phone 375",
          styles: { width: "375px", height: "812px" },
          type: "mobile",
        },
        phone390: {
          name: "Phone 390",
          styles: { width: "390px", height: "844px" },
          type: "mobile",
        },
      },
    },
  },
} satisfies Meta<typeof ReviewsScreen>

export default meta
type Story = StoryObj<typeof meta>

const withFirst = (
  data: ReviewsData,
  change: Partial<ReviewSummary>
): ReviewsData => ({
  ...data,
  reviews: data.reviews.map((review, index) =>
    index === 0 ? { ...review, ...change } : review
  ),
})

/** The first page: what waits on you, then ten reviews under their days, and the pages. */
export const FirstPage: Story = {
  play: async ({ canvas }) => {
    await visible(canvas.getByRole("heading", { level: 1, name: "Reviews" }))
    await visible(canvas.getByText("1–10 of 16 reviews"))
    const pages = canvas.getByRole("navigation", { name: "Pages of reviews" })
    await expect(
      within(pages).getByRole("link", { name: "Page 1" })
    ).toHaveAttribute("aria-current", "page")
    await visible(within(pages).getByRole("link", { name: "Next page" }))
    // On the first page, Previous is shown but is not a link.
    await expect(
      within(pages).queryByRole("link", { name: "Previous page" })
    ).toBeNull()
    await expect(canvas.getAllByRole("listitem").length).toBeGreaterThan(10)
  },
}

/** The second page: the six older reviews; Next is the step that can't be taken. */
export const SecondPage: Story = {
  args: { data: realReviewsPage2 },
  play: async ({ canvas }) => {
    await visible(canvas.getByText("11–16 of 16 reviews"))
    const pages = canvas.getByRole("navigation", { name: "Pages of reviews" })
    await expect(
      within(pages).getByRole("link", { name: "Page 2" })
    ).toHaveAttribute("aria-current", "page")
    // Only the page on screen is current.
    await expect(
      within(pages).getByRole("link", { name: "Page 1" })
    ).not.toHaveAttribute("aria-current")
    await expect(
      within(pages).queryByRole("link", { name: "Next page" })
    ).toBeNull()
  },
}

/** "Waiting on you": only the reviews with human-required units you haven't decided. */
export const WaitingOnYou: Story = {
  args: { data: realReviewsWaiting },
  play: async ({ canvas }) => {
    await expect(
      canvas.getByRole("radio", { name: /Waiting on you/ })
    ).toHaveAttribute("aria-checked", "true")
    await expect(
      canvas.queryByRole("navigation", { name: "Pages of reviews" })
    ).toBeNull()
  },
}

/**
 * A review of several batches opens its batches; each opens its overview
 * and says what it still needs from you. Opening the list moves nothing.
 */
export const BatchesOpen: Story = {
  play: async ({ canvas, canvasElement }) => {
    const trigger = canvas.getAllByRole("button", { name: /batches$/ })[0]!
    await expectNoLayoutShift(() => userEvent.click(trigger))
    const menu = await within(canvasElement.ownerDocument.body).findByRole(
      "menu"
    )
    await expect(within(menu).getAllByRole("menuitem").length).toBeGreaterThan(
      1
    )
  },
}

/** The newest review is still running: no batch yet, so its row opens nothing. */
export const Running: Story = {
  args: {
    data: withFirst(realReviews, {
      state: "running",
      title:
        "Adjudicated human-required units are guarded; splits show what stays",
      lanes: [],
      gate: [],
      feedback: false,
      batches: [],
    }),
  },
  play: async ({ canvas }) => {
    await visible(canvas.getByText("Running"))
  },
}

/**
 * A running review that has published its first batch of three: its row
 * shows that batch's lanes, squares and "to decide" as any review does, and
 * its batches read published of all. Only published units wait on you, and
 * a human-suggested unit the agent reviewed is decided: its square shows
 * the agent's review, and only the human-required units wait.
 */
export const RunningWithBatches: Story = {
  args: { data: linkExpiryClosureReviewsFixture },
  play: async ({ canvas, canvasElement }) => {
    await visible(canvas.getByText("3 units wait on you"))
    await expect(canvas.getByText("Running")).toBeVisible()
    await expect(canvas.getByText("3 to decide")).toBeVisible()
    await expect(
      canvas.getByRole("list", { name: "Human review: 2 of 5 decided" })
    ).toBeVisible()
    const trigger = canvas.getByRole("button", { name: "1 of 3 batches" })
    await userEvent.click(trigger)
    const menu = await within(canvasElement.ownerDocument.body).findByRole(
      "menu"
    )
    await expect(within(menu).getAllByRole("menuitem")).toHaveLength(1)
  },
}

/** The same review once its second batch arrived. */
export const RunningSecondBatch: Story = {
  args: { data: linkExpiryClosureArrivedReviewsFixture },
  play: async ({ canvas }) => {
    await visible(canvas.getByText("4 units wait on you"))
    await expect(
      canvas.getByRole("button", { name: "2 of 3 batches" })
    ).toBeVisible()
  },
}

/**
 * Your earlier approval of the admins unit carried from the branch's earlier
 * review: its square reads approved, and one fewer unit waits on you.
 */
export const RunningCarriedDecision: Story = {
  args: { data: linkExpiryClosureCarriedReviewsFixture },
  play: async ({ canvas }) => {
    await visible(canvas.getByText("2 units wait on you"))
    await expect(canvas.getByText("2 to decide")).toBeVisible()
    await expect(
      canvas.getByRole("list", { name: "Human review: 3 of 5 decided" })
    ).toBeVisible()
  },
}

/**
 * The branch's earlier review is listed under the newer one, which holds
 * all of its units: its row says "Replaced by a newer review" in place of
 * squares and
 * nothing to decide, and only the newer review's units wait on you.
 */
export const OlderReview: Story = {
  args: { data: linkExpiryOlderReviewsFixture },
  play: async ({ canvas }) => {
    await visible(canvas.getByText("2 units wait on you"))
    await expect(canvas.getByText("in 1 review")).toBeVisible()
    // Both reviews of the branch share a title; the earlier one's range names it.
    const older = canvas
      .getByText(EARLIER_LINK_EXPIRY_REVIEW.range)
      .closest("li")
    await expect(older).not.toBeNull()
    const row = within(older as HTMLElement)
    await expect(row.getByText("Replaced by a newer review")).toBeVisible()
    await expect(row.queryByRole("list", { name: /Human review/ })).toBeNull()
    await expect(row.queryByText(/to decide/)).toBeNull()
    // Waiting on you counts only the review that asks for something.
    await expect(
      canvas.getByRole("radio", { name: /Waiting on you/ })
    ).toHaveTextContent("1")
  },
}

export const OlderReviewDark: Story = {
  ...OlderReview,
  globals: { theme: "dark" },
}

export const OlderReviewPhone: Story = {
  ...OlderReview,
  globals: { viewport: { value: "phone390", isRotated: false } },
}

/** The newest run failed before it published. */
export const Failed: Story = {
  args: {
    data: withFirst(realReviews, {
      state: "failed",
      lanes: [],
      gate: [],
      feedback: false,
      batches: [],
    }),
  },
}

/** Every human unit is decided: the panel says so and offers no action. */
export const NothingWaits: Story = {
  args: {
    data: {
      ...realReviews,
      counts: { ...realReviews.counts, waiting: 0 },
      waiting: { units: 0, reviews: 0 },
      reviews: realReviews.reviews.map((review) => ({
        ...review,
        gate: review.gate.map((unit) =>
          unit.mark === "waiting"
            ? { ...unit, mark: "approved" as const }
            : unit
        ),
        batches: review.batches.map((batch) => ({ ...batch, needYou: 0 })),
      })),
    },
  },
  play: async ({ canvas }) => {
    await visible(canvas.getByText("Nothing waits on you"))
    await expect(canvas.queryByRole("link", { name: /Open next/ })).toBeNull()
  },
}

/** The branch moved past the newest review: Start a review leads the page. */
export const NewWork: Story = {
  args: {
    data: { ...realReviews, newestHead: "0000000" },
    start: startPreviewFixture,
    onStartReview: async () => {},
  },
}

/** The newest review failed: Start a review again, with what went wrong. */
export const NewestFailed: Story = {
  args: {
    data: withFirst(realReviews, {
      state: "failed",
      lanes: [],
      gate: [],
      feedback: false,
      batches: [],
    }),
    start: startAfterFailureFixture,
    onStartReview: async () => {},
  },
  play: async ({ canvas }) => {
    await visible(canvas.getByRole("button", { name: /Try again/ }))
    await visible(canvas.getByRole("alert"))
  },
}

export const FirstPageDark: Story = { globals: { theme: "dark" } }

/** Phone width: rows stack, and the pages read "Page 1 of 2" between the arrows. */
export const Phone: Story = {
  globals: { viewport: { value: "phone375", isRotated: false } },
  play: async ({ canvas }) => {
    await visible(canvas.getByText("Page 1 of 2"))
  },
}

export const PhoneDark: Story = {
  globals: {
    theme: "dark",
    viewport: { value: "phone375", isRotated: false },
  },
}
