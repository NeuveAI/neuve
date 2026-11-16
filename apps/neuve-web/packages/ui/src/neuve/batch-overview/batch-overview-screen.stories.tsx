import type { Decorator, Meta, StoryObj } from "@storybook/react-vite"
import { atom, createStore, useAtomValue, useSetAtom } from "jotai"
import { useMemo } from "react"
import type * as React from "react"
import {
  expect,
  fireEvent,
  fn,
  userEvent,
  waitFor,
  within,
} from "storybook/test"

import {
  batchOverviewFixture,
  multiBatchOverviewFixture,
  reviewBatchesFixture,
} from "@workspace/ui/fixtures/review-batch.fixtures"
import {
  agentChangesOnlyOverviewFixture,
  agentChangesOverviewFixture,
  allApprovedOverviewFixture,
  allDecidedOverviewFixture,
  oneRequestedOverviewFixture,
  branchMovedRunningFixture,
  branchMovedStartFixture,
  someDecidedOverviewFixture,
  waitingOverviewFixture,
} from "@workspace/ui/fixtures/decided-overview.fixtures"
import { liveLaneOverviewFixture } from "@workspace/ui/fixtures/shell.fixtures"
import {
  EXPIRED_UNIT_ID,
  EXPIRY_PATH,
  NEWER_BATCH_ID,
  SCENARIO_UNITS,
} from "@workspace/ui/fixtures/lanes-scenario.fixtures"
import {
  linkExpiryArrivedOverviewFixture,
  linkExpiryCarriedChangesOverviewFixture,
  linkExpiryCarriedOverviewFixture,
  linkExpiryLockfileOverviewFixture,
  linkExpiryLongLinesOverviewFixture,
  linkExpiryLimitationsOverviewFixture,
  linkExpiryOverviewFixture,
  linkExpiryReplacedOverviewFixture,
  linkExpiryStaticOverviewFixture,
  linkExpiryStoppedOverviewFixture,
  linkExpiryWholeOverviewFixture,
} from "@workspace/ui/fixtures/lanes-overview.fixtures"
import { BatchOverviewScreen } from "@workspace/ui/neuve/batch-overview/batch-overview-screen"
import { NewerReviewProvider } from "@workspace/ui/neuve/shared/app-header"
import { BatchArrivalsStore } from "@workspace/ui/neuve/shared/batch-arrivals"
import { withStory } from "@workspace/ui/neuve/story-kit/store"
import { frames, visible } from "@workspace/ui/neuve/story-kit/play"

/**
 * Arrivals a review's screens share live in a store the screens share (the
 * app's default jotai store); each story gets its own, so one story's
 * arrivals never reach another's.
 */
function OwnArrivals({ children }: { children: React.ReactNode }) {
  const store = useMemo(() => createStore(), [])
  return <BatchArrivalsStore store={store}>{children}</BatchArrivalsStore>
}
const ownArrivals: Decorator = (Story) => (
  <OwnArrivals>
    <Story />
  </OwnArrivals>
)

