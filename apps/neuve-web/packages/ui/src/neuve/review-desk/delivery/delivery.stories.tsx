import { atomWithStorage } from "jotai/utils"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"

import {
  gatheredDeliveryDeskFixture,
  goDeliveryAgentRequestedDeskFixture,
  goDeliveryApproveSuggestedDeskFixture,
  goDeliveryCheckMissingDeskFixture,
  goDeliveryDeskFixture,
  goDeliveryFactsGuidedDeskFixture,
  goDeliveryInLane,
  goDeliverySuggestedPassedDeskFixture,
  scopeAgentReviewDeskFixture,
  scopeAllMetDeskFixture,
  scopeDeliveryDeskFixture,
  scopeNoCheckpointsDeskFixture,
  scopeOnlyThinDeskFixture,
  scopeUnattachedDeskFixture,
  scopeUnattachedNoItemsDeskFixture,
  unlinkedGatheredDeliveryDeskFixture,
  unlinkedSuggestedDeliveryDeskFixture,
  unlinkedSuggestedNoReviewerDeskFixture,
} from "@workspace/ui/fixtures/review-batch.fixtures"
import { sampleDeliverySettings } from "@workspace/ui/fixtures/delivery-languages.fixtures"
import { noAgentDecisionDeskFixture } from "@workspace/ui/fixtures/lanes-desk.fixtures"
import { deskMeta } from "@workspace/ui/neuve/story-kit/desk"
import type { DeskAt } from "@workspace/ui/neuve/story-kit/desk"
import { mainColumn, seenText } from "@workspace/ui/neuve/story-kit/dom"
import { CriteriaCardFrame } from "@workspace/ui/neuve/story-kit/frames"
import {
  chooseStop,
  pause,
  saidOnce,
  stopRadio,
  visible,
} from "@workspace/ui/neuve/story-kit/play"
import { withDeliverySettings } from "@workspace/ui/neuve/story-kit/settings"

/**
 * Review delivery on the desk (Delivery.dc.html, round 4). One dial with
 * four stops; the cited facts never change, higher stops add layers, and
 * Guided trades the diff for the change checked against its ticket. Stories
 * read an in-memory workspace setting (never the one stored in this
 * browser), seeded from the sample (Go refined to Explained); most also seed
 * the reader's stop for the unit.
 */
const meta = {
  title: "Screens/Review desk/Delivery",
  ...deskMeta("index-writes"),
} satisfies Meta<typeof DeskAt>

export default meta
type Story = StoryObj<typeof meta>

/** The Guided card's region name: "Done when" and the ticket's title. */
const DONE_WHEN = "Done when: Index writes fail when the database is busy"

/** Facts: one cited sentence, then the diff and its margin. */
export const Facts: Story = {
  args: { initialDeliveryStop: "facts" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await visible(canvas.getByText(/Commit retries busy writes three times/))
    await expect(canvas.queryByLabelText("How Commit changes")).toBeNull()
  },
}

/** Briefed: today's cited claims, one per line; nothing else is added. */
export const Briefed: Story = { args: { initialDeliveryStop: "briefed" } }

/** Explained: the same paragraph, the flow and the terms from owned lines. */
export const Explained: Story = {}

/**
 * No reader override: the stop comes from the workspace setting refined by
 * the payload's declared language (the sample refines Go to Explained).
 * Moving the dial away and back to that stop clears the override.
 */
export const FollowsWorkspace: Story = {
  play: async ({ canvasElement }) => {
    await expect(await stopRadio(canvasElement, "explained")).toBeChecked()
    await chooseStop(canvasElement, "facts")
    await expect(await stopRadio(canvasElement, "facts")).toBeChecked()
    await chooseStop(canvasElement, "explained")
    await expect(await stopRadio(canvasElement, "explained")).toBeChecked()
  },
}

/** Guided: no diff. The flow stays; the change is checked against SHR-318. */
export const Guided: Story = {
  args: { initialDeliveryStop: "guided" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await visible(
      canvas.getByRole("region", {
        name: DONE_WHEN,
      })
    )
    await expect(canvasElement.querySelector("diffs-container")).toBeNull()
    // The suggestion requests changes: the lane's own verbs, that one primary.
    await visible(canvas.getByRole("button", { name: /^Request changes/ }))
    await expect(
      canvas.getByRole("button", { name: /^Request changes/ })
    ).toHaveAttribute("aria-keyshortcuts", "Meta+Enter")
    await visible(canvas.getByRole("button", { name: "Edit request" }))
    await visible(canvas.getByRole("button", { name: "Approve" }))
    // The Guided dock keeps the scope note ("Covers 1 hunk") of the lane dock.
    await expect(canvas.getByText(/Covers 1 hunk/)).toHaveAttribute(
      "aria-describedby",
      "dock-scope-note"
    )
  },
}

/** A Source pin opens only a short excerpt of its lines. */
export const GuidedExcerpt: Story = {
  args: { initialDeliveryStop: "guided" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const pin = canvas.getByRole("button", { name: /Source\s*line 34/ })
    await userEvent.click(pin)
    await expect(pin).toHaveAttribute("aria-expanded", "true")
    await visible(
      await canvas.findByText("time.Sleep(backoff(attempt))", {
        selector: "pre span",
      })
    )
  },
}

/**
 * The stored workspace setting resolves after mount (browser storage is read
 * on mount): here it refines Go to Guided. Not the reader's move, so the
 * layers snap instead of playing the storyboard.
 */
const LATE_SETTINGS_KEY = "neuve.review-delivery.story-late"
const lateSettingsAtom = atomWithStorage(
  LATE_SETTINGS_KEY,
  sampleDeliverySettings
)

