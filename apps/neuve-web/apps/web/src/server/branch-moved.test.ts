// Why (23 October 2026): the overview offers "Start a review" as new work on the branch since a
// batch's review. The review of that change found it trusted any head that differed from the
// reviewed one, so an unrelated branch or a reset behind the review read as new work. This runs the
// rule on a real repository in a temporary directory: only a head that descends from the reviewed
// one, and is not it, counts.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, expect, test } from "bun:test"

import { movedPast } from "./branch-moved.server"

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
