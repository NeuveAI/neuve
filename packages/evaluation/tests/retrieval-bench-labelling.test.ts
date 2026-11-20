import { expect, test } from "bun:test";
import { cohensKappa } from "../src/retrieval-bench/labelling/agreement.ts";
import {
  headToBase,
  mergeEntries,
} from "../src/retrieval-bench/labelling/pool.ts";
import type { DiffHunk } from "../src/retrieval-bench/hunks.ts";
import type { Grade } from "../src/retrieval-bench/labelling/schema.ts";

// Why: a wrong merge or line mapping silently changes which base regions labellers grade and which
// review citations enter the pool; nothing downstream would notice.
test("pool merges overlapping spans transitively and maps head lines to base lines", () => {
  const source = (name: string) => ({
    source: name,
    rank: 1,
    startLine: null,
    endLine: null,
    ref: null,
  });
  const merged = mergeEntries([
    { path: "a", start: 10, end: 20, source: source("x") },
    { path: "a", start: 18, end: 30, source: source("y") },
    { path: "a", start: 30, end: 35, source: source("z") },
    { path: "a", start: 36, end: 40, source: source("w") },
    { path: "b", start: 1, end: 5, source: source("x") },
  ]);
  expect(merged.map((m) => [m.path, m.start, m.end, m.sources.length])).toEqual(
    [
      ["a", 10, 35, 3],
      ["a", 36, 40, 1],
      ["b", 1, 5, 1],
    ],
  );

  const hunk = (
    oldStart: number,
    oldLines: number,
    newStart: number,
    newLines: number,
  ): DiffHunk => ({
    path: "f",
    oldPath: "f",
    oldStart,
    oldLines,
    newStart,
    newLines,
    added: newLines,
    deleted: oldLines,
  });
  // Base 10–11 replaced by head 10–13; base 30 deleted (head has nothing there); head 40 added.
  const hunks = [hunk(10, 2, 10, 4), hunk(30, 1, 31, 0), hunk(38, 0, 40, 1)];
  expect(headToBase(hunks, "f", 5)).toEqual({ oldPath: "f", start: 5, end: 5 });
  expect(headToBase(hunks, "f", 12)).toEqual({
    oldPath: "f",
    start: 10,
    end: 11,
  });
  expect(headToBase(hunks, "f", 20)).toEqual({
    oldPath: "f",
    start: 18,
    end: 18,
  });
  expect(headToBase(hunks, "f", 35)).toEqual({
    oldPath: "f",
    start: 34,
    end: 34,
  });
  expect(headToBase(hunks, "f", 40)).toBeNull();
  expect(headToBase(hunks, "f", 41)).toEqual({
    oldPath: "f",
    start: 39,
    end: 39,
  });
});

// Why: kappa is the headline agreement figure; an off-by-chance error would not be visible in output.
test("Cohen's kappa matches a hand-computed case", () => {
  const pairs = [
    ...Array.from({ length: 20 }, () => ["y", "y"] as const),
    ...Array.from({ length: 5 }, () => ["y", "n"] as const),
    ...Array.from({ length: 10 }, () => ["n", "y"] as const),
    ...Array.from({ length: 15 }, () => ["n", "n"] as const),
  ];
  const result = cohensKappa(pairs);
  expect(result.agreement).toBeCloseTo(0.7, 10);
  expect(result.kappa).toBeCloseTo(0.4, 10);
});

