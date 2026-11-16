import * as React from "react"
import { useAtomValue } from "jotai"
import { FileDiff, VirtualizedFileDiff } from "@workspace/diffs"
import type {
  AnnotationOverlayHighlight,
  AnnotationOverlayLanding,
  AnnotationOverlayState,
  DiffLineAnnotation,
  FileDiffMetadata,
  FileDiffOptions,
  HunkExpansionRegion,
  HunkFold,
  SelectedLineRange,
  SelectionPoint,
} from "@workspace/diffs"

import {
  DIFF_METRICS,
  diffOptions,
  ensureNeuveDiffTheme,
  getDiffWorkerPool,
} from "@workspace/ui/lib/diffs"
import type { DiffVariant } from "@workspace/ui/lib/diffs"
import { cn } from "@workspace/ui/lib/utils"
import {
  diffVirtualizerAtom,
  effectiveLayoutAtom,
  wrapAtom,
} from "@workspace/ui/neuve/review-desk/atoms"
import type { DiffSide, LineRange } from "@workspace/ui/neuve/types"
import {
  prefersReducedMotion,
  scrollParent,
  whenScrollSettles,
} from "@workspace/ui/neuve/review-desk/scroll-arrival"

declare module "react" {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      /** Host element of the @workspace/diffs renderer (shadow DOM). */
      "diffs-container": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      >
    }
  }
}

/**
 * Ranged review (owned ranges): gaps and sibling-owned runs folded behind
 * one gap row per stretch, opened by the host, or the whole file with other
 * units' runs read-only. None of it changes the diff, so the highlighted
 * result is reused when it changes.
 */
export interface RangedPresentation {
  folds: ReadonlyArray<HunkFold>
  /** Gaps folded into another stretch part's row: they render nothing. */
  hiddenGaps: ReadonlyArray<number>
  expandUnchanged: boolean
  expanded: Readonly<Record<number, HunkExpansionRegion>>
}

/**
 * Lines a jump landed on: scrolled below the sticky header, then tinted once
 * the scroll has arrived (`arrived`, reported through `onLanded`).
 */
export interface SurfaceLanding {
  range: LineRange
  /** More lines that take the tint (a section's separate runs). */
  ranges?: Array<LineRange>
  key: AnnotationOverlayLanding["key"]
  /** Changes on every landing; a new one scrolls again. */
  nonce: number
  /** The scroll has settled on the lines: the tint may start. */
  arrived: boolean
  /** Lines already in view (or, "none", any lines) are not scrolled to; they only tint. */
  scroll?: "if-needed" | "none"
}

export interface DiffSurfaceProps {
  fileDiff: FileDiffMetadata
  /** Overlay annotations; `id` keys pin/body slots and overlay state. */
  annotations: Array<DiffLineAnnotation>
  overlay: {
    expandedId: string | undefined
    dismissedIds: ReadonlyArray<string>
    hintId: string | undefined
    /** Another file's layer is expanded: dim and disable this one too. */
    isolated?: boolean
    /** Lines tinted on the code for an open or pointed-at marker. */
    highlight?: {
      range: LineRange
      /** More lines tinted the same (a section's separate runs). */
      ranges?: Array<LineRange>
      tone: "strong" | "hint"
    }
    /** The engaged marker's lines (its card or list open), outlined. */
    engaged?: LineRange
    /**
     * The engaged lines are the composer's selection: outlined at 1px, a
     * host-level state so a row the live drag has not reached yet never
     * shows the 2px marker outline (round 5c).
     */
    engagedTone?: "composer"
  }
  variant?: DiffVariant
  /**
   * The gutter selection (controlled from jotai). Pierre's own selection
   * machinery draws it and reports changes through `onSelectLines`.
   */
  selection?: LineRange | null
  /** Live while dragging, on click, Shift+click, keys and touch. */
  onSelectLines?: (range: LineRange | null) => void
  /** Enter / C on a line number, or the gutter "+": comment on these lines. */
  onCommitLines?: (range: LineRange) => void
  /**
   * Which lines can take a comment (owned ranges). Given, the fork names
   * the others just "Line N" and never selects them; absent, every line can.
   */
  isLineCommentable?: (side: DiffSide, line: number) => boolean
  /**
   * Owned ranges: fold rows, gap expansion, whole file. Not virtualized,
   * except a whole file above WHOLE_FILE_VIRTUAL_ROWS rows.
   */
  ranged?: RangedPresentation
  /** Rebuild the renderer when this changes (another unit's file). */
  identity?: string
  landing?: SurfaceLanding
  /** The landing's scroll arrived (scrollend, a settled position, or a timeout). */
  onLanded?: (nonce: number) => void
  /** Owned ranges: the code width the slotted gap and fold rows span. */
  onCodeWidth?: (width: number) => void
  /** Accessible name of the code region. */
  label: string
  className?: string
  /** Slotted content: overlay pins and bodies, gap and fold rows. */
  children?: React.ReactNode
}

