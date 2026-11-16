/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD — File header, owned ranges, landing (round 3)
 *
 * Sticky header (Sticky.dc.html, merged variant):
 *  scroll  header sticks at the top of the desk's scroller (native sticky)
 *    0ms   stuck — soft shadow (--nv-shadow-stuck) in (stuck 160ms,
 *          standard); the corners square at once; the "2 / 3" position and
 *          Stacked/Split/Wrap icons fade + drop 3px into place (stuckEnter
 *          180ms, emphasized decelerate); unstuck: stuckExit 140ms out
 *  hover   copy-path icon fades in on real hover or focus-within
 *          (surfaceTone 120ms)
 *
 * Fold (chevron or Viewed):
 *    0ms   chevron turns −90° (chevron 200ms, standard)
 *    0ms   opening: rows fade in (swap 180ms); folding: rows leave at once
 *
 * Owned ranges (Ranges.dc.html):
 *    0ms   gap row — its next part opens in place, from the owned code
 *          outward: up to 20 unchanged lines, or a whole run another unit
 *          owns (no motion: rows re-render inside the renderer, so a fade
 *          would replay); the row moves on to the next part
 *
 * Whole file: other units' runs read-only, their owner chip in the margin
 * on each run's first line (no motion).
 *
 * Landing (briefing chip or Files tab):
 *    0ms   folded file opens; the gap row holding the lines opens whole
 *    0ms   smooth scroll puts the first line below the sticky header
 *    0ms   lines tint --nv-land, hold 275ms, fade over 825ms (fork CSS)
 *
 * Reduced motion: instant scroll, static tint until the next pointer or key
 * press, no fades or rises; chevrons snap.
 * ───────────────────────────────────────────────────────── */

import * as React from "react"
import { atom, useAtomValue, useSetAtom } from "jotai"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import {
  CheckIcon,
  ChevronDownIcon,
  Columns2Icon,
  CopyIcon,
  LockIcon,
  ChevronsUpDownIcon,
  Rows2Icon,
  WrapTextIcon,
} from "lucide-react"
import {
  getHunkSeparatorSlotName,
  getOverlayBodySlotName,
  getOverlayPinSlotName,
} from "@workspace/diffs"
import type { DiffLineAnnotation } from "@workspace/diffs"

import { cn } from "@workspace/ui/lib/utils"
import {
  EASE,
  REDUCED_TRANSITION,
  TIMING,
  ms,
  OFFSET,
  SCALE,
} from "@workspace/ui/lib/motion"
import {
  closingComposerAtom,
  commentDraftAtom,
  composerAtom,
  diffLayoutAtom,
  discardCommentAtom,
  effectiveLayoutAtom,
  escapeComposerAtom,
  hoverHintAtom,
  isolatingAtom,
  lineSelectionAtom,
  openComposerAtom,
  openMarkerAtom,
  parkedDraftsAtom,
  saveCommentAtom,
  selectLinesAtom,
  splitFitsAtom,
  wrapAtom,
} from "@workspace/ui/neuve/review-desk/atoms"
import {
  CommentComposer,
  DraftPin,
  HiddenMarkersPin,
  MarginLine,
  SelectionChip,
  groupMarkerAnchors,
  groupOfMarker,
  linesOfGroup,
  markerLines,
} from "@workspace/ui/neuve/review-desk/context-margin"
import { shownAnchors } from "@workspace/ui/neuve/review-desk/checkpoint-parts"
import {
  INLINE_GAP,
  displayRows,
  foldSlotName,
  hiddenGapLines,
  normalizeRange,
  rangeKey,
  rangeLabel,
  rangePhrase,
  rangeRows,
  rangedLayout,
  rangedView,
  ownsSelection,
  stretchHides,
  stretchView,
  toFileDiff,
} from "@workspace/ui/neuve/review-desk/diff-model"
import type {
  RangedRun,
  RangedView,
  StretchState,
  StretchView,
} from "@workspace/ui/neuve/review-desk/diff-model"
import {
  GAP_CHUNK,
  fileFoldAtom,
  fileKey,
  gapExpansionAtom,
  landedTintAtom,
  openSiblingsAtom,
  openStretchAtom,
  codeWidthAtom,
  isFileRenderedAtom,
  registerFileAtom,
  setCodeWidthAtom,
  setLandedTintAtom,
  setViewedAtom,
  setWholeFileAtom,
  toggleFoldAtom,
  wholeFileAtom,
} from "@workspace/ui/neuve/review-desk/diff-atoms"
import type { LandedTint } from "@workspace/ui/neuve/review-desk/diff-atoms"
import {
  SectionMargin,
  SectionRows,
} from "@workspace/ui/neuve/review-desk/section-rows"
import {
  lineKey,
  openLineAtom,
} from "@workspace/ui/neuve/review-desk/marker-atoms"
import { DiffSurface } from "@workspace/ui/neuve/review-desk/diff-surface"
import type { RangedPresentation } from "@workspace/ui/neuve/review-desk/diff-surface"
import {
  currentFileAtom,
  landingAtom,
  litLinesAtom,
  useViewedFiles,
} from "@workspace/ui/neuve/review-desk/landing"
import { LANE_NAME } from "@workspace/ui/neuve/shared/lane-facts"
import { LaneGlyph } from "@workspace/ui/neuve/shared/lane-glyph"
import { NeuveLink } from "@workspace/ui/neuve/shared/nav-link"
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@workspace/ui/components/toggle-group"
import type { DiffVariant } from "@workspace/ui/lib/diffs"
import type {
  ReviewCommentAuthor,
  ReviewCommentRecord,
} from "@workspace/ui/neuve/review-comments/record"
import type {
  ContextualMarker,
  DiffFile,
  DiffSide,
  LineRange,
  MarkerAnchor,
  MarkerCheckAction,
  NeighborContextNote,
} from "@workspace/ui/neuve/types"

/** Overlay ids: the comment composer and the selection's commit chip. */
export const COMPOSER_ID = "composer"
export const SELECTION_ID = "selection"
const draftId = (id: string) => `draft:${id}`
const noteId = (key: string) => `note:${key}`
const hiddenId = (slot: string) => `hidden:${slot}`
const ownerId = (hunkIndex: number) => `owner:${hunkIndex}`

/** A collapsed file's code rising in (read-only neighbor). */
const RISE = {
  offsetY: OFFSET.lift, // px the rows rise from
  initialScale: SCALE.enter,
  enter: { duration: ms(TIMING.dockRise), ease: EASE.emphasizedDecelerate },
  exit: { duration: ms(TIMING.dockExit), ease: EASE.emphasizedAccelerate },
} as const

/** Opening a folded file: rows fade in; folding removes them at once. */
const FOLD = {
  enter: { duration: ms(TIMING.swap), ease: EASE.standard },
} as const

/** The chevron turns −90° when the file folds. */
const CHEVRON = { duration: ms(TIMING.chevron), ease: EASE.standard } as const

/** Landing tint: hold 275ms + fade 825ms (fork CSS); cleared after. */
const LAND_MS = TIMING.landHold + TIMING.landFade

/** How long "copied" shows on the copy-path icon. */
const COPIED_MS = 1200

