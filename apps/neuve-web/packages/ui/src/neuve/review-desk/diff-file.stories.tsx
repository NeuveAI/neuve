import type { ReactNode } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { useHydrateAtoms } from "jotai/utils"
import { useAtomValue, useSetAtom } from "jotai"
import { expect, userEvent, waitFor } from "storybook/test"

import {
  crowdedRangedFile,
  gapSizesFile,
  plainGapsFile,
  longNameRangedFile,
  removalEndRangedFile,
  longRangedFile,
  liveReviewFile,
  ownedRangesContext,
  ownedRangesFile,
  ownedRangesFiles,
  startOperationFile,
} from "@workspace/ui/fixtures/owned-ranges.fixtures"

import { diffVirtualizerAtom } from "@workspace/ui/neuve/review-desk/atoms"
import {
  VIEWED_FILES_STORAGE_KEY,
  currentFileAtom,
  landOnAtom,
  landingAtom,
} from "@workspace/ui/neuve/review-desk/landing"
import {
  // Local names kept: plays use `fileCard` and `row` as variables.
  fileCard as card,
  fileRoot,
  row as newRow,
  scroller,
} from "@workspace/ui/neuve/story-kit/dom"
import { UnitColumnFrame } from "@workspace/ui/neuve/story-kit/frames"
import {
  expectDocumentFocus,
  expectFocusVisible,
  expectNoFocusRing,
  expectNoLayoutShift,
  frames,
  pause,
  tabTo,
} from "@workspace/ui/neuve/story-kit/play"
import { withReviewDeskState } from "@workspace/ui/neuve/story-kit/store"

/**
 * Round 3 file cards (Sticky.dc.html, Ranges.dc.html, Polish.dc.html):
 * sticky headers, Viewed and collapse, jump landing, owned ranges with gap
 * rows (other units' lines folded into them), the Owned ranges / Whole file
 * switch with other units' lines attributed in the whole file, skeleton
 * rows and the split view's missing side.
 *
 * Cards render in the kit's unit column (a scroller like the desk's), so
 * headers stick to it, not to the page.
 */
const meta = {
  title: "Review desk/Diff file",
  component: UnitColumnFrame,
  args: { files: ownedRangesFiles },
  argTypes: { files: { control: false } },
  decorators: [withReviewDeskState()],
  // Viewed is per-viewer browser storage: every story starts unviewed and
  // leaves nothing behind.
  beforeEach: () => {
    localStorage.removeItem(VIEWED_FILES_STORAGE_KEY)
    return () => localStorage.removeItem(VIEWED_FILES_STORAGE_KEY)
  },
} satisfies Meta<typeof UnitColumnFrame>

export default meta
type Story = StoryObj<typeof meta>

/** What the rail's Files tab reads: the file under the sticky header. */
function CurrentFile() {
  const current = useAtomValue(currentFileAtom)
  return (
    <p className="px-8 pt-3 font-mono text-[11px] text-ink-muted">
      current: <span data-current-file="">{current ?? "none"}</span>
    </p>
  )
}

/**
 * Sticky headers (merged variant): scrolled into the second file, its
 * header holds the top of the scroller with a soft shadow, the faint
 * "2 / 3" and the compact Stacked/Split/Wrap icons. The directory truncates
 * before the basename; copy-path shows on hover or focus.
 */
export const StickyHeaders: Story = {
  render: (args) => (
    <UnitColumnFrame {...args}>
      <CurrentFile />
    </UnitColumnFrame>
  ),
  play: async ({ canvasElement }) => {
    await fileRoot(canvasElement, liveReviewFile.path)
    const box = scroller(canvasElement)
    const second = card(canvasElement, liveReviewFile.path)
    box.scrollTop +=
      second.getBoundingClientRect().top - box.getBoundingClientRect().top + 200
    await waitFor(() => {
      const header = second.querySelector<HTMLElement>("[data-file-header]")!
      expect(
        Math.abs(
          header.getBoundingClientRect().top - box.getBoundingClientRect().top
        )
      ).toBeLessThan(2)
      // The stuck-only controls take space only once stuck.
      expect(
        getComputedStyle(header.querySelector(".nv-when-stuck")!).display
      ).not.toBe("none")
      // The file under the sticky header is the current file (Files tab).
      expect(
        canvasElement.querySelector("[data-current-file]")?.textContent
      ).toBe(liveReviewFile.path)
    })
  },
}

/** Viewed: the checkbox marks the file viewed and folds it to its header. */
export const ViewedFolds: Story = {
  play: async ({ canvasElement, canvas }) => {
    await fileRoot(canvasElement, ownedRangesFiles[0]!.path)
    const viewed = canvas.getAllByRole("button", { name: "Viewed" })[0]!
    await userEvent.click(viewed)
    await expect(viewed).toHaveAttribute("aria-pressed", "true")
    await waitFor(() =>
      expect(
        card(canvasElement, ownedRangesFiles[0]!.path).querySelector(
          "diffs-container"
        )
      ).toBeNull()
    )
  },
}

/**
 * Owned ranges: this unit's lines in line order with old and new numbers;
 * "N unchanged lines · Lx–y" gap rows. The other unit's line (L142) folds
 * into the gap row around it, "179 lines · L23–201 · 1 other unit", so
 * the numbers read on across it; markers on hidden lines wait on "1 hidden"
 * pins.
 */
export const OwnedRanges: Story = {
  args: { files: [ownedRangesFile] },
  play: async ({ canvasElement, canvas }) => {
    const root = await fileRoot(canvasElement, ownedRangesFile.path)
    const host = card(canvasElement, ownedRangesFile.path)
    await waitFor(() =>
      expect(host.querySelectorAll("[data-gap-row]").length).toBe(3)
    )
    await expect(canvas.getByText("179 lines")).toBeVisible()
    await expect(canvas.getByText("L23–201")).toBeVisible()
    await expect(canvas.getByText("1 other unit")).toBeVisible()
    // No row of its own, and none of its lines drawn.
    await expect(host.querySelector('[slot^="nv-fold-"]')).toBeNull()
    await expect(root.querySelector("[data-line][data-read-only]")).toBeNull()
    await expect(canvas.queryByRole("link", { name: /Open unit/ })).toBeNull()
  },
}

