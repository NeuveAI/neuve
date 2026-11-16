// Why: controls measure over-escalation (design §1, the owner's call of 26 October), so each must be
// what its kind says. A revert control is the original change a revert undid, not the revert; a
// mechanical change is known by its files or a roll bot, never its title; quiet and mechanical have
// at most one comment and a reverted original fewer than an interaction case; every kind has the
// cases' size bounds. A review's first draft got the revert and mechanical rules wrong: titles like
// "Format CSS numbers in the Styles pane" with 12 comments came out mechanical.
import { expect, test } from "bun:test";
import {
  controlKind,
  gerritMessageSays,
  revertedCommit,
  revertedPull,
  type ControlFacts,
} from "../src/pr-replay/controls.ts";

const change = (over: Partial<ControlFacts> = {}): ControlFacts => ({
  title: "Fix the network panel's sort order",
  author: "someone",
  merged: true,
  abandoned: false,
  lines: 80,
  files: 3,
  comments: 0,
  paths: ["front_end/panels/network/NetworkLogView.ts"],
  reverted: false,
  ...over,
});

test("quiet and mechanical are told apart by files and comments, never by title", () => {
  expect(controlKind(change())).toBe("quiet");
  expect(controlKind(change({ comments: 1 }))).toBe("quiet");
  expect(controlKind(change({ comments: 2 }))).toBeNull();
  // The titles the first draft misread: code files and comments make them no mechanical control.
  for (const title of [
    "Format CSS numbers in the Styles pane",
    "Support generated source maps",
    "Bump the minimum Node version check and fix startup",
  ]) {
    expect(controlKind(change({ title, comments: 12 }))).toBeNull();
    expect(controlKind(change({ title }))).toBe("quiet");
  }
  expect(controlKind(change({ paths: ["DEPS"], title: "Update things" }))).toBe(
    "mechanical",
  );
  expect(
    controlKind(
      change({
        paths: ["package-lock.json", "node_modules/acorn/dist/acorn.js"],
      }),
    ),
  ).toBe("mechanical");
  // A project's own code under third_party/ (DevTools' build tooling) is not mechanical, and
  // every file there is ambiguous: no control.
  expect(
    controlKind(
      change({ paths: ["third_party/typescript/tests/fixtures/BUILD.gn"] }),
    ),
  ).toBeNull();
  expect(
    controlKind(change({ paths: ["third_party/foo/package-lock.json"] })),
  ).toBe("mechanical");
  expect(
    controlKind(change({ author: "chromium-autoroll", paths: null })),
  ).toBe("mechanical");
  expect(controlKind(change({ paths: ["DEPS"], comments: 3 }))).toBeNull();
  // Without the files, a person's quiet change is undecided.
  expect(controlKind(change({ paths: null }))).toBeNull();
});

test("a revert control is the reverted original; the revert itself is at most mechanical", () => {
  expect(controlKind(change({ reverted: true, comments: 4 }))).toBe("revert");
  expect(controlKind(change({ reverted: true, comments: 5 }))).toBeNull();
  expect(
    controlKind(change({ reverted: true, author: "dependabot[bot]" })),
  ).toBeNull();
  // A reverted revert is a re-land, not a revert control.
  expect(
    controlKind(change({ reverted: true, title: 'Revert "Let asserts show"' })),
  ).toBeNull();
  expect(
    controlKind(change({ title: 'Revert "Fix the sort order"' })),
  ).toBeNull();
  expect(
    controlKind(change({ title: 'Revert "Roll DEPS"', paths: ["DEPS"] })),
  ).toBe("mechanical");
  expect(
    revertedPull(
      "Reverts react/react#30548\n\nbecause it broke",
      "react/react",
    ),
  ).toBe(30548);
  expect(revertedPull("Reverts #12", "react/react")).toBe(12);
  expect(revertedPull("No revert here #12", "react/react")).toBeNull();
  // Another repository's pull request, or prose: no revert link.
  expect(
    revertedPull("Reverts facebook/other#30548", "react/react"),
  ).toBeNull();
  expect(revertedPull("This PR reverts #5 and more", "react/react")).toBeNull();
  expect(gerritMessageSays("Patch Set 3: Code-Review+1")).toBe(false);
  expect(gerritMessageSays("Patch Set 2: Commit-Queue+2\n\n(1 comment)")).toBe(
    false,
  );
  expect(
    gerritMessageSays(
      "Patch Set 2: Code-Review+1\n\nWhy not reuse the helper?",
    ),
  ).toBe(true);
  expect(
    revertedCommit(
      "This reverts commit 4cc0e4b12b7fcfbe2904a7486df5905715eb8d65.",
    ),
  ).toBe("4cc0e4b12b7fcfbe2904a7486df5905715eb8d65");
});

test("abandoned changes, sizes and bots", () => {
  expect(
    controlKind(
      change({ merged: false, abandoned: true, comments: 9, paths: null }),
    ),
  ).toBe("abandoned");
  expect(
    controlKind(change({ merged: false, abandoned: true, author: "renovate" })),
  ).toBeNull();
  // A tiny roll or lockfile bump is still mechanical; nothing else below the floor counts.
  expect(controlKind(change({ lines: 2, paths: ["DEPS"] }))).toBe("mechanical");
  expect(
    controlKind(
      change({ lines: 2, author: "devtools-ci-autoroll", paths: null }),
    ),
  ).toBe("mechanical");
  for (const kind of [
    {},
    { reverted: true },
    { abandoned: true, merged: false },
  ])
    expect(controlKind(change({ ...kind, lines: 5 }))).toBeNull();
  // A roll of third_party code by a person: ambiguous, no control.
  expect(
    controlKind(
      change({
        paths: [
          "third_party/blink/public/devtools_protocol/browser_protocol.pdl",
        ],
      }),
    ),
  ).toBeNull();
  for (const over of [{ lines: 4000 }, { files: 80 }])
    for (const kind of [
      {},
      { reverted: true },
      { paths: ["DEPS"] },
      { abandoned: true, merged: false },
    ])
      expect(controlKind(change({ ...kind, ...over }))).toBeNull();
  expect(controlKind(change({ author: "dependabot[bot]" }))).toBe("mechanical");
});
