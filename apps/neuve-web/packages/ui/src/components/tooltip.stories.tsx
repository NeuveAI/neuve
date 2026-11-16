import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { expectFocusVisible } from "@workspace/ui/neuve/story-kit/play"

import { StoryFrame } from "@workspace/ui/foundations/sheet"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

/**
 * shadcn Tooltip: fades in over TIMING.hint (iOS ease-out) on a real hover,
 * opens at once on keyboard focus, and never animates under reduced motion.
 */
function Example() {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="h-8 rounded-lg border-0 bg-raised px-3 text-[12.5px]"
          >
            R1 approved
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Reviewer agent · a3f9c2e</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

const meta = {
  title: "Primitives/Tooltip",
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

const content = () =>
  within(document.body).findByText("Reviewer agent · a3f9c2e", {
    selector: "[data-slot='tooltip-content'], [data-slot='tooltip-content'] *",
  })

/** Hover: a fade, no zoom or slide. */
export const Hover: Story = {
  globals: { reducedMotion: "full" },
  play: async ({ canvas }) => {
    await userEvent.hover(canvas.getByRole("button", { name: "R1 approved" }))
    const tip = (await content()).closest<HTMLElement>(
      "[data-slot='tooltip-content']"
    )!
    await waitFor(() =>
      expect(tip).toHaveAttribute("data-state", "delayed-open")
    )
    const style = getComputedStyle(tip)
    await expect(style.animationName).toBe("enter")
    // A fade only: tw-animate's zoom and slide stay at rest.
    await expect(style.getPropertyValue("--tw-enter-scale").trim()).toBe("1")
    await expect(
      parseFloat(style.getPropertyValue("--tw-enter-translate-y")) || 0
    ).toBe(0)
  },
}

/**
 * Keyboard focus opens it at once, with the focus ring on the trigger: Radix
 * marks it "instant-open" and it appears without the hover fade, even with
 * motion allowed (a deliberate accessibility choice, round 6).
 */
export const FocusVisible: Story = {
  globals: { reducedMotion: "full" },
  play: async ({ canvas }) => {
    await userEvent.tab()
    // Keyboard focus (focus-visible, with its ring) opens the tooltip.
    await expectFocusVisible(
      canvas.getByRole("button", { name: "R1 approved" })
    )
    const tip = (await content()).closest<HTMLElement>(
      "[data-slot='tooltip-content']"
    )!
    await expect(tip).toHaveAttribute("data-state", "instant-open")
    await expect(tip).toBeVisible()
    // Radix holds any animation until the content is positioned; two frames
    // later the hover fade would have started.
    await new Promise((done) =>
      requestAnimationFrame(() => requestAnimationFrame(done))
    )
    await expect(getComputedStyle(tip).animationName).toBe("none")
  },
}

/** Reduced motion: the tooltip appears without any animation. */
export const ReducedMotion: Story = {
  globals: { reducedMotion: "reduce" },
  play: async ({ canvas }) => {
    await userEvent.hover(canvas.getByRole("button", { name: "R1 approved" }))
    const tip = (await content()).closest<HTMLElement>(
      "[data-slot='tooltip-content']"
    )!
    await expect(getComputedStyle(tip).animationName).toBe("none")
  },
}

export const HoverDark: Story = {
  ...Hover,
  globals: { theme: "dark", reducedMotion: "full" },
}
