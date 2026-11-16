import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { expectFocusVisible } from "@workspace/ui/neuve/story-kit/play"

import { CheckIcon } from "lucide-react"

import { agentRegistryFixture } from "@workspace/ui/fixtures/review-batch.fixtures"
import { TIMING, ms } from "@workspace/ui/lib/motion"
import { cn } from "@workspace/ui/lib/utils"
import { AgentAvatar } from "@workspace/ui/neuve/agents/agent-avatar"
import type { AgentPinState } from "@workspace/ui/neuve/agents/agent-avatar"
import { onPaper } from "@workspace/ui/neuve/review-desk/story-state"
import { PersonAvatar } from "@workspace/ui/neuve/shared/person-avatar"
import type {
  AvatarPerson,
  AvatarSize,
} from "@workspace/ui/neuve/shared/person-avatar"
import { ReviewMark } from "@workspace/ui/neuve/shared/review-mark"
import type { BranchAgent } from "@workspace/ui/neuve/types"

const agent = (short: string): BranchAgent => {
  const found = agentRegistryFixture.agents.find((a) => a.short === short)
  if (!found) throw new Error(`Unknown fixture agent ${short}`)
  return found
}
const I1 = agent("I1")
const R1 = agent("R1")
const you: AvatarPerson = { name: "Vinicius Dallacqua", initials: "VD" }
const PROVENANCE = "R1 · reviewer agent · agentic review · a3f9c2e"

const SIZES: Array<AvatarSize> = [24, 20, 16]
const PLACEMENT: Record<AvatarSize, string> = {
  24: "Header",
  20: "Cards · threads · margin",
  16: "Rail",
}

