import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fireEvent, waitFor, within } from "storybook/test"

import {
  goDeliveryDeskFixture,
  longFileDeskFixture,
  POLICY_COMMENT_ID,
  SESSIONS_COMMENT_ID,
  reviewCommentFixtures,
  reviewDeskFixture,
  reviewDeskLiveFixture,
  reviewDeskLongCardFixture,
  reviewBatchesFixture,
  threadPermissionScript,
  threadReplyScript,
  threadRetryScript,
  threadStateFixtures,
} from "@workspace/ui/fixtures/review-batch.fixtures"
import {
  lastUndecidedDeskFixture,
  nextUndecidedDeskFixture,
} from "@workspace/ui/fixtures/shell.fixtures"
import { OPACITY } from "@workspace/ui/lib/motion"
import { commentMarkerKey } from "@workspace/ui/neuve/review-comments/markers"
import { createMockThreadRelay } from "@workspace/ui/neuve/review-comments/mock-thread-relay"
import {
  VIEWED_FILES_STORAGE_KEY,
  viewedKey,
} from "@workspace/ui/neuve/review-desk/landing"
import { DEFAULT_DELIVERY_SETTINGS } from "@workspace/ui/neuve/shared/delivery"
import { DeskAt, deskAt, deskMeta } from "@workspace/ui/neuve/story-kit/desk"
import {
  diffHosts as hosts,
  diffRoot,
  expectAttached,
  floatingCard,
  headerRows,
  mainColumn,
  openCard,
  pinOf,
  placedPin,
} from "@workspace/ui/neuve/story-kit/dom"
import {
  chooseStop,
  expectFocusVisible,
  expectNoLayoutShift,
  frames,
  pause,
} from "@workspace/ui/neuve/story-kit/play"

/**
 * Review desk screen (Main.dc.html). Every state of the disclosure model and
 * the decision dock is reachable by interaction from `Rest`; the other
 * stories seed one state directly. Each story's desk has its own in-memory
 * comment store and the default workspace delivery setting, in memory:
 * stories never read or write the reviewer's real comments or setting.
 */
const meta = {
  title: "Screens/Review desk",
  ...deskMeta("revoke-live", {}, { settings: DEFAULT_DELIVERY_SETTINGS }),
} satisfies Meta<typeof DeskAt>

export default meta
type Story = StoryObj<typeof meta>

const SESSIONS_MARKER = commentMarkerKey(SESSIONS_COMMENT_ID)

export const Rest: Story = {}

/** A key press on whatever has focus inside a diff's shadow root. */
function pressIn(root: ShadowRoot, key: string, shiftKey = false) {
  ;(root.activeElement ?? root.host).dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      shiftKey,
      bubbles: true,
      composed: true,
    })
  )
}

/** A line-number cell as "number:type". */
function cellKey(cell: Element | null | undefined) {
  return cell
    ? `${cell.getAttribute("data-column-number")}:${cell.getAttribute("data-line-type")}`
    : null
}

/**
 * Keyboard range selection on the full desk, at a reader's pace (160ms
 * between keys): the desk re-renders the rows on every selection, and focus
 * stays on the gutter. Space then three Shift+↑ select four lines, with
 * focus on the moving end (the top).
 */
export const PacedRangeSelection: Story = {
  play: async ({ canvasElement }) => {
    const root = await diffRoot(canvasElement)
    root
      .querySelector<HTMLElement>('[data-column-number][tabindex="0"]')!
      .focus()
    for (let step = 0; step < 4; step++) pressIn(root, "ArrowDown")
    const start = cellKey(root.activeElement)
    pressIn(root, " ")
    await pause(160)
    // The row re-rendered under the cursor; focus is still on that line.
    await expect(cellKey(root.activeElement)).toBe(start)
    for (let step = 0; step < 3; step++) {
      pressIn(root, "ArrowUp", true)
      await pause(160)
    }
    const cells = [
      ...root.querySelectorAll("[data-column-number][data-selected-line]"),
    ]
    await expect(cells).toHaveLength(4)
    await expect(cellKey(cells.at(-1))).toBe(start)
    await expect(root.activeElement).toBe(cells[0])
  },
}

/** L2: the conflict card is open; other pins dim and leave the tab order. */
export const ContextCardOpen: Story = {
  args: deskAt("revoke-live", { open: "conflict" }),
}

/** L2 on a second pin of the same line (sibling pin stays enabled). */
export const SameBatchCardOpen: Story = {
  args: deskAt("revoke-live", { open: "batch" }),
}

/** Graph card open: the read-by tree, and its two suggested units linked in the rail. */
export const GraphCardOpen: Story = {
  args: deskAt("revoke-live", { open: "graph" }),
}

/**
 * The Main board's default state (Main.dc.html), its story twin: the
 * conflict card open and the seeded review comments in the margin, the
 * resolved one hidden until "Show resolved".
 */
export const DeskMainBoard: Story = {
  args: deskAt("revoke-live", { open: "conflict", comments: "seeded" }),
}

/* ── Floating layers: anchored to the pin, placed against the viewport ── */

const scrollRoot = (canvasElement: HTMLElement) =>
  canvasElement.querySelector<HTMLElement>("main > div")!

/** Scroll the unit column so the pin's top lands at `y` in the viewport. */
async function scrollPinTo(
  canvasElement: HTMLElement,
  pin: HTMLElement,
  y: number
) {
  const root = scrollRoot(canvasElement)
  root.scrollTop += pin.getBoundingClientRect().top - y
  await frames(2)
}

/**
 * Scrolling with a card open keeps it attached to its pin (it follows the
 * pin; when the pin leaves the view, the card hides with it).
 */
export const CardStaysAttachedWhileScrolling: Story = {
  args: deskAt("revoke-live", { open: "conflict" }),
  play: async ({ canvasElement }) => {
    const pin = await placedPin(canvasElement, "conflict")
    const card = await floatingCard(canvasElement)
    await waitFor(() => expectAttached(pin, card))
    scrollRoot(canvasElement).scrollTop += 120
    await waitFor(() => expectAttached(pin, card))
    await expect(card.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      window.innerHeight - 7
    )
  },
}

/** Near the viewport bottom the card flips above its pin. */
export const CardFlipsAboveNearBottom: Story = {
  args: deskAt("revoke-live"),
  play: async ({ canvasElement, userEvent }) => {
    const pin = await placedPin(canvasElement, "history")
    await scrollPinTo(canvasElement, pin, window.innerHeight - 70)
    await userEvent.click(pin)
    const card = await floatingCard(canvasElement)
    await waitFor(() => expect(card.dataset.side).toBe("top"))
    await waitFor(() => expectAttached(pin, card))
    await expect(card.getBoundingClientRect().top).toBeGreaterThanOrEqual(7)
  },
}

/**
 * A pin near the right edge: the card shifts left to stay 8px inside. The
 * Test pin is alone on its line, so it opens its card directly (a line with
 * several markers opens the line's list instead).
 */
export const CardShiftsLeftNearRightEdge: Story = {
  args: deskAt("revoke-live"),
  play: async ({ canvasElement, userEvent }) => {
    const pin = await placedPin(canvasElement, "test")
    await scrollPinTo(canvasElement, pin, 160)
    await userEvent.click(pin)
    const card = await floatingCard(canvasElement)
    await waitFor(() =>
      expect(card.getBoundingClientRect().right).toBeLessThanOrEqual(
        window.innerWidth - 7
      )
    )
    // Shifted only when the card wouldn't fit from the pin's left edge.
    const { left, width } = card.getBoundingClientRect()
    const pinLeft = pin.getBoundingClientRect().left
    if (pinLeft + width > window.innerWidth - 8)
      await expect(left).toBeLessThan(pinLeft)
    else await expect(left).toBe(pinLeft)
  },
}

/**
 * A long card with no room for its full height (the pin mid-viewport):
 * the height is capped to the space left and the card scrolls inside.
 */
export const LongCardCapsHeight: Story = {
  args: deskAt(reviewDeskLongCardFixture),
  play: async ({ canvasElement, userEvent }) => {
    const pin = await placedPin(canvasElement, "graph")
    await scrollPinTo(canvasElement, pin, window.innerHeight / 2 - 11)
    await userEvent.click(pin)
    const card = await floatingCard(canvasElement)
    await waitFor(() => expectAttached(pin, card))
    const box = card.getBoundingClientRect()
    await expect(box.top).toBeGreaterThanOrEqual(7)
    await expect(box.bottom).toBeLessThanOrEqual(window.innerHeight - 7)
    await expect(card.scrollHeight).toBeGreaterThan(card.clientHeight)
  },
}

/**
 * Toggling Wrap or Split with a card open moves the pin's row; the card
 * follows it. (A press on the toolbar while a card is open would only close
 * the card, so the play toggles through the controls directly.)
 */
export const CardFollowsWrapAndSplit: Story = {
  args: deskAt("revoke-live", { open: "graph" }),
  play: async ({ canvas, canvasElement }) => {
    const card = await floatingCard(canvasElement)
    const pin = () => pinOf(canvasElement, "graph")
    await waitFor(() => expectAttached(pin(), card))
    canvas.getByRole("button", { name: "Wrap long lines" }).click()
    await waitFor(() =>
      expect(hosts(canvasElement)[0]?.dataset.wrap).toBe("false")
    )
    await waitFor(() => expectAttached(pin(), openCard(canvasElement)!))
    canvas.getByRole("radio", { name: "Split" }).click()
    await waitFor(() =>
      expect(hosts(canvasElement)[0]?.dataset.layout).toBe("split")
    )
    await waitFor(() => expectAttached(pin(), openCard(canvasElement)!))
  },
}

