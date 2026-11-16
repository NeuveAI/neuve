import type { Meta, StoryObj } from "@storybook/react-vite"
import { WrapTextIcon } from "lucide-react"
import { expect, userEvent } from "storybook/test"
import { expectFocusVisible } from "@workspace/ui/neuve/story-kit/play"

import { StoryFrame } from "@workspace/ui/foundations/sheet"
import { Toggle } from "@workspace/ui/components/toggle"
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@workspace/ui/components/toggle-group"

/** shadcn Toggle and ToggleGroup; `segment` is the Neuve segmented control. */
const meta = {
  title: "Primitives/Toggle",
  component: Toggle,
  decorators: [
    (Story) => (
      <StoryFrame>
        <Story />
      </StoryFrame>
    ),
  ],
} satisfies Meta<typeof Toggle>

export default meta
type Story = StoryObj<typeof meta>

export const States: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Toggle aria-label="Wrap off">
          <WrapTextIcon />
        </Toggle>
        <Toggle aria-label="Wrap on" defaultPressed>
          <WrapTextIcon />
        </Toggle>
        <Toggle variant="outline">Outline</Toggle>
        <Toggle variant="outline" defaultPressed>
          Outline on
        </Toggle>
        <Toggle disabled>Disabled</Toggle>
      </div>
    </div>
  ),
  play: async ({ canvas }) => {
    const off = canvas.getByRole("button", { name: "Wrap off" })
    await expect(off).toHaveAttribute("data-state", "off")
    await userEvent.click(off)
    await expect(off).toHaveAttribute("data-state", "on")
    await expect(off).toHaveAttribute("aria-pressed", "true")
    await expect(
      canvas.getByRole("button", { name: "Disabled" })
    ).toBeDisabled()
  },
}

/** The segmented control (Units / Files, Stacked / Split). */
export const SegmentGroup: Story = {
  render: () => (
    <div className="inline-flex rounded-lg bg-raised p-0.5">
      <ToggleGroup
        type="single"
        defaultValue="units"
        variant="segment"
        size="segment"
        spacing={0}
        aria-label="Browse by"
      >
        <ToggleGroupItem value="units">Units</ToggleGroupItem>
        <ToggleGroupItem value="files">Files</ToggleGroupItem>
      </ToggleGroup>
    </div>
  ),
  play: async ({ canvas }) => {
    const files = canvas.getByRole("radio", { name: "Files" })
    await userEvent.click(files)
    await expect(files).toHaveAttribute("data-state", "on")
    await expect(canvas.getByRole("radio", { name: "Units" })).toHaveAttribute(
      "data-state",
      "off"
    )
  },
}

export const SegmentGroupDark: Story = {
  ...SegmentGroup,
  globals: { theme: "dark" },
}

/** Keyboard focus draws the ring; arrow keys move within the group. */
export const FocusVisible: Story = {
  render: SegmentGroup.render,
  play: async ({ canvas }) => {
    await userEvent.tab()
    const units = canvas.getByRole("radio", { name: "Units" })
    // The house ring: a solid 2px outline (not a half-strength box-shadow).
    await expectFocusVisible(units)
    await userEvent.keyboard("{ArrowRight}")
    await expect(canvas.getByRole("radio", { name: "Files" })).toHaveFocus()
  },
}