/**
 * Sticky file header (Sticky.dc.html, merged variant). Native sticky inside
 * the card; stuck styling from a scroll-state container query, with the
 * IntersectionObserver fallback (modern-web-guidance) setting data-stuck.
 * The stuck-only controls take no width until stuck (display, entering via
 * @starting-style), so the path keeps the room; the header's height never
 * changes, so scroll anchoring cannot oscillate.
 *
 * The file name wins (round 3.1, D2). The directory gives way first; then,
 * only as far as the basename needs the room (measured, see fitHeader), the
 * header sheds in order: 1 the stuck controls, 2 "Owned ranges / Whole
 * file" → "Owned / Whole", 3 Viewed keeps only its box, 4 the +/− counts
 * (visually; screen readers keep them). Only then does the basename
 * truncate. Accessible names never change. Copy-path shows on hover or
 * focus and takes no width while hidden; the fit counts it as shown (so
 * revealing it never cuts the name) and stage 1 sheds it with the stuck
 * controls: it stays in the tab order, visually hidden, and shows as an
 * overlay at the header's end (no layout width) on keyboard focus. Before
 * the first fit (server render until hydration, first frame) the basename
 * may shrink, the path box clips, and fixed container breakpoints (760 /
 * 640 / 560 / 440px) shed the controls in the same order, so a phone's
 * server-rendered header never overflows; the measured fit replaces them.
 */
const HEADER_CSS = `
.nv-fh{position:sticky;top:0;z-index:5;container-name:nv-fh;container-type:inline-size;container-type:scroll-state inline-size}
.nv-short{display:none}
.nv-fh-in{transition:box-shadow var(--nv-dur-stuck) var(--nv-ease-standard)}
.nv-when-stuck{display:none;opacity:0;transform:translateY(calc(var(--nv-offset-stuck) * -1));transition:opacity var(--nv-dur-stuck-exit) var(--nv-ease-standard),transform var(--nv-dur-stuck-exit) var(--nv-ease-standard),display var(--nv-dur-stuck-exit) allow-discrete}
@container nv-fh scroll-state(stuck: top){
.nv-fh-in{box-shadow:var(--nv-shadow-stuck);border-bottom-color:transparent;border-radius:0}
.nv-when-stuck{display:inline-flex;opacity:1;transform:none;transition:opacity var(--nv-dur-stuck-enter) var(--nv-ease-emphasized-decelerate),transform var(--nv-dur-stuck-enter) var(--nv-ease-emphasized-decelerate),display 0s allow-discrete}
@starting-style{.nv-when-stuck{opacity:0;transform:translateY(calc(var(--nv-offset-stuck) * -1))}}
}
.nv-fh[data-stuck] .nv-fh-in{box-shadow:var(--nv-shadow-stuck);border-bottom-color:transparent;border-radius:0}
.nv-fh[data-stuck] .nv-when-stuck{display:inline-flex;opacity:1;transform:none}
@media (hover:hover){.nv-copy{width:0;opacity:0;overflow:hidden;transition:opacity var(--nv-dur-surface-tone) var(--nv-ease-standard)}.nv-fh:hover .nv-copy,.nv-fh:focus-within .nv-copy,.nv-fh[data-fitting] .nv-copy{width:28px;opacity:1}}
@media (prefers-reduced-motion:reduce){.nv-fh-in,.nv-when-stuck,.nv-copy{transition:none!important}}
.nv-fh:is([data-shed="1"],[data-shed="2"],[data-shed="3"],[data-shed="4"]) .nv-when-stuck{display:none!important}
.nv-fh:is([data-shed="1"],[data-shed="2"],[data-shed="3"],[data-shed="4"]) .nv-copy{position:absolute;top:8px;right:8px;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);opacity:1}
.nv-fh:is([data-shed="1"],[data-shed="2"],[data-shed="3"],[data-shed="4"]) .nv-copy:focus-visible{z-index:1;width:28px;height:28px;clip-path:none;background:var(--nv-surface);box-shadow:0 0 0 1px var(--nv-line)}
.nv-fh:is([data-shed="2"],[data-shed="3"],[data-shed="4"]) .nv-long{display:none}
.nv-fh:is([data-shed="2"],[data-shed="3"],[data-shed="4"]) .nv-short{display:inline}
.nv-fh:is([data-shed="3"],[data-shed="4"]) .nv-viewed-label{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.nv-fh[data-shed="4"] .nv-counts{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.nv-fh[data-shed="4"] [data-basename]{flex-shrink:1}
.nv-fh:not([data-fit]) [data-basename]{flex-shrink:1}
@container nv-fh (width < 760px){.nv-fh:not([data-fit]) .nv-when-stuck{display:none!important}.nv-fh:not([data-fit]) .nv-copy{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}}
@container nv-fh (width < 640px){.nv-fh:not([data-fit]) .nv-long{display:none}.nv-fh:not([data-fit]) .nv-short{display:inline}}
@container nv-fh (width < 560px){.nv-fh:not([data-fit]) .nv-viewed-label{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}}
@container nv-fh (width < 440px){.nv-fh:not([data-fit]) .nv-counts{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}}
`

/** Header shed stages (HEADER_CSS); the basename truncates past the last. */
const SHED_STAGES = 4
/** Room (px) a header needs before it un-sheds a stage: no flicker at the edge. */
const SHED_HYSTERESIS = 12

/**
 * The least shedding at which the basename shows whole. Stages apply in
 * order and are measured synchronously (no paint in between); the header's
 * width or the basename's room changing (resize, stuck controls appearing,
 * a font loading) re-runs it through a ResizeObserver.
 */
function fitHeader(
  header: HTMLElement,
  path: HTMLElement,
  spacer: HTMLElement
) {
  const current = Number(header.dataset.shed ?? 0)
  const directory = path.firstElementChild
  // The basename does not shrink before the last stage, so the path box
  // overflows exactly while the basename lacks room. Un-shedding (a stage
  // below the current one) also needs SHED_HYSTERESIS of spare room: the
  // free spacer plus the directory, which gives way before anything else.
  // Measured with copy-path shown, so revealing it on hover never cuts the
  // name; all of it synchronous, before paint.
  header.dataset.fitting = ""
  header.dataset.fit = ""
  try {
    for (let stage = 0; stage < SHED_STAGES; stage++) {
      if (stage === 0) delete header.dataset.shed
      else header.dataset.shed = String(stage)
      if (path.scrollWidth > path.clientWidth) continue
      const spare =
        spacer.getBoundingClientRect().width +
        (directory?.getBoundingClientRect().width ?? 0)
      if (stage >= current || spare >= SHED_HYSTERESIS) return
    }
    header.dataset.shed = String(SHED_STAGES)
  } finally {
    delete header.dataset.fitting
  }
}

const ICON_BUTTON =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-[7px] border-0 bg-transparent text-ink-muted transition-colors duration-surface-tone ease-standard hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none"

/** Who is writing and against which unit and revision. */
export interface CommentContext {
  unitId: string
  revision: string
  author: ReviewCommentAuthor
  /** The unit's agent: new comments open a thread with it. */
  agentId?: string
}

function splitPath(path: string): { dir: string; base: string } {
  const at = path.lastIndexOf("/") + 1
  return { dir: path.slice(0, at), base: path.slice(at) }
}

function basename(path: string): string {
  return splitPath(path).base
}

/** The scroll container a card sticks and lands in (null: the viewport). */
function scrollRoot(node: HTMLElement): HTMLElement | null {
  for (let el = node.parentElement; el; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el)
    if (overflowY === "auto" || overflowY === "scroll") return el
  }
  return null
}

function reducedMotion() {
  return (
    typeof matchMedia !== "undefined" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches
  )
}

/** A file in the desk's registry: its unit and path. */
function renderedKey(unitId: string, path: string) {
  return JSON.stringify([unitId, path])
}

/**
 * Where a stretch's gap row sits: the separator above its head gap, or the
 * fold row of its head run. Split view adds a filler on the new side.
 */
function headSlots(shown: StretchView, split: boolean) {
  const head = shown.head!
  if (head.kind === "run") {
    const slot = foldSlotName(head.run.hunkIndex)
    return { slot, filler: split ? `${slot}:additions` : undefined }
  }
  const index = head.gap.hunkIndex
  return {
    slot: getHunkSeparatorSlotName(split ? "deletions" : "unified", index),
    filler: split ? getHunkSeparatorSlotName("additions", index) : undefined,
  }
}

