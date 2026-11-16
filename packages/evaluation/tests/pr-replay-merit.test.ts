// Why: Neuve's volume means nothing until its unmatched items are judged on their merits (10.134).
// The reviewers must judge only items no reviewer concern was paired with, see the code at the
// first revision with its language and framework named, and nothing that says who raised an item or
// that a tool did; two passes, a third on their ties, the majority deciding (10.135); and the split
// must account for every item: matched + legitimate + minor + noise + unjudged.
import { afterAll, afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { BlindItem } from "../src/pr-replay/matching.ts";
import type { CaseRecord } from "../src/pr-replay/schema.ts";

const root = mkdtempSync(join(tmpdir(), "replay-merit-"));
const environment = { ...process.env };
afterAll(() => {
  process.env = environment;
  rmSync(root, { recursive: true, force: true });
});
process.env["NEUVE_RESEARCH_ROOT"] = root;
process.env["NEUVE_LABEL_RUNNER"] = "cloud";
const {
  DISABLED_FEATURES,
  PINNED_CODEX_VERSION,
  PINNED_LINUX_INSTALL_HASH,
  SAFE_ENABLED_FEATURES,
  pinCatalog,
  setCloudCaller,
} = await import("../src/pr-replay/codex.ts");
const {
  MERIT_REVISION,
  bandsOf,
  decideMerit,
  decoyCatch,
  judgeMerit,
  meritChunks,
  meritPrompt,
  meritSplit,
  unitsOf,
  reanchored,
  regradeMerit,
  unmatchedItems,
} = await import("../src/pr-replay/merit.ts");
afterEach(() => setCloudCaller(undefined));

const git = (cwd: string, args: ReadonlyArray<string>) => {
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
    },
  });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  return child.stdout.toString().trim();
};

// A mirror with the case's first revision: main.go gains a function.
const work = join(root, "work");
git(root, ["init", "-q", "-b", "main", work]);
writeFileSync(join(work, "main.go"), "package main\n");
// A file the change deletes: its lines exist only in the base.
writeFileSync(
  join(work, "gone.go"),
  Array.from({ length: 10 }, (_, at) => `// gone ${at + 1}`).join("\n") + "\n",
);
git(work, ["add", "."]);
git(work, ["commit", "-q", "-m", "base"]);
const base = git(work, ["rev-parse", "HEAD"]);
writeFileSync(
  join(work, "main.go"),
  "package main\n\nfunc run() error {\n\tf, _ := open()\n\treturn f.Close()\n}\n",
);
writeFileSync(join(work, "other.go"), "package main\n\nvar x = 1\n");
// A long file: 1,500 lines, each naming itself, for the never-clipped guarantee.
writeFileSync(
  join(work, "big.go"),
  Array.from(
    { length: 1_500 },
    (_, at) => `// line ${at + 1} ${"padding ".repeat(6)}`,
  ).join("\n") + "\n",
);
git(work, ["add", "other.go", "big.go"]);
git(work, ["rm", "-q", "gone.go"]);
git(work, ["commit", "-q", "-am", "head"]);
const head = git(work, ["rev-parse", "HEAD"]);
git(root, [
  "clone",
  "-q",
  "--bare",
  work,
  join(root, "mirrors", "entireio__cli.git"),
]);

// The cloud labeller, faked as the cloud tests fake it.
const home = join(root, "codex-home");
mkdirSync(home);
writeFileSync(
  join(home, "models_cache.json"),
  JSON.stringify({
    models: [
      {
        slug: "gpt-6.1-sol",
        tool_mode: "code_mode_only",
        experimental_supported_tools: ["send_user_message_async", "clock"],
        upgrade: null,
        shell_type: "unified_exec",
        apply_patch_tool_type: "freeform",
        supports_search_tool: true,
        node_repl_disabled: false,
        multi_agent_version: "v2",
        web_search_tool_type: "text_and_image",
      },
    ],
  }),
);
pinCatalog(home);
const facts = {
  installHash: PINNED_LINUX_INSTALL_HASH,
  modelsCache: null,
  modelsCacheSha256: null,
  homeFiles: ["auth.json"],
};
const probeAnswer = {
  version: `${PINNED_CODEX_VERSION}\n`,
  features: [
    ...DISABLED_FEATURES.map((name) => `${name}  stable  false`),
    ...[...SAFE_ENABLED_FEATURES].map((name) => `${name}  stable  true`),
  ].join("\n"),
  configSources: [],
  created: [],
  ...facts,
};
const done = {
  stdout: '{"type":"turn.completed"}\n',
  stderr: "",
  code: 0,
  timedOut: false,
  wallSeconds: 1,
  after: facts,
  created: [],
};

const record = {
  caseId: "github:entireio/cli:9",
  source: "entire-cli",
  number: 9,
  firstRevision: { base, head, at: "2026-01-01T00:00:00Z" },
} as unknown as CaseRecord;

const item = (
  id: string,
  source: "neuve" | "reviewer",
  group: BlindItem["group"],
  line: number,
): BlindItem => ({
  id,
  source,
  group,
  ref: source === "neuve" ? `unit-7#${group}-${id}` : `thread-${id}`,
  repeats: [],
  path: "main.go",
  line,
  anchoredTo: "line",
  text: `TEXT ${id}`,
});

const items = [
  item("n1", "neuve", "comment", 4),
  item("n2", "neuve", "checkpoint", 4),
  item("n3", "neuve", "consider", 5),
  item("n4", "neuve", "gap", 3),
  item("r1", "reviewer", "reviewer", 4),
];