/**
 * A hint with no room below its pin flips up: the comment preview (a small
 * card) on the last file's comment pin, scrolled to the bottom of the view.
 * On a short window: on a tall one the whole desk fits, and nothing scrolls
 * the pin near the bottom.
 */
export const HintFlipsUpNearBottom: Story = {
  args: deskAt("revoke-live", { comments: "seeded" }),
  globals: { viewport: { value: "short", isRotated: false } },
  play: async ({ canvasElement, userEvent }) => {
    const key = commentMarkerKey(POLICY_COMMENT_ID)
    const pin = await placedPin(canvasElement, key)
    await scrollPinTo(canvasElement, pin, window.innerHeight - 40)
    await userEvent.hover(pin)
    const hint = await waitFor(() => {
      const found = canvasElement.ownerDocument.querySelector<HTMLElement>(
        "[data-floating-hint]"
      )
      expect(found).toBeVisible()
      return found!
    })
    const room = window.innerHeight - pin.getBoundingClientRect().bottom - 6 - 8
    await expect(hint.getBoundingClientRect().height).toBeGreaterThan(room)
    await waitFor(() => expect(hint.dataset.side).toBe("top"))
    await expect(hint.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      pin.getBoundingClientRect().top
    )
  },
}

/** L1: the shared hover hint for the Graph pin, with linked units in the rail. */
export const HoverHint: Story = {
  args: deskAt("revoke-live", {
    state: {
      hoverHint: { filePath: "src/sharing/revoke.ts", markerKey: "graph" },
    },
  }),
}

/**
 * Shared markers: hovering the Doc pin tone-shifts the admins unit in the
 * rail (link glyph); hovering Graph lights the Suggested group with two dots.
 */
export const SharedMarkerHover: Story = {
  play: async ({ canvasElement, userEvent }) => {
    // The overlay places (un-hides) its items on its next frame.
    const pin = await placedPin(canvasElement, "doc")
    await userEvent.hover(pin)
    const rail = within(
      canvasElement.querySelector<HTMLElement>(
        'nav[aria-label="Review units"]'
      )!
    )
    await waitFor(() =>
      expect(
        rail.getByRole("link", { name: /Workspace admins may revoke any link/ })
      ).toHaveAttribute("data-linked")
    )
    await userEvent.unhover(pin)
    const graph = pinOf(canvasElement, "graph")
    await userEvent.hover(graph)
    await waitFor(() =>
      expect(
        rail.getByRole("img", {
          name: "2 suggested units share the open context",
        })
      ).toBeVisible()
    )
    await userEvent.unhover(graph)
    await waitFor(() =>
      expect(
        rail.queryByRole("img", {
          name: "2 suggested units share the open context",
        })
      ).toBeNull()
    )
  },
}

/** L3: the ticket behind the conflict, drilled from its card. */
export const SourceSheetOpen: Story = {
  args: deskAt("revoke-live", { open: "conflict", sheet: "conflict" }),
}

/** L3 for code: editor actions, facts, highlighted lines, "Go to its unit". */
export const SourceSheetCode: Story = {
  args: deskAt("revoke-live", { open: "batch", sheet: "batch" }),
}

/** L3 for the graph: readers with their paths, coverage in red. */
export const SourceSheetGraph: Story = {
  args: deskAt("revoke-live", { open: "graph", sheet: "graph" }),
}

/** L3 for history: Show commit, the incident, the files it touched. */
export const SourceSheetHistory: Story = {
  args: deskAt("revoke-live", { open: "history", sheet: "history" }),
}

/** Read-only neighbor expanded: muted pins of its own context. */
export const NeighborExpanded: Story = {
  args: deskAt("revoke-live", { state: { neighborOpen: true } }),
}

/* ── Diff layout and wrapping ─────────────────────────── */

/** Split: removed and added rows side by side; pins on the new-side row. */
export const Split: Story = {
  args: deskAt("revoke-live", { layout: "split" }),
  play: async ({ canvasElement }) => {
    await waitFor(() =>
      expect(hosts(canvasElement)[0]?.dataset.layout).toBe("split")
    )
  },
}

/** Wrap off: long lines scroll sideways per file, gutter pinned. */
export const WrapOff: Story = {
  args: deskAt("revoke-live", { wrap: false }),
}

export const SplitWrapOff: Story = {
  args: deskAt("revoke-live", { layout: "split", wrap: false }),
}

/** The play turns Wrap off and back on, and switches to Split. */
export const LayoutAndWrapToggles: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    const wrap = canvas.getByRole("button", { name: "Wrap long lines" })
    await expect(wrap).toHaveAttribute("aria-pressed", "true")
    await waitFor(() =>
      expect(hosts(canvasElement)[0]?.dataset.wrap).toBe("true")
    )
    await userEvent.click(wrap)
    await waitFor(() =>
      expect(hosts(canvasElement)[0]?.dataset.wrap).toBe("false")
    )
    await userEvent.click(wrap)
    await waitFor(() =>
      expect(hosts(canvasElement)[0]?.dataset.wrap).toBe("true")
    )
    await userEvent.click(canvas.getByRole("radio", { name: "Split" }))
    await waitFor(() =>
      expect(hosts(canvasElement)[0]?.dataset.layout).toBe("split")
    )
  },
}

/** The diff toolbar: the row that holds the "N/M viewed" count. */
function diffToolbar(canvas: ReturnType<typeof within>) {
  const count = canvas.getByText(/^\d+\/\d+ viewed$/)
  return count.parentElement as HTMLElement
}

/**
 * The toolbar's only meta is "N/M viewed" (round 6): no unit stats beside
 * it, and no standing note about Split's width.
 */
export const ToolbarMeta: Story = {
  play: async ({ canvas }) => {
    const toolbar = diffToolbar(canvas)
    const total = reviewDeskLiveFixture.files.length
    await expect(toolbar).toHaveTextContent(`0/${total} viewed`)
    await expect(toolbar).not.toHaveTextContent(
      reviewDeskLiveFixture.unit.stats
    )
    await expect(toolbar).not.toHaveTextContent("980px")
  },
}

/**
 * Narrow and on Stacked: Split is unavailable (its description says why)
 * and the toolbar's status region is there but empty.
 */
export const StackedWhenNarrow: Story = {
  render: (args) => (
    <div style={{ width: 1100 }}>
      <DeskAt {...args} />
    </div>
  ),
  play: async ({ canvas, canvasElement }) => {
    await waitFor(() =>
      expect(canvas.getByRole("radio", { name: "Split" })).toHaveAttribute(
        "aria-disabled",
        "true"
      )
    )
    const toolbar = diffToolbar(canvas)
    await expect(toolbar).not.toHaveTextContent("980px")
    await expect(toolbar).not.toHaveTextContent(
      reviewDeskLiveFixture.unit.stats
    )
    await expect(
      canvasElement.querySelector("[data-split-fallback]")
    ).not.toBeInTheDocument()
    // The live region waits, empty, so its text is announced when it fills.
    await expect(within(toolbar).getByRole("status")).toBeEmptyDOMElement()
  },
}

/** The Split segment's reason when the unit column is under 980px. */
const SPLIT_REASON = "Split needs a column of 980px"

/** The opacity an element is painted with: its own times its ancestors'. */
function paintedOpacity(element: Element | null) {
  let opacity = 1
  for (let node = element; node; node = node.parentElement)
    opacity *= Number(getComputedStyle(node).opacity)
  return opacity
}

/**
 * Unavailable Split stays in the keyboard path: Tab lands on the diff
 * layout control, an arrow reaches Split, and its reason shows as a tooltip
 * (on focus and on hover). Its icon and label dim, its focus ring doesn't.
 * Pressing or clicking it never chooses Split: the stored layout stays
 * Stacked, so the fallback status stays empty.
 */
export const SplitUnavailableExplained: Story = {
  render: (args) => (
    <div style={{ width: 1100 }}>
      <DeskAt {...args} />
    </div>
  ),
  play: async ({ canvas, canvasElement, userEvent }) => {
    const split = canvas.getByRole("radio", { name: "Split" })
    const stacked = canvas.getByRole("radio", { name: "Stacked" })
    const doc = canvasElement.ownerDocument
    const page = within(doc.body)
    const status = within(diffToolbar(canvas)).getByRole("status")
    await waitFor(() => expect(split).toHaveAttribute("aria-disabled", "true"))
    // Back from Wrap: Tab reaches the control on its checked option.
    canvas.getByRole("button", { name: "Wrap long lines" }).focus()
    await userEvent.tab({ shift: true })
    await expect(stacked).toHaveFocus()
    await userEvent.keyboard("{ArrowRight}")
    await expect(split).toHaveFocus()
    await expect(
      await page.findByRole("tooltip", { name: SPLIT_REASON })
    ).toBeInTheDocument()
    // The ring is the item's own outline, painted at full strength; only
    // the icon and label inside it are dimmed.
    await expectFocusVisible(split)
    // Waits out the desk's entrance fade; a dimmed item never reaches 1.
    await waitFor(() => expect(paintedOpacity(split)).toBe(1))
    await expect(paintedOpacity(split.lastElementChild)).toBe(0.5)
    // Space and Enter press Split; the press is refused.
    await userEvent.keyboard(" ")
    // Two frames, so a refused choice would have rendered by now.
    await frames(2)
    await expect(status).toBeEmptyDOMElement()
    await userEvent.keyboard("{Enter}")
    await frames(2)
    await expect(status).toBeEmptyDOMElement()
    await expect(split).toHaveAttribute("aria-checked", "false")
    await expect(stacked).toHaveAttribute("aria-checked", "true")
    // Hover shows the same reason; a click doesn't choose it either.
    await userEvent.keyboard("{Escape}")
    split.blur()
    await waitFor(() =>
      expect(
        page.queryByRole("tooltip", { name: SPLIT_REASON })
      ).not.toBeInTheDocument()
    )
    await userEvent.hover(split)
    await expect(
      await page.findByRole("tooltip", { name: SPLIT_REASON })
    ).toBeInTheDocument()
    await userEvent.click(split)
    await frames(2)
    await expect(status).toBeEmptyDOMElement()
    await expect(stacked).toHaveAttribute("aria-checked", "true")
    await waitFor(() =>
      expect(hosts(canvasElement)[0]?.dataset.layout).toBe("stacked")
    )
    await userEvent.unhover(split)
  },
}