/**
 * One changed file: the sticky header, the forked diff renderer, and its
 * context margin rendered as the renderer's overlay layer — pins, comment
 * bodies, the L2 card, the selection chip, the composer, drafts and the one
 * shared hint — beside the code, never between its rows.
 *
 * Commenting is direct manipulation in the gutter (Pierre's line selection,
 * extended in the fork with keyboard and touch): select lines → a "Comment"
 * chip appears at the selection's last line → the composer opens at its
 * first line. Dragging in the gutter while composing re-targets it.
 *
 * A file with responsibility shows its owned ranges in line order: what lies
 * between them (unchanged lines and lines other units own) folds into one
 * gap row that opens in place, and the header switches to the whole file,
 * where other units' lines show read-only behind an owner chip.
 */
export function DiffFileCard({
  file,
  markers,
  commentAnchors = [],
  comments = {},
  commentContext,
  variant = "review",
  contextNotes = [],
  header,
  footer,
  collapsed,
  surfaceId,
  position,
  onCheckAction,
}: {
  file: DiffFile
  markers: Record<string, ContextualMarker>
  /** `review comment` markers placed in this file (derived from records). */
  commentAnchors?: ReadonlyArray<MarkerAnchor>
  /** Records behind those markers, by marker key (status, actions). */
  comments?: Record<string, ReviewCommentRecord>
  commentContext: CommentContext
  /** `read-only`: a read-only neighbor (muted, its own unit's comments). */
  variant?: DiffVariant
  /** A read-only neighbor's own context: muted pins with their note. */
  contextNotes?: ReadonlyArray<NeighborContextNote>
  /** Replaces the file header (the read-only neighbor brings its own). */
  header?: React.ReactNode
  /** Under the code (the read-only neighbor's "you can comment" note). */
  footer?: React.ReactNode
  /**
   * Header only, controlled by a custom header (read-only neighbor,
   * generated diff); the code rises in when expanded. Without it, the file
   * header's chevron and Viewed checkbox fold the file.
   */
  collapsed?: boolean
  /** Id of the code region, for the header's aria-controls. */
  surfaceId?: string
  /** "2 / 3" in the stuck header. */
  position?: { index: number; of: number }
  /** The "Before you decide" action of an open card. */
  onCheckAction?: (marker: ContextualMarker, action: MarkerCheckAction) => void
}) {
  const open = useAtomValue(openMarkerAtom)
  const composer = useAtomValue(composerAtom)
  const closingComposer = useAtomValue(closingComposerAtom)
  const setClosingComposer = useSetAtom(closingComposerAtom)
  const selection = useAtomValue(lineSelectionAtom)
  const draft = useAtomValue(commentDraftAtom)
  const parked = useAtomValue(parkedDraftsAtom)
  const hint = useAtomValue(hoverHintAtom)
  const lit = useAtomValue(litLinesAtom)
  const openLine = useAtomValue(openLineAtom)
  const isolating = useAtomValue(isolatingAtom)
  const openComposer = useSetAtom(openComposerAtom)
  const escapeComposer = useSetAtom(escapeComposerAtom)
  const discardComment = useSetAtom(discardCommentAtom)
  const selectLines = useSetAtom(selectLinesAtom)
  const setDraft = useSetAtom(commentDraftAtom)
  const saveComment = useSetAtom(saveCommentAtom)
  const diffLayout = useAtomValue(effectiveLayoutAtom)
  const readOnly = variant === "read-only"
  const reduce = useReducedMotion()

  const identity = {
    unitId: commentContext.unitId,
    revision: commentContext.revision,
    path: file.path,
  }
  const key = fileKey(identity)
  const viewed = useViewedFiles()[key] === true
  const foldOverride = useAtomValue(fileFoldAtom)[key]
  const whole = useAtomValue(wholeFileAtom)[key] === true
  const gapExpansion = useAtomValue(gapExpansionAtom)[key]
  const openSiblings = useAtomValue(openSiblingsAtom)[key]
  const tint = useAtomValue(landedTintAtom)[key]
  const openStretch = useSetAtom(openStretchAtom)

  const ownHeader = header === undefined
  const folded = ownHeader ? (foldOverride ?? viewed) : (collapsed ?? false)
  const regionId = surfaceId ?? `file-${key.replace(/[^a-z0-9]+/gi, "-")}`

  const fileDiff = toFileDiff(file, commentContext.revision)
  const view = rangedView(file, commentContext.revision)
  const rows = displayRows(fileDiff, file)
  const composing = composer?.filePath === file.path ? composer : null
  // Keep the composer's overlay item while its exit motion plays.
  const composerSlot =
    composing ??
    (closingComposer?.filePath === file.path ? closingComposer : null)
  const selected =
    selection?.filePath === file.path && !composing ? selection.range : null
  const drafts = parked.filter((d) => d.filePath === file.path)

  // Owned ranges: each stretch's open parts, its gap row and what the row
  // hides; whole file: every line, other units' runs read-only.
  const layout = React.useMemo(
    () =>
      view
        ? rangedLayout(
            view,
            { expansion: gapExpansion, openRuns: openSiblings },
            whole
          )
        : undefined,
    [view, gapExpansion, openSiblings, whole]
  )
  const presentation = React.useMemo<RangedPresentation | undefined>(
    () =>
      layout
        ? {
            folds: layout.folds,
            hiddenGaps: layout.hiddenGaps,
            expandUnchanged: whole,
            expanded: whole ? {} : (gapExpansion ?? {}),
          }
        : undefined,
    [layout, whole, gapExpansion]
  )
  const split = diffLayout === "split"
  // The unit's separate changes in this file (10.109): a row above each.
  const sections = view?.sections ?? []
  const sectionTarget = React.useMemo(
    () => ({
      unitId: identity.unitId,
      filePath: file.path,
      fileKeyValue: key,
    }),
    [identity.unitId, file.path, key]
  )
  // Other units' runs in view (all of them in the whole file); each carries
  // its owner chip on its first line.
  const ownerPins = React.useMemo(() => {
    if (!view || !layout) return []
    const behind = new Set(layout.rows.flatMap((row) => row.runs))
    return view.runs.filter(
      (run) => run.owner.kind === "sibling" && !behind.has(run)
    )
  }, [view, layout])

  // A checkpoint shows once in each section its lines touch, or once per
  // run of its lines.
  const shown = React.useMemo(
    () => shownAnchors(file, markers, rows),
    [file, markers, rows]
  )
  const allAnchors = React.useMemo(
    () => [...shown.anchors, ...commentAnchors],
    [shown, commentAnchors]
  )
  // Anchors on lines behind a gap row wait on that row's "N hidden" pin;
  // the rest show in the margin.
  const { anchors, hiddenPins } = React.useMemo(() => {
    if (!view || !layout || layout.rows.length === 0)
      return { anchors: allAnchors, hiddenPins: [] }
    const pins: Array<{
      slot: string
      lineNumber: number
      count: number
      open: () => void
    }> = []
    const hiddenKeys = new Set<MarkerAnchor>()
    for (const row of layout.rows) {
      const inside = allAnchors.filter((anchor) =>
        stretchHides(view, row, anchor)
      )
      inside.forEach((anchor) => hiddenKeys.add(anchor))
      if (inside.length > 0)
        pins.push({
          slot: headSlots(row, split).slot,
          lineNumber: row.lines.count > 0 ? row.lines.start : 1,
          count: inside.length,
          open: () => openStretch(key, row.stretch, true),
        })
    }
    return {
      anchors: allAnchors.filter((anchor) => !hiddenKeys.has(anchor)),
      hiddenPins: pins,
    }
  }, [view, layout, allAnchors, split, key, openStretch])

  const groups = React.useMemo(
    () => groupMarkerAnchors(anchors, shown.markers),
    [anchors, shown.markers]
  )

  const annotations = React.useMemo<Array<DiffLineAnnotation>>(() => {
    const list: Array<DiffLineAnnotation> = groups.map((group) => ({
      id: group.id,
      side: group.side,
      lineNumber: group.lineNumber,
    }))
    for (const pin of hiddenPins) {
      list.push({
        id: hiddenId(pin.slot),
        side: "additions",
        lineNumber: pin.lineNumber,
        anchorSlot: pin.slot,
      })
    }
    // The chip sits on the run's first row: its first removed line when it
    // removes any (stacked and split show those first), else its first
    // added line.
    for (const run of ownerPins) {
      const hunk = view?.fileDiff.hunks[run.hunkIndex]
      const removes = hunk !== undefined && hunk.deletionCount > 0
      list.push({
        id: ownerId(run.hunkIndex),
        side: removes ? "deletions" : run.label.side,
        lineNumber: removes ? hunk.deletionStart : run.label.start,
      })
    }
    for (const note of contextNotes) {
      list.push({
        id: noteId(note.key),
        side: note.side,
        lineNumber: note.lineNumber,
      })
    }
    for (const d of drafts) {
      list.push({
        id: draftId(d.id),
        side: d.range.side,
        lineNumber: d.range.start,
      })
    }
    if (composerSlot) {
      // The composer sits on the selection's first line.
      list.push({
        id: COMPOSER_ID,
        side: composerSlot.range.side,
        lineNumber: composerSlot.range.start,
      })
    }
    if (!composing && selected) {
      // The commit chip sits on the selection's last line.
      list.push({
        id: SELECTION_ID,
        side: selected.endSide ?? selected.side,
        lineNumber: selected.end,
      })
    }
    return list
  }, [
    groups,
    hiddenPins,
    ownerPins,
    view,
    contextNotes,
    drafts,
    composerSlot,
    composing,
    selected,
  ])

  const openGroup = groups.find((group) =>
    group.entries.some((entry) => entry.marker.key === open)
  )
  const openEntry = openGroup?.entries.find(
    (entry) => entry.marker.key === open
  )
  const hintGroup =
    hint?.filePath === file.path
      ? groupOfMarker(groups, hint.markerKey)
      : undefined
  // A briefing phrase pointed at or focused lights the lines it describes.
  const litLines =
    lit?.unitId === identity.unitId && lit.filePath === file.path
      ? lit
      : undefined
  // Marker ↔ code: a pointed-at pin tints exactly its lines (--nv-lit), as a
  // pointed-at briefing phrase does; the open marker tints its own lines
  // fully.
  const highlight:
    | { range: LineRange; ranges?: Array<LineRange>; tone: "strong" | "hint" }
    | undefined = composing
    ? undefined
    : hintGroup && !isolating
      ? { range: linesOfGroup(hintGroup), tone: "hint" }
      : // A phrase or chip lights its lines even while a card is open
        // (round 5b); the open tint returns when it is left.
        litLines
        ? {
            range: litLines.range,
            ...(litLines.ranges ? { ranges: litLines.ranges } : {}),
            tone: "hint",
          }
        : openEntry
          ? { range: markerLines(openEntry.anchor), tone: "strong" }
          : undefined

  // Round 5c: an engaged pin always shows its lines, whichever entry point
  // engaged it: its card is open, or its line's list is pinned open. They
  // keep the hover tint with an outline (and the stronger number cells)
  // until the card or list closes, under any pointed-at range.
  const listGroup = groups.find(
    (group) =>
      group.entries.length > 1 && openLine === lineKey(file.path, group.id)
  )
  // While composing, the selected range is outlined the same way at 1px
  // (lib/diffs.ts), so the ring always means "these lines".
  const engaged: LineRange | undefined = composing
    ? composing.range
    : openEntry
      ? markerLines(openEntry.anchor)
      : listGroup
        ? linesOfGroup(listGroup)
        : undefined

  const overlay = {
    // The L2 card stays expanded under an L3 sheet ("Back to unit" returns
    // to it); the composer is the expanded layer while it is open.
    expandedId: composing ? COMPOSER_ID : openGroup?.id,
    // Margin lines float their layers (MarginLine), so every line's body
    // slot stays collapsed to its pin except the expanded one.
    dismissedIds: groups
      .map((group) => group.id)
      .filter((id) => id !== openGroup?.id),
    // Isolation spans files: a layer expanded in another file dims this one.
    isolated: isolating && !composing && !openGroup,
    hintId: undefined,
    highlight,
    engaged,
    engagedTone: composing ? ("composer" as const) : undefined,
  }

  const onSelectLines = React.useCallback(
    (range: LineRange | null) =>
      selectLines(
        file.path,
        range && ownsSelection(file, range)
          ? (normalizeRange(rows, range) ?? range)
          : null
      ),
    [selectLines, file, rows]
  )
  // Owned ranges: only lines inside an owned interval take a comment, so
  // the gutter names and selects only those. Without responsibility every
  // line can, and the surface keeps the renderer's own behaviour.
  const isLineCommentable = React.useCallback(
    (side: DiffSide, line: number) =>
      ownsSelection(file, { side, start: line, end: line }),
    [file]
  )
  const onCommitLines = React.useCallback(
    (range: LineRange) => {
      if (!ownsSelection(file, range)) return
      openComposer({
        filePath: file.path,
        range: normalizeRange(rows, range) ?? range,
      })
    },
    [openComposer, file, rows]
  )

  function save() {
    if (!composing || !ownsSelection(file, composing.range)) return
    const covered = rangeRows(rows, composing.range)
    const first = covered[0]
    saveComment({
      ...commentContext,
      anchor: {
        filePath: file.path,
        range: composing.range,
        hunk: {
          index: first?.hunkIndex ?? 0,
          header: first?.hunkHeader ?? "",
        },
        lines:
          covered.length > 0
            ? covered.map((row) => ({
                side: row.kind === "deletion" ? "deletions" : "additions",
                lineNumber:
                  (row.kind === "deletion" ? row.oldLine : row.newLine) ?? 0,
                text: row.text,
              }))
            : [
                {
                  side: composing.range.side,
                  lineNumber: composing.range.start,
                  text: "",
                },
              ],
      },
    })
  }

  const setCodeWidth = useSetAtom(setCodeWidthAtom)
  const onCodeWidth = React.useCallback(
    (width: number) => setCodeWidth(key, width),
    [setCodeWidth, key]
  )
  const { cardRef, landing, onLanded } = useLanding({
    view,
    identity,
    fileKeyValue: key,
    folded,
    ownHeader,
    whole,
    state: { expansion: gapExpansion, openRuns: openSiblings },
    tint,
    trackCurrent: !readOnly,
  })

  const surface = (
    <DiffSurface
      variant={variant}
      identity={key}
      label={
        readOnly
          ? `Read-only neighbor ${file.path}. Line numbers select lines to comment on.`
          : file.responsibility
            ? `Owned changed ranges in ${file.path}. Line numbers select owned lines to comment on.`
            : `Changes in ${file.path}. Line numbers select lines to comment on.`
      }
      fileDiff={fileDiff}
      annotations={annotations}
      overlay={overlay}
      selection={composing ? composing.range : selected}
      onSelectLines={onSelectLines}
      onCommitLines={onCommitLines}
      isLineCommentable={file.responsibility ? isLineCommentable : undefined}
      ranged={presentation}
      landing={landing}
      onLanded={onLanded}
      onCodeWidth={view ? onCodeWidth : undefined}
    >
      {groups.map((group) => (
        <div
          key={group.id}
          slot={getOverlayPinSlotName(group.id)}
          className="contents"
        >
          <MarginLine
            group={group}
            filePath={file.path}
            readOnly={readOnly}
            comments={comments}
            reviewer={commentContext.author}
            agentId={commentContext.agentId}
            unitId={commentContext.unitId}
            onCheckAction={onCheckAction}
          />
        </div>
      ))}
      {hiddenPins.map((pin) => (
        <div
          key={pin.slot}
          slot={getOverlayPinSlotName(hiddenId(pin.slot))}
          className="contents"
        >
          <HiddenMarkersPin count={pin.count} onOpen={pin.open} />
        </div>
      ))}
      {ownerPins.map((run) => (
        <div
          key={run.hunkIndex}
          slot={getOverlayPinSlotName(ownerId(run.hunkIndex))}
          className="contents"
        >
          <OwnerPin run={run} />
        </div>
      ))}
      {layout && layout.rows.length > 0 && (
        <GapRows fileKeyValue={key} rows={layout.rows} split={split} />
      )}
      {sections.length > 0 && (
        <SectionRows target={sectionTarget} sections={sections} split={split} />
      )}
      {contextNotes.map((note) => (
        <React.Fragment key={note.key}>
          <div
            slot={getOverlayPinSlotName(noteId(note.key))}
            className="contents"
          >
            <span
              aria-label={`${note.short}: ${note.note}`}
              className="inline-flex h-[22px] items-center gap-1.5 rounded-md px-2 font-mono text-[11px] text-ink-muted shadow-[inset_0_0_0_1px_var(--nv-line)]"
            >
              <span
                aria-hidden="true"
                className="size-1.5 rounded-[2px] bg-faint"
              />
              {note.short}
            </span>
          </div>
          <div
            slot={getOverlayBodySlotName(noteId(note.key))}
            className="block"
          >
            <span className="block max-w-[230px] text-[11.5px] leading-4 text-ink-muted">
              {note.note}
            </span>
          </div>
        </React.Fragment>
      ))}
      {drafts.map((d) => (
        <div
          key={d.id}
          slot={getOverlayPinSlotName(draftId(d.id))}
          className="contents"
        >
          <DraftPin
            label={rangeLabel(d.range)}
            excerpt={d.text}
            disabled={isolating}
            onOpen={() => openComposer({ filePath: file.path, range: d.range })}
          />
        </div>
      ))}
      <div slot={getOverlayPinSlotName(SELECTION_ID)} className="contents">
        <AnimatePresence>
          {selected && (
            <SelectionChip
              key="chip"
              label={rangeLabel(selected)}
              onOpen={() =>
                openComposer({
                  filePath: file.path,
                  range: selected,
                })
              }
            />
          )}
        </AnimatePresence>
      </div>
      <div slot={getOverlayBodySlotName(COMPOSER_ID)} className="block">
        <AnimatePresence onExitComplete={() => setClosingComposer(null)}>
          {composing && (
            <CommentComposer
              key="composer"
              anchorLabel={`${basename(file.path)} · ${rangePhrase(composing.range)}`}
              placeholder={`Comment on ${rangePhrase(composing.range)}`}
              draft={draft}
              onDraft={setDraft}
              onSave={save}
              onCancel={discardComment}
              onEscape={escapeComposer}
            />
          )}
        </AnimatePresence>
      </div>
    </DiffSurface>
  )

  const nontext = file.responsibility?.ownedSource.map((source) =>
    source.kind === "whole-nontext" ? (
      <div key={source.hunkId} className="px-3.5 py-3">
        <p className="mb-2 text-xs text-ink-muted">
          Owned {source.sourceKind} change
        </p>
        <pre className="overflow-x-auto font-mono text-xs whitespace-pre-wrap">
          {source.text}
        </pre>
      </div>
    ) : null
  )

  return (
    // While composing here, presses in this file do not close the composer
    // (data-composing), so the gutter stays live (dragging re-targets the
    // comment); everywhere else an outside press still closes it.
    <div
      ref={cardRef}
      data-file-card={file.path}
      // Presses here do not close the composer (review-desk-screen.tsx).
      data-composing={composing ? "" : undefined}
      className="flex scroll-mt-2 items-start gap-4"
    >
      {ownHeader && (
        <style href="nv-diff-file-header" precedence="default">
          {HEADER_CSS}
        </style>
      )}
      <div
        className={cn(
          // No overflow clip: the margin overlay lives inside the diff host
          // and reaches past the card; the code clips its own corners.
          "min-w-0 flex-auto rounded-[10px]",
          readOnly ? "bg-ro-bg" : "bg-surface shadow-[0_0_0_1px_var(--nv-line)]"
        )}
      >
        {ownHeader ? (
          <FileHeader
            file={file}
            fileKeyValue={key}
            regionId={regionId}
            folded={folded}
            viewed={viewed}
            ranged={view !== undefined}
            whole={whole}
            position={position}
          />
        ) : (
          header
        )}
        {ownHeader ? (
          <AnimatePresence initial={false}>
            {!folded && (
              <motion.div
                key="body"
                id={regionId}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, transition: { duration: 0 } }}
                transition={reduce ? REDUCED_TRANSITION : FOLD.enter}
              >
                {nontext}
                {surface}
                {footer}
              </motion.div>
            )}
          </AnimatePresence>
        ) : (
          <>
            {nontext}
            <AnimatePresence initial={false}>
              {!folded && (
                <motion.div
                  key="surface"
                  id={regionId}
                  initial={
                    reduce
                      ? { opacity: 0 }
                      : {
                          opacity: 0,
                          y: RISE.offsetY,
                          scale: RISE.initialScale,
                        }
                  }
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{
                    opacity: 0,
                    transition: reduce ? REDUCED_TRANSITION : RISE.exit,
                  }}
                  transition={reduce ? REDUCED_TRANSITION : RISE.enter}
                  style={{ transformOrigin: "bottom center" }}
                >
                  {surface}
                  {footer}
                </motion.div>
              )}
            </AnimatePresence>
          </>
        )}
      </div>
      <SectionMargin
        target={sectionTarget}
        sections={folded ? [] : sections}
        quiet={open !== null || openLine !== null || composing !== null}
      />
    </div>
  )
}

