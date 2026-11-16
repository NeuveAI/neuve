import {
  ArrowRightIcon,
  FileIcon,
  Link2Icon,
  TriangleAlertIcon,
} from "lucide-react"

import type { LucideIcon } from "lucide-react"
import { useId } from "react"
import type * as React from "react"
import { atom, useAtomValue, useSetAtom } from "jotai"

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"
import {
  CheckpointCount,
  ROW_FOCUS,
  ROW_LINK,
} from "@workspace/ui/neuve/batch-overview/checkpoint-count"
import { AgentTag } from "@workspace/ui/neuve/agents/agent-avatar"
import { agentByIdAtom } from "@workspace/ui/neuve/agents/atoms"
import {
  MovedUpTip,
  UntitledOnOneLine,
  useMovedUpFocus,
} from "@workspace/ui/neuve/batch-overview/unit-name"
import { NO_AGENT_DECISION } from "@workspace/ui/neuve/shared/lane-facts"
import { LaneGlyph } from "@workspace/ui/neuve/shared/lane-glyph"
import { NeuveLink } from "@workspace/ui/neuve/shared/nav-link"
import type { JudgmentUnit, UnitCheckpoints } from "@workspace/ui/neuve/types"

const ICON = "size-[15px] shrink-0"
const STROKE = 1.75
/** Fixed columns (Polish.dc.html): cells truncate, never collide. */
const ROW_GRID =
  "grid grid-cols-[minmax(0,1fr)_92px_168px_160px_20px] items-center gap-4 px-5 max-[900px]:grid-cols-[minmax(0,1fr)_20px]"
const COL = "max-[900px]:hidden"
const STAT =
  "inline-flex items-center gap-1.5 text-[13px] whitespace-nowrap text-ink-2"

/**
 * Cells whose text is clipped and whose tooltip shows: the hovered cell
 * (real pointer hover), or every clipped cell of the keyboard-focused row.
 */
const openTipsAtom = atom<ReadonlyArray<string>>([])

function isClipped(element: HTMLElement) {
  return element.scrollWidth > element.clientWidth
}

/** The clipped cells inside a row, by id. */
function clippedCells(row: HTMLElement) {
  return Array.from(row.querySelectorAll<HTMLElement>("[data-clip-id]"))
    .filter(isClipped)
    .map((element) => element.dataset.clipId ?? "")
}

/**
 * A fixed-width cell: icon and text on one line, ellipsis when it doesn't
 * fit. Only a clipped cell shows its full text in a tooltip, on real hover
 * or when its row has keyboard focus (review F10). The full text is always
 * in the DOM, so assistive tech reads it whole.
 */
function StatCell({
  id,
  icon: Icon,
  children,
  className,
}: {
  id: string
  icon: LucideIcon
  children: React.ReactNode
  className?: string
}) {
  const open = useAtomValue(openTipsAtom).includes(id)
  const setOpen = useSetAtom(openTipsAtom)
  return (
    <Tooltip
      open={open}
      // Escape (and Radix's other dismissals) close it (WCAG 1.4.13).
      onOpenChange={(next) => {
        if (!next) setOpen([])
      }}
    >
      <TooltipTrigger asChild>
        <span
          role="cell"
          onPointerEnter={(event) => {
            const text =
              event.currentTarget.querySelector<HTMLElement>("[data-clip-id]")
            if (event.pointerType === "mouse" && text && isClipped(text))
              setOpen([id])
          }}
          onPointerLeave={() => setOpen([])}
          className={cn(STAT, COL, "min-w-0", className)}
        >
          <Icon aria-hidden="true" className={ICON} strokeWidth={STROKE} />
          <span data-clip-id={id} className="min-w-0 truncate">
            {children}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{children}</TooltipContent>
    </Tooltip>
  )
}

