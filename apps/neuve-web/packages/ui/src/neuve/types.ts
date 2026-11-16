import type { DeliveryPayload } from "@workspace/ui/neuve/shared/delivery"
import type { ReviewVerdict } from "@workspace/ui/neuve/shared/review-mark"

/**
 * View models for the review UI.
 *
 * Names follow the product vocabulary (vocabulary.md in the neuve root repo):
 * a review unit groups hunks, a contextual marker is a retrieved fragment
 * attributed to one hunk line, a read-only neighbor supplies context without
 * receiving the unit's disposition, and a review lane is a responsibility
 * category. These are presentation shapes only — no backend contract yet.
 */

import type { ReviewCommentRecord } from "./review-comments/record"
import type { ReviewThread } from "./review-comments/thread"
import type { ThreadCommentMetadata } from "./review-desk/thread-card"

export type ReviewLane =
  "human-required" | "human-suggested" | "agentic-review" | "static-automation"

export type Disposition = "approved" | "changes-requested"

/**
 * Kind of a margin item, which sets its pin, icon and family
 * (design/neuve-web/context-markers.md). Every value but `comment` is a
 * contextual marker kind: `failed` is a failed or invalidated check, `gap`
 * a reported assessment gap, `unavailable` linked evidence or a check that
 * could not be used, `test` a usable check, `source` captured source,
 * `decision` and `signal` recorded review signals. `comment` is a review
 * comment, a margin item that is not retrieved context.
 */
export type MarkerTone =
  | "conflict"
  | "decision"
  | "failed"
  | "gap"
  | "unavailable"
  | "comment"
  | "batch"
  | "signal"
  | "test"
  | "source"
  | "graph"
  | "history"
  | "doc"
  | "checkpoint"

/**
 * A checkpoint's proof state (10.110), set by Records' code in this order
 * (11.16, 11.19): missing, no record serves it; out of date, a record it
 * rests on is no longer current (11.10); conflicting, its records disagree;
 * proven, two or more current kinds that agree, every applicable kind
 * recorded, a test run among them where one can check it (11.20); thin,
 * anything else. Missing, out of date and conflicting are unmet.
 */
export type CheckpointProof =
  "proven" | "thin" | "missing" | "out-of-date" | "conflicting"

/**
 * What a change must satisfy (10.110): a requirement from its ticket or
 * plan, or what needs proving, with its proof state. It rides a contextual
 * marker of kind `checkpoint`, anchored on the owned lines that meet it, or
 * on no line when it is anchored to its unit as a whole (11.17).
 */
export interface Checkpoint {
  /** Its place among the unit's checkpoints, from 1. */
  number: number
  /** The requirement as the harness wrote it. */
  requirement: string
  proof: CheckpointProof
  /** What the state rests on, in a few words: "No proof is recorded." */
  note: string
}

/**
 * Where a contextual marker comes from.
 *
 * - `retrieved`: semantic context retrieved and attributed to a hunk line
 *   (the vocabulary.md meaning of a contextual marker).
 * - `review comment`: PROPOSAL (not yet in vocabulary.md) — a human inline
 *   review comment recorded on a hunk line and carried into the unit's
 *   markers so later cycles see it. It stays traceable to its comment record
 *   and the revision it was written against.
 */
export type MarkerSourceKind = "retrieved" | "review comment"

/** Trace from a `review comment` marker back to its record. */
export interface ReviewCommentTrace {
  commentId: string
  unitId: string
  /** Commit the comment was written against. */
  revision: string
  /** The lines it is about in the revision on screen (display order). */
  range: LineRange
  /** True when the comment was written against an earlier revision and was re-anchored by line text. */
  carriedForward: boolean
}

/* ── Context card (L2) ───────────────────────────────── */

/** One row of the graph read-by tree (`├`/`└` branches, file on the right). */
export interface ReadByNode {
  /** Tree prefix drawn in faint mono, e.g. "├ " or "│ └ ". */
  prefix: string
  name: string
  /** Short file shown on the right, or "not traced". */
  where: string
  /** Full `path:line`, revealed in a tooltip when `where` is truncated. */
  fullPath?: string
  tone: "root" | "node" | "untraced"
}

/** The kind-specific excerpt of a context card. */
export type MarkerExcerpt =
  | { kind: "tree"; nodes: Array<ReadByNode> }
  | {
      kind: "versus"
      a: { source: string; text: string }
      b: { source: string; text: string }
    }
  | { kind: "code"; code: string }
  | { kind: "quote"; text: string }

/** Where a context reference stands toward the change (Records' stance). */
export type ReferenceStance =
  "supports" | "contradicts" | "background" | "unresolved"

/**
 * A context reference's tie to the change, which its card (L2) and sheet
 * (L3) lead with: one word for how it bears on the change, before its
 * reason (reference-tie.ts). The lines are not repeated: the diff tints
 * them while the card is open.
 */
export interface ReferenceTie {
  stance: ReferenceStance
  /**
   * The harness's grade. Shown only beside the owner's feedback, which
   * records that the harness's call was visible.
   */
  grade?: "necessary" | "useful"
}

/**
 * The single action in a card's "Before you decide" callout. It does the
 * check the sentence names: open a unit, open a file, ask the implementer,
 * or request a check.
 */
export type MarkerCheckAction =
  | { kind: "unit"; label: string; unitId: string }
  | { kind: "file"; label: string; path: string }
  | { kind: "ask"; label: string }
  | { kind: "request-check"; label: string }

/* ── Source sheet (L3) ─────────────────────────────────── */

export type SourceTone = "neutral" | "outline" | "sug" | "req" | "agt"

export type SourceAction =
  | { kind: "editor"; editor: "VS Code" | "Cursor" | "Zed"; path: string }
  | { kind: "copy-path"; path: string }
  | { kind: "external"; label: string; href: string }
  | { kind: "link"; label: string; href: string }