export const SettingResolvesAfterMount: Story = {
  // Like the /mock setting: storage says Go is Guided, read on mount.
  loaders: [
    () => {
      try {
        localStorage.setItem(
          LATE_SETTINGS_KEY,
          JSON.stringify({
            ...sampleDeliverySettings,
            byLanguage: { go: "guided" },
          })
        )
      } catch {
        // Storage unavailable: the story shows the sample (Explained).
      }
      return {}
    },
  ],
  decorators: [
    withDeliverySettings(sampleDeliverySettings, { source: lateSettingsAtom }),
  ],
  play: async ({ canvasElement }) => {
    const card = await within(canvasElement).findByRole("region", {
      name: DONE_WHEN,
    })
    // Snapped: fully shown at once, and the diff already gone.
    await expect(getComputedStyle(card.parentElement!).opacity).toBe("1")
    await expect(canvasElement.querySelector("diffs-container")).toBeNull()
  },
}

/** Moving the dial: Briefed → Explained adds the layers; Guided drops the diff. */
export const DialChange: Story = {
  args: { initialDeliveryStop: "briefed" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.queryByLabelText("How Commit changes")).toBeNull()
    await chooseStop(canvasElement, "explained")
    await visible(
      await canvas.findByRole("region", { name: "How Commit changes" })
    )
    await visible(canvas.getByRole("region", { name: "Go in this unit" }))
    await chooseStop(canvasElement, "guided")
    await waitFor(() =>
      expect(canvasElement.querySelector("diffs-container")).toBeNull()
    )
    await waitFor(() =>
      expect(
        canvas.queryByRole("region", { name: "Go in this unit" })
      ).toBeNull()
    )
    await visible(canvas.getByRole("region", { name: "How Commit changes" }))
    // Back to Briefed: the diff returns.
    await chooseStop(canvasElement, "briefed")
    await waitFor(() =>
      expect(canvasElement.querySelector("diffs-container")).not.toBeNull()
    )
  },
}

/**
 * Request changes (primary, ⌘↵): the reader sends the harness's suggestion
 * as their own; the card turns solid ("Sent by you") until Undo.
 */
export const SendRequest: Story = {
  args: { initialDeliveryStop: "guided" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("button", { name: /^Request changes/ })
    )
    await visible(
      await canvas.findByText(
        "Changes requested · suggested by the harness, sent by you"
      )
    )
    // Sent: the mark says "You requested changes"; Undo makes it a
    // suggestion again ("Suggested · request changes", dashed).
    const card = canvas.getByRole("region", { name: "Suggested review" })
    await expect(card).toHaveAttribute("data-sent")
    const sentMark = card.querySelector('[data-review-mark][data-sent="true"]')
    await expect(sentMark).toHaveTextContent("You requested changes")
    // The screen passes the reader, so the sent mark leads with your avatar.
    await expect(
      sentMark?.querySelector('[data-avatar="person"]')
    ).not.toBeNull()
    await userEvent.click(canvas.getByRole("button", { name: "Undo" }))
    await waitFor(() => expect(card).not.toHaveAttribute("data-sent"))
    await expect(
      card.querySelector('[data-review-mark][data-sent="false"]')
    ).toHaveTextContent("Suggested · request changes")
  },
}

/** Edit request: the composer opens prefilled and says where it came from. */
export const EditMessage: Story = {
  args: { initialDeliveryStop: "guided" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Edit request" }))
    const composer = await canvas.findByRole("dialog", {
      name: "Request changes",
    })
    await visible(within(composer).getByText("from the suggested review"))
    await expect(within(composer).getByRole("textbox")).toHaveValue(
      goDeliveryDeskFixture.delivery!.check!.suggestion!.message
    )
  },
}

/** Approve, where the suggestion requests changes: decided against it. */
export const ApproveInstead: Story = {
  args: { initialDeliveryStop: "guided" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Approve" }))
    await visible(
      await canvas.findByText("Approved · against the suggested review")
    )
  },
}

/* ── No agent verdict on a human-required unit (10.122) ── */

/**
 * At Guided on a human-required unit R1 also sent back, before the human
 * decides: the desk shows no agent verdict there (10.122). R1's request
 * stays in the unit's context in Records (4.14) and is to reach the desk only
 * as a reviewer finding; no R1 review card renders, and the dock's suggested
 * review is the only verdict shown. Every review mark on the desk is the
 * suggestion's (goDeliveryAgentRequestedDeskFixture).
 */
async function expectOnlyTheSuggestion(
  canvasElement: HTMLElement,
  sent: "not sent" | "sent" | "against"
) {
  const canvas = within(canvasElement)
  const suggested = await waitFor(() =>
    canvas.getByRole("region", { name: "Suggested review" })
  )
  await visible(suggested)
  await expect(
    canvas.queryByRole("region", { name: "The agent’s review" })
  ).toBeNull()
  await expect(canvas.queryByText(/R1 requested changes/)).toBeNull()
  const marks = [...canvasElement.querySelectorAll("[data-review-mark]")]
  await expect(marks.every((mark) => suggested.contains(mark))).toBe(true)
  const mark = suggested.querySelector("[data-review-mark]")
  if (sent === "sent") {
    await expect(suggested).toHaveAttribute("data-sent")
    await expect(mark).toHaveTextContent("You requested changes")
  } else {
    await expect(suggested).not.toHaveAttribute("data-sent")
    await expect(mark).toHaveTextContent("Suggested · request changes")
  }
}

/**
 * Before any human decision: the dock rests on the suggestion (Request
 * changes, primary ⌘↵; Edit request; Approve).
 */
export const GuidedSuggestionOnly: Story = {
  args: {
    data: goDeliveryAgentRequestedDeskFixture,
    initialDeliveryStop: "guided",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expectOnlyTheSuggestion(canvasElement, "not sent")
    const send = canvas.getByRole("button", { name: /^Request changes/ })
    await visible(send)
    await expect(send).toHaveAttribute("aria-keyshortcuts", "Meta+Enter")
    await visible(canvas.getByRole("button", { name: "Edit request" }))
    await visible(canvas.getByRole("button", { name: "Approve" }))
  },
}

/** Sending the suggestion makes it the reader's request, and no R1 card. */
export const GuidedSuggestionOnlySent: Story = {
  args: {
    data: goDeliveryAgentRequestedDeskFixture,
    initialDeliveryStop: "guided",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expectOnlyTheSuggestion(canvasElement, "not sent")
    await userEvent.click(
      canvas.getByRole("button", { name: /^Request changes/ })
    )
    await visible(
      await canvas.findByText(
        "Changes requested · suggested by the harness, sent by you"
      )
    )
    await expectOnlyTheSuggestion(canvasElement, "sent")
  },
}

