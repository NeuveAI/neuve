/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD — Source sheet (L2 → L3 drill)
 *
 *    0ms   "Open source": scrim fades in (scrim 160ms, ease-out)
 *    0ms   sheet slides x 24 → 0, opacity 0 → 1 (gentle spring 200/20)
 *  280ms   cited fragment (a quote, or each cited code line) pulses once:
 *          tint-2 overlay fades to the resting tint (pulse 900ms,
 *          ease-out, opacity only)
 *  close   sheet slides out x → 24, fades (sheetExit 200ms, accelerate);
 *          scrim fades; focus returns to "Open source", card stays open
 *
 * Reduced motion: opacity-only 150ms; the pulse becomes a static tint.
 * ───────────────────────────────────────────────────────── */

import * as React from "react"
import { HistorySource } from "./history-source"
import { BeforeYouDecide, PathLabel, ReferenceWhy } from "./reference-parts"
import { withoutSharedIndent } from "./reference-tie"
import { ThreadCard } from "./thread-card"
import { reviewThreadsAtom } from "@workspace/ui/neuve/review-comments/threads"
import { useAtomValue, useSetAtom } from "jotai"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CopyIcon,
  ExternalLinkIcon,
  EyeIcon,
  FileIcon,
  GitCommitHorizontalIcon,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { Dialog as DialogPrimitive } from "radix-ui"

import {
  EASE,
  REDUCED_TRANSITION,
  SPRING,
  TIMING,
  ms,
  OFFSET,
} from "@workspace/ui/lib/motion"
import { cn } from "@workspace/ui/lib/utils"
import {
  closeSheetAtom,
  sheetMarkerAtom,
} from "@workspace/ui/neuve/review-desk/atoms"
import { SOURCE_SHEET_ATTRIBUTE } from "@workspace/ui/neuve/review-desk/floating"
import { editorHref } from "@workspace/ui/neuve/shared/editor-links"
import { HighlightedCode } from "@workspace/ui/neuve/shared/highlighted-code"
import {
  MARKER_KINDS,
  MarkerKindTile,
  markerKind,
} from "@workspace/ui/neuve/shared/marker-kind"
import { NeuveLink } from "@workspace/ui/neuve/shared/nav-link"
import type {
  ContextualMarker,
  SourceAction,
  SourceBlock,
  SourceTone,
  UnitHistoryLoader,
} from "@workspace/ui/neuve/types"

const SHEET = {
  offsetX: OFFSET.sheet, // px the sheet slides in from
  enter: SPRING.gentle,
  exit: { duration: ms(TIMING.sheetExit), ease: EASE.emphasizedAccelerate },
} as const

const SCRIM = {
  transition: { duration: ms(TIMING.scrim), ease: EASE.out },
} as const

const PULSE = {
  transition: {
    delay: ms(TIMING.pulseDelay),
    duration: ms(TIMING.pulse),
    ease: EASE.out,
  },
} as const

const CHIP_TONE: Record<SourceTone, string> = {
  neutral: "bg-raised text-ink-2",
  outline:
    "bg-transparent text-ink-muted shadow-[inset_0_0_0_1px_var(--nv-line)]",
  sug: "bg-sug-tint text-sug-ink",
  req: "bg-req-tint text-req-ink",
  agt: "bg-agt-tint text-agt-fg",
}

const TEXT_TONE: Record<"sug" | "req" | "agt", string> = {
  sug: "text-sug-fg",
  req: "text-req-fg",
  agt: "text-agt-fg",
}

/**
 * Row marks drawn in the product's icon language instead of text glyphs, so
 * a screen reader doesn't read "black circle" before the status word. A
 * marker kind's icon where the meaning matches; otherwise the Lucide icon
 * the Source board draws. Marks that are words ("1 hop", "output") stay
 * text.
 */
const ROW_MARK_ICON = new Map<string, LucideIcon>([
  ["◉", EyeIcon], // observed
  ["!", MARKER_KINDS.gap.icon], // no evidence: the assessment-gap kind
  ["▢", FileIcon], // a file the commit changed
  ["◦", GitCommitHorizontalIcon], // a commit in a file log
])

