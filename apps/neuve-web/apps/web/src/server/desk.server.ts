import { Effect, Option } from "effect"
import {
  Dispositions,
  HumanCommands,
  Identity,
  Lineage,
  Log,
  PublishedPackets,
  ReviewOrigins,
  ReviewProgress,
} from "@neuve/records-core"
import { gitHuman } from "@neuve/harness/request"
import type { ReviewCommentRecord } from "@workspace/ui/neuve/review-comments/record"
import type {
  BatchOverviewLoad,
  ReviewDeskLoad,
} from "@workspace/ui/neuve/types"

import {
  NO_PEOPLE,
  deskBatchContext,
  deskData,
  humanDispositions,
  laneOf,
  overviewData,
  personFrom,
  reviewBatches,
  unitReads,
} from "./projection"
import type {
  EarlierWork,
  HunkHeaders,
  OverviewPeople,
  PacketContext,
  Person,
  ReviewRange,
  Sources,
} from "./projection"
import { feedbackTargets } from "./feedback.server"
import { LANE_FACTS } from "./lane-facts"
import { hunksFor, repositoryName, sourcesFor } from "./git-source.server"
import {
  NoStore,
  readRecords,
  repository,
  writeRecords,
} from "./records.server"

/**
 * The live pages' loads and the desk's commands (M5 S3), over records-core.
 * A load reads the standing packet of either shape through `PublishedPackets`
 * (`readStanding`; RD1, RD3),
 * people's dispositions and comments beside it, and the diff from git, then
 * hands them to the projection. A command records the person git names in
 * the repository (ID1) through `HumanCommands`, whose append rules decide;
 * the BFF decides nothing else (1.7).
 */

const NO_BATCH = { status: "empty", reason: "no-batch" } as const

export const rangeOf = (cycleId: string) =>
  Effect.gen(function* () {
    const events = yield* Log.history({
      cycleId,
      kind: "cycle.opened@1",
      limit: 1,
    })
    const event = events.at(0)?.event
    if (event?.kind !== "cycle.opened@1") return undefined
    const origins = yield* ReviewOrigins.list({ reference: cycleId })
    const display = origins.find((entry) => entry.origin.display)?.origin
      .display
    return {
      ...event.attribution.range,
      ...(display ? { display } : {}),
    } satisfies ReviewRange
  })

/**
 * The standing packet of a cycle, of either shape (`readStanding`), and its
 * range, or undefined when it has none. While batches are pending, also
 * whether a run of it is going or queued (`ReviewProgress.cycleRunGoing`),
 * so the header can say the review stopped short: only on a definite no,
 * and nothing when Records cannot tell.
 */
const standing = (cycleId: string | undefined) =>
  Effect.gen(function* () {
    if (cycleId === undefined) return undefined
    // The repository's git decides each proof record's currency at this read (11.10, 11.18).
    const packet = yield* PublishedPackets.readStanding(cycleId, {
      repository: repository(),
    })
    const range = yield* rangeOf(cycleId)
    if (packet === undefined || range === undefined) return undefined
    // What did not decode, and why, is for the server log: the page says
    // only what the reader can't see (the projection's limitations).
    for (const item of packet.undecoded)
      yield* Effect.logWarning(
        "the standing packet holds content that does not read",
        { what: item.what, ref: item.ref, issue: item.issue }
      )
    const going =
      LANE_FACTS.pendingBatches(packet) > 0
        ? yield* ReviewProgress.cycleRunGoing(cycleId)
        : "unknown"
    return {
      cycleId,
      packet,
      range,
      ...(going === "unknown" ? {} : { runGoing: going }),
    }
  })

type Standing = NonNullable<Effect.Success<ReturnType<typeof standing>>>

/** The most of a cycle's other packets a reload reads to find the one its page came from. */
export const EARLIER_MAX = 8

/**
 * The packet a batch or unit was in before a newer review of the same work
 * replaced it, for a page the reader is already on: the cycle's other
 * packets, newest first, each read whole (`readExact`, which reads a packet
 * a later one superseded) until one `holds` it. Each read costs what the
 * standing read costs (the manifest, the units' blobs and judgements), so
 * it reads at most `EARLIER_MAX`; the one replaced last is read first and
 * is nearly always the one. Undefined when none does, or the cycle has no
 * range: the page then answers as for an unknown batch or unit.
 */
