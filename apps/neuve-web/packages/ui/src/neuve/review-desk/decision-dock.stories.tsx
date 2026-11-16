import type { Meta, StoryObj } from "@storybook/react-vite"
import * as React from "react"
import { atom, useAtomValue, useSetAtom, useStore } from "jotai"
import { useHydrateAtoms } from "jotai/utils"
import { expect, userEvent, waitFor, within } from "storybook/test"

import {
  ADMINS_UNIT_ID,
  agenticUnitFixture,
  goDeliveryDeskFixture,
  reviewDeskFixture,
  suggestedUnitFixture,
} from "@workspace/ui/fixtures/review-batch.fixtures"
import {
  decisionSinkAtom,
  dockAtom,
} from "@workspace/ui/neuve/review-desk/atoms"
import { DecisionDock } from "@workspace/ui/neuve/review-desk/decision-dock"
import { atDock } from "@workspace/ui/neuve/story-kit/frames"
import {
  expectFocusVisible,
  expectNoFocusRing,
  tabTo,
} from "@workspace/ui/neuve/story-kit/play"
import { withReviewDeskState } from "@workspace/ui/neuve/story-kit/store"

const meta = {
  title: "Review desk/Decision dock",
  component: DecisionDock,
  args: { unit: reviewDeskFixture.unit, markers: reviewDeskFixture.markers },
  decorators: [atDock],
} satisfies Meta<typeof DecisionDock>

export default meta
type Story = StoryObj<typeof meta>

/** Rest. Hover or focus "Covers 3 hunks" for the scope note. */
export const Rest: Story = { decorators: [withReviewDeskState()] }

/** Composer with the suggested draft offered and the open context attached. */
export const Composing: Story = {
  decorators: [
    withReviewDeskState({ dock: "composing", attachment: "conflict" }),
  ],
}

/** Draft accepted: the suggestion fills the comment and the offer disappears. */
export const ComposingWithDraft: Story = {
  decorators: [
    withReviewDeskState({
      dock: "composing",
      attachment: "conflict",
      draft: reviewDeskFixture.unit.draftSuggestion,
    }),
  ],
}

/** Attachment removed. */
export const ComposingDetached: Story = {
  decorators: [withReviewDeskState({ dock: "composing", attachment: null })],
}

/** After a decision: what you did, Undo, and the next undecided unit. */
export const Approved: Story = {
  args: { nextUnitId: ADMINS_UNIT_ID },
  decorators: [withReviewDeskState({ dock: "approved" })],
}

/** No undecided unit remains: "Back to batch". */
export const ApprovedLastUnit: Story = {
  decorators: [withReviewDeskState({ dock: "approved" })],
}

export const ChangesRequested: Story = {
  args: { nextUnitId: ADMINS_UNIT_ID },
  decorators: [withReviewDeskState({ dock: "changes-requested" })],
}

/**
 * Human-suggested rest (Option A): the agent's review is said once, in the
 * review card; the dock says what the decision covers.
 */
export const SuggestedRest: Story = {
  args: { unit: suggestedUnitFixture.unit },
  decorators: [withReviewDeskState()],
  play: async ({ canvas }) => {
    await waitFor(() =>
      expect(canvas.getByText("Covers 1 hunk")).toBeInTheDocument()
    )
    await expect(canvas.queryByText(/Agent approved/)).toBeNull()
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "Agree" })).toBeVisible()
    )
  },
}

/** Agree on a suggested unit is an approval (user decision D1). */
export const Agreed: Story = {
  args: { unit: suggestedUnitFixture.unit, nextUnitId: ADMINS_UNIT_ID },
  decorators: [withReviewDeskState({ dock: "agreed" })],
  play: async ({ canvas }) => {
    await waitFor(() =>
      expect(canvas.getByRole("status")).toHaveTextContent(
        "You approved this unit"
      )
    )
    await expect(canvas.queryByText(/agreed/i)).toBeNull()
  },
}

export const Commented: Story = {
  args: { unit: agenticUnitFixture.unit, nextUnitId: ADMINS_UNIT_ID },
  decorators: [withReviewDeskState({ dock: "commented" })],
}

/* ── Focus across dock states ─────────────────────────────
 * Each state replaces the last, so the control pressed is gone. Focus
 * lands in the composer's text when it opens, back on the opener when the
 * dock returns to rest (Cancel or Escape), and on the way on (Next unit /
 * Back to batch) after Send. Never on the page. The ring shows for the
 * keyboard only.
 */

type Canvas = ReturnType<typeof within>

