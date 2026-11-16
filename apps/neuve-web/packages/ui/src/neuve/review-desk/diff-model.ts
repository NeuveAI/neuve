import {
  DEFAULT_COLLAPSED_CONTEXT_THRESHOLD,
  hydratePartialDiff,
  parseDiffFromFile,
  parsePatchFiles,
} from "@workspace/diffs"
import type {
  FileDiffMetadata,
  Hunk,
  HunkExpansionRegion,
  HunkFold,
} from "@workspace/diffs"

import type {
  DiffFile,
  DiffResponsibility,
  DiffSide,
  LineRange,
  ReviewLane,
} from "@workspace/ui/neuve/types"

/**
 * View model → @workspace/diffs metadata, and line-range helpers.
 *
 * Results are cached per input object (fixtures and loader data are
 * immutable), so renders reuse the same metadata and the renderer's
 * equality checks skip work. Cache keys let the highlighting worker reuse
 * tokens across mounts.
 */

const fileDiffs = new WeakMap<DiffFile, FileDiffMetadata>()
const rangedViews = new WeakMap<DiffFile, RangedView>()

export function toFileDiff(file: DiffFile, revision: string): FileDiffMetadata {
  if (file.responsibility && file.responsibility.revisionId !== revision)
    throw Error("Owned excerpts belong to a different review revision")
  const cached = fileDiffs.get(file)
  if (cached) return cached
  const fileDiff =
    file.patch === undefined
      ? parseDiffFromFile(
          {
            name: file.path,
            contents: file.oldContents,
            cacheKey: `${file.path}@${revision}:old`,
          },
          {
            name: file.path,
            contents: file.newContents,
            cacheKey: `${file.path}@${revision}:new`,
          },
          { context: file.context }
        )
      : parsePatchFiles(
          file.patch,
          `${file.path}@${revision}:reviewed`,
          true
        )[0]?.files[0]
  if (!fileDiff || fileDiff.name !== file.path)
    throw new Error("Reviewed patch must contain the requested file")
  if (!file.responsibility) {
    fileDiffs.set(file, fileDiff)
    return fileDiff
  }
  const view = buildRangedView(file, file.responsibility, fileDiff, revision)
  rangedViews.set(file, view)
  fileDiffs.set(file, view.fileDiff)
  return view.fileDiff
}

/**
 * The owned-ranges layout of a file with responsibility: which hunk is this
 * unit's, which belongs to a sibling unit, and the unchanged gaps between
 * them. Undefined for files reviewed whole.
 */
export function rangedView(
  file: DiffFile,
  revision: string
): RangedView | undefined {
  if (!file.responsibility) return undefined
  toFileDiff(file, revision)
  return rangedViews.get(file)
}

const patchDiffs = new Map<string, FileDiffMetadata>()

/** A single-file unified patch (a read-only neighbor's hunk). */
export function toPatchDiff(patch: string): FileDiffMetadata {
  const cached = patchDiffs.get(patch)
  if (cached) return cached
  const fileDiff = parsePatchFiles(patch, "neighbor", true)[0]?.files[0]
  if (!fileDiff) throw new Error("toPatchDiff: the patch has no file diff")
  patchDiffs.set(patch, fileDiff)
  return fileDiff
}

/**
 * One row of the stacked (unified) view as if every fold were expanded:
 * context rows carry both line numbers, deletions the old one, additions the
 * new one.
 */
export interface DisplayRow {
  kind: "context" | "addition" | "deletion"
  oldLine: number | null
  newLine: number | null
  text: string
  /** The hunk the row belongs to, or the next hunk for folded context. */
  hunkIndex: number
  hunkHeader: string
}

const displayRowsCache = new WeakMap<FileDiffMetadata, Array<DisplayRow>>()

function stripEol(line: string | undefined): string {
  return (line ?? "").replace(/\r?\n$/, "")
}

function hunkHeaderOf(hunk: FileDiffMetadata["hunks"][number]): string {
  return (
    hunk.hunkSpecs?.trim() ??
    `@@ -${hunk.deletionStart},${hunk.deletionCount} +${hunk.additionStart},${hunk.additionCount} @@`
  )
}