const earlierHolding = (
  cycleId: string | undefined,
  holds: (batch: Standing["packet"]["batches"][number]) => boolean
) =>
  Effect.gen(function* () {
    if (cycleId === undefined) return undefined
    const range = yield* rangeOf(cycleId)
    if (range === undefined) return undefined
    const standingId = yield* PublishedPackets.standingPacketId(cycleId)
    const events = [
      ...(yield* Log.history({
        cycleId,
        kind: "packet.published@2",
        limit: 1_000,
      })),
      ...(yield* Log.history({
        cycleId,
        kind: "packet.published@1",
        limit: 1_000,
      })),
    ]
    const ids = events
      .map((stored) => stored.event.id)
      .filter((id) => id !== standingId)
      .sort()
      .reverse()
      .slice(0, EARLIER_MAX)
    for (const id of ids) {
      const packet = yield* PublishedPackets.readExact(id, {
        repository: repository(),
      })
      const batch = packet?.batches.find(holds)
      if (packet && batch) {
        // No run of it is read: a replaced review says nothing of its runs.
        const found: Standing = { cycleId, packet, range }
        return { found, batch }
      }
    }
    return undefined
  })

/**
 * Where the newer review that replaced a page's packet starts: its first
 * batch, or nothing (the Reviews page) when the cycle has no standing
 * packet to open.
 */
const newestOf = (cycleId: string) =>
  Effect.map(standing(cycleId), (found) => {
    const batchId = found?.packet.batches.at(0)?.batchId
    return batchId === undefined ? {} : { batchId }
  })

/**
 * The files whose hunks a load counts: those the batch's human-required
 * units own lines in, the units the overview and the rail list with a count.
 */
const listedPaths = (
  units: ReadonlyArray<Standing["packet"]["batches"][number]["units"][number]>
) => [
  ...new Set(
    units
      .filter((unit) => laneOf(unit) === "human-required")
      .flatMap((unit) => unitReads(unit).paths)
  ),
]

/** The newest cycle's standing packet: what `/` opens (RD3). */
const newest = Effect.flatMap(PublishedPackets.newestPacketCycle, standing)

const registration = (actorId: string) =>
  Effect.map(
    Log.history({ kind: "actor.registered@1", actorId, limit: 10 }),
    (events) => {
      const event = events.at(-1)?.event
      return event?.kind === "actor.registered@1" &&
        event.payload.actorKind === "human"
        ? event.payload
        : undefined
    }
  )

/** The registered people among `actors`, by actor, with the viewer always named. */
const peopleOf = (actors: Iterable<string>, viewing: Person | undefined) =>
  Effect.gen(function* () {
    const people: Partial<Record<string, Person>> = {}
    for (const actor of new Set(actors)) {
      const registered = yield* registration(actor)
      if (registered) people[actor] = personFrom(actor, registered)
    }
    if (viewing) people[viewing.actor] = viewing
    return people
  })

/** The person git names in the repository (10.5, ID1), as the harness reads them. */
const gitPerson = async (at: string) => {
  const human = Option.getOrUndefined(await Effect.runPromise(gitHuman(at)))
  return human?._tag === "Human"
    ? { email: human.email, displayName: human.displayName }
    : undefined
}

/** The person git names in the repository, as Records knows them (ID1). */
export const viewer = async (at: string) => {
  const person = await gitPerson(at)
  if (!person) return undefined
  return personFrom(Identity.humanFingerprint(person.email), person)
}

/**
 * The overview's read of Records: the batch asked for (else the newest
 * cycle's first), its standing packet, and people's decisions on it unless
 * `people` is off. Undefined when no standing packet holds the batch.
 */
