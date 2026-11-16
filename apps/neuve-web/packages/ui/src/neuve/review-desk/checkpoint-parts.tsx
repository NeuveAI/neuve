import * as React from "react"
import { useAtomValue, useSetAtom } from "jotai"
import { motion, useReducedMotion } from "motion/react"
import {
  ArrowRightLeftIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  ClockAlertIcon,
  ContrastIcon,
  XIcon,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"
import {
  Popover as PopoverPrimitive,
  Tooltip as TooltipPrimitive,
} from "radix-ui"

import { Button } from "@workspace/ui/components/button"
import { REDUCED_TRANSITION, SCALE, SPRING } from "@workspace/ui/lib/motion"
import { cn } from "@workspace/ui/lib/utils"
import { FAMILY_STYLE } from "@workspace/ui/neuve/shared/marker-kind"
import type { MarkerFamily } from "@workspace/ui/neuve/shared/marker-kind"
import {
  closeCardAtom,
  hoverHintAtom,
  isolatingAtom,
  openCitationAtom,
  openMarkerAtom,
  pinMarkerKey,
} from "@workspace/ui/neuve/review-desk/atoms"
import {
  displayRows,
  toFileDiff,
} from "@workspace/ui/neuve/review-desk/diff-model"
import type { DisplayRow } from "@workspace/ui/neuve/review-desk/diff-model"
import {
  FloatingCard,
  FloatingHint,
} from "@workspace/ui/neuve/review-desk/floating"
import type {
  CheckpointProof,
  ContextualMarker,
  DiffFile,
  DiffSide,
  LineRange,
  MarkerAnchor,
} from "@workspace/ui/neuve/types"

/**
 * Checkpoints (10.110, 11.16): what a change must satisfy, as contextual
 * markers on the owned lines that meet it, each with its proof state said
 * plainly. The briefing names them; in the margin each line's checkpoints
 * share one pin beside the line's reference pin, and open one card.
 */

export const PROOF_LABEL: Record<CheckpointProof, string> = {
  proven: "Proven",
  thin: "Thin",
  missing: "Missing",
  "out-of-date": "Out of date",
  conflicting: "Conflicting",
}

/** The state's shape, so it never rests on colour alone. */
const PROOF_ICON: Record<CheckpointProof, LucideIcon> = {
  proven: CircleCheckIcon,
  thin: ContrastIcon,
  missing: CircleDashedIcon,
  "out-of-date": ClockAlertIcon,
  conflicting: ArrowRightLeftIcon,
}

/**
 * Magenta asks for a decision (records that disagree, as a conflict marker
 * does), amber asks for proof, and a proven checkpoint only informs.
 */
export function proofFamily(proof: CheckpointProof): MarkerFamily {
  return proof === "proven"
    ? "neutral"
    : proof === "conflicting"
      ? "req"
      : "sug"
}

/**
 * A line's pin leads with what needs the reader most: the unmet states in
 * 11.16's order, then thin, then proven.
 */
export const PROOF_ORDER: ReadonlyArray<CheckpointProof> = [
  "missing",
  "out-of-date",
  "conflicting",
  "thin",
  "proven",
]

export function isCheckpoint(marker: Pick<ContextualMarker, "tone">): boolean {
  return marker.tone === "checkpoint"
}

/** A checkpoint's state as its pin reads it: Missing when none is recorded. */
export const proofOf = (marker: ContextualMarker): CheckpointProof =>
  marker.checkpoint?.proof ?? "missing"

export function ProofIcon({
  proof,
  className,
}: {
  proof: CheckpointProof
  className?: string
}) {
  const Icon = PROOF_ICON[proof]
  return (
    <Icon
      aria-hidden="true"
      strokeWidth={2.2}
      className={cn("size-3 shrink-0", className)}
    />
  )
}

/** A checkpoint as the desk lists it, with the first lines it is anchored to. */
export interface CheckpointEntry {
  marker: ContextualMarker
  /** Absent for a checkpoint anchored to its unit as a whole (11.17). */
  at?: {
    filePath: string
    side: DiffSide
    lineNumber: number
    range: LineRange
  }
}

const rowIndexes = new WeakMap<ReadonlyArray<DisplayRow>, Map<string, number>>()

/** Each (side, line) point's row among the stacked display rows. */
function rowFinder(
  rows: ReadonlyArray<DisplayRow>
): (side: DiffSide, lineNumber: number) => number | undefined {
  let index = rowIndexes.get(rows)
  if (!index) {
    const built = new Map<string, number>()
    rows.forEach((row, at) => {
      if (row.kind !== "deletion") built.set(`additions:${row.newLine}`, at)
      if (row.kind !== "addition") built.set(`deletions:${row.oldLine}`, at)
    })
    rowIndexes.set(rows, built)
    index = built
  }
  const found = index
  return (side, lineNumber) => found.get(`${side}:${lineNumber}`)
}

/** A changed row's own (side, line) point. */
const pointOf = (row: DisplayRow) =>
  row.kind === "deletion"
    ? { side: "deletions" as const, lineNumber: row.oldLine! }
    : { side: "additions" as const, lineNumber: row.newLine! }

/** One pin a checkpoint anchor asks for, at its first row in a section. */
interface Placement {
  anchor: MarkerAnchor
  number: number
  first: number
  last: number
  section: string | undefined
}

/** What the desk shows of a file's anchors, and the markers they name. */
export interface ShownAnchors {
  anchors: Array<MarkerAnchor>
  /** The file's markers, with each further pin's own (`pinMarkerKey`). */
  markers: Record<string, ContextualMarker>
}

/**
 * The file's anchors the desk shows. Records anchors a checkpoint to every
 * owned range its requirement reaches (11.17), and a unit can join several
 * of a file's changes as sections (10.109), so one checkpoint can have many
 * anchors down one file, and one range can run on across a section's edge.
 * It shows once in each section its ranges touch, on the first changed line
 * they touch there in display order, so no pin repeats a group already shown
 * above it in its section. An anchor keeps its own marker on its first pin;
 * a pin in a further section has a marker of its own, about that section's
 * lines of the range, so its card opens there alone. Without sections, its
 * anchors that only unchanged lines separate show once, on the first of
 * them. Every other anchor stays, in its order.
 */
export function shownAnchors(
  file: DiffFile,
  markers: Record<string, ContextualMarker>,
  rows: ReadonlyArray<DisplayRow>
): ShownAnchors {
  const rowOf = rowFinder(rows)
  // changedBefore[i]: changed rows above row i, so a span's count is a difference.
  const changedBefore = [0]
  for (const row of rows)
    changedBefore.push(changedBefore.at(-1)! + (row.kind === "context" ? 0 : 1))
  const sections = file.responsibility?.sections ?? []
  const sectionAt = (side: DiffSide, lineNumber: number) =>
    sections.find((section) =>
      section.ranges.some(
        (range) =>
          (range.side === "new") === (side === "additions") &&
          lineNumber >= range.startLine &&
          lineNumber <= range.endLine
      )
    )?.id
  const pinned: Record<string, ContextualMarker> = {}
  const pinsOf = new Map<MarkerAnchor, Array<MarkerAnchor>>()
  const placed = file.markerAnchors.flatMap((anchor): Array<Placement> => {
    const marker = markers[anchor.markerKey]
    const number = marker?.checkpoint?.number
    const first = rowOf(anchor.side, anchor.lineNumber)
    if (!marker || number === undefined || first === undefined) return []
    const end = anchor.range
      ? rowOf(anchor.range.endSide ?? anchor.range.side, anchor.range.end)
      : undefined
    const last = Math.max(first, end ?? first)
    // The sections its own line and its range's changed lines belong to,
    // each with the first and last of those rows there. A range on one side
    // owns that side's lines only, not another hunk's lines on the other.
    const only =
      anchor.range &&
      (anchor.range.endSide ?? anchor.range.side) === anchor.range.side
        ? anchor.range.side
        : undefined
    const touched = new Map<string, { top: number; bottom: number }>()
    for (let at = first; at <= last; at++) {
      const row = rows[at]!
      if (at > first && row.kind === "context") continue
      const point = at === first ? anchor : pointOf(row)
      if (at > first && only !== undefined && point.side !== only) continue
      const section = sectionAt(point.side, point.lineNumber)
      if (section === undefined) continue
      const span = touched.get(section)
      if (span) span.bottom = at
      else touched.set(section, { top: at, bottom: at })
    }
    if (touched.size === 0)
      return [{ anchor, number, first, last, section: undefined }]
    const pins = [...touched].map(([section, { top, bottom }], index) => {
      const at = pointOf(rows[top]!)
      if (index === 0)
        return {
          anchor: top === first ? anchor : { ...anchor, ...at },
          section,
          top,
        }
      const to = pointOf(rows[bottom]!)
      const key = pinMarkerKey(anchor.markerKey, at.side, at.lineNumber)
      pinned[key] = { ...marker, key }
      const pin: MarkerAnchor = {
        markerKey: key,
        side: at.side,
        lineNumber: at.lineNumber,
        range: {
          start: at.lineNumber,
          side: at.side,
          end: to.lineNumber,
          ...(to.side !== at.side ? { endSide: to.side } : {}),
        },
      }
      return { anchor: pin, section, top }
    })
    pinsOf.set(
      anchor,
      pins.map((pin) => pin.anchor)
    )
    return pins.map(({ anchor: pin, section, top }) => ({
      anchor: pin,
      number,
      first: top,
      last,
      section,
    }))
  })
  const hidden = new Set<MarkerAnchor>()
  const seen = new Map<
    number,
    { sections: Set<string>; runEnd: number | undefined }
  >()
  // Array.prototype.sort is stable: anchors on one row keep data order.
  for (const { anchor, number, first, last, section } of placed.sort(
    (a, b) => a.first - b.first
  )) {
    const state = seen.get(number) ?? {
      sections: new Set<string>(),
      runEnd: undefined,
    }
    seen.set(number, state)
    if (section !== undefined) {
      if (state.sections.has(section)) hidden.add(anchor)
      state.sections.add(section)
      state.runEnd = undefined
      continue
    }
    const { runEnd } = state
    const joins =
      runEnd !== undefined &&
      (first <= runEnd + 1 ||
        changedBefore[first] === changedBefore[runEnd + 1])
    if (joins) hidden.add(anchor)
    state.runEnd = joins ? Math.max(runEnd, last) : last
  }
  const anchors = file.markerAnchors.flatMap((anchor) =>
    (pinsOf.get(anchor) ?? [anchor]).filter((pin) => !hidden.has(pin))
  )
  const extra = anchors.filter((pin) => pin.markerKey in pinned)
  return {
    anchors,
    markers:
      extra.length === 0
        ? markers
        : {
            ...markers,
            ...Object.fromEntries(
              extra.map((pin) => [pin.markerKey, pinned[pin.markerKey]!])
            ),
          },
  }
}

/**
 * The unit's checkpoints in their order, one entry each. A checkpoint on
 * several lines has a marker per line; its entry takes the first line it
 * shows on (`shownAnchors`) in the files' order and display order, so the
 * briefing lands there and opens that line's card.
 */
export function checkpointEntries(
  markers: Record<string, ContextualMarker>,
  files: ReadonlyArray<DiffFile> | undefined,
  revision: string
): Array<CheckpointEntry> {
  const byNumber = new Map<number, Array<ContextualMarker>>()
  for (const marker of Object.values(markers)) {
    if (!isCheckpoint(marker) || !marker.checkpoint) continue
    const group = byNumber.get(marker.checkpoint.number) ?? []
    group.push(marker)
    byNumber.set(marker.checkpoint.number, group)
  }
  const shown = (files ?? []).map((file) => {
    const rows = displayRows(toFileDiff(file, revision), file)
    return {
      file,
      anchors: shownAnchors(file, markers, rows).anchors,
      rowOf: rowFinder(rows),
    }
  })
  return [...byNumber.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, group]) => {
      const keys = new Set(group.map((marker) => marker.key))
      for (const { file, anchors, rowOf } of shown) {
        const row = (anchor: MarkerAnchor) =>
          rowOf(anchor.side, anchor.lineNumber) ?? Infinity
        const anchor = anchors
          .filter((candidate) => keys.has(candidate.markerKey))
          .reduce<MarkerAnchor | undefined>(
            (best, candidate) =>
              best === undefined || row(candidate) < row(best)
                ? candidate
                : best,
            undefined
          )
        if (anchor)
          return {
            marker: group.find((marker) => marker.key === anchor.markerKey)!,
            at: {
              filePath: file.path,
              side: anchor.side,
              lineNumber: anchor.lineNumber,
              range: anchor.range ?? {
                start: anchor.lineNumber,
                end: anchor.lineNumber,
                side: anchor.side,
              },
            },
          }
      }
      return { marker: group[0]! }
    })
}

