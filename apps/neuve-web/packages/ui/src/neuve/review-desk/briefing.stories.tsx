import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"

import {
  POLICY_COMMENT_ID,
  goDeliveryPhraseToReviewDeskFixture,
  goDeliveryPlainBriefingDeskFixture,
  reviewDeskFixture,
} from "@workspace/ui/fixtures/review-batch.fixtures"
import { commentMarkerKey } from "@workspace/ui/neuve/review-comments/markers"
import {
  composingAt,
  deskAt,
  deskMeta,
} from "@workspace/ui/neuve/story-kit/desk"
import type { DeskAt } from "@workspace/ui/neuve/story-kit/desk"
import {
  countInDiffs,
  diffRoot,
  engagedLook,
  landed,
  linePinWith,
  lineList,
  lit,
  numberCell,
  openCard,
  pinOf,
  row,
  tint,
} from "@workspace/ui/neuve/story-kit/dom"
import {
  clickAt,
  expectFocusVisible,
  expectNoFocusRing,
  pause,
  tooltipText,
} from "@workspace/ui/neuve/story-kit/play"

/**
 * Briefing descriptive links (round 5, option B with icon-only chips;
 * design/neuve-web/changes/round-5.md). Each phrase that describes part of
 * the change links to it and lands there as a citation chip lands; the
 * chips stay beside the claims they support, showing only their kind icon.
 * The desk renders the Index-writes unit at Briefed, so the diff is there
 * to land in.
 */
const meta = {
  title: "Screens/Review desk/Briefing links",
  ...deskMeta("index-writes", { stop: "briefed" }),
} satisfies Meta<typeof DeskAt>

export default meta
type Story = StoryObj<typeof meta>

const RETRIES =
  /^retries up to three times with growing waits, then returns ErrIndexBusy/
const WAIT = /^The wait ignores cancellation/
const BUSY = /^No test forces the busy path/

/** The briefing's phrase link, by its words. */
function phrase(canvasElement: HTMLElement, name: RegExp) {
  return within(canvasElement).findByRole("link", { name })
}

/**
 * The Index-writes briefing: three phrases link to what they describe, and
 * the Source, Doc and Gap chips show only their icon. The play checks each
 * link's name (its words and where it lands) and each chip's name.
 */
export const PhraseLinks: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(await phrase(canvasElement, RETRIES)).toHaveAccessibleName(
      "retries up to three times with growing waits, then returns ErrIndexBusy (lines 29–36)"
    )
    await expect(await phrase(canvasElement, WAIT)).toHaveAccessibleName(
      "The wait ignores cancellation (line 34)"
    )
    await expect(await phrase(canvasElement, BUSY)).toHaveAccessibleName(
      "No test forces the busy path (Gap, line 29)"
    )
    // The phrase sits in its sentence: the claim reads as one text.
    const claim = (await phrase(canvasElement, RETRIES)).closest("li")!
    await expect(claim.textContent).toContain(
      "It now retries up to three times"
    )
    for (const name of [
      "Source, lines 29–36",
      "Doc, line 34",
      "Gap, line 29",
    ]) {
      const chip = canvas.getByRole("button", { name })
      await expect(chip).toHaveAttribute("data-icon-only")
      await expect(chip.textContent).toBe("")
      await expect(chip.querySelector("svg")).toBeTruthy()
    }
  },
}

export const PhraseLinksDark: Story = {
  ...PhraseLinks,
  globals: { theme: "dark" },
}

/**
 * Clicking a phrase lands on the lines it describes: they scroll in below
 * the sticky file header and take the landing tint, which holds then fades.
 * The browser does not navigate (the hash stays).
 */
export const PhraseLands: Story = {
  play: async ({ canvasElement }) => {
    const root = await diffRoot(canvasElement)
    const hash = window.location.hash
    await userEvent.click(await phrase(canvasElement, RETRIES))
    await waitFor(
      () => {
        expect(landed(root, 29)).toMatch(/^[ab]$/)
        expect(landed(root, 36)).toMatch(/^[ab]$/)
      },
      { timeout: 4000, interval: 30 }
    )
    await expect(landed(root, 37)).toBeNull()
    await expect(window.location.hash).toBe(hash)
    // Not a static tint: it fades out (275ms hold + 825ms fade).
    await waitFor(() => expect(landed(root, 29)).toBeNull(), {
      timeout: 3000,
    })
  },
}

/**
 * Keyboard: Tab reaches a phrase (the focus ring shows and its line lights)
 * and Enter follows it, landing on line 34.
 */