/** Exposed for stories: the range key a parked draft is stored under. */
export { rangeKey }

/* ── Landing, current file, registry ──────────────────── */

/**
 * The card's side of the round 3 contract (landing.ts): registers the file,
 * reports it as current while it sits under the top of the scroller, and
 * consumes landings aimed at it — unfolding the file, opening the gap row
 * that holds the lines, scrolling them below the sticky header
 * (the surface) and tinting them once.
 */
function useLanding({
  view,
  identity,
  fileKeyValue,
  folded,
  ownHeader,
  whole,
  state,
  tint,
  trackCurrent,
}: {
  view: RangedView | undefined
  identity: { unitId: string; revision: string; path: string }
  fileKeyValue: string
  folded: boolean
  ownHeader: boolean
  whole: boolean
  /** Owned ranges: what is open, read when a landing arrives. */
  state: StretchState
  tint: LandedTint | undefined
  trackCurrent: boolean
}) {
  const target = useAtomValue(landingAtom)
  const setTarget = useSetAtom(landingAtom)
  // Read on demand, never subscribed: a card mounting elsewhere must not
  // re-render this one.
  const isRendered = useSetAtom(isFileRenderedAtom)
  const register = useSetAtom(registerFileAtom)
  const setCurrent = useSetAtom(currentFileAtom)
  const toggleFold = useSetAtom(toggleFoldAtom)
  const openStretch = useSetAtom(openStretchAtom)
  const setTint = useSetAtom(setLandedTintAtom)
  const cardEl = React.useRef<HTMLElement | null>(null)
  const mine = renderedKey(identity.unitId, identity.path)

  // Registry + current-file tracking. A ref callback owns the observer, so
  // no effect is needed: the band is the top tenth of the scroller, under
  // the sticky header.
  const cardRef = React.useCallback(
    (el: HTMLDivElement | null) => {
      cardEl.current = el
      if (!el) return
      register(mine, true)
      let observer: IntersectionObserver | undefined
      if (trackCurrent && typeof IntersectionObserver !== "undefined") {
        observer = new IntersectionObserver(
          (entries) => {
            if (entries.some((entry) => entry.isIntersecting))
              setCurrent(identity.path)
          },
          { root: scrollRoot(el), rootMargin: "0px 0px -90% 0px" }
        )
        observer.observe(el)
      }
      return () => {
        observer?.disconnect()
        register(mine, false)
        cardEl.current = null
      }
    },
    [register, mine, trackCurrent, setCurrent, identity.path]
  )

  const targetNonce = target?.nonce
  // Effect: consumes the landing request (written by the briefing and the rail) and moves the scroll container, an external system, to it.
  React.useEffect(() => {
    if (!target) return
    if (
      target.unitId !== identity.unitId ||
      target.filePath !== identity.path
    ) {
      // Nobody renders that file: drop the request (the contract's rule).
      if (!isRendered(renderedKey(target.unitId, target.filePath)))
        setTarget(null)
      return
    }
    setTarget(null)
    if (ownHeader && folded) toggleFold(fileKeyValue, false)
    const range = target.range
    if (!range) {
      const el = cardEl.current
      requestAnimationFrame(() =>
        el?.scrollIntoView({
          block: "start",
          behavior: reducedMotion() ? "auto" : "smooth",
        })
      )
      return
    }
    if (view && !whole) {
      // The gap row hiding the lines opens whole: unchanged lines and other
      // units' runs alike, so the tint lands on them in place.
      const point = { side: range.side, lineNumber: range.start }
      for (const stretch of view.stretches)
        if (stretchHides(view, stretchView(stretch, state), point))
          openStretch(fileKeyValue, stretch, true)
    }
    // The tint waits for the scroll to arrive (the surface's onLanded).
    setTint(fileKeyValue, {
      range,
      ...(target.ranges ? { ranges: target.ranges } : {}),
      key: reducedMotion() ? "static" : target.nonce % 2 ? "a" : "b",
      nonce: target.nonce,
      arrived: false,
      ...(target.scroll ? { scroll: target.scroll } : {}),
    })
    // Only a new request re-runs this; the rest is read at that moment.
  }, [targetNonce])

  const onLanded = React.useCallback(
    (landed: number) => {
      if (tint?.nonce === landed && !tint.arrived)
        setTint(fileKeyValue, { ...tint, arrived: true })
    },
    [tint, setTint, fileKeyValue]
  )

  // Effect: ends the landing tint once shown — a timer after its fade, or (reduced motion, a static tint) the next pointer or key press on the document.
  React.useEffect(() => {
    if (!tint?.arrived) return
    const clear = () => setTint(fileKeyValue, null)
    if (tint.key !== "static") {
      const timer = setTimeout(clear, LAND_MS)
      return () => clearTimeout(timer)
    }
    const options = { once: true, capture: true } as const
    // The click that asked for the landing has already finished.
    document.addEventListener("pointerdown", clear, options)
    document.addEventListener("keydown", clear, options)
    return () => {
      document.removeEventListener("pointerdown", clear, options)
      document.removeEventListener("keydown", clear, options)
    }
  }, [tint, setTint, fileKeyValue])

  return { cardRef, landing: tint, onLanded }
}

