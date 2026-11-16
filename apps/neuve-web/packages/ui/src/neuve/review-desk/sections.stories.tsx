import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { realSectionsDeskFixtures } from "@workspace/ui/fixtures/real-sections.fixtures"
import { DEFAULT_DELIVERY_SETTINGS } from "@workspace/ui/neuve/shared/delivery"
import type { DeskAt } from "@workspace/ui/neuve/story-kit/desk"
import { deskAt, deskMeta } from "@workspace/ui/neuve/story-kit/desk"
import {
  diffRoot,
  landed,
  lit,
  mainColumn,
} from "@workspace/ui/neuve/story-kit/dom"
import { pause } from "@workspace/ui/neuve/story-kit/play"
import type { DiffSection, ReviewDeskData } from "@workspace/ui/neuve/types"

/**
 * A unit's separate changes (10.109) on a real review: units of one file
 * whose changes in one lane were joined, each change a section with its own
 * row above its lines (Main.dc.html, approved 24 October 2026).
 */
const desks = Object.values(realSectionsDeskFixtures)
const sectionsOf = (desk: ReviewDeskData): Array<DiffSection> =>
  desk.files[0]?.responsibility?.sections ?? []
const withSections = desks.filter((desk) => sectionsOf(desk).length > 1)
/** Three sections, with removed and added lines. */
const three = withSections.find((desk) => sectionsOf(desk).length === 3)!
/** Seven sections of a new test file. */
const seven = withSections.find((desk) => sectionsOf(desk).length === 7)!

/** A section's first new line, where its lines light and land. */
const firstNew = (section: DiffSection) =>
  Math.min(
    ...section.ranges
      .filter((range) => range.side === "new")
      .map((range) => range.startLine)
  )

const sectionRows = (canvasElement: HTMLElement) =>
  waitFor(
    () => {
      const rows = [
        ...canvasElement.querySelectorAll<HTMLElement>("[data-section-row]"),
      ]
      expect(rows.length).toBeGreaterThan(1)
      // Slotted into the diff, so each row has a box once the renderer drew it.
      for (const row of rows) expect(row.getClientRects().length).toBe(1)
      return rows
    },
    { timeout: 8000 }
  )

const meta = {
  title: "Screens/Real packet/Sections",
  ...deskMeta(three, {}, { settings: DEFAULT_DELIVERY_SETTINGS }),
} satisfies Meta<typeof DeskAt>

export default meta
type Story = StoryObj<typeof meta>

/**
 * Each section's row: its title (a heading), where it stands and the steps,
 * the first step up and the last step down disabled.
 */
export const Rows: Story = {
  play: async ({ canvasElement }) => {
    const rows = await sectionRows(canvasElement)
    const sections = sectionsOf(three)
    await expect(rows.map((row) => row.dataset.sectionRow)).toEqual(
      sections.map((section) => section.id)
    )
    for (const [index, row] of rows.entries()) {
      const inRow = within(row)
      await expect(
        inRow.getByRole("heading", { level: 2, name: sections[index]!.title })
      ).toBeTruthy()
      await expect(row.textContent).toContain(`${index + 1} of 3`)
      await expect(
        inRow.getByRole("button", { name: "Previous section" })
      ).toHaveProperty("disabled", index === 0)
      await expect(
        inRow.getByRole("button", { name: "Next section" })
      ).toHaveProperty("disabled", index === rows.length - 1)
    }
  },
}

/**
 * Real hover on a row lights the lines its section owns, and only those:
 * every lit row is one of its changed lines, never the unchanged lines or
 * another section's lines between its runs.
 */
export const HoverLightsItsLines: Story = {
  play: async ({ canvasElement }) => {
    const rows = await sectionRows(canvasElement)
    const root = await diffRoot(canvasElement)
    const sections = sectionsOf(three)
    for (const [index, row] of rows.entries()) {
      const owned = sections[index]!.ranges
      const owns = (side: "old" | "new", line: number) =>
        owned.some(
          (range) =>
            range.side === side &&
            line >= range.startLine &&
            line <= range.endLine
        )
      row.scrollIntoView({ block: "center" })
      await userEvent.hover(within(row).getByRole("heading"))
      await waitFor(() =>
        expect(lit(root, firstNew(sections[index]!))).toBe(true)
      )
      const litRows = [
        ...root.querySelectorAll<HTMLElement>(
          '[data-content] [data-line][data-overlay-range="hint"]'
        ),
      ]
      for (const element of litRows) {
        const type = element.getAttribute("data-line-type")
        const line = Number(element.getAttribute("data-line"))
        await expect(type).toMatch(/^change-(addition|deletion)$/)
        await expect(
          owns(type === "change-deletion" ? "old" : "new", line)
        ).toBe(true)
      }
      await userEvent.unhover(within(row).getByRole("heading"))
      await waitFor(() =>
        expect(lit(root, firstNew(sections[index]!))).toBe(false)
      )
    }
  },
}

/**
 * A step from the keyboard lands on the next section: its lines take the
 * landing tint and focus moves to the same step on its row, so Enter keeps
 * stepping; at the last section focus takes the step back up.
 */
