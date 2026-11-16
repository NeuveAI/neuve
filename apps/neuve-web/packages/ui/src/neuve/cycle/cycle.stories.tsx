import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, waitFor } from "storybook/test"

import {
  REVIEWER,
  REVIEW_UNIT_ID,
  agentRegistryFixture,
  commitLineageFixture,
  commitLineageWithPendingFixture,
  newCommitFixture,
  observedCommitLoadFixture,
  unavailableCommitLoadFixture,
} from "@workspace/ui/fixtures/review-batch.fixtures"
import { registeredLineageFixture } from "@workspace/ui/fixtures/shell.fixtures"
import { CommitObservationScreen } from "@workspace/ui/neuve/cycle/commit-observation-screen"
import { LineageScreen } from "@workspace/ui/neuve/cycle/lineage-screen"
import { NewCommitNotice } from "@workspace/ui/neuve/cycle/new-commit-notice"
import { withReviewDeskState } from "@workspace/ui/neuve/review-desk/story-state"

/**
 * New revision mid-review (Cycle.dc.html): a Git event becomes a notice over
 * the unit column; "What changed" opens the commit lineage.
 */
const meta = {
  title: "Screens/Commit lineage",
  component: LineageScreen,
  args: {
    lineage: commitLineageFixture,
    agents: agentRegistryFixture,
    back: { to: "unit", unitId: REVIEW_UNIT_ID },
    reviewer: REVIEWER,
  },
} satisfies Meta<typeof LineageScreen>

export default meta
type Story = StoryObj<typeof meta>

/* ── Play helpers: verdict marks and rendered contrast ──── */

/** Each review mark's words ("You approved"), without the avatar's text. */
function verdictWords(root: ParentNode) {
  return [...root.querySelectorAll<HTMLElement>("[data-review-mark]")].map(
    (mark) =>
      mark.querySelector(":scope > span:last-child")?.textContent.trim() ?? ""
  )
}

/** A computed `rgb()`/`rgba()` colour as channels and alpha. */
function channels(color: string) {
  const [r = 0, g = 0, b = 0, a = 1] = (color.match(/[\d.]+/g) ?? []).map(
    Number
  )
  return { rgb: [r, g, b] as const, alpha: a }
}

/** The colour actually painted behind an element: the nearest opaque fill. */
function backdrop(element: Element) {
  for (let node: Element | null = element; node; node = node.parentElement) {
    const fill = channels(getComputedStyle(node).backgroundColor)
    if (fill.alpha === 1) return fill.rgb
  }
  return [255, 255, 255] as const
}

