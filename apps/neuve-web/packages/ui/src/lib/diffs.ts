/**
 * Neuve configuration for the @workspace/diffs fork (Pierre diffs).
 *
 * - One Shiki theme whose token colours are CSS variables. The variables are
 *   mapped to the brand syntax tokens in globals.css (`.nv-diff`), so light and
 *   dark follow the `.dark` class with no re-highlighting and no theme reads in
 *   components.
 * - Shared render options and virtual-layout metrics that match the approved
 *   row geometry (24px rows, 28px expand rows, no file header).
 * - A lazily created worker pool so Shiki highlighting runs off the main
 *   thread in the browser (never on the server).
 */
import { registerCustomCSSVariableTheme } from "@workspace/diffs"
import type { FileDiffOptions, VirtualFileMetrics } from "@workspace/diffs"
import { getOrCreateWorkerPoolSingleton } from "@workspace/diffs/worker"
import type { WorkerPoolManager } from "@workspace/diffs/worker"
// Vite bundles the worker entry as its own chunk (`?worker`).
import DiffsWorker from "@workspace/diffs/worker/worker.js?worker"

export const NEUVE_DIFF_THEME = "neuve"

/** Defaults only matter when a host lacks the `.nv-diff` class. */
const THEME_DEFAULTS: Record<string, string> = {
  foreground: "var(--nv-syn-pl)",
  background: "var(--nv-surface)",
  "token-keyword": "var(--nv-syn-kw)",
  "token-string": "var(--nv-syn-st)",
  "token-string-expression": "var(--nv-syn-st)",
  "token-function": "var(--nv-syn-fn)",
  "token-comment": "var(--nv-syn-cm)",
  "token-constant": "var(--nv-syn-nu)",
  "token-parameter": "var(--nv-syn-id)",
  "token-punctuation": "var(--nv-syn-pl)",
  "token-link": "var(--nv-syn-fn)",
}

let themeRegistered = false

export function ensureNeuveDiffTheme() {
  if (themeRegistered) return
  themeRegistered = true
  registerCustomCSSVariableTheme(NEUVE_DIFF_THEME, THEME_DEFAULTS, true)
}

/** Row geometry from the design; the virtual layout estimates with it. */
export const DIFF_METRICS: Partial<VirtualFileMetrics> = {
  lineHeight: 24,
  diffHeaderHeight: 0,
  hunkSeparatorHeight: 28,
  spacing: 0,
  paddingTop: 0,
  paddingBottom: 0,
}

/**
 * Styles injected into the diff's shadow root (Pierre's `unsafeCSS` layer).
 * Only geometry and typography that brand variables cannot reach.
 */