/** Every row of the file in stacked display order (deletions before additions). */
export function displayRows(
  fileDiff: FileDiffMetadata,
  file: Pick<DiffFile, "newContents">
): Array<DisplayRow> {
  const cached = displayRowsCache.get(fileDiff)
  if (cached) return cached
  const newText = file.newContents.split("\n")
  if (newText.at(-1) === "") newText.pop()
  const rows: Array<DisplayRow> = []
  let oldLine = 1
  let newLine = 1
  const pushContextUntil = (
    nextNew: number,
    hunkIndex: number,
    hunkHeader: string
  ) => {
    while (newLine < nextNew) {
      rows.push({
        kind: "context",
        oldLine,
        newLine,
        text: newText[newLine - 1] ?? "",
        hunkIndex,
        hunkHeader,
      })
      oldLine++
      newLine++
    }
  }
  fileDiff.hunks.forEach((hunk, hunkIndex) => {
    const hunkHeader = hunkHeaderOf(hunk)
    // An empty side's start names the line *before* the change (unified diff
    // convention, Pierre's getHunkSideStartBoundary): its first line is the
    // one after it.
    const firstNew = hunk.additionStart + (hunk.additionCount === 0 ? 1 : 0)
    const firstOld = hunk.deletionStart + (hunk.deletionCount === 0 ? 1 : 0)
    if (!fileDiff.isPartial) pushContextUntil(firstNew, hunkIndex, hunkHeader)
    oldLine = firstOld
    newLine = firstNew
    for (const block of hunk.hunkContent) {
      if (block.type === "context") {
        for (let i = 0; i < block.lines; i++) {
          rows.push({
            kind: "context",
            oldLine,
            newLine,
            text: stripEol(fileDiff.additionLines[block.additionLineIndex + i]),
            hunkIndex,
            hunkHeader,
          })
          oldLine++
          newLine++
        }
        continue
      }
      for (let i = 0; i < block.deletions; i++) {
        rows.push({
          kind: "deletion",
          oldLine,
          newLine: null,
          text: stripEol(fileDiff.deletionLines[block.deletionLineIndex + i]),
          hunkIndex,
          hunkHeader,
        })
        oldLine++
      }
      for (let i = 0; i < block.additions; i++) {
        rows.push({
          kind: "addition",
          oldLine: null,
          newLine,
          text: stripEol(fileDiff.additionLines[block.additionLineIndex + i]),
          hunkIndex,
          hunkHeader,
        })
        newLine++
      }
    }
  })
  const last = fileDiff.hunks.length - 1
  const lastHeader = last >= 0 ? hunkHeaderOf(fileDiff.hunks[last]!) : ""
  if (!fileDiff.isPartial)
    pushContextUntil(newText.length + 1, Math.max(last, 0), lastHeader)
  displayRowsCache.set(fileDiff, rows)
  return rows
}

/** Index of a (side, line) point among the display rows. */
export function rowIndexOf(
  rows: ReadonlyArray<DisplayRow>,
  side: DiffSide,
  lineNumber: number
): number {
  return rows.findIndex((row) =>
    side === "additions"
      ? row.kind !== "deletion" && row.newLine === lineNumber
      : row.kind !== "addition" && row.oldLine === lineNumber
  )
}

/**
 * Pierre ranges keep the drag direction; store them top-to-bottom. Returns
 * undefined when a point is not a row of this file.
 */
export function normalizeRange(
  rows: ReadonlyArray<DisplayRow>,
  range: LineRange
): LineRange | undefined {
  const endSide = range.endSide ?? range.side
  const a = rowIndexOf(rows, range.side, range.start)
  const b = rowIndexOf(rows, endSide, range.end)
  if (a < 0 || b < 0) return undefined
  const [top, bottom] =
    a <= b
      ? [
          { side: range.side, line: range.start },
          { side: endSide, line: range.end },
        ]
      : [
          { side: endSide, line: range.end },
          { side: range.side, line: range.start },
        ]
  return {
    start: top.line,
    side: top.side,
    end: bottom.line,
    ...(bottom.side !== top.side ? { endSide: bottom.side } : {}),
  }
}

