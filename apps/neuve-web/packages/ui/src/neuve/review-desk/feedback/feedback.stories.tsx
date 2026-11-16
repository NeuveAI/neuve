import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { realPacketDeskFixtures } from "@workspace/ui/fixtures/real-packet.fixtures"
import { commentMarkerKey } from "@workspace/ui/neuve/review-comments/markers"
import { DEFAULT_DELIVERY_SETTINGS } from "@workspace/ui/neuve/shared/delivery"
import type { DeskAt } from "@workspace/ui/neuve/story-kit/desk"
import { deskAt, deskMeta } from "@workspace/ui/neuve/story-kit/desk"
import { storyFeedbackSink } from "@workspace/ui/neuve/story-kit/feedback"
import type { DecisionSink } from "@workspace/ui/neuve/review-desk/atoms"
import { pause, visible } from "@workspace/ui/neuve/story-kit/play"
import { linePinWith } from "@workspace/ui/neuve/story-kit/dom"
import type {
  DeskFeedback,
  FeedbackSubmission,
  ReviewDeskData,
  ReviewLane,
} from "@workspace/ui/neuve/types"

/**
 * Feedback in the desk (10.100, M5 S7) on the real packet: "Give feedback"
 * beside the lane label, "Give feedback" on a context reference's card (its
 * grade and the note's rubric, 10.107), a judgement on the agent's finding
 * and a rubric under each digest. The BFF sends a desk its
 * feedback only while the owner's setting is on, so "setting off" is the
 * desk without it. Every story records to an in-memory sink.
 */
const desks = Object.values(realPacketDeskFixtures)
const inLane = (lane: ReviewLane): ReviewDeskData =>
  desks.find((desk) => desk.unit.lane === lane) ?? desks[0]!
/** A desk's first reference, the first row of its first line's list. */
const firstReference = (desk: ReviewDeskData) =>
  desk.files[0]?.markerAnchors[0]?.markerKey ?? ""
/**
 * The human-required unit whose first reference the harness graded
 * Necessary, so the reference stories answer with another grade.
 */
const required =
  desks.find(
    (desk) =>
      desk.unit.lane === "human-required" &&
      desk.feedback?.references[firstReference(desk)]?.harnessGrade ===
        "necessary"
  ) ?? inLane("human-required")
const suggested = inLane("human-suggested")
const withFinding =
  desks.find((desk) => Object.keys(desk.feedback?.findings ?? {}).length > 0) ??
  desks[0]!
const findingId = Object.keys(withFinding.feedback?.findings ?? {})[0] ?? ""
const referenceKey = firstReference(required)

/** The required unit with an answer already recorded on its first reference. */
const answered = (feedback: DeskFeedback): DeskFeedback => ({
  ...feedback,
  references: {
    ...feedback.references,
    [referenceKey]: {
      ...feedback.references[referenceKey]!,
      saved: {
        eventId: "01M5S7STORY000000000000001",
        at: "2026-10-22T14:00:00.000Z",
        answer: {
          on: "reference",
          grade: "useful",
          note: "Points at the right check, though the code shows it.",
        },
      },
    },
  },
})
const requiredAnswered: ReviewDeskData = {
  ...required,
  feedback: answered(required.feedback!),
}

const meta = {
  title: "Screens/Real packet/Feedback",
  ...deskMeta(required, {}, { settings: DEFAULT_DELIVERY_SETTINGS }),
} satisfies Meta<typeof DeskAt>

export default meta
type Story = StoryObj<typeof meta>

/** The desk as the BFF sends it with the setting on: its feedback, and a sink. */
const on = () => ({ feedbackSink: storyFeedbackSink() })

/** The same desk with the setting off: the BFF sends no feedback. */
const { feedback: _feedback, ...requiredOff } = required

const page = () => within(document.body)

/** The open context card, once its entrance has settled. */
const openCard = () =>
  waitFor(() => {
    const card = document.querySelector<HTMLElement>("[data-context-card]")
    expect(card).toBeVisible()
    return card!
  })

