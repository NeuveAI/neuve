// Why: the rework map is the history signal behind "needs a person" lanes (10.123, 10.128). A file
// renamed during review or after landing, with no content change, must not count its lines as
// reworked, and a line changed after landing must still be found through the new names; otherwise
// every renamed file reads as wholly reworked, or its later fixes vanish.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CaseRecord } from "../src/pr-replay/schema.ts";

const root = mkdtempSync(join(tmpdir(), "replay-rework-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
process.env["NEUVE_RESEARCH_ROOT"] = root;
const { reworkMap } = await import("../src/pr-replay/rework.ts");

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

// base → first (adds a.ts) → final (renames it to b.ts, content unchanged), landed on main; then a
// second rename to c.ts, a fix to its second line 10 days after landing, and an edit to its third
// 200 days after, outside the window.
const work = join(root, "work");
git(root, ["init", "-q", "-b", "main", work]);
const commit = (message: string, date: string) => {
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", message], date);
  return git(work, ["rev-parse", "HEAD"]);
};
writeFileSync(join(work, "other.ts"), "x\n");
const base = commit("base", "2021-01-01T00:00:00Z");
writeFileSync(join(work, "a.ts"), "one\ntwo\nthree\nfour\n");
const first = commit("first", "2021-01-02T00:00:00Z");
git(work, ["mv", "a.ts", "b.ts"]);
const final = commit("rename", "2021-01-03T00:00:00Z");
git(work, ["mv", "b.ts", "c.ts"]);
commit("Rename again after landing", "2021-01-08T00:00:00Z");
writeFileSync(join(work, "c.ts"), "one\nTWO\nthree\nfour\n");
commit("Fix the second line", "2021-01-13T00:00:00Z");
writeFileSync(join(work, "c.ts"), "one\nTWO\nTHREE\nfour\n");
commit("Much later", "2021-07-22T00:00:00Z");
// The mirror path for the Gerrit source this record names.
git(root, [
  "clone",
  "-q",
  "--bare",
  work,
  join(root, "mirrors", "devtools__devtools-frontend.git"),
]);
const capture = join(root, "cases", "devtools-frontend", "1", "capture");
mkdirSync(capture, { recursive: true });
writeFileSync(
  join(capture, "detail.json"),
  JSON.stringify({ submitted: "2021-01-03 00:00:00.000000000" }),
);

const record = {
  caseId: "gerrit:devtools/devtools-frontend:1",
  source: "devtools-frontend",
  provider: "gerrit",
  number: 1,
  firstRevision: {
    head: first,
    base,
    at: "2021-01-02T00:00:00.000Z",
    how: "gerrit-patchset-1",
    baseFrom: "gerrit-parent",
  },
  later: { finalHead: final, merged: final, revisions: [final] },
} as unknown as CaseRecord;

test("renames during review and after landing change no line, and a later fix is found through them", () => {
  const map = reworkMap(record);
  expect(map.firstLines).toBe(4);
  expect(map.landed).toBe(final);
  expect(map.untracked).toBe(0);
  // Only the fixed line, within the 90 days, under its first-revision key.
  expect(Object.keys(map.lines)).toEqual(["a.ts:new:2"]);
  expect(map.lines["a.ts:new:2"]!.beforeMerge).toBe(false);
  expect(map.lines["a.ts:new:2"]!.afterMerge?.subject).toBe(
    "Fix the second line",
  );
  expect(map.lines["a.ts:new:2"]!.afterMerge?.days).toBe(10);
});
