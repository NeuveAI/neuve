import {
  EASE,
  SPRING,
  TIMING,
  cssBezier,
  cssSpring,
} from "@workspace/ui/lib/motion"
import { cn } from "@workspace/ui/lib/utils"
import type { AvatarSize } from "@workspace/ui/neuve/shared/person-avatar"
import type { AgentRole, BranchAgent } from "@workspace/ui/neuve/types"

/**
 * An agent's avatar (changes/round-4.md § Review identity, Verdicts.dc.html):
 * one SVG on a 24 × 29.2 grid (viewBox 0 -1.2 24 29.2), so the antenna, the
 * dashed edge and the id scale together at every size.
 *
 *   antenna  rod 12,1.4 → 12,6.4 (0.85, round caps); ball r 1.7 at 12,1.2
 *   body     20 × 20 at 2,6, radius 5.5, in the role tint
 *   edge     an OPEN dashed path outside the fill that leaves a 3.6 opening
 *            under the antenna, then 16 even dashes (2.619 / 1.964); the
 *            dash values are SVG attributes, never CSS; stroke 1, opacity .5
 *   id       Geist Mono 8.6 / 600, centred at y 16.3
 *   offset   shifted up 10% so the body, not the antenna, aligns with the
 *            text beside it
 *
 * Role carries the tint: implementers ocean-green, reviewers golden-grass.
 * Identity never changes with placement (size only) or state: nothing is
 * attached to the avatar. Connection status lives beside it (the agents
 * popover's dot and label; the header's "N agents · M live").
 *
 * ANIMATION STORYBOARD: comment pin states (round-4.md § Comment pins,
 * Verdicts.dc.html "Comment pins · state around the avatar")
 *
 *    0ms   hover / focus / open: a ring fades in just OUTSIDE the dashed
 *          edge, with the same opening under the antenna (140ms, standard
 *          decelerate): line-strong 1.4 · focus 1.8 · ink 1.8
 *    0ms   the antenna ball rises 1.6 and the rod stretches to follow
 *          (scaleY 1.32 from its base at y 6.4) on SPRING.snappy, as a CSS
 *          linear() spring, so the antenna clears the ring
 *  leave   ring fades out and the antenna settles (100ms, accelerate)
 *  resolved  no ring: just the dashed edge (the pin puts a check beside it)
 *
 * Reduced motion: the ring and the raised antenna appear instantly.
 */
const ROLE_STYLE: Record<AgentRole, { body: string; ink: string }> = {
  implementer: { body: "fill-agt-tint", ink: "text-agt-fg" },
  reviewer: { body: "fill-sug-tint", ink: "text-sug-ink" },
}

/** Width × height of the 24 × 29.2 grid at each placement size. */
const AGENT_SIZE: Record<AvatarSize, string> = {
  16: "h-[19.47px] w-4",
  20: "h-[24.33px] w-5",
  24: "h-[29.2px] w-6",
}

/**
 * A comment pin's state around the avatar. Rest and resolved draw nothing;
 * the pin owns the check beside a resolved avatar.
 */
export type AgentPinState = "rest" | "hover" | "focus" | "open" | "resolved"

/** Ring fade in / out (ms): round-4.md § Comment pins. */
const PIN_RING = { enter: TIMING.pinRing, exit: TIMING.pinRingExit } as const

/**
 * SPRING.snappy as a CSS `linear()` easing and its settle time, so the
 * antenna moves on the same spring as the motion/react surfaces without
 * React state (hover and focus stay pure CSS).
 */
const ANTENNA = cssSpring(SPRING.snappy)

const AGENT = 'svg[data-avatar="agent"]'
/** Raised by the avatar's own `pinState`, or by a `[data-pin-host]` ancestor. */
const RAISED = {
  hover: [
    `${AGENT}[data-pin="hover"][data-pin]`,
    `@hover [data-pin-host]:hover ${AGENT}`,
  ],
  focus: [
    `${AGENT}[data-pin="focus"][data-pin]`,
    `[data-pin-host]:focus-visible ${AGENT}`,
  ],
  open: [
    `${AGENT}[data-pin="open"][data-pin]`,
    `[data-pin-host][aria-expanded="true"] ${AGENT}`,
  ],
} as const
const RING = {
  hover: "stroke:var(--nv-line-strong);stroke-width:1.4",
  focus: "stroke:var(--nv-focus);stroke-width:1.8",
  open: "stroke:var(--nv-ink);stroke-width:1.8",
} as const

function rule(selectors: ReadonlyArray<string>, child: string, body: string) {
  return selectors
    .map((selector) =>
      selector.startsWith("@hover ")
        ? `@media (hover:hover){${selector.slice(7)} ${child}{${body}}}`
        : `${selector} ${child}{${body}}`
    )
    .join("\n")
}

/**
 * Pin state CSS, hoisted once (React 19 style precedence). Every raised
 * selector has the same specificity, so the order decides: hover, then
 * focus, then open. Stroke and dash values stay SVG attributes elsewhere.
 */
