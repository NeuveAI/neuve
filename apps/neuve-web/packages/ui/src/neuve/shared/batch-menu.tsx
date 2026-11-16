/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD — Batch menu (header)
 *
 *    0ms   trigger hover (real pointer hover) or press: tone shift
 *          (surfaceTone 120ms, CSS)
 *    0ms   menu enters: opacity 0 → 1, y -4 → 0, scale .98 → 1
 *          (card 220ms, emphasized decelerate, origin top left)
 *  close   menu exits: opacity → 0, y → -4 (cardExit 160ms, accelerate)
 *    0ms   a row is highlighted (pointer or arrow keys): tone shift
 *          (surfaceTone)
 *
 * Reduced motion: opacity-only 150ms; no tone transition.
 * ───────────────────────────────────────────────────────── */

import { atom, useAtomValue, useSetAtom } from "jotai"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { CheckIcon, ChevronDownIcon } from "lucide-react"
import { DropdownMenu } from "radix-ui"

import {
  EASE,
  OFFSET,
  REDUCED_TRANSITION,
  SCALE,
  TIMING,
  ms,
} from "@workspace/ui/lib/motion"
import { cn } from "@workspace/ui/lib/utils"
import {
  useNewBatches,
  useOpenedBatchMenu,
} from "@workspace/ui/neuve/shared/batch-arrivals"
import { NeuveLink } from "@workspace/ui/neuve/shared/nav-link"
import type { NeuveDestination } from "@workspace/ui/neuve/shared/nav-link"
import type { ReviewBatch, ReviewBatches } from "@workspace/ui/neuve/types"

const MENU = {
  offsetY: -OFFSET.card,
  initialScale: SCALE.enter,
  enter: { duration: ms(TIMING.card), ease: EASE.emphasizedDecelerate },
  exit: { duration: ms(TIMING.cardExit), ease: EASE.emphasizedAccelerate },
} as const

const STROKE = 1.75

/**
 * The overview of one batch of a review, at its own address. `/` is the
 * Reviews page, so a batch is always named; without one, the Reviews page.
 */
export function batchOverview(
  batches: ReviewBatches | undefined,
  batchId = batches?.current
): NeuveDestination {
  return batchId === undefined ? { to: "reviews" } : { to: "overview", batchId }
}

/** The review's batches in all: the published ones and those still to come. */
const batchTotal = (batches: ReviewBatches) =>
  batches.all.length + (batches.pending ?? 0)

/**
 * Whether the header shows the batch menu: once the review has more than one
 * batch in all, published or not, so the control is already there when the
 * next batch arrives and nothing moves.
 */
export const hasBatchMenu = (batches: ReviewBatches | undefined) =>
  batches !== undefined && batchTotal(batches) > 1

/** Whether the batch menu is open (one header per screen). */
export const batchMenuOpenAtom = atom(false)

const units = (count: number) => `${count} ${count === 1 ? "unit" : "units"}`

function BatchRow({
  batch,
  batches,
  fresh,
}: {
  batch: ReviewBatch
  batches: ReviewBatches
  /** It arrived while this screen was open. */
  fresh: boolean
}) {
  const current = batch.id === batches.current
  return (
    <DropdownMenu.Item asChild>
      <NeuveLink
        destination={batchOverview(batches, batch.id)}
        aria-current={current ? "page" : undefined}
        className="grid grid-cols-[16px_minmax(0,1fr)] items-start gap-x-2 gap-y-0.5 rounded-lg px-2.5 py-2 text-ink no-underline outline-hidden transition-colors duration-surface-tone ease-standard hover:text-ink data-highlighted:bg-raised motion-reduce:transition-none"
      >
        <span className="row-span-2 flex h-5 items-center">
          {current && (
            <CheckIcon
              aria-hidden="true"
              strokeWidth={STROKE}
              className="size-3.5"
            />
          )}
        </span>
        <span className="text-[13px] leading-5 font-medium text-pretty">
          {batch.title}
        </span>
        <span className="font-mono text-[11px] text-ink-muted">
          {fresh && "New · "}
          {batch.needYou > 0 && (
            <span className="text-req-fg">
              {batch.needYou} {batch.needYou === 1 ? "needs" : "need"} you
              ·{" "}
            </span>
          )}
          {units(batch.unitCount)}
        </span>
      </NeuveLink>
    </DropdownMenu.Item>
  )
}

