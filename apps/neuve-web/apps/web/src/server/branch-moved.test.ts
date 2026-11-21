// Why (23 October 2026): the overview offers "Start a review" as new work on the branch since a
// batch's review. The review of that change found it trusted any head that differed from the
// reviewed one, so an unrelated branch or a reset behind the review read as new work. This runs the
// rule on a real repository in a temporary directory: only a head that descends from the reviewed
// one, and is not it, counts.
//
// Why (21 November 2026, NEU-433): "Waiting on you" drops a review whose range is done or that a
// later review's range holds, so a wrong answer from git hides work a person still has to decide,
// or keeps finished work in the way. These run the git reads on real repositories: a merge, a
// squash merge of a branch tip that holds the reviewed head, a stacked pair squashed as one, a head
// on no branch (a ref of Neuve's own doesn't count), a head the repository doesn't hold, and a
// range still open; and which reviewed commits descend from which.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, expect, test } from "bun:test"

import { movedPast } from "./branch-moved.server"
import { ancestryOf, rangeEnds } from "./range-done.server"

const directories: Array<string> = []
afterAll(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

/** A home of the test's own, so the owner's git config (signing, hooks) never shapes the commits. */
const home = mkdtempSync(join(tmpdir(), "branch-moved-home-"))
directories.push(home)

const git = (at: string, ...args: Array<string>) => {
  const run = Bun.spawnSync(["git", "-C", at, ...args], {
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      TMPDIR: process.env["TMPDIR"] ?? tmpdir(),
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  })
  if (run.exitCode !== 0) throw new Error(run.stderr.toString())
  return run.stdout.toString().trim()
}

const commit = (at: string, file: string) => {
  writeFileSync(join(at, file), file)
  git(at, "add", file)
  git(at, "commit", "--quiet", "-m", file)
  return git(at, "rev-parse", "HEAD")
}

test("only a head that descends from the reviewed one is new work", async () => {
  const at = mkdtempSync(join(tmpdir(), "branch-moved-"))
  directories.push(at)
  git(at, "init", "--quiet", "-b", "main")
  const base = commit(at, "base")
  const reviewed = commit(at, "reviewed")
  const later = commit(at, "later")
  git(at, "checkout", "--quiet", "-b", "other", base)
  const unrelated = commit(at, "unrelated")

  expect(await movedPast(at, reviewed, later)).toBe(true)
  expect(await movedPast(at, reviewed, reviewed)).toBe(false)
  // Reset behind the review: the head is an ancestor, not a descendant.
  expect(await movedPast(at, reviewed, base)).toBe(false)
  // Another branch from before the review.
  expect(await movedPast(at, reviewed, unrelated)).toBe(false)
  // A revision the repository doesn't hold.
  expect(await movedPast(at, "f".repeat(40), later)).toBe(false)
})

test("a range is done when it landed on the default branch, by merge or by squash, or its head is gone", async () => {
  const at = mkdtempSync(join(tmpdir(), "range-done-"))
  directories.push(at)
  git(at, "init", "--quiet", "-b", "main")
  commit(at, "base")
  // Merged: its head is in the default branch.
  git(at, "checkout", "--quiet", "-b", "merged")
  const merged = commit(at, "merged")
  git(at, "checkout", "--quiet", "main")
  git(at, "merge", "--quiet", "--no-ff", "-m", "merge", "merged")
  // Squashed from a later tip: the reviewed head is behind the branch's tip.
  git(at, "checkout", "--quiet", "-b", "squashed")
  const squashedHead = commit(at, "squashed-1")
  commit(at, "squashed-2")
  // Stacked: the upper branch, holding the lower, landed as one squash.
  git(at, "checkout", "--quiet", "-b", "lower", "main")
  const lower = commit(at, "lower")
  git(at, "checkout", "--quiet", "-b", "upper")
  const upper = commit(at, "upper")
  git(at, "checkout", "--quiet", "main")
  for (const branch of ["squashed", "upper"]) {
    git(at, "merge", "--quiet", "--squash", branch)
    git(at, "commit", "--quiet", "-m", `squash ${branch}`)
  }
  // Gone: rebased away, kept only by a ref of Neuve's own.
  git(at, "checkout", "--quiet", "-b", "gone")
  const gone = commit(at, "gone")
  git(at, "update-ref", `refs/neuve/reviews/${gone}`, gone)
  git(at, "checkout", "--quiet", "main")
  git(at, "branch", "--quiet", "-D", "gone")
  // Open: on a branch, not landed.
  git(at, "checkout", "--quiet", "-b", "open")
  const open = commit(at, "open")
  git(at, "checkout", "--quiet", "main")
  git(at, "update-ref", "refs/remotes/origin/main", "main")
  git(
    at,
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main"
  )

  const range = (cycleId: string, headOid: string, baseRef = "abc1234") => ({
    cycleId,
    baseRef,
    headOid,
  })
  const ranges = [
    range("merged", merged),
    range("squashed", squashedHead),
    range("lower", lower),
    range("upper", upper),
    range("gone", gone),
    range("missing", "f".repeat(40)),
    range("open", open),
  ]
  const ended = async (of: typeof ranges) =>
    Object.fromEntries(await rangeEnds(at, of)) as Record<string, string>
  const expected: Record<string, string> = {
    merged: "landed",
    squashed: "landed",
    lower: "landed",
    upper: "landed",
    gone: "gone",
    missing: "gone",
  }
  expect(await ended(ranges)).toEqual(expected)
  // The second read answers from what the first kept, the same.
  expect(await ended(ranges)).toEqual(expected)

  // Without origin/HEAD, a base ref that names a branch is the default branch; one that doesn't
  // leaves the range unplaced.
  git(at, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD")
  expect(
    await ended([
      range("named", merged, "main"),
      range("unnamed", merged, "abc1234"),
    ])
  ).toEqual({ named: "landed" })
})

test("which reviewed commits descend from which", async () => {
  const at = mkdtempSync(join(tmpdir(), "range-ancestry-"))
  directories.push(at)
  git(at, "init", "--quiet", "-b", "main")
  const base = commit(at, "base")
  const middle = commit(at, "middle")
  const head = commit(at, "head")
  git(at, "checkout", "--quiet", "-b", "side", base)
  const side = commit(at, "side")
  const missing = "e".repeat(40)
  const descends = await ancestryOf(at, [base, middle, head, side, missing])
  expect(descends(base, head)).toBe(true)
  expect(descends(middle, head)).toBe(true)
  expect(descends(head, head)).toBe(true)
  expect(descends(head, middle)).toBe(false)
  expect(descends(side, head)).toBe(false)
  expect(descends(base, side)).toBe(true)
  expect(descends(missing, head)).toBe(false)
})
