/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD — Delivery preview (settings aside)
 *
 * The desk's phased choreography on a miniature unit (delivery-choreography.ts,
 * phased-layer.tsx): the card is the delivery stack, so it changes height
 * once per change, by transform, while its layers step into or out of
 * layout unseen.
 *
 *    0ms   label "<row> · <stop>" fades in, rising OFFSET.label; leaving
 *          blocks fade out last first, one step (27.5ms) apart, over
 *          TIMING.hint (fade only); the card keeps its size
 *  morph   13ms before the last leaving block is out, the card morphs once
 *          on EASE.standard over TIMING.card; its corners stay round
 *  77ms    (75% of the morph): arriving blocks fade in, in reading order,
 *          one step apart, rising OFFSET.hint
 *
 * Blocks: the facts (one), the claims (one), Explained (Before, After, the
 * links' line, the terms' label, the terms), "Done when" (label, each row),
 * the suggested review, the code. Rapid changes retarget from where the card is.
 * Reduced motion: no morph; the height snaps once and contents fade over
 * TIMING.reduced, together; a leaving layer fades where it was.
 * ───────────────────────────────────────────────────────── */

import * as React from "react"
import { CornerDownRightIcon } from "lucide-react"
import { AnimatePresence, motion, useReducedMotionConfig } from "motion/react"

import { EASE, OFFSET, TIMING, ms } from "@workspace/ui/lib/motion"
import { cn } from "@workspace/ui/lib/utils"
import {
  DELIVERY_STOP_DESCRIPTION,
  DELIVERY_STOP_LABEL,
  deliveryStopIndex,
} from "@workspace/ui/neuve/shared/delivery"
import type { DeliveryStop } from "@workspace/ui/neuve/shared/delivery"
import { ReviewMark } from "@workspace/ui/neuve/shared/review-mark"
import { blockFade } from "@workspace/ui/neuve/review-desk/delivery/delivery-motion"
import { usePhased } from "@workspace/ui/neuve/review-desk/delivery/delivery-choreography"
import {
  DeliveryMoveContext,
  DeliveryStack,
  PhasedLayer,
  blockProps,
} from "@workspace/ui/neuve/review-desk/delivery/phased-layer"

/* ── Skeleton pieces ──────────────────────────────────────────────────── */

function Bar({ className }: { className?: string }) {
  return (
    <span className={cn("block h-[7px] rounded-full bg-line", className)} />
  )
}

/** A cited fragment inside the facts. */
function Cite() {
  return (
    <span className="inline-block h-2.5 w-3.5 shrink-0 rounded-[3px] bg-sug-tint" />
  )
}

const SECTION = "flex flex-col gap-[7px] rounded-[9px] bg-paper px-3 py-2.5"
const SECTION_LABEL = "label-mono text-[9.5px]"

/* ── Layers ───────────────────────────────────────────────────────────── */

function FactsSentence() {
  return (
    <div className="flex items-center gap-1.5 pt-2.5">
      <Bar className="w-[72%]" />
      <Cite />
    </div>
  )
}

const CLAIM_ROWS = [
  { key: "a", bar: "w-[62%]", cite: true },
  { key: "b", bar: "w-[84%]", cite: false },
  { key: "c", bar: "w-[46%]", cite: true },
] as const

/** Briefed and Guided: the claims, one per line. */
function Claims() {
  return (
    <div className="flex flex-col gap-1.5 pt-2.5">
      {CLAIM_ROWS.map((row) => (
        <span key={row.key} className="flex items-center gap-1.5">
          <span className="size-1 shrink-0 rounded-full bg-faint" />
          <Bar className={row.bar} />
          {row.cite && <Cite />}
        </span>
      ))}
    </div>
  )
}

/** A chip in the miniature terms. */
function Box({ className }: { className?: string }) {
  return (
    <span
      className={cn("inline-block h-3.5 rounded-[4px] bg-raised-2", className)}
    />
  )
}