/** The display rows a (normalized) range covers, top to bottom. */
export function rangeRows(
  rows: ReadonlyArray<DisplayRow>,
  range: LineRange
): Array<DisplayRow> {
  const a = rowIndexOf(rows, range.side, range.start)
  const b = rowIndexOf(rows, range.endSide ?? range.side, range.end)
  if (a < 0 || b < 0) return []
  return rows.slice(Math.min(a, b), Math.max(a, b) + 1)
}

export function rangeEquals(
  a: LineRange | null | undefined,
  b: LineRange | null | undefined
): boolean {
  if (!a || !b) return a === b
  return (
    a.start === b.start &&
    a.end === b.end &&
    a.side === b.side &&
    (a.endSide ?? a.side) === (b.endSide ?? b.side)
  )
}

/** Stable key for a file + range (drafts, overlay ids). */
export function rangeKey(filePath: string, range: LineRange): string {
  return `${filePath}#${range.side}:${range.start}-${range.endSide ?? range.side}:${range.end}`
}

const sign = (side: DiffSide) => (side === "deletions" ? "−" : "")

/**
 * "L22", "L22–23", "L−20–21" (removed lines), or "L−20–+20" when the range
 * crosses from removed to added rows.
 */
export function rangeLabel(range: LineRange): string {
  const endSide = range.endSide ?? range.side
  const head = `${sign(range.side)}${range.start}`
  if (range.start === range.end && endSide === range.side) return `L${head}`
  const tail =
    endSide === range.side
      ? `${range.end}`
      : `${endSide === "deletions" ? "−" : "+"}${range.end}`
  return `L${head}–${tail}`
}

/** "line 20" / "lines 20–23" for prose (composer header, placeholder). */
export function rangePhrase(range: LineRange): string {
  const label = rangeLabel(range).slice(1)
  return range.start === range.end &&
    (range.endSide ?? range.side) === range.side
    ? `line ${label}`
    : `lines ${label}`
}

export function anchorKey(side: DiffSide, lineNumber: number): string {
  return `${side}:${lineNumber}`
}

/** A range is commentable only within one exact owned interval. */
export function ownsSelection(file: DiffFile, range: LineRange): boolean {
  if (!file.responsibility) return true
  if (range.endSide && range.endSide !== range.side) return false
  const start = Math.min(range.start, range.end)
  const end = Math.max(range.start, range.end)
  return file.responsibility.ownedSource.some(
    (source) =>
      source.kind === "changed-lines" &&
      source.side === (range.side === "additions" ? "new" : "old") &&
      start >= source.startLine &&
      end < source.startLine + source.lineCount
  )
}

/* ── Owned ranges (round 3, Ranges.dc.html) ─────────────────────────── */

/** Who a run of changed lines belongs to. */
export type RunOwner =
  /** `section`: which of the unit's separate changes the run belongs to. */
  | { kind: "owned"; section?: string }
  | {
      kind: "sibling"
      /** Absent when the batch did not say which unit owns these lines. */
      unitId?: string
      title?: string
      lane?: ReviewLane
      /** As on the sibling source: the lane words its title leaves out. */
      laneWords?: string
    }

/** One hunk of the ranged diff: consecutive changed lines of one owner. */
export interface RangedRun {
  hunkIndex: number
  owner: RunOwner
  /** First and last changed line, new side when it has one, else old. */
  label: { side: DiffSide; start: number; end: number }
  changed: number
}

/** Unchanged lines before hunk `hunkIndex` (or after the last one). */
export interface RangedGap {
  /** The hunk the gap sits above; `hunks.length` for the trailing gap. */
  hunkIndex: number
  /** New-side lines of the gap, inclusive. */
  newStart: number
  newEnd: number
  /** The same lines on the old side (unchanged, so the same count). */
  oldStart: number
  size: number
}

export interface RangedView {
  fileDiff: FileDiffMetadata
  runs: Array<RangedRun>
  gaps: Array<RangedGap>
  /** What lies between this unit's runs, in line order. */
  stretches: Array<RangedStretch>
  /** The unit's separate changes in line order; empty unless two or more show. */
  sections: Array<RangedSection>
}

/**
 * One of the unit's separate changes (10.109) as it shows: a row above its
 * first run holds its title, where it stands and the steps to the others.
 */
