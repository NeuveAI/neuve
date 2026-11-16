import { UNDECIDED_GAP_PREFIX, phraseLinks } from "@neuve/records-schema"
import type {
  OwnedRange,
  RecordEvent,
  ReviewOrigin,
} from "@neuve/records-schema"
import { Checkpoints } from "@neuve/records-core"
import type { PublishedPackets } from "@neuve/records-core"
import { STANCE_LABEL } from "@workspace/ui/neuve/review-desk/reference-tie"
import { undecidedRow } from "@workspace/ui/neuve/review-desk/briefing-rows"
import {
  MARKER_KIND_LABEL,
  citationName,
  linesName,
} from "@workspace/ui/neuve/citation-name"
import type {
  DeliveryCheckpoint,
  DeliveryCriterion,
  DeliveryCriterionStatus,
  DeliveryEvidence,
  DeliveryPayload,
  DeliveryStop,
} from "@workspace/ui/neuve/shared/delivery"
import {
  explainedShows,
  rowExplained,
} from "@workspace/ui/neuve/shared/explained-rule"
import type { ReviewCommentRecord } from "@workspace/ui/neuve/review-comments/record"
import type {
  AgentRegistry,
  BatchOverviewData,
  BatchUnit,
  BranchAgent,
  BriefingSection,
  BriefingSegment,
  ContextualMarker,
  DecidedUnit,
  DeskBatchContext,
  DiffFile,
  DigestObligation,
  DiffSide,
  ElsewhereLane,
  ExplainedText,
  JudgmentUnit,
  LaneSummary,
  LaneUnit,
  LineageReviewActor,
  LineRange,
  MarkerAnchor,
  MarkerTone,
  OverviewUnit,
  OwnedChangedSource,
  RailUnit,
  ReviewBatches,
  ReviewDeskData,
  ReferenceTie,
  ReviewLane,
  Reviewer,
  UnitAttribution,
  UnitCheckpoints,
  UnitLevelComment,
  UntitledFile,
} from "@workspace/ui/neuve/types"

import { LANE_FACTS, isChain, isNewShape, readSections } from "./lane-facts"
import type {
  CarriedDecision,
  DeskBatch,
  DeskPacket,
  DeskUnit,
  LaneFacts,
} from "./lane-facts"

/**
 * The BFF's projection (M5 RD4, 1.7): Records' standing packet, as
 * records-core's read model returns it (`readStanding`, either packet
 * shape), mapped onto the screens' existing shapes. It maps names and shapes
 * only. Which packet stands, what a local ID points to, a unit's lane and
 * closure and whose verdict stands all come from the read model; git
 * supplies the file contents. Every item keeps the Records event ID it came
 * from (a marker's key is its reference's event ID, a comment record's ID is
 * its comment's), so later slices attach to it. Where the two packet shapes
 * differ it reads them through `lane-facts.ts` and `deskSections`.
 *
 * Pure: the page loads (desk.server.ts) and the Storybook fixture's
 * generator (scripts/real-packet-fixture.ts) both call it.
 */

type Packet = DeskPacket
type Batch = DeskBatch
type Unit = DeskUnit
type Citations = PublishedPackets.Citations
type Of<TKind extends RecordEvent["kind"]> = Extract<
  RecordEvent,
  { kind: TKind }
>
type Reference = Of<"context.referenced@2">
type CommentEvent = Of<
  "comment.recorded@2" | "comment.recorded@3" | "comment.carried@1"
>
type Lane = NonNullable<Unit["judgement"]["lane"]>
/** A unit's checkpoint: a version 4 assessment's carries its section's key. */
type Checkpoint = Unit["checkpoints"][number]
/** A checkpoint's citations: a ref and entry, or a section's local ID alone. */
type Cite = { readonly ref?: string; readonly entry?: string }

const citesOf = (checkpoint: Checkpoint): ReadonlyArray<Cite> =>
  checkpoint.cites.map((cite: string | Cite) =>
    typeof cite === "string" ? { entry: cite } : cite
  )

/**
 * A unit's separate changes (10.109) in one form for both shapes: the
 * assembled batch's sections for a `packet.published@1` unit, with their own
 * content where it keeps it, or a `unit.recorded@3`'s sections by key. The
 * desk names a section by this ID.
 */
export interface DeskSection {
  readonly id: string
  readonly title: string
  readonly ownedRanges: ReadonlyArray<
    PublishedPackets.Sections[number]["ownedRanges"][number] | OwnedRange
  >
  readonly content?: SectionContent | undefined
}

export const deskSections = (unit: Unit): ReadonlyArray<DeskSection> => {
  // A new-shape unit's in line order (`readSections`); an old-shape unit's
  // in the order Assemble wrote them.
  const read = readSections(unit)
  if (read.length > 0)
    return read.map((section) => ({
      id: section.key,
      title: section.title,
      ownedRanges: section.ownedRanges,
      content: section.content,
    }))
  return (unit.sections ?? []).flatMap((section) =>
    "key" in section ? [] : [section]
  )
}

/** The range a cycle reviews, from its `cycle.opened@1`. */
export interface ReviewRange {
  readonly display?: ReviewOrigin["display"]
  readonly baseRef: string
  readonly baseOid: string
  readonly headOid: string
}

/** One changed file as git holds it at the range's merge base and head. */
export interface SourceFile {
  readonly path: string
  readonly oldPath: string | null
  readonly newPath: string | null
  readonly binary: boolean
  readonly oldContents: string
  readonly newContents: string
  readonly hunks: ReadonlyArray<{
    readonly oldStart: number
    readonly oldLines: number
    readonly newStart: number
    readonly newLines: number
    readonly text: string
    readonly added: number
    readonly deleted: number
    /** The lines the hunk changes on each side, from the shared review rules. */
    readonly changed: ReadonlyArray<{
      readonly side: "old" | "new"
      readonly startLine: number
      readonly lineCount: number
    }>
  }>
}

/** A hunk's place on each side, as git's diff gives it. */
export interface HunkHeader {
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
}

/** Git's hunks of listed units' files, by old and by new path: what a hunk count reads. */
export type HunkHeaders = Readonly<
  Partial<Record<string, ReadonlyArray<HunkHeader>>>
>

/** What git holds for a unit's files and its references' cited lines (tracked work only, 10.34). */
export interface Sources {
  readonly mergeBase: string
  readonly head: string
  /** By old and by new path. */
  readonly files: Readonly<Partial<Record<string, SourceFile>>>
  /**
   * Git's hunks of every file the batch's listed units own lines in (the
   * rail's), so each unit's count is read as the open unit's is. Absent, the
   * open unit's `files` are the only ones read.
   */
  readonly hunks?: HunkHeaders
  /** A cited blob's lines, by blob OID. */
  readonly blobs: Readonly<Partial<Record<string, ReadonlyArray<string>>>>
}

/** A person Records knows as a registered human, for their name on comments. */
export interface Person {
  readonly actor: string
  readonly name: string
  readonly initials: string
}

/** A current disposition by a person, as `judge` reads it (closing or held as context). */
export interface HumanDisposition {
  readonly eventId: string
  readonly unitId: string
  readonly actorId: string
  readonly verdict: "approve" | "request-changes"
}

/** People's review work on the batch, read from Records beside the packet. */
export interface HumanWork {
  readonly viewer: Person | undefined
  readonly people: Readonly<Partial<Record<string, Person>>>
  /** Current human dispositions on the batch's units. */
  readonly dispositions: ReadonlyArray<HumanDisposition>
  /** People's comments on the unit on screen (the packet holds the agent's). */
  readonly comments: ReadonlyArray<CommentEvent>
  /** The log's sequence when this was read: the comments' snapshot. */
  readonly sequence: number
  /** People's standing decisions on earlier versions of the unit on screen (14.12). */
  readonly earlier?: ReadonlyArray<EarlierWork>
  /**
   * A person's fresh decision standing on the unit on screen, as Records
   * holds it: its verdict and the comments a request for changes rests on.
   */
  readonly standing?: {
    readonly verdict: "approve" | "request-changes"
    readonly restsOn: ReadonlyArray<string>
  }
}

/** A person's standing decision on an earlier unit a changed unit's lineage names. */
export interface EarlierWork {
  readonly actorId: string
  readonly verdict: "approve" | "request-changes"
  /** The head the decision reviewed: the earlier review's. */
  readonly head: string
}

/**
 * People's current dispositions on the batch's units, as records-core's
 * `judge` reads them (closing or held as context). The one rule for whether a
 * person has decided a unit, for the desk and the overview alike: a retracted
 * disposition, or one from an earlier cycle, is not current there (4.13).
 */
export const humanDispositions = (
  units: ReadonlyArray<Unit>
): Array<HumanDisposition> =>
  units.flatMap((unit) =>
    [...unit.judgement.closing, ...unit.judgement.context]
      .filter((disposition) => disposition.actorKind === "human")
      .map((disposition) => ({
        eventId: disposition.eventId,
        unitId: disposition.unitId,
        actorId: disposition.actorId,
        verdict: disposition.verdict,
      }))
  )

/** A person's decision that stands on a unit, fresh or carried. */
export interface PersonDecision {
  readonly eventId: string
  readonly actorId: string
  readonly verdict: "approve" | "request-changes"
  /**
   * Set when it was carried from an earlier review whose sections are all
   * unchanged here: the carried label (the earlier review's short head).
   */
  readonly carried?: string
}

/**
 * The person's decision that stands on a unit, as records-core's judgement
 * reads it (`judgement.standing` by a human), fresh or carried onto it from
 * an earlier unit with the same sections. The one rule for whether a person
 * has decided a unit, for every place the desk asks it: the overview's
 * "Needs your decision" and counts, the header's batch menu, the rail's
 * meter, and the decided rows. A decision the person makes on the unit
 * itself after a carried one is newer and stands instead, with no mark.
 */
export const personDecision = (
  unit: Unit,
  facts: LaneFacts = LANE_FACTS
): PersonDecision | undefined => {
  const standing = unit.judgement.standing
  if (standing?.actorKind !== "human") return undefined
  const carried = facts
    .carriedDecisions(unit)
    .find((event) => event.id === standing.eventId)
  return {
    eventId: standing.eventId,
    actorId: standing.actorId,
    verdict: standing.verdict,
    ...(carried ? { carried: carriedLabel(carried.payload.from) } : {}),
  }
}

/**
 * The person's decisions carried onto a unit that still stand: those
 * Records' judgement holds current (closing or held as context). One the
 * person retracted (Undo), or decided again since, no longer does, and the
 * unit is theirs to decide again like any other.
 */
export const standingCarried = (
  unit: Unit,
  facts: LaneFacts = LANE_FACTS
): ReadonlyArray<CarriedDecision> => {
  const current = new Set(
    [...unit.judgement.closing, ...unit.judgement.context].map(
      (disposition) => disposition.eventId
    )
  )
  return facts.carriedDecisions(unit).filter((event) => current.has(event.id))
}

/**
 * Whether a unit is the rail's "Decided" group's: it arrived with a
 * person's decision carried onto it, and a person's decision, carried or
 * fresh, still stands on it.
 */
const arrivedDecided = (unit: Unit, facts: LaneFacts) =>
  facts.carriedDecisions(unit).length > 0 &&
  personDecision(unit, facts) !== undefined

/** A person's decision as a review mark: who, the verdict, and the carried label. */
const personReviewOf = (
  decision: PersonDecision,
  people: HumanWork["people"],
  viewer: Person | undefined
) => ({
  actor: {
    kind: "person" as const,
    person: reviewerOf(
      people[decision.actorId] ?? {
        actor: decision.actorId,
        name: "Reviewer",
        initials: "?",
      }
    ),
    isYou: decision.actorId === viewer?.actor,
  },
  verdict:
    decision.verdict === "approve"
      ? ("approved" as const)
      : ("changes_requested" as const),
  ...(decision.carried ? { carried: decision.carried } : {}),
})

/** What the overview needs of people's work: who views, who decided, and their names. */
export type OverviewPeople = Pick<
  HumanWork,
  "viewer" | "people" | "dispositions"
> & {
  /**
   * No person's work is counted or shown, though Records' judgement holds
   * it: the batch as the review published it (`NO_PEOPLE`).
   */
  readonly withoutPeople?: true
}

/** No person's work: the batch as the review published it. */
export const NO_PEOPLE: OverviewPeople = {
  viewer: undefined,
  people: {},
  dispositions: [],
  withoutPeople: true,
}

export interface PacketContext {
  /** The repository's name, as the header shows it. */
  readonly repo: string
  readonly range: ReviewRange
  readonly packet: Packet
  readonly batch: Batch
  /** Whether this is the newest review, the one `/` opens. */
  readonly newest?: boolean
  /**
   * Whether a run of this review is going or queued, when the load read it
   * (it does only while batches are pending).
   */
  readonly runGoing?: boolean
  /** Git's hunks of the batch's listed units' files, when the load read them (`hunkCount`). */
  readonly hunks?: HunkHeaders
}

/* ── Names ─────────────────────────────────────────────── */

const LANE: Record<Lane, ReviewLane> = {
  "static-automation": "static-automation",
  agentic: "agentic-review",
  "human-suggested": "human-suggested",
  "human-required": "human-required",
}

const LANE_ORDER: ReadonlyArray<ReviewLane> = [
  "human-required",
  "human-suggested",
  "agentic-review",
  "static-automation",
]

const LANE_NAME: Record<ReviewLane, string> = {
  "human-required": "Human-required",
  "human-suggested": "Human-suggested",
  "agentic-review": "Agentic review",
  "static-automation": "Static automation",
}

/** The rail's group labels: the review lanes' names in full. */
const RAIL_LABEL: Record<Exclude<ReviewLane, "human-required">, string> = {
  "human-suggested": "Human-suggested",
  "agentic-review": "Agentic review",
  "static-automation": "Static automation",
}

/** Records' marker kinds onto the margin's identity (design/neuve-web/context-markers.md). */
const TONE: Record<Reference["payload"]["markerKind"], MarkerTone> = {
  conflict: "conflict",
  "decision-signal": "decision",
  "failed-check": "failed",
  "assessment-gap": "gap",
  "unavailable-evidence": "unavailable",
  "same-batch": "batch",
  "contextual-signal": "signal",
  test: "test",
  "captured-source": "source",
  graph: "graph",
  history: "history",
  doc: "doc",
}

/** The card's L2 kind label, which already carries status (context-markers.md, Kinds). */
const KIND_LABEL: Record<MarkerTone, string> = {
  conflict: "Conflict",
  decision: "Recorded decision signal",
  failed: "Failed or invalidated check",
  gap: "Reported assessment gap",
  unavailable: "Linked evidence unavailable",
  comment: "Comment",
  batch: "Same batch · unreviewed",
  signal: "Contextual signal",
  test: "Test",
  source: "Captured source",
  graph: "Graph · blast radius",
  history: "Unit history",
  doc: "Doc",
  checkpoint: "Checkpoint",
}

const SHEET_KIND: Record<MarkerTone, string> = {
  conflict: "Code",
  decision: "Code",
  failed: "Test",
  gap: "Code",
  unavailable: "Code",
  comment: "Comment",
  batch: "Code",
  signal: "Code",
  test: "Test",
  source: "Code",
  graph: "Graph",
  history: "History",
  doc: "Doc",
  checkpoint: "Checkpoint",
}

const short = (oid: string) => oid.slice(0, 7)

const sideOf = (side: string): DiffSide =>
  side === "old" ? "deletions" : "additions"

/**
 * A unit's current lane as records-core's judgement reads it (a unit the
 * review never assessed already reads as human-suggested there, 10.100).
 * Records gives no lane only for a unit it holds no record of: such a unit
 * is in no lane here either.
 */
export const laneOf = (unit: Unit): ReviewLane | undefined =>
  unit.judgement.lane === null ? undefined : LANE[unit.judgement.lane]

/**
 * What a unit's row says about its review lane beyond the lane (the seam's
 * answers, `lane-facts.ts`): no agent decision only on human-required work,
 * and an earlier lane only when it is lower than this one, which is a rise.
 */
const unitLaneFacts = (
  unit: Unit,
  lane: ReviewLane,
  facts: LaneFacts
): { noAgentDecision?: true; raisedFrom?: ReviewLane } => {
  const earlier = facts.raisedFrom(unit)
  return {
    ...(lane === "human-required" && facts.noAgentDecision(unit)
      ? { noAgentDecision: true as const }
      : {}),
    ...(earlier !== undefined &&
    LANE_ORDER.indexOf(earlier) > LANE_ORDER.indexOf(lane)
      ? { raisedFrom: earlier }
      : {}),
  }
}

