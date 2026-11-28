import type { PublishedPackets, ReviewList } from "@neuve/records-core"
import type { RecordEvent } from "@neuve/records-schema"
import type { ReviewLane } from "@workspace/ui/neuve/types"

/*
 * The packet shapes the desk reads, and the one place it branches on them.
 * `PublishedPackets.readStanding`, `readExact` and `readRun` return either a
 * `packet.published@1` (its batches and units as `standingPacket` always
 * read them) or a `packet.published@2` (`ReadBatch`, `ReadUnit`: a unit's
 * lines in its sections blob, its sections joined with their judgements,
 * agents' comments at `comment.recorded@3`, its lineage). Title and owned
 * ranges read alike in both (the read model resolves a `unit.recorded@3`'s
 * ranges into today's form), and so does the lane (`judgement.lane`).
 * What differs is read in two files: here (the lane facts below, and
 * `readSections` / `isChain`), and in the projection, where `deskSections`
 * gives both shapes' sections one form, `citesOf` reads a version 4
 * checkpoint's citations, `gapsOf` picks a batch's gaps, the section rows
 * and the limitations' wording follow the shape, and a new-shape batch's
 * limitations show without a digest.
 */

/** A packet of either shape; a `standingPacket` read is the first. */
export type DeskPacket =
  PublishedPackets.StandingPacket | PublishedPackets.ReadPacket

/** A unit of either shape. */
export type DeskUnit = PublishedPackets.PacketUnit | PublishedPackets.ReadUnit

/** A batch of either shape, as far as the projection reads it. */
export interface DeskBatch extends Omit<PublishedPackets.PacketBatch, "units"> {
  readonly units: ReadonlyArray<DeskUnit>
  /** A `packet.published@2` batch's own gaps, frozen with it. */
  readonly gaps?: PublishedPackets.ReadBatch["gaps"]
}

/** A new-shape section: its identity, lines and judgement, joined by key. */
export type ReadSection = PublishedPackets.ReadSection

/** Whether a unit was recorded in the new shape (`unit.recorded@3`), whether or not its lines read. */
export const isNewShape = (unit: DeskUnit) =>
  unit.recorded?.kind === "unit.recorded@3"

/**
 * The unit's new-shape sections in line order: by where each starts (its
 * span), then its first owned line, then its key (the blob keeps them by
 * key). None for a `packet.published@1` unit.
 */
export const readSections = (unit: DeskUnit): ReadonlyArray<ReadSection> =>
  [
    ...(unit.sections ?? []).flatMap((section) =>
      "key" in section ? [section] : []
    ),
  ].sort(
    (a, b) =>
      startOf(a) - startOf(b) ||
      firstOwned(a) - firstOwned(b) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  )

/** A section's first owned line, on either side; a section with none sorts last. */
const firstOwned = (section: ReadSection) =>
  Math.min(
    Number.MAX_SAFE_INTEGER,
    ...section.ownedRanges.flatMap((range) =>
      range.kind === "lines" ? [range.startLine] : []
    )
  )

/** Where a section starts: its span's first line, else its first owned line. */
const startOf = (section: ReadSection) =>
  section.where?.startLine ?? firstOwned(section)

/** Whether the packet is one publication of a `packet.published@2` chain. */
export const isChain = (
  packet: DeskPacket
): packet is PublishedPackets.ReadPacketV2 =>
  "kind" in packet && packet.kind === "packet.published@2"

/**
 * The one place the projection asks a packet, a batch or a unit what the
 * desk says about its review lane beyond the lane itself: whether an agent
 * decided it, what lane it was in before, what the batch removes, and how
 * many batches are still to come. A `packet.published@1` holds none of it,
 * so every answer for one is the neutral one. The projection takes these as
 * a parameter, so its tests pass their own answers.
 */