/**
 * Split falls back to Stacked when the unit column is under 980px
 * (measured on the column, not the viewport): the toggle shows Stacked,
 * Split is unavailable and says why.
 */
export const SplitFallsBackWhenNarrow: Story = {
  args: deskAt("revoke-live", { layout: "split" }),
  render: (args) => (
    <div style={{ width: 1100 }}>
      <DeskAt {...args} />
    </div>
  ),
  play: async ({ canvas, canvasElement }) => {
    await waitFor(() =>
      expect(
        canvasElement.querySelector("[data-split-fallback]")
      ).toHaveTextContent("Split shows as stacked below 980px")
    )
    await expect(diffToolbar(canvas)).not.toHaveTextContent(
      reviewDeskLiveFixture.unit.stats
    )
    await expect(canvas.getByRole("radio", { name: "Split" })).toHaveAttribute(
      "aria-disabled",
      "true"
    )
    await expect(
      canvas.getByRole("radio", { name: "Stacked" })
    ).toHaveAttribute("aria-checked", "true")
    await waitFor(() =>
      expect(hosts(canvasElement)[0]?.dataset.layout).toBe("stacked")
    )
  },
}

/* ── Rail ──────────────────────────────────────────────── */

/** The rail collapsed to its 60px icon column. */
/**
 * The rail echoes an agent's review as the 16px mark only (avatar + verdict
 * icon; the words are for screen readers), with no lane note: the review is
 * said in words once, in the unit's review card (round 4.3). A one-hunk unit
 * reads "1 hunk".
 */
export const RailReviewMarks: Story = {
  args: deskAt("index-writes"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const rail = canvas.getByRole("navigation", { name: "Review units" })
    await expect(within(rail).getAllByText("1 hunk").length).toBeGreaterThan(0)
    await expect(within(rail).queryByText(/1 hunks/)).toBeNull()
    await expect(canvas.queryByText(/yours to override/)).toBeNull()
    for (const label of ["Suggested", "Agentic review"]) {
      const group = canvas.getByRole("button", {
        name: new RegExp(`^${label}`),
      })
      if (group.getAttribute("aria-expanded") === "false")
        fireEvent.click(group)
    }
    const suggested = await canvas.findByRole("list", {
      name: "Suggested units",
    })
    const marks = suggested.querySelectorAll(
      '[data-review-mark][data-verdict="approved"]'
    )
    await expect(marks).toHaveLength(3)
    for (const mark of marks)
      await expect(mark.querySelector('[data-avatar="agent"]')).not.toBeNull()
    const agentic = await canvas.findByRole("list", {
      name: "Agentic review units",
    })
    await expect(
      agentic.querySelector(
        '[data-review-mark][data-verdict="changes_requested"]'
      )
    ).not.toBeNull()
  },
}

export const RailCollapsed: Story = {
  args: deskAt("revoke-live", { rail: "collapsed" }),
}

/** "[" collapses and expands the rail (the desk's keyboard shortcut). */
export const RailShortcut: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const nav = canvasElement.querySelector<HTMLElement>(
      'nav[aria-label="Review units"]'
    )!
    canvasElement.ownerDocument.body.focus()
    await userEvent.keyboard("[[")
    await waitFor(() => expect(nav).toHaveAttribute("data-collapsed"))
    await userEvent.keyboard("[[")
    await waitFor(() => expect(nav).not.toHaveAttribute("data-collapsed"))
  },
}

/* ── Viewed files ──────────────────────────────────────── */

/**
 * Files marked viewed before a reload stay viewed: browser storage is read on
 * mount, and every reader re-renders with it (jotai 3's useAtomValue would
 * keep the empty record it rendered first). The files fold, their toggles
 * stay pressed, the toolbar counts them and the rail checks them.
 */
export const ViewedAfterReload: Story = {
  args: deskAt("revoke-live", { state: { browse: "files" } }),
  beforeEach: () => {
    const { unit, revision, files } = reviewDeskLiveFixture
    localStorage.setItem(
      VIEWED_FILES_STORAGE_KEY,
      JSON.stringify(
        Object.fromEntries(
          files.map((file) => [viewedKey(unit.id, revision, file.path), true])
        )
      )
    )
  },
  play: async ({ canvas }) => {
    const total = reviewDeskLiveFixture.files.length
    await waitFor(() =>
      expect(
        canvas
          .getAllByRole("button", { name: "Viewed" })
          .filter((toggle) => toggle.getAttribute("aria-pressed") === "true")
      ).toHaveLength(total)
    )
    await expect(
      canvas.getByText(`${total}/${total} viewed`)
    ).toBeInTheDocument()
    await expect(
      canvas.getAllByRole("button", { name: /^Expand / })
    ).toHaveLength(total)
    const rail = within(
      canvas.getByRole("region", { name: "Files in this unit" })
    )
    await expect(rail.getAllByRole("img", { name: "Viewed" })).toHaveLength(
      total
    )
  },
}

/* ── Agents ────────────────────────────────────────────── */

export const AgentsOpen: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(
      canvas.getByRole("button", {
        name: "4 agents on this branch, 3 connected",
      })
    )
  },
}

/* ── Threads ───────────────────────────────────────────── */

/** An open thread: Maya's comment and Implementer 1's reply. */
export const ThreadOpen: Story = {
  args: deskAt("revoke-live", { comments: "seeded", open: SESSIONS_MARKER }),
}

/**
 * An open thread behaves like a context card: the play clicks Maya's pin —
 * the thread becomes the one expanded layer (other pins dimmed and inert),
 * stays attached to its pin while the unit scrolls, and an outside press
 * closes it.
 */
export const ThreadIsolatesAndStaysAttached: Story = {
  args: deskAt("revoke-live", { comments: "seeded" }),
  play: async ({ canvasElement, userEvent }) => {
    // The comment shares its line: the line's pin opens the line's list,
    // and the comment's row opens its thread on the same pin.
    const pin = await waitFor(() => {
      const found = canvasElement.querySelector<HTMLElement>(
        `button[data-marker-keys~="${CSS.escape(SESSIONS_MARKER)}"]`
      )
      expect(found).toBeVisible()
      return found!
    })
    await userEvent.click(pin)
    const sessions = reviewCommentFixtures.find(
      (record) => record.id === SESSIONS_COMMENT_ID
    )!
    const entry = await waitFor(() => {
      const list = canvasElement.ownerDocument.querySelector<HTMLElement>(
        "[data-floating-card] [data-line-list]"
      )
      const found = Array.from(
        list?.querySelectorAll<HTMLButtonElement>("button") ?? []
      ).find((row) => row.textContent.includes(sessions.body.slice(0, 40)))
      expect(found).toBeVisible()
      return found!
    })
    await userEvent.click(entry)
    const thread = await waitFor(() => {
      const found =
        canvasElement.ownerDocument.querySelector<HTMLElement>(
          "[data-thread-card]"
        )
      expect(found).toBeVisible()
      return found!
    })
    await expect(pin).toHaveAttribute("aria-expanded", "true")
    const root = hosts(canvasElement)[0]!.shadowRoot!
    await waitFor(() =>
      expect(
        root.querySelectorAll("[data-overlay-item][inert]").length
      ).toBeGreaterThan(0)
    )
    const layer = openCard(canvasElement)!
    await waitFor(() => expectAttached(pin, layer))
    scrollRoot(canvasElement).scrollTop += 80
    await waitFor(() => expectAttached(pin, layer))
    await expect(thread).toBeVisible()
    // A press outside the card closes it (the unit's title is outside).
    await userEvent.click(
      within(canvasElement).getByRole("heading", { level: 1 })
    )
    await waitFor(() =>
      expect(
        canvasElement.ownerDocument.querySelector("[data-thread-card]")
      ).toBeNull()
    )
  },
}

/**
 * "Show comments" shows each comment as a compact preview (no isolation);
 * clicking a preview opens its thread; "Dismiss all" collapses everything.
 */
export const ShowCommentsPreviews: Story = {
  args: deskAt("revoke-live", { comments: "seeded" }),
  play: async ({ canvas, canvasElement, userEvent }) => {
    await userEvent.click(
      await canvas.findByRole("button", { name: "Show comments" })
    )
    // Previews float on their line's pin (portaled to the document).
    const preview = await waitFor(() => {
      const found = canvasElement.ownerDocument.querySelector<HTMLElement>(
        "[data-comment-preview]"
      )
      expect(found).toBeVisible()
      return found!
    })
    await userEvent.click(preview)
    await waitFor(() =>
      expect(
        canvasElement.ownerDocument.querySelector("[data-thread-card]")
      ).toBeVisible()
    )
    await userEvent.keyboard("{Escape}")
    await userEvent.click(
      await canvas.findByRole("button", { name: "Dismiss all" })
    )
    await waitFor(() =>
      expect(
        canvasElement.ownerDocument.querySelector("[data-comment-preview]")
      ).toBeNull()
    )
  },
}

