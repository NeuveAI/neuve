import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { realSectionsDeskFixtures } from "@workspace/ui/fixtures/real-sections.fixtures"
import {
  displayRows,
  rowIndexOf,
  toFileDiff,
} from "@workspace/ui/neuve/review-desk/diff-model"
import { DEFAULT_DELIVERY_SETTINGS } from "@workspace/ui/neuve/shared/delivery"
import type { DisplayRow } from "@workspace/ui/neuve/review-desk/diff-model"
import type { DeskAt } from "@workspace/ui/neuve/story-kit/desk"
import { deskAt, deskMeta } from "@workspace/ui/neuve/story-kit/desk"
import { expectNoLayoutShift, pause } from "@workspace/ui/neuve/story-kit/play"
import type {
  DiffSide,
  MarkerAnchor,
  ReviewDeskData,
} from "@workspace/ui/neuve/types"

/**
 * Checkpoints on a real review whose units join several of a file's changes
 * as sections (10.109). Records anchors each checkpoint to every owned range
 * its requirement reaches (11.17); the desk shows it once per section, on
 * the first changed line its anchors touch there, so the same pin no longer
 * repeats down the unit; a range that runs on across a section's edge shows
 * in each section it touches. Without sections, its anchors that only
 * unchanged lines separate show once.
 */
const desks = Object.values(realSectionsDeskFixtures)
const fileOf = (desk: ReviewDeskData) => desk.files[0]!
const sectionsOf = (desk: ReviewDeskData) =>
  fileOf(desk).responsibility?.sections ?? []
const checkpointAnchors = (desk: ReviewDeskData) =>
  fileOf(desk).markerAnchors.filter(
    (anchor) => desk.markers[anchor.markerKey]?.checkpoint
  )
/** The owner's unit: three sections, each with its checkpoints on every range. */
const three = desks.find((desk) => sectionsOf(desk).length === 3)!
/** One section-less file whose checkpoints mark several ranges. */
const unsectioned = desks.find(
  (desk) =>
    sectionsOf(desk).length === 0 &&
    checkpointAnchors(desk).length >
      new Set(
        checkpointAnchors(desk).map(
          (anchor) => desk.markers[anchor.markerKey]!.checkpoint!.number
        )
      ).size
)!

/** A new file cut into sections line after line, a checkpoint atop each. */
const adjoining = desks.reduce((best, desk) =>
  sectionsOf(desk).length > sectionsOf(best).length ? desk : best
)
/** How many sections the first checkpoint's range runs across. */
const ACROSS = 5
/**
 * The same unit had Records merged the first checkpoint's range across the
 * next sections' edges, as its projection can: one anchor from its first
 * line to the end of the fifth section.
 */
const spanning: ReviewDeskData = (() => {
  const file = fileOf(adjoining)
  const end = sectionsOf(adjoining)[ACROSS - 1]!.ranges.at(-1)!.endLine
  const markerAnchors = file.markerAnchors.map((anchor) =>
    adjoining.markers[anchor.markerKey]?.checkpoint?.number === 1
      ? { ...anchor, range: { ...anchor.range!, end } }
      : anchor
  )
  return {
    ...adjoining,
    files: [{ ...file, markerAnchors }, ...adjoining.files.slice(1)],
  }
})()

const numberOf = (desk: ReviewDeskData, anchor: MarkerAnchor) =>
  desk.markers[anchor.markerKey]!.checkpoint!.number

const rowsOf = (desk: ReviewDeskData) =>
  displayRows(toFileDiff(fileOf(desk), desk.revision), fileOf(desk))

/** The section an anchor's first line belongs to, or "" for none. */
const sectionAt = (desk: ReviewDeskData, side: DiffSide, line: number) =>
  sectionsOf(desk).find((section) =>
    section.ranges.some(
      (range) =>
        (range.side === "new") === (side === "additions") &&
        line >= range.startLine &&
        line <= range.endLine
    )
  )?.id ?? ""

/** A display row's own (side, line). */
const pointOf = (row: DisplayRow) =>
  row.kind === "deletion"
    ? { side: "deletions" as const, lineNumber: row.oldLine! }
    : { side: "additions" as const, lineNumber: row.newLine! }