/** Batch overview screen (Overview.dc.html). */
const meta = {
  title: "Screens/Batch overview",
  component: BatchOverviewScreen,
  decorators: [ownArrivals],
  args: { data: batchOverviewFixture },
  parameters: {
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
} satisfies Meta<typeof BatchOverviewScreen>

export default meta
type Story = StoryObj<typeof meta>

export const Rest: Story = {}
export const RestDark: Story = {
  globals: { theme: "dark" },
}
export const SuggestedLane: Story = {
  args: { initialState: { activeLane: "human-suggested" } },
}
export const StaticAutomationLane: Story = {
  args: { initialState: { activeLane: "static-automation" } },
}
/** The same header and Agents control as the desk, popover open. */
export const AgentsOpen: Story = {
  args: { agentsOpen: true },
}

/** The four human-required units, as the decision panel's squares name them. */
const squares = (canvas: ReturnType<typeof within>) =>
  within(canvas.getByRole("list", { name: "Human-required units" }))

/**
 * Nothing decided: the panel counts what needs you and starts the review;
 * the lane bar shows the split; every unit sits under its lane, the ones
 * that need you open.
 */
export const Waiting: Story = {
  args: { data: waitingOverviewFixture },
  play: async ({ canvas }) => {
    const data = waitingOverviewFixture
    const panel = canvas.getByRole("region", { name: "Your decisions" })
    await waitFor(() => expect(panel).toBeVisible(), { timeout: 3000 })
    await expect(panel).toHaveTextContent("4 need your decision")
    for (const unit of data.judgment)
      await expect(
        squares(canvas).getByRole("link", {
          name: `${unit.title}, waiting on you`,
        })
      ).toHaveAttribute("href", expect.stringContaining(unit.id))
    await expect(
      within(panel).getByRole("link", { name: "Start review" })
    ).toBeVisible()
    await expect(
      canvas.getByRole("list", { name: "Review lanes" })
    ).toBeVisible()
    const table = canvas.getByRole("table", {
      name: "Units that need your decision",
    })
    await expect(table).toBeVisible()
    await expect(canvas.queryByText("Decided")).toBeNull()
    // The other lanes are listed, closed.
    for (const lane of [
      "Human-suggested",
      "Agentic review",
      "Static automation",
    ])
      await expect(
        canvas.getByRole("heading", { name: lane, level: 3 })
      ).toBeVisible()
    await expect(canvas.getByText("Link cache eviction")).not.toBeVisible()
  },
}
export const WaitingDark: Story = {
  args: { data: waitingOverviewFixture },
  globals: { theme: "dark" },
}

/**
 * Each row counts its unit's unmet checkpoints; nothing expands, and the
 * whole row opens the unit, where the checkpoints are listed.
 */
export const RowCountsCheckpoints: Story = {
  args: { data: waitingOverviewFixture },
  play: async ({ canvas, canvasElement }) => {
    const unit = waitingOverviewFixture.judgment[0]!
    const link = canvas.getByRole("link", { name: unit.title })
    await waitFor(() => expect(link).toBeVisible(), { timeout: 3000 })
    const row = link.closest<HTMLElement>('[role="row"]')!
    await expect(row).toHaveTextContent("4 unmet checkpoints")
    await expect(link).toHaveAttribute("href", expect.stringContaining(unit.id))
    await expect(
      canvasElement.querySelector("[aria-expanded][aria-controls]")
    ).toBeNull()
    await expect(
      canvas.queryByRole("region", { name: "Verification" })
    ).toBeNull()
  },
}

/**
 * Some units decided: the panel counts what still needs you and continues
 * the review; its squares show the verdicts; "Needs your decision" holds only
 * the waiting units and the decided ones sit in the closed "Decided" group.
 */
export const SomeDecided: Story = {
  args: { data: someDecidedOverviewFixture },
  play: async ({ canvas }) => {
    const data = someDecidedOverviewFixture
    const panel = canvas.getByRole("region", { name: "Your decisions" })
    await waitFor(() => expect(panel).toBeVisible(), { timeout: 3000 })
    await expect(panel).toHaveTextContent("2 of 4 still need you")
    await expect(
      squares(canvas).getByRole("link", {
        name: `${data.decided![0]!.title}, changes requested`,
      })
    ).toBeVisible()
    await expect(
      squares(canvas).getByRole("link", {
        name: `${data.decided![1]!.title}, approved`,
      })
    ).toBeVisible()
    await expect(
      within(panel).getByRole("link", { name: "Continue review" })
    ).toBeVisible()
    const table = canvas.getByRole("table", {
      name: "Units that need your decision",
    })
    for (const unit of data.judgment)
      await expect(
        within(table).getByRole("link", { name: unit.title })
      ).toBeVisible()
    for (const unit of data.decided!)
      await expect(within(table).queryByText(unit.title)).toBeNull()
    // The lane keeps its own count; the phrase counts only what still waits.
    const required = canvas
      .getByRole("list", { name: "Review lanes" })
      .querySelector("li")!
    await expect(required).toHaveTextContent(
      /^Human-required\s*4\s*2 waiting on you$/
    )
    // Closed by default: the titles are in the page, not shown.
    const decided = canvas.getByRole("heading", { name: "Decided" })
    const row = canvas.getByRole("link", { name: data.decided![0]!.title })
    await expect(row).not.toBeVisible()
    await userEvent.click(decided)
    await waitFor(() => expect(row).toBeVisible())
    await expect(row.closest("div")).toHaveTextContent(/You requested changes/)
  },
}

/**
 * Every unit approved: the panel is the outcome, its action turns light, the
 * lane split moves into its foot, the briefing folds and "Decided" opens.
 */
export const AllApproved: Story = {
  args: { data: allApprovedOverviewFixture },
  play: async ({ canvas }) => {
    const data = allApprovedOverviewFixture
    const panel = canvas.getByRole("region", { name: "Your decisions" })
    await waitFor(() => expect(panel).toBeVisible(), { timeout: 3000 })
    await expect(panel).toHaveTextContent("All 4 approved")
    const next = within(panel).getByRole("link", { name: "Open review desk" })
    await expect(next).toHaveAttribute(
      "href",
      expect.stringContaining(data.firstUnitId)
    )
    await expect(
      canvas.queryByRole("list", { name: "Review lanes" })
    ).toBeNull()
    await expect(
      within(panel).getByRole("list", { name: "Units by review lane" })
    ).toHaveTextContent(/Human-required\s*4/)
    await expect(canvas.queryByText(/waiting on you|need you/)).toBeNull()
    // The briefing is folded: its words are in the page, not shown.
    await expect(canvas.getByText(data.briefing)).not.toBeVisible()
    await expect(
      canvas.queryByRole("table", { name: "Units that need your decision" })
    ).toBeNull()
    for (const unit of data.decided!)
      await waitFor(() =>
        expect(canvas.getByRole("link", { name: unit.title })).toBeVisible()
      )
  },
}

/**
 * Every unit decided, two with changes requested: the outcome says both, and
 * each decided row shows who decided what.
 */
export const AllDecided: Story = {
  args: { data: allDecidedOverviewFixture },
  play: async ({ canvas }) => {
    const panel = canvas.getByRole("region", { name: "Your decisions" })
    await waitFor(() => expect(panel).toBeVisible(), { timeout: 3000 })
    await expect(panel).toHaveTextContent(
      /2 changes requested\s*·\s*2 approved/
    )
    await waitFor(() =>
      expect(canvas.getByText("Ana Lima", { exact: false })).toBeVisible()
    )
  },
}
/**
 * Every human-required unit approved, but two agents requested changes on
 * a unit each no person decided: the panel names them, each opening its unit,
 * never the all-approved outcome; they still show in their lanes.
 */
export const AgentRequestedChanges: Story = {
  args: { data: agentChangesOverviewFixture },
  play: async ({ canvas }) => {
    const data = agentChangesOverviewFixture
    const named = data.agentChanges!
    const panel = canvas.getByRole("region", { name: "Your decisions" })
    await waitFor(() => expect(panel).toBeVisible(), { timeout: 3000 })
    // Two different agents: R1 and R2.
    await expect(panel).toHaveTextContent("Agents requested changes on 2 units")
    await expect(panel).not.toHaveTextContent(/approved|Nothing here/)
    const list = within(panel).getByRole("list", {
      name: "Units an agent requested changes on",
    })
    for (const unit of named) {
      const link = within(list).getByRole("link", {
        name: `${unit.title}, changes requested by an agent`,
      })
      await expect(link).toHaveAttribute(
        "href",
        expect.stringContaining(unit.id)
      )
      // Still in its lane, as before: closed by default, shown once opened.
      const row = canvas.getByRole("link", { name: unit.title })
      await expect(row).not.toBeVisible()
      await userEvent.click(
        row.closest("details")!.querySelector(":scope > summary")!
      )
      await waitFor(() => expect(row).toBeVisible())
    }
    await expect(
      within(panel).getByRole("link", { name: "Open review desk" })
    ).toHaveAttribute("href", expect.stringContaining(named[0]!.id))
  },
}
export const AgentRequestedChangesDark: Story = {
  args: { data: agentChangesOverviewFixture },
  globals: { theme: "dark" },
}

/**
 * No human-required unit, and the agent requested changes on a
 * human-suggested one (the clean-account run): never "Nothing here needs
 * your decision".
 */
export const AgentRequestedChangesOnly: Story = {
  args: { data: agentChangesOnlyOverviewFixture },
  play: async ({ canvas }) => {
    const unit = agentChangesOnlyOverviewFixture.agentChanges![0]!
    const panel = canvas.getByRole("region", { name: "Your decisions" })
    await waitFor(() => expect(panel).toBeVisible(), { timeout: 3000 })
    await expect(panel).toHaveTextContent(
      "An agent requested changes on 1 unit"
    )
    await expect(panel).not.toHaveTextContent("Nothing here")
    await expect(
      within(panel).getByRole("link", {
        name: `${unit.title}, changes requested by an agent`,
      })
    ).toHaveAttribute("href", expect.stringContaining(unit.id))
  },
}

export const AllDecidedDark: Story = {
  args: { data: allDecidedOverviewFixture },
  globals: { theme: "dark" },
}

/**
 * Every unit decided, one with changes requested: the count is singular,
 * "1 change requested", on the panel and in what it says to a screen reader.
 */
export const OneChangeRequested: Story = {
  args: { data: oneRequestedOverviewFixture },
  play: async ({ canvas }) => {
    const panel = canvas.getByRole("region", { name: "Your decisions" })
    await waitFor(() => expect(panel).toBeVisible(), { timeout: 3000 })
    await expect(panel).toHaveTextContent(/1 change requested\s*·\s*3 approved/)
    await expect(panel).not.toHaveTextContent(/changes requested/)
  },
}
export const OneChangeRequestedDark: Story = {
  ...OneChangeRequested,
  globals: { theme: "dark" },
}
export const OneChangeRequestedPhone: Story = {
  ...OneChangeRequested,
  globals: { viewport: { value: "phone390", isRotated: false } },
}

/** Phone width: rows wrap their review and count under the title, no sideways scroll. */
export const AllDecidedPhone: Story = {
  args: { data: allDecidedOverviewFixture },
  globals: { viewport: { value: "phone375", isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    const unit = allDecidedOverviewFixture.decided![0]!
    const link = canvas.getByRole("link", { name: unit.title })
    await waitFor(() => expect(link).toBeVisible(), { timeout: 3000 })
    const doc = canvasElement.ownerDocument.documentElement
    await expect(doc.scrollWidth).toBeLessThanOrEqual(doc.clientWidth)
  },
}

/** Phone width with units waiting: the checkpoint count stays under the title. */
export const WaitingPhone: Story = {
  args: { data: waitingOverviewFixture },
  globals: { viewport: { value: "phone375", isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    const unit = waitingOverviewFixture.judgment[0]!
    const link = canvas.getByRole("link", { name: unit.title })
    await waitFor(() => expect(link).toBeVisible(), { timeout: 3000 })
    const count = within(link.closest<HTMLElement>('[role="row"]')!).getByText(
      /^4 unmet/
    )
    await expect(count).toBeVisible()
    await expect(count.getBoundingClientRect().top).toBeGreaterThan(
      link.getBoundingClientRect().top
    )
    const doc = canvasElement.ownerDocument.documentElement
    await expect(doc.scrollWidth).toBeLessThanOrEqual(doc.clientWidth)
  },
}

/**
 * The agents' lanes list their units with the agent's review and how many
 * of their checkpoints are unmet.
 */
export const AgentLanes: Story = {
  args: { data: someDecidedOverviewFixture },
  play: async ({ canvas }) => {
    const lane = canvas.getByRole("heading", { name: "Agentic review" })
    await waitFor(() => expect(lane).toBeVisible(), { timeout: 3000 })
    await userEvent.click(lane)
    const row = canvas.getByRole("link", {
      name: "Session invalidation by link",
    })
    await waitFor(() => expect(row).toBeVisible())
    const line = row.closest("div")!
    await expect(line).toHaveTextContent(/R2\s*requested changes/)
    await expect(line).toHaveTextContent("5 unmet checkpoints")
  },
}

/**
 * The branch moved past the reviewed head: the next review is the strong
 * action, on top; the decisions stay as they were.
 */
export const BranchMoved: Story = {
  args: {
    data: allDecidedOverviewFixture,
    start: branchMovedStartFixture,
    onStartReview: fn(),
  },
  play: async ({ canvas, args }) => {
    const notice = await canvas.findByText(/since this review/)
    await waitFor(() => expect(notice).toBeVisible(), { timeout: 3000 })
    await expect(notice.closest("div")).toHaveTextContent(
      /New work on shr-212-revoke-links since this review/
    )
    await expect(canvas.getByText("a3f9c2e → 9c41d07")).toBeVisible()
    await userEvent.click(
      canvas.getByRole("button", { name: "Start a review" })
    )
    await expect(args.onStartReview).toHaveBeenCalledOnce()
    await expect(
      canvas.getByRole("link", { name: "Open review desk" })
    ).toBeVisible()
  },
}

/** The review of the moved branch runs: the notice says so, with no button. */
export const BranchMovedRunning: Story = {
  args: { data: allDecidedOverviewFixture, start: branchMovedRunningFixture },
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole("status")).toHaveTextContent(
      "Reviewing shr-212-revoke-links"
    )
    await expect(
      canvas.queryByRole("button", { name: "Start a review" })
    ).toBeNull()
  },
}

/** The branch still points at the reviewed head: no notice. */
export const BranchUnmoved: Story = {
  args: {
    data: allDecidedOverviewFixture,
    start: {
      status: "ready",
      preview: {
        ...(branchMovedStartFixture.status === "ready"
          ? branchMovedStartFixture.preview
          : ({} as never)),
        headOid: allDecidedOverviewFixture.revision,
      },
    },
    onStartReview: fn(),
  },
  play: async ({ canvas }) => {
    await waitFor(
      () =>
        expect(
          canvas.getByRole("region", { name: "Your decisions" })
        ).toBeVisible(),
      { timeout: 3000 }
    )
    await expect(canvas.queryByText(/since this review/)).toBeNull()
  },
}

const briefing = liveLaneOverviewFixture.contextualBriefing!
const graphChip = briefing.segments.find(
  (segment) =>
    segment.kind === "cite" && segment.ariaLabel === "Graph, Revoke callers"
)

/**
 * A briefing chip opens its source in the sheet; the overview has no diff,
 * so the sheet is where a citation lands. Closing it, with Escape or "Back
 * to briefing", returns focus to the chip.
 */
export const BriefingChipOpensSource: Story = {
  args: { data: liveLaneOverviewFixture },
  play: async ({ canvas, canvasElement }) => {
    if (graphChip?.kind !== "cite") throw new Error("No Graph chip in fixture")
    const doc = canvasElement.ownerDocument
    const title = briefing.markers[graphChip.markerKey]!.source.title
    const chip = canvas.getByRole("button", { name: "Graph, Revoke callers" })
    const closed = () =>
      waitFor(() => expect(canvas.queryByRole("dialog")).toBeNull())

    await userEvent.click(chip)
    await canvas.findByRole("dialog", { name: title })
    await userEvent.click(
      canvas.getByRole("button", { name: "Back to briefing" })
    )
    await closed()

    // Keyboard: open with Enter, close with Escape.
    chip.focus()
    await userEvent.keyboard("{Enter}")
    await canvas.findByRole("dialog", { name: title })
    await userEvent.keyboard("{Escape}")
    await closed()
    await waitFor(() => expect(doc.activeElement).toBe(chip))

    // Keyboard: open with Enter, close with "Back to briefing".
    await userEvent.keyboard("{Enter}")
    await canvas.findByRole("dialog", { name: title })
    canvas.getByRole("button", { name: "Back to briefing" }).focus()
    await userEvent.keyboard("{Enter}")
    await closed()
    await waitFor(() => expect(doc.activeElement).toBe(chip))
  },
}

/**
 * A review split into three batches: the header's batch menu names the one
 * on screen and lists all three, each opening its overview, with what still
 * needs you; each opens at its own address. Escape closes it and returns focus.
 */
export const SeveralBatches: Story = {
  args: { data: multiBatchOverviewFixture },
  play: async ({ canvas, canvasElement }) => {
    const doc = canvasElement.ownerDocument
    const trigger = canvas.getByRole("button", {
      name: /^Revoked share links stop working immediately\s*, batch 1 of 3$/,
    })
    await waitFor(() => expect(trigger).toBeVisible(), { timeout: 3000 })
    await userEvent.click(trigger)
    const menu = await within(doc.body).findByRole("menu", {
      name: /batch 1 of 3/,
    })
    const items = within(menu).getAllByRole("menuitem")
    await expect(items).toHaveLength(3)
    await expect(items[0]).toHaveAttribute("aria-current", "page")
    await expect(items[1]).toHaveTextContent("1 needs you · 4 units")
    // Every batch has its own address: `/` is the Reviews page.
    reviewBatchesFixture.all.forEach((batch, i) =>
      expect(items[i]).toHaveAttribute("href", `/batch/${batch.id}`)
    )
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(within(doc.body).queryByRole("menu")).toBeNull())
    await expect(trigger).toHaveFocus()
  },
}
export const SeveralBatchesMenuOpen: Story = {
  args: { data: multiBatchOverviewFixture },
  play: async ({ canvas }) => {
    const trigger = canvas.getByRole("button", { name: /batch 1 of 3/ })
    await waitFor(() => expect(trigger).toBeVisible(), { timeout: 3000 })
    await userEvent.click(trigger)
  },
}
export const SeveralBatchesDark: Story = {
  ...SeveralBatchesMenuOpen,
  globals: { theme: "dark" },
}
/** Phone width: the batch title truncates in the header; no sideways scroll. */
export const SeveralBatchesPhone: Story = {
  ...SeveralBatchesMenuOpen,
  globals: { viewport: { value: "phone375", isRotated: false } },
  play: async (context) => {
    await SeveralBatchesMenuOpen.play!(context)
    const doc = context.canvasElement.ownerDocument.documentElement
    await expect(doc.scrollWidth).toBeLessThanOrEqual(doc.clientWidth)
  },
}