function contrast(color: string, behind: readonly number[]) {
  const luminance = (rgb: readonly number[]) => {
    const [r, g, b] = rgb.map((value) => {
      const c = value / 255
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
  }
  const front = channels(color)
  // A translucent paint composites over what is behind it.
  const painted = front.rgb.map(
    (channel, i) => channel * front.alpha + behind[i]! * (1 - front.alpha)
  )
  const [hi, lo] = [luminance(painted), luminance(behind)].sort((a, b) => b - a)
  return (hi! + 0.05) / (lo! + 0.05)
}

/** A token as the browser resolves it in the current theme. */
function tokenColor(doc: Document, token: string) {
  const probe = doc.createElement("span")
  probe.style.color = `var(${token})`
  doc.body.append(probe)
  const color = getComputedStyle(probe).color
  probe.remove()
  return color
}

/**
 * Wait for the page's entrance (the main region's content fade and any
 * detail rising) to finish, so visibility, opacity and colour read settled.
 */
async function settled(root: Element) {
  await Promise.all(
    root.ownerDocument
      .getAnimations()
      .map((animation) => animation.finished.catch(() => undefined))
  )
}

/** Nothing inside a mark can take focus: rows are the only control. */
async function expectInertMarks(root: ParentNode) {
  const marks = [...root.querySelectorAll<HTMLElement>("[data-review-mark]")]
  await expect(marks.length).toBeGreaterThan(0)
  for (const mark of marks) {
    await expect(
      mark.querySelectorAll("button, a, input, [tabindex]")
    ).toHaveLength(0)
    // The avatar is decorative beside the visible name.
    for (const avatar of mark.querySelectorAll("[data-avatar]"))
      await expect(avatar.closest("[aria-hidden='true']")).not.toBeNull()
  }
}

/**
 * Words ≥ 4.55:1 against the row they sit on (WCAG 1.4.3 plus a rendering
 * margin), the verdict icon ≥ 3.05:1 (1.4.11), in the story's theme.
 */
async function expectVerdictContrast(root: ParentNode) {
  for (const mark of root.querySelectorAll<HTMLElement>("[data-review-mark]")) {
    const words = mark.querySelector<HTMLElement>(":scope > span:last-child")!
    await expect(
      contrast(getComputedStyle(words).color, backdrop(words))
    ).toBeGreaterThanOrEqual(4.55)
    const icon = mark.querySelector<SVGElement>("[data-verdict-icon]")!
    await expect(
      contrast(getComputedStyle(icon).stroke, backdrop(mark))
    ).toBeGreaterThanOrEqual(3.05)
  }
  for (const status of root.querySelectorAll<HTMLElement>(
    "[data-lineage-status]"
  ))
    await expect(
      contrast(getComputedStyle(status).color, backdrop(status))
    ).toBeGreaterThanOrEqual(4.55)
}

/** "What b71e5aa asks of you", the renewed signal open. */
export const RenewedOpen: Story = {
  play: async ({ canvasElement }) => {
    await settled(canvasElement)
    // The code keeps its syntax colours here as everywhere else: the
    // approved line and both sides of the change under it.
    const detail = canvasElement.querySelector("#lineage-renewed")!
    const keyword = [...detail.querySelectorAll<HTMLElement>("span")].find(
      (span) => span.textContent === "return"
    )
    await expect(keyword).toHaveClass("text-syn-kw")
    const number = [...detail.querySelectorAll<HTMLElement>("span")].find(
      (span) => span.textContent === "0"
    )
    await expect(number).toHaveClass("text-syn-nu")
    for (const token of detail.querySelectorAll<HTMLElement>(
      "[class*='text-syn-']"
    ))
      await expect(
        contrast(getComputedStyle(token).color, backdrop(token))
      ).toBeGreaterThanOrEqual(4.55)
  },
}

/** The renewed signal in the dark theme. */
export const RenewedOpenDark: Story = {
  globals: { theme: "dark" },
  play: RenewedOpen.play,
}

/** The correction that answers your comment, open. */
export const CorrectedOpen: Story = { args: { initialOpen: "corrected" } }

/** Regrouped hunks: earlier approvals stay with the hunks they covered. */
export const RegroupedOpen: Story = { args: { initialOpen: "regrouped" } }

/** Carried forward: no decision needed. */
export const CarriedOpen: Story = { args: { initialOpen: "audit" } }

/** Everything closed; the play opens and closes a row. */
export const AllClosed: Story = {
  args: { initialOpen: null },
  play: async ({ canvas, userEvent }) => {
    const row = canvas.getByRole("button", { name: /Corrected/ })
    await expect(row).toHaveAttribute("aria-expanded", "false")
    await userEvent.click(row)
    await expect(row).toHaveAttribute("aria-expanded", "true")
    await waitFor(() =>
      expect(canvas.getByRole("link", { name: /Open unit/ })).toBeVisible()
    )
    await userEvent.click(row)
    await waitFor(() => expect(row).toHaveAttribute("aria-expanded", "false"))
  },
}

/**
 * Earlier verdicts as the review mark at 16px with words ("You approved",
 * "R2 approved"): the actor's avatar, the icon in the verdict colour, the
 * words in ink. No chip. The mark is not a control inside the row's button,
 * and the row's name says the verdict.
 */
export const VerdictMarks: Story = {
  args: { initialOpen: null },
  play: async ({ canvas, canvasElement, userEvent }) => {
    await settled(canvasElement)
    await expect(verdictWords(canvasElement)).toEqual([
      "You approved",
      "You requested changes",
      "You approved",
      "R2 approved",
      "R1 approved",
      "R1 approved",
    ])
    // No tinted chips, and no "you ✓" shorthand left.
    await expect(canvasElement).not.toHaveTextContent("✓")
    await expect(canvasElement).not.toHaveTextContent("✕")
    const doc = canvasElement.ownerDocument
    const agt = tokenColor(doc, "--nv-agt")
    const req = tokenColor(doc, "--nv-req")
    for (const mark of canvasElement.querySelectorAll<HTMLElement>(
      "[data-review-mark]"
    )) {
      await expect(getComputedStyle(mark).backgroundColor).toBe(
        "rgba(0, 0, 0, 0)"
      )
      const verdict = mark.dataset.verdict
      const icon = mark.querySelector<SVGElement>("[data-verdict-icon]")!
      // Shape: a check for approved, a cross for changes requested.
      await expect(icon.dataset.verdictIcon).toBe(verdict)
      await expect(icon.querySelector("path")!.getAttribute("d")).toBe(
        verdict === "approved" ? "M20 6 9 17l-5-5" : "M18 6 6 18M6 6l12 12"
      )
      // Colour family: agt for approved, req for changes requested.
      await expect(getComputedStyle(icon).stroke).toBe(
        verdict === "approved" ? agt : req
      )
      // The avatar is the actor's own: a person bubble or the agent's.
      await expect(mark.querySelector("[data-avatar]")).not.toBeNull()
    }
    await expect(
      canvasElement.querySelector("[data-review-mark] [data-avatar='person']")!
        .textContent
    ).toBe(REVIEWER.initials)
    await expectInertMarks(canvasElement)
    // The row's accessible name carries the verdict words.
    await expect(
      canvas.getByRole("button", { name: /canOpen guard\s+You approved/ })
    ).toBeInTheDocument()
    await expect(
      canvas.getByRole("button", {
        name: /canOpen checks active only\s+You requested changes/,
      })
    ).toBeInTheDocument()
    await expect(
      canvas.getByRole("button", {
        name: /Session store cleanup\s+R2 approved/,
      })
    ).toBeInTheDocument()
    // Tab moves row to row: focus never lands inside a mark.
    doc.defaultView?.focus()
    const rows = canvas.getAllByRole("button", { expanded: false })
    for (let tabs = 0; tabs < 20; tabs++) {
      await userEvent.tab()
      await expect(doc.activeElement?.closest("[data-review-mark]")).toBeNull()
      if (doc.activeElement === rows.at(-1)) break
    }
    await expect(rows.at(-1)).toHaveFocus()
    await expectVerdictContrast(canvasElement)
  },
}

/** The verdict marks in the dark theme: the same checks, dark tokens. */
export const VerdictMarksDark: Story = {
  ...VerdictMarks,
  globals: { theme: "dark" },
}

/**
 * Carried rows are dimmed by the muted text token, not by opacity, so the
 * verdict keeps its contrast; the open row sits on the raised fill.
 */
export const CarriedContrast: Story = {
  args: { initialOpen: "audit" },
  play: async ({ canvas, canvasElement }) => {
    await settled(canvasElement)
    const carried = canvas.getByRole("button", {
      name: /Audit event for revocation\s+R1 approved/,
    })
    await expect(carried).toHaveAttribute("aria-expanded", "true")
    for (let node: Element | null = carried; node; node = node.parentElement)
      await expect(getComputedStyle(node).opacity).toBe("1")
    // The avatar's own dashed edge is drawn at half opacity by design; every
    // text and the verdict icon are painted at full opacity.
    for (const element of carried.querySelectorAll("*"))
      if (!element.closest("[data-avatar]"))
        await expect(getComputedStyle(element).opacity).toBe("1")
    const muted = tokenColor(canvasElement.ownerDocument, "--nv-muted")
    const words = carried.querySelector<HTMLElement>(
      "[data-review-mark] > span:last-child"
    )!
    await expect(getComputedStyle(words).color).toBe(muted)
    await expectVerdictContrast(canvasElement)
  },
}

export const CarriedContrastDark: Story = {
  ...CarriedContrast,
  globals: { theme: "dark" },
}

/**
 * An earlier unit with no recorded verdict keeps its status words in the
 * rail's muted mono style: no mark, no chip.
 */
export const StatusWithoutVerdict: Story = {
  args: {
    lineage: commitLineageWithPendingFixture,
    initialOpen: "share-email",
  },
  play: async ({ canvas, canvasElement }) => {
    await settled(canvasElement)
    // Open, so the status also sits on the raised fill.
    const row = canvas.getByRole("button", {
      name: /Revoked links in the share email\s+Assessment pending/,
    })
    await expect(row).toHaveAttribute("aria-expanded", "true")
    await expect(row.querySelector("[data-review-mark]")).toBeNull()
    const status = row.querySelector<HTMLElement>("[data-lineage-status]")!
    await expect(status).toHaveTextContent("Assessment pending")
    await expect(status).toHaveClass("font-mono")
    await expect(getComputedStyle(status).backgroundColor).toBe(
      "rgba(0, 0, 0, 0)"
    )
    await expect(getComputedStyle(status).color).toBe(
      tokenColor(canvasElement.ownerDocument, "--nv-muted")
    )
    // Rows with a recorded verdict keep their marks.
    await expect(verdictWords(canvasElement)).toHaveLength(6)
    await expectVerdictContrast(canvasElement)
  },
}

export const StatusWithoutVerdictDark: Story = {
  ...StatusWithoutVerdict,
  globals: { theme: "dark" },
}

/**
 * A registered revision pair (`/changes/<sha>` live, round 3): one divided
 * list per revision with lane glyph, title, the verdict mark ("You
 * approved", "R1 requested changes") or muted status words, and a chevron;
 * no raw lane slugs, no bordered cards. The play opens a row to its hunks
 * and recorded decisions.
 */
export const Registered: Story = {
  args: { lineage: registeredLineageFixture },
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expect(canvasElement).not.toHaveTextContent("human-suggested")
    const words = verdictWords(canvasElement)
    // Another person's decision keeps their name; marks show the recorded
    // decision (a human approve on a suggested unit reads "You approved").
    await expect(words).toContain("maya requested changes")
    await expect(canvasElement).not.toHaveTextContent("You agreed")
    await expect(words.filter((text) => text === "You approved")).toHaveLength(
      2
    )
    // Agents are named from the registry, not as "Agent".
    await expect(words).toContain("R1 requested changes")
    await expect(words.some((text) => text.startsWith("Agent"))).toBe(false)
    // maya is named by id, with initials taken from it.
    const maya = [
      ...canvasElement.querySelectorAll<HTMLElement>("[data-review-mark]"),
    ].find((mark) => mark.textContent.includes("maya"))!
    await expect(
      maya.querySelector("[data-avatar='person']")!.textContent
    ).toBe("MA")
    await expectInertMarks(canvasElement)
    // Relation claims name their author from the structured author.
    await expect(
      canvas.getByText("Authored corrected claim · i1")
    ).toBeInTheDocument()
    await expect(
      canvas.getAllByText("Human-required:", { exact: false }).length
    ).toBeGreaterThan(0)
    const row = canvas.getAllByText(
      "Typed preparation failures and recovery messages"
    )[0]!
    const details = row.closest("details")!
    await userEvent.click(row)
    await expect(details.open).toBe(true)
    await waitFor(() =>
      expect(
        canvas.getByText(/Recovery messages match the typed reasons/)
      ).toBeVisible()
    )
  },
}

const noticeFrame = () => (
  <div className="relative h-[240px] bg-paper font-sans text-sm text-ink">
    <NewCommitNotice event={newCommitFixture} />
  </div>
)

/** The registered pair in the dark theme. */
export const RegisteredDark: Story = {
  args: { lineage: registeredLineageFixture },
  globals: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await settled(canvasElement)
    await expectInertMarks(canvasElement)
    await expectVerdictContrast(canvasElement)
  },
}