const BEFORE_AFTER = [
  {
    key: "before",
    label: "Before",
    bars: ["w-[92%]", "w-[56%]"],
    tone: "opacity-60",
  },
  {
    key: "after",
    label: "After",
    bars: ["w-[96%]", "w-[88%]", "w-[40%]"],
    tone: "",
  },
] as const

const TERMS = [
  { key: "a", chip: "w-[46px]", bar: "w-[78%]" },
  { key: "b", chip: "w-8", bar: "w-[64%]" },
] as const

/**
 * Explained: Before beside After, the claims' links folded into one line,
 * then the terms. No card: the briefing itself changes.
 */
function Explained({ termsLabel }: { termsLabel: string }) {
  return (
    <div className="flex flex-col gap-3 pt-2.5">
      <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-3">
        {BEFORE_AFTER.map((side) => (
          <span
            key={side.key}
            {...blockProps()}
            className="flex flex-col gap-1.5"
          >
            <span className={SECTION_LABEL}>{side.label}</span>
            {side.bars.map((bar) => (
              <Bar key={bar} className={cn(bar, side.tone)} />
            ))}
          </span>
        ))}
      </div>
      <span {...blockProps()} className="flex items-center gap-1.5">
        <CornerDownRightIcon
          aria-hidden="true"
          className="size-2.5 shrink-0 text-faint"
        />
        <Bar className="h-[5px] w-[22%] bg-sug-tint" />
        <Bar className="h-[5px] w-[30%] bg-sug-tint" />
      </span>
      <div className="flex flex-col gap-1.5">
        <span {...blockProps()} className={SECTION_LABEL}>
          {termsLabel}
        </span>
        <span {...blockProps()} className="grid grid-cols-2 gap-x-3">
          {TERMS.map((term) => (
            <span key={term.key} className="flex flex-col gap-1">
              <Box className={term.chip} />
              <Bar className={cn("h-[5px]", term.bar)} />
            </span>
          ))}
        </span>
      </div>
    </div>
  )
}

const MARKS = [
  {
    key: "met",
    mark: "bg-agt-tint shadow-[inset_0_0_0_1.5px_var(--nv-agt-fg)]",
    bar: "w-[70%]",
  },
  {
    key: "not-met",
    mark: "bg-req-tint shadow-[inset_0_0_0_1.5px_var(--nv-req)]",
    bar: "w-[58%]",
  },
  {
    key: "no-evidence",
    mark: "bg-sug-tint shadow-[inset_0_0_0_1.5px_var(--nv-sug)]",
    bar: "w-[48%]",
  },
] as const

const CODE_ROWS = [
  { key: "a", indent: false, widths: ["w-[18%]", "w-[30%]", "w-[22%]"] },
  { key: "b", indent: true, widths: ["w-[26%]", "w-[40%]", "w-[12%]"] },
  { key: "c", indent: true, widths: ["w-[20%]", "w-[34%]"] },
] as const

/**
 * A miniature unit whose layers open and close with the desk's choreography.
 * Decorative skeleton: the card is one image whose name says what the stop
 * delivers; the header label names the row and the stop in text.
 */