/** "Give feedback" on the open card, then its layer's form. */
async function openReferenceLayer() {
  const card = await openCard()
  await userEvent.click(
    within(card).getByRole("button", { name: /^Give feedback/ })
  )
  return waitFor(() =>
    page().getByRole("form", { name: "Feedback on this reference" })
  )
}

/** The layer closed, and the card's chip says its answer is saved. */
async function expectChipSaved() {
  await waitFor(() =>
    expect(
      page().queryByRole("form", { name: "Feedback on this reference" })
    ).toBeNull()
  )
  const card = await openCard()
  await expect(
    within(card).getByRole("button", { name: "Give feedback, saved" })
  ).toBeVisible()
}

/** The setting off (the default): the desk shows no feedback controls. */
export const SettingOff: Story = {
  args: { ...deskAt(requiredOff), ...on() },
  play: async ({ canvas }) => {
    await visible(
      canvas.getByRole("heading", { level: 1, name: required.unit.title })
    )
    await expect(
      canvas.queryByRole("button", { name: /Give feedback/ })
    ).toBeNull()
    await expect(
      canvas.queryByRole("button", { name: /Rate the .* digest/ })
    ).toBeNull()
  },
}

/** The setting on: "Give feedback" beside the lane label, and the digest's rubric. */
export const SettingOn: Story = {
  args: { ...deskAt(required), ...on() },
  play: async ({ canvas }) => {
    await visible(canvas.getByRole("button", { name: /^Give feedback/ }))
    await visible(
      canvas.getByRole("button", { name: "Rate the Briefed digest" })
    )
  },
}

/** Feedback on a unit: complexity, ease of validation, lane and verdict. */
export const UnitCall: Story = {
  args: { ...deskAt(required), ...on() },
  play: async ({ canvas }) => {
    await userEvent.click(
      canvas.getByRole("button", { name: /^Give feedback/ })
    )
    const form = await waitFor(() =>
      page().getByRole("form", { name: "Feedback on this unit" })
    )
    const scale = within(form)
    await userEvent.click(scale.getByRole("radio", { name: "High" }))
    await userEvent.click(scale.getByRole("radio", { name: "Hard" }))
    await userEvent.click(scale.getByRole("radio", { name: "Human-required" }))
    await userEvent.click(scale.getByRole("radio", { name: "Request changes" }))
    await userEvent.click(scale.getByRole("button", { name: "Save" }))
    await waitFor(() =>
      expect(
        page().getByText(
          "High complexity · Hard to validate · Human-required · Request changes"
        )
      ).toBeVisible()
    )
  },
}

/** A grade on a context reference, placed between two grades (10.98). */
export const ReferenceGrade: Story = {
  args: { ...deskAt(required, { open: referenceKey }), ...on() },
  play: async () => {
    const form = await openReferenceLayer()
    const scale = within(form)
    await userEvent.click(scale.getByRole("radio", { name: "Useful" }))
    const between = await waitFor(() =>
      scale.getByRole("group", { name: "Between it and" })
    )
    await userEvent.click(
      within(between).getByRole("radio", { name: "Necessary" })
    )
    await userEvent.click(scale.getByRole("button", { name: "Save" }))
    await expectChipSaved()
    // Reopened, the layer reads the saved answer.
    await userEvent.click(
      page().getByRole("button", { name: "Give feedback, saved" })
    )
    await waitFor(() =>
      expect(page().getByText("Useful · between necessary")).toBeVisible()
    )
  },
}

const rubricFeedback: Array<FeedbackSubmission> = []

/**
 * The note's rubric by pointer (10.107): the harness's grade is marked on
 * its option (and never sent: the BFF reads it from the packet), each row
 * is answered, and Save closes the layer. The chip
 * shows a check, the line's pin counts the rated reference, and the line's
 * list shows the answer under the reference's reason.
 */
