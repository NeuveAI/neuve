import type { Meta, StoryObj } from "@storybook/react-vite"

import { BrandMark } from "@workspace/ui/neuve/shared/brand-mark"
import { Disclosure } from "@workspace/ui/neuve/shared/disclosure"
import { LaneGlyph } from "@workspace/ui/neuve/shared/lane-glyph"
import { Segmented } from "@workspace/ui/neuve/shared/segmented"
import { ThemeToggle } from "@workspace/ui/neuve/shared/theme-toggle"
import type { ReviewLane } from "@workspace/ui/neuve/types"

const meta = {
  title: "Shared",
  component: BrandMark,
  decorators: [
    (Story) => (
      <div className="min-h-svh bg-paper p-8 font-sans text-sm text-ink">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof BrandMark>

export default meta
type Story = StoryObj<typeof meta>

export const Brand: Story = {}

/** Toggles `.dark` on <html>; also driven by the toolbar theme switch. */
export const ThemeSwitch: Story = { render: () => <ThemeToggle /> }

const LANES: Array<[ReviewLane, string]> = [
  ["human-required", "Human-required"],
  ["human-suggested", "Human-suggested"],
  ["agentic-review", "Agentic review"],
  ["static-automation", "Static automation"],
]

export const LaneGlyphs: Story = {
  render: () => (
    <ul className="m-0 flex list-none flex-col gap-3 p-0">
      {LANES.map(([lane, label]) => (
        <li key={lane} className="flex items-center gap-2.5">
          <LaneGlyph lane={lane} />
          {label}
        </li>
      ))}
    </ul>
  ),
}

/** Without a handler only the current option is enabled. */
export const SegmentedControl: Story = {
  render: () => (
    <div className="flex gap-4">
      <Segmented label="Browse by" options={["Units", "Files"]} value="Units" />
      <Segmented
        label="Diff layout"
        options={["Stacked", "Split"]}
        value="Stacked"
      />
    </div>
  ),
}

/**
 * The one disclosure style (round 3): a 40px chevron row, the chevron turns
 * 90° in 200ms, label and count chip; the content rises in. Native
 * <details>, so find-in-page opens it.
 */
export const DisclosureRows: Story = {
  render: () => (
    <div className="flex max-w-[560px] flex-col">
      <Disclosure label="Recorded limitations" count={3} defaultOpen>
        <ul className="m-0 flex list-disc flex-col gap-1.5 pl-4 text-[12.5px] leading-[18px] text-ink-2">
          <li>Submitted-source citation support is unavailable</li>
          <li>Review-obligation coverage is not established</li>
          <li>A partial provider failure skipped one file</li>
        </ul>
      </Disclosure>
      <Disclosure label="Owned hunks and recorded decisions" count={3}>
        <p className="m-0 font-mono text-xs text-ink-muted">h-1, h-2, h-3</p>
      </Disclosure>
      <Disclosure label="Details">
        <pre className="m-0 font-mono text-[11.5px] text-ink-2">
          SchemaError: Expected a full commit id
        </pre>
      </Disclosure>
    </div>
  ),
}
