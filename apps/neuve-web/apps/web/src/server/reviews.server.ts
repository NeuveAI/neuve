import { Effect } from "effect"
import {
  Dispositions,
  Lineage,
  Log,
  PublishedPackets,
  ReviewList,
} from "@neuve/records-core"
import type {
  ReviewBatch,
  ReviewGateMark,
  ReviewHumanLane,
  ReviewLane,
  ReviewSummary,
  ReviewsData,
  ReviewsFilter,
  ReviewsLoad,
} from "@workspace/ui/neuve/types"

import { successorOf } from "./desk.server"
import type { OpensCache } from "./desk.server"
import { repositoryName } from "./git-source.server"
import { LANE_FACTS } from "./lane-facts"
import type { LaneFacts } from "./lane-facts"
import { ancestryOf, rangeEnds, rangePatchesOf } from "./range-done.server"
import type { RangeEnd } from "./range-done.server"
import { NoStore, readRecords, repository } from "./records.server"

/**
 * The Reviews page's load (`/`): every review of the repository, newest run
 * first, ten to a page, through records-core's `ReviewList`. What waits on
 * a person, and the "Waiting on you" filter, are counted over the newest
 * `WAITING_CAP` reviews in one read; its span says how many it read, so we
 * see when a store-wide count is worth building.
 *
 * A unit waits on a person while Records' closure rule
 * (`Dispositions.judgeDispositions`) still needs a person's act on it: a
 * human-required unit until a person decides it (a carried decision
 * included), a human-suggested one until anyone does, the agent's
 * disposition included. A unit no agent read (a lockfile or a generated
 * file, as the overview reads it) never waits. Nor does a unit a later
 * review took over: the desk's `successorOf`, with the "Newer review"
 * link's `laterThan`, leads from it to a unit that opens, which counts in
 * its own review instead. Nor does any unit of a review a later published
 * review's range holds (`replacedOf`): that review reviewed the same
 * changes, so only the newest review per branch counts (14.33). A review
 * whose every human unit is taken over is older: its row asks for nothing
 * and says a newer review replaced it. The BFF decides nothing: Records says
 * each review's state, lanes, lineage and dispositions, and git says how
 * the ranges relate and whether one landed.
 *
 * "Waiting on you", the default list, holds the reviews with a unit that
 * waits, landed ones only while a human-required unit waits
 * (`listedByDefault`), human-required work first (`defaultListOf`). The
 * header's counts and "Open next" count over it. A cycle's own address
 * (`cycle`) lists that one review, wherever it stands.
 */

export const PAGE_SIZE = 10
export const WAITING_CAP = ReviewList.LIMIT_MAX

type Listed = ReviewList.ListedReview
type RecordedLane = ReviewList.ListedUnit["lane"]
type Verdict = "approve" | "request-changes"

const LANE: Record<NonNullable<RecordedLane>, ReviewLane> = {
  "static-automation": "static-automation",
  agentic: "agentic-review",
  "human-suggested": "human-suggested",
  "human-required": "human-required",
}

export const LANE_ORDER: ReadonlyArray<ReviewLane> = [
  "human-required",
  "human-suggested",
  "agentic-review",
  "static-automation",
]

/** A unit the review never assessed reads as human-suggested (10.100). */
export const laneOf = (lane: RecordedLane) =>
  lane === null ? "human-suggested" : LANE[lane]

const short = (oid: string) => oid.slice(0, 7)

/** A commit's subject line, the title a review reads by (`summaryOf`). */
const subjectOf = async (at: string, oid: string) => {
  const child = Bun.spawn(
    ["git", "-C", at, "log", "-1", "--format=%s", oid, "--"],
    { stdin: "ignore", stdout: "pipe", stderr: "ignore" }
  )
  const [out, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ])
  return code === 0 ? out.trim() : ""
}

