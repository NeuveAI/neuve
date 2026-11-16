import type { Meta, StoryObj, Decorator } from "@storybook/react-vite"
import type { ReactNode } from "react"
import { atom, useAtomValue, useSetAtom } from "jotai"
import { useHydrateAtoms } from "jotai/utils"
import { expect, waitFor, within } from "storybook/test"

import {
  ADMINS_UNIT_ID,
  AUDIT_UNIT_ID,
  multiBatchDeskFixture,
  reviewDeskFixture,
} from "@workspace/ui/fixtures/review-batch.fixtures"
import {
  LONG_RAIL_CURRENT_INDEX,
  longRailDeskFixture,
  longRailDeskOn,
} from "@workspace/ui/fixtures/long-rail.fixtures"
import {
  currentFileAtom,
  viewedFilesAtom,
  viewedKey,
} from "@workspace/ui/neuve/review-desk/landing"
import { Briefing } from "@workspace/ui/neuve/review-desk/briefing"
import { UnitRail } from "@workspace/ui/neuve/review-desk/unit-rail"
import {
  HeaderFrame,
  RailFrame,
  onBarePaper,
} from "@workspace/ui/neuve/story-kit/frames"
import { headerRows } from "@workspace/ui/neuve/story-kit/dom"
import { expectNoLayoutShift } from "@workspace/ui/neuve/story-kit/play"
import { withReviewDeskState } from "@workspace/ui/neuve/story-kit/store"

const meta = {
  title: "Review desk/Chrome",
  component: UnitRail,
  args: { data: reviewDeskFixture },
} satisfies Meta<typeof UnitRail>

export default meta
type Story = StoryObj<typeof meta>

/**
 * Header: logo, repo / branch, commit chip, Agents control, Find ⌘K, theme.
 * The human gate lives in the rail; Units / Files is the rail's own toggle.
 */
export const Header: Story = {
  decorators: [withReviewDeskState()],
  render: (args) => <HeaderFrame data={args.data} />,
}

/**
 * A review with several batches: the header names the batch on screen and
 * opens a menu of all of them.
 */
export const HeaderSeveralBatches: Story = {
  args: { data: multiBatchDeskFixture },
  decorators: [withReviewDeskState()],
  render: (args) => <HeaderFrame data={args.data} />,
  play: async ({ canvas, canvasElement, userEvent }) => {
    const trigger = canvas.getByRole("button", { name: /batch 1 of 3/ })
    await userEvent.click(trigger)
    const menu = await within(canvasElement.ownerDocument.body).findByRole(
      "menu",
      { name: /batch 1 of 3/ }
    )
    await expect(within(menu).getAllByRole("menuitem")).toHaveLength(3)
  },
}

/** Live (round 3): "● Live" follows the commit chip; no status strip. */
export const HeaderLive: Story = {
  decorators: [withReviewDeskState()],
  render: (args) => <HeaderFrame data={args.data} status={{ kind: "live" }} />,
}

/**
 * The event stream dropped: "Reconnecting" with an amber dot that pulses
 * (static under reduced motion); the detail is in the status text.
 */
export const HeaderReconnecting: Story = {
  decorators: [withReviewDeskState()],
  render: (args) => (
    <HeaderFrame
      data={args.data}
      status={{
        kind: "reconnecting",
        detail:
          "Updates disconnected. Showing the last loaded review while reconnecting.",
      }}
    />
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("status")).toHaveTextContent("Reconnecting")
  },
}

/**
 * Reconnecting on a 320px phone: the status sits on the breadcrumb's line,
 * after the commit and wholly inside the page; the header keeps two rows.
 */
export const HeaderReconnectingPhone320: Story = {
  ...HeaderReconnecting,
  globals: { viewport: { value: "phone320", isRotated: false } },
  parameters: {
    viewport: {
      options: {
        phone320: {
          name: "Phone 320",
          styles: { width: "320px", height: "568px" },
          type: "mobile",
        },
      },
    },
  },
  play: async ({ canvasElement }) => {
    const doc = canvasElement.ownerDocument
    await expect(doc.documentElement.clientWidth, "A 320px frame").toBe(320)
    const header = canvasElement.querySelector("header")!
    const status = within(header).getByRole("status")
    await expect(status).toHaveTextContent("Reconnecting")
    await expect(
      doc.documentElement.scrollWidth,
      "Nothing scrolls the page sideways"
    ).toBe(320)
    const rows = headerRows(header)
    await expect(rows, "The header takes two rows").toHaveLength(2)
    const commit = within(header).getByText("a3f9c2e")
    const [box, chip] = [
      status.getBoundingClientRect(),
      commit.getBoundingClientRect(),
    ]
    await expect(
      box.top,
      "The status is on the breadcrumb's line"
    ).toBeGreaterThanOrEqual(rows[1]!.top)
    await expect(box.bottom).toBeLessThanOrEqual(rows[1]!.bottom)
    await expect(box.left, "after the commit").toBeGreaterThanOrEqual(
      chip.right
    )
    await expect(box.right, "inside the page").toBeLessThanOrEqual(320)
    await expect(
      status.scrollWidth,
      "The status is shown whole"
    ).toBeLessThanOrEqual(status.clientWidth)
  },
}