/* ── Real review lanes (NEU-148): one review of acme/docs-app in three
 * batches, the first published (fixtures/lanes-overview.fixtures.ts). ── */

/** The lane bar's legend item for a lane. */
const legendItem = (canvas: ReturnType<typeof within>, name: string) =>
  within(canvas.getByRole("list", { name: "Review lanes" }))
    .getAllByRole("listitem")
    .find((item) => item.textContent.startsWith(name))!

/**
 * The first batch: three lanes hold its nine units; static automation has
 * none, so the bar keeps its stub, the legend a muted 0, and the unit list
 * leaves the lane out.
 */
export const ExpiryLanes: Story = {
  args: { data: linkExpiryOverviewFixture },
  play: async ({ canvas }) => {
    await visible(canvas.getByRole("list", { name: "Review lanes" }))
    await expect(
      canvas.getByRole("region", { name: "Review units by review lane" })
    ).toBeVisible()
    await expect(legendItem(canvas, "Static automation")).toHaveTextContent(
      /^Static automation\s*0$/
    )
    await expect(legendItem(canvas, "Agentic review")).toHaveTextContent(
      /^Agentic review\s*4$/
    )
    for (const lane of ["Human-suggested", "Agentic review"])
      await expect(
        canvas.getByRole("heading", { name: lane, level: 3 })
      ).toBeVisible()
    await expect(
      canvas.queryByRole("heading", { name: "Static automation", level: 3 })
    ).toBeNull()
  },
}

