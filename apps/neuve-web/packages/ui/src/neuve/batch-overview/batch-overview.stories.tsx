import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { batchOverviewFixture } from "@workspace/ui/fixtures/review-batch.fixtures"
import {
  boldDigestOverviewFixture,
  contextualBriefingWithPhraseFixture,
  digestSectionsOverviewFixture,
  liveLaneOverviewFixture,
} from "@workspace/ui/fixtures/shell.fixtures"
import { BatchHero } from "@workspace/ui/neuve/batch-overview/batch-hero"
import { JudgmentTable } from "@workspace/ui/neuve/batch-overview/judgment-table"
import { LaneBar } from "@workspace/ui/neuve/batch-overview/lane-bar"
import { withBatchOverviewState } from "@workspace/ui/neuve/batch-overview/story-state"
import { expectTabFocusRing } from "@workspace/ui/neuve/story-kit/play"

const data = batchOverviewFixture

const meta = {
  title: "Batch overview/Sections",
  component: LaneBar,
  args: { lanes: data.lanes, waiting: data.needYou },
  decorators: [
    (Story) => (
      <div className="min-h-svh bg-paper p-8 font-sans text-sm text-ink">
        <div className="mx-auto max-w-[1132px]">
          <Story />
        </div>
      </div>
    ),
  ],
} satisfies Meta<typeof LaneBar>

export default meta
type Story = StoryObj<typeof meta>

/** Rest: a thin bar of solid lane colours and a legend; no raw slugs. */
export const LanesRest: Story = { decorators: [withBatchOverviewState()] }
/** Pointing at a lane (legend or bar) dims the others. */
export const LanesSuggested: Story = {
  decorators: [withBatchOverviewState({ activeLane: "human-suggested" })],
}
export const LanesAgentic: Story = {
  decorators: [withBatchOverviewState({ activeLane: "agentic-review" })],
}
/**
 * The live batch (2026-10-06): one unit per lane and an empty static lane,
 * which keeps a 6px stub. Lane lines that are raw readiness slugs never show.
 */
export const LanesWithEmptyLane: Story = {
  args: {
    lanes: liveLaneOverviewFixture.lanes,
    waiting: liveLaneOverviewFixture.needYou,
  },
  decorators: [withBatchOverviewState()],
  play: async ({ canvasElement }) => {
    await expect(canvasElement).not.toHaveTextContent("awaiting-human")
    const segments = canvasElement.querySelectorAll<HTMLElement>(
      '[role="img"] > span'
    )
    await expect(segments[3]?.getBoundingClientRect().width).toBe(6)
  },
}

export const Hero: Story = {
  decorators: [withBatchOverviewState()],
  render: () => <BatchHero data={data} />,
}

/** The open tooltip's text, once it shows. */
function tooltipText(doc: Document) {
  return waitFor(() => {
    const content = doc.querySelector<HTMLElement>(
      "[data-slot='tooltip-content'][data-state$='open']"
    )
    expect(content).toBeVisible()
    return content!.textContent
  })
}

/**
 * Contextual briefing: icon-only citation chips, as on the desk (round 5),
 * named and tooltipped by kind and target; and the recorded limitations
 * folded into one disclosure with a count.
 */
export const HeroWithLimitations: Story = {
  decorators: [withBatchOverviewState()],
  render: () => <BatchHero data={liveLaneOverviewFixture} />,
  play: async ({ canvas, canvasElement }) => {
    const doc = canvasElement.ownerDocument
    for (const name of [
      "Conflict, Session invalidation",
      "Graph, Revoke callers",
    ]) {
      const chip = canvas.getByRole("button", { name })
      await expect(chip).toHaveAttribute("data-icon-only")
      await expect(chip.textContent).toBe("")
      await expect(chip.querySelector("svg")).toBeTruthy()
      await userEvent.hover(chip)
      await expect(await tooltipText(doc)).toBe(name)
      // The tooltip is not also a description: the name is said once.
      await expect(chip).not.toHaveAttribute("aria-describedby")
      await userEvent.unhover(chip)
    }
    // Keyboard focus shows the focus ring and the same tooltip, once the
    // hover tooltips have closed.
    await waitFor(() =>
      expect(doc.querySelector("[data-slot='tooltip-content']")).toBeNull()
    )
    const first = canvas.getByRole("button", {
      name: "Conflict, Session invalidation",
    })
    await expectTabFocusRing(userEvent, first)
    await expect(await tooltipText(doc)).toBe("Conflict, Session invalidation")
    await userEvent.keyboard("{Escape}")
    first.blur()
    const summary = canvas.getByText("Limitations")
    const details = summary.closest("details")!
    await expect(details.open).toBe(false)
    await userEvent.click(summary)
    await expect(details.open).toBe(true)
  },
}

/**
 * A contextual briefing with a describing phrase: the overview has no diff
 * to land in, so the phrase reads as its words, and the phrase and the
 * chips stay inside their paragraph (round 5).
 */
export const HeroBriefingWithPhrase: Story = {
  decorators: [withBatchOverviewState()],
  render: () => <BatchHero data={contextualBriefingWithPhraseFixture} />,
  play: async ({ canvas }) => {
    const sentence = canvas.getByText(/^Revoking now also/).closest("p")!
    await expect(sentence.textContent).toContain(
      "Revoking now also ends open sessions, reversing a May decision"
    )
    await expect(sentence.querySelectorAll("button[aria-label]").length).toBe(2)
    await expect(
      canvas.queryByRole("link", { name: /ends open sessions/ })
    ).toBeNull()
  },
}