// Why: a model process that inherits the session's environment silently receives tokens, proxy
// passwords and the SSH agent socket; nothing in the run's output would show it.
test("model processes get only the allowlisted environment", async () => {
  const { ENV_ALLOWLIST, claudePrintCommand, codexCommand } =
    await import("../src/retrieval-bench/labelling/routes.ts");
  const saved = {
    sock: process.env["SSH_AUTH_SOCK"],
    secret: process.env["NEUVE_TEST_SECRET_TOKEN"],
    apiKey: process.env["ANTHROPIC_API_KEY"],
    oauth: process.env["CLAUDE_CODE_OAUTH_TOKEN"],
  };
  process.env["SSH_AUTH_SOCK"] = "/tmp/agent.sock";
  process.env["NEUVE_TEST_SECRET_TOKEN"] = "do-not-leak";
  const allowed = new Set<string>(ENV_ALLOWLIST);
  const commands = [
    codexCommand({
      runDir: "/tmp/run",
      prompt: "",
      schemaFile: "output.schema.json",
      log: "/tmp/log",
      binary: "/test/codex",
    }),
    claudePrintCommand("/tmp/run", "/tmp/snapshot", "{}"),
  ];
  for (const { env } of commands) {
    expect(Object.keys(env).filter((key) => !allowed.has(key))).toEqual([]);
    const child = Bun.spawn(["/usr/bin/env"], { env, stdout: "pipe" });
    const printed = (await new Response(child.stdout).text())
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(0, line.indexOf("=")));
    await child.exited;
    expect(printed.filter((key) => !allowed.has(key))).toEqual([]);
  }
  // A Claude process gets exactly one credential variable; a Codex process gets none, and no
  // other secret (including credentials already in the parent environment) reaches either.
  process.env["ANTHROPIC_API_KEY"] = "parent-key-must-not-leak";
  process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "parent-token-must-not-leak";
  const { CREDENTIAL_VARIABLES } =
    await import("../src/retrieval-bench/labelling/credentials.ts");
  const claude = claudePrintCommand(
    "/tmp/run",
    "/tmp/snapshot",
    "{}",
    null,
    undefined,
    {
      name: "CLAUDE_CODE_OAUTH_TOKEN",
      value: "test-token",
    },
  );
  expect(Object.keys(claude.env).filter((key) => !allowed.has(key))).toEqual([
    "CLAUDE_CODE_OAUTH_TOKEN",
  ]);
  expect(claude.env["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("test-token");
  const codex = codexCommand({
    runDir: "/tmp/run",
    prompt: "",
    schemaFile: "output.schema.json",
    log: "/tmp/log",
    binary: "/test/codex",
  });
  for (const name of CREDENTIAL_VARIABLES)
    expect(codex.env[name]).toBeUndefined();
  expect(Object.values(codex.env)).not.toContain("parent-key-must-not-leak");
  expect(Object.values(claude.env)).not.toContain("parent-key-must-not-leak");
  for (const [key, value] of [
    ["SSH_AUTH_SOCK", saved.sock],
    ["NEUVE_TEST_SECRET_TOKEN", saved.secret],
    ["ANTHROPIC_API_KEY", saved.apiKey],
    ["CLAUDE_CODE_OAUTH_TOKEN", saved.oauth],
  ] as const)
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
});

// Why: the queue policy and the lower-grade rule decide what the owner sees and what enters the
// gold unseen (9.36); a wrong branch would silently change both.
test("light-package queue and the lower-grade rule", async () => {
  const { buildQueue, DEV_POLICY, HELD_OUT_POLICY, lowerGrade } =
    await import("../src/retrieval-bench/labelling/adjudication.ts");
  expect(lowerGrade(["necessary", "useful"])).toBe("useful");
  expect(lowerGrade(["useful", "misleading"])).toBe("irrelevant");
  expect(lowerGrade(["misleading", "irrelevant"])).toBe("irrelevant");
  expect(lowerGrade(["misleading", "misleading"])).toBe("misleading");
  const pairs = [
    ["necessary", "useful"],
    ["necessary", "irrelevant"],
    ["useful", "irrelevant"],
    ["misleading", "irrelevant"],
    ["necessary", "necessary"],
    ["misleading", "misleading"],
    ["misleading", "misleading"],
    ...Array.from({ length: 10 }, () => ["irrelevant", "irrelevant"]),
  ] as const;
  const candidates = pairs.map((_, index) => ({
    id: `c${String(index + 1).padStart(3, "0")}`,
    type: "region" as const,
    path: "a.ts",
    startLine: index * 10 + 1,
    endLine: index * 10 + 5,
    kind: "code" as const,
    commit: null,
    historyTiming: null,
    rangeStatus: "committed" as const,
    changedBaseLines: 0,
    bestRank: 1,
    sources: [{ source: "L", rank: 1, startLine: 1, endLine: 5, ref: null }],
  }));
  const pool = {
    schemaVersion: 1 as const,
    caseId: "case",
    hunkId: "h",
    repository: "neuve" as const,
    base: "b",
    head: "h",
    depth: 50,
    arms: ["L"],
    candidates,
  };
  const grades = new Map(
    (["opus", "codex"] as const).map((labeller, side) => [
      labeller,
      new Map(
        candidates.map((c, index) => [c.id, pairs[index]![side]! as Grade]),
      ),
    ]),
  );
  const reasons = (policy: typeof DEV_POLICY) =>
    buildQueue({ split: "dev", pool, grades, additions: [], policy })
      .map((entry) => `${entry.reason}:${entry.candidateId}`)
      .sort();
  expect(reasons(DEV_POLICY)).toEqual([
    "disagreement:c001",
    "disagreement:c002",
  ]);
  const heldOut = reasons(HELD_OUT_POLICY);
  expect(heldOut.filter((r) => r.startsWith("disagreement"))).toEqual([
    "disagreement:c001",
    "disagreement:c002",
  ]);
  expect(heldOut.filter((r) => r.startsWith("both-irrelevant")).length).toBe(2);
  expect(heldOut.filter((r) => r.startsWith("agreed-misleading")).length).toBe(
    1,
  );
});

// Why: the held-out light package has the council set's numbers, so falling back to it would only
// rename the receipt's policy, and a changed dev default would silently resize the dev queue.
test("held-out always takes the council set; dev keeps its default unless asked", async () => {
  const { COUNCIL_POLICY, DEV_POLICY, queuePolicyFor } =
    await import("../src/retrieval-bench/labelling/adjudication.ts");
  expect(queuePolicyFor("held-out", undefined)).toBe(COUNCIL_POLICY);
  expect(queuePolicyFor("held-out", "council")).toBe(COUNCIL_POLICY);
  expect(queuePolicyFor("dev", undefined)).toBe(DEV_POLICY);
  expect(queuePolicyFor("dev", "council")).toBe(COUNCIL_POLICY);
});

// Why: a split filter that let the other split through would silently mix dev and held-out hunks
// in one run's pools, queue and exported gold; a partial held-out export would be scored once (9.58)
// with hunks silently missing.
test("a run refuses hunks outside its split and a partial held-out export", async () => {
  const { checkComplete, checkSplit, labellingSplit } =
    await import("../src/retrieval-bench/labelling/split.ts");
  expect(labellingSplit(undefined)).toEqual({ name: "dev", folder: "dev" });
  expect(labellingSplit("held-out")).toEqual({
    name: "held-out",
    folder: "heldout",
  });
  expect(() => labellingSplit("heldout")).toThrow("--split must be");
  expect(() => labellingSplit("toString")).toThrow("--split must be");
  const dev = { id: "a", split: "dev" };
  const heldOut = { id: "b", split: "held-out" };
  expect(checkSplit([heldOut], labellingSplit("held-out"))).toEqual([heldOut]);
  expect(() => checkSplit([dev, heldOut], labellingSplit("held-out"))).toThrow(
    "a is dev",
  );
  expect(() => checkSplit([dev, heldOut], labellingSplit("dev"))).toThrow(
    "b is held-out",
  );
  const heldOutSplit = labellingSplit("held-out");
  expect(() =>
    checkComplete(["c#h1", "c#h2"], new Set(["c#h1", "c#h2"]), heldOutSplit),
  ).not.toThrow();
  expect(() =>
    checkComplete(["c#h1", "c#h2", "d#h3"], new Set(["c#h1"]), heldOutSplit),
  ).toThrow("2 of 3 hunks missing: c#h2, d#h3");
});

// Why: 9.59 sets regions aside without failing the output, so dropping a text region, keeping a
// binary one or misreading numstat would silently change the gold and the addition ids.
test("labels drop regions on binary or line-less files, and only those (9.59)", async () => {
  const { rangeChanges, validateOutput } =
    await import("../src/retrieval-bench/labelling/validate.ts");
  const { collectAdditions } =
    await import("../src/retrieval-bench/labelling/adjudication.ts");
  // Plain, binary, renamed binary (old and new paths both count), renamed text, an added empty
  // file (no text hunk, still a change) and a deleted file.
  const numstat = [
    "1\t2\tsrc/a.ts",
    "-\t-\tpublic/icon.png",
    "-\t-\t",
    "old/logo.ico",
    "new/logo.ico",
    "3\t0\t",
    "old/b.ts",
    "new/b.ts",
    "0\t0\tsrc/new-empty.ts",
    "0\t7\tsrc/gone.ts",
    "",
  ].join("\0");
  const range = rangeChanges(numstat);
  expect([...range.binary].sort()).toEqual([
    "new/logo.ico",
    "old/logo.ico",
    "public/icon.png",
  ]);
  expect([...range.changed].sort()).toEqual([
    "new/b.ts",
    "new/logo.ico",
    "public/icon.png",
    "src/a.ts",
    "src/gone.ts",
    "src/new-empty.ts",
  ]);
  const binary = range.binary;
  const region = (
    source: "base" | "range-change",
    path: string,
    startLine: number | null,
  ) => ({
    source,
    path,
    startLine,
    endLine: startLine,
    heading: null,
    commit: null,
  });
  const item = (r: ReturnType<typeof region>, candidateIds: Array<string>) => ({
    candidateIds,
    added: candidateIds.length === 0,
    region: r,
    kind: "code" as const,
    grade: "necessary" as const,
    whyItApplies: "w",
    checkBeforeDeciding: "c",
    whyItMisleads: null,
    scopeTrace: "s",
    impliedRule: null,
    historyTiming: null,
  });
  const pool = {
    schemaVersion: 1 as const,
    caseId: "case",
    hunkId: "h",
    repository: "neuve" as const,
    base: "b",
    head: "h",
    depth: 50,
    arms: ["L"],
    candidates: [
      {
        id: "c001",
        type: "region" as const,
        path: "src/a.ts",
        startLine: 1,
        endLine: 5,
        kind: "code" as const,
        commit: null,
        historyTiming: null,
        rangeStatus: "committed" as const,
        changedBaseLines: 0,
        bestRank: 1,
        sources: [
          { source: "L", rank: 1, startLine: 1, endLine: 5, ref: null },
        ],
      },
    ],
  };
  const lines: Record<string, number> = {
    "src/a.ts": 40,
    "src/empty.ts": 0,
    "src/new-empty.ts": 0,
    "public/icon.png": 3,
    "new/logo.ico": 2,
  };
  const lookups = {
    baseLines: (path: string) => lines[path],
    // As cli.ts lookupsFor: a file the range changes gets its head line count; a deleted file has
    // no head version, so it stays undefined.
    rangeChangeLines: (path: string) =>
      range.changed.has(path) ? lines[path] : undefined,
    rangeDocLines: () => undefined,
    changedBaseLines: () => 0,
    changedHeadLines: () => 1,
    binaryInRange: (path: string) => binary.has(path),
    commitTiming: () => undefined,
  };
  const output = {
    caseId: "case",
    hunkId: "h",
    scope: { sources: [], stratum: "none" as const, gap: null },
    items: [
      item(region("base", "src/a.ts", 2), ["c001"]),
      item(region("range-change", "public/icon.png", null), []),
      item(region("range-change", "src/a.ts", 3), []),
      item(region("base", "new/logo.ico", 1), []),
      item(region("base", "src/empty.ts", 1), []),
      item(region("base", "src/a.ts", 10), []),
      item(region("range-change", "src/new-empty.ts", 1), []),
    ],
    irrelevant: [],
    notes: null,
  };
  const entry = { inRangeDocs: [] } as unknown as Parameters<
    typeof validateOutput
  >[2];
  const checked = validateOutput(output, pool, entry, lookups);
  expect(checked.errors).toEqual([]);
  expect(checked.items.map((i) => i.dropped)).toEqual([
    false,
    true,
    false,
    true,
    true,
    false,
    true,
  ]);
  expect(checked.warnings.filter((w) => w.includes("(9.59)"))).toEqual([
    "item 1: dropped, range-change region public/icon.png is on a binary file (9.59)",
    "item 3: dropped, base region new/logo.ico is on a binary file (9.59)",
    "item 4: dropped, base region src/empty.ts is on a file with no lines (9.59)",
    "item 6: dropped, range-change region src/new-empty.ts is on a file with no lines (9.59)",
  ]);
  // Addition ids keep the output's numbering across dropped items.
  expect(
    collectAdditions(new Map([["codex", checked.items]])).map((a) => a.id),
  ).toEqual(["codex-a2", "codex-a5"]);
  // A line-less region on a text file is still an error.
  const textual = validateOutput(
    {
      ...output,
      items: [output.items[0]!, item(region("base", "src/a.ts", null), [])],
    },
    pool,
    entry,
    lookups,
  );
  expect(textual.errors).toEqual(["item 1: base region needs path and lines"]);
  // A region on a deleted file is still an error, not a drop.
  const deleted = validateOutput(
    {
      ...output,
      items: [
        output.items[0]!,
        item(region("range-change", "src/gone.ts", 1), []),
      ],
    },
    pool,
    entry,
    lookups,
  );
  expect(deleted.errors).toEqual([
    "item 1: src/gone.ts is not a file the range changes",
  ]);
});

// Why: a verdict landing on the wrong item, or a mapping that reveals the family, would silently
// corrupt the owner's gold or bias the adjudication.
test("owner verdicts map only to exported items, and sides are a seeded coin flip", async () => {
  const { blindSides, decisionsFor, itemId } =
    await import("../src/retrieval-bench/labelling/owner.ts");
  const keys = ["case/h/c001", "case/h/c002", "case/h/opus-a1"];
  const decided = decisionsFor(
    {
      decidedBy: "owner",
      decidedAt: "2026-10-18T12:00:00+02:00",
      verdicts: [{ id: itemId(keys[0]!), grade: "useful", note: "close call" }],
    },
    keys,
  );
  expect(decided.get(keys[0]!)).toEqual({
    grade: "useful",
    note: "close call",
    decidedBy: "owner",
    decidedAt: "2026-10-18T12:00:00+02:00",
  });
  expect(() =>
    decisionsFor(
      {
        decidedBy: "owner",
        verdicts: [{ id: itemId("other"), grade: "useful" }],
      },
      keys,
    ),
  ).toThrow("unknown item id");
  const twice = { id: itemId(keys[1]!), grade: "irrelevant" };
  expect(() =>
    decisionsFor({ decidedBy: "owner", verdicts: [twice, twice] }, keys),
  ).toThrow("two verdicts");
  const sides = Array.from(
    { length: 40 },
    (_, i) => blindSides(itemId(`k${i}`)).A,
  );
  expect(new Set(sides)).toEqual(new Set(["opus", "codex"]));
  expect(blindSides(itemId("k1"))).toEqual(blindSides(itemId("k1")));
});

// Why: a briefing that proposes a grade would anchor the owner (9.38); the guard must refuse it.
test("briefings that use a grade word are refused", async () => {
  const { checkBriefing } =
    await import("../src/retrieval-bench/labelling/briefing.ts");
  const briefing = {
    change: "Adds a height argument to the preset lookup.",
    relation: {
      kind: "is-called-by" as const,
      text: "The region calls the lookup.",
    },
    lines: [{ lines: "12-14", note: "passes width and height" }],
    questions: ["Can you confirm landscape phones still map to a preset?"],
  };
  expect(checkBriefing(briefing)).toEqual(briefing);
  expect(() =>
    checkBriefing({
      ...briefing,
      questions: ["Is this region Necessary here?"],
    }),
  ).toThrow("grade word");
  expect(() => checkBriefing({ ...briefing, lines: [] })).toThrow();
});

// Why: the gold must take the final grade while the blind first grade is kept (9.38); swapping
// them would silently undo the decide-then-reveal protocol.
test("blind-pass decisions keep the first grade and give the gold the final grade", async () => {
  const { blindVerdicts, decisionsFor, itemId } =
    await import("../src/retrieval-bench/labelling/owner.ts");
  const key = "case/h/c001";
  const decided = decisionsFor(
    blindVerdicts(
      [
        {
          batch: "pilot",
          item: itemId(key),
          firstGrade: "useful",
          finalGrade: "necessary",
          note: "",
          firstAt: "2026-10-18T13:30:00.000Z",
          decidedAt: "2026-10-18T13:31:00.000Z",
        },
      ],
      "owner (blind pass, 9.38)",
    ),
    [key],
  );
  expect(decided.get(key)).toEqual({
    grade: "necessary",
    firstGrade: "useful",
    firstAt: "2026-10-18T13:30:00.000Z",
    decidedAt: "2026-10-18T13:31:00.000Z",
    decidedBy: "owner (blind pass, 9.38)",
    batch: "pilot",
    note: null,
  });
});

// Why: the council must show labellers in the page's order, decide only on three of four, and keep
// members anonymous; each of these could break without any visible error (9.52).
test("council order, majority and anonymity", async () => {
  const { fnv1a, majority, memberLabels, MEMBERS, scrub } =
    await import("../src/retrieval-bench/labelling/council.ts");
  // FNV-1a 32-bit reference values, as the page computes them.
  expect(fnv1a("")).toBe(2166136261);
  expect(fnv1a("a")).toBe(0xe40c292c);
  expect(majority(["useful", "useful", "useful", "necessary"])).toBe("useful");
  expect(majority(["useful", "useful", "necessary", "necessary"])).toBeNull();
  expect(majority(["unsure", "unsure", "unsure", "useful"])).toBeNull();
  const ids = MEMBERS.map((member) => member.id).sort();
  const a = memberLabels("q-1", "opus-high", 1);
  expect([...a].sort()).toEqual(ids);
  const views = new Set(
    MEMBERS.map((member) => memberLabels("q-1", member.id, 1).join(",")),
  );
  expect(views.size).toBeGreaterThan(1);
  expect(scrub("As Claude I think GPT-6.1-Sol and Codex agree").text).toBe(
    "As [model] I think [model] and [model] agree",
  );
});

// Why: the gold must record how each item was resolved (9.53); a council decision that silently
// read as an owner decision, or lost its round and votes, would misreport the gold's provenance.
test("gold records council decisions with round and votes", async () => {
  const { resolveGold } =
    await import("../src/retrieval-bench/labelling/adjudication.ts");
  const candidate = {
    id: "c001",
    type: "region" as const,
    path: "a.ts",
    startLine: 1,
    endLine: 5,
    kind: "code" as const,
    commit: null,
    historyTiming: null,
    rangeStatus: "committed" as const,
    changedBaseLines: 0,
    bestRank: 1,
    sources: [{ source: "L", rank: 1, startLine: 1, endLine: 5, ref: null }],
  };
  const pool = {
    schemaVersion: 1 as const,
    caseId: "case",
    hunkId: "h",
    repository: "neuve" as const,
    base: "b",
    head: "h",
    depth: 50,
    arms: ["L"],
    candidates: [
      candidate,
      { ...candidate, id: "c002", startLine: 10, endLine: 12 },
    ],
  };
  const grades = new Map<string, Map<string, Grade>>([
    [
      "opus",
      new Map<string, Grade>([
        ["c001", "useful"],
        ["c002", "useful"],
      ]),
    ],
    [
      "codex",
      new Map<string, Grade>([
        ["c001", "necessary"],
        ["c002", "irrelevant"],
      ]),
    ],
  ]);
  const votes = [
    {
      round: 0,
      votes: { a: "necessary", b: "necessary", c: "necessary", d: "useful" },
    },
  ];
  const gold = resolveGold(
    pool,
    grades,
    [],
    new Set(["case/h/c001"]),
    new Map([
      [
        "case/h/c001",
        {
          grade: "necessary" as const,
          note: null,
          decidedBy: "council (9.53)",
          decidedAt: "2026-10-18T00:00:00Z",
          council: { round: 0, votes },
        },
      ],
    ]),
  );
  expect(gold.find((g) => g.id === "c001")).toMatchObject({
    grade: "necessary",
    status: "council-decided",
    owner: { council: { round: 0, votes } },
  });
  // 9.56: a re-run tie resolved by the lower-grade rule is recorded as such, not as a council grade.
  const tied = resolveGold(
    pool,
    grades,
    [],
    new Set(["case/h/c001"]),
    new Map([
      [
        "case/h/c001",
        {
          grade: "useful" as const,
          note: null,
          decidedBy: "council tie rule (9.56)",
          decidedAt: "2026-10-19T00:00:00Z",
          council: { tieRule: true, round: 3, votes },
        },
      ],
    ]),
  );
  expect(tied.find((g) => g.id === "c001")).toMatchObject({
    grade: "useful",
    status: "council-tie-rule",
  });
  expect(gold.find((g) => g.id === "c002")).toMatchObject({
    grade: "irrelevant",
    status: "lower-grade",
  });
});

// Why: on 18 October a usage limit turned failed member calls into "unsure" votes and fake ties.
// This drives the council loop itself with a fake model: if the loop ever records a failed step as
// a vote again, the item completes and this test fails. It also checks that no sibling step is left
// running when the item stops (6.10).
test("a failed council step stops the item instead of voting unsure", async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { runCouncilItem, CouncilItemIncomplete } =
    await import("../src/retrieval-bench/labelling/council-run.ts");
  const { MEMBERS } =
    await import("../src/retrieval-bench/labelling/council.ts");
  const { isLimitFailure } =
    await import("../src/retrieval-bench/labelling/credentials.ts");
  expect(
    isLimitFailure("exit 1: You've hit your weekly limit · resets Oct 23"),
  ).toBe(true);
  expect(isLimitFailure("exit 1: schema mismatch")).toBe(false);
  const root = mkdtempSync(join(tmpdir(), "council-test-"));
  const item = {
    id: "q-000000000001",
    caseId: "case",
    hunkId: "h",
    hunkPath: "a.ts",
    commitSubject: "change",
    hunkDiff: "@@ -1 +1 @@\n-a\n+b",
    region: "a.ts:1-2",
    kind: "code",
    regionContext: { text: ">    1  a", truncated: false },
    links: [],
    scope: { source: "commit text", heading: null, text: "change" },
    commitText: "change",
    briefing: null,
    A: {
      role: "labeller",
      grade: "useful",
      whyItApplies: "x",
      checkBeforeDeciding: "y",
      whyItMisleads: null,
    },
    B: {
      role: "labeller",
      grade: "necessary",
      whyItApplies: "x",
      checkBeforeDeciding: "y",
      whyItMisleads: null,
    },
  };
  const answers: Record<string, unknown> = {
    blind: { grade: "useful", reason: "r" },
    reveal: { decision: "keep", grade: "useful", reason: "r" },
    investigation: { grade: "useful", reasons: "r", evidence: [] },
  };
  const receipt = (note: string | null) => ({
    caseId: "case",
    hunkId: "h",
    role: "adjudicator" as const,
    route: "claude-print" as const,
    model: "m",
    effort: null,
    wallSeconds: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: null,
    totalTokens: 0,
    toolCalls: 0,
    apiEquivalentUsd: 0,
    outsideReads: [],
    credentialRoute: null,
    credentialVariable: null,
    note,
  });
  const run = async (failing: string | null) => {
    let running = 0;
    let finishedAfterFailure = 0;
    let failed = false;
    const context = {
      members: MEMBERS,
      snapshot: root,
      packet: root,
      logs: join(root, `logs-${failing}`),
      runsRoot: root,
      memberDir: (memberId: string) => {
        const dir = join(root, `${failing}-${memberId}`);
        mkdirSync(dir, { recursive: true });
        return dir;
      },
      runStep: async (request: {
        state: { member: { id: string }; dir: string };
        name: string;
      }) => {
        running++;
        await new Promise((done) =>
          setTimeout(done, request.state.member.id === failing ? 1 : 20),
        );
        running--;
        if (failed) finishedAfterFailure++;
        if (
          request.state.member.id === failing &&
          request.name === "investigation"
        ) {
          failed = true;
          return receipt("exit 1: You've hit your weekly limit");
        }
        writeFileSync(
          join(request.state.dir, "output.json"),
          JSON.stringify(answers[request.name]),
        );
        return receipt(null);
      },
    };
    try {
      const result = await runCouncilItem(item as never, context as never);
      return { result, error: null, running, finishedAfterFailure };
    } catch (error) {
      return { result: null, error, running, finishedAfterFailure };
    }
  };
  const ok = await run(null);
  expect(ok.result?.councilGrade).toBe("useful");
  const stopped = await run("opus-high");
  expect(stopped.result).toBeNull();
  expect(stopped.error).toBeInstanceOf(CouncilItemIncomplete);
  expect(
    (stopped.error as InstanceType<typeof CouncilItemIncomplete>).limit,
  ).toBe(true);
  // The three siblings' investigation steps were awaited, not orphaned.
  expect(stopped.running).toBe(0);
  expect(stopped.finishedAfterFailure).toBe(3);
  expect(
    (stopped.error as InstanceType<typeof CouncilItemIncomplete>).receipts
      .length,
  ).toBe(4 * 2 + 4);
});