const rail = (args: { data: typeof reviewDeskFixture }) => (
  <RailFrame data={args.data} />
)

/**
 * Rail: gate meter beside "Needs your decision", agent tags (I1, I2), the
 * current unit selected by tone, "Decided by agents and tools".
 */
export const Rail: Story = {
  decorators: [withReviewDeskState({ railCollapsed: false })],
  render: rail,
}
export const RailApproved: Story = {
  decorators: [withReviewDeskState({ dock: "approved", railCollapsed: false })],
  render: rail,
}
export const RailChangesRequested: Story = {
  decorators: [
    withReviewDeskState({ dock: "changes-requested", railCollapsed: false }),
  ],
  render: rail,
}

/**
 * Collapsed: a 60px column of identical 36px buttons — expand, back,
 * divider, units to decide as their lane glyph, divider, lane groups with a
 * count badge. Names are tooltips.
 */
export const RailCollapsed: Story = {
  decorators: [withReviewDeskState({ railCollapsed: true })],
  render: rail,
  play: async ({ canvasElement }) => {
    const nav = canvasElement.querySelector("nav")!
    await expect(nav.getBoundingClientRect().width).toBe(60)
    const buttons = Array.from(nav.querySelectorAll<HTMLElement>("button, a"))
    for (const button of buttons) {
      const box = button.getBoundingClientRect()
      await expect([box.width, box.height]).toEqual([36, 36])
    }
  },
}

/** The play collapses with the button, then expands again with "[". */
export const RailCollapseToggle: Story = {
  decorators: [withReviewDeskState({ railCollapsed: false })],
  render: rail,
  play: async ({ canvas, canvasElement, userEvent }) => {
    const nav = canvasElement.querySelector("nav")!
    await userEvent.click(
      canvas.getByRole("button", { name: "Collapse sidebar" })
    )
    await waitFor(() => expect(nav.getBoundingClientRect().width).toBe(60))
    await expect(nav.hasAttribute("data-collapsed")).toBe(true)
    await userEvent.click(
      canvas.getByRole("button", { name: "Expand sidebar" })
    )
    await waitFor(() =>
      expect(nav.getBoundingClientRect().width).toBeGreaterThan(200)
    )
  },
}

/**
 * A shared marker is pointed at (Graph, shared with two suggested units):
 * the Human-suggested group tone-shifts and shows one dot per linked unit.
 */
export const RailLinkedFromGraph: Story = {
  decorators: [
    withReviewDeskState({
      railCollapsed: false,
      hoverHint: { filePath: "src/sharing/revoke.ts", markerKey: "graph" },
    }),
  ],
  render: rail,
}

/** The open Doc card links the admins unit: it tone-shifts with a link glyph. */
export const RailLinkedFromDoc: Story = {
  decorators: [
    withReviewDeskState({ railCollapsed: false, openMarker: "doc" }),
  ],
  render: rail,
  play: async ({ canvas }) => {
    const admins = canvas.getByRole("link", {
      name: /Workspace admins may revoke any link/,
    })
    await expect(admins).toHaveAttribute("data-linked")
    await waitFor(() =>
      expect(
        canvas.getByRole("img", { name: "Shares the open context" })
      ).toBeVisible()
    )
  },
}

/** Collapsed rail with a linked lane group (tone shift on the icon button). */
export const RailCollapsedLinked: Story = {
  decorators: [
    withReviewDeskState({ railCollapsed: true, openMarker: "conflict" }),
  ],
  render: rail,
}

/** Briefing with numbered citations that open margin cards. */
export const BriefingWithCitations: Story = {
  decorators: [onBarePaper, withReviewDeskState()],
  render: (args) => (
    <Briefing unit={args.data.unit} revision={args.data.revision} />
  ),
}

/**
 * Lane groups expand in place to list their units (Lanes.dc.html); a unit
 * links to its desk. The play opens Human-suggested, checks a unit's link, and
 * closes it again.
 */
