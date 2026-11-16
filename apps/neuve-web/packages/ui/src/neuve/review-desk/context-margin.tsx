/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD — Context margin overlay (L0 → L1 → L2)
 *
 * Everything here is slotted into the diff's overlay layer
 * (@workspace/diffs, annotationLayout: 'overlay'): the layer positions it,
 * the code rows never move.
 *
 *    0ms   pin hover/focus — tone shift (surfaceTone 120ms, CSS)
 *    0ms   shared hint fades in, y -2 → 0 (hint 140ms, iOS ease-out)
 *    0ms   pin press — compresses to .97 while held (SCALE.press, pressIn
 *          80ms, the CSS `press` utility)
 *    0ms   other overlay items dim to 35% (OPACITY.dimOthers, dimOthers
 *          160ms, the diff fork's layer CSS)
 *    0ms   card / composer enters: opacity 0 → 1, y -4 → 0, scale .98 → 1
 *          (card 220ms, emphasized decelerate, origin top-left)
 *    0ms   comment body opens: opacity 0 → 1, y -4 → 0 (card 220ms)
 *  close   card and comment body exit: opacity → 0, y → -4
 *          (cardExit 160ms, accelerate); items below slide up (layerShift
 *          200ms, the fork's layer CSS)
 *
 * Commenting (gutter → chip → composer → pin):
 *    0ms   lines selected — "Comment · L20–23" chip at the last line:
 *          opacity 0 → 1, scale .96 → 1 (snappy spring 400/30, origin left)
 *    0ms   chip / Enter / C — composer at the first line (card 220ms)
 *  save    composer collapses toward the pin row: opacity → 0, scale → .9,
 *          origin top-left (cardExit 160ms, accelerate); the new pin enters
 *          scale .96 → 1 (snappy)
 *
 * Round 2:
 *  rest    a pin shared with other units carries one 4px dot per unit
 *          (max 3, currentColor, 75% on a filled pin); no width growth, no
 *          raised edge
 *    0ms   pointing at / opening it tone-shifts the linked rail units
 *          (linked 160ms, rail storyboard)
 *  open    the L2 card sticks at top 16px while the file scrolls, capped
 *          at the viewport (scrolls inside itself, never sideways)
 *    0ms   graph tree path tooltip fades in on real hover / focus-visible
 *          (hint 140ms, iOS ease-out), wrapped inside the card
 *
 * Round 3 (context-markers.md, Margin.dc.html):
 *  rest    one pin per line: the lead kind's icon + label, a faint target,
 *          a count when the line holds more; the family tint
 *    0ms   real hover / focus-visible — one tint step (surfaceTone 120ms,
 *          CSS); the diff tints exactly the line group's lines (--nv-lit)
 *    0ms   light peek card, one row per marker: opacity 0 → 1, y −4 → 0
 *          (hint 140ms, iOS ease-out, floating.tsx)
 *    0ms   count click — the line's list opens like a card (card 220ms);
 *          choosing a row swaps in that marker's card
 *    0ms   its back chevron (or Escape) swaps the list back in, focus on
 *          the row it came from; the layer stays put, no motion
 *
 * Reduced motion: opacity-only 150ms tweens; tone and dimming stay; the
 * layer drops its slide.
 * ───────────────────────────────────────────────────────── */

import * as React from "react"
import { useAtomValue, useSetAtom } from "jotai"
import { motion, useReducedMotion } from "motion/react"
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronsUpDownIcon,
  MessageSquarePlusIcon,
  XIcon,
} from "lucide-react"
import {
  Popover as PopoverPrimitive,
  Tooltip as TooltipPrimitive,
} from "radix-ui"

import { Button } from "@workspace/ui/components/button"
import {
  EASE,
  REDUCED_TRANSITION,
  SPRING,
  TIMING,
  ms,
  OFFSET,
  SCALE,
} from "@workspace/ui/lib/motion"
import { cn } from "@workspace/ui/lib/utils"
import { HighlightedCode } from "@workspace/ui/neuve/shared/highlighted-code"
import { NeuveLink } from "@workspace/ui/neuve/shared/nav-link"
import { editorHref } from "@workspace/ui/neuve/shared/editor-links"
import {
  FAMILY_STYLE,
  MarkerKindIcon,
  MarkerKindTile,
  markerFamily,
  markerKind,
  markerPinLabel,
  markerPriority,
} from "@workspace/ui/neuve/shared/marker-kind"
import {
  closeCardAtom,
  composerAtom,
  hoverHintAtom,
  isolatingAtom,
  openBodiesAtom,
  openMarkerAtom,
  openSheetAtom,
  toggleMarkerAtom,
  treeTipAtom,
} from "@workspace/ui/neuve/review-desk/atoms"
import {
  backToLineAtom,
  cardFromLineAtom,
  chooseLineMarkerAtom,
  closeLineAtom,
  lineKey,
  openLineAtom,
  toggleLineAtom,
} from "@workspace/ui/neuve/review-desk/marker-atoms"
import { rangeLabel } from "@workspace/ui/neuve/review-desk/diff-model"
import { landOnAtom } from "@workspace/ui/neuve/review-desk/landing"
import { linesName } from "@workspace/ui/neuve/citation-name"
import {
  CardBackButton,
  CardBoundaryContext,
  FloatingCard,
  FloatingHint,
  focusAsLastInput,
} from "@workspace/ui/neuve/review-desk/floating"
import type { CardBack } from "@workspace/ui/neuve/review-desk/floating"
import {
  CommentPreviewCard,
  ThreadCard,
} from "@workspace/ui/neuve/review-desk/thread-card"
import {
  ReferenceFeedback,
  ReferenceFeedbackSummary,
  useRatedReferences,
  useReferenceFeedbackKey,
} from "@workspace/ui/neuve/review-desk/feedback/feedback-controls"
import {
  BeforeYouDecide,
  HarnessGrade,
  PathLabel,
  ReferenceWhy,
} from "@workspace/ui/neuve/review-desk/reference-parts"
import { pathParts } from "@workspace/ui/neuve/review-desk/reference-tie"
import {
  CheckpointMark,
  isCheckpoint,
} from "@workspace/ui/neuve/review-desk/checkpoint-parts"
import { reviewThreadsAtom } from "@workspace/ui/neuve/review-comments/threads"
import { AgentAvatar } from "@workspace/ui/neuve/agents/agent-avatar"
import { PersonAvatar } from "@workspace/ui/neuve/shared/person-avatar"
import type { AvatarSize } from "@workspace/ui/neuve/shared/person-avatar"
import { reviewCommentRepositoryAtom } from "@workspace/ui/neuve/review-comments/repository"
import type {
  ReviewCommentAuthor,
  ReviewCommentRecord,
} from "@workspace/ui/neuve/review-comments/record"
import type {
  ContextualMarker,
  DiffSide,
  LineRange,
  MarkerAnchor,
  MarkerCheckAction,
  MarkerExcerpt,
  ReadByNode,
} from "@workspace/ui/neuve/types"

const CARD = {
  offsetY: -OFFSET.card, // px the card rises from
  initialScale: SCALE.enter, // scale before landing
  enter: { duration: ms(TIMING.card), ease: EASE.emphasizedDecelerate },
  exit: { duration: ms(TIMING.cardExit), ease: EASE.emphasizedAccelerate },
} as const

const HINT = {
  offsetY: -OFFSET.hint, // px the hint drops from
  transition: { duration: ms(TIMING.hint), ease: EASE.iosOut },
} as const

/** Shared enter/exit for everything that floats in the overlay. */
function useFloatMotion(withScale: boolean) {
  const reduce = useReducedMotion()
  return {
    initial: reduce
      ? { opacity: 0 }
      : withScale
        ? { opacity: 0, y: CARD.offsetY, scale: CARD.initialScale }
        : { opacity: 0, y: CARD.offsetY },
    animate: withScale ? { opacity: 1, y: 0, scale: 1 } : { opacity: 1, y: 0 },
    exit: reduce
      ? { opacity: 0, transition: REDUCED_TRANSITION }
      : { opacity: 0, y: CARD.offsetY, transition: CARD.exit },
    transition: reduce ? REDUCED_TRANSITION : CARD.enter,
  } as const
}

/* ── L0 pin ────────────────────────────────────────────── */

const AVATAR_BOX: Record<AvatarSize, string> = {
  16: "size-4",
  20: "size-5",
  24: "size-6",
}

/**
 * A review comment's author as the identity draws them everywhere: the
 * agent's antenna square (role tint) or the person's bubble. Absent
 * `author` means a person whose initials are the marker's `short`.
 */
function CommentAuthorAvatar({
  author,
  short,
  size,
  className,
}: {
  author: ContextualMarker["author"]
  short: string
  size: AvatarSize
  className?: string
}) {
  // An agent's box is taller (the antenna); hold it to the bubble's square
  // so rows line up whoever wrote the comment.
  return author?.kind === "agent" ? (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        AVATAR_BOX[size]
      )}
    >
      <AgentAvatar
        agent={{ short: author.short, role: author.role }}
        size={size}
      />
    </span>
  ) : (
    <PersonAvatar
      person={{ initials: short }}
      size={size}
      className={className}
    />
  )
}