/* ── File header ──────────────────────────────────────── */

function FileHeader({
  file,
  fileKeyValue,
  regionId,
  folded,
  viewed,
  ranged,
  whole,
  position,
}: {
  file: DiffFile
  fileKeyValue: string
  regionId: string
  folded: boolean
  viewed: boolean
  ranged: boolean
  whole: boolean
  position?: { index: number; of: number }
}) {
  const toggleFold = useSetAtom(toggleFoldAtom)
  const setViewed = useSetAtom(setViewedAtom)
  const setWhole = useSetAtom(setWholeFileAtom)
  const reduce = useReducedMotion()
  const { dir, base } = splitPath(file.path)

  // The IntersectionObserver fallback for scroll-state queries
  // (modern-web-guidance): only where the query is unsupported.
  // A ref callback owns the observers (no effect): the content-aware shed
  // order, and the IntersectionObserver fallback for scroll-state queries
  // (modern-web-guidance) only where the query is unsupported.
  const stuckRef = React.useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    const path = el.querySelector<HTMLElement>("[data-path]")
    const spacer = el.querySelector<HTMLElement>("[data-header-spacer]")
    // Every header fits as it mounts, on screen or not, before the first
    // paint; then on each change to its width or the path's room (a
    // ResizeObserver reports before paint). Scrolling one into view, or a
    // click after that, never refits it: its layout is already final.
    const fit = () => {
      if (path && spacer) fitHeader(el, path, spacer)
    }
    fit()
    const fitter =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(fit)
        : undefined
    if (path) {
      fitter?.observe(el)
      fitter?.observe(path)
    }
    const stopFitting = () => fitter?.disconnect()
    if (
      typeof IntersectionObserver === "undefined" ||
      CSS.supports("container-type: scroll-state")
    )
      return stopFitting
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return
        const top = entry.rootBounds?.top ?? 0
        el.toggleAttribute(
          "data-stuck",
          entry.intersectionRatio < 1 && entry.boundingClientRect.top <= top + 1
        )
      },
      { root: scrollRoot(el), threshold: [1], rootMargin: "-1px 0px 0px 0px" }
    )
    observer.observe(el)
    return () => {
      observer.disconnect()
      stopFitting()
    }
  }, [])

  return (
    <div ref={stuckRef} className="nv-fh" data-file-header="">
      <div
        className={cn(
          "nv-fh-in relative box-border flex h-11 items-center gap-2 rounded-t-[10px] bg-surface pr-2 pl-1.5",
          folded ? "rounded-b-[10px]" : "border-b border-line-2"
        )}
      >
        <button
          type="button"
          className={ICON_BUTTON}
          aria-expanded={!folded}
          aria-controls={regionId}
          aria-label={`${folded ? "Expand" : "Collapse"} ${base}`}
          onClick={() => toggleFold(fileKeyValue, !folded)}
        >
          <motion.span
            aria-hidden="true"
            className="inline-flex"
            animate={{ rotate: folded ? -90 : 0 }}
            transition={reduce ? { duration: 0 } : CHEVRON}
          >
            <ChevronDownIcon className="size-3.5" />
          </motion.span>
        </button>
        <span
          title={file.path}
          data-path=""
          className="flex min-w-0 items-baseline overflow-hidden font-mono text-[12.5px]"
        >
          {/* The directory gives way first (it shrinks a million times
              faster, so it is gone before the name loses a pixel); the
              header then sheds controls for the basename (fitHeader); only
              then does the basename truncate. */}
          <span className="min-w-0 shrink-[1000000] truncate text-ink-muted">
            {dir}
          </span>
          <span
            data-basename=""
            className={cn(
              "min-w-0 shrink-0 truncate font-medium",
              viewed ? "text-ink-muted" : "text-ink"
            )}
          >
            {base}
          </span>
        </span>
        <span className="nv-counts inline-flex gap-2">
          <span className="font-mono text-[11.5px] whitespace-nowrap text-add-fg">
            +{file.additions}
          </span>
          <span className="font-mono text-[11.5px] whitespace-nowrap text-del-fg">
            −{file.deletions}
          </span>
        </span>
        <CopyPath path={file.path} />
        <span data-header-spacer="" className="flex-auto" />
        {position && (
          <span className="nv-when-stuck font-mono text-[11px] whitespace-nowrap text-faint">
            {position.index} / {position.of}
          </span>
        )}
        <StuckLayoutControls />
        {ranged && (
          // Segmented's look, with labels that compact in a narrow header.
          <ToggleGroup
            type="single"
            value={whole ? "whole" : "owned"}
            onValueChange={(next) => {
              if (next) setWhole(fileKeyValue, next === "whole")
            }}
            aria-label="Lines shown"
            spacing={0}
            variant="segment"
            size="segment"
            className="shrink-0 rounded-lg bg-raised p-[3px]"
          >
            <ToggleGroupItem value="owned" aria-label="Owned ranges">
              <span className="nv-long">Owned ranges</span>
              <span className="nv-short">Owned</span>
            </ToggleGroupItem>
            <ToggleGroupItem value="whole" aria-label="Whole file">
              <span className="nv-long">Whole file</span>
              <span className="nv-short">Whole</span>
            </ToggleGroupItem>
          </ToggleGroup>
        )}
        <button
          type="button"
          aria-pressed={viewed}
          onClick={() => setViewed(fileKeyValue, !viewed)}
          className={cn(
            "group/viewed inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[7px] border-0 bg-transparent pr-2.5 pl-2 text-[12.5px] transition-colors duration-surface-tone ease-standard hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none",
            viewed ? "text-agt-fg" : "text-ink-muted hover:text-ink"
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "inline-flex size-3.5 items-center justify-center rounded-[4px] transition-colors duration-check ease-standard motion-reduce:transition-none",
              viewed
                ? "bg-agt text-white"
                : // line-strong holds 3:1 at rest; on the raised hover fill
                  // the edge steps to muted with the label.
                  "shadow-[inset_0_0_0_1.5px_var(--nv-line-strong)] group-hover/viewed:shadow-[inset_0_0_0_1.5px_var(--nv-muted)]"
            )}
          >
            {viewed && <CheckIcon className="size-[11px]" strokeWidth={3} />}
          </span>
          <span className="nv-viewed-label">Viewed</span>
        </button>
      </div>
    </div>
  )
}