/** Implementer 1 is working on your follow-up (steps collapsed). */
export const ThreadWorking: Story = {
  args: deskAt("revoke-live", {
    comments: "seeded",
    open: SESSIONS_MARKER,
    threads: [threadStateFixtures.working],
  }),
}

/** Implementer 1 needs your input: Allow once / Deny. */
export const ThreadNeedsInput: Story = {
  args: deskAt("revoke-live", {
    comments: "seeded",
    open: SESSIONS_MARKER,
    threads: [threadStateFixtures["needs-input"]],
  }),
}

/** Delivery failed: Retry. */
export const ThreadFailed: Story = {
  args: deskAt("revoke-live", {
    comments: "seeded",
    open: SESSIONS_MARKER,
    threads: [threadStateFixtures.failed],
  }),
}

/**
 * Thread state progression from a mock relay (no real ACP): the play sends
 * a reply and follows queued → sent → picked up → working → needs your
 * input, answers "Allow once", and waits for the final reply with its
 * inner-loop commit as a chip.
 */
export const ThreadProgression: Story = {
  args: {
    ...deskAt("revoke-live", { comments: "seeded", open: SESSIONS_MARKER }),
    threadEvents: createMockThreadRelay({
      onReply: threadReplyScript,
      onPermission: threadPermissionScript,
      onRetry: threadRetryScript,
    }),
  },
  play: async ({ canvasElement, userEvent }) => {
    // The thread floats in a portal and can re-render: look it up fresh.
    const thread = () =>
      canvasElement.ownerDocument.querySelector<HTMLElement>(
        "[data-thread-card]"
      )!
    const view = () => within(thread())
    const reply = await waitFor(() => {
      const found = view().getByRole("textbox", { name: "Reply" })
      expect(found).toBeVisible()
      return found
    })
    // Keep focusing until focus survives two frames (the layer settles).
    await waitFor(
      async () => {
        reply.focus()
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        )
        expect(reply.ownerDocument.activeElement).toBe(reply)
      },
      { timeout: 3000 }
    )
    // The thread floats in a portal; set the reply through React's change
    // path (user-event's typed value doesn't reach React's tracker there).
    fireEvent.change(reply, {
      target: {
        value: "Go with SHR-212. Add a test that reloads an open session.",
      },
    })
    await waitFor(() =>
      expect(view().getByRole("button", { name: "Send" })).toBeEnabled()
    )
    await userEvent.click(view().getByRole("button", { name: "Send" }))
    const state = () => thread().getAttribute("data-thread-state")
    await expect(state()).toBe("queued")
    await waitFor(() => expect(state()).toBe("sent"), { timeout: 3000 })
    await waitFor(() => expect(state()).toBe("picked-up"), { timeout: 3000 })
    await waitFor(() => expect(state()).toBe("working"), { timeout: 3000 })
    await waitFor(() => expect(state()).toBe("needs-input"), { timeout: 4000 })
    await userEvent.click(view().getByRole("button", { name: "Allow once" }))
    await waitFor(() => expect(state()).toBe("replied"), { timeout: 5000 })
    await waitFor(() =>
      expect(
        view().getByText(/Sessions end on revoke, and a test now reloads/)
      ).toBeVisible()
    )
    await expect(view().getByText("b71e5aa")).toBeVisible()
  },
}

/* ── New commit mid-review (Cycle.dc.html) ─────────────── */

/** A new commit landed: the dark notice, Later / What changed. */
export const NewCommitNotice: Story = {
  args: deskAt("revoke-new-commit"),
}

/** Parked as a corner pill after Later. */
export const NewCommitParked: Story = {
  args: deskAt("revoke-new-commit", { state: { notice: "parked" } }),
}

/** The play presses Later: the notice shrinks to the corner pill. */
export const NewCommitLater: Story = {
  args: deskAt("revoke-new-commit"),
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Later" }))
    await waitFor(() =>
      expect(
        canvas.getByRole("link", {
          name: /New commit b71e5aa: 3 units need you/,
        })
      ).toBeVisible()
    )
  },
}

/* ── Units in other lanes (Lanes.dc.html) ──────────────── */

/** Suggested: Agent approved · Request changes or Agree. */
export const SuggestedUnit: Story = {
  args: deskAt("suggested"),
}

export const SuggestedAgreed: Story = {
  args: deskAt("suggested", { dock: "agreed" }),
}

/** Request changes on a suggested unit overrides the agent's approval. */
export const SuggestedRequestingChanges: Story = {
  args: deskAt("suggested", { dock: "composing" }),
}

/**
 * Agentic review: the agent sent it back. You can Comment or Request
 * changes, never approve: approvals there are the agent's (13.25).
 */
export const AgenticUnit: Story = {
  args: deskAt("agentic"),
}

export const AgenticCommenting: Story = {
  args: deskAt("agentic", {
    dock: "composing",
    state: { feedbackKind: "comment" },
  }),
}

/**
 * ⌘↵ in an agentic unit's Request changes composer sends the request, as
 * its Send to implementer button does, not a comment.
 */
export const AgenticRequestByKeyboard: Story = {
  args: deskAt("agentic"),
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(
      await waitFor(() =>
        canvas.getByRole("button", { name: "Request changes" })
      )
    )
    const text = await canvas.findByRole("textbox", {
      name: "What needs to change",
    })
    // Blank, ⌘↵ sends nothing: a request says what to change (10.69).
    text.focus()
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}")
    await expect(
      canvas.getByRole("dialog", { name: "Request changes on this unit" })
    ).toBeInTheDocument()
    await expect(canvas.queryByText("You requested changes")).toBeNull()
    await expect(text).toHaveFocus()
    await userEvent.type(text, "The retry loop never ends.")
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}")
    await waitFor(() =>
      expect(canvas.getByText("You requested changes")).toBeInTheDocument()
    )
    await expect(canvas.queryByText("Comment added as context")).toBeNull()
  },
}

export const AgenticCommented: Story = {
  args: deskAt("agentic", { dock: "commented" }),
}

/** Static automation: checks that passed, the generated diff collapsed. */
export const StaticUnit: Story = {
  args: deskAt("static"),
}

/** The static unit's generated diff: the play expands and collapses it. */
export const StaticGeneratedDiff: Story = {
  args: deskAt("static"),
  play: async ({ canvas, canvasElement, userEvent }) => {
    const toggle = canvas.getByRole("button", { name: /Show generated diff/ })
    await expect(toggle).toHaveAttribute("aria-expanded", "false")
    await expect(toggle).toHaveTextContent(/\d+ lines/)
    await expect(hosts(canvasElement)).toHaveLength(0)
    await userEvent.click(toggle)
    await waitFor(() => expect(hosts(canvasElement)).toHaveLength(1))
    await userEvent.click(
      canvas.getByRole("button", { name: /Hide generated diff/ })
    )
    await waitFor(() => expect(hosts(canvasElement)).toHaveLength(0))
  },
}

export const StaticGeneratedDiffOpen: Story = {
  args: deskAt("static", { state: { generatedOpen: true } }),
}

/* ── Dock ──────────────────────────────────────────────── */

export const Composing: Story = {
  args: deskAt("revoke-live", {
    dock: "composing",
    state: { attachment: "conflict" },
  }),
}

export const ComposingWithDraft: Story = {
  args: deskAt("revoke-live", {
    dock: "composing",
    state: {
      attachment: "conflict",
      draft: reviewDeskFixture.unit.draftSuggestion,
    },
  }),
}

export const Approved: Story = {
  args: deskAt("revoke-live", { dock: "approved" }),
}

export const ChangesRequested: Story = {
  args: deskAt("revoke-live", { dock: "changes-requested" }),
}

/** Another unit still needs your decision: "Next unit →" goes to it. */
export const ApprovedNextUndecided: Story = {
  args: deskAt(nextUndecidedDeskFixture, { dock: "approved" }),
  play: async ({ canvas }) => {
    await waitFor(() =>
      expect(canvas.getByRole("link", { name: /Next unit/ })).toHaveAttribute(
        "href",
        "/review/workspace-admins-may-revoke"
      )
    )
  },
}

/** Nothing else is undecided: the dock offers "Back to batch". */
export const ApprovedLastUndecided: Story = {
  args: deskAt(lastUndecidedDeskFixture, { dock: "approved" }),
  play: async ({ canvas }) => {
    await waitFor(() =>
      expect(canvas.getByRole("link", { name: /Back to batch/ })).toBeVisible()
    )
  },
}

/**
 * In the second of a review's batches, "Back to batch" returns to that
 * batch, never to the review's first.
 */
export const ApprovedLastUndecidedSecondBatch: Story = {
  args: deskAt(
    {
      ...lastUndecidedDeskFixture,
      batches: { ...reviewBatchesFixture, current: "batch-share-dialog" },
    },
    { dock: "approved" }
  ),
  play: async ({ canvas }) => {
    await waitFor(() =>
      expect(
        canvas.getByRole("link", { name: /Back to batch/ })
      ).toHaveAttribute("href", "/batch/batch-share-dialog")
    )
  },
}