const PIN_FOCUS =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus focus-visible:outline-solid"

/**
 * A review comment: a margin item that is not retrieved context. The one
 * test for "comment" in the margin (pin anatomy, thread, preview).
 */
function isComment(marker: Pick<ContextualMarker, "tone">): boolean {
  return markerKind(marker) === "comment"
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1)
}

/** Paths compare without a leading "./" or "/". */
function samePath(a: string, b: string): boolean {
  const clean = (path: string) => path.replace(/^\.?\//, "")
  return clean(a) === clean(b)
}

/**
 * One pin per line (context-markers.md): the lead kind's icon and label, a
 * faint target when it cites another file, a count when the line holds
 * more markers, and one dot per other unit it is shared with (max 3).
 *
 *   rest       the family tint
 *   hover      one tint step darker (real pointer hover only)
 *   focus      2px focus ring, offset 2px (focus-visible)
 *   open       ink fill while its card or list is open
 *   read-only  outline only, no colour (a read-only neighbor's own context)
 *
 * A review comment pin is its author's real avatar, which no state
 * changes (round-4.md § Comment pins); resolved adds a small muted check
 * beside it. A person's rings follow the bubble on its slot: hover
 * line-strong 1.5px, open ink 2px, resolved line-strong 1px, focus the 2px
 * outline; they fade in over pinRing and out over pinRingExit, as the
 * agent's ring does. An agent's pin is the avatar's `data-pin-host`: hover, focus and
 * open (aria-expanded) draw the ring outside its dashed edge and raise the
 * antenna; resolved is the plain avatar. Exactly one focus indicator: an
 * agent pin drops the outline because the avatar's focus ring is it.
 */
export function MarginPin({
  marker,
  rangeLabel: commentRange,
  on,
  disabled,
  readOnly = false,
  resolved = false,
  count = 1,
  rated,
  reviewedPath,
  lineNumber,
  sharedWith,
  onToggle,
  onHintStart,
  onHintEnd,
  className,
  onClick: slotClick,
  onFocus: slotFocus,
  onBlur: slotBlur,
  onMouseEnter: slotMouseEnter,
  onMouseLeave: slotMouseLeave,
  ...rest
}: Omit<
  React.ComponentPropsWithRef<"button">,
  | "children"
  | "onDrag"
  | "onDragStart"
  | "onDragEnd"
  | "onAnimationStart"
  | "onAnimationEnd"
> & {
  /** The line's lead marker (highest priority). */
  marker: ContextualMarker
  /** Review comments: the lines they are about, e.g. "L20–23". */
  rangeLabel?: string
  /** Its card or its line's list is open (or, for a comment, its body). */
  on: boolean
  disabled: boolean
  /** A resolved review comment: muted ring and a check beside the avatar. */
  resolved?: boolean
  /** A read-only neighbor's own context: muted outline pin. */
  readOnly?: boolean
  /** Markers on this line, the lead included. */
  count?: number
  /**
   * How many of the line's references the reader has rated (feedback,
   * 10.107), shown after the count ("2 rated"). Absent while feedback is off
   * or none is rated.
   */
  rated?: number
  /** The file under review: a target in it is not repeated on the pin. */
  reviewedPath?: string
  /** For the accessible name, e.g. "Gap on line 1179". */
  lineNumber?: number
  /** Units the line's markers are shared with; defaults to the lead's. */
  sharedWith?: ReadonlyArray<string>
  onToggle: () => void
  onHintStart: () => void
  onHintEnd: () => void
  className?: string
  "data-anchor"?: string
  "data-marker-key"?: string
}) {
  const kind = markerKind(marker)
  const style = FAMILY_STYLE[markerFamily(kind)]
  const comment = isComment(marker)
  const agentAuthor =
    comment && marker.author?.kind === "agent" ? marker.author : undefined
  const label = markerPinLabel(marker)
  const reduce = useReducedMotion()
  const many = count > 1
  const target =
    !many &&
    marker.target &&
    !(reviewedPath && samePath(marker.target, reviewedPath))
      ? basename(marker.target)
      : undefined
  // Shared with other units: one small dot per other unit (max 3), in the
  // pin's own colour (at 75% on a filled pin). No width growth, no raised
  // edge.
  const shared = (sharedWith ?? marker.sharedWith ?? []).length
  // No fill of its own: the dots sit on whatever row is behind the pin.
  const outlined =
    !on &&
    (readOnly ||
      markerFamily(kind) === "transient" ||
      markerFamily(kind) === "draft")
  // Shown and announced together: a comment-led pin shows no count of
  // rated references, so it does not announce one either.
  const showRated = !comment && rated !== undefined && rated > 0
  const accessibleName = comment
    ? `${resolved ? "Resolved review comment" : "Review comment"} by ${marker.title.replace(/ commented$/, "")}${commentRange ? ` on ${commentRange}` : ""}${many ? `, ${count} markers` : `: ${marker.peek}`}`
    : [
        `${label}${lineNumber === undefined ? "" : ` on line ${lineNumber}`}`,
        many ? `${count} markers` : undefined,
        shared > 0
          ? `shared with ${shared} unit${shared > 1 ? "s" : ""}`
          : undefined,
        showRated ? `${rated} rated` : undefined,
      ]
        .filter(Boolean)
        .join(", ")
  return (
    <motion.button
      initial={reduce ? { opacity: 0 } : { opacity: 0, scale: SCALE.pop }}
      animate={{ opacity: 1, scale: 1 }}
      transition={reduce ? REDUCED_TRANSITION : SPRING.snappy}
      type="button"
      aria-expanded={on}
      aria-haspopup={many ? "dialog" : undefined}
      aria-label={accessibleName}
      tabIndex={disabled ? -1 : 0}
      // Handlers from wrapping anchors/triggers (Radix Slot) run alongside
      // the pin's own, never instead of them.
      onClick={(event) => {
        onToggle()
        slotClick?.(event)
      }}
      onMouseEnter={(event) => {
        onHintStart()
        slotMouseEnter?.(event)
      }}
      onFocus={(event) => {
        // Focus returned to the pin after a pointer dismiss is not a request
        // for the hint; only keyboard focus (focus-visible) shows it.
        if (event.currentTarget.matches(":focus-visible")) onHintStart()
        slotFocus?.(event)
      }}
      onMouseLeave={(event) => {
        onHintEnd()
        slotMouseLeave?.(event)
      }}
      onBlur={(event) => {
        onHintEnd()
        slotBlur?.(event)
      }}
      data-shared={shared > 0 ? shared : undefined}
      data-pin-host={agentAuthor ? "" : undefined}
      data-author={comment ? (agentAuthor ? "agent" : "person") : undefined}
      data-kind={kind}
      data-count={many ? count : undefined}
      className={cn(
        "relative inline-flex h-[22px] max-w-[220px] items-center whitespace-nowrap",
        "press motion-reduce:transition-none",
        // One focus indicator: an agent's is its avatar's ring.
        agentAuthor ? "focus-visible:outline-none" : PIN_FOCUS,
        comment
          ? cn(
              // The author's avatar, unchanged by state: the rings sit on
              // its slot (below), never on the avatar.
              "group/pin border-0 bg-transparent text-ink-2",
              many || resolved
                ? "gap-1 rounded-[7px] pr-1"
                : "w-[22px] justify-center rounded-[50%_50%_50%_14%]",
              many && !on && !agentAuthor && "hover:bg-raised"
            )
          : cn(
              "group/pin gap-[5px] rounded-md pr-2 pl-1.5 font-mono text-[11px]",
              on
                ? cn(
                    "bg-ink text-paper",
                    markerFamily(kind) === "transient" &&
                      "border border-transparent"
                  )
                : readOnly
                  ? "border-0 bg-transparent text-ink-muted shadow-[inset_0_0_0_1px_var(--nv-line)] hover:bg-raised"
                  : cn(style.tint, style.hover)
            ),
        disabled && "pointer-events-none",
        className
      )}
      {...rest}
    >
      {agentAuthor ? (
        <>
          <span className="inline-flex size-[22px] shrink-0 items-center justify-center">
            <AgentAvatar
              agent={{ short: agentAuthor.short, role: agentAuthor.role }}
              size={20}
              pinState={resolved ? "resolved" : undefined}
            />
          </span>
          {resolved && !many && (
            <CheckIcon
              aria-hidden="true"
              data-resolved=""
              strokeWidth={2.5}
              className="size-3 shrink-0 text-ink-muted"
            />
          )}
        </>
      ) : comment ? (
        <>
          <span
            data-avatar-slot=""
            className={cn(
              "inline-flex size-[22px] shrink-0 items-center justify-center rounded-[50%_50%_50%_14%] p-px",
              // Like the agent ring (round-4.md § Comment pins): in on
              // pinRing (standard decelerate), out on pinRingExit (accelerate).
              "transition-[box-shadow] duration-pin-ring-exit ease-standard-accelerate motion-reduce:transition-none",
              on
                ? "shadow-[0_0_0_2px_var(--nv-ink)] duration-pin-ring ease-standard-decelerate"
                : cn(
                    resolved && "shadow-[0_0_0_1px_var(--nv-line-strong)]",
                    !many &&
                      "group-hover/pin:shadow-[0_0_0_1.5px_var(--nv-line-strong)] group-hover/pin:duration-pin-ring group-hover/pin:ease-standard-decelerate"
                  )
            )}
          >
            <PersonAvatar person={{ initials: label }} size={20} />
          </span>
          {resolved && !many && (
            <CheckIcon
              aria-hidden="true"
              data-resolved=""
              strokeWidth={2.5}
              className="size-3 shrink-0 text-ink-muted"
            />
          )}
        </>
      ) : (
        <>
          <MarkerKindIcon
            kind={kind}
            className={
              on ? "text-paper" : readOnly ? "text-ink-muted" : style.icon
            }
          />
          <span className="shrink-0">{label}</span>
        </>
      )}
      {target && (
        <span
          className={cn(
            "min-w-0 truncate",
            // Muted holds 4.55:1 on the rest tints; the hover tints (raised-2,
            // req-tint-2, sug-tint-2) are a step darker, so the target takes
            // the pin's own ink there.
            on ? "text-paper/70" : "text-ink-muted group-hover/pin:text-current"
          )}
        >
          {target}
        </span>
      )}
      {many && (
        <span
          aria-hidden="true"
          className={cn(
            "inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-[4px] px-1 font-mono text-[10.5px] font-normal tracking-normal",
            comment
              ? "bg-raised text-ink-2"
              : on
                ? "bg-paper/20 text-paper"
                : "bg-surface text-ink-2"
          )}
        >
          {count}
        </span>
      )}
      {showRated && (
        <span
          aria-hidden="true"
          data-rated={rated}
          className={cn(
            "shrink-0 font-mono text-[10.5px]",
            on ? "text-paper/70" : "text-ink-muted group-hover/pin:text-current"
          )}
        >
          {rated} rated
        </span>
      )}
      {shared > 0 && !comment && (
        <span aria-hidden="true" className="ml-px inline-flex shrink-0 gap-0.5">
          {Array.from({ length: Math.min(shared, 3) }, (_, i) => (
            <i
              key={i}
              className={cn(
                "size-1 rounded-full bg-current",
                // 3:1 or better at 75% on a filled pin's own tint; an
                // outlined pin has no fill of its own, so its dots stay full.
                !outlined && "opacity-75"
              )}
            />
          ))}
        </span>
      )}
    </motion.button>
  )
}

/**
 * Markers anchored in collapsed lines wait on the gap row as one outlined
 * pin; opening it opens the gap (rule 4). Replaces the loose "+71" numbers.
 */
export function HiddenMarkersPin({
  count,
  onOpen,
}: {
  count: number
  onOpen: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${count} marker${count === 1 ? "" : "s"} in hidden lines. Show the lines`}
      className={cn(
        "inline-flex h-[22px] items-center gap-[5px] rounded-md border-0 bg-transparent pr-2 pl-1.5 font-mono text-[11px] whitespace-nowrap text-ink-muted shadow-[inset_0_0_0_1px_var(--nv-line)]",
        "transition-colors duration-surface-tone ease-standard hover:bg-raised motion-reduce:transition-none",
        PIN_FOCUS
      )}
    >
      <ChevronsUpDownIcon
        aria-hidden="true"
        strokeWidth={2.2}
        className="size-3 shrink-0"
      />
      {count} hidden
    </button>
  )
}

/* ── Commit point: the selection's chip ────────────────── */

/**
 * "Comment · L20–23", on the selection's last line. Click, Enter or C opens
 * the composer; Escape (handled by the desk) clears the selection.
 */
export function SelectionChip({
  label,
  onOpen,
}: {
  label: string
  onOpen: () => void
}) {
  const reduce = useReducedMotion()
  return (
    <motion.button
      type="button"
      initial={reduce ? { opacity: 0 } : { opacity: 0, scale: SCALE.pop }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, transition: REDUCED_TRANSITION }}
      transition={reduce ? REDUCED_TRANSITION : SPRING.snappy}
      style={{ transformOrigin: "left center" }}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (
          (event.key === "c" || event.key === "C") &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey
        ) {
          event.preventDefault()
          onOpen()
        }
      }}
      aria-keyshortcuts="Enter C"
      aria-label={`Comment on ${label}`}
      className="inline-flex h-[22px] items-center gap-1.5 rounded-full border-0 bg-ink px-2.5 font-sans text-[11.5px] text-paper transition-[background-color] duration-surface-tone ease-standard hover:bg-ink/90 motion-reduce:transition-none"
    >
      <MessageSquarePlusIcon aria-hidden="true" className="size-3" />
      Comment
      <span aria-hidden="true" className="font-mono text-[11px] text-paper/70">
        · {label}
      </span>
    </motion.button>
  )
}

/* ── Draft set aside with Escape ───────────────────────── */

/** A parked draft: the pencil in a dashed bubble, icon only. */
export function DraftPin({
  label,
  excerpt,
  disabled,
  onOpen,
}: {
  label: string
  excerpt: string
  disabled: boolean
  onOpen: () => void
}) {
  const reduce = useReducedMotion()
  const style = FAMILY_STYLE.draft
  return (
    <motion.button
      type="button"
      initial={reduce ? { opacity: 0 } : { opacity: 0, scale: SCALE.pop }}
      animate={{ opacity: 1, scale: 1 }}
      transition={reduce ? REDUCED_TRANSITION : SPRING.snappy}
      onClick={onOpen}
      tabIndex={disabled ? -1 : 0}
      aria-label={`Draft comment on ${label}: ${excerpt}`}
      data-kind="draft"
      className={cn(
        "inline-flex size-[22px] items-center justify-center rounded-[11px_11px_11px_3px]",
        "transition-colors duration-surface-tone ease-standard motion-reduce:transition-none",
        PIN_FOCUS,
        style.tint,
        style.hover,
        disabled && "pointer-events-none"
      )}
    >
      <MarkerKindIcon kind="draft" className={style.icon} />
    </motion.button>
  )
}

/* ── L2 card ───────────────────────────────────────────── */

/** A pill-like quiet action ("Open source →", the callout's action). */
const QUIET_ACTION =
  "inline-flex h-7 flex-none items-center gap-1.5 rounded-[7px] border-0 px-[9px] text-xs whitespace-nowrap text-ink no-underline transition-colors duration-surface-tone ease-standard hover:text-ink motion-reduce:transition-none"

/**
 * Graph read-by tree: plain mono rows with `├`/`└` branches and the file on
 * the right; an untraced edge says "not traced" in red. A truncated file
 * shows its full `path:line` in a tooltip on real hover or keyboard focus,
 * wrapped and kept inside the card.
 */
function ReadByTree({
  markerKey,
  nodes,
}: {
  markerKey: string
  nodes: ReadonlyArray<ReadByNode>
}) {
  const tip = useAtomValue(treeTipAtom)
  const setTip = useSetAtom(treeTipAtom)
  const card = React.useContext(CardBoundaryContext)
  return (
    <TooltipPrimitive.Provider delayDuration={0}>
      <div
        role="list"
        aria-label="Read by"
        className="flex flex-col font-mono text-[11.5px] leading-[22px]"
      >
        {nodes.map((node, i) => {
          const id = `${markerKey}:${i}`
          const show = () => {
            if (node.fullPath) setTip(id)
          }
          const hide = () =>
            setTip((current) => (current === id ? null : current))
          return (
            <div
              key={id}
              role="listitem"
              data-tree-row={i}
              onPointerEnter={(event) => {
                if (event.pointerType === "mouse") show()
              }}
              onPointerLeave={hide}
              className="relative flex min-w-0 items-baseline gap-1.5"
            >
              <span
                aria-hidden="true"
                className="whitespace-pre text-ink-muted"
              >
                {node.prefix}
              </span>
              <span
                className={cn(
                  "whitespace-nowrap",
                  node.tone === "root" && "text-ink-muted",
                  node.tone === "node" && "text-ink",
                  node.tone === "untraced" && "text-req-fg"
                )}
              >
                {node.name}
              </span>
              <span className="flex-auto" />
              {node.where && (
                <TooltipPrimitive.Root open={tip === id && !!node.fullPath}>
                  <TooltipPrimitive.Trigger asChild>
                    <span
                      tabIndex={node.fullPath ? 0 : undefined}
                      aria-label={node.fullPath}
                      onFocus={(event) => {
                        if (event.currentTarget.matches(":focus-visible"))
                          show()
                      }}
                      onBlur={hide}
                      className={cn(
                        "min-w-0 truncate rounded-[3px] text-[10.5px]",
                        node.tone === "untraced"
                          ? "text-req-fg"
                          : "text-ink-muted"
                      )}
                    >
                      {node.where}
                    </span>
                  </TooltipPrimitive.Trigger>
                  {node.fullPath && (
                    // Escape closes the path first, then the card.
                    <FloatingHint
                      side="top"
                      align="end"
                      boundary={card.current}
                      label={node.fullPath}
                      onEscape={hide}
                    >
                      <span
                        data-tip-text=""
                        className="box-border block w-max max-w-[284px] rounded-md bg-peek px-2 py-1 font-mono text-[11px] leading-4 break-all whitespace-normal text-peek-fg"
                      >
                        {node.fullPath}
                      </span>
                    </FloatingHint>
                  )}
                </TooltipPrimitive.Root>
              )}
            </div>
          )
        })}
      </div>
    </TooltipPrimitive.Provider>
  )
}

function Excerpt({
  markerKey,
  excerpt,
}: {
  markerKey: string
  excerpt: MarkerExcerpt
}) {
  switch (excerpt.kind) {
    case "tree":
      return <ReadByTree markerKey={markerKey} nodes={excerpt.nodes} />
    case "versus":
      return (
        <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-stretch gap-1.5">
          <div className="flex flex-col gap-1 rounded-lg bg-paper px-[9px] py-2">
            <span className="font-mono text-[10px] text-ink-muted">
              {excerpt.a.source}
            </span>
            <span className="text-xs leading-4">{excerpt.a.text}</span>
          </div>
          <span className="self-center font-mono text-[10px] text-ink-muted">
            vs
          </span>
          <div className="flex flex-col gap-1 rounded-lg bg-req-tint px-[9px] py-2">
            <span className="font-mono text-[10px] text-req-ink">
              {excerpt.b.source}
            </span>
            <span className="text-xs leading-4">{excerpt.b.text}</span>
          </div>
        </div>
      )
    case "code":
      return (
        <div className="rounded-lg bg-paper px-2.5 py-2 font-mono text-[11.5px] leading-[18px] wrap-anywhere whitespace-pre-wrap">
          <HighlightedCode code={excerpt.code} />
        </div>
      )
    case "quote":
      return (
        <div className="grid grid-cols-[14px_minmax(0,1fr)] gap-1.5">
          <span
            aria-hidden="true"
            className="font-serif text-[26px] leading-[22px] text-ink-muted"
          >
            “
          </span>
          <span className="text-[12.5px] leading-[18px] text-ink">
            {excerpt.text}
          </span>
        </div>
      )
  }
}

/** The callout's single action. */
function CheckActionButton({
  action,
  onAction,
}: {
  action: MarkerCheckAction
  onAction: (action: MarkerCheckAction) => void
}) {
  const className = cn(
    QUIET_ACTION,
    "self-start bg-surface shadow-[0_0_0_1px_var(--nv-line)] hover:bg-raised"
  )
  const icon = (
    <ArrowRightIcon aria-hidden="true" className="size-3" strokeWidth={1.9} />
  )
  if (action.kind === "unit") {
    return (
      <NeuveLink
        destination={{ to: "unit", unitId: action.unitId }}
        className={className}
      >
        {action.label}
        {icon}
      </NeuveLink>
    )
  }
  if (action.kind === "file") {
    return (
      <a href={editorHref("VS Code", action.path)} className={className}>
        {action.label}
        {icon}
      </a>
    )
  }
  return (
    <button
      type="button"
      className={className}
      onClick={() => onAction(action)}
    >
      {action.label}
      {icon}
    </button>
  )
}

/**
 * L2 card, restyled per source kind: kind icon tile and one kind label that
 * already carries status, title + mono meta, the kind-specific excerpt,
 * why it's here, the "Before you decide" callout with one action, and a
 * quiet "Open source →". It sticks at the top of the viewport while the
 * file scrolls, capped at the viewport height, and never scrolls sideways.
 *
 * A context reference is a summary that says why it is here first: its
 * file (name, then folder), then its reason led by how it bears on the
 * change ("Supports."), then what to check. The open card tints the lines it
 * is about in the diff, so the card never repeats them; the code waits in
 * the source sheet.
 */
export function ContextCard({
  marker,
  onClose,
  back,
  onOpenSource,
  onCheckAction = () => {},
  floating = false,
  className,
}: {
  marker: ContextualMarker
  onClose: () => void
  /**
   * A card chosen from a line's list: a back control returns to it.
   * `label` names the list, e.g. "Back to 5 markers".
   */
  back?: CardBack
  onOpenSource: () => void
  onCheckAction?: (action: MarkerCheckAction) => void
  /**
   * Inside a FloatingCard: the floating layer owns the surface, the shadow,
   * the height cap and the entrance motion.
   */
  floating?: boolean
  className?: string
}) {
  const float = useFloatMotion(true)
  const kind = markerKind(marker)
  const onFeedbackKey = useReferenceFeedbackKey(marker.key)
  // Tooltips inside (the graph path) stay inside this card.
  const boundary = React.useRef<HTMLDivElement | null>(null)
  const floatingBoundary = React.useContext(CardBoundaryContext)
  // A context reference leads with its tie to this unit and names its file.
  const tie = marker.reference
  const path = marker.source.path
  const closeButton = (
    <Button
      type="button"
      variant="quiet"
      size="icon-card"
      aria-label="Close context"
      onClick={onClose}
      className="size-[26px] shrink-0"
    >
      <XIcon aria-hidden="true" className="size-[11px]" />
    </Button>
  )
  const backButton = back && <CardBackButton back={back} />
  const excerpt = marker.excerpt && (
    <div className="px-3.5 pt-3">
      <Excerpt markerKey={marker.key} excerpt={marker.excerpt} />
    </div>
  )
  const check = marker.check && (
    <div className="mx-3.5 mt-3 flex flex-col gap-2 rounded-lg bg-raised py-2.5 pr-2.5 pl-3">
      <span className="label-mono text-[10px]">Before you decide</span>
      <span className="text-[12.5px] leading-[18px] text-ink">
        {marker.check}
      </span>
      {marker.checkAction && (
        <CheckActionButton
          action={marker.checkAction}
          onAction={onCheckAction}
        />
      )}
    </div>
  )
  return (
    <CardBoundaryContext.Provider
      value={floating ? floatingBoundary : boundary}
    >
      <motion.div
        ref={boundary}
        role="region"
        aria-label={marker.title}
        data-context-card=""
        onKeyDown={onFeedbackKey}
        {...(floating ? { initial: false } : float)}
        style={{ transformOrigin: "top left" }}
        className={cn(
          "box-border flex w-full flex-col overflow-x-hidden rounded-xl bg-surface pb-0 font-sans text-sm text-ink",
          floating ? "shrink-0" : "shadow-card",
          className
        )}
      >
        {tie ? (
          <>
            <div
              className={cn(
                "flex items-start gap-2 pt-3 pr-2.5",
                backButton ? "pl-2.5" : "pl-3.5"
              )}
            >
              {backButton}
              <MarkerKindTile kind={kind} />
              <span className="sr-only">{marker.kindLabel}</span>
              {path ? (
                <PathLabel path={path} className="flex-auto pt-[3px]" />
              ) : (
                <span className="min-w-0 flex-auto pt-[3px] text-[13.5px] leading-[19px] font-semibold tracking-[-0.01em] wrap-anywhere">
                  {marker.title}
                </span>
              )}
              {closeButton}
            </div>
            <ReferenceWhy
              tie={tie}
              why={marker.applies}
              className="mx-3.5 mt-3 text-[13.5px] leading-5"
            />
            {marker.check && (
              <BeforeYouDecide
                check={marker.check}
                className="mx-3.5 mt-3.5 text-[12.5px] leading-[18px]"
              >
                {marker.checkAction && (
                  <CheckActionButton
                    action={marker.checkAction}
                    onAction={onCheckAction}
                  />
                )}
              </BeforeYouDecide>
            )}
          </>
        ) : (
          <>
            <div
              className={cn(
                "flex items-center gap-2 pt-3 pr-2.5",
                backButton ? "pl-2.5" : "pl-3.5"
              )}
            >
              {backButton}
              <MarkerKindTile kind={kind} />
              <span
                className={cn(
                  "min-w-0 flex-auto truncate label-mono text-[10.5px]",
                  FAMILY_STYLE[markerFamily(kind)].label
                )}
              >
                {marker.kindLabel}
              </span>
              {closeButton}
            </div>
            <div className="flex flex-col gap-0.5 px-3.5 pt-2.5">
              <span className="text-sm leading-[19px] font-semibold tracking-[-0.01em] wrap-anywhere">
                {marker.title}
              </span>
              <span className="font-mono text-[10.5px] wrap-anywhere text-ink-muted">
                {marker.meta}
              </span>
            </div>
            {excerpt}
            <p className="m-0 mx-3.5 mt-3 text-[12.5px] leading-[18px] text-ink-2">
              {marker.applies}
            </p>
            {check}
          </>
        )}
        {tie && (
          <HarnessGrade markerKey={marker.key} className="mx-3.5 mt-3.5" />
        )}
        <div className="mt-3 flex items-center justify-end gap-2 px-2.5 pt-2 pb-2.5">
          <ReferenceFeedback
            markerKey={marker.key}
            hasCheck={!!marker.check}
            className="mr-auto"
          />
          <button
            type="button"
            onClick={onOpenSource}
            aria-haspopup="dialog"
            data-source-trigger=""
            className={cn(QUIET_ACTION, "bg-raised hover:bg-raised-2")}
          >
            Open source
            <ArrowRightIcon
              aria-hidden="true"
              className="size-3"
              strokeWidth={1.9}
            />
          </button>
        </div>
      </motion.div>
    </CardBoundaryContext.Provider>
  )
}

/* ── Inline comment composer (the expanded layer) ──────── */

const COMPOSER_EXIT = {
  // Collapses toward the pin row (top-left of its overlay item).
  scale: SCALE.collapse,
  transition: {
    duration: ms(TIMING.cardExit),
    ease: EASE.emphasizedAccelerate,
  },
} as const

/**
 * The composer for the selected lines. No line picker: the anchor is the
 * gutter selection, shown as a quiet label, and dragging in the gutter
 * re-targets it live. Escape with an empty draft cancels; with text, the
 * draft is set aside as a "Draft" pin.
 */
export function CommentComposer({
  anchorLabel,
  placeholder,
  draft,
  onDraft,
  onSave,
  onCancel,
  onEscape,
}: {
  /** e.g. "revoke.ts · lines 20–23" (non-interactive). */
  anchorLabel: string
  placeholder: string
  draft: string
  onDraft: (value: string) => void
  onSave: () => void
  onCancel: () => void
  onEscape: () => void
}) {
  const reduce = useReducedMotion()
  const id = React.useId()
  const empty = draft.trim() === ""
  // The layer places (un-hides) a new item on its next frame, so retry for a
  // few frames until the textarea can take focus.
  const focusOnMount = React.useCallback(
    (element: HTMLTextAreaElement | null) => {
      if (!element) return
      let frame = 0
      let attempts = 0
      const tryFocus = () => {
        element.focus({ preventScroll: true })
        if (
          element.ownerDocument.activeElement !== element &&
          attempts++ < 60
        ) {
          frame = requestAnimationFrame(tryFocus)
        }
      }
      frame = requestAnimationFrame(tryFocus)
      return () => cancelAnimationFrame(frame)
    },
    []
  )
  return (
    <motion.div
      role="dialog"
      aria-label={`New review comment, ${anchorLabel}`}
      initial={
        reduce
          ? { opacity: 0 }
          : { opacity: 0, y: CARD.offsetY, scale: CARD.initialScale }
      }
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={
        reduce
          ? { opacity: 0, transition: REDUCED_TRANSITION }
          : { opacity: 0, ...COMPOSER_EXIT }
      }
      transition={reduce ? REDUCED_TRANSITION : CARD.enter}
      style={{ transformOrigin: "top left" }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation()
          onEscape()
        }
      }}
      className="box-border flex w-full flex-col gap-2 rounded-xl bg-surface px-3 pt-2.5 pb-3 font-sans text-ink shadow-card"
    >
      <p
        id={`${id}-anchor`}
        className="m-0 truncate font-mono text-[11px] leading-4 text-ink-muted"
      >
        {anchorLabel}
      </p>
      <label htmlFor={`${id}-body`} className="sr-only">
        Comment
      </label>
      <textarea
        id={`${id}-body`}
        rows={3}
        ref={focusOnMount}
        value={draft}
        onChange={(event) => onDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            // Keep ⌘↵ from reaching the desk's approve shortcut.
            event.preventDefault()
            event.stopPropagation()
            if (!empty) onSave()
          }
        }}
        placeholder={placeholder}
        aria-describedby={`${id}-anchor`}
        aria-keyshortcuts="Meta+Enter"
        className="min-h-[68px] w-full resize-y rounded-lg border-0 bg-raised px-2.5 py-2 text-[12.5px] leading-[18px] text-ink outline-none placeholder:text-ink-muted focus-visible:shadow-[inset_0_0_0_1px_var(--nv-focus)]"
      />
      <div className="flex items-center justify-end gap-1.5">
        <Button type="button" variant="quiet" size="compact" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="ink"
          size="compact"
          onClick={onSave}
          disabled={empty}
          aria-keyshortcuts="Meta+Enter"
          // Disabled reads as "waiting for text": a quiet raised tone in our
          // palette, not a faded slab.
          className="disabled:bg-raised-2 disabled:text-ink-muted disabled:opacity-100"
        >
          Comment
          <span className="font-mono text-[10.5px] opacity-70">⌘↵</span>
        </Button>
      </div>
    </motion.div>
  )
}

/* ── L1 peek (one per file, placed against the pin) ───── */

export interface CommentPreview {
  author: string
  initials: string
  /** The author's kind; absent means a person (see ContextualMarker). */
  avatar?: ContextualMarker["author"]
  /** "L20–23" */
  range?: string
}

/**
 * One marker in the peek or the line's list: icon, kind, why, meta. A
 * context reference names its file and says how it bears on the change.
 */
function MarkerRow({
  marker,
  feedback = false,
}: {
  marker: ContextualMarker
  /** In the line's list: the reader's answer under the reason, when rated. */
  feedback?: boolean
}) {
  const kind = markerKind(marker)
  const tie = marker.reference
  return (
    <>
      {kind === "comment" ? (
        <CommentAuthorAvatar
          author={marker.author}
          short={marker.short}
          size={16}
          className="mt-px"
        />
      ) : (
        <MarkerKindIcon
          kind={kind}
          className={cn("mt-[3px]", FAMILY_STYLE[markerFamily(kind)].icon)}
        />
      )}
      <span className="min-w-0 truncate text-[12px] leading-[18px] font-semibold text-ink">
        {tie && marker.source.path ? (
          <>
            <span className="sr-only">{marker.kindLabel}, </span>
            {pathParts(marker.source.path).name}
          </>
        ) : (
          marker.kindLabel
        )}
      </span>
      {tie ? (
        <>
          <ReferenceWhy
            inline
            tie={tie}
            why={marker.peek}
            className="col-start-2 line-clamp-2 text-[12px] leading-[17px] text-ink-muted"
          />
        </>
      ) : (
        <>
          <span className="col-start-2 line-clamp-2 text-[12px] leading-[17px] text-ink-muted">
            {marker.peek}
          </span>
          {marker.meta && (
            <span className="col-start-2 truncate font-mono text-[11px] leading-4 text-faint">
              {marker.meta}
            </span>
          )}
        </>
      )}
      {feedback && (
        <ReferenceFeedbackSummary
          markerKey={marker.key}
          className="col-start-2 mt-1"
        />
      )}
    </>
  )
}

const ROW =
  "grid w-full grid-cols-[16px_minmax(0,1fr)] items-start gap-x-2 gap-y-0.5 rounded-[7px] p-2 text-left"

/**
 * L1 peek: a light card with one row per marker on the line, raised by real
 * hover or keyboard focus on the pin. Never a grey translucent tooltip.
 */
export function HintBubble({
  text,
  comment,
  markers,
  floating = false,
}: {
  text: string
  /** A single review comment previews as author, lines and body. */
  comment?: CommentPreview
  /** Every marker on the pin's line, lead first. */
  markers?: ReadonlyArray<ContextualMarker>
  /** Inside a FloatingHint, which owns the entrance motion. */
  floating?: boolean
}) {
  const reduce = useReducedMotion()
  const motionProps = {
    initial: floating
      ? (false as const)
      : reduce
        ? { opacity: 0 }
        : { opacity: 0, y: HINT.offsetY },
    animate: { opacity: 1, y: 0 },
    transition: reduce ? REDUCED_TRANSITION : HINT.transition,
  }
  if (comment && (!markers || markers.length <= 1)) {
    return (
      <motion.div
        aria-hidden="true"
        {...motionProps}
        className="pointer-events-none flex w-[248px] flex-col gap-1.5 rounded-[10px] bg-surface px-3 py-2.5 text-left font-sans shadow-card"
      >
        <span className="flex items-center gap-2 text-[12px] leading-4">
          <CommentAuthorAvatar
            author={comment.avatar}
            short={comment.initials}
            size={20}
          />
          <span className="truncate font-semibold text-ink">
            {comment.author}
          </span>
          {comment.range && (
            <span className="ml-auto shrink-0 font-mono text-[10.5px] text-ink-muted">
              {comment.range}
            </span>
          )}
        </span>
        <span className="line-clamp-2 text-[12.5px] leading-[18px] text-ink-2">
          {text}
        </span>
      </motion.div>
    )
  }
  return (
    <motion.div
      aria-hidden="true"
      {...motionProps}
      data-peek=""
      className="pointer-events-none box-border flex w-[min(300px,calc(100vw-16px))] flex-col rounded-[10px] bg-surface p-1.5 text-left font-sans shadow-card"
    >
      {markers && markers.length > 0 ? (
        markers.map((marker) => (
          <div key={marker.key} className={ROW}>
            <MarkerRow marker={marker} />
          </div>
        ))
      ) : (
        <span className="p-2 text-[12px] leading-[17px] text-ink-2">
          {text}
        </span>
      )}
    </motion.div>
  )
}

/**
 * The line's list, opened by a pin that counts several markers: the same
 * rows as the peek, each opening its marker's card. Arrow keys move
 * between rows.
 */
export function LineMarkerList({
  markers,
  label,
  onChoose,
  focusKey,
}: {
  markers: ReadonlyArray<ContextualMarker>
  /** e.g. "3 markers on line 23". */
  label: string
  onChoose: (markerKey: string) => void
  /** Back from a row's card: that row takes focus when the list mounts. */
  focusKey?: string
}) {
  return (
    <div
      role="group"
      aria-label={label}
      data-line-list=""
      className="flex flex-col p-1.5 font-sans"
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
        const rows = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
        ]
        const at = rows.indexOf(event.target as HTMLButtonElement)
        if (at < 0) return
        event.preventDefault()
        const next = event.key === "ArrowDown" ? at + 1 : at - 1
        rows[(next + rows.length) % rows.length]?.focus()
      }}
    >
      {markers.map((marker) => (
        <button
          key={marker.key}
          ref={marker.key === focusKey ? focusAsLastInput : undefined}
          type="button"
          onClick={() => onChoose(marker.key)}
          className={cn(
            ROW,
            "border-0 bg-transparent transition-colors duration-surface-tone ease-standard hover:bg-raised motion-reduce:transition-none",
            "focus-visible:bg-raised focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus focus-visible:outline-solid"
          )}
        >
          <MarkerRow marker={marker} feedback />
        </button>
      ))}
    </div>
  )
}

/* ── One line of the margin: grouping and its layers ───── */

export interface MarkerLineEntry {
  anchor: MarkerAnchor
  marker: ContextualMarker
}

/** The markers anchored on one diff line, highest priority first. */
export interface MarkerLineGroup {
  /**
   * The line's position in its file, `${side}:${lineNumber}`: the overlay
   * annotation id. It stays the same when a higher-priority item joins the
   * line, so the pin never remounts.
   */
  id: string
  side: DiffSide
  lineNumber: number
  entries: Array<MarkerLineEntry>
}

/** One group per anchored line, in first-seen order (rules 1 and 3). */
export function groupMarkerAnchors(
  anchors: ReadonlyArray<MarkerAnchor>,
  markers: Record<string, ContextualMarker>
): Array<MarkerLineGroup> {
  const lines = new Map<string, Array<MarkerLineEntry>>()
  for (const anchor of anchors) {
    const marker = markers[anchor.markerKey]
    if (!marker) continue
    const key = `${anchor.side}:${anchor.lineNumber}`
    const entries = lines.get(key)
    if (entries) entries.push({ anchor, marker })
    else lines.set(key, [{ anchor, marker }])
  }
  return [...lines.values()].map((entries) => {
    // Array.prototype.sort is stable: same-kind markers keep data order.
    const sorted = [...entries].sort(
      (a, b) =>
        markerPriority(markerKind(a.marker)) -
        markerPriority(markerKind(b.marker))
    )
    const lead = sorted[0]!
    return {
      id: `${lead.anchor.side}:${lead.anchor.lineNumber}`,
      side: lead.anchor.side,
      lineNumber: lead.anchor.lineNumber,
      entries: sorted,
    }
  })
}

/** The lines a marker is about: its range, or its anchored line. */
export function markerLines(anchor: MarkerAnchor): LineRange {
  return (
    anchor.range ?? {
      start: anchor.lineNumber,
      end: anchor.lineNumber,
      side: anchor.side,
    }
  )
}

/** Every line a group's markers are about (tinted while its pin is hovered). */
export function linesOfGroup(group: MarkerLineGroup): LineRange {
  const ranges = group.entries.map((entry) => markerLines(entry.anchor))
  const lead = ranges[0]!
  // A range that crosses sides stays as it is; merging it is ambiguous.
  if (ranges.some((range) => range.side !== lead.side || range.endSide))
    return lead
  return {
    side: lead.side,
    start: Math.min(...ranges.map((range) => range.start)),
    end: Math.max(...ranges.map((range) => range.end)),
  }
}

/**
 * The group whose line carries a marker, e.g. the pointed-at line from
 * `hoverHintAtom`, which holds the lead marker's key.
 */
export function groupOfMarker(
  groups: ReadonlyArray<MarkerLineGroup>,
  markerKey: string
): MarkerLineGroup | undefined {
  return groups.find((group) =>
    group.entries.some((entry) => entry.marker.key === markerKey)
  )
}

/** A pin carrying a marker, by its `data-marker-keys` list. */
export function markerPinSelector(markerKey: string): string {
  return `button[data-marker-keys~="${CSS.escape(markerKey)}"]`
}

/**
 * Everything one line of the margin shows, slotted by the diff into the
 * line's overlay pin slot: the reference pin with its layers, and the line's
 * checkpoints beside it (10.110).
 */
export function MarginLine(props: React.ComponentProps<typeof ReferenceLine>) {
  const { group, filePath, unitId } = props
  const landOn = useSetAtom(landOnAtom)
  const references = group.entries.filter(
    (entry) => !isCheckpoint(entry.marker)
  )
  const checkpoints = group.entries.filter((entry) =>
    isCheckpoint(entry.marker)
  )
  const mark = checkpoints.length > 0 && (
    <CheckpointMark
      markers={checkpoints.map((entry) => entry.marker)}
      filePath={filePath}
      lineNumber={group.lineNumber}
      onLand={(markerKey) => {
        const entry = checkpoints.find((e) => e.marker.key === markerKey)
        if (entry && unitId)
          landOn({
            unitId,
            filePath,
            range: markerLines(entry.anchor),
            scroll: "if-needed",
          })
      }}
    />
  )
  if (references.length === 0) return mark || null
  return (
    <>
      <ReferenceLine {...props} group={{ ...group, entries: references }} />
      {mark}
    </>
  )
}

/**
 * The line's reference pin, its peek on hover or focus, the line's list,
 * and the open marker's card, comment thread or comment preview. They float
 * against the viewport, anchored to the pin (floating.tsx).
 */
function ReferenceLine({
  group,
  filePath,
  readOnly = false,
  comments = {},
  reviewer,
  agentId,
  unitId,
  onCheckAction,
}: {
  group: MarkerLineGroup
  /** The file under review. */
  filePath: string
  /**
   * The unit whose diff renders the line: opening an item's card lands on
   * its lines there (round 5b), as a briefing chip does.
   */
  unitId?: string
  /** A read-only neighbor: retrieved context pins are outlined. */
  readOnly?: boolean
  /** Review comment records by marker key. */
  comments?: Record<string, ReviewCommentRecord>
  reviewer: ReviewCommentAuthor
  /** The unit's agent: replies to a thread go to it by default. */
  agentId?: string
  onCheckAction?: (marker: ContextualMarker, action: MarkerCheckAction) => void
}) {
  const open = useAtomValue(openMarkerAtom)
  const openLine = useAtomValue(openLineAtom)
  const cardFromLine = useAtomValue(cardFromLineAtom)
  const openBodies = useAtomValue(openBodiesAtom)
  const hint = useAtomValue(hoverHintAtom)
  const isolating = useAtomValue(isolatingAtom)
  const composer = useAtomValue(composerAtom)
  const threads = useAtomValue(reviewThreadsAtom)
  const repository = useAtomValue(reviewCommentRepositoryAtom)
  const setStatus = useSetAtom(repository.setStatusAtom)
  const setHint = useSetAtom(hoverHintAtom)
  const toggleMarker = useSetAtom(toggleMarkerAtom)
  const toggleLine = useSetAtom(toggleLineAtom)
  const chooseLineMarker = useSetAtom(chooseLineMarkerAtom)
  const backToLine = useSetAtom(backToLineAtom)
  const landOn = useSetAtom(landOnAtom)
  const closeLine = useSetAtom(closeLineAtom)
  const closeCard = useSetAtom(closeCardAtom)
  const openSheet = useSetAtom(openSheetAtom)
  // F on the open card's floating box itself (where focus falls back when
  // nothing inside is in view); the card's own handler covers its inside.
  const onCardFeedbackKey = useReferenceFeedbackKey(open ?? "")

  const lead = group.entries[0]!
  const count = group.entries.length
  const many = count > 1
  const line = lineKey(filePath, group.id)
  const openEntry = group.entries.find((entry) => entry.marker.key === open)
  const openRecord = openEntry ? comments[openEntry.marker.key] : undefined
  // A comment opens its thread; anything else (or a comment whose record is
  // missing) opens its card.
  const threadOpen = !!openEntry && isComment(openEntry.marker) && !!openRecord
  const cardOpen = !!openEntry && !threadOpen
  // Opening a card or the composer clears the list (marker-atoms.ts); this
  // guard keeps a value not yet cleared from showing over them.
  const listOpen =
    many && openLine === line && open === null && composer === null
  // This line's list is where the open card or thread was chosen.
  const fromList =
    many &&
    cardFromLine?.line === line &&
    cardFromLine.markerKey === open &&
    (cardOpen || threadOpen)
  const back: CardBack | undefined = fromList
    ? { label: `Back to ${count} markers`, onBack: backToLine }
    : undefined
  const preview = openEntry
    ? undefined
    : group.entries.find(
        (entry) =>
          isComment(entry.marker) &&
          openBodies.includes(entry.marker.key) &&
          !!comments[entry.marker.key]
      )
  const previewRecord = preview ? comments[preview.marker.key] : undefined
  const hinted =
    hint?.filePath === filePath &&
    hint.markerKey === lead.marker.key &&
    !isolating
  const layerOpen = cardOpen || threadOpen || listOpen || !!previewRecord
  const sharedWith = [
    ...new Set(group.entries.flatMap((entry) => entry.marker.sharedWith ?? [])),
  ]
  const leadRecord = comments[lead.marker.key]
  const rated = useRatedReferences(
    group.entries.map((entry) => entry.marker.key)
  )
  const commentLabel = (entry: MarkerLineEntry) =>
    rangeLabel(markerLines(entry.anchor))
  const pin = React.useRef<HTMLButtonElement | null>(null)
  const returnFocus = () => pin.current?.focus()
  const endHint = () =>
    setHint((current) =>
      current?.markerKey === lead.marker.key ? null : current
    )
  // Opening a marker's card lands on its lines, as a briefing chip does:
  // the landing tint holds, then fades. Lines already in view do not
  // scroll. Closing a card plays nothing, and a review comment's thread
  // does not land (its pin only lights its lines on hover).
  const land = (entry: MarkerLineEntry | undefined) => {
    if (entry && unitId && !isComment(entry.marker))
      landOn({
        unitId,
        filePath,
        range: markerLines(entry.anchor),
        scroll: "if-needed",
      })
  }
  const openItem = (markerKey: string) => {
    toggleMarker(markerKey)
    land(group.entries.find((entry) => entry.marker.key === markerKey))
  }
  const chooseMarker = (markerKey: string) => {
    chooseLineMarker({ line, markerKey })
    land(group.entries.find((entry) => entry.marker.key === markerKey))
  }

  return (
    // Its own provider, so the line works outside a diff file too.
    <TooltipPrimitive.Provider delayDuration={0}>
      <PopoverPrimitive.Root
        open={layerOpen}
        onOpenChange={(next) => {
          if (next) return
          if (openEntry) closeCard()
          else if (listOpen) closeLine()
        }}
      >
        <TooltipPrimitive.Root open={hinted && !layerOpen}>
          <TooltipPrimitive.Trigger asChild>
            <PopoverPrimitive.Anchor asChild>
              <MarginPin
                ref={pin}
                marker={lead.marker}
                rangeLabel={
                  isComment(lead.marker) ? commentLabel(lead) : undefined
                }
                on={!!openEntry || listOpen}
                readOnly={readOnly && !isComment(lead.marker)}
                count={count}
                {...(rated ? { rated } : {})}
                reviewedPath={filePath}
                lineNumber={group.lineNumber}
                sharedWith={sharedWith}
                resolved={!many && leadRecord?.status === "resolved"}
                disabled={isolating && !openEntry}
                data-anchor={`${group.side}:${group.lineNumber}`}
                data-marker-key={lead.marker.key}
                data-line={group.id}
                data-marker-keys={group.entries
                  .map((entry) => entry.marker.key)
                  .join(" ")}
                onToggle={() => {
                  if (many) toggleLine(line)
                  else {
                    closeLine()
                    if (openEntry) toggleMarker(lead.marker.key)
                    else openItem(lead.marker.key)
                  }
                }}
                // The hint names the lead marker, so the rail can link the
                // units it is shared with.
                onHintStart={() =>
                  setHint({ filePath, markerKey: lead.marker.key })
                }
                onHintEnd={endHint}
              />
            </PopoverPrimitive.Anchor>
          </TooltipPrimitive.Trigger>
          {hinted && !layerOpen && (
            // Escape ends the hint, as the pin's own hint end does (WCAG
            // 1.4.13); embedded in Ace, the next press then goes to Ace.
            <FloatingHint
              onEscape={endHint}
              label={`${group.entries
                .map(
                  (entry) =>
                    `${entry.marker.kindLabel}: ${entry.marker.peek.replace(/[.\s]+$/, "")}`
                )
                .join(". ")}.`}
            >
              <HintBubble
                floating
                text={lead.marker.peek}
                markers={group.entries.map((entry) => entry.marker)}
                comment={
                  !many && isComment(lead.marker)
                    ? {
                        author: lead.marker.title.replace(/ commented$/, ""),
                        initials: lead.marker.short,
                        avatar: lead.marker.author,
                        range: commentLabel(lead),
                      }
                    : undefined
                }
              />
            </FloatingHint>
          )}
        </TooltipPrimitive.Root>
        {layerOpen && (
          <FloatingCard
            {...(onCardFeedbackKey && open !== null && cardOpen
              ? { onKeyDown: onCardFeedbackKey }
              : {})}
            label={
              listOpen
                ? `${count} markers on line ${group.lineNumber}`
                : threadOpen
                  ? `Comment thread on ${commentLabel(openEntry)}`
                  : (openEntry?.marker.title ??
                    `Comment on ${preview ? commentLabel(preview) : ""}`)
            }
            // A marker's card names the lines it lights (round 5c), so the
            // connection to the code is not visual only.
            description={
              cardOpen
                ? `About ${linesName(markerLines(openEntry.anchor))}`
                : undefined
            }
            onReturnFocus={returnFocus}
            // Escape steps back one layer, as it does from the source
            // sheet: a card chosen from the list returns to it, and the
            // desk's own Escape (a full close) does not also run.
            onEscape={
              fromList
                ? (event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    backToLine()
                  }
                : undefined
            }
            passive={!!previewRecord && !openEntry && !listOpen}
          >
            {listOpen ? (
              <LineMarkerList
                markers={group.entries.map((entry) => entry.marker)}
                label={`${count} markers on line ${group.lineNumber}`}
                onChoose={chooseMarker}
                focusKey={
                  cardFromLine?.line === line
                    ? cardFromLine.markerKey
                    : undefined
                }
              />
            ) : threadOpen ? (
              <ThreadCard
                floating
                record={openRecord}
                rangeLabel={commentLabel(openEntry)}
                thread={threads[openRecord.id]}
                fallbackAgentId={agentId}
                reviewer={reviewer}
                back={back}
                onDismiss={() => {
                  closeCard()
                  returnFocus()
                }}
                onToggleStatus={() =>
                  setStatus(
                    openRecord.id,
                    openRecord.status === "open" ? "resolved" : "open"
                  )
                }
              />
            ) : cardOpen ? (
              <ContextCard
                floating
                marker={openEntry.marker}
                onClose={closeCard}
                back={back}
                onOpenSource={openSheet}
                onCheckAction={(action) =>
                  onCheckAction?.(openEntry.marker, action)
                }
              />
            ) : preview && previewRecord ? (
              <CommentPreviewCard
                floating
                record={previewRecord}
                rangeLabel={commentLabel(preview)}
                thread={threads[previewRecord.id]}
                onOpen={() => openItem(preview.marker.key)}
              />
            ) : null}
          </FloatingCard>
        )}
      </PopoverPrimitive.Root>
    </TooltipPrimitive.Provider>
  )
}