export const overviewRead = (
  batchId: string | undefined,
  options: {
    readonly people: boolean
    readonly viewer: Person | undefined
    /**
     * A reload of the page the reader is on: a batch a newer review
     * replaced is read from the packet it was in, and says so (`newer`).
     */
    readonly stay?: boolean
  }
) =>
  Effect.gen(function* () {
    const newestCycle = yield* PublishedPackets.newestPacketCycle
    const cycleId =
      batchId === undefined
        ? newestCycle
        : yield* PublishedPackets.cycleOfBatch(batchId)
    const standingRead = yield* standing(cycleId)
    const standingBatch =
      batchId === undefined
        ? standingRead?.packet.batches.at(0)
        : standingRead?.packet.batches.find(
            (entry) => entry.batchId === batchId
          )
    const earlier =
      standingBatch === undefined && options.stay && batchId !== undefined
        ? yield* earlierHolding(cycleId, (entry) => entry.batchId === batchId)
        : undefined
    const found = earlier?.found ?? standingRead
    const batch = earlier?.batch ?? standingBatch
    if (!found || !batch) return undefined
    const latest = cycleId === newestCycle
    // A batch a newer review replaced says where the newer review starts;
    // one of an older review whose every unit's work a later review holds
    // says where (Records' lineage, the redirect's rule).
    const newer = earlier
      ? yield* newestOf(found.cycleId)
      : yield* batchSuccessor(batch.units, found.cycleId)
    const replaced = newer ? { newer } : {}
    if (!options.people)
      return { found, latest, batch, human: NO_PEOPLE, ...replaced }
    const dispositions = humanDispositions(batch.units)
    const human: OverviewPeople = {
      viewer: options.viewer,
      people: yield* peopleOf(
        dispositions.map((disposition) => disposition.actorId),
        options.viewer
      ),
      dispositions,
    }
    return { found, latest, batch, human, ...replaced }
  })

type OverviewRead = NonNullable<Effect.Success<ReturnType<typeof overviewRead>>>

/**
 * Where a batch's link leads when a newer review replaced the batch and the
 * reader enters it (not a reload): the batch that holds its work now, as a
 * unit's link leads to its unit's (`successorOf`), else where the newer
 * review starts. Undefined for a batch no packet of its review held, or a
 * newer review with no batch to open.
 */
export const replacedBatchSuccessor = (batchId: string) =>
  Effect.gen(function* () {
    const cycleId = yield* PublishedPackets.cycleOfBatch(batchId)
    const earlier = yield* earlierHolding(
      cycleId,
      (entry) => entry.batchId === batchId
    )
    if (!earlier) return undefined
    const now =
      (yield* batchSuccessor(earlier.batch.units, undefined)) ??
      (yield* newestOf(earlier.found.cycleId))
    return "batchId" in now && now.batchId !== undefined
      ? { batchId: now.batchId }
      : undefined
  })

/** The overview a read projects to. */
export const overviewOf = (
  read: OverviewRead,
  repo: string,
  /** Git's hunks of the batch's listed units' files (`listedPaths`), when the load read them. */
  hunks?: HunkHeaders
) => ({
  ...overviewData(
    {
      repo,
      range: read.found.range,
      packet: read.found.packet,
      batch: read.batch,
      newest: read.latest,
      ...(hunks ? { hunks } : {}),
      ...(read.found.runGoing === undefined
        ? {}
        : { runGoing: read.found.runGoing }),
    },
    read.human
  ),
  ...("newer" in read && read.newer ? { newer: read.newer } : {}),
})

/**
 * An overview load, with the review it shows when it shows one, so a page
 * reloads for changes to that review alone (`pageConcerned`).
 */
export type LiveOverviewLoad = BatchOverviewLoad & {
  readonly cycleId?: string
  /**
   * For a batch a newer review replaced, entered rather than reloaded: the
   * batch that holds its work now, which the route opens instead.
   */
  readonly successor?: { readonly batchId: string }
}

export async function overviewLoad(
  batchId: string | undefined,
  options: {
    /** People's decisions (on by default); the Storybook fixture leaves them out. */
    readonly people?: boolean
    /** A reload of the page the reader is on (`overviewRead`). */
    readonly stay?: boolean
  } = {}
): Promise<LiveOverviewLoad> {
  const at = repository()
  const withPeople = options.people ?? true
  const person = withPeople ? await viewer(at) : undefined
  try {
    const read = await readRecords("web.load.overview", () =>
      Effect.gen(function* () {
        const found = yield* overviewRead(batchId, {
          people: withPeople,
          viewer: person,
          stay: options.stay ?? false,
        })
        return found !== undefined || batchId === undefined || options.stay
          ? found
          : { successor: yield* replacedBatchSuccessor(batchId) }
      })
    )
    if (!read) return NO_BATCH
    if ("successor" in read)
      return read.successor
        ? { ...NO_BATCH, successor: read.successor }
        : NO_BATCH
    // Without git's hunks the counts fall back to the files each unit owns
    // lines in; the page still opens, and the server log says why.
    const hunks = await Effect.runPromise(
      hunksFor(at, read.found.range, listedPaths(read.batch.units))
    ).catch((error: unknown) => {
      console.warn("the overview could not read git's hunks", error)
      return undefined
    })
    return {
      status: "ready",
      data: overviewOf(read, await repositoryName(at), hunks),
      cycleId: read.found.cycleId,
    }
  } catch (error) {
    if (error instanceof NoStore) return NO_BATCH
    throw error
  }
}

