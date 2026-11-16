// Why (10.109): the desk marks a unit's separate changes from its sections. The projection gives a
// file the sections with the lines each owns there, in the order Records keeps; one section is the
// unit itself and a unit assembled before sections has none, so neither may mark anything, and a
// section's non-text range can't be drawn as lines, so it never reaches the diff.
import { expect, test } from "bun:test"

import { diffFile } from "./projection"
import type { Sources } from "./projection"

const HEAD = "5fa1ba94d6a0000000000000000000000000000a"
const BASE = "c0c47cea00000000000000000000000000000000b"

const old = Array.from({ length: 12 }, (_, i) => `l${i + 1}`)
const next = [
  ...old.slice(0, 2),
  "n3",
  ...old.slice(3, 9),
  "n10",
  ...old.slice(10),
]

const sources: Sources = {
  mergeBase: BASE,
  head: HEAD,
  blobs: {},
  files: {
    "src/a.ts": {
      path: "src/a.ts",
      oldPath: "src/a.ts",
      newPath: "src/a.ts",
      binary: false,
      oldContents: old.join("\n") + "\n",
      newContents: next.join("\n") + "\n",
      hunks: [3, 10].map((line) => ({
        oldStart: line,
        oldLines: 1,
        newStart: line,
        newLines: 1,
        text: `@@ -${line} +${line} @@\n-l${line}\n+n${line}\n`,
        added: 1,
        deleted: 1,
        changed: [
          { side: "old" as const, startLine: line, lineCount: 1 },
          { side: "new" as const, startLine: line, lineCount: 1 },
        ],
      })),
    },
  },
}

const lines = (side: "old" | "new", line: number) => ({
  kind: "lines" as const,
  hunkId: `h${line}`,
  path: "src/a.ts",
  side,
  startLine: line,
  endLine: line,
})

type Unit = Parameters<typeof diffFile>[1]
type Batch = Parameters<typeof diffFile>[2]

const unitWith = (sections?: Unit["sections"]) =>
  ({
    unitId: "u1",
    recorded: {
      payload: {
        ownedRanges: [
          lines("old", 3),
          lines("new", 3),
          lines("old", 10),
          lines("new", 10),
        ],
      },
    },
    ...(sections ? { sections } : {}),
  }) as unknown as Unit

const batchOf = (unit: Unit) => ({ units: [unit] }) as unknown as Batch

const reader = {
  id: "b1.s1",
  title: "The reader",
  ownedRanges: [lines("old", 3), lines("new", 3)],
}
const writer = {
  id: "b1.s3",
  title: "The writer",
  ownedRanges: [
    lines("old", 10),
    lines("new", 10),
    {
      kind: "whole-nontext" as const,
      hunkId: "h0",
      path: "src/a.ts",
      side: "new" as const,
    },
  ],
}

test("a file takes its unit's sections in order, each with the lines it owns there", () => {
  const unit = unitWith([reader, writer])
  const file = diffFile("src/a.ts", unit, batchOf(unit), sources, [])
  expect(file?.responsibility?.sections).toEqual([
    {
      id: "b1.s1",
      title: "The reader",
      ranges: [
        { side: "old", startLine: 3, endLine: 3 },
        { side: "new", startLine: 3, endLine: 3 },
      ],
    },
    {
      id: "b1.s3",
      title: "The writer",
      ranges: [
        { side: "old", startLine: 10, endLine: 10 },
        { side: "new", startLine: 10, endLine: 10 },
      ],
    },
  ])
})

test("one section, or none, marks nothing", () => {
  for (const sections of [[reader], undefined]) {
    const unit = unitWith(sections)
    const file = diffFile("src/a.ts", unit, batchOf(unit), sources, [])
    expect(file?.responsibility?.ownedSource).toHaveLength(4)
    expect(file?.responsibility?.sections).toBeUndefined()
  }
})
