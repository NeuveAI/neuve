// Why: blind matching scores Neuve's comments without the scorer knowing which are Neuve's
// (10.129). That rests on the prompt carrying nothing that names a source (no author, comment or
// thread id, finding kind, lane, citation or badge) and on the key being joined only afterwards. Its
// rates (concerns caught, comments that hold for Neuve and for the reviewers, verdicts consistent)
// must count only what both passes agree, never "unsure", and a same-problem pair only when both
// passes name it; otherwise disagreement would read as a result. Neuve's identical items (units
// sharing a reference) are scored once, since repeats would weigh the counts and mark the source;
// and since Neuve crowds lines a reviewer also commented on, matches are split by place.
import { expect, test } from "bun:test";
import type { PacketLite } from "../src/harness-compare/full-test/packets.ts";
import {
  blindItems,
  blindPrompt,
  mergeBlind,
  normalizeComment,
  shuffled,
  type BlindPass,
} from "../src/pr-replay/matching.ts";

const packet = {
  complete: true,
  gaps: [],
  batches: [
    {
      batchId: "b1",
      units: [
        {
          unitId: "01NEUVEUNIT0000000000000000",
          local: "b1.u1",
          recorded: {
            payload: {
              title: "Agentic unit title",
              ownedRanges: [
                {
                  kind: "lines",
                  path: "src/a.ts",
                  side: "new",
                  startLine: 3,
                  endLine: 9,
                },
              ],
            },
          },
          assessment: {
            payload: {
              lane: "agentic",
              gaps: [
                {
                  axis: "ease-of-validation",
                  kind: "binary-content-unread",
                  detail: "The fixture's binary was not decoded.",
                },
              ],
            },
          },
          checkpoints: [
            {
              number: 1,
              requirement: "A reset clears the cache before the next read.",
              anchors: [
                { path: "src/a.ts", side: "new", startLine: 7, endLine: 8 },
              ],
            },
          ],
          referenceDetails: {
            "01NEUVEREFERENCE000000000000": {
              local: "b1.r4",
              beforeYouDecide: "Check that callers reset the cache on logout.",
              anchors: [
                { path: "src/b.ts", side: "new", startLine: 2, endLine: 2 },
              ],
            },
          },
          disposition: { payload: { verdict: "approve" } },
          content: {},
          comments: [
            {
              id: "01NEUVECOMMENT00000000000000",
              payload: {
                body: "The new branch never resets the cache ([h8936287f9957840], [b1.r9]).",
                anchor: {
                  path: "src/a.ts",
                  side: "new",
                  startLine: 5,
                  endLine: 6,
                },
                finding: { kind: "defect", about: "code", evidence: [] },
              },
            },
          ],
        },
      ],
    },
  ],
} as unknown as PacketLite;

test("comments reach the scorer in one format, with nothing naming their source", () => {
  expect(
    normalizeComment(
      "<!-- MURMUR_IGNORE --> 🟡 **Medium** `x.ts:4` The cache is never reset. <details><summary>Prompt for AI agents</summary>fix it</details> ([h8936287f9957840])",
    ),
  ).toBe("`x.ts:4` The cache is never reset.");
  const { items, verdicts, unplaced } = blindItems(packet, [
    {
      id: "github:review-comment:3874643586",
      key: "src/a.ts:new:5",
      text: "_⚠️ Potential issue_ Reset the cache here.",
    },
  ]);
  expect(items.map((item) => item.group).sort()).toEqual([
    "checkpoint",
    "comment",
    "consider",
    "gap",
    "reviewer",
  ]);
  expect(unplaced).toEqual([]);
  // A gap has no line: it stands on its unit's first owned line, and the key says so.
  const gap = items.find((item) => item.group === "gap")!;
  expect([gap.path, gap.line, gap.anchoredTo]).toEqual(["src/a.ts", 3, "unit"]);
  expect(items.find((item) => item.group === "consider")).toMatchObject({
    path: "src/b.ts",
    line: 2,
    anchoredTo: "line",
  });
  const prompt = blindPrompt(items, verdicts, [], "t".repeat(32));
  for (const leak of [
    "01NEUVECOMMENT",
    "01NEUVEUNIT",
    "b1.u1",
    "github:review-comment",
    "3874643586",
    "Neuve",
    "agentic",
    "human-required",
    "lane",
    "defect",
    "h8936287f9957840",
    "b1.r9",
    "Potential issue",
    "Agentic unit title",
    "checkpoint",
    "binary-content-unread",
    "ease-of-validation",
    "01NEUVEREFERENCE",
    "b1.r4",
  ])
    expect(prompt).not.toContain(leak);
  for (const item of items) expect(prompt).toContain(`"id": "${item.id}"`);
  expect(verdicts).toHaveLength(1);
  expect(verdicts[0]!.verdict).toBe("approve");
});