export interface SourceFact {
  label: string
  value: string
  /** Coloured only when the fact carries status. */
  tone?: Exclude<SourceTone, "neutral" | "outline">
  mono?: boolean
}

export interface SourceRow {
  /** Leading mark: "1 hop", "◉", "!", a file glyph… */
  mark: string
  label: string
  sub?: string
  meta: string
  tone?: Exclude<SourceTone, "neutral" | "outline">
  /** Diff stat rows (`+6 −1`) colour each part. */
  stat?: { additions?: number; deletions?: number }
  /** Rows that can open in the editor (graph readers). */
  openPath?: string
}

export interface UnitHistoryRecord {
  id: string
  sequence: number
  title: string
  actor: string
  origin: string
  occurredAt: string
  recordedAt: string
  cycleId: string | null
  summary: string
}
export interface UnitHistoryPage {
  unitId: string
  records: UnitHistoryRecord[]
  highWaterMark: number
  nextAfter: number | null
}
export interface UnitHistoryLoader {
  page: (input: {
    unitId: string
    after: number
    through: number
  }) => Promise<UnitHistoryPage>
  record: (input: { unitId: string; recordId: string }) => Promise<string>
}

export type SourceBlock =
  | {
      kind: "comment-thread"
      record: ThreadCommentMetadata
      thread: ReviewThread
      unitLabel: string
      reviewer: Reviewer
    }
  | {
      kind: "code"
      lines: Array<{ number: number; text: string; cited: boolean }>
      /** A quiet line above the code: which lines, and from which version. */
      caption?: string
    }
  | { kind: "quote"; text: string }
  | { kind: "text"; text: string }
  | { kind: "label"; text: string }
  | { kind: "rows"; mono?: boolean; rows: Array<SourceRow> }
  | { kind: "history"; page: UnitHistoryPage }

/** L3 — the whole source, opened in the sheet. */
export interface MarkerSource {
  /** "Code", "Ticket", "History", "Graph", "Doc", "Test", "Comment". */
  kind: string
  chips: Array<{ text: string; tone: SourceTone }>
  title: string
  subtitle: string
  /**
   * The cited file. The header names it by its file name, the folder muted,
   * in place of the title and subtitle.
   */
  path?: string
  actions: Array<SourceAction>
  /** Up to four facts. */
  facts: Array<SourceFact>
  blocks: Array<SourceBlock>
  citedBy: Array<string>
  /** Present when the source belongs to another unit of the batch. */
  goToUnit?: string
}

/** A contextual marker attributed to one diff line. */
export interface ContextualMarker {
  key: string
  /** Defaults to `retrieved`. */
  sourceKind?: MarkerSourceKind
  /** Present on `review comment` markers. */
  trace?: ReviewCommentTrace
  /**
   * A review comment's author (review identity, round 4.2): the pin draws
   * this author's own avatar. Absent means a person whose initials are
   * `short`. Agent authors arrive only where the data says so (fixtures
   * today; the backend once comment records carry an author kind).
   */
  author?:
    | { kind: "person"; short: string }
    | { kind: "agent"; short: string; role: AgentRole; name?: string }
  tone: MarkerTone
  /**
   * Pin label (L0) in the data. The pin shows the kind's own label instead;
   * a review comment's `short` is its author's initials.
   */
  short: string
  /**
   * The cited file, when the marker points at one. The pin shows it faintly
   * after the kind, and only when it differs from the file under review.
   */
  target?: string
  /** One sentence to decide from (L1). */
  peek: string
  /**
   * L2 header: one kind label that already carries status, e.g.
   * "Same batch · unreviewed", "Conflict", "Evidence gap".
   */
  kindLabel: string
  title: string
  meta: string
  /** The cited text (a review comment's body). */
  quote: string
  /** Kind-specific excerpt in the card body. */
  excerpt?: MarkerExcerpt
  /** "Why it's here": one line. */
  applies: string
  /** "Before you decide": one plain sentence naming what to check. */
  check?: string
  checkAction?: MarkerCheckAction
  /**
   * Present on a published context reference: its card and sheet lead with
   * how it bears on the change and why it applies, then what to check.
   */
  reference?: ReferenceTie
  /** Present on a `checkpoint` marker: the requirement and its proof. */
  checkpoint?: Checkpoint
  /**
   * Other review units of the batch that carry the same marker. Shown as
   * dots on the pin and as linked units in the rail, never as a footnote.
   */
  sharedWith?: Array<string>
  source: MarkerSource
}

/** Which side of a diff a line number refers to (Pierre's AnnotationSide). */
export type DiffSide = "additions" | "deletions"

/**
 * A run of diff lines, Pierre's `SelectedLineRange`: it can start on one side
 * and end on the other (a deletion row through an addition row in the
 * stacked view). Stored top-to-bottom in display order.
 */
export interface LineRange {
  start: number
  side: DiffSide
  end: number
  /** Present only when the range ends on the other side. */
  endSide?: DiffSide
}

/** A contextual marker attributed to one line of a file's diff. */
export interface MarkerAnchor {
  markerKey: string
  side: DiffSide
  lineNumber: number
  /** The lines the marker is about (review comments); tinted when open. */
  range?: LineRange
}

/**
 * One changed file of a review unit. Full contents on both sides let the
 * diff renderer (the @workspace/diffs fork) expand collapsed context.
 */
export interface OwnedChangedSource {
  kind: "changed-lines"
  hunkId: string
  side: "old" | "new"
  sourceRevisionId: string
  startLine: number
  lineCount: number
  lines: string[]
}

/**
 * One of a unit's separate changes in its file (10.109): its title and the
 * changed lines it owns, a subset of the unit's owned lines.
 */