const byWeakest = (markers: ReadonlyArray<ContextualMarker>) =>
  [...markers].sort(
    (a, b) => PROOF_ORDER.indexOf(proofOf(a)) - PROOF_ORDER.indexOf(proofOf(b))
  )

/** A checkpoint's state, its icon and its word: never colour alone. */
export function StateLabel({
  proof,
  className,
}: {
  proof: CheckpointProof
  className?: string
}) {
  const style = FAMILY_STYLE[proofFamily(proof)]
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 font-mono text-[11px]",
        style.label,
        className
      )}
    >
      <ProofIcon proof={proof} className={style.icon} />
      {PROOF_LABEL[proof]}
    </span>
  )
}

/** One checkpoint, as the peek and the card both say it. */
function CheckpointBody({
  marker,
  clamp,
}: {
  marker: ContextualMarker
  clamp: boolean
}) {
  return (
    <div className="flex flex-col gap-1">
      <StateLabel proof={proofOf(marker)} />
      <span
        className={cn(
          "text-[13px] leading-[19px] wrap-anywhere text-ink",
          clamp && "line-clamp-3"
        )}
      >
        {marker.checkpoint?.requirement}
      </span>
      {marker.checkpoint?.note && (
        <span className="text-[12px] leading-[17px] text-ink-muted">
          {marker.checkpoint.note}
        </span>
      )}
    </div>
  )
}