type Instance = FileDiff | VirtualizedFileDiff

/** Below the sticky file header (44px) with room to breathe. */
const LAND_OFFSET = 60
/** Frames to wait for a landing row to render before giving up. */
const LAND_FRAMES = 12
/**
 * A whole file this long renders through the desk's Virtualizer instead of
 * every row at once (owned-range folds open, rows decorated read-only).
 */
export const WHOLE_FILE_VIRTUAL_ROWS = 3000
/** Gap rows and Pierre's separators share the round-3 gap row height. */
const GAP_ROW_HEIGHT = 32
const METRICS = { ...DIFF_METRICS, hunkSeparatorHeight: GAP_ROW_HEIGHT }
/** Numbered skeleton rows before the renderer attaches (SSR, first frame). */
const SKELETON_ROWS = 40
const SKELETON_WIDTHS = [
  "46%",
  "28%",
  "34%",
  "62%",
  "30%",
  "38%",
  "12%",
  "52%",
  "8%",
]

/**
 * Neuve rules inside the shadow root, on top of lib/diffs SURFACE_CSS: rows
 * of another unit in the read-only neighbor's grayscale (their numbers in
 * --nv-ro-ink, 4.5:1 on the read-only rows, so they still read),
 * revealed gap context a step quieter, the custom separator/fold rows' cells
 * transparent (the slotted row paints them), and rows landing below the
 * sticky header.
 */
const RANGED_CSS = `
[data-line] { scroll-margin-top: ${LAND_OFFSET}px; }
[data-line][data-read-only] { background-color: var(--nv-ro-row); }
[data-line][data-read-only][data-line-type='change-addition'] { background-color: var(--nv-ro-add); }
[data-line][data-read-only][data-line-type='change-deletion'] { background-color: var(--nv-ro-del); }
[data-line][data-read-only] span { color: var(--nv-ro-ink) !important; background-color: transparent !important; }
[data-column-number][data-read-only] { background-color: var(--nv-ro-row); color: var(--nv-ro-ink); }
[data-indicators='classic'] [data-column-number][data-read-only]::after { color: var(--nv-ro-ink); }
[data-ranged] [data-line][data-line-type='context-expanded'] span { opacity: .78; }
[data-separator='custom'], [data-fold-row] { background-color: transparent; text-align: left; }
/* One gap style everywhere (round 3): Pierre's separators look like the
   owned-range gap row — 32px, --nv-expand, the expand control in the gutter
   column, "N unchanged lines" and the hidden range. Pierre keeps its own
   up/down/both controls (behaviour unchanged). */
[data-separator='line-info'] { height: ${GAP_ROW_HEIGHT}px; min-height: ${GAP_ROW_HEIGHT}px; margin-block: 0; background-color: var(--nv-expand); }
[data-separator='line-info'] [data-separator-wrapper] { background-color: var(--nv-expand); padding-left: 0 !important; }
[data-expand-index] [data-separator-wrapper] { grid-template-columns: var(--diffs-column-number-width, 88px) auto; }
[data-expand-index] [data-separator-wrapper][data-separator-multi-button] { grid-template-columns: calc(var(--diffs-column-number-width, 88px) / 2) calc(var(--diffs-column-number-width, 88px) / 2) auto; }
[data-separator='line-info'] [data-expand-button] { background-color: transparent; border-right: 0; color: var(--nv-muted); transition: background-color var(--nv-dur-surface-tone) var(--nv-ease-standard), color var(--nv-dur-surface-tone) var(--nv-ease-standard); }
[data-separator='line-info'] [data-separator-content] { background-color: transparent; border-radius: 0 !important; padding-inline: 10px; font-family: var(--diffs-font-family, monospace); font-size: 11.5px; color: var(--nv-muted); transition: color var(--nv-dur-surface-tone) var(--nv-ease-standard); }
[data-separator-content] [data-unmodified-lines]::before { content: none; }
[data-unmodified-lines][data-hidden-range]::after { content: attr(data-hidden-range); margin-inline-start: 10px; color: var(--nv-muted); opacity: 1; }
[data-expand-index] [data-separator-content]:hover { text-decoration: none; }
@media (hover: hover) {
  [data-separator='line-info'] [data-expand-button]:hover { background-color: var(--nv-raised); color: var(--nv-ink); }
  [data-expand-index] [data-separator-content]:hover { color: var(--nv-ink); }
}
@media (prefers-reduced-motion: reduce) {
  [data-separator='line-info'] [data-expand-button], [data-separator='line-info'] [data-separator-content] { transition: none; }
}
`