// The review's packet: one unit owning main.go's new function, lines 3-6.
const packet = {
  batches: [
    {
      batchId: "b1",
      units: [
        {
          unitId: "unit-7",
          local: "unit-7",
          recorded: {
            payload: {
              ownedRanges: [
                {
                  kind: "lines",
                  path: "main.go",
                  side: "new",
                  startLine: 3,
                  endLine: 6,
                },
              ],
            },
          },
          comments: [],
        },
      ],
    },
  ],
};
const caseDir = join(root, "cases", "entire-cli", "9");
mkdirSync(join(caseDir, "run"), { recursive: true });
writeFileSync(
  join(caseDir, "run", "show.json"),
  JSON.stringify({ runId: "r", packet }),
);
const { ranges, unitOf } = unitsOf(packet as never);
const meritItem = (blind: BlindItem) => ({
  id: blind.id,
  group: blind.group,
  ref: blind.ref,
  path: blind.path,
  line: blind.line,
  side: "new" as const,
  text: blind.text,
  unit: unitOf(blind.ref),
  decoy: false,
});

test("only items no reviewer concern was paired with are judged; a pair of two of Neuve's is no match", () => {
  const { matched, unmatched } = unmatchedItems(items, ["n1|r1", "n2|n3"]);
  expect(matched.map((one) => one.id)).toEqual(["n1"]);
  expect(unmatched.map((one) => one.id)).toEqual(["n2", "n3", "n4"]);
});

test("each item is shown with its unit's code, by a neutral kind, and nothing of who raised it", () => {
  const shown = items.slice(1, 4).map(meritItem);
  expect(shown.every((one) => one.unit === "unit-7")).toBe(true);
  const prompt = meritPrompt(record, shown, ranges, "e".repeat(32));
  expect(prompt).toContain("Go command-line tool");
  // Each item's own line first, then the rest of the unit, with no line shown twice.
  expect(prompt).toContain("main.go, around lines 3, 4, 5");
  expect(prompt.match(/  1 \| package main/g)).toHaveLength(1);
  expect(prompt).toContain('"path": "main.go"');
  // The whole unit: its hunk, and the file around its owned lines, not one line's window.
  expect(prompt).toContain("+func run() error {");
  expect(prompt).toContain("  1 | package main");
  expect(prompt).toContain("  6 | }");
  // One block for the unit, however many items stand on it.
  expect(prompt.match(/<<<DATA e+ CODE /g)).toHaveLength(1);
  // Kinds by neutral names; the owner's question for requirements, questions and evidence gaps.
  for (const kind of [
    '"kind": "requirement"',
    '"kind": "question"',
    '"kind": "evidence-gap"',
  ])
    expect(prompt).toContain(kind);
  expect(prompt).toContain("would raise this point about this change, here");
  expect(prompt).toContain("outsideContext");
  // No source, no tool, no unit reference.
  expect(prompt.toLowerCase()).not.toContain("neuve");
  expect(prompt).not.toContain("unit-7");
  expect(prompt).not.toContain("checkpoint");
});

type Verdict =
  | "real-defect"
  | "code-quality"
  | "nit-pick"
  | "minor"
  | "not-applicable"
  | "wrong"
  | "unsure";
const verdict = (id: string, value: Verdict, outsideContext = false) => ({
  id,
  verdict: value,
  reason: `${value} because`,
  practice: null,
  outsideContext,
});