/**
 * The words the harness's code title writes after a file's name when the
 * file has more than one unit (`codeTitle` in
 * packages/harness/src/publish-sections-input.ts), so two units of one file
 * never share a stored title: "projects.ts (human required): checkout".
 */
const LANE_WORDS: Record<Lane, string> = {
  "static-automation": "static automation",
  agentic: "agentic",
  "human-suggested": "human suggested",
  "human-required": "human required",
}

/**
 * A title without its unit's own lane label: ` (<lane words>)` right after
 * the name of one of the unit's files at the title's start, followed by the
 * title's end or ": ". The desk says the lane already (the track in the
 * rail, the eyebrow above the heading). Another lane's words, or any other
 * parenthesis, stay.
 */
export const withoutLaneLabel = (
  title: string,
  lane: Lane | null,
  paths: ReadonlyArray<string>
) => {
  if (lane === null) return title
  for (const path of paths) {
    const file = path.slice(path.lastIndexOf("/") + 1) || path
    const head = `${file} (${LANE_WORDS[lane]})`
    if (title === head || title.startsWith(`${head}: `))
      return `${file}${title.slice(head.length)}`
  }
  return title
}

const storedTitle = (unit: Unit) => unit.recorded?.payload.title ?? unit.local

/**
 * Every unit's title as the desk shows it, by unit ID: its stored title
 * without its lane label (`withoutLaneLabel`), except where that would give
 * it the title of another unit of the batch whose stored title differs (two
 * units of one file in different lanes, each titled by the file alone):
 * those keep their stored titles, so the label still tells them apart.
 */
export const shownTitles = (
  units: ReadonlyArray<Unit>
): ReadonlyMap<string, string> => {
  const stripped = new Map(
    units.map((unit) => [
      unit.unitId,
      unit.recorded
        ? withoutLaneLabel(
            unit.recorded.payload.title,
            unit.judgement.lane,
            unitPaths(unit)
          )
        : unit.local,
    ])
  )
  const storedBy = new Map<string, Set<string>>()
  for (const unit of units) {
    const shown = stripped.get(unit.unitId) ?? storedTitle(unit)
    storedBy.set(
      shown,
      (storedBy.get(shown) ?? new Set()).add(storedTitle(unit))
    )
  }
  return new Map(
    units.map((unit) => {
      const shown = stripped.get(unit.unitId) ?? storedTitle(unit)
      return [
        unit.unitId,
        (storedBy.get(shown)?.size ?? 1) > 1 ? storedTitle(unit) : shown,
      ]
    })
  )
}

const SHOWN_TITLES = new WeakMap<
  ReadonlyArray<Unit>,
  ReadonlyMap<string, string>
>()

/**
 * A unit's title wherever the desk and the overview show it (heading, tab,
 * rail, overview, digest, markers, notes): `shownTitles` of its batch.
 */
const titleOf = (batch: Pick<Batch, "units">, unit: Unit) => {
  const known = SHOWN_TITLES.get(batch.units) ?? shownTitles(batch.units)
  SHOWN_TITLES.set(batch.units, known)
  return known.get(unit.unitId) ?? storedTitle(unit)
}

/**
 * The lane words a unit's shown title leaves out, when it leaves them out:
 * a place that says no lane says them after the title to screen readers.
 */
const laneWordsOf = (batch: Pick<Batch, "units">, unit: Unit) =>
  unit.judgement.lane !== null && titleOf(batch, unit) !== storedTitle(unit)
    ? LANE_WORDS[unit.judgement.lane]
    : undefined

/**
 * Records' words about the batch's units with each unit the text names
 * (`unitIds`) by its shown title: a gap's detail quotes its unit's stored
 * title.
 */
const namedAsShown = (
  batch: Pick<Batch, "units">,
  text: string,
  unitIds: ReadonlyArray<string>
) =>
  batch.units
    .filter((unit) => unitIds.includes(unit.unitId))
    .reduce((said, unit) => {
      const stored = storedTitle(unit)
      const shown = titleOf(batch, unit)
      return stored === shown ? said : said.split(stored).join(shown)
    }, text)

const initialsOf = (name: string) => {
  const words = name
    .replace(/@.*$/, "")
    .split(/[\s._-]+/)
    .filter((word) => word !== "")
  const letters = (
    words.length > 1
      ? `${(words.at(0) ?? "").charAt(0)}${(words.at(-1) ?? "").charAt(0)}`
      : (words[0] ?? "?").slice(0, 2)
  ).toUpperCase()
  return letters === "" ? "?" : letters
}

export const personFrom = (
  actor: string,
  registration: { displayName?: string | undefined; email?: string | undefined }
): Person => {
  const name = registration.displayName ?? registration.email ?? "Reviewer"
  return { actor, name, initials: initialsOf(name) }
}

export const reviewerOf = (person: Person): Reviewer => ({
  id: person.actor,
  name: person.name,
  initials: person.initials,
})

/**
 * The agent whose review a unit carries. Records names it by actor; the
 * agents control stays empty in M5 (open point 8), so the review mark draws
 * it from this identity alone.
 */
const agentReviewer = (
  actor: string,
  agents: Map<string, Pick<BranchAgent, "id" | "short" | "name" | "role">>
) => {
  const known = agents.get(actor)
  if (known) return known
  const index = agents.size + 1
  const agent = {
    id: actor,
    short: `R${index}`,
    name: `Reviewer ${index}`,
    role: "reviewer" as const,
  }
  agents.set(actor, agent)
  return agent
}

/** Every agent that reviewed a unit of the batch, numbered in unit order. */
const batchReviewers = (batch: Batch) => {
  const agents = new Map<
    string,
    Pick<BranchAgent, "id" | "short" | "name" | "role">
  >()
  for (const unit of batch.units) {
    const actor = unit.disposition?.actor ?? unit.comments.at(0)?.actor
    if (actor !== undefined) agentReviewer(actor, agents)
  }
  return agents
}

const EMPTY_AGENTS: AgentRegistry = {
  agents: [],
  configured: [],
  connections: {},
}

/* ── Citations ─────────────────────────────────────────── */

type Resolution = NonNullable<PublishedPackets.CitedId["resolution"]>

const resolutions = (citations: Citations) =>
  new Map(
    citations.cited.flatMap((cited) =>
      cited.resolution === undefined ? [] : [[cited.id, cited.resolution]]
    )
  )

/** A hunk's lines on the side a reader lands on: the new side when it has one. */
const hunkRange = (
  resolution: Extract<Resolution, { kind: "hunk" }>
): LineRange | undefined => {
  const lines = resolution.ranges.filter(
    (range) => range.startLine !== undefined && range.endLine !== undefined
  )
  const chosen = lines.find((range) => range.side === "new") ?? lines.at(0)
  if (chosen?.startLine === undefined || chosen.endLine === undefined)
    return undefined
  return {
    start: chosen.startLine,
    end: chosen.endLine,
    side: sideOf(chosen.side),
  }
}

/**
 * Every range a hunk's lines run on, on one side: a hunk split between
 * sections resolves to each section's lines (Records' `ownResolution`).
 */
const hunkLines = (
  resolution: Extract<Resolution, { kind: "hunk" }>,
  side: DiffSide
): Array<LineRange> =>
  resolution.ranges.flatMap((range) =>
    range.startLine !== undefined &&
    range.endLine !== undefined &&
    sideOf(range.side) === side
      ? [{ start: range.startLine, end: range.endLine, side }]
      : []
  )

/** What a unit's content can point at on its own desk. */
interface DeskTargets {
  /** The unit's files on screen, by path. */
  readonly paths: ReadonlySet<string>
  /** The unit's markers, by reference event ID. */
  readonly markers: Readonly<Partial<Record<string, ContextualMarker>>>
  /** Extra markers a citation chip opens in the source sheet (cited hunks). */
  readonly extra: Record<string, ContextualMarker>
  readonly sources: Sources | undefined
  /**
   * Where the margin draws the unit's markers, by path: the desk's own
   * anchors (`deskData`), so a phrase's chip names a pin the reader sees.
   */
  readonly anchors?: ReadonlyMap<string, ReadonlyArray<MarkerAnchor>>
}

/** A cited hunk as a source the chip opens in the sheet: the code itself. */
const hunkMarker = (
  id: string,
  resolution: Extract<Resolution, { kind: "hunk" }>,
  range: LineRange,
  sources: Sources | undefined,
  revision: string
): ContextualMarker => {
  const file = sources?.files[resolution.path]
  const contents =
    range.side === "deletions" ? file?.oldContents : file?.newContents
  const lines = (contents ?? "").split("\n")
  const code = lines.slice(range.start - 1, range.end).map((text, offset) => ({
    number: range.start + offset,
    text,
    cited: true,
  }))
  const where = `${resolution.path} · ${linesName(range)}`
  return {
    key: `hunk:${id}`,
    tone: "source",
    short: MARKER_KIND_LABEL.source,
    target: resolution.path,
    peek: where,
    kindLabel: "Source · this change",
    title: resolution.path,
    meta: where,
    quote: code.map((line) => line.text).join("\n"),
    excerpt: { kind: "code", code: code.map((line) => line.text).join("\n") },
    applies: "The changed lines the briefing cites.",
    source: {
      kind: "Code",
      chips: [],
      title: resolution.path,
      subtitle: `${resolution.path} · ${short(revision)}`,
      path: resolution.path,
      actions: [{ kind: "copy-path", path: resolution.path }],
      facts: [],
      blocks:
        code.length > 0
          ? [
              {
                kind: "code",
                lines: code,
                caption: codeCaption(
                  range,
                  range.side === "deletions"
                    ? "before this change"
                    : "after this change"
                ),
              },
            ]
          : [],
      citedBy: ["This unit"],
    },
  }
}

/**
 * A joined unit's briefing by change (10.109), for the merged briefing the
 * owner approved on 25 October: Assemble writes a lead, then one paragraph
 * per section that opens with the section's title and ": ". Matched against
 * the packet's own section titles, in their order; a briefing of any other
 * shape stays whole.
 */
export const briefingBySection = (
  text: string,
  sections: ReadonlyArray<{ id: string; title: string }>
):
  | {
      lead: string
      sections: Array<{ id: string; title: string; text: string }>
    }
  | undefined => {
  // Line endings as written on any platform: a CRLF never reaches a claim.
  const paragraphs = text.replace(/\r\n?/g, "\n").split(/\n[^\S\n]*\n\s*/)
  if (sections.length < 2 || paragraphs.length !== sections.length + 1)
    return undefined
  const claims = sections.map((section, i) => {
    const paragraph = paragraphs[i + 1]
    const prefix = `${section.title}: `
    return paragraph.startsWith(prefix)
      ? {
          id: section.id,
          title: section.title,
          text: paragraph.slice(prefix.length),
        }
      : undefined
  })
  if (claims.some((claim) => claim === undefined)) return undefined
  return {
    lead: paragraphs[0],
    sections: claims as Array<{ id: string; title: string; text: string }>,
  }
}

/**
 * A joined unit's briefing by change: the lead, and each section's claim with
 * its own content where the packet keeps it (pipeline 10: the claim is its
 * Briefed, else its Facts, as Assemble writes the unit's). Older packets fall
 * back to the split by title, and any other shape stays whole.
 */
export const joinedBriefing = (
  text: string,
  sections: ReadonlyArray<{
    id: string
    title: string
    content?: SectionContent | undefined
  }>
):
  | {
      lead: string
      sections: Array<{
        id: string
        title: string
        claim: string
        content?: SectionContent
      }>
    }
  | undefined => {
  const contents = sections.map((section) => section.content)
  if (sections.length > 1 && contents.every((content) => content)) {
    const paragraphs = text.replace(/\r\n?/g, "\n").split(/\n[^\S\n]*\n\s*/)
    return {
      lead: paragraphs[0] ?? "",
      sections: sections.map((section, i) => {
        const content = contents[i]!
        return {
          id: section.id,
          title: section.title,
          claim: content.briefed ?? content.facts.text,
          content,
        }
      }),
    }
  }
  const split = briefingBySection(text, sections)
  return (
    split && {
      lead: split.lead,
      sections: split.sections.map((section) => ({
        id: section.id,
        title: section.title,
        claim: section.text,
      })),
    }
  )
}

/** A `[phrase]` cut before "…", not after a word (code's `a[i]…` stays). */
const CUT_AFTER_PHRASE = /(?<![\w)\]])\[([^[\]\n]+)\](?=…)/g
/** The same, or at the text's end. */
const CUT_AFTER_PHRASE_AT_END = /(?<![\w)\]])\[([^[\]\n]+)\](?=…|\s*$)/g

/**
 * Words around links, with no link markup left:
 * - a link the parser could not read (a phrase or an ID too long, a space
 *   in its ID, an empty phrase) reads as its phrase, an empty one as
 *   nothing;
 * - a link cut inside its target ("[phrase](h1.e…") reads as its phrase;
 * - a link cut just after its phrase ("[phrase]" at the text's end, or
 *   before "…") reads as its phrase;
 * - a `[` that opens no link (a writer's cut, "… are [delegated…") reads
 *   without the bracket.
 * A bracketed word with no target in running text ("[x]") and code's
 * brackets ("string[]", "handlers[key](a, b)") are not link markup and
 * stay. `atEnd`: these words end the text.
 */
const withoutLinkMarkup = (text: string, atEnd: boolean) =>
  text
    .replace(/[^\S\n]?(?<![\w)\]])\[\]\([^()\n]*\)/g, "")
    .replace(/(?<![\w)\]])\[([^[\]\n]+)\]\([^()\n]*\)/g, "$1")
    .replace(/(?<![\w)\]])\[([^[\]\n]*)\]\((?![^)\s]*\))[^)\s]*/g, "$1")
    .replace(atEnd ? CUT_AFTER_PHRASE_AT_END : CUT_AFTER_PHRASE, "$1")
    .replace(/\[(?=[^\]\n]*(?:\n|$))/g, "")

/** A run of plain words, or a complete `[phrase](id)` link. */
type LinkPiece =
  { kind: "text"; text: string } | { kind: "link"; phrase: string; id: string }

/**
 * Text as its complete `[phrase](id)` links and the words between them,
 * in order, the words without link markup (`withoutLinkMarkup`). A stray
 * `[` before a link is not the link's: the link starts at its phrase's
 * last `[`.
 */
const linkPieces = (text: string): Array<LinkPiece> => {
  const pieces: Array<LinkPiece> = []
  let at = 0
  const words = (piece: string, atEnd = false) => {
    const clean = withoutLinkMarkup(piece, atEnd)
    if (clean !== "") pieces.push({ kind: "text", text: clean })
  }
  for (const { phrase, id } of phraseLinks(text)) {
    const literal = `[${phrase}](${id})`
    const index = text.indexOf(literal, at)
    if (index < 0) continue
    const open = phrase.lastIndexOf("[")
    words(text.slice(at, index) + (open < 0 ? "" : phrase.slice(0, open)))
    at = index + literal.length
    const own = phrase.slice(open + 1)
    if (own !== "") pieces.push({ kind: "link", phrase: own, id })
  }
  words(text.slice(at), true)
  return pieces
}

/** Text with each `[phrase](id)` read as its phrase, and no bare local ID. */
const phraseWords = (text: string) =>
  withoutLocalIds(
    linkPieces(text)
      .map((piece) => (piece.kind === "text" ? piece.text : piece.phrase))
      .join("")
  )

/**
 * Explained as the reader sees it: the harness's prose as plain text, a
 * link read as its phrase and no local ID shown. Before and After stay
 * plain (the readers' rule); a phrase there that lands on something on
 * this desk is kept in `links`, for the change's "↳" line.
 */
const explainedText = (
  explained: {
    before: string
    after: string
    terms?: ReadonlyArray<{ term: string; meaning: string }> | undefined
  },
  found: Map<string, Resolution>,
  targets: DeskTargets
): ExplainedText => {
  const links = [explained.before, explained.after].flatMap((text) =>
    linkedSegments(text, found, targets).filter(
      (segment): segment is Extract<BriefingSegment, { kind: "phrase" }> =>
        segment.kind === "phrase"
    )
  )
  return {
    before: phraseWords(explained.before),
    after: phraseWords(explained.after),
    terms: (explained.terms ?? []).map((term) => ({
      term: term.term,
      meaning: phraseWords(term.meaning),
    })),
    ...(links.length > 0 ? { links } : {}),
  }
}

