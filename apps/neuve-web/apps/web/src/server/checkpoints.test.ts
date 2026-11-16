// Why (11.16-11.21): the desk and the overview's count read a unit's checkpoints from this
// projection, so its mapping is what a reviewer sees. Records sets each checkpoint's state and
// note at the read, and its anchors when the batch was created; this checks the boundary: the
// state, note and number pass through as Records gives them; Records' lines become the diff's
// lines on the side they change, one marker per line, so each line's pin, tint and card are its
// own; a checkpoint anchored to the unit as a whole gets one marker with no line; only a packet
// assessed before anchors existed (anchors null) has its lines placed here from its citations
// (every range of a hunk split between units, the old side only when nothing new is owned,
// overlapping lines merged); and the overview's unmet rule is Records' (Missing, Out of date,
// Conflicting). Guided (11.23) puts each checkpoint under the scope item its requirement rests on,
// so a checkpoint that lands under the wrong item, or vanishes into the foot, misleads the reader
// about what the item lacks. Records stores that link: each Guided row lists the requirements whose
// basis it is. A checkpoint sits under the row that lists its requirement, with its state, note,
// unmet flag and first lines, whatever its citations say: a basis that is no row while a row is
// cited, another row cited first in an older packet, or a basis the six-citation cut dropped. One
// no row lists stays unattached. Only content whose rows list no requirements falls back to the
// citations.
import { expect, test } from "bun:test"
import type { Checkpoints } from "@neuve/records-core"

import {
  checkpointsOf,
  guidedCheckpoints,
  isUnmetCheckpoint,
} from "./projection"

type Unit = Parameters<typeof checkpointsOf>[0]
type Found = Parameters<typeof checkpointsOf>[1]
// A version 1 checkpoint: these packets were assessed before sections.
type Checkpoint = Checkpoints.Checkpoint

const PATH = "src/reader.ts"
const UNIT = "01JZ0000000000000000000U01"
const AT_40 = "01JZ0000000000000000000R02"
const MANIFEST = `computation:${"a".repeat(64)}`

const reference = (id: string, line: number) => ({
  id,
  payload: {
    anchor: { path: PATH, side: "new", startLine: line, endLine: line },
  },
})

const checkpoint = (fields: Partial<Checkpoint>): Checkpoint => ({
  number: 1,
  requirement: "The reader returns the new default.",
  proof: "missing",
  note: "Nothing names what proves it.",
  kinds: [],
  records: [],
  anchors: [],
  sources: [],
  cites: [],
  ...fields,
})

const unit = (checkpoints: ReadonlyArray<Checkpoint>) =>
  ({
    local: "u1",
    unitId: UNIT,
    recorded: {
      payload: {
        title: "Reader default",
        ownedRanges: [
          {
            kind: "lines",
            path: PATH,
            side: "new",
            startLine: 10,
            endLine: 14,
          },
          {
            kind: "lines",
            path: PATH,
            side: "new",
            startLine: 40,
            endLine: 50,
          },
          {
            kind: "lines",
            path: PATH,
            side: "old",
            startLine: 30,
            endLine: 31,
          },
        ],
      },
    },
    assessment: undefined,
    content: {},
    references: [reference(AT_40, 40)],
    referenceDetails: {},
    comments: [],
    disposition: undefined,
    judgement: {},
    citations: { cited: [], resolved: 0, unresolved: 0 },
    checkpoints,
    proofCurrency: {},
  }) as unknown as Unit

const hunk = (
  ...ranges: Array<[side: "old" | "new", start: number, end: number]>
) => ({
  kind: "hunk" as const,
  path: PATH,
  ranges: ranges.map(([side, startLine, endLine]) => ({
    side,
    startLine,
    endLine,
  })),
})

const found = (entries: Record<string, unknown> = {}) =>
  new Map(Object.entries(entries)) as unknown as Found

const lines = (
  start: number,
  end: number,
  side: "additions" | "deletions" = "additions"
) => ({ path: PATH, range: { start, end, side } })

test("state, note and number pass through as Records gives them", () => {
  const [conflicting] = checkpointsOf(
    unit([
      checkpoint({
        number: 2,
        requirement: "A busy database is retried three times.",
        proof: "conflicting",
        note: "Its records disagree: a test run and logs.",
      }),
    ]),
    found()
  )
  expect(conflicting!.marker.tone).toBe("checkpoint")
  expect(conflicting!.marker.key).toBe(`checkpoint:${UNIT}:2`)
  expect(conflicting!.marker.checkpoint).toEqual({
    number: 2,
    requirement: "A busy database is retried three times.",
    proof: "conflicting",
    note: "Its records disagree: a test run and logs.",
  })
})

