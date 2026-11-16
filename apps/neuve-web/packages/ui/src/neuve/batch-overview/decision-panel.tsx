/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD — Decision panel
 *
 *  rest    one square per human-required unit: an outlined diamond while it
 *          waits, its verdict once a person decides it
 *    0ms   a decision arrives (live update): the square's verdict pops in,
 *          scale .96 → 1, opacity 0 → 1 (snappy spring); the waiting
 *          diamond leaves at once
 *    0ms   a square or the action is hovered (real pointer hover): tone
 *          shift (surfaceTone 120ms); the action's arrow nudges (nudge)
 *
 * Nothing moves on first paint. Reduced motion: the verdict fades in
 * (reduced 150ms); no tone transition. A square for a unit an agent
 * requested changes on is still: its verdict is the agent's and does not
 * arrive live.
 * ───────────────────────────────────────────────────────── */

import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { ArrowRightIcon } from "lucide-react"

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { REDUCED_TRANSITION, SCALE, SPRING } from "@workspace/ui/lib/motion"
import { cn } from "@workspace/ui/lib/utils"
import { LaneCounts } from "@workspace/ui/neuve/batch-overview/lane-bar"
import { LaneGlyph } from "@workspace/ui/neuve/shared/lane-glyph"
import { NeuveLink } from "@workspace/ui/neuve/shared/nav-link"
import { VerdictIcon } from "@workspace/ui/neuve/shared/review-mark"
import type { ReviewVerdict } from "@workspace/ui/neuve/shared/review-mark"
import type {
  AgentChangesUnit,
  BatchOverviewData,
  OverviewUnit,
} from "@workspace/ui/neuve/types"

const STROKE = 1.75
const VERDICT = {
  initial: { opacity: 0, scale: SCALE.pop },
  transition: SPRING.snappy,
} as const

const VERDICT_WORDS: Record<ReviewVerdict, string> = {
  approved: "approved",
  changes_requested: "changes requested",
}

/**
 * The batch's human-required units in its order, each with the person's
 * review once one stands. Without `units` (older hosts), the waiting units
 * come first, then the decided ones.
 */
export function humanRequired(data: BatchOverviewData): Array<OverviewUnit> {
  if (data.units)
    return data.units.filter((unit) => unit.lane === "human-required")
  return [
    ...data.judgment.map((unit) => ({
      id: unit.id,
      title: unit.title,
      lane: "human-required" as const,
    })),
    ...(data.decided ?? []).map((unit) => ({
      id: unit.id,
      title: unit.title,
      lane: "human-required" as const,
      review: unit.review,
    })),
  ]
}

/** Whether nothing in the batch waits on a person's decision. */
export function isSettled(data: BatchOverviewData) {
  return data.needYou === 0
}

/**
 * The units an agent requested changes on that no person has decided, when
 * nothing waits on you: the panel names them instead of an outcome. Empty
 * while units wait on you; the panel is as before then.
 */
export function agentChangesShown(
  data: BatchOverviewData
): ReadonlyArray<AgentChangesUnit> {
  return isSettled(data) ? (data.agentChanges ?? []) : []
}

/**
 * The headline over units an agent requested changes on. One unit has one
 * review, so one agent. Several name their agents only when the packet says
 * who each is: "Agents" when two differ, "An agent" when one; while any
 * unit's agent is unknown, the words count no agents.
 */
function agentChangesHeadline(units: ReadonlyArray<AgentChangesUnit>) {
  const count = `${units.length} ${units.length === 1 ? "unit" : "units"}`
  if (units.length === 1) return `An agent requested changes on ${count}`
  if (units.some((unit) => unit.agentId === undefined))
    return `Changes were requested on ${count}`
  const agents = new Set(units.map((unit) => unit.agentId)).size
  return `${agents > 1 ? "Agents" : "An agent"} requested changes on ${count}`
}