test("decoys are written apart, mixed in blind, kept out of the split, and their catch reported", async () => {
  const labels = join(caseDir, "labels");
  mkdirSync(labels, { recursive: true });
  writeFileSync(join(labels, "matching-key.json"), JSON.stringify({ items }));
  writeFileSync(
    join(labels, "matching.json"),
    JSON.stringify({ pairs: ["n1|r1"] }),
  );
  // Texts and reasons a reviewer must never see the source of: no "decoy" anywhere, a distinctive reason.
  const decoys = {
    decoys: [
      {
        code: "code-1",
        path: "main.go",
        line: 4,
        kind: "comment",
        text: "ALPHA-ONE sounds right",
        grade: "wrong",
        shape: "n/a",
        why: "HIDDEN-REASON-1",
      },
      {
        code: "code-1",
        path: "main.go",
        line: 5,
        kind: "requirement",
        text: "**high** ALPHA-TWO check <b>it</b>",
        grade: "wrong",
        shape: "n/a",
        why: "HIDDEN-REASON-2",
      },
      {
        code: "code-1",
        path: "main.go",
        line: 3,
        kind: "evidence-gap",
        text: "ALPHA-THREE no test run",
        grade: "wrong",
        shape: "n/a",
        why: "HIDDEN-REASON-3",
      },
      // Outside the unit's owned lines (3-6): dropped, a tell otherwise.
      {
        code: "code-1",
        path: "main.go",
        line: 1,
        kind: "question",
        text: "ALPHA-FOUR off the unit",
        grade: "wrong",
        shape: "n/a",
        why: "HIDDEN-REASON-4",
      },
      // True but trivial: it should come back minor, and best practice is the miss.
      {
        code: "code-1",
        path: "main.go",
        line: 5,
        kind: "comment",
        grade: "minor",
        shape: "cosmetic",
        text: "BETA-ONE rename for taste",
        why: "HIDDEN-REASON-5",
      },
      // A check of low consequence, the shape most of Neuve's items take.
      {
        code: "code-1",
        path: "main.go",
        line: 4,
        kind: "question",
        grade: "minor",
        shape: "check",
        text: "BETA-TWO confirm the shown value",
        why: "HIDDEN-REASON-6",
      },
      // A defensible preference: it should come back a nit-pick, and code quality is the miss.
      {
        code: "code-1",
        path: "main.go",
        line: 5,
        kind: "requirement",
        grade: "nit-pick",
        shape: "n/a",
        text: "GAMMA-ONE prefer a shorter name",
        why: "HIDDEN-REASON-7",
      },
    ],
  };
  // Every real item and decoy gets the same verdict from a pass, by its text.
  const answer =
    (decoyVerdict: Verdict, realVerdict: Verdict, outside = false) =>
    (prompt: string) => ({
      items: [
        ...prompt.matchAll(
          /"id": "([^"]+)",\n  "kind": "[^"]+",\n  "code": "[^"]+",\n  "path": "[^"]+",\n  "side": "[^"]+",\n  "line": \d+,\n  "text": "([^"]+)"/g,
        ),
      ].map(([, id, text]) =>
        verdict(
          id!,
          text!.startsWith("ALPHA") ? decoyVerdict : realVerdict,
          outside && text === "TEXT n4",
        ),
      ),
    });
  const calls: Array<(prompt: string) => unknown> = [
    () => decoys,
    answer("wrong", "code-quality", true),
    answer("not-applicable", "code-quality", true),
    // The first two split on the decoys (wrong against not-applicable): the third breaks it.
    answer("wrong", "code-quality", true),
  ];
  const prompts: Array<string> = [];
  setCloudCaller(async (request) => {
    if (request["command"] === "probe") return probeAnswer;
    const prompt = String(request["prompt"]);
    prompts.push(prompt);
    return { ...done, output: JSON.stringify(calls.shift()!(prompt)) };
  });
  const result = await judgeMerit(record);
  if (result.incomplete) throw new Error("incomplete");
  // The decoy writer saw the code and some items' text for style, nothing of any verdict.
  expect(prompts[0]).toContain("STYLE");
  expect(prompts[0]).toContain("TEXT n2");
  expect(prompts[0]).not.toContain("code-quality");
  // It is told the lines a decoy is kept on, the unit's owned lines, not the code shown around them.
  expect(prompts[0]).toContain("DECOY LINES\nmain.go: lines 3-6\n");
  expect(prompts[0]).toContain('2 of grade "minor"');
  expect(prompts[0]).toContain('1 of grade "nit-pick"');
  expect(prompts[0]).toContain('of shape "check"');
  // The reviewers saw the decoys among the real items, by the same kinds, and nothing that tells them
  // apart: no reason, no "decoy" anywhere, no reference field, ids in the real items' format.
  for (const text of [
    "ALPHA-ONE",
    "ALPHA-TWO",
    "ALPHA-THREE",
    "BETA-ONE",
    "BETA-TWO",
    "GAMMA-ONE",
    "TEXT n2",
  ])
    expect(prompts[1]).toContain(text);
  expect(prompts[1]).not.toContain("ALPHA-FOUR");
  for (const prompt of prompts.slice(1)) {
    expect(prompt).not.toContain("HIDDEN-REASON");
    expect(prompt.toLowerCase()).not.toContain("decoy");
    expect(prompt).not.toContain('"ref"');
    expect(prompt).not.toContain("why");
    expect(prompt).not.toContain('"grade"');
    expect(prompt).not.toContain('"shape"');
  }
  const kept = JSON.parse(readFileSync(join(labels, "merit.json"), "utf8")) as {
    decoys: Array<{ id: string }>;
    items: Array<{ id: string; decoy: boolean }>;
  };
  expect(kept.decoys).toHaveLength(6);
  expect(
    (
      kept.decoys as unknown as Array<{
        text: string;
        grade: string;
        whyNit?: string;
      }>
    ).find((one) => one.text.startsWith("GAMMA")),
  ).toMatchObject({ grade: "nit-pick", whyNit: "HIDDEN-REASON-7" });
  // The grade and its reason stay in the key.
  expect(
    (
      kept.decoys as unknown as Array<{
        text: string;
        grade: string;
        whyMinor?: string;
        whyWrong?: string;
      }>
    ).find((one) => one.text.startsWith("BETA")),
  ).toMatchObject({
    grade: "minor",
    shape: "cosmetic",
    whyMinor: "HIDDEN-REASON-5",
  });
  // Decoy text normalised like real items: no emphasis, no markup.
  const two = (
    kept.decoys as unknown as Array<{
      text: string;
      line: number;
      group: string;
    }>
  ).find((one) => one.text.includes("ALPHA-TWO"))!;
  expect(two.text).toBe("ALPHA-TWO check it");
  // A requirement stands on its range's first line (3), as real ones do; it was written on line 5.
  expect(two.line).toBe(3);
  for (const one of kept.items) expect(one.id).toMatch(/^x[0-9a-f]{8}$|^n\d$/);
  for (const one of kept.decoys) expect(one.id).toMatch(/^x[0-9a-f]{8}$/);
  // Mixed in: pass a's order is the id hash's, never real items then decoys.
  const shownIds = [...prompts[1]!.matchAll(/"id": "([^"]+)",\n  "kind"/g)].map(
    (found) => found[1]!,
  );
  const hashed = [...shownIds].sort((x, y) =>
    createHash("sha256")
      .update(x)
      .digest("hex")
      .localeCompare(createHash("sha256").update(y).digest("hex")),
  );
  expect(shownIds).toEqual(hashed);
  // The real items are best practice, outside the split's decoys; all three decoys caught, the
  // third's "wrong" and the first two's split broken to it.
  expect(prompts).toHaveLength(4);
  expect(result).toMatchObject({
    version: 2,
    items: 4,
    matched: 1,
    legitimate: 3,
    codeQuality: 3,
    nitPick: 0,
    noise: 0,
  });
  // The minor and nit decoys came back code quality, as the real items did: the misses that show
  // the scale inflated.
  expect(result.decoyCatch).toMatchObject({
    decoys: 3,
    caught: 3,
    passedAsValid: 0,
    nitGrade: { decoys: 1, caught: 0, codeQuality: 1 },
    minorGrade: {
      decoys: 2,
      caught: 0,
      codeQuality: 2,
      rejected: 0,
      byShape: {
        cosmetic: { decoys: 1, codeQuality: 1 },
        check: { decoys: 1, codeQuality: 1 },
      },
    },
  });
  const parts =
    result.matched +
    result.legitimate +
    result.nitPick +
    result.minor +
    result.noise +
    result.unjudged;
  expect(parts).toBe(result.items);
});