test("the shuffle is a seeded permutation, and uniform", () => {
  const list = Array.from({ length: 20 }, (_, i) => i);
  const once = shuffled(list, 12345);
  expect(once).not.toEqual(list);
  expect([...once].sort((x, y) => x - y)).toEqual(list);
  expect(shuffled(list, 12345)).toEqual(once);
  // The reviewer's probe: 3 Neuve and 2 reviewer items, built Neuve first. Neuve must come first
  // 60% of the time over many seeds (the float LCG gave 80%), and each item lead about 20%.
  const items = ["n1", "n2", "n3", "r1", "r2"];
  const firsts = new Map<string, number>();
  const runs = 20_000;
  for (let seed = 0; seed < runs; seed++) {
    const first = shuffled(items, seed * 2_654_435_761)[0]!;
    firsts.set(first, (firsts.get(first) ?? 0) + 1);
  }
  const neuveFirst =
    ((firsts.get("n1") ?? 0) +
      (firsts.get("n2") ?? 0) +
      (firsts.get("n3") ?? 0)) /
    runs;
  expect(Math.abs(neuveFirst - 0.6)).toBeLessThan(0.02);
  for (const item of items)
    expect(Math.abs((firsts.get(item) ?? 0) / runs - 0.2)).toBeLessThan(0.02);
});

const key = {
  items: [
    {
      id: "n1",
      source: "neuve",
      group: "comment",
      ref: "c1",
      path: "a",
      line: 1,
      anchoredTo: "line",
      repeats: [],
      text: "",
    },
    {
      id: "n2",
      source: "neuve",
      group: "comment",
      ref: "c2",
      path: "a",
      line: 2,
      anchoredTo: "line",
      repeats: [],
      text: "",
    },
    {
      id: "r1",
      source: "reviewer",
      group: "reviewer",
      ref: "t1",
      path: "a",
      line: 1,
      anchoredTo: "line",
      repeats: [],
      text: "",
    },
    {
      id: "r2",
      source: "reviewer",
      group: "reviewer",
      ref: "t2",
      path: "a",
      line: 9,
      anchoredTo: "line",
      repeats: [],
      text: "",
    },
    {
      id: "k1",
      source: "neuve",
      group: "checkpoint",
      ref: "u1#checkpoint-1",
      path: "a",
      line: 9,
      anchoredTo: "line",
      repeats: [],
      text: "",
    },
  ] as const,
  verdicts: [
    { id: "v1", unit: "u1", verdict: "approve", lines: [] },
    { id: "v2", unit: "u2", verdict: "approve", lines: [] },
  ] as const,
  substantive: new Set(["t1", "t2"]),
};

const pass = (overrides: Partial<BlindPass> = {}): BlindPass => ({
  comments: [
    { id: "n1", holds: "plausible", sameAs: ["r1"], rationale: "" },
    { id: "n2", holds: "invalid", sameAs: [], rationale: "" },
    { id: "r1", holds: "confirmed-later", sameAs: [], rationale: "" },
    { id: "r2", holds: "confirmed-later", sameAs: [], rationale: "" },
    { id: "k1", holds: "plausible", sameAs: ["r2"], rationale: "" },
  ],
  verdicts: [
    { id: "v1", judgement: "consistent", rationale: "" },
    { id: "v2", judgement: "too-lenient", rationale: "" },
  ],
  ...overrides,
});

