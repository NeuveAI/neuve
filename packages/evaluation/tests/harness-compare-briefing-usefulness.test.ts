// Why (NEU-148, the readers' briefing rubric 3.8): the owner judged the briefings by two things, whether
// each claim is cited and whether the text speaks in product and system terms rather than listing files,
// and this measure is what tells the readers' briefing round it got there. Claims split differently from
// the desk would count sentences a person never sees; a link that does not resolve counted as a cite would
// pass a writer whose cites the desk drops; code's own texts or texts of unrecorded source counted as the
// model's would pass or fail the model on code's words; and a folder with no packet must say so rather than
// read as a clean pass. The packets are hand-built in `review show --json`'s shape; no live model.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  briefingOfFolder,
  briefingUsefulness,
  isCodeLike,
  NOTHING_MODEL_WRITTEN,
  readBriefingText,
  SOURCE_NOT_RECORDED,
} from "../src/harness-compare/full-test/readings-gate.ts";

const resolved = (...ids: Array<string>) =>
  ids.map((id) => ({ id, stops: ["briefed"], resolution: { kind: "hunk" } }));
const unresolved = (...ids: Array<string>) =>
  ids.map((id) => ({ id, stops: ["briefed"], unresolved: "unknown" }));

const unit = (over: Record<string, unknown> = {}) => ({
  unitId: "u1",
  content: { facts: { text: "Facts.", cites: [] } },
  sections: [],
  citations: { cited: [], resolved: 0, unresolved: 0 },
  ...over,
});
const gap = (kind: string, unitIds?: Array<string>) => ({
  kind: "gap.disclosed@1",
  attribution: unitIds === undefined ? {} : { unitIds },
  payload: { kind, detail: "a gap" },
});
const packet = (
  units: Array<unknown>,
  digest?: unknown,
  digestCited: Array<unknown> = [],
) => ({
  complete: true,
  batches: [
    {
      batchId: "b1",
      ...(digest === undefined ? {} : { digest }),
      digestCitations: { cited: digestCited, resolved: 0, unresolved: 0 },
      units,
    },
  ],
  gaps: [],
});

test("claims split as the desk splits them: never inside a phrase, at a blank line, and short claims dropped", () => {
  const t = readBriefingText(
    "lead",
    "agent",
    "u1",
    "Revoking a link now [bumps its version. And ends sessions](h1). The only test checks the 204 status.\n\nA new paragraph starts here. Too short.",
    new Set(["h1"]),
  );
  // The phrase's inner ". A" never splits it; the blank line ends a claim; "Too short." has two words.
  expect(t.claims.map((c) => c.words)).toEqual([10, 7, 5]);
  expect(t.claims.map((c) => c.cited)).toEqual([true, false, false]);
});

test("a link whose ID does not resolve is written but not cited", () => {
  const b = briefingUsefulness(
    packet([
      unit({
        content: {
          briefed: {
            source: "agent",
            text: "Revoking a link [ends open sessions](h1) at once. A May decision [kept sessions alive](h9) instead.",
          },
        },
        citations: { cited: [...resolved("h1"), ...unresolved("h9")] },
      }),
    ]),
  );
  expect(b.bySource.agent).toMatchObject({
    claims: 2,
    citedClaims: 1,
    writtenClaims: 2,
  });
  expect(b.citeShare).toBe(0.5);
  expect(b.writtenShare).toBe(1);
  expect(b.fails[0]).toContain("cite share 0.500 (1 of 2 claims) is under 0.9");
});

test("code-like words and enumerating claims follow the rubric, and prose naming one symbol does not enumerate", () => {
  expect(
    [
      "packages/harness/src/cli.ts",
      "cli.ts",
      "`floorsOf`",
      "recordedUnits",
      "SECTIONS_LANE_RULES",
      "run()",
    ].every(isCodeLike),
  ).toBe(true);
  expect(["sessions", "SHR-212", "204", "Revoking"].some(isCodeLike)).toBe(
    false,
  );
  const read = (text: string) =>
    readBriefingText("section", "agent", "u1", text, new Set()).claims[0]!;
  expect(
    read("Changes publish.ts, packets.ts and cli.ts for the reader.")
      .enumerates,
  ).toBe(true);
  expect(read("Retry section of the harness: 12 lines added").enumerates).toBe(
    true,
  );
  expect(
    read(
      "The holder now keeps one idle timer for every encoder process it starts and stops.",
    ).enumerates,
  ).toBe(false);
  // A backticked command with spaces is one code-like word: three of them joined enumerate.
  expect(
    read(
      "Run `neuve review show --json`, `bun run check` and `git status --short` first.",
    ).enumerates,
  ).toBe(true);
  // A call keeps its parentheses inside text, and a parenthesis closing the sentence's own aside does not.
  expect(
    read("It calls run(), stop() and reset() (all three).").enumerates,
  ).toBe(true);
  // Three names joined by commas and "and", under 30% of the words.
  expect(
    read(
      "The reader now checks `recordedUnits`, `floorsOf` and `rule3Unit` before it trusts any stored trail from an older run of the eval.",
    ).enumerates,
  ).toBe(true);
});

