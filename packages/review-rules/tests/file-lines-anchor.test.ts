import { expect, test } from "bun:test";
import {
  type FileLinesAnchor,
  fileLines,
  fileLinesSection,
  matchesFileLines,
  placeFileLinesAnchor,
  plainText,
} from "../src/file-lines-anchor.ts";

// Why: the channel keeps comments on a plan and re-anchors them on every new
// version with this rule. These cases are the rule's specification, which the
// channel's implementer builds on: a comment stays only where its lines' text
// occurs exactly once, changes when its words are gone, and is ambiguous
// otherwise, never shown as unchanged by mistake.

const plan = [
  "# Retry failed exports",
  "",
  "## Goal",
  "A failed export is retried on its own, **up to three times**,",
  "and the person sees why it failed.",
  "",
  "## Out of scope",
  "- Exports that failed before this change",
].join("\n");

const hash = (letter: string) => letter.repeat(64);

function commentOn(
  text: string,
  first: number,
  last: number,
  quote: string,
): FileLinesAnchor {
  const lines = fileLines(text).slice(first - 1, last);
  expect(matchesFileLines(text, lines, quote)).toBe(true);
  return {
    hash: hash("a"),
    lines,
    quote,
    section: fileLinesSection(text, first),
  };
}

const goal = commentOn(plan, 4, 5, "up to three times, and the person");

test("a comment on an unchanged passage stays on its lines", () => {
  const edited = plan.replace("- Exports that failed", "- Exports that broke");
  expect(goal.section).toBe("Goal");
  expect(
    placeFileLinesAnchor(goal, plan, { hash: hash("b"), text: edited }),
  ).toEqual({
    kind: "stays",
    hash: hash("b"),
    lines: goal.lines,
  });
});

test("text inserted or removed above a comment moves its lines and keeps it", () => {
  const inserted = plan.replace(
    "## Goal",
    "## Context\nNightly batch.\n\n## Goal",
  );
  expect(
    placeFileLinesAnchor(goal, plan, { hash: hash("b"), text: inserted }),
  ).toEqual({
    kind: "stays",
    hash: hash("b"),
    lines: goal.lines.map((line) => ({ ...line, line: line.line + 3 })),
  });
  const removed = plan.replace("# Retry failed exports\n\n", "");
  expect(
    placeFileLinesAnchor(goal, plan, { hash: hash("c"), text: removed }),
  ).toEqual({
    kind: "stays",
    hash: hash("c"),
    lines: goal.lines.map((line) => ({ ...line, line: line.line - 2 })),
  });
});

test("an edited passage whose quote is gone shows what was removed and what replaced it", () => {
  const rewritten = plan
    .replace("**up to three times**,", "**up to five times**,")
    .replace(
      "and the person sees why it failed.",
      "and the export row shows the last reason.",
    );
  expect(
    placeFileLinesAnchor(goal, plan, { hash: hash("b"), text: rewritten }),
  ).toEqual({
    kind: "changed",
    hash: hash("b"),
    removed: goal.lines,
    added: [
      {
        line: 4,
        text: "A failed export is retried on its own, **up to five times**,",
      },
      { line: 5, text: "and the export row shows the last reason." },
    ],
  });
});

test("a removed passage shows only what was removed", () => {
  const scope = commentOn(plan, 8, 8, "Exports that failed before");
  const cut = plan.replace("\n- Exports that failed before this change", "");
  expect(
    placeFileLinesAnchor(scope, plan, { hash: hash("b"), text: cut }),
  ).toEqual({
    kind: "changed",
    hash: hash("b"),
    removed: scope.lines,
    added: [],
  });
});

test("a quote that survives in lines that no longer match is ambiguous", () => {
  const split = plan.replace(
    "and the person sees why it failed.",
    "and the person sees why it failed, on the export row.",
  );
  expect(
    placeFileLinesAnchor(goal, plan, { hash: hash("b"), text: split }),
  ).toEqual({
    kind: "ambiguous",
    hash: hash("b"),
    section: "Goal",
  });
});