/** Icon colours on the sheet: the family's icon colour, as in the margin. */
const ICON_TONE: Record<"sug" | "req" | "agt", string> = {
  sug: "text-sug",
  req: "text-req",
  agt: "text-agt",
}

const SHEET_ACTION =
  "inline-flex h-7 flex-none items-center gap-1.5 rounded-[7px] border-0 bg-raised px-[9px] text-xs whitespace-nowrap text-ink no-underline transition-colors duration-surface-tone ease-standard hover:bg-raised-2 hover:text-ink motion-reduce:transition-none"

/**
 * A cited code line's one pulse after the sheet lands: a stronger tint fades
 * to the resting one, so the eye finds the cited lines among their
 * neighbours. Reduced motion keeps the static tint.
 */
function CitedPulse() {
  const reduce = useReducedMotion()
  if (reduce) return null
  return (
    <motion.span
      aria-hidden="true"
      className="absolute inset-0 -z-1 bg-sug-tint-2"
      initial={{ opacity: 1 }}
      animate={{ opacity: 0 }}
      transition={PULSE.transition}
    />
  )
}

/** The cited quote pulses once after the sheet lands. */
function CitedQuote({ text }: { text: string }) {
  const reduce = useReducedMotion()
  return (
    <p className="relative isolate m-0 rounded-lg bg-sug-tint px-2.5 py-2 text-[13.5px] leading-[21px]">
      {!reduce && (
        <motion.span
          aria-hidden="true"
          className="absolute inset-0 -z-1 rounded-lg bg-sug-tint-2"
          initial={{ opacity: 1 }}
          animate={{ opacity: 0 }}
          transition={PULSE.transition}
        />
      )}
      {text}
    </p>
  )
}

function SheetActionLink({ action }: { action: SourceAction }) {
  if (action.kind === "copy-path") {
    return (
      <button
        type="button"
        aria-label="Copy path"
        className={SHEET_ACTION}
        onClick={() => void navigator.clipboard.writeText(action.path)}
      >
        <CopyIcon aria-hidden="true" className="size-3" />
      </button>
    )
  }
  if (action.kind === "editor") {
    return (
      <a
        href={editorHref(action.editor, action.path)}
        className={SHEET_ACTION}
        aria-label={`Open in ${action.editor} (opens externally)`}
      >
        {action.editor === "VS Code" && (
          <ExternalLinkIcon aria-hidden="true" className="size-3" />
        )}
        {action.editor}
      </a>
    )
  }
  return (
    <a
      href={action.href}
      target="_blank"
      rel="noreferrer"
      className={SHEET_ACTION}
      aria-label={
        action.kind === "external"
          ? `${action.label} (opens externally)`
          : undefined
      }
    >
      {action.kind === "external" && (
        <ExternalLinkIcon aria-hidden="true" className="size-3" />
      )}
      {action.label}
    </a>
  )
}