function GateCell({ unit }: { unit: OverviewUnit }) {
  const reduce = useReducedMotion()
  const verdict = unit.review?.verdict
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <NeuveLink
          destination={{ to: "unit", unitId: unit.id }}
          aria-label={`${unit.title}, ${verdict ? VERDICT_WORDS[verdict] : "waiting on you"}`}
          className={cn(
            "flex size-7 items-center justify-center rounded-[7px] no-underline transition-colors duration-surface-tone ease-standard motion-reduce:transition-none",
            verdict
              ? "bg-paper shadow-[0_0_0_1px_var(--nv-line)] hover:bg-raised"
              : "bg-req-tint shadow-[0_0_0_1px_var(--nv-req-tint-2)] hover:bg-req-tint-2"
          )}
        >
          <AnimatePresence initial={false} mode="popLayout">
            {verdict ? (
              <motion.span
                key={verdict}
                initial={reduce ? { opacity: 0 } : VERDICT.initial}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, transition: { duration: 0 } }}
                transition={reduce ? REDUCED_TRANSITION : VERDICT.transition}
                className="flex"
              >
                <VerdictIcon verdict={verdict} />
              </motion.span>
            ) : (
              <motion.span
                key="waiting"
                exit={{ opacity: 0, transition: { duration: 0 } }}
                className="flex"
              >
                <LaneGlyph lane="human-required" outline />
              </motion.span>
            )}
          </AnimatePresence>
        </NeuveLink>
      </TooltipTrigger>
      <TooltipContent side="top">{unit.title}</TooltipContent>
    </Tooltip>
  )
}

/** A unit an agent requested changes on, as a square that opens it. */
function AgentChangesCell({ unit }: { unit: AgentChangesUnit }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <NeuveLink
          destination={{ to: "unit", unitId: unit.id }}
          aria-label={`${unit.title}, changes requested by an agent`}
          className="flex size-7 items-center justify-center rounded-[7px] bg-paper no-underline shadow-[0_0_0_1px_var(--nv-line)] transition-colors duration-surface-tone ease-standard hover:bg-raised motion-reduce:transition-none"
        >
          <VerdictIcon verdict="changes_requested" />
        </NeuveLink>
      </TooltipTrigger>
      <TooltipContent side="top">{unit.title}</TooltipContent>
    </Tooltip>
  )
}

/** "2 changes requested · 2 approved", the verdict icons leading. */
function Outcome({ units }: { units: ReadonlyArray<OverviewUnit> }) {
  const changes = units.filter(
    (unit) => unit.review?.verdict === "changes_requested"
  ).length
  const approved = units.filter(
    (unit) => unit.review?.verdict === "approved"
  ).length
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      {changes > 0 && (
        <span className="inline-flex items-center gap-2">
          <VerdictIcon verdict="changes_requested" className="size-4" />
          {changes === units.length && changes > 1
            ? `All ${changes} changes requested`
            : `${changes} ${changes === 1 ? "change" : "changes"} requested`}
        </span>
      )}
      {changes > 0 && approved > 0 && (
        // On a phone the two counts stack, so the dot would end a line.
        <span
          aria-hidden="true"
          className="font-normal text-faint max-[600px]:hidden"
        >
          ·
        </span>
      )}
      {approved > 0 && (
        <span
          className={cn(
            "inline-flex items-center gap-2",
            changes > 0 && "font-normal text-ink-2"
          )}
        >
          <VerdictIcon verdict="approved" className="size-4" />
          {changes === 0 && approved > 1
            ? `All ${approved} approved`
            : `${approved} approved`}
        </span>
      )}
    </span>
  )
}

