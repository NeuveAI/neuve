import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"

import {
  AGENTIC_MESSAGE,
  BRIEFING_GAP_NOTE,
  CHECKOUT_BRIEFED,
  CHECKOUT_EXPLAINED,
  CHECKOUT_NOTE,
  CHECKOUT_READINGS,
  CITED_EXPLAINED,
  CITED_LEAD,
  CITED_PHRASES,
  IMPORTS_NOTE,
  LINE_58_CODE_BRIEFED,
  LOCATE_NOTES,
  PROBE_READING,
  PROJECTS_TEST_AFTERS,
  PROJECTS_TEST_BRIEFED,
  PROOF_DOES,
  RECORDS_TEST_READINGS,
  SECTION_MESSAGES,
  SHARED_CARRIED,
  agenticCheckedDeskFixture,
  allDecidedSectionsDeskFixture,
  carriedSectionsDeskFixture,
  briefedPerSectionDeskFixture,
  briefingGapDeskFixture,
  citedLeadDeskFixture,
  explainedOneSectionDeskFixture,
  guidedAllMissingDeskFixture,
  guidedProofRecordedDeskFixture,
  guidedUnansweredMissingDeskFixture,
  humanRequiredDecidedDeskFixture,
  mixedApprovesDeskFixture,
  mixedRequestsDeskFixture,
  unsureOneNoteDeskFixture,
  unsureTwoNotesDeskFixture,
} from "@workspace/ui/fixtures/redesigned-desk.fixtures"
import { DEFAULT_DELIVERY_SETTINGS } from "@workspace/ui/neuve/shared/delivery"
import { deskAt, deskMeta } from "@workspace/ui/neuve/story-kit/desk"
import type { DeskAt } from "@workspace/ui/neuve/story-kit/desk"
import { diffRoot } from "@workspace/ui/neuve/story-kit/dom"
import {
  chooseStop,
  pause,
  saidOnce,
  stopRadio,
  visible,
} from "@workspace/ui/neuve/story-kit/play"

/**
 * The review desk on a redesigned review, built like the owner's batch
 * "Share low-risk reads": units named by code, Facts by code, and the depth
 * content the readers lane restores. Every story's data is in
 * `fixtures/redesigned-desk.fixtures.ts`; the workspace default is Briefed.
 */
const meta = {
  title: "Screens/Review desk/Redesigned review",
  ...deskMeta(
    unsureOneNoteDeskFixture,
    {},
    {
      settings: DEFAULT_DELIVERY_SETTINGS,
    }
  ),
} satisfies Meta<typeof DeskAt>

export default meta
type Story = StoryObj<typeof meta>

const LINE = "No agent decision in this run"
const LINE_WORDS = /^No agent decision in this run$/
const DONE_WHEN = "Done when: Share low-risk reads"

/** `first` comes before `then` in reading order. */
const readsBefore = (first: Node, then: Node) =>
  expect(
    first.compareDocumentPosition(then) & Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy()

/** The note under "No agent decision": the line and it, in reading order. */
const noteFollowsLine = (canvasElement: HTMLElement, note: string) =>
  readsBefore(
    within(canvasElement).getByText(LINE),
    within(canvasElement).getByText(note)
  )

/** A Guided card's own rows (not the checkpoints' list at its foot). */
const rowsOf = (card: HTMLElement) =>
  Array.from(card.querySelector("ol")!.children) as Array<HTMLElement>

/** A row's pins that open their cited lines. */
const pinsOf = (row: HTMLElement) =>
  within(row).queryAllByRole("button", { expanded: false })

/**
 * A human-required unit no agent decided, of one section: under "No agent
 * decision in this run", what the agent was unsure of, as one sentence with
 * no title before it. It stays at every stop the unit offers.
 */
export const NoAgentDecisionOneNote: Story = {
  args: deskAt(unsureOneNoteDeskFixture),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await visible(canvas.getByText(CHECKOUT_NOTE))
    await noteFollowsLine(canvasElement, CHECKOUT_NOTE)
    await expect(canvas.getByText(CHECKOUT_NOTE).tagName).toBe("P")
    // At Guided too: the card, and the note still under the line.
    await chooseStop(canvasElement, "guided")
    await visible(await canvas.findByRole("region", { name: DONE_WHEN }))
    await visible(canvas.getByText(CHECKOUT_NOTE))
    await saidOnce(canvasElement, LINE_WORDS)
    // No agent decided it: the lane's plain dock, no suggested review.
    await expect(
      canvas.queryByRole("button", { name: "Edit request" })
    ).toBeNull()
    await expect(
      canvas.queryByRole("region", { name: "Suggested review" })
    ).toBeNull()
  },
}