// Why: a packet that carried the listing's key, ids or note, or anything from the check's results,
// would silently prime the reviewers (9.65, 2.16); nothing downstream could tell.
test("later-fix packets hold only git material located by the listing", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Effect } = await import("effect");
  const { buildPacket, packetLeaks } =
    await import("../src/retrieval-bench/labelling/later-fixes/packet.ts");
  const repo = mkdtempSync(join(tmpdir(), "later-fix-test-"));
  const git = (...args: Array<string>) => {
    const result = Bun.spawnSync(["git", "-C", repo, ...args], {
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString().trim();
  };
  git("init", "-q");
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  writeFileSync(join(repo, "a.ts"), `${lines.join("\n")}\n`);
  git("add", "a.ts");
  git("commit", "-q", "-m", "reviewed change");
  const head = git("rev-parse", "HEAD");
  lines[11] = "line 12 fixed";
  writeFileSync(join(repo, "a.ts"), `${lines.join("\n")}\n`);
  git("commit", "-q", "-am", "fix line twelve");
  const commit = git("rev-parse", "HEAD");
  const listed = {
    key: "h-0000feedbeef:c901",
    caseId: "neuve:aaaa..bbbb",
    hunkId: "h-0000feedbeef",
    itemId: "c901",
    commit,
    path: "a.ts",
    hunkLines: [10, 14] as [number, number],
    headLinesChanged: [12],
    touches: true,
    note: "a private note from the listing",
  };
  const packet = await Effect.runPromise(buildPacket(repo, { head }, listed));
  expect(packetLeaks(packet.text, listed)).toEqual([]);
  expect(packet.text).toContain("fix line twelve");
  expect(packet.text).toContain("> 12 | line 12");
  expect(packet.text).toMatch(/◆ +12 +-line 12/);
  expect(packet.marked).toBe(2);
  // The same packet whatever the listing's other fields say.
  const other = await Effect.runPromise(
    buildPacket(repo, { head }, { ...listed, note: "x", key: "y" } as never),
  );
  expect(other.text).toBe(packet.text);
  // The check itself fires on each kind of leak.
  expect(
    packetLeaks(
      `${listed.key} ${listed.note} see results/full-test/x and c901.`,
      listed,
    ).sort(),
  ).toEqual(["hunkId", "itemId", "key", "note", "results folder"]);
});