/**
 * A section's own Facts, Briefed and Explained (pipeline 10), in the unit
 * content's shapes. Packets assembled before it have none.
 */
export type SectionContent = NonNullable<
  PublishedPackets.Sections[number]["content"]
>

/** A marker's citation chip, as the briefing shows it: its kind and its title. */
const markerChip = (marker: ContextualMarker): BriefingSegment => ({
  kind: "cite",
  label: MARKER_KIND_LABEL[marker.tone],
  markerKey: marker.key,
  ariaLabel: citationName(marker.tone, marker.title),
})

/** The pins a phrase's chip may name, in the order a tie on one line takes. */
const PHRASE_PINS: ReadonlyArray<MarkerTone> = [
  "checkpoint",
  "conflict",
  "batch",
]

/**
 * The pin a lines phrase carries: of the margin's unmet checkpoints,
 * conflicts and same-batch markers whose lines overlap any of the phrase's
 * ranges on its side (`hunkLines`), the first in the diff's reading order
 * (its first line), a tie on one line going to a checkpoint, then a
 * conflict, then a same-batch marker, then the lower key. Undefined when
 * none overlaps.
 */
const phrasePin = (
  filePath: string,
  ranges: ReadonlyArray<LineRange>,
  targets: DeskTargets
): ContextualMarker | undefined => {
  const pins = (targets.anchors?.get(filePath) ?? []).flatMap((anchor) => {
    const marker = targets.markers[anchor.markerKey]
    const rank = marker ? PHRASE_PINS.indexOf(marker.tone) : -1
    if (!marker || rank < 0) return []
    if (
      marker.tone === "checkpoint" &&
      !(marker.checkpoint && isUnmetCheckpoint(marker.checkpoint))
    )
      return []
    const start = anchor.range?.start ?? anchor.lineNumber
    const end = anchor.range?.end ?? anchor.lineNumber
    return ranges.some(
      (range) =>
        anchor.side === range.side && start <= range.end && end >= range.start
    )
      ? [{ marker, start, rank }]
      : []
  })
  pins.sort(
    (a, b) =>
      a.start - b.start ||
      a.rank - b.rank ||
      (a.marker.key < b.marker.key ? -1 : a.marker.key > b.marker.key ? 1 : 0)
  )
  return pins.at(0)?.marker
}

/**
 * Content text with `[phrase](id)` links, as briefing segments: a phrase
 * lands on the lines it cites when they are on screen, on its marker when it
 * cites one of the unit's references; anything else reads as its words (a
 * unit, an obligation, an ID that resolved to nothing published). A lines
 * phrase is followed by the chip of the pin its lines carry (`phrasePin`),
 * and a marker phrase by its marker's chip.
 */
const linkedSegments = (
  text: string,
  found: Map<string, Resolution>,
  targets: DeskTargets,
  /** The batch digest's phrases that name a unit link to it (the overview). */
  unitLinks = false
): Array<BriefingSegment> => {
  const segments: Array<BriefingSegment> = []
  const push = (piece: string) => {
    if (piece === "") return
    const last = segments.at(-1)
    if (last?.kind === "text") last.text += piece
    else segments.push({ kind: "text", text: piece })
  }
  for (const piece of linkPieces(text)) {
    if (piece.kind === "text") {
      push(piece.text)
      continue
    }
    const { phrase, id } = piece
    const resolution = found.get(id)
    if (resolution?.kind === "hunk" && targets.paths.has(resolution.path)) {
      const range = hunkRange(resolution)
      if (range) {
        segments.push({
          kind: "phrase",
          text: phrase,
          target: { kind: "lines", filePath: resolution.path, range },
        })
        // It lands on its first range; a pin over any of its ranges counts.
        const pin = phrasePin(
          resolution.path,
          hunkLines(resolution, range.side),
          targets
        )
        if (pin) segments.push(markerChip(pin))
        continue
      }
    }
    const marker =
      resolution?.kind === "reference"
        ? targets.markers[resolution.eventId]
        : undefined
    if (resolution?.kind === "reference" && marker) {
      segments.push({
        kind: "phrase",
        text: phrase,
        target: { kind: "marker", markerKey: resolution.eventId },
      })
      segments.push(markerChip(marker))
      continue
    }
    if (unitLinks && resolution?.kind === "unit") {
      segments.push({
        kind: "phrase",
        text: phrase,
        target: { kind: "unit", unitId: resolution.unitId },
      })
      continue
    }
    push(phrase)
  }
  return segments
}

/**
 * What a chip names, for showing it once: the thing the person acts on. A
 * checkpoint on several lines has a pin per line, all one checkpoint, so its
 * pins share its number, as the margin groups them (`checkpointEntries`); a
 * reference or conflict is its event, the key its marker has.
 */
const chipItem = (markerKey: string, markers: DeskTargets["markers"]) => {
  const checkpoint = markers[markerKey]?.checkpoint
  return checkpoint ? `checkpoint:${checkpoint.number}` : markerKey
}

/**
 * One chip per item in a briefing (`chipItem`): across the lead, then each
 * row, in reading order, an item's chip follows only the first lines phrase
 * over it, and later lines phrases over it, on any of its lines, stay plain
 * links. A phrase that cites the marker itself keeps its chip every time
 * (the marker is its subject), and that chip counts as shown.
 */
const chipsOnce = (
  briefings: ReadonlyArray<ReadonlyArray<BriefingSegment>>,
  markers: DeskTargets["markers"]
): Array<Array<BriefingSegment>> => {
  const shown = new Set<string>()
  return briefings.map((segments) =>
    segments.filter((segment, i) => {
      if (segment.kind !== "cite") return true
      const item = chipItem(segment.markerKey, markers)
      const before = i > 0 ? segments[i - 1] : undefined
      const overLines =
        before?.kind === "phrase" && before.target.kind === "lines"
      if (overLines && shown.has(item)) return false
      shown.add(item)
      return true
    })
  )
}

/** A citation chip for one cited ID, when it has something to open. */
const citeChip = (
  id: string,
  found: Map<string, Resolution>,
  targets: DeskTargets,
  revision: string
): BriefingSegment | undefined => {
  const resolution = found.get(id)
  if (resolution?.kind === "reference") {
    const marker = targets.markers[resolution.eventId]
    return marker ? markerChip(marker) : undefined
  }
  if (resolution?.kind === "hunk") {
    const range = hunkRange(resolution)
    if (!range) return undefined
    const marker = hunkMarker(id, resolution, range, targets.sources, revision)
    targets.extra[marker.key] = marker
    return {
      kind: "cite",
      label: MARKER_KIND_LABEL.source,
      markerKey: marker.key,
      ariaLabel: citationName(
        "source",
        `${resolution.path}, ${linesName(range)}`
      ),
      presentation: "source-sheet",
    }
  }
  return undefined
}

/** Facts: one sentence with its citations as chips after it. */
const factsSegments = (
  facts: NonNullable<Unit["content"]["facts"]>,
  found: Map<string, Resolution>,
  targets: DeskTargets,
  revision: string
): Array<BriefingSegment> => {
  const text = facts.text.trim()
  const ends = /[.!?]$/.test(text)
  const body = ends ? text.slice(0, -1) : text
  const chips = (facts.cites ?? []).flatMap((id) => {
    const chip = citeChip(id, found, targets, revision)
    return chip ? [chip] : []
  })
  if (chips.length === 0) return [{ kind: "text", text }]
  const segments: Array<BriefingSegment> = [{ kind: "text", text: `${body} ` }]
  chips.forEach((chip, index) => {
    if (index > 0) segments.push({ kind: "text", text: " " })
    segments.push(chip)
  })
  segments.push({ kind: "text", text: ends ? text.slice(-1) : "." })
  return segments
}

/** A local ID an agent cites inside a run: a hunk, a reference, a ledger entry, a unit, a section. */
const LOCAL_ID =
  /^(?:h[0-9a-f]{8,}|[a-z]\d+\.[a-z]\d+|p\d+\.e\d+|b\d+\.[a-z]+\d+|S\d+(?:\.\d+)*)$/

/**
 * Prose an agent wrote with bare local IDs in parentheses, "(h47dffd0, b1.r3)",
 * read without them: they name nothing a person can open in plain text, and
 * the content's links and chips carry what resolves. A parenthesis with any
 * other word stays.
 */
export const withoutLocalIds = (text: string) =>
  text
    .replace(/\s*\(([^()]*)\)/g, (whole, inner: string) => {
      const parts = inner.split(/[,;]\s*/).map((part) => part.trim())
      return parts.length > 0 && parts.every((part) => LOCAL_ID.test(part))
        ? ""
        : whole
    })
    .replace(/\s+([.,;:])/g, "$1")

/* ── The BFF's own limitations ─────────────────────────── */

const STOP_NAME = {
  facts: "Facts",
  briefed: "Briefed",
  explained: "Explained",
  guided: "Guided",
} as const

/**
 * What a reader is told when the read model discloses a unit's sections
 * blob (`unit-sections`, naming no section): with no owned ranges, its
 * blob did not read and nothing of its changes is shown; with ranges, the
 * blob read but disagrees with the unit's counts, and every range read is
 * shown.
 */
const linesText = (unit: Unit, name: string) =>
  (unit.recorded?.payload.ownedRanges ?? []).length === 0
    ? `The lines ${name} owns couldn't be read, so its changes aren't shown.`
    : `Some of the lines ${name} owns may not be shown.`

/**
 * What the unit's page leads with when its lines did not read in full, as
 * the read model discloses it. A section whose own content did not read
 * names that section, and the unit keeps its lines.
 */
const linesNote = (packet: Packet, batch: Batch, unit: Unit) =>
  packet.undecoded.some(
    (item: PublishedPackets.ReadUndecoded) =>
      item.part === "unit-sections" &&
      item.section === undefined &&
      item.batch === batch.local &&
      item.unit === unit.local
  )
    ? linesText(unit, titleOf(batch, unit))
    : undefined

/**
 * The limitations the BFF adds to a batch's, in a reader's words, as the
 * harness writes its own (packages/harness/src/reader-text.ts): a unit by its
 * title, never its local ID, and never the decoder's text, which the load
 * logs on the server instead (desk.server.ts).
 *
 * A unit with no review lane is one Records holds no record of (`laneOf`).
 * Whole-batch publication gives every published unit a lane, so only an
 * older review, or a manifest naming a unit whose records the store lacks,
 * still says so.
 */
const addedLimitations = (
  batch: Batch,
  undecoded: ReadonlyArray<PublishedPackets.ReadUndecoded>
) => {
  const unlaned = batch.units.filter((unit) => laneOf(unit) === undefined)
  const named = unlaned.flatMap((unit) =>
    unit.recorded ? [titleOf(batch, unit)] : []
  )
  const untitled = unlaned.length - named.length
  const byLocal = new Map(batch.units.map((unit) => [unit.local, unit]))
  const unread = undecoded.flatMap((item) => {
    if (item.part === "manifest")
      return [
        "Part of this batch couldn't be read, so some of it may not be shown.",
      ]
    // A gap the packet names that Records does not hold: the review's own,
    // or this batch's.
    if (
      item.part === "gap" &&
      (item.batch === undefined || item.batch === batch.local)
    )
      return [
        "Part of this review's limitations couldn't be read, so some may not be shown.",
      ]
    if (item.batch !== batch.local) return []
    if (item.part === "assembled-batch")
      return [
        "Some of this batch's context couldn't be read, so some of its links and context references may not be shown.",
      ]
    if (item.part === "batch-digest")
      return ["The batch digest couldn't be read, so it isn't shown."]
    const unit = item.unit === undefined ? undefined : byLocal.get(item.unit)
    if (unit === undefined) return []
    const name = unit.recorded ? titleOf(batch, unit) : "a unit"
    switch (item.part) {
      case "dispose":
        return [
          `The agent's review of ${name} couldn't be read in full, so some of its links may not be shown.`,
        ]
      case "unit-sections":
        return [
          item.section === undefined
            ? linesText(unit, name)
            : `Part of the briefing of ${name} couldn't be read, so it isn't shown.`,
        ]
      case "judgements":
        return [
          `What the agents judged of ${name} couldn't be read in full, so some of its checkpoints may not be shown.`,
        ]
      case "facts":
      case "briefed":
      case "explained":
      case "guided":
        return [
          `The ${STOP_NAME[item.part]} stop for ${name} couldn't be read, so it isn't shown.`,
        ]
      default:
        return []
    }
  })
  return [
    ...named.map(
      (title) =>
        `${title} hasn't been placed in a review lane yet, so it isn't counted in any review lane.`
    ),
    ...(untitled === 0
      ? []
      : untitled === 1
        ? [
            "A unit hasn't been placed in a review lane yet, so it isn't counted in any review lane.",
          ]
        : [
            `${untitled} units haven't been placed in a review lane yet, so they aren't counted in any review lane.`,
          ]),
    ...new Set(unread),
  ]
}

/**
 * The gaps a batch's overview reads: a `packet.published@1`'s are its run's,
 * all of them; a `packet.published@2`'s are those its manifest names for the
 * whole review and those frozen with this batch, never another batch's.
 */
const gapsOf = (packet: Packet, batch: Batch) => {
  if (!isChain(packet)) return packet.gaps
  const batched = new Set(
    packet.batches.flatMap((entry) => entry.gaps.map((gap) => gap.id))
  )
  const own = new Set((batch.gaps ?? []).map((gap) => gap.id))
  return packet.gaps.filter((gap) => !batched.has(gap.id) || own.has(gap.id))
}

/**
 * The gaps Records discloses about carrying a person's earlier decision
 * onto a unit: an approval held back because this review disputes the
 * unit, and a carried comment whose lines cannot be placed. Each names its
 * unit, and both are for the reader, in Records' words.
 */
const CARRIED_GAPS: ReadonlySet<string> = new Set([
  "earlier-approval-not-carried",
  "carried-comment-unanchored",
])

const gapUnits = (gap: { readonly attribution: unknown }) =>
  (gap.attribution as { unitIds?: ReadonlyArray<string> }).unitIds ?? []

/** The batch's carried gaps on `unitIds`' units, in the reader's words, each once. */
const carriedGapsOf = (
  packet: Packet,
  batch: Batch,
  unitIds: ReadonlyArray<string>
) => [
  ...new Set(
    gapsOf(packet, batch)
      .filter(
        (gap) =>
          CARRIED_GAPS.has(gap.payload.kind) &&
          gapUnits(gap).some((id) => unitIds.includes(id))
      )
      .map((gap) => namedAsShown(batch, gap.payload.detail, gapUnits(gap)))
  ),
]

/**
 * Every note Records writes about one unit, for that unit's page: each gap
 * of the batch that names it, in Records' words, each once. Why no agent
 * decided a section (the `undecided-` kinds) is never shown (14.4): the
 * unit's "No agent decision in this run" says all a reader needs.
 */
const unitGapsOf = (packet: Packet, batch: Batch, unitId: string) => [
  ...new Set(
    gapsOf(packet, batch)
      .filter(
        (gap) =>
          gapUnits(gap).includes(unitId) &&
          !gap.payload.kind.startsWith(UNDECIDED_GAP_PREFIX)
      )
      .map((gap) => namedAsShown(batch, gap.payload.detail, gapUnits(gap)))
  ),
]

/* ── References → markers ──────────────────────────────── */

/** Lines a unit owns, by path and side. */
const ownedLines = (unit: Unit) =>
  (unit.recorded?.payload.ownedRanges ?? []).flatMap((range) =>
    range.kind === "lines" ? [range] : []
  )

/** A reference whole, when the assembled batch holds it; an older store may not. */
const detailOf = (
  unit: Unit,
  eventId: string
): PublishedPackets.ReferenceDetail | undefined =>
  unit.referenceDetails[eventId]

/**
 * Where a reference's pin goes on this unit: the first of its anchors on
 * lines the unit owns (`owned`), else the anchor Records holds. Only an
 * owned anchor gives a comment on the marker its lines (10.102).
 */
