// Why: parity (10.141) is about to be climbed on concerns caught, so the scoring must be checked both
// ways before any miss is analysed. A concern's standing must follow the matcher's own rule (two of
// three passes); the sample must draw from every source and era; the judge must never see the
// matcher's call, a matched concern must be judged on its pairs alone, and a missed one on Neuve's
// nearby and owning-unit items, a split one with its pair always, and the sample's shares read back by
// each stratum's population. Then a miss's facts must come from the run's own record of what it was
// served, unknown when that record is, with a cut-off and a shown cap each told apart from a choice
// not to look.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PacketLite } from "../src/harness-compare/full-test/packets.ts";
import { hunkLine } from "../../harness/src/lookups.ts";
import type { BlindItem, BlindPass } from "../src/pr-replay/matching.ts";
import {
  MatchCheckItem,
  NEARBY_LINES,
  concernStandings,
  laterChangeOf,
  matchCheckItem,
  matchCheckReport,
  missCauseItem,
  missCauseReport,
  missFacts,
  reportMatchCheck,
  servedRanges,
  stratifiedSample,
  weightedShare,
} from "../src/pr-replay/parity.ts";
import {
  RUBRICS,
  decideRubric,
  rubricOfItems,
} from "../src/pr-replay/rubric-judge.ts";

const item = (
  id: string,
  source: "neuve" | "reviewer",
  ref: string,
  line: number,
  text = id,
  path = "a.js",
): BlindItem => ({
  id,
  source,
  group: source === "reviewer" ? "reviewer" : "comment",
  ref,
  repeats: [],
  path,
  line,
  side: "new",
  anchoredTo: "line",
  text,
});
const pass = (pairs: Array<[string, string]>): BlindPass => ({
  comments: pairs.map(([id, other]) => ({
    id,
    holds: "plausible",
    sameAs: [other],
    rationale: "",
  })),
  verdicts: [],
});

const key = {
  items: [
    item("r1", "reviewer", "t1", 10),
    item("r2", "reviewer", "t2", 40),
    item("r3", "reviewer", "t3", 70),
    item("r4", "reviewer", "t4", 90),
    item("n1", "neuve", "b1.u1#comment-1", 10),
    item("n2", "neuve", "b1.u1#comment-2", 42),
    item("n3", "neuve", "b1.u2#comment-1", 200),
  ],
};

test("a concern is matched by two passes, split by one, and missed by none; reviewer pairs never count", () => {
  const rows = concernStandings(
    key,
    [
      pass([
        ["r1", "n1"],
        ["r2", "n2"],
        ["r3", "r4"],
      ]),
      pass([["n1", "r1"]]),
      null,
    ],
    new Set(["t1", "t2", "t3"]),
  );
  expect(rows.map((row) => [row.ref, row.standing])).toEqual([
    ["t1", "matched"],
    ["t2", "split"],
    ["t3", "missed"],
  ]);
  expect(rows[0]!.matchedWith.map((one) => one.id)).toEqual(["n1"]);
  expect(rows[1]!.splitWith.map((one) => one.id)).toEqual(["n2"]);
});

test("the sample takes each quota a stratum at a time, the same way for the same seed", () => {
  const rows = [
    ...Array.from({ length: 10 }, (_, at) => ({
      standing: "missed" as const,
      stratum: "go|2026",
      at,
    })),
    ...Array.from({ length: 2 }, (_, at) => ({
      standing: "missed" as const,
      stratum: "react|pre-2022",
      at,
    })),
    { standing: "matched" as const, stratum: "go|2026", at: 0 },
  ];
  const sample = stratifiedSample(rows, { missed: 4, split: 3, matched: 5 }, 7);
  const missed = sample.filter((row) => row.standing === "missed");
  expect(missed).toHaveLength(4);
  expect(missed.filter((row) => row.stratum === "react|pre-2022")).toHaveLength(
    2,
  );
  expect(sample.filter((row) => row.standing === "matched")).toHaveLength(1);
  expect(
    stratifiedSample(rows, { missed: 4, split: 3, matched: 5 }, 7),
  ).toEqual(sample);
});