/** The variant with one static-automation unit: all four lanes hold units. */
export const ExpiryLanesWithStatic: Story = {
  args: { data: linkExpiryStaticOverviewFixture },
  play: async ({ canvas }) => {
    await visible(canvas.getByRole("list", { name: "Review lanes" }))
    await expect(legendItem(canvas, "Static automation")).toHaveTextContent(
      /^Static automation\s*1$/
    )
    const lane = canvas.getByRole("heading", {
      name: "Static automation",
      level: 3,
    })
    await userEvent.click(lane)
    await visible(canvas.getByRole("link", { name: "Regenerated API client" }))
  },
}

/**
 * A unit no agent decided: no written title, so its row reads as its file,
 * the lines it owns and the folder, with the full title as its name, and one
 * plain line under it. Its square in the decision panel is like the others.
 */
export const ExpiryNoAgentDecision: Story = {
  args: { data: linkExpiryOverviewFixture },
  play: async ({ canvas }) => {
    const table = canvas.getByRole("table", {
      name: "Units that need your decision",
    })
    const link = within(table).getByRole("link", {
      name: "Changes to src/sharing/schedule.ts",
    })
    await visible(link)
    await expect(link).toHaveTextContent(/schedule\.ts\s*L12–48, L71–90/)
    const row = link.closest<HTMLElement>('[role="row"]')!
    await expect(
      within(row).getByText("No agent decision in this run")
    ).toBeVisible()
    await expect(
      squares(canvas).getByRole("link", {
        name: "Changes to src/sharing/schedule.ts, waiting on you",
      })
    ).toBeVisible()
  },
}