test("a majority of unsure leaves an item unjudged, outside context is counted, and noise is not applicable or wrong", () => {
  const unmatched = [items[1]!, items[2]!].map(meritItem);
  const decided = decideMerit(unmatched, {
    a: {
      items: [
        verdict("n2", "unsure", true),
        { ...verdict("n3", "wrong"), reason: "from a" },
      ],
    },
    b: {
      items: [verdict("n2", "unsure", true), verdict("n3", "not-applicable")],
    },
    c: { items: [verdict("n3", "wrong")] },
  });
  expect(decided[0]).toMatchObject({
    verdict: null,
    unjudged: "unsure",
    outsideContext: true,
  });
  // The reason shown is that of the first pass backing the majority.
  expect(decided[1]).toMatchObject({
    verdict: "wrong",
    reason: "from a",
    brokenByThird: true,
  });
  expect(meritSplit([], decided)).toMatchObject({
    items: 2,
    noise: 1,
    unjudged: 1,
    needsOutsideContext: 1,
  });
  // A decoy counts in the catch, never the split.
  const withDecoy = decideMerit(
    [...unmatched, { ...meritItem(items[3]!), id: "d1", decoy: true }],
    {
      a: { items: [verdict("d1", "wrong")] },
      b: { items: [verdict("d1", "wrong")] },
      c: null,
    },
  );
  expect(meritSplit([], withDecoy).items).toBe(2);
  expect(decoyCatch(withDecoy)).toMatchObject({
    decoys: 1,
    caught: 1,
    passedAsValid: 0,
  });
  // Not applicable is a catch too, not only wrong.
  const notApplicable = decideMerit(
    [{ ...meritItem(items[3]!), id: "d2", decoy: true }],
    {
      a: { items: [verdict("d2", "not-applicable")] },
      b: { items: [verdict("d2", "not-applicable")] },
      c: null,
    },
  );
  expect(decoyCatch(notApplicable)).toMatchObject({ decoys: 1, caught: 1 });
  // A minor decoy is caught when called minor, and counts apart from the wrong ones.
  const minor = decideMerit(
    [
      {
        ...meritItem(items[3]!),
        id: "d3",
        decoy: true,
        grade: "minor",
        shape: "check",
      },
    ],
    {
      a: { items: [verdict("d3", "minor")] },
      b: { items: [verdict("d3", "minor")] },
      c: null,
    },
  );
  expect(decoyCatch(minor)).toMatchObject({
    decoys: 0,
    minorGrade: {
      decoys: 1,
      caught: 1,
      codeQuality: 0,
      byShape: { cosmetic: { decoys: 0 }, check: { decoys: 1, caught: 1 } },
    },
  });
  // A nit decoy is caught when called a nit-pick; a nit-pick is no legitimate find.
  const nit = decideMerit(
    [
      unmatched[0]!,
      {
        ...meritItem(items[3]!),
        id: "d4",
        decoy: true,
        grade: "nit-pick",
      },
    ],
    {
      a: { items: [verdict("n2", "nit-pick"), verdict("d4", "nit-pick")] },
      b: { items: [verdict("n2", "nit-pick"), verdict("d4", "nit-pick")] },
      c: null,
    },
  );
  expect(decoyCatch(nit)).toMatchObject({
    decoys: 0,
    nitGrade: { decoys: 1, caught: 1, codeQuality: 0 },
  });
  expect(meritSplit([], nit)).toMatchObject({
    items: 1,
    legitimate: 0,
    nitPick: 1,
  });
});

test("a failed decoy writer leaves the case to run again; a big case is chunked by unit", async () => {
  const labels = join(caseDir, "labels");
  rmSync(join(labels, "merit-v2"), { recursive: true, force: true });
  rmSync(join(labels, "merit.json"), { force: true });
  // Both draws fail: the writer is drawn once more before the case is left to run again.
  const calls: Array<unknown> = [{ not: "decoys" }, { not: "decoys" }];
  setCloudCaller(async (request) => {
    if (request["command"] === "probe") return probeAnswer;
    return { ...done, output: JSON.stringify(calls.shift()) };
  });
  const first = await judgeMerit(record);
  expect(first).toMatchObject({ incomplete: true, failed: ["decoys"] });
  // Both failed draws are on record, so what the writer cost is not lost.
  expect(
    (first as unknown as { receipts: Array<{ pass: string; attempt: number }> })
      .receipts,
  ).toMatchObject([
    { pass: "decoys", attempt: 1 },
    { pass: "decoys", attempt: 2 },
  ]);
  expect(existsSync(join(labels, "merit.json"))).toBe(false);
  // Two lines outside any unit are two blocks: under a small cap, two chunks; a unit's stay together.
  const loose = [
    {
      ...meritItem(items[1]!),
      id: "p1",
      path: "other.go",
      line: 9,
      unit: null,
    },
    {
      ...meritItem(items[2]!),
      id: "p2",
      path: "other.go",
      line: 1,
      unit: null,
    },
  ];
  expect(
    meritChunks(record, loose, ranges, 10).map((chunk) =>
      chunk.map((one) => one.id),
    ),
  ).toEqual([["p2"], ["p1"]]);
  expect(
    meritChunks(record, items.slice(1, 4).map(meritItem), ranges, 10),
  ).toHaveLength(1);
});

test("an item in a file its unit's ranges do not cover still sees its own line, ahead of the unit's code", () => {
  // The defect this guards against: a question on one file shown under a block of only another.
  const elsewhere = {
    ...meritItem(items[2]!),
    id: "e1",
    path: "other.go",
    line: 3,
  };
  const prompt = meritPrompt(
    record,
    [elsewhere, meritItem(items[1]!)],
    ranges,
    "f".repeat(32),
  );
  expect(prompt).toContain("other.go, around lines 3");
  expect(prompt).toContain("  3 | var x = 1");
  expect(prompt.indexOf("other.go, around lines 3")).toBeLessThan(
    prompt.indexOf("the unit's lines"),
  );
});