export interface LaneFacts {
  /**
   * No agent decided any section of the unit in this run. The desk shows it
   * only on a human-required unit, and never its cause.
   */
  readonly noAgentDecision: (unit: DeskUnit) => boolean
  /** The IDs of the unit's sections no agent decided, when only some are. */
  readonly undecidedSections: (unit: DeskUnit) => ReadonlySet<string>
  /** No agent wrote the unit's title: the desk names it by file and lines. */
  readonly titledByCode: (unit: DeskUnit) => boolean
  /**
   * The highest review lane among the units this one succeeds (its
   * lineage). The projection keeps it only when it is lower than the unit's
   * own: that is a rise.
   */
  readonly raisedFrom: (unit: DeskUnit) => ReviewLane | undefined
  /** The review's batches not published yet. */
  readonly pendingBatches: (packet: DeskPacket) => number
  /** The same count for a review as the Reviews page lists it. */
  readonly listedPendingBatches: (review: ReviewList.ListedReview) => number
  /**
   * What the batch removes, disables or narrows: one sentence per finding,
   * in the agent's words with its local IDs still in (as the digest's other
   * parts are before the projection links them), and the unit it is on.
   */
  readonly removedSegments: (
    batch: DeskBatch
  ) => ReadonlyArray<{ readonly text: string; readonly unitId: string }>
  /**
   * A unit's facts (its sections) or findings (its comments), with what
   * removes, disables or narrows first and the rest in their order.
   */
  readonly removalFirst: <T extends { readonly id: string }>(
    unit: DeskUnit,
    facts: ReadonlyArray<T>
  ) => ReadonlyArray<T>
  /**
   * The decisions people made on an earlier unit whose sections are all
   * unchanged here, carried onto this one (`disposition.carried@1` by a
   * person), oldest first. One of them is the standing decision when
   * `judgement.standing.eventId` names it.
   */
  readonly carriedDecisions: (unit: DeskUnit) => ReadonlyArray<CarriedDecision>
  /**
   * Why no agent read the unit, when a section of it is marked excluded: a
   * lockfile, a file the repository declares generated, or another mark
   * Records gives. Such a unit is
   * not read, never approved by the mark, and never waits on a person.
   */
  readonly excluded: (unit: DeskUnit) => Exclusion | undefined
}

/** Why the review read none of a unit (`sections[n].excluded.reason`), an open set. */
export interface Exclusion {
  readonly reason: string
}

/** A person's decision carried onto a unit from an earlier one. */
export type CarriedDecision = Extract<
  RecordEvent,
  { kind: "disposition.carried@1" }
>

const NONE: ReadonlySet<string> = new Set()

/** Records' lane names in the desk's. */
const LANE: Partial<Record<string, ReviewLane>> = {
  "human-required": "human-required",
  "human-suggested": "human-suggested",
  agentic: "agentic-review",
  "static-automation": "static-automation",
}

const LANE_ORDER: ReadonlyArray<ReviewLane> = [
  "human-required",
  "human-suggested",
  "agentic-review",
  "static-automation",
]

/** The effects the desk leads with (13.19); `changed` and `added` keep their place. */
const REMOVAL: ReadonlySet<string> = new Set([
  "removed",
  "disabled",
  "narrowed",
])

type Comment = DeskUnit["comments"][number]

/** An agent's impact finding that removes, disables or narrows. */
const removes = (comment: Comment) =>
  comment.kind === "comment.recorded@3" &&
  comment.payload.finding?.kind === "impact" &&
  REMOVAL.has(comment.payload.finding.effect ?? "")

/** Whether a comment's lines fall in a section: on lines it owns, or inside its span. */
const onSection = (comment: Comment, section: ReadSection) => {
  const anchor = comment.payload.anchor
  if (anchor === undefined) return false
  const owned = section.ownedRanges.some(
    (range) =>
      range.kind === "lines" &&
      range.path === anchor.path &&
      range.side === anchor.side &&
      anchor.startLine <= range.endLine &&
      anchor.endLine >= range.startLine
  )
  if (owned) return true
  // Inside its span, on the side `parts.side` names; a section with no span
  // (`none`), or a blob that names no side, is placed by its lines alone.
  return (
    section.where !== null &&
    section.parts.path === anchor.path &&
    section.parts.side === anchor.side &&
    anchor.startLine >= section.where.startLine &&
    anchor.endLine <= section.where.endLine
  )
}

/** A section whose own review raised a removal among its impact findings. */
const raisesRemoval = (section: ReadSection) =>
  (section.impact ?? []).some((entry) => REMOVAL.has(entry.effect))

/**
 * What leads a unit's lists: its impact findings that remove, disable or
 * narrow (by comment ID), and the sections they are on or whose own review
 * raised one (by section key).
 */
const leading = (unit: DeskUnit): ReadonlySet<string> => {
  const comments = unit.comments.filter(removes)
  const sections = readSections(unit).filter(
    (section) =>
      raisesRemoval(section) ||
      comments.some((comment) => onSection(comment, section))
  )
  if (comments.length === 0 && sections.length === 0) return NONE
  return new Set([
    ...comments.map((comment) => comment.id),
    ...sections.map((section) => section.key),
  ])
}