export const PhraseKeyboard: Story = {
  play: async ({ canvasElement }) => {
    const root = await diffRoot(canvasElement)
    const retries = await phrase(canvasElement, RETRIES)
    const wait = await phrase(canvasElement, WAIT)
    retries.focus()
    // The Source chip, then the wait phrase.
    await userEvent.tab()
    await userEvent.tab()
    await expectFocusVisible(wait)
    await waitFor(() => expect(lit(root, 34)).toBe(true))
    await expect(lit(root, 33)).toBe(false)
    await userEvent.keyboard("{Enter}")
    await waitFor(() => expect(landed(root, 34)).toMatch(/^[ab]$/), {
      timeout: 4000,
      interval: 30,
    })
    await expect(landed(root, 35)).toBeNull()
  },
}

/**
 * Real hover on a phrase lights the lines it describes, as a marker pin
 * does, and leaving puts them out. The Gap phrase lights its marker's line.
 */
export const PhraseHoverLights: Story = {
  play: async ({ canvasElement }) => {
    const root = await diffRoot(canvasElement)
    const retries = await phrase(canvasElement, RETRIES)
    await userEvent.hover(retries)
    await waitFor(() => {
      expect(lit(root, 29)).toBe(true)
      expect(lit(root, 36)).toBe(true)
    })
    await expect(lit(root, 37)).toBe(false)
    await userEvent.unhover(retries)
    await waitFor(() => expect(lit(root, 29)).toBe(false))
    const busy = await phrase(canvasElement, BUSY)
    await userEvent.hover(busy)
    await waitFor(() => expect(lit(root, 29)).toBe(true))
    await expect(lit(root, 30)).toBe(false)
    await userEvent.unhover(busy)
    await waitFor(() => expect(lit(root, 29)).toBe(false))
  },
}

/**
 * Icon-only chips: the name says the kind and the target, the tooltip on
 * hover or keyboard focus says the same text, and activating the chip still
 * lands and opens its card.
 */
export const IconOnlyChips: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const doc = canvasElement.ownerDocument
    const root = await diffRoot(canvasElement)
    const source = canvas.getByRole("button", { name: "Source, lines 29–36" })
    await userEvent.hover(source)
    await expect(await tooltipText(doc)).toBe(source.getAttribute("aria-label"))
    // The tooltip is not also a description: the name is said once.
    await expect(source).not.toHaveAttribute("aria-describedby")
    await expect(source).toHaveAccessibleDescription("")
    await userEvent.unhover(source)
    // Keyboard focus: the Doc chip, reached with Tab from the wait phrase.
    ;(await phrase(canvasElement, WAIT)).focus()
    await userEvent.tab()
    const doc34 = canvas.getByRole("button", { name: "Doc, line 34" })
    await expect(doc34).toHaveFocus()
    await expect(await tooltipText(doc)).toBe("Doc, line 34")
    await expect(doc34).not.toHaveAttribute("aria-describedby")
    await userEvent.keyboard("{Escape}")
    await userEvent.click(source)
    await waitFor(() => expect(landed(root, 29)).toMatch(/^[ab]$/), {
      timeout: 4000,
      interval: 30,
    })
  },
}

/**
 * Reduced motion (the toolbar): the jump is instant and the tint stays,
 * without a fade, until the reader's next key or pointer press.
 */
export const PhraseReducedMotion: Story = {
  globals: { reducedMotion: "reduce" },
  play: async ({ canvasElement }) => {
    const root = await diffRoot(canvasElement)
    await userEvent.click(await phrase(canvasElement, WAIT))
    await waitFor(() => expect(landed(root, 34)).toBe("static"), {
      timeout: 2000,
    })
    // Longer than the full fade (275 + 825ms): still there.
    await pause(1400)
    await expect(landed(root, 34)).toBe("static")
    await userEvent.keyboard("{Shift}")
    await waitFor(() => expect(landed(root, 34)).toBeNull())
  },
}

/**
 * A phrase that describes the recorded review leads to the review card:
 * the review line tints and focus lands on the review mark.
 */
export const PhraseToReview: Story = {
  args: { data: goDeliveryPhraseToReviewDeskFixture },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await phrase(canvasElement, /^The reviewer agent approved it/)
    )
    const line = canvasElement.querySelector("[data-review-line]")
    await waitFor(() => expect(line).toHaveAttribute("data-arrived"), {
      timeout: 3000,
    })
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: "R1, reviewer agent" })
      ).toHaveFocus()
    )
  },
}

/** A briefing with no phrase links and no chips still renders as text. */
export const PlainBriefing: Story = {
  args: { data: goDeliveryPlainBriefingDeskFixture },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const text = await canvas.findByText(/It now retries up to three times/)
    // The desk's entrance fades it in.
    await waitFor(() => expect(text).toBeVisible(), { timeout: 3000 })
    await expect(canvasElement.querySelector("[data-phrase-link]")).toBeNull()
  },
}

/**
 * Live briefings read one claim per line (the merged briefing, approved
 * 25 October 2026): each sentence is its own claim, and its phrases and
 * chips stay inside it, never a row per phrase.
 */
