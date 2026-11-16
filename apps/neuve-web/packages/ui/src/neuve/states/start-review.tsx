/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD — "Start a review"
 *
 *    0ms   press: tone shift + press compress (surfaceTone 120ms, CSS)
 *    0ms   starting: label swaps to "Starting…", spinner turns (CSS spin,
 *          off under reduced motion), button disabled + aria-busy
 *  done    the batch arrives through the route loader; the page swaps
 *          (router view transition)
 *  fail    the error line rises: opacity 0 → 1, y 4 → 0 (snappy spring),
 *          the button reads "Try again"
 *
 * Reduced motion: no spinner turn, the error line fades 150ms.
 * ───────────────────────────────────────────────────────── */

import { atom, useAtomValue, useSetAtom } from "jotai"
import { useHydrateAtoms } from "jotai/utils"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { ArrowRightIcon, LoaderCircleIcon } from "lucide-react"

import { REDUCED_TRANSITION, SPRING } from "@workspace/ui/lib/motion"
import { cn } from "@workspace/ui/lib/utils"

/** "Start a review" asks the assigned harness to register a review batch. */
export type StartReviewHandler = () => Promise<void> | void

export type StartReviewState =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "failed"; message: string }

export const startReviewStateAtom = atom<StartReviewState>({ status: "idle" })

/**
 * Runs the handler: idle → starting → idle (the batch then arrives through
 * the normal loader) or failed (with the reason). Never runs twice at once.
 */
export const startReviewAtom = atom(
  null,
  async (get, set, handler: StartReviewHandler) => {
    if (get(startReviewStateAtom).status === "starting") return
    set(startReviewStateAtom, { status: "starting" })
    try {
      await handler()
      set(startReviewStateAtom, { status: "idle" })
    } catch (error) {
      set(startReviewStateAtom, {
        status: "failed",
        message:
          error instanceof Error && error.message
            ? error.message
            : "The review didn’t start.",
      })
    }
  }
)

/**
 * The batch overview's one action when there is no review batch. It acts
 * (a request to the harness), so it is a button, not a link.
 */
export function StartReviewButton({
  onStartReview,
  initialState,
}: {
  onStartReview: StartReviewHandler
  /** Seeds the state (stories). */
  initialState?: StartReviewState
}) {
  useHydrateAtoms(
    new Map([[startReviewStateAtom, initialState ?? { status: "idle" }]])
  )
  const state = useAtomValue(startReviewStateAtom)
  const start = useSetAtom(startReviewAtom)
  const reduce = useReducedMotion()
  const starting = state.status === "starting"
  const failed = state.status === "failed"
  return (
    <div className="flex flex-col items-center gap-2.5">
      <button
        type="button"
        onClick={() => void start(onStartReview)}
        disabled={starting}
        aria-busy={starting || undefined}
        className={cn(
          "group/cta inline-flex h-11 min-w-[168px] press items-center justify-center gap-2.5 rounded-[10px] border-0 bg-ink px-[18px] font-sans text-sm font-medium text-paper hover:bg-ink/90 motion-reduce:transition-none",
          "disabled:cursor-default disabled:bg-ink/80 disabled:hover:bg-ink/80"
        )}
      >
        {starting ? (
          <>
            <LoaderCircleIcon
              aria-hidden="true"
              className="size-[15px] motion-safe:animate-pending-spin"
            />
            Starting…
          </>
        ) : (
          <>
            {failed ? "Try again" : "Start a review"}
            <ArrowRightIcon
              aria-hidden="true"
              strokeWidth={1.75}
              className="size-[15px] transition-transform duration-nudge ease-ios-out group-hover/cta:translate-x-(--nv-offset-nudge) motion-reduce:transition-none"
            />
          </>
        )}
      </button>
      <AnimatePresence>
        {failed && (
          <motion.p
            key="error"
            role="alert"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: REDUCED_TRANSITION }}
            transition={reduce ? REDUCED_TRANSITION : SPRING.snappy}
            className="m-0 text-[12.5px] leading-[18px] text-req-fg"
          >
            {state.message}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  )
}
