import { Effect } from "effect"
import { HumanCommands, PublishedPackets } from "@neuve/records-core"
import type { ReviewList } from "@neuve/records-core"
import type {
  HomeBatch,
  HomeLoad,
  HomeReview,
} from "@workspace/ui/neuve/home/home-data"
import type { ReviewLane, ReviewSummary } from "@workspace/ui/neuve/types"

import { LANE_FACTS } from "./lane-facts"
import type { DeskBatch, LaneFacts } from "./lane-facts"
import { withoutLocalIds } from "./projection"
import { gitPerson } from "./feedback.server"
import { readRecords, writeRecords } from "./records.server"
import {
  LANE_ORDER,
  asks,
  entryUnitOf,
  laneOf,
  markOf,
  reviewsRead,
} from "./reviews.server"
import type { UnitStanding } from "./reviews.server"

/**
 * The home page's load (`/`): the Reviews load's page of reviews, newest run
 * first, with each batch as a reader picks one: its batch digest, its units
 * by lane, what waits on the reader and the unit its desk opens on. What
 * waits counts as the Reviews load counts it (14.33): a human-required unit
 * until a person decides it, a human-suggested one until anyone does, and
 * nothing a newer review took over.
 *
 * The digests come from each listed review's packet of record, one read per
 * review on the page (`PublishedPackets.readStanding`). A packet that can't
 * be read leaves its batches without a digest; the page still opens.
 */

type Listed = ReviewList.ListedReview

/** `[phrase](id)`, the digest's phrase link. */
const PHRASE_LINK = /\[([^\]\n]+)\]\(([^()\s]+)\)/g

/**
 * Digest text as a reader reads it in a list: each phrase link as its
 * phrase, bare local IDs dropped (`withoutLocalIds`), runs of space joined.
 * Empty text reads as none.
 */
export const plainDigest = (text: string | undefined): string | undefined => {
  if (text === undefined) return undefined
  const plain = withoutLocalIds(text.replace(PHRASE_LINK, "$1"))
    .replace(/[ \t]+/g, " ")
    .trim()
  return plain === "" ? undefined : plain
}

/** One listed batch with what its packet says of it. */
export const homeBatchOf = (
  listed: ReviewList.ListedBatch,
  summary: ReviewSummary["batches"][number],
  packet: DeskBatch | undefined,
  standing: UnitStanding,
  newer: boolean,
  facts: LaneFacts = LANE_FACTS
): HomeBatch => {
  const counts = new Map<ReviewLane, number>()
  for (const unit of listed.units) {
    const lane = laneOf(unit.lane)
    counts.set(lane, (counts.get(lane) ?? 0) + 1)
  }
  const asked = newer ? [] : listed.units.filter(asks(standing))
  const digest = plainDigest(packet?.digest?.digest)
  const toCheck = plainDigest(packet?.digest?.verification)
  const removes = packet
    ? facts
        .removedSegments(packet)
        .map((entry) => withoutLocalIds(entry.text).trim())
        .filter((text) => text !== "")
    : []
  const deskUnitId =
    (newer ? undefined : entryUnitOf(listed.units, standing)) ??
    listed.units.at(0)?.unitId
  return {
    ...summary,
    // An older review asks for nothing: a newer one holds its units.
    needYou: newer ? 0 : summary.needYou,
    lanes: LANE_ORDER.flatMap((lane) => {
      const count = counts.get(lane) ?? 0
      return count > 0 ? [{ lane, count }] : []
    }),
    ...(digest ? { digest } : {}),
    ...(toCheck ? { toCheck } : {}),
    ...(removes.length > 0 ? { removes } : {}),
    asked: asked.length,
    ...(deskUnitId ? { deskUnitId } : {}),
  }
}

/** Each review's packet of record, or none when it has no batch or can't be read. */
const packetsOf = (reviews: ReadonlyArray<Listed>) =>
  readRecords("web.load.home.digests", () =>
    Effect.forEach(reviews, (review) =>
      review.batches.length === 0
        ? Effect.succeed(undefined)
        : PublishedPackets.readStanding(review.cycleId).pipe(
            Effect.orElseSucceed(() => undefined)
          )
    ).pipe(
      Effect.withSpan("web.home.digests", {
        attributes: { "neuve.home.reviews": reviews.length },
      })
    )
  ).catch((error: unknown) => {
    console.warn("the home page could not read the batch digests", error)
    return reviews.map(() => undefined)
  })

/**
 * A review's batches as the home page shows them, in packet order; at a
 * cycle's own address (`requiredFirst`), the batches with a human-required
 * unit that waits come first, each group keeping that order.
 */
export const homeBatchesOf = (
  summary: ReviewSummary,
  listed: Listed | undefined,
  packet: { readonly batches: ReadonlyArray<DeskBatch> } | undefined,
  standing: UnitStanding,
  requiredFirst: boolean
): Array<HomeBatch> => {
  const byId = new Map(
    (packet?.batches ?? []).map((batch) => [batch.batchId, batch])
  )
  const newer = summary.newer === true
  const batches = summary.batches.map((batch, at) => {
    const own = listed?.batches.at(at)
    return {
      shown: own
        ? homeBatchOf(own, batch, byId.get(batch.id), standing, newer)
        : { ...batch, lanes: [], asked: 0 },
      required:
        !newer &&
        (own?.units ?? []).some(
          (unit) =>
            laneOf(unit.lane) === "human-required" &&
            asks(standing)(unit) &&
            markOf(standing, unit.unitId) === "waiting"
        ),
    }
  })
  if (requiredFirst)
    batches.sort((a, b) => Number(b.required) - Number(a.required))
  return batches.map(({ shown }) => shown)
}

export async function homeLoad(options: {
  readonly page: number
  readonly filter: "all" | "waiting"
  /** A cycle's own address: the list scoped to that one review. */
  readonly cycle?: string | undefined
}): Promise<HomeLoad> {
  const read = await reviewsRead(options)
  if (read.status === "empty") return read
  const packets = await packetsOf(read.onPage)
  const reviews: Array<HomeReview> = read.data.reviews.map(
    (summary, index) => ({
      ...summary,
      batches: homeBatchesOf(
        summary,
        read.onPage.at(index),
        packets.at(index),
        read.standing,
        options.cycle !== undefined
      ),
    })
  )
  return { status: "ready", data: { ...read.data, reviews } }
}

/**
 * "Clear" on the default list, or its undo (`restore`), as the person git
 * names in the repository (ID1), through `HumanCommands.clearReviewList`.
 */
export async function clearList(restore: boolean): Promise<void> {
  const person = await gitPerson()
  if (!person)
    throw new Error(
      "git names no email here (git config user.email), so Neuve cannot record who cleared the list"
    )
  await writeRecords("web.command.clear-list", () =>
    HumanCommands.clearReviewList({ person, restore })
  )
}
