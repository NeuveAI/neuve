import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect } from "storybook/test"

import { Skeleton } from "@workspace/ui/components/skeleton"
import { StoryFrame } from "@workspace/ui/foundations/sheet"
import { TIMING, ms } from "@workspace/ui/lib/motion"

/** Neuve Skeleton: breathes on TIMING.skeleton; static under reduced motion. */
function Example() {
  return (
    <div className="flex max-w-[360px] flex-col gap-2.5">
      <Skeleton className="h-4 w-3/5" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-4/5" />
    </div>
  )
}

const meta = {
  title: "Primitives/Skeleton",
  component: Example,
  decorators: [
    (Story) => (
      <StoryFrame>
        <Story />
      </StoryFrame>
    ),
  ],
} satisfies Meta<typeof Example>

export default meta
type Story = StoryObj<typeof meta>

const blocks = (canvasElement: HTMLElement) =>
  canvasElement.querySelectorAll<HTMLElement>("[data-slot='skeleton']")

export const Breathing: Story = {
  globals: { reducedMotion: "full" },
  play: async ({ canvasElement }) => {
    for (const block of blocks(canvasElement)) {
      const style = getComputedStyle(block)
      await expect(style.animationName).toBe("nv-skeleton")
      await expect(style.animationDuration).toBe(`${ms(TIMING.skeleton)}s`)
    }
  },
}

export const BreathingDark: Story = {
  ...Breathing,
  globals: { theme: "dark", reducedMotion: "full" },
}

export const ReducedMotion: Story = {
  globals: { reducedMotion: "reduce" },
  play: async ({ canvasElement }) => {
    for (const block of blocks(canvasElement))
      await expect(getComputedStyle(block).animationName).toBe("none")
  },
}
