// Why: the label audit replaces the owner's check page (10.136), so its sample must cover every
// label kind, over-sampling the rare ones, and spread across sources and origins; three auditors
// decide by majority, a wrong label carries the correction most of them named, and a kind below 85%
// accuracy is flagged before its labels feed a climb. An auditor must see the label, its definition
// and the code at the first revision, never the labeller's reasoning.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CaseRecord } from "../src/pr-replay/schema.ts";

const root = mkdtempSync(join(tmpdir(), "replay-audit-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
process.env["NEUVE_RESEARCH_ROOT"] = root;
const {
  CLASS_DEFINITIONS,
  auditPool,
  auditOverrideOf,
  auditPrompt,
  auditReport,
  decideAudit,
  stratifiedSample,
  wilson,
} = await import("../src/pr-replay/audit.ts");
type Item = Parameters<typeof decideAudit>[0][number];

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

const item = (
  over: Partial<Item> & Pick<Item, "class" | "origin" | "source">,
  at: number,
): Item => ({
  id: "",
  caseId: `case-${at}`,
  number: at,
  cite: `cite-${at}`,
  lines: [`a.ts:new:${at}`],
  ...over,
});

test("the sample takes one per stratum, then shares the rest by pool size", () => {
  const pool: Array<Item> = [];
  let at = 0;
  for (const source of ["devtools-frontend", "go", "t3code"])
    for (let n = 0; n < 30; n++)
      pool.push(
        item({ class: "needs-person", origin: "review", source }, ++at),
      );
  pool.push(item({ class: "discussed", origin: "review", source: "go" }, ++at));
  pool.push(item({ class: "discussed", origin: "review", source: "go" }, ++at));
  for (let n = 0; n < 9; n++)
    pool.push(
      item(
        { class: "agent-catchable", origin: "review", source: "t3code" },
        ++at,
      ),
    );
  for (let n = 0; n < 9; n++)
    pool.push(
      item({ class: "mechanical", origin: "path", source: "go" }, ++at),
    );
  for (let n = 0; n < 9; n++)
    pool.push(
      item(
        { class: "needs-person", origin: "after-merge", source: "go" },
        ++at,
      ),
    );
  const sample = stratifiedSample(pool, 42);
  // Seven strata, one each, then 24 more by pool size.
  expect(sample.length).toBe(7 + 24);
  const count = (pick: (one: Item) => boolean) => sample.filter(pick).length;
  for (const kind of [
    "needs-person",
    "discussed",
    "agent-catchable",
    "mechanical",
  ] as const)
    expect(count((one) => one.class === kind)).toBeGreaterThan(0);
  // The big strata get the most; a rare one is still over-sampled against its pool share.
  expect(
    count((one) => one.source === "devtools-frontend"),
  ).toBeGreaterThanOrEqual(4);
  expect(
    count((one) => one.class === "mechanical") / sample.length,
  ).toBeGreaterThan(9 / pool.length);
  expect(count((one) => one.origin === "after-merge")).toBeGreaterThan(0);
  // Seeded: the same seed draws the same items (the ids are fresh each time).
  expect(stratifiedSample(pool, 42).map((one) => one.cite)).toEqual(
    sample.map((one) => one.cite),
  );
  expect(new Set(sample.map((one) => one.id)).size).toBe(sample.length);
});

test("the largest stratum always gets its share, whatever the seed (it once got none)", () => {
  // Shaped like the real pool: one stratum of 141 review labels among 25 small ones, 291 in all.
  const pool: Array<Item> = [];
  let at = 0;
  for (let n = 0; n < 141; n++)
    pool.push(
      item({ class: "needs-person", origin: "review", source: "go" }, ++at),
    );
  const small = [
    "devtools-frontend",
    "t3code",
    "react-core",
    "react-compiler",
    "entire-cli",
  ];
  for (const source of small)
    for (const [cls, origin] of [
      ["needs-person", "after-merge"],
      ["discussed", "review"],
      ["agent-catchable", "review"],
      ["mechanical", "path"],
      ["needs-person", "review"],
    ] as const)
      for (let n = 0; n < 6; n++)
        pool.push(item({ class: cls, origin, source }, ++at));
  expect(pool.length).toBe(291);
  for (const seed of [12345, 1, 7, 99]) {
    const sample = stratifiedSample(pool, seed);
    const largest = sample.filter((one) => one.source === "go").length;
    // One, plus its share of the 24: 141 / 291 of them, at least 11.
    expect(largest).toBeGreaterThanOrEqual(12);
    expect(
      new Set(sample.map((one) => `${one.class}|${one.origin}|${one.source}`))
        .size,
    ).toBe(26);
  }
});

test("three auditors decide by majority; a wrong label carries the correction most named", () => {
  const items = [1, 2, 3, 4].map((at) =>
    item(
      { class: "needs-person", origin: "review", source: "go", id: `i${at}` },
      at,
    ),
  );
  const pass = (
    verdicts: Array<["right" | "wrong" | "unsure", string | null]>,
  ) => ({
    items: verdicts.map(([verdict, shouldBe], at) => ({
      id: `i${at + 1}`,
      verdict,
      reason: `reason ${at}`,
      shouldBe: shouldBe as "discussed" | null,
    })),
  });
  const { items: decided } = decideAudit(items, {
    a: pass([
      ["right", null],
      ["wrong", "discussed"],
      ["unsure", null],
      ["right", null],
    ]),
    b: pass([
      ["right", null],
      ["wrong", "discussed"],
      ["unsure", null],
      ["wrong", "none"],
    ]),
    c: pass([
      ["wrong", "none"],
      ["wrong", "none"],
      ["right", null],
      ["unsure", null],
    ]),
  });
  expect(decided.map((one) => one.verdict)).toEqual([
    "right",
    "wrong",
    null,
    null,
  ]);
  expect(decided[1]!.shouldBe).toBe("discussed");
  expect(decided[2]!.unjudged).toBe("unsure");
  expect(decided[3]!.unjudged).toBe("split");
});

test("accuracy is weighted back to the pool, never read off the over-sampled sample", () => {
  // The reviewer's case: needs-person holds 22 after-merge labels and 141 review ones; the sample
  // takes 7 and 1. Every after-merge label right and the one review label wrong reads 7 of 8 as
  // sampled, but the pool is mostly review labels: about 13%.
  const decided = (
    origin: "after-merge" | "review",
    count: number,
    verdict: "right" | "wrong",
    at: number,
  ) =>
    Array.from({ length: count }, (_, n) => ({
      ...item({ class: "needs-person", origin, source: "go" }, at + n),
      verdict,
      unjudged: null,
      shouldBe: verdict === "wrong" ? ("none" as const) : null,
      reasons: ["why"],
    }));
  const strata = {
    "needs-person|after-merge|go": 22,
    "needs-person|review|go": 141,
  };
  const report = auditReport(
    [
      ...decided("after-merge", 7, "right", 0),
      ...decided("review", 1, "wrong", 100),
    ],
    strata,
  );
  const kind = report.byKind["needs-person"]!;
  expect(kind.right).toBe(7);
  expect(kind.judged).toBe(8);
  expect(kind.accuracy).toBeCloseTo(22 / 163, 10);
  expect(kind.coverage).toBe(1);
  expect(report.overall.accuracy).toBeCloseTo(22 / 163, 10);
  expect(report.byOrigin["after-merge"]!.accuracy).toBe(1);
  expect(report.byOrigin["review"]!.accuracy).toBe(0);
  // Eight items are too few to tell by the estimate alone, but the whole interval is below 85%.
  expect(kind.interval![1]).toBeLessThan(0.85);
  expect(report.flagged).toEqual(["needs-person"]);
  expect(report.tooFew).toEqual(["needs-person"]);
  expect(report.wrong).toHaveLength(1);
});

test("a kind is flagged only when the evidence shows it below 85%, and an unsampled stratum lowers coverage", () => {
  const verdicts = (
    cls: "discussed" | "mechanical",
    origin: "review" | "path",
    right: number,
    wrong: number,
  ) =>
    Array.from({ length: right + wrong }, (_, n) => ({
      ...item({ class: cls, origin, source: "go" }, n),
      verdict: n < right ? ("right" as const) : ("wrong" as const),
      unjudged: null,
      shouldBe: null,
      reasons: [],
    }));
  const report = auditReport(
    [
      ...verdicts("discussed", "review", 18, 2),
      ...verdicts("mechanical", "path", 7, 3),
    ],
    {
      "discussed|review|go": 40,
      "discussed|review|t3code": 40,
      "mechanical|path|go": 10,
    },
  );
  // 90% on 20 items: not flagged, but its interval still reaches below 85%.
  expect(report.byKind["discussed"]!.accuracy).toBeCloseTo(0.9, 10);
  expect(report.byKind["discussed"]!.coverage).toBe(0.5);
  expect(report.flagged).toEqual(["mechanical"]);
  expect(report.notShown).toContain("discussed");
  // Wilson on a small count: wide, and never past 0 or 1.
  const [low, high] = wilson(2, 4)!;
  expect(low).toBeGreaterThan(0.1);
  expect(high).toBeLessThan(0.9);
  expect(wilson(10, 10)![1]).toBe(1);
});

test("an item rests on its line evidence, and the auditor sees label, definition and code, never the labeller's reasoning", () => {
  const mirror = join(root, "mirrors", "entireio__cli.git");
  const work = join(root, "work");
  git(root, ["init", "-q", "-b", "main", work]);
  writeFileSync(join(work, "go.sum"), "x v1\n");
  git(work, ["add", "."]);
  git(work, ["commit", "-q", "-m", "base"]);
  const base = git(work, ["rev-parse", "HEAD"]);
  writeFileSync(join(work, "go.sum"), "x v1\ny v2\nz v3\n");
  git(work, ["commit", "-q", "-am", "head"]);
  const head = git(work, ["rev-parse", "HEAD"]);
  git(root, ["clone", "-q", "--bare", work, mirror]);
  const labels = join(root, "cases", "entire-cli", "7", "labels");
  mkdirSync(labels, { recursive: true });
  writeFileSync(
    join(labels, "line-evidence.json"),
    JSON.stringify({
      version: 2,
      caseId: "github:entireio/cli:7",
      source: "entire-cli",
      era: "2026",
      split: "development",
      family: "github:entireio/cli:7",
      control: null,
      range: `${base.slice(0, 8)}..${head.slice(0, 8)}`,
      runId: "run",
      labelling: { passes: 2, rule: "majority", kappa: null },
      lines: {
        "go.sum:new:2": {
          class: "mechanical",
          strength: "weak",
          concerns: ["path"],
        },
        "go.sum:new:3": {
          class: "mechanical",
          strength: "weak",
          concerns: ["path"],
        },
      },
      disputed: 0,
    }),
  );
  writeFileSync(
    join(labels, "concerns.jsonl"),
    `${JSON.stringify({ id: "t", a: { rationale: "LABELLER-REASONING" } })}\n`,
  );
  const record = {
    caseId: "github:entireio/cli:7",
    source: "entire-cli",
    number: 7,
    firstRevision: { base, head, at: "2026-01-01T00:00:00Z" },
  } as unknown as CaseRecord;
  const pool = auditPool(record);
  expect(pool).toHaveLength(1);
  expect(pool[0]).toMatchObject({
    origin: "path",
    cite: "go.sum",
    class: "mechanical",
  });
  expect(pool[0]!.lines).toEqual(["go.sum:new:2", "go.sum:new:3"]);
  const prompt = auditPrompt(
    record,
    [{ ...pool[0]!, id: "a1" }],
    "f".repeat(32),
  );
  expect(prompt).toContain("LABEL: mechanical");
  expect(prompt).toContain(CLASS_DEFINITIONS.mechanical);
  expect(prompt).toContain(">");
  expect(prompt).toContain("+y v2");
  expect(prompt).not.toContain("LABELLER-REASONING");
  // An after-merge label: the auditor needs when the fix landed to apply the 90-day definition (the
  // pilot's auditors were unsure on every one without it), and the fix's diff on the item's file,
  // not clipped away behind other files.
  writeFileSync(join(work, "go.sum"), "x v1\ny v9\nz v3\n");
  writeFileSync(join(work, "big.txt"), "BIG-OTHER-FILE\n".repeat(10));
  git(work, ["add", "."]);
  git(work, ["commit", "-q", "-m", "fix the y line"]);
  const fix = git(work, ["rev-parse", "HEAD"]);
  git(work, ["push", "-q", mirror, "main"]);
  writeFileSync(
    join(labels, "rework.json"),
    JSON.stringify({
      version: 1,
      caseId: record.caseId,
      firstLines: 2,
      landed: head,
      windowEnd: fix,
      untracked: 0,
      lines: {
        "go.sum:new:2": {
          beforeMerge: false,
          afterMerge: {
            commit: fix,
            subject: "fix the y line",
            days: 12.5,
            revert: false,
          },
        },
      },
      notes: [],
    }),
  );
  const later = auditPrompt(
    record,
    [
      {
        id: "a2",
        caseId: record.caseId,
        source: "entire-cli",
        number: 7,
        origin: "after-merge",
        cite: fix,
        class: "needs-person",
        lines: ["go.sum:new:2"],
      },
    ],
    "f".repeat(32),
  );
  expect(later).toContain(
    "12.5 days after the change merged (inside the 90-day window)",
  );
  expect(later).toContain("MESSAGE\nfix the y line");
  expect(later).toContain("DIFF ON go.sum");
  expect(later).toContain("+y v9");
  expect(later).not.toContain("BIG-OTHER-FILE");
});

test("Kish's effective n never exceeds the items judged, pure strata included", () => {
  const verdicts = (
    cls: "discussed" | "mechanical",
    source: string,
    right: number,
    wrong: number,
  ) =>
    Array.from({ length: right + wrong }, (_, n) => ({
      ...item(
        {
          class: cls,
          origin: cls === "mechanical" ? "path" : "review",
          source,
        },
        n,
      ),
      verdict: n < right ? ("right" as const) : ("wrong" as const),
      unjudged: null,
      shouldBe: null,
      reasons: [],
    }));
  // One pure stratum, one half right, equal pools: 75%, on 20 judged items.
  const mixed = auditReport(
    [
      ...verdicts("discussed", "go", 10, 0),
      ...verdicts("discussed", "t3code", 5, 5),
    ],
    { "discussed|review|go": 100, "discussed|review|t3code": 100 },
  ).byKind["discussed"]!;
  expect(mixed.accuracy).toBeCloseTo(0.75, 10);
  expect(mixed.effectiveN).toBeLessThanOrEqual(mixed.judged);
  // Pure strata with unequal weights: a variance-based n would claim certainty; Kish's is small.
  const pure = auditReport(
    [
      ...verdicts("discussed", "go", 1, 0),
      ...verdicts("discussed", "t3code", 23, 0),
    ],
    { "discussed|review|go": 290, "discussed|review|t3code": 1 },
  ).byKind["discussed"]!;
  expect(pure.accuracy).toBe(1);
  expect(pure.effectiveN).toBeLessThan(2);
  expect(pure.interval![0]).toBeLessThan(0.5);
});

test("an unaudited share of the pool widens the interval to anything", () => {
  const right = Array.from({ length: 10 }, (_, n) => ({
    ...item({ class: "discussed", origin: "review", source: "go" }, n),
    verdict: "right" as const,
    unjudged: null,
    shouldBe: null,
    reasons: [],
  }));
  const unsure = Array.from({ length: 3 }, (_, n) => ({
    ...item({ class: "discussed", origin: "review", source: "t3code" }, 20 + n),
    verdict: null,
    unjudged: "unsure" as const,
    shouldBe: null,
    reasons: [],
  }));
  const result = auditReport([...right, ...unsure], {
    "discussed|review|go": 50,
    "discussed|review|t3code": 50,
  }).byKind["discussed"]!;
  expect(result.coverage).toBe(0.5);
  expect(result.interval![1]).toBe(1);
  expect(result.interval![0]).toBeLessThanOrEqual(0.5);
});

test("a wrong label becomes an override only when every auditor found it wrong with none as the fix", () => {
  // Why: the audit's corrections go into the evidence the lanes climb reads, so only a unanimous
  // verdict with the same correction may change it.
  const folder = join(root, "audits", "batch-x", "entire-cli-7");
  mkdirSync(folder, { recursive: true });
  const item = {
    id: "a1",
    caseId: "github:entireio/cli:7",
    source: "entire-cli",
    number: 7,
    origin: "review",
    cite: "thread-1",
    class: "agent-catchable",
    lines: ["go.sum:new:2"],
  };
  writeFileSync(
    join(folder, "verdicts.json"),
    JSON.stringify({
      items: [
        {
          ...item,
          verdict: "wrong",
          unjudged: null,
          shouldBe: "none",
          reasons: ["x", "y", "z"],
        },
      ],
    }),
  );
  const pass = (verdict: string, shouldBe: string | null) =>
    JSON.stringify({
      output: {
        items: [{ id: "a1", verdict, reason: `${verdict} because`, shouldBe }],
      },
    });
  for (const name of ["a", "b", "c"])
    writeFileSync(join(folder, `pass-${name}.json`), pass("wrong", "none"));
  const record = {
    caseId: "github:entireio/cli:7",
    source: "entire-cli",
    number: 7,
  } as unknown as CaseRecord;
  expect(auditOverrideOf("batch-x", record, "a1")).toMatchObject({
    audit: "batch-x",
    origin: "review",
    cite: "thread-1",
    was: "agent-catchable",
    now: "none",
    verdicts: ["wrong", "wrong", "wrong"],
  });
  // Two of three is a majority, not unanimity: refused.
  writeFileSync(join(folder, "pass-c.json"), pass("right", null));
  expect(() => auditOverrideOf("batch-x", record, "a1")).toThrow(
    "not wrong by every auditor",
  );
});