export const ClaimPerLine: Story = {
  play: async ({ canvasElement }) => {
    const links = await Promise.all(
      [RETRIES, WAIT, BUSY].map((name) => phrase(canvasElement, name))
    )
    const claims = links.map((link) => link.closest("li")!)
    await expect(new Set(claims).size).toBe(3)
    await expect(claims[0]!.textContent).toMatch(
      /^It now retries up to three times/
    )
    const list = claims[0]!.parentElement!
    await expect(list.querySelectorAll(":scope > li")).toHaveLength(4)
    await expect(list.firstElementChild!.textContent).toBe(
      "Commit used to fail on the first lock clash."
    )
  },
}

/**
 * The Revoke briefing (Main, canvas parity): its phrases link to lines 22–23
 * and to the Conflict, Gap and Same batch markers, and its icon-only chips
 * are named, and tooltipped, by kind and target.
 */
export const MainPhraseLinks: Story = {
  args: deskAt("revoke"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const doc = canvasElement.ownerDocument
    for (const [name, target] of [
      ["bumps its version and ends open sessions", "lines 22–23"],
      ["a May decision kept sessions alive", "Conflict, line 23"],
      ["The only test checks the 204", "Gap, line 24"],
      ["the session helper", "Same batch, line 23"],
    ] as const) {
      const link = await canvas.findByRole("link", {
        name: `${name} (${target})`,
      })
      // The desk's entrance fades it in.
      await waitFor(() => expect(link).toBeVisible(), { timeout: 3000 })
    }
    const chips = canvasElement.querySelectorAll<HTMLElement>(
      "button[data-icon-only]"
    )
    await expect(
      [...chips].map((chip) => chip.getAttribute("aria-label"))
    ).toEqual(["Conflict, line 23", "Gap, line 24", "Same batch, line 23"])
    // Each chip keeps the punctuation after it on its line, as on the board.
    for (const [i, punctuation] of [".", ",", "."].entries()) {
      const glue = chips[i]!.closest<HTMLElement>("[data-chip-glue]")
      await expect(glue?.textContent).toBe(punctuation)
      await expect(getComputedStyle(glue!).whiteSpace).toBe("nowrap")
    }
    for (const chip of chips) {
      await userEvent.hover(chip)
      await expect(await tooltipText(doc)).toBe(chip.getAttribute("aria-label"))
      await expect(chip).not.toHaveAttribute("aria-describedby")
      await userEvent.unhover(chip)
    }
    // The lines phrase lands on 22–23 and leaves no card open.
    const root = await diffRoot(canvasElement)
    await userEvent.click(
      canvas.getByRole("link", { name: /^bumps its version/ })
    )
    await waitFor(
      () => {
        expect(landed(root, 22)).toMatch(/^[ab]$/)
        expect(landed(root, 23)).toMatch(/^[ab]$/)
      },
      { timeout: 4000, interval: 30 }
    )
    await expect(landed(root, 24)).toBeNull()
    await expect(openCard(canvasElement)).toBeNull()
  },
}

/* ── Round 5b: one treatment for phrases, chips and pins ───────────────
 * Hover or keyboard focus lights the lines; activating lands (the tint
 * holds, then fades) and a marker also opens its card; the open state is
 * the same whichever entry point opened it.
 */

/** The open card's state: which lines hold the open tint, which card. */
function openState(canvasElement: HTMLElement, root: ShadowRoot) {
  return {
    strong: [
      ...root.querySelectorAll("[data-content] [data-overlay-range='strong']"),
    ]
      .map((el) => `${el.getAttribute("data-line")}`)
      .join(","),
    strongTint: (() => {
      const strong = root.querySelector<HTMLElement>(
        "[data-content] [data-line][data-overlay-range='strong']"
      )
      return strong ? getComputedStyle(strong).boxShadow : ""
    })(),
    card: openCard(canvasElement)?.getAttribute("aria-label"),
    landed: root.querySelectorAll("[data-overlay-land]").length,
  }
}

/**
 * A briefing chip lights its cited lines on real hover, with the same tint
 * a phrase gives; leaving puts them out.
 */