test("unblinded rates from what both passes agree", () => {
  const { summary } = mergeBlind(pass(), pass(), {
    ...key,
    reworked: new Set(["r1"]),
  });
  // t1 is caught by n1, a comment; t2 only by k1, a checkpoint.
  expect(summary.caught).toBe(0.5);
  expect(summary.caughtByAny).toBe(1);
  expect(summary.byGroup.comment).toMatchObject({
    items: 2,
    judged: 2,
    matched: 0.5,
    holding: 0.5,
    invalid: 0.5,
  });
  expect(summary.byGroup.checkpoint).toMatchObject({ items: 1, matched: 1 });
  expect(summary.neuve.items).toBe(3);
  // r2's "confirmed later" has no later change on its line: model-only.
  expect(summary.reviewersCeiling).toMatchObject({
    holding: 1,
    confirmedLater: 0.5,
    confirmedLaterModelOnly: 1,
  });
  expect(summary.verdictsConsistent).toBe(0.5);
});

test("with no third pass, a pair one pass names, a tie or an agreed unsure counts in no rate", () => {
  const b = pass({
    comments: [
      { id: "n1", holds: "plausible", sameAs: [], rationale: "" },
      { id: "n2", holds: "unsure", sameAs: [], rationale: "" },
      { id: "r1", holds: "plausible", sameAs: [], rationale: "" },
      { id: "r2", holds: "confirmed-later", sameAs: [], rationale: "" },
      { id: "k1", holds: "plausible", sameAs: [], rationale: "" },
    ],
  });
  const a = pass({
    comments: [
      { id: "n1", holds: "plausible", sameAs: ["r1"], rationale: "" },
      { id: "n2", holds: "unsure", sameAs: [], rationale: "" },
      { id: "r1", holds: "confirmed-later", sameAs: [], rationale: "" },
      { id: "r2", holds: "confirmed-later", sameAs: [], rationale: "" },
      { id: "k1", holds: "plausible", sameAs: [], rationale: "" },
    ],
  });
  const { summary, pairs } = mergeBlind(a, b, key);
  expect(pairs).toEqual([]);
  expect(summary.caught).toBe(0);
  expect(summary.byGroup.comment.judged).toBe(1);
  // r1's tie, never broken, has too few answers for a majority (10.135).
  expect(summary.notJudged.comments).toEqual({
    missing: 1,
    split: 0,
    unsure: 1,
    brokenByThird: 0,
  });
});

test("a missing pass judges nothing", () => {
  const { summary } = mergeBlind(pass(), null, key);
  expect(summary.neuve.judged).toBe(0);
  expect(summary.reviewersCeiling.judged).toBe(0);
  expect(summary.verdictsJudged).toBe(0);
  expect(summary.caught).toBe(0);
});

test("an item of a unit with no line to stand on is listed apart, never scored", () => {
  const binary = structuredClone(packet) as unknown as {
    batches: Array<{ units: Array<Record<string, unknown>> }>;
  };
  const unit = binary.batches[0]!.units[0]! as {
    recorded: { payload: { ownedRanges: Array<unknown> } };
    comments: Array<unknown>;
    checkpoints: Array<{ anchors?: unknown }>;
  };
  unit.recorded.payload.ownedRanges = [
    { kind: "whole-nontext", path: "fixture.wasm", side: "new" },
  ];
  unit.comments = [];
  delete unit.checkpoints[0]!.anchors;
  const { items, unplaced } = blindItems(binary as unknown as PacketLite, []);
  expect(unplaced.map((item) => item.group).sort()).toEqual([
    "checkpoint",
    "gap",
  ]);
  expect(items.map((item) => item.group)).toEqual(["consider"]);
});