test("every item's own line shows even when those lines alone pass the cap; only the rest is clipped", () => {
  const big = new Map([
    ["big", [{ path: "big.go", side: "new" as const, start: 1, end: 1_500 }]],
  ]);
  const lines = Array.from({ length: 20 }, (_, at) => 40 + at * 70);
  const spread = lines.map((line, at) => ({
    ...meritItem(items[1]!),
    id: `b${at}`,
    path: "big.go",
    line,
    unit: "big",
  }));
  const prompt = meritPrompt(record, spread, big, "a".repeat(32));
  // 20 windows of 31 lines of ~60 characters: well past the 16,000-character cap.
  for (const line of lines)
    expect(prompt).toContain(`  ${line} | // line ${line} `);
  expect(prompt).toContain("[clipped:");
});

test("each kind's length band is its real items' 10th to 90th percentile", () => {
  const sample = Array.from({ length: 100 }, (_, at) => ({
    group: "consider" as const,
    text: "x".repeat(at + 1),
  }));
  expect(bandsOf(sample)["consider"]).toEqual([10, 90]);
  // Too few items of a kind to say: no band, so no filter.
  expect(bandsOf(sample.slice(0, 19))["consider"]).toBeUndefined();
});

test("an item anchored past its file's end is skipped from merit, counted and logged", async () => {
  const labels = join(caseDir, "labels");
  rmSync(join(labels, "merit-v2"), { recursive: true, force: true });
  rmSync(join(labels, "merit.json"), { force: true });
  const past = { ...items[2]!, id: "n9", line: 99 };
  writeFileSync(
    join(labels, "matching-key.json"),
    JSON.stringify({ items: [...items, past] }),
  );
  writeFileSync(
    join(labels, "matching.json"),
    JSON.stringify({ pairs: ["n1|r1"] }),
  );
  const queue: Array<(prompt: string) => unknown> = [
    // One wrong decoy alone: the set lacks the minor and nit grades, so it is drawn once more.
    () => ({
      decoys: [
        {
          code: "code-1",
          path: "main.go",
          line: 4,
          kind: "comment",
          grade: "wrong",
          shape: "n/a",
          text: "ALPHA wrong claim",
          why: "w",
        },
      ],
    }),
    () => ({
      decoys: [
        {
          code: "code-1",
          path: "main.go",
          line: 4,
          kind: "comment",
          grade: "wrong",
          shape: "n/a",
          text: "ALPHA wrong claim",
          why: "w",
        },
      ],
    }),
    (prompt) => ({
      items: [...prompt.matchAll(/"id": "([^"]+)",\n  "kind"/g)].map(([, id]) =>
        verdict(id!, "minor"),
      ),
    }),
    (prompt) => ({
      items: [...prompt.matchAll(/"id": "([^"]+)",\n  "kind"/g)].map(([, id]) =>
        verdict(id!, "minor"),
      ),
    }),
  ];
  const prompts: Array<string> = [];
  setCloudCaller(async (request) => {
    if (request["command"] === "probe") return probeAnswer;
    prompts.push(String(request["prompt"]));
    return {
      ...done,
      output: JSON.stringify(queue.shift()!(String(request["prompt"]))),
    };
  });
  const result = await judgeMerit(record);
  if (result.incomplete) throw new Error("incomplete");
  expect(result.anchorErrors).toEqual({
    total: 1,
    byKind: { comment: 0, checkpoint: 0, gap: 0, consider: 1 },
  });
  expect(result.items).toBe(4);
  for (const prompt of prompts) expect(prompt).not.toContain('"id": "n9"');
  const log = readFileSync(join(root, "anchor-errors.jsonl"), "utf8");
  expect(log).toContain('"line":99');
  expect(log).toContain("past the file's end on its own side");
});

test("an old-side item is read in the base file, labelled as before the change, and is no anchor error", async () => {
  // The lanes thread's finding: old-side anchors (a deleted file, removed lines) are correct, and
  // merit read them against the head, where they fall past the end or on other code.
  const removed = new Map([
    ["del", [{ path: "gone.go", side: "old" as const, start: 7, end: 9 }]],
  ]);
  const item = {
    ...meritItem(items[2]!),
    id: "g1",
    path: "gone.go",
    line: 8,
    side: "old" as const,
    unit: "del",
  };
  const prompt = meritPrompt(record, [item], removed, "c".repeat(32));
  expect(prompt).toContain("gone.go (before the change), around lines 8");
  expect(prompt).toContain("FILE BEFORE THE CHANGE (removed or changed lines)");
  expect(prompt).toContain("  8 | // gone 8");
  expect(prompt).toContain('"side": "old"');
  // The packet gives an item its anchor's side.
  const sided = unitsOf({
    batches: [
      {
        batchId: "b",
        units: [
          {
            unitId: "u",
            local: "u",
            recorded: {
              payload: {
                ownedRanges: [
                  {
                    kind: "lines",
                    path: "gone.go",
                    side: "old",
                    startLine: 7,
                    endLine: 9,
                  },
                ],
              },
            },
            comments: [
              {
                id: "c-old",
                payload: {
                  anchor: { path: "gone.go", side: "old", startLine: 8 },
                },
              },
            ],
            checkpoints: [
              {
                number: 1,
                anchors: [{ path: "gone.go", side: "old", startLine: 7 }],
              },
            ],
          },
        ],
      },
    ],
  } as never);
  expect(sided.sideOf("c-old")).toBe("old");
  expect(sided.sideOf("u#checkpoint-1")).toBe("old");
  expect(sided.ranges.get("u")).toEqual([
    { path: "gone.go", side: "old", start: 7, end: 9 },
  ]);
});