export interface DiffSection {
  id: string
  title: string
  ranges: Array<{ side: "old" | "new"; startLine: number; endLine: number }>
}

export interface DiffResponsibility {
  kind: "changed-ranges"
  unitId: string
  revisionId: string
  /** The unit's separate changes in this file, in file order; only when there are two or more. */
  sections?: Array<DiffSection>
  /** Changed lines in this file owned by other units of the batch (shown collapsed, read-only). */
  siblingSource?: Array<{
    unitId: string
    title: string
    lane?: ReviewLane
    /**
     * The lane words its title leaves out, set only when its stored title
     * named its lane after the file's name: a control that names no lane
     * says them after the title.
     */
    laneWords?: string
    side: "old" | "new"
    startLine: number
    lineCount: number
  }>
  ownedSource: Array<
    | OwnedChangedSource
    | {
        kind: "whole-nontext"
        hunkId: string
        sourceKind: "binary" | "metadata"
        text: string
      }
  >
}

export interface DiffFile {
  path: string
  responsibility?: DiffResponsibility
  /** Exact reviewed hunks; full contents must not add other changes to this scope. */
  patch?: string
  additions: number
  deletions: number
  oldContents: string
  newContents: string
  /** Unchanged lines kept around each change when hunks are computed. */
  context: number
  markerAnchors: Array<MarkerAnchor>
}

/** A muted context pin on a read-only neighbor, with its note shown. */
export interface NeighborContextNote {
  key: string
  short: string
  note: string
  side: DiffSide
  lineNumber: number
}

export interface ReadOnlyNeighbor {
  agentId?: string
  path: string
  /** Why it is read-only, e.g. its own lane and result. */
  note: string
  /** The neighbor's own unit: comments on it go there, never to this unit. */
  unitId: string
  /** Its lane, in the "decision stays with …" note. */
  laneLabel: string
  file: DiffFile
  /** Its own surrounding context, shown as muted pins when expanded. */
  contextNotes: Array<NeighborContextNote>
}

/**
 * The part of the change a briefing phrase describes (foundations/04,
 * "Descriptive text links to what it describes"; round-5.md): cited lines
 * of a file, a whole file, a contextual marker, or the unit's recorded
 * review. The generator emits each describing phrase with its target.
 */
export type BriefingPhraseTarget =
  | { kind: "lines"; filePath: string; range: LineRange }
  | { kind: "file"; filePath: string }
  | { kind: "marker"; markerKey: string }
  | { kind: "review" }
  /** A unit of the batch, from the batch digest (the overview only). */
  | { kind: "unit"; unitId: string }

/**
 * A contextual briefing's text, in order: plain text, phrases that link to
 * the part of the change they describe, and citation chips. A briefing with
 * no phrases is plain text and chips, as before.
 */
export type BriefingSegment =
  | { kind: "text"; text: string }
  | { kind: "phrase"; text: string; target: BriefingPhraseTarget }
  | {
      kind: "cite"
      label: string
      markerKey: string
      ariaLabel: string
      presentation?: "source-sheet"
    }

/** Explained as the harness writes it (10.60): before, after and up to three terms. */
export interface ExplainedText {
  before: string
  after: string
  terms: Array<{ term: string; meaning: string }>
  /**
   * The phrases Before and After linked that land on this desk, for the
   * change's "↳" line; Before and After themselves read as plain text.
   * Absent unless one resolved.
   */
  links?: Array<Extract<BriefingSegment, { kind: "phrase" }>>
}

/**
 * One of a joined unit's separate changes in its briefing (10.109): its
 * title and its claim, and its own Facts and Explained where the harness
 * keeps them per change.
 */
export interface BriefingSection {
  id: string
  title: string
  briefing: Array<BriefingSegment>
  facts?: Array<BriefingSegment>
  explained?: ExplainedText
  /** No agent decided this change in this run, though others of the unit were. */
  noAgentDecision?: true
  /**
   * With `noAgentDecision`: why no agent could decide this change, without
   * its title (the row's heading names it). Shown under its line.
   */
  undecidedNotes?: Array<string>
  /**
   * On a human-required unit of several changes: an agent decided this
   * change, and suggests this for it. Its verdict, and its own words
   * ("Checked: …"), plain. Absent on a change no agent
   * decided, and where the review gave the change no words of its own.
   */
  suggestion?: {
    decision: "approve" | "request_changes"
    message: Array<BriefingSegment>
  }
  /** An agent's comments that name this change but no lines of it. */
  comments?: Array<UnitLevelComment>
}

/**
 * Why no agent read a unit: a lockfile, or a file the repository declares
 * generated. The mark never approves the unit and it never waits on a person.
 */
export interface UnitExclusion {
  /** Records' reason, an open set: "lockfile" and "declared-generated" today. */
  reason: string
}

/** A person's review standing on a unit, as a review mark: who, the verdict, and the carried label. */
export interface PersonReview {
  actor: Extract<LineageReviewActor, { kind: "person" }>
  verdict: ReviewVerdict
  /** The earlier review it was carried from ("Earlier review, head 9c1e77b"). */
  carried?: string
}

/** A comment on the whole unit, with no lines: a person's or an agent's. */
export interface UnitLevelComment {
  id: string
  author: LineageReviewActor
  body: string
  /** Carried with a person's decision from an earlier review ("Earlier review, head 9c1e77b"). */
  carried?: string
  /** The agent's review mark it carries, when it is a finding with a verdict. */
  verdict?: ReviewVerdict
}

/** A person's standing decision on an earlier version of a changed unit: it closes nothing. */
export interface EarlierDecision {
  actor: Extract<LineageReviewActor, { kind: "person" }>
  verdict: ReviewVerdict
  /** The earlier review, as the carried label names it ("Earlier review, head 9c1e77b"). */
  review: string
}

