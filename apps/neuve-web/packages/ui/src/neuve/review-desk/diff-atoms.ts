import { atom } from "jotai"
import type { HunkExpansionRegion } from "@workspace/diffs"

import {
  markViewedAtom,
  viewedKey,
} from "@workspace/ui/neuve/review-desk/landing"
import {
  openingOrder,
  stretchView,
} from "@workspace/ui/neuve/review-desk/diff-model"
import type { RangedStretch } from "@workspace/ui/neuve/review-desk/diff-model"
import type { LineRange } from "@workspace/ui/neuve/types"

/**
 * Round 3 diff state (Sticky.dc.html, Ranges.dc.html): which files are
 * folded, how much of each gap is open, which sibling-owned runs a gap row
 * has opened, the Owned ranges / Whole file choice, and the tint a landing
 * leaves.
 *
 * Keyed per unit, revision and file (`fileKey`), so switching units inside
 * one desk never carries a fold or an open gap to another unit's file.
 * Viewed state itself is the shared contract in landing.ts.
 */

export interface FileIdentity {
  unitId: string
  revision: string
  path: string
}

export function fileKey({ unitId, revision, path }: FileIdentity): string {
  return viewedKey(unitId, revision, path)
}

/** Unchanged lines revealed per click on a gap row (chunk by chunk). */
export const GAP_CHUNK = 20

/** A file folded or opened by its chevron; absent → folded when viewed. */
export const fileFoldAtom = atom<Record<string, boolean>>({})

/** Files shown whole (every gap and sibling run open). */
export const wholeFileAtom = atom<Record<string, true>>({})

/** Revealed lines per gap, by file then gap (its hunk index). */
export const gapExpansionAtom = atom<
  Record<string, Record<number, HunkExpansionRegion>>
>({})

/** Sibling-owned runs a gap row has opened, by file then hunk index. */
export const openSiblingsAtom = atom<Record<string, Record<number, true>>>({})

/**
 * The tint a landing leaves on its lines: `a`/`b` alternate so a repeat
 * landing restarts the fade; `static` under reduced motion (cleared on the
 * next interaction).
 */
export interface LandedTint {
  range: LineRange
  /** More lines that land with `range` (a section's separate runs). */
  ranges?: Array<LineRange>
  key: "a" | "b" | "static"
  /** The landing request it answers. */
  nonce: number
  /** The scroll has arrived: the tint shows and its fade starts. */
  arrived: boolean
  /** Lines already in view, or all lines, are not scrolled to (LandingTarget.scroll). */
  scroll?: "if-needed" | "none"
}
export const landedTintAtom = atom<Record<string, LandedTint>>({})

/** Files the desk renders, so a landing for any other file is cleared. */
export const renderedFilesAtom = atom<ReadonlySet<string>>(new Set<string>())

/* ── Actions ───────────────────────────────────────────── */

export const toggleFoldAtom = atom(
  null,
  (get, set, key: string, folded: boolean) => {
    set(fileFoldAtom, { ...get(fileFoldAtom), [key]: folded })
  }
)

/** The Viewed checkbox: marking a file viewed folds it; unmarking opens it. */
export const setViewedAtom = atom(
  null,
  (get, set, key: string, viewed: boolean) => {
    set(markViewedAtom, key, viewed)
    set(fileFoldAtom, { ...get(fileFoldAtom), [key]: viewed })
  }
)

export const setWholeFileAtom = atom(
  null,
  (get, set, key: string, whole: boolean) => {
    const next = { ...get(wholeFileAtom) }
    if (whole) next[key] = true
    else delete next[key]
    set(wholeFileAtom, next)
    // Back to owned ranges: gaps and sibling runs close again (as on the board).
    if (!whole) {
      set(gapExpansionAtom, { ...get(gapExpansionAtom), [key]: {} })
      set(openSiblingsAtom, { ...get(openSiblingsAtom), [key]: {} })
    }
  }
)

/**
 * Open a gap row's next part, from the owned code outward: up to GAP_CHUNK
 * unchanged lines, or a whole run another unit owns. A stretch before the
 * first owned run opens upward, from the code below it; any other opens
 * downward. `all` opens the whole stretch (a landing or a hidden-markers
 * pin).
 */
export const openStretchAtom = atom(
  null,
  (get, set, key: string, stretch: RangedStretch, all = false) => {
    const expansion = { ...get(gapExpansionAtom)[key] }
    const runs = { ...get(openSiblingsAtom)[key] }
    const parts = all
      ? openingOrder(stretch)
      : [stretchView(stretch, { expansion, openRuns: runs }).head].flatMap(
          (part) => (part ? [part] : [])
        )
    for (const part of parts) {
      if (part.kind === "run") {
        runs[part.run.hunkIndex] = true
        continue
      }
      const { gap } = part
      const region = expansion[gap.hunkIndex] ?? { fromStart: 0, fromEnd: 0 }
      const remaining = gap.size - region.fromStart - region.fromEnd
      if (remaining <= 0) continue
      const step = all ? remaining : Math.min(GAP_CHUNK, remaining)
      expansion[gap.hunkIndex] = stretch.upward
        ? { ...region, fromEnd: region.fromEnd + step }
        : { ...region, fromStart: region.fromStart + step }
    }
    set(gapExpansionAtom, { ...get(gapExpansionAtom), [key]: expansion })
    set(openSiblingsAtom, { ...get(openSiblingsAtom), [key]: runs })
  }
)

export const setLandedTintAtom = atom(
  null,
  (get, set, key: string, tint: LandedTint | null) => {
    const next = { ...get(landedTintAtom) }
    if (tint) next[key] = tint
    else delete next[key]
    set(landedTintAtom, next)
  }
)

/** Is a file rendered? Read on demand (a write-only atom), never subscribed. */
export const isFileRenderedAtom = atom(null, (get, _set, key: string) =>
  get(renderedFilesAtom).has(key)
)

/** Owned ranges: the code column width the slotted rows span, per file. */
export const codeWidthAtom = atom<Record<string, number>>({})

export const setCodeWidthAtom = atom(
  null,
  (get, set, key: string, width: number) => {
    if (get(codeWidthAtom)[key] === width) return
    set(codeWidthAtom, { ...get(codeWidthAtom), [key]: width })
  }
)

export const registerFileAtom = atom(
  null,
  (get, set, key: string, present: boolean) => {
    const next = new Set(get(renderedFilesAtom))
    if (present) next.add(key)
    else next.delete(key)
    set(renderedFilesAtom, next)
  }
)