/** The skeleton's code bars, repeated past the numbered rows (fork pattern). */
const SKELETON_BARS = [46, 28, 34, 62, 30, 38, 12, 52, 8]
  .map((w, i) => `<rect y='${i * 24 + 8}' width='${w}%25' height='8' rx='4'/>`)
  .join("")
const SKELETON_FILL: React.CSSProperties = {
  backgroundColor: "var(--nv-skel)",
  maskImage: `url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='18' height='24'><rect y='9' width='18' height='6' rx='3'/></svg>"), url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='100%25' height='216'>${SKELETON_BARS}</svg>")`,
  maskRepeat: "repeat-y, repeat-y",
  maskPosition: "58px 0, 100px 0",
  maskSize: "18px 24px, calc(100% - 112px) 216px",
}

/** Before <diffs-container> upgrades, only the skeleton shows (no stray slots). */
const PENDING_CSS =
  "diffs-container:not(:defined)>:not([slot=placeholder]){display:none}"

function toLineRange(range: SelectedLineRange | null): LineRange | null {
  if (range === null) return null
  const side = range.side ?? "additions"
  return {
    start: range.start,
    side,
    end: range.end,
    ...(range.endSide && range.endSide !== side
      ? { endSide: range.endSide }
      : {}),
  }
}

/** First rows of the diff as Pierre shows them, for the pre-attach skeleton. */
function skeletonRows(
  fileDiff: FileDiffMetadata
): Array<[number | undefined, number | undefined]> {
  const rows: Array<[number | undefined, number | undefined]> = []
  for (const hunk of fileDiff.hunks) {
    let oldLine = hunk.deletionStart
    let newLine = hunk.additionStart
    for (const block of hunk.hunkContent) {
      if (block.type === "context") {
        for (let i = 0; i < block.lines; i++) rows.push([oldLine++, newLine++])
      } else {
        for (let i = 0; i < block.deletions; i++)
          rows.push([oldLine++, undefined])
        for (let i = 0; i < block.additions; i++)
          rows.push([undefined, newLine++])
      }
      if (rows.length >= SKELETON_ROWS) return rows
    }
  }
  return rows
}

/** Px a row may sit past the view's edge and still count as in view. */
const IN_VIEW_TOLERANCE = 1

/** A line's rendered code row, or null while it is not in the DOM. */
function lineRow(
  instance: Instance,
  host: HTMLElement,
  line: number,
  side: LineRange["side"]
) {
  const index = instance.getLineIndex(line, side)
  // Rows carry "unified,split" in both layouts; match both exactly, so a
  // paired deletion row (same split index) is never taken for the addition.
  return index
    ? (host.shadowRoot?.querySelector<HTMLElement>(
        `[data-content] [data-line][data-line-index="${index[0]},${index[1]}"]`
      ) ?? null)
    : null
}

/**
 * The rows sit inside the scroller's view: below the sticky header (the
 * row's scroll-margin-top) and above the dock (the scroller's
 * scroll-padding-bottom).
 */