export interface RangedSection {
  id: string
  title: string
  /** 0-based, in line order. */
  index: number
  of: number
  /** Its runs' hunks in line order; the first holds its row. */
  hunks: Array<number>
  /**
   * Each run's changed rows, first to last in display order: exactly the
   * lines it owns, what lights and lands.
   */
  ranges: Array<LineRange>
}

/** A section row's slot inside the diff host. */
export function sectionSlotName(hunkIndex: number): string {
  return `nv-section-${hunkIndex}`
}

/** One part of a stretch: an unchanged gap or a run another unit owns. */
export type StretchPart =
  { kind: "gap"; gap: RangedGap } | { kind: "run"; run: RangedRun }

/**
 * The lines between two of this unit's runs, or between one and a file
 * edge: unchanged gaps and sibling runs in line order. Owned ranges shows a
 * stretch as one gap row that opens part by part from the owned code
 * outward, so other units' lines never take rows of their own.
 */
export interface RangedStretch {
  parts: Array<StretchPart>
  /** Before the first owned run: opens upward, from the code below it. */
  upward: boolean
}

/** A fold row's slot inside the diff host (sibling-owned lines). */
export function foldSlotName(hunkIndex: number): string {
  return `nv-fold-${hunkIndex}`
}

function lineInSources<
  T extends { side: "old" | "new"; startLine: number; lineCount: number },
>(sources: ReadonlyArray<T>, side: "old" | "new", line: number): T | undefined {
  return sources.find(
    (source) =>
      source.side === side &&
      line >= source.startLine &&
      line < source.startLine + source.lineCount
  )
}

function ownerOf(
  responsibility: DiffResponsibility,
  row: DisplayRow
): { key: string; owner: RunOwner } {
  const side = row.kind === "deletion" ? "old" : "new"
  const line = (row.kind === "deletion" ? row.oldLine : row.newLine) ?? 0
  const owned = lineInSources(
    responsibility.ownedSource.flatMap((source) =>
      source.kind === "changed-lines" ? [source] : []
    ),
    side,
    line
  )
  if (owned) {
    // A section boundary ends a run, so each section starts on a hunk of its
    // own. One section is the unit itself: it splits nothing.
    const sections = responsibility.sections ?? []
    const section = (sections.length > 1 ? sections : []).find((candidate) =>
      candidate.ranges.some(
        (range) =>
          range.side === side &&
          line >= range.startLine &&
          line <= range.endLine
      )
    )?.id
    return {
      key: `owned:${section ?? ""}`,
      owner: section ? { kind: "owned", section } : { kind: "owned" },
    }
  }
  const sibling = lineInSources(responsibility.siblingSource ?? [], side, line)
  if (sibling)
    return {
      key: `sibling:${sibling.unitId}`,
      owner: {
        kind: "sibling",
        unitId: sibling.unitId,
        title: sibling.title,
        lane: sibling.lane,
        ...(sibling.laneWords ? { laneWords: sibling.laneWords } : {}),
      },
    }
  return { key: "sibling:", owner: { kind: "sibling" } }
}

/** The original diff with full old/new line arrays, so gaps can open. */
function hydrated(
  file: DiffFile,
  original: FileDiffMetadata,
  revision: string
) {
  if (!original.isPartial) return original
  if (original.type !== "change" && original.type !== "rename-changed")
    return original
  return hydratePartialDiff("clone", original, {
    oldFile: {
      name: file.path,
      contents: file.oldContents,
      cacheKey: `${file.path}@${revision}:old`,
    },
    newFile: {
      name: file.path,
      contents: file.newContents,
      cacheKey: `${file.path}@${revision}:new`,
    },
  })
}

/**
 * Owned ranges in line order. Every changed line of the original patch stays
 * in the diff, grouped into runs of one owner (this unit, or a sibling unit);
 * unchanged lines between runs become gaps the reviewer opens in place. The
 * host folds sibling runs behind one row (`hunkFolds`) and owns the gaps'
 * expansion, so neither changes the diff and highlighting is reused.
 */
