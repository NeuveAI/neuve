import { realPacketDeskFixtures } from "@workspace/ui/fixtures/real-packet.fixtures"
import type {
  Checkpoint,
  CheckpointProof,
  ContextualMarker,
  DiffSide,
  LineRange,
  ReviewDeskData,
} from "@workspace/ui/neuve/types"

/**
 * Checkpoints (10.110) on units of the real packet, as the projection
 * carries Records' checkpoints: one marker per line a checkpoint marks
 * (`checkpointsOf`). Each desk is found by what its checkpoints are, not by
 * its unit's ID, so a regenerated fixture moves the stories with it.
 */

const desks = Object.values(realPacketDeskFixtures)

const checkpointMarkers = (desk: ReviewDeskData) =>
  Object.values(desk.markers).filter((marker) => marker.checkpoint)

const checkpointCount = (desk: ReviewDeskData) =>
  new Set(checkpointMarkers(desk).map((marker) => marker.checkpoint!.number))
    .size

/** One line a unit's checkpoints mark: where, and how many meet there. */
export interface CheckpointLine {
  filePath: string
  side: DiffSide
  lineNumber: number
  range: LineRange
  count: number
}

/** The lines a desk's checkpoints mark, in the files' order. */
export function checkpointLines(desk: ReviewDeskData): Array<CheckpointLine> {
  const lines = new Map<string, CheckpointLine>()
  for (const file of desk.files)
    for (const anchor of file.markerAnchors) {
      if (!desk.markers[anchor.markerKey]?.checkpoint) continue
      const at = `${file.path}:${anchor.side}:${anchor.lineNumber}`
      const line = lines.get(at)
      if (line) line.count += 1
      else
        lines.set(at, {
          filePath: file.path,
          side: anchor.side,
          lineNumber: anchor.lineNumber,
          range: anchor.range ?? {
            start: anchor.lineNumber,
            end: anchor.lineNumber,
            side: anchor.side,
          },
          count: 1,
        })
    }
  return [...lines.values()]
}

/** A desk with two checkpoints, both Missing, on every line either marks. */
const twoMissingOnEachLine = (desk: ReviewDeskData) =>
  checkpointCount(desk) === 2 &&
  checkpointMarkers(desk).every(
    (marker) => marker.checkpoint!.proof === "missing"
  ) &&
  checkpointLines(desk).every((line) => line.count === 2)

/** The first unit whose two Missing checkpoints mark more than one line. */
export const twoLinesDesk = desks.find(
  (desk) => twoMissingOnEachLine(desk) && checkpointLines(desk).length > 1
)!

/** The first unit whose two Missing checkpoints share one line. */
export const sharedLineDesk = desks.find(
  (desk) => twoMissingOnEachLine(desk) && checkpointLines(desk).length === 1
)!

/* ── Every proof state ─────────────────────────────────── */

/**
 * The unit's own checkpoints in other proof states, with Records' notes for
 * them (records-core's `stateNote`): the real review records only Missing.
 */
function restated(
  desk: ReviewDeskData,
  states: Record<number, { proof: CheckpointProof; note: string }>
): ReviewDeskData {
  const markers = Object.fromEntries(
    Object.entries(desk.markers).map(([key, marker]) => {
      const state = marker.checkpoint && states[marker.checkpoint.number]
      return [
        key,
        state
          ? {
              ...marker,
              checkpoint: { ...marker.checkpoint!, ...state },
              applies: state.note,
            }
          : marker,
      ]
    })
  )
  return { ...desk, markers }
}

interface CheckpointSpec {
  checkpoint: Omit<Checkpoint, "number">
  /** The line it marks, or none for a checkpoint on the unit as a whole. */
  line?: CheckpointLine
}

function checkpointMarker(
  key: string,
  checkpoint: Checkpoint,
  line: CheckpointLine | undefined
): ContextualMarker {
  const where = line
    ? `${line.filePath} · ${line.range.start === line.range.end ? `line ${line.range.start}` : `lines ${line.range.start}–${line.range.end}`}`
    : "This unit"
  return {
    key,
    tone: "checkpoint",
    short: "Checkpoint",
    peek: checkpoint.requirement,
    kindLabel: "Checkpoint",
    title: checkpoint.requirement,
    meta: where,
    quote: checkpoint.requirement,
    applies: checkpoint.note,
    checkpoint,
    source: {
      kind: "Checkpoint",
      chips: [{ text: "Checkpoint", tone: "neutral" }],
      title: checkpoint.requirement,
      subtitle: where,
      actions: [],
      facts: [],
      blocks: [],
      citedBy: ["This unit"],
    },
  }
}

/** Checkpoints after the unit's own, placed as the projection places them. */
function withCheckpoints(
  desk: ReviewDeskData,
  specs: ReadonlyArray<CheckpointSpec>
): ReviewDeskData {
  const markers = { ...desk.markers }
  const files = desk.files.map((file) => ({
    ...file,
    markerAnchors: [...file.markerAnchors],
  }))
  const after = checkpointCount(desk)
  specs.forEach((spec, index) => {
    const number = after + index + 1
    const key = `checkpoint:${desk.unit.id}:${number}`
    markers[key] = checkpointMarker(
      key,
      { ...spec.checkpoint, number },
      spec.line
    )
    if (!spec.line) return
    const { filePath, side, lineNumber, range } = spec.line
    files
      .find((file) => file.path === filePath)
      ?.markerAnchors.push({ markerKey: key, side, lineNumber, range })
  })
  return { ...desk, markers, files }
}

const [firstLine, secondLine] = checkpointLines(twoLinesDesk)

/**
 * Every proof state once, and a ticket item no requirement covers (11.21),
 * anchored to the unit as a whole. The unit's two checkpoints read
 * Conflicting and Thin on every line they mark; Proven and Out of date are
 * written for the story on its second line, as the review recorded neither.
 */
export const allStatesDesk = withCheckpoints(
  restated(twoLinesDesk, {
    1: {
      proof: "conflicting",
      note: "Its records disagree: a test run and logs.",
    },
    2: {
      proof: "thin",
      note: "One kind of proof alone: a test run; not recorded: telemetry.",
    },
  }),
  [
    {
      checkpoint: {
        requirement:
          "An excerpt whose window already holds its heading gets no second copy of it.",
        proof: "proven",
        note: "Its kinds of proof agree and are current: a test run and logs.",
      },
      line: secondLine,
    },
    {
      checkpoint: {
        requirement:
          "An excerpt judged before heading context was added is read as it was.",
        proof: "out-of-date",
        note: "Out of date: a proof record it rests on was taken on a commit that is no longer in the branch's history (rebased, amended or force-pushed away).",
      },
      line: secondLine,
    },
    {
      checkpoint: {
        requirement:
          "Heading context is described in the ticket-change runbook.",
        proof: "missing",
        note: "Nothing names what proves it.",
      },
    },
  ]
)

/** The line where the unit's own two checkpoints lead, beside its references. */
export const allStatesLeadLine = firstLine!