export const ChipHoverLights: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const root = await diffRoot(canvasElement)
    const retries = await phrase(canvasElement, RETRIES)
    await waitFor(() => expect(retries).toBeVisible(), { timeout: 3000 })
    await userEvent.hover(retries)
    await waitFor(() => expect(lit(root, 30)).toBe(true))
    const phraseTint = tint(root, 30)
    await userEvent.unhover(retries)
    await waitFor(() => expect(lit(root, 30)).toBe(false))
    const source = canvas.getByRole("button", { name: "Source, lines 29–36" })
    await userEvent.hover(source)
    await waitFor(() => {
      expect(lit(root, 29)).toBe(true)
      expect(lit(root, 36)).toBe(true)
    })
    await expect(lit(root, 37)).toBe(false)
    await expect(tint(root, 30)).toBe(phraseTint)
    await userEvent.unhover(source)
    await waitFor(() => expect(lit(root, 29)).toBe(false))
    // Keyboard focus lights too: Tab from the wait phrase to the Doc chip.
    ;(await phrase(canvasElement, WAIT)).focus()
    await userEvent.tab()
    await waitFor(() => expect(lit(root, 34)).toBe(true))
    await expect(lit(root, 33)).toBe(false)
  },
}

/**
 * A margin pin opening its card lands on its lines, as a chip does: the
 * tint holds, then fades, without scrolling lines already in view. The
 * open state then equals the one a chip click leaves.
 */
export const PinLands: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const root = await diffRoot(canvasElement)
    const pin = pinOf(canvasElement, "go-doc")
    // Line 34 in the middle of the view: a landing that scrolled would bring
    // it to the top. (Near the bottom, the card's own focus on opening may
    // scroll the desk to keep its close button in view; that is not the
    // landing.)
    row(root, 34)!.scrollIntoView({ block: "center" })
    await pause(300)
    const top = row(root, 34)!.getBoundingClientRect().top
    await userEvent.click(pin)
    await waitFor(() => expect(landed(root, 34)).toMatch(/^[ab]$/), {
      timeout: 3000,
      interval: 30,
    })
    await expect(landed(root, 33)).toBeNull()
    await expect(
      Math.abs(row(root, 34)!.getBoundingClientRect().top - top)
    ).toBeLessThanOrEqual(1)
    await waitFor(() => expect(landed(root, 34)).toBeNull(), {
      timeout: 3000,
    })
    const fromPin = openState(canvasElement, root)
    await expect(fromPin.card).toBeTruthy()
    await expect(fromPin.strong).toContain("34")
    // Closing plays nothing.
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(openCard(canvasElement)).toBeNull())
    await pause(200)
    await expect(root.querySelector("[data-overlay-land]")).toBeNull()
    // The chip leaves the same open state.
    await userEvent.click(canvas.getByRole("button", { name: "Doc, line 34" }))
    await waitFor(() => expect(landed(root, 34)).toMatch(/^[ab]$/), {
      timeout: 3000,
      interval: 30,
    })
    await waitFor(() => expect(landed(root, 34)).toBeNull(), {
      timeout: 3000,
    })
    await expect(openState(canvasElement, root)).toEqual(fromPin)
  },
}

/**
 * A line with several markers opens its list first; choosing one opens its
 * card and lands on its lines.
 */
export const PinListLands: Story = {
  play: async ({ canvasElement }) => {
    const root = await diffRoot(canvasElement)
    const pin = pinOf(canvasElement, "go-gap")
    pin.scrollIntoView({ block: "center" })
    await userEvent.click(pin)
    const list = await within(canvasElement.ownerDocument.body).findByRole(
      "group",
      { name: "2 markers on line 29" }
    )
    // The Source marker's row: its card is about lines 29–36.
    const source = within(list)
      .getAllByRole("button")
      .find((button) => button.textContent.includes("Source"))!
    await userEvent.click(source)
    await waitFor(
      () => {
        expect(landed(root, 29)).toMatch(/^[ab]$/)
        expect(landed(root, 36)).toMatch(/^[ab]$/)
      },
      { timeout: 3000, interval: 30 }
    )
  },
}

/** Reduced motion: the pin's landing is static until the next key press. */
export const PinLandsReducedMotion: Story = {
  globals: { reducedMotion: "reduce" },
  play: async ({ canvasElement }) => {
    const root = await diffRoot(canvasElement)
    const pin = pinOf(canvasElement, "go-doc")
    pin.scrollIntoView({ block: "center" })
    await userEvent.click(pin)
    await waitFor(() => expect(landed(root, 34)).toBe("static"), {
      timeout: 2000,
    })
    await pause(1400)
    await expect(landed(root, 34)).toBe("static")
    await userEvent.keyboard("{Shift}")
    await waitFor(() => expect(landed(root, 34)).toBeNull())
  },
}

/**
 * With a card open, a click on a briefing phrase closes the card and lands
 * in the same click (B); a click on the diff only closes the card.
 */