/** A gap row opens 20 lines in place; the rest stays behind the row. */
export const GapOpens: Story = {
  args: { files: [ownedRangesFile] },
  play: async ({ canvasElement, canvas }) => {
    const root = await fileRoot(canvasElement, ownedRangesFile.path)
    const before = root.querySelectorAll("[data-content] [data-line]").length
    const open = canvas.getByRole("button", { name: /^Show 20 of 179 lines/ })
    await userEvent.click(open)
    await waitFor(() =>
      expect(root.querySelectorAll("[data-content] [data-line]").length).toBe(
        before + 20
      )
    )
    await expect(canvas.getByText("159 lines")).toBeVisible()
    await expect(canvas.getByText("L43–201")).toBeVisible()
  },
}

/**
 * A revealed line's gutter cell on the new side (unified or the additions
 * column). Revealed context rows read "context-expanded", so the kit's
 * numberCell doesn't match them.
 */
function revealedCell(root: ShadowRoot, line: number) {
  return root.querySelector<HTMLElement>(
    `:is([data-unified], [data-additions]) [data-column-number="${line}"]:not([data-line-type="change-deletion"])`
  )
}

/** The file's fold chevron, by the file's base name. */
function foldChevron(
  canvas: { getByRole: (role: string, options: object) => HTMLElement },
  base: string
) {
  return canvas.getByRole("button", { name: `Collapse ${base}` })
}

/**
 * Keyboard, partial: Enter opens 20 of 179 lines; the row stays (now 159)
 * and keeps focus with its ring. A second Enter opens the next chunk, never
 * folds the file.
 */
export const GapKeyboardPartial: Story = {
  args: { files: [ownedRangesFile] },
  play: async ({ canvasElement, canvas }) => {
    await fileRoot(canvasElement, ownedRangesFile.path)
    const gap = canvas.getByRole("button", { name: /^Show 20 of 179 / })
    await tabTo(gap)
    await userEvent.keyboard("{Enter}")
    await waitFor(() =>
      expect(gap.getAttribute("aria-label")).toMatch(/^Show 20 of 159 /)
    )
    await expectFocusVisible(gap)
    await userEvent.keyboard("{Enter}")
    await waitFor(() =>
      expect(gap.getAttribute("aria-label")).toMatch(/^Show 20 of 139 /)
    )
    await expectFocusVisible(gap)
    await expect(foldChevron(canvas, "index.tsx")).toHaveAttribute(
      "aria-expanded",
      "true"
    )
  },
}

/**
 * Keyboard, full: Enter opens the last 3 lines (L11–13) and the row goes;
 * focus moves to the first revealed line's gutter cell (L11), with its
 * ring, and that cell is the gutter's only tab stop. L11 isn't the unit's
 * to comment on, so it's named just "Line 11". A second Enter leaves the
 * file open.
 */
export const GapKeyboardFull: Story = {
  args: { files: [gapSizesFile] },
  play: async ({ canvasElement, canvas }) => {
    const root = await fileRoot(canvasElement, gapSizesFile.path)
    const gap = canvas.getByRole("button", {
      name: /^Show 3 of 3 unchanged lines, L11–13/,
    })
    await tabTo(gap)
    await userEvent.keyboard("{Enter}")
    const cell = await waitFor(() => {
      const found = revealedCell(root, 11)
      expect(found).toBeTruthy()
      expect(root.activeElement).toBe(found)
      return found!
    })
    await expect(gap.isConnected).toBe(false)
    await expectDocumentFocus(cell.ownerDocument)
    await expect(cell.matches(":focus-visible")).toBe(true)
    // One roving tab stop in the gutter, and it's the landing cell.
    const stops = root.querySelectorAll('[data-column-number][tabindex="0"]')
    await expect(stops).toHaveLength(1)
    await expect(stops[0]).toBe(cell)
    await expect(cell.getAttribute("aria-label")).toBe("Line 11")
    await userEvent.keyboard("{Enter}")
    await frames(2)
    await expect(foldChevron(canvas, "gap-sizes.ts")).toHaveAttribute(
      "aria-expanded",
      "true"
    )
    await expect(newRow(root, 11)).toBeTruthy()
  },
}

/** A key press on whatever has focus inside a diff's shadow root. */
function press(root: ShadowRoot, key: string, shiftKey = false) {
  ;(root.activeElement ?? root.host).dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      shiftKey,
      bubbles: true,
      composed: true,
    })
  )
}

/** Line numbers the renderer paints as selected. */
function selectedNumbers(root: ShadowRoot) {
  return [
    ...root.querySelectorAll("[data-column-number][data-selected-line]"),
  ].map((cell) => cell.getAttribute("data-column-number"))
}

/**
 * Only the unit's own lines take a comment. On a revealed line (L11) Space
 * selects nothing; the owned line above (L10) keeps "Enter to comment",
 * and extending from it with Shift+↓ moves focus to L11 but the selection
 * stops at L10, the owned boundary. Enter there comments on line 10.
 */
export const CommentableLines: Story = {
  args: { files: [gapSizesFile] },
  play: async ({ canvasElement, canvas }) => {
    const root = await fileRoot(canvasElement, gapSizesFile.path)
    await tabTo(
      canvas.getByRole("button", {
        name: /^Show 3 of 3 unchanged lines, L11–13/,
      })
    )
    await userEvent.keyboard("{Enter}")
    await waitFor(() => expect(root.activeElement).toBe(revealedCell(root, 11)))
    press(root, " ")
    await frames(2)
    await expect(selectedNumbers(root)).toEqual([])
    press(root, "ArrowUp")
    const owned = root.activeElement as HTMLElement
    await expect(owned.getAttribute("data-line-type")).toBe("change-addition")
    await expect(owned.getAttribute("aria-label")).toBe(
      "Line 10. Enter to comment, Shift+Arrow to extend."
    )
    press(root, " ")
    await waitFor(() => expect(selectedNumbers(root)).toEqual(["10"]))
    press(root, "ArrowDown", true)
    await expect(root.activeElement).toBe(revealedCell(root, 11))
    await frames(2)
    await expect(selectedNumbers(root)).toEqual(["10"])
    // Enter there comments on the clamped selection, line 10.
    press(root, "Enter")
    await expect(
      await canvas.findByPlaceholderText("Comment on line 10")
    ).toBeInTheDocument()
  },
}

/**
 * Enter comments past a clamp only right after it: Shift+↓ from the owned
 * L10 clamps (focus on L11), a plain ↓ moves on to L12, and Enter there
 * opens nothing. The selection stays on L10.
 */
