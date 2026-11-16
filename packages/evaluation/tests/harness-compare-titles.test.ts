// Why (owner, 25 October): titles of units that join several changes read worse than one-change
// titles, and the lanes climb now reports it. A rule that misfires would score a glued list of titles
// as fine, or penalise a one-change title, and the report would point the wrong way.
import { expect, test } from "bun:test";
import {
  checkTitle,
  titleCheck,
} from "../src/harness-compare/full-test/titles.ts";

const lines = (start: number, end: number, hunkId = "h1") => [
  { kind: "lines", hunkId, startLine: start, endLine: end },
];

test("a glued list of section titles fails; a statement that leads with the main change passes", () => {
  const sections = [
    { title: "Imports for the cache tests", lines: 3, supporting: true },
    {
      title: "Check that an aged engine copy is refreshed",
      lines: 40,
      supporting: false,
    },
  ];
  expect(
    checkTitle(
      "Imports for the cache tests; Check that an aged engine copy is refreshed",
      sections,
    ),
  ).toEqual({
    oneStatement: false,
    plain: true,
    namesMain: true,
    leavesOutSupporting: false,
  });
  expect(
    checkTitle("Refresh an aged engine copy on the next inspection", sections),
  ).toEqual({
    oneStatement: true,
    plain: true,
    namesMain: true,
    leavesOutSupporting: true,
  });
  expect(checkTitle("a.ts: 2 hunk(s), +3 -1 lines", sections).plain).toBe(
    false,
  );
  expect(checkTitle("Changes to b1.u3 and h47dffd0a", sections).plain).toBe(
    false,
  );
});

test("joined and one-change units are reported apart, supporting sections read from roles and titles", () => {
  const check = titleCheck([
    {
      changeMap: { hunkRoles: [{ hunkId: "h2", role: "mechanical" }] },
      assembled: [
        {
          units: [
            {
              id: "b1.u1",
              title: "Normalize store usage; Reformat the parser; and 1 more",
              hunkIds: ["h1", "h2"],
              ownedRanges: [],
              sections: [
                {
                  id: "b1.s1",
                  title: "Normalize store usage",
                  ownedRanges: lines(1, 30),
                },
                {
                  id: "b1.s2",
                  title: "Reformat the parser",
                  ownedRanges: lines(40, 44, "h2"),
                },
              ],
            },
            {
              id: "b1.u3",
              title: "Qualify cache receipts",
              hunkIds: ["h3"],
              ownedRanges: lines(1, 9, "h3"),
            },
          ],
        },
      ],
    },
  ]);
  expect(check.joined).toMatchObject({
    units: 1,
    allRules: 0,
    oneStatement: 0,
    leavesOutSupporting: 0,
  });
  expect(check.single).toMatchObject({ units: 1, allRules: 1 });
  expect(check.failing).toEqual([
    {
      unit: "b1.u1",
      title: "Normalize store usage; Reformat the parser; and 1 more",
      fails: ["oneStatement", "leavesOutSupporting"],
    },
  ]);
});

test("titles are reported by concern count and by source, so the multi-concern gap shows where it is", () => {
  const unit = (id: string, title: string, sections: Array<string>) => ({
    id,
    title,
    hunkIds: ["h1"],
    ownedRanges: lines(1, 10),
    sections: sections.map((section, index) => ({
      id: `${id}.s${index}`,
      title: section,
      ownedRanges: lines(index * 10 + 1, index * 10 + 10, `h${index}`),
    })),
  });
  const check = titleCheck([
    {
      source: "a",
      assembled: [
        {
          units: [
            unit("u1", "Parse the cache key", ["Parse the cache key"]),
            // Four concerns; the title names none of the main one's words.
            unit("u2", "Several changes", [
              "Refresh aged engine copies",
              "Record the refresh",
              "Log the refresh",
              "Test the refresh",
            ]),
          ],
        },
      ],
    },
    {
      source: "b",
      assembled: [
        {
          units: [
            unit("v1", "Retry on closed sockets and log the retry", [
              "Retry on closed sockets",
              "Log the retry",
            ]),
          ],
        },
      ],
    },
  ]);
  expect(check.bySections["1"]).toMatchObject({ units: 1, allRules: 1 });
  expect(check.bySections["2-3"]).toMatchObject({ units: 1 });
  expect(check.bySections["4+"]).toMatchObject({ units: 1, namesMain: 0 });
  expect(check.bySource["a"]!["4+"].units).toBe(1);
  expect(check.bySource["b"]!["2-3"].units).toBe(1);
});

test("the main change is the largest section that does more than support, never a larger import block", () => {
  const sections = [
    { title: "Import the receipt helpers", lines: 40, supporting: true },
    {
      title: "Report store usage from cache declarations",
      lines: 12,
      supporting: false,
    },
  ];
  expect(
    checkTitle(
      "Report store usage from cache declarations, with one supporting change",
      sections,
    ),
  ).toMatchObject({ namesMain: true, leavesOutSupporting: true });
  expect(checkTitle("Import the receipt helpers", sections)).toMatchObject({
    namesMain: false,
  });
});