test("a case judged before the code-quality scale has only its best-practice items graded again, by majority", async () => {
  const labels = join(caseDir, "labels");
  mkdirSync(labels, { recursive: true });
  rmSync(join(labels, "merit-v2"), { recursive: true, force: true });
  writeFileSync(join(labels, "matching-key.json"), JSON.stringify({ items }));
  writeFileSync(
    join(labels, "matching.json"),
    JSON.stringify({ pairs: ["n1|r1"] }),
  );
  // n2 and n3 were best practice on revision 3; n4, minor, stays out of the regrade.
  writeFileSync(
    join(labels, "merit.json"),
    JSON.stringify({
      items: [
        { id: "n2", decoy: false, verdict: "best-practice" },
        { id: "n3", decoy: false, verdict: "best-practice" },
        { id: "n4", decoy: false, verdict: "minor" },
      ],
      summary: { revision: 3 },
    }),
  );
  // Pass a and b agree n2 is a nit-pick and tie on n3; the third breaks it to code quality.
  const grades: Array<Record<string, string>> = [
    { n2: "nit-pick", n3: "code-quality" },
    { n2: "nit-pick", n3: "minor" },
    { n2: "minor", n3: "code-quality" },
  ];
  const prompts: Array<string> = [];
  setCloudCaller(async (request) => {
    if (request["command"] === "probe") return probeAnswer;
    const prompt = String(request["prompt"]);
    prompts.push(prompt);
    const answer = grades.shift()!;
    return {
      ...done,
      output: JSON.stringify({
        items: [...prompt.matchAll(/"id": "([^"]+)",\n  "kind"/g)].map(
          ([, id]) => ({ id, grade: answer[id!], reason: "r" }),
        ),
      }),
    };
  });
  const result = await regradeMerit(record);
  if ("skipped" in result || result.incomplete) throw new Error("no regrade");
  expect(prompts).toHaveLength(3);
  // Pass b sees pass a's order reversed.
  const order = (prompt: string) =>
    [...prompt.matchAll(/"id": "([^"]+)",\n  "kind"/g)].map(([, id]) => id);
  expect(order(prompts[1]!)).toEqual([...order(prompts[0]!)].reverse());
  expect(prompts[0]).toContain("Every ITEM here was already judged valid");
  expect(prompts[0]).toContain('"nit-pick": valid, but a preference');
  for (const prompt of prompts) {
    expect(prompt).toContain("TEXT n2");
    expect(prompt).toContain("TEXT n3");
    expect(prompt).not.toContain("TEXT n4");
  }
  expect(result).toMatchObject({
    fromRevision: 3,
    items: 2,
    codeQuality: 1,
    nitPick: 1,
    minor: 0,
    unjudged: 0,
    missing: 0,
  });
  // Kept: a second run asks nothing.
  await regradeMerit(record);
  expect(prompts).toHaveLength(3);
  // A case with no merit yet says so, not a raw file error.
  rmSync(join(labels, "merit.json"));
  await expect(regradeMerit(record)).rejects.toThrow(
    "no labels/merit.json: run merit before regrade",
  );
  // A case already on the code-quality scale is left alone.
  writeFileSync(
    join(labels, "merit.json"),
    JSON.stringify({ items: [], summary: { revision: 4 } }),
  );
  expect(await regradeMerit(record)).toMatchObject({
    skipped: "judged on the code-quality scale already",
  });
});

test("a decoy set missing a grade is drawn once more, and a grade still missing is flagged", async () => {
  const labels = join(caseDir, "labels");
  mkdirSync(labels, { recursive: true });
  rmSync(join(labels, "merit-v2"), { recursive: true, force: true });
  rmSync(join(labels, "merit.json"), { force: true });
  writeFileSync(join(labels, "matching-key.json"), JSON.stringify({ items }));
  writeFileSync(
    join(labels, "matching.json"),
    JSON.stringify({ pairs: ["n1|r1"] }),
  );
  // Both draws leave out the nit-pick.
  const noNit = {
    decoys: [
      {
        code: "code-1",
        path: "main.go",
        line: 4,
        kind: "comment",
        grade: "wrong",
        shape: "n/a",
        text: "ALPHA wrong",
        why: "w",
      },
      {
        code: "code-1",
        path: "main.go",
        line: 5,
        kind: "comment",
        grade: "minor",
        shape: "cosmetic",
        text: "BETA typo",
        why: "m",
      },
    ],
  };
  let writers = 0;
  setCloudCaller(async (request) => {
    if (request["command"] === "probe") return probeAnswer;
    const prompt = String(request["prompt"]);
    if (prompt.includes("decoys")) {
      writers++;
      return { ...done, output: JSON.stringify(noNit) };
    }
    return {
      ...done,
      output: JSON.stringify({
        items: [...prompt.matchAll(/"id": "([^"]+)",\n  "kind"/g)].map(
          ([, id]) => verdict(id!, "code-quality"),
        ),
      }),
    };
  });
  const result = await judgeMerit(record);
  if (result.incomplete) throw new Error("incomplete");
  expect(writers).toBe(2);
  expect(result.decoysMissing).toEqual(["nit-pick"]);
  expect(result.decoyCatch).toMatchObject({ nitGrade: { decoys: 0 } });
});

