import { basename } from "node:path"
import { Effect } from "effect"
import {
  diffTrees,
  mergeBase,
  readBlobs,
  type DiffFile,
} from "@neuve/harness/git-objects"
import type { SubmittedBranchReview } from "@neuve/records-schema"
import {
  DecisionRangesError,
  projectSubmittedChangedRanges,
} from "@neuve/review-rules"

import type {
  HunkHeader,
  HunkHeaders,
  ReviewRange,
  SourceFile,
  Sources,
} from "./projection"

/**
 * The diff's contents for the desk (M5 RD4, 10.34): git objects at the
 * range's merge base and head, never the working tree, so untracked and
 * ignored files never reach the desk. Through the harness's git-objects
 * subpath, the reads the harness's own Precompute makes. Each hunk's changed
 * lines come from the shared review rules (10.21), as the harness's own
 * owned ranges do, so the desk and the harness agree on what a hunk changes.
 */

const decoder = new TextDecoder()

/**
 * Git's diff as the review rules take it: the files and their hunks, each
 * hunk named by its file and position. The rules refuse a diff they cannot
 * account for; its hunks then carry no changed ranges and the desk shows
 * those files whole.
 */
const changedRanges = (
  range: ReviewRange,
  base: string,
  diff: ReadonlyArray<DiffFile>
) => {
  const id = (file: DiffFile, index: number) =>
    `${file.oldPath ?? ""}\0${file.newPath ?? ""}\0${index}`
  const kind = (file: DiffFile) =>
    file.binary
      ? ("binary" as const)
      : file.hunks.length === 0
        ? ("metadata" as const)
        : ("text" as const)
  const hunks = diff.flatMap((file) =>
    kind(file) === "text"
      ? file.hunks.map((hunk, index) => ({
          hunkId: id(file, index),
          lane: "agentic" as const,
          kind: "text" as const,
          path: file.newPath ?? file.oldPath ?? "",
          oldPath: file.oldPath,
          newPath: file.newPath,
          oldRange: { startLine: hunk.oldStart, lineCount: hunk.oldLines },
          newRange: { startLine: hunk.newStart, lineCount: hunk.newLines },
          text: hunk.text,
        }))
      : []
  )
  const submission: SubmittedBranchReview = {
    repository: "repository",
    branch: range.headOid,
    baseBranch: range.baseOid,
    baseRevisionId: range.baseOid,
    mergeBaseRevisionId: base,
    revisionId: range.headOid,
    snapshotKind: "committed",
    workingTreeDirty: false,
    limitations: [],
    files: diff
      .filter((file) => kind(file) === "text")
      .map((file) => ({
        status: file.status,
        oldPath: file.oldPath,
        newPath: file.newPath,
        oldMode: file.oldMode,
        newMode: file.newMode,
        binary: false,
        hunkIds: file.hunks.map((_hunk, index) => id(file, index)),
      })),
    hunks,
    inventory: {
      revisionId: range.headOid,
      hunks: hunks.map((hunk) => ({ hunkId: hunk.hunkId, lane: hunk.lane })),
    },
  }
  try {
    const projected = projectSubmittedChangedRanges(submission)
    return {
      of: (file: DiffFile, index: number) =>
        projected.hunks.find((hunk) => hunk.hunkId === id(file, index))
          ?.changedRanges ?? [],
    }
  } catch (error) {
    if (!(error instanceof DecisionRangesError)) throw error
    return { of: () => [] }
  }
}

/** A gitlink's side as git's diff prints it. */
const gitlink = (oid: string | null) =>
  oid === null ? "" : `Subproject commit ${oid}\n`

/** The files of git's diff whose old or new path is among `paths`. */
const touching = (
  diff: ReadonlyArray<DiffFile>,
  paths: ReadonlyArray<string>
) => {
  const wanted = new Set(paths)
  return diff.filter(
    (file) =>
      (file.newPath !== null && wanted.has(file.newPath)) ||
      (file.oldPath !== null && wanted.has(file.oldPath))
  )
}