/**
 * What a unit's row says about its review lane beyond the lane itself, on
 * every surface that lists units.
 */
export interface UnitLaneFacts {
  /**
   * No agent decided this unit in this run, so it is human-required and has
   * no suggested review. Surfaces say it in one line: "No agent decision in
   * this run".
   */
  noAgentDecision?: true
  /** The review lane the unit was in at the last run, when it has risen since. */
  raisedFrom?: ReviewLane
}

export interface RailUnit extends UnitLaneFacts {
  id: string
  title: string
  hunkCount: number
  scopeLabel?: string
  /** The implementer that owns the unit (comments route to it). */
  agentId?: string
  /** As on `LaneUnit`: set only when the unit has no written title. */
  untitled?: { files: Array<UntitledFile> }
  /**
   * On a unit that arrived closed by a person's decision carried from an
   * earlier review (a `carriedUnits` row): the person's review that stands
   * on it, with the carried label (the earlier review's short head) while
   * the carried one stands, without it once they decided it fresh.
   */
  carriedReview?: {
    actor: LineageReviewActor
    verdict: ReviewVerdict
    carried?: string
  }
}

export interface ElsewhereLane {
  lane: Exclude<ReviewLane, "human-required">
  label: string
  count: number
  note?: string
  /** The lane's units, listed when its rail group expands. */
  units?: Array<LaneUnit>
}

/** A unit inside a rail lane group, with its result. */
export interface LaneUnit {
  id: string
  title: string
  /**
   * The lane words its title leaves out ("human suggested"), set only in a
   * group that names no lane ("Not read") and only when its stored title
   * named its lane after the file's name: the row says them after the title
   * to screen readers.
   */
  laneWords?: string
  /** "agent ✓", "changes", "passed". Shown when there is no `review`. */
  result: string
  tone?: "req"
  /**
   * The agent's recorded review on this unit (review identity, round 4.2).
   * When present, the rail shows the 16px review mark instead of `result`.
   */
  review?: {
    reviewer: Pick<BranchAgent, "id" | "short" | "name" | "role">
    verdict: ReviewVerdict
  }
  /**
   * Set only when the unit has no written title: the review could not assess
   * it, so its title is a line code built from its path and hunk counts. The
   * files it owns ranges in, in order, each with its owned line spans; the
   * rail names the unit by these, and `title` stays its accessible name.
   */
  untitled?: { files: Array<UntitledFile> }
  /** The review lane the unit was in at the last run, when it has risen since. */
  raisedFrom?: ReviewLane
  /** A person's decision that stands on the unit; the rail shows it in place of `result` and `review`. */
  personReview?: PersonReview
  /** No agent read the unit (a lockfile or a generated file); shown in place of `result`. */
  excluded?: UnitExclusion
}

/** A file an untitled unit owns ranges in, and the owned line spans there. */
export interface UntitledFile {
  path: string
  /** Owned changed lines, new side where the unit has any, else old side. */
  lines: Array<{ start: number; end: number }>
}

export type ResponsibilityPresentation =
  | {
      lane: ReviewLane
      responsibility?:
        { kind: "legacy" } | { kind: "resolved"; assessmentId: string }
    }
  | {
      lane?: never
      responsibility:
        | { kind: "provisional-unassessed"; historicalProjection: ReviewLane }
        | {
            kind: "unresolved"
            assessmentId: string
            historicalProjection: ReviewLane
            author: string
            runId: string
            gaps: Array<{
              requirement: string
              reportedObservation: string
              investigation: string
              referenceLabel: string
              availability: string
              markerKey: string
            }>
          }
    }

/** Any review unit of the batch, for linking shared markers to the rail. */
export type BatchUnit = ResponsibilityPresentation & {
  id: string
  title: string
}

/* ── Agents on the branch (registry) ───────────────────── */

/**
 * Working labels, not vocabulary.md terms: "implementer" writes the change,
 * "reviewer" reviews it. Neuve owns roles, scopes and routing; ACP carries
 * none of them.
 */
export type AgentRole = "implementer" | "reviewer"

/** An agent working on part of the branch. */
export interface BranchAgent {
  id: string
  /** Avatar initials, e.g. "I1". */
  short: string
  /** e.g. "Implementer 1". */
  name: string
  role: AgentRole
  /** The part of the branch it owns: a label and its paths. */
  scope: { label: string; paths: Array<string> }
  unitCount: number
}

/**
 * A harness configured on the server that Connect may start. The browser
 * picks one by id; it never supplies a command.
 */
export interface ConfiguredAgent {
  id: string
  label: string
  roles: Array<AgentRole>
}

export type AgentConnection =
  | {
      status: "connected"
      harnessId: string
      activity: string
      detail?: string
    }
  | { status: "connecting"; harnessId: string; detail?: string }
  | { status: "disconnected"; detail?: string }

export interface AgentRegistry {
  agents: Array<BranchAgent>
  configured: Array<ConfiguredAgent>
  /** Initial connection status by agent id (live status lives in jotai). */
  connections: Record<string, AgentConnection>
}

/* ── New commit mid-review (Cycle.dc.html) ─────────────── */

/** Distinguishes a branch-ref observation from an explicit new-commit event. */
export type NewCommitEvent = {
  commit: string
  /** Null when a responsibility assessment for this commit is unavailable. */
  needYou: number | null
  /** The commit the reviewer is mid-review on. */
  reviewing: string
} & ({ kind: "branch-moved" } | { kind?: "new-commit" })

export type LineageRelation = "renewed" | "corrected" | "regrouped" | "carried"

