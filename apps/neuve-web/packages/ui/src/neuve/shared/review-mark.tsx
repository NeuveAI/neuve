import type * as React from "react"

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"
import { AgentAvatar } from "@workspace/ui/neuve/agents/agent-avatar"
import { PersonAvatar } from "@workspace/ui/neuve/shared/person-avatar"
import type {
  AvatarPerson,
  AvatarSize,
} from "@workspace/ui/neuve/shared/person-avatar"
import type { BranchAgent } from "@workspace/ui/neuve/types"

/**
 * A review as a mark (changes/round-4.md § Review identity):
 *
 *   sent     [avatar] [icon] R1 approved · You approved · R1 requested changes
 *   unsent   ┆[icon] Suggested · request changes┆   dashed edge, no avatar
 *
 * The verdict colour goes on the icon only: a check in agt, a cross in req.
 * The words stay in ink. No fill, no chip. Provenance ("R1 · reviewer agent
 * · agentic review · a3f9c2e") shows on demand: hovering or keyboard-focusing
 * the avatar. It is never a subheading.
 */
export type ReviewVerdict = "approved" | "changes_requested"

export type ReviewActor =
  | { kind: "agent"; agent: Pick<BranchAgent, "short" | "role" | "name"> }
  | { kind: "person"; person: AvatarPerson; isYou?: boolean }

interface ReviewMarkBase {
  /** Explicit prior-review attribution, shown beside the verdict and in provenance. */
  carried?: string
  verdict: ReviewVerdict
  /** Avatar size by placement: 20 in cards (default), 16 in the rail. */
  size?: AvatarSize
  /** Avatar and icon only; the words stay for assistive technology. */
  compact?: boolean
  className?: string
}

export type ReviewMarkProps = ReviewMarkBase &
  (
    | {
        /** Sent (default): the actor's avatar leads the mark. */
        sent?: true
        actor: ReviewActor
        /** Shown in a tooltip on avatar hover or keyboard focus. */
        provenance?: string
        /** The provenance button, for a jump that lands focus on the mark. */
        triggerRef?: React.Ref<HTMLButtonElement>
        /**
         * Controls the provenance tooltip (a jump opens it on arrival).
         * Omitted, the tooltip keeps its own state.
         */
        provenanceOpen?: boolean
        /** Every open or close the tooltip asks for (hover, focus, dismiss). */
        onProvenanceOpenChange?: (open: boolean) => void
      }
    | {
        /** A suggested review not sent yet: dashed edge, no avatar. */
        sent: false
        actor?: undefined
        provenance?: undefined
        triggerRef?: undefined
        provenanceOpen?: undefined
        onProvenanceOpenChange?: undefined
      }
  )

const VERB: Record<ReviewVerdict, { sent: string; suggested: string }> = {
  approved: { sent: "approved", suggested: "approve" },
  changes_requested: {
    sent: "requested changes",
    suggested: "request changes",
  },
}

const ROLE_NAME = {
  implementer: "implementer agent",
  reviewer: "reviewer agent",
} as const

/** "R1", "You" or the person's name: the subject of the words. */
export function reviewActorShort(actor: ReviewActor): string {
  if (actor.kind === "agent") return actor.agent.short
  return actor.isYou ? "You" : actor.person.name
}

/**
 * The avatar's accessible name: "R1, reviewer agent", "You, Vinicius". A
 * viewer whose name is already "You" (or missing) is plain "You".
 */
export function reviewActorLabel(actor: ReviewActor): string {
  if (actor.kind === "agent")
    return `${actor.agent.short}, ${ROLE_NAME[actor.agent.role]}`
  if (!actor.isYou) return actor.person.name
  const name = actor.person.name.trim()
  return name === "" || name === "You" ? "You" : `You, ${name}`
}

