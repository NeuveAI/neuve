import type { Meta, StoryObj } from "@storybook/react-vite"
import type { within } from "storybook/test"
import { expect, spyOn, waitFor } from "storybook/test"

import {
  checkpointLines,
  sharedLineDesk,
} from "@workspace/ui/fixtures/checkpoint.fixtures"
import { reviewDeskLiveFixture } from "@workspace/ui/fixtures/review-batch.fixtures"
import { RAIL_COLLAPSED_STORAGE_KEY } from "@workspace/ui/neuve/review-desk/atoms"
import { DEFAULT_DELIVERY_SETTINGS } from "@workspace/ui/neuve/shared/delivery"
import {
  MESSAGE_SOURCE,
  useAceBridge,
} from "@workspace/ui/neuve/shared/embedded"
import type { DeskAt } from "@workspace/ui/neuve/story-kit/desk"
import {
  DESK_VIEWPORTS,
  deskAt,
  deskMeta,
} from "@workspace/ui/neuve/story-kit/desk"
import { diffHosts, openCard } from "@workspace/ui/neuve/story-kit/dom"
import { frames } from "@workspace/ui/neuve/story-kit/play"
import {
  ACE_VIEWPORTS,
  AT_ACE_SPLIT,
  AT_ACE_TAB,
  inAcePage,
  inAceTab,
} from "@workspace/ui/neuve/story-kit/frames"

const desk = deskMeta(
  "revoke-live",
  {},
  { settings: DEFAULT_DELIVERY_SETTINGS }
)

/**
 * The review desk in Ace's Review tab (decision 12.16). The header gives way
 * to one thin row, and the desk keeps its app shell at every width, so the
 * dock stays in view. Split beside the chat (narrower than 960px) the rail
 * starts as its icon column and the margins tighten; the diff and the dock
 * stay. Each story is the desk of "Screens/Review desk" (`deskAt`).
 */
const meta = {
  title: "Screens/Review desk/In Ace",
  ...desk,
  decorators: [...desk.decorators, inAceTab],
  parameters: {
    viewport: { options: { ...DESK_VIEWPORTS, ...ACE_VIEWPORTS } },
  },
} satisfies Meta<typeof DeskAt>

export default meta
type Story = StoryObj<typeof meta>

const dark = { theme: "dark" } as const
const rail = (canvas: ReturnType<typeof within>) =>
  canvas.getByRole("navigation", { name: "Review units" })

/** The full-width tab: the thin row, then the desk as on its own address. */
export const Tab: Story = {
  ...AT_ACE_TAB,
  play: async ({ canvas }) => {
    const row = canvas.getByRole("banner")
    await expect(row).toHaveTextContent(reviewDeskLiveFixture.branch)
    await expect(row.getBoundingClientRect().height).toBeLessThanOrEqual(40)
    await expect(canvas.queryByRole("button", { name: "Find" })).toBeNull()
    await expect(rail(canvas)).not.toHaveAttribute("data-collapsed")
  },
}
export const TabDark: Story = {
  globals: { ...AT_ACE_TAB.globals, ...dark },
}

/**
 * Split beside the chat: the rail is its 60px icon column, the diff takes
 * the rest, the dock stays at the bottom of the tab, and nothing scrolls
 * sideways. The rail the viewer stored for the wide desk is untouched.
 */
export const Split: Story = {
  ...AT_ACE_SPLIT,
  play: async ({ canvas, canvasElement }) => {
    const doc = canvasElement.ownerDocument
    await expect(doc.documentElement.clientWidth, "A 640px tab").toBe(640)
    await waitFor(() => expect(rail(canvas)).toHaveAttribute("data-collapsed"))
    await expect(rail(canvas).getBoundingClientRect().width).toBe(60)
    await waitFor(() =>
      expect(diffHosts(canvasElement).length).toBeGreaterThan(0)
    )
    // The dock fades in as the desk mounts.
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: "Request changes" })
      ).toBeVisible()
    )
    const dock = canvasElement.querySelector("[data-decision-dock]")!
    await expect(dock.getBoundingClientRect().bottom).toBeLessThanOrEqual(820)
    await expect(doc.documentElement.scrollWidth).toBe(640)
  },
}
export const SplitDark: Story = {
  globals: { ...AT_ACE_SPLIT.globals, ...dark },
}

/**
 * The rail opens in split view by its button and closes with "[", for this
 * desk only: the stored choice for the wide desk stays as it was.
 */
export const SplitRailOpens: Story = {
  ...AT_ACE_SPLIT,
  play: async ({ canvas, userEvent }) => {
    const stored = localStorage.getItem(RAIL_COLLAPSED_STORAGE_KEY)
    await waitFor(() => expect(rail(canvas)).toHaveAttribute("data-collapsed"))
    await userEvent.click(
      canvas.getByRole("button", { name: "Expand sidebar" })
    )
    await waitFor(() =>
      expect(rail(canvas)).not.toHaveAttribute("data-collapsed")
    )
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: "Request changes" })
      ).toBeVisible()
    )
    await expect(localStorage.getItem(RAIL_COLLAPSED_STORAGE_KEY)).toBe(stored)
    await userEvent.keyboard("[[")
    await waitFor(() => expect(rail(canvas)).toHaveAttribute("data-collapsed"))
    await expect(localStorage.getItem(RAIL_COLLAPSED_STORAGE_KEY)).toBe(stored)
  },
}

