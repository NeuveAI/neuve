// Why (10.139): the title rubric is judged blind by labellers outside the harness. Its sample must
// hold every joined unit and a matched, reproducible sample of one-concern units per source, or the
// gap the owner saw could be an artefact of which titles were judged; an item must never say which
// run or unit it is; and the rates must read the decided answers back onto the right kind of unit.
import { expect, test } from "bun:test";
import {
  readRubricKey,
  rubricChunks,
  rubricRates,
  titleRubricSample,
  TitleRubricItem,
} from "../src/harness-compare/full-test/title-rubric.ts";

const run = (
  caseId: string,
  source: string,
  joined: number,
  single: number,
) => ({
  caseId,
  source,
  assembled: [
    {
      units: [
        ...Array.from({ length: joined }, (_, i) => ({
          id: `j${i}`,
          title: `Joined ${i}`,
          ownedPaths: ["src/a.ts"],
          sections: [
            {
              title: "One",
              content: { briefed: "[The first](h1) change. More." },
            },
            { title: "Two", content: { briefed: "The second change." } },
          ],
        })),
        ...Array.from({ length: single }, (_, i) => ({
          id: `s${i}`,
          title: `Single ${i}`,
          ownedPaths: ["src/b.ts"],
          content: { briefed: "The only change.\n\n**Detail:** more." },
        })),
      ],
    },
  ],
});

test("the sample holds every joined unit and as many one-concern units per source, the same for the same seed", () => {
  const runs = [run("c1", "a", 2, 5), run("c2", "b", 1, 0)];
  const first = titleRubricSample(runs, "seed");
  const kinds = Object.values(first.key);
  expect(kinds.filter((k) => k.source === "a" && k.joined)).toHaveLength(2);
  expect(kinds.filter((k) => k.source === "a" && !k.joined)).toHaveLength(2);
  // Source b has no one-concern unit to match its joined one.
  expect(kinds.filter((k) => k.source === "b")).toHaveLength(1);
  expect(titleRubricSample(runs, "seed").items).toEqual(first.items);
  expect(titleRubricSample(runs, "other").items).not.toEqual(first.items);
  // An item is the title, its changes' briefing lines (links read as text) and paths: nothing else.
  const joined = first.items.find((item) => item.title === "Joined 0")!;
  expect(Object.keys(TitleRubricItem.parse(joined)).sort()).toEqual([
    "changes",
    "id",
    "paths",
    "title",
  ]);
  expect(joined.changes).toEqual(["The first change.", "The second change."]);
  expect(JSON.stringify(first.items)).not.toContain("c1");
  expect(rubricChunks(first.items, 2).map((chunk) => chunk.length)).toEqual([
    2, 2, 1,
  ]);
});

test("decided answers read back as yes shares for joined and one-concern units, unsure left out", () => {
  const sample = titleRubricSample([run("c1", "a", 2, 2)], "seed");
  const key = readRubricKey(JSON.stringify(sample.key));
  const answer = (id: string, namesMain: "yes" | "no" | "unsure") => ({
    id,
    namesMain,
    coversRest: "not-applicable" as const,
    oneStatement: "yes" as const,
    whereToLook: "yes" as const,
    reason: "",
  });
  const joined = Object.entries(key)
    .filter(([, k]) => k.joined)
    .map(([id]) => id);
  const single = Object.entries(key)
    .filter(([, k]) => !k.joined)
    .map(([id]) => id);
  const rates = rubricRates(
    {
      version: 1,
      answers: [
        answer(joined[0]!, "yes"),
        answer(joined[1]!, "no"),
        answer(single[0]!, "yes"),
        answer(single[1]!, "unsure"),
        answer("t000000000000", "yes"),
      ],
    },
    key,
  );
  expect(rates.joined).toMatchObject({
    titles: 2,
    namesMain: 0.5,
    judged: { namesMain: 2, coversRest: 0 },
  });
  expect(rates.single.judged.namesMain).toBe(1);
  expect(() =>
    rubricRates(
      {
        version: 1,
        answers: [answer(joined[0]!, "yes"), answer(joined[0]!, "no")],
      },
      key,
    ),
  ).toThrow("more than once");
  expect(rates.single).toMatchObject({ titles: 2, namesMain: 1 });
  // coversRest answered not-applicable everywhere: nothing to judge.
  expect(rates.joined.coversRest).toBeNull();
  expect(rates.unmatched).toBe(1);
});
