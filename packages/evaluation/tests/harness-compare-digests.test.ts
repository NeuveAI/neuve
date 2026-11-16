// Why (10.139): the owner's desk feedback on digests becomes the checks the dispositions and titles
// work tunes against. A check that misreads Markdown, counts a full-sentence briefing line as a
// repeat of any title, or counts stock phrases as Explained repeating Briefed would point the climb
// at the wrong digests; and a length summary that mixed concern counts would hide that joined
// units' briefings run long because they say more, or because they ramble.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimRows,
  claimsLed,
  deskRows,
  deskSections,
  digestCheck,
  lengths,
  repeatedSentences,
  repeatsLine,
  wordCount,
} from "../src/harness-compare/full-test/digests.ts";
import { replayRuns } from "../src/harness-compare/full-test/replay-runs.ts";

test("separate claims are led by a heading or bold lead-in; a short text stands alone", () => {
  expect(claimsLed("One summary sentence.")).toBe(true);
  expect(claimsLed("A summary. One claim.")).toBe(true);
  // Three sentences in one block: separate claims with nothing marking them.
  expect(claimsLed("A summary. One claim. Another claim.")).toBe(false);
  expect(
    claimsLed("A summary.\n\n**Cache:** it refreshes.\n\n### Logs\nIt logs."),
  ).toBe(true);
  // A list of bold-led claims, or bold-led claims on their own lines, is marked.
  expect(
    claimsLed("Summary.\n\n- **Cache:** refreshes.\n- **Log:** logs."),
  ).toBe(true);
  expect(
    claimsLed(
      "**Cache:** It refreshes. It is fast.\n**Log:** It logs. It is quiet.",
    ),
  ).toBe(true);
  // One list item left unmarked fails; a plain line going on from a claim is part of it.
  expect(claimsLed("Summary.\n\n- **Cache:** refreshes.\n- logs too.")).toBe(
    false,
  );
  expect(claimsLed("Summary.\n\n**Cache:** it refreshes,\nand logs.")).toBe(
    true,
  );
  // A heading needs its space, as CommonMark does.
  expect(claimsLed("Summary.\n\n#Cache\nIt refreshes.")).toBe(false);
  // The desk's current shape: a plain-text lead-in ending in a colon is not Markdown.
  expect(
    claimsLed("A summary.\n\nPass the target only: it drops a value."),
  ).toBe(false);
});

test("a title repeats its briefing line when the line restates its words, not when it only shares some", () => {
  expect(
    repeatsLine(
      "Forward optional calculator options into the selection window",
      "The OverviewGrid constructor accepts optional calculator options and passes them to its selection window.\n\nMore.",
    ),
  ).toBe(true);
  expect(
    repeatsLine(
      "Retry closed sockets",
      "[The client retries](h1) when a socket closes, after one second.",
    ),
  ).toBe(false);
  // Too short a title to judge.
  expect(repeatsLine("Imports", "Imports the helper.")).toBe(false);
});

test("Explained repeats Briefed's claims only with a sentence of its own words, never a stock phrase", () => {
  const briefed =
    "Summary line.\n\n**Cache:** The engine copy refreshes when its recorded age passes the configured limit.";
  expect(
    repeatedSentences(
      "The engine copy refreshes when its recorded age passes the limit. No execution proof is recorded.",
      briefed,
    ),
  ).toBe(1);
  expect(repeatedSentences("No execution proof is recorded.", briefed)).toBe(0);
  // A one-block briefing's claims are its sentences after the first.
  const single =
    "The cache changes. The engine copy refreshes when its recorded age passes the configured limit. The worker logs each refresh with its age and limit.";
  expect(
    repeatedSentences(
      "The engine copy refreshes when its recorded age passes the configured limit. The worker logs each refresh with its age and limit.",
      single,
    ),
  ).toBe(2);
  // A briefing that is its summary alone has nothing to repeat: the unit is left out.
  expect(
    repeatedSentences("Anything at all here.", "Only a summary."),
  ).toBeNull();
});