/**
 * A human-required unit of two sections no agent decided: the two notes
 * are a plain list under the line, each led by its section's title.
 */
export const NoAgentDecisionTwoNotes: Story = {
  args: deskAt(unsureTwoNotesDeskFixture),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    for (const note of LOCATE_NOTES) {
      const item = canvas.getByText(note)
      await visible(item)
      await expect(item.tagName).toBe("LI")
      await noteFollowsLine(canvasElement, note)
    }
    await saidOnce(canvasElement, LINE_WORDS)
  },
}

/**
 * A human-required unit an agent decided: at Guided, its rows (done, not
 * done, no evidence), its checkpoints at the card's foot, and the suggested
 * review in the dock. No review card on human-required work.
 */
export const HumanRequiredDecided: Story = {
  args: deskAt(humanRequiredDecidedDeskFixture, { stop: "guided" }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await visible(canvas.getByRole("region", { name: DONE_WHEN }))
    await visible(canvas.getByRole("button", { name: /^Request changes/ }))
    await visible(canvas.getByRole("button", { name: "Edit request" }))
    await visible(canvas.getByRole("region", { name: "Suggested review" }))
    await expect(canvas.queryByText(LINE)).toBeNull()
    await expect(canvas.queryByText(/Agent requested changes/)).toBeNull()
  },
}

/**
 * Guided rows with their status, one of each (done, not done, no
 * evidence), and the unit's checkpoints, tied to no row, at the card's
 * foot.
 */
export const GuidedRowStatuses: Story = {
  args: deskAt(humanRequiredDecidedDeskFixture, { stop: "guided" }),
  play: async ({ canvasElement }) => {
    const card = within(canvasElement).getByRole("region", {
      name: DONE_WHEN,
    })
    await visible(card)
    for (const status of ["Done", "Not done", "No evidence"])
      await expect(within(card).getAllByText(status).length).toBeGreaterThan(0)
    const foot = card.querySelector<HTMLElement>(
      "[data-checkpoints-foot] summary"
    )!
    await expect(foot).toHaveTextContent("2 checkpoints")
    await expect(foot).toHaveTextContent("1 missing")
    // Rows written before proof states and readings show neither.
    for (const row of rowsOf(card)) {
      await expect(within(row).queryByText("Missing")).toBeNull()
      await expect(row.querySelector("[data-reading]")).toBeNull()
    }
  },
}

/* ── Guided rows without proof, and the agent's readings ── */

const SCOPE = "Scope: Share low-risk reads"

/**
 * The owner's case: no row of the checkout has proof recorded. Each keeps
 * its status, says Missing as the checkpoints do, and shows under its line
 * what the agent read in the changed lines, with those lines pinned once.
 */