export const ClickThroughWithCardOpen: Story = {
  play: async ({ canvasElement }) => {
    const doc = canvasElement.ownerDocument
    const root = await diffRoot(canvasElement)
    const retries = await phrase(canvasElement, RETRIES)
    await waitFor(() => expect(retries).toBeVisible(), { timeout: 3000 })
    const openDocCard = async () => {
      const pin = pinOf(canvasElement, "go-doc")
      await userEvent.click(pin)
      await waitFor(() => expect(openCard(doc)).toBeTruthy())
      // The pin's own landing plays out first.
      await waitFor(() => expect(landed(root, 34)).toMatch(/^[ab]$/), {
        timeout: 3000,
        interval: 30,
      })
      await waitFor(() => expect(landed(root, 34)).toBeNull(), {
        timeout: 3000,
      })
    }
    await openDocCard()
    // The phrase is outside the card: the press closes it and the click
    // follows the phrase.
    // (Opening the card may have scrolled the phrase away on a short canvas.)
    retries.scrollIntoView({ block: "center" })
    await clickAt(retries)
    await waitFor(() => expect(openCard(doc)).toBeNull())
    await waitFor(
      () => {
        expect(landed(root, 29)).toMatch(/^[ab]$/)
        expect(landed(root, 36)).toMatch(/^[ab]$/)
      },
      { timeout: 4000, interval: 30 }
    )
    await waitFor(() => expect(landed(root, 29)).toBeNull(), { timeout: 3000 })
    // A click on the diff only closes the card: nothing lands or opens.
    pinOf(canvasElement, "go-doc").scrollIntoView({ block: "center" })
    await openDocCard()
    // Line 34's number: it would select the line if the press reached it.
    await clickAt(
      root.querySelector<HTMLElement>(
        '[data-column-number="34"][data-line-type="change-addition"]'
      )!
    )
    await waitFor(() => expect(openCard(doc)).toBeNull())
    await pause(400)
    await expect(root.querySelector("[data-overlay-land]")).toBeNull()
    await expect(openCard(doc)).toBeNull()
    await expect(root.querySelector("[data-selected-line]")).toBeNull()
    // Anything else outside only closes too: the file's Viewed checkbox
    // under the press stays as it was.
    const viewed = within(canvasElement).getByRole("button", {
      name: /Viewed/,
    })
    const pressed = viewed.getAttribute("aria-pressed")
    await openDocCard()
    await clickAt(viewed)
    await waitFor(() => expect(openCard(doc)).toBeNull())
    await pause(200)
    await expect(viewed.getAttribute("aria-pressed")).toBe(pressed)
  },
}

/**
 * With a card open, hover still reaches the briefing: a phrase lights its
 * lines in place of the open tint, which returns when the phrase is left.
 */
export const HoverWithCardOpen: Story = {
  play: async ({ canvasElement }) => {
    const doc = canvasElement.ownerDocument
    const root = await diffRoot(canvasElement)
    const retries = await phrase(canvasElement, RETRIES)
    await waitFor(() => expect(retries).toBeVisible(), { timeout: 3000 })
    await userEvent.click(pinOf(canvasElement, "go-doc"))
    await waitFor(() => expect(openCard(doc)).toBeTruthy())
    await waitFor(() =>
      expect(row(root, 34)?.getAttribute("data-overlay-range")).toBe("strong")
    )
    retries.scrollIntoView({ block: "center" })
    await userEvent.hover(retries)
    await waitFor(() => {
      expect(lit(root, 29)).toBe(true)
      expect(lit(root, 36)).toBe(true)
    })
    await expect(openCard(doc)).toBeTruthy()
    await userEvent.unhover(retries)
    await waitFor(() =>
      expect(row(root, 34)?.getAttribute("data-overlay-range")).toBe("strong")
    )
  },
}

/**
 * A review comment's pin lights its lines on hover (the margin's hint) and
 * opens its thread on click without a landing.
 */
export const CommentPinNoLanding: Story = {
  args: deskAt("revoke", { comments: "seeded" }),
  play: async ({ canvasElement }) => {
    const doc = canvasElement.ownerDocument
    const pin = await waitFor(() => {
      const found = canvasElement.querySelector<HTMLElement>(
        `button[data-marker-key="${commentMarkerKey(POLICY_COMMENT_ID)}"]`
      )
      expect(found).toBeVisible()
      return found!
    })
    pin.scrollIntoView({ block: "center" })
    const count = (selector: string) => countInDiffs(canvasElement, selector)
    await userEvent.hover(pin)
    await waitFor(() =>
      expect(
        count("[data-content] [data-overlay-range='hint']")
      ).toBeGreaterThan(0)
    )
    await userEvent.click(pin)
    // Watched through a full landing's length (hold + fade): none comes.
    let landings = 0
    for (let frame = 0; frame < 40; frame++) {
      landings += count("[data-overlay-land]")
      await pause(30)
    }
    await expect(doc.querySelector("[data-thread-card]")).toBeTruthy()
    await expect(landings).toBe(0)
  },
}

/**
 * While composing, the file being commented on stays live: a press on a
 * line number there (inside the diff's shadow root) keeps the composer and
 * re-targets it, rather than closing it as an outside press.
 */
