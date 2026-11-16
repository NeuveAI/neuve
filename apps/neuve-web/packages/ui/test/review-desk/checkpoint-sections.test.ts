/**
 * Which checkpoint pins the margin shows (`shownAnchors`), tested because
 * the rule alone decides it and a story can only sample real packets. The
 * independent review of the once-per-section change found that a range
 * Records merged across a section's edge pinned only its first section:
 * here an additions range 10–20 runs over sections 10–14 and 15–20, and the
 * checkpoint must show once in each, at its first changed line there, with
 * its card and hint on that pin alone.
 */
import { describe, expect, test } from "bun:test"

import {
  pinMarkerKey,
  recordedMarkerKey,
} from "@workspace/ui/neuve/review-desk/atoms"
import {
  checkpointEntries,
  shownAnchors,
} from "@workspace/ui/neuve/review-desk/checkpoint-parts"
import {
  displayRows,
  toFileDiff,
} from "@workspace/ui/neuve/review-desk/diff-model"
import type {
  ContextualMarker,
  DiffFile,
  DiffSection,
  MarkerAnchor,
} from "@workspace/ui/neuve/types"

const REVISION = "e".repeat(40)
const PATH = "src/spans.ts"

const old = Array.from({ length: 30 }, (_, i) => `export const a${i + 1} = 0`)
// Lines 10–20 change on both sides; the rest stay.
const changed = (i: number) => i >= 10 && i <= 20
const next = old.map((line, i) =>
  changed(i + 1) ? `export const b${i + 1} = 1` : line
)
const text = (lines: Array<string>) => `${lines.join("\n")}\n`

const TWO: Array<DiffSection> = [
  {
    id: "first",
    title: "First change",
    ranges: [
      { side: "old", startLine: 10, endLine: 14 },
      { side: "new", startLine: 10, endLine: 14 },
    ],
  },
  {
    id: "second",
    title: "Second change",
    ranges: [
      { side: "old", startLine: 15, endLine: 20 },
      { side: "new", startLine: 15, endLine: 20 },
    ],
  },
]

function fileWith(
  markerAnchors: Array<MarkerAnchor>,
  sections: Array<DiffSection> = TWO
): DiffFile {
  return {
    path: PATH,
    oldContents: text(old),
    newContents: text(next),
    context: 3,
    additions: 11,
    deletions: 11,
    markerAnchors,
    responsibility: {
      kind: "changed-ranges",
      unitId: "unit",
      revisionId: REVISION,
      ...(sections.length > 0 ? { sections } : {}),
      ownedSource: [
        {
          kind: "changed-lines",
          hunkId: "h",
          side: "old",
          sourceRevisionId: "f".repeat(40),
          startLine: 10,
          lineCount: 11,
          lines: old.slice(9, 20),
        },
        {
          kind: "changed-lines",
          hunkId: "h",
          side: "new",
          sourceRevisionId: REVISION,
          startLine: 10,
          lineCount: 11,
          lines: next.slice(9, 20),
        },
      ],
    },
  }
}

function checkpoint(key: string, number: number): ContextualMarker {
  return {
    key,
    tone: "checkpoint",
    short: "Checkpoint",
    peek: `Requirement ${number}`,
    kindLabel: "Checkpoint",
    title: `Requirement ${number}`,
    meta: PATH,
    quote: `Requirement ${number}`,
    applies: "No proof is recorded.",
    checkpoint: {
      number,
      requirement: `Requirement ${number}`,
      proof: "missing",
      note: "No proof is recorded.",
    },
    source: {
      kind: "Checkpoint",
      chips: [],
      title: `Requirement ${number}`,
      subtitle: PATH,
      actions: [],
      facts: [],
      blocks: [],
      citedBy: ["This unit"],
    },
  }
}

const additions = (
  markerKey: string,
  start: number,
  end: number
): MarkerAnchor => ({
  markerKey,
  side: "additions",
  lineNumber: start,
  range: { start, end, side: "additions" },
})

function shown(file: DiffFile, markers: Record<string, ContextualMarker>) {
  const rows = displayRows(toFileDiff(file, REVISION), file)
  return shownAnchors(file, markers, rows)
}

const at = (anchors: ReadonlyArray<MarkerAnchor>) =>
  anchors.map((anchor) => `${anchor.side}:${anchor.lineNumber}`)

