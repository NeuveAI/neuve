import type { Decorator, Meta, StoryObj } from "@storybook/react-vite"
import { Provider, atom, createStore, useAtomValue, useSetAtom } from "jotai"
import { useMemo } from "react"
import type * as React from "react"
import { expect, fireEvent, waitFor, within } from "storybook/test"

import {
  EXPIRY_PATH,
  SCHEDULE_UNIT_TITLE,
  carriedRailDeskFixture,
  carriedSuggestedDeskFixture,
  carriedUnitDeskFixture,
  earlierVersionDeskFixture,
  lockfileAloneDeskFixture,
  lockfileDeskFixture,
  lockfileLongLaneDeskFixture,
  lockfileRailDeskFixture,
  partsOnlyDeskFixture,
  lanesArrivedDeskFixture,
  lanesDeskFixture,
  lanesRaisedDeskFixture,
  lanesWithStaticDeskFixture,
  noAgentDecisionArrivedDeskFixture,
  noAgentDecisionDeskFixture,
  replacedDeskFixture,
  replacedNoSuccessorDeskFixture,
  UNDECIDED_SECTION_NOTE,
  undecidedSectionDeskFixture,
  wholeUnitCommentsDeskFixture,
} from "@workspace/ui/fixtures/lanes-desk.fixtures"
import {
  NEWER_BATCH_ID,
  NEWER_EXTEND_UNIT_ID,
} from "@workspace/ui/fixtures/lanes-scenario.fixtures"
import { NewerReviewProvider } from "@workspace/ui/neuve/shared/app-header"
import { BatchArrivalsStore } from "@workspace/ui/neuve/shared/batch-arrivals"
import { DEFAULT_DELIVERY_SETTINGS } from "@workspace/ui/neuve/shared/delivery"
import { DeskAt, deskAt, deskMeta } from "@workspace/ui/neuve/story-kit/desk"
import type { DeskAtProps } from "@workspace/ui/neuve/story-kit/desk"
import type { ReviewDeskData } from "@workspace/ui/neuve/types"
import { diffRoot, mainColumn } from "@workspace/ui/neuve/story-kit/dom"
import { RailFrame } from "@workspace/ui/neuve/story-kit/frames"
import { frames, stopRadio, visible } from "@workspace/ui/neuve/story-kit/play"

/**
 * The review desk with real lanes (NEU-148): each unit is one file's
 * changes in one review lane. One review of three batches on SHR-240; the
 * desk opens on "Expired links refuse new sessions", human-required, whose
 * lane rose since the last run. Every story's data is in
 * `fixtures/lanes-desk.fixtures.ts`.
 */
/** Each story's own store for what a review's screens share (arrivals). */
function OwnArrivals({ children }: { children: React.ReactNode }) {
  const store = useMemo(() => createStore(), [])
  return <BatchArrivalsStore store={store}>{children}</BatchArrivalsStore>
}
const ownArrivals: Decorator = (Story) => (
  <OwnArrivals>
    <Story />
  </OwnArrivals>
)

const base = deskMeta(
  lanesDeskFixture,
  {},
  { settings: DEFAULT_DELIVERY_SETTINGS }
)
const meta = {
  title: "Screens/Review desk/Lanes",
  ...base,
  decorators: [...base.decorators, ownArrivals],
} satisfies Meta<typeof DeskAt>

export default meta
type Story = StoryObj<typeof meta>

/** The lane groups listed, as a reader opens them. */
const OPEN_LANES = {
  state: {
    openLanes: ["human-suggested", "agentic-review"] as const,
  },
}

const rail = (canvasElement: HTMLElement) =>
  within(canvasElement.querySelector<HTMLElement>("nav")!)

/**
 * The innermost element whose text, as read, is `text`: the meter's
 * "Decided" is visually hidden beside its count, in another node.
 */
const readAs = (text: string) => (_content: string, element: Element | null) =>
  element?.textContent === text &&
  [...element.children].every((child) => child.textContent !== text)

/**
 * Four lanes with real data: three units need a decision, Human-suggested
 * 2, Agentic review 4, Static automation 0 (no chevron).
 */
export const FourLanes: Story = {
  args: deskAt(lanesDeskFixture, OPEN_LANES),
  play: async ({ canvasElement }) => {
    const nav = rail(canvasElement)
    await visible(nav.getByRole("button", { name: /Human-suggested\s*2/ }))
    expect(
      nav.getByRole("button", { name: /Static automation\s*0/ })
    ).not.toHaveAttribute("aria-expanded")
    expect(nav.getAllByRole("listitem")).toHaveLength(6)
  },
}

