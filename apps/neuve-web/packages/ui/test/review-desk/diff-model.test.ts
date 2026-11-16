/**
 * Owned ranges (round 3 item 5): buildRangedView invariants, ported from the
 * independent review's probe. Every changed line of the original stays in
 * the ranged diff exactly once with its owner, and with every gap expanded
 * the ranged diff reproduces both files line for line.
 *
 * Stretches (other units' lines folded into gap rows): tested because the
 * model alone decides which lines a gap row stands for. At every opening
 * step, the lines the renderer draws and the lines the gap rows name must
 * cover the new file exactly once, so the line numbers read on across each
 * row (the owner's requirement), and opening ends on the whole file.
 */
import { describe, expect, test } from "bun:test"
import { createStore } from "jotai"

import {
  OWNED_REVISION,
  crowdedRangedFile,
  gapSizesFile,
} from "@workspace/ui/fixtures/owned-ranges.fixtures"
import {
  GAP_CHUNK,
  gapExpansionAtom,
  openSiblingsAtom,
  openStretchAtom,
} from "@workspace/ui/neuve/review-desk/diff-atoms"
import {
  INLINE_GAP,
  displayRows,
  hiddenGapLines,
  rangedLayout,
  rangedView,
  stretchHides,
  stretchView,
  toFileDiff,
} from "@workspace/ui/neuve/review-desk/diff-model"
import type {
  RangedLayout,
  RangedView,
  StretchState,
} from "@workspace/ui/neuve/review-desk/diff-model"
import type { DiffFile } from "@workspace/ui/neuve/types"

const REVISION = "d".repeat(40)