// Why (the overseer, 27 October): a repeat run's merit sets the parity noise and nit bars against its
// case's first run, so it is judged on the same revision with the first run's decoys, never a fresh
// draw, and writes only into its own run folder.
test("another run of a case is judged with the first run's current decoys, in its own folder", async () => {
  const labels = join(caseDir, "labels");
  const runFolder = join(caseDir, "run", "cloud-2");
  const runLabels = join(runFolder, "labels");
  mkdirSync(runLabels, { recursive: true });
  writeFileSync(
    join(runFolder, "show.json"),
    JSON.stringify({ runId: "r2", packet: secondRun }),
  );
  writeFileSync(
    join(runLabels, "matching-key.json"),
    JSON.stringify({ items }),
  );
  writeFileSync(
    join(runLabels, "matching.json"),
    JSON.stringify({ pairs: ["n1|r1"] }),
  );
  rmSync(join(labels, "merit-v2"), { recursive: true, force: true });
  rmSync(join(labels, "merit.json"), { force: true });
  mkdirSync(join(labels, "merit-v2"), { recursive: true });
  const decoy = (at: number) => ({
    ...meritItem(item(`d${at}`, "neuve", "comment", 4)),
    id: `decoy-${at}`,
    text: `SHARED-DECOY-${at}`,
    decoy: true,
  });
  writeFileSync(
    join(labels, "merit-v2", "decoys.json"),
    JSON.stringify({
      revision: 4,
      decoys: [1, 2, 3, 4, 5, 6].map(decoy),
      missingGrades: [],
      receipts: [],
    }),
  );
  const prompts: Array<string> = [];
  setCloudCaller(async (request) => {
    if (request["command"] === "probe") return probeAnswer;
    prompts.push(String(request["prompt"]));
    return { ...done, output: JSON.stringify({ not: "a pass" }) };
  });
  const summary = await judgeMerit(record, "cloud-2");
  expect(summary).toMatchObject({ incomplete: true });
  expect(prompts.length).toBeGreaterThan(0);
  expect(
    prompts.some((prompt) =>
      prompt.startsWith("You are preparing control items"),
    ),
  ).toBe(false);
  expect(prompts.every((prompt) => prompt.includes("SHARED-DECOY-1"))).toBe(
    true,
  );
  expect(existsSync(join(runLabels, "merit-v2", "decoys.json"))).toBe(false);
  expect(existsSync(join(labels, "merit.json"))).toBe(false);
});

// Why (review, 27 October): unit ids and owned ranges differ between runs, so a decoy kept from the first
// run must go to the unit of this run that owns its line, or to a line block of its own, never to the
// first run's unit id, which names other code here or nothing at all.
const secondRun = {
  batches: [
    {
      batchId: "b1",
      units: [
        {
          unitId: "unit-9",
          local: "unit-9",
          recorded: {
            payload: {
              ownedRanges: [
                {
                  kind: "lines",
                  path: "main.go",
                  side: "new",
                  startLine: 3,
                  endLine: 6,
                },
              ],
            },
          },
          comments: [],
        },
      ],
    },
  ],
};

test("a decoy kept from the first run is placed in this run's unit that owns its line, else a line block", () => {
  const { ranges: second } = unitsOf(secondRun as never);
  const kept = (path: string, line: number, side: "new" | "old") => ({
    ...meritItem(item("k", "neuve", "comment", line)),
    path,
    side,
    unit: "unit-7",
    decoy: true,
  });
  expect(
    reanchored(
      [
        kept("main.go", 4, "new"),
        kept("other.go", 1, "new"),
        kept("main.go", 4, "old"),
      ],
      second,
    ).map((decoy): string | null => decoy.unit),
  ).toEqual(["unit-9", null, null]);
});

// Why (review, 27 October): a kept pass is reused only for the same items, decoys included, so a pass
// that judged an earlier decoy draw is never reused once the decoys are drawn again.
test("a kept pass that holds an earlier draw's decoy ids is judged again", async () => {
  const labels = join(caseDir, "labels");
  const runFolder = join(caseDir, "run", "cloud-3");
  const runLabels = join(runFolder, "labels");
  mkdirSync(join(runLabels, "merit-v2"), { recursive: true });
  writeFileSync(
    join(runFolder, "show.json"),
    JSON.stringify({ runId: "r3", packet }),
  );
  writeFileSync(
    join(runLabels, "matching-key.json"),
    JSON.stringify({ items }),
  );
  writeFileSync(
    join(runLabels, "matching.json"),
    JSON.stringify({ pairs: ["n1|r1"] }),
  );
  const decoys = JSON.parse(
    readFileSync(join(labels, "merit-v2", "decoys.json"), "utf8"),
  ) as {
    decoys: Array<{ id: string }>;
  };
  // A pass kept against the same real items and an earlier draw's decoys.
  const earlier = [
    "n2",
    "n3",
    "n4",
    "old-1",
    "old-2",
    "old-3",
    "old-4",
    "old-5",
    "old-6",
  ].sort();
  writeFileSync(
    join(runLabels, "merit-v2", "pass-a-0.json"),
    JSON.stringify({
      ids: earlier,
      revision: 4,
      output: {
        items: earlier.map((id) => ({ id, verdict: "legitimate", reason: "" })),
      },
      receipt: {},
    }),
  );
  expect(decoys.decoys.map((one) => one.id)).not.toContain("old-1");
  const prompts: Array<string> = [];
  setCloudCaller(async (request) => {
    if (request["command"] === "probe") return probeAnswer;
    prompts.push(String(request["prompt"]));
    return { ...done, output: JSON.stringify({ not: "a pass" }) };
  });
  await judgeMerit(record, "cloud-3");
  // Passes a and b both ran: the kept pass a was not reused for the new draw.
  expect(prompts).toHaveLength(2);
});