export const ReferenceRubric: Story = {
  args: {
    ...deskAt(required, { open: referenceKey }),
    feedbackSink: storyFeedbackSink({
      record: (submission) => rubricFeedback.push(submission),
    }),
  },
  play: async ({ canvasElement }) => {
    rubricFeedback.length = 0
    const form = await openReferenceLayer()
    const fields = within(form)
    const grade = within(
      fields.getByRole("group", { name: "This reference is" })
    )
    // The tag reads after the harness's option; the layer has faded in.
    await waitFor(() =>
      expect(
        grade.getByRole("radio", { name: "Necessary (the harness's grade)" })
      ).toBeVisible()
    )
    await userEvent.click(grade.getByRole("radio", { name: "Useful" }))
    const row = async (legend: string, answer: string) =>
      userEvent.click(
        within(fields.getByRole("group", { name: legend })).getByRole("radio", {
          name: answer,
        })
      )
    await row("Says why it's here", "Yes")
    await row("Tied to these lines", "No")
    await row("Check is actionable", "Yes")
    await row("Accurate", "Yes")
    await row("Length", "Right")
    await userEvent.click(fields.getByRole("button", { name: "Save" }))
    await expectChipSaved()
    await expect(rubricFeedback).toEqual([
      {
        on: "reference",
        target: referenceKey,
        harnessCallVisible: true,
        grade: "useful",
        saysWhy: "yes",
        tiedToLines: "no",
        checkActionable: "yes",
        accurate: "yes",
        length: "right",
      },
    ])
    // The line's pin counts what is rated.
    const pin = linePinWith(canvasElement, referenceKey)
    await waitFor(() => expect(pin).toHaveTextContent("1 rated"))
    await expect(pin.getAttribute("aria-label")).toMatch(/, 1 rated$/)
    // Back to the line's list: the answer sits under the reason, only what
    // is off after the grade.
    // The layer has handed focus back to its chip; Escape closes the card.
    await waitFor(() =>
      expect(
        page().getByRole("button", { name: "Give feedback, saved" })
      ).toHaveFocus()
    )
    await userEvent.keyboard("{Escape}")
    await waitFor(() =>
      expect(document.querySelector("[data-context-card]")).toBeNull()
    )
    await userEvent.click(pin)
    const list = await waitFor(() =>
      page().getByRole("group", { name: /markers on line/ })
    )
    await waitFor(() =>
      expect(
        within(list).getByText("Useful · not tied to these lines")
      ).toBeVisible()
    )
  },
}

const keyboardFeedback: Array<FeedbackSubmission> = []

/**
 * The same by keyboard: F opens the layer for the open card, 2 picks
 * Useful, Tab and the arrow keys answer rows, ⌘↵ saves and closes, and
 * focus returns to something in view. Rows left unanswered are not sent:
 * blank, never yes.
 */
