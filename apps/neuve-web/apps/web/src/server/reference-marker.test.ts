// Why: the owner could not tell why a context card or its source sheet was shown. The projection now
// gives both surfaces a reference's tie (its stance, and the harness's grade for the owner's
// feedback), leaves code out of the card, and gives the sheet a slice with the lines around the
// citation and a caption saying which version of the code it reads. These checks hold the bounds and
// words at that seam: six lines each side unless the citation runs past its bound or the file's
// edges, a caption that names the whole citation, and no internal labels (chips, revision, grade or
// stance facts) on the sheet.
import { expect, test } from "bun:test"

import { referenceMarker } from "./projection"
import type { Sources } from "./projection"

const HEAD = "5fa1ba94d6a0000000000000000000000000000a"
const BASE = "c0c47cea00000000000000000000000000000000b"

/** A blob of numbered lines; the listed line numbers are blank. */
const blobOf = (length: number, blank: ReadonlyArray<number> = []) =>
  Array.from({ length }, (_, i) =>
    blank.includes(i + 1) ? "" : `    line ${i + 1}`
  )

const sourcesWith = (blob: ReadonlyArray<string>): Sources => ({
  mergeBase: BASE,
  head: HEAD,
  files: {},
  blobs: { blob1: blob },
})

type Unit = Parameters<typeof referenceMarker>[0]
type Reference = Parameters<typeof referenceMarker>[1]

const unit = (grade: string) =>
  ({
    unitId: "u1",
    recorded: {
      payload: {
        ownedRanges: [
          {
            kind: "lines",
            path: "src/a.ts",
            side: "new",
            startLine: 10,
            endLine: 30,
          },
        ],
      },
    },
    referenceDetails: {
      r1: {
        local: "r1",
        grade,
        why: "The adapter maps sides to the ownership callback.",
        beforeYouDecide: "Check that undefined sides map to additions.",
        locator: "src/b.ts:20-30",
        entries: [],
        anchors: [
          {
            hunk: "h1",
            path: "src/a.ts",
            side: "new",
            startLine: 12,
            endLine: 14,
          },
        ],
      },
    },
  }) as unknown as Unit

const reference = (
  stance: string,
  revision: string,
  startLine: number,
  endLine: number,
  unitIds: ReadonlyArray<string> = ["u1"]
) =>
  ({
    id: "r1",
    attribution: { unitIds },
    payload: {
      markerKind: "contextual-signal",
      source: { kind: "code", locator: "src/b.ts:20-30" },
      summary: "A summary.",
      anchor: { path: "src/a.ts", side: "new", startLine: 40, endLine: 41 },
      stance,
      origin: "committed",
      provenance: {
        kind: "git",
        revision,
        blob: "blob1",
        path: "src/lib/b.ts",
        startLine,
        endLine,
      },
    },
  }) as unknown as Reference

test("a supporting reference leads with its stance and drops internal labels", () => {
  const marker = referenceMarker(
    unit("necessary"),
    reference("supports", HEAD, 20, 30),
    new Map(),
    sourcesWith(blobOf(100, [20, 21]))
  )
  expect(marker.reference).toEqual({ stance: "supports", grade: "necessary" })
  expect(marker.meta).toBe("Supports")
  expect(marker.applies).toBe(
    "The adapter maps sides to the ownership callback."
  )
  expect(marker.check).toBe("Check that undefined sides map to additions.")
  // The card shows no code: the sheet holds it.
  expect(marker.excerpt).toBeUndefined()
  // The sheet: the file named by its path, no chips or facts, one code block.
  expect(marker.source.path).toBe("src/lib/b.ts")
  expect(marker.source.chips).toEqual([])
  expect(marker.source.facts).toEqual([])
  const [block] = marker.source.blocks
  if (block?.kind !== "code") throw new Error("Expected a code block")
  expect(block.caption).toBe("Lines 20–30, after this change")
  expect(block.lines.at(0)?.number).toBe(14)
  expect(block.lines.at(-1)?.number).toBe(36)
  expect(
    block.lines.filter((line) => line.cited).map((line) => line.number)
  ).toEqual([20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30])
})

test("an unresolved reference at the base says so, and an unknown grade is left out", () => {
  const marker = referenceMarker(
    unit("preloaded"),
    reference("unresolved", BASE, 2, 3),
    new Map(),
    sourcesWith(blobOf(4))
  )
  expect(marker.reference?.grade).toBeUndefined()
  expect(marker.meta).toBe("Unclear fit")
  const [block] = marker.source.blocks
  if (block?.kind !== "code") throw new Error("Expected a code block")
  expect(block.caption).toBe("Lines 2–3, before this change")
  // Context stops at the file's edges.
  expect(block.lines.map((line) => line.number)).toEqual([1, 2, 3, 4])
})

test("a citation past the sheet's bound stops at its last shown line", () => {
  const marker = referenceMarker(
    unit("useful"),
    reference("background", "0123456789abcdef", 10, 400),
    new Map(),
    sourcesWith(blobOf(500))
  )
  const [block] = marker.source.blocks
  if (block?.kind !== "code") throw new Error("Expected a code block")
  // The caption names the whole citation and says how much of it is shown.
  expect(block.caption).toBe(
    "Lines 10–400, at another commit · the first 120 shown"
  )
  expect(block.lines.at(0)?.number).toBe(4)
  expect(block.lines.at(-1)).toEqual({
    number: 129,
    text: "    line 129",
    cited: true,
  })
})