/**
 * On the first batch of an older review, "Back to batch" opens that batch
 * by its address, as it does on every batch.
 */
export const ApprovedLastUndecidedOlderReview: Story = {
  args: deskAt(
    {
      ...lastUndecidedDeskFixture,
      batches: { ...reviewBatchesFixture, newest: false },
    },
    { dock: "approved" }
  ),
  play: async ({ canvas }) => {
    await waitFor(() =>
      expect(
        canvas.getByRole("link", { name: /Back to batch/ })
      ).toHaveAttribute("href", "/batch/batch-revoke-links")
    )
  },
}

/**
 * Unit switch (round 3, item 10): the clicked rail row is selected with a
 * spinner; after 150ms without arrival the current unit dims to 45%. Arrival
 * remounts the desk at the top of the new unit.
 */
export const SwitchingUnit: Story = {
  args: deskAt("revoke-live", {
    state: { pendingUnit: "workspace-admins-may-revoke" },
  }),
  play: async ({ canvasElement }) => {
    const scroller = mainColumn(canvasElement)
    await expect(scroller).toHaveAttribute("aria-busy", "true")
    await waitFor(() =>
      expect(Number(getComputedStyle(scroller).opacity)).toBeCloseTo(
        OPACITY.switching,
        2
      )
    )
  },
}

/**
 * Review F3: the host router settled back on this unit (Back during a
 * switch, or a superseded navigation): pendingUnitId is null, so the
 * switching state clears and the desk is never left dimmed.
 */
export const SwitchSettlesWithRouter: Story = {
  args: {
    ...deskAt("revoke-live", {
      state: { pendingUnit: "workspace-admins-may-revoke" },
    }),
    pendingUnitId: null,
  },
  play: async ({ canvasElement }) => {
    const scroller = mainColumn(canvasElement)
    await waitFor(() => expect(scroller).not.toHaveAttribute("aria-busy"))
    await waitFor(() =>
      expect(Number(getComputedStyle(scroller).opacity)).toBe(1)
    )
  },
}

/** The router is navigating to another unit: the rail and desk show it. */
export const SwitchDrivenByRouter: Story = {
  args: {
    ...deskAt("revoke-live"),
    pendingUnitId: "workspace-admins-may-revoke",
  },
  play: async ({ canvas, canvasElement }) => {
    const scroller = mainColumn(canvasElement)
    await waitFor(() => expect(scroller).toHaveAttribute("aria-busy", "true"))
    await expect(
      canvas.getByRole("link", { name: /Workspace admins may revoke any link/ })
    ).toHaveAttribute("aria-busy", "true")
  },
}

/**
 * The dock never covers code at the end of the unit (round 3, item 11): the
 * last file ends at least 24px above the dock, and the scroll padding
 * matches the measured dock height.
 */
export const DockClearance: Story = {
  play: async ({ canvasElement }) => {
    const scroller = mainColumn(canvasElement)
    await waitFor(() =>
      expect(scroller.style.getPropertyValue("--nv-dock-h")).not.toBe("")
    )
    scroller.scrollTop = scroller.scrollHeight
    await waitFor(() => {
      const dock = canvasElement
        // The dock bar's body (its fill; the bar draws its shadow as a
        // filter since round 7).
        .querySelector<HTMLElement>("[data-dock-body]")
        ?.getBoundingClientRect()
      const cards = hosts(canvasElement)
      const last = cards.at(-1)?.getBoundingClientRect()
      if (!dock || !last) throw new Error("dock or diff not rendered")
      expect(last.bottom + 24).toBeLessThanOrEqual(dock.top + 1)
    })
  },
}

const rangedRevision = "b".repeat(40)
const rangedPatch = [
  "diff --git a/src/obligation.ts b/src/obligation.ts",
  "--- a/src/obligation.ts",
  "+++ b/src/obligation.ts",
  "@@ -1,4 +1,4 @@",
  "-allowAll()",
  "+checkPermission()",
  " keepContext()",
  "-noisyLabelOld()",
  "+noiseSibling()",
  " trailingContext()",
  "",
].join("\n")

/** Controlled component fixture; no retained batch, provider or live authority. */
export const RangedResponsibility: Story = {
  args: {
    data: {
      ...reviewDeskFixture,
      repo: "controlled/ranged-ui-fixture",
      revision: rangedRevision,
      batchTitle: "Controlled ranged responsibility fixture",
      unit: {
        ...reviewDeskFixture.unit,
        id: "fixture-permission-unit",
        title: "Permission guard · controlled fixture",
        decisionSignal: undefined,
        position: { index: 1, of: 1 },
        briefing: [
          {
            kind: "text",
            text: "Controlled UI fixture: the unit owns only the permission change. Sibling label changes remain read-only context. No model output or review approval is established.",
          },
        ],
        stats: "1 file · 2 changed ranges",
        scopeLabel: "2 changed ranges · 2 changed lines",
        hunkCount: 1,
        defaultAttachment: "",
        draftSuggestion: "",
        scopeNote:
          "Only owned old/new line 1 is covered. Original hunk context and sibling changes are read-only.",
        agentId: undefined,
      },
      files: [
        {
          path: "src/obligation.ts",
          patch: rangedPatch,
          oldContents:
            "allowAll()\nkeepContext()\nnoisyLabelOld()\ntrailingContext()\n",
          newContents:
            "checkPermission()\nkeepContext()\nnoiseSibling()\ntrailingContext()\n",
          context: 3,
          additions: 1,
          deletions: 1,
          markerAnchors: [],
          responsibility: {
            kind: "changed-ranges",
            unitId: "fixture-permission-unit",
            revisionId: rangedRevision,
            ownedSource: [
              {
                kind: "changed-lines",
                hunkId: "fixture-original-hunk",
                side: "old",
                sourceRevisionId: "a".repeat(40),
                startLine: 1,
                lineCount: 1,
                lines: ["allowAll()"],
              },
              {
                kind: "changed-lines",
                hunkId: "fixture-original-hunk",
                side: "new",
                sourceRevisionId: rangedRevision,
                startLine: 1,
                lineCount: 1,
                lines: ["checkPermission()"],
              },
            ],
          },
        },
      ],
      markers: {},
      neighbor: undefined,
      elsewhere: [],
      railUnits: [
        {
          id: "fixture-permission-unit",
          title: "Permission guard · controlled fixture",
          hunkCount: 1,
          scopeLabel: "2 changed ranges · 2 changed lines",
        },
      ],
      batchUnits: [
        {
          id: "fixture-permission-unit",
          title: "Permission guard · controlled fixture",
          lane: "human-required",
        },
      ],
      threads: [],
      commentRecords: [],
      currentDecision: undefined,
      newCommit: undefined,
      humanRequiredTotal: 1,
      humanDecidedUnitIds: [],
    },
    initialState: { railCollapsed: false, layout: "stacked" },
  },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement)
    const owned = await waitFor(() => {
      const host = canvasElement.querySelector<HTMLElement>(
        'diffs-container[data-commentable="true"]'
      )!
      expect(host.shadowRoot?.textContent).toContain("checkPermission()")
      expect(host.shadowRoot?.textContent).toContain("allowAll()")
      return host
    })
    // Owned ranges in line order: short unchanged gaps show inline, the
    // sibling unit's line folds into the gap row around it, which says
    // quietly that another unit owns changes there.
    expect(owned.shadowRoot?.textContent).not.toContain("noiseSibling()")
    expect(
      canvas.getAllByText(/2 changed ranges · 2 changed lines/).length
    ).toBeGreaterThan(0)
    // The gap row is slotted into the diff after it paints.
    await waitFor(() => expect(canvas.getByText("1 other unit")).toBeVisible())
    // Whole file shows the sibling's lines read-only; Owned ranges folds them.
    await userEvent.click(canvas.getByRole("radio", { name: "Whole file" }))
    await waitFor(() =>
      expect(owned.shadowRoot?.textContent).toContain("noiseSibling()")
    )
    expect(
      owned.shadowRoot?.querySelectorAll("[data-line][data-read-only]").length
    ).toBe(2)
    await userEvent.click(canvas.getByRole("radio", { name: "Owned ranges" }))
    await waitFor(() =>
      expect(owned.shadowRoot?.textContent).not.toContain("noiseSibling()")
    )
    const number = owned.shadowRoot!.querySelector<HTMLElement>(
      '[data-column-number="1"][data-line-type="change-addition"]'
    )!
    expect(number).toBeTruthy()
    number.focus()
    fireEvent.keyDown(number, { key: "Enter", code: "Enter" })
    const composer = await waitFor(() => {
      const dialog = canvasElement.ownerDocument.querySelector<HTMLElement>(
        '[role="dialog"][aria-label^="New review comment"]'
      )!
      expect(dialog).toBeVisible()
      return dialog
    })
    fireEvent.change(
      within(composer).getByRole("textbox", { name: "Comment" }),
      { target: { value: "Inspect the owned permission guard." } }
    )
    await userEvent.click(
      within(composer).getByRole("button", { name: /^Comment/ })
    )
    await waitFor(() =>
      expect(
        canvas.getByRole("button", {
          name: /Review comment.*Inspect the owned permission guard/,
        })
      ).toBeVisible()
    )
    expect(owned.shadowRoot?.textContent).not.toContain("noiseSibling()")
  },
}