export const ReferenceRubricKeyboard: Story = {
  args: {
    ...deskAt(required),
    feedbackSink: storyFeedbackSink({
      record: (submission) => keyboardFeedback.push(submission),
    }),
  },
  play: async ({ canvasElement }) => {
    keyboardFeedback.length = 0
    // From the line's pin: Enter opens its list, Enter on the first row
    // opens that reference's card, with focus inside it.
    const pin = await waitFor(() => {
      const found = linePinWith(canvasElement, referenceKey)
      expect(found).toBeVisible()
      return found
    })
    // The desk settles its own focus as it mounts: focus the pin once it has.
    await waitFor(() => {
      pin.focus()
      expect(pin).toHaveFocus()
    })
    await userEvent.keyboard("{Enter}")
    const list = await waitFor(
      () => page().getByRole("group", { name: /markers on line/ }),
      { timeout: 3000 }
    )
    await waitFor(() =>
      expect(list.contains(document.activeElement)).toBe(true)
    )
    await userEvent.keyboard("{Enter}")
    const card = await openCard()
    await waitFor(() =>
      expect(card.contains(document.activeElement)).toBe(true)
    )
    await userEvent.keyboard("f")
    const form = await waitFor(() =>
      page().getByRole("form", { name: "Feedback on this reference" })
    )
    const fields = within(form)
    await waitFor(() =>
      expect(
        fields.getByRole("radio", { name: "Necessary (the harness's grade)" })
      ).toHaveFocus()
    )
    await userEvent.keyboard("2")
    await expect(fields.getByRole("radio", { name: "Useful" })).toBeChecked()
    // Tab past the in-between grade to "Says why it's here": Space answers
    // Yes; Tab to "Tied to these lines", and the arrow answers No.
    await userEvent.tab()
    await userEvent.tab()
    await expect(
      within(
        fields.getByRole("group", { name: "Says why it's here" })
      ).getByRole("radio", { name: "Yes" })
    ).toHaveFocus()
    await userEvent.keyboard(" ")
    await userEvent.tab()
    await userEvent.keyboard("{ArrowRight}")
    await expect(
      within(
        fields.getByRole("group", { name: "Tied to these lines" })
      ).getByRole("radio", { name: "No" })
    ).toBeChecked()
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}")
    await expectChipSaved()
    await expect(keyboardFeedback).toEqual([
      {
        on: "reference",
        target: referenceKey,
        harnessCallVisible: true,
        grade: "useful",
        saysWhy: "yes",
        tiedToLines: "no",
      },
    ])
    // Focus returns to something in view: the chip when it shows, else
    // where F was pressed (this card is taller than its box).
    await expectFocusVisibleInCard()
  },
}

/** Feedback off: the card shows no chip and no harness's grade, the pin no count. */
export const ReferenceSettingOff: Story = {
  args: { ...deskAt(requiredOff, { open: referenceKey }), ...on() },
  play: async ({ canvasElement }) => {
    const card = await openCard()
    await expect(within(card).getByText("Before you decide")).toBeVisible()
    await expect(
      within(card).queryByRole("button", { name: /Give feedback/ })
    ).toBeNull()
    await expect(within(card).queryByText(/Harness grade/)).toBeNull()
    await userEvent.keyboard("f")
    await expect(
      page().queryByRole("form", { name: "Feedback on this reference" })
    ).toBeNull()
    await expect(
      linePinWith(canvasElement, referenceKey)
    ).not.toHaveTextContent(/rated/)
  },
}

/** A correction: the saved grade, "Change", and a new answer that replaces it. */
export const ReferenceCorrection: Story = {
  args: { ...deskAt(requiredAnswered, { open: referenceKey }), ...on() },
  play: async () => {
    const card = await openCard()
    await userEvent.click(
      within(card).getByRole("button", { name: "Give feedback, saved" })
    )
    await visible(await waitFor(() => page().getByText("Useful")))
    await userEvent.click(page().getByRole("button", { name: "Change" }))
    const form = await waitFor(() =>
      page().getByRole("form", { name: "Feedback on this reference" })
    )
    const scale = within(
      within(form).getByRole("group", { name: "This reference is" })
    )
    await expect(scale.getByRole("radio", { name: "Useful" })).toBeChecked()
    await userEvent.click(scale.getByRole("radio", { name: "Irrelevant" }))
    await userEvent.click(within(form).getByRole("button", { name: "Save" }))
    await expectChipSaved()
    await userEvent.click(
      page().getByRole("button", { name: "Give feedback, saved" })
    )
    await waitFor(() => expect(page().getByText("Irrelevant")).toBeVisible())
  },
}

/** Valid, invalid or unsure, on the agent's finding in its thread. */
export const FindingJudgement: Story = {
  args: {
    ...deskAt(withFinding, {
      comments: withFinding.commentRecords ?? [],
      open: commentMarkerKey(findingId),
    }),
    ...on(),
  },
  play: async () => {
    // The thread is placed once its lines are in view: bring them there.
    const form = await waitFor(
      () => {
        const thread = document.querySelector("[data-thread-card]")
        const scroller = document.querySelector("[data-desk-scroll]")
        const top = thread?.getBoundingClientRect().top ?? 0
        if (scroller && top > 480) scroller.scrollTop += top - 240
        return page().getByRole("form", { name: "Feedback on this finding" })
      },
      { timeout: 5000 }
    )
    await userEvent.click(within(form).getByRole("radio", { name: "Valid" }))
    await userEvent.click(within(form).getByRole("button", { name: "Save" }))
    await waitFor(() => expect(page().getByText("Valid")).toBeVisible())
  },
}