export const RailLaneGroupExpand: Story = {
  decorators: [withReviewDeskState({ railCollapsed: false })],
  render: rail,
  play: async ({ canvas, userEvent }) => {
    const group = canvas.getByRole("button", { name: /^Human-suggested/ })
    await expect(group).toHaveAttribute("aria-expanded", "false")
    await userEvent.click(group)
    const list = await canvas.findByRole("list", {
      name: "Human-suggested units",
    })
    const audit = within(list).getByRole("link", {
      name: /Audit event for revocation/,
    })
    await expect(audit).toHaveAttribute(
      "href",
      "/review/audit-event-for-revocation"
    )
    await userEvent.click(group)
    await waitFor(() =>
      expect(
        canvas.queryByRole("list", { name: "Human-suggested units" })
      ).toBeNull()
    )
  },
}

/** Agentic review open, with the unit sent back in red. */
export const RailLaneGroupsOpen: Story = {
  decorators: [
    withReviewDeskState({
      railCollapsed: false,
      openLanes: ["human-suggested", "agentic-review", "static-automation"],
    }),
  ],
  render: rail,
}

/** From the collapsed rail, a lane glyph expands the rail with that lane open. */
export const RailCollapsedLaneOpens: Story = {
  decorators: [withReviewDeskState({ railCollapsed: true })],
  render: rail,
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(
      canvas.getByRole("button", { name: "Agentic review · 7 units" })
    )
    await canvas.findByRole("list", { name: "Agentic review units" })
  },
}

const [firstFile, secondFile] = reviewDeskFixture.files

/** Seeds the diff's landing state: the stuck file and the viewed files. */
function withLanding(current: string | null, viewed: string[]): Decorator {
  function Hydrate({ children }: { children: ReactNode }) {
    useHydrateAtoms([
      [currentFileAtom, current],
      [
        viewedFilesAtom,
        Object.fromEntries(
          viewed.map((path) => [
            viewedKey(
              reviewDeskFixture.unit.id,
              reviewDeskFixture.revision,
              path
            ),
            true as const,
          ])
        ),
      ],
    ] as const)
    return children
  }
  return (Story) => (
    <Hydrate>
      <Story />
    </Hydrate>
  )
}

/**
 * Files tab (round 3, item 4): the file under the sticky header is current
 * (tone shift + aria-current), viewed files show a check and step back,
 * each row shows +/− counts. A row lands its file in the diff.
 */
export const RailFilesTab: Story = {
  decorators: [
    withLanding(secondFile?.path ?? null, firstFile ? [firstFile.path] : []),
    withReviewDeskState({ railCollapsed: false, browse: "files" }),
  ],
  render: rail,
  play: async ({ canvas }) => {
    const current = canvas
      .getAllByRole("button")
      .find((row) => row.getAttribute("aria-current") === "true")
    await expect(current).toBeDefined()
    await expect(canvas.getByRole("img", { name: "Viewed" })).toBeVisible()
  },
}

/**
 * Unit switch (round 3, item 10): the clicked row selects at once and shows
 * a spinner in place of its glyph; aria-current stays on the page until the
 * next unit arrives.
 */
export const RailSwitchingUnit: Story = {
  decorators: [
    withReviewDeskState({ railCollapsed: false, pendingUnit: ADMINS_UNIT_ID }),
  ],
  render: rail,
  play: async ({ canvas }) => {
    const target = canvas.getByRole("link", {
      name: /Workspace admins may revoke any link/,
    })
    await expect(target).toHaveAttribute("aria-busy", "true")
    await expect(target).not.toHaveAttribute("aria-current")
  },
}

/**
 * Selecting another unit to decide moves nothing: its spinner sits beside
 * its hunk count, and titles keep one weight, so no title wraps anew and
 * the rows below stay put.
 */
export const RailSwitchMovesNothing: Story = {
  decorators: [withReviewDeskState({ railCollapsed: false })],
  render: rail,
  play: async ({ canvas, canvasElement, userEvent }) => {
    const target = canvas.getByRole("link", {
      name: /Workspace admins may revoke any link/,
    })
    // The story has no router: the click starts the switch, then stays on
    // this page (after the rail has seen it, so it still counts as plain).
    canvasElement.ownerDocument.defaultView?.addEventListener(
      "click",
      (event) => event.preventDefault(),
      { once: true }
    )
    await expectNoLayoutShift(() => userEvent.click(target))
    await expect(target).toHaveAttribute("aria-busy", "true")
  },
}

/** Switching to a unit in a lane group: the spinner takes the lane colour. */
export const RailSwitchingToLaneUnit: Story = {
  decorators: [
    withReviewDeskState({
      railCollapsed: false,
      openLanes: ["human-suggested"],
      pendingUnit: AUDIT_UNIT_ID,
    }),
  ],
  render: rail,
}