/* ── The dock hands focus across its states ───────────────
 * A dock step asks the state it leads to (on this unit) to take focus, and
 * the request waits for a live decision however long the server takes. It
 * ends without moving focus when the decision fails, when focus moves
 * elsewhere, or on a unit switch.
 */

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The decided dock's way on ("Next unit" or "Back to batch"). */
function wayOn(canvasElement: HTMLElement) {
  return canvasElement.querySelector<HTMLElement>("[data-dock-way-on]")
}

/** Focus inside the dock (its root holds every dock state). */
function inDock(canvasElement: HTMLElement) {
  const active = canvasElement.ownerDocument.activeElement
  return !!active?.closest(
    "[data-dock-step], [data-dock-way-on], [role=dialog]"
  )
}

/**
 * A decision the server takes 2.5s to record: Approve by keyboard still
 * lands focus on the way on, with its ring, once the decided dock arrives.
 */
export const DockSlowDecision: Story = {
  args: {
    decisionSink: async () => {
      await wait(2500)
    },
  },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const approve = await waitFor(() =>
      canvas.getByRole("button", { name: /^Approve/ })
    )
    approve.focus()
    await userEvent.keyboard("{Enter}")
    await waitFor(() => expect(wayOn(canvasElement)).toHaveFocus(), {
      timeout: 6000,
    })
    await expectFocusVisible(wayOn(canvasElement)!, { ring: false })
  },
}

/**
 * While a slow decision is pending the reader moves on (focus to the diff
 * toolbar): when the decided dock arrives, focus stays where they went.
 */
export const DockSlowDecisionFocusElsewhere: Story = {
  args: {
    decisionSink: async () => {
      await wait(1500)
    },
  },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const approve = await waitFor(() =>
      canvas.getByRole("button", { name: /^Approve/ })
    )
    approve.focus()
    await userEvent.keyboard("{Enter}")
    const wrap = canvas.getByRole("button", { name: "Wrap long lines" })
    wrap.focus()
    await waitFor(() => expect(wayOn(canvasElement)).toBeTruthy(), {
      timeout: 4000,
    })
    await wait(400)
    await expect(wrap).toHaveFocus()
  },
}

/**
 * A rejected Approve leaves nothing behind: changing the delivery stop
 * right after (the dock swaps its rest) keeps focus in the dial.
 */
export const DockRejectedDecisionLeavesFocus: Story = {
  args: {
    ...deskAt("index-writes", { stop: "guided" }),
    decisionSink: async () => {
      await wait(300)
      throw new Error("Rejected by the reviewer service")
    },
  },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const approve = await waitFor(() =>
      canvas.getByRole("button", { name: "Approve" })
    )
    approve.focus()
    await userEvent.keyboard("{Enter}")
    await wait(600)
    const explained = await chooseStop(canvasElement, "explained")
    await wait(600)
    await expect(explained).toHaveFocus()
    await expect(inDock(canvasElement)).toBe(false)
  },
}

/** ⌘↵ from the rest dock decides, and focus lands on the way on. */
export const DockShortcutFromRest: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    const scope = await waitFor(() => canvas.getByText(/^Covers /))
    scope.focus()
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}")
    await waitFor(() => expect(wayOn(canvasElement)).toHaveFocus())
  },
}

/** ⌘↵ from the composer's text sends, and focus lands on the way on. */
export const DockShortcutFromComposer: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    await userEvent.click(
      await waitFor(() =>
        canvas.getByRole("button", { name: "Request changes" })
      )
    )
    const text = await canvas.findByRole("textbox", {
      name: "What needs to change",
    })
    await waitFor(() => expect(text).toHaveFocus())
    await userEvent.type(text, "Please add a test.")
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}")
    await waitFor(() => expect(wayOn(canvasElement)).toHaveFocus())
  },
}

/**
 * Escape in the dock's composer closes only the composer: the desk's own
 * Escape (which would clear the gutter selection next) never sees it.
 */
export const DockEscapeStaysInDock: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    const root = await diffRoot(canvasElement)
    root
      .querySelector<HTMLElement>('[data-column-number][tabindex="0"]')!
      .focus()
    pressIn(root, " ")
    const selected = () =>
      root.querySelectorAll("[data-column-number][data-selected-line]").length
    await waitFor(() => expect(selected()).toBeGreaterThan(0))
    await userEvent.click(
      canvas.getByRole("button", { name: "Request changes" })
    )
    const text = await canvas.findByRole("textbox", {
      name: "What needs to change",
    })
    await waitFor(() => expect(text).toHaveFocus())
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(canvas.queryByRole("dialog")).toBeNull())
    await frames(2)
    await expect(selected()).toBeGreaterThan(0)
  },
}

/** With a card open, one press on a dock control closes the card and acts. */
export const DockOnePressWithCardOpen: Story = {
  args: deskAt("revoke-live", { open: "conflict" }),
  play: async ({ canvas, canvasElement, userEvent }) => {
    await waitFor(() =>
      expect(
        canvasElement.ownerDocument.querySelector("[data-floating-card]")
      ).toBeTruthy()
    )
    await userEvent.click(
      canvas.getByRole("button", { name: "Request changes" })
    )
    const text = await canvas.findByRole("textbox", {
      name: "What needs to change",
    })
    await waitFor(() => expect(text).toHaveFocus())
    await expect(
      canvasElement.ownerDocument.querySelector("[data-floating-card]")
    ).toBeNull()
  },
}

/* ── Typing in the dock ────────────────────────────────── */

/**
 * Types into a dock composer's text one key at a time and fails if the
 * desk scrolled or the composer moved. The browser's caret reveal acts only
 * on trusted keys, which a play can't send, so the play checks what it
 * acts on: the text sits inside the desk's view, clear of the scroll
 * padding, so the reveal has nothing to scroll. Before the fix the padding
 * (the dock's height) covered the dock's own text, and every keystroke
 * scrolled the desk toward the unit's end. The composer keeps its bottom
 * edge: when a line wraps it grows upward, and only what is inside it moves
 * (the button row under the text). Nothing outside it moves, except where
 * the draft offer leaves on the first key (`offer`): the text takes its
 * room.
 */
async function expectTypingHoldsStill(
  canvasElement: HTMLElement,
  user: { keyboard: (text: string) => Promise<unknown> },
  text: HTMLElement,
  at: "middle" | "end",
  keys: string,
  { offer = false }: { offer?: boolean } = {}
) {
  const scroller =
    canvasElement.querySelector<HTMLElement>("[data-desk-scroll]")!
  const composer = text.closest<HTMLElement>('[role="dialog"]')!
  const range = scroller.scrollHeight - scroller.clientHeight
  await expect(range, "The unit scrolls").toBeGreaterThan(200)
  scroller.scrollTop = at === "end" ? range : Math.round(range / 2)
  text.focus({ preventScroll: true })
  // The composer's rise has run (dockRise).
  await pause(400)
  const top = scroller.scrollTop
  const box = composer.getBoundingClientRect()
  for (const [index, key] of [...keys].entries()) {
    const type = () => user.keyboard(key)
    await (offer && index === 0
      ? type()
      : expectNoLayoutShift(type, { ignoring: composer }))
    await frames(2)
    const view = scroller.getBoundingClientRect()
    const padding = parseFloat(getComputedStyle(scroller).scrollPaddingBottom)
    await expect(
      text.getBoundingClientRect().bottom,
      "The text is clear of the scroll padding"
    ).toBeLessThanOrEqual(view.bottom - (padding || 0))
    await expect(scroller.scrollTop, "The desk didn't scroll").toBe(top)
    const now = composer.getBoundingClientRect()
    await expect(now.bottom, "The composer's bottom edge holds").toBe(
      box.bottom
    )
    await expect(
      now.top,
      "The composer only grows, upward"
    ).toBeLessThanOrEqual(box.top)
    await expect(now.top, "The composer stays in view").toBeGreaterThanOrEqual(
      view.top
    )
  }
}

/** A long unit in the agentic lane: its dock composes a comment. */
const longAgenticDesk = {
  ...longFileDeskFixture,
  unit: {
    ...longFileDeskFixture.unit,
    lane: "agentic-review" as const,
    responsibility: undefined,
  },
}

/**
 * The owner's case: "Comment on this unit" on a long unit, mid-scroll.
 * Typing scrolls nothing and moves nothing around it.
 */
export const DockTypingHoldsTheDesk: Story = {
  args: deskAt(longAgenticDesk, {
    dock: "composing",
    state: { feedbackKind: "comment" },
  }),
  play: async ({ canvas, canvasElement, userEvent }) => {
    const text = await canvas.findByRole("textbox", { name: "Comment" })
    await expectTypingHoldsStill(
      canvasElement,
      userEvent,
      text,
      "middle",
      "Please add a test"
    )
    await expect(text).toHaveValue("Please add a test")
  },
}

/**
 * Request changes at the unit's end, with the draft offered: the offer
 * leaves on the first key and the text takes its room, so the dock (in flow
 * there) keeps its height and the code above it stays put.
 */
export const DockTypingHoldsTheUnitEnd: Story = {
  args: deskAt("long-file", { dock: "composing" }),
  play: async ({ canvas, canvasElement, userEvent }) => {
    await canvas.findByRole("button", { name: /^Draft/ })
    const text = await canvas.findByRole("textbox", {
      name: "What needs to change",
    })
    await expectTypingHoldsStill(
      canvasElement,
      userEvent,
      text,
      "end",
      "Please add a test",
      { offer: true }
    )
    await expect(text).toHaveValue("Please add a test")
    await expect(canvas.queryByRole("button", { name: /^Draft/ })).toBeNull()
  },
}