test("units sharing a reference put one thing to consider in the mix, with both refs in the key", () => {
  const shared = structuredClone(packet) as unknown as {
    batches: Array<{ units: Array<Record<string, unknown>> }>;
  };
  const [unit] = shared.batches[0]!.units as [Record<string, unknown>];
  const twin = {
    ...structuredClone(unit),
    unitId: "01NEUVEUNIT0000000000000002",
    local: "b1.u2",
    comments: [],
    checkpoints: [],
    assessment: { payload: { gaps: [] } },
  };
  // The same reference, once in different words: that one stays.
  const reworded = {
    ...structuredClone(twin),
    local: "b1.u3",
    referenceDetails: {
      "01NEUVEREFERENCE000000000000": {
        local: "b1.r4",
        beforeYouDecide: "Check that the logout path resets the cache.",
        anchors: [{ path: "src/b.ts", side: "new", startLine: 2, endLine: 2 }],
      },
    },
  };
  shared.batches[0]!.units.push(twin, reworded);
  const { items } = blindItems(shared as unknown as PacketLite, []);
  const consider = items.filter((item) => item.group === "consider");
  expect(consider.map((item) => [item.ref, item.repeats])).toEqual([
    ["b1.u1#b1.r4", ["b1.u2#b1.r4"]],
    ["b1.u3#b1.r4", []],
  ]);
  const prompt = blindPrompt(items, [], [], "t".repeat(32));
  expect(
    prompt.split("Check that callers reset the cache on logout.").length - 1,
  ).toBe(1);
});

test("a match on a line crowded with Neuve's items is reported apart", () => {
  const crowdedKey = {
    items: [
      ...["n1", "n2", "n3", "n4"].map((id) => ({
        id,
        source: "neuve" as const,
        group: "consider" as const,
        ref: id,
        repeats: [],
        path: "a",
        line: 1,
        anchoredTo: "line" as const,
        text: "",
      })),
      {
        id: "r1",
        source: "reviewer" as const,
        group: "reviewer" as const,
        ref: "t1",
        repeats: [],
        path: "a",
        line: 1,
        anchoredTo: "line" as const,
        text: "",
      },
    ],
    verdicts: [],
    substantive: new Set(["t1"]),
  };
  const both: BlindPass = {
    comments: [
      { id: "n1", holds: "plausible", sameAs: ["r1"], rationale: "" },
      ...["n2", "n3", "n4", "r1"].map((id) => ({
        id,
        holds: "plausible" as const,
        sameAs: [],
        rationale: "",
      })),
    ],
    verdicts: [],
  };
  const { summary } = mergeBlind(both, both, crowdedKey);
  expect(summary.caughtByAny).toBe(1);
  expect(summary.caughtByAnyByPlace).toEqual({ line: 1, notCrowded: 0 });
  expect(summary.neuveMostOnOneLine).toBe(4);
  expect(summary.neuveCrowdedLines).toBe(1);
  expect(summary.neuve.matchedByPlace.crowded).toEqual({
    judged: 4,
    matched: 0.25,
  });
  expect(summary.neuve.matchedByPlace.notCrowded).toEqual({
    judged: 0,
    matched: null,
  });
});

// Why: an old-side line is numbered in the file as it was before the change. Shown without its side,
// the scorer reads it against the first revision's line of the same number, and may pair or judge
// it against the wrong code (26 October); the headline's "caught" rests on those pairs.
test("every item reaches the scorer with its side, a reviewer concern's from its line key", () => {
  const { items } = blindItems(packet, [
    {
      id: "t-old",
      key: "src/a.ts:old:7",
      text: "This removal drops the guard.",
    },
    { id: "t-new", key: "src/a.ts:new:5", text: "Reset the cache here." },
  ]);
  const reviewer = (ref: string) => items.find((item) => item.ref === ref)!;
  expect(reviewer("t-old")).toMatchObject({
    path: "src/a.ts",
    line: 7,
    side: "old",
  });
  expect(reviewer("t-new")).toMatchObject({ side: "new" });
  const prompt = blindPrompt(items, [], [], "s".repeat(32));
  expect(prompt).toContain('"side": "old"');
  expect(prompt).toContain(
    "numbered in the\n  file as it was before the change",
  );
  // A key written before sides were recorded reads as new.
  const { side: _side, ...unsided } = reviewer("t-new");
  const legacy = blindPrompt([unsided], [], [], "s".repeat(32));
  expect(legacy).toContain('"side": "new"');
});