/** The batch IDs of the newest cycle's standing packet, in packet order. */
export async function newestBatchIds(
  /** A cycle to read in place of the newest (the Storybook fixture's choice). */
  cycleId?: string
): Promise<Array<string>> {
  try {
    return await readRecords("web.load.batches", () =>
      Effect.map(
        cycleId === undefined ? newest : standing(cycleId),
        (found) => found?.packet.batches.map((batch) => batch.batchId) ?? []
      )
    )
  } catch (error) {
    if (error instanceof NoStore) return []
    throw error
  }
}

/** Where an old unit's work is now: a unit lineage leads to that the desk opens. */
export interface DeskSuccessor {
  readonly unitId: string
  /** `unchanged` when every step from the old unit to it is the same change. */
  readonly relation: Lineage.Successor["relation"]
  /** The batch that holds it, in its review's standing packet. */
  readonly batchId?: string
  /** Its review. */
  readonly cycleId?: string
}

/** The most units an old link's lineage is followed through. */
export const SUCCESSOR_MAX = 16

/**
 * A unit as the desk opens it: in its cycle's standing packet, which has a
 * range (`cycle.opened@1`), with a lane from Records. The full read of the
 * unit the page opens; whether a unit opens at all is `opensAt`'s, the same
 * rule from cheap reads. `held` says a standing packet holds a unit that
 * does not open (it has no lane).
 */
export const opening = (unitId: string) =>
  Effect.gen(function* () {
    const cycleId = yield* PublishedPackets.cycleOfUnit(unitId)
    const found = yield* standing(cycleId)
    const batch = found?.packet.batches.find((entry) =>
      entry.units.some((unit) => unit.unitId === unitId)
    )
    const unit = batch?.units.find((entry) => entry.unitId === unitId)
    if (!found || !batch || !unit) return { opens: false as const, held: false }
    if (laneOf(unit) === undefined) return { opens: false as const, held: true }
    return { opens: true as const, cycleId, found, batch, unit }
  })

/**
 * What `opensAt` has read of each review, by cycle: the batch of each unit
 * its standing manifest names, or undefined when it has none (no packet, a
 * manifest that does not read, or no range). One walk reads each once.
 */
export type OpensCache = Map<string, ReadonlyMap<string, string> | undefined>

/** Whether a unit opens on the desk, and in which review and batch. */
export interface Opens {
  readonly opens: boolean
  readonly cycleId?: string
  readonly batchId?: string
}

/**
 * Whether the desk opens a unit, by `opening`'s rule from cheap reads only:
 * its cycle (`cycleOfUnit`, which also says Records recorded it, so it has
 * a lane), that cycle's standing manifest naming it and the cycle's range
 * (`cycle.opened@1`), both read once per cycle into `cache`. No packet is
 * read whole: the redirect, the "Newer review" link and the Reviews page
 * decide by this, and only the unit then opened is read in full.
 */
export const opensAt = (unitId: string, cache: OpensCache = new Map()) =>
  Effect.gen(function* () {
    const cycleId = yield* PublishedPackets.cycleOfUnit(unitId)
    const closed: Opens = { opens: false }
    if (cycleId === undefined) return closed
    if (!cache.has(cycleId)) {
      const manifest = (yield* PublishedPackets.standingManifest(cycleId))
        ?.manifest
      const range = manifest ? yield* rangeOf(cycleId) : undefined
      cache.set(
        cycleId,
        manifest && range
          ? new Map(
              manifest.batches.flatMap((batch) =>
                batch.units.map((unit) => [unit.unitId, batch.batchId] as const)
              )
            )
          : undefined
      )
    }
    const batchId = cache.get(cycleId)?.get(unitId)
    if (batchId === undefined) return closed
    // Records gives a unit no lane only when it holds no `unit.recorded`
    // for it (`judge`: no assessment's lane and no recording), and only a
    // recording sets the projection's cycle that `cycleOfUnit` just read
    // (records-core `projectors.ts`). So a unit with a cycle has a lane:
    // nothing more is read.
    const opens: Opens = { opens: true, cycleId, batchId }
    return opens
  })