/** Approving instead leaves the suggestion a suggestion, and no R1 card. */
export const GuidedSuggestionOnlyAgainst: Story = {
  args: {
    data: goDeliveryAgentRequestedDeskFixture,
    initialDeliveryStop: "guided",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expectOnlyTheSuggestion(canvasElement, "not sent")
    await userEvent.click(canvas.getByRole("button", { name: "Approve" }))
    await visible(
      await canvas.findByText("Approved · against the suggested review")
    )
    await expectOnlyTheSuggestion(canvasElement, "against")
  },
}

/**
 * The conclusion is computed from the rows, never carried by the payload:
 * two open rows of three read "2 of 3 not done".
 */
export const GuidedConclusionFromRows: Story = {
  args: { initialDeliveryStop: "guided" },
  play: async ({ canvasElement }) => {
    const card = within(
      within(canvasElement).getByRole("region", {
        name: "Suggested review",
      })
    )
    await expect(card.getByText("· 2 of 3 not done")).toBeInTheDocument()
  },
}

/** A suggested approval on met rows: Request changes · Approve ⌘↵. */
export const GuidedSuggestsApprove: Story = {
  args: {
    data: goDeliveryApproveSuggestedDeskFixture,
    initialDeliveryStop: "guided",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText("· everything is done")).toBeInTheDocument()
    await expect(
      canvas.getByRole("button", { name: "Request changes" })
    ).not.toHaveAttribute("aria-keyshortcuts")
    await expect(
      canvas.getByRole("button", { name: /^Approve/ })
    ).toHaveAttribute("aria-keyshortcuts", "Meta+Enter")
    await expect(
      canvas.queryByRole("button", { name: "Edit request" })
    ).toBeNull()
  },
}

/** At Guided there's no diff: a flow box opens its lines in the source sheet. */
export const GuidedFlowOpensSource: Story = {
  args: { initialDeliveryStop: "guided" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.queryByText(/Every box is a symbol you can land on/)
    ).toBeNull()
    await userEvent.click(
      canvas.getByRole("button", {
        name: "commitOnce: open line 39 in the source",
      })
    )
    await expect(
      await within(canvasElement.ownerDocument.body).findByRole("dialog", {
        name: "internal/index/writer.go",
      })
    ).toBeInTheDocument()
  },
}

/**
 * Human-suggested (Option A): the agent's review is one card. The review
 * mark leads (R1, check, "R1 approved"; provenance on the avatar), then the
 * reason and the evidence. At Guided the ticket's rows wait inside the card
 * behind "Why" with the computed count; there's no separate card, no
 * suggested review, and the dock says what it covers.
 */
export const GuidedHumanSuggested: Story = {
  args: {
    data: goDeliveryInLane("human-suggested"),
    initialDeliveryStop: "guided",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const card = canvas.getByRole("region", { name: "The agent’s review" })
    await visible(card)
    await saidOnce(canvasElement, /R1\s+approved/)
    await expect(canvas.queryByText(/agentic review · a3f9c2e/)).toBeNull()
    await expect(
      canvas.queryByRole("region", { name: "Suggested review" })
    ).toBeNull()
    await expect(
      canvas.queryByRole("region", { name: /^Done when:/ })
    ).toBeNull()
    await visible(canvas.getByRole("button", { name: "Agree" }))
    await expect(canvas.getByText(/Covers 1 hunk/)).toBeInTheDocument()
    await expect(canvas.queryByText("Agent approved this unit")).toBeNull()
    // Present and settled on first paint (no shift): the screen passes the
    // check to the briefing, and a stop the reader didn't move to snaps.
    const why = within(card).getByRole("button", {
      name: /^Why · 2 of 3 not done/,
    })
    await expect(getComputedStyle(why.parentElement!).opacity).toBe("1")
    await expect(why).toHaveAttribute("aria-expanded", "false")
    await expect(
      canvas.queryByText("Cancelling a request stops index work")
    ).toBeNull()
  },
}

/** "Why" opened: the ticket's rows inside the review card. */
export const GuidedHumanSuggestedWhyOpen: Story = {
  args: {
    data: goDeliveryInLane("human-suggested"),
    initialDeliveryStop: "guided",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const card = canvas.getByRole("region", { name: "The agent’s review" })
    const why = within(card).getByRole("button", { name: /^Why/ })
    await visible(why)
    await userEvent.click(why)
    await expect(why).toHaveAttribute("aria-expanded", "true")
    await visible(
      await within(card).findByText("Cancelling a request stops index work")
    )
    await visible(
      within(card).getByText("Index writes fail when the database is busy")
    )
    await saidOnce(canvasElement, /R1\s+approved/)
  },
}

/** Below Guided: the same review card, without "Why". */
export const HumanSuggestedBriefed: Story = {
  args: {
    data: goDeliveryInLane("human-suggested"),
    initialDeliveryStop: "briefed",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const card = canvas.getByRole("region", { name: "The agent’s review" })
    await visible(card)
    await expect(
      within(card).queryByRole("button", { name: /^Why/ })
    ).toBeNull()
    await expect(
      within(card).getByText("Retries busy writes; accepted the untested path.")
    ).toBeInTheDocument()
    await saidOnce(canvasElement, /R1\s+approved/)
  },
}

/** The provenance is on the avatar: focus it to see where the review came from. */
export const HumanSuggestedProvenance: Story = {
  args: {
    data: goDeliveryInLane("human-suggested"),
    initialDeliveryStop: "briefed",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const avatar = await canvas.findByRole("button", {
      name: "R1, reviewer agent",
    })
    avatar.focus()
    await expect(
      await within(canvasElement.ownerDocument.body).findAllByText(
        "R1 · reviewer agent · agentic review · a3f9c2e"
      )
    ).not.toHaveLength(0)
  },
}