/**
 * Who recorded a verdict in the lineage, in the shape the review mark draws
 * at 16px with its words: "You approved", "R1 approved" (the review-identity
 * decision, `design/neuve-web/changes/round-4.md` in the Neuve repository).
 * An agent carries its registry identity, so the mark renders without the
 * registry, as `LaneUnit.review` does. A person carries their avatar;
 * `isYou` marks the person viewing, whose words read "You". Both variants
 * are assignable to the mark's `ReviewActor`.
 */
export type LineageReviewActor =
  | {
      kind: "agent"
      agent: Pick<BranchAgent, "id" | "short" | "name" | "role">
    }
  | { kind: "person"; person: Reviewer; isYou: boolean }

/** A recorded verdict on an earlier unit: who decided, and what. */
export interface LineageReview {
  actor: LineageReviewActor
  verdict: ReviewVerdict
}

export interface LineageEntry {
  id: string
  relation: LineageRelation
  /** The units of the earlier commit, with their result. */
  before: Array<{
    title: string
    /**
     * Status words ("Assessment pending", "passed"). Shown only when there
     * is no `review`, as in `LaneUnit`; a verdict is said by `review`.
     */
    result: string
    tone: "approved" | "changes" | "agent"
    /** The recorded verdict on this unit, when there is one. */
    review?: LineageReview
  }>
  after: string
  afterNote: string
  needsYou: boolean
  /** The reviewer's comment the change answers, if any. */
  quote?: string
  note?: string
  /** Renewed signal: the unchanged hunk next to what changed under it. */
  renewed?: {
    approved: { file: string; note: string; line: number; text: string }
    changed: {
      file: string
      note: string
      line: number
      removed: string
      added: string
    }
    why: string
    evidence: string
  }
  unitId?: string
}

export interface CommitLineage {
  repo: string
  branch: string
  from: string
  to: string
  cycle: number
  needYou: number
  carried: number
  entries: Array<LineageEntry>
}

/**
 * Who recorded a lineage disposition or relation claim (round 3.1), mapped
 * from Records by the BFF. `viewer` marks the person viewing (the local
 * reviewer), so only their own decisions read "You".
 *
 * Drawn as a review-mark actor: an agent resolves by `id` in the
 * branch's `AgentRegistry`; the viewer is the desk's `Reviewer`; any other
 * person is named by `id`, with initials taken from it. The fixtures keep
 * every agent id in the registry and the viewer's id equal to the
 * reviewer's.
 */
export interface LineageAuthor {
  kind: "human" | "agent"
  id: string
  viewer: boolean
}

export interface RegisteredRevisionView {
  revisionId: string
  sourceAvailable: boolean
  limitations: string[]
  units: Array<
    ResponsibilityPresentation & {
      id: string
      title: string
      hunkIds: string[]
      result: string
      deskAvailable: boolean
      needsYou: boolean
      dispositions: Array<{
        id: string
        author: LineageAuthor
        decision: "approve" | "request-changes"
        rationale: string
        current: boolean
        retracted: boolean
      }>
    }
  >
}

export interface RegisteredCommitLineage {
  kind: "registered"
  repo: string
  branch: string
  from: string | null
  to: string
  cycle: null
  before: RegisteredRevisionView | null
  after: RegisteredRevisionView
  relations:
    | { kind: "unknown" }
    | {
        kind: "recorded"
        records: Array<{
          id: string
          relation: LineageRelation
          author: LineageAuthor
          rationale: string
          before: Array<{ unitId: string; hunkIds: string[] }>
          after: Array<{ unitId: string; hunkIds: string[] }>
          comments: Array<{
            commandId: string
            unitId: string
            revisionId: string
          }>
          evidence: Array<{
            evidenceId: string
            unitId: string
            revisionId: string
            validity: string
          }>
        }>
        unlinkedBeforeUnitIds: string[]
        unlinkedAfterUnitIds: string[]
      }
}

/** The person reviewing; authors inline review comments. */
export interface Reviewer {
  id: string
  name: string
  initials: string
}