test("lengths are a median, a top tenth and a longest; words leave link targets out", () => {
  expect(lengths([])).toEqual({ n: 0, p50: null, p90: null, max: null });
  expect(lengths([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toEqual({
    n: 10,
    p50: 5,
    p90: 9,
    max: 10,
  });
  expect(wordCount("[The helper](h1abcdef) runs.")).toBe(3);
});

test("digests are measured per unit by concern count, and per batch on both parts", () => {
  const check = digestCheck([
    {
      source: "a",
      assembled: [
        {
          batches: [
            {
              id: "b1",
              digest: {
                digest: "**What changed:** one thing.",
                verification: "Check it. Check that. Check more.",
              },
            },
          ],
          units: [
            {
              id: "u1",
              title: "Parse the cache key carefully",
              changedLines: 10,
              content: {
                briefed:
                  "Parse the cache key carefully and early.\n\n**Key:** it is parsed.",
                explained: {
                  before: "Keys were raw.",
                  after: "Keys are parsed.",
                },
              },
            },
            {
              id: "u2",
              title: "Joined",
              changedLines: 200,
              sections: [
                { id: "s1", title: "A", content: { briefed: "A." } },
                { id: "s2", title: "B", content: { briefed: "B." } },
              ],
              content: { briefed: "Two things. One. Two.", explained: null },
            },
          ],
        },
      ],
    },
  ]);
  expect(check.units.units).toBe(2);
  expect(check.byConcerns["1"]).toMatchObject({
    units: 1,
    claimsLed: 1,
    titlesRepeatingLine: 1,
  });
  // The desk shows the joined unit's sections as rows under their titles: each row is one claim.
  expect(check.byConcerns["2-3"]).toMatchObject({ units: 1, claimsLed: 1 });
  expect(check.byChangedLines[">100"].units).toBe(1);
  expect(check.batches).toMatchObject({
    batches: 1,
    digestLed: 1,
    verificationLed: 0,
  });
});

test("a joined briefing is read as the desk shows it: each section a row under its title", () => {
  const stored =
    "Two changes.\n\nA: It parses. It checks.\n\nB: It logs. It flushes. It retries.";
  // With each section's own content, the rows are those; the stored text gives only the lead.
  expect(
    deskSections(stored, [
      { title: "A", content: { briefed: "It parses." } },
      { title: "B", content: { briefed: "It logs." } },
    ]),
  ).toEqual({
    lead: "Two changes.",
    sections: [
      { title: "A", body: "It parses." },
      { title: "B", body: "It logs." },
    ],
  });
  // A section with content but no Briefed shows its Facts, as the desk shows it.
  expect(
    deskSections(stored, [
      { title: "A", content: { briefed: "It parses." } },
      {
        title: "B",
        content: {
          briefed: null,
          facts: { text: "It logs. It flushes. It retries." },
        },
      },
    ])!.sections[1],
  ).toEqual({ title: "B", body: "It logs. It flushes. It retries." });
  // Without it, the desk's fallback split: a block per section opening with its title.
  const split = deskSections(stored, [{ title: "A" }, { title: "B" }])!;
  expect(split.sections.map((row) => row.body)).toEqual([
    "It parses. It checks.",
    "It logs. It flushes. It retries.",
  ]);
  // A row with several claims and no lead-in fails, as a one-change briefing would.
  expect(split.sections.map((row) => claimsLed(row.body))).toEqual([
    true,
    false,
  ]);
  // A text the desk cannot split is shown whole.
  expect(
    deskSections("One block.", [{ title: "A" }, { title: "B" }]),
  ).toBeNull();
  expect(deskSections(stored, [{ title: "A" }])).toBeNull();
});

test("a briefing is read as the desk's claim rows: one per sentence, a bold label or code no break", () => {
  // The desk breaks before a capital, a digit, a quote or an opening mark, and at a blank line.
  expect(
    deskRows(
      "The [reader](h1) parses keys. It keeps the [old key. Sometimes](h2) on failure.",
    ),
  ).toEqual([
    "The [reader](h1) parses keys.",
    "It keeps the [old key. Sometimes](h2) on failure.",
  ]);
  expect(claimRows("It parses. It keeps. Tests cover it.")).toBe(true);
  // A bold-led line after a sentence is no new row on the desk: two sentences in one row.
  const led =
    "It parses keys.\n**Fallback:** it keeps the old key. **Cache:** it expires.";
  expect(deskRows(led)).toHaveLength(1);
  expect(claimRows(led)).toBe(false);
  expect(claimRows("It parses `keys`. `Cache` expires.")).toBe(false);
  // A list line the desk does not break at merges into the row before; after a blank line it stands.
  expect(
    claimRows("It parses keys.\n- **Fallback:** it keeps the old key."),
  ).toBe(false);
  expect(
    claimRows("It parses keys.\n\n- **Fallback:** it keeps the old key."),
  ).toBe(true);
  // A link to a unit is text on the desk: it breaks a row only when its phrase starts a sentence.
  expect(deskRows("It parses keys. [`parse`](b1.u2) now throws.")).toHaveLength(
    1,
  );
  expect(
    deskRows("It parses keys. [The parser](b1.u2) now throws."),
  ).toHaveLength(2);
  expect(deskRows("It parses keys. [`parse`](h1a2b) now throws.")).toHaveLength(
    2,
  );
  // With the unit's landed links known, a ledger entry its reference marks is a phrase, and a hunk
  // of another file is text.
  const lands = new Set(["p1.e3", "h1a2b"]);
  expect(
    deskRows("It parses keys. [`parse`](p1.e3) now throws.", lands),
  ).toHaveLength(2);
  expect(
    deskRows("It parses keys. [`parse`](h9f9f) now throws.", lands),
  ).toHaveLength(1);
});

test("the replay runs read development cases by their records, and held-out only when asked", () => {
  const root = mkdtempSync(join(tmpdir(), "replay-runs-"));
  try {
    const add = (number: number, split: string) => {
      const dir = join(root, "t3code", String(number));
      mkdirSync(join(dir, "run"), { recursive: true });
      writeFileSync(
        join(dir, "case.json"),
        JSON.stringify({
          version: 1,
          caseId: `c${number}`,
          source: "t3code",
          provider: "github",
          number,
          title: "t",
          url: "https://example.test/1",
          author: "a",
          createdAt: "2026-01-01T00:00:00Z",
          outcome: "merged",
          family: "f",
          split,
          era: "2026",
          control: null,
          selection: { score: 1, reasons: [] },
          firstRevision: null,
          later: null,
          size: null,
          capture: { at: "2026-01-01T00:00:00Z", files: [] },
          clone: null,
          checks: null,
          unavailable: null,
        }),
      );
      writeFileSync(
        join(dir, "run", "show.json"),
        JSON.stringify({ n: number }),
      );
    };
    add(1, "development");
    add(2, "held-out");
    add(3, "pilot");
    // A stray file beside the sources is no source.
    writeFileSync(join(root, ".DS_Store"), "");
    writeFileSync(join(root, "t3code", ".DS_Store"), "");
    expect(replayRuns({ cases: root }).map((r) => r.caseId)).toEqual(["c1"]);
    expect(
      replayRuns({ cases: root, heldOut: true }).map((r) => r.caseId),
    ).toEqual(["c1", "c2"]);
    // A named run is read where each case has it; a case without it is refused unless left out.
    add(4, "development");
    mkdirSync(join(root, "t3code", "1", "run", "titles-a"), {
      recursive: true,
    });
    writeFileSync(
      join(root, "t3code", "1", "run", "titles-a", "show.json"),
      JSON.stringify({ n: 10 }),
    );
    expect(() => replayRuns({ cases: root, run: "titles-a" })).toThrow(
      "every case needs the run",
    );
    expect(
      replayRuns({
        cases: root,
        run: "titles-a",
        leaveOut: new Set(["c4"]),
      }).map((r) => r.shown),
    ).toEqual([{ n: 10 }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