function rowsInView(host: HTMLElement, first: HTMLElement, last: HTMLElement) {
  const scroller = scrollParent(host)
  const view = scroller
    ? scroller.getBoundingClientRect()
    : { top: 0, bottom: window.innerHeight }
  const padding = getComputedStyle(scroller ?? document.documentElement)
  const top =
    view.top + (parseFloat(getComputedStyle(first).scrollMarginTop) || 0)
  const bottom = view.bottom - (parseFloat(padding.scrollPaddingBottom) || 0)
  // Rows sit on sub-pixel positions: a row a fraction past an edge (one
  // scrolled to that edge) is still in view.
  return (
    first.getBoundingClientRect().top >= top - IN_VIEW_TOLERANCE &&
    last.getBoundingClientRect().bottom <= bottom + IN_VIEW_TOLERANCE
  )
}

/**
 * Scroll a landing's first line below the sticky header: the rendered row
 * scrolls itself (its scroll-margin-top); a virtualized row not in the DOM
 * yet is reached through the virtual layout, then corrected once rendered.
 */
function scrollToLine(
  instance: Instance,
  host: HTMLElement,
  range: LineRange,
  mode?: "if-needed" | "none"
) {
  if (mode === "none") return true
  const behavior: ScrollBehavior = prefersReducedMotion() ? "auto" : "smooth"
  const row = lineRow(instance, host, range.start, range.side)
  if (row && mode === "if-needed") {
    const last = lineRow(instance, host, range.end, range.endSide ?? range.side)
    if (last && rowsInView(host, row, last)) return true
  }
  if (row) {
    row.scrollIntoView({ block: "start", behavior })
    return true
  }
  if (!(instance instanceof VirtualizedFileDiff)) return false
  const top = instance.getLinePosition(range.start, range.side)?.top
  if (top === undefined) return false
  const scroller = scrollParent(host)
  const hostTop = host.getBoundingClientRect().top
  if (scroller) {
    scroller.scrollTo({
      top:
        scroller.scrollTop +
        hostTop -
        scroller.getBoundingClientRect().top +
        top -
        LAND_OFFSET,
      behavior,
    })
  } else {
    window.scrollTo({
      top: window.scrollY + hostTop + top - LAND_OFFSET,
      behavior,
    })
  }
  return true
}

/**
 * React host for the forked Pierre renderer.
 *
 * The vanilla instance owns the shadow DOM (code rows, gutter selection and
 * the overlay layer); React owns the light-DOM children it slots into the
 * layer, gap rows and fold rows. The instance is created when the host
 * element attaches (a ref callback, so it never runs on the server) and
 * updated from props after each commit. When the review desk provides a
 * Virtualizer the surface is virtualized (owned ranges are not: their fold
 * rows have heights the virtual layout cannot estimate — except a very long
 * whole file, which renders without fold rows); otherwise every row renders
 * (component stories).
 */