export interface ReviewDeskData {
  repo: string
  branch: string
  /** Commit under review. */
  revision: string
  reviewer: Reviewer
  cycle: number
  batchTitle: string
  unit: ResponsibilityPresentation & {
    id: string
    title: string
    /** As on `UnitLaneFacts`: no agent decided this unit in this run. */
    noAgentDecision?: true
    /**
     * Why no agent could decide it, one note per change the agent was
     * unsure of, in the unit's order, shown under its header's "No agent
     * decision" line. A note is led by its change's title ("checkout in
     * projects.ts: …") unless the unit has one change or the title is the
     * unit's own. On a unit only partly undecided, each change's note is on
     * its row (`BriefingSection.undecidedNotes`); one that names no row
     * stays here, under the header. A change's own note (keyed to it) is
     * placed by its key; the title-led notes only where it has none.
     */
    undecidedNotes?: Array<string>
    /** As on `UnitLaneFacts`: the review lane it was in at the last run, when it has risen since. */
    raisedFrom?: ReviewLane
    /** No agent read the unit (a lockfile or a generated file). */
    excluded?: UnitExclusion
    /** People's standing decisions on earlier versions of this changed unit, one quiet note each. */
    earlierDecisions?: Array<EarlierDecision>
    /** Comments on the whole unit, with no lines: a person's or an agent's, shown under its briefing. */
    comments?: Array<UnitLevelComment>
    decisionSignal?: "conflict"
    position: { index: number; of: number }
    /** With `sections`, only the lead before them. */
    briefing: Array<BriefingSegment>
    /**
     * What Records wrote about the unit, in its words (a briefing that
     * failed or was cut, lines that didn't read, what couldn't be carried):
     * the text `briefing` leads with, kept apart for the stops that don't
     * show the briefing as text, Facts and Explained without rows.
     */
    briefingNotes?: Array<string>
    /** A joined unit's changes, in file order; only when there are two or more. */
    sections?: Array<BriefingSection>
    stats: string
    hunkCount: number
    scopeLabel?: string
    /** Marker attached to a change request when nothing else is open. */
    defaultAttachment: string
    draftSuggestion: string
    scopeNote: string
    /** Owning implementer (comments and change requests route to it). */
    agentId?: string
    /**
     * Units outside the human-required lane: who decided it and how. The
     * reviewer can agree or request changes (suggested) or comment.
     */
    attribution?: UnitAttribution
    nativeChecks?: Array<
      NonNullable<UnitAttribution["checks"]>[number] & {
        id: string
        markerKey: string
      }
    >
    generatedDiffs?: Array<{
      label: string
      file: DiffFile
      provenance: Array<{ markerKey: string; summary: string }>
    }>
  }
  /** "Needs your decision": the human-required units no carried decision closes. */
  railUnits: Array<RailUnit>
  /**
   * Human-required units that arrived closed by a person's decision carried
   * from an earlier review: the rail's own "Decided" group for the whole
   * review, whatever the reader does on them after, never under "Needs your
   * decision" nor in its meter. Absent when none.
   */
  carriedUnits?: Array<RailUnit>
  /**
   * The units outside human-required work no agent read (lockfiles and
   * generated files): the rail's own collapsed "Not read" group, below the
   * lanes decided by agents and tools, out of those lanes' groups. Absent
   * when none.
   */
  notReadUnits?: Array<LaneUnit & { lane: ReviewLane }>
  elsewhere: Array<ElsewhereLane>
  /** The review's batches, for the header's batch menu. */
  batches?: ReviewBatches
  /** Every unit a shared marker can link to. */
  batchUnits: Array<BatchUnit>
  agents: AgentRegistry
  markers: Record<string, ContextualMarker>
  files: Array<DiffFile>
  /**
   * Review delivery layers for the dial (round 4). Fixtures only for now; the
   * desk shows the dial only when this is present.
   */
  delivery?: DeliveryPayload
  neighbor?: ReadOnlyNeighbor
  /** The meter's total: `railUnits`, the human-required units no carried decision closes. */
  humanRequiredTotal: number
  /** Current, non-retracted human dispositions in the required lane. */
  humanDecidedUnitIds?: string[]
  /** A new commit arrived while this revision is under review. */
  newCommit?: NewCommitEvent
  /** Comment threads with the agents (by comment record id). */
  threads?: Array<ReviewThread>
  commentRecords?: Array<ReviewCommentRecord>
  commentSnapshotSequence?: number
  currentDecision?: {
    commandId: string
    decision: "approve" | "request-changes"
  }
  /**
   * The reader's feedback on this unit (vocabulary: Feedback; 10.100): what
   * each control answers on and the reader's current answer there. Absent
   * where Records can't take feedback (the `/mock` pages).
   */
  feedback?: DeskFeedback
  /**
   * A newer review of this work replaced this unit's while the reader was on
   * it: the unit that holds the work now, or, with none that opens, the
   * newest review's batch (absent: the Reviews page).
   */
  newer?: { unitId: string } | { batchId?: string }
}

/* ── Feedback (10.100, M5 FB1–FB5) ─────────────────────── */

export type ReferenceGrade =
  "necessary" | "useful" | "irrelevant" | "misleading"
export type FindingJudgement = "valid" | "invalid" | "unsure"
export type YesNo = "yes" | "no"
/** A note's length, as the reference rubric asks it (10.107). */
export type NoteLength = "too-short" | "right" | "too-long"

/**
 * One answer on the sheet's scales. A reader may answer some scales and
 * leave others, or give a note alone, but never nothing.
 */
export type FeedbackAnswer =
  | {
      on: "unit"
      complexity?: "low" | "high"
      easeOfValidation?: "easy" | "hard"
      lane?: ReviewLane
      verdict?: "approve" | "request-changes"
      note?: string
    }
  | { on: "finding"; judged?: FindingJudgement; note?: string }
  | {
      on: "reference"
      grade?: ReferenceGrade
      /** The other grade of an in-between answer, never the same as `grade`. */
      between?: ReferenceGrade
      /*
       * The note's rubric (10.107), each row optional: an unanswered row is
       * left out and reads blank, never yes. `checkActionable` is asked only
       * when the reference has a "Before you decide" check.
       */
      saysWhy?: YesNo
      tiedToLines?: YesNo
      checkActionable?: YesNo
      accurate?: YesNo
      length?: NoteLength
      note?: string
    }
  | {
      on: "digest"
      accurate?: YesNo
      complete?: YesNo
      misleadingClaim?: "none" | "some"
      neutralBeforeVerdict?: YesNo
      note?: string
    }

export type FeedbackOn = FeedbackAnswer["on"]

/** An answer as Records holds it. */
export interface SavedFeedback {
  eventId: string
  at: string
  answer: FeedbackAnswer
}

/** What one control answers on: a Records event, and the reader's current answer. */
export interface FeedbackTarget {
  /** The event ID the answer names. */
  target: string
  saved?: SavedFeedback
}

/** The delivery stops a unit's digest answers can name. */
export type DigestContent = "facts" | "briefed" | "explained" | "guided"

export interface DeskFeedback {
  /** The unit's `unit.recorded` event. */
  unit?: FeedbackTarget
  /** The agent's findings, by comment record ID (its comment's event ID). */
  findings: Record<string, FeedbackTarget>
  /**
   * Context references, by marker key (its reference's event ID), with the
   * harness's grade when the card shows one.
   */
  references: Record<string, FeedbackTarget & { harnessGrade?: string }>
  /** The unit's digests, by delivery stop. */
  digests: Partial<Record<DigestContent, FeedbackTarget>>
}

/** What the desk sends to record one answer. */
export type FeedbackSubmission = FeedbackAnswer & {
  target: string
  /** True when the harness's call on the item was on screen as the reader answered. */
  harnessCallVisible: boolean
}