/**
 * Where an old unit's work is now: lineage followed from `unitId`, newest
 * successor first, to the first unit the desk opens (`opensAt`, the unit
 * load's own rule: a standing packet with a range, and a lane).
 * Undefined when none does within `SUCCESSOR_MAX` units: a successor that
 * does not open, and lineage that names a unit twice (bad data), end as an
 * unknown unit rather than a link to one or a loop.
 */
export const successorOf = (
  unitId: string,
  options: {
    /** Only a unit of a later review than this one ends the walk (an older review's page). */
    readonly laterThan?: string | undefined
    /** What the walk has read of each review, shared across one load's walks. */
    readonly cache?: OpensCache
    /**
     * Lineage already read for some units (`Lineage.successorsMany`, which
     * holds for every unit it was asked about exactly what
     * `Lineage.successors` returns): the walk reads only the units it does
     * not hold.
     */
    readonly successors?: ReadonlyMap<string, ReadonlyArray<Lineage.Successor>>
  } = {}
) =>
  Effect.gen(function* () {
    const cache = options.cache ?? new Map()
    const seen = new Set([unitId])
    const queue: Array<DeskSuccessor> = [{ unitId, relation: "unchanged" }]
    for (let from = queue.shift(); from !== undefined; from = queue.shift()) {
      const named =
        options.successors?.get(from.unitId) ??
        (yield* Lineage.successors(from.unitId))
      for (const next of named) {
        if (seen.has(next.unitId)) continue
        if (seen.size >= SUCCESSOR_MAX) return undefined
        seen.add(next.unitId)
        const step: DeskSuccessor = {
          unitId: next.unitId,
          relation:
            from.relation === "unchanged" && next.relation === "unchanged"
              ? "unchanged"
              : "changed",
        }
        const opened = yield* opensAt(next.unitId, cache)
        if (
          opened.opens &&
          (options.laterThan === undefined ||
            (opened.cycleId !== undefined &&
              opened.cycleId > options.laterThan))
        )
          return {
            ...step,
            ...(opened.batchId === undefined
              ? {}
              : { batchId: opened.batchId }),
            ...(opened.cycleId === undefined
              ? {}
              : { cycleId: opened.cycleId }),
          }
        queue.push(step)
      }
    }
    return undefined
  })

/** The most units of a batch whose lineage the overview follows to say a newer review holds them. */
export const BATCH_SUCCESSORS_MAX = 64

/**
 * Where a batch's work is now, by Records' lineage: the batch every one of
 * its units' work moved to in a later review (`successorOf`, the redirect's
 * rule), `{}` when it spread over several (the newest review's overview of
 * that lineage), or undefined when some unit's work moved nowhere that
 * opens. A batch of more than `BATCH_SUCCESSORS_MAX` units is not followed.
 */
const batchSuccessor = (
  units: ReadonlyArray<{ readonly unitId: string }>,
  laterThan: string | undefined,
  cache: OpensCache = new Map()
) =>
  Effect.gen(function* () {
    if (units.length === 0 || units.length > BATCH_SUCCESSORS_MAX)
      return undefined
    const batches = new Set<string>()
    let cycle: string | undefined
    for (const unit of units) {
      const next = yield* successorOf(unit.unitId, { laterThan, cache })
      if (next?.batchId === undefined) return undefined
      batches.add(next.batchId)
      if (cycle === undefined || (next.cycleId ?? "") > cycle)
        cycle = next.cycleId
    }
    const [only] = [...batches]
    return batches.size === 1
      ? { batchId: only }
      : cycle === undefined
        ? {}
        : yield* newestOf(cycle)
  })

/** A desk load, with where an old link's work is now. */
export interface LiveDeskLoad {
  readonly load: ReviewDeskLoad
  /**
   * For a unit no standing packet holds, the unit that now holds its work,
   * when lineage names one: the route opens that unit instead.
   */
  readonly successor?: DeskSuccessor
  /** The review the unit is in, when it opens (`pageConcerned`). */
  readonly cycleId?: string
}