function Headline({
  data,
  units,
  agentChanges,
}: {
  data: BatchOverviewData
  units: ReadonlyArray<OverviewUnit>
  agentChanges: ReadonlyArray<AgentChangesUnit>
}) {
  const decided = units.length - data.needYou
  if (agentChanges.length > 0) return <>{agentChangesHeadline(agentChanges)}</>
  if (units.length === 0) return <>Nothing here needs your decision</>
  if (data.needYou === 0) return <Outcome units={units} />
  if (decided === 0)
    return (
      <>
        {data.needYou} {data.needYou === 1 ? "needs" : "need"} your decision
      </>
    )
  return (
    <>
      {data.needYou} of {units.length} still need you
    </>
  )
}

function Action({ data }: { data: BatchOverviewData }) {
  const decided = humanRequired(data).length - data.needYou
  const quiet = isSettled(data)
  // With nothing waiting on you, the first unit an agent requested changes
  // on, when there is one.
  const unitId = agentChangesShown(data).at(0)?.id ?? data.firstUnitId
  const label = quiet
    ? "Open review desk"
    : decided > 0
      ? "Continue review"
      : "Start review"
  return (
    <NeuveLink
      destination={{ to: "unit", unitId }}
      className={cn(
        "group/cta inline-flex h-11 shrink-0 items-center gap-2.5 rounded-[10px] px-[18px] text-sm font-medium no-underline transition-colors duration-surface-tone ease-standard motion-reduce:transition-none",
        quiet
          ? "bg-raised text-ink hover:bg-raised-2 hover:text-ink"
          : "bg-ink text-paper hover:bg-ink/90 hover:text-paper"
      )}
    >
      {label}
      <ArrowRightIcon
        aria-hidden="true"
        className="size-[15px] transition-transform duration-nudge ease-ios-out group-hover/cta:translate-x-(--nv-offset-nudge) motion-reduce:transition-none"
        strokeWidth={STROKE}
      />
    </NeuveLink>
  )
}

/**
 * The human gate at the top of the overview: a square per human-required
 * unit (each opens its unit), one headline and one action, by state. Once
 * nothing waits it is the outcome, and the lane split sits in its foot;
 * while an agent's request for changes no person has decided stands, it
 * names those units instead of the outcome.
 */
export function DecisionPanel({ data }: { data: BatchOverviewData }) {
  const units = humanRequired(data)
  const settled = isSettled(data)
  const agentChanges = agentChangesShown(data)
  return (
    <section
      aria-label="Your decisions"
      className="flex flex-col gap-4 rounded-[16px] bg-surface p-5 shadow-[0_0_0_1px_var(--nv-line)] max-[600px]:p-4"
    >
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="flex min-w-0 flex-col gap-3">
          <p
            aria-live="polite"
            className="m-0 text-[22px] leading-7 font-semibold tracking-[-0.02em] text-pretty"
          >
            <Headline data={data} units={units} agentChanges={agentChanges} />
          </p>
          {agentChanges.length > 0 ? (
            <TooltipProvider delayDuration={300}>
              <ul
                aria-label="Units an agent requested changes on"
                className="m-0 flex list-none flex-wrap gap-1.5 p-0"
              >
                {agentChanges.map((unit) => (
                  <li key={unit.id}>
                    <AgentChangesCell unit={unit} />
                  </li>
                ))}
              </ul>
            </TooltipProvider>
          ) : (
            units.length > 0 && (
              <TooltipProvider delayDuration={300}>
                <ul
                  aria-label="Human-required units"
                  className="m-0 flex list-none flex-wrap gap-1.5 p-0"
                >
                  {units.map((unit) => (
                    <li key={unit.id}>
                      <GateCell unit={unit} />
                    </li>
                  ))}
                </ul>
              </TooltipProvider>
            )
          )}
        </div>
        <Action data={data} />
      </div>
      {settled && data.lanes.some((lane) => lane.count > 0) && (
        <div className="border-t border-line-2 pt-3">
          <LaneCounts
            lanes={data.lanes}
            {...(data.notRead ? { notRead: data.notRead } : {})}
          />
        </div>
      )}
    </section>
  )
}