const SURFACE_CSS = `
:host { --diffs-gap-block: 0px; --diffs-overlay-width: 300px; }
/* Pierre mixes the diff colours into the row background (80–91%); the brand
   tokens are already the final colours, so use them unmixed. */
[data-line], [data-no-newline], [data-gutter-buffer], [data-column-number] {
  --mix-light: 0%;
  --mix-dark: 0%;
}
pre { border-radius: 0 0 10px 10px; overflow: hidden; }
[data-separator='line-info'] { height: 28px; min-height: 28px; font-size: 11.5px; }
[data-separator-content] { color: var(--nv-muted); }
[data-separator-content] [data-unmodified-lines]::before { content: 'Show '; }
[data-column-number] { font-size: 11.5px; }
/* Gutter as the comment surface: tone shift on hover/focus, a small "+"
   handle (the fork reveals it on focus too), pointer cursor. */
[data-interactive-line-numbers] [data-column-number] { cursor: pointer; }
/* Selected lines: the same accent tint a comment's lines get when open, over
   the row's own diff colour (the mix override above would otherwise erase
   Pierre's selection mix). */
:is([data-line], [data-column-number])[data-selected-line] {
  box-shadow: inset 0 0 0 100vmax var(--diffs-overlay-range-strong);
}
/* A selected line's number in a colour that reads on the selection tint
   (≥4.5:1; round 5c). */
:is([data-gutter-buffer], [data-column-number])[data-selected-line] {
  color: var(--nv-ln-select);
}
/* Round 5c: an engaged marker (its card or its line's list open) shows its
   lines as hover does (the --nv-lit tint) with an outline around the range,
   so the state is not colour alone; the number cells keep the stronger open
   tint. The whole range fades in and out as one box: the outline by the code
   root's engaged amount, the tint by that or, on lines already tinted, the
   highlight's (the diffs fork's "one fade per overlay layer"); at once under
   reduced motion. */
:is([data-line], [data-column-number])[data-overlay-engaged] {
  --lit: var(--diffs-overlay-engaged-in, 1);
}
:is([data-line], [data-column-number])[data-overlay-engaged][data-overlay-range] {
  --lit: max(var(--diffs-overlay-engaged-in, 1), var(--diffs-overlay-range-in, 1));
}
[data-line]:is([data-overlay-engaged], [data-overlay-engaged-leaving]) {
  --w: 2px;
  --shade: var(--diffs-overlay-range-hint);
}
[data-line][data-overlay-engaged] {
  --ring: color-mix(in srgb, var(--diffs-overlay-engaged-ring) calc(var(--diffs-overlay-engaged-in, 1) * 100%), transparent);
  --edges: inset var(--w) 0 0 var(--ring), inset calc(-1 * var(--w)) 0 0 var(--ring);
  --tint: inset 0 0 0 100vmax color-mix(in srgb, var(--shade) calc(var(--lit) * 100%), transparent);
  box-shadow: var(--edges), var(--tint);
}
/* The composer's selected range: the same outline at 1px, quieter than an
   engaged marker's, over the selection tint (round 5c). Keyed on the host,
   so mid-drag a row the selection has just left never turns 2px. */
:host([data-engaged-tone='composer']) [data-line][data-overlay-engaged],
[data-line][data-selected-line][data-overlay-engaged],
[data-line][data-overlay-engaged-leaving~='composer'] {
  --w: 1px;
  --shade: var(--diffs-overlay-range-strong);
}
[data-line][data-overlay-engaged='first'] {
  --edges: inset var(--w) 0 0 var(--ring), inset calc(-1 * var(--w)) 0 0 var(--ring),
    inset 0 var(--w) 0 var(--ring);
}
[data-line][data-overlay-engaged='last'] {
  --edges: inset var(--w) 0 0 var(--ring), inset calc(-1 * var(--w)) 0 0 var(--ring),
    inset 0 calc(-1 * var(--w)) 0 var(--ring);
}
[data-line][data-overlay-engaged='only'] {
  --edges: inset 0 0 0 var(--w) var(--ring);
}
/* Number cells take the open tint as the outline comes in (from the hint a
   pointed-at pin already gave them). */
[data-column-number][data-overlay-engaged] {
  --open: color-mix(in srgb, var(--diffs-overlay-range-strong) calc(var(--diffs-overlay-engaged-in, 1) * 100%), var(--diffs-overlay-range-hint));
  box-shadow: inset 0 0 0 100vmax color-mix(in srgb, var(--open) calc(var(--lit) * 100%), transparent);
}
/* Lines the outline has just left fade out with it, under the current tint
   (a background layer, as the fork paints every leaving layer). A landing
   on engaged lines paints under them the same way, so it fades back to the
   engaged tint, not to nothing. */
[data-line][data-overlay-engaged-leaving] {
  --gone: color-mix(in srgb, var(--diffs-overlay-engaged-ring) calc(var(--diffs-overlay-engaged-out, 0) * 100%), transparent);
  --gone-tint: color-mix(in srgb, var(--shade) calc(var(--diffs-overlay-engaged-out, 0) * 100%), transparent);
  --gone-sides: linear-gradient(to right, var(--gone) var(--w), transparent var(--w) calc(100% - var(--w)), var(--gone) calc(100% - var(--w)));
  --gone-top: linear-gradient(transparent, transparent);
  --gone-bottom: linear-gradient(transparent, transparent);
  --diffs-overlay-engaged-left-layer: var(--gone-top), var(--gone-bottom), var(--gone-sides), linear-gradient(var(--gone-tint), var(--gone-tint));
}
[data-line]:is([data-overlay-engaged-leaving~='first'], [data-overlay-engaged-leaving~='only']) {
  --gone-top: linear-gradient(to bottom, var(--gone) var(--w), transparent var(--w));
}
[data-line]:is([data-overlay-engaged-leaving~='last'], [data-overlay-engaged-leaving~='only']) {
  --gone-bottom: linear-gradient(to top, var(--gone) var(--w), transparent var(--w));
}
[data-column-number][data-overlay-engaged-leaving] {
  --gone-tint: color-mix(in srgb, var(--diffs-overlay-range-strong) calc(var(--diffs-overlay-engaged-out, 0) * 100%), transparent);
  --diffs-overlay-engaged-left-layer: linear-gradient(var(--gone-tint), var(--gone-tint));
}
[data-utility-button] {
  width: 18px; height: 18px; margin-right: -6px; margin-top: 3px;
  border-radius: 5px;
  background-color: var(--nv-ink); color: var(--nv-bg);
  transition: scale var(--nv-dur-press-in) var(--nv-ease-standard);
}
[data-utility-button]:active { scale: var(--nv-scale-press); }
@media (prefers-reduced-motion: reduce) {
  [data-utility-button] { transition: none; }
  [data-utility-button]:active { scale: none; }
}
[data-overlay-hint] { width: 232px; }
/* An open comment thread can run past a short file: keep it above the next
   file's margin items instead of under them. */
[data-overlay-item]:has([data-overlay-body]:not([data-dismissed], [data-empty])) {
  z-index: 3;
}
/* +/− live in the gutter, which Pierre pins while a file scrolls sideways
   (Wrap off), so the sign never scrolls away from its line number. */
[data-indicators='classic'] [data-line]::before { content: none; }
[data-indicators='classic'] [data-line] { padding-inline-start: 1ch; }
[data-indicators='classic'] [data-column-number] { padding-inline-end: 2.2ch; }
[data-indicators='classic'] [data-column-number]:is([data-line-type='change-addition'], [data-line-type='change-deletion'])::after {
  position: absolute; top: 0; right: 0.6ch; width: 1ch; text-align: center;
  user-select: none; pointer-events: none;
}
[data-indicators='classic'] [data-column-number][data-line-type='change-addition']::after {
  content: '+'; color: var(--diffs-addition-base);
}
[data-indicators='classic'] [data-column-number][data-line-type='change-deletion']::after {
  content: '−'; color: var(--diffs-deletion-base);
}
@media (max-width: 1180px) { :host { --diffs-overlay-width: 260px; } }
@media (max-width: 860px) {
  [data-annotation-overlay] {
    inset-inline-start: auto;
    inset-inline-end: 8px;
    width: min(220px, 60%);
  }
  /* Over the code, the pins sit at the row's end and the anchored line wraps
     short of them (their width plus the layer's inset and a gap), so a pin
     never covers code. */
  [data-overlay-pins] { margin-inline-start: auto; }
  [data-line][data-overlay-anchor] {
    padding-inline-end: calc(var(--diffs-overlay-pins-width, 0px) + 14px);
  }
}
`