/** The variant with one static-automation unit and three agentic units. */
export const WithStaticAutomation: Story = {
  args: deskAt(lanesWithStaticDeskFixture, {
    state: { openLanes: ["static-automation", "agentic-review"] },
  }),
}

/** The collapsed rail: each lane's tooltip names it in full. */
export const CollapsedRail: Story = {
  args: deskAt(lanesDeskFixture, { rail: "collapsed" }),
  play: async ({ canvasElement }) => {
    const nav = rail(canvasElement)
    await visible(
      nav.getByRole("button", { name: "Human-suggested · 2 units" })
    )
    nav.getByRole("link", {
      name: "Expired links refuse new sessions · needs your decision · Moved up from Agentic review",
    })
  },
}

/**
 * The unit no agent decided: named on the rail by its file and owned
 * lines; on the page one plain line where its briefing begins, then its
 * Facts text and its diff. No suggested review.
 */
export const NoAgentDecision: Story = {
  args: deskAt(noAgentDecisionDeskFixture),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await visible(canvas.getByText("No agent decision in this run"))
    // The rail row's accessible name is the unit's whole title.
    rail(canvasElement).getByRole("link", {
      name: new RegExp(`^${SCHEDULE_UNIT_TITLE}`),
    })
  },
}

/** A unit whose lane rose since the last run, in a lane group too. */
export const RaisedSinceLastRun: Story = {
  args: deskAt(lanesRaisedDeskFixture, OPEN_LANES),
  play: async ({ canvasElement }) => {
    const nav = rail(canvasElement)
    await visible(nav.getByRole("link", { name: /^Link list shows time left/ }))
    // Rail rows and the unit's head line each say it once.
    expect(
      nav.getAllByRole("link", { name: /Moved up from Agentic review/ })
    ).toHaveLength(2)
    expect(
      within(canvasElement.querySelector("main")!).getAllByRole("img", {
        name: "Moved up from Agentic review",
      })
    ).toHaveLength(1)
  },
}

/**
 * Three units from expiry.ts, one per lane, their lines interleaved: the
 * human-required unit's lines with the other two units' folded between.
 */
export const ThreeUnitsInOneFile: Story = {
  args: deskAt(lanesDeskFixture),
  play: async ({ canvasElement }) => {
    const root = await diffRoot(canvasElement)
    expect(root).toBeTruthy()
    await waitFor(() =>
      expect(
        canvasElement.querySelectorAll(
          `[aria-label*="owned by"], [aria-label*="other unit"]`
        ).length
      ).toBeGreaterThan(0)
    )
    expect(
      within(canvasElement).getAllByText(EXPIRY_PATH, { exact: false })
    ).not.toHaveLength(0)
  },
}

/** Facts: what the change removes comes first. */
export const FactsRemovalFirst: Story = {
  args: deskAt(lanesDeskFixture, { stop: "facts" }),
  play: async ({ canvasElement }) => {
    await visible(
      within(canvasElement).getByText(/^Removes neverExpires from ShareLink\./)
    )
  },
}

/**
 * A joined unit of a redesigned review whose second change no agent
 * decided. It offers Facts alone, so it opens there: that change's row says
 * so, with what the agent was unsure of, before its Facts; the unit says
 * nothing of it.
 */
export const UndecidedSection: Story = {
  args: deskAt(undecidedSectionDeskFixture),
  play: async ({ canvasElement }) => {
    const change = await waitFor(() =>
      within(canvasElement).getByRole("region", {
        name: "Extending sets a new expiry date",
      })
    )
    await expect(await stopRadio(canvasElement, "facts")).toBeChecked()
    within(change).getByText("No agent decision in this run")
    within(change).getByText(UNDECIDED_SECTION_NOTE)
    within(change).getByText(/access-policy\.ts at line 14/)
    expect(
      within(canvasElement).getAllByText("No agent decision in this run")
    ).toHaveLength(1)
  },
}

/* ── A batch arrives ───────────────────────────────────── */

/** Whether the review's second batch has arrived (story chrome only). */
const arrivedAtom = atom(false)
/** Whether the reader moved on to the next unit (story chrome only). */
const movedOnAtom = atom(false)

/**
 * The desk on the unit no agent decided while the review runs, with the
 * story's own chrome: the second batch arrives (as a data reload brings
 * it), and the reader moves on to another unit, a new desk keyed by its
 * unit as the app keys it.
 */