export function DiffSurface({
  fileDiff,
  annotations,
  overlay,
  variant = "review",
  selection = null,
  onSelectLines,
  onCommitLines,
  isLineCommentable,
  ranged,
  identity,
  landing,
  onLanded,
  onCodeWidth,
  label,
  className,
  children,
}: DiffSurfaceProps) {
  const desk = useAtomValue(diffVirtualizerAtom)
  // Stacked/Split and Wrap are Pierre's own diffStyle and overflow options;
  // a change rebuilds the renderer (the ref callback below depends on them).
  const layout = useAtomValue(effectiveLayoutAtom)
  const wrap = useAtomValue(wrapAtom)
  const rowCount =
    layout === "split" ? fileDiff.splitLineCount : fileDiff.unifiedLineCount
  // A very long whole file goes through the Virtualizer: folds open without
  // their rows (read-only decoration only), every gap expanded.
  const bigWhole =
    ranged !== undefined &&
    ranged.expandUnchanged &&
    rowCount > WHOLE_FILE_VIRTUAL_ROWS
  const isRanged = ranged !== undefined && !bigWhole
  const virtualizer = isRanged ? null : desk
  const waiting = !isRanged && desk === "pending"
  const commentable = onSelectLines !== undefined
  // Read at construction: a surface gains or loses the check only by
  // rebuilding (it's in the attach dependencies).
  const limitsComments = isLineCommentable !== undefined
  const instanceRef = React.useRef<Instance | null>(null)
  const hostRef = React.useRef<HTMLElement | null>(null)
  // Latest callbacks for the vanilla instance (assigned after commit).
  const callbacks = React.useRef({
    onSelectLines,
    onCommitLines,
    isLineCommentable,
    onLanded,
    onCodeWidth,
  })
  // The presentation last applied to the instance, as JSON.
  const appliedRanged = React.useRef<string | null>(null)
  const bigFolds = bigWhole ? JSON.stringify(ranged.folds) : ""

  const attach = React.useCallback(
    (host: HTMLElement | null) => {
      // Inside the review desk, wait for its Virtualizer instead of building
      // a renderer that would be replaced one commit later.
      if (host === null || waiting || virtualizer === "pending") return
      ensureNeuveDiffTheme()
      // Any surface that takes comments (a unit's file or a read-only
      // neighbor) makes its gutter the comment surface.
      const select = (range: SelectedLineRange | null) =>
        callbacks.current.onSelectLines?.(toLineRange(range))
      const commit = (range: SelectedLineRange) => {
        const next = toLineRange(range)
        if (next) callbacks.current.onCommitLines?.(next)
      }
      const base = diffOptions(variant, { layout, wrap })
      const options: FileDiffOptions<undefined, undefined> = {
        ...base,
        // Old and new line numbers side by side in the stacked view.
        unifiedLineNumbers: "both",
        unsafeCSS: `${base.unsafeCSS ?? ""}${RANGED_CSS}`,
        ...(isRanged
          ? {
              // Gap rows are the host's (slotted into the separator).
              hunkSeparators: "custom" as const,
            }
          : {}),
        ...(bigFolds
          ? {
              expandUnchanged: true,
              hunkFolds: (JSON.parse(bigFolds) as Array<HunkFold>).map(
                (fold) => ({ ...fold, collapsed: false, row: false })
              ),
            }
          : {}),
        ...(commentable
          ? {
              // Pierre's line selection, extended in the fork with keyboard
              // and touch: the gutter is the comment surface.
              enableLineSelection: true,
              enableKeyboardLineSelection: true,
              touchTapExtendsSelection: true,
              lineHoverHighlight: "number" as const,
              enableGutterUtility: true,
              onLineSelectionChange: select,
              onLineSelected: select,
              onLineSelectionCommit: commit,
              onGutterUtilityClick: commit,
              ...(limitsComments
                ? {
                    isLineCommentable: (point: SelectionPoint) =>
                      callbacks.current.isLineCommentable?.(
                        point.side ?? "additions",
                        point.lineNumber
                      ) ?? true,
                  }
                : {}),
            }
          : {}),
      }
      const pool = getDiffWorkerPool()
      const instance: Instance = virtualizer
        ? new VirtualizedFileDiff(options, virtualizer, METRICS, pool, true)
        : new FileDiff(options, pool, true)
      // Exposed for stories and tests (which renderer is mounted).
      host.dataset.virtualized = virtualizer ? "true" : "false"
      host.dataset.layout = layout
      host.dataset.wrap = wrap ? "true" : "false"
      hostRef.current = host
      instanceRef.current = instance
      appliedRanged.current = null
      // Owned ranges only: slotted gap and fold rows span the code column
      // from its gutter cell and size from the host's width (container
      // queries do not reach slotted content). The width goes to the rows
      // themselves (onCodeWidth), not the host, so a resize never restyles
      // the shadow tree.
      let width = -1
      const sizer =
        !isRanged || typeof ResizeObserver === "undefined"
          ? undefined
          : new ResizeObserver(([entry]) => {
              const next = entry ? Math.floor(entry.contentRect.width) : 0
              if (next === width) return
              width = next
              callbacks.current.onCodeWidth?.(next)
            })
      sizer?.observe(host)
      return () => {
        sizer?.disconnect()
        instance.cleanUp()
        // The host stays mounted (React owns it); drop the old shadow content
        // so a replacement instance starts from an empty root, keeping the
        // fork's placeholder slot (the skeleton shows until it renders).
        for (const child of [...(host.shadowRoot?.children ?? [])]) {
          if (!(
            child instanceof HTMLSlotElement && child.name === "placeholder"
          ))
            child.remove()
        }
        instanceRef.current = null
        hostRef.current = null
      }
    },
    [
      virtualizer,
      waiting,
      variant,
      layout,
      wrap,
      commentable,
      limitsComments,
      isRanged,
      bigFolds,
    ]
  )

  const {
    expandedId,
    dismissedIds,
    hintId,
    isolated = false,
    highlight,
    engaged,
  } = overlay
  const dismissedKey = dismissedIds.join("\u0000")
  const selectionKey = selection ? JSON.stringify(selection) : ""
  const highlightKey = highlight ? JSON.stringify(highlight) : ""
  const engagedKey = engaged ? JSON.stringify(engaged) : ""
  // The big whole file has its presentation from construction.
  const rangedKey = isRanged ? JSON.stringify(ranged) : ""
  // The tint starts only once the scroll has arrived.
  const landingKey =
    landing?.arrived === true
      ? JSON.stringify({
          range: landing.range,
          ...(landing.ranges ? { ranges: landing.ranges } : {}),
          key: landing.key,
        })
      : ""

  // Effect: syncs the vanilla diff renderer (an external system) with committed props, the allowed "synchronize with an external system" case.
  React.useLayoutEffect(() => {
    callbacks.current = {
      onSelectLines,
      onCommitLines,
      isLineCommentable,
      onLanded,
      onCodeWidth,
    }
    const instance = instanceRef.current
    const host = hostRef.current
    if (!instance || !host) return
    if (rangedKey && appliedRanged.current !== rangedKey) {
      const next = JSON.parse(rangedKey) as RangedPresentation
      appliedRanged.current = rangedKey
      instance.setPresentation(
        {
          hunkFolds: next.folds,
          hiddenGaps: next.hiddenGaps,
          expandUnchanged: next.expandUnchanged,
        },
        new Map(
          Object.entries(next.expanded).map(([index, region]) => [
            Number(index),
            region,
          ])
        )
      )
    }
    instance.render({
      fileContainer: host,
      fileDiff,
      lineAnnotations: annotations,
    })
    const nextSelection: SelectedLineRange | null = selectionKey
      ? (JSON.parse(selectionKey) as SelectedLineRange)
      : null
    // notify: false — this is the echo of state that came from the gutter.
    instance.setSelectedLines(nextSelection, { notify: false })
    const state: Partial<AnnotationOverlayState> = {
      expandedId,
      dismissedIds: dismissedKey ? dismissedKey.split("\u0000") : [],
      hintId,
      isolated,
      highlight: highlightKey
        ? (JSON.parse(highlightKey) as AnnotationOverlayHighlight)
        : undefined,
      landing: landingKey
        ? (JSON.parse(landingKey) as AnnotationOverlayLanding)
        : undefined,
      engaged: engagedKey
        ? (JSON.parse(engagedKey) as SelectedLineRange)
        : undefined,
    }
    instance.setAnnotationOverlayState(state)
  }, [
    attach,
    fileDiff,
    annotations,
    expandedId,
    dismissedKey,
    hintId,
    isolated,
    selectionKey,
    highlightKey,
    engagedKey,
    landingKey,
    rangedKey,
    onSelectLines,
    onCommitLines,
    onLanded,
    onCodeWidth,
  ])

  const landingNonce = landing?.nonce
  const landingRange = landing ? JSON.stringify(landing.range) : ""
  const landingScroll = landing?.scroll
  // Effect: scrolls the scroll container (an external system) once per landing, after the renderer has painted the target rows, then reports when the scroll has arrived.
  React.useEffect(() => {
    if (landingNonce === undefined || !landingRange) return
    const range = JSON.parse(landingRange) as LineRange
    let frame = 0
    let attempts = 0
    let cancelArrival: (() => void) | undefined
    const arrived = () => callbacks.current.onLanded?.(landingNonce)
    const tryScroll = () => {
      const instance = instanceRef.current
      const host = hostRef.current
      attempts += 1
      if (
        instance &&
        host &&
        scrollToLine(instance, host, range, landingScroll)
      ) {
        cancelArrival = whenScrollSettles(host, arrived)
        return
      }
      if (attempts < LAND_FRAMES) frame = requestAnimationFrame(tryScroll)
      // The row never rendered: tint what is there rather than nothing.
      else arrived()
    }
    frame = requestAnimationFrame(tryScroll)
    return () => {
      cancelAnimationFrame(frame)
      cancelArrival?.()
    }
  }, [landingNonce, landingRange, landingScroll, attach])

  // A stable box before the renderer paints its rows (they render a frame
  // or more later, after highlighting): the page transition's snapshot and
  // the overlay never see the file grow from nothing. Lower bound only; hunk
  // expansion and wrapped rows grow past it. Owned ranges render at once
  // (never virtualized), so they reserve nothing: folded rows would make any
  // estimate a blank band.
  const reservedRows = isRanged
    ? 0
    : bigWhole
      ? rowCount
      : fileDiff.hunks.reduce(
          (sum, hunk) =>
            sum +
            (layout === "split" ? hunk.splitLineCount : hunk.unifiedLineCount),
          0
        )
  const minHeight = isRanged
    ? undefined
    : reservedRows * (METRICS.lineHeight ?? 24) +
      (bigWhole ? 0 : fileDiff.hunks.length * GAP_ROW_HEIGHT)

  return (
    <diffs-container
      key={identity}
      ref={attach}
      data-commentable={commentable ? "true" : "false"}
      data-ranged={ranged ? "" : undefined}
      style={
        {
          minHeight,
          // Fork hooks (packages/diffs style.css): skeleton bars, the split
          // view's missing side, and the landing tint.
          "--diffs-skeleton-color": "var(--nv-skel)",
          "--diffs-content-buffer-image": "none",
          "--diffs-content-buffer-color": "var(--nv-expand)",
          "--diffs-gutter-buffer-color": "var(--nv-expand)",
          "--diffs-overlay-land": "var(--nv-land)",
        } as React.CSSProperties
      }
      role="region"
      aria-label={label}
      data-engaged-tone={overlay.engagedTone}
      className={cn(
        "nv-diff block",
        variant === "read-only" && "nv-diff-readonly",
        className
      )}
    >
      <style href="nv-diffs-pending" precedence="default">
        {PENDING_CSS}
      </style>
      {/* Until the renderer's first output: the server render (no shadow
          root yet) and the fork's placeholder slot afterwards. */}
      <SkeletonRows fileDiff={fileDiff} height={minHeight} />
      {children}
    </diffs-container>
  )
}