export const GuidedAllMissing: Story = {
  args: deskAt(guidedAllMissingDeskFixture, { stop: "guided" }),
  play: async ({ canvasElement }) => {
    const card = within(canvasElement).getByRole("region", { name: SCOPE })
    await visible(card)
    const rows = rowsOf(card)
    await expect(rows).toHaveLength(3)
    for (const [i, row] of rows.entries()) {
      const at = within(row)
      await visible(at.getByText("No evidence"))
      await visible(at.getByText("Missing"))
      const reading = at.getByText(CHECKOUT_READINGS[i]!)
      await visible(reading)
      await readsBefore(at.getByText(PROOF_DOES.answeredMissing), reading)
      // The reading cites the row's own lines: one pin, under the words.
      const pins = pinsOf(row)
      await expect(pins).toHaveLength(1)
      await readsBefore(reading, pins[0]!)
    }
    // No heading or label names the reading.
    await expect(within(card).queryByText(/^Reading/)).toBeNull()
    const [pin] = pinsOf(rows[0]!)
    await userEvent.click(pin!)
    await expect(pin).toHaveAttribute("aria-expanded", "true")
    await visible(within(rows[0]!).getByText(/shared\.run/))
  },
}

/**
 * A file with no proof recorded: a row the review answered, with its
 * reading, and one it left unanswered. Both are Missing; the unanswered
 * one says so in code's words and shows no reading.
 */
export const GuidedUnansweredMissing: Story = {
  args: deskAt(guidedUnansweredMissingDeskFixture, { stop: "guided" }),
  play: async ({ canvasElement }) => {
    const card = within(canvasElement).getByRole("region", { name: SCOPE })
    await visible(card)
    const [answered, unanswered] = rowsOf(card)
    await visible(within(answered!).getByText(PROBE_READING))
    await visible(within(answered!).getByText("Missing"))
    await visible(within(unanswered!).getByText("Missing"))
    await visible(within(unanswered!).getByText(PROOF_DOES.unansweredMissing))
    await expect(unanswered!.querySelector("[data-reading]")).toBeNull()
  },
}

/**
 * A test file whose run is recorded: no row says Missing. A row left
 * unanswered shows the agent's reading; a row not met shows its own, with
 * the lines its evidence cites and the one the reading adds.
 */
export const GuidedProofRecorded: Story = {
  args: deskAt(guidedProofRecordedDeskFixture, { stop: "guided" }),
  play: async ({ canvasElement }) => {
    const card = within(canvasElement).getByRole("region", { name: SCOPE })
    await visible(card)
    await expect(within(card).queryByText("Missing")).toBeNull()
    const [unanswered, notMet] = rowsOf(card)
    await visible(within(unanswered!).getByText(PROOF_DOES.unansweredProven))
    await visible(
      within(unanswered!).getByText(RECORDS_TEST_READINGS.unanswered)
    )
    await visible(within(notMet!).getByText("Not covered"))
    await visible(within(notMet!).getByText(RECORDS_TEST_READINGS.notMet))
    await expect(pinsOf(notMet!)).toHaveLength(2)
  },
}

/**
 * An agentic unit an agent decided: its review card says what the agent
 * checked, never a proof line.
 */
export const AgenticReviewMessage: Story = {
  args: deskAt(agenticCheckedDeskFixture),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(await stopRadio(canvasElement, "briefed")).toBeChecked()
    await visible(canvas.getByText(AGENTIC_MESSAGE))
    await expect(canvas.queryByText(/^Proof/)).toBeNull()
    await expect(canvas.queryByText(LINE)).toBeNull()
  },
}

/* ── Each section's own verdict inside one unit ──────────── */

/**
 * The rows of a joined unit: one region per change, named by its title,
 * which is the row's own heading. The Guided card is a region too, with a
 * heading deeper inside it, so it is not counted.
 */
const changeRows = (canvasElement: HTMLElement) =>
  Array.from(
    canvasElement.querySelectorAll<HTMLElement>("section[aria-label]")
  ).filter((row) => row.querySelector(":scope > h2"))

/** The words an element shows, without what only screen readers hear. */
const seenText = (element: Element | null) => {
  if (!element) return undefined
  const copy = element.cloneNode(true) as Element
  for (const hidden of Array.from(copy.querySelectorAll(".sr-only")))
    hidden.remove()
  return copy.textContent
}

