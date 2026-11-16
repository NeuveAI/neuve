import * as React from "react"
import {
  ActivityIcon,
  ArrowRightLeftIcon,
  CircleDashedIcon,
  CodeIcon,
  FileTextIcon,
  FlagIcon,
  FlaskConicalIcon,
  FlaskConicalOffIcon,
  GitForkIcon,
  HistoryIcon,
  LayersIcon,
  MessageSquareIcon,
  PencilLineIcon,
  TargetIcon,
  createLucideIcon,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"
import { MARKER_KIND_LABEL } from "@workspace/ui/neuve/citation-name"
import type { ContextualMarker, MarkerTone } from "@workspace/ui/neuve/types"

/**
 * Contextual marker identity (design/neuve-web/context-markers.md,
 * Markers.dc.html): one kind table for the pin, peek, card, source sheet and
 * briefing citation chip.
 *
 *   icon    what kind of marker it is (Lucide, never a lane primitive)
 *   colour  whether it asks something of the reviewer: magenta needs your
 *           decision, amber is missing or failed evidence, neutral informs
 *   edge    where it comes from (filled, dashed, speech bubble)
 *
 * Review comments and parked drafts share the margin, the pin anatomy and
 * the grouping rule, so they have rows here too; they are margin items, not
 * contextual markers.
 */

/** A margin item's kind: the data tone, plus the UI-only parked draft. */
export type MarkerKind = MarkerTone | "draft"

export type MarkerFamily =
  | "req" // asks you: it needs your decision
  | "sug" // asks you: evidence is missing or failed
  | "human" // a person wrote it
  | "draft" // a person's unsaved draft
  | "transient" // same batch, unapproved
  | "neutral" // informs

/** `circle-dashed` with an x: linked evidence that could not be read. */
const CircleDashedXIcon = createLucideIcon("circle-dashed-x", [
  ["path", { d: "M10.1 2.182a10 10 0 0 1 3.8 0", key: "a" }],
  ["path", { d: "M13.9 21.818a10 10 0 0 1-3.8 0", key: "b" }],
  ["path", { d: "M17.609 3.721a10 10 0 0 1 2.69 2.7", key: "c" }],
  ["path", { d: "M2.182 13.9a10 10 0 0 1 0-3.8", key: "d" }],
  ["path", { d: "M20.279 17.609a10 10 0 0 1-2.7 2.69", key: "e" }],
  ["path", { d: "M21.818 10.1a10 10 0 0 1 0 3.8", key: "f" }],
  ["path", { d: "M3.721 6.391a10 10 0 0 1 2.7-2.69", key: "g" }],
  ["path", { d: "M6.391 20.279a10 10 0 0 1-2.69-2.7", key: "h" }],
  ["path", { d: "m9 9 6 6", key: "i" }],
  ["path", { d: "m15 9-6 6", key: "j" }],
])

interface KindEntry {
  icon: LucideIcon
  family: MarkerFamily
  /**
   * L0 pin label (citation-name.ts). Review comments show the author's
   * initials instead.
   */
  label: string
}

/** In priority order: a shared line's pin shows the first kind present. */
export const MARKER_KINDS = {
  conflict: {
    icon: ArrowRightLeftIcon,
    family: "req",
    label: MARKER_KIND_LABEL.conflict,
  },
  decision: {
    icon: FlagIcon,
    family: "req",
    label: MARKER_KIND_LABEL.decision,
  },
  failed: {
    icon: FlaskConicalOffIcon,
    family: "sug",
    label: MARKER_KIND_LABEL.failed,
  },
  gap: { icon: CircleDashedIcon, family: "sug", label: MARKER_KIND_LABEL.gap },
  unavailable: {
    icon: CircleDashedXIcon,
    family: "sug",
    label: MARKER_KIND_LABEL.unavailable,
  },
  // Margin items that are not markers: a review comment, a parked draft.
  comment: {
    icon: MessageSquareIcon,
    family: "human",
    label: MARKER_KIND_LABEL.comment,
  },
  draft: {
    icon: PencilLineIcon,
    family: "draft",
    label: MARKER_KIND_LABEL.draft,
  },
  batch: {
    icon: LayersIcon,
    family: "transient",
    label: MARKER_KIND_LABEL.batch,
  },
  signal: {
    icon: ActivityIcon,
    family: "neutral",
    label: MARKER_KIND_LABEL.signal,
  },
  test: {
    icon: FlaskConicalIcon,
    family: "neutral",
    label: MARKER_KIND_LABEL.test,
  },
  source: {
    icon: CodeIcon,
    family: "neutral",
    label: MARKER_KIND_LABEL.source,
  },
  graph: {
    icon: GitForkIcon,
    family: "neutral",
    label: MARKER_KIND_LABEL.graph,
  },
  history: {
    icon: HistoryIcon,
    family: "neutral",
    label: MARKER_KIND_LABEL.history,
  },
  doc: { icon: FileTextIcon, family: "neutral", label: MARKER_KIND_LABEL.doc },
  // A checkpoint's own mark takes its family from its proof state
  // (checkpoint-parts.tsx); this row is its kind for lists and chips.
  checkpoint: {
    icon: TargetIcon,
    family: "neutral",
    label: MARKER_KIND_LABEL.checkpoint,
  },
} as const satisfies Record<MarkerKind, KindEntry>

const PRIORITY = Object.keys(MARKER_KINDS) as Array<MarkerKind>

/** The kind of a margin item (its tone). */
export function markerKind(marker: Pick<ContextualMarker, "tone">): MarkerKind {
  return marker.tone
}

export function markerFamily(kind: MarkerKind): MarkerFamily {
  return MARKER_KINDS[kind].family
}

/** Lower is more important; sorts a shared line's markers. */
export function markerPriority(kind: MarkerKind): number {
  return PRIORITY.indexOf(kind)
}

/** The pin's label: the kind, never the file; a comment's author initials. */
export function markerPinLabel(
  marker: Pick<ContextualMarker, "tone" | "short">
): string {
  const kind = markerKind(marker)
  return kind === "comment" ? marker.short : MARKER_KINDS[kind].label
}

/**
 * Family colours. `tint` is the rest state, `hover` one tint step darker on
 * real pointer hover, `icon` the glyph's own colour on the tint, `tile` the
 * card and sheet header tile.
 */
export const FAMILY_STYLE: Record<
  MarkerFamily,
  { tint: string; hover: string; icon: string; tile: string; label: string }
> = {
  neutral: {
    tint: "bg-raised text-ink-2",
    hover: "hover:bg-raised-2",
    icon: "text-ink-muted",
    tile: "bg-raised text-ink-muted",
    label: "text-ink-2",
  },
  req: {
    tint: "bg-req-tint text-req-ink",
    hover: "hover:bg-req-tint-2",
    icon: "text-req",
    tile: "bg-req-tint text-req",
    label: "text-req-ink",
  },
  sug: {
    tint: "bg-sug-tint text-sug-ink",
    hover: "hover:bg-sug-tint-2",
    icon: "text-sug",
    tile: "bg-sug-tint text-sug",
    label: "text-sug-ink",
  },
  transient: {
    tint: "border border-dashed border-line-strong bg-transparent text-ink-muted",
    hover: "hover:bg-raised",
    icon: "text-ink-muted",
    tile: "border border-dashed border-line-strong bg-transparent text-ink-muted",
    label: "text-ink-muted",
  },
  human: {
    tint: "bg-raised-2 text-ink-2",
    hover: "hover:bg-ink hover:text-paper",
    icon: "text-ink-muted",
    tile: "bg-raised-2 text-ink-2",
    label: "text-ink-2",
  },
  draft: {
    tint: "border border-dashed border-line-strong bg-transparent text-ink-muted",
    hover: "hover:bg-raised",
    icon: "text-ink-muted",
    tile: "border border-dashed border-line-strong bg-transparent text-ink-muted",
    label: "text-ink-muted",
  },
}

/** The kind's icon: 12px, stroke 2.2 unless sized by the caller. */
export function MarkerKindIcon({
  kind,
  className,
  strokeWidth = 2.2,
}: {
  kind: MarkerKind
  className?: string
  strokeWidth?: number
}) {
  const Icon = MARKER_KINDS[kind].icon
  return (
    <Icon
      aria-hidden="true"
      strokeWidth={strokeWidth}
      className={cn("size-3 shrink-0", className)}
    />
  )
}

/** The icon on a family-tinted tile: 24px in the card, 32px in the sheet. */
export function MarkerKindTile({
  kind,
  size = 24,
}: {
  kind: MarkerKind
  size?: 24 | 32
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        size === 24 ? "size-6 rounded-md" : "size-8 rounded-lg",
        FAMILY_STYLE[markerFamily(kind)].tile
      )}
    >
      <MarkerKindIcon
        kind={kind}
        className={size === 24 ? "size-3" : "size-[15px]"}
      />
    </span>
  )
}

