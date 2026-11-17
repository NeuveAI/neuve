import { Effect, Option } from "effect"
import { JobQueue, Log, ReviewProgress, Worker } from "@neuve/records-core"
import type { StoreLocation } from "@neuve/records-core"
import { heldForAccount, readHeldReviews } from "@neuve/harness/held-reviews"
import { settingsRoute } from "@neuve/harness/request"
import { REVIEW_STAGES } from "@workspace/ui/neuve/states/review-start"
import type {
  ReviewStage,
  ReviewStart,
  ReviewStartPreview,
  RunningPhase,
} from "@workspace/ui/neuve/states/review-start"

import { NoStore, readRecords, repository } from "./records.server"
import { requestFromWeb } from "./review-request.server"

/**
 * "Start a review" on the empty overview (M5 ST1–ST4, 10.103). Before the
 * press the overview shows what it will review and on which route (ST2): a
 * feature branch against its base, or the branch the repository works on
 * directly (main) against its remote-tracking copy (origin/main). The press
 * relays to the harness's request through its subpath as the person git
 * names (ST1, `requestFromWeb`), then wakes a worker that is already running.
 * It never starts one: the owner starts the worker from a shell that holds
 * the route's sign-in (ST4), and the running state says when none runs or
 * when the running one lacks the sign-in (ST3).
 */

/* ── What the press reviews (ST2, 10.103) ──────────────────── */

const git = async (at: string, args: ReadonlyArray<string>) => {
  const child = Bun.spawn(["git", "-C", at, ...args], {
    stdout: "pipe",
    stderr: "ignore",
  })
  const [out, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ])
  return code === 0 ? out.trim() : undefined
}

const exists = async (at: string, ref: string) =>
  (await git(at, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) !==
  undefined

/** The route the request freezes (the user's settings, 10.85), as `provider/model`. */
const routeName = () => {
  const route = settingsRoute()
  return `${route.provider}/${route.model}`
}

/**
 * What the checked-out branch is reviewed against. The branch the repository
 * works on directly (the remote's default branch, else `main` or `master`)
 * is reviewed against its remote-tracking copy: its upstream, else
 * `origin/<branch>`. Any other branch is reviewed against that default
 * branch, its local copy first.
 */
async function baseOf(
  at: string,
  branch: string
): Promise<{ base: string } | { refused: string }> {
  const named = await git(at, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  ])
  // An origin/HEAD left pointing at a default branch the remote renamed names nothing.
  const remoteDefault =
    named !== undefined && (await exists(at, named)) ? named : undefined
  const defaultName = remoteDefault?.replace(/^origin\//, "")
  const direct =
    defaultName === undefined
      ? branch === "main" || branch === "master"
      : branch === defaultName
  if (direct) {
    const upstream = await git(at, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      `${branch}@{upstream}`,
    ])
    for (const candidate of [upstream, `origin/${branch}`])
      if (candidate !== undefined && (await exists(at, candidate)))
        return { base: candidate }
    return {
      refused: `${branch} has no remote-tracking copy to compare with. Push it once, or check out a feature branch.`,
    }
  }
  const candidates = [defaultName, remoteDefault, "main", "master"].filter(
    (name): name is string => name !== undefined && name !== branch
  )
  for (const candidate of new Set(candidates))
    if (await exists(at, candidate)) return { base: candidate }
  return {
    refused: `${branch} has no base branch to compare with (main or master).`,
  }
}

type Preview =
  | { status: "ready"; preview: ReviewStartPreview }
  | { status: "refused"; message: string }

/** What the press would review now, or why there is nothing to review. */
export async function branchPreview(): Promise<Preview> {
  const at = repository()
  const branch = await git(at, ["symbolic-ref", "--quiet", "--short", "HEAD"])
  if (branch === undefined)
    return {
      status: "refused",
      message: "HEAD is detached. Check out a branch to review it.",
    }
  const headOid = await git(at, ["rev-parse", "--verify", "--quiet", "HEAD"])
  if (headOid === undefined)
    return { status: "refused", message: `${branch} has no commits yet.` }
  const found = await baseOf(at, branch)
  if ("refused" in found) return { status: "refused", message: found.refused }
  const { base } = found
  const mergeBase = await git(at, ["merge-base", base, headOid])
  if (mergeBase === undefined)
    return {
      status: "refused",
      message: `${branch} shares no history with ${base}.`,
    }
  const ahead = Number(
    (await git(at, ["rev-list", "--count", `${mergeBase}..${headOid}`])) ?? 0
  )
  if (ahead === 0)
    return {
      status: "refused",
      message: `${branch} has nothing ahead of ${base}. Commit to it or check out another branch.`,
    }
  return {
    status: "ready",
    preview: { branch, base, headOid, mergeBase, ahead, route: routeName() },
  }
}