function AvatarMatrix() {
  const rows = [
    {
      label: "Person",
      render: (size: AvatarSize) => (
        <PersonAvatar person={you} size={size} label={you.name} />
      ),
    },
    {
      label: "Implementer",
      render: (size: AvatarSize) => (
        <AgentAvatar agent={I1} size={size} label="I1, implementer agent" />
      ),
    },
    {
      label: "Reviewer",
      render: (size: AvatarSize) => (
        <AgentAvatar agent={R1} size={size} label="R1, reviewer agent" />
      ),
    },
  ]
  return (
    <div className="flex flex-col gap-8">
      <div
        role="table"
        aria-label="Avatars by actor and size"
        className="grid w-max grid-cols-[120px_repeat(3,minmax(96px,auto))] items-center gap-x-6 gap-y-5"
      >
        <span role="row" className="contents">
          <span role="columnheader" className="label-mono">
            Actor
          </span>
          {SIZES.map((size) => (
            <span key={size} role="columnheader" className="label-mono">
              {size} · {PLACEMENT[size]}
            </span>
          ))}
        </span>
        {rows.map((row) => (
          <span key={row.label} role="row" className="contents">
            <span role="rowheader" className="text-[13px] text-ink-2">
              {row.label}
            </span>
            {SIZES.map((size) => (
              <span
                key={size}
                role="cell"
                data-cell={`${row.label}-${size}`}
                className="flex items-center gap-2 text-[13px] text-ink-2"
              >
                {row.render(size)}
                <span>Text beside it</span>
              </span>
            ))}
          </span>
        ))}
      </div>
      <div className="flex flex-col gap-2">
        <span className="label-mono">
          Detail · 6× (the antenna rises through the edge's opening)
        </span>
        <div className="flex items-end gap-8 pt-4">
          <AgentAvatar agent={I1} className="h-[175.2px] w-36" />
          <AgentAvatar agent={R1} className="h-[175.2px] w-36" />
          <PersonAvatar person={you} className="size-36 text-[54px]" />
        </div>
      </div>
    </div>
  )
}

const meta = {
  title: "Shared/Review identity",
  component: AvatarMatrix,
  decorators: [onPaper],
} satisfies Meta<typeof AvatarMatrix>

export default meta
type Story = StoryObj<typeof meta>

/** Identity is fixed; placement changes the size only. */
export const Avatars: Story = {
  play: async ({ canvasElement }) => {
    for (const size of SIZES) {
      const person = canvasElement.querySelector<HTMLElement>(
        `[data-cell="Person-${size}"] [data-avatar="person"]`
      )!
      await expect(person.getBoundingClientRect().width).toBeCloseTo(size, 0)
      await expect(person.getBoundingClientRect().height).toBeCloseTo(size, 0)
      for (const row of ["Implementer", "Reviewer"]) {
        const svg = canvasElement.querySelector<SVGSVGElement>(
          `[data-cell="${row}-${size}"] svg[data-avatar="agent"]`
        )!
        await expect(svg.getBoundingClientRect().width).toBeCloseTo(size, 0)
        await expect(svg.getAttribute("viewBox")).toBe("0 -1.2 24 29.2")
        // The dashes are attributes on the open edge, never CSS.
        const edge = svg.querySelector("path")!
        await expect(edge.getAttribute("stroke-dasharray")).toBe("2.619 1.964")
        await expect(edge.getAttribute("d")).toMatch(/^M13\.8 5\.3H/)
        await expect(edge.getAttribute("d")).toMatch(/H10\.2$/)
      }
    }
    // Nothing is attached to an agent avatar: one circle, the antenna ball.
    for (const svg of canvasElement.querySelectorAll(
      'svg[data-avatar="agent"]'
    ))
      await expect(svg.querySelectorAll("circle")).toHaveLength(1)
  },
}

export const AvatarsDark: Story = {
  globals: { theme: "dark" },
}

/* ── Review marks ──────────────────────────────────────── */

function Marks() {
  return (
    <div className="flex flex-col items-start gap-4">
      <ReviewMark actor={{ kind: "agent", agent: R1 }} verdict="approved" />
      <ReviewMark
        actor={{ kind: "agent", agent: R1 }}
        verdict="changes_requested"
      />
      <ReviewMark
        actor={{ kind: "person", person: you, isYou: true }}
        verdict="approved"
      />
      <ReviewMark
        actor={{ kind: "person", person: you, isYou: true }}
        verdict="changes_requested"
      />
      <ReviewMark sent={false} verdict="changes_requested" />
      <ReviewMark sent={false} verdict="approved" />
      <ReviewMark
        actor={{ kind: "agent", agent: R1 }}
        verdict="approved"
        provenance={PROVENANCE}
      />
      <span className="flex items-center gap-2 text-[13px] text-ink-2">
        <span className="label-mono">Rail · 16, compact</span>
        <ReviewMark
          actor={{ kind: "agent", agent: R1 }}
          verdict="approved"
          size={16}
          compact
        />
      </span>
    </div>
  )
}

/**
 * Avatar, verdict icon, words in ink. The colour is on the icon only; no
 * fill, no chip. Unsent: a dashed edge around the whole mark, no avatar.
 */
export const ReviewMarks: Story = {
  render: () => <Marks />,
  play: async ({ canvasElement }) => {
    const marks = [
      ...canvasElement.querySelectorAll<HTMLElement>("[data-review-mark]"),
    ]
    await expect(marks.map((mark) => mark.textContent)).toEqual([
      "R1R1 approved",
      "R1R1 requested changes",
      "VDYou approved",
      "VDYou requested changes",
      "Suggested · request changes",
      "Suggested · approve",
      "R1R1 approved",
      "R1R1 approved",
    ])
    for (const mark of marks) {
      await expect(getComputedStyle(mark).backgroundColor).toBe(
        "rgba(0, 0, 0, 0)"
      )
    }
    const unsent = marks.filter((mark) => mark.dataset.sent === "false")
    for (const mark of unsent) {
      await expect(mark.querySelector("[data-avatar]")).toBeNull()
      await expect(getComputedStyle(mark).borderStyle).toBe("dashed")
    }
    // Words in ink; the verdict colour only on the icon.
    const ink = getComputedStyle(marks[1]!).color
    const words = marks[1]!.querySelector<HTMLElement>("span:last-child")!
    await expect(getComputedStyle(words).color).toBe(ink)
    const cross = marks[1]!.querySelector<SVGElement>("[data-verdict-icon]")!
    await expect(getComputedStyle(cross).stroke).not.toBe(ink)
  },
}

export const ReviewMarksDark: Story = {
  render: () => <Marks />,
  globals: { theme: "dark" },
}

/**
 * Provenance on demand: Tab focuses the avatar, which opens the tooltip at
 * once; Escape dismisses it. Pointer hover opens it after 300ms.
 */
export const ProvenanceOnFocus: Story = {
  render: () => (
    <div className="pt-12">
      <ReviewMark
        actor={{ kind: "agent", agent: R1 }}
        verdict="approved"
        provenance={PROVENANCE}
      />
    </div>
  ),
  play: async ({ canvas, canvasElement }) => {
    const trigger = canvas.getByRole("button", { name: "R1, reviewer agent" })
    await userEvent.tab()
    // A visible keyboard focus ring (WCAG 2.4.7), not just the tooltip.
    await expectFocusVisible(trigger)
    const body = within(canvasElement.ownerDocument.body)
    await waitFor(() =>
      expect(body.getByRole("tooltip")).toHaveTextContent(PROVENANCE)
    )
    await expect(trigger).toHaveAccessibleDescription(PROVENANCE)
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(body.queryByRole("tooltip")).toBeNull())
  },
}