const PIN_FOCUS =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus focus-visible:outline-solid"

/**
 * A line's checkpoints in the margin, beside its reference pin: the weakest
 * state's icon and word, "Checkpoint", and a count when the line meets more
 * than one. Its peek on hover or keyboard focus says each requirement; the
 * card says them in full.
 */
export function CheckpointMark({
  markers,
  filePath,
  lineNumber,
  onLand,
}: {
  markers: ReadonlyArray<ContextualMarker>
  filePath: string
  lineNumber: number
  /** Lands on the checkpoint's lines, as opening a reference's card does. */
  onLand: (markerKey: string) => void
}) {
  const reduce = useReducedMotion()
  const open = useAtomValue(openMarkerAtom)
  const isolating = useAtomValue(isolatingAtom)
  const hint = useAtomValue(hoverHintAtom)
  const setHint = useSetAtom(hoverHintAtom)
  const openCitation = useSetAtom(openCitationAtom)
  const closeCard = useSetAtom(closeCardAtom)
  const pin = React.useRef<HTMLButtonElement | null>(null)
  const sorted = byWeakest(markers)
  const lead = sorted[0]!
  const proof = proofOf(lead)
  const style = FAMILY_STYLE[proofFamily(proof)]
  const many = markers.length > 1
  // Each line has its own markers (one per line a checkpoint marks), so
  // the card opens on this line only.
  const cardOpen =
    open !== null && markers.some((marker) => marker.key === open)
  const hinted =
    !cardOpen &&
    !isolating &&
    hint?.filePath === filePath &&
    hint.markerKey === lead.key
  const states = sorted
    .map((marker) => PROOF_LABEL[proofOf(marker)].toLowerCase())
    .join(", ")
  const name = `${many ? `${markers.length} checkpoints` : "Checkpoint"} on line ${lineNumber}, ${states}`
  const endHint = () =>
    setHint((current) => (current?.markerKey === lead.key ? null : current))
  return (
    <TooltipPrimitive.Provider delayDuration={0}>
      <PopoverPrimitive.Root
        open={cardOpen}
        onOpenChange={(next) => {
          if (!next) closeCard()
        }}
      >
        <TooltipPrimitive.Root open={hinted}>
          <TooltipPrimitive.Trigger asChild>
            <PopoverPrimitive.Anchor asChild>
              <motion.button
                ref={pin}
                initial={
                  reduce ? { opacity: 0 } : { opacity: 0, scale: SCALE.pop }
                }
                animate={{ opacity: 1, scale: 1 }}
                transition={reduce ? REDUCED_TRANSITION : SPRING.snappy}
                type="button"
                data-checkpoint-mark=""
                data-checkpoints={sorted
                  .map((marker) => marker.checkpoint?.number)
                  .join(" ")}
                data-proof={proof}
                aria-expanded={cardOpen}
                aria-haspopup="dialog"
                aria-label={name}
                tabIndex={isolating && !cardOpen ? -1 : 0}
                onClick={() => {
                  if (cardOpen) return closeCard()
                  openCitation(lead.key)
                  onLand(lead.key)
                }}
                onMouseEnter={() => setHint({ filePath, markerKey: lead.key })}
                onMouseLeave={endHint}
                onFocus={(event) => {
                  // Only keyboard focus asks for the peek.
                  if (event.currentTarget.matches(":focus-visible"))
                    setHint({ filePath, markerKey: lead.key })
                }}
                onBlur={endHint}
                className={cn(
                  "relative inline-flex h-[22px] max-w-[220px] items-center gap-[5px] rounded-md pr-2 pl-1.5 font-mono text-[11px] whitespace-nowrap",
                  "press motion-reduce:transition-none",
                  PIN_FOCUS,
                  cardOpen ? "bg-ink text-paper" : cn(style.tint, style.hover),
                  isolating && !cardOpen && "pointer-events-none"
                )}
              >
                <ProofIcon
                  proof={proof}
                  className={cardOpen ? "text-paper" : style.icon}
                />
                <span className="shrink-0">Checkpoint</span>
                <span className="shrink-0">{PROOF_LABEL[proof]}</span>
                {many && (
                  <span
                    aria-hidden="true"
                    className={cn(
                      "inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-[4px] px-1 text-[10.5px]",
                      cardOpen
                        ? "bg-paper/20 text-paper"
                        : "bg-surface text-ink-2"
                    )}
                  >
                    {markers.length}
                  </span>
                )}
              </motion.button>
            </PopoverPrimitive.Anchor>
          </TooltipPrimitive.Trigger>
          {hinted && (
            // Escape ends the peek, as leaving the pin does (WCAG 1.4.13);
            // embedded in Ace, the next press then goes to Ace.
            <FloatingHint
              onEscape={endHint}
              label={sorted
                .map(
                  (marker) =>
                    `${PROOF_LABEL[proofOf(marker)]}: ${marker.checkpoint?.requirement}`
                )
                .join(". ")}
            >
              <div
                aria-hidden="true"
                data-peek=""
                className="pointer-events-none box-border flex w-[min(320px,calc(100vw-16px))] flex-col gap-1 rounded-[10px] bg-surface p-1.5 text-left font-sans shadow-card"
              >
                {sorted.map((marker) => (
                  <div key={marker.key} className="p-2">
                    <CheckpointBody marker={marker} clamp />
                  </div>
                ))}
              </div>
            </FloatingHint>
          )}
        </TooltipPrimitive.Root>
        {cardOpen && (
          <FloatingCard
            label={many ? `${markers.length} checkpoints` : "Checkpoint"}
            description={`On line ${lineNumber}`}
            onReturnFocus={() => pin.current?.focus()}
          >
            <section
              data-checkpoint-card=""
              className="box-border flex w-full shrink-0 flex-col overflow-x-hidden rounded-xl bg-surface pb-3.5 font-sans text-sm text-ink"
            >
              <div className="flex items-center gap-2 pt-3 pr-2.5 pl-3.5">
                <span className="min-w-0 flex-auto label-mono text-[10.5px] text-ink-muted">
                  {many ? `${markers.length} checkpoints` : "Checkpoint"}
                </span>
                <Button
                  type="button"
                  variant="quiet"
                  size="icon-card"
                  aria-label="Close checkpoint"
                  onClick={() => {
                    closeCard()
                    pin.current?.focus()
                  }}
                  className="size-[26px] shrink-0"
                >
                  <XIcon aria-hidden="true" className="size-[11px]" />
                </Button>
              </div>
              <ol className="m-0 flex list-none flex-col gap-3 px-3.5 pt-1.5">
                {sorted.map((marker) => (
                  <li key={marker.key}>
                    <CheckpointBody marker={marker} clamp={false} />
                  </li>
                ))}
              </ol>
            </section>
          </FloatingCard>
        )}
      </PopoverPrimitive.Root>
    </TooltipPrimitive.Provider>
  )
}