test("treatment merit and regrade admit summaries, cached passes and model leaves before cloud work", async () => {
  const treatment = join(root, "../", `treatment-${process.pid}-${Date.now()}`);
  const previous = process.env["NEUVE_TREATMENT_ROOT"];
  process.env["NEUVE_TREATMENT_ROOT"] = treatment;
  const directory = join(
    treatment,
    "cases/entire-cli/9/run/candidate-1/labels",
  );
  const store = join(directory, "merit-v2");
  mkdirSync(store, { recursive: true });
  writeFileSync(
    join(dirname(directory), "show.json"),
    JSON.stringify({ packet }),
  );
  writeFileSync(
    join(directory, "matching-key.json"),
    JSON.stringify({ items }),
  );
  writeFileSync(
    join(directory, "matching.json"),
    JSON.stringify({ pairs: [] }),
  );
  let calls = 0;
  setCloudCaller(async () => {
    calls++;
    throw new Error("unexpected cloud call");
  });
  try {
    for (const regrade of [false, true]) {
      const kind = regrade ? "regrade" : "pass";
      const names = [regrade ? "merit-regrade.json" : "merit.json"];
      if (!regrade) {
        names.push("merit-v2/decoys.json", "merit-v2/decoys.jsonl");
        for (const draw of ["decoys", "decoys-2"])
          names.push(
            `merit-v2/${draw}`,
            `merit-v2/${draw}/schema.json`,
            `merit-v2/${draw}/output.json`,
          );
      }
      for (const at of [0, 9])
        for (const pass of ["a", "b", "c"])
          names.push(
            `merit-v2/${kind}-${pass}-${at}.json`,
            `merit-v2/${kind}-${pass}-${at}`,
            `merit-v2/${kind}-${pass}-${at}/schema.json`,
            `merit-v2/${kind}-${pass}-${at}/output.json`,
            `merit-v2/${regrade ? "regrade" : "merit"}-${pass}-${at}.jsonl`,
          );
      if (regrade)
        writeFileSync(
          join(directory, "merit.json"),
          JSON.stringify({
            items: [{ id: "n1", decoy: false, verdict: "best-practice" }],
            summary: { revision: 1 },
          }),
        );
      for (const existing of [false, true]) {
        const sentinel = join(root, `admission-${regrade}-${existing}`);
        if (existing) writeFileSync(sentinel, "{}\n");
        for (const name of names) {
          const path = join(directory, name);
          mkdirSync(dirname(path), { recursive: true });
          rmSync(path, { recursive: true, force: true });
          symlinkSync(sentinel, path);
          await expect(
            regrade
              ? regradeMerit(record, "candidate-1")
              : judgeMerit(record, "candidate-1"),
          ).rejects.toThrow();
          expect(calls).toBe(0);
          expect(existsSync(sentinel)).toBe(existing);
          if (existing) expect(readFileSync(sentinel, "utf8")).toBe("{}\n");
          unlinkSync(path);
        }
      }
    }
  } finally {
    if (previous === undefined) delete process.env["NEUVE_TREATMENT_ROOT"];
    else process.env["NEUVE_TREATMENT_ROOT"] = previous;
    rmSync(treatment, { recursive: true, force: true });
  }
  // Alone 2.14-4.92 s at load 11-30, 5.56 s in its file; 10x slowest seen; child processes and disk I/O under load.
}, 60_000);

test("valid treatment merit and regrade retain cached passes and resume without new cloud work", async () => {
  const treatment = join(
    root,
    "../",
    `valid-treatment-${process.pid}-${Date.now()}`,
  );
  const previous = process.env["NEUVE_TREATMENT_ROOT"];
  process.env["NEUVE_TREATMENT_ROOT"] = treatment;
  const directory = join(
    treatment,
    "cases/entire-cli/9/run/candidate-1/labels",
  );
  const store = join(directory, "merit-v2");
  mkdirSync(store, { recursive: true });
  writeFileSync(
    join(dirname(directory), "show.json"),
    JSON.stringify({ packet }),
  );
  writeFileSync(
    join(directory, "matching-key.json"),
    JSON.stringify({ items: [items[0]] }),
  );
  writeFileSync(
    join(directory, "matching.json"),
    JSON.stringify({ pairs: [] }),
  );
  writeFileSync(
    join(store, "decoys.json"),
    JSON.stringify({
      revision: MERIT_REVISION,
      decoys: [
        { ...meritItem(items[0]!), id: "xcached", decoy: true, grade: "wrong" },
      ],
      missingGrades: [],
      receipts: [],
    }),
  );
  const requests: string[] = [];
  setCloudCaller(async (request) => {
    requests.push(String(request["command"]));
    if (request["command"] === "probe") return probeAnswer;
    const prompt = String(request["prompt"]);
    const ids = [...prompt.matchAll(/"id": "([^"]+)"/g)].map(
      (match) => match[1]!,
    );
    return {
      ...done,
      output: JSON.stringify({
        items: ids.map((id) =>
          prompt.includes("code quality, nit-pick or minor")
            ? { id, grade: "code-quality", reason: "A concrete practice." }
            : verdict(id, "code-quality"),
        ),
      }),
    };
  });
  try {
    expect(await judgeMerit(record, "candidate-1")).toMatchObject({
      incomplete: false,
      items: 1,
    });
    expect(requests).toEqual(["probe", "exec", "exec"]);
    expect(await judgeMerit(record, "candidate-1")).toMatchObject({
      incomplete: false,
      items: 1,
    });
    expect(requests).toHaveLength(3);
    writeFileSync(
      join(directory, "merit.json"),
      JSON.stringify({
        items: [{ id: "n1", decoy: false, verdict: "best-practice" }],
        summary: { revision: 1 },
      }),
    );
    setCloudCaller(async (request) => {
      requests.push(String(request["command"]));
      return request["command"] === "probe"
        ? probeAnswer
        : {
            ...done,
            output: JSON.stringify({
              items: [
                {
                  id: "n1",
                  grade: "code-quality",
                  reason: "A concrete practice.",
                },
              ],
            }),
          };
    });
    expect(await regradeMerit(record, "candidate-1")).toMatchObject({
      incomplete: false,
      codeQuality: 1,
    });
    expect(requests).toHaveLength(6);
    expect(await regradeMerit(record, "candidate-1")).toMatchObject({
      incomplete: false,
      codeQuality: 1,
    });
    expect(requests).toHaveLength(6);
  } finally {
    if (previous === undefined) delete process.env["NEUVE_TREATMENT_ROOT"];
    else process.env["NEUVE_TREATMENT_ROOT"] = previous;
    rmSync(treatment, { recursive: true, force: true });
  }
});