const PIN_CSS = [
  `${AGENT} .nv-pinring{fill:none;stroke:var(--nv-line-strong);stroke-width:1.4;opacity:0;transition:opacity ${PIN_RING.exit}ms ${cssBezier(EASE.standardAccelerate)},stroke ${PIN_RING.exit}ms,stroke-width ${PIN_RING.exit}ms}`,
  `${AGENT} .nv-tip,${AGENT} .nv-ant{transform-box:view-box;transition:transform ${PIN_RING.exit}ms ${cssBezier(EASE.standardAccelerate)}}`,
  `${AGENT} .nv-ant{transform-origin:12px 6.4px}`,
  ...(["hover", "focus", "open"] as const).flatMap((state) => [
    rule(
      RAISED[state],
      ".nv-pinring",
      `${RING[state]};opacity:1;transition:opacity ${PIN_RING.enter}ms ${cssBezier(EASE.standardDecelerate)}`
    ),
    rule(
      RAISED[state],
      ".nv-tip",
      `transform:translateY(-1.6px);transition:transform ${ANTENNA.duration}ms ${ANTENNA.easing}`
    ),
    rule(
      RAISED[state],
      ".nv-ant",
      `transform:scaleY(1.32);transition:transform ${ANTENNA.duration}ms ${ANTENNA.easing}`
    ),
  ]),
  `@media (prefers-reduced-motion:reduce){${AGENT} .nv-pinring,${AGENT} .nv-tip,${AGENT} .nv-ant{transition:none!important}}`,
].join("\n")

/** The open edge: starts right of the antenna, ends left of it. */
const EDGE_PATH =
  "M13.8 5.3H16.5A6.2 6.2 0 0 1 22.7 11.5V20.5A6.2 6.2 0 0 1 16.5 26.7H7.5A6.2 6.2 0 0 1 1.3 20.5V11.5A6.2 6.2 0 0 1 7.5 5.3H10.2"

/** A comment pin's ring, just outside the edge, with the same opening. */
const PIN_RING_PATH =
  "M14.4 3.9H16.9A7.6 7.6 0 0 1 24.1 11.1V20.9A7.6 7.6 0 0 1 16.9 28.1H7.1A7.6 7.6 0 0 1 -0.1 20.9V11.1A7.6 7.6 0 0 1 7.1 3.9H9.6"

export function AgentAvatar({
  agent,
  size = 24,
  pinState,
  label,
  className,
}: {
  agent: Pick<BranchAgent, "short" | "role">
  /** 24 header agents control · 20 review cards, threads, margin · 16 rail. */
  size?: AvatarSize
  /**
   * A comment pin's state, drawn around the avatar. A pin can instead mark
   * itself `data-pin-host`: its real hover, focus-visible and
   * aria-expanded="true" then raise the ring with no React state.
   */
  pinState?: AgentPinState
  /** Accessible name when no visible name sits beside the avatar. */
  label?: string
  className?: string
}) {
  const role = ROLE_STYLE[agent.role]
  return (
    <>
      {/* Hoisted to <head> once (not inside the SVG namespace). */}
      <style href="nv-agent-pin" precedence="default">
        {PIN_CSS}
      </style>
      <svg
        viewBox="0 -1.2 24 29.2"
        {...(label
          ? { role: "img", "aria-label": label }
          : { "aria-hidden": true })}
        focusable="false"
        data-avatar="agent"
        data-role={agent.role}
        data-size={size}
        data-pin={pinState}
        className={cn(
          "inline-block shrink-0 -translate-y-[10%] overflow-visible select-none",
          AGENT_SIZE[size],
          role.ink,
          className
        )}
      >
        <line
          className="nv-ant"
          x1="12"
          y1="1.4"
          x2="12"
          y2="6.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="0.85"
          strokeLinecap="round"
        />
        <circle
          className="nv-tip"
          cx="12"
          cy="1.2"
          r="1.7"
          fill="currentColor"
        />
        <rect
          x="2"
          y="6"
          width="20"
          height="20"
          rx="5.5"
          className={role.body}
        />
        <path
          d={EDGE_PATH}
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
          strokeLinecap="butt"
          strokeDasharray="2.619 1.964"
          opacity="0.5"
        />
        <path className="nv-pinring" d={PIN_RING_PATH} />
        <text
          x="12"
          y="16.3"
          fill="currentColor"
          fontSize="8.6"
          fontWeight="600"
          textAnchor="middle"
          dominantBaseline="central"
          className="font-mono"
        >
          {agent.short}
        </text>
      </svg>
    </>
  )
}

/**
 * The agent on rail units and judgment rows: its 16px avatar. The id stays
 * in the row's accessible name; the full name and scope show on hover.
 */
export function AgentTag({
  agent,
  className,
}: {
  agent: Pick<BranchAgent, "short" | "role" | "name" | "scope">
  className?: string
}) {
  return (
    <span
      title={`${agent.name} · ${agent.scope.label}`}
      className={cn("inline-flex shrink-0 items-center", className)}
    >
      <AgentAvatar agent={agent} size={16} label={agent.short} />
    </span>
  )
}