/** Deterministic PRNG (mulberry32), so a failure reproduces. */
function prng(seed: number) {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Block {
  owned: boolean
  /** Old lines removed (1-based) and new lines added (1-based). */
  oldLines: Array<number>
  newLines: Array<number>
}

function randomCase(seed: number, withPatch: boolean) {
  const rand = prng(seed)
  const pick = (n: number) => Math.floor(rand() * n)
  const total = 20 + pick(40)
  const old = Array.from({ length: total }, (_, i) => `o${seed}_${i + 1}`)
  const next: Array<string> = []
  const blocks: Array<Block> = []
  let added = 0
  let i = 0
  while (i < old.length) {
    // At least one unchanged line between blocks.
    if (i > 0 && rand() < 0.6) {
      next.push(old[i]!)
      i++
      continue
    }
    const kind = pick(3) // 0 replace, 1 delete, 2 insert
    const removed = kind === 2 ? 0 : 1 + pick(3)
    const inserted = kind === 1 ? 0 : 1 + pick(3)
    const block: Block = {
      owned: blocks.length === 0 || rand() < 0.5,
      oldLines: [],
      newLines: [],
    }
    for (let k = 0; k < removed && i < old.length; k++) block.oldLines.push(++i)
    for (let k = 0; k < inserted; k++) {
      next.push(`n${seed}_${++added}`)
      block.newLines.push(next.length)
    }
    if (block.oldLines.length + block.newLines.length > 0) blocks.push(block)
    if (i < old.length) {
      next.push(old[i]!)
      i++
    }
  }
  const noEol = rand() < 0.3
  const text = (lines: Array<string>) => lines.join("\n") + (noEol ? "" : "\n")
  const path = `src/case-${seed}.ts`
  const source = (block: Block, side: "old" | "new") => {
    const lines = side === "old" ? block.oldLines : block.newLines
    return {
      side,
      startLine: lines[0]!,
      lineCount: lines.length,
      lines: lines.map((line) => (side === "old" ? old : next)[line - 1]!),
    }
  }
  const sides = (block: Block) =>
    (["old", "new"] as const).filter((side) =>
      side === "old" ? block.oldLines.length > 0 : block.newLines.length > 0
    )
  const patch = withPatch
    ? [
        `diff --git a/${path} b/${path}`,
        `--- a/${path}`,
        `+++ b/${path}`,
        ...blocks.flatMap((block) => {
          const d = block.oldLines.length
          const a = block.newLines.length
          // Unified-diff headers: an empty side names the line before it.
          const oldStart = d > 0 ? block.oldLines[0]! : oldBefore(block)
          const newStart = a > 0 ? block.newLines[0]! : newBefore(block)
          return [
            `@@ -${oldStart},${d} +${newStart},${a} @@`,
            ...block.oldLines.map((line) => `-${old[line - 1]}`),
            ...(noEol && block.oldLines.at(-1) === old.length
              ? ["\\ No newline at end of file"]
              : []),
            ...block.newLines.map((line) => `+${next[line - 1]}`),
            ...(noEol && block.newLines.at(-1) === next.length
              ? ["\\ No newline at end of file"]
              : []),
          ]
        }),
        "",
      ].join("\n")
    : undefined
  // Unchanged lines before a block, counted on each side.
  function oldBefore(block: Block) {
    const at = next.indexOf(next[(block.newLines[0] ?? 1) - 1]!)
    // Lines before the first added line that are old lines.
    return (
      next.slice(0, at).filter((line) => line.startsWith("o")).length +
      blocks
        .slice(0, blocks.indexOf(block))
        .reduce((sum, b) => sum + b.oldLines.length, 0)
    )
  }
  function newBefore(block: Block) {
    const first = block.oldLines[0]!
    const unchangedBefore =
      first -
      1 -
      blocks
        .slice(0, blocks.indexOf(block))
        .reduce((sum, b) => sum + b.oldLines.length, 0)
    return (
      unchangedBefore +
      blocks
        .slice(0, blocks.indexOf(block))
        .reduce((sum, b) => sum + b.newLines.length, 0)
    )
  }
  const file: DiffFile = {
    path,
    oldContents: text(old),
    newContents: text(next),
    ...(patch ? { patch } : {}),
    context: 0,
    additions: next.length,
    deletions: old.length,
    markerAnchors: [],
    responsibility: {
      kind: "changed-ranges",
      unitId: "unit",
      revisionId: REVISION,
      ownedSource: blocks
        .filter((block) => block.owned)
        .flatMap((block) =>
          sides(block).map((side) => ({
            kind: "changed-lines" as const,
            hunkId: `h${blocks.indexOf(block)}`,
            sourceRevisionId: REVISION,
            ...source(block, side),
          }))
        ),
      siblingSource: blocks
        .filter((block) => !block.owned)
        .flatMap((block) =>
          sides(block).map((side) => {
            const { lines: _lines, ...range } = source(block, side)
            return { unitId: "sibling", title: "Sibling", ...range }
          })
        ),
    },
  }
  return { file, old, next, blocks }
}

function check(seed: number, withPatch: boolean) {
  const { file, old, next, blocks } = randomCase(seed, withPatch)
  const view = rangedView(file, REVISION)!
  openEveryStep(view, next.length)
  const diff = view.fileDiff
  const strip = (line: string | undefined) => (line ?? "").replace(/\n$/, "")
  let oldCursor = 1
  let newCursor = 1
  let unified = 0
  let split = 0
  const deleted: Array<number> = []
  const addedLines: Array<number> = []
  diff.hunks.forEach((hunk, index) => {
    const d = hunk.deletionCount
    const a = hunk.additionCount
    const newBoundary = hunk.additionStart - (a > 0 ? 1 : 0)
    const oldBoundary = hunk.deletionStart - (d > 0 ? 1 : 0)
    // The gap is the same unchanged lines on both sides.
    expect(newBoundary - newCursor + 1).toBe(hunk.collapsedBefore)
    expect(oldBoundary - oldCursor + 1).toBe(hunk.collapsedBefore)
    for (let k = 0; k < hunk.collapsedBefore; k++)
      expect(strip(diff.additionLines[newCursor - 1 + k])).toBe(
        strip(diff.deletionLines[oldCursor - 1 + k])
      )
    for (let k = 0; k < d; k++) {
      expect(strip(diff.deletionLines[hunk.deletionLineIndex + k])).toBe(
        old[oldBoundary + k]!
      )
      deleted.push(oldBoundary + k + 1)
    }
    for (let k = 0; k < a; k++) {
      expect(strip(diff.additionLines[hunk.additionLineIndex + k])).toBe(
        next[newBoundary + k]!
      )
      addedLines.push(newBoundary + k + 1)
    }
    // One owner per run, the owner of its lines.
    const owner = view.runs[index]!.owner.kind
    for (const block of blocks) {
      const mine =
        block.oldLines.some(
          (line) => line > oldBoundary && line <= oldBoundary + d
        ) ||
        block.newLines.some(
          (line) => line > newBoundary && line <= newBoundary + a
        )
      if (mine) expect(owner).toBe(block.owned ? "owned" : "sibling")
    }
    unified += hunk.collapsedBefore + d + a
    split += hunk.collapsedBefore + Math.max(d, a)
    oldCursor = oldBoundary + d + 1
    newCursor = newBoundary + a + 1
  })
  const trailing = next.length - newCursor + 1
  expect(old.length - oldCursor + 1).toBe(trailing)
  expect(diff.unifiedLineCount).toBe(unified + trailing)
  expect(diff.splitLineCount).toBe(split + trailing)
  // Every changed line of the original diff exactly once (read from the
  // renderer's own parse, not from this generator: a line losing its final
  // newline is a change there too).
  const original = changedLines(
    toFileDiff({ ...file, responsibility: undefined }, REVISION)
  )
  expect(deleted).toEqual(original.deleted)
  expect(addedLines).toEqual(original.added)
  // Gaps are the unchanged runs, trailing included.
  const sizes = diff.hunks
    .map((hunk) => hunk.collapsedBefore)
    .filter((size) => size > 0)
  if (trailing > 0) sizes.push(trailing)
  expect(view.gaps.map((gap) => gap.size)).toEqual(sizes)

  // displayRows (selection, composer lines, comment re-anchoring): every
  // row's text is the file line at its numbers, including the first
  // unchanged line after a deletion-only or insertion-only run (the
  // empty-side boundary regression).
  const rows = displayRows(diff, file)
  expect(rows.length).toBe(diff.unifiedLineCount)
  for (const row of rows) {
    if (row.kind !== "addition")
      expect(row.text).toBe(old[(row.oldLine ?? 0) - 1]!)
    if (row.kind !== "deletion")
      expect(row.text).toBe(next[(row.newLine ?? 0) - 1]!)
  }
  return blocks.some(
    (block) => block.oldLines.length === 0 || block.newLines.length === 0
  )
}

/** Changed line numbers of a diff, from its hunk content. */
function changedLines(diff: ReturnType<typeof toFileDiff>) {
  const deleted: Array<number> = []
  const added: Array<number> = []
  for (const hunk of diff.hunks) {
    let oldLine = hunk.deletionStart + (hunk.deletionCount === 0 ? 1 : 0)
    let newLine = hunk.additionStart + (hunk.additionCount === 0 ? 1 : 0)
    for (const block of hunk.hunkContent) {
      if (block.type === "context") {
        oldLine += block.lines
        newLine += block.lines
        continue
      }
      for (let k = 0; k < block.deletions; k++) deleted.push(oldLine++)
      for (let k = 0; k < block.additions; k++) added.push(newLine++)
    }
  }
  return { deleted, added }
}

/**
 * The new-side lines the renderer draws under a layout: owned runs, open
 * sibling runs, and each gap's revealed lines unless the gap is hidden.
 */
function drawnLines(
  view: RangedView,
  layout: RangedLayout,
  state: StretchState
): Array<number> {
  const lines: Array<number> = []
  const hidden = new Set(layout.hiddenGaps)
  const folded = new Set(
    layout.folds.filter((fold) => fold.collapsed).map((fold) => fold.hunkIndex)
  )
  for (const gap of view.gaps) {
    if (hidden.has(gap.hunkIndex)) continue
    const closed =
      gap.size <= INLINE_GAP
        ? { count: 0, start: 0, end: -1 }
        : hiddenGapLines(gap, state.expansion?.[gap.hunkIndex])
    for (let line = gap.newStart; line <= gap.newEnd; line++)
      if (line < closed.start || line > closed.end) lines.push(line)
  }
  for (const run of view.runs) {
    if (folded.has(run.hunkIndex)) continue
    const hunk = view.fileDiff.hunks[run.hunkIndex]!
    for (let k = 0; k < hunk.additionCount; k++)
      lines.push(hunk.additionStart + k)
  }
  return lines
}

/**
 * Open every stretch row by row through the desk's own action, checking
 * after each press that drawn lines and row spans cover 1..total once.
 */
function openEveryStep(view: RangedView, total: number) {
  const store = createStore()
  const key = "file"
  const state = (): StretchState => ({
    expansion: store.get(gapExpansionAtom)[key],
    openRuns: store.get(openSiblingsAtom)[key],
  })
  for (let press = 0; ; press++) {
    expect(press).toBeLessThan(10_000)
    const layout = rangedLayout(view, state(), false)
    const covered = [
      ...drawnLines(view, layout, state()),
      ...layout.rows.flatMap((row) => {
        // A row's span is one contiguous block of new lines.
        expect(row.lines.count).toBe(
          row.lines.count > 0 ? row.lines.end - row.lines.start + 1 : 0
        )
        return Array.from(
          { length: row.lines.count },
          (_, k) => row.lines.start + k
        )
      }),
    ].sort((a, b) => a - b)
    expect(covered).toEqual(Array.from({ length: total }, (_, k) => k + 1))
    // Only a row's head run keeps a fold row.
    expect(
      layout.folds.filter((fold) => fold.row).map((fold) => fold.hunkIndex)
    ).toEqual(
      layout.rows.flatMap((row) =>
        row.head?.kind === "run" ? [row.head.run.hunkIndex] : []
      )
    )
    const row = layout.rows[0]
    if (!row) break
    const before = row.headGap?.count
    store.set(openStretchAtom, key, row.stretch)
    const after = stretchView(row.stretch, state())
    // One press opens one part: a whole run, or up to GAP_CHUNK lines.
    if (row.head?.kind === "gap" && after.head === row.head)
      expect(before! - after.headGap!.count).toBe(GAP_CHUNK)
  }
  // Fully open is the whole file: every run read-only, nothing hidden.
  const open = rangedLayout(view, state(), false)
  expect(open.hiddenGaps).toEqual([])
  expect(open.folds).toEqual(rangedLayout(view, {}, true).folds)
}

describe("stretches", () => {
  const view = rangedView(crowdedRangedFile, OWNED_REVISION)!
  const total = crowdedRangedFile.newContents.split("\n").length - 1

  test("other units' runs fold into one gap row per stretch", () => {
    const layout = rangedLayout(view, {}, false)
    // 12 runs of 6 other units, 4 owned runs: 5 rows, none a unit's own.
    expect(view.runs.filter((run) => run.owner.kind === "owned")).toHaveLength(
      4
    )
    expect(layout.rows.map((row) => [row.label, row.units])).toEqual([
      ["L1–252", 2],
      ["L256–303", 2],
      ["L306–381", 2],
      ["L383–521", 3],
      ["L524–704", 3],
    ])
    expect(layout.folds.every((fold) => fold.collapsed && !fold.row)).toBe(true)
    // The stretch before the first owned run opens from the code below it.
    expect(view.stretches.map((stretch) => stretch.upward)).toEqual([
      true,
      false,
      false,
      false,
      false,
    ])
  })

  test("drawn lines and gap rows cover the file once at every step", () => {
    openEveryStep(view, total)
  })

  test("a removal-only run still opens and names its removed lines", () => {
    // The bridge unit removes old L340–342 and adds nothing.
    const stretch = view.stretches[2]!
    const store = createStore()
    while (
      stretchView(stretch, { expansion: store.get(gapExpansionAtom).f }).head
        ?.kind === "gap"
    )
      store.set(openStretchAtom, "f", stretch)
    const shown = stretchView(stretch, {
      expansion: store.get(gapExpansionAtom).f,
      openRuns: store.get(openSiblingsAtom).f,
    })
    expect(shown.head?.kind).toBe("run")
    expect(shown.runs[0]?.label).toEqual({
      side: "deletions",
      start: 340,
      end: 342,
    })
  })

  test("a line behind a gap row is hidden until its stretch opens", () => {
    const store = createStore()
    const point = { side: "additions" as const, lineNumber: 603 }
    const shown = () =>
      stretchView(view.stretches[4]!, {
        expansion: store.get(gapExpansionAtom).f,
        openRuns: store.get(openSiblingsAtom).f,
      })
    expect(stretchHides(view, shown(), point)).toBe(true)
    // Not this unit's lines: no other row claims them.
    expect(stretchHides(view, stretchView(view.stretches[3]!, {}), point)).toBe(
      false
    )
    store.set(openStretchAtom, "f", view.stretches[4]!, true)
    expect(shown().head).toBeUndefined()
    expect(stretchHides(view, shown(), point)).toBe(false)
  })

  test("the whole file draws every line with other units' runs read-only", () => {
    const layout = rangedLayout(view, {}, true)
    expect(layout.rows).toEqual([])
    expect(layout.hiddenGaps).toEqual([])
    expect(layout.folds).toHaveLength(12)
    expect(
      layout.folds.every(
        (fold) => fold.readOnly && !fold.collapsed && !fold.row
      )
    ).toBe(true)
  })
})

describe("buildRangedView", () => {
  test("gap sizes of the controlled fixture", () => {
    const view = rangedView(gapSizesFile, "c".repeat(40))!
    expect(view.gaps.map((gap) => [gap.newStart, gap.newEnd])).toEqual([
      [1, 4],
      [6, 6],
      [8, 9],
      [11, 13],
      [15, 20],
    ])
  })

  for (const withPatch of [false, true]) {
    test(`random files reproduce exactly (${withPatch ? "patch" : "contents"})`, () => {
      let oneSided = 0
      for (let seed = 1; seed <= 40; seed++)
        if (check(seed, withPatch)) oneSided++
      // The empty-side cases are actually exercised.
      expect(oneSided).toBeGreaterThan(10)
    })
  }
})

/**
 * Sections (10.109): a unit of one file's separate changes marks each with a
 * row above its first run. Tested because the model alone decides where a
 * section starts: a boundary must end a run even where two sections' lines
 * touch, or a row would sit inside another section's lines; and one section
 * is the unit itself, so it must mark nothing and change nothing.
 */
describe("sections", () => {
  const old = Array.from({ length: 12 }, (_, i) => `l${i + 1}`)
  const next = [
    ...old.slice(0, 2),
    "n3",
    "n4",
    ...old.slice(3, 9),
    "n11",
    ...old.slice(10),
  ]
  const lines = (side: "old" | "new", startLine: number, endLine: number) => ({
    kind: "changed-lines" as const,
    hunkId: `${side}${startLine}`,
    sourceRevisionId: REVISION,
    side,
    startLine,
    lineCount: endLine - startLine + 1,
    lines: (side === "old" ? old : next).slice(startLine - 1, endLine),
  })
  const fileWith = (
    sections?: NonNullable<DiffFile["responsibility"]>["sections"]
  ): DiffFile => ({
    path: "src/sections.ts",
    oldContents: old.join("\n") + "\n",
    newContents: next.join("\n") + "\n",
    context: 0,
    additions: 3,
    deletions: 2,
    markerAnchors: [],
    responsibility: {
      kind: "changed-ranges",
      unitId: "unit",
      revisionId: REVISION,
      ownedSource: [
        lines("old", 3, 3),
        lines("new", 3, 4),
        lines("old", 10, 10),
        lines("new", 11, 11),
      ],
      ...(sections ? { sections } : {}),
    },
  })
  const three = [
    {
      id: "s1",
      title: "Replaces the third line",
      ranges: [
        { side: "old" as const, startLine: 3, endLine: 3 },
        { side: "new" as const, startLine: 3, endLine: 3 },
      ],
    },
    {
      id: "s2",
      title: "Adds a line after it",
      ranges: [{ side: "new" as const, startLine: 4, endLine: 4 }],
    },
    {
      id: "s3",
      title: "Replaces the tenth line",
      ranges: [
        { side: "old" as const, startLine: 10, endLine: 10 },
        { side: "new" as const, startLine: 11, endLine: 11 },
      ],
    },
  ]

  test("a section boundary ends a run, and each section's row sits on its first run", () => {
    const view = rangedView(fileWith(three), REVISION)!
    expect(view.sections.map((s) => [s.id, s.index, s.of])).toEqual([
      ["s1", 0, 3],
      ["s2", 1, 3],
      ["s3", 2, 3],
    ])
    // s1 and s2 touch (new lines 3 and 4) but stay two runs.
    const [s1, s2, s3] = view.sections
    expect(s1!.hunks).toHaveLength(1)
    expect(s2!.hunks[0]).toBe(s1!.hunks[0]! + 1)
    // Each run's changed rows only: what lights and lands.
    expect(s1!.ranges).toEqual([
      { start: 3, side: "deletions", end: 3, endSide: "additions" },
    ])
    expect(s2!.ranges).toEqual([{ start: 4, side: "additions", end: 4 }])
    expect(s3!.ranges).toEqual([
      { start: 10, side: "deletions", end: 11, endSide: "additions" },
    ])
    for (const whole of [false, true]) {
      const rows = rangedLayout(view, {}, whole).folds.filter((fold) =>
        fold.slotName.startsWith("nv-section-")
      )
      expect(rows).toEqual(
        view.sections.map((section) => ({
          hunkIndex: section.hunks[0]!,
          slotName: `nv-section-${section.hunks[0]}`,
          collapsed: false,
        }))
      )
    }
  })

  test("a section of two runs lights and lands on each run's rows, never the unchanged lines between", () => {
    const view = rangedView(
      fileWith([
        {
          id: "outer",
          title: "Replaces the third and tenth lines",
          ranges: [...three[0]!.ranges, ...three[2]!.ranges],
        },
        three[1]!,
      ]),
      REVISION
    )!
    const [outer, inner] = view.sections
    expect(outer!.id).toBe("outer")
    expect(outer!.hunks).toHaveLength(2)
    expect(outer!.ranges).toEqual([
      { start: 3, side: "deletions", end: 3, endSide: "additions" },
      { start: 10, side: "deletions", end: 11, endSide: "additions" },
    ])
    expect(inner!.ranges).toEqual([{ start: 4, side: "additions", end: 4 }])
  })

  test("one section marks nothing and draws the file as a unit without sections", () => {
    const one = rangedView(fileWith([three[0]!]), REVISION)!
    const none = rangedView(fileWith(), REVISION)!
    expect(one.sections).toEqual([])
    expect(rangedLayout(one, {}, false).folds).toEqual([])
    expect(one.fileDiff.hunks).toEqual(none.fileDiff.hunks)
    expect(none.fileDiff.hunks).toHaveLength(2)
  })
})