/** What Records says of the listed reviews' units, read once per load. */
export interface UnitStanding {
  /**
   * Units whose work a later review holds: lineage leads to a unit that
   * opens, or a later review's range holds their review's (`replacedOf`).
   */
  readonly takenOver: ReadonlySet<string>
  /** Human units Records' judgement closes, with the verdict that stands. */
  readonly decided: ReadonlyMap<string, Verdict>
  /** Units no agent read: a lockfile or a generated file. */
  readonly notRead: ReadonlySet<string>
}

export const NO_STANDING: UnitStanding = {
  takenOver: new Set(),
  decided: new Map(),
  notRead: new Set(),
}

export const markOf = (
  standing: UnitStanding,
  unitId: string
): ReviewGateMark => {
  const verdict = standing.decided.get(unitId)
  if (verdict === "approve") return "approved"
  if (verdict === "request-changes") return "changes-requested"
  return "waiting"
}

/** The lane a unit is a person's to decide in, if it is: an unassessed unit is human-suggested. */
const humanLane = (
  unit: ReviewList.ListedUnit
): ReviewHumanLane | undefined => {
  const lane = laneOf(unit.lane)
  return lane === "human-required" || lane === "human-suggested"
    ? lane
    : undefined
}

/** A human unit this review asks about: not taken over, and read by an agent. */
export const asks = (standing: UnitStanding) => (unit: ReviewList.ListedUnit) =>
  humanLane(unit) !== undefined &&
  !standing.takenOver.has(unit.unitId) &&
  !standing.notRead.has(unit.unitId)

const units = (review: Listed) => review.batches.flatMap((batch) => batch.units)

const askedUnits = (review: Listed, standing: UnitStanding) =>
  units(review).filter(asks(standing))

const waitingUnits = (review: Listed, standing: UnitStanding) =>
  askedUnits(review, standing).filter(
    (unit) => markOf(standing, unit.unitId) === "waiting"
  )

const requiredWaiting = (review: Listed, standing: UnitStanding) =>
  waitingUnits(review, standing).filter(
    (unit) => laneOf(unit.lane) === "human-required"
  )

/**
 * The unit a desk opens on among `candidates` (a review's units, or a
 * batch's): the first human-required unit that waits, else the first unit
 * that waits. A caller with nothing waiting opens the first unit.
 */
export const entryUnitOf = (
  candidates: ReadonlyArray<ReviewList.ListedUnit>,
  standing: UnitStanding
) => {
  const waiting = candidates.filter(
    (unit) =>
      asks(standing)(unit) && markOf(standing, unit.unitId) === "waiting"
  )
  return (
    waiting.find((unit) => laneOf(unit.lane) === "human-required") ?? waiting[0]
  )?.unitId
}

/** A review that published every batch: it holds what it reviewed. */
const wholeOf = (review: Listed, facts: LaneFacts = LANE_FACTS) =>
  review.batches.length > 0 && facts.listedPendingBatches(review) === 0

/**
 * The gone reviews (`ends`) a later whole review carries: every commit of
 * the gone range has a commit of the later range with the same patch-id,
 * git's rebase equivalence (`git cherry`). A rebased pull request reviewed
 * again counts once. A gone review with a commit no later review carries
 * stays.
 */
export const rebasedOf = (
  reviews: ReadonlyArray<Listed>,
  ends: ReadonlyMap<string, RangeEnd>,
  patchesOf: (review: Listed) => ReadonlyArray<string> | undefined,
  facts: LaneFacts = LANE_FACTS
): ReadonlySet<string> =>
  new Set(
    reviews
      .filter((earlier) => {
        if (ends.get(earlier.cycleId) !== "gone") return false
        const own = patchesOf(earlier) ?? []
        if (own.length === 0) return false
        return reviews.some((later) => {
          if (later.cycleId <= earlier.cycleId || !wholeOf(later, facts))
            return false
          const carried = new Set(patchesOf(later) ?? [])
          return own.every((patch) => carried.has(patch))
        })
      })
      .map((review) => review.cycleId)
  )