describe("checkpoint pins by section", () => {
  test("a range across a section's edge pins each section it touches", () => {
    const anchor = additions("c1", 10, 20)
    const markers = { c1: checkpoint("c1", 1) }
    const result = shown(fileWith([anchor]), markers)
    expect(at(result.anchors)).toEqual(["additions:10", "additions:15"])
    // The first pin is the recorded anchor itself.
    expect(result.anchors[0]).toBe(anchor)
    // The second has a marker of its own, about its section's lines, so
    // its card and hint stay on it.
    const second = result.anchors[1]!
    expect(second.markerKey).toBe(pinMarkerKey("c1", "additions", 15))
    expect(second.range).toEqual({ start: 15, end: 20, side: "additions" })
    expect(result.markers[second.markerKey]).toEqual({
      ...markers.c1,
      key: second.markerKey,
    })
    expect(recordedMarkerKey(second.markerKey)).toBe("c1")
  })

  test("in each section it shows on the first changed line its anchors touch there", () => {
    // Recorded in data order: a later range first, then one starting above.
    const markers = { c1: checkpoint("c1", 1), c2: checkpoint("c2", 1) }
    const result = shown(
      fileWith([additions("c1", 17, 20), additions("c2", 12, 18)]),
      markers
    )
    // Section one at 12 (c2); section two at 15 (c2's range), not 17.
    expect(at(result.anchors)).toEqual(["additions:12", "additions:15"])
    expect(result.anchors.map((anchor) => anchor.markerKey)).toEqual([
      "c2",
      pinMarkerKey("c2", "additions", 15),
    ])
  })

  test("a range inside one section still shows once", () => {
    const markers = { c1: checkpoint("c1", 1), c2: checkpoint("c2", 1) }
    const result = shown(
      fileWith([additions("c1", 10, 12), additions("c2", 13, 14)]),
      markers
    )
    expect(at(result.anchors)).toEqual(["additions:10"])
    expect(result.markers).toBe(markers)
  })

  test("deleted lines of a range count on their own side", () => {
    const anchor: MarkerAnchor = {
      markerKey: "c1",
      side: "deletions",
      lineNumber: 13,
      range: { start: 13, end: 16, side: "deletions" },
    }
    const result = shown(fileWith([anchor]), { c1: checkpoint("c1", 1) })
    expect(at(result.anchors)).toEqual(["deletions:13", "deletions:15"])
  })

  test("a range on one side never pins the other side's lines of a later hunk", () => {
    // Two hunks, 10–14 and 16–20, with line 15 unchanged between them.
    const kept = next.map((line, i) => (i + 1 === 15 ? old[14]! : line))
    const owned = (
      side: "old" | "new",
      start: number,
      lines: Array<string>
    ) => ({
      kind: "changed-lines" as const,
      hunkId: `h${start}`,
      side,
      sourceRevisionId: side === "old" ? "f".repeat(40) : REVISION,
      startLine: start,
      lineCount: 5,
      lines: lines.slice(start - 1, start + 4),
    })
    const base = fileWith(
      [additions("c1", 10, 20)],
      [
        { ...TWO[0]! },
        {
          ...TWO[1]!,
          ranges: [
            { side: "old", startLine: 16, endLine: 20 },
            { side: "new", startLine: 16, endLine: 20 },
          ],
        },
      ]
    )
    const file: DiffFile = {
      ...base,
      newContents: text(kept),
      additions: 10,
      deletions: 10,
      responsibility: {
        ...base.responsibility!,
        ownedSource: [
          owned("old", 10, old),
          owned("new", 10, kept),
          owned("old", 16, old),
          owned("new", 16, kept),
        ],
      },
    }
    const result = shown(file, { c1: checkpoint("c1", 1) })
    // Deleted line 16 comes first in the stacked view; the pin skips it.
    expect(at(result.anchors)).toEqual(["additions:10", "additions:16"])
    expect(result.anchors[1]!.range).toEqual({
      start: 16,
      end: 20,
      side: "additions",
    })
  })

  test("without sections, anchors that only unchanged lines separate show once", () => {
    const markers = { c1: checkpoint("c1", 1), c2: checkpoint("c2", 1) }
    const result = shown(
      fileWith([additions("c1", 10, 20), additions("c2", 15, 20)], []),
      markers
    )
    expect(at(result.anchors)).toEqual(["additions:10"])
  })

  test("other checkpoints and other markers keep their pins", () => {
    const { checkpoint: _, ...note } = checkpoint("note", 3)
    const markers: Record<string, ContextualMarker> = {
      c1: checkpoint("c1", 1),
      c2: checkpoint("c2", 2),
      note: { ...note, tone: "decision" },
    }
    const result = shown(
      fileWith([
        additions("c1", 10, 20),
        additions("c2", 16, 16),
        { markerKey: "note", side: "additions", lineNumber: 18 },
      ]),
      markers
    )
    expect(result.anchors.map((a) => `${a.markerKey}@${a.lineNumber}`)).toEqual(
      ["c1@10", `${pinMarkerKey("c1", "additions", 15)}@15`, "c2@16", "note@18"]
    )
  })

  test("the briefing lands on the recorded anchor's pin, never a further one", () => {
    const anchor = additions("c1", 10, 20)
    const markers = { c1: checkpoint("c1", 1) }
    const [entry] = checkpointEntries(markers, [fileWith([anchor])], REVISION)
    expect(entry!.marker.key).toBe("c1")
    expect(entry!.at).toEqual({
      filePath: PATH,
      side: "additions",
      lineNumber: 10,
      range: anchor.range!,
    })
  })
})