export const EnterAwayFromSelectionDoesNothing: Story = {
  args: { files: [gapSizesFile] },
  play: async ({ canvasElement, canvas }) => {
    const root = await fileRoot(canvasElement, gapSizesFile.path)
    await tabTo(
      canvas.getByRole("button", {
        name: /^Show 3 of 3 unchanged lines, L11–13/,
      })
    )
    await userEvent.keyboard("{Enter}")
    await waitFor(() => expect(root.activeElement).toBe(revealedCell(root, 11)))
    press(root, "ArrowUp")
    press(root, " ")
    await waitFor(() => expect(selectedNumbers(root)).toEqual(["10"]))
    press(root, "ArrowDown", true)
    await expect(root.activeElement).toBe(revealedCell(root, 11))
    press(root, "ArrowDown")
    await expect(root.activeElement).toBe(revealedCell(root, 12))
    press(root, "Enter")
    await frames(4)
    await expect(
      canvas.queryByPlaceholderText(/^Comment on line/)
    ).not.toBeInTheDocument()
    await expect(selectedNumbers(root)).toEqual(["10"])
  },
}

/** Keys at a reader's pace: the host re-renders between presses. */
const PACE_MS = 160

/** Selected line-number cells, top to bottom. */
function selectedCells(root: ShadowRoot) {
  return [
    ...root.querySelectorAll<HTMLElement>(
      "[data-column-number][data-selected-line]"
    ),
  ]
}

/** A line-number cell as "number:type" (a removed and an added line share numbers). */
function cellKey(cell: Element | null | undefined) {
  return cell
    ? `${cell.getAttribute("data-column-number")}:${cell.getAttribute("data-line-type")}`
    : null
}

/**
 * At a reader's pace (160ms between keys), Space then three Shift+↑ select
 * four lines on a plain file, with focus on the moving end (the top). The
 * host echoes each selection back with its top line first; the extension
 * still grows from where Space was pressed.
 */
export const PacedRangeSelection: Story = {
  args: { files: [liveReviewFile] },
  play: async ({ canvasElement }) => {
    const root = await fileRoot(canvasElement, liveReviewFile.path)
    root
      .querySelector<HTMLElement>('[data-column-number][tabindex="0"]')!
      .focus()
    for (let step = 0; step < 6; step++) press(root, "ArrowDown")
    const start = cellKey(root.activeElement)
    press(root, " ")
    await pause(PACE_MS)
    for (let step = 0; step < 3; step++) {
      press(root, "ArrowUp", true)
      await pause(PACE_MS)
    }
    const cells = selectedCells(root)
    await expect(cells).toHaveLength(4)
    await expect(cellKey(cells.at(-1))).toBe(start)
    await expect(root.activeElement).toBe(cells[0])
  },
}

/**
 * Paced on owned lines, where clamping applies: Space on L204, then three
 * Shift+↑ select the whole owned run L202–204 on the added side; focus goes
 * on past the clamp to the removed L201 (the moving end).
 */
export const PacedRangeSelectionOnOwnedLines: Story = {
  args: { files: [ownedRangesFile] },
  play: async ({ canvasElement }) => {
    const root = await fileRoot(canvasElement, ownedRangesFile.path)
    const added = (line: number) =>
      root.querySelector<HTMLElement>(
        `[data-unified] [data-column-number="${line}"][data-line-type="change-addition"]`
      )!
    added(204).tabIndex = 0
    added(204).focus()
    press(root, " ")
    await pause(PACE_MS)
    for (let step = 0; step < 3; step++) {
      press(root, "ArrowUp", true)
      await pause(PACE_MS)
    }
    await expect(selectedCells(root).map(cellKey)).toEqual([
      "202:change-addition",
      "203:change-addition",
      "204:change-addition",
    ])
    await expect(cellKey(root.activeElement)).toBe("201:change-deletion")
  },
}

/** A mouse event at the centre of a line number (inside a shadow root). */
function mouseAt(type: string, cell: HTMLElement, target: EventTarget = cell) {
  const box = cell.getBoundingClientRect()
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerType: "mouse",
      pointerId: 11,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      clientX: box.left + box.width / 2,
      clientY: box.top + box.height / 2,
    })
  )
}

/**
 * Pointer selection stops where the unit's lines end: a drag from the owned
 * line (L10) down to a revealed one (L12) selects L10 only. A press on a
 * revealed line then clears it.
 */
export const PointerSelectionStopsAtOwnedLines: Story = {
  args: { files: [gapSizesFile] },
  play: async ({ canvasElement, canvas }) => {
    const root = await fileRoot(canvasElement, gapSizesFile.path)
    await userEvent.click(
      canvas.getByRole("button", {
        name: /^Show 3 of 3 unchanged lines, L11–13/,
      })
    )
    // Rows are re-created as the renderer settles: query each cell when used.
    const owned = () =>
      root.querySelector<HTMLElement>(
        '[data-unified] [data-column-number="10"][data-line-type="change-addition"]'
      )!
    const revealed = () => revealedCell(root, 12)!
    await waitFor(() => expect(revealedCell(root, 12)).toBeTruthy())
    await frames(4)
    const doc = canvasElement.ownerDocument
    mouseAt("pointerdown", owned())
    mouseAt("pointermove", revealed(), doc)
    mouseAt("pointerup", revealed(), doc)
    await waitFor(() => expect(selectedNumbers(root)).toEqual(["10"]))
    await frames(2)
    await expect(selectedNumbers(root)).toEqual(["10"])
    mouseAt("pointerdown", revealed())
    mouseAt("pointerup", revealed(), doc)
    await waitFor(() => expect(selectedNumbers(root)).toEqual([]))
  },
}

/** A mouse over a line number inside a diff's shadow root. */
function hoverNumber(cell: HTMLElement) {
  cell.dispatchEvent(
    new PointerEvent("pointermove", {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerType: "mouse",
    })
  )
}

/** The line number the gutter's "+" comment button sits on, if any. */
function utilityLine(root: ShadowRoot) {
  return (
    root
      .querySelector("[data-gutter-utility-slot]")
      ?.closest("[data-column-number]")
      ?.getAttribute("data-column-number") ?? null
  )
}

/**
 * The gutter's "+" comment button appears on hover only where the unit can
 * take a comment: not on a revealed context line (L12), yes on the owned
 * line (L10).
 */
