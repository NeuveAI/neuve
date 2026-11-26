import { Effect, Option } from "effect"
import { Log, ReviewInformation } from "@neuve/records-core"
import type { PublishedPackets } from "@neuve/records-core"
import { ReviewInformationReadQuery } from "@neuve/records-schema"
import { z } from "zod"

export type ReviewInformationTarget =
  | { readonly kind: "cycle" }
  | { readonly kind: "unit"; readonly unitId: string }
  | { readonly kind: "batch"; readonly batchId: string }

const PageOptions = z.strictObject({
  // Two streams share this ceiling, not a full allowance each. Reserve a row for each.
  limit: z.int().min(2).max(128).default(64),
  detailsBytes: z.int().min(0).max(1_048_576).default(65_536),
  ownedAfterSeq: z.int().nonnegative().default(0),
  cycleAfterSeq: z.int().nonnegative().default(0),
})

export type ReviewInformationPageOptions = z.input<typeof PageOptions>

type Bounds = { readonly limit: number; readonly detailsBytes: number }
type Unavailable = { readonly status: "unavailable"; readonly reason: string }
type AvailablePage = {
  readonly status: "available"
  readonly bounds: Bounds
  readonly afterSeq: number
  readonly items: ReadonlyArray<ReviewInformation.InformationRow>
  readonly hasMore: boolean
  readonly nextSeq: number
}

export type ReviewInformationView =
  | Unavailable
  | {
      readonly status: "available"
      readonly packetId: string
      readonly cycleId: string
      readonly runKey: string
      readonly notice: string
      /** Aggregate returned-row/detail-byte ceilings; metadata is bounded by the fact schema. */
      readonly bounds: Bounds
      readonly owned:
        AvailablePage | Unavailable | { readonly status: "not-requested" }
      /** Cycle-level even on a unit page: candidate sections never establish an owner. */
      readonly cycleUnassigned: AvailablePage
    }

const unavailable = (reason: string): Unavailable => ({
  status: "unavailable",
  reason,
})

const sectionsFor = (
  packet: PublishedPackets.ReadPacketV2,
  target: Exclude<ReviewInformationTarget, { kind: "cycle" }>
) => {
  const units =
    target.kind === "batch"
      ? packet.batches.find((batch) => batch.batchId === target.batchId)?.units
      : packet.batches
          .flatMap((batch) => batch.units)
          .filter((unit) => unit.unitId === target.unitId)
  if (!units?.length) return undefined
  // Missing section data is not an empty, completely reviewed assignment.
  if (units.some((unit) => unit.sections.length === 0)) return undefined
  return [
    ...new Set(
      units.flatMap((unit) => unit.sections.map((section) => section.key))
    ),
  ].sort()
}

/**
 * Read-only preparation for future desk/overview loads, not wired to either UI yet.
 * Invoke inside their existing readRecords boundary with the packet actually selected (including
 * an older packet kept open). No latest-run lookup, frozen-package mutation or decision inference.
 * Rows, report/source JSON and source references remain untrusted DATA, byte-for-byte as read;
 * a future renderer must escape text and must not treat it as HTML, instructions or approval.
 */
export const readReviewInformation = (
  packet: PublishedPackets.ReadPacket,
  target: ReviewInformationTarget,
  options: ReviewInformationPageOptions = {}
) =>
  Effect.gen(function* () {
    const parsed = PageOptions.safeParse(options)
    if (!parsed.success)
      return yield* new ReviewInformation.InformationRefused({
        message: "Invalid review information view bounds or cursors",
      })
    const page = parsed.data
    if (packet.kind !== "packet.published@2")
      return unavailable(
        "This legacy packet has no supported review-information identity."
      )

    const publication = Option.getOrUndefined(
      yield* Log.get(packet.eventId)
    )?.event
    if (publication?.kind !== "packet.published@2")
      return unavailable(
        "The selected packet's publication is unavailable or has a different shape."
      )
    if (
      publication.payload.ordinal !== packet.ordinal ||
      packet.sequence?.ordinal !== packet.ordinal ||
      packet.sequence.base !== (publication.causation?.supersedes ?? null) ||
      !publication.refs.some(
        (ref) =>
          ref.role === "manifest" && ref.ref === `blob:${packet.manifest}`
      )
    )
      return unavailable(
        "The selected packet and publication identities do not match."
      )

    const identity = ReviewInformationReadQuery.pick({
      cycleId: true,
      runKey: true,
    }).safeParse({
      cycleId: publication.attribution.cycleId,
      runKey: packet.sequence.runKey,
    })
    if (!identity.success)
      return unavailable(
        "The selected publication has no valid cycle and review run key."
      )

    const keys =
      target.kind === "cycle" ? undefined : sectionsFor(packet, target)
    const destination = ReviewInformationReadQuery.shape.destination.safeParse({
      kind: "owned",
      sectionKeys: keys,
    })
    const ownable = target.kind !== "cycle" && destination.success
    const ownedBounds = {
      limit: Math.floor(page.limit / 2),
      detailsBytes: Math.floor(page.detailsBytes / 2),
    }
    const cycleBounds = {
      limit: page.limit - (ownable ? ownedBounds.limit : 0),
      detailsBytes:
        page.detailsBytes - (ownable ? ownedBounds.detailsBytes : 0),
    }
    const readPage = (
      bounds: Bounds,
      afterSeq: number,
      destination: NonNullable<ReviewInformationReadQuery["destination"]>
    ) =>
      Effect.map(
        ReviewInformation.read({
          ...identity.data,
          ...bounds,
          afterSeq,
          classifications: ["later-review-information", "unknown-ownership"],
          destination,
        }),
        (result): AvailablePage => ({
          status: "available",
          bounds,
          afterSeq,
          ...result,
        })
      )

    // Independent cursors: activity elsewhere cannot consume a selected unit's page. Invalid owned
    // targets still return the cycle's unassigned observations with the full unsplit allowance.
    const cycleUnassigned = yield* readPage(cycleBounds, page.cycleAfterSeq, {
      kind: "unassigned",
    })
    const owned =
      target.kind === "cycle"
        ? { status: "not-requested" as const }
        : ownable && destination.data
          ? yield* readPage(ownedBounds, page.ownedAfterSeq, destination.data)
          : unavailable(
              "The selected target has no readable, bounded stable owned-section keys in this packet."
            )

    return {
      status: "available",
      packetId: packet.eventId,
      ...identity.data,
      notice:
        "Attributed observations outside the frozen package; verification is not approval, resolution or an additional vote.",
      bounds: { limit: page.limit, detailsBytes: page.detailsBytes },
      owned,
      cycleUnassigned,
    } satisfies ReviewInformationView
  })