export const GutterPressWhileComposing: Story = {
  args: deskAt("revoke", {
    state: composingAt(reviewDeskFixture.files[0]!.path, 21, 23),
  }),
  play: async ({ canvasElement }) => {
    const doc = canvasElement.ownerDocument
    const composer = () =>
      doc.querySelector<HTMLElement>('[role="dialog"][aria-label*="line"]')
    await waitFor(() =>
      expect(composer()?.getAttribute("aria-label")).toContain("lines 21–23")
    )
    const root = await diffRoot(canvasElement)
    await userEvent.click(numberCell(root, 24)!)
    await waitFor(() =>
      expect(composer()?.getAttribute("aria-label")).toContain("line 24")
    )
  },
}

/**
 * Touch closes on the tap, not the press: a touch that starts a scroll over
 * the desk leaves the card open; the tap that ends on the title closes it.
 */
export const TouchTapCloses: Story = {
  play: async ({ canvasElement }) => {
    const doc = canvasElement.ownerDocument
    await diffRoot(canvasElement)
    await userEvent.click(pinOf(canvasElement, "go-doc"))
    await waitFor(() => expect(openCard(doc)).toBeTruthy())
    const title = within(canvasElement).getByRole("heading", { level: 1 })
    const user = userEvent.setup()
    await user.pointer({ keys: "[TouchA>]", target: title })
    await pause(200)
    await expect(openCard(doc)).toBeTruthy()
    await user.pointer({ keys: "[/TouchA]", target: title })
    await waitFor(() => expect(openCard(doc)).toBeNull())
  },
}

/* ── Round 5c: an engaged pin always shows its lines ──────────────────
 * While a marker's list is pinned open or its card is open, its lines keep
 * the hover tint with an outline around the range, and the number cells
 * keep the stronger open tint, until the list or card closes.
 */

/** The ring is drawn in the engaged-ring token, over the hover tint. */
async function expectOutlined(root: ShadowRoot, line: number) {
  const code = row(root, line)!
  await expect(code.hasAttribute("data-overlay-engaged")).toBe(true)
  const shadow = getComputedStyle(code).boxShadow
  const ring = getComputedStyle(code)
    .getPropertyValue("--diffs-overlay-engaged-ring")
    .trim()
  await expect(ring).not.toBe("")
  // An inset ring (2px) and the full-row hover tint.
  await expect(shadow).toMatch(/inset/)
  await expect(shadow).toMatch(/2px/)
  await expect(shadow).toMatch(/1440px|100vmax|\d{3,}px/)
}

/**
 * A line with two markers, its list pinned open by a click: line 23 keeps
 * its tint and outline after the pointer leaves the pin.
 */
export const EngagedListPinned: Story = {
  args: deskAt("revoke"),
  play: async ({ canvasElement }) => {
    const root = await diffRoot(canvasElement)
    const pin = linePinWith(canvasElement, "conflict")
    pin.scrollIntoView({ block: "center" })
    await userEvent.click(pin)
    await userEvent.unhover(pin)
    await waitFor(() => expect(lineList(canvasElement)).toBeTruthy())
    await pause(300)
    await expectOutlined(root, 23)
    await expect(engagedLook(root).cells).toBe("#23:only,23:only")
    await expect(engagedLook(root).number).toMatch(/inset/)
    await userEvent.keyboard("{Escape}")
    await waitFor(() =>
      expect(root.querySelector("[data-overlay-engaged]")).toBeNull()
    )
  },
}

/**
 * A single marker's card open from its pin: its line is engaged, the card
 * names the line for assistive tech, and the chip leaves the same look.
 * Escape clears it.
 */
export const EngagedCardSameFromChip: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const doc = canvasElement.ownerDocument
    const root = await diffRoot(canvasElement)
    row(root, 34)!.scrollIntoView({ block: "center" })
    await userEvent.click(pinOf(canvasElement, "go-doc"))
    await waitFor(() => expect(landed(root, 34)).toMatch(/^[ab]$/), {
      timeout: 3000,
      interval: 30,
    })
    await waitFor(() => expect(landed(root, 34)).toBeNull(), {
      timeout: 3000,
    })
    await expectOutlined(root, 34)
    const card = doc.querySelector<HTMLElement>("[data-floating-card]")!
    await expect(card).toHaveAccessibleDescription("About line 34")
    const fromPin = engagedLook(root)
    await userEvent.keyboard("{Escape}")
    await waitFor(() =>
      expect(root.querySelector("[data-overlay-engaged]")).toBeNull()
    )
    await userEvent.click(canvas.getByRole("button", { name: "Doc, line 34" }))
    await waitFor(() => expect(landed(root, 34)).toMatch(/^[ab]$/), {
      timeout: 3000,
      interval: 30,
    })
    await waitFor(() => expect(landed(root, 34)).toBeNull(), {
      timeout: 3000,
    })
    await expect(engagedLook(root)).toEqual(fromPin)
  },
}