/**
 * The new commit observed on the branch before any assessment exists for
 * it (`CommitObservationScreen`): the review stays on its commit.
 */
export const Observed: Story = {
  render: () => (
    <CommitObservationScreen
      load={observedCommitLoadFixture}
      back={{ to: "unit", unitId: REVIEW_UNIT_ID }}
    />
  ),
  play: async ({ canvas, canvasElement }) => {
    await settled(canvasElement)
    await expect(
      canvas.getByRole("heading", {
        level: 1,
        name: "What b71e5aa asks of you",
      })
    ).toBeVisible()
    await expect(
      canvas.getByRole("heading", { name: "Review assessment pending" })
    ).toBeVisible()
    await expect(
      canvas.getByText(/Your current review stays on a3f9c2e/)
    ).toBeVisible()
    await expect(
      canvas.getByRole("link", { name: /Back to a3f9c2e/ })
    ).toBeVisible()
  },
}

/** The branch could not be observed: the review stays pinned. */
export const Unavailable: Story = {
  render: () => (
    <CommitObservationScreen
      load={unavailableCommitLoadFixture}
      back={{ to: "unit", unitId: REVIEW_UNIT_ID }}
    />
  ),
  play: async ({ canvas, canvasElement }) => {
    await settled(canvasElement)
    await expect(
      canvas.getByRole("heading", {
        level: 1,
        name: "Commit information unavailable",
      })
    ).toBeVisible()
    await expect(
      canvas.getByRole("heading", { name: "Observation unavailable" })
    ).toBeVisible()
    await expect(
      canvas.getByText(unavailableCommitLoadFixture.reason)
    ).toBeVisible()
  },
}

export const ObservedDark: Story = { ...Observed, globals: { theme: "dark" } }

export const UnavailableDark: Story = {
  ...Unavailable,
  globals: { theme: "dark" },
}

/** The notice on its own. */
export const Notice: Story = {
  decorators: [withReviewDeskState({ notice: "shown" })],
  render: noticeFrame,
}

/** Parked as the corner pill. */
export const NoticeParked: Story = {
  decorators: [withReviewDeskState({ notice: "parked" })],
  render: noticeFrame,
}