// Why: the rule decides the answer key every climb is measured against; a wrong majority, a tie
// that skipped deliberation, an owner opinion that counted, or a failed step turned into "unsure"
// would silently change it.
test("later-fix reviewers: two of three decide, a split deliberates once, the owner never votes", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { decide, reviewItem, PANELS } =
    await import("../src/retrieval-bench/labelling/later-fixes/review.ts");
  const { CouncilItemIncomplete } =
    await import("../src/retrieval-bench/labelling/council-run.ts");
  expect(decide(["fix", "fix", "not-a-fix"], 2)).toBe("fix");
  expect(decide(["unsure", "unsure", "fix"], 2)).toBe("unsure");
  expect(decide(["fix", "not-a-fix", "unsure"], 2)).toBeNull();
  const root = mkdtempSync(join(tmpdir(), "later-fix-review-"));
  const receipt = (note: string | null) => ({
    caseId: "c",
    hunkId: "h",
    role: "later-fix-reviewer" as const,
    route: "claude-print" as const,
    model: "m",
    effort: "default",
    wallSeconds: 1,
    inputTokens: 1,
    cachedInputTokens: 0,
    outputTokens: 1,
    reasoningTokens: null,
    totalTokens: 2,
    toolCalls: 0,
    apiEquivalentUsd: null,
    outsideReads: [],
    credentialRoute: null,
    credentialVariable: null,
    note,
  });
  const run = async (
    name: string,
    answers: Record<string, Array<string>>,
    owner: { answer: "unsure"; note: string } | null,
    failing: string | null = null,
  ) => {
    const seen: Record<string, string> = {};
    const result = await reviewItem(
      {
        id: `lf-${name}`,
        key: name,
        caseId: "c",
        hunkId: "h",
        packet: "# packet",
        owner,
      },
      {
        panel: PANELS["9.65"],
        logs: join(root, name, "logs"),
        reviewerDir: (id) => {
          const dir = join(root, name, id);
          mkdirSync(dir, { recursive: true });
          return dir;
        },
        runStep: async (request) => {
          const id = request.state.member.id;
          if (request.name === "deliberation")
            seen[id] = readFileSync(
              join(request.state.dir, "deliberation.md"),
              "utf8",
            );
          if (id === failing) return receipt("exit 1: no output");
          const answer = answers[id]![request.name === "round-0" ? 0 : 1]!;
          writeFileSync(
            join(request.state.dir, "output.json"),
            JSON.stringify(
              request.name === "round-0"
                ? { answer, reason: `round zero: ${answer}` }
                : {
                    critique: "c",
                    answer,
                    reason: `after deliberation: ${answer}`,
                  },
            ),
          );
          return receipt(null);
        },
      },
    ).catch((error: unknown) => error);
    return { result, seen };
  };
  const majority = await run(
    "m",
    {
      opus: ["fix"],
      "sol-medium": ["fix"],
      "sol-high": ["not-a-fix"],
    },
    null,
  );
  expect((majority.result as { answer: string }).answer).toBe("fix");
  expect((majority.result as { decidedIn: string }).decidedIn).toBe("round-0");
  expect(Object.keys(majority.seen)).toEqual([]);
  // A three-way split deliberates once; the owner's opinion is shown, never counted.
  const split = await run(
    "s",
    {
      opus: ["fix", "fix"],
      "sol-medium": ["not-a-fix", "not-a-fix"],
      "sol-high": ["unsure", "fix"],
    },
    { answer: "unsure", note: "hard to judge from here" },
  );
  const decided = split.result as {
    answer: string;
    decidedIn: string;
    votes: Array<unknown>;
    owner: { counted: boolean; shownInDeliberation: boolean };
  };
  expect(decided.answer).toBe("fix");
  expect(decided.decidedIn).toBe("deliberation");
  expect(decided.votes.length).toBe(2);
  expect(decided.owner).toMatchObject({
    counted: false,
    shownInDeliberation: true,
  });
  for (const text of Object.values(split.seen)) {
    expect(text).toContain("hard to judge from here");
    // Labels only: no reviewer id, family or the owner is named.
    expect(text).not.toMatch(/opus|sol-|owner/i);
    expect(text.match(/\(you\)/g)?.length).toBe(1);
    expect(text.match(/## Reviewer \d/g)?.length).toBe(4);
  }
  // Still split after deliberation: unsure, even with the owner on one side.
  const still = await run(
    "u",
    {
      opus: ["fix", "fix"],
      "sol-medium": ["not-a-fix", "not-a-fix"],
      "sol-high": ["unsure", "unsure"],
    },
    { answer: "unsure", note: "n" },
  );
  expect((still.result as { answer: string }).answer).toBe("unsure");
  expect((still.result as { decidedIn: string }).decidedIn).toBe("still-split");
  const stillTwo = await run(
    "o",
    {
      opus: ["fix", "fix"],
      "sol-medium": ["not-a-fix", "not-a-fix"],
      "sol-high": ["unsure", "not-a-fix"],
    },
    { answer: "unsure", note: "n" },
  );
  expect((stillTwo.result as { answer: string }).answer).toBe("not-a-fix");
  // A failed step stops the item; it is never recorded as unsure.
  const failed = await run(
    "f",
    { opus: ["fix"], "sol-medium": ["fix"], "sol-high": ["fix"] },
    null,
    "sol-high",
  );
  expect(failed.result).toBeInstanceOf(CouncilItemIncomplete);
});

// Why: an over-marked diff silently points reviewers at a change the reviewed lines never had (the
// rejected first run marked whole context-merged blocks); nothing downstream would notice.
test("later-fix diffs mark only the changes that touched the reviewed lines", async () => {
  const { markedDiff } =
    await import("../src/retrieval-bench/labelling/later-fixes/packet.ts");
  // Two separate changes four lines apart: the printed diff merges them into one block.
  const printed = [
    "@@ -9,11 +9,12 @@",
    " line 9",
    " line 10",
    "-line 11",
    "+line 11 fixed",
    " line 12",
    " line 13",
    " line 14",
    " line 15",
    "+added nearby",
    " line 16",
    " line 17",
    " line 18",
    "",
  ].join("\n");
  const zeroContext = [
    "@@ -11 +11 @@",
    "-line 11",
    "+line 11 fixed",
    "@@ -15,0 +16 @@",
    "+added nearby",
    "",
  ].join("\n");
  const marked = (touched: Array<number>) =>
    markedDiff(printed, zeroContext, new Set(touched));
  const first = marked([11]);
  expect(first.marked).toBe(2);
  expect(first.touching).toBe(1);
  expect(first.text).toMatch(/◆ +11 +-line 11/);
  expect(first.text).toMatch(/◆ +11 \+line 11 fixed/);
  expect(first.text).not.toMatch(/◆.*added nearby/);
  // An insertion touches the line it follows.
  const second = marked([15]);
  expect(second.marked).toBe(1);
  expect(second.text).toMatch(/◆ +16 \+added nearby/);
  // A context line near a change marks nothing.
  expect(marked([13]).marked).toBe(0);
});

// Why: 9.66's panel is the climbs' answer key; a 3-of-4 rule that let two votes decide, a 2–2 split
// that skipped deliberation or stopped early, or a panel with unequal family seats would silently
// change it.
test("9.66 panel: two seats per family, three of four decide, a 2–2 split deliberates to the limit", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { checkPanel, decide, familyCounts, PANELS, reviewItem, round0Prompt } =
    await import("../src/retrieval-bench/labelling/later-fixes/review.ts");
  const { MAX_ROUNDS } =
    await import("../src/retrieval-bench/labelling/council.ts");
  const panel = PANELS["9.66"];
  expect(familyCounts(panel.reviewers)).toEqual({ opus: 2, codex: 2 });
  expect(panel.needed).toBe(3);
  expect(panel.maxRounds).toBe(MAX_ROUNDS);
  expect(() =>
    checkPanel({
      ...panel,
      reviewers: [
        ...panel.reviewers.slice(0, 3),
        { id: "opus-x", family: "opus", effort: null },
      ],
    }),
  ).toThrow("equal seats");
  expect(() => checkPanel({ ...panel, needed: 2 })).toThrow("not a majority");
  expect(round0Prompt(panel)).toContain("Try to disprove");
  expect(round0Prompt(PANELS["9.65"])).not.toContain("disprove");
  expect(decide(["fix", "fix", "fix", "not-a-fix"], 3)).toBe("fix");
  expect(decide(["fix", "fix", "not-a-fix", "not-a-fix"], 3)).toBeNull();
  expect(decide(["fix", "fix", "not-a-fix", "unsure"], 3)).toBeNull();
  const root = mkdtempSync(join(tmpdir(), "later-fix-panel-"));
  const receipt = {
    caseId: "c",
    hunkId: "h",
    role: "later-fix-reviewer" as const,
    route: "codex-exec" as const,
    model: "m",
    effort: "high",
    wallSeconds: 1,
    inputTokens: 1,
    cachedInputTokens: 0,
    outputTokens: 1,
    reasoningTokens: null,
    totalTokens: 2,
    toolCalls: 0,
    apiEquivalentUsd: null,
    outsideReads: [],
    credentialRoute: null,
    credentialVariable: null,
    note: null,
  };
  // Each reviewer's answer per round (round 0 first); the last entry repeats.
  const run = async (name: string, answers: Record<string, Array<string>>) => {
    const steps: Array<string> = [];
    const result = await reviewItem(
      {
        id: `lf-${name}`,
        key: name,
        caseId: "c",
        hunkId: "h",
        packet: "# p",
        owner: { answer: "unsure", note: "n" },
      },
      {
        panel,
        logs: join(root, name, "logs"),
        reviewerDir: (id) => {
          const dir = join(root, name, id);
          mkdirSync(dir, { recursive: true });
          return dir;
        },
        runStep: async (request) => {
          steps.push(`${request.state.member.id}:${request.name}`);
          const list = answers[request.state.member.id]!;
          const round =
            request.name === "round-0"
              ? 0
              : Number(request.name.split("-")[1] ?? 1);
          const answer = list[Math.min(round, list.length - 1)]!;
          writeFileSync(
            join(request.state.dir, "output.json"),
            JSON.stringify(
              round === 0
                ? { answer, reason: "r" }
                : { critique: "c", answer, reason: "r" },
            ),
          );
          return receipt;
        },
      },
    );
    return { result, steps };
  };
  const three = await run("three", {
    "opus-default": ["fix"],
    "opus-high": ["not-a-fix"],
    "sol-medium": ["fix"],
    "sol-high": ["fix"],
  });
  expect(three.result.answer).toBe("fix");
  expect(three.result.decidedIn).toBe("round-0");
  expect(three.steps.length).toBe(4);
  // 2–2 moves to 3–1 in round 2.
  const moved = await run("moved", {
    "opus-default": ["fix"],
    "opus-high": ["not-a-fix", "not-a-fix", "fix"],
    "sol-medium": ["fix"],
    "sol-high": ["not-a-fix"],
  });
  expect(moved.result.answer).toBe("fix");
  expect(moved.result.decidedIn).toBe("deliberation");
  expect(moved.result.votes.length).toBe(3);
  expect(moved.result.owner).toMatchObject({
    counted: false,
    shownInDeliberation: true,
  });
  // A 2–2 that survives every round is unsure, after exactly the round limit.
  const split = await run("split", {
    "opus-default": ["fix"],
    "opus-high": ["fix"],
    "sol-medium": ["not-a-fix"],
    "sol-high": ["not-a-fix"],
  });
  expect(split.result.answer).toBe("unsure");
  expect(split.result.decidedIn).toBe("still-split");
  expect(split.result.votes.length).toBe(1 + MAX_ROUNDS);
  expect(split.steps.length).toBe(4 * (1 + MAX_ROUNDS));
});