function buildRangedView(
  file: DiffFile,
  responsibility: DiffResponsibility,
  original: FileDiffMetadata,
  revision: string
): RangedView {
  if (responsibility.ownedSource.length === 0)
    throw Error("Ranged presentation requires owned responsibility")
  const full = hydrated(file, original, revision)
  const rows = displayRows(full, file)
  for (const source of responsibility.ownedSource) {
    if (source.kind === "whole-nontext") {
      if (!source.text || !file.patch?.includes(source.text))
        throw Error(
          "Owned nontext source must be retained in the original patch"
        )
      continue
    }
    if (source.lines.length !== source.lineCount || source.lineCount <= 0)
      throw Error("Owned source needs exact retained lines")
    const kind = source.side === "old" ? "deletion" : "addition"
    source.lines.forEach((text, offset) => {
      const line = source.startLine + offset
      const row = rows.find(
        (candidate) =>
          candidate.kind === kind &&
          (kind === "deletion" ? candidate.oldLine : candidate.newLine) === line
      )
      if (!row)
        throw Error("Owned excerpt contradicts the original retained patch")
      if (row.text !== text)
        throw Error("Owned excerpt text differs from the retained source")
    })
  }

  type Pending = {
    key: string
    owner: RunOwner
    rows: Array<DisplayRow>
    oldBefore: number
    newBefore: number
  }
  const pending: Array<Pending> = []
  let lastOld = 0
  let lastNew = 0
  let current: Pending | undefined
  for (const row of rows) {
    if (row.kind === "context") {
      current = undefined
      lastOld = row.oldLine ?? lastOld
      lastNew = row.newLine ?? lastNew
      continue
    }
    const { key, owner } = ownerOf(responsibility, row)
    if (!current || current.key !== key) {
      current = { key, owner, rows: [], oldBefore: lastOld, newBefore: lastNew }
      pending.push(current)
    }
    current.rows.push(row)
    if (row.kind === "deletion") lastOld = row.oldLine ?? lastOld
    else lastNew = row.newLine ?? lastNew
  }

  const oldCount = full.deletionLines.length
  const newCount = full.additionLines.length
  const hunks: Array<Hunk> = []
  const runs: Array<RangedRun> = []
  const gaps: Array<RangedGap> = []
  let split = 0
  let unified = 0
  let lastNewEnd = 0
  let lastOldEnd = 0
  for (const run of pending) {
    const deleted = run.rows.filter((row) => row.kind === "deletion")
    const added = run.rows.filter((row) => row.kind === "addition")
    const d = deleted.length
    const a = added.length
    const deletionStart = d > 0 ? (deleted[0]!.oldLine ?? 0) : run.oldBefore
    const additionStart = a > 0 ? (added[0]!.newLine ?? 0) : run.newBefore
    // Pierre's boundaries: a side with no lines starts *after* its line.
    const newBoundary = additionStart - (a > 0 ? 1 : 0)
    const oldBoundary = deletionStart - (d > 0 ? 1 : 0)
    const collapsedBefore = Math.max(newBoundary - lastNewEnd, 0)
    if (collapsedBefore > 0)
      gaps.push({
        hunkIndex: hunks.length,
        newStart: lastNewEnd + 1,
        newEnd: newBoundary,
        oldStart: lastOldEnd + 1,
        size: collapsedBefore,
      })
    const splitCount = Math.max(d, a)
    const lastDeleted = deleted.at(-1)?.oldLine ?? 0
    const lastAdded = added.at(-1)?.newLine ?? 0
    const originalHunk = full.hunks[run.rows[0]!.hunkIndex]
    hunks.push({
      collapsedBefore,
      additionStart,
      additionCount: a,
      additionLines: a,
      additionLineIndex: newBoundary,
      deletionStart,
      deletionCount: d,
      deletionLines: d,
      deletionLineIndex: oldBoundary,
      hunkContent: [
        {
          type: "change",
          deletions: d,
          deletionLineIndex: oldBoundary,
          additions: a,
          additionLineIndex: newBoundary,
        },
      ],
      hunkSpecs: `@@ -${deletionStart},${d} +${additionStart},${a} @@`,
      splitLineStart: split + collapsedBefore,
      splitLineCount: splitCount,
      unifiedLineStart: unified + collapsedBefore,
      unifiedLineCount: d + a,
      noEOFCRDeletions:
        d > 0 &&
        lastDeleted === oldCount &&
        (originalHunk?.noEOFCRDeletions ?? false),
      noEOFCRAdditions:
        a > 0 &&
        lastAdded === newCount &&
        (originalHunk?.noEOFCRAdditions ?? false),
    })
    runs.push({
      hunkIndex: hunks.length - 1,
      owner: run.owner,
      label:
        a > 0
          ? { side: "additions", start: additionStart, end: lastAdded }
          : { side: "deletions", start: deletionStart, end: lastDeleted },
      changed: d + a,
    })
    split += collapsedBefore + splitCount
    unified += collapsedBefore + d + a
    lastNewEnd = newBoundary + a
    lastOldEnd = oldBoundary + d
  }
  const trailing = full.isPartial ? 0 : Math.max(newCount - lastNewEnd, 0)
  if (trailing > 0)
    gaps.push({
      hunkIndex: hunks.length,
      newStart: lastNewEnd + 1,
      newEnd: newCount,
      oldStart: lastOldEnd + 1,
      size: trailing,
    })
  const fileDiff: FileDiffMetadata = {
    ...full,
    hunks,
    splitLineCount: split + trailing,
    unifiedLineCount: unified + trailing,
    cacheKey: `${file.path}@${responsibility.revisionId}:${responsibility.unitId}:ranged`,
  }
  return {
    fileDiff,
    runs,
    gaps,
    stretches: stretchesOf(runs, gaps),
    sections: sectionsOf(responsibility, runs, hunks),
  }
}

