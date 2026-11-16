// Why: a first revision's range must hold the pull request's own change and nothing else. Batch 1
// found React pull requests whose branch was rebased onto a newer target before the first review:
// the recorded base was older than the fork, and the range dragged in the target's commits in
// between (2,979 lines for a +577 -311 pull request). The base must follow the later fork when the
// branch forked later, keep the merge-commit fix (never the head itself), and fall back to the
// recorded base when the target was rewritten since; a range far past the pull request's own diff
// must never pass in silence.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubBase, stackedBase } from "../src/pr-replay/prepare.ts";

const root = mkdtempSync(join(tmpdir(), "replay-base-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const git = (cwd: string, args: ReadonlyArray<string>, date?: string) => {
  const child = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: root,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "a",
      GIT_AUTHOR_EMAIL: "a@example.com",
      GIT_COMMITTER_NAME: "a",
      GIT_COMMITTER_EMAIL: "a@example.com",
      ...(date === undefined
        ? {}
        : { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }),
    },
  });
  if (child.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${child.stderr.toString()}`);
  return child.stdout.toString().trim();
};

let repos = 0;
/** A working repository and helpers to commit on it at a given committer date. */
const repository = () => {
  const work = join(root, `work-${++repos}`);
  git(root, ["init", "-q", "-b", "main", work]);
  const commit = (name: string, date: string) => {
    writeFileSync(join(work, name), name);
    git(work, ["add", name]);
    git(work, ["commit", "-q", "-m", name], date);
    return git(work, ["rev-parse", "HEAD"]);
  };
  /** The bare mirror the code reads, as prepare.ts clones it. */
  const mirror = () => {
    const path = join(
      root,
      `mirror-${repos}-${Math.random().toString(36).slice(2)}`,
    );
    git(root, ["clone", "-q", "--bare", work, path]);
    return path;
  };
  return { work, commit, mirror };
};

test("a branch rebased onto a newer target before its first review takes the later fork", () => {
  const { work, commit, mirror } = repository();
  const m1 = commit("m1", "2021-01-01T00:00:00Z");
  commit("m2", "2021-01-02T00:00:00Z");
  const m3 = commit("m3", "2021-01-03T00:00:00Z");
  // The branch, as reviewed: rebased onto m3. The pull request still records m1.
  git(work, ["checkout", "-q", "-b", "feature", m3]);
  const head = commit("b1", "2021-01-04T00:00:00Z");
  git(work, ["checkout", "-q", "main"]);
  const base = githubBase(mirror(), head, [m1], "main", "2021-01-05T00:00:00Z");
  expect(base).toBe(m3);
});

test("a merge-commit pull request keeps its fork, never its head", () => {
  const { work, commit, mirror } = repository();
  const m1 = commit("m1", "2021-01-01T00:00:00Z");
  git(work, ["checkout", "-q", "-b", "feature"]);
  const head = commit("b1", "2021-01-02T00:00:00Z");
  git(work, ["checkout", "-q", "main"]);
  const m2 = commit("m2", "2021-01-03T00:00:00Z");
  // Merged after the review, by a merge commit: today's target contains the head.
  git(
    work,
    ["merge", "-q", "--no-ff", "-m", "merge", "feature"],
    "2021-01-06T00:00:00Z",
  );
  const merge = git(work, ["rev-parse", "HEAD"]);
  const base = githubBase(
    mirror(),
    head,
    [m2, `${merge}^1`],
    "main",
    "2021-01-04T00:00:00Z",
  );
  expect(base).toBe(m1);
  expect(base).not.toBe(head);
});

test("a target rewritten since the review falls back to the recorded base", () => {
  const { work, commit, mirror } = repository();
  const m1 = commit("m1", "2021-01-01T00:00:00Z");
  git(work, ["checkout", "-q", "-b", "feature"]);
  const head = commit("b1", "2021-01-02T00:00:00Z");
  // The target as it is today: force-pushed to an unrelated history whose tip predates the review.
  git(work, ["checkout", "-q", "--orphan", "rewritten"]);
  git(work, ["rm", "-q", "-rf", "."]);
  commit("x1", "2021-01-01T12:00:00Z");
  git(work, ["branch", "-q", "-f", "main", "rewritten"]);
  git(work, ["checkout", "-q", "main"]);
  const base = githubBase(mirror(), head, [m1], "main", "2021-01-03T00:00:00Z");
  expect(base).toBe(m1);
});

test("a revert on the target around the review leaves the fork where it was", () => {
  const { work, commit, mirror } = repository();
  const m1 = commit("m1", "2021-01-01T00:00:00Z");
  const m2 = commit("m2", "2021-01-02T00:00:00Z");
  git(work, ["checkout", "-q", "-b", "feature", m2]);
  const head = commit("b1", "2021-01-03T00:00:00Z");
  git(work, ["checkout", "-q", "main"]);
  git(work, ["revert", "--no-edit", m2], "2021-01-04T00:00:00Z");
  // Recorded base m1, branch forked at m2; the revert after the review does not move the fork.
  expect(githubBase(mirror(), head, [m1], "main", "2021-01-05T00:00:00Z")).toBe(
    m2,
  );
});

test("a stacked branch's base moves to the parent pull request's tip, found by patch", () => {
  const { work, commit, mirror } = repository();
  const m1 = commit("m1", "2021-01-01T00:00:00Z");
  // Another pull request's commits, unmerged when this one was first reviewed.
  git(work, ["checkout", "-q", "-b", "parent"]);
  commit("p1", "2021-01-02T00:00:00Z");
  const p2 = commit("p2", "2021-01-02T01:00:00Z");
  git(work, ["checkout", "-q", "-b", "child"]);
  commit("c1", "2021-01-03T00:00:00Z");
  const head = commit("c2", "2021-01-03T01:00:00Z");
  // After the parent landed, the child was rebased onto main: same patches, new SHAs.
  git(work, ["checkout", "-q", "-b", "child-final", m1]);
  git(work, ["cherry-pick", `${p2}..${head}`], "2021-01-05T00:00:00Z");
  const final = git(work, ["log", "--format=%H", `${m1}..child-final`]).split(
    "\n",
  );
  git(work, ["checkout", "-q", "main"]);
  // The provider links the parent's commits to its own pull request, number 7.
  const linked = (sha: string) => (sha === p2 ? [7] : []);
  expect(stackedBase(mirror(), m1, head, final, 8, linked)).toEqual({
    base: p2,
    unverified: null,
  });
});

test("a first revision of only its own commits keeps its base", () => {
  const { work, commit, mirror } = repository();
  const m1 = commit("m1", "2021-01-01T00:00:00Z");
  git(work, ["checkout", "-q", "-b", "feature"]);
  const b1 = commit("b1", "2021-01-02T00:00:00Z");
  const head = commit("b2", "2021-01-02T01:00:00Z");
  git(work, ["checkout", "-q", "main"]);
  // A first revision later cut down: the final commits are still these, plus one more.
  expect(stackedBase(mirror(), m1, head, [b1, head], 8, () => [])).toEqual({
    base: m1,
    unverified: null,
  });
});

test("a history rewritten past recognition keeps its base and says it is unverified", () => {
  const { work, commit, mirror } = repository();
  const m1 = commit("m1", "2021-01-01T00:00:00Z");
  git(work, ["checkout", "-q", "-b", "feature"]);
  const head = commit("b1", "2021-01-02T00:00:00Z");
  // The pull request's final commits share neither SHA nor patch with its first revision.
  git(work, ["checkout", "-q", "-b", "rewritten", m1]);
  const other = commit("entirely-different", "2021-01-04T00:00:00Z");
  git(work, ["checkout", "-q", "main"]);
  expect(stackedBase(mirror(), m1, head, [other], 8, () => [])).toEqual({
    base: m1,
    unverified:
      "none of the pull request's own commits is in its first-revision range",
  });
});

test("an amended first commit is no foreign commit: the base stays, flagged unverified", () => {
  const { work, commit, mirror } = repository();
  const m1 = commit("m1", "2021-01-01T00:00:00Z");
  git(work, ["checkout", "-q", "-b", "feature"]);
  commit("b1", "2021-01-02T00:00:00Z");
  const head = commit("b2", "2021-01-02T01:00:00Z");
  // Later the first commit was amended (a new patch) and the second kept: the final list holds the
  // second and the amended first. The provider links the old first commit to no other pull request.
  git(work, ["checkout", "-q", "-b", "final", m1]);
  const amended = commit("b1-amended", "2021-01-04T00:00:00Z");
  git(work, ["checkout", "-q", "main"]);
  const result = stackedBase(mirror(), m1, head, [amended, head], 8, () => [8]);
  expect(result.base).toBe(m1);
  expect(result.unverified).toContain("amended or squashed later");
});
