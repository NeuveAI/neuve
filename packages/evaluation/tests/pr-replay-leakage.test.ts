// Why: a replay must see nothing after its first revision (10.125, design §6), and the leakage
// check is the only gate before a review runs on a clone. A clone can still hold a later commit
// that no provider record names: fetched into FETCH_HEAD, left dangling, kept by a reflog or
// ORIG_HEAD, a loose blob of later content, or an annotated tag made later on an old commit; each
// is readable by SHA. So a clean clone must pass
// and each planted leak must fail, without `later` naming the commit. A first revision can also
// commit a symlink that points out of the clone, at the case's labels or anywhere on the machine;
// whatever reads the worktree would follow it, so such a clone fails too. Links resolve as the
// kernel resolves them: a dangling link that looks inside by its text but points out through
// another link fails, while one that stays inside (a vendored node_modules/.bin without its
// package) passes, and a loop fails. And a config key such as
// core.fsmonitor runs a command when git touches the clone, the check's own commands included.
import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { leakageChecks, makeReplayClone } from "../src/pr-replay/prepare.ts";
import type { CaseRecord } from "../src/pr-replay/schema.ts";

const root = mkdtempSync(join(tmpdir(), "replay-leakage-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const git = (cwd: string, args: ReadonlyArray<string>, date?: string) => {
  const child = Bun.spawnSync(
    [
      "git",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    {
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
    },
  );
  if (child.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${child.stderr.toString()}`);
  return child.stdout.toString().trim();
};

// A source with a base, the first revision on top of it, and a later revision on another branch.
const source = join(root, "source");
git(root, ["init", "-q", "-b", "main", source]);
const commit = (text: string, date: string) => {
  writeFileSync(join(source, "h"), text);
  git(source, ["add", "h"]);
  git(source, ["commit", "-q", "-m", text], date);
  return git(source, ["rev-parse", "HEAD"]);
};
const base = commit("base", "2021-01-01T00:00:00Z");
const first = commit("first", "2021-01-02T00:00:00Z");
// An annotated tag made later on an old commit: a clone can carry it even with --no-tags.
git(
  source,
  ["tag", "-a", "v1", "-m", "release notes from later", base],
  "2021-06-01T00:00:00Z",
);
git(source, ["checkout", "-q", "-b", "later"]);
const later = commit("later", "2021-01-05T00:00:00Z");
git(source, ["checkout", "-q", "main"]);

let clones = 0;
const freshClone = () => {
  const replay = join(root, `replay-${++clones}`);
  makeReplayClone(source, first, replay, "replay/case");
  return replay;
};

const record = (
  replay: string,
  at = "2021-01-03T00:00:00.000Z",
  revision = { head: first, base },
) =>
  ({
    clone: { path: replay, preparedAt: at },
    firstRevision: {
      ...revision,
      at,
      how: "gerrit-patchset-1",
      baseFrom: "gerrit-parent",
    },
    // Nothing named: the check must find later content on its own.
    later: { finalHead: null, merged: null, revisions: [] },
  }) as unknown as CaseRecord;

test("a clean clone holds only the first revision's history and passes", () => {
  const checks = leakageChecks(record(freshClone()));
  expect(checks.unreachableObjects).toBe(0);
  expect(checks.reflogEntries).toBe(0);
  expect(checks.transientHeads).toEqual([]);
  expect(checks.configOnlyCloneKeys).toBe(true);
  expect(checks.unexpectedGitEntries).toEqual([]);
  expect(checks.passed).toBe(true);
});

test("a later commit fetched into FETCH_HEAD fails", () => {
  const replay = freshClone();
  git(replay, ["fetch", "-q", source, "later"]);
  const checks = leakageChecks(record(replay));
  expect(checks.transientHeads).toContain("FETCH_HEAD");
  expect(checks.unreachableObjects).toBeGreaterThan(0);
  expect(checks.passed).toBe(false);
});

test("a dangling later commit fails", () => {
  const replay = freshClone();
  git(replay, ["fetch", "-q", source, "later:refs/heads/tmp"]);
  git(replay, ["update-ref", "-d", "refs/heads/tmp"]);
  rmSync(join(replay, ".git", "FETCH_HEAD"), { force: true });
  rmSync(join(replay, ".git", "logs"), { recursive: true, force: true });
  const checks = leakageChecks(record(replay));
  expect(checks.transientHeads).toEqual([]);
  expect(checks.reflogEntries).toBe(0);
  expect(checks.unreachableObjects).toBeGreaterThan(0);
  expect(checks.passed).toBe(false);
});

test("a later commit kept by ORIG_HEAD or a reflog fails", () => {
  const replay = freshClone();
  git(replay, ["fetch", "-q", source, "later"]);
  rmSync(join(replay, ".git", "FETCH_HEAD"));
  git(replay, ["reset", "-q", "--hard", later]);
  git(replay, ["reset", "-q", "--hard", first]);
  const withOrigHead = leakageChecks(record(replay));
  expect(withOrigHead.transientHeads).toContain("ORIG_HEAD");
  expect(withOrigHead.passed).toBe(false);
  rmSync(join(replay, ".git", "ORIG_HEAD"));
  const withReflog = leakageChecks(record(replay));
  expect(withReflog.transientHeads).toEqual([]);
  expect(withReflog.reflogEntries).toBeGreaterThan(0);
  expect(withReflog.passed).toBe(false);
});

test("a loose blob of later content fails", () => {
  const replay = freshClone();
  const blob = Bun.spawnSync(["git", "hash-object", "-w", "--stdin"], {
    cwd: replay,
    stdin: new TextEncoder().encode("later content"),
  });
  expect(blob.exitCode).toBe(0);
  const checks = leakageChecks(record(replay));
  expect(checks.unreachableObjects).toBe(1);
  expect(checks.passed).toBe(false);
});

test("a remote or branch in the clone's config fails, since a fetch would reach the future", () => {
  const replay = freshClone();
  git(replay, ["config", "branch.replay.remote", source]);
  const checks = leakageChecks(record(replay));
  expect(checks.configOnlyCloneKeys).toBe(false);
  expect(checks.passed).toBe(false);
});

test("a config key that runs a command fails, and the check itself never runs it", () => {
  mkdirSync(join(root, "a hook's folder"));
  const hook = join(root, "a hook's folder", "fsmonitor.sh");
  writeFileSync(hook, '#!/bin/sh\ntouch "$0.ran"\n', { mode: 0o755 });
  // git runs these values with sh, so the path is quoted as one word. Unquoted, its space
  // or apostrophe would stop the hook running, and the last assertion could never fail.
  const command = `'${hook.replaceAll("'", `'\\''`)}'`;
  // The hook is real: status in a clone with it configured runs it.
  const probe = freshClone();
  git(probe, ["config", "core.fsmonitor", command]);
  Bun.spawnSync(["git", "-C", probe, "status", "--porcelain"]);
  expect(existsSync(`${hook}.ran`)).toBe(true);
  // One marker, whatever environment a run gets, so any run by the check below shows.
  rmSync(`${hook}.ran`);

  for (const [key, value] of [
    ["core.fsmonitor", command],
    ["core.hooksPath", root],
    ["core.sshCommand", command],
    ["core.pager", command],
  ] as const) {
    const replay = freshClone();
    git(replay, ["config", key, value]);
    const checks = leakageChecks(record(replay));
    expect(checks.configOnlyCloneKeys).toBe(false);
    expect(checks.passed).toBe(false);
  }
  expect(existsSync(`${hook}.ran`)).toBe(false);
});

test("a repository nested in .git fails", () => {
  const replay = freshClone();
  git(root, ["init", "-q", "--bare", join(replay, ".git", "modules", "x")]);
  const checks = leakageChecks(record(replay));
  expect(checks.unexpectedGitEntries).toEqual(["modules"]);
  expect(checks.passed).toBe(false);
});

test("a first revision dated before its own head commit fails", () => {
  const checks = leakageChecks(
    record(freshClone(), "2021-01-01T12:00:00.000Z"),
  );
  expect(checks.newestCommitNotAfterFirstRevision).toBe(false);
  expect(checks.passed).toBe(false);
});

test("a first revision with a symlink out of the clone fails; one inside passes", () => {
  const linked = join(root, "linked");
  git(root, ["init", "-q", "-b", "main", linked]);
  writeFileSync(join(linked, "h"), "base");
  git(linked, ["add", "h"]);
  git(linked, ["commit", "-q", "-m", "base"], "2021-01-01T00:00:00Z");
  const linkedBase = git(linked, ["rev-parse", "HEAD"]);
  const commitLinks = (links: Record<string, string>, date: string) => {
    for (const [name, target] of Object.entries(links))
      symlinkSync(target, join(linked, name));
    git(linked, ["add", ...Object.keys(links)]);
    git(linked, ["commit", "-q", "-m", "links"], date);
    return git(linked, ["rev-parse", "HEAD"]);
  };
  const cloneAt = (head: string) => {
    const replay = join(root, `replay-${++clones}`);
    makeReplayClone(linked, head, replay, "replay/case");
    return leakageChecks(record(replay, undefined, { head, base: linkedBase }));
  };

  mkdirSync(join(linked, "sub", "deep"), { recursive: true });
  mkdirSync(join(linked, "node_modules", ".bin"), { recursive: true });
  const inside = commitLinks(
    {
      "to-h": "h",
      "to-dir": ".",
      "sub/deep/r": "../..",
      // Dangling but inside: a vendored bin link whose package was never committed.
      "node_modules/.bin/acorn": "../acorn/bin/acorn",
      dangling: "missing",
      // Through a regular file (ENOTDIR): missing, and inside.
      "through-file": "h/missing",
    },
    "2021-01-02T00:00:00Z",
  );
  expect(cloneAt(inside).escapingSymlinks).toEqual([]);
  expect(cloneAt(inside).passed).toBe(true);

  const outside = commitLinks(
    {
      "to-labels": "../labels/concerns.jsonl",
      "to-root": "/",
      "via-dir": "to-dir/../..",
      // Dangling, and inside by their text; the kernel resolves the link first, then `..`.
      "via-self": "to-dir/../labels/later.json",
      "via-deep": "sub/deep/r/../later.json",
      // A loop resolves to nothing: fails closed.
      "loop-a": "loop-b",
      "loop-b": "loop-a",
    },
    "2021-01-02T01:00:00Z",
  );
  const checks = cloneAt(outside);
  expect(checks.escapingSymlinks).toEqual([
    "loop-a",
    "loop-b",
    "to-labels",
    "to-root",
    "via-deep",
    "via-dir",
    "via-self",
  ]);
  expect(checks.passed).toBe(false);

  // A link made after cloning, untracked or inside .git, counts the same.
  const planted = freshClone();
  symlinkSync("../../../labels", join(planted, ".git", "info", "x"));
  expect(leakageChecks(record(planted)).escapingSymlinks).toEqual([
    ".git/info/x",
  ]);
});