const diffs = [
  { name: "r0-r1", text: "diff --git a/a.js b/a.js\n+first\n" },
  {
    name: "r1-r2",
    text: "diff --git a/a.js b/a.js\n+fixed\ndiff --git a/other.js b/other.js\n+unrelated\ndiff --git a/lib/a.js b/lib/a.js\n+elsewhere\n",
  },
];
const shownWith = (
  standing: ReturnType<typeof concernStandings>[number],
  over: { items?: Array<BlindItem>; owners?: Array<string> } = {},
) =>
  matchCheckItem("case:1", standing, {
    items: over.items ?? key.items,
    owners: over.owners ?? [],
    thread: ["Is this null-safe?"],
    diffs,
    seed: 3,
    stratum: "go|2026",
  });

test("the judge sees candidates by label only; a matched concern is judged on its pairs alone", () => {
  const [matched, , missed] = concernStandings(
    key,
    [pass([["r1", "n1"]]), pass([["r1", "n1"]])],
    new Set(["t1", "t2", "t3"]),
  );
  const shown = shownWith(matched!);
  expect(shown.item.candidates.map((one) => one.text)).toEqual(["n1"]);
  expect(shown.key).toMatchObject({
    standing: "matched",
    stratum: "go|2026",
    outsideWindow: false,
    candidates: { A: "n1" },
  });
  // Nothing in the item names the standing, the matcher, or a Neuve or reviewer source.
  expect(JSON.stringify(shown.item)).not.toMatch(
    /matched|split|missed|neuve|reviewer|go\|2026/i,
  );
  // The later change is the concern's file's only: not another file, nor one whose path ends the same.
  expect(shown.item.laterChange).toContain("+fixed");
  expect(shown.item.laterChange).not.toContain("unrelated");
  expect(shown.item.laterChange).not.toContain("elsewhere");
  // A missed concern's candidates: Neuve's items near its line, and the owning unit's anywhere.
  const near = shownWith(missed!, {
    items: [
      ...key.items,
      item("n4", "neuve", "b1.u3#c", 70 + NEARBY_LINES + 1),
    ],
    owners: ["b1.u2"],
  });
  expect(near.item.candidates.map((one) => one.text).sort()).toEqual(["n3"]);
  expect(MatchCheckItem.parse(near.item)).toEqual(near.item);
});

// Why (review, 27 October): a split concern whose one-pass pair stood outside the window lost it, so the
// judge could only say no and a scoring gap became a miss (2 of 5 in the dry run).
test("a split concern always keeps its pair among its candidates, wherever it stands", () => {
  const far = item("n9", "neuve", "b9.u9#comment-1", 900, "n9", "z.js");
  const [, split] = concernStandings(
    { items: [...key.items, far] },
    [pass([["r2", "n9"]])],
    new Set(["t1", "t2"]),
  );
  expect(split!.standing).toBe("split");
  expect(shownWith(split!).item.candidates.map((one) => one.text)).toContain(
    "n9",
  );
  // A matched concern whose pairs all stand outside the window is counted, for the lower bound.
  const [matched] = concernStandings(
    { items: [...key.items, far] },
    [pass([["r1", "n9"]]), pass([["r1", "n9"]])],
    new Set(["t1"]),
  );
  expect(shownWith(matched!).key.outsideWindow).toBe(true);
});

test("a later change that never touched the file says so", () => {
  expect(laterChangeOf(diffs, "b.js")).toBe(
    "(no later revision changed this file)",
  );
});

const answer = (id: string, raised: "yes" | "no" | "unsure") => ({
  id,
  raised,
  form: raised === "yes" ? ("question" as const) : ("none" as const),
  reason: "",
});