/** Copy the file path; the icon confirms for a moment. */
function CopyPath({ path }: { path: string }) {
  // Component-local state in jotai (no useState).
  const copiedAtom = React.useMemo(() => atom(false), [])
  const copied = useAtomValue(copiedAtom)
  const setCopied = useSetAtom(copiedAtom)
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  )
  // Stable, so its cleanup runs only on unmount (a new callback per render
  // would clear the timer the click just set).
  const clearOnUnmount = React.useCallback(
    () => () => clearTimeout(timer.current),
    []
  )
  return (
    <button
      type="button"
      ref={clearOnUnmount}
      className={cn(ICON_BUTTON, "nv-copy")}
      aria-label={copied ? `Copied ${path}` : `Copy path ${path}`}
      onClick={() => {
        void navigator.clipboard.writeText(path).then(() => {
          setCopied(true)
          clearTimeout(timer.current)
          timer.current = setTimeout(() => setCopied(false), COPIED_MS)
        })
      }}
    >
      {copied ? (
        <CheckIcon aria-hidden="true" className="size-[13px] text-agt-fg" />
      ) : (
        <CopyIcon aria-hidden="true" className="size-[13px]" />
      )}
    </button>
  )
}

/**
 * Stacked / Split / Wrap as compact icons, only while the header is stuck
 * (the toolbar above the files is not sticky).
 */
