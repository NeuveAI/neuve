import type { Decorator, Meta, StoryObj } from "@storybook/react-vite"
import { createStore } from "jotai"
import { useMemo } from "react"
import type * as React from "react"
import { expect, userEvent, within } from "storybook/test"

import {
  CODE_DIGEST_LIMITATION,
  DIGEST_GAP_NOTE,
  MODEL_DIGEST_OBLIGATIONS,
  WRAPPING_DIGEST_LINKS,
  digestGapOverviewFixture,
  generatedDigestOverviewFixture,
  missingProofOverviewFixture,
  modelDigestOverviewFixture,
  wrappingLinksOverviewFixture,
} from "@workspace/ui/fixtures/redesigned-overview.fixtures"
import { REDESIGNED_UNITS } from "@workspace/ui/fixtures/redesigned-desk.fixtures"
import { BatchOverviewScreen } from "@workspace/ui/neuve/batch-overview/batch-overview-screen"
import { BatchArrivalsStore } from "@workspace/ui/neuve/shared/batch-arrivals"
import { visible } from "@workspace/ui/neuve/story-kit/play"

/** Each story's own arrivals store, as on the other overview stories. */
function OwnArrivals({ children }: { children: React.ReactNode }) {
  const store = useMemo(() => createStore(), [])
  return <BatchArrivalsStore store={store}>{children}</BatchArrivalsStore>
}
const ownArrivals: Decorator = (Story) => (
  <OwnArrivals>
    <Story />
  </OwnArrivals>
)

/**
 * The batch overview on a redesigned review, built like the owner's batch:
 * the digest the briefing step writes, code's digest for the generated
 * batch, and code's digest when the briefing's digest failed. Every
 * story's data is in `fixtures/redesigned-overview.fixtures.ts`.
 */
const meta = {
  title: "Screens/Batch overview/Redesigned review",
  component: BatchOverviewScreen,
  decorators: [ownArrivals],
  args: { data: modelDigestOverviewFixture },
} satisfies Meta<typeof BatchOverviewScreen>

export default meta
type Story = StoryObj<typeof meta>

/**
 * The model's digest: its phrases open the units they name; under "What
 * to check", code's verification, then each ticket item across the units,
 * each unit a link under its own status. Nothing says who wrote it.
 */
export const ModelDigest: Story = {
  play: async ({ canvas }) => {
    const changed = canvas.getByRole("region", { name: "What changed" })
    await visible(changed)
    const { CHECKOUT, LOCATE, PROBE } = REDESIGNED_UNITS
    await expect(
      within(changed).getByRole("link", { name: "Checkouts of one folder" })
    ).toHaveAttribute("href", expect.stringContaining(CHECKOUT.id))
    await expect(
      within(changed).getByRole("link", { name: "locating a folder's store" })
    ).toHaveAttribute("href", expect.stringContaining(LOCATE.id))
    const check = canvas.getByRole("region", { name: "What to check" })
    await visible(check)
    await expect(check).toHaveTextContent("Of 5 checkpoints, 1 has thin proof")
    for (const obligation of MODEL_DIGEST_OBLIGATIONS)
      await expect(within(check).getByText(obligation.text)).toBeVisible()
    await expect(check).toHaveTextContent("· Done on 2 of 3 units")
    await expect(check).toHaveTextContent("· Not done")
    await expect(check).toHaveTextContent("Not required: package.json")
    // A unit is a link to its desk, under each item it rests on. Its title
    // shows no lane; the digest names none, so its name keeps the lane words.
    const probe = within(check).getAllByRole("link", {
      name: `${PROBE.title} (human required)`,
    })
    await expect(probe).toHaveLength(2)
    for (const link of probe)
      await expect(link).toHaveAttribute(
        "href",
        expect.stringContaining(PROBE.id)
      )
    await expect(canvas.queryByText(/written by|by the model/i)).toBeNull()
  },
}

/**
 * The same digest where the units with no evidence have no proof recorded:
 * under "What to check", each says Missing after its link, as its unit
 * page's row does. The units that met an item say nothing more.
 */
