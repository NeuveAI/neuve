import { useSetAtom } from "jotai"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"

import {
  markerKindFixtures,
  reviewDeskFixture,
} from "@workspace/ui/fixtures/review-batch.fixtures"
import { contextReferenceFixtures } from "@workspace/ui/fixtures/context-reference.fixtures"
import { openSheetAtom } from "@workspace/ui/neuve/review-desk/atoms"
import { SheetFrame } from "@workspace/ui/neuve/story-kit/frames"
import { withReviewDeskState } from "@workspace/ui/neuve/story-kit/store"

const markers = {
  ...reviewDeskFixture.markers,
  ...Object.fromEntries(
    [
      ...Object.values(markerKindFixtures),
      ...Object.values(contextReferenceFixtures),
    ].map((marker) => [marker.key, marker])
  ),
}

/**
 * The sheet renders inside a positioned unit column (the kit's SheetFrame),
 * as it does in the desk. Its header carries the marker's kind icon on a
 * 32px family tile.
 */
const meta = {
  title: "Review desk/Source sheet (L3)",
  component: SheetFrame,
  args: { markers },
  argTypes: { markers: { control: false } },
} satisfies Meta<typeof SheetFrame>

export default meta
type Story = StoryObj<typeof meta>

/**
 * Row marks are icons hidden from assistive tech: the status word beside
 * them carries the meaning, so no glyph ("◉", "!", "▢") is read out.
 */
async function expectIconMarks(
  canvasElement: HTMLElement,
  rows: Array<{ label: string; status?: string }>
) {
  const body = within(canvasElement.ownerDocument.body)
  for (const { label, status } of rows) {
    const row = (await body.findByText(label)).closest("div")
    if (!row) throw new Error(`No row for ${label}`)
    const mark = row.querySelector("svg[data-row-mark]")
    await expect(mark).toHaveAttribute("aria-hidden", "true")
    await expect(row.textContent).not.toMatch(/[◉!▢◦]/)
    if (status) await expect(row).toHaveTextContent(status)
  }
}

/** "Done when" rows: an eye for observed, the gap icon for no evidence. */
export const Ticket: Story = {
  decorators: [
    withReviewDeskState({ openMarker: "conflict", sheetMarker: "conflict" }),
  ],
  play: ({ canvasElement }) =>
    expectIconMarks(canvasElement, [
      { label: "The old link is denied", status: "observed" },
      { label: "Open sessions are denied", status: "no evidence" },
    ]),
}
export const Documentation: Story = {
  decorators: [withReviewDeskState({ openMarker: "doc", sheetMarker: "doc" })],
}
export const TransientContext: Story = {
  decorators: [
    withReviewDeskState({ openMarker: "batch", sheetMarker: "batch" }),
  ],
}
export const CommittedGraph: Story = {
  decorators: [
    withReviewDeskState({ openMarker: "graph", sheetMarker: "graph" }),
  ],
}
export const VerificationEvidence: Story = {
  decorators: [
    withReviewDeskState({ openMarker: "test", sheetMarker: "test" }),
  ],
}
/** The commit's changed files carry a file icon. */
export const RegressionHistory: Story = {
  decorators: [
    withReviewDeskState({ openMarker: "history", sheetMarker: "history" }),
  ],
  play: ({ canvasElement }) =>
    expectIconMarks(canvasElement, [
      { label: "src/routes/open.ts" },
      { label: "test/routes/open.test.ts" },
    ]),
}

const sheet = (key: string): Story => ({
  decorators: [withReviewDeskState({ openMarker: key, sheetMarker: key })],
})
/** Evidence gap: amber tile. */
export const Gap: Story = sheet("kind-gap")
/** Linked evidence unavailable. */
export const Unavailable: Story = sheet("kind-unavailable")
/** Recorded decision signal: magenta flag. */
export const Decision: Story = sheet("kind-decision")
/** Recorded contextual signal. */
export const Signal: Story = sheet("kind-signal")
/** A failed check: amber. */
export const Failed: Story = sheet("kind-failed")
/** Captured source. */
export const CapturedSource: Story = sheet("kind-source")

/**
 * A context reference's sheet: the file by name, folder muted, its copy
 * action beside "Back to unit"; then its reason led by how it bears on the
 * change (the dialog's description) and what to check; then the code under
 * a caption, its cited lines tinted among their neighbours, every line
 * wrapped inside the sheet; then the other units that cite it.
 */
async function expectReferenceSheet(canvasElement: HTMLElement, lead: string) {
  const doc = canvasElement.ownerDocument
  const dialog = await within(doc.body).findByRole("dialog")
  await expect(dialog).toHaveAccessibleDescription(new RegExp(`^${lead}`))
  const code = dialog.querySelector<HTMLElement>("figure > div")!
  await expect(code.scrollWidth).toBeLessThanOrEqual(code.clientWidth + 1)
  await expect(dialog.textContent).not.toMatch(
    /Committed|necessary|Grade|Stance|Revision/
  )
  await expect(dialog.querySelectorAll("[data-cited]").length).toBeGreaterThan(
    0
  )
}