/**
 * The viewer's own mark with provenance: their display name is "You" (as
 * every fixture and the live BFF send it), so the avatar is named "You",
 * never "You, You".
 */
export const ProvenanceForYou: Story = {
  render: () => (
    <div className="pt-12">
      <ReviewMark
        actor={{
          kind: "person",
          person: { name: "You", initials: "VD" },
          isYou: true,
        }}
        verdict="approved"
        provenance="You · human review · a3f9c2e"
      />
    </div>
  ),
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole("button", { name: "You" })).toBeVisible()
    await expect(canvasElement).not.toHaveTextContent("You, You")
    const named = [...canvasElement.querySelectorAll("[aria-label]")].map(
      (element) => element.getAttribute("aria-label")
    )
    await expect(named).not.toContain("You, You")
  },
}

/**
 * A comment beside a review: the comment is avatar plus text, with no icon
 * and no verb; the review is avatar, icon and verb.
 */
export const CommentNextToReview: Story = {
  render: () => (
    <div className="flex max-w-[560px] flex-col gap-3">
      <div className="flex flex-col gap-2 rounded-xl bg-surface px-4 py-3.5 shadow-[0_0_0_1px_var(--nv-line)]">
        <ReviewMark
          actor={{ kind: "agent", agent: R1 }}
          verdict="approved"
          provenance={PROVENANCE}
        />
        <span className="text-[13.5px] leading-5 text-ink-2">
          Retries busy writes; accepted the untested path.
        </span>
      </div>
      <div
        data-comment=""
        className="flex flex-col gap-2.5 rounded-xl bg-surface px-4 py-3.5 shadow-[0_0_0_1px_var(--nv-line)]"
      >
        <span className="flex items-start gap-2 text-[13.5px] leading-5 text-ink-2">
          <span className="flex h-5 items-center">
            <PersonAvatar person={you} label="You" />
          </span>
          Should the busy path have a test before this lands?
        </span>
        <span className="flex items-start gap-2 text-[13.5px] leading-5 text-ink-2">
          <span className="flex h-5 items-center">
            <AgentAvatar agent={I1} size={20} label="I1, implementer agent" />
          </span>
          Done in the next revision.
        </span>
      </div>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const comment = canvasElement.querySelector<HTMLElement>("[data-comment]")!
    await expect(comment.querySelector("[data-verdict-icon]")).toBeNull()
    await expect(comment.textContent).not.toMatch(/approved|requested/)
    await expect(
      canvasElement.querySelectorAll("[data-review-mark]").length
    ).toBe(1)
  },
}

/* ── Comment pins: state around the avatar ─────────────── */

const PIN_STATES: Array<AgentPinState> = [
  "rest",
  "hover",
  "focus",
  "open",
  "resolved",
]
const RAISED: ReadonlyArray<AgentPinState> = ["hover", "focus", "open"]
const RING_WIDTH: Partial<Record<AgentPinState, string>> = {
  hover: "1.4px",
  focus: "1.8px",
  open: "1.8px",
}
/** The board's ring path (Verdicts.dc.html, Comment pins). */
const PIN_RING_D =
  "M14.4 3.9H16.9A7.6 7.6 0 0 1 24.1 11.1V20.9A7.6 7.6 0 0 1 16.9 28.1H7.1A7.6 7.6 0 0 1 -0.1 20.9V11.1A7.6 7.6 0 0 1 7.1 3.9H9.6"

/**
 * A person's pin rings follow the bubble on the pin's 22px slot (as the
 * margin draws them; Verdicts.dc.html .pslot).
 */