export const CommentUtilityOnOwnedLines: Story = {
  args: { files: [gapSizesFile] },
  play: async ({ canvasElement, canvas }) => {
    const root = await fileRoot(canvasElement, gapSizesFile.path)
    await userEvent.click(
      canvas.getByRole("button", {
        name: /^Show 3 of 3 unchanged lines, L11–13/,
      })
    )
    // Rows are re-created as the renderer settles: query each cell when used.
    const revealed = () => revealedCell(root, 12)
    const owned = () =>
      root.querySelector<HTMLElement>(
        '[data-unified] [data-column-number="10"][data-line-type="change-addition"]'
      )
    await waitFor(() => expect(revealed()).toBeTruthy())
    hoverNumber(revealed()!)
    await frames(2)
    await expect(utilityLine(root)).toBeNull()
    hoverNumber(owned()!)
    await waitFor(() => expect(utilityLine(root)).toBe("10"))
    hoverNumber(revealed()!)
    await frames(2)
    await expect(utilityLine(root)).toBeNull()
  },
}

/**
 * Pointer: a click opens a chunk with no focus ring. The row that stays
 * (20 of 179) keeps focus on its labelled button; the row that goes
 * (18 of 18, L3–20) hands focus to L3. Both stay ringless.
 */
export const GapPointerExpand: Story = {
  args: { files: [ownedRangesFile] },
  play: async ({ canvasElement, canvas }) => {
    const root = await fileRoot(canvasElement, ownedRangesFile.path)
    const partial = canvas.getByRole("button", { name: /^Show 20 of 179 / })
    await userEvent.click(partial)
    await waitFor(() =>
      expect(partial.getAttribute("aria-label")).toMatch(/^Show 20 of 159 /)
    )
    await expectNoFocusRing(partial)
    await userEvent.click(
      canvas.getByRole("button", { name: /^Show 18 of 18 unchanged lines/ })
    )
    const cell = await waitFor(() => {
      const found = revealedCell(root, 3)
      expect(found).toBeTruthy()
      expect(root.activeElement).toBe(found)
      return found!
    })
    await expectDocumentFocus(cell.ownerDocument)
    await expect(cell.matches(":focus-visible")).toBe(false)
    await expect(foldChevron(canvas, "index.tsx")).toHaveAttribute(
      "aria-expanded",
      "true"
    )
  },
}

/**
 * A removed line's gutter cell (unified, or the deletions column in split):
 * it carries the old line number.
 */
function removedCell(root: ShadowRoot, line: number) {
  return root.querySelector<HTMLElement>(
    `:is([data-unified], [data-deletions]) [data-column-number="${line}"][data-line-type="change-deletion"]`
  )
}

/** The removal-only stretch's two presses: its 15 lines, then the run. */
async function openRemovalStretch(
  canvas: { getByRole: (role: string, options: object) => HTMLElement },
  step: (gap: HTMLElement) => Promise<void>
) {
  const gap = canvas.getByRole("button", {
    name: /^Show 15 of 15 lines, L4–18, including changes owned by 1 other unit$/,
  })
  await step(gap)
  await waitFor(() =>
    expect(gap.getAttribute("aria-label")).toBe(
      "Show 3 changed lines owned by Typed preparation failures and recovery messages, L−19–21"
    )
  )
  await step(gap)
  return gap
}

/**
 * Reason: the last press of a stretch that ends on another unit's
 * removal-only run reveals lines with only an old number (L−19–21). Focus
 * must land on the first of them, the removed L−19, not on new line 19 (the
 * unit's own line just below, which shares the number). Keyboard, stacked:
 * the cell takes focus with its ring and is the gutter's only tab stop.
 */
export const GapKeyboardRemovalEnd: Story = {
  args: { files: [removalEndRangedFile] },
  play: async ({ canvasElement, canvas }) => {
    const root = await fileRoot(canvasElement, removalEndRangedFile.path)
    const first = canvas.getByRole("button", { name: /^Show 15 of 15 / })
    await tabTo(first)
    const gap = await openRemovalStretch(canvas, async () => {
      await userEvent.keyboard("{Enter}")
    })
    const cell = await waitFor(() => {
      const found = removedCell(root, 19)
      expect(found).toBeTruthy()
      expect(root.activeElement).toBe(found)
      return found!
    })
    await expect(gap.isConnected).toBe(false)
    await expectDocumentFocus(cell.ownerDocument)
    await expect(cell.matches(":focus-visible")).toBe(true)
    await expect(revealedCell(root, 19)?.matches(":focus")).toBe(false)
    const stops = root.querySelectorAll('[data-column-number][tabindex="0"]')
    await expect(stops).toHaveLength(1)
    await expect(stops[0]).toBe(cell)
  },
}

/**
 * Reason: as above, in split, where the removed lines sit only in the
 * deletions column. Pointer presses: focus lands on L−19 there, without a
 * ring.
 */
export const GapPointerRemovalEndSplit: Story = {
  args: { files: [removalEndRangedFile] },
  decorators: [withReviewDeskState({ layout: "split" })],
  play: async ({ canvasElement, canvas }) => {
    const root = await fileRoot(canvasElement, removalEndRangedFile.path)
    await waitFor(() =>
      expect(root.querySelector("[data-deletions]")).toBeTruthy()
    )
    await openRemovalStretch(canvas, (gap) => userEvent.click(gap))
    const cell = await waitFor(() => {
      const found = root.querySelector<HTMLElement>(
        '[data-deletions] [data-column-number="19"][data-line-type="change-deletion"]'
      )
      expect(found).toBeTruthy()
      expect(root.activeElement).toBe(found)
      return found!
    })
    await expectDocumentFocus(cell.ownerDocument)
    await expect(cell.matches(":focus-visible")).toBe(false)
  },
}

/**
 * Opened part by part, the gap row reaches the other unit's line: it shows
 * in place, read-only, with its owner chip in the margin; the row moves on
 * to the unchanged lines below it (and keeps focus).
 */
export const SiblingShown: Story = {
  args: { files: [ownedRangesFile] },
  play: async ({ canvasElement, canvas }) => {
    const root = await fileRoot(canvasElement, ownedRangesFile.path)
    const gap = canvas.getByRole("button", { name: /^Show 20 of 179 / })
    // 119 unchanged lines in 6 presses, then the other unit's run.
    for (let press = 0; press < 6; press++) await userEvent.click(gap)
    await waitFor(() =>
      expect(gap.getAttribute("aria-label")).toBe(
        "Show 2 changed lines owned by Typed preparation failures and recovery messages, L142"
      )
    )
    await userEvent.click(gap)
    await waitFor(() =>
      expect(root.querySelectorAll("[data-line][data-read-only]").length).toBe(
        2
      )
    )
    await expect(
      canvas.getByRole("link", {
        name: "L142 owned by Typed preparation failures and recovery messages, Agentic review. Open unit",
      })
    ).toBeVisible()
    await expect(gap.getAttribute("aria-label")).toBe(
      "Show 20 of 59 unchanged lines, L143–201"
    )
    await expect(canvas.queryByText("1 other unit")).toBeNull()
  },
}