/**
 * Human-suggested with an outcome that isn't an agent's disposition: the
 * rows show, with no conclusion line (no wrong-lane wording).
 */
export const GuidedHumanSuggestedNoDisposition: Story = {
  args: {
    data: goDeliverySuggestedPassedDeskFixture,
    initialDeliveryStop: "guided",
  },
  play: async ({ canvasElement }) => {
    const card = within(
      within(canvasElement).getByRole("region", { name: DONE_WHEN })
    )
    await expect(card.queryByText(/Passed static automation/)).toBeNull()
    await expect(card.queryByText(/The agent/)).toBeNull()
    // The dock follows the lane, not the outcome: no agent decided this
    // human-suggested unit, and nothing on the desk reads as a static pass.
    const canvas = within(canvasElement)
    await expect(
      canvas.getByText("No agent decision in this run")
    ).toBeInTheDocument()
    await expect(canvas.queryByText(/Passed static automation/)).toBeNull()
  },
}

/** The Scope card's region name: "Scope" and the ticket's title. */
const SCOPE = "Scope: Revoked links keep working for open sessions"

/**
 * Scope fallback (S2): SHR-212 has a scope but no "Done when". Ring marks,
 * Covered / Not covered / No evidence, a computed "2 of 3 not covered",
 * and the suggested review still ends a human-required unit.
 */
export const GuidedScope: Story = {
  args: { data: scopeDeliveryDeskFixture, initialDeliveryStop: "guided" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const card = canvas.getByRole("region", { name: SCOPE })
    await visible(card)
    for (const status of ["Covered", "Not covered", "No evidence"])
      await expect(within(card).getByText(status)).toBeInTheDocument()
    await expect(within(card).queryByText(/^(Done|Not done)$/)).toBeNull()
    const suggested = within(card).getByRole("region", {
      name: "Suggested review",
    })
    await expect(
      within(suggested).getByText("· 2 of 3 not covered")
    ).toBeInTheDocument()
    await expect(
      suggested.querySelector('[data-review-mark][data-sent="false"]')
    ).toHaveTextContent("Suggested · request changes")
    await visible(canvas.getByRole("button", { name: "Edit request" }))
  },
}

export const GuidedScopeDark: Story = {
  args: { data: scopeDeliveryDeskFixture, initialDeliveryStop: "guided" },
  globals: { theme: "dark" },
}

/* ── The Scope card's checkpoints (11.23) ─────────────────
 * Unmet checkpoints (Missing, Out of date, Conflicting) sit under the item
 * they fail; every other one is one count row at the card's foot, a native
 * disclosure grouped by item. The agent's word never changes with them.
 */

/** The foot's count row, by its accessible name. */
const footRow = (card: HTMLElement) =>
  card.querySelector<HTMLElement>("[data-checkpoints-foot] summary")!

/**
 * Some unmet: "Open documents lose access too" carries its Missing and
 * Conflicting checkpoints, each with its state, requirement, Records' note
 * and where it sits; the items with none unmet look as before; the foot
 * counts the other three; the suggested review counts the two unmet.
 */
export const GuidedScopeCheckpoints: Story = {
  args: { data: scopeDeliveryDeskFixture, initialDeliveryStop: "guided" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const card = canvas.getByRole("region", { name: SCOPE })
    await visible(card)
    const unmet = within(card).getByRole("list", {
      name: "2 unmet checkpoints",
    })
    const items = within(unmet).getAllByRole("listitem")
    await expect(items).toHaveLength(2)
    await expect(items[0]).toHaveTextContent("Missing")
    await expect(items[0]).toHaveTextContent("This unit as a whole")
    await expect(items[0]).toHaveTextContent(
      "No proof record it names is in Records."
    )
    await expect(items[1]).toHaveTextContent("Conflicting")
    // The agent's word stays: a checkpoint is not a verdict.
    for (const status of ["Covered", "Not covered", "No evidence"])
      await expect(within(card).getByText(status)).toBeInTheDocument()
    // One unmet list only: the met items look as before.
    await expect(
      within(card).queryAllByRole("list", { name: /unmet checkpoint/ })
    ).toHaveLength(1)
    const row = footRow(card)
    await expect(row).toHaveTextContent("3 other checkpoints")
    await expect(row).toHaveTextContent("1 thin")
    await expect(row).toHaveTextContent("2 proven")
    await expect(row.closest("details")).not.toHaveAttribute("open")
    const suggested = within(card).getByRole("region", {
      name: "Suggested review",
    })
    await expect(
      within(suggested).getByText("· 2 of 3 not covered")
    ).toBeInTheDocument()
    await expect(
      within(suggested).getByText("· 2 unmet checkpoints")
    ).toBeInTheDocument()
  },
}

/** The count row open: the other checkpoints, grouped by item. */
export const GuidedScopeCheckpointsOpen: Story = {
  args: { data: scopeDeliveryDeskFixture, initialDeliveryStop: "guided" },
  play: async ({ canvasElement }) => {
    const card = within(canvasElement).getByRole("region", { name: SCOPE })
    await visible(card)
    const row = footRow(card)
    await userEvent.click(row)
    await expect(row.closest("details")).toHaveAttribute("open")
    const foot = within(row.closest("details")!)
    await expect(
      foot.getByRole("list", {
        name: "Revoking a link ends access immediately",
      })
    ).toBeInTheDocument()
    await expect(
      foot.getByRole("list", { name: "Viewers see why access ended" })
    ).toBeInTheDocument()
    await expect(foot.getAllByText("Proven")).toHaveLength(2)
    await expect(foot.getByText("Thin")).toBeInTheDocument()
  },
}

/** A checkpoint's lines pin opens its lines under it, as a Source pin does. */
export const GuidedScopeCheckpointLines: Story = {
  args: { data: scopeDeliveryDeskFixture, initialDeliveryStop: "guided" },
  play: async ({ canvasElement }) => {
    const card = within(canvasElement).getByRole("region", { name: SCOPE })
    await visible(card)
    const unmet = within(card).getByRole("list", {
      name: "2 unmet checkpoints",
    })
    const pin = within(unmet).getByRole("button", {
      name: /viewer-access\.ts\s*lines 9–13/,
    })
    await userEvent.click(pin)
    await expect(pin).toHaveAttribute("aria-expanded", "true")
    await visible(
      await within(unmet).findByText('    throw new AccessEnded("revoked");', {
        selector: "pre span",
        normalizer: (text) => text,
      })
    )
  },
}