function ArrivingDesk(props: DeskAtProps) {
  const arrived = useAtomValue(arrivedAtom)
  const arrive = useSetAtom(arrivedAtom)
  const movedOn = useAtomValue(movedOnAtom)
  const moveOn = useSetAtom(movedOnAtom)
  const data = movedOn
    ? arrived
      ? lanesArrivedDeskFixture
      : lanesDeskFixture
    : arrived
      ? noAgentDecisionArrivedDeskFixture
      : noAgentDecisionDeskFixture
  return (
    <>
      <DeskAt key={data.unit.id} {...props} data={data} />
      <span className="fixed bottom-3 left-3 z-50 flex gap-2">
        <button
          type="button"
          data-story-arrive=""
          disabled={arrived}
          onClick={() => arrive(true)}
          className="rounded-md bg-ink px-3 py-1.5 text-xs text-paper disabled:opacity-60"
        >
          {arrived ? "Batch 2 arrived" : "Batch 2 arrives"}
        </button>
        <button
          type="button"
          data-story-move-on=""
          onClick={() => moveOn(true)}
          className="rounded-md bg-ink px-3 py-1.5 text-xs text-paper"
        >
          Next unit
        </button>
      </span>
    </>
  )
}

const arriving = {
  // A unit with a long diff, so the scroll position is a real one.
  args: deskAt(noAgentDecisionDeskFixture, OPEN_LANES),
  render: (args: DeskAtProps) => (
    <Provider>
      <ArrivingDesk {...args} />
    </Provider>
  ),
}

/** The arrival, dispatched: it comes from the server, not a click on the page. */
async function arriveFromServer(canvasElement: HTMLElement) {
  fireEvent.click(
    canvasElement.querySelector<HTMLElement>("[data-story-arrive]")!
  )
  await waitFor(() =>
    expect(canvasElement.querySelector("[data-story-arrive]")).toBeDisabled()
  )
}

/**
 * A new batch of the review is published while the desk is open: the
 * header's live region says so once and its batch menu learns of it. The
 * rail's rows, the open unit, focus and the diff's scroll position stay as
 * they were.
 */
export const BatchArrives: Story = {
  ...arriving,
  // Desktop only: the stacked desk (below 861px) scrolls the page, not the
  // column this play scrolls; BatchArrivesStacked covers it.
  play: async ({ canvasElement }) => {
    const doc = canvasElement.ownerDocument
    const nav = canvasElement.querySelector("nav")!
    const scroll = mainColumn(canvasElement)
    const title = await waitFor(() =>
      within(canvasElement).getByRole("heading", { level: 1 })
    )
    await diffRoot(canvasElement)
    // The header's one live region is in the page, silent, before the
    // batch arrives.
    const region = canvasElement.querySelector<HTMLElement>(
      "[data-batch-arrivals]"
    )!
    expect(region).toHaveAttribute("role", "status")
    expect(region).toBeEmptyDOMElement()
    // Scrolled into the diff, so a jump back would show.
    scroll.scrollTop = 160
    await waitFor(() => expect(scroll.scrollTop).toBe(160))
    within(nav)
      .getByRole("link", { name: /^Rename the expiry constants/ })
      .focus()
    await frames(3)
    const before = {
      rows: [...nav.querySelectorAll("a, button")].map(
        (row) => row.textContent
      ),
      title: title.textContent,
      active: doc.activeElement,
      top: scroll.scrollTop,
    }
    // Dispatched, so focus stays where the reader left it.
    await arriveFromServer(canvasElement)
    await waitFor(() =>
      expect(region).toHaveTextContent(/^New batch: Expiry reminders by email$/)
    )
    await frames(6)
    expect(canvasElement.querySelector("[data-batch-arrivals]")).toBe(region)
    expect(
      [...nav.querySelectorAll("a, button")].map((row) => row.textContent)
    ).toEqual(before.rows)
    expect(
      within(canvasElement).getByRole("heading", { level: 1 }).textContent
    ).toBe(before.title)
    expect(doc.activeElement).toBe(before.active)
    expect(scroll.scrollTop).toBe(before.top)
  },
}

/**
 * The same arrival on the stacked desk (a phone): announced once, the
 * rail's rows and the title where they were.
 */