/**
 * The desk's read of Records for one unit: its standing packet, batch and
 * unit, people's decisions and comments, and the feedback targets when
 * `feedback` is on. A unit no standing packet holds reads as `missing`,
 * framed by the newest packet, with the unit its lineage leads to that
 * opens (`successorOf`) when there is one; a unit Records gives no lane is
 * `missing` with none.
 */
export const deskRead = (
  unitId: string,
  options: {
    readonly viewer: Person | undefined
    readonly feedback?: boolean
    /**
     * A reload of the page the reader is on: a unit a newer review replaced
     * is read from the packet it was in, never moved, and says where the
     * work is now (`newer`).
     */
    readonly stay?: boolean
  }
) =>
  Effect.gen(function* () {
    const opened = yield* opening(unitId)
    if (!opened.opens) {
      // One a standing packet holds with no lane: unit-not-found.
      if (opened.held) return { missing: yield* newest }
      // One no standing packet holds: where its work is now, when lineage
      // leads to a unit that opens (`successorOf`), else the designed
      // unit-not-found state, framed by the newest packet.
      const successor = yield* successorOf(unitId)
      // The reader's own page, reloaded as the newer review lands: the same
      // unit from the packet it was in, by the rule a unit opens by (a
      // lane), with the unit that holds the work now, by the redirect's
      // rule, or else where the newer review starts.
      const cycleId = options.stay
        ? yield* PublishedPackets.cycleOfUnit(unitId)
        : undefined
      const earlier = options.stay
        ? yield* earlierHolding(cycleId, (entry) =>
            entry.units.some((unit) => unit.unitId === unitId)
          )
        : undefined
      const unit = earlier?.batch.units.find((entry) => entry.unitId === unitId)
      if (earlier && unit && laneOf(unit) !== undefined)
        return {
          ...(yield* openedRead(
            { cycleId: earlier.found.cycleId, ...earlier, unit },
            unitId,
            options
          )),
          newer: successor
            ? { unitId: successor.unitId }
            : yield* newestOf(earlier.found.cycleId),
        }
      return {
        missing: yield* newest,
        // Where its work is now; the route opens it.
        ...(successor
          ? {
              successor: {
                unitId: successor.unitId,
                relation: successor.relation,
              },
            }
          : {}),
      }
    }
    return yield* openedRead(opened, unitId, options)
  })

/** The most earlier units of a changed unit whose people's decisions the desk reads. */
export const EARLIER_UNITS_MAX = 16

/**
 * People's standing decisions on the earlier units a changed unit's lineage
 * names (14.12): each one the decider still stands by there
 * (`Dispositions.current`), on a unit of an earlier review (`changed`; an
 * unchanged one's decision is carried instead, and one of the same review
 * is no earlier version). Each person's verdict on a head once. They close
 * nothing here.
 */
const earlierDecisions = (
  unit: Standing["packet"]["batches"][number]["units"][number]
) =>
  Effect.gen(function* () {
    const lineage = "lineage" in unit ? unit.lineage : undefined
    if (lineage === undefined) return []
    const own = lineage.attribution.cycleId
    const entries = lineage.payload.from
      .filter((entry) => entry.relation === "changed" && entry.cycleId !== own)
      .slice(0, EARLIER_UNITS_MAX)
    const rows: Array<EarlierWork> = []
    for (const entry of entries)
      for (const row of yield* Dispositions.current({ unitId: entry.unitId }))
        if (
          !rows.some(
            (known) =>
              known.actorId === row.actorId &&
              known.verdict === row.verdict &&
              known.head === row.reviewedHeadOid
          )
        )
          rows.push({
            actorId: row.actorId,
            verdict: row.verdict,
            head: row.reviewedHeadOid,
          })
    return rows
  })