/**
 * The unit's sections that own runs here, in line order, each with its runs
 * and their changed rows. One section alone is the unit itself, so none are
 * marked.
 */
function sectionsOf(
  responsibility: DiffResponsibility,
  runs: ReadonlyArray<RangedRun>,
  hunks: ReadonlyArray<Hunk>
): Array<RangedSection> {
  const byId = new Map<string, Array<RangedRun>>()
  for (const run of runs)
    if (run.owner.kind === "owned" && run.owner.section)
      byId.set(run.owner.section, [...(byId.get(run.owner.section) ?? []), run])
  const shown = (responsibility.sections ?? [])
    .flatMap((section) => {
      const own = byId.get(section.id)
      return own ? [{ section, own }] : []
    })
    .sort((a, b) => a.own[0]!.hunkIndex - b.own[0]!.hunkIndex)
  if (shown.length < 2) return []
  return shown.map(({ section, own }, index) => ({
    id: section.id,
    title: section.title,
    index,
    of: shown.length,
    hunks: own.map((run) => run.hunkIndex),
    ranges: own.map((run) => runRange(hunks[run.hunkIndex]!)),
  }))
}

/** A run's changed rows: stacked and split show its removed lines first. */
function runRange(hunk: Hunk): LineRange {
  const start =
    hunk.deletionCount > 0
      ? { start: hunk.deletionStart, side: "deletions" as const }
      : { start: hunk.additionStart, side: "additions" as const }
  const end =
    hunk.additionCount > 0
      ? {
          end: hunk.additionStart + hunk.additionCount - 1,
          side: "additions" as const,
        }
      : {
          end: hunk.deletionStart + hunk.deletionCount - 1,
          side: "deletions" as const,
        }
  return {
    start: start.start,
    side: start.side,
    end: end.end,
    ...(end.side === start.side ? {} : { endSide: end.side }),
  }
}

/** Gaps and sibling runs in line order, cut at every owned run. */
function stretchesOf(
  runs: ReadonlyArray<RangedRun>,
  gaps: ReadonlyArray<RangedGap>
): Array<RangedStretch> {
  const gapAbove = new Map(gaps.map((gap) => [gap.hunkIndex, gap]))
  const stretches: Array<RangedStretch> = []
  let parts: Array<StretchPart> = []
  let ownedSeen = false
  const close = (upward: boolean) => {
    if (parts.length > 0) stretches.push({ parts, upward })
    parts = []
  }
  for (let index = 0; index <= runs.length; index++) {
    const gap = gapAbove.get(index)
    if (gap) parts.push({ kind: "gap", gap })
    const run = runs[index]
    if (!run) continue
    if (run.owner.kind === "sibling") {
      parts.push({ kind: "run", run })
      continue
    }
    close(!ownedSeen)
    ownedSeen = true
  }
  close(false)
  return stretches
}