export function DeliveryPreview({
  stop,
  rowName,
  termsLabel,
}: {
  stop: DeliveryStop
  /** "Workspace default" or the previewed language's name. */
  rowName: string
  /** "Language terms" or "<language> terms". */
  termsLabel: string
}) {
  const reduce = useReducedMotionConfig() ?? false
  const params = usePhased()
  // One move per stop shown, so a change's leaves and arrivals share a morph.
  const move = React.useMemo(() => ({ stop }), [stop])
  const level = deliveryStopIndex(stop)
  const label = `${rowName} · ${DELIVERY_STOP_LABEL[stop]}`
  const fade = blockFade(reduce ? "reduced" : "full", 0)
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="label-mono">Preview</span>
        <AnimatePresence initial={false} mode="wait">
          <motion.span
            key={label}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: OFFSET.label }}
            animate={{
              opacity: 1,
              y: 0,
              transition: reduce
                ? fade.in
                : {
                    opacity: fade.in,
                    y: {
                      duration: ms(TIMING.card),
                      ease: EASE.standardDecelerate,
                    },
                  },
            }}
            exit={{ opacity: 0, transition: fade.out }}
            className="font-mono text-[11.5px] text-ink-muted"
          >
            {label}
          </motion.span>
        </AnimatePresence>
      </div>
      <DeliveryMoveContext.Provider value={move}>
        <DeliveryStack
          role="img"
          aria-label={`${label}. ${DELIVERY_STOP_DESCRIPTION[stop]}`}
          className="box-border rounded-[14px] bg-surface p-[18px] shadow-card"
        >
          <div className="flex items-center gap-1.5">
            <svg width="8" height="8" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M5 .8 9.2 5 5 9.2 .8 5z" className="fill-req" />
            </svg>
            <Bar className="h-1.5 w-[90px]" />
          </div>
          <div className="pt-3">
            <Bar className="h-2.5 w-[62%] bg-raised-2" />
          </div>
          <AnimatePresence initial={false}>
            {level === 0 && (
              <PhasedLayer key="facts" name="facts" params={params}>
                <FactsSentence />
              </PhasedLayer>
            )}
            {(level === 1 || level === 3) && (
              <PhasedLayer key="claims" name="claims" params={params}>
                <Claims />
              </PhasedLayer>
            )}
            {level === 2 && (
              <PhasedLayer key="explained" name="explained" params={params}>
                <Explained termsLabel={termsLabel} />
              </PhasedLayer>
            )}
          </AnimatePresence>
          <AnimatePresence initial={false}>
            {level === 3 && (
              <PhasedLayer key="check" name="check" params={params}>
                <div className={cn(SECTION, "mt-2.5")}>
                  <span {...blockProps()} className={SECTION_LABEL}>
                    Done when
                  </span>
                  {MARKS.map((row) => (
                    <span
                      key={row.key}
                      {...blockProps()}
                      className="flex items-center gap-2"
                    >
                      <span
                        className={cn("size-3 shrink-0 rounded-full", row.mark)}
                      />
                      <Bar className={row.bar} />
                    </span>
                  ))}
                </div>
              </PhasedLayer>
            )}
            {level < 3 && (
              <PhasedLayer key="code" name="code" params={params}>
                <div className="mt-3 box-border flex flex-col gap-1.5 rounded-lg bg-raised px-3 py-2.5">
                  {CODE_ROWS.map((row) => (
                    <span
                      key={row.key}
                      className={cn("flex gap-1", row.indent && "pl-3.5")}
                    >
                      {row.widths.map((width, index) => (
                        <Bar
                          key={index}
                          className={cn("h-1.5 bg-raised-2", width)}
                        />
                      ))}
                    </span>
                  ))}
                </div>
              </PhasedLayer>
            )}
            {level === 3 && (
              <PhasedLayer key="suggestion" name="suggestion" params={params}>
                <div className="mt-2.5 flex flex-col gap-2 rounded-[10px] bg-surface px-3 py-2.5 shadow-[0_0_0_1px_var(--nv-line)]">
                  <span className="flex items-center gap-2">
                    <ReviewMark sent={false} verdict="changes_requested" />
                    <Bar className="w-10" />
                  </span>
                  <Bar className="h-[5px] w-[70%]" />
                </div>
              </PhasedLayer>
            )}
          </AnimatePresence>
          <div className="flex justify-center">
            <div className="mt-3.5 flex h-[30px] items-center gap-2.5 rounded-[10px] bg-dock px-3">
              <span className="h-1.5 w-11 rounded-full bg-dock-muted" />
              <span className="h-[18px] w-[52px] rounded-md bg-brand" />
            </div>
          </div>
        </DeliveryStack>
      </DeliveryMoveContext.Provider>
      <p className="m-0 text-xs leading-[17px] text-ink-muted">
        One unit, the same facts. Layers open or close as you move a dial.
        Guided swaps the code for the ticket check.
      </p>
    </div>
  )
}