export const ObligationMissingProof: Story = {
  args: { data: missingProofOverviewFixture },
  play: async ({ canvas }) => {
    const check = canvas.getByRole("region", { name: "What to check" })
    await visible(check)
    const { LOCATE, PROBE, CHECKOUT } = REDESIGNED_UNITS
    const missing = within(check).getAllByText("Missing")
    await expect(missing).toHaveLength(2)
    // Whether Missing follows each of the unit's links, in the list's order.
    const missingAfter = (name: string) =>
      within(check)
        .getAllByRole("link", { name })
        .map((link) => link.nextElementSibling?.textContent === "Missing")
    // probeCache has no evidence for the first item and is not met on the second.
    await expect(missingAfter(`${PROBE.title} (human required)`)).toEqual([
      true,
      false,
    ])
    await expect(missingAfter(`${LOCATE.title} (human required)`)).toEqual([
      true,
    ])
    await expect(missingAfter(`${CHECKOUT.title} (human required)`)).toEqual([
      false,
    ])
    for (const label of missing) await visible(label)
  },
}

/**
 * The generated batch: no model call, so code's digest under "What
 * changed" and its limitation, and nothing to check. Nothing waits on a
 * person, so the briefing is folded.
 */
export const GeneratedBatchCodeDigest: Story = {
  args: { data: generatedDigestOverviewFixture },
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByText("Briefing"))
    const changed = canvas.getByRole("region", { name: "What changed" })
    await visible(changed)
    await expect(changed).toHaveTextContent("bun.lock at line 95")
    await expect(
      canvas.queryByRole("region", { name: "What to check" })
    ).toBeNull()
    await userEvent.click(canvas.getByText("Limitations"))
    await visible(canvas.getByText(CODE_DIGEST_LIMITATION))
  },
}

/**
 * A digest gap: the briefing's digest failed, so code's digest shows, with
 * its limitation and the gap's line under Limitations.
 */
export const DigestGap: Story = {
  args: { data: digestGapOverviewFixture },
  play: async ({ canvas }) => {
    const changed = canvas.getByRole("region", { name: "What changed" })
    await visible(changed)
    await expect(changed).toHaveTextContent('7 units in 5 files for "Share')
    await expect(
      canvas.queryByRole("region", { name: "What to check" })
    ).toBeNull()
    await userEvent.click(canvas.getByText("Limitations"))
    await visible(canvas.getByText(CODE_DIGEST_LIMITATION))
    await visible(canvas.getByText(DIGEST_GAP_NOTE))
  },
}

/**
 * How far each line of a link's underline runs past that line's last
 * visible character, in px: one entry per line the link spans.
 */
function underlineOverrun(link: HTMLElement) {
  const doc = link.ownerDocument
  const glyphs: Array<DOMRect> = []
  const walker = doc.createTreeWalker(link, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? ""
    for (let i = 0; i < text.length; i += 1) {
      if (/\s/.test(text[i]!)) continue
      const range = doc.createRange()
      range.setStart(node, i)
      range.setEnd(node, i + 1)
      const box = range.getBoundingClientRect()
      if (box.width > 0) glyphs.push(box)
    }
  }
  return Array.from(link.getClientRects()).map((line) => {
    const ends = glyphs
      .filter(
        (glyph) => glyph.top >= line.top - 1 && glyph.bottom <= line.bottom + 1
      )
      .map((glyph) => glyph.right)
    return line.right - Math.max(...ends)
  })
}

/**
 * Unit links in the digest that wrap: each line's underline ends at its
 * last word, as a phrase link's does in the briefing; the paragraph's kept
 * spaces never carry it past ("repeat_").
 */
export const DigestLinksWrap: Story = {
  args: { data: wrappingLinksOverviewFixture },
  decorators: [
    (Story) => (
      <div style={{ width: 360 }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvas }) => {
    const changed = canvas.getByRole("region", { name: "What changed" })
    await visible(changed)
    for (const name of WRAPPING_DIGEST_LINKS) {
      const link = within(changed).getByRole("link", { name })
      const overrun = underlineOverrun(link)
      // It wraps, and no line of it is underlined past its last word.
      await expect(overrun.length).toBeGreaterThan(1)
      for (const px of overrun) await expect(px).toBeLessThan(1)
    }
  },
}