/**
 * Inline citation: kind icon, label and ↓ when it lands in the diff,
 * family-tinted (Markers.dc.html, "Briefing citation"). A citation whose
 * marker is unknown never claims a kind: neutral, no icon.
 *
 * Icon only (the unit's briefing, round 5): the chip keeps its kind tint and
 * icon and drops the label and ↓. Its accessible name (aria-label) still
 * says the kind and the target ("Source, lines 29–36"), and its tooltip on
 * hover or keyboard focus shows that same text. A chip with no known kind
 * has no icon, so it keeps its label.
 *
 * A marker whose pin shows a state (a checkpoint's proof) gives its chip that
 * state's family and icon instead of its kind's (`state`).
 */
export function CitationChip({
  kind,
  label,
  lands = true,
  iconOnly = false,
  state,
  className,
  ...rest
}: Omit<React.ComponentPropsWithRef<"button">, "children"> & {
  /** Unknown (the cited marker is not loaded): a neutral chip, no icon. */
  kind?: MarkerKind
  label: string
  /** It scrolls to its lines in the diff (↓); otherwise it opens a sheet. */
  lands?: boolean
  /** Only the kind icon shows; the accessible name is its tooltip. */
  iconOnly?: boolean
  /** The marker's state as its pin shows it: its family and its icon. */
  state?: {
    family: MarkerFamily
    icon: (className: string) => React.ReactNode
  }
}) {
  const family =
    FAMILY_STYLE[state?.family ?? (kind ? markerFamily(kind) : "neutral")]
  const name = rest["aria-label"] ?? label
  const compact = iconOnly && kind !== undefined
  const chip = (
    <button
      type="button"
      data-icon-only={compact ? "" : undefined}
      className={cn(
        "inline-flex h-5 items-center rounded-[5px] align-[1px] font-mono text-[11px] leading-5 whitespace-nowrap",
        compact ? "w-5 justify-center" : "gap-1 pr-1.5 pl-[5px]",
        "transition-colors duration-surface-tone ease-standard motion-reduce:transition-none",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
        family.tint,
        family.hover,
        className
      )}
      {...rest}
      // The tooltip says the name; as a description it would be read twice.
      // The chip's own prop wins over the tooltip trigger's (Radix Slot).
      {...(compact ? { "aria-describedby": undefined } : {})}
    >
      {kind &&
        (state ? (
          state.icon(cn("size-[11px]", family.icon))
        ) : (
          <MarkerKindIcon
            kind={kind}
            className={cn("size-[11px]", family.icon)}
          />
        ))}
      {!compact && label}
      {!compact && lands && <span aria-hidden="true">↓</span>}
    </button>
  )
  if (!compact) return chip
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{chip}</TooltipTrigger>
        {/* The tooltip says what the name says, from the same string, so
        the two never drift apart. */}
        <TooltipContent side="top" className="font-mono text-[11px]">
          {name}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