export function SourceBlockView({
  block,
  historyLoader,
}: {
  block: SourceBlock
  historyLoader?: UnitHistoryLoader
}) {
  const threads = useAtomValue(reviewThreadsAtom)
  const closeSheet = useSetAtom(closeSheetAtom)
  switch (block.kind) {
    case "comment-thread": {
      const observed = threads[block.record.id]
      const thread =
        observed?.unitId === block.record.unitId &&
        observed.revisionId === block.record.revision
          ? observed
          : block.thread
      return (
        <ThreadCard
          record={block.record}
          rangeLabel={`Unit · ${block.unitLabel}`}
          thread={thread}
          reviewer={block.reviewer}
          onDismiss={closeSheet}
        />
      )
    }
    case "history":
      return <HistorySource page={block.page} loadPage={historyLoader} />
    case "code": {
      // Long lines wrap under their own text, never past the sheet's edge;
      // the number column stays as wide as the longest number.
      const texts = withoutSharedIndent(block.lines.map((line) => line.text))
      return (
        <figure className="m-0 overflow-hidden rounded-[10px] bg-paper shadow-[0_0_0_1px_var(--nv-line-2)]">
          {block.caption && (
            <figcaption className="border-b border-line-2 px-3 py-2 text-xs leading-4 text-ink-muted">
              {block.caption}
            </figcaption>
          )}
          <div className="grid grid-cols-[max-content_minmax(0,1fr)] py-1.5 font-mono text-[12.5px] leading-[21px]">
            {block.lines.map((line, i) => (
              <div
                key={line.number}
                data-cited={line.cited ? "" : undefined}
                className={cn(
                  "relative isolate col-span-2 grid grid-cols-subgrid py-px",
                  line.cited && "bg-sug-tint"
                )}
              >
                {line.cited && <CitedPulse />}
                <span
                  className={cn(
                    "pr-3 pl-3 text-right tabular-nums select-none",
                    line.cited ? "text-sug-ink" : "text-ln"
                  )}
                >
                  {line.number}
                </span>
                <span className="pr-4 wrap-anywhere whitespace-pre-wrap">
                  <HighlightedCode code={texts[i] ?? line.text} />
                </span>
              </div>
            ))}
          </div>
        </figure>
      )
    }
    case "quote":
      return <CitedQuote text={block.text} />
    case "text":
      return (
        <p className="m-0 text-[13.5px] leading-[21px] text-ink-2">
          {block.text}
        </p>
      )
    case "label":
      return <span className="pt-1 label-mono">{block.text}</span>
    case "rows": {
      // A block of icon marks takes the icon's width; word marks need 48px.
      const iconMarks = block.rows.every((row) => ROW_MARK_ICON.has(row.mark))
      return (
        <div>
          {block.rows.map((row, i) => {
            const MarkIcon = ROW_MARK_ICON.get(row.mark)
            return (
              <div
                key={`${row.label}-${i}`}
                className={cn(
                  "grid items-center gap-2.5 py-[9px]",
                  iconMarks
                    ? "grid-cols-[15px_minmax(0,1fr)_auto]"
                    : "grid-cols-[48px_minmax(0,1fr)_auto]",
                  i > 0 && "border-t border-line-2"
                )}
              >
                {MarkIcon ? (
                  <MarkIcon
                    aria-hidden="true"
                    data-row-mark=""
                    className={cn(
                      "size-[15px]",
                      row.tone ? ICON_TONE[row.tone] : "text-ink-muted"
                    )}
                  />
                ) : (
                  <span
                    className={cn(
                      "font-mono text-[10.5px]",
                      row.tone ? TEXT_TONE[row.tone] : "text-ink-muted"
                    )}
                  >
                    {row.mark}
                  </span>
                )}
                <span className="flex min-w-0 flex-col gap-px">
                  <span
                    className={cn(
                      "text-[13px] wrap-anywhere",
                      block.mono && "font-mono text-[12.5px]",
                      row.tone === "req" && block.mono && "text-req-fg"
                    )}
                  >
                    {row.label}
                  </span>
                  {row.sub && (
                    <span className="font-mono text-[11px] wrap-anywhere text-ink-muted">
                      {row.sub}
                    </span>
                  )}
                </span>
                {row.openPath ? (
                  <a
                    href={editorHref("VS Code", row.openPath)}
                    aria-label={`Open ${row.openPath} in editor`}
                    className={cn(SHEET_ACTION, "h-[26px] px-2")}
                  >
                    <ExternalLinkIcon aria-hidden="true" className="size-3" />
                  </a>
                ) : row.stat ? (
                  <span className="font-mono text-[11px]">
                    {row.stat.additions !== undefined && (
                      <span className="text-add-fg">+{row.stat.additions}</span>
                    )}
                    {row.stat.deletions !== undefined && (
                      <span className="text-del-fg">
                        {" "}
                        −{row.stat.deletions}
                      </span>
                    )}
                  </span>
                ) : (
                  <span
                    className={cn(
                      "font-mono text-[11px]",
                      row.tone ? TEXT_TONE[row.tone] : "text-ink-muted"
                    )}
                  >
                    {row.meta}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )
    }
  }
}

/**
 * A reference's other units, by title: the unit on screen is never named.
 * "Go to its unit" when the source belongs to another unit.
 */
function AlsoCitedBy({
  units,
  goToUnit,
}: {
  units: ReadonlyArray<string>
  goToUnit?: string
}) {
  if (units.length === 0 && !goToUnit) return null
  return (
    <div className="mt-auto flex flex-col gap-2 px-[22px] pt-5 pb-5">
      {units.length > 0 && (
        <>
          <span className="text-xs leading-4 text-ink-muted">
            Also cited by
          </span>
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px] leading-[19px] text-ink-2">
            {units.map((unit) => (
              <li key={unit}>{unit}</li>
            ))}
          </ul>
        </>
      )}
      {goToUnit && (
        <NeuveLink
          destination={{ to: "unit", unitId: goToUnit }}
          className={cn(SHEET_ACTION, "self-start")}
        >
          Go to its unit
          <ArrowRightIcon
            aria-hidden="true"
            className="size-3"
            strokeWidth={1.8}
          />
        </NeuveLink>
      )}
    </div>
  )
}

/**
 * L3 drill: the whole source in a sheet over the unit — kind and status
 * chips, title and mono subtitle, actions (open in an editor, copy path,
 * Linear, the commit), up to four facts coloured only where they carry
 * status, kind-specific blocks with the cited fragment highlighted, and the
 * units that cite it ("Go to its unit" when it belongs to another unit).
 * Code is always Geist Mono.
 *
 * A file's source names it by file name, the folder muted, with no chips;
 * its actions sit beside "Back to unit". A context reference then leads
 * with its reason, led by how it bears on the change, and what to check;
 * the code follows under a caption naming its lines and version, the cited
 * lines tinted among their neighbours, and the other units that cite it
 * close the sheet.
 */
export function SourceSheet({
  markers,
  historyLoader,
  backLabel = "Back to unit",
}: {
  markers: Record<string, ContextualMarker>
  historyLoader?: UnitHistoryLoader
  backLabel?: string
}) {
  const sheetKey = useAtomValue(sheetMarkerAtom)
  const closeSheet = useSetAtom(closeSheetAtom)
  /** Anchor inside the unit column, used to find the card's trigger again. */
  const anchor = React.useRef<HTMLSpanElement>(null)
  /** The element that had focus when the sheet opened: focus goes back to it. */
  const opener = React.useRef<HTMLElement | null>(null)
  const reduce = useReducedMotion()
  const marker = sheetKey ? markers[sheetKey] : undefined
  const source = marker?.source
  const tie = marker?.reference
  const backButton = (
    <DialogPrimitive.Close asChild>
      <button type="button" data-sheet-back="" className={SHEET_ACTION}>
        <ArrowLeftIcon
          aria-hidden="true"
          className="size-3"
          strokeWidth={1.9}
        />
        {/* In a narrow sheet (a phone) the arrow alone, so the title keeps its width. */}
        <span className="@max-[28rem]:sr-only">{backLabel}</span>
      </button>
    </DialogPrimitive.Close>
  )

  return (
    <>
      <span ref={anchor} hidden />
      <DialogPrimitive.Root
        open={source !== undefined}
        onOpenChange={(open) => {
          if (!open) closeSheet()
        }}
      >
        <AnimatePresence
          onExitComplete={() => {
            // "Back returns you to the same line": refocus what opened the
            // sheet (a card's trigger, a briefing chip). If it is gone or
            // can't take focus, refocus the card's trigger; the card floats
            // in a portal, outside the unit column. Next frame, so Radix's
            // focus trap has been torn down with the sheet. The desk stays
            // where the reviewer left it: refocusing never scrolls.
            const target = opener.current
            opener.current = null
            requestAnimationFrame(() => {
              const doc = anchor.current?.ownerDocument
              if (!doc) return
              if (target?.isConnected) {
                target.focus({ preventScroll: true })
                if (doc.activeElement === target) return
              }
              doc
                .querySelector<HTMLElement>(
                  "[data-floating-card] [data-source-trigger]"
                )
                ?.focus({ preventScroll: true })
            })
          }}
        >
          {source && (
            <React.Fragment key="sheet">
              <DialogPrimitive.Overlay asChild forceMount>
                <motion.div
                  {...{ [SOURCE_SHEET_ATTRIBUTE]: "" }}
                  className="absolute inset-0 z-20 bg-scrim"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={reduce ? REDUCED_TRANSITION : SCRIM.transition}
                />
              </DialogPrimitive.Overlay>
              {/* The sheet's layer spans the unit column. In the app shell
              (from 861px) the column is the viewport's height and the
              sheet fills it. In one column the page scrolls and the column
              is taller than the viewport: the sheet sticks to the
              viewport's top at the viewport's height, so it opens where
              the reviewer is, never at the column's top. */}
              <div className="pointer-events-none absolute inset-0 z-21">
                <DialogPrimitive.Content
                  asChild
                  forceMount
                  // Escape returns to the card only; the desk's own Escape
                  // handler (close card) must not also see this keypress.
                  onEscapeKeyDown={(event) => event.stopPropagation()}
                  // Before focus moves in, the opener still has it.
                  onOpenAutoFocus={(event) => {
                    const content = event.currentTarget as HTMLElement
                    const active = content.ownerDocument.activeElement
                    opener.current =
                      active instanceof HTMLElement &&
                      active !== active.ownerDocument.body
                        ? active
                        : null
                    // Focus lands on "Back to unit", whatever actions sit
                    // before it in the header, without scrolling the page
                    // under the sheet (as Radix's own autofocus does).
                    const back =
                      content.querySelector<HTMLElement>("[data-sheet-back]")
                    if (back) {
                      event.preventDefault()
                      back.focus({ preventScroll: true })
                    }
                  }}
                  // Focus is restored in AnimatePresence.onExitComplete instead.
                  onCloseAutoFocus={(event) => event.preventDefault()}
                  // A file's sheet without a reference has no description: its
                  // file name is the whole title.
                  {...(source.path && !tie
                    ? { "aria-describedby": undefined }
                    : {})}
                >
                  <motion.aside
                    {...{ [SOURCE_SHEET_ATTRIBUTE]: "" }}
                    initial={
                      reduce ? { opacity: 0 } : { opacity: 0, x: SHEET.offsetX }
                    }
                    animate={{ opacity: 1, x: 0 }}
                    exit={
                      reduce
                        ? { opacity: 0, transition: REDUCED_TRANSITION }
                        : {
                            opacity: 0,
                            x: SHEET.offsetX,
                            transition: SHEET.exit,
                          }
                    }
                    transition={reduce ? REDUCED_TRANSITION : SHEET.enter}
                    className="@container pointer-events-auto sticky top-0 ml-auto box-border flex h-full max-h-dvh w-[min(580px,100%)] flex-col overflow-auto bg-surface shadow-card outline-none"
                  >
                    <div className="flex flex-col gap-2.5 border-b border-line-2 px-[22px] pt-[18px] pb-3.5">
                      {source.path ? (
                        <div className="grid grid-cols-[32px_minmax(0,1fr)_auto] items-start gap-x-2.5">
                          <MarkerKindTile kind={markerKind(marker)} size={32} />
                          <DialogPrimitive.Title className="m-0 min-w-0 pt-px text-base font-normal">
                            <PathLabel path={source.path} size="sheet" />
                          </DialogPrimitive.Title>
                          <div className="flex items-center gap-1.5">
                            {source.actions.map((action, i) => (
                              <SheetActionLink key={i} action={action} />
                            ))}
                            {backButton}
                          </div>
                        </div>
                      ) : (
                        <div className="grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-1">
                          <span className="row-span-3 self-start pt-0.5">
                            <MarkerKindTile
                              kind={markerKind(marker)}
                              size={32}
                            />
                          </span>
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <span className="label-mono">{source.kind}</span>
                            {source.chips.map((chip) => (
                              <span
                                key={chip.text}
                                className={cn(
                                  "rounded-[5px] px-[7px] py-0.5 font-mono text-[10.5px] whitespace-nowrap",
                                  CHIP_TONE[chip.tone]
                                )}
                              >
                                {chip.text}
                              </span>
                            ))}
                          </div>
                          {backButton}
                          <DialogPrimitive.Title className="col-span-2 m-0 text-xl leading-[26px] font-semibold tracking-[-0.02em] wrap-anywhere">
                            {source.title}
                          </DialogPrimitive.Title>
                          {tie ? (
                            // A reference is described by its reason, below.
                            <span className="col-span-2 col-start-2 font-mono text-xs text-ink-muted">
                              {source.subtitle}
                            </span>
                          ) : (
                            <DialogPrimitive.Description className="col-span-2 col-start-2 m-0 font-mono text-xs text-ink-muted">
                              {source.subtitle}
                            </DialogPrimitive.Description>
                          )}
                        </div>
                      )}
                      {!source.path && source.actions.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {source.actions.map((action, i) => (
                            <SheetActionLink key={i} action={action} />
                          ))}
                        </div>
                      )}
                    </div>
                    {tie && (
                      <div className="flex flex-col gap-4 border-b border-line-2 px-[22px] pt-4 pb-5">
                        <DialogPrimitive.Description asChild>
                          <ReferenceWhy
                            tie={tie}
                            why={marker.applies}
                            className="max-w-[62ch] text-[15px] leading-[23px]"
                          />
                        </DialogPrimitive.Description>
                        {marker.check && (
                          <BeforeYouDecide
                            check={marker.check}
                            className="max-w-[62ch] text-[13.5px] leading-5"
                          />
                        )}
                      </div>
                    )}
                    {source.facts.length > 0 && (
                      <dl className="m-0 grid grid-cols-2 gap-x-[18px] gap-y-2.5 border-b border-line-2 px-[22px] py-3.5">
                        {source.facts.map((fact) => (
                          <div
                            key={fact.label}
                            className="flex min-w-0 flex-col gap-0.5"
                          >
                            <dt className="text-[11.5px] text-ink-muted">
                              {fact.label}
                            </dt>
                            <dd
                              className={cn(
                                "m-0 truncate",
                                fact.mono ? "font-mono text-xs" : "text-[13px]",
                                fact.tone ? TEXT_TONE[fact.tone] : "text-ink"
                              )}
                            >
                              {fact.value}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    )}
                    <div className="flex flex-col gap-3 px-[22px] pt-4">
                      {source.blocks.map((block, i) => (
                        <SourceBlockView
                          key={i}
                          block={block}
                          historyLoader={historyLoader}
                        />
                      ))}
                    </div>
                    {tie ? (
                      <AlsoCitedBy
                        units={source.citedBy.slice(1)}
                        goToUnit={source.goToUnit}
                      />
                    ) : (
                      <div className="mt-auto flex flex-wrap items-center gap-2 px-[22px] py-4 text-xs text-ink-muted">
                        Cited by
                        {source.citedBy.map((unit) => (
                          <span
                            key={unit}
                            className="rounded-[5px] bg-raised px-[7px] py-0.5 font-mono text-[11px] text-ink-2"
                          >
                            {unit}
                          </span>
                        ))}
                        {source.goToUnit && (
                          <NeuveLink
                            destination={{
                              to: "unit",
                              unitId: source.goToUnit,
                            }}
                            className={cn(SHEET_ACTION, "ml-auto")}
                          >
                            Go to its unit
                            <ArrowRightIcon
                              aria-hidden="true"
                              className="size-3"
                              strokeWidth={1.8}
                            />
                          </NeuveLink>
                        )}
                      </div>
                    )}
                  </motion.aside>
                </DialogPrimitive.Content>
              </div>
            </React.Fragment>
          )}
        </AnimatePresence>
      </DialogPrimitive.Root>
    </>
  )
}