/** A row's suggestion, when an agent decided its change: the mark's words, and its message. */
const rowSuggestion = (row: HTMLElement) => {
  const suggestion = row.querySelector<HTMLElement>("[data-section-suggestion]")
  if (!suggestion) return undefined
  return {
    element: suggestion,
    mark: seenText(suggestion.querySelector("[data-review-mark]")),
    message: seenText(suggestion.querySelector("p:last-child")),
  }
}

/** The three rows of the shared-store unit once drawn at this stop. */
const threeRows = (canvasElement: HTMLElement) =>
  waitFor(() => {
    const rows = changeRows(canvasElement)
    expect(rows).toHaveLength(3)
    return rows as [HTMLElement, HTMLElement, HTMLElement]
  })

/** Each row says its state at the top of its body, before what it says of the change. */
const stateLeads = async (row: HTMLElement, claim: string) =>
  readsBefore(
    row.querySelector("[data-section-suggestion]")!,
    within(row).getByText(claim)
  )

/**
 * A human-required unit an agent decided only in part: the import's row
 * says "No agent decision in this run" with its note; locate's row says
 * "Suggested · request changes" and the agent's words for it;
 * openStore's says "Suggested · approve". Each row's state leads it, at
 * Briefed and at Facts. The header has no line of its own, since agents
 * decided some changes. At Guided, the unit's suggestion (the worst
 * verdict, written by the readers lane) is in the card and the dock; the
 * card keeps its mark but not the words the rows already say.
 */
export const MixedSectionVerdicts: Story = {
  args: deskAt(mixedRequestsDeskFixture),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(await stopRadio(canvasElement, "briefed")).toBeChecked()
    const [imports, locate, openStore] = await threeRows(canvasElement)
    await visible(within(imports).getByText(LINE))
    await visible(within(imports).getByText(IMPORTS_NOTE))
    await expect(rowSuggestion(imports)).toBeUndefined()
    const asks = rowSuggestion(locate)!
    await visible(asks.element)
    await expect(asks.mark).toBe("Suggested · request changes")
    await expect(asks.message).toBe(SECTION_MESSAGES.locate)
    await stateLeads(
      locate,
      "Callers locating one folder's store share one Git discovery; a folder with no repository now throws StoreNotFound."
    )
    const approves = rowSuggestion(openStore)!
    await expect(approves.mark).toBe("Suggested · approve")
    await expect(approves.message).toBe(SECTION_MESSAGES.openStore)
    // Only the import's row says no agent decided: never the header.
    await saidOnce(canvasElement, LINE_WORDS)
    // At Facts each decided row still says its suggestion, before its Facts.
    await chooseStop(canvasElement, "facts")
    await visible(
      await canvas.findByText(
        "locate in records.server.ts: 2 lines added and 1 removed."
      )
    )
    const atFacts = await threeRows(canvasElement)
    await expect(rowSuggestion(atFacts[1])?.mark).toBe(
      "Suggested · request changes"
    )
    await expect(rowSuggestion(atFacts[2])?.mark).toBe("Suggested · approve")
    await stateLeads(
      atFacts[1],
      "locate in records.server.ts: 2 lines added and 1 removed."
    )
    // At Guided, the unit's suggestion the readers lane wrote: its mark in
    // the card, and its words only on the rows, said once.
    await chooseStop(canvasElement, "guided")
    const card = await canvas.findByRole("region", { name: "Suggested review" })
    await visible(card)
    await expect(card.querySelector("[data-review-mark]")?.textContent).toBe(
      "Suggested · request changes"
    )
    await expect(within(card).queryByText(/Checked:/)).toBeNull()
    await waitFor(() =>
      expect(canvas.getAllByText(SECTION_MESSAGES.locate)).toHaveLength(1)
    )
    await visible(canvas.getByRole("button", { name: "Edit request" }))
  },
}