/**
 * Gutter numbers and code bars, never a blank band (round 3 item 6): the
 * first rows numbered, then the bar pattern down the whole reserved height.
 */
function SkeletonRows({
  fileDiff,
  height,
}: {
  fileDiff: FileDiffMetadata
  height: number | undefined
}) {
  const rows = React.useMemo(() => skeletonRows(fileDiff), [fileDiff])
  return (
    <div
      slot="placeholder"
      aria-hidden="true"
      data-skeleton=""
      style={{ height }}
      className="flex animate-skeleton flex-col overflow-hidden font-mono text-[11.5px] text-faint motion-reduce:animate-none"
    >
      {rows.map(([oldLine, newLine], index) => (
        <div
          key={index}
          className="grid h-6 grid-cols-[88px_minmax(0,1fr)] items-center"
        >
          <span className="flex justify-end gap-[1.5ch] pr-[2.2ch] opacity-60">
            <span className="min-w-[3ch] text-right">{oldLine}</span>
            <span className="min-w-[3ch] text-right">{newLine}</span>
          </span>
          <span
            className="ml-[1ch] block h-2 rounded bg-skel"
            style={{
              width:
                SKELETON_WIDTHS[
                  (newLine ?? oldLine ?? index) % SKELETON_WIDTHS.length
                ],
            }}
          />
        </div>
      ))}
      <div className="min-h-0 flex-auto" style={SKELETON_FILL} />
    </div>
  )
}