/** How an agent or tool decided a unit outside the human-required lane. */
export interface UnitAttribution {
  /** "Agent approved", "Agent requested changes", "Passed static automation". */
  headline: string
  meta: string
  summary?: string
  outcome: "approved" | "changes-requested" | "passed"
  evidence?: Array<string>
  waiting?: string
  checks?: Array<{
    title: string
    detail: string
    meta: string
    tone: "blocking" | "note" | "passed"
  }>
  /** Generated code, collapsed behind "Show generated diff". */
  generatedDiff?: { label: string; file: DiffFile }
  /**
   * The agent whose review this is (review identity, round 4.2). Carried with
   * the attribution so the review mark renders without the agents registry.
   * Absent for static automation, which has no agent.
   */
  reviewer?: Pick<BranchAgent, "id" | "short" | "name" | "role">
  /** A person's decision stands on the unit, fresh or carried: their review, in the agent's place. */
  person?: Pick<PersonReview, "actor" | "carried">
}

/* ── Batch overview ─────────────────────────────────────── */

export interface LaneSummary {
  lane: ReviewLane
  name: string
  count: number
  /**
   * No surface renders it and the server no longer writes it. The generated
   * fixtures still carry it; it goes when they are regenerated.
   */
  line?: string
}

export interface JudgmentUnit extends UnitLaneFacts {
  id: string
  title: string
  /** As on `LaneUnit`: set only when the unit has no written title. */
  untitled?: { files: Array<UntitledFile> }
  /** A contextual marker that conflicts with the change, said in a phrase. */
  signal?: { text: string }
  files: number
  hunks: number
  markers: number
  unapproved?: number
  /** Owning agent tag, e.g. I1. */
  agentId?: string
}

/** A human-required unit a person has decided, and the review that stands. */
export interface DecidedUnit {
  id: string
  title: string
  review: {
    actor: LineageReviewActor
    verdict: ReviewVerdict
    /** Carried from an earlier review: the carried label, as on `OverviewUnit`. */
    carried?: string
  }
}

/**
 * A unit as the overview lists it, under its lane: the review that stands on
 * it, when one does. A human-required unit has one only once a person decides
 * it; on the other lanes it is the agent's, unless a person's overrides it.
 */
export interface OverviewUnit extends UnitLaneFacts {
  id: string
  title: string
  lane: ReviewLane
  /** As on `LaneUnit`: set only when the unit has no written title. */
  untitled?: { files: Array<UntitledFile> }
  review?: {
    actor: LineageReviewActor
    verdict: ReviewVerdict
    carried?: string
  }
  /** No agent read the unit (a lockfile or a generated file). */
  excluded?: UnitExclusion
}

/**
 * A unit an agent requested changes on that no person has decided, as the
 * decision panel names it: the agent's actor ID when the packet says which.
 */
export interface AgentChangesUnit {
  id: string
  title: string
  agentId?: string
}

/** A unit's checkpoints: how many, and how many have no proof yet. */
export interface UnitCheckpoints {
  total: number
  unmet: number
}

/** A batch of the review, as the header's batch menu lists it. */
export interface ReviewBatch {
  id: string
  title: string
  unitCount: number
  /**
   * Units no person has decided yet: human-required ones, and on the Reviews
   * page human-suggested ones too (10.127).
   */
  needYou: number
}

/** Where a review's newest run stands. */
export type ReviewRunState = "running" | "completed" | "timed-out" | "failed"

/** A human unit's standing decision on the Reviews page: a person's review, or waiting on one. */
export type ReviewGateMark = "approved" | "changes-requested" | "waiting"

/** The lanes whose units wait on a person (10.127). */
export type ReviewHumanLane = Extract<
  ReviewLane,
  "human-required" | "human-suggested"
>

/** One human-required or human-suggested unit of a review, as its row draws it. */
export interface ReviewGateUnit {
  lane: ReviewHumanLane
  mark: ReviewGateMark
}

/** Which reviews the Reviews page lists. */
export type ReviewsFilter = "all" | "waiting"

/** One review (cycle) on the Reviews page. */
export interface ReviewSummary {
  /** The cycle's Records ID. */
  id: string
  /** Its first batch's title; while it has none, its head commit's subject. */
  title: string
  /** Its range as `base..head`, each shortened. */
  range: string
  /** When its newest run ended, failed, started or was requested (ISO). */
  at: string
  state: ReviewRunState
  /** Units by lane, in lane order; lanes with none are left out. */
  lanes: Array<{ lane: ReviewLane; count: number }>
  /** One per human-required or human-suggested unit, in packet order. */
  gate: Array<ReviewGateUnit>
  /** Whether anyone gave feedback on it (10.127). */
  feedback: boolean
  /** Its batches in packet order; `needYou` counts its human units no person has decided. */
  batches: Array<ReviewBatch>
  /** Batches of this review not published yet: still being reviewed. Absent or 0 once it is whole. */
  pendingBatches?: number
  /** A later review holds the work of every unit of this one: nothing of it waits on a person here, and its row says "Replaced by a newer review". */
  newer?: true
}

export interface ReviewsData {
  repo: string
  /** This page's reviews, newest run first. */
  reviews: Array<ReviewSummary>
  filter: ReviewsFilter
  /** 1-based. */
  page: number
  pageSize: number
  /** Reviews the filter lists, over every page. */
  total: number
  counts: { all: number; waiting: number }
  /** The human units no person has decided across reviews, and the unit Open next opens. */
  waiting: { units: number; reviews: number; nextUnitId?: string }
  /** The head the newest review reviewed, for the new-work notice. */
  newestHead?: string
}

export type ReviewsLoad =
  | { status: "ready"; data: ReviewsData }
  /** No review was ever started here. */
  | { status: "empty" }