export type DiffVariant = "review" | "read-only"

export interface DiffPresentation {
  /** Stacked (unified) or split (removed and added rows side by side). */
  layout: "stacked" | "split"
  /** Wrap long lines; off scrolls each file sideways, gutter pinned. */
  wrap: boolean
}

export const DEFAULT_PRESENTATION: DiffPresentation = {
  layout: "stacked",
  wrap: true,
}

export function diffOptions(
  variant: DiffVariant,
  presentation: DiffPresentation = DEFAULT_PRESENTATION
): FileDiffOptions<undefined, undefined> {
  return {
    theme: NEUVE_DIFF_THEME,
    themeType: "light",
    diffStyle: presentation.layout === "split" ? "split" : "unified",
    // Classic +/− signs: the design bans coloured edge rails.
    diffIndicators: "classic",
    hunkSeparators: "line-info",
    disableFileHeader: true,
    annotationLayout: "overlay",
    overflow: presentation.wrap ? "wrap" : "scroll",
    lineDiffType: variant === "review" ? "word-alt" : "none",
    expansionLineCount: 20,
    unsafeCSS: SURFACE_CSS,
  }
}

let pool: WorkerPoolManager | undefined | null = null

/**
 * The shared highlighting worker pool, created on first use in a browser.
 * Returns undefined on the server or where workers are unavailable; the
 * renderer then highlights on the main thread.
 */
export function getDiffWorkerPool(): WorkerPoolManager | undefined {
  if (pool !== null) return pool
  if (typeof window === "undefined" || typeof Worker === "undefined") {
    return undefined
  }
  ensureNeuveDiffTheme()
  try {
    pool = getOrCreateWorkerPoolSingleton({
      poolOptions: {
        poolSize: 2,
        workerFactory: () => new DiffsWorker(),
      },
      highlighterOptions: {
        theme: NEUVE_DIFF_THEME,
        langs: ["typescript", "tsx"],
        lineDiffType: "word-alt",
      },
    })
  } catch {
    pool = undefined
  }
  return pool
}