export const GuidedScopeCheckpointsDark: Story = {
  args: { data: scopeDeliveryDeskFixture, initialDeliveryStop: "guided" },
  globals: { theme: "dark" },
}

/** Every checkpoint met: every item looks as before; the foot counts them. */
export const GuidedScopeAllMet: Story = {
  args: { data: scopeAllMetDeskFixture, initialDeliveryStop: "guided" },
  play: async ({ canvasElement }) => {
    const card = within(canvasElement).getByRole("region", { name: SCOPE })
    await visible(card)
    await expect(
      within(card).queryByRole("list", { name: /unmet checkpoint/ })
    ).toBeNull()
    await expect(footRow(card)).toHaveTextContent("5 checkpoints")
    await expect(footRow(card)).toHaveTextContent("1 thin")
    await expect(footRow(card)).toHaveTextContent("4 proven")
    await expect(within(card).queryByText(/unmet checkpoints?/)).toBeNull()
  },
}

/** Only Thin: shallow but not unmet, so none comes forward. */
export const GuidedScopeOnlyThin: Story = {
  args: { data: scopeOnlyThinDeskFixture, initialDeliveryStop: "guided" },
  play: async ({ canvasElement }) => {
    const card = within(canvasElement).getByRole("region", { name: SCOPE })
    await visible(card)
    await expect(
      within(card).queryByRole("list", { name: /unmet checkpoint/ })
    ).toBeNull()
    await expect(footRow(card)).toHaveTextContent("5 checkpoints")
    await expect(footRow(card)).toHaveTextContent("5 thin")
  },
}

/** No checkpoints: the card as it was, with no count row. */
export const GuidedScopeNoCheckpoints: Story = {
  args: { data: scopeNoCheckpointsDeskFixture, initialDeliveryStop: "guided" },
  play: async ({ canvasElement }) => {
    const card = within(canvasElement).getByRole("region", { name: SCOPE })
    await visible(card)
    await expect(card.querySelector("[data-checkpoints-foot]")).toBeNull()
    await expect(within(card).queryByText(/unmet checkpoints?/)).toBeNull()
  },
}

/**
 * Checkpoints that rest on no item only: the foot holds them under their
 * own heading, and the suggested review still counts the unmet one.
 */
export const GuidedScopeUnattached: Story = {
  args: { data: scopeUnattachedDeskFixture, initialDeliveryStop: "guided" },
  play: async ({ canvasElement }) => {
    const card = within(canvasElement).getByRole("region", { name: SCOPE })
    await visible(card)
    await expect(
      within(card).queryByRole("list", { name: /unmet checkpoint/ })
    ).toBeNull()
    const row = footRow(card)
    await expect(row).toHaveTextContent("2 checkpoints")
    await expect(row).toHaveTextContent("1 missing")
    await userEvent.click(row)
    await expect(
      within(row.closest("details")!).getByRole("list", {
        name: "Not tied to an item above",
      })
    ).toBeInTheDocument()
    await expect(
      within(card).getByText("· 1 unmet checkpoint")
    ).toBeInTheDocument()
  },
}

/**
 * No scope items on the card: the heading says so instead of "above". The
 * desk shows Guided's card only with items (`guidedCheck`), so this renders
 * the card alone.
 */
export const GuidedScopeUnattachedNoItems: StoryObj = {
  render: () => <CriteriaCardFrame data={scopeUnattachedNoItemsDeskFixture} />,
  play: async ({ canvasElement }) => {
    const card = within(canvasElement).getByRole("region", { name: SCOPE })
    await visible(card)
    const row = footRow(card)
    await expect(row).toHaveTextContent("2 checkpoints")
    await userEvent.click(row)
    await expect(
      within(row.closest("details")!).getByRole("list", {
        name: "Not tied to a scope item",
      })
    ).toBeInTheDocument()
  },
}

/** At 390px: the unmet checkpoints and the count row wrap, no sideways scroll. */
export const GuidedScopeCheckpointsPhone: Story = {
  args: { data: scopeDeliveryDeskFixture, initialDeliveryStop: "guided" },
  globals: { viewport: { value: "phone390", isRotated: false } },
  play: async ({ canvasElement }) => {
    const card = within(canvasElement).getByRole("region", { name: SCOPE })
    await visible(card)
    await userEvent.click(footRow(card))
    await expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth)
    const root = canvasElement.ownerDocument.documentElement
    await expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth)
  },
}

/**
 * Human-suggested work whose agent recorded a review: its card carries the
 * same rows behind "Why", with the unmet checkpoints under their item and
 * the count row at the foot.
 */
export const GuidedScopeAgentReview: Story = {
  args: { data: scopeAgentReviewDeskFixture, initialDeliveryStop: "guided" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const review = canvas.getByRole("region", { name: "The agent’s review" })
    await visible(review)
    await userEvent.click(within(review).getByRole("button", { name: /^Why/ }))
    await visible(
      await within(review).findByRole("list", { name: "2 unmet checkpoints" })
    )
    await expect(footRow(review)).toHaveTextContent("3 other checkpoints")
  },
}

/** The Gathered scope card's region name: the label and the intent line. */
const GATHERED = "Gathered scope: Retry index writes when SQLite reports busy"

/** The subtitle of an unlinked gathered scope, verbatim (user, 2026-10-14). */
const UNLINKED =
  "No ticket or doc is linked to this change, so this briefing and any suggested review come from the code and its history alone."

/**
 * No usable ticket: the harness gathered the scope from the change, its
 * history, the blast radius and an earlier review (round-4.md, "Scope is
 * always gathered"). "Gathered scope" over the intent, no ticket id, ring
 * marks, Source/History/Graph pins, and the suggested review still follows.
 */