/**
 * The batch digest in two short sections, "What changed" and "What to
 * check", in the harness's words; a phrase that names a unit opens it, and
 * no caption describes the digest.
 */
export const HeroDigestSections: Story = {
  decorators: [withBatchOverviewState()],
  render: () => <BatchHero data={digestSectionsOverviewFixture} />,
  play: async ({ canvas }) => {
    const changed = canvas.getByRole("region", { name: "What changed" })
    const check = canvas.getByRole("region", { name: "What to check" })
    await expect(changed).toHaveTextContent(/^What changedRevoking now also/)
    await expect(check).toHaveTextContent(/retry path is unproven\.$/)
    await expect(
      within(changed).getByRole("link", { name: "start request contract" })
    ).toHaveAttribute("href", "/review/revoke-cuts-off-open-sessions")
    await expect(canvas.queryByText(/Advisory briefing/)).toBeNull()
  },
}

/**
 * A digest whose lines lead with bold labels (10.140): each label is bold
 * and its line keeps its break; a phrase that names a unit still opens it.
 */
export const HeroDigestBold: Story = {
  decorators: [withBatchOverviewState()],
  render: () => <BatchHero data={boldDigestOverviewFixture} />,
  play: async ({ canvas }) => {
    const changed = canvas.getByRole("region", { name: "What changed" })
    const check = canvas.getByRole("region", { name: "What to check" })
    const labels = (region: HTMLElement) =>
      Array.from(region.querySelectorAll("strong"), (bold) => bold.textContent)
    await expect(labels(changed)).toEqual(["Identity:", "Stability:"])
    await expect(labels(check)).toEqual(["Missing proof:"])
    await expect(changed).not.toHaveTextContent("**")
    await expect(check).not.toHaveTextContent("**")
    await expect(
      within(changed).getByRole("link", { name: "start request contract" })
    ).toHaveAttribute("href", "/review/revoke-cuts-off-open-sessions")
    // Each label starts its own line.
    const [identity, stability] = Array.from(changed.querySelectorAll("strong"))
    await expect(stability!.getBoundingClientRect().top).toBeGreaterThan(
      identity!.getBoundingClientRect().bottom - 1
    )
  },
}

/**
 * An unmet checkpoint reads amber (`sug`), never magenta: magenta is for
 * a decision needed (vocabulary.md, "Marker kind").
 */
async function expectAmber(element: HTMLElement) {
  const probe = element.ownerDocument.createElement("span")
  probe.style.color = "var(--nv-sug-fg)"
  element.ownerDocument.body.append(probe)
  const amber = getComputedStyle(probe).color
  probe.remove()
  await waitFor(() => expect(getComputedStyle(element).color).toBe(amber))
}

/** Scope reads "1 hunk" and, for screen readers, "1 file": never "1 hunks". */
export const NeedsYourJudgment: Story = {
  render: () => <JudgmentTable units={data.judgment} />,
  play: async ({ canvasElement }) => {
    const scope = Array.from(
      canvasElement.querySelectorAll<HTMLElement>('[role="cell"]'),
      (cell) => cell.textContent
    ).filter((text) => /\bhunks?\b/.test(text))
    await expect(scope).toEqual([
      "2 files · 3 hunks",
      "1 file · 2 hunks",
      "1 file · 1 hunk",
      "1 file · 1 hunk",
    ])
    await expect(canvasElement.textContent).not.toMatch(/\b1 (hunks|files)\b/)
  },
}

/**
 * The live row whose cells once collided: fixed
 * columns, ellipsis, the full text in a tooltip.
 */
export const JudgmentCellsTruncate: Story = {
  render: () => (
    <div className="max-w-[920px]">
      <JudgmentTable units={liveLaneOverviewFixture.judgment} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const cells = Array.from(
      canvasElement.querySelectorAll<HTMLElement>('[role="row"] [role="cell"]')
    ).slice(1)
    for (let i = 1; i < cells.length; i++) {
      const previous = cells[i - 1]!.getBoundingClientRect()
      const next = cells[i]!.getBoundingClientRect()
      await expect(previous.right).toBeLessThanOrEqual(next.left)
    }
  },
}

/**
 * Each unit's unmet checkpoints in one count under "Checkpoints": "N unmet"
 * reads amber and says "checkpoints" to screen readers; a unit with none
 * unmet shows nothing, never "met". Nothing expands: the row opens the
 * unit, where the checkpoints are.
 */
export const UnmetCheckpoints: Story = {
  render: () => (
    <JudgmentTable units={data.judgment} checkpoints={data.checkpoints} />
  ),
  play: async ({ canvas, canvasElement }) => {
    await expect(
      canvas.getByRole("columnheader", { name: "Checkpoints" })
    ).toBeVisible()
    const unmet = canvas.getAllByText(/^1 unmet/)
    await expect(unmet).toHaveLength(3)
    await expect(unmet[0]).toHaveTextContent("1 unmet checkpoint")
    await expectAmber(unmet[0]!)
    await expect(canvas.queryByText(/\bmet\b/)).toBeNull()
    await expect(canvasElement.querySelector("[aria-expanded]")).toBeNull()
  },
}