/**
 * Focus has landed on `element` with the ring (keyboard) or without it
 * (pointer). The dock is an inverse surface with its own ring colour, so
 * the ring is checked as a solid 2px outline.
 */
async function landed(element: HTMLElement, keyboard: boolean) {
  await waitFor(() => expect(element).toHaveFocus())
  if (!keyboard) return expectNoFocusRing(element)
  await expectFocusVisible(element, { ring: false })
  const style = getComputedStyle(element)
  await expect(style.outlineStyle).toBe("solid")
  await expect(style.outlineWidth).toBe("2px")
}

/** Press a dock control the way the reader does. */
async function pressControl(control: HTMLElement, keyboard: boolean) {
  if (!keyboard) return userEvent.click(control)
  await tabTo(control)
  await userEvent.keyboard("{Enter}")
}

/**
 * Open with `opener` and write; close (Escape by keyboard, Cancel by
 * pointer) and come back to the opener. Reopen: Escape kept the words,
 * Cancel dropped them. Then write, send, and land on the way on.
 */
async function roundTrip(
  canvas: Canvas,
  opener: string,
  send: string,
  keyboard: boolean
) {
  const open = () => canvas.getByRole("button", { name: opener })
  const words = keyboard ? " Keep this." : " Drop this."
  await pressControl(open(), keyboard)
  const text = await canvas.findByRole("textbox")
  await waitFor(() => expect(text).toHaveFocus())
  await userEvent.type(text, words)
  if (keyboard) await userEvent.keyboard("{Escape}")
  // The text Cancel (the × in the header is also named Cancel).
  else
    await userEvent.click(
      canvas.getAllByRole("button", { name: "Cancel" }).at(-1)
    )
  await waitFor(() => expect(canvas.queryByRole("dialog")).toBeNull())
  await landed(await waitFor(() => open()), keyboard)

  await pressControl(open(), keyboard)
  const again = await canvas.findByRole("textbox")
  await waitFor(() => expect(again).toHaveFocus())
  // Escape set the draft aside; Cancel discarded it.
  if (keyboard)
    await waitFor(() =>
      expect((again as HTMLTextAreaElement).value).toContain(words)
    )
  else await expect((again as HTMLTextAreaElement).value).not.toContain(words)
  await userEvent.type(again, " Please add a test.")
  await pressControl(canvas.getByRole("button", { name: send }), keyboard)
  const wayOn = await waitFor(() =>
    within(canvas.getByRole("status")).getByRole("link", {
      name: /Next unit|Back to batch/,
    })
  )
  await landed(wayOn, keyboard)
}

/** Request changes, by keyboard: text, Escape back to it, Send on. */
export const FocusRequestChangesKeyboard: Story = {
  decorators: [withReviewDeskState()],
  play: async ({ canvas }) =>
    roundTrip(canvas, "Request changes", "Send to implementer ⌘↵", true),
}

/** Request changes, by pointer: the same landings, no ring. */
export const FocusRequestChangesPointer: Story = {
  decorators: [withReviewDeskState()],
  play: async ({ canvas }) =>
    roundTrip(canvas, "Request changes", "Send to implementer ⌘↵", false),
}

/** Edit request (Guided suggestion), by keyboard. */
export const FocusEditRequestKeyboard: Story = {
  args: {
    unit: goDeliveryDeskFixture.unit,
    markers: goDeliveryDeskFixture.markers,
    suggestion: goDeliveryDeskFixture.delivery!.check!.suggestion!,
  },
  decorators: [withReviewDeskState()],
  play: async ({ canvas }) =>
    roundTrip(canvas, "Edit request", "Send to implementer ⌘↵", true),
}

/** Edit request (Guided suggestion), by pointer. */
export const FocusEditRequestPointer: Story = {
  args: {
    unit: goDeliveryDeskFixture.unit,
    markers: goDeliveryDeskFixture.markers,
    suggestion: goDeliveryDeskFixture.delivery!.check!.suggestion!,
  },
  decorators: [withReviewDeskState()],
  play: async ({ canvas }) =>
    roundTrip(canvas, "Edit request", "Send to implementer ⌘↵", false),
}

/** Comment (an agentic unit), by keyboard. */
export const FocusCommentKeyboard: Story = {
  args: { unit: agenticUnitFixture.unit, nextUnitId: ADMINS_UNIT_ID },
  decorators: [withReviewDeskState()],
  play: async ({ canvas }) => roundTrip(canvas, "Comment", "Add comment", true),
}