/**
 * Whole file replaces the old "Original submitted patch" disclosure: every
 * line, no gap rows; the other unit's line read-only with its owner chip.
 */
export const WholeFile: Story = {
  args: { files: [ownedRangesFile] },
  play: async ({ canvasElement, canvas }) => {
    const root = await fileRoot(canvasElement, ownedRangesFile.path)
    await userEvent.click(canvas.getByRole("radio", { name: "Whole file" }))
    await waitFor(() =>
      // 243 new lines plus the 4 removed ones.
      expect(root.querySelectorAll("[data-content] [data-line]").length).toBe(
        247
      )
    )
    await expect(
      root.querySelectorAll("[data-line][data-read-only]").length
    ).toBe(2)
    await expect(canvasElement.querySelector("[data-gap-row]")).toBeNull()
    await expect(
      canvas.getByRole("link", {
        name: "L142 owned by Typed preparation failures and recovery messages, Agentic review. Open unit",
      })
    ).toBeVisible()
  },
}

/**
 * Real volume (the owner's InteractionManager.ts): this unit's 4 runs among
 * 12 runs of 6 other units. Owned ranges keeps to this unit's lines with 5
 * quiet gap rows, each naming how many other units own changes behind it;
 * Whole file draws every line, other units' runs muted, each with its owner
 * chip (12 chips, links to their units).
 */
export const CrowdedFile: Story = {
  args: { files: [crowdedRangedFile] },
  play: async ({ canvasElement, canvas }) => {
    const root = await fileRoot(canvasElement, crowdedRangedFile.path)
    const host = card(canvasElement, crowdedRangedFile.path)
    await waitFor(() =>
      expect(host.querySelectorAll("[data-gap-row]").length).toBe(5)
    )
    await expect(
      [...host.querySelectorAll("[data-gap-row] [data-gap-range]")].map(
        (range) => range.textContent
      )
    ).toEqual(["L1–252", "L256–303", "L306–381", "L383–521", "L524–704"])
    await expect(root.querySelector("[data-line][data-read-only]")).toBeNull()
    await expect(canvas.queryAllByRole("link", { name: /Open unit$/ })).toEqual(
      []
    )
    await userEvent.click(canvas.getByRole("radio", { name: "Whole file" }))
    await waitFor(() =>
      expect(canvas.getAllByRole("link", { name: /Open unit$/ })).toHaveLength(
        12
      )
    )
    await expect(host.querySelector("[data-gap-row]")).toBeNull()
    // Other units' runs: 16 removed and 18 added lines, all read-only.
    await expect(
      root.querySelectorAll("[data-content] [data-line][data-read-only]").length
    ).toBe(34)
  },
}

function LandingButtons() {
  const landOn = useSetAtom(landOnAtom)
  return (
    <div className="flex gap-2 px-8 pt-4">
      <button
        type="button"
        className="rounded-md bg-sug-tint px-2 font-mono text-[11px] text-sug-ink"
        onClick={() =>
          landOn({
            unitId: ownedRangesContext.unitId,
            filePath: ownedRangesFile.path,
            range: { start: 202, end: 204, side: "additions" },
          })
        }
      >
        Notice refresh ↓
      </button>
      <button
        type="button"
        className="rounded-md bg-raised px-2 font-mono text-[11px]"
        onClick={() =>
          landOn({
            unitId: ownedRangesContext.unitId,
            filePath: liveReviewFile.path,
          })
        }
      >
        live-review.ts
      </button>
      <button
        type="button"
        className="rounded-md bg-raised px-2 font-mono text-[11px]"
        onClick={() =>
          landOn({
            unitId: ownedRangesContext.unitId,
            filePath: ownedRangesFile.path,
            range: { start: 142, end: 142, side: "additions" },
          })
        }
      >
        Other unit&apos;s line ↓
      </button>
      <button
        type="button"
        className="rounded-md bg-raised px-2 font-mono text-[11px]"
        onClick={() =>
          landOn({
            unitId: "another-unit",
            filePath: ownedRangesFile.path,
            range: { start: 202, end: 204, side: "additions" },
          })
        }
      >
        Same path, other unit
      </button>
      <LandingState />
    </div>
  )
}

/** Whether a landing request is pending (the diff clears what it handles). */
function LandingState() {
  const target = useAtomValue(landingAtom)
  return (
    <span data-landing={target ? "pending" : "none"} className="sr-only">
      {target ? "pending" : "none"}
    </span>
  )
}

/**
 * Jump landing: a briefing chip scrolls L202–204 below the sticky header
 * and tints them (hold 275ms, fade 825ms; static under reduced motion).
 * A file landing scrolls its header to the top. A folded file opens.
 */
export const Landing: Story = {
  // The owned-ranges file sits between two others, so L202 can reach the
  // top of the scroller (a last file would stop at the end of the content).
  args: { files: [startOperationFile, ownedRangesFile, liveReviewFile] },
  render: (args) => (
    <UnitColumnFrame {...args}>
      <LandingButtons />
    </UnitColumnFrame>
  ),
  play: async ({ canvasElement, canvas }) => {
    const root = await fileRoot(canvasElement, ownedRangesFile.path)
    const box = scroller(canvasElement)
    // Unit scope: the same path in another unit is not this card's; nobody
    // renders it, so the request is cleared and nothing scrolls.
    await userEvent.click(
      canvas.getByRole("button", { name: "Same path, other unit" })
    )
    await waitFor(() =>
      expect(
        canvasElement
          .querySelector("[data-landing]")
          ?.getAttribute("data-landing")
      ).toBe("none")
    )
    await pause(300)
    await expect(box.scrollTop).toBe(0)
    await expect(root.querySelector("[data-overlay-land]")).toBeNull()

    // A long jump (several screens): the tint starts only once the scroll
    // has arrived, with L202 below the 44px sticky header.
    await userEvent.click(
      canvas.getByRole("button", { name: /Notice refresh/ })
    )
    await waitFor(
      () => {
        const row = newRow(root, 202)
        expect(row?.hasAttribute("data-overlay-land")).toBe(true)
        const top =
          row!.getBoundingClientRect().top - box.getBoundingClientRect().top
        expect(top).toBeGreaterThanOrEqual(44)
        expect(top).toBeLessThanOrEqual(76)
      },
      { timeout: 4000, interval: 30 }
    )
  },
}

