import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { StoryFrame } from "@workspace/ui/foundations/sheet"
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@workspace/ui/components/popover"

/**
 * shadcn Popover. The app uses Popover and PopoverTrigger (the agents
 * control renders its own panel); PopoverContent has no importer and is
 * kept here so its motion stays on the tokens: a fade over TIMING.hint, none
 * under reduced motion.
 */
function Example() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="h-8 rounded-lg border-0 bg-raised px-3 text-[12.5px]"
        >
          Agents
        </button>
      </PopoverTrigger>
      <PopoverContent align="start">
        <PopoverHeader>
          <PopoverTitle>Connected agents</PopoverTitle>
          <PopoverDescription>I1 implementer · R1 reviewer</PopoverDescription>
        </PopoverHeader>
      </PopoverContent>
    </Popover>
  )
}

const meta = {
  title: "Primitives/Popover",
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

const panel = async () =>
  (
    await within(document.body).findByText("Connected agents")
  ).closest<HTMLElement>("[data-slot='popover-content']")!

export const Open: Story = {
  globals: { reducedMotion: "full" },
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Agents" }))
    const content = await panel()
    await expect(content).toHaveAttribute("data-state", "open")
    await expect(getComputedStyle(content).animationName).toBe("enter")
  },
}

export const FocusVisible: Story = {
  play: async ({ canvas }) => {
    await userEvent.tab()
    const trigger = canvas.getByRole("button", { name: "Agents" })
    await expect(trigger).toHaveFocus()
    await userEvent.keyboard("{Enter}")
    const content = await panel()
    await waitFor(() => expect(content).toBeVisible())
  },
}

export const ReducedMotion: Story = {
  globals: { reducedMotion: "reduce" },
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Agents" }))
    await expect(getComputedStyle(await panel()).animationName).toBe("none")
  },
}

export const OpenDark: Story = {
  ...Open,
  globals: { theme: "dark", reducedMotion: "full" },
}