export const GuidedGatheredScope: Story = {
  args: { data: gatheredDeliveryDeskFixture, initialDeliveryStop: "guided" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const card = canvas.getByRole("region", { name: GATHERED })
    await visible(card)
    await expect(within(card).getByText("Gathered scope")).toBeInTheDocument()
    await expect(within(card).queryByText(/^SHR-/)).toBeNull()
    for (const status of ["Covered", "Not covered", "No evidence"])
      await expect(within(card).getByText(status)).toBeInTheDocument()
    await expect(
      within(card).getAllByRole("button", { name: /^History/ })
    ).toHaveLength(2)
    await expect(
      within(card).getByRole("button", { name: /^Graph/ })
    ).toBeInTheDocument()
    const suggested = within(card).getByRole("region", {
      name: "Suggested review",
    })
    await expect(
      within(suggested).getByText("· 2 of 3 not covered")
    ).toBeInTheDocument()
    await expect(canvasElement.querySelector("diffs-container")).toBeNull()
    // Linked to an earlier review: no unlinked subtitle.
    await expect(within(card).queryByText(UNLINKED)).toBeNull()
  },
}

export const GuidedGatheredScopeDark: Story = {
  args: { data: gatheredDeliveryDeskFixture, initialDeliveryStop: "guided" },
  globals: { theme: "dark" },
}

/**
 * The harness reports that no ticket, doc, recorded decision or earlier
 * review links to the change: the card says so under the intent. Rows still
 * rest on the code and its history (the commit covers one), and the
 * suggested review still follows.
 */
export const GuidedGatheredUnlinked: Story = {
  args: {
    data: unlinkedGatheredDeliveryDeskFixture,
    initialDeliveryStop: "guided",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const card = canvas.getByRole("region", { name: GATHERED })
    await visible(card)
    await visible(within(card).getByText(UNLINKED))
    // Human-required keeps the approved line: no link to a review.
    await expect(
      within(card).queryByRole("button", { name: /^the agent’s review/ })
    ).toBeNull()
    await expect(within(card).getByText("Covered")).toBeInTheDocument()
    await expect(within(card).getAllByText("No evidence")).toHaveLength(2)
    // The commit, and writer.go's log behind the busy row.
    await expect(
      within(card).getAllByRole("button", { name: /^History/ })
    ).toHaveLength(2)
    const suggested = within(card).getByRole("region", {
      name: "Suggested review",
    })
    await expect(
      within(suggested).getByText("· 2 of 3 not covered")
    ).toBeInTheDocument()
  },
}

export const GuidedGatheredUnlinkedDark: Story = {
  args: {
    data: unlinkedGatheredDeliveryDeskFixture,
    initialDeliveryStop: "guided",
  },
  globals: { theme: "dark" },
}

/**
 * The line inside the agent's review card (user, 2026-10-14): it names that
 * review, as read on screen (the link's hidden "(R1, go to review)" aside).
 */
const UNLINKED_REVIEW =
  "No ticket or doc is linked to this change, so this briefing and the agent’s review come from the code and its history alone."

/** Opens "Why" in the agent's review card; returns the card. */
async function openWhy(canvasElement: HTMLElement) {
  const card = within(canvasElement).getByRole("region", {
    name: "The agent’s review",
  })
  const why = within(card).getByRole("button", { name: /^Why/ })
  await visible(why)
  await userEvent.click(why)
  await expect(why).toHaveAttribute("aria-expanded", "true")
  return card
}

/**
 * Human-suggested with an unlinked gathered scope: behind "Why", the line
 * names the agent's review and links to it. Following the link lands on the
 * review line (tinted like a diff landing) with focus on the review mark,
 * whose provenance shows.
 */
export const GuidedHumanSuggestedUnlinked: Story = {
  args: {
    data: unlinkedSuggestedDeliveryDeskFixture,
    initialDeliveryStop: "guided",
  },
  play: async ({ canvasElement }) => {
    const card = await openWhy(canvasElement)
    const line = await within(card).findByText(
      (_, element) =>
        element?.hasAttribute("data-unlinked") === true &&
        seenText(element) === UNLINKED_REVIEW
    )
    await visible(line)
    await expect(within(card).queryByText(UNLINKED)).toBeNull()
    const link = within(line).getByRole("button", {
      name: "the agent’s review (R1, go to review)",
    })
    await userEvent.click(link)
    const mark = within(card).getByRole("button", {
      name: "R1, reviewer agent",
    })
    await waitFor(() => expect(mark).toHaveFocus())
    const reviewLine = card.querySelector("[data-review-line]")
    await expect(reviewLine?.getAttribute("data-landed")).toMatch(
      /^(fade|static)$/
    )
    await waitFor(() => expect(reviewLine).toHaveAttribute("data-arrived"), {
      timeout: 3000,
    })
    await expect(
      await within(canvasElement.ownerDocument.body).findAllByText(
        "R1 · reviewer agent · agentic review · a3f9c2e"
      )
    ).not.toHaveLength(0)
  },
}

/** The provenance tooltip's state, on the review mark's trigger. */
function provenanceShown(mark: HTMLElement) {
  return waitFor(() =>
    expect(mark.getAttribute("data-state")).toMatch(/^(instant|delayed)-open$/)
  )
}

/**
 * Following the link again while the provenance is open: the press on the
 * link dismisses the tooltip, and the jump opens it again on arrival.
 */
export const GuidedHumanSuggestedUnlinkedTwice: Story = {
  args: {
    data: unlinkedSuggestedDeliveryDeskFixture,
    initialDeliveryStop: "guided",
  },
  play: async ({ canvasElement }) => {
    const card = await openWhy(canvasElement)
    const link = await within(card).findByRole("button", {
      name: "the agent’s review (R1, go to review)",
    })
    const mark = within(card).getByRole("button", {
      name: "R1, reviewer agent",
    })
    await userEvent.click(link)
    await waitFor(() => expect(mark).toHaveFocus())
    await provenanceShown(mark)
    await userEvent.click(link)
    await waitFor(() => expect(mark).toHaveFocus())
    await provenanceShown(mark)
    await expect(
      within(canvasElement.ownerDocument.body).getAllByText(
        "R1 · reviewer agent · agentic review · a3f9c2e"
      )[0]
    ).toBeVisible()
  },
}