const PERSON_RING: Record<AgentPinState, string> = {
  rest: "",
  hover: "shadow-[0_0_0_1.5px_var(--nv-line-strong)]",
  focus: "shadow-[0_0_0_2px_var(--nv-focus)]",
  open: "shadow-[0_0_0_2px_var(--nv-ink)]",
  resolved: "shadow-[0_0_0_1px_var(--nv-line-strong)]",
}

function ResolvedCheck({ state }: { state: AgentPinState }) {
  return state === "resolved" ? (
    <CheckIcon
      aria-hidden="true"
      data-resolved=""
      strokeWidth={2.5}
      className="size-3 shrink-0 text-ink-muted"
    />
  ) : null
}

function PinMatrix() {
  const rows = [
    {
      label: "Person",
      render: (state: AgentPinState) => (
        <span
          data-person-pin={state}
          className={cn(
            "inline-flex size-[22px] items-center justify-center rounded-[50%_50%_50%_14%] p-px",
            PERSON_RING[state]
          )}
        >
          <PersonAvatar person={you} />
        </span>
      ),
    },
    {
      label: "Implementer",
      render: (state: AgentPinState) => (
        <AgentAvatar agent={I1} size={20} pinState={state} />
      ),
    },
    {
      label: "Reviewer",
      render: (state: AgentPinState) => (
        <AgentAvatar agent={R1} size={20} pinState={state} />
      ),
    },
  ]
  return (
    <div className="flex flex-col gap-10">
      <div
        role="table"
        aria-label="Comment pin states by author"
        className="grid w-max grid-cols-[120px_repeat(5,72px)] items-center gap-x-4 gap-y-6 rounded-xl bg-surface p-5 shadow-[0_0_0_1px_var(--nv-line)]"
      >
        <span role="row" className="contents">
          <span role="columnheader" className="label-mono">
            Author
          </span>
          {PIN_STATES.map((state) => (
            <span key={state} role="columnheader" className="label-mono">
              {state}
            </span>
          ))}
        </span>
        {rows.map((row) => (
          <span key={row.label} role="row" className="contents">
            <span role="rowheader" className="text-[13px] text-ink-2">
              {row.label}
            </span>
            {PIN_STATES.map((state) => (
              <span
                key={state}
                role="cell"
                data-cell={`${row.label}-${state}`}
                className="inline-flex items-center gap-[5px]"
              >
                {row.render(state)}
                <ResolvedCheck state={state} />
              </span>
            ))}
          </span>
        ))}
      </div>
      <div className="flex flex-col gap-3">
        <span className="label-mono">
          Driven by the pin, no React state: data-pin-host
        </span>
        <div className="flex items-center gap-6 text-[13px] text-ink-2">
          <button
            type="button"
            data-pin-host=""
            aria-label="Comment by I1 (Tab here: focus raises the ring)"
            className="inline-flex size-[22px] items-center justify-center border-0 bg-transparent p-0 outline-hidden"
          >
            <AgentAvatar agent={I1} size={20} />
          </button>
          <button
            type="button"
            data-pin-host=""
            aria-expanded="true"
            aria-label="Comment by R1, open"
            className="inline-flex size-[22px] items-center justify-center border-0 bg-transparent p-0 outline-hidden"
          >
            <AgentAvatar agent={R1} size={20} />
          </button>
          <span>Hover either one with a real pointer.</span>
        </div>
      </div>
    </div>
  )
}

const settled = (raised: boolean) => ({
  opacity: raised ? "1" : "0",
  tip: raised ? "matrix(1, 0, 0, 1, 0, -1.6)" : "none",
  ant: raised ? "matrix(1, 0, 0, 1.32, 0, 0)" : "none",
})

function antennaOf(svg: SVGSVGElement) {
  return {
    opacity: getComputedStyle(svg.querySelector(".nv-pinring")!).opacity,
    tip: getComputedStyle(svg.querySelector(".nv-tip")!).transform,
    ant: getComputedStyle(svg.querySelector(".nv-ant")!).transform,
  }
}