/**
 * The reviews a later review replaces: one opened later, with every batch
 * published, whose base is at or before the earlier base and whose head is
 * at or past the earlier head. It reviewed the same changes, and decisions
 * carry to the units that didn't change (14.12). A later review that
 * published nothing, or stopped short of its batches, may not hold what the
 * earlier one asks.
 */
export const replacedOf = (
  reviews: ReadonlyArray<Listed>,
  descends: (ancestor: string, descendant: string) => boolean,
  facts: LaneFacts = LANE_FACTS
): ReadonlySet<string> =>
  new Set(
    reviews
      .filter((earlier) =>
        reviews.some(
          (later) =>
            later.cycleId > earlier.cycleId &&
            wholeOf(later, facts) &&
            descends(later.range.baseOid, earlier.range.baseOid) &&
            descends(earlier.range.headOid, later.range.headOid)
        )
      )
      .map((review) => review.cycleId)
  )

/**
 * Whether "Waiting on you" lists a review, given its units that wait
 * (14.33) and how its range ended. A review still open is listed while
 * anything of it waits; a landed or gone one (its commits rewritten, maybe
 * landed under new hashes) only while a human-required unit waits, since a
 * person still decides it.
 */
export const listedByDefault = (
  waiting: number,
  required: number,
  end: RangeEnd | undefined
) => (end === undefined ? waiting > 0 : required > 0)

/**
 * "Waiting on you": the reviews `listedByDefault` holds, newest run first
 * within each group: open reviews with a human-required unit that waits,
 * then landed or gone ones with one, then the rest.
 */
export const defaultListOf = (
  reviews: ReadonlyArray<Listed>,
  standing: UnitStanding,
  ends: ReadonlyMap<string, RangeEnd>
): ReadonlyArray<Listed> => {
  const rank = (review: Listed) => {
    if (requiredWaiting(review, standing).length === 0) return 2
    return ends.has(review.cycleId) ? 1 : 0
  }
  return reviews
    .filter((review) =>
      listedByDefault(
        waitingUnits(review, standing).length,
        requiredWaiting(review, standing).length,
        ends.get(review.cycleId)
      )
    )
    .map((review, index) => ({ review, index, rank: rank(review) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ review }) => review)
}

/**
 * What "Waiting on you" lists after a clear ("Clear"): the reviews run after
 * it. What waits on a person still counts every review, cleared or not.
 */
export const afterClear = (
  reviews: ReadonlyArray<Listed>,
  cleared: string | undefined
): ReadonlyArray<Listed> =>
  cleared === undefined
    ? reviews
    : reviews.filter((review) => Date.parse(review.at) > Date.parse(cleared))

/** Every human unit of the review is held by a later review: it asks for nothing. */
const isOlder = (review: Listed, standing: UnitStanding) => {
  const human = units(review).filter((unit) => humanLane(unit) !== undefined)
  return (
    human.length > 0 &&
    human.every((unit) => standing.takenOver.has(unit.unitId))
  )
}

/**
 * One review as the page shows it; `title` is its head commit's `subject`,
 * else its first batch's, else its range. Its batches are those its standing packet publishes: a batch
 * not published yet has no units in Records, so none of it is counted as
 * waiting on a person, only as pending. An older review (`isOlder`) shows
 * no square and no unit to decide: a newer review holds them.
 */