/**
 * A short canvas (1100×520): the link sits behind the dock, so the press
 * scrolls the desk as it focuses the link, and the review line is then
 * already in view. That scroll is reported a frame late; it must not close
 * the provenance the jump opens. Each press is checked to have scrolled,
 * so the story fails rather than passes in a frame tall enough to hide it.
 */
async function followTwiceBelowTheFold(canvasElement: HTMLElement) {
  const card = await openWhy(canvasElement)
  const link = await within(card).findByRole("button", {
    name: "the agent’s review (R1, go to review)",
  })
  const mark = within(card).getByRole("button", {
    name: "R1, reviewer agent",
  })
  const desk = mainColumn(canvasElement)
  for (const press of [1, 2]) {
    if (press === 2) {
      // The reader scrolls back up: their scroll still closes it.
      desk.scrollTop = 0
      await waitFor(() => expect(mark).toHaveAttribute("data-state", "closed"))
    }
    const before = desk.scrollTop
    await userEvent.click(link)
    await expect(desk.scrollTop).toBeGreaterThan(before)
    await waitFor(() => expect(mark).toHaveFocus())
    await provenanceShown(mark)
    // Past the press's scroll events: still open.
    await new Promise((resolve) => requestAnimationFrame(resolve))
    await new Promise((resolve) => requestAnimationFrame(resolve))
    await expect(mark.getAttribute("data-state")).toMatch(
      /^(instant|delayed)-open$/
    )
  }
  await expect(
    within(canvasElement.ownerDocument.body).getAllByText(
      "R1 · reviewer agent · agentic review · a3f9c2e"
    )[0]
  ).toBeVisible()
}

export const GuidedHumanSuggestedUnlinkedTwiceShort: Story = {
  args: {
    data: unlinkedSuggestedDeliveryDeskFixture,
    initialDeliveryStop: "guided",
  },
  globals: { viewport: { value: "short", isRotated: false } },
  play: async ({ canvasElement }) => followTwiceBelowTheFold(canvasElement),
}

/** The same at reduced motion: no smooth scroll, the same arrival. */
export const GuidedHumanSuggestedUnlinkedTwiceShortReducedMotion: Story = {
  args: {
    data: unlinkedSuggestedDeliveryDeskFixture,
    initialDeliveryStop: "guided",
  },
  globals: {
    reducedMotion: "reduce",
    viewport: { value: "short", isRotated: false },
  },
  play: async ({ canvasElement }) => followTwiceBelowTheFold(canvasElement),
}

/**
 * Reduced motion: the jump arrives at once and the tint stays (no fade)
 * until the reader's next key or pointer press.
 */
export const GuidedHumanSuggestedUnlinkedReducedMotion: Story = {
  args: {
    data: unlinkedSuggestedDeliveryDeskFixture,
    initialDeliveryStop: "guided",
  },
  globals: { reducedMotion: "reduce" },
  play: async ({ canvasElement }) => {
    const card = await openWhy(canvasElement)
    const line = card.querySelector<HTMLElement>("[data-review-line]")!
    await userEvent.click(
      await within(card).findByRole("button", {
        name: "the agent’s review (R1, go to review)",
      })
    )
    await expect(line).toHaveAttribute("data-landed", "static")
    await waitFor(() => expect(line).toHaveAttribute("data-arrived"))
    // Longer than the full fade (275 + 825ms): still there.
    await pause(1400)
    await expect(line).toHaveAttribute("data-landed", "static")
    await userEvent.keyboard("{Shift}")
    await waitFor(() => expect(line).not.toHaveAttribute("data-landed"))
  },
}

/**
 * No recorded reviewer: the card shows the recorded words without a mark,
 * so the jump lands focus on the review line itself.
 */
export const GuidedHumanSuggestedUnlinkedNoReviewer: Story = {
  args: {
    data: unlinkedSuggestedNoReviewerDeskFixture,
    initialDeliveryStop: "guided",
  },
  play: async ({ canvasElement }) => {
    const card = await openWhy(canvasElement)
    await userEvent.click(
      await within(card).findByRole("button", {
        name: "the agent’s review (go to review)",
      })
    )
    const line = card.querySelector<HTMLElement>("[data-review-line]")!
    await waitFor(() => expect(line).toHaveFocus())
    await expect(line).toHaveAttribute("tabindex", "-1")
    await expect(within(card).queryByRole("button", { name: /R1/ })).toBeNull()
  },
}

export const GuidedHumanSuggestedUnlinkedDark: Story = {
  args: {
    data: unlinkedSuggestedDeliveryDeskFixture,
    initialDeliveryStop: "guided",
  },
  globals: { theme: "dark" },
  play: async ({ canvasElement }) => {
    const card = await openWhy(canvasElement)
    await visible(
      await within(card).findByRole("button", {
        name: "the agent’s review (R1, go to review)",
      })
    )
  },
}

/**
 * A Guided payload without a check is a contract error (Guided always has
 * a basis). This one offers Guided anyway: the desk logs it and shows the
 * flow with no card, and keeps the diff, so the page is never empty. There's
 * no suggested review.
 */
export const GuidedCheckMissing: Story = {
  args: {
    data: goDeliveryCheckMissingDeskFixture,
    initialDeliveryStop: "guided",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await visible(canvas.getByRole("region", { name: "How Commit changes" }))
    await waitFor(() =>
      expect(canvasElement.querySelector("diffs-container")).not.toBeNull()
    )
    await expect(
      canvas.queryByRole("region", {
        name: /^(Done when|Scope|Gathered scope):/,
      })
    ).toBeNull()
    await expect(
      canvas.queryByRole("region", { name: "Suggested review" })
    ).toBeNull()
    // No suggested review, so no suggested dock (its "Edit request").
    await expect(
      canvas.queryByRole("button", { name: "Edit request" })
    ).toBeNull()
  },
}