export const BatchArrivesStacked: Story = {
  ...arriving,
  play: async ({ canvasElement }) => {
    const title = await waitFor(() =>
      within(canvasElement).getByRole("heading", { level: 1 })
    )
    const region = canvasElement.querySelector<HTMLElement>(
      "[data-batch-arrivals]"
    )!
    expect(region).toBeEmptyDOMElement()
    const nav = canvasElement.querySelector("nav")!
    const rows = [...nav.querySelectorAll("a, button")].map(
      (row) => row.textContent
    )
    // Fonts in and the page still, so the title's place is its settled one.
    await document.fonts.ready
    let top = Number.NaN
    for (let steady = 0; steady < 4;) {
      await frames(1)
      const now = title.getBoundingClientRect().top
      steady = now === top ? steady + 1 : 0
      top = now
    }
    await arriveFromServer(canvasElement)
    await waitFor(() =>
      expect(region).toHaveTextContent(/^New batch: Expiry reminders by email$/)
    )
    await frames(6)
    expect(
      [...nav.querySelectorAll("a, button")].map((row) => row.textContent)
    ).toEqual(rows)
    expect(title.getBoundingClientRect().top).toBe(top)
  },
}

/**
 * The arrival outlives the unit: the reader moves on to the next unit (a
 * new desk, with a store of its own). Its batch menu keeps the dot, and
 * nothing is announced again.
 */
export const BatchArrivesThenNextUnit: Story = {
  ...arriving,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() => canvas.getByRole("heading", { level: 1 }))
    await arriveFromServer(canvasElement)
    await canvas.findByRole("button", { name: /batch 1 of 3, 1 new$/ })
    fireEvent.click(
      canvasElement.querySelector<HTMLElement>("[data-story-move-on]")!
    )
    await waitFor(() =>
      expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
        "Expired links refuse new sessions"
      )
    )
    await canvas.findByRole("button", { name: /batch 1 of 3, 1 new$/ })
    expect(
      canvasElement.querySelector("[data-batch-arrivals]")
    ).toBeEmptyDOMElement()
  },
}

/* ── Your earlier decision carried ───────────────────────── */

/**
 * Your approval of "Admins can extend an expired link" carried from the
 * branch's earlier review: it leaves "Needs your decision" and its meter
 * (0/2) for a collapsed "Decided" group of its own, above the lanes decided
 * by agents and tools.
 */
export const CarriedDecision: Story = {
  args: deskAt(carriedRailDeskFixture),
  play: async ({ canvasElement }) => {
    const nav = rail(canvasElement)
    const group = await waitFor(() =>
      nav.getByRole("button", { name: /^Decided\s*1$/ })
    )
    expect(group).toHaveAttribute("aria-expanded", "false")
    expect(nav.getByText(readAs("Decided 0/2"))).toBeVisible()
    const needs = within(
      nav.getByRole("region", { name: "Needs your decision" })
    )
    expect(
      needs.queryByRole("link", { name: /^Admins can extend an expired link/ })
    ).toBeNull()
    // Keyboard order: after "Needs your decision", before the agents' lanes.
    const order = [...canvasElement.querySelectorAll("nav a, nav button")]
    expect(order.indexOf(group)).toBeLessThan(
      order.indexOf(nav.getByRole("button", { name: /^Human-suggested/ }))
    )
    fireEvent.click(group)
    const row = await waitFor(() =>
      nav.getByRole("link", { name: /^Admins can extend an expired link/ })
    )
    expect(row).toHaveAccessibleName(/Carried · You approved$/)
    // The title has the row: the carried word is the mark's, not shown.
    expect(row).not.toHaveTextContent(/carried(?! ·)/)
  },
}

export const CarriedDecisionDark: Story = {
  ...CarriedDecision,
  globals: { theme: "dark" },
}

/** The collapsed rail: the "Decided" group is one glyph with its count. */
export const CarriedDecisionCollapsedRail: Story = {
  args: deskAt(carriedRailDeskFixture, { rail: "collapsed" }),
  play: async ({ canvasElement }) => {
    await visible(
      rail(canvasElement).getByRole("button", { name: "Decided · 1 unit" })
    )
  },
}

/**
 * The admins unit's own page: the "Decided" group is open on its row, the
 * current one; your carried approval stands, so the dock opens decided with
 * Undo, which retracts it and leaves the unit waiting on you again.
 */
export const CarriedDecisionUnit: Story = {
  args: deskAt(carriedUnitDeskFixture, { dock: "approved" }),
  play: async ({ canvasElement }) => {
    const nav = rail(canvasElement)
    const row = await waitFor(() =>
      nav.getByRole("link", { name: /^Admins can extend an expired link/ })
    )
    expect(row).toHaveAttribute("aria-current", "page")
    expect(row).toHaveAccessibleName(/Carried · You approved$/)
    expect(nav.getByRole("button", { name: /^Decided\s*1$/ })).toHaveAttribute(
      "aria-expanded",
      "true"
    )
    expect(nav.getByText(readAs("Decided 0/2"))).toBeVisible()
    await visible(within(canvasElement).getByRole("button", { name: /Undo/ }))
  },
}