export const summaryOf = (
  review: Listed,
  /** Records' word on its units (`standingOf`). */
  standing: UnitStanding,
  feedback: ReadonlySet<string>,
  subject: string | undefined,
  facts: LaneFacts = LANE_FACTS
): ReviewSummary => {
  const pending = facts.listedPendingBatches(review)
  const older = isOlder(review, standing)
  const counts = new Map<ReviewLane, number>()
  for (const unit of units(review)) {
    const lane = laneOf(unit.lane)
    counts.set(lane, (counts.get(lane) ?? 0) + 1)
  }
  const batches: Array<ReviewBatch> = review.batches.map((batch, index) => ({
    id: batch.batchId,
    title: batch.title ?? `Batch ${index + 1}`,
    unitCount: batch.units.length,
    needYou: batch.units.filter(
      (unit) =>
        asks(standing)(unit) && markOf(standing, unit.unitId) === "waiting"
    ).length,
  }))
  return {
    id: review.cycleId,
    title:
      subject ||
      batches[0]?.title ||
      `${short(review.range.baseOid)}..${short(review.range.headOid)}`,
    range: `${short(review.range.baseOid)}..${short(review.range.headOid)}`,
    at: review.at,
    // The cycle's newest run's state: a follow-on run is a newer run, and a
    // review that stopped with batches unpublished says so by its pending
    // count, whatever the state.
    state: review.state,
    lanes: LANE_ORDER.flatMap((lane) => {
      const count = counts.get(lane) ?? 0
      return count > 0 ? [{ lane, count }] : []
    }),
    gate: askedUnits(review, standing).flatMap((unit) => {
      const lane = humanLane(unit)
      return lane ? [{ lane, mark: markOf(standing, unit.unitId) }] : []
    }),
    feedback: feedback.has(review.cycleId),
    batches,
    ...(pending > 0 ? { pendingBatches: pending } : {}),
    ...(older ? { newer: true as const } : {}),
  }
}

type PersonKinds = Map<string, boolean>

/** Whether `actorId` is a registered person, as `projection_actors` says (one read per actor). */
const isPerson = (actorId: string, known: PersonKinds) =>
  Effect.gen(function* () {
    const held = known.get(actorId)
    if (held !== undefined) return held
    const registered = (yield* Log.history({
      kind: "actor.registered@1",
      actorId,
      limit: 10,
    })).at(-1)?.event
    const person =
      registered?.kind === "actor.registered@1" &&
      registered.payload.actorKind === "human"
    known.set(actorId, person)
    return person
  })

/**
 * What Records says of `reviews`' human units:
 * - taken over: the desk's own `successorOf` with `laterThan` (the rule the
 *   "Newer review" link follows) for each human unit lineage names as an
 *   earlier unit (`Lineage.successorsMany`, one batched read), each later
 *   review's manifest and range read once for the whole load (`opensAt`'s
 *   cache);
 * - decided: Records' judgement (`judgeDispositions`) over each unit's
 *   dispositions in force, of any actor, carried ones included
 *   (`Dispositions.currentMany`, by unit ID through the index); a person's
 *   kind read once per actor;
 * - not read: M's `LANE_FACTS.excluded` on the standing packet, read only for
 *   a review with an assessed human-suggested unit nobody decided.
 */