/**
 * Agentic review: the agent's review card says the verdict once ("R2
 * requested changes"); the check's rows follow as reasons, with no
 * suggested review; the dock says what it covers and offers Comment and
 * Request changes, never an approval (13.25).
 */
export const GuidedAgentic: Story = {
  args: {
    data: goDeliveryInLane("agentic-review"),
    initialDeliveryStop: "guided",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await visible(canvas.getByRole("region", { name: DONE_WHEN }))
    await saidOnce(canvasElement, /R2\s+requested changes/)
    await expect(canvas.queryByText(/Agent requested changes/)).toBeNull()
    await expect(canvas.getByText(/Covers 1 hunk/)).toBeInTheDocument()
    await visible(canvas.getByRole("button", { name: "Comment" }))
    await visible(canvas.getByRole("button", { name: "Request changes" }))
    await expect(
      canvas.queryByRole("button", { name: /^(Approve|Agree)/ })
    ).toBeNull()
    await expect(
      canvas.queryByRole("region", { name: "Suggested review" })
    ).toBeNull()
  },
}

/**
 * Static automation: no agent review; the dock shows the check's result,
 * once, with no action (13.25).
 */
export const GuidedStatic: Story = {
  args: {
    data: goDeliveryInLane("static-automation"),
    initialDeliveryStop: "guided",
  },
  play: async ({ canvasElement }) => {
    await visible(
      within(canvasElement).getByRole("region", { name: DONE_WHEN })
    )
    await saidOnce(canvasElement, /Passed static automation/)
    await expect(
      within(canvasElement).queryByRole("button", {
        name: /^(Approve|Agree|Comment|Request changes)/,
      })
    ).toBeNull()
  },
}

/** Human-required: the suggested review's mark is the column's one verdict. */
export const GuidedVerdictOnce: Story = {
  args: { initialDeliveryStop: "guided" },
  play: async ({ canvasElement }) => {
    await visible(
      within(canvasElement).getByRole("region", { name: "Suggested review" })
    )
    await saidOnce(canvasElement, /Suggested\s*·\s*request changes/)
  },
}

export const GuidedDark: Story = {
  args: { initialDeliveryStop: "guided" },
  globals: { theme: "dark" },
}

export const ExplainedDark: Story = { globals: { theme: "dark" } }

/** Reduced motion: layers only fade (150ms); no travel, height, pop or stagger. */
export const ReducedMotion: Story = {
  args: { initialDeliveryStop: "briefed" },
  globals: { reducedMotion: "reduce" },
}

export const GuidedPhone: Story = {
  args: { initialDeliveryStop: "guided" },
  globals: { viewport: { value: "phone", isRotated: false } },
}

export const ExplainedPhone: Story = {
  globals: { viewport: { value: "phone", isRotated: false } },
}

/**
 * The sent suggested review, as the card shows it with the reader known:
 * "You requested changes" with your avatar. (On the desk the screen doesn't
 * pass the reader yet, so it shows the words without an avatar.)
 */
export const SuggestedReviewSent: StoryObj = {
  render: () => (
    <CriteriaCardFrame
      dock={{ state: "changes-requested", origin: "suggestion" }}
    />
  ),
  play: async ({ canvasElement }) => {
    const card = within(canvasElement).getByRole("region", {
      name: "Suggested review",
    })
    await visible(card)
    const mark = card.querySelector<HTMLElement>(
      '[data-review-mark][data-sent="true"]'
    )!
    await expect(mark).toHaveTextContent("You requested changes")
    await expect(mark.querySelector('[data-avatar="person"]')).not.toBeNull()
  },
}

/* ── Only the stops a unit has ─────────────────────────────
 * A unit offers only the stops it has content for (the payload's
 * `stops`). The dial keeps its four places; a stop not offered is a
 * disabled radio the arrow keys skip. A reader whose default is Guided sees
 * the deepest stop the unit has below it; the setting itself is untouched.
 */

/** The reader's default is Guided, for every language. */
const GUIDED_DEFAULT = withDeliverySettings({
  workspaceDefault: "guided",
  byLanguage: {},
})

/**
 * Only Facts: a human-required unit no agent decided, as the owner's batch
 * carries it. It opens at Facts with its diff; the dial, open, offers Facts
 * alone, and arrow keys stay there.
 */
export const OnlyFacts: Story = {
  args: { data: noAgentDecisionDeskFixture },
  decorators: [GUIDED_DEFAULT],
  play: async ({ canvasElement }) => {
    const facts = await stopRadio(canvasElement, "facts")
    await expect(facts).toBeChecked()
    for (const stop of ["briefed", "explained", "guided"] as const)
      await expect(await stopRadio(canvasElement, stop)).toBeDisabled()
    await waitFor(() =>
      expect(canvasElement.querySelector("diffs-container")).not.toBeNull()
    )
    facts.focus()
    await userEvent.keyboard("{ArrowRight}")
    await expect(facts).toBeChecked()
    await expect(facts).toHaveFocus()
  },
}

/**
 * Facts plus Guided: an older review's unit. It opens at Guided with its
 * check in place of the diff; Briefed and Explained are disabled, so an
 * arrow key from Guided goes straight to Facts and back.
 */
export const FactsPlusGuided: Story = {
  args: { data: goDeliveryFactsGuidedDeskFixture },
  decorators: [GUIDED_DEFAULT],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const guided = await stopRadio(canvasElement, "guided")
    await expect(guided).toBeChecked()
    await expect(await stopRadio(canvasElement, "briefed")).toBeDisabled()
    await expect(await stopRadio(canvasElement, "explained")).toBeDisabled()
    await visible(canvas.getByRole("region", { name: DONE_WHEN }))
    await expect(canvasElement.querySelector("diffs-container")).toBeNull()
    guided.focus()
    await userEvent.keyboard("{ArrowLeft}")
    await expect(await stopRadio(canvasElement, "facts")).toBeChecked()
    await userEvent.keyboard("{ArrowRight}")
    await expect(await stopRadio(canvasElement, "guided")).toBeChecked()
  },
}