/**
 * Landing on another unit's line (a briefing chip or the Files tab): the
 * gap row holding it opens whole, and L142 shows read-only and tinted.
 */
export const LandingOnOtherUnitsLines: Story = {
  args: { files: [startOperationFile, ownedRangesFile, liveReviewFile] },
  render: (args) => (
    <UnitColumnFrame {...args}>
      <LandingButtons />
    </UnitColumnFrame>
  ),
  play: async ({ canvasElement, canvas }) => {
    const root = await fileRoot(canvasElement, ownedRangesFile.path)
    await userEvent.click(
      canvas.getByRole("button", { name: /Other unit's line/ })
    )
    await waitFor(
      () => {
        const row = newRow(root, 142)
        expect(row?.hasAttribute("data-read-only")).toBe(true)
        expect(row?.hasAttribute("data-overlay-land")).toBe(true)
      },
      { timeout: 4000, interval: 30 }
    )
    await expect(
      card(canvasElement, ownedRangesFile.path).querySelector(
        "[data-gap-row] [data-gap-range]"
      )?.textContent
    ).not.toBe("L23–201")
  },
}

/**
 * Split view: the side a change does not have gets the flat --nv-expand
 * fill (no hatching, no blank white).
 */
export const SplitFill: Story = {
  args: { files: [liveReviewFile, ownedRangesFile] },
  decorators: [withReviewDeskState({ layout: "split" })],
  play: async ({ canvasElement }) => {
    const root = await fileRoot(canvasElement, ownedRangesFile.path)
    // L21–22 were added: their left side is the flat --nv-expand fill.
    const buffer = await waitFor(() => {
      const found = root.querySelector<HTMLElement>("[data-content-buffer]")
      expect(found).toBeTruthy()
      return found!
    })
    const probe = document.createElement("span")
    probe.style.backgroundColor = "var(--nv-expand)"
    canvasElement.append(probe)
    const expand = getComputedStyle(probe).backgroundColor
    probe.remove()
    await expect(getComputedStyle(buffer).backgroundImage).toBe("none")
    await expect(getComputedStyle(buffer).backgroundColor).toBe(expand)
  },
}

/**
 * Gap sizes: a 1-line gap shows inline (L6); gaps of 2 and 3 lines get a
 * row that opens them (L8–9, L11–13). The marker on L9 waits on the 2-line
 * gap's "1 hidden" pin until it opens.
 */
export const GapSizes: Story = {
  args: { files: [gapSizesFile] },
  play: async ({ canvasElement, canvas }) => {
    const root = await fileRoot(canvasElement, gapSizesFile.path)
    await expect(newRow(root, 6)).toBeTruthy()
    await expect(newRow(root, 8)).toBeUndefined()
    await expect(canvas.getByText("2 unchanged lines")).toBeVisible()
    await expect(canvas.getByText("3 unchanged lines")).toBeVisible()
    await expect(
      canvas.getByRole("button", { name: /1 marker in hidden lines/ })
    ).toBeVisible()
    await userEvent.click(
      canvas.getByRole("button", { name: /^Show 2 of 2 unchanged lines, L8–9/ })
    )
    await waitFor(() => {
      expect(newRow(root, 8)).toBeTruthy()
      expect(newRow(root, 9)).toBeTruthy()
    })
  },
}

function Pending({ children }: { children: ReactNode }) {
  // The desk's Virtualizer has not mounted yet: hosts wait, as on the server.
  useHydrateAtoms([[diffVirtualizerAtom, "pending"]] as const)
  return children
}

/**
 * Skeleton rows: before the renderer attaches (server render, the desk's
 * first frame) a file shows its line numbers and bars, never a blank band.
 * Rows the virtualizer has not painted get the same skeleton (see "Overlay
 * annotations / Long file virtualized" while scrolling fast).
 */
export const Skeleton: Story = {
  args: { files: [liveReviewFile] },
  decorators: [
    (Story) => (
      <Pending>
        <Story />
      </Pending>
    ),
  ],
  play: async ({ canvasElement }) => {
    const host = canvasElement.querySelector<HTMLElement>("diffs-container")!
    const skeleton = host.querySelector<HTMLElement>("[data-skeleton]")!
    // The whole reserved height is skeleton: numbered rows, then bars.
    await expect(skeleton.getBoundingClientRect().height).toBeGreaterThan(
      host.getBoundingClientRect().height - 1
    )
    await expect(
      skeleton.querySelectorAll(":scope > .grid").length
    ).toBeGreaterThan(0)
  },
}

/**
 * A 4,000-line file: owned ranges render every row at once (two runs and
 * their gap rows); Whole file is past WHOLE_FILE_VIRTUAL_ROWS and switches
 * to the desk's Virtualizer, the sibling's line read-only without its row.
 */
export const WholeFileLong: Story = {
  args: { files: [longRangedFile], virtualized: true },
  play: async ({ canvasElement, canvas }) => {
    const longHost = () =>
      canvasElement.querySelector<HTMLElement>("diffs-container")!
    await fileRoot(canvasElement, longRangedFile.path)
    await expect(longHost().dataset.virtualized).toBe("false")
    await userEvent.click(canvas.getByRole("radio", { name: "Whole file" }))
    await waitFor(
      () => {
        expect(longHost().dataset.virtualized).toBe("true")
        const rows = longHost().shadowRoot?.querySelectorAll(
          "[data-content] [data-line]"
        )
        expect(rows?.length ?? 0).toBeGreaterThan(0)
        expect(rows?.length ?? 0).toBeLessThan(400)
      },
      { timeout: 8000 }
    )
    // No sibling row in this mode: the owning unit stays named on a pin.
    await expect(
      canvas.getByRole("link", {
        name: "L3000 owned by Typed preparation failures and recovery messages, Agentic review. Open unit",
      })
    ).toBeTruthy()
  },
}

/**
 * Copy path: the icon confirms ("Copied …") and reverts after a moment.
 */
export const CopyPath: Story = {
  args: { files: [liveReviewFile] },
  play: async ({ canvasElement, canvas }) => {
    await fileRoot(canvasElement, liveReviewFile.path)
    // Storybook's frame may not grant clipboard access; stub the write.
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.resolve() },
    })
    await userEvent.click(
      canvas.getByRole("button", { name: `Copy path ${liveReviewFile.path}` })
    )
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: `Copied ${liveReviewFile.path}` })
      ).toBeTruthy()
    )
    await waitFor(
      () =>
        expect(
          canvas.getByRole("button", {
            name: `Copy path ${liveReviewFile.path}`,
          })
        ).toBeTruthy(),
      { timeout: 3000 }
    )
  },
}

