import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect } from "storybook/test"
import { expectFocusVisible } from "@workspace/ui/neuve/story-kit/play"

import { Badge } from "@workspace/ui/components/badge"
import { StoryFrame } from "@workspace/ui/foundations/sheet"

const VARIANTS = [
  "default",
  "secondary",
  "destructive",
  "outline",
  "ghost",
  "link",
  "marker-neutral",
  "marker-req",
  "marker-sug",
  "marker-batch",
] as const

/**
 * shadcn Badge with the Neuve marker variants. No component imports it
 * today (marker chips draw their own); it stays on the tokens here.
 */
const meta = {
  title: "Primitives/Badge",
  component: Badge,
  decorators: [
    (Story) => (
      <StoryFrame>
        <Story />
      </StoryFrame>
    ),
  ],
} satisfies Meta<typeof Badge>

export default meta
type Story = StoryObj<typeof meta>

export const Variants: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      {VARIANTS.map((variant) => (
        <Badge key={variant} variant={variant}>
          {variant}
        </Badge>
      ))}
      <Badge asChild>
        <a href="#badge">Link badge</a>
      </Badge>
    </div>
  ),
  play: async ({ canvas }) => {
    for (const variant of VARIANTS)
      await expect(canvas.getByText(variant)).toHaveAttribute(
        "data-variant",
        variant
      )
  },
}

export const VariantsDark: Story = { ...Variants, globals: { theme: "dark" } }

/** A badge that is a link takes keyboard focus and draws the ring. */
export const FocusVisible: Story = {
  render: () => (
    <Badge asChild>
      <a href="#badge">Link badge</a>
    </Badge>
  ),
  play: async ({ canvas, userEvent }) => {
    await userEvent.tab()
    const link = canvas.getByRole("link", { name: "Link badge" })
    // The house ring: a solid 2px outline (not a half-strength box-shadow).
    await expectFocusVisible(link)
    // A link badge already takes the global outline; no ring halo with it.
    await expect(getComputedStyle(link).boxShadow).toBe("none")
  },
}