function UnitRow({
  unit,
  first,
  checkpoints,
}: {
  unit: JudgmentUnit
  first: boolean
  checkpoints: UnitCheckpoints | undefined
}) {
  const agents = useAtomValue(agentByIdAtom)
  const setOpenTips = useSetAtom(openTipsAtom)
  const agent = unit.agentId ? agents[unit.agentId] : undefined
  const markId = `${useId()}moved-up`
  const movedUp = useMovedUpFocus(unit.raisedFrom && markId)
  return (
    <div role="rowgroup" className={cn(!first && "border-t border-line-2")}>
      <div
        role="row"
        className={cn(
          ROW_GRID,
          "group/row relative py-4 transition-colors duration-surface-tone ease-standard hover:bg-raised motion-reduce:transition-none",
          ROW_FOCUS
        )}
      >
        <span role="cell" className="flex min-w-0 flex-col gap-1.5">
          <span className="flex items-center gap-2.5 text-[15.5px] font-semibold tracking-[-0.01em]">
            <LaneGlyph lane="human-required" className="shrink-0" />
            <NeuveLink
              data-row-link=""
              destination={{ to: "unit", unitId: unit.id }}
              aria-describedby={unit.raisedFrom ? markId : undefined}
              onFocus={(event) => {
                const row =
                  event.currentTarget.closest<HTMLElement>("[role='row']")
                if (row && event.currentTarget.matches(":focus-visible"))
                  setOpenTips(clippedCells(row))
                movedUp.onFocus?.(event)
              }}
              onBlur={() => {
                setOpenTips([])
                movedUp.onBlur?.()
              }}
              className={cn(ROW_LINK, unit.untitled && "min-w-0")}
            >
              {unit.untitled ? (
                <UntitledOnOneLine
                  title={unit.title}
                  files={unit.untitled.files}
                />
              ) : (
                unit.title
              )}
            </NeuveLink>
            {/* After the title, so every row's title starts on one line. */}
            {unit.raisedFrom && (
              <MovedUpTip id={markId} from={unit.raisedFrom} />
            )}
            {agent && <AgentTag agent={agent} />}
          </span>
          {unit.signal && (
            <span className={cn(STAT, "pl-5 text-req-fg")}>
              <TriangleAlertIcon
                aria-hidden="true"
                className="size-[13px]"
                strokeWidth={STROKE}
              />
              {unit.signal.text}
            </span>
          )}
          {unit.noAgentDecision && (
            <span className={cn(STAT, "pl-5 text-ink-muted")}>
              {NO_AGENT_DECISION}
            </span>
          )}
        </span>
        <StatCell id={`${unit.id}:scope`} icon={FileIcon}>
          <span className="sr-only">
            {`${unit.files} ${unit.files === 1 ? "file" : "files"} · `}
          </span>
          {`${unit.hunks} ${unit.hunks === 1 ? "hunk" : "hunks"}`}
        </StatCell>
        <StatCell id={`${unit.id}:context`} icon={Link2Icon}>
          {unit.unapproved
            ? `${unit.markers} markers · ${unit.unapproved} unapproved`
            : `${unit.markers} markers`}
        </StatCell>
        {/* At every width: under the title on a narrow screen. */}
        <span
          role="cell"
          className="max-[900px]:col-start-1 max-[900px]:row-start-2 max-[900px]:pl-5"
        >
          <CheckpointCount checkpoints={checkpoints} />
        </span>
        <ArrowRightIcon
          aria-hidden="true"
          strokeWidth={STROKE}
          className={cn(
            ICON,
            "text-faint transition-[transform,color] duration-nudge ease-ios-out group-hover/row:translate-x-(--nv-offset-nudge) group-hover/row:text-ink motion-reduce:transition-none max-[900px]:col-start-2 max-[900px]:row-start-1"
          )}
        />
      </div>
    </div>
  )
}

/** The overview's section heading, shared by its sibling sections. */
export const SECTION_HEADING =
  "m-0 mb-1 text-[22px] font-semibold tracking-[-0.02em]"

/**
 * Human-required units no person has decided, one row each, linking to the
 * desk, with how many of each unit's checkpoints are unmet.
 */
export function JudgmentTable({
  units,
  checkpoints = {},
}: {
  units: Array<JudgmentUnit>
  /** Each unit's checkpoints, by unit ID (`BatchOverviewData.checkpoints`). */
  checkpoints?: Readonly<Partial<Record<string, UnitCheckpoints>>>
}) {
  return (
    <TooltipProvider delayDuration={300}>
      <div
        role="table"
        aria-label="Units that need your decision"
        className="overflow-hidden rounded-[14px] bg-surface shadow-[0_0_0_1px_var(--nv-line)]"
      >
        <div
          role="row"
          className={cn(
            ROW_GRID,
            "border-b border-line-2 py-3 max-[900px]:hidden"
          )}
        >
          <span role="columnheader" className="label-mono">
            Unit
          </span>
          <span role="columnheader" className="label-mono">
            Scope
          </span>
          <span role="columnheader" className="label-mono">
            Context
          </span>
          <span role="columnheader" className="label-mono">
            Checkpoints
          </span>
          <span />
        </div>
        {units.map((unit, i) => (
          <UnitRow
            key={unit.id}
            unit={unit}
            first={i === 0}
            checkpoints={checkpoints[unit.id]}
          />
        ))}
      </div>
    </TooltipProvider>
  )
}