const anchorFor = (unit: Unit, event: Reference) => {
  const owned = ownedLines(unit)
  const detail = detailOf(unit, event.id)
  const candidates = [...(detail?.anchors ?? []), event.payload.anchor]
  const inOwned = candidates.find((anchor) =>
    owned.some(
      (range) =>
        range.path === anchor.path &&
        range.side === anchor.side &&
        anchor.startLine >= range.startLine &&
        anchor.endLine <= range.endLine
    )
  )
  return inOwned === undefined
    ? { anchor: event.payload.anchor, owned: false }
    : { anchor: inOwned, owned: true }
}

/**
 * How much cited source the sheet (L3) shows: the cited lines, up to a
 * bound, with a few lines around them. The card (L2) shows none: it tints
 * the unit's lines in the diff and leads with the reason.
 */
const SHEET_LINES = 120
const SHEET_CONTEXT = 6

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

const GRADES = new Set(["necessary", "useful"])

/** Which version of the code a citation reads, in the reader's words. */
const versionOf = (revision: string, sources: Sources | undefined) =>
  sources === undefined
    ? undefined
    : revision === sources.head
      ? "after this change"
      : revision === sources.mergeBase
        ? "before this change"
        : "at another commit"

/**
 * "Lines 12–20, before this change": the quiet line above cited code. A
 * citation longer than the sheet shows says how much of it is shown.
 */
const codeCaption = (
  range: { start: number; end: number },
  version: string | undefined,
  shown?: number
) => {
  const lines = linesName(range)
  const named = `${lines.charAt(0).toUpperCase()}${lines.slice(1)}`
  return [
    version ? `${named}, ${version}` : named,
    ...(shown === undefined ? [] : [`the first ${shown} shown`]),
  ].join(" · ")
}

export const referenceMarker = (
  unit: Unit,
  event: Reference,
  titles: ReadonlyMap<string, string>,
  sources: Sources | undefined
): ContextualMarker => {
  const payload = event.payload
  const detail = detailOf(unit, event.id)
  const tone = TONE[payload.markerKind]
  const provenance = payload.provenance
  const why = detail?.why ?? payload.summary
  const grade = detail?.grade
  const tie: ReferenceTie = {
    stance: payload.stance,
    ...(grade !== undefined && GRADES.has(grade)
      ? { grade: grade as NonNullable<ReferenceTie["grade"]> }
      : {}),
  }
  const blob =
    provenance.kind === "git" && provenance.blob !== undefined
      ? (sources?.blobs[provenance.blob] ?? [])
      : []
  const cited =
    provenance.kind === "git" &&
    provenance.startLine !== undefined &&
    blob.length >= provenance.startLine
      ? {
          start: provenance.startLine,
          end: Math.min(
            provenance.endLine ?? provenance.startLine,
            provenance.startLine + SHEET_LINES - 1,
            blob.length
          ),
          total:
            Math.min(provenance.endLine ?? provenance.startLine, blob.length) -
            provenance.startLine +
            1,
        }
      : undefined
  const slice = (from: number, to: number) =>
    blob.slice(from - 1, to).map((text, offset) => ({
      number: from + offset,
      text,
      cited:
        cited !== undefined &&
        from + offset >= cited.start &&
        from + offset <= cited.end,
    }))
  const citedLines = cited ? slice(cited.start, cited.end) : []
  // Lines around the cited ones, unless the citation runs past the bound:
  // then the sheet stops at its last shown cited line.
  const sheetLines = cited
    ? slice(
        Math.max(1, cited.start - SHEET_CONTEXT),
        cited.end - cited.start + 1 < cited.total
          ? cited.end
          : Math.min(blob.length, cited.end + SHEET_CONTEXT)
      )
    : []
  const title =
    provenance.kind === "git"
      ? provenance.path
      : provenance.kind === "url"
        ? provenance.url
        : payload.source.locator
  const others = event.attribution.unitIds.filter((id) => id !== unit.unitId)
  return {
    key: event.id,
    tone,
    short: MARKER_KIND_LABEL[tone],
    target: provenance.kind === "git" ? provenance.path : undefined,
    peek: why,
    kindLabel: KIND_LABEL[tone],
    title,
    meta: STANCE_LABEL[tie.stance],
    quote:
      citedLines.length > 0
        ? clip((citedLines.at(0)?.text ?? "").trim(), 300)
        : why,
    applies: why,
    ...(detail?.beforeYouDecide ? { check: detail.beforeYouDecide } : {}),
    reference: tie,
    ...(others.length > 0 ? { sharedWith: others } : {}),
    source: {
      kind: SHEET_KIND[tone],
      chips: [],
      title,
      subtitle: payload.source.locator,
      ...(provenance.kind === "git" ? { path: provenance.path } : {}),
      actions:
        provenance.kind === "git"
          ? [{ kind: "copy-path", path: provenance.path }]
          : provenance.kind === "url"
            ? [{ kind: "external", label: "Open", href: provenance.url }]
            : [],
      facts: [],
      blocks:
        cited && provenance.kind === "git"
          ? [
              {
                kind: "code" as const,
                lines: sheetLines,
                caption: codeCaption(
                  {
                    start: cited.start,
                    end: cited.start + cited.total - 1,
                  },
                  versionOf(provenance.revision, sources),
                  cited.end - cited.start + 1 < cited.total
                    ? cited.end - cited.start + 1
                    : undefined
                ),
              },
            ]
          : [],
      citedBy: ["This unit", ...others.map((id) => titles.get(id) ?? id)],
    },
  }
}

/* ── Diff ──────────────────────────────────────────────── */

const patchOf = (file: SourceFile) => {
  const oldName = file.oldPath === null ? "/dev/null" : `a/${file.oldPath}`
  const newName = file.newPath === null ? "/dev/null" : `b/${file.newPath}`
  const header = `diff --git a/${file.oldPath ?? file.newPath} b/${file.newPath ?? file.oldPath}\n`
  if (file.binary)
    return `${header}Binary files ${oldName} and ${newName} differ\n`
  return `${header}--- ${oldName}\n+++ ${newName}\n${file.hunks.map((hunk) => hunk.text).join("")}`
}

/** The changed line numbers on each side, as the review rules give them. */
const changedLines = (file: SourceFile) => {
  const sides = { old: new Set<number>(), new: new Set<number>() }
  for (const hunk of file.hunks)
    for (const range of hunk.changed)
      for (let line = 0; line < range.lineCount; line++)
        sides[range.side].add(range.startLine + line)
  return sides
}

/** The hunk whose changed lines (from the review rules) hold a line, for a comment's anchor. */
const hunkAt = (file: SourceFile, side: DiffSide, line: number) => {
  const wanted = side === "deletions" ? "old" : "new"
  const index = file.hunks.findIndex((hunk) =>
    hunk.changed.some(
      (range) =>
        range.side === wanted &&
        line >= range.startLine &&
        line < range.startLine + range.lineCount
    )
  )
  const hunk = file.hunks.at(Math.max(index, 0))
  return {
    index: Math.max(index, 0),
    header: (hunk?.text.split("\n")[0] ?? "").replace(/ @@.*$/, " @@"),
  }
}

/**
 * One file of the unit: git's patch and both sides whole, with the lines the
 * unit owns (`unit.recorded@2`) and the batch's other units' lines in the
 * same file shown folded and read-only.
 */
export const diffFile = (
  path: string,
  unit: Unit,
  batch: Batch,
  sources: Sources,
  anchors: DiffFile["markerAnchors"]
): DiffFile | undefined => {
  const file = sources.files[path]
  if (!file) return undefined
  const changed = changedLines(file)
  const oldLines = file.oldContents.split("\n")
  const newLines = file.newContents.split("\n")
  const owned: Array<OwnedChangedSource> = []
  let exact = true
  for (const range of unit.recorded?.payload.ownedRanges ?? []) {
    if (range.path !== path || range.kind !== "lines") continue
    const set = range.side === "old" ? changed.old : changed.new
    const all = range.side === "old" ? oldLines : newLines
    for (let line = range.startLine; line <= range.endLine; line++)
      if (!set.has(line)) exact = false
    owned.push({
      kind: "changed-lines",
      hunkId: `${path}:${range.side}:${range.startLine}`,
      side: range.side,
      sourceRevisionId: range.side === "old" ? sources.mergeBase : sources.head,
      startLine: range.startLine,
      lineCount: range.endLine - range.startLine + 1,
      lines: all.slice(range.startLine - 1, range.endLine),
    })
  }
  const siblings = batch.units
    .filter((other) => other.unitId !== unit.unitId)
    .flatMap((other) => {
      // The fold's button names no lane: it keeps the words the title
      // leaves out (its pin names the lane).
      const laneWords = laneWordsOf(batch, other)
      return ownedLines(other)
        .filter((range) => range.path === path)
        .map((range) => ({
          unitId: other.unitId,
          title: titleOf(batch, other),
          lane: laneOf(other),
          ...(laneWords ? { laneWords } : {}),
          side: range.side,
          startLine: range.startLine,
          lineCount: range.endLine - range.startLine + 1,
        }))
    })
  // The unit's separate changes (10.109), each with the lines it owns here.
  const sections = deskSections(unit)
    .map((section) => ({
      id: section.id,
      title: section.title,
      ranges: section.ownedRanges.flatMap((range) =>
        range.kind === "lines" && range.path === path
          ? [
              {
                side: range.side,
                startLine: range.startLine,
                endLine: range.endLine,
              },
            ]
          : []
      ),
    }))
    .filter((section) => section.ranges.length > 0)
  const additions = file.hunks.reduce((sum, hunk) => sum + hunk.added, 0)
  const deletions = file.hunks.reduce((sum, hunk) => sum + hunk.deleted, 0)
  return {
    path,
    patch: patchOf(file),
    additions,
    deletions,
    oldContents: file.oldContents,
    newContents: file.newContents,
    context: 3,
    markerAnchors: anchors,
    // Owned lines that are not changed lines in git's diff cannot be drawn
    // as owned ranges; the file then shows whole rather than wrongly.
    ...(owned.length > 0 && exact && !file.binary
      ? {
          responsibility: {
            kind: "changed-ranges" as const,
            unitId: unit.unitId,
            revisionId: sources.head,
            ownedSource: owned,
            ...(siblings.length > 0 ? { siblingSource: siblings } : {}),
            ...(sections.length > 1 ? { sections } : {}),
          },
        }
      : {}),
  }
}

const unitPaths = (unit: Unit) => [
  ...new Set((unit.recorded?.payload.ownedRanges ?? []).map((r) => r.path)),
]

/** The hunks a hunk count reads: the listed units' files git read, else the open unit's. */
const headersOf = (sources: Sources): HunkHeaders =>
  sources.hunks ??
  Object.fromEntries(
    Object.entries(sources.files).map(([path, file]) => [
      path,
      file?.hunks ?? [],
    ])
  )

/**
 * How many of git's hunks the unit's owned lines fall in: the one rule for a
 * unit's count on the overview, the rail and the unit page alike. Without
 * git's hunks (a load that read none), the files it owns lines in.
 */
const hunkCount = (unit: Unit, hunks: HunkHeaders | undefined) => {
  if (!hunks) return unitPaths(unit).length
  let count = 0
  for (const path of unitPaths(unit)) {
    const inFile = hunks[path]
    if (!inFile) continue
    const owned = (unit.recorded?.payload.ownedRanges ?? []).filter(
      (range) => range.path === path
    )
    count += inFile.filter((hunk) =>
      owned.some((range) =>
        range.kind !== "lines"
          ? true
          : range.side === "old"
            ? range.startLine < hunk.oldStart + hunk.oldLines &&
              range.endLine >= hunk.oldStart
            : range.startLine < hunk.newStart + hunk.newLines &&
              range.endLine >= hunk.newStart
      )
    ).length
  }
  return Math.max(count, unitPaths(unit).length > 0 ? 1 : 0)
}

/* ── Comments ──────────────────────────────────────────── */

const commentRecord = (
  event: CommentEvent,
  unit: Unit,
  revision: string,
  sources: Sources | undefined,
  author: ReviewCommentRecord["author"]
): ReviewCommentRecord | undefined => {
  const anchor = event.payload.anchor
  if (!anchor) return undefined
  const file = sources?.files[anchor.path]
  if (!file) return undefined
  const side = sideOf(anchor.side)
  const contents = side === "deletions" ? file.oldContents : file.newContents
  const lines = contents
    .split("\n")
    .slice(anchor.startLine - 1, anchor.endLine)
    .map((text, offset) => ({
      side,
      lineNumber: anchor.startLine + offset,
      text,
    }))
  if (lines.length === 0) return undefined
  return {
    schemaVersion: 2,
    id: event.id,
    unitId: unit.unitId,
    revision,
    anchor: {
      filePath: anchor.path,
      range: { start: anchor.startLine, end: anchor.endLine, side },
      hunk: hunkAt(file, side, anchor.startLine),
      lines,
    },
    author,
    body: withoutLocalIds(event.payload.body),
    createdAt: event.occurredAt,
    status: "open",
  }
}

/**
 * Where a carried decision came from, as the desk says it: the earlier
 * review's head, as the meta beside it shows this review's, and never the
 * review's id (the owner's text carries no codes).
 */
const carriedLabel = (from: { readonly head: string }) =>
  `Earlier review, head ${short(from.head)}`

/**
 * The line that leads a carried suggestion on the Guided card and in what
 * the dock sends or opens for editing (`suggestionText`). The card shows no
 * heads, so it names neither the review's id nor its head.
 */
export const CARRIED_SUGGESTION = "Carried from an earlier review."

/**
 * Where each of a unit's comments shows (10.102): on its lines when git's
 * diff here holds them (a comment record), else on the change it names (an
 * agent's comment with `section` and no lines, while the unit's changes are
 * rows), else on the whole unit under its briefing. Every comment shows
 * once: the packet's (the agent's, and a person's carried with their
 * decision) in their order, then people's. A whole-unit comment keeps its
 * author, the carried label when it was carried, and the review mark of a
 * request for changes that stands on it.
 */
const placeComments = (input: {
  readonly unit: Unit
  readonly human: HumanWork
  readonly revision: string
  readonly sources: Sources
  readonly facts: LaneFacts
  readonly agents: Map<
    string,
    Pick<BranchAgent, "id" | "short" | "name" | "role">
  >
  /** The unit's change rows by ID, when it shows them. */
  readonly rows: ReadonlySet<string>
}) => {
  const { unit, human, revision, sources, facts, agents } = input
  const agentActor = (actor: string): LineageReviewActor => ({
    kind: "agent",
    agent: agentReviewer(actor, agents),
  })
  const personActor = (actor: string): LineageReviewActor => ({
    kind: "person",
    person: reviewerOf(
      human.people[actor] ?? { actor, name: "Reviewer", initials: "?" }
    ),
    isYou: actor === human.viewer?.actor,
  })
  const authorOf = (
    actor: LineageReviewActor
  ): ReviewCommentRecord["author"] =>
    actor.kind === "agent"
      ? {
          kind: "agent",
          id: actor.agent.id,
          name: actor.agent.name,
          initials: actor.agent.short,
          role: actor.agent.role,
        }
      : {
          id: actor.person.id,
          name: actor.person.name,
          initials: actor.person.initials,
        }
  // The requests for changes that stand on the unit and the comments each
  // rests on: the review's own, a person's carried one, and the person's
  // fresh one that stands (read beside the packet, `HumanWork.standing`).
  const requests = [
    ...(unit.disposition &&
    unit.judgement.standing?.eventId === unit.disposition.id
      ? [unit.disposition.payload]
      : []),
    ...standingCarried(unit, facts).map((event) => event.payload),
    ...(human.standing ? [human.standing] : []),
  ].filter((payload) => payload.verdict === "request-changes")
  const restsOn = (id: string) =>
    requests.some((payload) =>
      ((payload as { restsOn?: ReadonlyArray<string> }).restsOn ?? []).includes(
        id
      )
    )
  const records: Array<ReviewCommentRecord> = []
  const whole: Array<UnitLevelComment> = []
  const bySection = new Map<string, Array<UnitLevelComment>>()
  const place = (event: CommentEvent, actor: LineageReviewActor) => {
    const record = commentRecord(
      event,
      unit,
      revision,
      sources,
      authorOf(actor)
    )
    if (record) return void records.push(record)
    const entry: UnitLevelComment = {
      id: event.id,
      author: actor,
      body: withoutLocalIds(event.payload.body),
      ...(event.kind === "comment.carried@1"
        ? { carried: carriedLabel(event.payload.from) }
        : {}),
      ...(restsOn(event.id) ? { verdict: "changes_requested" as const } : {}),
    }
    const section =
      event.kind === "comment.recorded@3" && event.payload.anchor === undefined
        ? event.payload.section
        : undefined
    if (section !== undefined && input.rows.has(section))
      bySection.set(section, [...(bySection.get(section) ?? []), entry])
    else whole.push(entry)
  }
  for (const event of facts.removalFirst(unit, unit.comments))
    // A person's comment carried with their decision is theirs.
    place(
      event,
      carriedByPerson(event, human)
        ? personActor(event.actor)
        : agentActor(event.actor)
    )
  for (const event of human.comments) place(event, personActor(event.actor))
  return { records, whole, bySection }
}

