import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, waitFor, within } from "storybook/test"

import { agentRegistryFixture } from "@workspace/ui/fixtures/review-batch.fixtures"
import { AgentsControl } from "@workspace/ui/neuve/agents/agents-control"
import { pendingAgentConnector } from "@workspace/ui/neuve/agents/atoms"
import type { AgentConnector } from "@workspace/ui/neuve/agents/atoms"
import {
  onPaper,
  withReviewDeskState,
} from "@workspace/ui/neuve/review-desk/story-state"
import type { AgentRegistry } from "@workspace/ui/neuve/types"

/** Connects quickly so the play can see the whole round trip. */
const quickConnector: AgentConnector = {
  connect: (_agentId, harnessId) =>
    new Promise((resolve) =>
      setTimeout(
        () => resolve({ status: "connected", harnessId, activity: "Idle" }),
        400
      )
    ),
  disconnect: () => Promise.resolve(),
}

const meta = {
  title: "Agents/Agents control",
  component: AgentsControl,
  decorators: [
    (Story) => (
      <div className="flex justify-end">
        <Story />
      </div>
    ),
    onPaper,
  ],
} satisfies Meta<typeof AgentsControl>

export default meta
type Story = StoryObj<typeof meta>

/**
 * The layout boxes of a row's own grid items (name with its units chip,
 * control, status). Offsets ignore transforms, so the popover's enter
 * motion doesn't move them; the fonts must have loaded first.
 */
async function rowBoxes(row: HTMLElement) {
  row.getBoundingClientRect() // lays the row out, so its fonts start loading
  await row.ownerDocument.fonts.ready
  return [...row.children]
    .filter((item): item is HTMLElement => item instanceof HTMLElement)
    .slice(0, 3)
    .map(({ offsetLeft, offsetTop, offsetWidth, offsetHeight }) => ({
      offsetLeft,
      offsetTop,
      offsetWidth,
      offsetHeight,
    }))
}

/**
 * A row keeps its three columns and its items' places while a reveal (the
 * picker or the disconnect warning) opens under it, and its units chip
 * stays whole. Layout only: the popover's own fade is not asserted here.
 */
async function expectRowHeld(
  row: HTMLElement,
  before: Awaited<ReturnType<typeof rowBoxes>>
) {
  const columns = getComputedStyle(row).gridTemplateColumns.split(" ")
  await expect(columns).toHaveLength(3)
  await expect(await rowBoxes(row)).toEqual(before)
  // The chip sits whole inside the name cell (both share an offset parent).
  const chip = within(row).getByText(/^\d+ units$/)
  const name = chip.parentElement
  if (!name) throw new Error("The units chip has no name cell")
  await expect(chip.checkVisibility({ visibilityProperty: true })).toBe(true)
  await expect(chip.offsetWidth).toBeGreaterThan(0)
  await expect(chip.offsetLeft + chip.offsetWidth).toBeLessThanOrEqual(
    name.offsetLeft + name.offsetWidth
  )
}

/**
 * Avatars side by side (never overlapped), "+1", "4 agents · 3 live". Each
 * is the plain 24px antenna square from the review identity: liveness is
 * the "3 live" count, never a badge on the avatar.
 */
export const Rest: Story = {
  decorators: [withReviewDeskState()],
  play: async ({ canvas }) => {
    const trigger = canvas.getByRole("button", {
      name: "4 agents on this branch, 3 connected",
    })
    await expect(trigger).toHaveTextContent("4 agents · 3 live")
    const avatars = [
      ...trigger.querySelectorAll<SVGSVGElement>('svg[data-avatar="agent"]'),
    ]
    await expect(avatars.map((svg) => svg.dataset.size)).toEqual([
      "24",
      "24",
      "24",
    ])
    for (const svg of avatars)
      await expect(svg.querySelectorAll("circle")).toHaveLength(1) // the antenna ball
  },
}

const twoAgents: AgentRegistry = {
  ...agentRegistryFixture,
  agents: agentRegistryFixture.agents.slice(0, 2),
}

/** Fewer than four agents: no "+N". */
export const TwoAgents: Story = {
  decorators: [withReviewDeskState({}, undefined, { agents: twoAgents })],
}

/** Popover: Implementers and Reviewers with scope, unit count, status. */
export const Open: Story = {
  decorators: [withReviewDeskState({}, undefined, { agentsOpen: true })],
}

/** R2 is starting on this machine. */
export const Connecting: Story = {
  decorators: [
    withReviewDeskState({}, undefined, {
      agentsOpen: true,
      agents: {
        ...agentRegistryFixture,
        connections: {
          ...agentRegistryFixture.connections,
          r2: { status: "connecting", harnessId: "eve-local" },
        },
      },
      agentConnector: pendingAgentConnector,
    }),
  ],
}

/**
 * Connect picks from configured agents only (never a typed command): the
 * picker opens under the row without moving its chip, status or button, and
 * the play connects R2 with the eve local harness and waits for it to go
 * live.
 */
export const ConnectFlow: Story = {
  decorators: [
    withReviewDeskState({}, undefined, {
      agentsOpen: true,
      agentConnector: quickConnector,
    }),
  ],
  play: async ({ canvasElement, userEvent }) => {
    const body = within(canvasElement.ownerDocument.body)
    const dialog = await body.findByRole("dialog", {
      name: "Agents on this branch",
    })
    const row = within(dialog).getByRole("group", {
      name: "Reviewer 2 · Sessions",
    })
    const r2 = within(row)
    const before = await rowBoxes(row)
    await userEvent.click(r2.getByRole("button", { name: "Connect" }))
    // The picker rises from opacity 0, so this checks presence, not paint.
    await expect(
      r2.getByRole("group", { name: "Connect Reviewer 2 with" })
    ).toBeInTheDocument()
    await expectRowHeld(row, before)
    await userEvent.click(r2.getByRole("button", { name: "eve local harness" }))
    await expect(r2.getByRole("status")).toHaveTextContent("Connecting")
    await waitFor(() =>
      expect(r2.getByRole("button", { name: "Disconnect" })).toBeVisible()
    )
    await waitFor(() =>
      expect(
        body.getByRole("button", {
          name: "4 agents on this branch, 4 connected",
        })
      ).toBeVisible()
    )
  },
}

/**
 * Disconnect warns that the agent's context is lost; thread history stays.
 * The warning opens under the row without moving its chip, status or
 * button.
 */
export const DisconnectWarning: Story = {
  decorators: [withReviewDeskState({}, undefined, { agentsOpen: true })],
  play: async ({ canvasElement, userEvent }) => {
    const body = within(canvasElement.ownerDocument.body)
    const dialog = await body.findByRole("dialog", {
      name: "Agents on this branch",
    })
    const row = within(dialog).getByRole("group", {
      name: "Implementer 1 · Sharing",
    })
    const i1 = within(row)
    const before = await rowBoxes(row)
    await userEvent.click(i1.getByRole("button", { name: "Disconnect" }))
    await expect(i1.getByRole("alert")).toHaveTextContent(
      "I1 loses its working context. Thread history stays."
    )
    await expectRowHeld(row, before)
  },
}