/**
 * With a card open, a hovered phrase lights its own lines while the
 * engaged line keeps its outline.
 */
export const EngagedUnderHoveredPhrase: Story = {
  play: async ({ canvasElement }) => {
    const root = await diffRoot(canvasElement)
    const retries = await phrase(canvasElement, RETRIES)
    await waitFor(() => expect(retries).toBeVisible(), { timeout: 3000 })
    await userEvent.click(pinOf(canvasElement, "go-doc"))
    await waitFor(() => expectOutlined(root, 34))
    retries.scrollIntoView({ block: "center" })
    await userEvent.hover(retries)
    await waitFor(() => {
      expect(lit(root, 29)).toBe(true)
      expect(lit(root, 36)).toBe(true)
    })
    await expectOutlined(root, 34)
    await expect(row(root, 30)?.hasAttribute("data-overlay-engaged")).toBe(
      false
    )
  },
}

/**
 * Reduced motion: the engaged look takes over at once, with no transition
 * (with full motion one fade on the diff's code root eases it in).
 */
export const EngagedReducedMotion: Story = {
  globals: { reducedMotion: "reduce" },
  play: async ({ canvasElement }) => {
    const root = await diffRoot(canvasElement)
    row(root, 34)!.scrollIntoView({ block: "center" })
    await userEvent.click(pinOf(canvasElement, "go-doc"))
    await waitFor(() => expectOutlined(root, 34))
    const style = getComputedStyle(row(root, 34)!)
    for (const duration of style.transitionDuration.split(","))
      await expect(parseFloat(duration)).toBe(0)
  },
}

/**
 * A landing on engaged lines keeps the outline throughout and fades back to
 * the engaged tint, not to nothing: no dip, then no pop.
 */
export const EngagedLandingKeepsOutline: Story = {
  play: async ({ canvasElement }) => {
    const root = await diffRoot(canvasElement)
    row(root, 34)!.scrollIntoView({ block: "center" })
    await userEvent.click(pinOf(canvasElement, "go-doc"))
    // Sampled through the hold and the fade: the ring is always drawn.
    const samples: Array<string> = []
    await waitFor(() => expect(landed(root, 34)).toMatch(/^[ab]$/), {
      timeout: 3000,
      interval: 20,
    })
    while (landed(root, 34)) {
      samples.push(getComputedStyle(row(root, 34)!).boxShadow)
      await pause(60)
    }
    await expect(samples.length).toBeGreaterThan(5)
    // The ring's colour is mixed by the outline's fade, so it computes as
    // rgb() or color(srgb …).
    const ring = /(?:rgb|color)\([^)]*\) 0px 0px 0px 2px inset/
    for (const shadow of samples) await expect(shadow).toMatch(ring)
    // It ends on the engaged look itself: the outline over the hover tint,
    // with the landing's layer (painted under it) gone.
    await expectOutlined(root, 34)
    await expect(getComputedStyle(row(root, 34)!).backgroundImage).toBe("none")
  },
}

/**
 * The composer's selected range is outlined the same way at 1px (quieter
 * than an engaged marker's 2px), first to last line, over the selection.
 */
export const ComposerRangeOutlined: Story = {
  args: deskAt("revoke", {
    state: composingAt(reviewDeskFixture.files[0]!.path, 21, 23),
  }),
  play: async ({ canvasElement }) => {
    const root = await diffRoot(canvasElement)
    await waitFor(() =>
      expect(row(root, 21)?.getAttribute("data-overlay-engaged")).toBe("first")
    )
    await expect(row(root, 22)?.getAttribute("data-overlay-engaged")).toBe(
      "mid"
    )
    await expect(row(root, 23)?.getAttribute("data-overlay-engaged")).toBe(
      "last"
    )
    await expect(row(root, 24)?.hasAttribute("data-overlay-engaged")).toBe(
      false
    )
    for (const line of [21, 22, 23]) {
      const shadow = getComputedStyle(row(root, line)!).boxShadow
      // The side edges, 1px (offset-x 1px; computed with a 0px spread).
      await expect(shadow).toMatch(/ 1px 0px 0px 0px inset/)
      await expect(shadow).not.toMatch(/ 2px 0px 0px 0px inset/)
    }
  },
}

/**
 * Re-targeting the composer by dragging in the gutter: sampled every frame
 * of the drag, no row ever shows the 2px marker outline; the composer's
 * range keeps its 1px outline throughout.
 */