/* ── A stretch as it shows (owned ranges) ───────────────────────────── */

/**
 * Gaps at or below Pierre's collapsedContextThreshold render inline, so they
 * never hold the gap row. One source: the renderer's own default (the
 * surface passes no override), so a gap is never both "inline" here and
 * folded there.
 */
export const INLINE_GAP = DEFAULT_COLLAPSED_CONTEXT_THRESHOLD

/** What the reviewer has opened in one file. */
export interface StretchState {
  /** Revealed lines per gap, by the hunk it sits above. */
  expansion?: Readonly<Record<number, HunkExpansionRegion>>
  /** Sibling runs shown, by hunk index. */
  openRuns?: Readonly<Record<number, true>>
}

/** Lines by new-side number, inclusive; `count` 0 when there are none. */
export interface LineSpan {
  start: number
  end: number
  count: number
}

/** A stretch as it shows: open parts, the gap row's part, hidden parts. */
export interface StretchView {
  stretch: RangedStretch
  /**
   * The part the gap row sits on: the first not yet open, in opening order.
   * Absent once the whole stretch is open (no row).
   */
  head?: StretchPart
  /** The head gap's lines not yet opened (a head run has none). */
  headGap?: LineSpan
  /** Parts past the head, in opening order: they render nothing. */
  hidden: Array<StretchPart>
  /** The new-side lines the row stands for. */
  lines: LineSpan
  /** "L585–622"; the removed side ("L−20–23") when no new line is behind it. */
  label: string
  /** Sibling runs behind the row (the head's included), in line order. */
  runs: Array<RangedRun>
  /** Distinct other units behind the row. */
  units: number
}

/** The new-side lines of a gap the reviewer has not opened yet. */
export function hiddenGapLines(
  gap: RangedGap,
  region: HunkExpansionRegion | undefined
): LineSpan {
  const start = gap.newStart + (region?.fromStart ?? 0)
  const end = gap.newEnd - (region?.fromEnd ?? 0)
  return { start, end, count: Math.max(end - start + 1, 0) }
}

function partIsOpen(part: StretchPart, state: StretchState): boolean {
  if (part.kind === "run") return state.openRuns?.[part.run.hunkIndex] === true
  if (part.gap.size <= INLINE_GAP) return true
  return (
    hiddenGapLines(part.gap, state.expansion?.[part.gap.hunkIndex]).count <= 0
  )
}

/** Parts in the order the gap row opens them: from the owned code outward. */
export function openingOrder(stretch: RangedStretch): Array<StretchPart> {
  return stretch.upward ? [...stretch.parts].reverse() : stretch.parts
}

export function stretchView(
  stretch: RangedStretch,
  state: StretchState
): StretchView {
  const order = openingOrder(stretch)
  const at = order.findIndex((part) => !partIsOpen(part, state))
  const head = at < 0 ? undefined : order[at]
  const hidden = at < 0 ? [] : order.slice(at + 1)
  const headGap =
    head?.kind === "gap"
      ? hiddenGapLines(head.gap, state.expansion?.[head.gap.hunkIndex])
      : undefined
  let start = Infinity
  let end = -Infinity
  let count = 0
  const runs: Array<RangedRun> = []
  for (const part of head ? [head, ...hidden] : []) {
    let span: { start: number; end: number } | undefined
    if (part.kind === "gap") {
      const gap =
        part === head && headGap ? headGap : hiddenGapLines(part.gap, undefined)
      if (gap.count > 0) span = gap
    } else {
      runs.push(part.run)
      if (part.run.label.side === "additions") span = part.run.label
    }
    if (!span) continue
    start = Math.min(start, span.start)
    end = Math.max(end, span.end)
    count += span.end - span.start + 1
  }
  runs.sort((a, b) => a.hunkIndex - b.hunkIndex)
  const removed = runs.filter((run) => run.label.side === "deletions")
  const label =
    count > 0
      ? start === end
        ? `L${start}`
        : `L${start}–${end}`
      : removed.length > 0
        ? rangeLabel({
            side: "deletions",
            start: removed[0]!.label.start,
            end: removed.at(-1)!.label.end,
          })
        : ""
  const units = new Set(
    runs.map((run) =>
      run.owner.kind === "sibling" && run.owner.unitId
        ? run.owner.unitId
        : `#${run.hunkIndex}`
    )
  ).size
  return {
    stretch,
    ...(head ? { head } : {}),
    ...(headGap ? { headGap } : {}),
    hidden,
    lines: count > 0 ? { start, end, count } : { start: 0, end: -1, count: 0 },
    label,
    runs,
    units,
  }
}