/** A unit is excluded when any section is marked, with lockfiles first. */
export const excludedSections = (
  sections: ReadonlyArray<Pick<ReadSection, "excluded">>
): Exclusion | undefined => {
  const reasons = sections.flatMap((section) => {
    const reason: unknown = section.excluded?.reason
    return typeof reason === "string" ? [reason] : []
  })
  const reason = reasons.includes("lockfile") ? "lockfile" : reasons.at(0)
  return reason === undefined ? undefined : { reason }
}

export const LANE_FACTS: LaneFacts = {
  // Presence of `sections[n].undecided` on every section of a version 4
  // assessment (the cause is never read). When the sections or their
  // judgements did not read, the assessment's own counts say it.
  noAgentDecision: (unit) => {
    if (unit.assessment?.kind !== "assessment.recorded@4") return false
    const sections = readSections(unit)
    if (
      sections.length > 0 &&
      sections.every((section) => section.lane !== undefined)
    )
      return sections.every((section) => section.undecided !== undefined)
    const { count, undecided } = unit.assessment.payload.sections
    return Object.values(undecided).reduce((sum, n) => sum + n, 0) >= count
  },
  // The keys of the sections whose `sections[n].undecided` is present.
  undecidedSections: (unit) => {
    const keys = readSections(unit)
      .filter((section) => section.undecided !== undefined)
      .map((section) => section.key)
    return keys.length === 0 ? NONE : new Set(keys)
  },
  // `unit.recorded@3.payload.titleBy`: "code" means no agent wrote the
  // title. A `unit.recorded@2` has no such field; an unassessed one is still
  // named by its file and lines (`untitledOf`).
  titledByCode: (unit) =>
    unit.recorded?.kind === "unit.recorded@3" &&
    unit.recorded.payload.titleBy === "code",
  // The highest of the unit's `lineage.from[].lane` among earlier reviews'
  // units; an earlier unit with no lane (`null`) says nothing, and nor does
  // one of the same review (`cycleId` the lineage event's own): a review
  // published again in its cycle is not where the unit came from.
  raisedFrom: (unit) => {
    const lineage = "lineage" in unit ? unit.lineage : undefined
    const own = lineage?.attribution.cycleId
    return (lineage?.payload.from ?? []).reduce<ReviewLane | undefined>(
      (highest, entry) => {
        const lane =
          entry.lane === null || entry.cycleId === own
            ? undefined
            : LANE[entry.lane]
        return lane !== undefined &&
          (highest === undefined ||
            LANE_ORDER.indexOf(lane) < LANE_ORDER.indexOf(highest))
          ? lane
          : highest
      },
      undefined
    )
  },
  // `counts.pending.batches` of a `packet.published@2`; a
  // `packet.published@1` is published whole, once.
  pendingBatches: (packet) =>
    isChain(packet) ? packet.counts.pending.batches : 0,
  // `ListedReview.pendingBatches`, 0 for a `packet.published@1`.
  listedPendingBatches: (review) => review.pendingBatches ?? 0,
  // The batch's units' `comment.recorded@3` impact findings whose
  // `finding.effect` is removed, disabled or narrowed: its one-line
  // `finding.summary` (the body stays the full comment, on the unit), and
  // the first of the batch's units it is on. A finding on several units is
  // said once.
  removedSegments: (batch) => {
    const seen = new Set<string>()
    return batch.units.flatMap((unit) =>
      unit.comments.flatMap((comment) => {
        const summary =
          comment.kind === "comment.recorded@3"
            ? comment.payload.finding?.summary
            : undefined
        if (!removes(comment) || summary === undefined || seen.has(comment.id))
          return []
        seen.add(comment.id)
        return [{ text: summary, unitId: unit.unitId }]
      })
    )
  },
  // Such a finding before the others, and the section it is on (or whose
  // own review raised one) before the unit's other sections.
  removalFirst: (unit, facts) => {
    const first = leading(unit)
    if (first.size === 0) return facts
    return [
      ...facts.filter((entry) => first.has(entry.id)),
      ...facts.filter((entry) => !first.has(entry.id)),
    ]
  },
  // `ReadUnit.carriedDecisions`: the `disposition.carried@1` events by
  // people on the unit, oldest first. None for a `packet.published@1` unit.
  carriedDecisions: (unit) =>
    "carriedDecisions" in unit ? unit.carriedDecisions : [],
  excluded: (unit) => excludedSections(readSections(unit)),
}
