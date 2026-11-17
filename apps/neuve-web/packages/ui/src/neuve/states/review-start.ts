/*
 * "Start a review" on the empty batch overview (M5 ST1–ST4): what the host
 * loads before the reader presses it, and the running state it shows while
 * the requested review works. The BFF fills these from git and Records; the
 * mock pages and stories pass fixtures.
 */

/**
 * The pipeline's stages, in receipt order: the fixed review shape's `Stage`
 * in `packages/harness/src/budget.ts` (12.41). The web app does not import
 * the harness for this; a test in `apps/web` keeps the two lists equal.
 */
export const REVIEW_STAGES = [
  "precompute",
  "frame",
  "map",
  "find",
  "verify",
  "link",
  "publish",
] as const

export type ReviewStage = (typeof REVIEW_STAGES)[number]

/**
 * What the press will review, shown before it starts (ST2, 10.103): a feature
 * branch against its base, or the branch the repository works on directly
 * (main) against its remote-tracking copy (origin/main).
 */
export interface ReviewStartPreview {
  branch: string
  /** `main` for a feature branch; `origin/main` on main itself. */
  base: string
  /** The range the request will name; the start refuses when either moved. */
  headOid: string
  mergeBase: string
  /** Commits on the branch past the merge base. */
  ahead: number
  /** The route the request freezes, as `provider/model`. */
  route: string
}

/** Where a requested review is (ST3, ST4). */
export type RunningPhase =
  /** Waiting for the running worker to pick it up. */
  | { kind: "queued" }
  /** No worker is running for this repository. */
  | { kind: "no-worker" }
  /**
   * The running worker lacks the route's sign-in and holds the job (10.17).
   * `account` is set for a Claude Code route: `credential` is then the
   * worker's own sentence on the account's state and the command that fixes
   * it, shown whole.
   */
  | { kind: "held"; credential: string; route: string; account?: true }
  /** A worker runs it; its stages complete one by one. */
  | { kind: "working" }

export interface RunningReview {
  /** The branch under review, or the head's short id when no branch points at it. */
  subject: string
  phase: RunningPhase
  /** The route the request froze, as `provider/model`. */
  route: string
  /**
   * Stages with at least one recorded completion (Records' stage telemetry).
   * A stage records its work in parts, so this is not the stages done.
   */
  recorded: Array<ReviewStage>
}

export type ReviewStart =
  | {
      status: "ready"
      preview: ReviewStartPreview
      /** The newest review of this repository failed: the button opens in its failed state. */
      failure?: string
    }
  /** Nothing to start from here (detached head, no base, nothing ahead). */
  | { status: "refused"; message: string }
  | { status: "running"; run: RunningReview }

export type StageState = "done" | "current" | "pending"

const at = (stage: ReviewStage) => REVIEW_STAGES.indexOf(stage)

/** The stages that run one after another, before the finders. */
const IN_TURN: ReadonlyArray<ReviewStage> = ["precompute", "frame", "map"]

/**
 * Each stage's state, from nothing but the names of the stages with at least
 * one recorded completion (Records' `stage.completed@1`). It never shows a
 * stage done while it still works, nor a stage working before it has work.
 *
 * What it rests on. Every stage records its work in parts, one completion
 * per agent or code step (Precompute's coverage and facts, Frame's
 * scope-change judges and the frame, Map's manifest and map, one Find per
 * lens, one Verify per finding, Link's fill and its link, one Publish per
 * run, written when the run's publisher ends), so one completion never
 * finishes a stage. The orders below were measured on 12 November 2026 over
 * the `stage.completed@1` events of 250 runs of today's pipeline in the pi
 * worktree's Records:
 *
 * - Precompute, Frame and Map run in turn: no stage's completion came before
 *   the last of the stage before it. Each is done once a later stage has a
 *   completion; the latest of them with one works.
 * - Link's fill runs beside the finders and records first, about a minute
 *   before any Find (249 of 250 runs). A Link with no Find or Verify means
 *   Map is done and only the finders work.
 * - Verify's first completion follows Find's first within a second (250 of
 *   250) and they overlap until the last finder ends, and Link's own step
 *   comes after both. Once Find or Verify has a completion, Find, Verify and
 *   Link all work.
 * - Publish's completion came after every Find, Verify and Link one (250 of
 *   250), so it means they are done. Publish itself is never shown done:
 *   the batch opening ends the list.
 *
 * Before the first completion Precompute works; before a worker takes the
 * job none does.
 */
export function stageStates(
  run: RunningReview
): Array<{ stage: ReviewStage; state: StageState }> {
  const has = (stage: ReviewStage) => run.recorded.includes(stage)
  // The latest of Precompute, Frame and Map with a completion, else Precompute.
  const inTurn = Math.max(0, ...IN_TURN.filter(has).map(at))
  // Stages before `from` are done; `from` through `to` work.
  const [from, to] = has("publish")
    ? [at("publish"), at("publish")]
    : has("find") || has("verify")
      ? [at("find"), at("link")]
      : has("link")
        ? [at("find"), at("find")]
        : [inTurn, inTurn]
  const working = run.phase.kind === "working"
  return REVIEW_STAGES.map((stage, index) => ({
    stage,
    state:
      index < from ? "done" : working && index <= to ? "current" : "pending",
  }))
}