export const ComposerDragNeverEngaged: Story = {
  args: ComposerRangeOutlined.args,
  play: async ({ canvasElement }) => {
    const doc = canvasElement.ownerDocument
    const root = await diffRoot(canvasElement)
    await waitFor(() =>
      expect(row(root, 21)?.getAttribute("data-overlay-engaged")).toBe("first")
    )
    const cell = (line: number) => numberCell(root, line)!
    const at = (element: HTMLElement) => {
      const box = element.getBoundingClientRect()
      return {
        clientX: box.left + box.width / 2,
        clientY: box.top + box.height / 2,
      }
    }
    const send = (target: EventTarget, type: string, element: HTMLElement) =>
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 1,
          pointerType: "mouse",
          button: 0,
          buttons: type === "pointerup" ? 0 : 1,
          ...at(element),
        })
      )
    // A 2px side edge anywhere in the code column is the marker outline.
    const wide: Array<string> = []
    let sampling = true
    const sample = () => {
      for (const el of root.querySelectorAll<HTMLElement>(
        "[data-content] [data-line][data-overlay-engaged]"
      ))
        if (/ 2px 0px 0px 0px inset/.test(getComputedStyle(el).boxShadow))
          wide.push(el.getAttribute("data-line") ?? "?")
      if (sampling) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
    send(cell(24), "pointerdown", cell(24))
    for (const line of [25, 24, 23, 22]) {
      await pause(40)
      send(doc, "pointermove", cell(line))
    }
    await pause(40)
    send(doc, "pointerup", cell(22))
    await pause(300)
    sampling = false
    await expect(wide).toEqual([])
    // The composer moved with the drag, still outlined at 1px.
    await waitFor(() =>
      expect(
        doc
          .querySelector('[role="dialog"][aria-label*="line"]')
          ?.getAttribute("aria-label")
      ).toContain("22–24")
    )
  },
}

/* ── Pinned list: its own pin, focus on open, another pin ──────────── */

const conflictPin = (canvasElement: HTMLElement) =>
  linePinWith(canvasElement, "conflict")

/** Pressing the pinned list's own pin closes it, and it stays closed. */
export const PinnedListOwnPinCloses: Story = {
  args: deskAt("revoke"),
  play: async ({ canvasElement }) => {
    await diffRoot(canvasElement)
    const pin = conflictPin(canvasElement)
    pin.scrollIntoView({ block: "center" })
    await userEvent.click(pin)
    await waitFor(() => expect(lineList(canvasElement)).toBeTruthy())
    await userEvent.click(pin)
    await waitFor(() => expect(lineList(canvasElement)).toBeNull())
    await pause(400)
    await expect(lineList(canvasElement)).toBeNull()
    await expect(pin).toHaveAttribute("aria-expanded", "false")
  },
}

/**
 * Opened by a pointer, the list takes focus on its first row without a
 * focus ring (the ring is for the keyboard).
 */
export const PinnedListPointerNoRing: Story = {
  args: deskAt("revoke"),
  play: async ({ canvasElement }) => {
    await diffRoot(canvasElement)
    const pin = conflictPin(canvasElement)
    pin.scrollIntoView({ block: "center" })
    await userEvent.click(pin)
    const first = await waitFor(() => {
      const firstRow = lineList(canvasElement)?.querySelector("button")
      expect(firstRow).toHaveFocus()
      return firstRow!
    })
    await expectNoFocusRing(first)
  },
}

/** Opened from the keyboard (Enter on the pin), the first row shows its ring. */
export const PinnedListKeyboardRing: Story = {
  args: deskAt("revoke"),
  play: async ({ canvasElement }) => {
    await diffRoot(canvasElement)
    const pin = conflictPin(canvasElement)
    pin.scrollIntoView({ block: "center" })
    pin.focus()
    await userEvent.keyboard("{Enter}")
    const first = await waitFor(() => {
      const firstRow = lineList(canvasElement)?.querySelector("button")
      expect(firstRow).toHaveFocus()
      return firstRow!
    })
    await expectFocusVisible(first)
  },
}

/**
 * With a list pinned, one press on another pin closes the list and opens
 * that pin's card.
 */
export const PinnedListOtherPinOpensCard: Story = {
  args: deskAt("revoke"),
  play: async ({ canvasElement }) => {
    const doc = canvasElement.ownerDocument
    await diffRoot(canvasElement)
    const pin = conflictPin(canvasElement)
    pin.scrollIntoView({ block: "center" })
    await userEvent.click(pin)
    await waitFor(() => expect(lineList(canvasElement)).toBeTruthy())
    const graph = pinOf(canvasElement, "graph")
    await userEvent.click(graph)
    await waitFor(() => {
      expect(lineList(canvasElement)).toBeNull()
      expect(
        doc.querySelector(
          '[data-floating-card][aria-label="Blast radius of link.version"]'
        )
      ).toBeTruthy()
    })
    await expect(graph).toHaveAttribute("aria-expanded", "true")
  },
}