/** Guided's Edit request: typing after the suggested message holds still. */
export const DockTypingHoldsGuidedEdit: Story = {
  args: deskAt(
    {
      ...goDeliveryDeskFixture,
      files: longFileDeskFixture.files,
      markers: longFileDeskFixture.markers,
    },
    { stop: "guided" }
  ),
  play: async ({ canvas, canvasElement, userEvent }) => {
    await userEvent.click(
      await canvas.findByRole("button", { name: "Edit request" })
    )
    const text = await canvas.findByRole<HTMLTextAreaElement>("textbox", {
      name: "What needs to change",
    })
    const message = text.value
    await expect(message).not.toBe("")
    text.focus({ preventScroll: true })
    text.setSelectionRange(message.length, message.length)
    await expectTypingHoldsStill(
      canvasElement,
      userEvent,
      text,
      "middle",
      " Also"
    )
    await expect(text).toHaveValue(`${message} Also`)
  },
}

/**
 * A comment longer than the room: the composer grows upward from where it
 * sits, the desk stays put, and at 40% of the viewport the text stops
 * growing and scrolls itself, the whole composer still in view. The play
 * types lines until the text overflows, whatever the viewport's height,
 * then a few more: the cap holds and the caret's line stays in the text's
 * view.
 */
export const DockTypingGrowsInView: Story = {
  args: deskAt(longAgenticDesk, {
    dock: "composing",
    state: { feedbackKind: "comment" },
  }),
  play: async ({ canvas, canvasElement, userEvent }) => {
    const text = await canvas.findByRole<HTMLTextAreaElement>("textbox", {
      name: "Comment",
    })
    const scroller =
      canvasElement.querySelector<HTMLElement>("[data-desk-scroll]")!
    const composer = text.closest<HTMLElement>('[role="dialog"]')!
    scroller.scrollTop = Math.round(
      (scroller.scrollHeight - scroller.clientHeight) / 2
    )
    text.focus({ preventScroll: true })
    await pause(400)
    const top = scroller.scrollTop
    const bottom = composer.getBoundingClientRect().bottom
    const view = canvasElement.ownerDocument.defaultView!
    // 40dvh, as the browser rounds it into the text's border box.
    const cap = Math.ceil(view.innerHeight * 0.4)
    let line = 0
    const typeLine = async () => {
      line += 1
      await userEvent.keyboard(`${line > 1 ? "{Enter}" : ""}Line ${line}`)
      await frames(2)
    }
    while (text.scrollHeight <= text.clientHeight && line < 200)
      await typeLine()
    await expect(
      text.scrollHeight,
      "The text overflows its room"
    ).toBeGreaterThan(text.clientHeight)
    const capped = text.offsetHeight
    for (let more = 0; more < 3; more++) await typeLine()
    await expect(text.offsetHeight, "The text stops growing").toBe(capped)
    await expect(capped, "at 40% of the viewport").toBeLessThanOrEqual(cap)
    await expect(scroller.scrollTop, "The desk didn't scroll").toBe(top)
    await expect(
      composer.getBoundingClientRect().bottom,
      "The composer's bottom edge holds"
    ).toBe(bottom)
    await expect(
      composer.getBoundingClientRect().top,
      "The composer stays in view"
    ).toBeGreaterThanOrEqual(scroller.getBoundingClientRect().top)
    // The caret ends the last line. The browser's caret reveal (trusted
    // keys only, so not this play's) scrolls the nearest scroller that can
    // show it: the text scrolls itself, and its box sits in the desk's view
    // clear of the scroll padding, so the desk has nothing to scroll.
    await expect(text.selectionStart).toBe(text.value.length)
    await expect(getComputedStyle(text).overflowY).toMatch(/auto|scroll/)
    const padding = parseFloat(getComputedStyle(scroller).scrollPaddingBottom)
    await expect(
      text.getBoundingClientRect().bottom,
      "The text is clear of the scroll padding"
    ).toBeLessThanOrEqual(
      scroller.getBoundingClientRect().bottom - (padding || 0)
    )
    // The reveal's own step: the text scrolls to the caret's line.
    text.scrollTop = text.scrollHeight
    await frames(2)
    const lineHeight = parseFloat(getComputedStyle(text).lineHeight)
    await expect(
      text.scrollTop + text.clientHeight,
      "The caret's line is in the text's view"
    ).toBeGreaterThanOrEqual(text.scrollHeight - lineHeight)
    await expect(scroller.scrollTop, "The desk still didn't scroll").toBe(top)
  },
}

/* ── Phone width ───────────────────────────────────────── */

/** A 375×812 phone (the desk meta's viewport): the column is the page's width. */
const PHONE = {
  globals: { viewport: { value: "phone", isRotated: false } },
} as const

/** A 320×568 phone, the narrowest the desk fits. */
const PHONE_320 = {
  globals: { viewport: { value: "phone320", isRotated: false } },
} as const

/** Fails unless the story runs in a frame this wide (it would pass vacuously). */
async function expectPhoneWidth(doc: Document, width = 375) {
  await expect(doc.documentElement.clientWidth, `A ${width}px frame`).toBe(
    width
  )
}

/**
 * Everything at phone width stays inside the page: nothing scrolls it
 * sideways. Before the fix the read-only neighbor's Show button overran the
 * page by 36px; on a phone that widens the layout viewport, which zooms the
 * page out and pushes the sticky dock partly below the screen. The play
 * scrolls into the unit, where the dock floats over the code, and asserts
 * the dock sits wholly on screen.
 */
export const PhoneFitsTheWidth: Story = {
  ...PHONE,
  play: async ({ canvasElement }) => {
    const doc = canvasElement.ownerDocument
    const view = doc.defaultView!
    await expectPhoneWidth(doc)
    const column = mainColumn(canvasElement)
    await waitFor(() =>
      expect(column.style.getPropertyValue("--nv-dock-h")).not.toBe("")
    )
    // Once the context margin has placed its pins (they start past the
    // edge for a few frames as the desk mounts).
    await waitFor(
      async () => {
        await expect(
          doc.documentElement.scrollWidth,
          "Nothing scrolls the page sideways"
        ).toBe(375)
        const past = [...doc.body.querySelectorAll<HTMLElement>("*")]
          .filter((element) => {
            const box = element.getBoundingClientRect()
            return box.width > 0 && (box.right > 375.5 || box.left < -0.5)
          })
          .map((element) => element.textContent.trim().slice(0, 40))
        await expect(past, "Every element is inside the page").toEqual([])
      },
      { timeout: 3000 }
    )

    // Into the unit: the page is the one scroll container at this width.
    view.scrollTo(0, column.getBoundingClientRect().top + view.scrollY + 400)
    await frames(2)
    const dock = canvasElement.querySelector<HTMLElement>("[data-dock-body]")!
    await waitFor(() => expect(dock).toBeVisible())
    const box = dock.getBoundingClientRect()
    const screen = view.visualViewport!
    await expect(view.innerHeight, "The page is not zoomed out").toBe(
      screen.height
    )
    await expect(box.top).toBeGreaterThanOrEqual(0)
    await expect(box.left).toBeGreaterThanOrEqual(0)
    await expect(box.right, "The dock is on screen").toBeLessThanOrEqual(
      screen.width
    )
    await expect(box.bottom, "The dock is on screen").toBeLessThanOrEqual(
      screen.height
    )
  },
}

/**
 * The read-only neighbor at phone width: its note and context count take a
 * second line, so its Show button sits wholly inside the card, nothing
 * covers it, and the path keeps its room. Showing and hiding the rows
 * leaves the button where it is.
 */
export const PhoneNeighborFits: Story = {
  ...PHONE,
  play: async ({ canvas, canvasElement, userEvent }) => {
    const doc = canvasElement.ownerDocument
    await expectPhoneWidth(doc)
    const show = await canvas.findByRole("button", {
      name: "Show",
      expanded: false,
    })
    show.scrollIntoView({ block: "center" })
    await frames(2)
    // The header row spans the card.
    const header = show.parentElement!
    const card = header.getBoundingClientRect()
    const box = show.getBoundingClientRect()
    await expect(box.left).toBeGreaterThanOrEqual(card.left)
    await expect(box.right, "Show sits inside its card").toBeLessThanOrEqual(
      card.right
    )
    await expect(box.right, "Show sits inside the page").toBeLessThanOrEqual(
      doc.documentElement.clientWidth
    )
    for (const [x, y] of [
      [box.left + 2, box.top + box.height / 2],
      [box.right - 2, box.top + box.height / 2],
    ] as const)
      await expect(
        show.contains(doc.elementFromPoint(x, y)),
        "Nothing covers Show"
      ).toBe(true)
    const path = within(header).getByText(/\.ts$/)
    await expect(
      path.scrollWidth,
      "The path is shown whole"
    ).toBeLessThanOrEqual(path.clientWidth)
    const note = within(header).getByText(/^Read-only/)
    await expect(
      note.getBoundingClientRect().top,
      "The note takes the second line"
    ).toBeGreaterThanOrEqual(path.getBoundingClientRect().bottom)

    await userEvent.click(show)
    await expect(show).toHaveAttribute("aria-expanded", "true")
    // Once the press has eased back (SCALE.press).
    await waitFor(() => expect(show.getBoundingClientRect()).toEqual(box))
  },
}

/**
 * The header on a phone: two rows, the logomark and controls, then the
 * breadcrumb on one line. Before the fix it wrapped onto four rows, 180px
 * tall at 375 (202px at 320) with the controls on rows of their own. Every
 * control stays on screen with its name, the agents' count and the commit
 * whole; the branch shortens instead of wrapping.
 */
