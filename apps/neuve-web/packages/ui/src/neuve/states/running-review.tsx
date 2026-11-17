/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD — "Start a review" while it runs
 *
 *    0ms   the page swaps from the button to this state (content-fade
 *          160ms, the empty page's own entrance)
 *  loop    the working stage's three dots pulse 0.3 → 1 → 0.3, 180ms
 *          apart (working 1100ms, ease-in-out), as a thread card's
 *          "is working" row does
 *    0ms   a later stage records a part: an earlier stage's dots leave
 *          (reduced 150ms fade), the check pops in, opacity 0 → 1, scale
 *          .98 → 1 (snappy spring); the next stage's dots start. Find,
 *          Verify and Link overlap, so up to three show dots at once
 *  done    the batch arrives through the web events; the route swaps to
 *          the overview (content-fade)
 *
 * Reduced motion: the dots stay still at 60%; the check fades in 150ms.
 * ───────────────────────────────────────────────────────── */

import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { CheckIcon, GitCommitHorizontalIcon } from "lucide-react"

import {
  EASE,
  OPACITY,
  REDUCED_TRANSITION,
  SCALE,
  SPRING,
  TIMING,
  ms,
} from "@workspace/ui/lib/motion"
import { cn } from "@workspace/ui/lib/utils"
import { EmptyPage } from "@workspace/ui/neuve/states/empty-page"
import { stageStates } from "@workspace/ui/neuve/states/review-start"
import type {
  ReviewStage,
  RunningReview,
  StageState,
} from "@workspace/ui/neuve/states/review-start"

/** The stages' names as the pipeline gives them (`Stage` in the harness's budget.ts). */
const STAGE_LABEL: Record<ReviewStage, string> = {
  precompute: "Precompute",
  frame: "Frame",
  map: "Map",
  find: "Find",
  verify: "Verify",
  link: "Link",
  publish: "Publish",
}

const DOTS = {
  stagger: ms(TIMING.workingStagger),
  low: OPACITY.workingLow,
  loop: { duration: ms(TIMING.working), ease: EASE.inOut },
} as const

/** The thread card's "working" dots (review-desk/thread-card.tsx), in the stage's marker slot. */
function WorkingDots() {
  const reduce = useReducedMotion()
  return (
    <span aria-hidden="true" className="inline-flex gap-[3px]">
      {[0, 1, 2].map((i) =>
        reduce ? (
          <span key={i} className="size-[5px] rounded-full bg-agt-fg/60" />
        ) : (
          <motion.span
            key={i}
            className="size-[5px] rounded-full bg-agt-fg"
            animate={{ opacity: [DOTS.low, 1, DOTS.low] }}
            transition={{
              ...DOTS.loop,
              repeat: Infinity,
              delay: i * DOTS.stagger,
            }}
          />
        )
      )}
    </span>
  )
}

function StageMarker({ state }: { state: StageState }) {
  const reduce = useReducedMotion()
  return (
    <AnimatePresence mode="wait" initial={false}>
      {state === "done" ? (
        <motion.span
          key="done"
          initial={reduce ? { opacity: 0 } : { opacity: 0, scale: SCALE.enter }}
          animate={{ opacity: 1, scale: 1 }}
          transition={reduce ? REDUCED_TRANSITION : SPRING.snappy}
          className="flex"
        >
          <CheckIcon
            aria-hidden="true"
            strokeWidth={2}
            className="size-3.5 text-agt-fg"
          />
        </motion.span>
      ) : state === "current" ? (
        <motion.span
          key="current"
          exit={{ opacity: 0, transition: REDUCED_TRANSITION }}
          className="flex"
        >
          <WorkingDots />
        </motion.span>
      ) : (
        <span key="pending" aria-hidden="true">
          ·
        </span>
      )}
    </AnimatePresence>
  )
}

/**
 * The stages in order: done, those working, and those still to come. Several
 * can work at once; the earliest of them is the list's current step.
 */
export function StageList({ run }: { run: RunningReview }) {
  const states = stageStates(run)
  const step = states.findIndex((entry) => entry.state === "current")
  return (
    <ol
      aria-label="Review stages"
      className="m-0 inline-flex list-none flex-col gap-1 p-0 text-left"
    >
      {states.map(({ stage, state }, index) => (
        <li
          key={stage}
          aria-current={index === step ? "step" : undefined}
          className={cn(
            "grid grid-cols-[24px_auto] items-center gap-2 font-mono text-[12px] leading-[18px]",
            state === "pending" ? "text-ink-muted" : "text-ink-2",
            state === "current" && "text-ink"
          )}
        >
          <span className="flex justify-center">
            <StageMarker state={state} />
          </span>
          <span>
            {STAGE_LABEL[stage]}
            {state !== "pending" && (
              <span className="sr-only">
                {state === "done" ? ", done" : ", working"}
              </span>
            )}
          </span>
        </li>
      ))}
    </ol>
  )
}

/** The worker's sentence with each `command` in it set as code. */
function WithCommands({ text }: { text: string }) {
  return text.split("`").map((part, index) =>
    index % 2 === 1 ? (
      <code key={index} translate="no">
        {part}
      </code>
    ) : (
      part
    )
  )
}

/** One line on where the review is; the held line keeps the CLI's own words (10.17). */
function PhaseLine({ run }: { run: RunningReview }) {
  const { phase } = run
  switch (phase.kind) {
    case "queued":
      return <>Queued. The worker picks it up next.</>
    case "no-worker":
      return (
        <>
          Queued for <code translate="no">{run.route}</code>. Start a worker
          from a shell with its sign-in:{" "}
          <code translate="no">neuve worker start</code>
        </>
      )
    case "held":
      return phase.account ? (
        <>
          The running worker holds this job for{" "}
          <code translate="no">{phase.route}</code>.{" "}
          <WithCommands text={phase.credential} />.
        </>
      ) : (
        <>
          The running worker lacks {phase.credential} for{" "}
          <code translate="no">{phase.route}</code>, so it holds this job; a
          worker that has it picks it up.
        </>
      )
    case "working":
      return <>The batch opens here when it’s ready.</>
  }
}

/** "Find", "Find and Verify", "Find, Verify and Link". */
const listed = (names: ReadonlyArray<string>) =>
  names.length < 2
    ? names.join("")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`

/** What a screen reader hears when the phase or the working stages change. */
function announcement(run: RunningReview): string {
  if (run.phase.kind === "working") {
    // Publish records once, when publishing has ended: the batch opens next.
    if (run.recorded.includes("publish")) return "Opening the batch"
    const working = stageStates(run)
      .filter((entry) => entry.state === "current")
      .map((entry) => STAGE_LABEL[entry.stage])
    return `${listed(working)} ${working.length > 1 ? "are" : "is"} working`
  }
  if (run.phase.kind === "held") return "Waiting for a worker with the sign-in"
  if (run.phase.kind === "no-worker") return "Queued, no worker is running"
  return "Queued"
}

/** A branch name kept to one heading line's worth; the rest is cut with an ellipsis. */
const SUBJECT_MAX = 48
const shortSubject = (subject: string) =>
  subject.length > SUBJECT_MAX
    ? `${subject.slice(0, SUBJECT_MAX - 1)}…`
    : subject

/**
 * The empty overview while a requested review runs (ST3): the subject, one
 * line on where it is, and its stages ticking in. The batch replaces it
 * through the web events once the review publishes.
 */
export function RunningReviewEmpty({
  run,
  focusTitle,
}: {
  run: RunningReview
  /** The reader just pressed "Start a review": the heading takes focus. */
  focusTitle?: boolean
}) {
  return (
    <EmptyPage
      focusTitle={focusTitle}
      icon={GitCommitHorizontalIcon}
      title={`Reviewing ${shortSubject(run.subject)}`}
      actionSlot={
        <>
          <StageList run={run} />
          <p role="status" className="sr-only">
            {announcement(run)}
          </p>
        </>
      }
    >
      <PhaseLine run={run} />
    </EmptyPage>
  )
}