/**
 * A mixed unit whose decided changes all approve: each says "Suggested ·
 * approve" on its row, and the unit has no suggestion of its own, so at
 * Guided the dock offers the plain Approve and Request changes and the card
 * suggests nothing.
 */
export const MixedSectionsApprove: Story = {
  args: deskAt(mixedApprovesDeskFixture, { stop: "guided" }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await visible(canvas.getByRole("region", { name: DONE_WHEN }))
    const [imports, locate, openStore] = await threeRows(canvasElement)
    await expect(rowSuggestion(imports)).toBeUndefined()
    await expect(rowSuggestion(locate)?.mark).toBe("Suggested · approve")
    await expect(rowSuggestion(openStore)?.mark).toBe("Suggested · approve")
    await expect(
      canvas.queryByRole("region", { name: "Suggested review" })
    ).toBeNull()
    await expect(
      canvas.queryByRole("button", { name: "Edit request" })
    ).toBeNull()
    await visible(canvas.getByRole("button", { name: /^Approve/ }))
    await saidOnce(canvasElement, LINE_WORDS)
  },
}

/**
 * The same unit with every change decided: each row leads with its
 * suggestion, no "No agent decision" line shows anywhere, and the unit's
 * own suggestion stands in the Guided card and the dock, as before.
 */
export const AllSectionsDecided: Story = {
  args: deskAt(allDecidedSectionsDeskFixture),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const rows = await threeRows(canvasElement)
    await expect(rows.map((row) => rowSuggestion(row)?.mark)).toEqual([
      "Suggested · approve",
      "Suggested · request changes",
      "Suggested · approve",
    ])
    await expect(rowSuggestion(rows[0])?.message).toBe(SECTION_MESSAGES.imports)
    await expect(canvas.queryByText(LINE)).toBeNull()
    await chooseStop(canvasElement, "guided")
    await visible(
      await canvas.findByRole("region", { name: "Suggested review" })
    )
    await visible(canvas.getByRole("button", { name: "Edit request" }))
  },
}

/**
 * A unit carried unchanged from an earlier review, its rows each saying
 * their own suggestion: the Guided card keeps the line that says it was
 * carried, once, and leaves out the words the rows say. "Edit request"
 * opens the composer with the carried line and the agent's words, as
 * before.
 */
export const CarriedSectionVerdicts: Story = {
  args: deskAt(carriedSectionsDeskFixture, { stop: "guided" }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const card = await canvas.findByRole("region", {
      name: "Suggested review",
    })
    await visible(card)
    await expect(within(card).getByText(SHARED_CARRIED)).toBeVisible()
    await expect(within(card).queryByText(/Checked:/)).toBeNull()
    await waitFor(() =>
      expect(canvas.getAllByText(SHARED_CARRIED)).toHaveLength(1)
    )
    await waitFor(() =>
      expect(canvas.getAllByText(SECTION_MESSAGES.locate)).toHaveLength(1)
    )
    await userEvent.click(canvas.getByRole("button", { name: "Edit request" }))
    const draft = await waitFor(() => {
      const found =
        canvasElement.querySelector<HTMLTextAreaElement>("#dock-comment")
      if (!found) throw new Error("the composer is not open")
      return found
    })
    await expect(draft.value.startsWith(`${SHARED_CARRIED}\n\nChecked:`)).toBe(
      true
    )
  },
}

/**
 * An agentic unit of two changes, decided whole: its review card says
 * what the agent checked, once, and its rows carry no suggestion of their
 * own. Nothing waits on a person, so they would say the card again.
 */
export const AgenticSectionsDecided: Story = {
  args: deskAt(agenticCheckedDeskFixture),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const rows = await waitFor(() => {
      const found = changeRows(canvasElement)
      expect(found).toHaveLength(2)
      return found
    })
    for (const row of rows) await expect(rowSuggestion(row)).toBeUndefined()
    await expect(canvas.getAllByText(AGENTIC_MESSAGE)).toHaveLength(1)
    await expect(
      canvasElement.querySelector("[data-section-suggestion]")
    ).toBeNull()
  },
}