/** Is a (side, line) point behind a stretch's gap row right now? */
export function stretchHides(
  view: RangedView,
  shown: StretchView,
  point: { side: DiffSide; lineNumber: number }
): boolean {
  if (!shown.head) return false
  return [shown.head, ...shown.hidden].some((part) => {
    if (part.kind === "run") {
      const hunk = view.fileDiff.hunks[part.run.hunkIndex]
      if (!hunk) return false
      return point.side === "additions"
        ? point.lineNumber >= hunk.additionStart &&
            point.lineNumber < hunk.additionStart + hunk.additionCount
        : point.lineNumber >= hunk.deletionStart &&
            point.lineNumber < hunk.deletionStart + hunk.deletionCount
    }
    const gap = part.gap
    const lines =
      part === shown.head && shown.headGap
        ? shown.headGap
        : hiddenGapLines(gap, undefined)
    // Unchanged lines: the old number maps onto the new one by the offset.
    const line =
      point.side === "additions"
        ? point.lineNumber
        : point.lineNumber + (gap.newStart - gap.oldStart)
    return line >= lines.start && line <= lines.end
  })
}

/** The renderer's side of a ranged file right now. */
export interface RangedLayout {
  /**
   * One per sibling run: shown read-only, folded behind the gap row, or
   * gone; and one open row above each section's first run.
   */
  folds: Array<HunkFold>
  /** Gaps past a gap row's part: no separator, no rows. */
  hiddenGaps: Array<number>
  /** Owned ranges: each stretch that still has a gap row. */
  rows: Array<StretchView>
}

/**
 * Owned ranges: each stretch shows its open parts, one gap row on the first
 * part not yet open, and nothing past it, so the line numbers run on across
 * the row. Whole file: every line, other units' runs read-only, no rows.
 */
export function rangedLayout(
  view: RangedView,
  state: StretchState,
  whole: boolean
): RangedLayout {
  const open = (run: RangedRun): HunkFold => ({
    hunkIndex: run.hunkIndex,
    slotName: foldSlotName(run.hunkIndex),
    collapsed: false,
    readOnly: true,
    row: false,
  })
  const sectionRows = view.sections.map((section): HunkFold => ({
    hunkIndex: section.hunks[0]!,
    slotName: sectionSlotName(section.hunks[0]!),
    collapsed: false,
  }))
  if (whole)
    return {
      folds: [
        ...view.runs.filter((run) => run.owner.kind === "sibling").map(open),
        ...sectionRows,
      ],
      hiddenGaps: [],
      rows: [],
    }
  const folds: Array<HunkFold> = []
  const hiddenGaps: Array<number> = []
  const rows: Array<StretchView> = []
  for (const stretch of view.stretches) {
    const shown = stretchView(stretch, state)
    if (shown.head) rows.push(shown)
    const behind = new Set<StretchPart>(
      shown.head ? [shown.head, ...shown.hidden] : []
    )
    for (const part of stretch.parts) {
      if (part.kind === "gap") {
        if (behind.has(part) && part !== shown.head)
          hiddenGaps.push(part.gap.hunkIndex)
        continue
      }
      folds.push(
        behind.has(part)
          ? {
              ...open(part.run),
              collapsed: true,
              // Only the head's fold row holds the gap row.
              row: part === shown.head,
            }
          : open(part.run)
      )
    }
  }
  return { folds: [...folds, ...sectionRows], hiddenGaps, rows }
}