/** The desk's read of a unit that opens, from the packet `opened` names. */
const openedRead = (
  opened: {
    readonly cycleId: string | undefined
    readonly found: Standing
    readonly batch: Standing["packet"]["batches"][number]
    readonly unit: Standing["packet"]["batches"][number]["units"][number]
  },
  unitId: string,
  options: { readonly viewer: Person | undefined; readonly feedback?: boolean }
) =>
  Effect.gen(function* () {
    const person = options.viewer
    const { cycleId, found, batch, unit } = opened
    const latest =
      cycleId !== undefined &&
      cycleId === (yield* PublishedPackets.newestPacketCycle)
    const own = new Set(unit.comments.map((comment) => comment.id))
    const comments = (yield* Log.history({
      unitId,
      kind: "comment.recorded@2",
      limit: 10_000,
    }))
      .map((stored) => stored.event)
      .filter(
        (event) => event.kind === "comment.recorded@2" && !own.has(event.id)
      )
      .flatMap((event) => (event.kind === "comment.recorded@2" ? [event] : []))
    const dispositions = humanDispositions(batch.units)
    const earlierRows = yield* earlierDecisions(unit)
    const people = yield* peopleOf(
      [
        ...dispositions.map((disposition) => disposition.actorId),
        ...comments.map((comment) => comment.actor),
        // A person's comments carried with their decision.
        ...unit.comments
          .filter((comment) => comment.kind === "comment.carried@1")
          .map((comment) => comment.actor),
        ...earlierRows.map((row) => row.actorId),
      ],
      person
    )
    // A person's fresh decision that stands, read whole for the comments a
    // request for changes rests on (the packet holds no person's).
    const standingHuman =
      unit.judgement.standing?.actorKind === "human"
        ? Option.getOrUndefined(yield* Log.get(unit.judgement.standing.eventId))
            ?.event
        : undefined
    const standingDecision =
      standingHuman?.kind === "disposition.recorded@2"
        ? {
            verdict: standingHuman.payload.verdict,
            restsOn: standingHuman.payload.restsOn,
          }
        : undefined
    // An older review's unit whose work a later review holds says where
    // (Records' lineage, the redirect's rule).
    const later = yield* successorOf(unitId, { laterThan: cycleId })
    return {
      found,
      latest,
      batch,
      unit,
      viewer: person,
      comments: comments.filter((comment) => people[comment.actor]),
      dispositions,
      people,
      // People's decisions only: an agent's, or an unregistered actor's, is not shown.
      earlier: earlierRows.filter((row) => people[row.actorId] !== undefined),
      ...(standingDecision ? { standing: standingDecision } : {}),
      ...(later ? { newer: { unitId: later.unitId } } : {}),
      sequence: yield* Log.currentSequence,
      feedback: options.feedback
        ? yield* feedbackTargets({ batch, unit, actorId: person?.actor })
        : undefined,
    }
  })

type DeskRead = Effect.Success<ReturnType<typeof deskRead>>
type DeskMissing = Extract<DeskRead, { missing: unknown }>
type DeskFound = Exclude<DeskRead, { missing: unknown }>

/** The load for a unit the desk cannot open, with where its work is now. */
export const deskMissing = (
  read: DeskMissing,
  unitId: string,
  repo: string
): LiveDeskLoad => {
  const successor = "successor" in read ? { successor: read.successor } : {}
  const missing: Standing | undefined = read.missing
  const first = missing?.packet.batches.at(0)
  if (!missing || !first) return { load: NO_BATCH, ...successor }
  return {
    load: {
      status: "missing",
      reason: "unknown-unit",
      unitId,
      batch: deskBatchContext({
        repo,
        range: missing.range,
        packet: missing.packet,
        batch: first,
      }),
    },
    ...successor,
  }
}

/** The desk a read projects to, over the unit's files as git holds them. */
export const deskReady = (
  read: DeskFound,
  repo: string,
  sources: Sources
): LiveDeskLoad => {
  const lane = laneOf(read.unit)
  if (lane === undefined) return { load: NO_BATCH }
  const context: PacketContext = {
    repo,
    range: read.found.range,
    packet: read.found.packet,
    batch: read.batch,
    newest: read.latest,
    ...(read.found.runGoing === undefined
      ? {}
      : { runGoing: read.found.runGoing }),
  }
  const human = {
    viewer: read.viewer,
    people: read.people,
    dispositions: read.dispositions,
    comments: read.comments,
    sequence: read.sequence,
    earlier: read.earlier,
    ...("standing" in read && read.standing ? { standing: read.standing } : {}),
  }
  return {
    load: {
      status: "ready",
      data: {
        ...deskData(context, read.unit, lane, sources, human),
        batches: reviewBatches(context),
        ...(read.feedback ? { feedback: read.feedback } : {}),
        ...("newer" in read ? { newer: read.newer } : {}),
      },
    },
    cycleId: read.found.cycleId,
  }
}