/** The rubric under the Briefed digest. */
export const DigestRubric: Story = {
  args: { ...deskAt(suggested), ...on() },
  play: async ({ canvas }) => {
    await userEvent.click(
      canvas.getByRole("button", { name: "Rate the Briefed digest" })
    )
    const form = await waitFor(() =>
      page().getByRole("form", { name: "Feedback on the Briefed digest" })
    )
    const fields = within(form)
    const accurate = within(fields.getByRole("group", { name: "Accurate" }))
    await userEvent.click(accurate.getByRole("radio", { name: "Yes" }))
    const complete = within(fields.getByRole("group", { name: "Complete" }))
    await userEvent.click(complete.getByRole("radio", { name: "No" }))
    await userEvent.type(
      fields.getByRole("textbox", { name: "Note" }),
      "Needs the wider context of the batch."
    )
    await userEvent.click(fields.getByRole("button", { name: "Save" }))
    await waitFor(() =>
      expect(page().getByText("Accurate · Incomplete")).toBeVisible()
    )
  },
}

/** At Guided, the Guided digest gets its own rubric under its rows. */
export const GuidedRubrics: Story = {
  args: { ...deskAt(required, { stop: "guided" }), ...on() },
  play: async ({ canvas }) => {
    await visible(
      canvas.getByRole("button", { name: "Rate the Briefed digest" })
    )
    await visible(
      canvas.getByRole("button", { name: "Rate the Guided digest" })
    )
  },
}

/** Nothing chosen: the form says what it needs, and nothing is sent. */
export const NothingChosen: Story = {
  args: { ...deskAt(required, { open: referenceKey }), ...on() },
  play: async () => {
    const form = await openReferenceLayer()
    await userEvent.click(within(form).getByRole("button", { name: "Save" }))
    await waitFor(() =>
      expect(page().getByText("Choose an answer or add a note.")).toBeVisible()
    )
  },
}

/** Records refuses: the control announces why, keeps the answer, and never retries. */
export const Refused: Story = {
  args: {
    ...deskAt(required, { open: referenceKey }),
    ...on(),
    feedbackSink: storyFeedbackSink({
      refuse: "Records holds no reference 01M5HV74YX001T2TFPECK3F0PA",
    }),
  },
  play: async () => {
    const form = await openReferenceLayer()
    await userEvent.click(
      within(form).getByRole("radio", { name: "Misleading" })
    )
    await userEvent.click(within(form).getByRole("button", { name: "Save" }))
    await waitFor(() =>
      expect(page().getByText(/Records holds no reference/)).toBeVisible()
    )
    await expect(
      within(form).getByRole("radio", { name: "Misleading" })
    ).toBeChecked()
  },
}

/** One submit while one runs: the second press does nothing. */
export const NoDoubleSubmit: Story = {
  args: { ...deskAt(required, { open: referenceKey }), ...on() },
  play: async () => {
    const form = await openReferenceLayer()
    await userEvent.click(within(form).getByRole("radio", { name: "Useful" }))
    const save = within(form).getByRole("button", { name: "Save" })
    await userEvent.click(save)
    await expect(
      within(form).getByRole("button", { name: "Saving…" })
    ).toBeDisabled()
  },
}

const shortcutFeedback: Array<string> = []
const shortcutDecisions: Array<string> = []

/**
 * ⌘↵ on a focused answer saves the feedback and never decides the unit: one
 * feedback answer is sent and no decision.
 */
