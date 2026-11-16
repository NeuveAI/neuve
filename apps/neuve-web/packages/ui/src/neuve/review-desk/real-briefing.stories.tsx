import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, waitFor, within } from "storybook/test"

import { realBriefingDeskFixtures } from "@workspace/ui/fixtures/real-briefing.fixtures"
import { checkHeading } from "@workspace/ui/neuve/review-desk/delivery/criteria-card"
import { DEFAULT_DELIVERY_SETTINGS } from "@workspace/ui/neuve/shared/delivery"
import type { DeskAt } from "@workspace/ui/neuve/story-kit/desk"
import { deskAt, deskMeta } from "@workspace/ui/neuve/story-kit/desk"
import { visible } from "@workspace/ui/neuve/story-kit/play"

/**
 * One briefing per unit across the dial (UnitBriefing.dc.html, approved by
 * the owner on 25 October 2026), on a real review: a joined unit's changes
 * are rows whose titles stay put while the stop changes what each says, and
 * a unit with one change keeps the same order without rows. Checkpoints on
 * lines are pins in the margin, not rows here.
 */
const desks = Object.values(realBriefingDeskFixtures)
/** The joined unit: three changes of one file. */
const joined = desks.find((desk) => (desk.unit.sections?.length ?? 0) > 2)!
/** A unit with one change. */
const single = desks.find(
  (desk) => !desk.unit.sections && desk.unit.lane === "human-suggested"
)!
const titles = joined.unit.sections!.map((section) => section.title)

/** The briefing's rows, one per change, once they have mounted. */
const rows = (canvasElement: HTMLElement) =>
  waitFor(() => {
    const found = titles.map((title) =>
      within(canvasElement).getByRole("region", { name: title })
    )
    expect(found).toHaveLength(titles.length)
    return found
  })

const meta = {
  title: "Screens/Real packet/Briefing",
  ...deskMeta(
    joined,
    { stop: "briefed" },
    { settings: DEFAULT_DELIVERY_SETTINGS }
  ),
} satisfies Meta<typeof DeskAt>

export default meta
type Story = StoryObj<typeof meta>

/**
 * Briefed: each change's title beside its claims, one per line, with their
 * links; the lead says what the changes do together.
 */
export const Joined: Story = {
  play: async ({ canvasElement }) => {
    const found = await rows(canvasElement)
    for (const [index, row] of found.entries()) {
      const inRow = within(row)
      // The desk fades in as it mounts.
      await visible(
        inRow.getByRole("heading", { level: 2, name: titles[index] })
      )
      await expect(inRow.getAllByRole("listitem").length).toBeGreaterThan(1)
      await expect(inRow.getAllByRole("link").length).toBeGreaterThan(0)
    }
    await expect(
      within(canvasElement).queryByRole("list", { name: "Checkpoints" })
    ).toBeNull()
  },
}

/** Facts: each change's own sentence, in its row; the lead leaves. */
export const JoinedFacts: Story = {
  args: deskAt(joined, { stop: "facts" }),
  play: async ({ canvasElement }) => {
    const found = await rows(canvasElement)
    for (const [index, row] of found.entries()) {
      const facts = joined.unit.sections![index]!.facts!
      const text = facts.find((segment) => segment.kind === "text")!.text
      await visible(
        within(row).getByText(text.trim().slice(0, 40), { exact: false })
      )
      await expect(within(row).queryByRole("listitem")).toBeNull()
    }
  },
}

/**
 * Explained: each change's own Before beside its After, its links folded
 * into one line under them; the terms once, after the rows. No second card
 * says it again.
 */
export const JoinedExplained: Story = {
  args: deskAt(joined, { stop: "explained" }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const found = await rows(canvasElement)
    for (const [index, row] of found.entries()) {
      const explained = joined.unit.sections![index]!.explained!
      await visible(within(row).getByText(explained.after))
      await expect(within(row).getByText(explained.before)).toBeVisible()
      await expect(within(row).getAllByRole("link").length).toBeGreaterThan(0)
    }
    const terms = new Set(
      joined.unit.sections!.flatMap((section) =>
        section.explained!.terms.map((term) => term.term)
      )
    )
    await expect(canvas.getAllByRole("term")).toHaveLength(terms.size)
    await expect(
      canvas.queryByRole("region", { name: "How it changes" })
    ).toBeNull()
  },
}

/**
 * Guided: the claims, then the check and the suggested review as before. The
 * check against the ticket says what each item lacks, so the briefing lists
 * no checkpoints (10.140).
 */
export const JoinedGuided: Story = {
  args: deskAt(joined, { stop: "guided" }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await rows(canvasElement)
    await visible(
      canvas.getByRole("region", {
        name: checkHeading(joined.delivery!.check!),
      })
    )
    await expect(canvas.queryByRole("list", { name: "Checkpoints" })).toBeNull()
  },
}

/** A unit with one change: no rows, its claims one per line. */
export const Single: Story = {
  args: deskAt(single, { stop: "briefed" }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.queryByRole("region", { name: titles[0] })).toBeNull()
    await visible(
      canvas.getByRole("heading", { level: 1, name: single.unit.title })
    )
  },
}

/** A unit with one change at Explained: its labels over each paragraph. */
export const SingleExplained: Story = {
  args: deskAt(single, { stop: "explained" }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await visible(canvas.getByText(single.delivery!.explained!.before))
    await expect(canvas.getByText("Before")).toBeVisible()
    await expect(canvas.getByText("After")).toBeVisible()
  },
}

/** At phone width the rows stack: each title over its claims. */
export const JoinedPhone: Story = {
  args: deskAt(joined, { stop: "briefed", rail: "collapsed" }),
  globals: { viewport: { value: "phone", isRotated: false } },
  play: async ({ canvasElement }) => {
    const [first] = await rows(canvasElement)
    const heading = within(first!).getByRole("heading", { level: 2 })
    const claims = within(first!).getByRole("list")
    // Stacked: the claims start under the title, not beside it.
    await expect(claims.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      heading.getBoundingClientRect().bottom - 1
    )
  },
}

/** Explained at phone width: Before over After, each labelled. */
export const JoinedExplainedPhone: Story = {
  args: deskAt(joined, { stop: "explained", rail: "collapsed" }),
  globals: { viewport: { value: "phone", isRotated: false } },
}