/**
 * The review's batches, from the header: the batch on screen names the
 * trigger, and each row opens that batch's overview. Shown once the review
 * has more than one batch in all, published or still being reviewed; it
 * lists the published ones. A batch that arrived while the reader was in
 * the review puts a dot on the trigger until the menu is opened, on any of
 * the review's screens, and reads "New" in its row while that menu is open
 * (batch-arrivals.tsx).
 */
export function BatchMenu({ batches }: { batches: ReviewBatches }) {
  const open = useAtomValue(batchMenuOpenAtom)
  const setOpen = useSetAtom(batchMenuOpenAtom)
  const opened = useOpenedBatchMenu()
  const { fresh, unseen } = useNewBatches(batches)
  const reduce = useReducedMotion()
  const index = batches.all.findIndex((batch) => batch.id === batches.current)
  const current = batches.all[index]
  if (!hasBatchMenu(batches) || !current) return null
  return (
    <DropdownMenu.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) opened(batches)
      }}
      modal={false}
    >
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className={cn(
            "relative inline-flex h-7 max-w-[min(360px,60vw)] min-w-0 cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent px-2 text-[13px] font-medium text-ink transition-colors duration-surface-tone ease-standard hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus focus-visible:outline-solid motion-reduce:transition-none max-[600px]:-ml-2 max-[600px]:max-w-full",
            open && "bg-raised"
          )}
        >
          <span className="truncate">{current.title}</span>
          <span className="sr-only">
            , batch {index + 1} of {batchTotal(batches)}
            {unseen > 0 && `, ${unseen} new`}
          </span>
          {unseen > 0 && (
            // In the trigger's corner, out of flow, so the trigger keeps its
            // size; neutral ink (3:1 and more on paper in both themes): it
            // asks nothing of the reader.
            <span
              aria-hidden="true"
              className="absolute top-[3px] right-[3px] size-1.5 rounded-full bg-ink-muted"
            />
          )}
          <ChevronDownIcon
            aria-hidden="true"
            strokeWidth={STROKE}
            className="size-3.5 shrink-0 text-ink-muted"
          />
        </button>
      </DropdownMenu.Trigger>
      <AnimatePresence>
        {open && (
          <DropdownMenu.Portal forceMount>
            <DropdownMenu.Content
              forceMount
              asChild
              align="start"
              sideOffset={6}
            >
              <motion.div
                initial={
                  reduce
                    ? { opacity: 0 }
                    : {
                        opacity: 0,
                        y: MENU.offsetY,
                        scale: MENU.initialScale,
                      }
                }
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={
                  reduce
                    ? { opacity: 0, transition: REDUCED_TRANSITION }
                    : {
                        opacity: 0,
                        y: MENU.offsetY,
                        transition: MENU.exit,
                      }
                }
                transition={reduce ? REDUCED_TRANSITION : MENU.enter}
                style={{ transformOrigin: "top left" }}
                className="z-30 box-border flex w-[min(360px,calc(100vw-32px))] flex-col gap-0.5 rounded-xl bg-surface p-1 font-sans text-sm text-ink shadow-card outline-none"
              >
                {batches.all.map((batch) => (
                  <BatchRow
                    key={batch.id}
                    batch={batch}
                    batches={batches}
                    fresh={fresh.has(batch.id)}
                  />
                ))}
              </motion.div>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        )}
      </AnimatePresence>
    </DropdownMenu.Root>
  )
}