test("Records' lines are the diff's, one marker per line", () => {
  const marks = checkpointsOf(
    unit([
      checkpoint({
        proof: "out-of-date",
        anchors: [
          { path: PATH, side: "new", startLine: 10, endLine: 12 },
          { path: PATH, side: "old", startLine: 30, endLine: 31 },
        ],
      }),
    ]),
    found()
  )
  expect(marks.map((mark) => mark.anchor)).toEqual([
    lines(10, 12),
    lines(30, 31, "deletions"),
  ])
  expect(marks.map((mark) => mark.marker.key)).toEqual([
    `checkpoint:${UNIT}:1`,
    `checkpoint:${UNIT}:1:2`,
  ])
})

test("a checkpoint anchored to the unit as a whole has one marker and no line", () => {
  // An untied ticket item (11.21): Records anchors it to no line.
  const marks = checkpointsOf(
    unit([checkpoint({ anchors: [], cites: [{ ref: `event:${AT_40}` }] })]),
    found()
  )
  expect(marks).toHaveLength(1)
  expect(marks[0]!.anchor).toBeUndefined()
  expect(marks[0]!.marker.meta).toBe("This unit as a whole")
})

test("a packet assessed before anchors existed has its lines placed from its citations", () => {
  const before = (cites: Checkpoint["cites"], entries = {}) =>
    checkpointsOf(
      unit([checkpoint({ anchors: null, cites })]),
      found(entries)
    ).map((mark) => mark.anchor)
  // A hunk split between units: this unit's part, though another unit's is listed first.
  expect(
    before([{ ref: MANIFEST, entry: "h1" }], {
      h1: hunk(["new", 30, 39], ["new", 40, 50]),
    })
  ).toEqual([lines(40, 50)])
  // A removal anchors on the old side; a modification on its new side.
  expect(
    before([{ ref: MANIFEST, entry: "h2" }], { h2: hunk(["old", 29, 31]) })
  ).toEqual([lines(30, 31, "deletions")])
  expect(
    before([{ ref: MANIFEST, entry: "h3" }], {
      h3: hunk(["old", 30, 31], ["new", 10, 11]),
    })
  ).toEqual([lines(10, 11)])
  // A hunk and a reference on the same lines count the checkpoint once.
  expect(
    before([{ ref: MANIFEST, entry: "h4" }, { ref: `event:${AT_40}` }], {
      h4: hunk(["new", 40, 50]),
    })
  ).toEqual([lines(40, 50)])
  // Nothing resolves: the unit as a whole.
  expect(before([{ ref: MANIFEST, entry: "b1.o2" }])).toEqual([undefined])
})

test("unmet is Records' rule: Missing, Out of date or Conflicting", () => {
  expect(isUnmetCheckpoint({ proof: "missing" })).toBe(true)
  expect(isUnmetCheckpoint({ proof: "out-of-date" })).toBe(true)
  expect(isUnmetCheckpoint({ proof: "conflicting" })).toBe(true)
  expect(isUnmetCheckpoint({ proof: "thin" })).toBe(false)
  expect(isUnmetCheckpoint({ proof: "proven" })).toBe(false)
})

const CHANGE_MAP = `computation:${"c".repeat(64)}`
const cite = (entry: string) => ({
  ref: entry.startsWith("h") ? MANIFEST : CHANGE_MAP,
  entry,
})

type Rows = Parameters<typeof guidedCheckpoints>[1]
const OPEN = "A document already open stops showing its content."
const ENDS = "A revoke refuses the next request."

/** Two Guided rows, each listing the requirements whose basis it is. */
const ROWS: Rows = [
  { row: "b1.o1", requirements: [{ requirement: ENDS }] },
  { row: "b1.o2", requirements: [{ requirement: OPEN }] },
]

const attach = (checkpoints: ReadonlyArray<Checkpoint>, rows = ROWS) =>
  guidedCheckpoints(unit(checkpoints), rows, found(), undefined)

const placed = (result: ReturnType<typeof attach>) => ({
  byRow: Object.fromEntries(
    [...result.byRow].map(([row, entries]) => [
      row,
      entries.map((entry) => entry.number),
    ])
  ),
  unattached: result.unattached.map((entry) => entry.number),
})