/**
 * Where each checkpoint should show, by `section:number`: of the lines its
 * anchors touch (each anchor's first line and its range's changed lines
 * on its side),
 * the one that comes first in the stacked view, within each section.
 */
function expectedPins(desk: ReviewDeskData) {
  const rows = rowsOf(desk)
  const expected = new Map<
    string,
    { side: DiffSide; lineNumber: number; row: number }
  >()
  for (const anchor of checkpointAnchors(desk)) {
    const top = rowIndexOf(rows, anchor.side, anchor.lineNumber)
    const end = anchor.range
      ? rowIndexOf(
          rows,
          anchor.range.endSide ?? anchor.range.side,
          anchor.range.end
        )
      : top
    // A range on one side touches that side's lines only.
    const only =
      anchor.range &&
      (anchor.range.endSide ?? anchor.range.side) === anchor.range.side
        ? anchor.range.side
        : undefined
    for (let row = top; row <= Math.max(top, end); row++) {
      if (row > top && rows[row]!.kind === "context") continue
      const point = row === top ? anchor : pointOf(rows[row]!)
      if (row > top && only !== undefined && point.side !== only) continue
      const key = `${sectionAt(desk, point.side, point.lineNumber)}:${numberOf(desk, anchor)}`
      const best = expected.get(key)
      if (!best || row < best.row)
        expected.set(key, {
          side: point.side,
          lineNumber: point.lineNumber,
          row,
        })
    }
  }
  return expected
}

/** Every checkpoint pin the margin shows: its line and its checkpoints. */
function shownPins(canvasElement: HTMLElement) {
  return [
    ...canvasElement.querySelectorAll<HTMLElement>("[data-checkpoint-mark]"),
  ].map((pin) => {
    // The pin sits in its line's overlay slot, `overlay-pin:${side}:${line}`.
    const slot = pin.closest("[slot]")!.getAttribute("slot")!
    const [, side, line] = slot.split(":")
    return {
      pin,
      side: side as DiffSide,
      lineNumber: Number(line),
      numbers: pin.dataset.checkpoints!.split(" ").map(Number),
    }
  })
}

/**
 * Each checkpoint shows exactly once per section, on the line expected, and
 * the margin shows no other checkpoint pin.
 */
async function expectOncePerSection(
  desk: ReviewDeskData,
  canvasElement: HTMLElement
) {
  const expected = expectedPins(desk)
  const lines = new Set(
    [...expected.values()].map((a) => `${a.side}:${a.lineNumber}`)
  )
  // The margin places its marks once the diff has laid out.
  const pins = await waitFor(
    () => {
      const found = shownPins(canvasElement)
      expect(found).toHaveLength(lines.size)
      return found
    },
    { timeout: 8000 }
  )
  const seen = pins.flatMap((pin) =>
    pin.numbers.map((number) => ({
      key: `${sectionAt(desk, pin.side, pin.lineNumber)}:${number}`,
      at: `${pin.side}:${pin.lineNumber}`,
    }))
  )
  await expect(seen.map((s) => s.key).sort()).toEqual(
    [...expected.keys()].sort()
  )
  for (const { key, at } of seen) {
    const anchor = expected.get(key)!
    await expect(at, key).toBe(`${anchor.side}:${anchor.lineNumber}`)
  }
}

const meta = {
  title: "Screens/Real packet/Checkpoints by section",
  ...deskMeta(three, {}, { settings: DEFAULT_DELIVERY_SETTINGS }),
} satisfies Meta<typeof DeskAt>

export default meta
type Story = StoryObj<typeof meta>

/**
 * The owner's unit: each checkpoint once per section, at the first changed
 * line its anchors touch there, never again further down its section.
 */
export const OncePerSection: Story = {
  play: async ({ canvasElement }) => {
    // Recorded, each checkpoint repeats on every range of its section.
    await expect(checkpointAnchors(three).length).toBeGreaterThan(
      expectedPins(three).size
    )
    await expectOncePerSection(three, canvasElement)
  },
}

/**
 * A file without sections: a checkpoint's anchors that only unchanged lines
 * separate show once, on the first of them.
 */