test("a file-list text and file-name phrases fail the gate; Explained carrying a link or a local ID fails it", () => {
  const b = briefingUsefulness(
    packet([
      unit({
        content: {
          briefed: {
            source: "agent",
            text: "Edits [publish.ts](h1), [cli.ts](h2) and reader code. Holders now [share one idle timer](h1) across calls.",
          },
          explained: {
            before: "One timer per call.",
            after: "Shared timer, see h2 for the change.",
            cites: ["h2"],
          },
        },
        citations: { cited: resolved("h1", "h2") },
      }),
    ]),
  );
  expect(b.bySource.agent.fileListTexts).toBe(1);
  expect(b.fileNamePhraseShare).toBeCloseTo(2 / 3);
  expect(b.explainedIds).toBe(1);
  expect(b.fails.join("\n")).toContain(
    "1 model-written text(s) are file lists",
  );
  expect(b.fails.join("\n")).toContain(
    "file-name phrases 0.667 (2 of 3) are over 0.1",
  );
  expect(b.fails.join("\n")).toContain("1 link(s) or local ID(s) in Explained");
});

test("code's texts and texts of unrecorded source are counted apart, and a packet with no model text is not measured", () => {
  const b = briefingUsefulness(
    packet(
      [
        unit({
          content: {
            briefed: {
              text: "The checkout cache keeps finished values and never pending promises.",
            },
          },
          sections: [
            {
              key: "s1",
              content: {
                source: "code",
                briefed: "Concurrent loads now share one run of the work.",
              },
            },
          ],
        }),
      ],
      {
        source: "code",
        digest: "This batch moves shared loads onto one run per key.",
      },
    ),
  );
  expect(b.bySource["not recorded"].texts).toBe(1);
  expect(b.bySource.code.texts).toBe(2);
  expect(b.bySource.agent.texts).toBe(0);
  expect(b.citeShare).toBeNull();
  expect(b.fails).toEqual([SOURCE_NOT_RECORDED(1), NOTHING_MODEL_WRITTEN]);
});

test("in a briefed batch a text with no source is the model's, unless a briefing gap names its unit", () => {
  const fileList = "Edits publish.ts, packets.ts and cli.ts for the reader.";
  const prose = "Holders now [share one idle timer](h1) across every call.";
  const briefedUnit = (unitId: string, text: string) =>
    unit({
      unitId,
      content: { briefed: { text } },
      sections: [{ key: `${unitId}.s`, content: { briefed: text } }],
      citations: { cited: resolved("h1") },
    });
  const units = [briefedUnit("u1", fileList), briefedUnit("u2", prose)];
  const digest = {
    source: "agent",
    digest: "The batch [shares idle timers](h4) across calls.",
  };
  // A model digest marks the batch briefed: u1's file lists are the model's and fail the gate.
  const briefed = briefingUsefulness(packet(units, digest, resolved("h4")));
  expect(briefed.bySource.agent.texts).toBe(5);
  expect(briefed.bySource.agent.fileListTexts).toBe(2);
  expect(briefed.fails.join("\n")).toContain(
    "2 model-written text(s) are file lists",
  );
  // A briefing gap naming u1 puts its texts with code's fallback; a digest gap names no unit.
  const fell = briefingUsefulness({
    ...packet(units, { source: "code", digest: "2 units in 2 files." }),
    batches: [
      {
        ...packet(units).batches[0],
        digest: { source: "code", digest: "2 units in 2 files for the batch." },
        gaps: [gap("briefing-failed", ["u1"]), gap("briefing-cut")],
      },
    ],
  });
  expect(fell.bySource.code).toMatchObject({ texts: 3, fileListTexts: 2 });
  expect(fell.bySource.agent).toMatchObject({
    texts: 2,
    claims: 2,
    citedClaims: 2,
  });
  expect(fell.passes).toBe(true);
});

test("Explained carrying a sibling unit's ID or a range hunk no Facts cites fails the gate", () => {
  const explained = (after: string) => ({
    before: "One timer per call.",
    after,
    cites: [],
  });
  const b = briefingUsefulness(
    packet([
      unit({
        unitId: "u1",
        content: { explained: explained("The timer is shared, as hb7 shows.") },
      }),
      unit({
        unitId: "u2",
        content: { facts: { text: "Facts.", cites: ["hb7"] } },
      }),
      unit({
        unitId: "u3",
        content: {
          explained: explained("Every call counts, see `h9c1` here."),
        },
      }),
    ]),
    ["h9c1"],
  );
  expect(b.explainedIds).toBe(2);
});

