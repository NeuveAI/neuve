// Why: the sheet's neutral briefings (FT13, 9.38) are written by a model session that must never
// propose an answer and never see the reveal. Three boundaries carry that and are tested here: the
// guard (the only thing standing between a session's text and the owner's sheet), isolation (what
// the item directory holds is all a session can read besides the range's trees, so the reveal, the
// gold grade and the harness's reference summary must not reach it), and idempotence (a rerun or a
// sheet rebuild must neither spend a session on a briefed item nor discard its briefing). No model
// is called.
import { expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyBriefing,
  checkSheetBriefing,
  flattenSymlinks,
  pendingIds,
  questionOf,
  stripForbidden,
  writeItemDir,
} from "../src/harness-compare/full-test/briefings.ts";
import {
  carryBriefings,
  marginSheetItem,
  SheetFile,
  type SheetItem,
  unitSheetItem,
} from "../src/harness-compare/full-test/sheet.ts";

const SENTINEL = "SENTINEL-REVEAL";

const neutral = (extra = "") =>
  [
    "The owned lines add a reset script at .ralph/scripts/ralph-reset.sh:1-77, which rewrites progress.txt",
    "and, with --full, follows the active target through readlink before touching completion state.",
    "The caller is the README's usage block at README.md:40, and no test covers the script.",
    "Lines 30-44 choose between jq and a sed fallback; the sed path edits JSON with a pattern.",
    "Questions worth thinking about: what happens when readlink resolves to a path outside the",
    "project? Does the confirmation prompt at .ralph/scripts/ralph-reset.sh:12 cover the --full",
    "branch as well? Would the sed fallback behave the same as jq on nested keys, and how could a",
    "reviewer check that without running the script on real data? Does the commit text's claim",
    "that progress is reset match what lines 50-60 write? Which files does the script leave in place",
    `and is that what the title describes? ${extra}`,
  ].join(" ");

test("the guard refuses answer words and recommending wording, and keeps a neutral briefing", () => {
  expect(checkSheetBriefing(`  ${neutral()}  `)).toBe(neutral().trim());
  const refusals: ReadonlyArray<readonly [string, RegExp]> = [
    ["This is agentic work.", /lane word "agentic"/],
    ["It reads as Human-Required.", /lane word "human-required"/],
    ["Routing it to static automation", /lane word "static automation"/],
    ["It has low complexity.", /axis level word "low complexity"/],
    ["The lines are hard to validate.", /axis level word "hard to validate"/],
    ["Easy to verify from the test.", /axis level word "easy to verify"/],
    ["The approval gate", /verdict word "approval"/],
    ["Reviewers may request changes", /verdict word "request changes"/],
    ["These lines are useful context.", /grade word "useful"/],
    ["The relevant caller", /grade word "relevant"/],
    ["A misleading name", /grade word "misleading"/],
    ["Necessary for the reviewer.", /grade word "necessary"/],
    ["I recommend reading the test.", /recommends an answer \("recommend"\)/],
    ["The change looks good.", /recommends an answer \("looks good"\)/],
    ["This should be merged.", /recommends an answer \("should be merged"\)/],
    ["There are no concerns here.", /recommends an answer \("no concerns"\)/],
    ["A bug in the fallback.", /recommends an answer \("bug"\)/],
    ["A trivial rename.", /recommends an answer \("trivial"\)/],
    ["Low-risk edit.", /recommends an answer \("low-risk"\)/],
    ["The region has no bearing on it.", /recommends an answer/],
    // Who should look at it points at a lane; leaning on the cited lines states a grade.
    [
      "Who on the team can judge both parts?",
      /recommends an answer \("who on the team can judge"\)/,
    ],
    [
      "Who knows enough about Nitro bundling?",
      /recommends an answer \("who knows"\)/,
    ],
    [
      "The unit relies on these lines.",
      /recommends an answer \("relies on these lines"\)/,
    ],
    ["It depends only on the cited code.", /recommends an answer/],
    [
      "These look like the only evidence for it.",
      /recommends an answer \("only evidence"\)/,
    ],
    ["This needs a human.", /recommends an answer \("needs a human"\)/],
    [
      "The check can be automated.",
      /recommends an answer \("can be automated"\)/,
    ],
    ["A complex merge.", /recommends an answer \("complex"\)/],
    ["A simple guard.", /recommends an answer \("simple"\)/],
    // Typographic hyphens and zero-width characters do not hide a lane name.
    ["It reads as human\u2011required.", /lane word "human-required"/],
    ["It reads as human\u2010suggested.", /lane word "human-suggested"/],
    ["Static\u00A0automation", /lane word "static automation"/],
    ["agen\u200Btic", /lane word "agentic"/],
  ];
  for (const [phrase, reason] of refusals)
    expect(() => checkSheetBriefing(neutral(phrase))).toThrow(reason);
  // Whole words only: "debug", "upgrade" and "approximately" are not answer words.
  expect(() =>
    checkSheetBriefing(
      neutral("The debug flag, the upgrade step, approximately."),
    ),
  ).not.toThrow();
  expect(() => checkSheetBriefing("Too short at README.md:1.")).toThrow(
    /words, outside/,
  );
  expect(() =>
    checkSheetBriefing(
      neutral().replace(/[\w./-]+\.(sh|md):\d+(-\d+)?/g, "it"),
    ),
  ).toThrow(/cites no file and line/);
});