// Why: a hung model step that slipped through as an answer (a partial output.json left behind) or
// never ended would silently corrupt a vote or stall a run; the bound must turn it into a failed step.
test("a hung model step is killed at its bound and becomes a failed step, never an answer", async () => {
  const { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { runBounded, runCodex } =
    await import("../src/retrieval-bench/labelling/routes.ts");
  const { isLimitFailure } =
    await import("../src/retrieval-bench/labelling/credentials.ts");
  const root = mkdtempSync(join(tmpdir(), "hung-step-"));
  // A process group with a child that would outlive a plain kill.
  const bounded = await runBounded(["sh", "-c", "sleep 30 & sleep 30; wait"], {
    cwd: root,
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
    stdin: "",
    timeoutMs: 300,
  });
  expect(bounded.timedOut).toBe(true);
  expect(bounded.wallSeconds).toBeLessThan(5);
  // A fake Codex that writes an answer, then hangs.
  const fake = join(root, "codex");
  writeFileSync(
    fake,
    [
      "#!/bin/sh",
      'out=""; prev=""',
      'for a in "$@"; do [ "$prev" = "--output-last-message" ] && out="$a"; prev="$a"; done',
      'echo \'{"answer":"fix","reason":"partial"}\' > "$out"',
      "sleep 30",
      "",
    ].join("\n"),
  );
  chmodSync(fake, 0o755);
  writeFileSync(join(root, "verdict.schema.json"), "{}");
  const receipt = await runCodex(
    {
      runDir: root,
      prompt: "the prompt",
      schemaFile: "verdict.schema.json",
      log: join(root, "step.jsonl"),
      allowed: [],
      timeoutMs: 300,
      binary: fake,
    },
    { caseId: "c", hunkId: "h", role: "later-fix-reviewer" },
  );
  expect(existsSync(join(root, "output.json"))).toBe(false);
  expect(receipt.note).toMatch(/^timed out after \d+s; process group killed$/);
  expect(isLimitFailure(receipt.note!)).toBe(false);
  // The step's prompt is kept in a prompts/ folder beside its log, with a sha256 header.
  const kept = readFileSync(
    join(root, "prompts", "step.jsonl.prompt.txt"),
    "utf8",
  );
  expect(kept).toMatch(/^sha256: [0-9a-f]{64}\n\nthe prompt$/);
});

// Why: a prompt file among the receipts broke every strict receipt reader (judge, export, telemetry)
// on the next labelling round; the readers list receipts/*.json and must still parse.
test("kept prompts never sit where receipt readers look", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readdirSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { writePrompt } =
    await import("../src/retrieval-bench/labelling/routes.ts");
  const { buildTelemetry } =
    await import("../src/retrieval-bench/labelling/telemetry.ts");
  const root = mkdtempSync(join(tmpdir(), "prompt-place-"));
  const hunk = join(root, "hunks", "case", "h-1");
  const receipts = join(hunk, "receipts");
  mkdirSync(receipts, { recursive: true });
  const log = join(receipts, "labeller-opus.opus.jsonl");
  writeFileSync(log, "");
  writePrompt(log, "a prompt");
  writeFileSync(
    join(receipts, "labeller-opus.json"),
    JSON.stringify({
      caseId: "case",
      hunkId: "h-1",
      role: "labeller",
      route: "claude-print",
      model: "m",
      effort: "default",
      wallSeconds: 1,
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      reasoningTokens: null,
      totalTokens: 2,
      toolCalls: 0,
      apiEquivalentUsd: 0.1,
      outsideReads: [],
      credentialRoute: "subscription-token",
      credentialVariable: "CLAUDE_CODE_OAUTH_TOKEN",
      note: null,
    }),
  );
  expect(readdirSync(receipts).filter((f) => f.endsWith(".json"))).toEqual([
    "labeller-opus.json",
  ]);
  mkdirSync(join(root, "council"));
  const telemetry = buildTelemetry({
    hunkDirs: [hunk],
    briefingsDir: join(root, "briefings"),
    councilDir: join(root, "council"),
    logsDir: root,
    logPrefix: "dev",
    auditFile: join(root, "none.json"),
  });
  expect(telemetry.stages.labelling.runs).toBe(1);
});