/* ── Delivery ──────────────────────────────────────────── */

const CRITERION_STATUS: Record<string, DeliveryCriterionStatus> = {
  met: "met",
  "not-met": "not-met",
  "no-evidence": "no-evidence",
  outside: "outside",
}

const evidenceOf = (
  ids: ReadonlyArray<string>,
  found: Map<string, Resolution>,
  targets: DeskTargets,
  revision: string
): Array<DeliveryEvidence> =>
  ids.flatMap((id): Array<DeliveryEvidence> => {
    const resolution = found.get(id)
    if (resolution?.kind === "reference") {
      const marker = targets.markers[resolution.eventId]
      if (!marker) return []
      return [
        {
          kind: marker.tone,
          label: MARKER_KIND_LABEL[marker.tone],
          target: marker.title.split("/").at(-1),
          markerKey: marker.key,
        },
      ]
    }
    if (resolution?.kind === "hunk") {
      const range = hunkRange(resolution)
      if (!range) return []
      const marker = hunkMarker(
        id,
        resolution,
        range,
        targets.sources,
        revision
      )
      targets.extra[marker.key] = marker
      return [
        {
          kind: "source",
          label: MARKER_KIND_LABEL.source,
          target: linesName(range),
          markerKey: marker.key,
          excerpt:
            marker.excerpt?.kind === "code"
              ? marker.excerpt.code.split("\n")
              : [],
        },
      ]
    }
    if (
      resolution?.kind === "scope-section" ||
      resolution?.kind === "obligation"
    )
      return [{ kind: "doc", label: MARKER_KIND_LABEL.doc, target: id }]
    return []
  })

/**
 * A Guided row's proof state and the agent's reading, as the readers lane
 * writes them on the row (records keeps the row a loose object). Only
 * "missing" is a proof state the desk shows. A reading needs words; its
 * text loses its local IDs and its cites resolve as `evidence` does, as
 * their own list. An older row has neither, and gives nothing.
 */
const rowProof = (
  row: Readonly<Record<string, unknown>>,
  found: Map<string, Resolution>,
  targets: DeskTargets,
  revision: string
): Pick<DeliveryCriterion, "proofState" | "reading"> => {
  const reading =
    typeof row.reading === "object" && row.reading !== null
      ? (row.reading as { text?: unknown; cites?: unknown })
      : undefined
  const text =
    typeof reading?.text === "string"
      ? withoutLocalIds(reading.text).trim()
      : ""
  const cites = Array.isArray(reading?.cites)
    ? reading.cites.filter((cite): cite is string => typeof cite === "string")
    : []
  return {
    ...(row.proofState === "missing" ? { proofState: "missing" as const } : {}),
    ...(text
      ? {
          reading: {
            text,
            cites: evidenceOf(cites, found, targets, revision),
          },
        }
      : {}),
  }
}

const BASIS: Record<string, "done-when" | "scope" | "gathered"> = {
  "done-when": "done-when",
  scope: "scope",
}

/** Text as a reader compares it: no local IDs, whitespace collapsed. */
const sameWords = (text: string) =>
  withoutLocalIds(text).replace(/\s+/g, " ").trim()

/**
 * The changes the desk draws with their own content: a new-shape unit's
 * sections (`deskData`'s rows). An old-shape unit gives none here, so its
 * stops and its Explained are the unit's own, even where its rows carry
 * content: `joinedBriefing` attaches each assembled section's content when
 * every one has some, and splits the Briefed by title otherwise.
 */
const contentRows = (unit: Unit): ReadonlyArray<DeskSection> =>
  readSections(unit).length > 0 ? deskSections(unit) : []

/**
 * The unit's Explained as the desk shows it once: its own, else, on a unit
 * of one change, that change's. A unit of several changes shows theirs as
 * rows (`explainedShows`), never one of them as the unit's.
 */
const unitExplained = (
  content: Pick<Unit["content"], "explained">,
  rows: ReadonlyArray<{ readonly content?: SectionContent | undefined }>
) =>
  content.explained ??
  (rows.length === 1 ? (rows[0].content?.explained ?? undefined) : undefined)

/**
 * The stops a unit has content for, so the dial never offers an empty one:
 * a stop is offered exactly when the desk shows something there beyond
 * Facts. `rows` are the changes the desk draws with their own content
 * (`contentRows`).
 * - Facts always.
 * - Briefed when the unit's Briefed or a change's says more than its Facts
 *   (a Briefed with the Facts' own words adds nothing). A unit of one
 *   change shows that change's Briefed as its own.
 * - Explained by the desk's own rule (`explainedShows`): the unit's, or its
 *   one change's, or a row per change when every change has its own. Some
 *   changes explained and some not offers none.
 * - Guided when Guided has a row or an outside item to show: the desk's
 *   check card needs one.
 */
export const deliveryStopsOf = (
  content: Pick<Unit["content"], "facts" | "briefed" | "explained" | "guided">,
  sections: ReadonlyArray<{ readonly content?: SectionContent | undefined }>
): Array<DeliveryStop> => {
  const said = (
    briefed: string | null | undefined,
    facts: string | undefined
  ) =>
    briefed !== null &&
    briefed !== undefined &&
    sameWords(briefed) !== "" &&
    sameWords(briefed) !== sameWords(facts ?? "")
  const briefed =
    said(content.briefed?.text, content.facts?.text) ||
    sections.some(
      (section) =>
        section.content !== undefined &&
        said(section.content.briefed, section.content.facts.text)
    )
  const explained =
    explainedShows(
      unitExplained(content, sections),
      rowExplained(
        sections.map((section) => ({ explained: section.content?.explained }))
      )
    ) !== undefined
  const guided =
    (content.guided?.rows?.length ?? 0) +
      (content.guided?.outside?.length ?? 0) >
    0
  return [
    "facts",
    ...(briefed ? (["briefed"] as const) : []),
    ...(explained ? (["explained"] as const) : []),
    ...(guided ? (["guided"] as const) : []),
  ]
}

/**
 * Facts, Explained and Guided for the dial, with the stops the unit has
 * content for. Explained carries the harness's prose and terms as written;
 * real units have no flow diagram.
 */
const deliveryOf = (
  unit: Unit,
  batchTitle: string,
  found: Map<string, Resolution>,
  targets: DeskTargets,
  revision: string
): DeliveryPayload | undefined => {
  const facts = unit.content.facts
  if (!facts) return undefined
  const guided = unit.content.guided
  const checkpoints = guidedCheckpoints(
    unit,
    guided?.rows ?? [],
    found,
    targets.sources
  )
  const criteria: Array<DeliveryCriterion> = [
    ...(guided?.rows ?? []).map((row) => {
      const under = checkpoints.byRow.get(row.row)
      return {
        id: row.row,
        criterion: row.text,
        status: CRITERION_STATUS[row.status] ?? "no-evidence",
        does: withoutLocalIds(row.does),
        evidence: evidenceOf(row.evidence, found, targets, revision),
        ...rowProof(row, found, targets, revision),
        ...(under ? { checkpoints: under } : {}),
      }
    }),
    ...(guided?.outside ?? []).map((item, index) => ({
      id: `outside:${index + 1}`,
      criterion: item.item,
      status: "outside" as const,
      does: withoutLocalIds(item.does),
      evidence: evidenceOf(item.evidence, found, targets, revision),
    })),
  ]
  const suggestion = guided?.suggestion
  const rows = contentRows(unit)
  // The unit's, or its one change's; several changes' are on their rows.
  const explained = unitExplained(unit.content, rows)
  return {
    stops: deliveryStopsOf(unit.content, rows),
    facts: factsSegments(facts, found, targets, revision),
    // Explained as the harness wrote it (10.60), in the briefing.
    ...(explained
      ? { explained: explainedText(explained, found, targets) }
      : {}),
    ...(guided
      ? {
          check: {
            ticket: { title: batchTitle },
            basis: BASIS[guided.basis ?? ""] ?? "gathered",
            ...(guided.unlinked ? { unlinked: true } : {}),
            criteria,
            ...(checkpoints.unattached.length > 0
              ? { checkpoints: checkpoints.unattached }
              : {}),
            ...(laneOf(unit) === "human-required" && suggestion
              ? {
                  suggestion: {
                    decision:
                      suggestion.verdict === "request-changes"
                        ? ("request_changes" as const)
                        : ("approve" as const),
                    message: withoutLocalIds(suggestion.message),
                    ...(guided.review?.carried === undefined
                      ? {}
                      : { carried: CARRIED_SUGGESTION }),
                  },
                }
              : {}),
          },
        }
      : {}),
  }
}

/* ── Attribution and lanes ─────────────────────────────── */

/**
 * A proof line, opening the note or a paragraph of it: Publish's older
 * "Proof (10.83): …" or Dispose's "Proof: …".
 */
const PROOF_LINE = /(?:^|\n\s*\n)\s*Proof(?::| \(10\.83\))/

/**
 * The agent's summary in a disposition note: its prose before the proof
 * line. A note that opens with its proof line has none (""), so the card
 * shows no summary rather than the proof.
 */
export const noteSummary = (text: string | undefined) =>
  text?.split(PROOF_LINE)[0]?.trim()

/**
 * Who decided a unit outside the human-required lane, and how: a person's
 * decision that stands, fresh or carried, before the review's own (the
 * overview's rule, `personDecision`), else the agent's or the carried
 * review's.
 */
const attributionOf = (
  unit: Unit,
  revision: string,
  agents: Map<string, Pick<BranchAgent, "id" | "short" | "name" | "role">>,
  human: Pick<HumanWork, "people" | "viewer">,
  facts: LaneFacts
): UnitAttribution | undefined => {
  const lane = laneOf(unit)
  if (lane === undefined || lane === "human-required") return undefined
  const decision = personDecision(unit, facts)
  if (decision) {
    const review = personReviewOf(decision, human.people, human.viewer)
    const approved = review.verdict === "approved"
    const who = review.actor.isYou ? "You" : review.actor.person.name
    return {
      headline: `${who} ${approved ? "approved" : "requested changes"}`,
      meta:
        decision.carried ??
        `${LANE_NAME[lane].toLowerCase()} · ${short(revision)}`,
      outcome: approved ? "approved" : "changes-requested",
      person: {
        actor: review.actor,
        ...(decision.carried ? { carried: decision.carried } : {}),
      },
    }
  }
  const disposition = unit.disposition
  if (!disposition) return undefined
  const approved = disposition.payload.verdict === "approve"
  return {
    headline:
      disposition.kind === "disposition.carried@1"
        ? approved
          ? "Carried approval"
          : "Carried request for changes"
        : approved
          ? "Agent approved"
          : "Agent requested changes",
    meta:
      disposition.kind === "disposition.carried@1"
        ? carriedLabel(disposition.payload.from)
        : `${LANE_NAME[lane].toLowerCase()} · ${short(revision)}`,
    summary: withoutLocalIds(
      unit.content.guided?.review?.message ??
        noteSummary(disposition.payload.note) ??
        ""
    ),
    outcome: approved ? "approved" : "changes-requested",
    reviewer: agentReviewer(disposition.actor, agents),
  }
}

/**
 * What a unit with no written title covers, from its owned ranges. The
 * harness writes a title only for a unit it assessed; one it could not assess
 * is recorded with a title code built from its path and hunk counts, and
 * Records holds no assessment for it (`judgement.assessed`). Each file it
 * owns ranges in, in order, with its owned line spans: the new side where it
 * owns any there, else the old. Undefined for a written title, or a unit with
 * no owned ranges to name it by. A unit whose title code wrote (the seam's
 * `titledByCode`) is named this way too.
 */
const untitledOf = (unit: Unit, facts: LaneFacts): LaneUnit["untitled"] => {
  if ((unit.judgement.assessed && !facts.titledByCode(unit)) || !unit.recorded)
    return undefined
  const ranges = unit.recorded.payload.ownedRanges
  const files = unitPaths(unit).map((path): UntitledFile => {
    const lines = ranges.flatMap((range) =>
      range.kind === "lines" && range.path === path ? [range] : []
    )
    const added = lines.filter((range) => range.side !== "old")
    return {
      path,
      lines: (added.length > 0 ? added : lines)
        .map((range) => ({ start: range.startLine, end: range.endLine }))
        .sort((a, b) => a.start - b.start),
    }
  })
  return files.length > 0 ? { files } : undefined
}

const laneUnit = (
  batch: Batch,
  unit: Unit,
  lane: Exclude<ReviewLane, "human-required">,
  agents: Map<string, Pick<BranchAgent, "id" | "short" | "name" | "role">>,
  facts: LaneFacts,
  human: Pick<HumanWork, "people" | "viewer"> | undefined
): LaneUnit => {
  const disposition = unit.disposition
  const untitled = untitledOf(unit, facts)
  const { raisedFrom } = unitLaneFacts(unit, lane, facts)
  const named = {
    id: unit.unitId,
    title: titleOf(batch, unit),
    ...(untitled ? { untitled } : {}),
    ...(raisedFrom ? { raisedFrom } : {}),
  }
  // A person's decision that stands, fresh or carried, before the review's
  // own, as the overview's rows read it.
  const decision = human ? personDecision(unit, facts) : undefined
  if (human && decision) {
    const personReview = personReviewOf(decision, human.people, human.viewer)
    return {
      ...named,
      result: personReview.verdict === "approved" ? "approved" : "changes",
      personReview,
    }
  }
  const excluded = facts.excluded(unit)
  if (!disposition && excluded)
    return { ...named, result: "not read", excluded }
  if (!disposition) return { ...named, result: "open" }
  const approved = disposition.payload.verdict === "approve"
  return {
    ...named,
    result:
      disposition.kind === "disposition.carried@1"
        ? "carried"
        : approved
          ? "agent ✓"
          : "changes",
    ...(approved ? {} : { tone: "req" as const }),
    review: {
      reviewer: agentReviewer(disposition.actor, agents),
      verdict: approved ? "approved" : "changes_requested",
    },
  }
}

const elsewhereOf = (
  batch: Batch,
  agents: Map<string, Pick<BranchAgent, "id" | "short" | "name" | "role">>,
  facts: LaneFacts,
  /** People's names and the viewer, for a person's decision on a row; none without people's work. */
  human?: Pick<HumanWork, "people" | "viewer">
): Array<ElsewhereLane> =>
  (["human-suggested", "agentic-review", "static-automation"] as const).map(
    (lane) => {
      // A unit no agent read is the rail's "Not read" group's (`notReadOf`).
      const units = batch.units.filter(
        (unit) => laneOf(unit) === lane && facts.excluded(unit) === undefined
      )
      return {
        lane,
        label: RAIL_LABEL[lane],
        count: units.length,
        units: units.map((unit) =>
          laneUnit(batch, unit, lane, agents, facts, human)
        ),
      }
    }
  )

/**
 * The units outside human-required work no agent read, for the rail's own
 * "Not read" group: no agent decided them, so they are not among the lanes
 * decided by agents and tools. Each keeps its lane, as the overview lists it.
 */
const notReadOf = (
  batch: Batch,
  agents: Map<string, Pick<BranchAgent, "id" | "short" | "name" | "role">>,
  facts: LaneFacts,
  human?: Pick<HumanWork, "people" | "viewer">
): Array<LaneUnit & { lane: ReviewLane }> =>
  batch.units.flatMap((unit) => {
    const lane = laneOf(unit)
    if (
      lane === undefined ||
      lane === "human-required" ||
      facts.excluded(unit) === undefined
    )
      return []
    // The group names no lane, so a row keeps the words its title leaves out.
    const laneWords = laneWordsOf(batch, unit)
    return [
      {
        ...laneUnit(batch, unit, lane, agents, facts, human),
        ...(laneWords ? { laneWords } : {}),
        lane,
      },
    ]
  })