/* ── The running state (ST3) ───────────────────────────────── */

/** A worker answers on the repository's socket. */
const workerLive = (location: StoreLocation) =>
  Effect.gen(function* () {
    const { reach } = yield* Worker.reachStoreWorker(
      location,
      undefined,
      "500 millis"
    )
    return Worker.isLive(reach)
  }).pipe(Effect.orElseSucceed(() => false))

interface Found {
  readonly running?: {
    readonly headOid: string
    readonly route: string
    readonly phase: RunningPhase
    readonly recorded: Array<ReviewStage>
  }
  /** The newest review job failed, with its reason. */
  readonly failure?: string
}

/** The newest review job (records-core reads it newest first), and where its run is. */
const newestJob = (location: StoreLocation) =>
  Effect.gen(function* () {
    const newest = yield* ReviewProgress.newestReviewJob
    if (Option.isNone(newest)) return {} satisfies Found
    const queue = yield* JobQueue.JobQueue
    const job = Option.getOrUndefined(yield* queue.inspect(newest.value))
    if (job === undefined) return {} satisfies Found
    if (job.state === "failed")
      return {
        failure: `The last review failed: ${job.lastError?.message ?? "no reason recorded"}`,
      } satisfies Found
    if (job.state === "completed" || job.eventId === null)
      return {} satisfies Found
    const request = Option.getOrUndefined(yield* Log.get(job.eventId))?.event
    if (request?.kind !== "review.requested@1") return {} satisfies Found
    const stages = yield* ReviewProgress.stageCompletions(job.eventId)
    const recorded = REVIEW_STAGES.filter((stage) =>
      stages.some((entry) => entry.stage === stage)
    )
    const frozen = request.payload.pipeline.config as {
      route?: { provider?: unknown; model?: unknown }
    }
    const route =
      typeof frozen.route?.provider === "string" &&
      typeof frozen.route.model === "string"
        ? `${frozen.route.provider}/${frozen.route.model}`
        : "the route it froze"
    let phase: RunningPhase
    if (job.state === "active") phase = { kind: "working" }
    else {
      const claim = Option.getOrUndefined(yield* Worker.readClaim)
      const held = readHeldReviews(location).find(
        (entry) => entry.seq === job.seq && entry.pid === claim?.pid
      )
      if (held !== undefined)
        phase = {
          kind: "held",
          credential: held.credential,
          route: held.route,
          ...(heldForAccount(held) ? { account: true as const } : {}),
        }
      else
        phase = (yield* workerLive(location))
          ? { kind: "queued" }
          : { kind: "no-worker" }
    }
    return {
      running: {
        headOid: request.attribution.range.headOid,
        route,
        phase,
        recorded,
      },
    } satisfies Found
  }).pipe(Effect.provide(JobQueue.layer))

/** What the empty overview shows for "Start a review". */
export async function reviewStart(): Promise<ReviewStart> {
  let found: Found = {}
  try {
    found = await readRecords("web.start.read", newestJob)
  } catch (error) {
    if (!(error instanceof NoStore)) throw error
  }
  const preview = await branchPreview()
  if (found.running !== undefined) {
    const { headOid, route, phase, recorded } = found.running
    const subject =
      preview.status === "ready" && preview.preview.headOid === headOid
        ? preview.preview.branch
        : headOid.slice(0, 7)
    return { status: "running", run: { subject, route, phase, recorded } }
  }
  if (preview.status === "refused") return preview
  return {
    status: "ready",
    preview: preview.preview,
    ...(found.failure === undefined ? {} : { failure: found.failure }),
  }
}

/* ── The press (ST1, ST4) ──────────────────────────────────── */

/**
 * Requests the review of the shown range (its merge base to its head) as the
 * person git names, then wakes the running worker, if any. Refuses when
 * there is nothing to review, or when the head or the merge base moved
 * since the overview showed them.
 */
export async function startReview(shown: { head: string; mergeBase: string }) {
  const now = await branchPreview()
  if (now.status === "refused") throw new Error(now.message)
  const { branch, headOid, mergeBase } = now.preview
  if (headOid !== shown.head || mergeBase !== shown.mergeBase)
    throw new Error(`${branch} moved since it was shown. Check it again.`)
  const request = await requestFromWeb(`${mergeBase}..${headOid}`)
  await readRecords("web.start.wake", (location) =>
    Effect.gen(function* () {
      yield* Worker.reachStoreWorker(location, "wake", "500 millis")
    }).pipe(Effect.ignore)
  )
  return { cycleId: request.cycleId, openedCycle: request.openedCycle }
}