/** The review's batches in its order, and the one on screen. */
export interface ReviewBatches {
  current: string
  all: Array<ReviewBatch>
  /** Whether this is the newest review. */
  newest?: boolean
  /** Batches of this review not published yet. Absent or 0 once it is whole. */
  pending?: number
  /**
   * The review stopped with batches unpublished: no run of it is going or
   * queued. Absent while they are still being reviewed.
   */
  stopped?: true
}

/**
 * One ticket item across a batch's units (10.87): its words, its status
 * over the units that need it, and each unit's own, in the Guided card's
 * words. A unit's status is scoped to that unit ("met for this unit").
 */
export interface DigestObligation {
  text: string
  /** Which words its statuses take: a "Done when" item is done, a scope covered. */
  basis: "done-when" | "scope" | "gathered"
  /**
   * Over the units that need it: met, not met, no evidence, or met on some
   * of them. Absent when Records' value is one the desk doesn't know.
   */
  overall?:
    | { kind: "met" | "not-met" | "no-evidence" }
    | { kind: "partly"; met: number; of: number }
  /** The units it rests on, in the batch's order; one that doesn't need it says so. */
  units: Array<{
    unitId: string
    title: string
    /** As on `LaneUnit`: said after the title to screen readers, since the digest names no lane. */
    laneWords?: string
    status: "met" | "not-met" | "no-evidence" | "not-required"
    /** As on the unit page's row for this item: its file has no proof record. */
    proofState?: "missing"
  }>
}

export interface BatchOverviewData {
  repo: string
  title: string
  ticket: string
  branch: string
  revision: string
  unitCount: number
  briefing: string
  contextualBriefing?: {
    /** What the batch removes, disables or narrows; shown first. */
    removed?: BriefingSegment[]
    /** What changed, and why, as the digest says it. */
    segments: BriefingSegment[]
    /** What to check: the digest's account of what was verified. */
    toCheck?: BriefingSegment[]
    /**
     * What to check, too: each ticket item's status across the batch's
     * units (10.87), as code writes it from their Guided rows.
     */
    obligations?: DigestObligation[]
    markers: Record<string, ContextualMarker>
    limitations: string[]
  }
  /** The review's batches, for the header's batch menu. */
  batches?: ReviewBatches
  /** Human-required units no person has decided in the review's cycle. */
  needYou: number
  /** Units no agent read (lockfiles, generated files, any other mark); absent when none. */
  notRead?: number
  /**
   * Human-required units a person has decided in the review's cycle, with
   * the verdict that stands. They leave `judgment` and `needYou`; an undo or
   * a new cycle puts a unit back there.
   */
  decided?: Array<DecidedUnit>
  /**
   * Every unit with a lane, in the batch's order, with the review that stands.
   * Without it the overview lists only the human-required units it has from
   * `judgment` and `decided`.
   */
  units?: Array<OverviewUnit>
  /**
   * Units in any lane an agent requested changes on that no person has
   * decided, in the batch's order; absent when none. While nothing waits on
   * you, the decision panel names them instead of an outcome, so it never
   * says nothing needs you over them.
   */
  agentChanges?: Array<AgentChangesUnit>
  firstUnitId: string
  lanes: Array<LaneSummary>
  judgment: Array<JudgmentUnit>
  /**
   * Each unit's checkpoints, by unit ID: how many it has and how many have
   * no proof yet. A unit without checkpoints is absent.
   */
  checkpoints?: Record<string, UnitCheckpoints>
  agents: AgentRegistry
  /**
   * A newer review of this work replaced this batch's while the reader was
   * on it: the newest review's batch (absent: the Reviews page).
   */
  newer?: { batchId?: string }
}

/* ── Page loads (route loader results) ─────────────────── */

/*
 * What a page's loader returns. Today the real routes return the empty
 * shape and the `/mock` routes return fixtures; a BFF loader later returns
 * the same shapes, so the screens never change.
 */

export type BatchOverviewLoad =
  | { status: "ready"; data: BatchOverviewData }
  | { status: "empty"; reason: "no-batch" }

/** Enough of the batch to frame a desk with no unit to show. */
export interface DeskBatchContext {
  repo: string
  branch: string
  revision: string
  /** The batch's Records ID, for links back to its overview (fixtures may leave it out). */
  batchId?: string
  batchTitle: string
  elsewhere: Array<ElsewhereLane>
  agents: AgentRegistry
}

export type ReviewDeskLoad =
  | {
      status: "missing"
      reason: "unknown-unit"
      unitId: string
      batch: DeskBatchContext
    }
  | { status: "ready"; data: ReviewDeskData }
  | { status: "empty"; reason: "no-batch" }
  | { status: "empty"; reason: "no-decision"; batch: DeskBatchContext }

/** `notFound({ data })` for a unit id that is not in the revision. */
export interface UnknownUnitData {
  reason: "unknown-unit"
  unitId: string
  batch?: DeskBatchContext
}

export interface ObservedCommit {
  repo: string
  branch: string
  from: string
  to: string
  observedAt: string
}

export type CommitLineageLoad =
  | {
      status: "ready"
      lineage: CommitLineage
      agents: AgentRegistry
      /** The person viewing: their avatar on verdicts and quoted comments. */
      reviewer?: Reviewer
    }
  | {
      status: "registered"
      lineage: RegisteredCommitLineage
      agents: AgentRegistry
      /** The person viewing: their avatar on verdicts and quoted comments. */
      reviewer?: Reviewer
    }
  | { status: "observed"; commit: ObservedCommit; agents: AgentRegistry }
  | {
      status: "unavailable"
      reason: string
      batch: DeskBatchContext
      commit: string
    }
  | { status: "empty"; reason: "no-batch" }