const batchUnits = (batch: Batch): Array<BatchUnit> =>
  batch.units.flatMap((unit) => {
    const lane = laneOf(unit)
    return lane === undefined
      ? []
      : [{ id: unit.unitId, title: titleOf(batch, unit), lane }]
  })

const railUnits = (
  batch: Batch,
  hunks: HunkHeaders,
  facts: LaneFacts,
  /** A person's name, for a carried decision's mark. */
  people: HumanWork["people"],
  viewer: Person | undefined
): Array<RailUnit> =>
  batch.units
    .filter((unit) => laneOf(unit) === "human-required")
    .map((unit) => {
      const untitled = untitledOf(unit, facts)
      const decision = personDecision(unit, facts)
      return {
        id: unit.unitId,
        title: titleOf(batch, unit),
        hunkCount: hunkCount(unit, hunks),
        ...(untitled ? { untitled } : {}),
        ...unitLaneFacts(unit, "human-required", facts),
        // A unit in the rail's "Decided" group (`arrivedDecided`): its row
        // shows the person's review standing on it, the carried one marked.
        ...(arrivedDecided(unit, facts) && decision
          ? { carriedReview: personReviewOf(decision, people, viewer) }
          : {}),
      }
    })

const branchOf = (range: ReviewRange) => {
  const base = range.display?.base ?? range.baseRef
  return (
    range.display?.branch ??
    `${/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(base) ? short(base) : base}..${short(range.headOid)}`
  )
}

/** Enough of the batch to frame a desk with no unit to show. */
export const deskBatchContext = (
  context: PacketContext,
  facts: LaneFacts = LANE_FACTS
): DeskBatchContext => ({
  repo: context.range.display?.project ?? context.repo,
  branch: branchOf(context.range),
  revision: context.range.headOid,
  batchId: context.batch.batchId,
  batchTitle: context.batch.recorded?.payload.title ?? context.batch.local,
  elsewhere: elsewhereOf(context.batch, batchReviewers(context.batch), facts),
  agents: EMPTY_AGENTS,
})

/* ── Overview ──────────────────────────────────────────── */

/**
 * Whether a checkpoint (a unit's validation requirement, 10.110) is unmet:
 * Missing, Out of date or Conflicting (11.19), as Records decides it, so
 * the overview's count and the unit page agree. Thin is not unmet.
 */
export const isUnmetCheckpoint = (
  checkpoint: Pick<Checkpoints.Checkpoint, "proof">
) => Checkpoints.isUnmet(checkpoint.proof)

/**
 * The review's batches in its order, for the header's batch menu, each with
 * the human-required units no person has decided yet (the overview's rule),
 * and how many are still to be published. A batch not published yet has no
 * units in Records, so nothing of it is ever counted as waiting on a person.
 * With batches pending and no run of the review going or queued, the review
 * stopped short; a load that did not read its runs says nothing of it.
 */
export const reviewBatches = (
  context: PacketContext,
  facts: LaneFacts = LANE_FACTS,
  /** Off for the batch as the review published it: no person's decision counts. */
  people = true
): ReviewBatches => {
  const pending = facts.pendingBatches(context.packet)
  return {
    current: context.batch.batchId,
    newest: context.newest ?? false,
    ...(pending > 0 ? { pending } : {}),
    ...(pending > 0 && context.runGoing === false
      ? { stopped: true as const }
      : {}),
    all: context.packet.batches.map((batch) => ({
      id: batch.batchId,
      title: batch.recorded?.payload.title ?? batch.local,
      unitCount: batch.units.length,
      needYou: batch.units.filter(
        (unit) =>
          laneOf(unit) === "human-required" &&
          (!people || personDecision(unit, facts) === undefined)
      ).length,
    })),
  }
}

/** Code's words for a Guided status, as the overview reads them. */
const OBLIGATION_STATUS: Partial<
  Record<string, "met" | "not-met" | "no-evidence">
> = {
  met: "met",
  "not-met": "not-met",
  "no-evidence": "no-evidence",
}

/**
 * The digest's obligations (10.87) as the overview lists them, each unit by
 * its title. A digest written before them has none. The overall status is
 * code's word: met, not met, no evidence, or "met on n of m units"; any
 * other is left out rather than guessed at. A unit the batch doesn't hold
 * is left out: it has no title to give.
 */
export const digestObligationsOf = (
  batch: Pick<Batch, "digest" | "units">
): Array<DigestObligation> => {
  const byHandle = new Map(
    batch.units.flatMap((unit) => [
      [unit.local, unit] as const,
      [unit.unitId, unit] as const,
    ])
  )
  return (batch.digest?.obligations ?? []).map((obligation) => {
    const partly = /^met on (\d+) of (\d+) units$/.exec(obligation.overall)
    const known = OBLIGATION_STATUS[obligation.overall]
    const overall: DigestObligation["overall"] = partly
      ? { kind: "partly", met: Number(partly[1]), of: Number(partly[2]) }
      : known
        ? { kind: known }
        : undefined
    return {
      text: withoutLocalIds(obligation.text),
      basis: BASIS[obligation.basis ?? ""] ?? "gathered",
      ...(overall ? { overall } : {}),
      units: obligation.units.flatMap((entry) => {
        const unit = byHandle.get(entry.unit)
        const status = entry.required
          ? OBLIGATION_STATUS[entry.status]
          : "not-required"
        if (!unit || !status) return []
        const laneWords = laneWordsOf(batch, unit)
        // The unit page's Missing, from the unit's own row for this item.
        const missing =
          status !== "not-required" &&
          unit.content.guided?.rows?.find((row) => row.row === obligation.row)
            ?.proofState === "missing"
        return [
          {
            unitId: unit.unitId,
            title: titleOf(batch, unit),
            ...(laneWords ? { laneWords } : {}),
            status,
            ...(missing ? { proofState: "missing" as const } : {}),
          },
        ]
      }),
    }
  })
}

export const overviewData = (
  context: PacketContext,
  human: OverviewPeople = NO_PEOPLE,
  facts: LaneFacts = LANE_FACTS
): BatchOverviewData => {
  const { batch, range, packet } = context
  const units = batch.units
  const found = resolutions(batch.digestCitations)
  const targets: DeskTargets = {
    paths: new Set(),
    markers: {},
    extra: {},
    sources: undefined,
  }
  const digest = batch.digest
  // What changed, then what to check: the digest's two parts, each its own
  // section in the overview.
  const segments = digest
    ? linkedSegments(digest.digest, found, targets, true)
    : []
  const toCheck = digest?.verification
    ? linkedSegments(digest.verification, found, targets, true)
    : []
  // What to check, too: each ticket item across the batch's units, by code.
  const obligations = digestObligationsOf(batch)
  // What the batch removes, disables or narrows leads (13.19): each
  // finding's sentence, linking to the unit it is on.
  const removed = facts
    .removedSegments(batch)
    .flatMap((entry, index): Array<BriefingSegment> => [
      ...(index > 0 ? [{ kind: "text" as const, text: " " }] : []),
      {
        kind: "phrase",
        text: withoutLocalIds(entry.text),
        target: { kind: "unit", unitId: entry.unitId },
      },
    ])
  const plain = [
    ...removed,
    ...(removed.length > 0 && segments.length > 0
      ? [{ kind: "text" as const, text: " " }]
      : []),
    ...segments,
    ...toCheck,
  ]
    .map((segment) => (segment.kind === "cite" ? "" : segment.text))
    .join("")
  // The run's own gaps (no unit named) are the batch's limitations; a unit's
  // gaps stay with the unit.
  const limitations = [
    ...(digest?.limitations ?? []),
    ...(digest?.uncertainty ?? []),
    ...gapsOf(packet, batch)
      .filter(
        (gap) =>
          gapUnits(gap).length === 0 &&
          // Why no agent decided a section is never shown: the unit's
          // "No agent decision in this run" says all a reader needs.
          !gap.payload.kind.startsWith(UNDECIDED_GAP_PREFIX)
      )
      .map((gap) => gap.payload.detail),
    // What could not be carried from an earlier review names its unit, and
    // is the reader's to see here too.
    ...carriedGapsOf(
      packet,
      batch,
      units.map((unit) => unit.unitId)
    ),
    ...addedLimitations(batch, packet.undecoded),
  ]
  const required = units.filter((unit) => laneOf(unit) === "human-required")
  // A person's decision that stands, fresh or carried, takes a unit off
  // "Needs your decision" (`personDecision`, the desk's rule).
  const decisions = new Map(
    units.flatMap((unit) => {
      const decision = human.withoutPeople
        ? undefined
        : personDecision(unit, facts)
      return decision ? [[unit.unitId, decision] as const] : []
    })
  )
  const personReview = (decision: PersonDecision) =>
    personReviewOf(decision, human.people, human.viewer)
  const waiting = required.filter((unit) => !decisions.has(unit.unitId))
  // An agent's request for changes no person has answered, on any lane: the
  // decision panel names these rather than say nothing needs you. The count
  // that waits on you stays the human-required one above.
  const agentChanges = units
    .filter(
      (unit) =>
        laneOf(unit) !== undefined &&
        !decisions.has(unit.unitId) &&
        agentRequestsChanges(unit)
    )
    .map((unit) => ({
      id: unit.unitId,
      title: titleOf(batch, unit),
      // Which agent, when its disposition says: the panel says "Agents" only
      // when two differ.
      ...(unit.disposition ? { agentId: unit.disposition.actor } : {}),
    }))
  const decided: Array<DecidedUnit> = required.flatMap((unit) => {
    const decision = decisions.get(unit.unitId)
    return decision
      ? [
          {
            id: unit.unitId,
            title: titleOf(batch, unit),
            review: personReview(decision),
          },
        ]
      : []
  })
  // Every laned unit with the review that stands on it, for the overview's
  // unit rows. Human-required work shows a review only once a person decided
  // it (the rows above); elsewhere the standing one, numbered as the desk's
  // rail numbers its agents.
  const reviewers = batchReviewers(batch)
  const decidedById = new Map(decided.map((unit) => [unit.id, unit.review]))
  const overviewUnits: Array<OverviewUnit> = units.flatMap((unit) => {
    const lane = laneOf(unit)
    if (lane === undefined) return []
    const untitled = untitledOf(unit, facts)
    const excluded = facts.excluded(unit)
    const entry = {
      id: unit.unitId,
      title: titleOf(batch, unit),
      lane,
      ...(untitled ? { untitled } : {}),
      ...unitLaneFacts(unit, lane, facts),
      ...(excluded ? { excluded } : {}),
    }
    if (lane === "human-required") {
      const review = decidedById.get(unit.unitId)
      return [review ? { ...entry, review } : entry]
    }
    // A person's, fresh or carried, as on the decided rows.
    const decision = decisions.get(unit.unitId)
    if (decision) return [{ ...entry, review: personReview(decision) }]
    // Else the agent's that stands: without people's work, the newest
    // agent's among those that close it, even under a person's.
    const standing =
      unit.judgement.standing?.actorKind === "human"
        ? unit.judgement.closing
            .filter((closing) => closing.actorKind !== "human")
            .reduce<(typeof unit.judgement.closing)[number] | undefined>(
              (newest, closing) =>
                newest === undefined || closing.eventId > newest.eventId
                  ? closing
                  : newest,
              undefined
            )
        : unit.judgement.standing
    if (lane === "static-automation" || !standing) return [entry]
    const actor: LineageReviewActor = {
      kind: "agent",
      agent: agentReviewer(standing.actorId, reviewers),
    }
    return [
      {
        ...entry,
        review: {
          actor,
          ...(unit.disposition?.kind === "disposition.carried@1" &&
          unit.disposition.id === standing.eventId
            ? { carried: carriedLabel(unit.disposition.payload.from) }
            : {}),
          verdict:
            standing.verdict === "approve" ? "approved" : "changes_requested",
        },
      },
    ]
  })
  // No agent read a lockfile or a generated file: one count, never a wait.
  const notRead = units.filter(
    (unit) => laneOf(unit) !== undefined && facts.excluded(unit) !== undefined
  ).length
  const lanes: Array<LaneSummary> = LANE_ORDER.map((lane) => {
    const inLane = units.filter((unit) => laneOf(unit) === lane)
    return { lane, name: LANE_NAME[lane], count: inLane.length }
  })
  const judgment: Array<JudgmentUnit> = waiting.map((unit) => {
    const conflict = unit.references.some(
      (reference) =>
        reference.payload.markerKind === "conflict" ||
        reference.payload.markerKind === "decision-signal"
    )
    const untitled = untitledOf(unit, facts)
    return {
      id: unit.unitId,
      title: titleOf(batch, unit),
      ...(untitled ? { untitled } : {}),
      ...unitLaneFacts(unit, "human-required", facts),
      ...(conflict ? { signal: { text: "Context conflicts" } } : {}),
      files: unitPaths(unit).length,
      hunks: hunkCount(unit, context.hunks),
      markers: unit.references.length,
    }
  })
  // A unit's requirements are its checkpoints (10.110).
  const checkpoints: Record<string, UnitCheckpoints> = Object.fromEntries(
    units.flatMap((unit) => {
      const all = unit.checkpoints
      return all.length === 0
        ? []
        : [
            [
              unit.unitId,
              {
                total: all.length,
                unmet: all.filter(isUnmetCheckpoint).length,
              },
            ],
          ]
    })
  )
  return {
    repo: context.range.display?.project ?? context.repo,
    title: batch.recorded?.payload.title ?? batch.local,
    ticket: "",
    branch: branchOf(range),
    revision: range.headOid,
    unitCount: units.length,
    briefing: plain || (batch.recorded?.payload.focus ?? ""),
    // An old-shape batch has a briefing only with a digest; a new-shape
    // batch's limitations reach the page whenever there are any, with empty
    // segments when it has no digest.
    ...(segments.length > 0 ||
    removed.length > 0 ||
    obligations.length > 0 ||
    (isChain(packet) && limitations.length > 0)
      ? {
          contextualBriefing: {
            ...(removed.length > 0 ? { removed } : {}),
            segments,
            ...(toCheck.length > 0 ? { toCheck } : {}),
            ...(obligations.length > 0 ? { obligations } : {}),
            markers: targets.extra,
            limitations,
          },
        }
      : {}),
    batches: reviewBatches(context, facts, human.withoutPeople !== true),
    needYou: waiting.length,
    ...(notRead > 0 ? { notRead } : {}),
    firstUnitId: (waiting.at(0) ?? required.at(0) ?? units.at(0))?.unitId ?? "",
    lanes,
    judgment,
    ...(decided.length > 0 ? { decided } : {}),
    units: overviewUnits,
    ...(agentChanges.length > 0 ? { agentChanges } : {}),
    checkpoints,
    agents: EMPTY_AGENTS,
  }
}

/**
 * Whether an agent requested changes on a unit, read from every place a
 * review writes it: the agent's disposition in the packet, the unit's
 * guided review or suggestion, or any section's verdict. A section's is read
 * as the desk reads it (`sectionSayings`): `guided.sectionReviews` by its
 * key, else the section's own `review` in the sections blob. A packet from
 * an older build may carry one with the unit still human-suggested.
 */
export const agentRequestsChanges = (unit: Unit): boolean => {
  const guided = unit.content.guided
  if (
    unit.disposition?.payload.verdict === "request-changes" ||
    guided?.review?.verdict === "request-changes" ||
    guided?.suggestion?.verdict === "request-changes"
  )
    return true
  // Every section the unit has, and every key the keyed list names.
  const said = sectionSayings(unit)
  const keys = new Set([
    ...deskSections(unit).map((section) => section.id),
    ...bySectionKey(fieldOf(guided, "sectionReviews")).keys(),
  ])
  return [...keys].some((key) => said(key).verdict === "request-changes")
}

/* ── Checkpoints (10.110, 11.16, 11.17) ────────────────── */

/** Lines on one side of one file, merged where they overlap or touch. */
const mergedLines = (
  anchors: ReadonlyArray<{ path: string; range: LineRange }>
): Array<{ path: string; range: LineRange }> => {
  const sorted = [...anchors].sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.range.side.localeCompare(b.range.side) ||
      a.range.start - b.range.start
  )
  const merged: Array<{ path: string; range: LineRange }> = []
  for (const anchor of sorted) {
    const last = merged.at(-1)
    if (
      last &&
      last.path === anchor.path &&
      last.range.side === anchor.range.side &&
      anchor.range.start <= last.range.end + 1
    )
      last.range = {
        ...last.range,
        end: Math.max(last.range.end, anchor.range.end),
      }
    else merged.push({ path: anchor.path, range: { ...anchor.range } })
  }
  return merged
}