/** The collapsed rail swaps the target's glyph for the spinner. */
export const RailCollapsedSwitching: Story = {
  decorators: [
    withReviewDeskState({ railCollapsed: true, pendingUnit: ADMINS_UNIT_ID }),
  ],
  render: rail,
}

/** Whether `inner` lies wholly inside `outer`'s box (1px of rounding allowed). */
function inside(inner: Element, outer: Element) {
  const a = inner.getBoundingClientRect()
  const b = outer.getBoundingClientRect()
  return a.top >= b.top - 1 && a.bottom <= b.bottom + 1
}

/**
 * Height containment (the owner's 43-unit review, 23 October), at the
 * owner's size: a 1000px window, so a 920px rail under the header. Human-suggested
 * holds 43 units the review could not assess; the projection names each by
 * its file and owned lines, with the folder quiet below (the full title is
 * its name and tooltip). Expanded, the group shares the rail's height and
 * scrolls inside its own list, the open unit (the 28th) scrolled into view
 * there. The play checks the rail stays within its height, the list holds
 * all 43 items and scrolls, Tab keeps the focused row in view inside it,
 * and the other groups' headers stay in view.
 */
export const RailLongLane: Story = {
  args: { data: longRailDeskFixture },
  decorators: [
    withReviewDeskState({
      railCollapsed: false,
      openLanes: ["human-suggested"],
    }),
  ],
  render: (args) => <RailFrame data={args.data} height={920} />,
  play: async ({ canvas, canvasElement, userEvent }) => {
    const nav = canvasElement.querySelector("nav")!
    const list = await canvas.findByRole("list", {
      name: "Human-suggested units",
    })
    const units = longRailDeskFixture.elsewhere[0]!.units!

    // The rail keeps to its height; the group scrolls inside instead.
    await waitFor(() =>
      expect(nav.scrollHeight).toBeLessThanOrEqual(nav.clientHeight + 1)
    )
    await expect(list.scrollHeight).toBeGreaterThan(list.clientHeight)
    // Assistive tech hears the group's count: a list of 43 items.
    await expect(within(list).getAllByRole("listitem")).toHaveLength(43)

    // The open unit is scrolled into view within its group.
    const here = within(list).getByRole("link", { current: "page" })
    await expect(here).toHaveAccessibleName(
      expect.stringContaining(units[LONG_RAIL_CURRENT_INDEX]!.title)
    )
    await waitFor(() => expect(inside(here, list)).toBe(true))
    // Named by its file and owned lines, not a path cut off at its end.
    const file = units[LONG_RAIL_CURRENT_INDEX]!.untitled!.files[0]!.path
    await expect(here).toHaveTextContent(file.slice(file.lastIndexOf("/") + 1))
    await expect(here).toHaveTextContent(/L\d+–\d+/)

    // Tab moves through the rows and keeps the focused one in view.
    here.focus()
    for (let i = 0; i < 9; i++) await userEvent.tab()
    await expect(document.activeElement).toHaveAttribute(
      "data-unit-id",
      units[LONG_RAIL_CURRENT_INDEX + 9]!.id
    )
    await waitFor(() =>
      expect(inside(document.activeElement!, list)).toBe(true)
    )

    // The other groups' headers stay in view, below the bounded list.
    for (const name of [/^Agentic review/, /^Static automation/]) {
      const header = canvas.getByRole("button", { name })
      await expect(inside(header, nav)).toBe(true)
    }
    // "Show all" belongs to the phone only.
    await expect(
      canvas.queryByRole("button", { name: "Show all 43 units" })
    ).toBeNull()
  },
}

/**
 * The same rail at phone width, where the page is the one scroll container:
 * no list scrolls inside it. Human-suggested lists six rows around the open unit
 * and "Show all 43 units" opens the group in a sheet (a modal dialog with its
 * own scroll, so nothing nests); closing it returns focus to the button.
 */