/**
 * The review is still running: the hero's meta row ends with the batches
 * still being reviewed. It is not a live region; the header announces.
 */
export const ExpiryReviewing: Story = {
  args: { data: linkExpiryOverviewFixture },
  play: async ({ canvas }) => {
    const item = shownText(canvas, "Reviewing 2 more batches")
    await visible(item)
    // Its text, its item, its held cell, then the meta row.
    const cell = item.closest(".inline-grid")!
    await expect(cell.parentElement!.lastElementChild).toBe(cell)
    await expect(item.closest('[role="status"], [aria-live]')).toBeNull()
  },
}

/**
 * The review stopped with two batches unpublished and no run going: the
 * same last item says so, still, with no spinner.
 */
export const ExpiryStopped: Story = {
  args: { data: linkExpiryStoppedOverviewFixture },
  play: async ({ canvas }) => {
    const item = shownText(canvas, "2 batches not reviewed")
    await visible(item)
    await expect(item.querySelector("svg")).toBeNull()
    await expect(canvas.queryByText(/^Reviewing/)).toBeNull()
  },
}

/** How many batches the story's own chrome has published, 1 to 3. */
const publishedAtom = atom(1)
/** Each new value is a new screen of the review (another unit, then back). */
const screenAtom = atom(0)

const PUBLISHED = [
  linkExpiryOverviewFixture,
  linkExpiryArrivedOverviewFixture,
  linkExpiryWholeOverviewFixture,
]

const CHROME_BUTTON =
  "h-8 rounded-lg border-0 bg-ink px-3 font-sans text-[12.5px] text-paper"

/**
 * The overview while the review runs, with the story's own chrome: one
 * button publishes the next batch, as a data reload would bring it; the
 * other opens the screen again, as leaving for a unit and coming back does.
 */
function ArrivingBatch() {
  const published = useAtomValue(publishedAtom)
  const publish = useSetAtom(publishedAtom)
  const screen = useAtomValue(screenAtom)
  const reopen = useSetAtom(screenAtom)
  return (
    <>
      <BatchOverviewScreen key={screen} data={PUBLISHED[published - 1]!} />
      <span className="fixed right-4 bottom-4 z-50 flex gap-2">
        <button
          type="button"
          onClick={() => reopen((n) => n + 1)}
          className={CHROME_BUTTON}
        >
          Open the screen again
        </button>
        <button
          type="button"
          onClick={() => publish((n) => Math.min(n + 1, PUBLISHED.length))}
          className={CHROME_BUTTON}
        >
          Publish the next batch
        </button>
      </span>
    </>
  )
}

const arriving = {
  decorators: [withStory()],
  render: () => <ArrivingBatch />,
} satisfies Story

/**
 * A meta-row text as the reader sees it: the item keeps an invisible copy
 * of what it first said beside it, which is hidden from assistive tech.
 */
function shownText(canvas: ReturnType<typeof within>, text: string) {
  return canvas
    .getAllByText(text)
    .find((element: HTMLElement) => !element.closest('[aria-hidden="true"]'))!
}

const publish = (canvas: ReturnType<typeof within>) =>
  userEvent.click(
    canvas.getByRole("button", { name: "Publish the next batch" })
  )

const publishNext = async (canvas: ReturnType<typeof within>) => {
  await visible(shownText(canvas, "Reviewing 2 more batches"))
  await publish(canvas)
  return canvas.findByRole("button", { name: /batch 1 of 3, 1 new$/ })
}

/**
 * Batch 1 with two still being reviewed: the batch menu is already there,
 * listing the one published batch, so nothing moves when the next arrives.
 */
export const ExpiryBeforeArrival: Story = {
  ...arriving,
  play: async ({ canvas }) => {
    await visible(shownText(canvas, "Reviewing 2 more batches"))
    await expect(
      canvas.getByRole("button", { name: /batch 1 of 3$/ })
    ).toBeVisible()
  },
}

/** The second batch arrived: a dot on the menu's trigger; one batch to go. */
export const ExpiryArrived: Story = {
  ...arriving,
  play: async ({ canvas }) => {
    const trigger = await publishNext(canvas)
    await expect(shownText(canvas, "Reviewing 1 more batch")).toBeVisible()
    // The dot sits out of flow: the trigger keeps its size.
    await expect(trigger.querySelector(".absolute")).toBeTruthy()
  },
}