/**
 * The owned lines a requirement's citations reach (11.17): a cited
 * reference's anchor on owned lines (by its event, or by its local ID), and
 * the lines of a cited hunk that this unit owns, on the new side unless it
 * owns only removed lines there (a hunk can be split between units, so every
 * range of it counts). Overlapping lines merge, so a checkpoint marks a line
 * once. A hunk's local ID resolves only when the unit's content cites it
 * too, so a requirement may reach no line and is then anchored to its unit
 * as a whole.
 */
const checkpointAnchors = (
  unit: Unit,
  cites: ReadonlyArray<Cite>,
  found: Map<string, Resolution>
): Array<{ path: string; range: LineRange }> => {
  const owned = ownedLines(unit)
  const anchors: Array<{ path: string; range: LineRange }> = []
  const reference = (eventId: string) => {
    const event = unit.references.find((candidate) => candidate.id === eventId)
    if (!event) return
    const { anchor, owned: inOwned } = anchorFor(unit, event)
    if (inOwned)
      anchors.push({
        path: anchor.path,
        range: {
          start: anchor.startLine,
          end: anchor.endLine,
          side: sideOf(anchor.side),
        },
      })
  }
  const ownedOf = (
    resolution: Extract<Resolution, { kind: "hunk" }>,
    side: "old" | "new"
  ) =>
    resolution.ranges.flatMap((lines) =>
      lines.side !== side ||
      lines.startLine === undefined ||
      lines.endLine === undefined
        ? []
        : owned.flatMap((range) => {
            if (range.path !== resolution.path || range.side !== side) return []
            const start = Math.max(range.startLine, lines.startLine!)
            const end = Math.min(range.endLine, lines.endLine!)
            return start <= end
              ? [
                  {
                    path: range.path,
                    range: { start, end, side: sideOf(side) },
                  },
                ]
              : []
          })
    )
  for (const cite of cites) {
    if (cite.ref !== undefined && cite.ref.startsWith("event:")) {
      reference(cite.ref.slice("event:".length))
      continue
    }
    const resolution =
      cite.entry === undefined ? undefined : found.get(cite.entry)
    if (resolution?.kind === "reference") reference(resolution.eventId)
    if (resolution?.kind !== "hunk") continue
    const added = ownedOf(resolution, "new")
    anchors.push(...(added.length > 0 ? added : ownedOf(resolution, "old")))
  }
  return mergedLines(anchors)
}

/** Records' owned lines (old or new side) as the diff's range. */
const recordsLines = (
  anchor: Checkpoints.Checkpoint["anchors"] extends ReadonlyArray<
    infer A
  > | null
    ? A
    : never
) => ({
  path: anchor.path,
  range: {
    start: anchor.startLine,
    end: anchor.endLine,
    side: sideOf(anchor.side),
  },
})

/** A checkpoint's marker key, the one of its first line. */
const checkpointKey = (
  unit: Unit,
  checkpoint: Pick<Checkpoints.Checkpoint, "number">
) => `checkpoint:${unit.unitId}:${checkpoint.number}`

/**
 * The lines a checkpoint is anchored to: Records' (11.17), or, for an
 * assessment recorded before anchors were (`anchors` null), placed from its
 * citations. Empty when it is anchored to its unit as a whole.
 */
const checkpointLines = (
  unit: Unit,
  checkpoint: Checkpoint,
  found: Map<string, Resolution>
) =>
  checkpoint.anchors === null
    ? checkpointAnchors(unit, citesOf(checkpoint), found)
    : mergedLines(checkpoint.anchors.map(recordsLines))

/**
 * The unit's checkpoints as Records gives them (11.16-11.21), as markers:
 * one per line a checkpoint is anchored to (so each line's pin, tint and
 * card are its own), or a single marker with no anchor for one anchored to
 * its unit as a whole. Records sets the state and its note at this read;
 * the desk never derives them. Only a checkpoint whose assessment was
 * recorded before anchors were (`anchors` null) has its lines placed here,
 * from its citations.
 */
export const checkpointsOf = (
  unit: Unit,
  found: Map<string, Resolution>
): Array<{
  marker: ContextualMarker
  anchor?: { path: string; range: LineRange }
}> =>
  unit.checkpoints.flatMap((checkpoint) => {
    const text = withoutLocalIds(checkpoint.requirement)
    const marker = (
      key: string,
      anchor: { path: string; range: LineRange } | undefined
    ): ContextualMarker => {
      const where = anchor
        ? `${anchor.path} · ${linesName(anchor.range)}`
        : "This unit as a whole"
      return {
        key,
        tone: "checkpoint",
        short: "Checkpoint",
        peek: text,
        kindLabel: KIND_LABEL.checkpoint,
        title: text,
        meta: where,
        quote: text,
        applies: checkpoint.note,
        checkpoint: {
          number: checkpoint.number,
          requirement: text,
          proof: checkpoint.proof,
          note: checkpoint.note,
        },
        source: {
          kind: SHEET_KIND.checkpoint,
          chips: [{ text: KIND_LABEL.checkpoint, tone: "neutral" }],
          title: text,
          subtitle: where,
          actions: [],
          facts: [],
          blocks: [],
          citedBy: ["This unit"],
        },
      }
    }
    const key = checkpointKey(unit, checkpoint)
    const anchors = checkpointLines(unit, checkpoint, found)
    if (anchors.length === 0) return [{ marker: marker(key, undefined) }]
    return anchors.map((anchor, line) => ({
      marker: marker(line === 0 ? key : `${key}:${line + 1}`, anchor),
      anchor,
    }))
  })

/**
 * The guided row a checkpoint's citations point at, for Guided content that
 * names no row's requirements (stored before rows carried them): the cited
 * obligation that is one of the rows. Publish now puts the basis first among
 * a requirement's citations and earlier packets put it last, so the first
 * citation counts when it names a row, else the last that does. A guess:
 * a basis that is no row while a row is cited lands under that row, and a
 * basis the six-citation cut dropped leaves it with none.
 */
const citedRow = (
  cites: ReadonlyArray<{ readonly entry?: string }>,
  rows: ReadonlySet<string>
): string | undefined => {
  const named = cites.flatMap((cite) =>
    cite.entry !== undefined && rows.has(cite.entry) ? [cite.entry] : []
  )
  const first = cites.at(0)?.entry
  return first !== undefined && rows.has(first) ? first : named.at(-1)
}

/**
 * A requirement as the assessment event holds it: Publish spaces out
 * control characters, cuts it to 300 characters and trims it (`clipText`),
 * while the Guided rows keep the requirement as Assemble wrote it.
 */
const asRecorded = (text: string) => {
  let out = ""
  for (const char of text) {
    const code = char.codePointAt(0)!
    const spaced =
      code <= 8 || (code >= 11 && code <= 31) || code === 127 ? " " : char
    if (out.length + spaced.length > 300) break
    out += spaced
  }
  return out.trim() || "-"
}

/** A Guided row as the projection reads it: its ID and, when stored, its requirements. */
type GuidedRowRequirements = {
  readonly row: string
  readonly requirements?: ReadonlyArray<{ readonly requirement: string }>
}

/**
 * Which guided row each checkpoint rests on (11.23), by its number. Records
 * stores the link: each Guided row lists the requirements whose basis it is
 * (Dispose's `guidedBasis`), and a requirement with no row as its basis is
 * implied by the change and is listed under none. A checkpoint sits under
 * the row that lists its requirement; one no row lists has no row. Where
 * two rows list the same words, the row its citations point at decides,
 * else the first. Only Guided content whose rows list no requirements falls
 * back to the citations alone (`citedRow`).
 */
const checkpointRows = (
  checkpoints: ReadonlyArray<Checkpoint>,
  rows: ReadonlyArray<GuidedRowRequirements>
): Map<number, string | undefined> => {
  const ids = new Set(rows.map((row) => row.row))
  const listed = rows.some((row) => row.requirements !== undefined)
  const byRequirement = new Map<string, Array<string>>()
  for (const row of rows)
    for (const { requirement } of row.requirements ?? []) {
      const key = asRecorded(requirement)
      byRequirement.set(key, [...(byRequirement.get(key) ?? []), row.row])
    }
  return new Map(
    checkpoints.map((checkpoint) => {
      const cited = citedRow(citesOf(checkpoint), ids)
      if (!listed) return [checkpoint.number, cited]
      const candidates = byRequirement.get(checkpoint.requirement) ?? []
      return [
        checkpoint.number,
        cited !== undefined && candidates.includes(cited)
          ? cited
          : candidates.at(0),
      ]
    })
  )
}

/**
 * The unit's checkpoints for Guided (11.23), each under the row its
 * requirement rests on (`checkpointRows`), or left with none. State, note
 * and number pass through as Records gives them, with Records' unmet rule;
 * where it sits is its first line, as a pin that opens those lines, or
 * nothing for one anchored to its unit as a whole.
 */
export const guidedCheckpoints = (
  unit: Unit,
  rows: ReadonlyArray<GuidedRowRequirements>,
  found: Map<string, Resolution>,
  sources: Sources | undefined
): {
  byRow: Map<string, Array<DeliveryCheckpoint>>
  unattached: Array<DeliveryCheckpoint>
} => {
  const rowOf = checkpointRows(unit.checkpoints, rows)
  const byRow = new Map<string, Array<DeliveryCheckpoint>>()
  const unattached: Array<DeliveryCheckpoint> = []
  for (const checkpoint of unit.checkpoints) {
    const first = checkpointLines(unit, checkpoint, found).at(0)
    const entry: DeliveryCheckpoint = {
      number: checkpoint.number,
      requirement: withoutLocalIds(checkpoint.requirement),
      proof: checkpoint.proof,
      note: checkpoint.note,
      unmet: isUnmetCheckpoint(checkpoint),
      ...(first
        ? { lines: linesPin(first, checkpointKey(unit, checkpoint), sources) }
        : {}),
    }
    const row = rowOf.get(checkpoint.number)
    if (row === undefined) unattached.push(entry)
    else byRow.set(row, [...(byRow.get(row) ?? []), entry])
  }
  return { byRow, unattached }
}

/** A checkpoint's lines as a Source pin: the file, the lines, and the code. */
const linesPin = (
  anchor: { path: string; range: LineRange },
  markerKey: string,
  sources: Sources | undefined
): DeliveryEvidence => {
  const file = sources?.files[anchor.path]
  const contents =
    anchor.range.side === "deletions" ? file?.oldContents : file?.newContents
  const excerpt =
    contents === undefined
      ? []
      : contents.split("\n").slice(anchor.range.start - 1, anchor.range.end)
  return {
    kind: "source",
    label: anchor.path.split("/").at(-1) ?? anchor.path,
    target: linesName(anchor.range),
    markerKey,
    ...(excerpt.length > 0 ? { excerpt } : {}),
  }
}

/* ── Desk ──────────────────────────────────────────────── */