export const StepsFromTheKeyboard: Story = {
  args: deskAt(seven),
  play: async ({ canvasElement }) => {
    const rows = await sectionRows(canvasElement)
    const root = await diffRoot(canvasElement)
    const sections = sectionsOf(seven)
    within(rows[0]!).getByRole("button", { name: "Next section" }).focus()
    await userEvent.keyboard("{Enter}")
    await waitFor(() =>
      expect(document.activeElement?.closest("[data-section-row]")).toBe(
        rows[1]
      )
    )
    await expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Next section"
    )
    await waitFor(() =>
      expect(landed(root, firstNew(sections[1]!))).toMatch(/^(a|b|static)$/)
    )
    for (let step = 2; step < rows.length; step++)
      await userEvent.keyboard("{Enter}")
    await waitFor(() =>
      expect(document.activeElement?.closest("[data-section-row]")).toBe(
        rows.at(-1)
      )
    )
    await expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Previous section"
    )
    await waitFor(() =>
      expect(landed(root, firstNew(sections.at(-1)!))).toMatch(/^(a|b|static)$/)
    )
  },
}

/**
 * Once a row has passed under the sticky file header, its title holds at the
 * top of the margin beside its lines, with the same steps. After a step to
 * the next section, the margin never shows the previous section's title.
 */
export const MarginTitleHolds: Story = {
  play: async ({ canvasElement }) => {
    const rows = await sectionRows(canvasElement)
    const desk = mainColumn(canvasElement)
    const title = (id: string) =>
      canvasElement.querySelector<HTMLElement>(
        `[data-section-title="${CSS.escape(id)}"]`
      )
    const shown = (id: string) => {
      const element = title(id)
      if (!element || getComputedStyle(element).visibility !== "visible")
        return false
      const box = element.getBoundingClientRect()
      return box.bottom > desk.getBoundingClientRect().top && box.height > 0
    }
    const [first, second] = sectionsOf(three)
    await waitFor(() => expect(title(first!.id)).not.toBeNull())
    await expect(shown(first!.id)).toBe(false)
    // The first row 200px past the top: its lines are still in view.
    desk.scrollTop +=
      rows[0]!.getBoundingClientRect().top -
      desk.getBoundingClientRect().top +
      200
    await waitFor(() => expect(shown(first!.id)).toBe(true))
    // Step from the margin title to the second section.
    await userEvent.click(
      within(title(first!.id)!).getByRole("button", { name: "Next section" })
    )
    await waitFor(
      () =>
        expect(
          Math.abs(
            rows[1]!.getBoundingClientRect().top -
              desk.getBoundingClientRect().top -
              52
          )
        ).toBeLessThan(2),
      { timeout: 4000 }
    )
    await pause(300)
    await expect(shown(first!.id)).toBe(false)
    await expect(shown(second!.id)).toBe(false)
    // Once the second row is under the header, its own title holds.
    desk.scrollTop += 120
    await waitFor(() => expect(shown(second!.id)).toBe(true))
    await expect(shown(first!.id)).toBe(false)
  },
}

/** Split view: the title on the old side, its position and steps on the new side. */
export const Split: Story = {
  args: deskAt(three, { layout: "split" }),
  globals: { viewport: { value: "wide1500", isRotated: false } },
  play: async ({ canvasElement }) => {
    const rows = await sectionRows(canvasElement)
    for (const [index, row] of rows.entries()) {
      await expect(within(row).getByRole("heading")).toBeTruthy()
      await expect(within(row).queryByRole("button")).toBeNull()
      const side = canvasElement.querySelector<HTMLElement>(
        `[slot="${row.getAttribute("slot")}:additions"]`
      )!
      await expect(side.textContent).toContain(`${index + 1} of 3`)
      await expect(
        within(side).getByRole("button", { name: "Next section" })
      ).toBeTruthy()
      await expect(side.getBoundingClientRect().left).toBeGreaterThanOrEqual(
        row.getBoundingClientRect().right - 1
      )
    }
  },
}

/**
 * On a phone the margin is gone, so the rows carry each section: title,
 * position and steps, with no sideways scroll.
 */
export const Phone: Story = {
  globals: { viewport: { value: "phone", isRotated: false } },
  play: async ({ canvasElement }) => {
    const rows = await sectionRows(canvasElement)
    for (const row of rows) {
      await expect(
        within(row).getByRole("button", { name: "Next section" })
      ).toBeTruthy()
      await expect(row.getBoundingClientRect().right).toBeLessThanOrEqual(
        window.innerWidth
      )
    }
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
      window.innerWidth
    )
  },
}

/** Reduced motion: the step's scroll is instant and the tint holds. */
export const StepReducedMotion: Story = {
  globals: { reducedMotion: "reduce" },
  play: async ({ canvasElement }) => {
    const rows = await sectionRows(canvasElement)
    const root = await diffRoot(canvasElement)
    const sections = sectionsOf(three)
    await userEvent.click(
      within(rows[1]!).getByRole("button", { name: "Next section" })
    )
    await waitFor(() =>
      expect(landed(root, firstNew(sections[2]!))).toBe("static")
    )
  },
}