// Why: model processes run in their own process groups, so a Ctrl-C or kill of the CLI would leave
// them running unbounded, free to write an answer into a reused run folder.
test("a dying CLI takes its live model process groups with it", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "live-groups-"));
  const script = join(root, "cli.ts");
  const routes = resolve(
    import.meta.dir,
    "../src/retrieval-bench/labelling/routes.ts",
  );
  writeFileSync(
    script,
    [
      `import { liveProcessGroups, runBounded } from ${JSON.stringify(routes)};`,
      `void runBounded(["sh", "-c", "sleep 60 & sleep 60; wait"], { cwd: ${JSON.stringify(root)}, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdin: "", timeoutMs: 120_000 });`,
      "await Bun.sleep(300);",
      "console.log(JSON.stringify([...liveProcessGroups()]));",
      "await Bun.sleep(60_000);",
    ].join("\n"),
  );
  const alive = (pid: number) => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    const cli = Bun.spawn(["bun", script], { stdout: "pipe", stderr: "pipe" });
    const reader = cli.stdout.getReader();
    let text = "";
    while (!text.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    const groups = JSON.parse(text.trim()) as Array<number>;
    expect(groups.length).toBe(1);
    expect(alive(groups[0]!)).toBe(true);
    cli.kill(signal);
    await cli.exited;
    await Bun.sleep(100);
    expect(alive(groups[0]!)).toBe(false);
  }
});

// Why: labelling and the replay judge take Codex only from the explicit setting; unset, they must
// say what to set instead of falling back to a written path.
test("an unset NEUVE_CODEX_BINARY names the setting and looks nothing up", async () => {
  const { codexBinary, codexCommand } =
    await import("../src/retrieval-bench/labelling/routes.ts");
  const saved = process.env["NEUVE_CODEX_BINARY"];
  delete process.env["NEUVE_CODEX_BINARY"];
  try {
    const message =
      "Set NEUVE_CODEX_BINARY to the absolute path of the Codex program to run: Neuve does not look one up";
    expect(() => codexBinary()).toThrow(message);
    expect(() =>
      codexCommand({
        runDir: "/tmp/run",
        prompt: "",
        schemaFile: "output.schema.json",
        log: "/tmp/log",
      }),
    ).toThrow(message);
    process.env["NEUVE_CODEX_BINARY"] = "/test/codex";
    expect(codexBinary()).toBe("/test/codex");
  } finally {
    if (saved === undefined) delete process.env["NEUVE_CODEX_BINARY"];
    else process.env["NEUVE_CODEX_BINARY"] = saved;
  }
});