test("a copy of the passage added elsewhere does not move the comment", () => {
  const twice = `${plan}\n\n## Done when\n${goal.lines.map((line) => line.text).join("\n")}`;
  expect(
    placeFileLinesAnchor(goal, plan, { hash: hash("b"), text: twice }),
  ).toEqual({
    kind: "stays",
    hash: hash("b"),
    lines: goal.lines,
  });
});

const steps = [
  "# Ship",
  "",
  "## Backend",
  "- Run the tests.",
  "",
  "## Frontend",
  "- Run the tests.",
].join("\n");

test("a comment on the deleted copy of a repeated line does not move to the other copy", () => {
  const frontend = commentOn(steps, 7, 7, "Run the tests");
  const without = [
    "# Ship",
    "",
    "## Backend",
    "- Run the tests.",
    "",
    "## Frontend",
  ].join("\n");
  expect(
    placeFileLinesAnchor(frontend, steps, { hash: hash("b"), text: without }),
  ).toEqual({
    kind: "changed",
    hash: hash("b"),
    removed: frontend.lines,
    added: [],
  });
});

test("a comment on the kept copy of a repeated line stays when the other copy is deleted", () => {
  const frontend = commentOn(steps, 7, 7, "Run the tests");
  const without = [
    "# Ship",
    "",
    "## Backend",
    "",
    "## Frontend",
    "- Run the tests.",
  ].join("\n");
  expect(
    placeFileLinesAnchor(frontend, steps, { hash: hash("b"), text: without }),
  ).toEqual({
    kind: "stays",
    hash: hash("b"),
    lines: [{ line: 6, text: "- Run the tests." }],
  });
});

test("a deleted passage with a short quote found elsewhere in the plan is changed", () => {
  const short = commentOn(plan, 8, 8, "e");
  const cut = plan.replace("\n- Exports that failed before this change", "");
  expect(
    placeFileLinesAnchor(short, plan, { hash: hash("b"), text: cut }).kind,
  ).toBe("changed");
});

test("the version a comment was made on keeps it in place", () => {
  expect(
    placeFileLinesAnchor(goal, plan, { hash: goal.hash, text: plan }).kind,
  ).toBe("stays");
});

// The normalisation below is this lane's rule, not the design's: a selection
// is rendered text, so Markdown marks are left out and whitespace runs count
// as one space on both sides before a quote is compared with lines.

test("a quote as the screen shows it matches the file's marked-up lines", () => {
  expect(
    plainText("- [x] Retry **with `backoff`** in the [worker](https://x.test)"),
  ).toBe("Retry with backoff in the worker");
  expect(plainText("> ## Goal")).toBe("Goal");
  const lines = fileLines(plan).slice(3, 5);
  expect(
    matchesFileLines(plan, lines, "up to three times,\n  and the person"),
  ).toBe(true);
});

test("normalisation never joins words or removes marks inside them", () => {
  const lines = fileLines(plan).slice(3, 5);
  expect(matchesFileLines(plan, lines, "up to threetimes")).toBe(false);
  const code = "Rename `snake_case` fields, re-try once";
  expect(plainText(code)).toBe("Rename snake_case fields, re-try once");
  expect(matchesFileLines(code, fileLines(code), "snakecase")).toBe(false);
  expect(matchesFileLines(code, fileLines(code), "retry once")).toBe(false);
});

test("lines must be consecutive, with their exact text, and hold the quote", () => {
  const file = fileLines(plan);
  expect(matchesFileLines(plan, [file[3]!, file[5]!], "up to")).toBe(false);
  expect(
    matchesFileLines(plan, [{ line: 4, text: "A failed export" }], "failed"),
  ).toBe(false);
  expect(matchesFileLines(plan, [file[3]!], "the person")).toBe(false);
  expect(matchesFileLines(plan, [file[3]!], "**")).toBe(false);
});