/* ── Briefed and Explained from the briefing step ────────── */

/** The terms on screen, by their words: each `dt` the briefing lists. */
const termsShown = (canvasElement: HTMLElement) =>
  Array.from(canvasElement.querySelectorAll("dt")).map(
    (term) => term.textContent
  )

/**
 * Briefed written by the briefing step, per change: each of the five rows
 * says its own claim, and the change the briefing left to code reads in
 * code's words.
 */
export const BriefedPerSection: Story = {
  args: deskAt(briefedPerSectionDeskFixture),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(await stopRadio(canvasElement, "briefed")).toBeChecked()
    const rows = changeRows(canvasElement)
    await expect(rows).toHaveLength(PROJECTS_TEST_BRIEFED.length)
    for (const [i, claim] of PROJECTS_TEST_BRIEFED.entries()) {
      const said = canvas.getByText(claim)
      await visible(said)
      await expect(rows[i]).toContainElement(said)
    }
  },
}

/**
 * Explained per change: five rows, each its change's Before beside its
 * After, and no Explained of the unit's own. A term two changes explain is
 * listed once.
 */
export const ExplainedPerSection: Story = {
  args: deskAt(briefedPerSectionDeskFixture, { stop: "explained" }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(await stopRadio(canvasElement, "explained")).toBeChecked()
    const rows = changeRows(canvasElement)
    await expect(rows).toHaveLength(PROJECTS_TEST_AFTERS.length)
    for (const [i, after] of PROJECTS_TEST_AFTERS.entries()) {
      const said = canvas.getByText(after)
      await visible(said)
      await expect(rows[i]).toContainElement(said)
    }
    await expect(termsShown(canvasElement)).toEqual([
      "sharedWork",
      "probeCache",
    ])
  },
}

/**
 * Explained on the checkout, a human-required unit of one change: its
 * change's Before and After are the unit's, with its term, and the note
 * on why no agent decided it stays under its line.
 */
export const ExplainedOneSection: Story = {
  args: deskAt(explainedOneSectionDeskFixture, { stop: "explained" }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(await stopRadio(canvasElement, "explained")).toBeChecked()
    await visible(canvas.getByText(CHECKOUT_EXPLAINED.before))
    await visible(canvas.getByText(CHECKOUT_EXPLAINED.after))
    await expect(termsShown(canvasElement)).toEqual(["shared.run"])
    await noteFollowsLine(canvasElement, CHECKOUT_NOTE)
    await saidOnce(canvasElement, LINE_WORDS)
    // At Briefed, the change's Briefed is the unit's.
    await chooseStop(canvasElement, "briefed")
    await visible(await canvas.findByText(CHECKOUT_BRIEFED))
  },
}

/**
 * A briefing gap: the unit's briefing failed. Asked for Explained, it shows
 * Briefed, in code's words, with the gap's line; Explained isn't offered.
 * At Facts the gap's line stays, beside code's Facts.
 */
export const BriefingGap: Story = {
  args: deskAt(briefingGapDeskFixture, { stop: "explained" }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(await stopRadio(canvasElement, "briefed")).toBeChecked()
    await expect(await stopRadio(canvasElement, "explained")).toBeDisabled()
    await visible(canvas.getByText(BRIEFING_GAP_NOTE))
    await visible(canvas.getByText(LINE_58_CODE_BRIEFED))
    await visible(
      canvas.getByText("imports in records.server.ts: 2 lines added.")
    )
    await chooseStop(canvasElement, "facts")
    await visible(
      await canvas.findByText("records.server.ts at line 58: 4 lines added.")
    )
    // Once the stop has settled, the gap's line is said once.
    await waitFor(() =>
      expect(
        Array.from(canvasElement.querySelectorAll("p")).filter(
          (line) => line.textContent === BRIEFING_GAP_NOTE
        )
      ).toHaveLength(1)
    )
    await visible(canvas.getByText(BRIEFING_GAP_NOTE))
  },
}