/** The menu open after the arrival: the new batch reads "New"; the dot goes. */
export const ExpiryArrivedMenuOpen: Story = {
  ...arriving,
  play: async ({ canvas, canvasElement }) => {
    const trigger = await publishNext(canvas)
    const width = trigger.getBoundingClientRect().width
    await userEvent.click(trigger)
    const menu = await within(canvasElement.ownerDocument.body).findByRole(
      "menu"
    )
    const items = within(menu).getAllByRole("menuitem")
    await expect(items[0]).not.toHaveTextContent("New")
    await expect(items[1]).toHaveTextContent(
      /Expiry reminders by email\s*New · 1 needs you · 5 units/
    )
    await expect(trigger).toHaveAccessibleName(/batch 1 of 3$/)
    await expect(trigger.getBoundingClientRect().width).toBe(width)
  },
}

/**
 * The arrival is announced once, politely, by a region that was in the page
 * before it; focus and the scroll position stay where the reader left them.
 */
export const ExpiryArrivalAnnounced: Story = {
  ...arriving,
  play: async ({ canvas, canvasElement }) => {
    const doc = canvasElement.ownerDocument
    const win = doc.defaultView!
    await visible(shownText(canvas, "Reviewing 2 more batches"))
    const region = canvas.getByRole("status")
    await expect(region).toBeEmptyDOMElement()
    win.scrollTo(0, 240)
    await waitFor(() => expect(win.scrollY).toBeGreaterThan(0))
    const button = canvas.getByRole("button", {
      name: "Publish the next batch",
    })
    button.focus()
    const focused = doc.activeElement
    const scrolled = win.scrollY
    const heading = canvas.getByRole("heading", { level: 1 })
    const top = heading.getBoundingClientRect().top
    await userEvent.click(button)
    await waitFor(() =>
      expect(region).toHaveTextContent(/^New batch: Expiry reminders by email$/)
    )
    await expect(canvas.getByRole("status")).toBe(region)
    await expect(shownText(canvas, "Reviewing 1 more batch")).toBeVisible()
    await expect(doc.activeElement).toBe(focused)
    await expect(win.scrollY).toBe(scrolled)
    // Nothing above the title grew: the batch menu was already there.
    await expect(heading.getBoundingClientRect().top).toBe(top)
  },
}

/** The same at phone width, where the batch menu has a line of its own. */
export const ExpiryArrivalAnnouncedPhone: Story = {
  ...ExpiryArrivalAnnounced,
  globals: { viewport: { value: "phone375", isRotated: false } },
}

/**
 * The arrival outlives the screen: the reader leaves for a unit and comes
 * back (a new screen, with a store of its own). The dot is still there until
 * the menu is opened, nothing is announced again, the open menu marks the
 * batch "New", and the next time it opens no row is new.
 */
export const ExpiryArrivalOutlivesTheScreen: Story = {
  ...arriving,
  play: async ({ canvas, canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    const reopen = () =>
      userEvent.click(
        canvas.getByRole("button", { name: "Open the screen again" })
      )
    const firstScreen = canvas.getByRole("heading", { level: 1 })
    await publishNext(canvas)
    await reopen()
    await waitFor(() =>
      expect(canvas.getByRole("heading", { level: 1 })).not.toBe(firstScreen)
    )
    // A new screen: the dot is kept, and nothing is said again.
    const trigger = canvas.getByRole("button", { name: /batch 1 of 3, 1 new$/ })
    await expect(canvas.getByRole("status")).toBeEmptyDOMElement()
    await userEvent.click(trigger)
    const menu = await body.findByRole("menu")
    await expect(within(menu).getAllByRole("menuitem")[1]).toHaveTextContent(
      /New · /
    )
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(body.queryByRole("menu")).toBeNull())
    await expect(trigger).toHaveAccessibleName(/batch 1 of 3$/)
    // Another screen: no dot; the menu's rows are no longer new.
    await reopen()
    const again = await canvas.findByRole("button", { name: /batch 1 of 3$/ })
    await userEvent.click(again)
    const next = await body.findByRole("menu")
    for (const row of within(next).getAllByRole("menuitem"))
      await expect(row).not.toHaveTextContent("New")
  },
}

/** Resolves once fonts are in and `measure` holds still for a few frames. */
async function settled(measure: () => number) {
  await document.fonts.ready
  let last = Number.NaN
  for (let steady = 0; steady < 4;) {
    await frames(1)
    const now = measure()
    steady = now === last ? steady + 1 : 0
    last = now
  }
}

/**
 * The meta row holds its height while the batches arrive, at every width:
 * the item keeps the width of what it first said ("2 more batches"), and an
 * empty box once the last batch is in, so what is below never moves. The
 * play measures the decision panel's top before, after "2" to "1" and after
 * the last batch (run it at 360, 430, 600, 700 and 1440 wide).
 */
export const ExpiryMetaRowHolds: Story = {
  ...arriving,
  play: async ({ canvas, canvasElement }) => {
    const win = canvasElement.ownerDocument.defaultView!
    const panel = canvas.getByRole("region", { name: "Your decisions" })
    await visible(panel)
    const top = () => panel.getBoundingClientRect().top + win.scrollY
    await settled(top)
    const tops = [top()]
    await publish(canvas)
    await visible(shownText(canvas, "Reviewing 1 more batch"))
    tops.push(top())
    await publish(canvas)
    await canvas.findByRole("button", { name: /batch 1 of 3, 2 new$/ })
    await waitFor(() =>
      expect(
        canvas
          .queryAllByText(/^Reviewing/)
          .filter((element) => !element.closest('[aria-hidden="true"]'))
      ).toHaveLength(0)
    )
    tops.push(top())
    console.info(`MEASURE width=${win.innerWidth} panel-tops=${tops.join(",")}`)
    await expect(tops[1]).toBe(tops[0])
    await expect(tops[2]).toBe(tops[0])
  },
}

/**
 * What the batch removes, disables or narrows comes first in the briefing,
 * drawn like the sections after it, its chip and unit link working.
 */