// Why (review, 27 October): the sample draws strata equally, so its shares must be read back by each
// stratum's share of the population, never by its share of the sample.
test("the report weights each stratum by its population, and the implied rate by the weighted shares", () => {
  const keys = [
    // go: 90 matched concerns, two sampled, both raised; t3code: 10, two sampled, neither.
    { id: "g1", standing: "matched" as const, stratum: "go" },
    { id: "g2", standing: "matched" as const, stratum: "go" },
    { id: "t1", standing: "matched" as const, stratum: "t3code" },
    {
      id: "t2",
      standing: "matched" as const,
      stratum: "t3code",
      outsideWindow: true,
    },
    { id: "m1", standing: "missed" as const, stratum: "go" },
    { id: "m2", standing: "missed" as const, stratum: "go" },
    { id: "s1", standing: "split" as const, stratum: "go" },
  ];
  const report = matchCheckReport(
    {
      matched: { go: 90, t3code: 10 },
      split: { go: 10 },
      missed: { go: 100 },
    },
    keys,
    [
      answer("g1", "yes"),
      answer("g2", "yes"),
      answer("t1", "no"),
      answer("t2", "no"),
      answer("m1", "yes"),
      answer("m2", "no"),
      answer("s1", "unsure"),
    ],
  );
  // Unweighted, precision would read 2 of 4; by population it is 90% (go's 100% at 0.9, t3code's 0%).
  expect(report.precision.share).toBeCloseTo(0.9);
  expect(report.precision.effectiveN).toBeLessThanOrEqual(4);
  expect(report.scoringGaps.missed.share).toBe(0.5);
  expect(report.standings.missed.forms["question"]).toBe(1);
  expect(report.matchedOutsideWindow).toBe(1);
  expect(report.caughtByMatcher).toBeCloseTo(100 / 210);
  // No judged split concern: no implied rate, rather than a guess.
  expect(report.scoringGaps.split.share).toBeNull();
  expect(report.caughtImplied).toBeNull();
  const judgedSplit = matchCheckReport(
    { matched: { go: 90, t3code: 10 }, split: { go: 10 }, missed: { go: 100 } },
    keys,
    [
      answer("g1", "yes"),
      answer("g2", "yes"),
      answer("t1", "no"),
      answer("t2", "no"),
      answer("m1", "yes"),
      answer("m2", "no"),
      answer("s1", "yes"),
    ],
  );
  expect(judgedSplit.caughtImplied).toBeCloseTo(
    (100 * 0.9 + 10 * 1 + 100 * 0.5) / 210,
  );
});

test("a standing with no concerns adds nothing to the implied rate; unjudged strata are said", () => {
  const report = matchCheckReport(
    { matched: { go: 10, t3code: 10 }, split: {}, missed: { go: 10 } },
    [
      { id: "g1", standing: "matched" as const, stratum: "go" },
      { id: "m1", standing: "missed" as const, stratum: "go" },
    ],
    [answer("g1", "yes"), answer("m1", "no")],
  );
  // t3code's matched concerns were never sampled: go's share stands for them, and the report says so.
  expect(report.caughtImplied).toBeCloseTo((20 * 1 + 10 * 0) / 30);
  expect(report.impliedNote).toContain("matched");
});