/** Check (approved) or cross (changes requested), 12px, stroke 2.8. */
export function VerdictIcon({
  verdict,
  className,
}: {
  verdict: ReviewVerdict
  className?: string
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      data-verdict-icon={verdict}
      fill="none"
      strokeWidth="2.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn(
        "size-3 shrink-0",
        verdict === "approved" ? "stroke-agt" : "stroke-req",
        className
      )}
    >
      <path
        d={verdict === "approved" ? "M20 6 9 17l-5-5" : "M18 6 6 18M6 6l12 12"}
      />
    </svg>
  )
}

/** The actor's avatar, unchanged by state; never focusable on its own. */
export function ReviewActorAvatar({
  actor,
  size = 20,
  label,
}: {
  actor: ReviewActor
  size?: AvatarSize
  label?: string
}) {
  return actor.kind === "agent" ? (
    <AgentAvatar agent={actor.agent} size={size} label={label} />
  ) : (
    <PersonAvatar person={actor.person} size={size} label={label} />
  )
}

/**
 * The avatar as the provenance trigger: a real button (keyboard-focusable,
 * named after the actor) with the shadcn tooltip. Focus opens it at once;
 * pointer hover after a short delay; Escape dismisses it. The focus ring
 * stays visible: no outline-none / outline-hidden, which in Tailwind v4 set
 * --tw-outline-style: none and so cancel focus-visible:outline-2.
 */
function ProvenanceAvatar({
  actor,
  size,
  provenance,
  triggerRef,
  open,
  onOpenChange,
}: {
  actor: ReviewActor
  size: AvatarSize
  provenance: string
  triggerRef: React.Ref<HTMLButtonElement> | undefined
  open: boolean | undefined
  onOpenChange: ((open: boolean) => void) | undefined
}) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip open={open} onOpenChange={onOpenChange}>
        <TooltipTrigger asChild>
          <button
            ref={triggerRef}
            type="button"
            aria-label={reviewActorLabel(actor)}
            data-provenance-trigger=""
            className="inline-flex shrink-0 cursor-default items-center justify-center rounded-[5px] border-0 bg-transparent p-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus focus-visible:outline-solid"
          >
            <ReviewActorAvatar actor={actor} size={size} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="font-mono text-[11px]">
          {provenance}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export function ReviewMark(props: ReviewMarkProps) {
  const { verdict, size = 20, compact = false, className } = props
  const words = compact ? "sr-only" : undefined
  if (props.sent === false) {
    return (
      <span
        data-review-mark=""
        data-verdict={verdict}
        data-sent="false"
        className={cn(
          "inline-flex items-center gap-[7px] rounded-[7px] border border-dashed border-line-strong px-[9px] py-0.5 text-[13.5px] leading-5 whitespace-nowrap text-ink",
          className
        )}
      >
        <VerdictIcon verdict={verdict} />
        <span className={words}>
          <b className="font-semibold">Suggested</b> · {VERB[verdict].suggested}
        </span>
      </span>
    )
  }
  const {
    actor,
    provenance,
    triggerRef,
    provenanceOpen,
    onProvenanceOpenChange,
  } = props
  return (
    <span
      data-review-mark=""
      data-verdict={verdict}
      data-sent="true"
      className={cn(
        "inline-flex items-center gap-[7px] text-[13.5px] leading-5 whitespace-nowrap text-ink",
        className
      )}
    >
      {provenance || props.carried ? (
        <ProvenanceAvatar
          actor={actor}
          size={size}
          provenance={props.carried ?? provenance ?? ""}
          triggerRef={triggerRef}
          open={provenanceOpen}
          onOpenChange={onProvenanceOpenChange}
        />
      ) : (
        <ReviewActorAvatar actor={actor} size={size} />
      )}
      <VerdictIcon verdict={verdict} />
      <span className={words}>
        {props.carried && <>Carried · </>}
        <b className="font-semibold">{reviewActorShort(actor)}</b>{" "}
        {VERB[verdict].sent}
      </span>
    </span>
  )
}