export const ShortcutSavesFeedbackOnly: Story = {
  args: {
    ...deskAt(required),
    feedbackSink: storyFeedbackSink({
      record: (submission) => shortcutFeedback.push(submission.target),
    }),
    decisionSink: (async (decision) => {
      shortcutDecisions.push(decision.kind)
    }) satisfies DecisionSink,
  },
  play: async ({ canvas }) => {
    shortcutFeedback.length = 0
    shortcutDecisions.length = 0
    await userEvent.click(
      canvas.getByRole("button", { name: /^Give feedback/ })
    )
    const form = await waitFor(() =>
      page().getByRole("form", { name: "Feedback on this unit" })
    )
    const high = within(form).getByRole("radio", { name: "High" })
    await userEvent.click(high)
    await expect(high).toHaveFocus()
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}")
    await waitFor(() =>
      expect(page().getByText("High complexity")).toBeVisible()
    )
    await expect(shortcutFeedback).toEqual([required.feedback!.unit!.target])
    await expect(shortcutDecisions).toEqual([])
    // Focus moves to "Change", never to the page.
    await waitFor(() =>
      expect(page().getByRole("button", { name: "Change" })).toHaveFocus()
    )
  },
}

/* ── ⌘↵ never decides from a feedback layer ────────────── */

const fencedDecisions: Array<string> = []

/** The required unit, where ⌘↵ at rest approves; decisions are counted. */
const fenced = (options: { open?: string } = {}) => ({
  ...deskAt(required, options),
  feedbackSink: storyFeedbackSink(),
  decisionSink: (async (decision) => {
    fencedDecisions.push(decision.kind)
  }) satisfies DecisionSink,
})

/** ⌘↵, then ⌘↵ held (its autorepeat), wherever focus is now. */
async function pressSaveTwice() {
  await userEvent.keyboard("{Meta>}{Enter}{/Meta}")
  await userEvent.keyboard("{Meta>}{Enter>3}{/Meta}")
  await pause(300)
}

/**
 * The control: ⌘↵ with focus on the page does approve the unit, so the
 * fenced presses above were fenced, not ignored for some other reason.
 */
async function expectPageShortcutApproves() {
  await userEvent.keyboard("{Escape}")
  ;(document.activeElement as HTMLElement | null)?.blur()
  await userEvent.keyboard("{Meta>}{Enter}{/Meta}")
  await waitFor(() => expect(fencedDecisions).toEqual(["approve"]))
}

/** The layer as it stands open. */
const openLayer = () =>
  waitFor(() => {
    const layer = document.querySelector<HTMLElement>("[data-feedback-layer]")
    expect(layer).toBeVisible()
    return layer!
  })

const layers = {
  reference: {
    args: () => fenced({ open: referenceKey }),
    open: openReferenceLayer,
    pick: async (form: HTMLElement) =>
      userEvent.click(within(form).getByRole("radio", { name: "Useful" })),
  },
  unit: {
    args: () => fenced(),
    open: async () => {
      await userEvent.click(
        page().getByRole("button", { name: /^Give feedback/ })
      )
      return waitFor(() =>
        page().getByRole("form", { name: "Feedback on this unit" })
      )
    },
    pick: async (form: HTMLElement) =>
      userEvent.click(within(form).getByRole("radio", { name: "High" })),
  },
  digest: {
    args: () => fenced(),
    open: async () => {
      await userEvent.click(
        page().getByRole("button", { name: "Rate the Briefed digest" })
      )
      return waitFor(() =>
        page().getByRole("form", { name: "Feedback on the Briefed digest" })
      )
    },
    pick: async (form: HTMLElement) =>
      userEvent.click(
        within(within(form).getByRole("group", { name: "Accurate" })).getByRole(
          "radio",
          { name: "Yes" }
        )
      ),
  },
} as const

/**
 * ⌘↵ saves, then ⌘↵ again and held: focus is on what the save left (the
 * reference's chip, or "Change" in the unit's and digest's layers), and
 * none of it approves the unit.
 */