async function expectPinMatrix(canvasElement: HTMLElement) {
  for (const row of ["Implementer", "Reviewer"])
    for (const state of PIN_STATES) {
      const svg = canvasElement.querySelector<SVGSVGElement>(
        `[data-cell="${row}-${state}"] svg[data-avatar="agent"]`
      )!
      await expect(svg.dataset.pin).toBe(state)
      const ring = svg.querySelector<SVGPathElement>(".nv-pinring")!
      await expect(ring.getAttribute("d")).toBe(PIN_RING_D)
      const raised = RAISED.includes(state)
      // The antenna rises on a spring; wait for it to settle.
      await waitFor(() => expect(antennaOf(svg)).toEqual(settled(raised)))
      if (raised)
        await expect(getComputedStyle(ring).strokeWidth).toBe(RING_WIDTH[state])
      // The avatar itself never changes: same body fill as at rest.
      const rest = canvasElement.querySelector<SVGSVGElement>(
        `[data-cell="${row}-rest"] svg`
      )!
      await expect(getComputedStyle(svg.querySelector("rect")!).fill).toBe(
        getComputedStyle(rest.querySelector("rect")!).fill
      )
    }
  // Resolved: no ring, a check beside every author.
  for (const row of ["Person", "Implementer", "Reviewer"])
    await expect(
      canvasElement.querySelector(
        `[data-cell="${row}-resolved"] [data-resolved]`
      )
    ).not.toBeNull()
  // Focus and open rings differ in colour; hover is line-strong.
  const stroke = (row: string, state: AgentPinState) =>
    getComputedStyle(
      canvasElement.querySelector(`[data-cell="${row}-${state}"] .nv-pinring`)!
    ).stroke
  await expect(stroke("Implementer", "focus")).not.toBe(
    stroke("Implementer", "open")
  )
  await expect(stroke("Implementer", "hover")).not.toBe(
    stroke("Implementer", "open")
  )
}

/**
 * Comment pins on person and agent authors across rest, hover, focus,
 * open and resolved (forced here). On an agent the ring sits just outside
 * the dashed edge and the antenna rises to clear it; resolved is the plain
 * avatar with a check beside it. The second row is driven by real focus
 * and aria-expanded through `data-pin-host`.
 */
export const PinStates: Story = {
  render: () => <PinMatrix />,
  play: async ({ canvas, canvasElement }) => {
    await expectPinMatrix(canvasElement)
    // Real keyboard focus on a host raises its avatar's antenna and ring.
    const host = canvas.getByRole("button", { name: /Comment by I1/ })
    const svg = host.querySelector<SVGSVGElement>("svg")!
    await expect(antennaOf(svg)).toEqual(settled(false))
    await userEvent.tab()
    await expect(host).toHaveFocus()
    await waitFor(() => expect(antennaOf(svg)).toEqual(settled(true)))
    await expect(
      getComputedStyle(svg.querySelector(".nv-pinring")!).strokeWidth
    ).toBe("1.8px")
    host.blur()
    await waitFor(() => expect(antennaOf(svg)).toEqual(settled(false)))
    // aria-expanded="true" on the host is the open state.
    const open = canvas.getByRole("button", { name: /Comment by R1, open/ })
    await waitFor(() =>
      expect(antennaOf(open.querySelector("svg")!)).toEqual(settled(true))
    )
  },
}

export const PinStatesDark: Story = {
  render: () => <PinMatrix />,
  globals: { theme: "dark" },
  play: async ({ canvasElement }) => expectPinMatrix(canvasElement),
}

/**
 * Reduced motion (the toolbar's Reduced motion, set by this story): the ring
 * and the raised antenna appear instantly. With full motion the ring fades
 * in over 140ms and the antenna moves on SPRING.snappy.
 */
export const PinStatesReducedMotion: Story = {
  render: () => <PinMatrix />,
  globals: { reducedMotion: "reduce" },
  play: async ({ canvasElement }) => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    await expect(reduce).toBe(true)
    const svg = canvasElement.querySelector<SVGSVGElement>(
      '[data-cell="Implementer-hover"] svg'
    )!
    const ring = getComputedStyle(svg.querySelector(".nv-pinring")!)
    const tip = getComputedStyle(svg.querySelector(".nv-tip")!)
    if (reduce) {
      await expect(ring.transitionDuration).toBe("0s")
      await expect(tip.transitionDuration).toBe("0s")
    } else {
      await expect(ring.transitionDuration).toBe(`${ms(TIMING.pinRing)}s`)
      await expect(tip.transitionTimingFunction).toMatch(/^linear\(/)
    }
    await expectPinMatrix(canvasElement)
  },
}