export const CarriedDecisionUnitDark: Story = {
  ...CarriedDecisionUnit,
  globals: { theme: "dark" },
}

/**
 * "Expiry dates accept a time zone", which the agent approved: your request
 * for changes from the earlier review carried and stands over it. The
 * review card is yours, marked carried, never "Agent approved"; the comment
 * it rests on names no lines, so it is under the briefing, on the whole
 * unit; its rail row shows your mark; the dock opens decided with Undo.
 */
export const CarriedRequestOnSuggestedWork: Story = {
  // The dock opens decided, as the route opens it on the reader's own
  // standing decision (`recordedDecision`).
  args: deskAt(carriedSuggestedDeskFixture, {
    ...OPEN_LANES,
    dock: "changes-requested",
  }),
  play: async ({ canvasElement }) => {
    const main = within(mainColumn(canvasElement))
    const card = await waitFor(() =>
      main.getByRole("region", { name: "The review" })
    )
    expect(card).toHaveTextContent(/Carried · You requested changes/)
    expect(main.queryByText(/Agent approved/)).toBeNull()
    const comments = main.getByRole("list", { name: "Comments on this unit" })
    expect(comments).toHaveTextContent(/Keep the link's own time zone/)
    expect(comments).toHaveTextContent(/Earlier review, head 2d7f0c1/)
    const row = rail(canvasElement).getByRole("link", {
      name: /^Expiry dates accept a time zone/,
    })
    expect(row).toHaveAccessibleName(/Carried · You requested changes$/)
    await visible(within(canvasElement).getByRole("button", { name: /Undo/ }))
  },
}

export const CarriedRequestOnSuggestedWorkDark: Story = {
  ...CarriedRequestOnSuggestedWork,
  globals: { theme: "dark" },
}

/**
 * Comments that name no lines: the reviewer's on the change it names (its
 * row), the reviewer's and Rosa's on the whole unit under the briefing,
 * each with its author. Records' note about the unit leads the briefing.
 */
export const WholeUnitComments: Story = {
  args: deskAt(wholeUnitCommentsDeskFixture),
  play: async ({ canvasElement }) => {
    const main = within(mainColumn(canvasElement))
    const whole = await waitFor(() =>
      main.getByRole("list", { name: "Comments on this unit" })
    )
    expect(within(whole).getAllByRole("listitem")).toHaveLength(2)
    expect(whole).toHaveTextContent(/R1.*Extending an expired link reopens/)
    expect(whole).toHaveTextContent(/Rosa Amaral.*cap at 90 days/)
    const row = main.getByRole("region", { name: /audit log/i })
    expect(
      within(row).getByRole("list", { name: /^Comments on / })
    ).toHaveTextContent(/doesn't name the new expiry date|can't tell how far/)
    await visible(main.getByText(/wasn't brought forward/))
  },
}

export const WholeUnitCommentsDark: Story = {
  ...WholeUnitComments,
  globals: { theme: "dark" },
}

/**
 * "Expired links refuse new sessions" changed since the branch's earlier
 * review: each person's decision there is one quiet line, made on an
 * earlier version. It closes nothing: the unit still needs your decision.
 */
export const EarlierVersionDecisions: Story = {
  args: deskAt(earlierVersionDeskFixture),
  play: async ({ canvasElement }) => {
    const main = within(mainColumn(canvasElement))
    const list = await waitFor(() =>
      main.getByRole("list", { name: "Decisions on earlier versions" })
    )
    const lines = within(list).getAllByRole("listitem")
    expect(lines.map((line) => line.textContent)).toEqual([
      "Rosa Amaral approved an earlier version·Earlier review, head 2d7f0c1",
      "You requested changes on an earlier version·Earlier review, head 2d7f0c1",
    ])
    expect(
      within(canvasElement).queryByRole("button", { name: /Undo/ })
    ).toBeNull()
  },
}

export const EarlierVersionDecisionsDark: Story = {
  ...EarlierVersionDecisions,
  globals: { theme: "dark" },
}

/**
 * The lockfile no agent read: its page says "Lockfile, not read" where a
 * briefing would begin, with the rule that marked it under it, quiet; its
 * rail row says the same. It keeps its lane and never needs your decision.
 */
export const LockfileNotRead: Story = {
  args: deskAt(lockfileDeskFixture, OPEN_LANES),
  play: async ({ canvasElement }) => {
    const main = within(mainColumn(canvasElement))
    await visible(await main.findByText("Lockfile, not read"))
    expect(main.getByText("Marked a lockfile by its file name")).toBeVisible()
    // Its lane line is the lane alone: a unit no agent read asks for
    // nothing, so nothing says "optional" beside "not read".
    expect(main.getByText(/^Human-suggested$/)).toBeVisible()
    expect(main.queryByText(/optional/i)).toBeNull()
    const row = rail(canvasElement).getByRole("link", {
      name: /^Changes to pnpm-lock\.yaml/,
    })
    expect(row).toHaveTextContent(/Lockfile, not read/)
    // In the rail's own "Not read" group, open on it, never among the lanes
    // decided by agents and tools nor under "Needs your decision".
    expect(row.closest("[data-not-read-group]")).not.toBeNull()
    expect(
      rail(canvasElement).getByRole("button", { name: /^Not read\s*1$/ })
    ).toHaveAttribute("aria-expanded", "true")
    for (const region of ["Needs your decision", "Decided by agents and tools"])
      expect(
        within(
          rail(canvasElement).getByRole("region", { name: region })
        ).queryByRole("link", { name: /pnpm-lock/ })
      ).toBeNull()
  },
}

export const LockfileNotReadDark: Story = {
  ...LockfileNotRead,
  globals: { theme: "dark" },
}

/**
 * The rail on another unit of the lockfile's batch: "Not read" is a
 * collapsed group of its own below the lanes decided by agents and tools,
 * drawn as a lane group, and opens to the lockfile's row.
 */
export const NotReadGroup: Story = {
  args: deskAt(lockfileRailDeskFixture, OPEN_LANES),
  play: async ({ canvasElement }) => {
    const nav = rail(canvasElement)
    const group = await waitFor(() =>
      nav.getByRole("button", { name: /^Not read\s*1$/ })
    )
    expect(group).toHaveAttribute("aria-expanded", "false")
    // Keyboard order: after the lanes decided by agents and tools.
    const order = [...canvasElement.querySelectorAll("nav a, nav button")]
    expect(order.indexOf(group)).toBeGreaterThan(
      order.indexOf(nav.getByRole("button", { name: /^Static automation/ }))
    )
    expect(
      within(
        nav.getByRole("region", { name: "Decided by agents and tools" })
      ).getByRole("button", { name: /^Human-suggested\s*2$/ })
    ).toBeVisible()
    fireEvent.click(group)
    const row = await waitFor(() =>
      nav.getByRole("link", { name: /^Changes to pnpm-lock\.yaml/ })
    )
    expect(row).toHaveTextContent(/Lockfile, not read/)
  },
}

export const NotReadGroupDark: Story = {
  ...NotReadGroup,
  globals: { theme: "dark" },
}

/**
 * The lockfile alone in its batch, as real reviews publish one: nothing
 * needs a decision and every lane decided by agents and tools is empty, so
 * the rail draws the "Not read" group alone, with no heading over empty
 * lanes, and the page's lane line is the lane alone.
 */
export const LockfileAlone: Story = {
  args: deskAt(lockfileAloneDeskFixture),
  play: async ({ canvasElement }) => {
    const main = within(mainColumn(canvasElement))
    await visible(await main.findByText("Lockfile, not read"))
    expect(main.getByText(/^Human-suggested$/)).toBeVisible()
    expect(main.queryByText(/optional/i)).toBeNull()
    const nav = rail(canvasElement)
    expect(nav.getByRole("button", { name: /^Not read\s*1$/ })).toHaveAttribute(
      "aria-expanded",
      "true"
    )
    expect(
      nav.queryByRole("region", { name: "Decided by agents and tools" })
    ).toBeNull()
    expect(nav.queryByText("Decided by agents and tools")).toBeNull()
    expect(
      nav.queryByRole("region", { name: "Needs your decision" })
    ).toBeNull()
    for (const lane of [
      "Human-suggested",
      "Agentic review",
      "Static automation",
    ])
      expect(
        nav.queryByRole("button", { name: new RegExp(`^${lane}`) })
      ).toBeNull()
  },
}

export const LockfileAloneDark: Story = {
  ...LockfileAlone,
  globals: { theme: "dark" },
}

export const LockfileAlonePhone: Story = {
  ...LockfileAlone,
  globals: { viewport: { value: "phone390", isRotated: false } },
}

/** The collapsed rail of the lone lockfile: its "Not read" glyph, and no row of empty lane glyphs. */
export const LockfileAloneCollapsedRail: Story = {
  args: deskAt(lockfileAloneDeskFixture, { rail: "collapsed" }),
  play: async ({ canvasElement }) => {
    const nav = rail(canvasElement)
    await visible(nav.getByRole("button", { name: "Not read · 1 unit" }))
    for (const lane of [
      "Human-suggested",
      "Agentic review",
      "Static automation",
    ])
      expect(
        nav.queryByRole("button", { name: `${lane} · 0 units` })
      ).toBeNull()
  },
}

/** The collapsed rail: "Not read" is one glyph with its count. */
export const NotReadGroupCollapsedRail: Story = {
  args: deskAt(lockfileRailDeskFixture, { rail: "collapsed" }),
  play: async ({ canvasElement }) => {
    await visible(
      rail(canvasElement).getByRole("button", { name: "Not read · 1 unit" })
    )
  },
}

/**
 * A unit of three parts, each with its own text: the parts say it once,
 * each on its row, and the unit has no lead paragraph repeating them.
 */
export const PartsSayItOnce: Story = {
  args: deskAt(partsOnlyDeskFixture),
  play: async ({ canvasElement }) => {
    const main = within(mainColumn(canvasElement))
    for (const section of partsOnlyDeskFixture.unit.sections!) {
      const text = section.briefing
        .map((segment) => ("text" in segment ? segment.text : ""))
        .join("")
      await waitFor(() => expect(main.getAllByText(text)).toHaveLength(1))
    }
  },
}

export const PartsSayItOnceDark: Story = {
  ...PartsSayItOnce,
  globals: { theme: "dark" },
}

/* ── A newer review replaced this one under the reader ───── */

/** Whether the newer review has landed (story chrome only). */
const replacedAtom = atom(false)
/** Reloads after it landed (story chrome only): each a new data object. */
const reloadsAtom = atom(0)

/**
 * The desk with the story's own chrome: the newer review lands, as the
 * live reload brings it (the same page's data, with `newer`, which the app's
 * route hands the header), and the page reloads again after.
 */
function ReplacedDesk({
  replacement,
  ...props
}: DeskAtProps & { replacement: ReviewDeskData }) {
  const replaced = useAtomValue(replacedAtom)
  const replace = useSetAtom(replacedAtom)
  const reloads = useAtomValue(reloadsAtom)
  const reload = useSetAtom(reloadsAtom)
  // Each reload brings new data objects, as a real one does: the batches too.
  const data = replaced
    ? {
        ...replacement,
        ...(replacement.batches
          ? {
              batches: {
                ...replacement.batches,
                all: replacement.batches.all.map((batch) => ({ ...batch })),
              },
            }
          : {}),
      }
    : lanesDeskFixture
  return (
    <NewerReviewProvider newer={data.newer}>
      <DeskAt key={data.unit.id} {...props} data={data} />
      <span className="fixed bottom-3 left-3 z-50 flex gap-2">
        <button
          type="button"
          data-story-replace=""
          onClick={() => replace(true)}
          className="rounded-md bg-ink px-3 py-1.5 text-xs text-paper"
        >
          A newer review lands
        </button>
        <button
          type="button"
          data-story-reload=""
          data-reloads={reloads}
          onClick={() => reload((n) => n + 1)}
          className="rounded-md bg-ink px-3 py-1.5 text-xs text-paper"
        >
          Reload again
        </button>
      </span>
    </NewerReviewProvider>
  )
}

const replacing = (replacement: ReviewDeskData) => ({
  args: deskAt(lanesDeskFixture, OPEN_LANES),
  render: (args: DeskAtProps) => (
    <Provider>
      <ReplacedDesk {...args} replacement={replacement} />
    </Provider>
  ),
})

/**
 * The play for both widths: the region says it once, the link goes to
 * `href`, and focus, the scroll position, the rail's rows and the first
 * thing below the header stay where they were. At 1440 the desk's column
 * scrolls; stacked (390) the page does.
 */
const replacedPlay =
  (href: string) =>
  async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const doc = canvasElement.ownerDocument
    const win = doc.defaultView!
    const canvas = within(canvasElement)
    const nav = canvasElement.querySelector("nav")!
    await waitFor(() => canvas.getByRole("heading", { level: 1 }))
    await diffRoot(canvasElement)
    const region = canvasElement.querySelector<HTMLElement>(
      "[data-batch-arrivals]"
    )!
    expect(region).toBeEmptyDOMElement()
    const below = canvasElement
      .querySelector("header")!
      .parentElement!.querySelector<HTMLElement>(":scope > div.flex-auto")!
    const scroll = mainColumn(canvasElement)
    const stacked = getComputedStyle(scroll).overflowY !== "auto"
    if (stacked) win.scrollTo(0, 200)
    else scroll.scrollTop = 160
    await document.fonts.ready
    await frames(6)
    within(nav)
      .getByRole("link", { name: /^Rename the expiry constants/ })
      .focus()
    const before = {
      active: doc.activeElement,
      scroll: stacked ? win.scrollY : scroll.scrollTop,
      below: below.getBoundingClientRect().top,
      rows: [...nav.querySelectorAll("a, button")].map((r) => r.textContent),
    }
    // Dispatched, as a reload is: nothing the reader did.
    fireEvent.click(
      canvasElement.querySelector<HTMLElement>("[data-story-replace]")!
    )
    await waitFor(() =>
      expect(region).toHaveTextContent(/^A newer review of this work is ready$/)
    )
    const link = canvas.getByRole("link", { name: "Newer review" })
    expect(link).toHaveAttribute("href", href)
    await frames(6)
    expect(doc.activeElement).toBe(before.active)
    expect(stacked ? win.scrollY : scroll.scrollTop).toBe(before.scroll)
    expect(below.getBoundingClientRect().top).toBe(before.below)
    expect(
      [...nav.querySelectorAll("a, button")].map((r) => r.textContent)
    ).toEqual(before.rows)
    // Said once: a later reload of the page says nothing again.
    const said = region.firstElementChild
    fireEvent.click(
      canvasElement.querySelector<HTMLElement>("[data-story-reload]")!
    )
    await frames(6)
    expect(region.firstElementChild).toBe(said)
  }

/**
 * A newer review of this work replaced this one while the reader was on
 * the unit: the page stays, the header says so once and links to the unit
 * that holds the work now (run it at 1440 and 390 wide).
 */
export const ReplacedUnderReader: Story = {
  ...replacing(replacedDeskFixture),
  play: replacedPlay(`/review/${NEWER_EXTEND_UNIT_ID}`),
}

export const ReplacedUnderReaderDark: Story = {
  ...ReplacedUnderReader,
  globals: { theme: "dark" },
}

/** No unit of the newer review holds this one's work: the link goes to its start. */
export const ReplacedNoSuccessor: Story = {
  ...replacing(replacedNoSuccessorDeskFixture),
  play: replacedPlay(`/batch/${NEWER_BATCH_ID}`),
}

/**
 * A short rail (620px) with a long agentic lane and the lockfile: the
 * agents' lanes and the "Not read" group share one container and give up
 * height together, so the group's box never overlaps a lane's rows, with
 * every group closed, the long lane open, or "Not read" open too.
 */
export const NotReadShortRail: Story = {
  args: deskAt(lockfileLongLaneDeskFixture),
  render: () => <RailFrame data={lockfileLongLaneDeskFixture} height={620} />,
  play: async ({ canvasElement }) => {
    const nav = rail(canvasElement)
    const clear = () => {
      const group = canvasElement.querySelector<HTMLElement>(
        "[data-not-read-group]"
      )!
      const top = group.getBoundingClientRect().top
      const region = nav.getByRole("region", {
        name: "Decided by agents and tools",
      })
      // Every lane header and every lane's list ends above the group.
      const boxes = [
        ...region.querySelectorAll<HTMLElement>("button, [role='list']"),
      ]
      expect(boxes.length).toBeGreaterThanOrEqual(3)
      for (const box of boxes)
        expect(box.getBoundingClientRect().bottom).toBeLessThanOrEqual(
          top + 0.5
        )
    }
    await waitFor(() =>
      expect(nav.getByRole("button", { name: /^Not read\s*1$/ })).toBeVisible()
    )
    clear()
    fireEvent.click(nav.getByRole("button", { name: /^Agentic review\s*7$/ }))
    await waitFor(() =>
      expect(
        nav.getByRole("list", { name: "Agentic review units" })
      ).toBeVisible()
    )
    clear()
    fireEvent.click(nav.getByRole("button", { name: /^Not read\s*1$/ }))
    await waitFor(() =>
      expect(
        nav.getByRole("link", { name: /^Changes to pnpm-lock\.yaml/ })
      ).toBeInTheDocument()
    )
    clear()
  },
}

export const NotReadShortRailDark: Story = {
  ...NotReadShortRail,
  globals: { theme: "dark" },
}