export const standingOf = (
  reviews: ReadonlyArray<Listed>,
  facts: LaneFacts = LANE_FACTS,
  /** Reviews a later review's range holds (`replacedOf`): every unit of theirs is taken over. */
  replaced: ReadonlySet<string> = new Set()
) =>
  Effect.gen(function* () {
    // One shared cache: each later review's manifest and range read once.
    const cache: OpensCache = new Map()
    const taken = new Set<string>()
    // One batched lineage read: only a unit lineage names as an earlier one
    // can have a successor, so only those walk the desk's rule.
    const human = reviews.flatMap((review) =>
      units(review)
        .filter((unit) => humanLane(unit) !== undefined)
        .map((unit) => ({ review, unit }))
    )
    const named = yield* Lineage.successorsMany(
      human.map(({ unit }) => unit.unitId)
    )
    let walks = 0
    for (const { review, unit } of human) {
      if (replaced.has(review.cycleId)) {
        taken.add(unit.unitId)
        continue
      }
      if ((named.get(unit.unitId) ?? []).length === 0) continue
      walks += 1
      // The batched read already holds each listed unit's lineage: the
      // walk reads only units past them.
      const later = yield* successorOf(unit.unitId, {
        laterThan: review.cycleId,
        cache,
        successors: named,
      })
      if (later !== undefined) taken.add(unit.unitId)
    }
    const partial: UnitStanding = {
      takenOver: taken,
      decided: new Map(),
      notRead: new Set(),
    }
    const asked = reviews.flatMap((review) =>
      askedUnits(review, partial).map((unit) => ({
        review,
        unit,
      }))
    )
    // Each asked unit's dispositions in force, of any actor (Records'
    // `liveDisposition`), judged against its lane: a person's decision on
    // human-required work, anyone's on human-suggested work.
    const inForce = new Map<string, Array<Dispositions.JudgedDisposition>>()
    const people: PersonKinds = new Map()
    const cycleOf = new Map(
      asked.map(({ review, unit }) => [unit.unitId, review.cycleId])
    )
    for (const [unitId, rows] of yield* Dispositions.currentMany([
      ...cycleOf.keys(),
    ])) {
      const own: Array<Dispositions.JudgedDisposition> = []
      // A unit belongs to one review: only its rows there count.
      for (const row of rows)
        if (row.cycleId === cycleOf.get(unitId))
          own.push({
            ...row,
            actorKind: (yield* isPerson(row.actorId, people))
              ? "human"
              : "agent",
            beforeAssessment: true,
          })
      inForce.set(unitId, own)
    }
    const decided = new Map<string, Verdict>()
    for (const { review, unit } of asked) {
      const judgement = Dispositions.judgeDispositions(
        {
          unitId: unit.unitId,
          cycleId: review.cycleId,
          lane: unit.lane,
          assessmentEventId: null,
        },
        inForce.get(unit.unitId) ?? []
      )
      if (judgement.closed && judgement.standing)
        decided.set(unit.unitId, judgement.standing.verdict)
    }
    const suggested = asked.filter(
      ({ unit }) => humanLane(unit) === "human-suggested"
    )
    // Records' readers put a lockfile or a generated file in human-suggested
    // (`recordedLane`), assessed and with no disposition.
    const notRead = new Set<string>()
    const open = suggested.filter(
      ({ unit }) => unit.lane !== null && !decided.has(unit.unitId)
    )
    const openIds = new Set(open.map(({ unit }) => unit.unitId))
    const packetReads = new Set(open.map(({ review }) => review.cycleId))
    for (const cycleId of packetReads) {
      const packet = yield* PublishedPackets.readStanding(cycleId)
      for (const batch of packet?.batches ?? [])
        for (const unit of batch.units)
          if (openIds.has(unit.unitId) && facts.excluded(unit) !== undefined)
            notRead.add(unit.unitId)
    }
    // What this load read, so the span shows when a Records read that
    // answers all of it at once is worth building.
    yield* Effect.annotateCurrentSpan({
      "neuve.reviews.successor-walks": walks,
      "neuve.reviews.successor-reviews": cache.size,
      "neuve.reviews.asked-units": asked.length,
      "neuve.reviews.packet-reads": packetReads.size,
      "neuve.reviews.taken-over": taken.size,
      "neuve.reviews.replaced": replaced.size,
    })
    return { takenOver: taken, decided, notRead } satisfies UnitStanding
  }).pipe(Effect.withSpan("web.reviews.standing"))

/**
 * What waits on a person across `reviews`, in their order: the reviews with
 * a unit waiting, how many units, and the unit "Open next" opens, the first
 * human-required unit that waits before any other.
 */
export const waitingOf = (
  reviews: ReadonlyArray<Listed>,
  standing: UnitStanding
) => {
  const waiting = reviews.filter(
    (review) => waitingUnits(review, standing).length > 0
  )
  const required = waiting.find(
    (review) => requiredWaiting(review, standing).length > 0
  )
  const next = required ?? waiting.at(0)
  return {
    waiting,
    units: waiting.reduce(
      (sum, review) => sum + waitingUnits(review, standing).length,
      0
    ),
    nextUnitId: next ? entryUnitOf(units(next), standing) : undefined,
  }
}

/** Records' word on `reviews`' units, and where anyone gave feedback. */
const answers = (
  reviews: ReadonlyArray<Listed>,
  replaced?: ReadonlySet<string>
) =>
  Effect.gen(function* () {
    return {
      standing: yield* standingOf(reviews, LANE_FACTS, replaced),
      feedback: yield* ReviewList.feedbackGiven(
        reviews.map((review) => review.cycleId)
      ),
    }
  })

