/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD — Sections (10.109, Main.dc.html)
 *
 * A unit is one file's changes in one lane; when they are separate changes,
 * each is a section with its own row above its lines.
 *
 *    0ms   row hover (real pointer) — its lines take the --nv-lit hint
 *          (line tint, the briefing's), its steps a tone shift
 *          (surfaceTone 120ms, CSS)
 *    0ms   step press — focus moves to the same step on the next row (the
 *          other at either end); its row scrolls in under the sticky file
 *          header unless it and its lines are in view (smooth scroll)
 *  scroll  arrived — its lines take the landing tint, hold (landHold),
 *          then fade (landFade), as a briefing link's do
 *  stuck   a row has scrolled away — its title shows at the top of the
 *          margin beside its lines: opacity 0 → 1 (hint 140ms, ease-out),
 *          from a scroll-state query on the sticky title; it scrolls away
 *          with its last lines and gives way while a margin card is open
 *
 * Reduced motion: an instant scroll, the landing tint stays until the next
 * action, the margin title's fade takes the reduced 150ms.
 * ───────────────────────────────────────────────────────── */

import * as React from "react"
import { atom, useAtomValue, useSetAtom } from "jotai"
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react"

import { cn } from "@workspace/ui/lib/utils"
import { codeWidthAtom } from "@workspace/ui/neuve/review-desk/diff-atoms"
import { sectionSlotName } from "@workspace/ui/neuve/review-desk/diff-model"
import type { RangedSection } from "@workspace/ui/neuve/review-desk/diff-model"
import {
  landOnAtom,
  litLinesAtom,
} from "@workspace/ui/neuve/review-desk/landing"
import {
  prefersReducedMotion,
  scrollParent,
  whenScrollSettles,
} from "@workspace/ui/neuve/review-desk/scroll-arrival"

/** The sticky file header's height: it covers the top of the code. */
const HEADER_HEIGHT = 44
/** Where a step brings a row: just below the header (the row's scroll-mt). */
const LANDED_TOP = 52
/** The margin title sticks this far from the top. */
const TITLE_TOP = 12

/**
 * The margin title holds only once stuck (a scroll-state query); without
 * the query it stays hidden, and the rows still carry every section.
 */
const SECTION_CSS = `
.nv-sec-sticky{position:sticky;top:${TITLE_TOP}px;container-name:nv-sec;container-type:scroll-state}
.nv-sec-title{visibility:hidden;opacity:0;transition:opacity var(--nv-dur-hint) var(--nv-ease-out),visibility 0s linear var(--nv-dur-hint)}
@container nv-sec scroll-state(stuck: top){.nv-sec-title{visibility:visible;opacity:1;transition:opacity var(--nv-dur-hint) var(--nv-ease-out),visibility 0s}}
@media (prefers-reduced-motion:reduce){.nv-sec-title{transition-duration:var(--nv-dur-reduced),0s}}
`

const STEP_CLASS =
  "inline-flex size-6 shrink-0 items-center justify-center rounded-md border-0 bg-transparent text-ink-muted transition-colors duration-surface-tone ease-standard hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus disabled:pointer-events-none disabled:opacity-40 motion-reduce:transition-none"

interface SectionTarget {
  unitId: string
  filePath: string
  fileKeyValue: string
}

function rowOf(scope: ParentNode | null | undefined, id: string) {
  return scope?.querySelector<HTMLElement>(
    `[data-section-row="${CSS.escape(id)}"]`
  )
}

/**
 * A step to another section: focus moves to the same step on its row (the
 * other one at either end, where this one is disabled), the row scrolls in
 * below the sticky file header unless it and its lines are in view, and its
 * lines take the landing tint once the scroll has arrived.
 */
function useStep(
  target: SectionTarget,
  sections: ReadonlyArray<RangedSection>
) {
  const landOn = useSetAtom(landOnAtom)
  return (
    to: RangedSection,
    direction: "prev" | "next",
    origin: HTMLElement
  ) => {
    const card = origin.closest<HTMLElement>("[data-file-card]")
    const row = rowOf(card, to.id)
    if (!card || !row) return
    const keep =
      direction === "next"
        ? to.index < to.of - 1
          ? "next"
          : "prev"
        : to.index > 0
          ? "prev"
          : "next"
    row
      .querySelector<HTMLElement>(`[data-step="${keep}"]`)
      ?.focus({ preventScroll: true })
    const [first, ...rest] = to.ranges
    const land = () =>
      landOn({
        unitId: target.unitId,
        filePath: target.filePath,
        range: first!,
        ranges: rest,
        scroll: "none",
      })
    const scroller = scrollParent(row)
    const top =
      (scroller ? scroller.getBoundingClientRect().top : 0) + HEADER_HEIGHT
    const bottom = scroller
      ? scroller.getBoundingClientRect().bottom
      : window.innerHeight
    // Its lines end at the next section's row, or at the end of the code.
    const after = sections[to.index + 1]
    const next = after ? rowOf(card, after.id) : undefined
    const end = next
      ? next.getBoundingClientRect().top
      : (card
          .querySelector<HTMLElement>("diffs-container")
          ?.getBoundingClientRect().bottom ?? Infinity)
    if (row.getBoundingClientRect().top >= top && end <= bottom) return land()
    row.scrollIntoView({
      block: "start",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    })
    whenScrollSettles(row, land)
  }
}

/**
 * Real pointer hover lights the lines a section owns (the --nv-lit hint), as
 * a briefing phrase or a margin pin does; leaving, or unmounting while
 * pointed at, puts them out.
 */
function useLightsSection(target: SectionTarget, section: RangedSection) {
  const setLit = useSetAtom(litLinesAtom)
  const phrase = `section:${target.fileKeyValue}:${section.id}`
  const unlight = React.useCallback(
    () => setLit((current) => (current?.phrase === phrase ? null : current)),
    [setLit, phrase]
  )
  // A ref callback, so no effect is needed.
  const ref = React.useCallback(
    (element: HTMLElement | null) => (element ? unlight : undefined),
    [unlight]
  )
  return {
    ref,
    onPointerEnter: (event: React.PointerEvent) => {
      if (event.pointerType === "mouse")
        setLit({
          unitId: target.unitId,
          filePath: target.filePath,
          range: section.ranges[0]!,
          ranges: section.ranges.slice(1),
          phrase,
        })
    },
    onPointerLeave: unlight,
  }
}

function Steps({
  section,
  sections,
  step,
}: {
  section: RangedSection
  sections: ReadonlyArray<RangedSection>
  step: ReturnType<typeof useStep>
}) {
  const before = sections[section.index - 1]
  const after = sections[section.index + 1]
  return (
    <span className="inline-flex shrink-0 gap-0.5">
      <button
        type="button"
        data-step="prev"
        disabled={!before}
        aria-label="Previous section"
        onClick={(event) => before && step(before, "prev", event.currentTarget)}
        className={STEP_CLASS}
      >
        <ChevronUpIcon aria-hidden="true" className="size-3.5" />
      </button>
      <button
        type="button"
        data-step="next"
        disabled={!after}
        aria-label="Next section"
        onClick={(event) => after && step(after, "next", event.currentTarget)}
        className={STEP_CLASS}
      >
        <ChevronDownIcon aria-hidden="true" className="size-3.5" />
      </button>
    </span>
  )
}

function Position({ section }: { section: RangedSection }) {
  return (
    <span className="shrink-0 font-mono text-[11px] leading-4 whitespace-nowrap text-ink-muted tabular-nums">
      {section.index + 1} of {section.of}
    </span>
  )
}

/**
 * One row above each section's first lines (slotted into its fold row): its
 * title, where it stands and the steps to the sections before and after. The
 * title lines up with the gap rows' labels; on a phone the row starts at the
 * edge. Split view puts the position and the steps on the new side.
 */
export function SectionRows({
  target,
  sections,
  split,
}: {
  target: SectionTarget
  sections: ReadonlyArray<RangedSection>
  split: boolean
}) {
  const step = useStep(target, sections)
  const hostWidth = useAtomValue(codeWidthAtom)[target.fileKeyValue] ?? 0
  const width = split ? Math.floor(hostWidth / 2) : hostWidth
  const rowWidth: React.CSSProperties = { width, marginRight: -width }
  return (
    <>
      {sections.map((section) => (
        <SectionRow
          key={section.id}
          target={target}
          section={section}
          sections={sections}
          split={split}
          rowWidth={rowWidth}
          step={step}
        />
      ))}
    </>
  )
}

function SectionRow({
  target,
  section,
  sections,
  split,
  rowWidth,
  step,
}: {
  target: SectionTarget
  section: RangedSection
  sections: ReadonlyArray<RangedSection>
  split: boolean
  rowWidth: React.CSSProperties
  step: ReturnType<typeof useStep>
}) {
  const lights = useLightsSection(target, section)
  const slot = sectionSlotName(section.hunks[0]!)
  const band =
    "relative z-1 min-h-8 border-y border-line-2 bg-surface font-sans whitespace-normal select-none"
  return (
    <>
      <div
        slot={slot}
        data-section-row={section.id}
        style={rowWidth}
        className={cn(
          band,
          "grid scroll-mt-[52px] grid-cols-[var(--diffs-column-number-width,88px)_minmax(0,1fr)_auto] items-center max-[639px]:grid-cols-[minmax(0,1fr)_auto]"
        )}
      >
        <span aria-hidden="true" className="max-[639px]:hidden" />
        <span
          {...lights}
          className="flex min-w-0 items-center gap-2 py-1 pl-2.5 max-[639px]:pl-3.5"
        >
          <h2 className="m-0 line-clamp-2 min-w-0 flex-auto text-[12.5px] leading-4 font-medium text-ink-2 max-[639px]:line-clamp-3">
            {section.title}
          </h2>
          {!split && <Position section={section} />}
        </span>
        {!split && (
          <span className="pr-1.5">
            <Steps section={section} sections={sections} step={step} />
          </span>
        )}
      </div>
      {split && (
        <div
          slot={`${slot}:additions`}
          style={rowWidth}
          className={cn(band, "flex items-center justify-end gap-2 pr-1.5")}
        >
          <Position section={section} />
          <Steps section={section} sections={sections} step={step} />
        </div>
      )}
    </>
  )
}

interface Placement {
  /** Each row's top and height, from the margin column's top. */
  rows: Array<{ top: number; height: number }>
  /** Where the code ends. */
  end: number
}

const placementsAtom = atom<Record<string, Placement | undefined>>({})
const placeAtom = atom(
  null,
  (get, set, key: string, placement: Placement | undefined) => {
    const held = get(placementsAtom)[key]
    if (JSON.stringify(held) === JSON.stringify(placement)) return
    set(placementsAtom, { ...get(placementsAtom), [key]: placement })
  }
)

/**
 * The margin column beside a file's code. With sections, each one's title
 * spans its lines there and holds at the top from when its row passes under
 * the sticky file header until the next section's row arrives (or the code
 * ends). Hidden with the margin on narrow screens, where the rows carry it.
 */
export function SectionMargin({
  target,
  sections,
  quiet,
}: {
  target: SectionTarget
  sections: ReadonlyArray<RangedSection>
  /** A margin card or the composer is open: the titles give way. */
  quiet: boolean
}) {
  const columnRef = React.useRef<HTMLDivElement>(null)
  const placement = useAtomValue(placementsAtom)[target.fileKeyValue]
  const place = useSetAtom(placeAtom)
  const step = useStep(target, sections)
  const ids = sections.map((section) => section.id).join("\n")
  // Effect: measures where the section rows sit (the rendered layout, an external system) whenever the file's box changes size, so each margin title spans its section's lines.
  React.useEffect(() => {
    const column = columnRef.current
    const card = column?.parentElement
    if (!column || !card || !ids || typeof ResizeObserver === "undefined")
      return
    const measure = () => {
      const top = column.getBoundingClientRect().top
      const rows = ids.split("\n").map((id) => rowOf(card, id))
      const host = card.querySelector<HTMLElement>("diffs-container")
      if (
        !host ||
        rows.some((row) => !row || row.getClientRects().length === 0)
      )
        return place(target.fileKeyValue, undefined)
      place(target.fileKeyValue, {
        rows: rows.map((row) => {
          const rect = row!.getBoundingClientRect()
          return { top: rect.top - top, height: rect.height }
        }),
        end: host.getBoundingClientRect().bottom - top,
      })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(card)
    measure()
    return () => {
      observer.disconnect()
      place(target.fileKeyValue, undefined)
    }
  }, [ids, target.fileKeyValue, place])
  return (
    <div
      ref={columnRef}
      className="relative shrink-0 grow-0 basis-[300px] self-stretch max-[1180px]:basis-[260px] max-[860px]:hidden"
    >
      {sections.length > 0 && (
        <style href="nv-section-rows" precedence="default">
          {SECTION_CSS}
        </style>
      )}
      {placement &&
        !quiet &&
        sections.map((section, index) => {
          const row = placement.rows[index]
          if (!row) return null
          const next = placement.rows[index + 1]
          // It holds once its row is under the sticky header, and has gone by
          // the time the next row reaches where a step brings it.
          const top = row.top + row.height - HEADER_HEIGHT + TITLE_TOP
          const bottom = next ? next.top - LANDED_TOP : placement.end
          return (
            <div
              key={section.id}
              className="pointer-events-none absolute inset-x-0 z-10"
              style={{ top, height: Math.max(0, bottom - top) }}
            >
              <MarginTitle
                target={target}
                section={section}
                sections={sections}
                step={step}
              />
            </div>
          )
        })}
    </div>
  )
}

function MarginTitle({
  target,
  section,
  sections,
  step,
}: {
  target: SectionTarget
  section: RangedSection
  sections: ReadonlyArray<RangedSection>
  step: ReturnType<typeof useStep>
}) {
  const lights = useLightsSection(target, section)
  return (
    <div className="nv-sec-sticky">
      <div
        {...lights}
        data-section-title={section.id}
        className="nv-sec-title pointer-events-auto flex items-start gap-2 rounded-lg bg-background py-1.5 pr-1 pl-3 shadow-[0_0_0_1px_var(--nv-line-2)]"
      >
        {/* The row holds the heading; this is its echo beside the lines. */}
        <span
          aria-hidden="true"
          className="line-clamp-2 min-w-0 flex-auto pt-1 text-xs leading-4 text-ink-2"
        >
          {section.title}
        </span>
        <span className="pt-1">
          <Position section={section} />
        </span>
        <Steps section={section} sections={sections} step={step} />
      </div>
    </div>
  )
}