export const deskData = (
  context: PacketContext,
  unit: Unit,
  /** The unit's lane as Records gives it (`laneOf`); a unit with none has no desk. */
  lane: ReviewLane,
  sources: Sources,
  human: HumanWork,
  facts: LaneFacts = LANE_FACTS
): ReviewDeskData => {
  const { batch, range } = context
  const revision = range.headOid
  const agents = batchReviewers(batch)
  const titles = new Map(
    batch.units.map((other) => [other.unitId, titleOf(batch, other)])
  )
  const markers: Record<string, ContextualMarker> = {}
  const anchorsByPath = new Map<string, DiffFile["markerAnchors"]>()
  for (const reference of unit.references) {
    markers[reference.id] = referenceMarker(unit, reference, titles, sources)
    const { anchor, owned } = anchorFor(unit, reference)
    const list = anchorsByPath.get(anchor.path) ?? []
    const side = sideOf(anchor.side)
    list.push({
      markerKey: reference.id,
      side,
      lineNumber: anchor.startLine,
      // Only lines the unit owns: a comment attached to the marker takes them.
      ...(owned
        ? { range: { start: anchor.startLine, end: anchor.endLine, side } }
        : {}),
    })
    anchorsByPath.set(anchor.path, list)
  }
  const found = resolutions(unit.citations)
  for (const { marker, anchor } of checkpointsOf(unit, found)) {
    markers[marker.key] = marker
    if (!anchor) continue
    const list = anchorsByPath.get(anchor.path) ?? []
    list.push({
      markerKey: marker.key,
      side: anchor.range.side,
      lineNumber: anchor.range.start,
      range: anchor.range,
    })
    anchorsByPath.set(anchor.path, list)
  }
  const files = unitPaths(unit).flatMap((path) => {
    const file = diffFile(
      path,
      unit,
      batch,
      sources,
      anchorsByPath.get(path) ?? []
    )
    return file ? [file] : []
  })
  const targets: DeskTargets = {
    paths: new Set(files.map((file) => file.path)),
    markers,
    extra: {},
    sources,
    anchors: anchorsByPath,
  }
  const briefed = unit.content.briefed
  const bySection = briefed
    ? joinedBriefing(briefed.text, deskSections(unit))
    : undefined
  const unitFacts = unitLaneFacts(unit, lane, facts)
  // Per section, as the unit-level mark, only on human-required work, and
  // only when some of its sections were decided.
  const undecided =
    lane !== "human-required" || unitFacts.noAgentDecision
      ? new Set<string>()
      : facts.undecidedSections(unit)
  // A new-shape unit's rows are its sections as the read model holds them,
  // in its order, whatever its Briefed looks like: each claims its own
  // content, else its paragraph of a Briefed split by title. An old-shape
  // unit's rows are its Briefed split by section, as before.
  const claims = new Map(
    (bySection?.sections ?? []).map((section) => [section.id, section])
  )
  // The unit's own Briefed leads (`told`). A change whose Briefed says the
  // same words (Records leads with the first change's Briefed when the unit
  // has no lead of its own) claims its Facts in its row, so the lead is
  // never said twice.
  const lead = bySection?.lead ?? briefed?.text
  const leadWords = lead === undefined ? "" : sameWords(lead)
  const claimOf = (content: SectionContent) =>
    typeof content.briefed === "string" &&
    (leadWords === "" || sameWords(content.briefed) !== leadWords)
      ? content.briefed
      : content.facts.text
  const rows: ReadonlyArray<{
    id: string
    title: string
    claim?: string | undefined
    content?: SectionContent | undefined
  }> =
    readSections(unit).length > 0
      ? deskSections(unit).map((section) => ({
          id: section.id,
          title: section.title,
          claim: section.content
            ? claimOf(section.content)
            : claims.get(section.id)?.claim,
          content: section.content,
        }))
      : (bySection?.sections ?? [])
  const placed = placeComments({
    unit,
    human,
    revision,
    sources,
    facts,
    agents,
    rows: new Set(rows.length > 1 ? rows.map((row) => row.id) : []),
  })
  // Why no agent decided: the unit's own, under its line, or, on a unit
  // only partly undecided, each with its section's line. Human-required
  // work only, where those lines are.
  const undecidedNotes =
    unitFacts.noAgentDecision || undecided.size > 0
      ? undecidedNotesOf(
          unit,
          rows.filter((row) => undecided.has(row.id))
        )
      : { unit: [], bySection: new Map<string, ReadonlyArray<string>>() }
  // What an agent suggests for each change it decided, on its row: only on
  // human-required work of several changes, where a person decides and the
  // rows are drawn. A unit no agent decided has none; a unit of one change
  // keeps its suggestion at the unit, as before.
  const suggested =
    lane === "human-required" && !unitFacts.noAgentDecision && rows.length > 1
      ? sectionReviewsOf(unit)
      : new Map<
          string,
          { verdict: "approve" | "request-changes"; message: string }
        >()
  const suggestionOf = (id: string): Pick<BriefingSection, "suggestion"> => {
    const review = undecided.has(id) ? undefined : suggested.get(id)
    return review
      ? {
          suggestion: {
            decision:
              review.verdict === "request-changes"
                ? ("request_changes" as const)
                : ("approve" as const),
            // Plain words: any link reads as its phrase and no bare local
            // ID shows, so no phrase or chip comes from them.
            message: [{ kind: "text", text: phraseWords(review.message) }],
          },
        }
      : {}
  }
  const sections =
    rows.length === 0
      ? undefined
      : facts.removalFirst(unit, rows).map((section) => ({
          id: section.id,
          title: section.title,
          ...(undecided.has(section.id)
            ? { noAgentDecision: true as const }
            : {}),
          ...(undecidedNotes.bySection.has(section.id)
            ? {
                undecidedNotes: [...undecidedNotes.bySection.get(section.id)!],
              }
            : {}),
          ...suggestionOf(section.id),
          ...(placed.bySection.has(section.id)
            ? { comments: placed.bySection.get(section.id) }
            : {}),
          briefing:
            section.claim === undefined
              ? []
              : linkedSegments(section.claim, found, targets),
          ...(section.content
            ? {
                facts: factsSegments(
                  section.content.facts,
                  found,
                  targets,
                  revision
                ),
                ...(section.content.explained
                  ? {
                      explained: explainedText(
                        section.content.explained,
                        found,
                        targets
                      ),
                    }
                  : {}),
              }
            : {}),
        }))
  // With a row per part, each saying its own, a lead of the unit's Facts
  // says only what the parts' rows do not: the parts' own facts are taken
  // out of it (they are joined into the unit's), and what is left, such as
  // a sentence about the unit as a whole, leads once. A Briefed of the
  // unit's own leads as written.
  const factsText = unit.content.facts?.text
  const leadFacts =
    factsText !== undefined &&
    sections !== undefined &&
    sections.length > 1 &&
    sections.every((section) => section.briefing.length > 0)
      ? withoutParts(
          factsText,
          rows.flatMap((row) => [
            ...(row.claim === undefined ? [] : [row.claim]),
            ...(row.content ? [row.content.facts.text] : []),
          ])
        )
      : factsText
  // A new-shape unit of one change has no row: that change's Briefed is
  // the unit's, as `deliveryStopsOf` offers it.
  const oneBriefed =
    rows.length === 1 ? (rows[0].content?.briefed ?? undefined) : undefined
  const toldOnce = bySection
    ? linkedSegments(bySection.lead, found, targets)
    : briefed
      ? linkedSegments(briefed.text, found, targets)
      : oneBriefed
        ? linkedSegments(oneBriefed, found, targets)
        : leadFacts
          ? // A new-shape unit's Facts read as its Briefed would, links
            // resolved and no local ID shown; an old-shape unit's as before.
            isNewShape(unit)
            ? linkedSegments(leadFacts, found, targets)
            : [{ kind: "text" as const, text: leadFacts }]
          : []
  // Read as one briefing, the lead then the claims the rows draw: an item's
  // chip is shown once (`chipsOnce`). A row no agent decided draws its "No
  // agent decision" line in its claim's place (`undecidedRow`, the desk's
  // rule), so its phrases take no chip from a drawn one. A decided change's
  // suggestion is plain words, with nothing to chip.
  const claimDrawn = (section: NonNullable<typeof sections>[number]) =>
    !undecidedRow(section, !!unitFacts.noAgentDecision)
  const [told = [], ...rowBriefings] = chipsOnce(
    [
      toldOnce,
      ...(sections ?? []).map((section) =>
        claimDrawn(section) ? section.briefing : []
      ),
    ],
    targets.markers
  )
  const shownSections = sections?.map((section, i) =>
    claimDrawn(section)
      ? { ...section, briefing: rowBriefings[i] ?? section.briefing }
      : section
  )
  // A unit whose lines did not read in full says so first, then every note
  // Records wrote about it (what it could not carry, withheld or cut).
  const notes = [
    linesNote(context.packet, batch, unit),
    // A review in today's shape (`packet.published@1`) shows what it
    // showed before: what Records could not carry onto the unit.
    ...(isChain(context.packet)
      ? unitGapsOf(context.packet, batch, unit.unitId)
      : carriedGapsOf(context.packet, batch, [unit.unitId])),
  ].filter((text): text is string => text !== undefined)
  const briefing: Array<BriefingSegment> =
    notes.length === 0
      ? told
      : [
          { kind: "text", text: notes.join(" ") },
          ...(told.length > 0 ? [{ kind: "text" as const, text: " " }] : []),
          ...told,
        ]
  const batchTitle = batch.recorded?.payload.title ?? batch.local
  const delivery = deliveryOf(unit, batchTitle, found, targets, revision)
  const inLane = batch.units.filter((other) => laneOf(other) === lane)
  const required = railUnits(
    batch,
    headersOf(sources),
    facts,
    human.people,
    human.viewer
  )
  // A unit that arrived with a person's carried decision is the rail's
  // "Decided" group's, out of "Needs your decision" and its meter, while a
  // person's decision stands on it, carried or fresh: a reader who decides
  // it again sees nothing move. Only when no person's decision stands (an
  // Undo with nothing else standing) does it go back under "Needs your
  // decision", counted in the meter like any other.
  const arrivedCarried = new Set(
    batch.units
      .filter((other) => arrivedDecided(other, facts))
      .map((other) => other.unitId)
  )
  const rail = required.filter((entry) => !arrivedCarried.has(entry.id))
  const carried = required.filter((entry) => arrivedCarried.has(entry.id))
  const commentRecords = placed.records
  // The reader's own decision that stands opens the dock decided, with
  // Undo: one given fresh, or one carried from an earlier review, which
  // Records lets its person retract (`retractDisposition`), reopening it.
  const own = human.viewer
    ? human.dispositions.find(
        (disposition) =>
          disposition.unitId === unit.unitId &&
          disposition.actorId === human.viewer?.actor
      )
    : undefined
  // The meter's units a person's decision stands on (`personDecision`, the
  // overview's rule); one a carried decision closes is never among them.
  const metered = new Set(rail.map((entry) => entry.id))
  const decided = batch.units
    .filter(
      (other) =>
        metered.has(other.unitId) && personDecision(other, facts) !== undefined
    )
    .map((other) => other.unitId)
  // Its place among the batch's units of its lane, in the batch's order,
  // whichever rail group lists it.
  const group = inLane.map((other) => other.unitId)
  const attribution = attributionOf(unit, revision, agents, human, facts)
  const notRead = notReadOf(batch, agents, facts, human)
  // Each person's decision on an earlier version of a changed unit, as a
  // quiet note: it closes nothing and counts for nothing (14.12).
  const earlierDecisions = (human.earlier ?? []).map((work) => {
    const review = personReviewOf(
      { eventId: "", actorId: work.actorId, verdict: work.verdict },
      human.people,
      human.viewer
    )
    return {
      actor: review.actor,
      verdict: review.verdict,
      review: carriedLabel({ head: work.head }),
    }
  })
  const excluded = facts.excluded(unit)
  const count = hunkCount(unit, headersOf(sources))
  const paths = files.map((file) => file.path)
  return {
    repo: context.range.display?.project ?? context.repo,
    branch: branchOf(range),
    revision,
    reviewer: human.viewer
      ? reviewerOf(human.viewer)
      : { id: "unknown", name: "You", initials: "?" },
    cycle: 1,
    batchTitle,
    unit: {
      id: unit.unitId,
      title: titleOf(batch, unit),
      lane,
      ...unitFacts,
      ...(undecidedNotes.unit.length > 0
        ? { undecidedNotes: [...undecidedNotes.unit] }
        : {}),
      ...(excluded ? { excluded } : {}),
      ...(earlierDecisions.length > 0 ? { earlierDecisions } : {}),
      ...(placed.whole.length > 0 ? { comments: placed.whole } : {}),
      position: {
        index: Math.max(group.indexOf(unit.unitId), 0) + 1,
        of: group.length,
      },
      briefing,
      // The same notes apart, for the stops that don't show the briefing
      // as text (Facts, and Explained without rows).
      ...(notes.length > 0 ? { briefingNotes: notes } : {}),
      // Each change in its row: its claim, and its Facts and Explained
      // where the packet keeps them.
      ...(shownSections ? { sections: shownSections } : {}),
      stats: `${files.length} file${files.length === 1 ? "" : "s"} · ${count} hunk${count === 1 ? "" : "s"} · ${unit.references.length} marker${unit.references.length === 1 ? "" : "s"}`,
      hunkCount: count,
      defaultAttachment: "",
      draftSuggestion: "",
      scopeNote: `Only this unit’s owned lines in ${paths.join(", ")}.`,
      ...(attribution ? { attribution } : {}),
    },
    railUnits: rail,
    ...(carried.length > 0 ? { carriedUnits: carried } : {}),
    elsewhere: elsewhereOf(batch, agents, facts, human),
    ...(notRead.length > 0 ? { notReadUnits: notRead } : {}),
    batchUnits: batchUnits(batch),
    agents: EMPTY_AGENTS,
    markers: { ...markers, ...targets.extra },
    files,
    ...(delivery ? { delivery } : {}),
    humanRequiredTotal: rail.length,
    humanDecidedUnitIds: decided,
    commentRecords,
    commentSnapshotSequence: human.sequence,
    ...(own
      ? { currentDecision: { commandId: own.eventId, decision: own.verdict } }
      : {}),
  }
}

/** A comment carried onto the unit with a person's decision (it comes with the packet's). */
const carriedByPerson = (
  event: CommentEvent,
  human: Pick<HumanWork, "people">
) =>
  event.kind === "comment.carried@1" && human.people[event.actor] !== undefined

/** A note led by `title` and ": ", exactly. */
const ledBy = (note: string, title: string) =>
  title !== "" && note.startsWith(`${title}: `)

/** A plain object, read field by field: the fields below are not in the schema yet. */
const isFields = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** One field of a loose object, or undefined. */
const fieldOf = (value: unknown, name: string): unknown =>
  isFields(value) ? value[name] : undefined

/** Words, when there are any. */
const wordsOf = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value : undefined

/** A section's decided verdict; `unsure`, or anything else, is none. */
const decidedVerdict = (
  value: unknown
): "approve" | "request-changes" | undefined =>
  value === "approve" || value === "request-changes" ? value : undefined

/**
 * A guided list keyed by section (`sectionReviews`, `sectionNotes`): each
 * entry by its `section` key, the first one for a key.
 */
const bySectionKey = (list: unknown) => {
  const entries = new Map<string, Readonly<Record<string, unknown>>>()
  if (!Array.isArray(list)) return entries
  for (const entry of list as ReadonlyArray<unknown>) {
    const key = fieldOf(entry, "section")
    if (isFields(entry) && typeof key === "string" && !entries.has(key))
      entries.set(key, entry)
  }
  return entries
}

/**
 * What the review said of each section, by key, read from either place it
 * is written: the unit's `guided.sectionReviews` and `guided.sectionNotes`
 * first, else the section's own `review` in the sections blob (`message`,
 * `note`). Each field falls back on its own.
 */
const sectionSayings = (unit: Unit) => {
  const guided = unit.content.guided
  const reviews = bySectionKey(fieldOf(guided, "sectionReviews"))
  const notes = bySectionKey(fieldOf(guided, "sectionNotes"))
  const own = new Map(
    readSections(unit).map((section) => [section.key, section.review])
  )
  return (key: string) => {
    const keyed = reviews.get(key)
    const review = own.get(key)
    return {
      verdict:
        decidedVerdict(fieldOf(keyed, "verdict")) ??
        decidedVerdict(fieldOf(review, "verdict")),
      message:
        wordsOf(fieldOf(keyed, "message")) ??
        wordsOf(fieldOf(review, "message")),
      note:
        wordsOf(fieldOf(notes.get(key), "note")) ??
        wordsOf(fieldOf(review, "note")),
    }
  }
}

/**
 * Each decided section's own review, by key: its verdict and its words
 * ("Checked: …"), as written. Only a section with both: a
 * review written before sections had words of their own gives none, and
 * the desk shows that unit as before.
 */
export const sectionReviewsOf = (
  unit: Unit
): ReadonlyMap<
  string,
  { verdict: "approve" | "request-changes"; message: string }
> => {
  const said = sectionSayings(unit)
  const reviews = new Map<
    string,
    { verdict: "approve" | "request-changes"; message: string }
  >()
  for (const section of deskSections(unit)) {
    const { verdict, message } = said(section.id)
    if (verdict && message) reviews.set(section.id, { verdict, message })
  }
  return reviews
}

/**
 * Why no agent decided a unit, or some of its sections, as the Lane review
 * was unsure of them, in the unit's order, local IDs read out. A section's
 * own note (`guided.sectionNotes`, else its `review.note`) is placed by its
 * key. The title-led `guided.notes` (`<section title>: <reason>`) are read
 * for the rest: a line led by the title of a section that has its own note
 * says that note again and is left out, so a reason is never shown twice.
 * So is a line whose reason is a section's own note word for word, whatever
 * leads it: the readers sometimes lead it with a place ("neuve-graph at
 * line 1: …") rather than the section's title.
 *
 * - A section's own note goes to its row when it is one of `rows` (the
 *   rows the desk marks undecided, on a unit only partly undecided).
 * - A `guided.notes` line led by the exact published title of exactly one
 *   of `rows` goes to that row, without its title: the row's heading
 *   names it.
 * - Every other note is the unit's, shown under its header. Its section's
 *   title leads it, except when the page already says which code it is
 *   about: the unit has one section, or the title is the unit's own. A
 *   title two rows share is not guessed at: the line stays whole.
 */
export const undecidedNotesOf = (
  unit: Unit,
  rows: ReadonlyArray<{ id: string; title: string }> = []
): {
  unit: ReadonlyArray<string>
  bySection: ReadonlyMap<string, ReadonlyArray<string>>
} => {
  const sections = deskSections(unit)
  const said = [
    ...(sections.length === 1 ? [sections[0].title] : []),
    ...(unit.recorded ? [unit.recorded.payload.title] : []),
  ]
  const readable = (note: string, title: string | undefined) =>
    withoutLocalIds(
      title === undefined ? note : note.slice(title.length + 2)
    ).trim()
  const whole: Array<string> = []
  const bySection = new Map<string, Array<string>>()
  const sayings = sectionSayings(unit)
  // The readers write `guided.notes` beside the sections' own notes: a line
  // led by the title of a section that has its own says that note again, as
  // does a line whose reason is one of those notes, whatever leads it.
  const ownTitles: Array<string> = []
  const ownTexts: Array<string> = []
  for (const section of sections) {
    const note = sayings(section.id).note
    if (note === undefined) continue
    ownTitles.push(section.title)
    const text = readable(note, undefined)
    if (text === "") continue
    ownTexts.push(text)
    if (rows.some((row) => row.id === section.id))
      bySection.set(section.id, [...(bySection.get(section.id) ?? []), text])
    else
      whole.push(
        said.includes(section.title) ? text : `${section.title}: ${text}`
      )
  }
  const saysOwn = (note: string) => {
    const text = readable(note, undefined)
    return ownTexts.some((own) => text === own || text.endsWith(`: ${own}`))
  }
  const lines = (unit.content.guided?.notes ?? []).filter(
    (note) => !ownTitles.some((title) => ledBy(note, title)) && !saysOwn(note)
  )
  for (const note of lines) {
    const owners = rows.filter((row) => ledBy(note, row.title))
    const owner = owners.length === 1 ? owners[0] : undefined
    const text = owner
      ? readable(note, owner.title)
      : readable(
          note,
          said.find((title) => ledBy(note, title))
        )
    if (text === "") continue
    if (owner)
      bySection.set(owner.id, [...(bySection.get(owner.id) ?? []), text])
    else whole.push(text)
  }
  return { unit: whole, bySection }
}

/**
 * A unit's Facts with its parts' own facts taken out, each where it occurs
 * whole, and the spaces they leave closed: what the unit's Facts say beyond
 * its parts. Empty when they say nothing more.
 */
export const withoutParts = (text: string, parts: ReadonlyArray<string>) => {
  let rest = text
  for (const part of parts) {
    const trimmed = part.trim()
    if (trimmed !== "") rest = rest.split(trimmed).join(" ")
  }
  return rest.replace(/\s+/g, " ").trim()
}

/** The paths a unit's desk reads from git, and the blobs its references cite. */
export const unitReads = (unit: Unit) => ({
  paths: unitPaths(unit),
  blobs: [
    ...new Set(
      unit.references.flatMap((reference) =>
        reference.payload.provenance.kind === "git" &&
        reference.payload.provenance.blob !== undefined
          ? [reference.payload.provenance.blob]
          : []
      )
    ),
  ],
})
