import type { Meta, StoryObj } from "@storybook/react-vite"
import { ArrowRightIcon } from "lucide-react"
import { expect, userEvent } from "storybook/test"
import { expectFocusVisible } from "@workspace/ui/neuve/story-kit/play"

import { Button } from "@workspace/ui/components/button"
import { StoryFrame } from "@workspace/ui/foundations/sheet"

const VARIANTS = [
  "default",
  "outline",
  "secondary",
  "ghost",
  "destructive",
  "link",
  "ink",
  "raised",
  "quiet",
] as const
const DOCK_VARIANTS = ["dock-ghost", "dock-primary"] as const
const SIZES = ["xs", "sm", "default", "lg", "compact", "dock"] as const

/**
 * shadcn Button with the Neuve variants. Tone and focus ring shift on
 * surfaceTone; a press compresses to SCALE.press on pressIn (the `press`
 * utility); popup triggers don't compress.
 */
const meta = {
  title: "Primitives/Button",
  component: Button,
  decorators: [
    (Story) => (
      <StoryFrame>
        <Story />
      </StoryFrame>
    ),
  ],
} satisfies Meta<typeof Button>

export default meta
type Story = StoryObj<typeof meta>

export const Variants: Story = {
  render: () => (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        {VARIANTS.map((variant) => (
          <Button key={variant} variant={variant}>
            {variant}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3 rounded-xl bg-dock p-4">
        {DOCK_VARIANTS.map((variant) => (
          <Button key={variant} variant={variant} size="dock">
            {variant}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {SIZES.map((size) => (
          <Button key={size} size={size} variant="outline">
            Size {size}
            <ArrowRightIcon data-icon="inline-end" />
          </Button>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <Button disabled>Disabled</Button>
        <Button variant="ink" disabled>
          Disabled ink
        </Button>
      </div>
    </div>
  ),
  play: async ({ canvas }) => {
    for (const variant of VARIANTS)
      await expect(
        canvas.getByRole("button", { name: variant })
      ).toHaveAttribute("data-variant", variant)
    await expect(
      canvas.getByRole("button", { name: "Disabled" })
    ).toBeDisabled()
  },
}

export const VariantsDark: Story = { ...Variants, globals: { theme: "dark" } }

/** Keyboard focus draws the ring; the press transition carries scale. */
export const FocusVisible: Story = {
  render: () => (
    <div className="flex gap-3">
      <Button variant="ink">Approve</Button>
      <Button variant="outline">Request changes</Button>
    </div>
  ),
  play: async ({ canvas }) => {
    await userEvent.tab()
    const button = canvas.getByRole("button", { name: "Approve" })
    // The house ring: a solid 2px outline (not a half-strength box-shadow).
    await expectFocusVisible(button)
    await expect(getComputedStyle(button).transitionProperty).toContain("scale")
  },
}

/** Reduced motion: no compress; tone shifts stay. */
export const ReducedMotion: Story = {
  ...FocusVisible,
  globals: { reducedMotion: "reduce" },
  play: async ({ canvas }) => {
    const button = canvas.getByRole("button", { name: "Approve" })
    const transition = getComputedStyle(button).transitionProperty
    await expect(transition).not.toContain("scale")
    await expect(transition).toContain("background-color")
  },
}