const unitItem = (id: string): SheetItem =>
  unitSheetItem(
    id,
    "h9",
    {
      caseId: "neuve_effect:aaaa..bbbb",
      batchId: "b1",
      unit: {
        unitId: "01UNIT",
        recorded: {
          payload: {
            title: "Reset development progress",
            ownedRanges: [
              {
                kind: "lines",
                path: ".ralph/scripts/ralph-reset.sh",
                side: "new",
                startLine: 1,
                endLine: 77,
              },
            ],
          },
        },
        assessment: {
          payload: {
            lane: "human-required",
            quadrant: "high-hard",
            complexity: { level: "high" },
            easeOfValidation: { level: "hard" },
            gaps: [{ axis: "validation", kind: SENTINEL }],
            rationale: `${SENTINEL} rationale`,
          },
        } as never,
        content: { facts: { text: "Adds a reset command.", cites: [] } },
        references: [],
        comments: [
          {
            id: "c1",
            payload: {
              body: `${SENTINEL} finding body`,
              finding: { kind: "defect", about: "code", evidence: [] },
            },
          },
        ],
        disposition: {
          id: "d1",
          payload: { verdict: "request-changes", restsOn: [], proof: [] },
        },
      },
    },
    ["uncited-request"],
  );

// The sheet's own builder, so the fixture carries the harness's summary and the gold where the
// sheet puts them (the reveal); the ID is overridden to exercise repeated IDs.
const marginItem = (id: string, unitId: string): SheetItem => ({
  ...marginSheetItem({
    caseId: "neuve_effect:aaaa..bbbb",
    unitId,
    referenceId: "01REF",
    unitTitle: "Publish the failure",
    unitFacts: "The fail tool publishes AgentCompleted.",
    summary: `b2.r37 (necessary): ${SENTINEL} the harness's own reference summary`,
    region: { path: "apps/x/cors.ts", startLine: 254, endLine: 287 },
    goldGrade: `${SENTINEL}-gold`,
    hunkId: "h-1",
    hunk: {
      path: "apps/x/agent.ts",
      old: { start: 10, lines: 2 },
      new: { start: 10, lines: 9 },
    },
  }),
  id,
});

const range = {
  id: "neuve_effect:aaaa..bbbb",
  repository: "neuve_effect",
  base: "a".repeat(40),
  head: "b".repeat(40),
  subjects: ["feat: add the reset script"],
  hunks: [
    {
      id: "h-1",
      path: "apps/x/agent.ts",
      oldPath: "apps/x/agent.ts",
      old: { start: 10, lines: 2 },
      new: { start: 10, lines: 9 },
    },
  ],
};