/** WCAG contrast ratio of two computed `rgb(…)` colours. */
function contrast(foreground: string, background: string) {
  const luminance = (color: string) => {
    const [r, g, b] = (color.match(/[\d.]+/g) ?? []).map(Number)
    const channel = (value = 0) => {
      const c = value / 255
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
  }
  const [hi, lo] = [luminance(foreground), luminance(background)].sort(
    (a, b) => b - a
  )
  return (hi! + 0.05) / (lo! + 0.05)
}

/**
 * Gap ranges read in --nv-muted (round 3.1, D3): "Lx–y" on owned-range gap
 * rows and on Pierre's restyled separators keeps 4.5:1 or more against the
 * row, in light and dark; so does a row's "N other units".
 */
export const GapRangeContrast: Story = {
  args: { files: [gapSizesFile, plainGapsFile, ownedRangesFile] },
  play: async ({ canvasElement }) => {
    const ranged = await fileRoot(canvasElement, gapSizesFile.path)
    const plain = await fileRoot(canvasElement, plainGapsFile.path)
    void ranged
    const html = document.documentElement
    const wasDark = html.classList.contains("dark")
    try {
      for (const dark of [false, true]) {
        html.classList.toggle("dark", dark)
        await waitFor(() => {
          const range =
            canvasElement.querySelector<HTMLElement>("[data-gap-range]")!
          const row = range.closest<HTMLElement>("[slot]")!
          expect(
            contrast(
              getComputedStyle(range).color,
              getComputedStyle(row).backgroundColor
            )
          ).toBeGreaterThanOrEqual(4.5)
          const owners =
            canvasElement.querySelector<HTMLElement>("[data-gap-owners]")!
          expect(
            contrast(
              getComputedStyle(owners).color,
              getComputedStyle(owners.closest<HTMLElement>("[slot]")!)
                .backgroundColor
            )
          ).toBeGreaterThanOrEqual(4.5)
          const count = plain.querySelector<HTMLElement>(
            "[data-gutter] [data-unmodified-lines][data-hidden-range]"
          )!
          const after = getComputedStyle(count, "::after")
          expect(after.content).toContain("L")
          expect(after.opacity).toBe("1")
          const wrapper = count.closest<HTMLElement>(
            "[data-separator-wrapper]"
          )!
          expect(
            contrast(after.color, getComputedStyle(wrapper).backgroundColor)
          ).toBeGreaterThanOrEqual(4.5)
        })
      }
    } finally {
      html.classList.toggle("dark", wasDark)
    }
  },
}

/** What a header shows: its shed stage and each control's state. */
function headerState(header: HTMLElement) {
  const shown = (el: Element | null) =>
    !!el && getComputedStyle(el).display !== "none"
  const basename = header.querySelector<HTMLElement>("[data-basename]")!
  const viewedLabel = header.querySelector<HTMLElement>(".nv-viewed-label")!
  const counts = header.querySelector<HTMLElement>(".nv-counts")!
  const copy = header.querySelector<HTMLElement>(".nv-copy")!
  return {
    stage: Number(header.dataset.shed ?? 0),
    stuckControls: shown(header.querySelector(".nv-when-stuck")),
    short: shown(header.querySelector(".nv-short")),
    viewedLabel: viewedLabel.getBoundingClientRect().width > 1,
    // Visible, or kept only for screen readers (in the tree, 1px).
    counts: counts.getBoundingClientRect().width > 1,
    countsInTree: shown(counts) && /\+\d+\s*−\d+/.test(counts.textContent),
    // Shed: out of the layout (absolute) and visually hidden (1px), yet
    // still in the tab order and the tree.
    copyShed:
      getComputedStyle(copy).position === "absolute" &&
      copy.getBoundingClientRect().width <= 1,
    // Layout width it reserves (none while hidden or shed).
    copyWidth:
      getComputedStyle(copy).position === "absolute" || !shown(copy)
        ? 0
        : copy.getBoundingClientRect().width,
    directory: basename.previousElementSibling!.getBoundingClientRect().width,
    truncated: basename.scrollWidth > basename.clientWidth,
    overflow: header.scrollWidth - header.clientWidth,
  }
}

/**
 * The file name wins (round 3.1, D2), measured, not at fixed widths. As a
 * stuck header with a long basename narrows: the directory goes first, then
 * the stuck controls, the toggle's long labels, the Viewed label and the
 * +/− counts; only then does the basename truncate. Room freed beyond the
 * name's needs shows the directory again. A long name in a wide
 * header is never cut while a control can still shed. Accessible names
 * stay. The header never overflows.
 */
export const NarrowHeaders: Story = {
  args: { files: [liveReviewFile, longNameRangedFile, startOperationFile] },
  play: async ({ canvasElement, canvas }) => {
    await fileRoot(canvasElement, longNameRangedFile.path)
    const box = scroller(canvasElement)
    const fileCard = card(canvasElement, longNameRangedFile.path)
    const outer = fileCard.querySelector<HTMLElement>("[data-file-header]")!
    const header = outer.firstElementChild as HTMLElement
    // Stick its header: scroll the card's top just past the scroller's.
    box.scrollTop +=
      fileCard.getBoundingClientRect().top -
      box.getBoundingClientRect().top +
      40
    const states: Array<ReturnType<typeof headerState> & { width: number }> = []
    for (const width of [1000, 900, 800, 700, 640, 560, 480, 420, 360]) {
      fileCard.style.width = ""
      const extra =
        fileCard.getBoundingClientRect().width -
        header.getBoundingClientRect().width
      fileCard.style.width = `${width + extra}px`
      await waitFor(() =>
        expect(Math.round(header.getBoundingClientRect().width)).toBe(width)
      )
      // The fit runs in a ResizeObserver: let it settle.
      await new Promise((resolve) => requestAnimationFrame(resolve))
      await new Promise((resolve) => requestAnimationFrame(resolve))
      states.push({ width, ...headerState(outer) })
    }
    // Copy-path stays reachable when shed: still in the tab order, and on
    // keyboard focus it shows as an overlay at the header's end (no width).
    {
      const copy = outer.querySelector<HTMLButtonElement>(".nv-copy")!
      expect(states.at(-1)!.stage).toBe(4)
      expect(copy.tabIndex).toBeGreaterThanOrEqual(0)
      copy.focus({ focusVisible: true })
      expect(document.activeElement).toBe(copy)
      await waitFor(() => {
        const shown = copy.getBoundingClientRect()
        const end = header.getBoundingClientRect()
        expect(Math.round(shown.width)).toBe(28)
        expect(getComputedStyle(copy).clipPath).toBe("none")
        expect(shown.right).toBeLessThanOrEqual(end.right)
        expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth)
      })
      copy.blur()
    }

    // Before any fit (the server render, the first frame): the name may
    // shrink and the path box clips, so the name never overflows or paints
    // over the counts. Reproduced by clearing the fit at a desk-like width
    // where the fitted header sheds everything (700px: stage 4).
    {
      fileCard.style.width = ""
      const extra =
        fileCard.getBoundingClientRect().width -
        header.getBoundingClientRect().width
      fileCard.style.width = `${700 + extra}px`
      await waitFor(() => expect(outer.dataset.shed).toBe("4"))
      delete outer.dataset.fit
      delete outer.dataset.shed
      const path = outer.querySelector<HTMLElement>("[data-path]")!
      const counts = outer.querySelector<HTMLElement>(".nv-counts")!
      expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth)
      expect(path.getBoundingClientRect().right).toBeLessThanOrEqual(
        counts.getBoundingClientRect().left
      )
      expect(getComputedStyle(path).overflow).toBe("hidden")

      // A phone-width header before any fit (the server render until
      // hydration): the fallback breakpoints shed the controls, so the
      // header fits and the name keeps visible width.
      fileCard.style.width = ""
      const narrow =
        fileCard.getBoundingClientRect().width -
        header.getBoundingClientRect().width
      fileCard.style.width = `${340 + narrow}px`
      await waitFor(() =>
        expect(Math.round(header.getBoundingClientRect().width)).toBe(340)
      )
      delete outer.dataset.fit
      delete outer.dataset.shed
      const name = outer.querySelector<HTMLElement>("[data-basename]")!
      expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth)
      expect(name.getBoundingClientRect().width).toBeGreaterThan(0)
    }
    fileCard.style.width = ""
    for (const state of states) {
      expect(state.overflow, `overflow at ${state.width}`).toBeLessThanOrEqual(
        0
      )
      // The directory yields before everything: shown at all, the name is
      // whole (it only gets room left over once the name fits).
      if (state.directory >= 1) expect(state.truncated).toBe(false)
      // Order: each stage implies every earlier one.
      if (state.stage >= 1) expect(state.stuckControls).toBe(false)
      // Copy-path: shed with the stuck controls; never reserves width
      // while hidden (the pointer is not on the header).
      if (state.stage >= 1) expect(state.copyShed).toBe(true)
      expect(state.copyWidth).toBe(0)
      // The counts stay for screen readers at every stage.
      expect(state.countsInTree).toBe(true)
      if (state.stage >= 2) expect(state.short).toBe(true)
      if (state.stage >= 3) expect(state.viewedLabel).toBe(false)
      if (state.stage >= 4) expect(state.counts).toBe(false)
      if (state.stage < 4) {
        expect(state.counts).toBe(true)
        // A control can still shed: the name is whole.
        expect(state.truncated, `cut at ${state.width}`).toBe(false)
      }
      if (state.stage < 3) expect(state.viewedLabel).toBe(true)
      if (state.stage < 2) expect(state.short).toBe(false)
    }
    // Narrowing never un-sheds. A long name in a wide header is whole (its
    // stuck controls gave way); the narrowest has shed everything and only
    // then cut the name.
    for (let i = 1; i < states.length; i++)
      expect(states[i]!.stage).toBeGreaterThanOrEqual(states[i - 1]!.stage)
    expect(states[0]!.truncated).toBe(false)
    expect(states[0]!.stage).toBeLessThan(4)
    expect(states.at(-1)!.stage).toBe(4)
    expect(states.at(-1)!.truncated).toBe(true)
    // Accessible names never change.
    expect(canvas.getAllByRole("radio", { name: "Owned ranges" })).toHaveLength(
      1
    )
    expect(canvas.getAllByRole("radio", { name: "Whole file" })).toHaveLength(1)
    expect(canvas.getAllByRole("button", { name: "Viewed" }).length).toBe(3)
  },
}

