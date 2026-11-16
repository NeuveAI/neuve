/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD — New-commit notice (Cycle.dc.html)
 *
 *    0ms   a Git event arrives: the dark notice drops in at the top of the
 *          unit column, y -12 → 0, scale .98 → 1, opacity 0 → 1
 *          (notice 360ms, emphasized decelerate)
 *  Later   the notice leaves (noticeExit 160ms, accelerate) and shrinks to
 *          the corner pill, which fades and scales .96 → 1 (snappy spring)
 *  pill    click reopens the lineage ("What changed")
 *
 * The diff under review never moves: the notice floats over the column.
 * Reduced motion: opacity-only 150ms.
 * ───────────────────────────────────────────────────────── */

import { useEffect, useRef } from "react"
import { useAtomValue, useSetAtom } from "jotai"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { GitCommitHorizontalIcon } from "lucide-react"

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
import { NeuveLink, useNeuveMode } from "@workspace/ui/neuve/shared/nav-link"
import { noticeAtom } from "@workspace/ui/neuve/review-desk/atoms"
import { regionTransition } from "@workspace/ui/neuve/shared/view-transitions"
import type { NewCommitEvent } from "@workspace/ui/neuve/types"

const NOTICE = {
  offsetY: -OFFSET.notice,
  initialScale: SCALE.enter,
  enter: { duration: ms(TIMING.notice), ease: EASE.emphasizedDecelerate },
  exit: { duration: ms(TIMING.noticeExit), ease: EASE.emphasizedAccelerate },
} as const

/**
 * A branch-ref observation or an explicit new-commit event. A ref change
 * alone does not establish commit ancestry or creation. "What changed"
 * opens the lineage, "Later" parks it as a corner pill. (Commits made inside
 * an agent's inner loop show as thread activity instead.)
 */
export function NewCommitNotice({ event }: { event: NewCommitEvent }) {
  const notice = useAtomValue(noticeAtom)
  const setNotice = useSetAtom(noticeAtom)
  const reduce = useReducedMotion()
  const mode = useNeuveMode()
  const changes = {
    to: "changes",
    commit: event.commit,
    ...(mode === "live" ? { fromRevisionId: event.reviewing } : {}),
  } as const
  const previous = useRef(event.commit)
  // Effect: synchronizes the external notice store when a new backend branch observation arrives.
  useEffect(() => {
    if (previous.current !== event.commit) {
      previous.current = event.commit
      setNotice("shown")
    }
  }, [event.commit, setNotice])
  const heading =
    event.kind === "branch-moved" ? "Branch now points to" : "New commit"
  const assessment =
    event.needYou === null
      ? "Review assessment pending"
      : `${event.needYou} units need you`

  return (
    <>
      <div
        {...regionTransition("desk-notice", 3)}
        className="pointer-events-none absolute inset-x-0 top-4 z-30 flex justify-center px-4"
      >
        <AnimatePresence>
          {notice === "shown" && (
            <motion.div
              key="notice"
              role="status"
              aria-label={`${heading} ${event.commit}`}
              initial={
                reduce
                  ? { opacity: 0 }
                  : {
                      opacity: 0,
                      y: NOTICE.offsetY,
                      scale: NOTICE.initialScale,
                    }
              }
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={
                reduce
                  ? { opacity: 0, transition: REDUCED_TRANSITION }
                  : {
                      opacity: 0,
                      y: NOTICE.offsetY / 2,
                      scale: NOTICE.initialScale,
                      transition: NOTICE.exit,
                    }
              }
              transition={reduce ? REDUCED_TRANSITION : NOTICE.enter}
              data-surface="inverse"
              className="pointer-events-auto box-border flex w-[min(520px,100%)] items-center gap-2.5 rounded-[14px] bg-dock py-1.5 pr-1.5 pl-3.5 text-dock-fg shadow-dock"
            >
              <GitCommitHorizontalIcon
                aria-hidden="true"
                className="size-[15px] shrink-0 text-brand"
              />
              <span className="flex min-w-0 flex-auto flex-col">
                <span className="text-[13.5px] font-semibold">
                  {heading}{" "}
                  <span className="font-mono text-[12.5px]">
                    {event.commit.slice(0, 8)}
                  </span>
                </span>
                <span className="truncate text-xs text-dock-muted">
                  {assessment} · your review stays on{" "}
                  {event.reviewing.slice(0, 8)}
                </span>
              </span>
              <Button
                type="button"
                variant="dock-ghost"
                size="dock"
                onClick={() => setNotice("parked")}
              >
                Later
              </Button>
              <Button variant="dock-primary" size="dock" asChild>
                <NeuveLink
                  destination={changes}
                  onClick={() => setNotice("parked")}
                >
                  What changed
                </NeuveLink>
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <AnimatePresence>
        {notice === "parked" && (
          <motion.div
            key="pill"
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: SCALE.pop }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, transition: REDUCED_TRANSITION }}
            transition={reduce ? REDUCED_TRANSITION : SPRING.snappy}
            style={{ transformOrigin: "top right" }}
            className="absolute top-4 right-6 z-30"
          >
            <NeuveLink
              destination={changes}
              aria-label={`${heading} ${event.commit}: ${assessment}. What changed`}
              className="inline-flex h-8 items-center gap-2 rounded-2xl bg-raised-2 px-3 text-[12.5px] text-ink no-underline shadow-[0_0_0_2px_var(--nv-bg)] transition-colors duration-surface-tone ease-standard hover:bg-raised hover:text-ink motion-reduce:transition-none"
            >
              <span
                aria-hidden="true"
                className="size-1.5 rounded-full bg-brand"
              />
              <span className="font-mono text-[11.5px]">
                {event.commit.slice(0, 8)}
              </span>
              ·{" "}
              {event.needYou === null
                ? "Assessment pending"
                : `${event.needYou} need you`}
            </NeuveLink>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