export const OnceAcrossUnchangedLines: Story = {
  args: deskAt(unsectioned),
  play: async ({ canvasElement }) => {
    const rows = rowsOf(unsectioned)
    const anchors = checkpointAnchors(unsectioned)
    const first = Math.min(
      ...anchors.map((a) => rowIndexOf(rows, a.side, a.lineNumber))
    )
    const last = Math.max(
      ...anchors.map((a) => rowIndexOf(rows, a.range!.side, a.range!.end))
    )
    // Between its first and last line, every changed line is one it marks.
    const marked = (index: number) =>
      anchors.some((a) => {
        const top = rowIndexOf(rows, a.side, a.lineNumber)
        const bottom = rowIndexOf(rows, a.range!.side, a.range!.end)
        return index >= top && index <= bottom
      })
    for (let index = first; index <= last; index++)
      if (rows[index]!.kind !== "context")
        await expect(marked(index), `row ${index}`).toBe(true)
    await expectOncePerSection(unsectioned, canvasElement)
    await expect(shownPins(canvasElement)).toHaveLength(1)
  },
}

/** The first section's pin opens one card listing all its checkpoints. */
export const CardListsEveryCheckpoint: Story = {
  play: async ({ canvasElement }) => {
    await expectOncePerSection(three, canvasElement)
    const lead = shownPins(canvasElement).find((pin) =>
      pin.numbers.includes(1)
    )!
    const count = lead.numbers.length
    await expect(count).toBeGreaterThan(1)
    // The desk's own scroll on arrival settles before the pin opens.
    await pause(1000)
    const body = within(canvasElement.ownerDocument.body)
    const name = `${count} checkpoints`
    await expectNoLayoutShift(async () => {
      await userEvent.click(lead.pin)
      await waitFor(() =>
        expect(body.getByRole("dialog", { name })).toBeVisible()
      )
    })
    await expect(
      within(body.getByRole("dialog", { name })).getAllByRole("listitem")
    ).toHaveLength(count)
  },
}

/** The pins whose card is open. */
const openPins = (canvasElement: HTMLElement) =>
  shownPins(canvasElement).filter(
    (pin) => pin.pin.getAttribute("aria-expanded") === "true"
  )

/**
 * Checkpoints on lines are their pins; the briefing has no rows for them
 * (the merged briefing, approved 25 October 2026).
 */
export const NoBriefingRows: Story = {
  play: async ({ canvasElement }) => {
    await expectOncePerSection(three, canvasElement)
    await expect(
      within(canvasElement).queryByRole("list", { name: "Checkpoints" })
    ).toBeNull()
  },
}

/**
 * A range Records merged across sections' edges: its checkpoint shows once
 * in each section it touches, on the first changed line there, and each of
 * those pins opens its own card alone.
 */
export const OnceInEachSectionItsRangeTouches: Story = {
  args: deskAt(spanning),
  play: async ({ canvasElement }) => {
    const sections = sectionsOf(spanning)
    // Recorded, the first checkpoint has one anchor across five sections.
    const ranged = checkpointAnchors(spanning).filter(
      (anchor) => numberOf(spanning, anchor) === 1
    )
    await expect(ranged).toHaveLength(1)
    await expect(ranged[0]!.range!.end).toBe(
      sections[ACROSS - 1]!.ranges.at(-1)!.endLine
    )
    await expectOncePerSection(spanning, canvasElement)
    // It shows atop each of those sections, on its first line.
    const firstLines = sections
      .slice(0, ACROSS)
      .map((section) => section.ranges[0]!.startLine)
    await expect(
      shownPins(canvasElement)
        .filter((pin) => pin.numbers.includes(1))
        .map((pin) => pin.lineNumber)
        .sort((a, b) => a - b)
    ).toEqual(firstLines)
    // The desk's own scroll on arrival settles before the pin opens.
    await pause(1000)
    // A further section's pin opens its card there alone.
    const further = shownPins(canvasElement).find(
      (pin) => pin.numbers.includes(1) && pin.lineNumber === firstLines[1]
    )!
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(further.pin)
    await waitFor(() => expect(body.getByRole("dialog")).toBeVisible())
    await waitFor(() => {
      const open = openPins(canvasElement)
      expect(open).toHaveLength(1)
      expect(open[0]!.lineNumber).toBe(firstLines[1])
    })
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(body.queryByRole("dialog")).toBeNull())
  },
}