const referenceSheet = (
  key: keyof typeof contextReferenceFixtures,
  lead: string
): Story => ({
  decorators: [
    withReviewDeskState({
      openMarker: contextReferenceFixtures[key].key,
      sheetMarker: contextReferenceFixtures[key].key,
    }),
  ],
  play: ({ canvasElement }) => expectReferenceSheet(canvasElement, lead),
})
/** Supports: unreviewed work of the same batch. */
export const ReferenceSupports = referenceSheet(
  "supports",
  "Supports. The desk adapter"
)
/** Background: the code as it is after the change. */
export const ReferenceBackground = referenceSheet(
  "background",
  "Background. Keyboard and focus paths"
)
/** An unchecked lead: the code as it was before the change. */
export const ReferenceUnchecked = referenceSheet(
  "unchecked",
  "Unclear fit. A preloaded lead"
)
/** In a 375px column (a phone) the sheet fills it and long lines still wrap. */
export const ReferenceAtPhoneWidth: Story = {
  ...referenceSheet("unchecked", "Unclear fit. A preloaded lead"),
  render: () => (
    <div className="w-[375px]">
      <SheetFrame markers={markers} height={760} />
    </div>
  ),
}

/**
 * A card's "Open source" trigger beside the sheet, standing in for the
 * floating card (context-margin.tsx), which carries the same attributes.
 * With `chip`, a second opener outside the card stands in for a briefing
 * chip or a guided flow box.
 */
function CardTriggerFrame({ chip = false }: { chip?: boolean }) {
  const openSheet = useSetAtom(openSheetAtom)
  return (
    <SheetFrame markers={markers} className="p-6">
      <div data-floating-card="" className="inline-flex">
        <button
          type="button"
          data-source-trigger=""
          aria-haspopup="dialog"
          onClick={openSheet}
        >
          Open source
        </button>
      </div>
      {chip && (
        <button type="button" aria-haspopup="dialog" onClick={openSheet}>
          Lines 22–23
        </button>
      )}
    </SheetFrame>
  )
}

const sheetClosed = (doc: Document) =>
  waitFor(() =>
    expect(doc.querySelector("aside[data-source-sheet]")).toBeNull()
  )

/**
 * Closing the sheet, with Escape or "Back to unit", returns focus to the
 * card's "Open source" trigger that opened it.
 */
export const FocusReturnsToCardTrigger: Story = {
  decorators: [withReviewDeskState({ openMarker: "conflict" })],
  render: () => <CardTriggerFrame />,
  play: async ({ canvas, canvasElement }) => {
    const doc = canvasElement.ownerDocument
    const trigger = canvas.getByRole("button", { name: "Open source" })
    trigger.focus()
    await userEvent.keyboard("{Enter}")
    await canvas.findByRole("dialog")
    await userEvent.keyboard("{Escape}")
    await sheetClosed(doc)
    await waitFor(() => expect(doc.activeElement).toBe(trigger))

    await userEvent.keyboard("{Enter}")
    const dialog = await canvas.findByRole("dialog")
    within(dialog)
      .getByRole("button", { name: /Back to unit/ })
      .focus()
    await userEvent.keyboard("{Enter}")
    await sheetClosed(doc)
    await waitFor(() => expect(doc.activeElement).toBe(trigger))
  },
}

/**
 * A sheet that opened with nothing focused (restored state) returns focus
 * to the open card's source trigger when it closes.
 */
export const FocusFallsBackToCardTrigger: Story = {
  decorators: [
    withReviewDeskState({ openMarker: "conflict", sheetMarker: "conflict" }),
  ],
  render: () => <CardTriggerFrame />,
  play: async ({ canvas, canvasElement }) => {
    const doc = canvasElement.ownerDocument
    await canvas.findByRole("dialog")
    await userEvent.keyboard("{Escape}")
    await sheetClosed(doc)
    await waitFor(() =>
      expect(doc.activeElement).toBe(
        canvas.getByRole("button", { name: "Open source" })
      )
    )
  },
}

/**
 * Opened from outside the card (a briefing chip, a guided flow box), the
 * sheet returns focus to that opener, not to the card's trigger, with Escape
 * and with "Back to unit".
 */
export const FocusReturnsToOpener: Story = {
  decorators: [withReviewDeskState({ openMarker: "conflict" })],
  render: () => <CardTriggerFrame chip />,
  play: async ({ canvas, canvasElement }) => {
    const doc = canvasElement.ownerDocument
    const chip = canvas.getByRole("button", { name: "Lines 22–23" })
    chip.focus()
    await userEvent.keyboard("{Enter}")
    await canvas.findByRole("dialog")
    await userEvent.keyboard("{Escape}")
    await sheetClosed(doc)
    await waitFor(() => expect(doc.activeElement).toBe(chip))

    await userEvent.keyboard("{Enter}")
    const dialog = await canvas.findByRole("dialog")
    within(dialog)
      .getByRole("button", { name: /Back to unit/ })
      .focus()
    await userEvent.keyboard("{Enter}")
    await sheetClosed(doc)
    await waitFor(() => expect(doc.activeElement).toBe(chip))
  },
}