/* ── Cited phrases and their markers ─────────────────────── */

/**
 * A paragraph's links and chips in reading order, by what each names: a
 * phrase by its words, a chip by its accessible name.
 */
const citedOrder = (paragraph: Element) =>
  Array.from(paragraph.querySelectorAll("a, button")).map((element) =>
    element.tagName === "A"
      ? (element.firstChild?.textContent ?? "")
      : (element.getAttribute("aria-label") ?? "")
  )

/**
 * The lines a landing tints in the diff (new side), with the phase each
 * shows ("a"/"b" fading, "static" under reduced motion).
 */
const landedLines = (root: ShadowRoot) => {
  const rows = Array.from(
    root.querySelectorAll<HTMLElement>(
      "[data-content] [data-line][data-overlay-land]"
    )
  ).filter((row) => row.getAttribute("data-line-type") !== "change-deletion")
  return {
    lines: [...new Set(rows.map((row) => Number(row.dataset.line)))].sort(
      (a, b) => a - b
    ),
    phases: [...new Set(rows.map((row) => row.dataset.overlayLand))],
  }
}

/** locate's owned lines, where its phrases and the checkpoint's pin land. */
const LOCATE_LANDED = [6, 7]

/** Waits for a landing on exactly `lines`, in one of `phases`. */
const landsOn = (root: ShadowRoot, lines: Array<number>, phases: RegExp) =>
  waitFor(
    () => {
      const landed = landedLines(root)
      expect(landed.lines).toEqual(lines)
      expect(landed.phases.every((phase) => phases.test(phase ?? ""))).toBe(
        true
      )
    },
    { timeout: 4000, interval: 30 }
  )

// The checkpoint chip says its state in the margin pin's word.
const CHECKPOINT_CHIP =
  "Checkpoint, A failed discovery is not cached; the next caller retries, missing"
const SAME_BATCH_CHIP = "Same batch, checkout in projects.ts"

/**
 * The unit's own Briefed leads: each phrase is linked to its lines and
 * followed by the chip of the pin over them, a missing checkpoint after
 * locate's and the same-batch reference after openStore's, as in the
 * target. Each chip is shown once: the rows' phrases over those pins are
 * plain links, and only openStore's phrase naming the same-batch reference
 * itself is followed by its chip. The checkpoint's chip shows its margin
 * pin's state icon (the missing-proof dashed circle); the same-batch chip
 * keeps its kind's. Clicking a phrase lands on its lines and tints them,
 * then the tint fades, exactly as the checkpoint chip's jump tints them.
 */