/* ── In the briefing ─────────────────────────────────────────────────── */

const ROW =
  "grid w-full grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-0.5 rounded-lg px-2 py-1.5 text-left sm:grid-cols-[auto_minmax(0,1fr)_auto]"

function StateTag({ proof }: { proof: CheckpointProof }) {
  const style = FAMILY_STYLE[proofFamily(proof)]
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1 self-start rounded-[5px] pr-1.5 pl-[5px] font-mono text-[11px] whitespace-nowrap",
        style.tint
      )}
    >
      <ProofIcon proof={proof} className={cn("size-[11px]", style.icon)} />
      {PROOF_LABEL[proof]}
    </span>
  )
}

/**
 * The briefing names only the checkpoints no line meets (11.17): they have
 * no pin, so the briefing is the one place they show, with the requirement
 * in full and why no line meets it. Checkpoints on lines are their pins in
 * the margin (the owner's markup of 25 October took their rows out of the
 * briefing). Guided has no list: its check against the ticket says what
 * each item lacks (10.140).
 */
export function CheckpointBriefing({
  entries,
}: {
  entries: ReadonlyArray<CheckpointEntry>
}) {
  const whole = entries.filter((entry) => !entry.at)
  if (whole.length === 0) return null
  return (
    <ul
      aria-label="Checkpoints"
      className="m-0 -mx-2 flex max-w-[676px] list-none flex-col p-0"
    >
      {whole.map(({ marker }) => {
        const proof = proofOf(marker)
        return (
          <li key={marker.key} className={ROW}>
            <StateTag proof={proof} />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[14px] leading-5 wrap-anywhere text-ink-2">
                {marker.checkpoint?.requirement}
              </span>
              {/* It has no pin or card to say why, so the row does. */}
              {marker.checkpoint?.note && (
                <span className="text-[12.5px] leading-[18px] text-ink-muted">
                  {marker.checkpoint.note}
                </span>
              )}
            </span>
            {/* No line meets it on its own (11.17): it is the unit's. */}
            <span className="col-start-2 font-mono text-[11px] leading-5 text-ink-muted sm:col-start-auto">
              Whole unit
            </span>
          </li>
        )
      })}
    </ul>
  )
}