/** Comment (an agentic unit), by pointer. */
export const FocusCommentPointer: Story = {
  args: { unit: agenticUnitFixture.unit, nextUnitId: ADMINS_UNIT_ID },
  decorators: [withReviewDeskState()],
  play: async ({ canvas }) =>
    roundTrip(canvas, "Comment", "Add comment", false),
}

/* ── Parked drafts stay with their opener and unit ───────── */

/** A unit still being assessed: its dock offers Request changes and Comment. */
const assessingUnit: typeof reviewDeskFixture.unit = {
  ...reviewDeskFixture.unit,
  lane: undefined,
  responsibility: {
    kind: "provisional-unassessed",
    historicalProjection: "human-required",
  },
}

/**
 * Escape parks a draft for its opener only: Comment opens empty, and after
 * that detour Request changes still gets its words back.
 */
export const ParkedDraftStaysWithItsOpener: Story = {
  args: { unit: assessingUnit },
  decorators: [withReviewDeskState()],
  play: async ({ canvas }) => {
    const opener = (name: string) => canvas.getByRole("button", { name })
    await pressControl(opener("Request changes"), true)
    await userEvent.type(await canvas.findByRole("textbox"), "Keep for RC.")
    await userEvent.keyboard("{Escape}")
    await landed(await waitFor(() => opener("Request changes")), true)
    await pressControl(opener("Comment"), true)
    const comment = await canvas.findByRole<HTMLTextAreaElement>("textbox")
    await expect(comment.value).toBe("")
    await userEvent.keyboard("{Escape}")
    await pressControl(await waitFor(() => opener("Request changes")), true)
    await waitFor(async () =>
      expect(
        (await canvas.findByRole<HTMLTextAreaElement>("textbox")).value
      ).toBe("Keep for RC.")
    )
  },
}

/** The unit the story shows (switched by its own button). */
const storyUnitAtom = atom<"first" | "second">("first")

function SwitchingDock() {
  const which = useAtomValue(storyUnitAtom)
  const show = useSetAtom(storyUnitAtom)
  const unit =
    which === "first"
      ? assessingUnit
      : { ...assessingUnit, id: `${assessingUnit.id}-next`, title: "Next" }
  return (
    <>
      <button type="button" onClick={() => show("second")}>
        Show the next unit
      </button>
      <DecisionDock unit={unit} markers={reviewDeskFixture.markers} />
    </>
  )
}

/** A draft parked on one unit never shows on the next one. */
export const ParkedDraftStaysWithItsUnit: Story = {
  decorators: [withReviewDeskState()],
  render: () => <SwitchingDock />,
  play: async ({ canvas }) => {
    const requestChanges = () =>
      canvas.getByRole("button", { name: "Request changes" })
    await pressControl(requestChanges(), true)
    await userEvent.type(await canvas.findByRole("textbox"), "Unit one only.")
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(canvas.queryByRole("dialog")).toBeNull())
    await userEvent.click(
      canvas.getByRole("button", { name: "Show the next unit" })
    )
    await pressControl(requestChanges(), true)
    await expect(
      (await canvas.findByRole<HTMLTextAreaElement>("textbox")).value
    ).toBe("")
  },
}