test("Guided puts a checkpoint under the row that lists its requirement, with its state, note and lines", () => {
  const { byRow, unattached } = guidedCheckpoints(
    unit([
      checkpoint({
        number: 1,
        requirement: OPEN,
        proof: "conflicting",
        note: "Its records disagree: a test run and logs.",
        anchors: [{ path: PATH, side: "new", startLine: 11, endLine: 12 }],
        cites: [cite("b1.o2"), cite("h1")],
      }),
      // No row lists it: implied by the change.
      checkpoint({ number: 2, proof: "proven", note: "Proven.", anchors: [] }),
    ]),
    ROWS,
    found(),
    {
      mergeBase: "1".repeat(40),
      head: "2".repeat(40),
      files: {
        [PATH]: {
          newContents: Array.from(
            { length: 14 },
            (_, i) => `line ${i + 1}`
          ).join("\n"),
        },
      },
      blobs: {},
    } as unknown as Parameters<typeof guidedCheckpoints>[3]
  )
  expect([...byRow.keys()]).toEqual(["b1.o2"])
  expect(byRow.get("b1.o2")).toEqual([
    {
      number: 1,
      requirement: OPEN,
      proof: "conflicting",
      note: "Its records disagree: a test run and logs.",
      unmet: true,
      lines: {
        kind: "source",
        label: "reader.ts",
        target: "lines 11–12",
        markerKey: `checkpoint:${UNIT}:1`,
        excerpt: ["line 11", "line 12"],
      },
    },
  ])
  expect(unattached).toEqual([
    {
      number: 2,
      requirement: "The reader returns the new default.",
      proof: "proven",
      note: "Proven.",
      unmet: false,
    },
  ])
})

test("the row that lists the requirement decides, whatever the citations point at", () => {
  expect(
    placed(
      attach([
        // A basis Dispose kept as no row, then a row cited: Publish writes [b2.o9, b1.o1].
        checkpoint({
          number: 1,
          requirement: "Viewers see why access ended.",
          cites: [cite("b2.o9"), cite("b1.o1")],
        }),
        // An older packet, another row cited first and its basis b1.o2 last.
        checkpoint({
          number: 2,
          requirement: OPEN,
          cites: [cite("b1.o1"), cite("e1"), cite("b1.o2")],
        }),
        // An older packet whose basis the six-citation cut dropped.
        checkpoint({
          number: 3,
          requirement: ENDS,
          cites: ["h1", "h2", "h3", "h4", "h5", "h6"].map(cite),
        }),
      ])
    )
  ).toEqual({ byRow: { "b1.o2": [2], "b1.o1": [3] }, unattached: [1] })
})

test("a requirement matches as the event records it: control characters spaced, cut to 300", () => {
  const long = `A\u0007revoke ${"x".repeat(400)}`
  const recorded = `A revoke ${"x".repeat(291)}`
  expect(
    placed(
      attach(
        [checkpoint({ requirement: recorded })],
        [{ row: "b1.o1", requirements: [{ requirement: long }] }]
      )
    )
  ).toEqual({ byRow: { "b1.o1": [1] }, unattached: [] })
})

test("two rows listing the same words: the row the citations point at decides", () => {
  const rows: Rows = [
    { row: "b1.o1", requirements: [{ requirement: OPEN }] },
    { row: "b1.o2", requirements: [{ requirement: OPEN }] },
  ]
  expect(
    placed(
      attach(
        [
          checkpoint({ number: 1, requirement: OPEN, cites: [cite("b1.o2")] }),
          checkpoint({ number: 2, requirement: OPEN }),
        ],
        rows
      )
    )
  ).toEqual({ byRow: { "b1.o2": [1], "b1.o1": [2] }, unattached: [] })
})

test("content whose rows list no requirements falls back to the citations", () => {
  const bare: Rows = [{ row: "b1.o1" }, { row: "b1.o2" }]
  expect(
    placed(
      attach(
        [
          // The basis first, as Publish writes it now.
          checkpoint({ number: 1, cites: [cite("b1.o2"), cite("h1")] }),
          // An older packet: another citation first, the basis last.
          checkpoint({
            number: 2,
            cites: [cite("h1"), cite("b1.o1"), cite("b1.o2")],
          }),
          // No row cited.
          checkpoint({ number: 3, cites: [cite("b2.o9")] }),
        ],
        bare
      )
    )
  ).toEqual({ byRow: { "b1.o2": [1, 2] }, unattached: [3] })
})