test("an item directory holds only the question side: no reveal, gold grade, summary or answer", () => {
  const unit = unitItem("C-unit");
  const card = marginItem("M-card", "01UNIT");
  if (unit.kind !== "unit" || card.kind !== "margin-card")
    throw new Error("fixture kinds");
  // The fixture's reveal does carry the sentinel, so its absence below is meaningful.
  expect(JSON.stringify(unit.reveal)).toContain(SENTINEL);
  expect(JSON.stringify(card.reveal)).toContain(SENTINEL);
  const cases = [
    {
      question: questionOf(unit, range),
      expected: [
        "Reset development progress",
        ".ralph/scripts/ralph-reset.sh (new) 1-77",
        "Adds a reset command.",
      ],
    },
    {
      question: questionOf(card, range, { side: "head" }),
      expected: [
        "apps/x/cors.ts 254-287 (head)",
        "apps/x/agent.ts: old lines 10-11, new lines 10-18",
        "The fail tool publishes AgentCompleted.",
      ],
    },
  ];
  for (const { question, expected } of cases) {
    const dir = mkdtempSync(join(tmpdir(), "ft-brief-test-"));
    try {
      const task = writeItemDir(
        dir,
        question,
        "/scratch/trees/r",
        "diff --git a b\n",
      );
      expect(readdirSync(dir).sort()).toEqual([
        "briefing.schema.json",
        "change.diff",
        "item.md",
      ]);
      const files = readdirSync(dir).map((name) =>
        readFileSync(join(dir, name), "utf8"),
      );
      for (const text of [...files, task]) {
        expect(text).not.toContain(SENTINEL);
        expect(text).not.toContain("request-changes");
        expect(text).not.toContain("high-hard");
        expect(text).not.toContain("b2.r37");
      }
      const md = readFileSync(join(dir, "item.md"), "utf8");
      for (const line of [
        ...expected,
        "feat: add the reset script",
        range.base,
      ])
        expect(md).toContain(line);
      expect(task).toContain("/scratch/trees/r/base");
      expect(task).toContain("/scratch/trees/r/head");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("an extracted tree keeps no symlink a file tool could follow out of it, and no gold, label or benchmark file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ft-brief-tree-"));
  try {
    const tree = join(dir, "head");
    mkdirSync(join(tree, "src"), { recursive: true });
    writeFileSync(join(tree, "src", "a.ts"), "export {};\n");
    symlinkSync("/Users", join(tree, "outside"));
    symlinkSync("missing/target", join(tree, "src", "dangling"));
    symlinkSync("a.ts", join(tree, "src", "inside"));
    expect(flattenSymlinks(tree)).toBe(3);
    // Gold, labels and benchmark files never stay in a tree.
    for (const path of [
      "validation/benchmarks/m4/gold.json",
      "validation/review-quality/gold.jsonl",
      "validation/review-quality-context/gold-pending.jsonl",
      "validation/x/labels/a.json",
      "research/pr-bench/benchmarks.json",
      "research/notes/keep.md",
      "validation/evidence/keep.log",
    ]) {
      mkdirSync(join(tree, path, ".."), { recursive: true });
      writeFileSync(join(tree, path), "x");
    }
    expect(stripForbidden(tree)).toEqual([
      "research/pr-bench/benchmarks.json",
      "validation/benchmarks",
      "validation/review-quality-context/gold-pending.jsonl",
      "validation/review-quality/gold.jsonl",
      "validation/x/labels",
    ]);
    expect(readFileSync(join(tree, "research/notes/keep.md"), "utf8")).toBe(
      "x",
    );
    expect(
      readFileSync(join(tree, "validation/evidence/keep.log"), "utf8"),
    ).toBe("x");
    for (const path of ["outside", "src/dangling", "src/inside"]) {
      expect(lstatSync(join(tree, path)).isFile()).toBe(true);
    }
    expect(readFileSync(join(tree, "outside"), "utf8")).toBe(
      "(symbolic link to /Users)\n",
    );
    expect(readFileSync(join(tree, "src", "a.ts"), "utf8")).toBe(
      "export {};\n",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("briefed items are skipped unless forced, a repeated ID is briefed once, and a rebuild keeps briefings", () => {
  const timedOut: SheetItem = {
    id: "T-1",
    kind: "timed-out-run",
    caseId: "c",
    question: { published: "nothing", disclosed: [] },
    briefing: { text: null, by: null },
    reveal: null,
    answer: { judged: { label: "x", options: [], value: null }, note: null },
  };
  const sheet = SheetFile.parse({
    schemaVersion: 1,
    seed: "s",
    builtAt: "t",
    cut: [],
    marginPool: { candidates: 0, judged: 0, unjudged: 0 },
    items: [
      unitItem("C-1"),
      timedOut,
      marginItem("M-dup", "01A"),
      marginItem("M-dup", "01B"),
    ],
  });
  expect(pendingIds(sheet)).toEqual(["C-1", "M-dup"]);
  const briefed = applyBriefing(sheet, "M-dup", { text: "t", by: "b" });
  expect(
    briefed.items.filter((i) => i.id === "M-dup").map((i) => i.briefing.text),
  ).toEqual(["t", "t"]);
  expect(pendingIds(briefed)).toEqual(["C-1"]);
  expect(pendingIds(briefed, ["M-dup"])).toEqual(["C-1", "M-dup"]);
  expect(() => pendingIds(briefed, ["X-none"])).toThrow(/no such item/);
  expect(() => pendingIds(briefed, ["T-1"])).toThrow(/takes no briefing/);
  // A rebuild starts every slot empty; unchanged questions get their briefing back.
  const rebuilt = carryBriefings(briefed.items, sheet);
  expect(pendingIds(rebuilt)).toEqual(["C-1"]);
  const changed = SheetFile.parse({
    ...sheet,
    items: sheet.items.map((item) =>
      item.kind === "margin-card"
        ? { ...item, question: { ...item.question, region: "other 1-2" } }
        : item,
    ),
  });
  expect(pendingIds(carryBriefings(briefed.items, changed))).toEqual([
    "C-1",
    "M-dup",
  ]);
});