/* ── A pending hand-off and what may take it ──────────────
 * A slow decision drives the dock through other states while it is
 * pending, with focus unmoved (no focusin elsewhere): only the request's
 * target state on its unit may take it.
 */

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Whether the Guided suggestion is shown (the rest dock's variant). */
const suggestionShownAtom = atom(true)

/** A Guided dock whose slow decision swaps the rest variant as it starts. */
function SwappingRestDock() {
  const store = useStore()
  const shown = useAtomValue(suggestionShownAtom)
  const sink = React.useCallback(async () => {
    store.set(suggestionShownAtom, false)
    await wait(1500)
  }, [store])
  useHydrateAtoms([[decisionSinkAtom, sink]] as const)
  return (
    <DecisionDock
      unit={goDeliveryDeskFixture.unit}
      markers={goDeliveryDeskFixture.markers}
      suggestion={
        shown ? goDeliveryDeskFixture.delivery!.check!.suggestion! : undefined
      }
    />
  )
}

/**
 * Approve (against the suggestion) asks the decided dock for focus. While
 * the server answers, the rest dock remounts as its plain variant: being a
 * rest, it doesn't take the request, and focus lands on the way on once
 * the decision is recorded.
 */
export const PendingHandOffSkipsOtherStates: Story = {
  decorators: [withReviewDeskState()],
  render: () => <SwappingRestDock />,
  play: async ({ canvas, canvasElement }) => {
    const approve = await waitFor(() =>
      canvas.getByRole("button", { name: "Approve" })
    )
    approve.focus()
    await userEvent.keyboard("{Enter}")
    // The plain rest is up while the decision is pending.
    await waitFor(() =>
      expect(canvas.queryByRole("button", { name: "Edit request" })).toBeNull()
    )
    const wayOn = await waitFor(
      () => {
        const found =
          canvasElement.querySelector<HTMLElement>("[data-dock-way-on]")
        expect(found).toBeTruthy()
        return found!
      },
      { timeout: 4000 }
    )
    await landed(wayOn, true)
  },
}

/** Which unit the switching dock shows. */
const shownUnitAtom = atom<"first" | "second">("first")

const firstUnit = reviewDeskFixture.unit
const secondUnit = { ...reviewDeskFixture.unit, id: `${firstUnit.id}-next` }

/**
 * A dock whose slow decision switches to another unit and back while it
 * is pending (as a reader's unit switch would, with focus unmoved).
 */
function UnitHoppingDock() {
  const store = useStore()
  const shown = useAtomValue(shownUnitAtom)
  const sink = React.useCallback(async () => {
    await wait(200)
    store.set(shownUnitAtom, "second")
    await wait(500)
    store.set(shownUnitAtom, "first")
    await wait(800)
  }, [store])
  useHydrateAtoms([[decisionSinkAtom, sink]] as const)
  return (
    <DecisionDock
      unit={shown === "first" ? firstUnit : secondUnit}
      markers={reviewDeskFixture.markers}
    />
  )
}

/**
 * A unit switch ends a pending hand-off: after switching away and back,
 * the decided dock arrives without taking focus.
 */
export const UnitSwitchEndsHandOff: Story = {
  decorators: [withReviewDeskState()],
  render: () => <UnitHoppingDock />,
  play: async ({ canvas, canvasElement }) => {
    const approve = await waitFor(() =>
      canvas.getByRole("button", { name: /^Approve/ })
    )
    approve.focus()
    await userEvent.keyboard("{Enter}")
    const wayOn = await waitFor(
      () => {
        const found =
          canvasElement.querySelector<HTMLElement>("[data-dock-way-on]")
        expect(found).toBeTruthy()
        return found!
      },
      { timeout: 4000 }
    )
    await wait(300)
    await expect(wayOn).not.toHaveFocus()
  },
}

/**
 * A Guided dock whose server rejects the decision. Afterwards, with focus
 * unmoved, the rest swaps to its plain variant, and then the decided dock
 * arrives from elsewhere (as a decision recorded on another device would).
 */
function RejectingDock() {
  const store = useStore()
  const shown = useAtomValue(suggestionShownAtom)
  const sink = React.useCallback(async () => {
    await wait(300)
    setTimeout(() => store.set(suggestionShownAtom, false), 300)
    setTimeout(() => store.set(dockAtom, "approved"), 900)
    throw new Error("Rejected by the reviewer service")
  }, [store])
  useHydrateAtoms([[decisionSinkAtom, sink]] as const)
  return (
    <DecisionDock
      unit={goDeliveryDeskFixture.unit}
      markers={goDeliveryDeskFixture.markers}
      suggestion={
        shown ? goDeliveryDeskFixture.delivery!.check!.suggestion! : undefined
      }
    />
  )
}

/**
 * A rejected decision leaves no request behind: neither the rest swapping
 * its variant nor a decided dock arriving later takes focus into the dock.
 * (The swap alone can't take it: a rest never takes a decided request.)
 */
export const RejectedDecisionLeavesNoRequest: Story = {
  decorators: [withReviewDeskState()],
  render: () => <RejectingDock />,
  play: async ({ canvas, canvasElement }) => {
    const approve = await waitFor(() =>
      canvas.getByRole("button", { name: "Approve" })
    )
    approve.focus()
    await userEvent.keyboard("{Enter}")
    const inDock = () =>
      !!canvasElement.ownerDocument.activeElement?.closest(
        "[data-dock-step], [data-dock-way-on], [role=dialog]"
      )
    // The plain rest is up after the rejection.
    await waitFor(() =>
      expect(canvas.queryByRole("button", { name: "Edit request" })).toBeNull()
    )
    await expect(inDock()).toBe(false)
    // Then the decided dock arrives from elsewhere.
    await waitFor(
      () =>
        expect(canvasElement.querySelector("[data-dock-way-on]")).toBeTruthy(),
      { timeout: 3000 }
    )
    await wait(300)
    await expect(inDock()).toBe(false)
  },
}