/** Each file's hunk headers, by old and by new path. */
const headersOf = (diff: ReadonlyArray<DiffFile>): HunkHeaders => {
  const hunks: Record<string, ReadonlyArray<HunkHeader>> = {}
  for (const file of diff) {
    const headers = file.hunks.map((hunk) => ({
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
    }))
    if (file.oldPath !== null) hunks[file.oldPath] = headers
    if (file.newPath !== null) hunks[file.newPath] = headers
  }
  return hunks
}

/**
 * Git's hunks of `paths` between the range's merge base and head, without
 * the files' contents: what the overview's hunk counts read, by the rule
 * the unit page counts by (`hunkCount`).
 */
export const hunksFor = (
  repository: string,
  range: ReviewRange,
  paths: ReadonlyArray<string>
) =>
  Effect.gen(function* () {
    if (paths.length === 0) return {}
    const base = yield* mergeBase(repository, range.baseOid, range.headOid)
    return headersOf(
      touching(yield* diffTrees(repository, base, range.headOid), paths)
    )
  }).pipe(
    Effect.withSpan("web.git.hunks", {
      attributes: { "neuve.git.paths": paths.length },
    })
  )

export const sourcesFor = (
  repository: string,
  range: ReviewRange,
  paths: ReadonlyArray<string>,
  citedBlobs: ReadonlyArray<string>,
  /** Files whose hunks alone are read too: the rail's units' (`Sources.hunks`). */
  listed: ReadonlyArray<string> = []
) =>
  Effect.gen(function* () {
    const base = yield* mergeBase(repository, range.baseOid, range.headOid)
    const whole = yield* diffTrees(repository, base, range.headOid)
    const diff = touching(whole, paths)
    const isLink = (mode: string | null) => mode === "160000"
    const oids = diff.flatMap((file) => [
      ...(file.oldOid !== null && !isLink(file.oldMode) && !file.binary
        ? [file.oldOid]
        : []),
      ...(file.newOid !== null && !isLink(file.newMode) && !file.binary
        ? [file.newOid]
        : []),
    ])
    const blobs = yield* readBlobs(repository, [...oids, ...citedBlobs])
    const text = (oid: string | null, mode: string | null) => {
      if (oid === null || /^0+$/.test(oid)) return ""
      if (isLink(mode)) return gitlink(oid)
      const bytes = blobs.get(oid)
      return bytes === undefined ? "" : decoder.decode(bytes)
    }
    const rules = changedRanges(range, base, diff)
    const files: Record<string, SourceFile> = {}
    for (const file of diff) {
      const source: SourceFile = {
        path: file.newPath ?? file.oldPath ?? "",
        oldPath: file.oldPath,
        newPath: file.newPath,
        binary: file.binary,
        oldContents: text(file.oldOid, file.oldMode),
        newContents: text(file.newOid, file.newMode),
        hunks: file.hunks.map((hunk, index) => ({
          ...hunk,
          changed: rules.of(file, index),
        })),
      }
      if (file.oldPath !== null) files[file.oldPath] = source
      if (file.newPath !== null) files[file.newPath] = source
    }
    const cited: Record<string, ReadonlyArray<string>> = {}
    for (const oid of citedBlobs) {
      const bytes = blobs.get(oid)
      if (bytes !== undefined) cited[oid] = decoder.decode(bytes).split("\n")
    }
    return {
      mergeBase: base,
      head: range.headOid,
      files,
      blobs: cited,
      hunks: headersOf(touching(whole, [...paths, ...listed])),
    } satisfies Sources
  }).pipe(
    Effect.withSpan("web.git.sources", {
      attributes: {
        "neuve.git.paths": paths.length,
        "neuve.git.cited": citedBlobs.length,
      },
    })
  )

/** One `git config` value in the repository, or "" when it is unset. */
const config = async (repository: string, key: string) => {
  const child = Bun.spawn(["git", "-C", repository, "config", "--get", key], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  })
  const [out, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ])
  return code === 0 ? out.trim() : ""
}

/** The repository's name as the header shows it: its origin's, else its folder's. */
export const repositoryName = async (repository: string) => {
  const origin = await config(repository, "remote.origin.url")
  const from = origin === "" ? repository : origin
  return basename(from.replace(/\/+$/, "")).replace(/\.git$/, "")
}