export const RailLongLanePhone: Story = {
  args: { data: longRailDeskFixture },
  globals: { viewport: { value: "phone375", isRotated: false } },
  decorators: [
    withReviewDeskState({
      railCollapsed: false,
      openLanes: ["human-suggested"],
    }),
  ],
  render: (args) => <RailFrame data={args.data} height={1400} />,
  play: async ({ canvas, userEvent }) => {
    const list = await canvas.findByRole("list", {
      name: "Human-suggested units",
    })
    await expect(getComputedStyle(list).overflowY).toBe("visible")
    const shown = within(list)
      .getAllByRole("link")
      .filter((link) => link.checkVisibility())
    await expect(shown).toHaveLength(6)
    await expect(
      within(list).getByRole("link", { current: "page" })
    ).toBeVisible()

    const showAll = canvas.getByRole("button", { name: "Show all 43 units" })
    showAll.focus()
    await userEvent.keyboard("{Enter}")
    const sheet = await canvas.findByRole("dialog", { name: "Human-suggested" })
    await expect(within(sheet).getAllByRole("listitem")).toHaveLength(43)
    // The open unit is in view in the sheet's list too.
    const sheetList = within(sheet).getByRole("list")
    await waitFor(() =>
      expect(
        inside(
          within(sheetList).getByRole("link", { current: "page" }),
          sheetList
        )
      ).toBe(true)
    )
    // Escape closes it too (a trusted key only, so the play uses Close).
    await userEvent.click(within(sheet).getByRole("button", { name: "Close" }))
    await waitFor(() => expect(canvas.queryByRole("dialog")).toBeNull())
    await expect(showAll).toHaveFocus()
  },
}

/** The unit a host has open, for the visits story (0-based). */
const openUnitAtom = atom(LONG_RAIL_CURRENT_INDEX)

/** A host that opens units without remounting the rail (Back, Forward). */
function RailVisits() {
  const index = useAtomValue(openUnitAtom)
  const open = useSetAtom(openUnitAtom)
  return (
    <div className="flex items-start gap-4">
      <RailFrame data={longRailDeskOn(index)} height={920} />
      <div className="flex flex-col gap-2 p-4">
        <button type="button" onClick={() => open(2)}>
          Open the 3rd unit
        </button>
        <button type="button" onClick={() => open(LONG_RAIL_CURRENT_INDEX)}>
          Back to the 28th unit
        </button>
      </div>
    </div>
  )
}

/**
 * Going back to a unit already visited (Back, Forward, Find) brings its row
 * into view again, and opening a row already in view never moves the list.
 * The play scrolls the list to the top, opens the 3rd unit (in view: the
 * list stays put), then goes back to the 28th (out of view: it is revealed).
 */
export const RailLongLaneVisits: Story = {
  args: { data: longRailDeskFixture },
  decorators: [
    withReviewDeskState({
      railCollapsed: false,
      openLanes: ["human-suggested"],
    }),
  ],
  render: () => <RailVisits />,
  play: async ({ canvas, userEvent }) => {
    const list = await canvas.findByRole("list", {
      name: "Human-suggested units",
    })
    const here = () => within(list).getByRole("link", { current: "page" })
    await waitFor(() => expect(inside(here(), list)).toBe(true))

    list.scrollTop = 0
    await waitFor(() => expect(inside(here(), list)).toBe(false))
    await userEvent.click(
      canvas.getByRole("button", { name: "Open the 3rd unit" })
    )
    await expect(here()).toHaveAttribute("href", expect.stringContaining("03"))
    await expect(list.scrollTop).toBe(0)

    await userEvent.click(
      canvas.getByRole("button", { name: "Back to the 28th unit" })
    )
    await waitFor(() => expect(inside(here(), list)).toBe(true))
    await expect(here()).toHaveAccessibleName(
      expect.stringContaining(
        longRailDeskFixture.elsewhere[0]!.units![LONG_RAIL_CURRENT_INDEX]!.title
      )
    )
  },
}

/**
 * At exactly 860px the rail is in its phone form (the desktop rules start at
 * 861px): six rows and "Show all", never the full list in the page.
 */
export const RailLongLaneAt860: Story = {
  args: { data: longRailDeskFixture },
  parameters: {
    viewport: {
      options: {
        w860: {
          name: "860px",
          styles: { width: "860px", height: "1000px" },
          type: "tablet",
        },
      },
    },
  },
  globals: { viewport: { value: "w860", isRotated: false } },
  decorators: [
    withReviewDeskState({
      railCollapsed: false,
      openLanes: ["human-suggested"],
    }),
  ],
  render: (args) => <RailFrame data={args.data} height={1400} />,
  play: async ({ canvas, canvasElement }) => {
    await expect(canvasElement.ownerDocument.documentElement.clientWidth).toBe(
      860
    )
    const list = await canvas.findByRole("list", {
      name: "Human-suggested units",
    })
    const shown = within(list)
      .getAllByRole("link")
      .filter((link) => link.checkVisibility())
    await expect(shown).toHaveLength(6)
    await expect(
      canvas.getByRole("button", { name: "Show all 43 units" })
    ).toBeVisible()
  },
}