// Why (review, 27 October): a key built before the sample kept its strata read as zero concerns.
test("a key written before the strata were kept is refused, never read as zero", () => {
  const folder = mkdtempSync(join(tmpdir(), "match-check-"));
  try {
    writeFileSync(
      join(folder, "key.json"),
      JSON.stringify({
        population: { matched: 3, split: 1, missed: 4 },
        keys: [{ id: "m1", standing: "missed" }],
      }),
    );
    writeFileSync(
      join(folder, "decided.json"),
      JSON.stringify({ version: 1, answers: [] }),
    );
    expect(() => reportMatchCheck(folder)).toThrow("build the check again");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("a stratum the sample never judged widens the interval to anything in its share", () => {
  const half = weightedShare([
    { size: 50, judged: 10, hits: 10 },
    { size: 50, judged: 0, hits: 0 },
  ]);
  expect(half.coverage).toBe(0.5);
  expect(half.interval![1]).toBe(1);
  expect(half.interval![0]).toBeLessThan(0.5);
});

const packet = {
  complete: true,
  gaps: [],
  batches: [
    {
      batchId: "b1",
      units: [
        {
          unitId: "U1",
          local: "b1.u1",
          recorded: {
            payload: {
              title: "t",
              ownedRanges: [
                {
                  kind: "lines",
                  path: "a.js",
                  side: "new",
                  startLine: 5,
                  endLine: 20,
                },
                {
                  kind: "lines",
                  path: "a.js",
                  side: "old",
                  startLine: 5,
                  endLine: 9,
                },
              ],
            },
          },
          disposition: { payload: { verdict: "approve" } },
          content: {},
          references: [],
          comments: [],
        },
      ],
    },
  ],
} as unknown as PacketLite;
const call = (
  agent: string,
  tool: string,
  served: string | null,
  params: Record<string, unknown> = {},
  failed: boolean | null = false,
) => ({ agent, tool, params, served, failed });
const reads = (
  calls: Array<ReturnType<typeof call>>,
  missing: Array<string> = [],
) => ({
  version: 2 as const,
  captures: {},
  missingCaptures: missing,
  unreadableCaptures: [],
  calls,
});
const at = { path: "a.js", side: "new" as const, line: 12 };

/** A hunk result's first line, as the harness writes it (hunkLine), so the fixture cannot drift from it. */
const hunkHeader = (over: {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  status: string;
  symbols: Array<string>;
}) =>
  hunkLine({
    hunkId: "h57a42598bc8b4c9",
    path: "a.js",
    kind: "text",
    oldStart: over.oldStart,
    oldLines: over.oldLines,
    newStart: over.newStart,
    newLines: over.newLines,
    added: over.newLines,
    deleted: over.oldLines,
    status: over.status,
    enclosing:
      over.symbols.length === 0
        ? null
        : { symbols: over.symbols, headingPath: [] },
    declared: [],
  } as never);

// Why (review, 27 October): a read is counted by what it was served, never by what it asked for: a
// request for 1-1000 may be served 1-200, a handle read names no path, and a base read is the old side.
test("a read covers a line only where its result says it was served, on the same side", () => {
  const served = (calls: Array<ReturnType<typeof call>>) =>
    missFacts({ packet }, reads(calls), at);
  // Asked for 1-1000, served 1-10: not line 12.
  expect(
    served([
      call(
        "investigate.p1",
        "read",
        "hx a.js@head lines 1-10 of 900 (~1 tokens)",
        { path: "a.js", startLine: 1, endLine: 1000 },
      ),
    ]).reads,
  ).toBe(0);
  // A handle read: no path asked, the result names it.
  expect(
    served([
      call(
        "dispose.b1.u1",
        "read",
        "hx a.js@head lines 10-40 of 900 (~1 tokens)",
        { handle: "hx" },
      ),
    ]),
  ).toMatchObject({ reads: 1, readBy: ["dispose.b1.u1"], fileCalls: 1 });
  // The base revision is the old side: its line 12 is not the new side's.
  expect(
    served([
      call("understand", "read", "hx a.js@base lines 1-40 of 900 (~1 tokens)"),
    ]).reads,
  ).toBe(0);
  expect(
    missFacts(
      { packet },
      reads([
        call(
          "understand",
          "read",
          "hx a.js@base lines 1-40 of 900 (~1 tokens)",
        ),
      ]),
      { ...at, side: "old", line: 7 },
    ).reads,
  ).toBe(1);
  // A hunk covers both its sides, read from the harness's own header; a failed call, a call with no
  // result and an outline cover nothing.
  const modified = hunkHeader({
    oldStart: 10,
    oldLines: 2,
    newStart: 11,
    newLines: 4,
    status: "modified",
    symbols: ["f", "g"],
  });
  expect(
    served([call("understand", "hunk", modified, { id: "h1" })]).reads,
  ).toBe(1);
  expect(
    missFacts(
      { packet },
      reads([call("understand", "hunk", modified, { id: "h1" })]),
      { ...at, side: "old", line: 7 },
    ).reads,
  ).toBe(0);
  // A new file's hunk has no old side: -0,0 serves nothing there, and its new side is lines 1-12.
  const added = hunkHeader({
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines: 12,
    status: "added",
    symbols: [],
  });
  expect(served([call("understand", "hunk", added, { id: "h2" })]).reads).toBe(
    1,
  );
  expect(servedRanges(call("understand", "hunk", added))).toEqual([
    { path: "a.js", side: "new", start: 1, end: 12 },
  ]);
  expect(
    served([
      call("understand", "read", "hx a.js@head lines 1-40 of 9", {}, true),
    ]).reads,
  ).toBe(0);
  expect(
    served([call("understand", "read", null, { path: "a.js" }, null)]).reads,
  ).toBe(0);
  expect(
    served([call("understand", "outline", "a.js@head: js, parsed")]),
  ).toMatchObject({ reads: 0, fileCalls: 1 });
});

// Why (review, 27 October): with no record of a run's reads, "read by nobody" is a false fact that
// pushes the judge toward "never looked"; unknown must say unknown.
test("reads are unknown, not none, without a record or with captures missing", () => {
  for (const unknown of [null, reads([], ["ab"])])
    expect(missFacts({ packet }, unknown, at)).toMatchObject({
      readsKnown: false,
      readBy: null,
      reads: null,
      fileCalls: null,
    });
});

test("a miss's facts include its owner and the evidence that cites its lines", () => {
  const facts = missFacts(
    {
      packet,
      ledgers: [
        { entries: [{ source: { path: "a.js", startLine: 11, endLine: 13 } }] },
      ],
    },
    reads([]),
    at,
  );
  expect(facts).toMatchObject({
    owned: ["b1.u1"],
    readsKnown: true,
    reads: 0,
    evidence: 1,
    cutOff: false,
  });
});

test("a cut-off names the owner; a shown cap is apart; another file's gap never counts", () => {
  const deadline = missFacts(
    { packet, timeout: { reached: true, published: ["investigate.p1"] } },
    reads([]),
    at,
  );
  expect(deadline.cutBy).toEqual(["the deadline stopped b1.u1's review"]);
  const gap = (kind: string, detail: string) =>
    missFacts({ packet, gaps: [{ kind, detail }] }, null, at);
  expect(
    gap(
      "review-missing",
      "The unit in a.js (line 5) has no agent review (the review was cut off)",
    ).cutOff,
  ).toBe(true);
  expect(
    gap("review-missing", "The unit in a.js (line 30) has no agent review")
      .cutOff,
  ).toBe(false);
  // "in lib/a.js" names another file whose path merely ends in a.js.
  expect(
    gap("review-missing", "The unit in lib/a.js (line 5) has no agent review")
      .cutOff,
  ).toBe(false);
  const capped = gap(
    "assessment-cut",
    "Only part of the assessment of the unit in a.js (lines 5-20) is shown",
  );
  expect(capped).toMatchObject({ cutOff: false });
  expect(capped.shownCap).toHaveLength(1);
});

test("the cause item lists every owner's items, folded repeats included", () => {
  const items = [
    item("n1", "neuve", "b1.u1#comment-1", 12),
    {
      ...item("n2", "neuve", "b2.u4#comment-1", 12),
      repeats: ["b1.u1#comment-2"],
    },
    item("n3", "neuve", "b3.u1#comment-1", 12),
  ];
  const built = missCauseItem("case:1", "t1", at, {
    run: { packet },
    reads: null,
    thread: ["t"],
    diffs,
    items,
  });
  expect(built.item.units).toEqual([
    { verdict: "approve", items: ["n1", "n2"] },
  ]);
  expect(built.item.run).toMatchObject({
    readsKnown: false,
    readByAgents: null,
    readsOfTheLines: null,
  });
  expect(built.key).toMatchObject({
    readsKnown: false,
    cutOff: false,
    shownCap: false,
  });
});

test("the sort reports per concern, splits not looking three ways, and keeps unknown reads apart", () => {
  const report = missCauseReport(
    [
      {
        id: "c1",
        caseId: "x",
        concernId: "t1",
        cutOff: true,
        shownCap: false,
        readsKnown: true,
      },
      {
        id: "c2",
        caseId: "x",
        concernId: "t2",
        cutOff: false,
        shownCap: true,
        readsKnown: true,
      },
      {
        id: "c3",
        caseId: "x",
        concernId: "t3",
        cutOff: false,
        shownCap: false,
        readsKnown: true,
      },
      {
        id: "c4",
        caseId: "x",
        concernId: "t4",
        cutOff: false,
        shownCap: false,
        readsKnown: false,
      },
    ],
    [
      { id: "c1", cause: "not-looked", reason: "" },
      { id: "c2", cause: "not-looked", reason: "" },
      { id: "c3", cause: "not-looked", reason: "" },
      { id: "c4", cause: "not-looked", reason: "" },
    ],
  );
  expect(report.totals).toEqual({
    "not-looked: cut off": 1,
    "not-looked: shown cap": 1,
    "not-looked": 1,
  });
  expect(report.concerns).toBe(3);
  expect(report.readsUnknown).toEqual({
    concerns: 1,
    totals: { "not-looked": 1 },
  });
  expect(report.perConcern.map((row) => row.concernId)).toEqual([
    "t1",
    "t2",
    "t3",
    "t4",
  ]);
});

test("the judge takes match-check items, and keeps the reason behind a yes", () => {
  const shown = shownWith(
    concernStandings(
      key,
      [pass([["r1", "n1"]]), pass([["r1", "n1"]])],
      new Set(["t1"]),
    )[0]!,
  ).item;
  const { rubric } = rubricOfItems({
    version: 1,
    questions: [...RUBRICS.m.questions],
    chunks: [[shown]],
  });
  expect(rubric).toBe(RUBRICS.m);
  const verdict = (raised: string, reason: string) =>
    ({
      answers: [{ id: shown.id, raised, form: "question", reason }],
    }) as never;
  expect(
    decideRubric(
      RUBRICS.m,
      [shown.id],
      [verdict("yes", "B asks it"), verdict("yes", "B"), null],
    )[0],
  ).toMatchObject({ raised: "yes", form: "question", reason: "B asks it | B" });
});