function StuckLayoutControls() {
  const layout = useAtomValue(effectiveLayoutAtom)
  const setLayout = useSetAtom(diffLayoutAtom)
  const fits = useAtomValue(splitFitsAtom)
  const wrap = useAtomValue(wrapAtom)
  const setWrap = useSetAtom(wrapAtom)
  const button = (on: boolean) =>
    cn(
      ICON_BUTTON,
      on && "bg-raised text-ink",
      "disabled:cursor-not-allowed disabled:opacity-50"
    )
  return (
    <span className="nv-when-stuck ml-0.5 inline-flex items-center gap-0.5 pl-1.5 shadow-[inset_1px_0_0_var(--nv-line-2)]">
      <button
        type="button"
        className={button(layout === "stacked")}
        aria-label="Stacked layout"
        aria-pressed={layout === "stacked"}
        onClick={() => setLayout("stacked")}
      >
        <Rows2Icon aria-hidden="true" className="size-[13px]" />
      </button>
      <button
        type="button"
        className={button(layout === "split")}
        aria-label="Split layout"
        aria-pressed={layout === "split"}
        disabled={!fits}
        title={fits ? undefined : "Split needs a column of 980px"}
        onClick={() => setLayout("split")}
      >
        <Columns2Icon aria-hidden="true" className="size-[13px]" />
      </button>
      <button
        type="button"
        className={button(wrap)}
        aria-label="Wrap lines"
        aria-pressed={wrap}
        onClick={() => setWrap(!wrap)}
      >
        <WrapTextIcon aria-hidden="true" className="size-[13px]" />
      </button>
    </span>
  )
}

/* ── Owned ranges: gap rows and sibling rows ──────────── */

/** Frames to wait for the renderer to paint a gap's revealed lines. */
const REVEAL_FRAMES = 30

/**
 * When a gap row's last chunk opens, the row unmounts with focus on it.
 * Focus moves to the first revealed line's gutter cell (the renderer's
 * keyboard line model: arrows move, Enter comments), else to the line just
 * above it on the same side, else to the file's gutter tab stop. Never to
 * the page, and never to the file's fold chevron, where a second Enter
 * would fold the file. A pointer expand moves focus without a ring; a key
 * press with one. The renderer paints rows asynchronously, so this waits a
 * few frames; it gives up if the reader has moved focus meanwhile.
 *
 * A removed line has only its old number, which a new line elsewhere may
 * share, so the side picks the cell: removed lines in the unified column or
 * the deletions column, any other line in the unified or additions column.
 */
function focusRevealedLine(
  row: HTMLElement,
  first: RevealedLine,
  pointer: boolean
) {
  const host = row.closest("diffs-container")
  const doc = row.ownerDocument
  const view = doc.defaultView
  if (!host || !view) return
  const cell = (line: number) =>
    host.shadowRoot?.querySelector<HTMLElement>(
      first.side === "deletions"
        ? `:is([data-unified], [data-deletions]) [data-column-number="${line}"][data-line-type="change-deletion"]`
        : `:is([data-unified], [data-additions]) [data-column-number="${line}"]:not([data-line-type="change-deletion"])`
    ) ?? null
  let frames = 0
  const attempt = () => {
    const active = doc.activeElement
    if (active && active !== doc.body && !row.contains(active)) return
    const last = frames >= REVEAL_FRAMES
    const target =
      cell(first.line) ??
      (last
        ? (cell(first.line - 1) ??
          host.shadowRoot?.querySelector<HTMLElement>(
            '[data-column-number][tabindex="0"]'
          ) ??
          null)
        : null)
    if (target) {
      // As the renderer's own arrow keys do: the cell becomes the gutter's
      // one tab stop (revealed cells carry no tabindex yet), then takes
      // focus, which makes it the keyboard line.
      for (const stop of host.shadowRoot?.querySelectorAll<HTMLElement>(
        '[data-column-number][tabindex="0"]'
      ) ?? [])
        stop.tabIndex = -1
      target.tabIndex = 0
      return target.focus({ preventScroll: true, focusVisible: !pointer })
    }
    if (!last) {
      frames += 1
      view.requestAnimationFrame(attempt)
    }
  }
  view.requestAnimationFrame(attempt)
}

/** A line by its side and that side's number. */
interface RevealedLine {
  side: DiffSide
  line: number
}

/**
 * The topmost line a stretch's last press reveals. Downward, that is the
 * head; an upward stretch opens toward the top, so its last part in opening
 * order (a one-line gap the renderer shows inline) is its first in line
 * order. A run that only removes lines starts at an old line number.
 */
function firstRevealed(row: StretchView): RevealedLine {
  const head = row.head!
  const top = row.stretch.upward ? (row.hidden.at(-1) ?? head) : head
  if (top.kind === "run")
    return { side: top.run.label.side, line: top.run.label.start }
  const lines =
    top === head && row.headGap
      ? row.headGap
      : hiddenGapLines(top.gap, undefined)
  return { side: "additions", line: lines.start }
}