export const ExpiryRemovedFirst: Story = {
  args: { data: linkExpiryOverviewFixture },
  play: async ({ canvas }) => {
    const removed = canvas.getByRole("region", {
      name: "Removed, disabled or narrowed",
    })
    await visible(removed)
    const headings = canvas
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent)
    await expect(headings.slice(0, 3)).toEqual([
      "Removed, disabled or narrowed",
      "What changed",
      "What to check",
    ])
    await expect(
      within(removed).getByRole("link", { name: "ShareLink.neverExpires" })
    ).toHaveAttribute("href", expect.stringContaining(EXPIRED_UNIT_ID))
    await userEvent.click(
      within(removed).getByRole("button", { name: "Doc, Share link expiry" })
    )
    await canvas.findByRole("dialog", { name: "Share link expiry" })
  },
}

/**
 * Units whose review lane rose since the last run: a muted up arrow after
 * the title, named in full, in "Needs your decision" and in a lane group.
 * Pointing at it shows the same words.
 */
export const ExpiryMovedUp: Story = {
  args: { data: linkExpiryOverviewFixture },
  play: async ({ canvas, canvasElement }) => {
    const link = canvas.getByRole("link", {
      name: "Expired links refuse new sessions",
    })
    await visible(link)
    await expect(link).toHaveAccessibleDescription(
      "Moved up from Agentic review"
    )
    await userEvent.click(
      canvas.getByRole("heading", { name: "Human-suggested", level: 3 })
    )
    const raised = canvas.getByRole("link", {
      name: "Link list shows time left",
    })
    await visible(raised)
    await expect(raised).toHaveAccessibleDescription(
      "Moved up from Agentic review"
    )
    const [mark] = canvas.getAllByText("Moved up from Agentic review")
    await userEvent.hover(mark!.parentElement!)
    await waitFor(() =>
      expect(
        within(canvasElement.ownerDocument.body).getByRole("tooltip")
      ).toHaveTextContent("Moved up from Agentic review")
    )
  },
}

/**
 * One file, three units in three lanes, each with its own concern: the
 * overview lists them as any units, under their lanes.
 */
export const ExpiryOneFileThreeLanes: Story = {
  args: { data: linkExpiryOverviewFixture },
  play: async ({ canvas }) => {
    for (const lane of ["Human-suggested", "Agentic review"])
      await userEvent.click(
        canvas.getByRole("heading", { name: lane, level: 3 })
      )
    const titles = SCENARIO_UNITS.filter(
      (unit) => unit.path === EXPIRY_PATH
    ).map((unit) => unit.title)
    await expect(titles).toEqual([
      "Expired links refuse new sessions",
      "Expiry dates accept a time zone",
      "Rename the expiry constants",
    ])
    for (const title of titles)
      await visible(canvas.getByRole("link", { name: title }))
  },
}

/**
 * A batch with no digest whose limitations still arrive: "What changed" is
 * the plain briefing line, drawn as for a batch with no digest at all, and
 * the Limitations disclosure follows it.
 */
export const ExpiryLimitationsWithoutDigest: Story = {
  args: { data: linkExpiryLimitationsOverviewFixture },
  play: async ({ canvas }) => {
    const changed = canvas.getByRole("region", { name: "What changed" })
    await visible(changed)
    await expect(changed).toHaveTextContent(
      linkExpiryLimitationsOverviewFixture.briefing
    )
    await expect(
      canvas.queryByRole("region", { name: "What to check" })
    ).toBeNull()
    await expect(
      canvas.queryByRole("region", { name: "Removed, disabled or narrowed" })
    ).toBeNull()
    await expect(canvas.getByText("Limitations")).toBeVisible()
  },
}

/* ── Your earlier decision carried ───────────────────────── */

/**
 * Your approval of "Admins can extend an expired link" carried from the
 * branch's earlier review (its changes are all unchanged): two units need
 * your decision, and the admins unit is under "Decided" as your review,
 * with the carried mark.
 */
export const ExpiryCarriedDecision: Story = {
  args: { data: linkExpiryCarriedOverviewFixture },
  play: async ({ canvas }) => {
    const table = canvas.getByRole("table", {
      name: "Units that need your decision",
    })
    await visible(table)
    await expect(
      within(table).queryByText("Admins can extend an expired link")
    ).toBeNull()
    await expect(
      canvas.getByRole("region", { name: "Your decisions" })
    ).toHaveTextContent("2 of 3 still need you")
    // Under "Decided", as your review, marked carried; its square says so.
    await userEvent.click(canvas.getByRole("heading", { name: "Decided" }))
    await visible(canvas.getByText(/Carried ·/))
    await expect(
      squares(canvas).getByRole("link", {
        name: /^Admins can extend an expired link, /,
      })
    ).not.toHaveAccessibleName(/waiting on you/)
  },
}

export const ExpiryCarriedDecisionDark: Story = {
  ...ExpiryCarriedDecision,
  globals: { theme: "dark" },
}

/**
 * Your request for changes on "Expiry dates accept a time zone" carried
 * too: in the Human-suggested group its row shows your review, marked
 * carried, in place of the agent's approval. Nothing more needs you.
 */
export const ExpiryCarriedRequestForChanges: Story = {
  args: { data: linkExpiryCarriedChangesOverviewFixture },
  play: async ({ canvas }) => {
    await userEvent.click(
      await canvas.findByRole("heading", { name: "Human-suggested" })
    )
    const row = await waitFor(() =>
      canvas
        .getByRole("link", { name: /^Expiry dates accept a time zone/ })
        .closest<HTMLElement>("li")!
    )
    await expect(row).toHaveTextContent(/Carried · You requested changes/)
    await expect(
      canvas.getByRole("region", { name: "Your decisions" })
    ).toHaveTextContent("2 of 3 still need you")
  },
}

export const ExpiryCarriedRequestForChangesDark: Story = {
  ...ExpiryCarriedRequestForChanges,
  globals: { theme: "dark" },
}

/**
 * The batch also updated the lockfile: no agent read it. Its row in the
 * Human-suggested group says "Lockfile, not read", with the rule that
 * marked it on focus; the lanes say once "1 file not read". It
 * never needs your decision.
 */
