/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD — Unit rows
 *
 *  rest    one row per unit, grouped by lane: glyph and title (a unit
 *          whose lane rose since the last run adds a muted up arrow after
 *          it), the
 *          review that stands, the unmet checkpoint count, an arrow
 *    0ms   a row is hovered (real pointer hover): tone shift (surfaceTone,
 *          standard); its arrow nudges (nudge, iOS out)
 *
 * Reduced motion: no tone or nudge transition.
 * ───────────────────────────────────────────────────────── */

import { useId } from "react"
import type * as React from "react"
import { ArrowRightIcon } from "lucide-react"

import { cn } from "@workspace/ui/lib/utils"
import { humanRequired } from "@workspace/ui/neuve/batch-overview/decision-panel"
import {
  JudgmentTable,
  SECTION_HEADING,
} from "@workspace/ui/neuve/batch-overview/judgment-table"
import {
  CheckpointCount,
  ROW_FOCUS,
  ROW_LINK,
} from "@workspace/ui/neuve/batch-overview/checkpoint-count"
import {
  MovedUpTip,
  UntitledOnOneLine,
  useMovedUpFocus,
} from "@workspace/ui/neuve/batch-overview/unit-name"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { Disclosure } from "@workspace/ui/neuve/shared/disclosure"
import { excludedWords } from "@workspace/ui/neuve/shared/lane-facts"
import { LaneGlyph } from "@workspace/ui/neuve/shared/lane-glyph"
import { NeuveLink } from "@workspace/ui/neuve/shared/nav-link"
import { ReviewMark } from "@workspace/ui/neuve/shared/review-mark"
import type {
  BatchOverviewData,
  OverviewUnit,
  ReviewLane,
  UnitCheckpoints,
  UnitExclusion,
} from "@workspace/ui/neuve/types"

const STROKE = 1.75

/* ── One unit row ─────────────────────────────────────────── */

/**
 * A unit no agent read: its state in words, and the rule that marked it as
 * a tooltip on real hover or keyboard focus, which also describes the mark
 * to screen readers, once.
 */