test("a digest is cited by the batch's digest citations, and lead-is-facts fails only on a unit of more than one section with a section read", () => {
  const assessed = { assess: { complexity: { level: "low" } } };
  const two = [
    { key: "s1", ...assessed },
    { key: "s2", ...assessed },
  ];
  // Every section excluded (a generated lockfile) or unread for a cause: nothing a lead could be
  // written from, so exempt.
  const unread = [
    { key: "s4", assess: null, excluded: { reason: "generated" } },
    { key: "s5", assess: null, undecided: { cause: "too-large" } },
  ];
  // Assess failed on both sections: still read and briefed beside their Facts, so held to the rule.
  const failed = [
    {
      key: "s6",
      assess: null,
      undecided: { cause: "failed", reading: "assess" },
    },
    {
      key: "s7",
      assess: null,
      undecided: { cause: "failed", reading: "assess" },
    },
  ];
  const b = briefingUsefulness(
    packet(
      [
        unit({ unitId: "u1", sections: two }),
        unit({ unitId: "u2", sections: [{ key: "s3", ...assessed }] }),
        unit({ unitId: "u3", sections: unread }),
        unit({ unitId: "u4", sections: failed }),
      ],
      {
        source: "agent",
        digest: "The batch [moves shared loads onto one run](h4) per key.",
      },
      resolved("h4"),
    ),
  );
  expect(b.modelByKind.digest).toMatchObject({ claims: 1, citedClaims: 1 });
  expect(b.leadIsFacts).toBe(4);
  expect(b.leadIsFactsOnMultiSection).toBe(2);
  expect(b.leadIsFactsUnread).toBe(1);
  expect(b.fails).toEqual([
    "2 unit(s) of more than one section lead with their Facts",
  ]);
});

test("a link left open fails the gate, a hunk with a line range is cited like a bare hunk, and code-like section titles are counted", () => {
  const b = briefingUsefulness(
    packet([
      unit({
        content: {
          briefed: {
            source: "agent",
            // A whole link with a line range, a resolved one; "[" inside backticks is code, not a link.
            // Brackets in code outside backticks (keys[0], T[]) are no link either.
            text: "Revoking a link [ends open sessions](h1a2b3c4d5e6f70@4-9) at once, as `keys[0]` shows. It now reads keys[0] and returns T[] before the retry.",
          },
          explained: {
            before: "One timer per call.",
            after: "Shared timer, as h9@2-5 removed.",
            cites: [],
          },
        },
        sections: [
          {
            key: "s1",
            title: "src/publish.ts",
            content: {
              source: "agent",
              // Opened and never closed: the "](" has no closing parenthesis.
              briefed:
                "Holders now [share one idle timer](h1 across every call.",
            },
          },
          {
            key: "s2",
            title: "Holders share one idle timer",
            content: {
              source: "agent",
              briefed:
                "A [stray bracket opens here and never closes for calls.",
            },
          },
          {
            key: "s3",
            title: "12 lines added",
            content: {
              source: "agent",
              briefed:
                "Every caller [now waits on one run](h1a2b3c4d5e6f70@82) of the work.",
            },
          },
        ],
        citations: {
          cited: [
            ...resolved("h1a2b3c4d5e6f70@4-9"),
            ...unresolved("h1a2b3c4d5e6f70@82"),
          ],
        },
      }),
    ]),
    ["h9"],
  );
  expect(b.bySource.agent.danglingLinkTexts).toBe(2);
  expect(b.fails).toContain(
    '2 model-written text(s) leave a link open (a "[" or "](" that is no whole [phrase](id))',
  );
  // The resolved ranged cite counts as cited; the unresolved one is written but not cited.
  expect(b.modelByKind.lead).toMatchObject({ claims: 2, citedClaims: 1 });
  expect(b.bySource.agent.rangedPhrases).toBe(2);
  expect(b.lineRangeShare).toBe(1);
  // A hunk with a line range written in Explained is still a local ID.
  expect(b.explainedIds).toBe(1);
  expect(b).toMatchObject({ sectionTitles: 3, codeLikeSectionTitles: 2 });
});

let dirs: Array<string> = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

test("a folder with no show.json, no packet or unreadable JSON is not measured, with the reason", () => {
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), "briefing-"));
    dirs.push(d);
    return d;
  };
  const none = dir();
  expect(briefingOfFolder(none)).toEqual({
    folder: none,
    measured: false,
    why: "no show.json in the folder",
  });
  const empty = dir();
  writeFileSync(join(empty, "show.json"), JSON.stringify({ packet: null }));
  expect(briefingOfFolder(empty)).toMatchObject({
    measured: false,
    why: "show.json holds no packet",
  });
  const broken = dir();
  writeFileSync(join(broken, "show.json"), "{");
  expect(briefingOfFolder(broken).measured).toBe(false);
});