export async function deskLoad(
  unitId: string,
  options: {
    /** Feedback (10.100): what its controls answer on, while the owner's setting is on. */
    readonly feedback?: boolean
    /** A reload of the page the reader is on (`deskRead`). */
    readonly stay?: boolean
  } = {}
): Promise<LiveDeskLoad> {
  const at = repository()
  const person = await viewer(at)
  const read = await readRecords("web.load.desk", () =>
    deskRead(unitId, {
      viewer: person,
      feedback: options.feedback,
      stay: options.stay ?? false,
    })
  ).catch((error: unknown) => {
    if (error instanceof NoStore) return undefined
    throw error
  })
  if (!read) return { load: NO_BATCH }
  const repo = await repositoryName(at)
  if ("missing" in read) return deskMissing(read, unitId, repo)
  const reads = unitReads(read.unit)
  const sources = await Effect.runPromise(
    sourcesFor(
      at,
      read.found.range,
      reads.paths,
      reads.blobs,
      listedPaths(read.batch.units)
    )
  )
  return deskReady(read, repo, sources)
}

/* ── Commands (ID1) ─────────────────────────────────────── */

/** Lines on one side, as Records anchors a comment. */
export interface CommandAnchor {
  path: string
  side: "old" | "new"
  startLine: number
  endLine: number
}

const requirePerson = async () => {
  const person = await gitPerson(repository())
  if (!person)
    throw new Error(
      "git names no email here (git config user.email), so Neuve cannot record who decided"
    )
  return person
}

/**
 * The dock's decision. A comment it carries is on the lines of the marker
 * the composer showed attached when the unit owns them, else on the whole
 * unit (10.102); Records' append rules decide the rest.
 */
export async function recordDecision(input: {
  unitId: string
  kind: "approve" | "request-changes" | "comment"
  body: string
  anchor?: CommandAnchor | undefined
}) {
  const person = await requirePerson()
  return writeRecords("web.command.decision", () =>
    Effect.gen(function* () {
      if (input.kind === "approve") {
        const done = yield* HumanCommands.recordDisposition({
          person,
          unitId: input.unitId,
          verdict: "approve",
        })
        return {
          commandId: done.dispositionId,
          kind: "disposition" as const,
          applicability: "current" as const,
        }
      }
      const comment = { body: input.body, anchor: input.anchor }
      if (input.kind === "request-changes") {
        const done = yield* HumanCommands.recordDisposition({
          person,
          unitId: input.unitId,
          verdict: "request-changes",
          comments: [comment],
        })
        return {
          commandId: done.dispositionId,
          kind: "disposition" as const,
          applicability: "current" as const,
        }
      }
      const done = yield* HumanCommands.recordComment({
        person,
        unitId: input.unitId,
        comment,
      })
      return { commandId: done.commentId, kind: "comment" as const }
    })
  )
}

export async function retractDecision(input: { dispositionId: string }) {
  const person = await requirePerson()
  return writeRecords("web.command.retraction", () =>
    Effect.map(
      HumanCommands.retractDisposition({
        person,
        dispositionId: input.dispositionId,
      }),
      (done) => ({ retractionId: done.retractionId })
    )
  )
}

/** Records a line comment and returns it as the desk's comment record. */
export async function recordLineComment(input: {
  unitId: string
  revision: string
  body: string
  anchor: CommandAnchor
  shown: Pick<ReviewCommentRecord, "anchor">["anchor"]
}): Promise<ReviewCommentRecord> {
  const person = await requirePerson()
  const done = await writeRecords("web.command.comment", () =>
    HumanCommands.recordComment({
      person,
      unitId: input.unitId,
      comment: { body: input.body, anchor: input.anchor },
    })
  )
  const author = personFrom(done.actor, person)
  return {
    schemaVersion: 2,
    id: done.commentId,
    unitId: input.unitId,
    revision: input.revision,
    anchor: input.shown,
    author: { id: author.actor, name: author.name, initials: author.initials },
    body: input.body.trim(),
    createdAt: new Date().toISOString(),
    status: "open",
  }
}