/** Where a header's parts sit within it, and how much it has shed. */
function headerLayout(header: HTMLElement) {
  const box = header.getBoundingClientRect()
  const at = (selector: string) => {
    const { x, y, width } = header
      .querySelector(selector)!
      .getBoundingClientRect()
    return {
      x: Math.round(x - box.x),
      y: Math.round(y - box.y),
      width: Math.round(width),
    }
  }
  return {
    shed: header.dataset.shed ?? "0",
    path: at("[data-path]"),
    basename: at("[data-basename]"),
    lines: at('[aria-label="Lines shown"]'),
  }
}

/**
 * A header mounted far below the fold has fitted already. In a narrow desk
 * column (a 480px header, which the fit and the pre-fit fallback lay out
 * differently) a play scrolls the second card's header into view and at
 * once clicks a pin under it: nothing moves, and the header stays as it was
 * first drawn. Its fit never waits for it to come into view, and a click
 * never refits it.
 */
export const ScrolledInPinClick: Story = {
  args: { files: [startOperationFile, ownedRangesFile, liveReviewFile] },
  render: (args) => (
    <div style={{ width: 860 }}>
      <UnitColumnFrame {...args} />
    </div>
  ),
  play: async ({ canvasElement, canvas }) => {
    await fileRoot(canvasElement, ownedRangesFile.path)
    const box = scroller(canvasElement)
    const fileCard = card(canvasElement, ownedRangesFile.path)
    const header = fileCard.querySelector<HTMLElement>("[data-file-header]")!
    // Mounted well past the fold, beyond any on-screen margin.
    await expect(
      fileCard.getBoundingClientRect().top - box.getBoundingClientRect().bottom
    ).toBeGreaterThan(box.clientHeight)
    const pin = canvas.getByRole("button", { name: /^Doc on line 21\b/ })
    let drawn: ReturnType<typeof headerLayout> | undefined
    await expectNoLayoutShift(async () => {
      // Its header in view, below the top (not stuck), read as the next
      // frame draws it. One card gap down, so the card above, and its
      // header stuck at that card's foot, end just out of view.
      box.scrollTop +=
        fileCard.getBoundingClientRect().top -
        box.getBoundingClientRect().top -
        20
      drawn = headerLayout(header)
      await userEvent.click(pin)
      await waitFor(() => expect(pin).toHaveAttribute("aria-expanded", "true"))
    })
    await expect(headerLayout(header)).toEqual(drawn)
  },
}