export const ExpiryLockfileNotRead: Story = {
  args: { data: linkExpiryLockfileOverviewFixture },
  play: async ({ canvas }) => {
    const lanes = await canvas.findByRole("list", { name: "Review lanes" })
    await expect(lanes).toHaveTextContent("1 file not read")
    await expect(
      canvas.getByRole("region", { name: "Your decisions" })
    ).toHaveTextContent("3 need your decision")
    await userEvent.click(
      canvas.getByRole("heading", { name: "Human-suggested" })
    )
    const mark = await waitFor(() =>
      canvas.getByText("Lockfile, not read", { selector: "[data-not-read]" })
    )
    await expect(mark).toHaveTextContent("Lockfile, not read")
    // The rule is its tooltip, on keyboard focus as on hover.
    mark.focus()
    await expect(
      await within(document.body).findByRole("tooltip")
    ).toHaveTextContent("Marked a lockfile by its file name")
    await expect(
      canvas.queryByRole("link", {
        name: /^Changes to pnpm-lock\.yaml.*waiting/,
      })
    ).toBeNull()
  },
}

export const ExpiryLockfileNotReadDark: Story = {
  ...ExpiryLockfileNotRead,
  globals: { theme: "dark" },
}

/* ── A newer review replaced this one under the reader ───── */

/** Whether the newer review has landed (story chrome only). */
const replacedAtom = atom(false)
/** Reloads after it landed (story chrome only): each is a new data object. */
const reloadsAtom = atom(0)

/**
 * The overview with the story's own chrome: the newer review lands, as the
 * live reload brings it (`newer` on the same page's data), and the page
 * reloads again after, as the next record would.
 */
function ReplacedOverview() {
  const replaced = useAtomValue(replacedAtom)
  const replace = useSetAtom(replacedAtom)
  const reloads = useAtomValue(reloadsAtom)
  const reload = useSetAtom(reloadsAtom)
  const data = replaced
    ? // Each reload brings new data objects, as a real one does: the
      // batches too.
      {
        ...linkExpiryReplacedOverviewFixture,
        reloads,
        batches: {
          ...linkExpiryReplacedOverviewFixture.batches!,
          all: linkExpiryReplacedOverviewFixture.batches!.all.map((batch) => ({
            ...batch,
          })),
        },
      }
    : linkExpiryOverviewFixture
  return (
    <NewerReviewProvider newer={data.newer}>
      <BatchOverviewScreen data={data} />
      <span className="fixed right-4 bottom-4 z-50 flex gap-2">
        <button
          type="button"
          data-story-replace=""
          onClick={() => replace(true)}
          className={CHROME_BUTTON}
        >
          A newer review lands
        </button>
        <button
          type="button"
          data-story-reload=""
          onClick={() => reload((n) => n + 1)}
          className={CHROME_BUTTON}
        >
          Reload again
        </button>
      </span>
    </NewerReviewProvider>
  )
}

/**
 * A newer review of this work replaced this one while the reader was on
 * the overview: the header's live region says so once, and "Newer review"
 * goes to where the newer review starts. Focus, the scroll position and the
 * page below the header stay as they were (run it at 1440 and 390 wide).
 */
export const ExpiryReplacedUnderReader: Story = {
  decorators: [withStory()],
  render: () => <ReplacedOverview />,
  play: async ({ canvas, canvasElement }) => {
    const doc = canvasElement.ownerDocument
    const win = doc.defaultView!
    const main = canvasElement.querySelector("main")!
    await visible(canvas.getByRole("heading", { level: 1 }))
    const region = canvasElement.querySelector<HTMLElement>(
      "[data-batch-arrivals]"
    )!
    await expect(region).toBeEmptyDOMElement()
    await settled(() => main.getBoundingClientRect().top)
    win.scrollTo(0, 240)
    await waitFor(() => expect(win.scrollY).toBeGreaterThan(0))
    const row = canvas.getByRole("link", {
      name: /^Rename the expiry constants/,
    })
    row.focus()
    const before = {
      active: doc.activeElement,
      scroll: win.scrollY,
      main: main.getBoundingClientRect().top,
    }
    // Dispatched, as a reload is: nothing the reader did.
    fireEvent.click(canvasElement.querySelector("[data-story-replace]")!)
    await waitFor(() =>
      expect(region).toHaveTextContent(/^A newer review of this work is ready$/)
    )
    const link = canvas.getByRole("link", { name: "Newer review" })
    await expect(link).toHaveAttribute("href", `/batch/${NEWER_BATCH_ID}`)
    await frames(6)
    await expect(doc.activeElement).toBe(before.active)
    await expect(win.scrollY).toBe(before.scroll)
    await expect(main.getBoundingClientRect().top).toBe(before.main)
    // Said once: a later reload of the same page says nothing again.
    const said = region.firstElementChild
    fireEvent.click(canvasElement.querySelector("[data-story-reload]")!)
    await frames(6)
    await expect(region.firstElementChild).toBe(said)
    await expect(canvas.getByRole("link", { name: "Newer review" })).toBe(link)
  },
}

export const ExpiryReplacedUnderReaderDark: Story = {
  ...ExpiryReplacedUnderReader,
  globals: { theme: "dark" },
}

/**
 * A unit code titled, owning many short runs of lines: in the Agentic
 * review group its name lists every run and wraps within the title's
 * column, clear of "R2 approved" on the right.
 */
export const ExpiryLongLineList: Story = {
  args: { data: linkExpiryLongLinesOverviewFixture },
  play: async ({ canvas }) => {
    await userEvent.click(
      await canvas.findByRole("heading", { name: "Agentic review" })
    )
    const link = await waitFor(() =>
      canvas.getByRole("link", { name: /^Changes to src\/sharing\/expiry\.ts/ })
    )
    const row = link.closest<HTMLElement>("li")!
    const mark = row.querySelector<HTMLElement>("[data-review-mark]")!
    // The title's column ends before the review's begins: nothing overprints.
    await expect(link.getBoundingClientRect().right).toBeLessThanOrEqual(
      mark.getBoundingClientRect().left
    )
  },
}

export const ExpiryLongLineListDark: Story = {
  ...ExpiryLongLineList,
  globals: { theme: "dark" },
}