const againAfterSave = (layer: keyof typeof layers): Story => ({
  args: layers[layer].args(),
  play: async () => {
    fencedDecisions.length = 0
    const form = await layers[layer].open()
    await layers[layer].pick(form)
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}")
    await waitFor(() =>
      expect(page().queryByRole("button", { name: "Saving…" })).toBeNull()
    )
    await waitFor(() =>
      expect(
        document.activeElement?.closest(
          "[data-feedback-trigger], [data-feedback-layer]"
        )
      ).not.toBeNull()
    )
    await pressSaveTwice()
    await expect(fencedDecisions).toEqual([])
    await expectPageShortcutApproves()
  },
})

/** ⌘↵ on the layer's Close button closes or does nothing; it never approves. */
const onClose = (layer: keyof typeof layers): Story => ({
  args: layers[layer].args(),
  play: async () => {
    fencedDecisions.length = 0
    await layers[layer].open()
    const close = within(await openLayer()).getByRole("button", {
      name: "Close",
    })
    close.focus()
    await expect(close).toHaveFocus()
    await pressSaveTwice()
    await expect(fencedDecisions).toEqual([])
    await expectPageShortcutApproves()
  },
})

export const ReferenceShortcutAgainAfterSave = againAfterSave("reference")
export const ReferenceShortcutOnClose = onClose("reference")
export const UnitShortcutAgainAfterSave = againAfterSave("unit")
export const UnitShortcutOnClose = onClose("unit")
export const DigestShortcutAgainAfterSave = againAfterSave("digest")
export const DigestShortcutOnClose = onClose("digest")

/* ── The layer stays with its card, saved or changed ───── */

const box = (element: Element) => element.getBoundingClientRect()

/** Pin → line list → the reference's row → its card, as the reader opens it. */
async function openCardFromPin(canvasElement: HTMLElement) {
  const pin = await waitFor(() => {
    const found = linePinWith(canvasElement, referenceKey)
    expect(found).toBeVisible()
    return found
  })
  // At phone width the diff sits below the briefing: bring the pin into
  // view first, as the reader scrolls to it. The desk settles its own
  // scroll as it mounts, so scroll until the pin stays in view.
  const inViewport = () =>
    box(pin).top >= 0 && box(pin).bottom <= window.innerHeight
  for (let tries = 0; tries < 12 && !(inViewport() && tries > 1); tries++) {
    pin.scrollIntoView({ block: "center" })
    await pause(400)
  }
  await expect(inViewport()).toBe(true)
  await userEvent.click(pin)
  const list = await waitFor(
    () => page().getByRole("group", { name: /markers on line/ }),
    { timeout: 3000 }
  )
  await userEvent.click(within(list).getAllByRole("button")[0]!)
  const card = await openCard()
  await waitFor(() => expect(card.contains(document.activeElement)).toBe(true))
  return card
}

const floatingBox = () =>
  document.querySelector<HTMLElement>("[data-floating-card]")!
const chipOf = (card: HTMLElement) =>
  card.querySelector<HTMLElement>("[data-feedback-trigger]")!

/** The layer, once open and placed. */
const placedLayer = () =>
  waitFor(() => {
    const layer = document.querySelector<HTMLElement>("[data-feedback-layer]")
    expect(layer).toBeVisible()
    expect(box(layer!).width).toBeGreaterThan(0)
    return layer!
  })

/**
 * Wide: beside the card's visible box (left or right of it, sharing rows
 * with it), never over the card or off at the desk's top.
 */
async function expectBesideCard(layer: HTMLElement) {
  await waitFor(() => {
    const at = box(layer)
    const card = box(floatingBox())
    // Entirely to one side of the card's visible box, 0–16px from it.
    const gap =
      at.right <= card.left + 0.5
        ? card.left - at.right
        : at.left >= card.right - 0.5
          ? at.left - card.right
          : -1
    expect(gap).toBeGreaterThanOrEqual(-0.5)
    expect(gap).toBeLessThanOrEqual(16)
    // Sharing rows with it: at least half the shorter of the two overlaps,
    // so a layer pushed to the desk's top beside a card lower down fails.
    const shared = Math.min(at.bottom, card.bottom) - Math.max(at.top, card.top)
    expect(shared).toBeGreaterThanOrEqual(Math.min(at.height, card.height) / 2)
  })
}

