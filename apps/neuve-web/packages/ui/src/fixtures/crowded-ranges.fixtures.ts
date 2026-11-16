import type {
  DiffFile,
  DiffResponsibility,
  OwnedChangedSource,
  ReviewLane,
} from "@workspace/ui/neuve/types"

/*
 * Real volume (the owner's InteractionManager.ts case): a 700-line file
 * several units touch. The unit owns 4 runs; 6 other units own 12, spread
 * through it: one before the unit's first run (that stretch opens upward),
 * two a single unchanged line apart, one removal-only, three after its last
 * run. Built from a retained patch, as live data is. A module of its own so
 * both the owned-ranges fixtures and the /mock desk (review-batch) can build
 * it for their unit without importing each other.
 */

/** One of the six other units, in the order the changes below name them. */
export interface CrowdedOwner {
  unitId: string
  title: string
  lane: ReviewLane
}

const TEMPLATE = [
  (i: number) =>
    `  private clampSelection${i}(anchor: SelectionPoint, point: SelectionPoint) {`,
  () => `    if (!this.canComment(point)) return`,
  (i: number) => `    const end = this.commentableEnd(anchor, point, ${i})`,
  () => `    this.setSelection(this.buildSelectedLineRange(anchor, end))`,
  (i: number) => `    this.notify("selection", { line: ${i} })`,
  () => `  }`,
  () => ``,
]

const OLD = Array.from({ length: 700 }, (_, i) =>
  TEMPLATE[i % TEMPLATE.length]!(i + 1)
)

/**
 * Old line `at`: remove `remove` lines, add `add` new ones; `owner` is
 * "owned" or an index into the six other owners.
 */
const CHANGES: Array<{
  at: number
  remove: number
  add: number
  owner: number | "owned"
}> = [
  { at: 40, remove: 1, add: 1, owner: 3 },
  { at: 120, remove: 0, add: 3, owner: 0 },
  { at: 250, remove: 2, add: 3, owner: "owned" },
  { at: 258, remove: 1, add: 1, owner: 1 },
  { at: 260, remove: 1, add: 1, owner: 2 },
  { at: 300, remove: 1, add: 2, owner: "owned" },
  { at: 340, remove: 3, add: 0, owner: 4 },
  { at: 360, remove: 1, add: 1, owner: 5 },
  { at: 380, remove: 1, add: 1, owner: "owned" },
  { at: 383, remove: 1, add: 1, owner: 0 },
  { at: 450, remove: 1, add: 1, owner: 1 },
  { at: 470, remove: 1, add: 1, owner: 2 },
  { at: 520, remove: 2, add: 2, owner: "owned" },
  { at: 600, remove: 4, add: 6, owner: 0 },
  { at: 640, remove: 1, add: 1, owner: 3 },
  { at: 690, remove: 1, add: 1, owner: 5 },
]

const text = (lines: Array<string>) => `${lines.join("\n")}\n`

/** The crowded file as `unitId` sees it at `revision`. */
export function crowdedRangedFileFor({
  unitId,
  revision,
  path,
  owners,
  markerAnchors = [],
}: {
  unitId: string
  revision: string
  path: string
  owners: readonly [
    CrowdedOwner,
    CrowdedOwner,
    CrowdedOwner,
    CrowdedOwner,
    CrowdedOwner,
    CrowdedOwner,
  ]
  markerAnchors?: DiffFile["markerAnchors"]
}): DiffFile {
  const next: Array<string> = []
  const hunks: Array<string> = []
  const owned: Array<OwnedChangedSource> = []
  const sibling: NonNullable<DiffResponsibility["siblingSource"]> = []
  let cursor = 1
  for (const [index, change] of CHANGES.entries()) {
    while (cursor < change.at) next.push(OLD[cursor++ - 1]!)
    const removed = OLD.slice(change.at - 1, change.at - 1 + change.remove)
    cursor += change.remove
    const added = Array.from({ length: change.add }, (_, k) =>
      change.owner === "owned"
        ? `    if (!this.isLineCommentable(point${k ? ` + ${k}` : ""})) return this.keepFocus()`
        : `    this.selection = clampToEligible(this.selection, ${change.at + k})`
    )
    const newStart = next.length + 1
    next.push(...added)
    // Unified-diff headers: an empty side names the line before it.
    hunks.push(
      `@@ -${change.remove ? change.at : change.at - 1},${change.remove} +${change.add ? newStart : newStart - 1},${change.add} @@`,
      ...removed.map((line) => `-${line}`),
      ...added.map((line) => `+${line}`)
    )
    const sides = [
      { side: "old" as const, startLine: change.at, lines: removed },
      { side: "new" as const, startLine: newStart, lines: added },
    ].filter((side) => side.lines.length > 0)
    for (const side of sides) {
      if (change.owner === "owned")
        owned.push({
          kind: "changed-lines",
          hunkId: `h-crowded-${index}`,
          side: side.side,
          sourceRevisionId: side.side === "old" ? "b".repeat(40) : revision,
          startLine: side.startLine,
          lineCount: side.lines.length,
          lines: side.lines,
        })
      else
        sibling.push({
          ...owners[change.owner]!,
          side: side.side,
          startLine: side.startLine,
          lineCount: side.lines.length,
        })
    }
  }
  while (cursor <= OLD.length) next.push(OLD[cursor++ - 1]!)
  return {
    path,
    oldContents: text(OLD),
    newContents: text(next),
    patch: [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      ...hunks,
      "",
    ].join("\n"),
    context: 0,
    additions: CHANGES.reduce((sum, change) => sum + change.add, 0),
    deletions: CHANGES.reduce((sum, change) => sum + change.remove, 0),
    markerAnchors,
    responsibility: {
      kind: "changed-ranges",
      unitId,
      revisionId: revision,
      ownedSource: owned,
      siblingSource: sibling,
    },
  }
}