function NotReadMark({ excluded }: { excluded: UnitExclusion }) {
  const words = excludedWords(excluded)
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            data-not-read=""
            className="rounded-sm text-[13px] leading-5 text-ink-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            {words.state}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">{words.rule}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function UnitRow({
  unit,
  checkpoints,
}: {
  unit: OverviewUnit
  checkpoints: UnitCheckpoints | undefined
}) {
  const markId = `${useId()}moved-up`
  const movedUp = useMovedUpFocus(unit.raisedFrom && markId)
  return (
    <div
      className={cn(
        "group/row relative grid min-h-12 grid-cols-[minmax(0,1fr)_auto_112px_15px] items-center gap-4 px-5 py-2 transition-colors duration-surface-tone ease-standard hover:bg-raised motion-reduce:transition-none max-[600px]:grid-cols-[minmax(0,1fr)_15px] max-[600px]:gap-x-3 max-[600px]:gap-y-1",
        ROW_FOCUS
      )}
    >
      <span className="flex min-w-0 items-center gap-2.5 text-[14px] font-medium">
        <LaneGlyph lane={unit.lane} className="shrink-0" />
        <NeuveLink
          data-row-link=""
          destination={{ to: "unit", unitId: unit.id }}
          aria-describedby={unit.raisedFrom ? markId : undefined}
          {...movedUp}
          className={cn(ROW_LINK, "min-w-0 text-pretty")}
        >
          {unit.untitled ? (
            <UntitledOnOneLine title={unit.title} files={unit.untitled.files} />
          ) : (
            unit.title
          )}
        </NeuveLink>
        {/* After the title, so every row's title starts on one line. */}
        {unit.raisedFrom && <MovedUpTip id={markId} from={unit.raisedFrom} />}
      </span>
      <span className="flex justify-end max-[600px]:col-start-1 max-[600px]:row-start-2 max-[600px]:justify-start max-[600px]:pl-5">
        {unit.review ? (
          <ReviewMark
            size={16}
            actor={unit.review.actor}
            verdict={unit.review.verdict}
            {...(unit.review.carried ? { carried: unit.review.carried } : {})}
            className="text-[13px]"
          />
        ) : (
          unit.excluded && <NotReadMark excluded={unit.excluded} />
        )}
      </span>
      <span className="flex justify-end max-[600px]:col-start-1 max-[600px]:row-start-3 max-[600px]:justify-start max-[600px]:pl-5">
        <CheckpointCount checkpoints={checkpoints} />
      </span>
      <ArrowRightIcon
        aria-hidden="true"
        strokeWidth={STROKE}
        className="size-[15px] shrink-0 text-faint transition-[transform,color] duration-nudge ease-ios-out group-hover/row:translate-x-(--nv-offset-nudge) group-hover/row:text-ink motion-reduce:transition-none max-[600px]:col-start-2 max-[600px]:row-start-1"
      />
    </div>
  )
}

function UnitRows({
  units,
  checkpoints,
}: {
  units: ReadonlyArray<OverviewUnit>
  checkpoints: Readonly<Partial<Record<string, UnitCheckpoints>>>
}) {
  return (
    <ul className="m-0 list-none overflow-hidden rounded-[14px] bg-surface p-0 shadow-[0_0_0_1px_var(--nv-line)]">
      {units.map((unit, i) => (
        <li key={unit.id} className={cn(i > 0 && "border-t border-line-2")}>
          <UnitRow unit={unit} checkpoints={checkpoints[unit.id]} />
        </li>
      ))}
    </ul>
  )
}

/* ── The units, grouped by lane ───────────────────────────── */

const OTHER_LANES: ReadonlyArray<Exclude<ReviewLane, "human-required">> = [
  "human-suggested",
  "agentic-review",
  "static-automation",
]

function Group({
  label,
  lane,
  count,
  open,
  children,
}: {
  label: string
  lane: ReviewLane
  count: number
  open: boolean
  children: React.ReactNode
}) {
  return (
    <Disclosure
      defaultOpen={open}
      label={<h3 className="m-0 text-[14px] font-medium text-ink">{label}</h3>}
      count={count}
      leading={<LaneGlyph lane={lane} className="size-[9px] shrink-0" />}
      summaryClassName="-ml-2.5 w-fit"
      contentClassName="px-0 pt-1 pb-0"
    >
      {children}
    </Disclosure>
  )
}

/**
 * The batch's units by lane: the ones that need your decision, the ones you
 * decided, then the lanes agents and checks decide. Every row carries its
 * unit's lane, the review that stands and how many of its checkpoints are
 * unmet.
 */
export function UnitList({ data }: { data: BatchOverviewData }) {
  const headingId = useId()
  const checkpoints = data.checkpoints ?? {}
  const decided = humanRequired(data).filter((unit) => unit.review)
  const waiting = data.needYou > 0
  const lanes = OTHER_LANES.map((lane) => ({
    lane,
    name: data.lanes.find((entry) => entry.lane === lane)?.name ?? lane,
    units: (data.units ?? []).filter((unit) => unit.lane === lane),
  })).filter((entry) => entry.units.length > 0)
  if (data.judgment.length === 0 && decided.length === 0 && lanes.length === 0)
    return null
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className={SECTION_HEADING}>
        Units
      </h2>
      <div className="flex flex-col gap-1">
        {data.judgment.length > 0 && (
          <Group
            label="Needs your decision"
            lane="human-required"
            count={data.judgment.length}
            open
          >
            <JudgmentTable units={data.judgment} checkpoints={checkpoints} />
          </Group>
        )}
        {decided.length > 0 && (
          <Group
            label="Decided"
            lane="human-required"
            count={decided.length}
            open={!waiting}
          >
            <UnitRows units={decided} checkpoints={checkpoints} />
          </Group>
        )}
        {lanes.map((entry) => (
          <Group
            key={entry.lane}
            label={entry.name}
            lane={entry.lane}
            count={entry.units.length}
            open={false}
          >
            <UnitRows units={entry.units} checkpoints={checkpoints} />
          </Group>
        ))}
      </div>
    </section>
  )
}