/**
 * The page the Reviews load reads, with what it read it from: the page's
 * reviews as Records lists them and Records' word on their units, for a
 * page that shows more of each review (the home page's batches).
 */
export type ReviewsRead =
  | { readonly status: "empty" }
  | {
      readonly status: "ready"
      readonly data: ReviewsData
      readonly onPage: ReadonlyArray<Listed>
      readonly standing: UnitStanding
    }

export async function reviewsLoad(options: {
  readonly page: number
  readonly filter: ReviewsFilter
}): Promise<ReviewsLoad> {
  const read = await reviewsRead(options)
  return read.status === "empty" ? read : { status: "ready", data: read.data }
}

/** Git's word, or none when git can't say: nothing replaced, nothing ended. */
export const orNone = <A>(read: Promise<A>, none: A, what: string) =>
  read.catch((error: unknown) => {
    console.warn(`the Reviews load could not read ${what} from git`, error)
    return none
  })

export async function reviewsRead(options: {
  readonly page: number
  readonly filter: ReviewsFilter
  /** A cycle's own address: that one review, wherever it stands. */
  readonly cycle?: string | undefined
}): Promise<ReviewsRead> {
  const at = repository()
  const read = await readRecords("web.load.reviews", () =>
    Effect.gen(function* () {
      const recent = yield* ReviewList.reviews({ limit: WAITING_CAP }).pipe(
        Effect.tap((page) =>
          Effect.annotateCurrentSpan({
            "neuve.reviews.read": page.reviews.length,
            "neuve.reviews.total": page.total,
          })
        ),
        Effect.withSpan("web.reviews.waiting-scan", {
          attributes: { "neuve.reviews.cap": WAITING_CAP },
        })
      )
      const cycle = options.cycle
      // A cycle past the newest WAITING_CAP is read on its own.
      const scoped =
        cycle === undefined ||
        recent.reviews.some((review) => review.cycleId === cycle)
          ? []
          : (yield* ReviewList.reviews({ limit: 1, cycleId: cycle })).reviews
      const reviews = [...recent.reviews, ...scoped]
      const descends = yield* Effect.promise(() =>
        orNone(
          ancestryOf(
            at,
            reviews.flatMap((review) => [
              review.range.baseOid,
              review.range.headOid,
            ])
          ),
          () => false,
          "the reviewed history"
        )
      )
      const replaced = replacedOf(reviews, descends)
      return {
        recent,
        reviews,
        cleared: yield* ReviewList.cleared,
        ...(yield* answers(reviews, replaced)),
      }
    })
  ).catch((error: unknown) => {
    if (error instanceof NoStore) return undefined
    throw error
  })
  if (!options.cycle && (!read || read.recent.total === 0))
    return { status: "empty" }
  const reviews = read?.reviews ?? []
  let standing = read?.standing ?? NO_STANDING
  const feedback = new Set(read?.feedback)
  // How a range ended matters only to a review with a unit that waits.
  const ends = await orNone(
    rangeEnds(
      at,
      reviews
        .filter((review) => waitingUnits(review, standing).length > 0)
        .map((review) => ({
          cycleId: review.cycleId,
          baseRef: review.range.baseRef,
          headOid: review.range.headOid,
        }))
    ),
    new Map<string, RangeEnd>(),
    "how the ranges ended"
  )
  // A gone review a later review carries, commit for commit, is replaced
  // like one whose range a later review holds.
  const gone = reviews.filter((review) => ends.get(review.cycleId) === "gone")
  if (gone.length > 0) {
    const first = gone.reduce(
      (earliest, review) =>
        review.cycleId < earliest ? review.cycleId : earliest,
      gone[0]?.cycleId ?? ""
    )
    const asked = reviews.filter(
      (review) =>
        ends.get(review.cycleId) === "gone" ||
        (review.cycleId > first && wholeOf(review))
    )
    const patches = await orNone(
      rangePatchesOf(
        at,
        asked.map((review) => review.range)
      ),
      new Map<string, ReadonlyArray<string>>(),
      "the reviewed commits"
    )
    const rebased = rebasedOf(reviews, ends, (review) =>
      patches.get(`${review.range.baseOid}..${review.range.headOid}`)
    )
    if (rebased.size > 0)
      standing = {
        ...standing,
        takenOver: new Set([
          ...standing.takenOver,
          ...reviews
            .filter((review) => rebased.has(review.cycleId))
            .flatMap((review) => units(review).map((unit) => unit.unitId)),
        ]),
      }
  }
  let pageStanding = standing
  const waiting = defaultListOf(
    reviews.slice(0, read?.recent.reviews.length),
    standing,
    ends
  )
  const shown = afterClear(waiting, read?.cleared)
  const own = reviews.filter((review) => review.cycleId === options.cycle)
  const listed = options.cycle
    ? own
    : options.filter === "waiting"
      ? shown
      : reviews
  const across = waitingOf(options.cycle ? own : waiting, standing)
  const total = options.cycle
    ? own.length
    : options.filter === "waiting"
      ? shown.length
      : (read?.recent.total ?? 0)
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const page = Math.min(Math.max(1, Math.trunc(options.page) || 1), pageCount)
  const offset = (page - 1) * PAGE_SIZE
  // The newest WAITING_CAP reviews hold every page of All but those past
  // them; a page past them reads its reviews, and Records' word on them, apart.
  let onPage: ReadonlyArray<Listed> = listed.slice(offset, offset + PAGE_SIZE)
  if (!options.cycle && options.filter === "all" && offset >= listed.length) {
    const older = await readRecords("web.load.reviews.page", () =>
      Effect.gen(function* () {
        const reviews = (yield* ReviewList.reviews({
          limit: PAGE_SIZE,
          offset,
        })).reviews
        return { reviews, ...(yield* answers(reviews)) }
      })
    )
    onPage = older.reviews
    pageStanding = older.standing
    for (const cycleId of older.feedback) feedback.add(cycleId)
  }
  const subjects = await Promise.all(
    onPage.map((review) => subjectOf(at, review.range.headOid))
  )
  const inWaiting = new Set(waiting.map((review) => review.cycleId))
  const data: ReviewsData = {
    ...(options.cycle ? { cycle: options.cycle } : {}),
    repo: await repositoryName(at),
    reviews: onPage.map((review, index) =>
      summaryOf(review, pageStanding, feedback, subjects[index])
    ),
    filter: options.cycle ? "all" : options.filter,
    ...(read?.cleared ? { cleared: true as const } : {}),
    page,
    pageSize: PAGE_SIZE,
    total,
    // A cycle's address counts its one review.
    counts: options.cycle
      ? {
          all: own.length,
          waiting: own.filter((review) => inWaiting.has(review.cycleId)).length,
        }
      : { all: read?.recent.total ?? 0, waiting: shown.length },
    waiting: {
      units: across.units,
      reviews: across.waiting.length,
      nextUnitId: across.nextUnitId,
    },
    // A failed or running review reviewed nothing yet: new work counts from
    // the newest review that finished. A cycle's address offers none.
    newestHead: options.cycle
      ? undefined
      : read?.recent.reviews.find(
          (review) =>
            review.state === "completed" || review.state === "timed-out"
        )?.range.headOid,
  }
  return { status: "ready", data, onPage, standing: pageStanding }
}

/**
 * The unit a cycle's desk address opens on, across all its batches: the
 * first human-required unit that waits, else the first unit that waits,
 * else its first unit. None while it has no unit.
 */
export async function cycleEntry(cycle: string): Promise<string | undefined> {
  const read = await reviewsRead({ page: 1, filter: "all", cycle })
  const review = read.status === "ready" ? read.onPage[0] : undefined
  if (!review || read.status !== "ready") return undefined
  return entryUnitOf(units(review), read.standing) ?? units(review)[0]?.unitId
}