/** Narrow: against the chip, just above or below it, over its column. */
async function expectAgainstChip(layer: HTMLElement, chip: HTMLElement) {
  await waitFor(() => {
    const at = box(layer)
    const from = box(chip)
    const above = from.top - at.bottom
    const below = at.top - from.bottom
    expect((above >= 0 && above <= 12) || (below >= 0 && below <= 12)).toBe(
      true
    )
    expect(at.left).toBeLessThan(from.right)
    expect(at.right).toBeGreaterThan(from.left)
  })
}

/** Focus is on something the reader can see: inside the card's visible box. */
async function expectFocusVisibleInCard() {
  await waitFor(() => {
    const focused = document.activeElement as HTMLElement | null
    expect(focused && focused !== document.body).toBe(true)
    const at = box(focused!)
    const card = box(floatingBox())
    expect(at.top).toBeGreaterThanOrEqual(Math.max(card.top, 0) - 0.5)
    expect(at.bottom).toBeLessThanOrEqual(
      Math.min(card.bottom, window.innerHeight) + 0.5
    )
  })
}

/**
 * Open with F, save with ⌘↵, reopen with F to the saved answer, "Change",
 * then Escape: the layer stays placed against the card (wide) or its chip
 * (narrow) in every state, no close scrolls the card, and focus always
 * returns to something in view: the chip when it shows (narrow, where F
 * brought it into view), else where F was pressed (a tall wide card, whose
 * chip is below its visible box).
 */
const staysWithItsCard = (wide: boolean): Story => ({
  args: { ...deskAt(required), ...on() },
  globals: {
    viewport: { value: wide ? "wide1500" : "phone", isRotated: false },
  },
  play: async ({ canvasElement }) => {
    const card = await openCardFromPin(canvasElement)
    const expectPlaced = (layer: HTMLElement) =>
      wide ? expectBesideCard(layer) : expectAgainstChip(layer, chipOf(card))

    await userEvent.keyboard("f")
    const form = await waitFor(() =>
      page().getByRole("form", { name: "Feedback on this reference" })
    )
    await expectPlaced(await placedLayer())
    const scrolled = floatingBox().scrollTop
    await userEvent.click(within(form).getByRole("radio", { name: "Useful" }))
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}")
    await expectChipSaved()
    await expect(floatingBox().scrollTop).toBe(scrolled)
    await expectFocusVisibleInCard()
    // Narrow with a fine pointer, F brought the chip fully into view, so
    // focus is on it. With touch the 44px chip can stay slightly cut off,
    // and focus rightly falls back to the card's box (checked above).
    if (!wide && !matchMedia("(pointer: coarse)").matches)
      await waitFor(() => expect(chipOf(card)).toHaveFocus())

    // Reopened: the saved answer, in the same place.
    await userEvent.keyboard("f")
    await waitFor(() =>
      expect(page().getByRole("button", { name: "Change" })).toBeVisible()
    )
    await expectPlaced(await placedLayer())
    // Change: the form again, still in place.
    await userEvent.click(page().getByRole("button", { name: "Change" }))
    await waitFor(() =>
      page().getByRole("form", { name: "Feedback on this reference" })
    )
    await expectPlaced(await placedLayer())
    // Escape closes the layer only, and focus again lands in view.
    const beforeEscape = floatingBox().scrollTop
    await userEvent.keyboard("{Escape}")
    await waitFor(() =>
      expect(document.querySelector("[data-feedback-layer]")).toBeNull()
    )
    await expect(floatingBox().scrollTop).toBe(beforeEscape)
    await expectFocusVisibleInCard()
  },
})

export const LayerStaysWithItsCardWide = staysWithItsCard(true)
export const LayerStaysWithItsChipPhone = staysWithItsCard(false)