/** "3 other units": who owns the changed lines behind a gap row. */
function unitsPhrase(units: number) {
  return `${units} other unit${units === 1 ? "" : "s"}`
}

/** What the gap row's next press opens, for its accessible name. */
function nextStep(row: StretchView) {
  const head = row.head!
  if (head.kind === "gap") {
    const hidden = row.headGap!
    const shown = Math.min(hidden.count, GAP_CHUNK)
    if (row.units === 0)
      return `Show ${shown} of ${hidden.count} unchanged lines, ${row.label}`
    return `Show ${shown} of ${row.lines.count} lines, ${row.label}, including changes owned by ${unitsPhrase(row.units)}`
  }
  const { run } = head
  const owner = run.owner.kind === "sibling" ? run.owner : undefined
  const lines = rangeLabel({
    side: run.label.side,
    start: run.label.start,
    end: run.label.end,
  })
  // Nothing here names the owner's lane: the lane words its title leaves
  // out follow it.
  const owned = `${owner?.title ?? "another unit"}${owner?.laneWords ? ` (${owner.laneWords})` : ""}`
  return `Show ${run.changed} changed line${run.changed === 1 ? "" : "s"} owned by ${owned}, ${lines}`
}

/** Does this press open the stretch's last part (the row then goes)? */
function lastStep(row: StretchView) {
  const head = row.head!
  return (
    (head.kind === "run" || row.headGap!.count <= GAP_CHUNK) &&
    row.hidden.every(
      (part) => part.kind === "gap" && part.gap.size <= INLINE_GAP
    )
  )
}

/**
 * The gap rows the renderer leaves to the host (slotted), one per stretch
 * still folded, on its first part not yet open: a gap's separator or a
 * sibling run's fold row. Each counts the lines it stands for and says,
 * quietly, when other units own changes among them. A row keeps its element
 * as it moves on to the next part, so focus stays on it. They span the code
 * column (Pierre's --diffs-column-width) from the gutter cell.
 */
function GapRows({
  fileKeyValue,
  rows,
  split,
}: {
  fileKeyValue: string
  rows: ReadonlyArray<StretchView>
  split: boolean
}) {
  const openStretch = useSetAtom(openStretchAtom)
  // The width of one code column (half the host in split), measured by the
  // surface; a matching negative margin keeps the gutter column from growing.
  const hostWidth = useAtomValue(codeWidthAtom)[fileKeyValue] ?? 0
  const width = split ? Math.floor(hostWidth / 2) : hostWidth
  const rowWidth: React.CSSProperties = { width, marginRight: -width }
  return (
    <>
      {rows.map((row) => {
        const { slot, filler } = headSlots(row, split)
        const stretchKey = row.stretch.parts[0]!
        const id =
          stretchKey.kind === "gap"
            ? `g${stretchKey.gap.hunkIndex}`
            : `r${stretchKey.run.hunkIndex}`
        // The last part removes the row: if it held focus, focus follows
        // the revealed lines (focusRevealedLine). Otherwise the row stays
        // (on its next part) with its focus; after a pointer press that
        // focus sits on the labelled button (not the aria-hidden wide
        // target), with no ring. A click from a key has detail 0; a pointer
        // click counts presses.
        const open = (event: React.MouseEvent<HTMLButtonElement>) => {
          const element = event.currentTarget.parentElement
          const pointer = event.detail > 0
          const focused =
            element?.contains(element.ownerDocument.activeElement) ?? false
          const last = lastStep(row)
          const first = firstRevealed(row)
          openStretch(fileKeyValue, row.stretch)
          if (!element || !focused) return
          if (last) return focusRevealedLine(element, first, pointer)
          const labelled = element.querySelector<HTMLElement>(
            "button:not([aria-hidden])"
          )
          if (!pointer || !labelled) return
          // focus() on the focused element changes nothing: blur, refocus.
          const active = element.ownerDocument.activeElement
          if (active instanceof HTMLElement) active.blur()
          labelled.focus({ preventScroll: true, focusVisible: false })
        }
        const count = row.lines.count
        return (
          <React.Fragment key={id}>
            <div
              slot={slot}
              data-gap-row=""
              style={rowWidth}
              className="relative z-1 grid min-h-8 grid-cols-[var(--diffs-column-number-width,88px)_minmax(0,1fr)] items-center bg-expand text-left font-sans text-xs whitespace-normal text-ink-muted select-none"
            >
              <button
                type="button"
                onClick={open}
                aria-label={nextStep(row)}
                className="inline-flex h-8 w-full items-center justify-center border-0 bg-transparent text-ink-muted transition-colors duration-surface-tone ease-standard hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none"
              >
                <ChevronsUpDownIcon aria-hidden="true" className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={open}
                // The labelled control is the chevron button; this is a
                // larger pointer target for the same action.
                tabIndex={-1}
                aria-hidden="true"
                className="inline-flex h-8 min-w-0 items-center gap-2.5 justify-self-start border-0 bg-transparent px-2.5 text-left font-mono text-[11.5px] text-ink-muted transition-colors duration-surface-tone ease-standard hover:text-ink motion-reduce:transition-none"
              >
                {count > 0 && (
                  <span className="truncate">
                    {count} {row.units === 0 ? "unchanged " : ""}line
                    {count === 1 ? "" : "s"}
                  </span>
                )}
                <span data-gap-range="" className="shrink-0 text-ink-muted">
                  {row.label}
                </span>
                {row.units > 0 && (
                  <span
                    data-gap-owners=""
                    className="inline-flex min-w-0 shrink-[2] items-center gap-1 font-sans text-[11.5px] text-ink-muted"
                  >
                    <LockIcon
                      aria-hidden="true"
                      className="size-3 shrink-0"
                      strokeWidth={1.75}
                    />
                    <span className="truncate">{unitsPhrase(row.units)}</span>
                  </span>
                )}
              </button>
            </div>
            {filler && (
              <div
                aria-hidden="true"
                slot={filler}
                style={rowWidth}
                className="relative z-1 block min-h-8 bg-expand"
              />
            )}
          </React.Fragment>
        )
      })}
    </>
  )
}

/**
 * Who owns a run of read-only lines (a sibling run in view): a chip in the
 * margin on its first line with the lock, lane glyph and owning unit,
 * linking to it when known. Its name says the lane in full.
 */
function OwnerPin({ run }: { run: RangedRun }) {
  const owner = run.owner.kind === "sibling" ? run.owner : undefined
  // Removed lines read "L−340–342", as everywhere else.
  const lines = rangeLabel(run.label)
  const name = owner?.title ?? "another unit"
  // The glyph shows the owner's lane; its name says it in full.
  const owned = `${lines} owned by ${name}${owner?.lane ? `, ${LANE_NAME[owner.lane]}` : ""}`
  const content = (
    <>
      <LockIcon
        aria-hidden="true"
        className="size-3 shrink-0 text-ink-muted"
        strokeWidth={1.75}
      />
      {owner?.lane && <LaneGlyph lane={owner.lane} className="shrink-0" />}
      <span className="min-w-0 truncate">{name}</span>
    </>
  )
  const className =
    "inline-flex h-[22px] max-w-[220px] items-center gap-1.5 rounded-md bg-ro-bg px-2 text-[11.5px] text-ink-muted no-underline shadow-[inset_0_0_0_1px_var(--nv-line)]"
  return owner?.unitId ? (
    <NeuveLink
      destination={{ to: "unit", unitId: owner.unitId }}
      aria-label={`${owned}. Open unit`}
      className={cn(
        className,
        "transition-colors duration-surface-tone ease-standard hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none"
      )}
    >
      {content}
    </NeuveLink>
  ) : (
    <span aria-label={owned} className={className}>
      {content}
    </span>
  )
}