export const CitedLead: Story = {
  args: deskAt(citedLeadDeskFixture),
  play: async ({ canvasElement }) => {
    await expect(await stopRadio(canvasElement, "briefed")).toBeChecked()
    const lead = within(canvasElement)
      .getByRole("link", { name: new RegExp(CITED_LEAD.locate) })
      .closest("p")!
    await visible(lead)
    await expect(citedOrder(lead)).toEqual([
      CITED_LEAD.locate,
      CHECKPOINT_CHIP,
      CITED_LEAD.openStore,
      SAME_BATCH_CHIP,
    ])
    await expect(lead.textContent).not.toMatch(/[[\]]/)
    const rows = changeRows(canvasElement)
    await expect(rows).toHaveLength(2)
    await expect(citedOrder(rows[0]!)).toEqual(CITED_PHRASES.locate)
    await expect(citedOrder(rows[1]!)).toEqual([
      CITED_PHRASES.openStore[0],
      CITED_PHRASES.openStore[1],
      SAME_BATCH_CHIP,
    ])
    // The chip draws the very icon the margin's pin for that checkpoint
    // draws: the missing state's, not the checkpoint kind's.
    const pin = await waitFor(() => {
      const found = canvasElement.querySelector(
        "[data-checkpoint-mark][data-proof='missing'] svg"
      )
      if (!found) throw new Error("the checkpoint's margin pin is not drawn")
      return found
    })
    const checkpointChip = within(lead).getByRole("button", {
      name: CHECKPOINT_CHIP,
    })
    await expect(checkpointChip).toHaveAttribute("data-proof", "missing")
    await expect(checkpointChip.querySelector("svg")?.innerHTML).toBe(
      pin.innerHTML
    )
    const sameBatchChip = within(lead).getByRole("button", {
      name: SAME_BATCH_CHIP,
    })
    await expect(sameBatchChip).not.toHaveAttribute("data-proof")
    await expect(sameBatchChip.querySelector("svg")?.innerHTML).not.toBe(
      pin.innerHTML
    )
    // The phrase's landing tints locate's lines, then fades.
    const root = await diffRoot(canvasElement)
    await userEvent.click(
      within(lead).getByRole("link", { name: new RegExp(CITED_LEAD.locate) })
    )
    await landsOn(root, LOCATE_LANDED, /^[ab]$/)
    await waitFor(() => expect(landedLines(root).lines).toEqual([]), {
      timeout: 3000,
    })
    // The checkpoint chip's jump tints the very same lines.
    await userEvent.click(checkpointChip)
    await landsOn(root, LOCATE_LANDED, /^[ab]$/)
  },
}

/**
 * Reduced motion (the toolbar): a cited phrase's landing tints its lines
 * without a fade, and the tint stays until the reader's next key or
 * pointer press.
 */
export const CitedLeadReducedMotion: Story = {
  args: deskAt(citedLeadDeskFixture),
  globals: { reducedMotion: "reduce" },
  play: async ({ canvasElement }) => {
    const root = await diffRoot(canvasElement)
    const phrase = within(canvasElement).getByRole("link", {
      name: new RegExp(CITED_LEAD.locate),
    })
    await visible(phrase)
    await userEvent.click(phrase)
    await landsOn(root, LOCATE_LANDED, /^static$/)
    // Longer than the full fade (275 + 825ms): still there.
    await pause(1400)
    await expect(landedLines(root).lines).toEqual(LOCATE_LANDED)
    await userEvent.keyboard("{Shift}")
    await waitFor(() => expect(landedLines(root).lines).toEqual([]))
  },
}

/**
 * At Explained, each change's Before beside its After, plain, and under
 * them its "↳" line: its Briefed phrases, then the one its After linked,
 * phrases only, as the briefing showed them before.
 */
export const CitedExplained: Story = {
  args: deskAt(citedLeadDeskFixture, { stop: "explained" }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(await stopRadio(canvasElement, "explained")).toBeChecked()
    const rows = changeRows(canvasElement)
    await expect(rows).toHaveLength(2)
    for (const [i, explained] of [
      CITED_EXPLAINED.locate,
      CITED_EXPLAINED.openStore,
    ].entries()) {
      const after = canvas.getByText(explained.after)
      await visible(after)
      await expect(rows[i]).toContainElement(after)
      await expect(rows[i]!.textContent).not.toMatch(/[[\]]/)
    }
    const arrowLine = (row: HTMLElement) =>
      row.querySelector("p:has(> svg[aria-hidden='true'])")!
    await expect(citedOrder(arrowLine(rows[0]!))).toEqual([
      ...CITED_PHRASES.locate,
      "share one look-up",
    ])
    await expect(citedOrder(arrowLine(rows[1]!))).toEqual(
      CITED_PHRASES.openStore
    )
    // A "↳" phrase lands on its lines and tints them, as the lead's do.
    const root = await diffRoot(canvasElement)
    await userEvent.click(
      within(arrowLine(rows[0]!) as HTMLElement).getByRole("link", {
        name: new RegExp(CITED_PHRASES.locate[0]!),
      })
    )
    await landsOn(root, LOCATE_LANDED, /^[ab]$/)
  },
}