async function expectHeaderFits(canvasElement: HTMLElement, width: number) {
  const doc = canvasElement.ownerDocument
  await expectPhoneWidth(doc, width)
  const header = canvasElement.querySelector("header")!
  const canvas = within(header)
  await waitFor(() =>
    expect(
      doc.documentElement.scrollWidth,
      "Nothing scrolls the page sideways"
    ).toBe(width)
  )
  const rows = headerRows(header)
  await expect(rows, "The header takes two rows").toHaveLength(2)
  // 36px of controls and the breadcrumb's 21px, with the bar's padding.
  await expect(
    header.getBoundingClientRect().height,
    "The header is two rows tall"
  ).toBeLessThanOrEqual(80)

  const controls = [
    canvas.getByRole("link", { name: "Neuve — Reviews" }),
    canvas.getByRole("button", { name: /agents on this branch/ }),
    canvas.getByRole("button", { name: "Find" }),
    canvas.getByRole("link", { name: "Settings" }),
    canvas.getByRole("button", { name: /Switch to (dark|light) theme/ }),
  ]
  for (const control of controls) {
    await expect(control).toBeVisible()
    const box = control.getBoundingClientRect()
    await expect(box.top, "Controls share the first row").toBeLessThan(
      rows[0]!.bottom
    )
    await expect(box.left).toBeGreaterThanOrEqual(0)
    await expect(
      box.right,
      "Each control is inside the page"
    ).toBeLessThanOrEqual(width)
  }
  await expect(controls[1]!.innerText, "The agents' count is shown").toMatch(
    /^\d+ agents · \d+ live$/
  )

  const branch = canvas.getByText("shr-212-revoke-links")
  const commit = canvas.getByText("a3f9c2e")
  for (const part of [branch, commit]) {
    await expect(part).toBeVisible()
    await expect(
      part.getBoundingClientRect().top,
      "The breadcrumb is the second row"
    ).toBeGreaterThanOrEqual(rows[1]!.top - 1)
  }
  await expect(
    commit.scrollWidth,
    "The commit is shown whole"
  ).toBeLessThanOrEqual(commit.clientWidth)
  await expect(
    commit.getBoundingClientRect().right,
    "The commit is inside the page"
  ).toBeLessThanOrEqual(width)
}

export const PhoneHeaderFits: Story = {
  ...PHONE,
  play: async ({ canvasElement }) => {
    await expectHeaderFits(canvasElement, 375)
  },
}

export const PhoneHeaderFits320: Story = {
  ...PHONE_320,
  play: async ({ canvasElement }) => {
    await expectHeaderFits(canvasElement, 320)
  },
}

/**
 * The decided dock at 320: what you did on the first row, Undo and the way
 * on (Next unit or Back to batch) on the second, all inside the page. Before
 * the fix the bar kept one row and the way on ran 4–34px past the page,
 * which scrolled it sideways.
 */
async function expectDecidedDockFits(canvasElement: HTMLElement, name: RegExp) {
  const doc = canvasElement.ownerDocument
  await expectPhoneWidth(doc, 320)
  const link = await within(canvasElement).findByRole("link", { name })
  const status = link.closest<HTMLElement>("[role=status]")!
  const undo = within(status).getByRole("button", { name: "Undo" })
  // Once the bar has risen into place (dockRise).
  await waitFor(
    async () => {
      await expect(
        doc.documentElement.scrollWidth,
        "Nothing scrolls the page sideways"
      ).toBe(320)
      for (const part of [status, undo, link]) {
        const box = part.getBoundingClientRect()
        await expect(box.left).toBeGreaterThanOrEqual(0)
        await expect(
          box.right,
          "The dock is inside the page"
        ).toBeLessThanOrEqual(320)
      }
    },
    { timeout: 3000 }
  )
  const [undoBox, linkBox] = [
    undo.getBoundingClientRect(),
    link.getBoundingClientRect(),
  ]
  await expect(undoBox.top, "Undo and the way on share a row").toBe(linkBox.top)
  await expect(
    link.scrollWidth,
    "The way on is shown whole"
  ).toBeLessThanOrEqual(link.clientWidth)
}

export const PhoneApproved: Story = {
  ...PHONE_320,
  args: deskAt("revoke-live", { dock: "approved" }),
  play: async ({ canvasElement }) => {
    await expectDecidedDockFits(canvasElement, /Next unit/)
  },
}

export const PhoneChangesRequested: Story = {
  ...PHONE_320,
  args: deskAt("revoke-live", { dock: "changes-requested" }),
  play: async ({ canvasElement }) => {
    await expectDecidedDockFits(canvasElement, /Next unit/)
  },
}

export const PhoneSuggestedAgreed: Story = {
  ...PHONE_320,
  args: deskAt("suggested", { dock: "agreed" }),
  play: async ({ canvasElement }) => {
    await expectDecidedDockFits(canvasElement, /Next unit/)
  },
}

/** The longest way on: "Back to batch". */
export const PhoneApprovedLastUndecided: Story = {
  ...PHONE_320,
  args: deskAt(lastUndecidedDeskFixture, { dock: "approved" }),
  play: async ({ canvasElement }) => {
    await expectDecidedDockFits(canvasElement, /Back to batch/)
  },
}

/* ── Tabbing through the dock ──────────────────────────── */

/** The dock's controls in tab order (none sets a positive tabindex). */
function dockStops(dock: HTMLElement) {
  return [
    ...dock.querySelectorAll<HTMLElement>(
      "button, textarea, input, a[href], [tabindex]"
    ),
  ].filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.matches(":disabled") &&
      element.checkVisibility()
  )
}

/**
 * Tabs from `start` through every control in the dock to its last, then
 * back, and fails if the desk scrolled. The desk's scroll padding reserves
 * the dock's height so landings clear it; before the fix that padding also
 * covered the dock's own buttons, so focusing one (Tab from a composer to
 * its Cancel) scrolled the desk to uncover it: 478px on a long unit. With
 * focus back out of the dock the padding returns, so landings still clear
 * the dock.
 */
async function expectTabbingHoldsTheDesk(
  canvasElement: HTMLElement,
  user: { tab: (options?: { shift?: boolean }) => Promise<unknown> },
  start: HTMLElement
) {
  const doc = canvasElement.ownerDocument
  const scroller = mainColumn(canvasElement)
  const dock = canvasElement.querySelector<HTMLElement>("[data-decision-dock]")!
  const range = scroller.scrollHeight - scroller.clientHeight
  await expect(range, "The unit scrolls").toBeGreaterThan(200)
  scroller.scrollTop = Math.round(range / 2)
  doc.defaultView?.focus()
  start.focus({ preventScroll: true })
  // The dock state's rise has run (dockRise).
  await pause(400)
  const top = scroller.scrollTop
  const stops = dockStops(dock)
  await expect(stops).toContain(start)
  await expect(
    stops.length - stops.indexOf(start) - 1,
    "The dock has controls after the start"
  ).toBeGreaterThan(0)
  const visited: Array<string> = []
  const step = async (shift: boolean) => {
    await user.tab({ shift })
    await frames(2)
    const active = doc.activeElement as HTMLElement
    await expect(dock.contains(active), "Focus stays in the dock").toBe(true)
    visited.push(active.getAttribute("aria-label") ?? active.textContent.trim())
    await expect(
      scroller.scrollTop,
      `Focusing ${visited.at(-1)} didn't scroll the desk`
    ).toBe(top)
  }
  while (doc.activeElement !== stops.at(-1)) await step(false)
  while (doc.activeElement !== start) await step(true)
  await expect(visited.length).toBeGreaterThanOrEqual(2)

  // Nothing in the dock has focus: the padding keeps landings clear again.
  start.blur()
  await expect(
    parseFloat(getComputedStyle(scroller).scrollPaddingBottom),
    "Landings clear the dock"
  ).toBe(parseFloat(scroller.style.getPropertyValue("--nv-dock-h")) + 44)
}

/** Request changes on a long unit: Tab from the text to Cancel and on. */
export const DockTabHoldsTheDesk: Story = {
  args: deskAt("long-file", { dock: "composing" }),
  play: async ({ canvas, canvasElement, userEvent }) => {
    const text = await canvas.findByRole("textbox", {
      name: "What needs to change",
    })
    await expectTabbingHoldsTheDesk(canvasElement, userEvent, text)
  },
}

/** "Comment on this unit" on a long unit: its Cancel and Comment. */
export const DockTabHoldsTheLaneComposer: Story = {
  args: deskAt(longAgenticDesk, {
    dock: "composing",
    state: { feedbackKind: "comment" },
  }),
  play: async ({ canvas, canvasElement, userEvent }) => {
    const text = await canvas.findByRole("textbox", { name: "Comment" })
    await expectTabbingHoldsTheDesk(canvasElement, userEvent, text)
  },
}

/** The rest dock's buttons, from its first. */
export const DockTabHoldsTheRestDock: Story = {
  args: deskAt("long-file"),
  play: async ({ canvasElement, userEvent }) => {
    const dock = await waitFor(() => {
      const found = canvasElement.querySelector<HTMLElement>(
        "[data-decision-dock]"
      )
      expect(found && dockStops(found).length).toBeGreaterThan(1)
      return found!
    })
    await expectTabbingHoldsTheDesk(
      canvasElement,
      userEvent,
      dockStops(dock)[0]!
    )
  },
}