function AceBridge() {
  useAceBridge(undefined)
  return null
}

/** The page embedded, with the bridge that messages Ace. */
const withAceBridge: NonNullable<Story["decorators"]> = [
  (Story) => (
    <>
      <AceBridge />
      <Story />
    </>
  ),
  inAcePage,
]

type PlayArgs = Parameters<NonNullable<Story["play"]>>[0]

/**
 * The layers open now: floating cards, a line's marker list, and anything
 * Radix floats (tooltips such as a pin's hint or a graph path, popovers).
 */
const openLayers = (root: HTMLElement) =>
  root.ownerDocument.querySelectorAll(
    "[data-floating-card], [data-line-list], [data-radix-popper-content-wrapper]"
  ).length

/**
 * Presses Escape while a layer is open: each press closes one and nothing
 * goes to Ace. Then one press with nothing left goes to Ace, exactly once.
 * `post` is the spy on the parent's postMessage.
 */
async function closeLayersThenHandBack(
  { canvasElement, userEvent }: PlayArgs,
  post: ReturnType<typeof spyOn>
) {
  const escapes = () =>
    post.mock.calls.filter(
      ([message]) => (message as { type?: string }).type === "escape"
    )
  for (let press = 0; press < 5 && openLayers(canvasElement) > 0; press++) {
    const before = openLayers(canvasElement)
    await userEvent.keyboard("{Escape}")
    // A closing card leaves after its exit; the next press waits for it.
    await waitFor(() => expect(openLayers(canvasElement)).toBeLessThan(before))
    await frames(2)
    await expect(escapes()).toHaveLength(0)
  }
  await expect(openLayers(canvasElement)).toBe(0)
  await userEvent.keyboard("{Escape}")
  await waitFor(() => expect(escapes()).toHaveLength(1))
  await expect(escapes()[0]).toEqual([
    { source: MESSAGE_SOURCE, type: "escape" },
    window.location.origin,
  ])
}

/**
 * Escape closes the desk's layers one by one; only a press with nothing
 * left to close goes to Ace, which hands focus back to the chat. Here the
 * conflict card is open: Escape closes it, then the line's marker list it
 * returns to when it had the focus (and a focused pin's tooltip), and the
 * press after that goes to Ace.
 */
export const EscapeHandsBack: Story = {
  ...AT_ACE_SPLIT,
  args: deskAt("revoke-live", { open: "conflict" }),
  decorators: withAceBridge,
  play: async (context) => {
    const post = spyOn(window.parent, "postMessage")
    try {
      await waitFor(() => expect(openCard(context.canvasElement)).toBeVisible())
      await closeLayersThenHandBack(context, post)
    } finally {
      post.mockRestore()
    }
  },
}

/**
 * A checkpoint pin's peek (its hint) closes on Escape, as leaving the pin
 * does (WCAG 1.4.13). Before, the peek claimed the press and stayed, so with
 * the pointer on a checkpoint, Escape never reached Ace.
 */
export const EscapeClosesCheckpointPeek: Story = {
  ...AT_ACE_SPLIT,
  args: deskAt(sharedLineDesk),
  decorators: withAceBridge,
  play: async (context) => {
    const { canvas, canvasElement, userEvent } = context
    const doc = canvasElement.ownerDocument
    const post = spyOn(window.parent, "postMessage")
    try {
      const [line] = checkpointLines(sharedLineDesk)
      const pin = await canvas.findByRole(
        "button",
        {
          name: `2 checkpoints on line ${line!.lineNumber}, missing, missing`,
        },
        { timeout: 5000 }
      )
      await userEvent.hover(pin)
      await waitFor(() => expect(doc.querySelector("[data-peek]")).toBeTruthy())
      await closeLayersThenHandBack(context, post)
      await expect(doc.querySelector("[data-peek]")).toBeNull()
    } finally {
      post.mockRestore()
    }
  },
}

/**
 * Inside the graph card, a path's full-name tooltip closes on the first
 * Escape and the card stays; the next closes the card. Before, the tooltip
 * claimed every press, so the card could not be closed from the keyboard
 * while it showed, and Escape never reached Ace.
 */
export const EscapeClosesGraphPath: Story = {
  ...AT_ACE_TAB,
  args: deskAt("revoke-live", { open: "graph" }),
  decorators: withAceBridge,
  play: async (context) => {
    const { canvasElement, userEvent } = context
    const doc = canvasElement.ownerDocument
    const tip = () => doc.querySelector("[data-floating-hint] [data-tip-text]")
    const post = spyOn(window.parent, "postMessage")
    try {
      const card = await waitFor(() => {
        const found = openCard(canvasElement)
        expect(found).toBeVisible()
        return found!
      })
      await userEvent.hover(card.querySelector('[data-tree-row="1"]')!)
      await waitFor(() => expect(tip()).toBeTruthy())
      await userEvent.keyboard("{Escape}")
      await waitFor(() => expect(tip()).toBeNull())
      await expect(openCard(canvasElement)).toBeTruthy()
      await closeLayersThenHandBack(context, post)
    } finally {
      post.mockRestore()
    }
  },
}
