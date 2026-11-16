import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, userEvent } from "storybook/test"
import { expectFocusVisible } from "@workspace/ui/neuve/story-kit/play"

import { StoryFrame } from "@workspace/ui/foundations/sheet"
import { Textarea } from "@workspace/ui/components/textarea"

/** shadcn Textarea: border and ring tone on surfaceTone. */
const meta = {
  title: "Primitives/Textarea",
  component: Textarea,
  args: { placeholder: "Ask for a change…", "aria-label": "Comment" },
  decorators: [
    (Story) => (
      <StoryFrame>
        <div className="max-w-[420px]">
          <Story />
        </div>
      </StoryFrame>
    ),
  ],
} satisfies Meta<typeof Textarea>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Filled: Story = {
  args: { defaultValue: "Both writes should happen in one transaction." },
}

export const Disabled: Story = {
  args: { disabled: true, defaultValue: "Sent" },
  play: async ({ canvas }) =>
    expect(canvas.getByRole("textbox", { name: "Comment" })).toBeDisabled(),
}

export const Invalid: Story = { args: { "aria-invalid": true } }

export const FocusVisible: Story = {
  play: async ({ canvas }) => {
    await userEvent.tab()
    const field = canvas.getByRole("textbox", { name: "Comment" })
    // The house ring: a solid 2px outline (not a half-strength box-shadow).
    // It needs a focused document; the helper fails, naming that cause,
    // where none is (a headless tab without focus emulation).
    await expectFocusVisible(field)
    await expect(getComputedStyle(field).transitionDuration).toBe("0.12s")
    await userEvent.keyboard("Looks right")
    await expect(field).toHaveValue("Looks right")
  },
}

export const FilledDark: Story = { ...Filled, globals: { theme: "dark" } }
