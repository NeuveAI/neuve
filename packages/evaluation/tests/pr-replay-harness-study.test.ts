// Why: the harness study's reading finds where the baseline run stops carrying a reviewer's problem,
// and the lanes thread joins its answers back to the concerns by ID. So the study's items must reach
// the judge whole, in the order given and with no ID twice; the judge must read them as the study's
// rubric; and a decision must keep each question's majority, its reasons, and an unsure where the
// passes find none, delivered included.

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STUDY_QUESTIONS,
  StudyDecided,
  buildStudy,
} from "../src/pr-replay/harness-study.ts";
import {
  RUBRICS,
  decideRubric,
  rubricOfItems,
} from "../src/pr-replay/rubric-judge.ts";

const item = (n: number) => ({
  id: `s${n.toString(16).padStart(12, "0")}`,
  concern: {
    path: "a.go",
    side: "new",
    line: n,
    lineText: "x",
    thread: ["why?"],
  },
  understand: { summary: "s" },
  investigate: { leads: [] },
  review: { task: "t", steps: [] },
  delivered: [],
});

test("the study's items reach the judge whole, in order, three to a call, and no ID twice", () => {
  const folder = mkdtempSync(join(tmpdir(), "harness-study-"));
  try {
    const items = [1, 2, 3, 4, 5, 6, 7].map(item);
    writeFileSync(
      join(folder, "study.json"),
      JSON.stringify({ version: 1, items }),
    );
    expect(buildStudy(join(folder, "study.json"), join(folder, "out"))).toEqual(
      { items: 7, chunks: 3 },
    );
    const written = JSON.parse(
      readFileSync(join(folder, "out", "rubric-items.json"), "utf8"),
    );
    const { rubric, items: parsed } = rubricOfItems(written);
    expect(rubric).toBe(RUBRICS.s);
    expect(parsed.questions).toEqual([...STUDY_QUESTIONS]);
    expect(parsed.chunks.map((chunk) => chunk.map((one) => one.id))).toEqual([
      [items[0]!.id, items[1]!.id, items[2]!.id],
      [items[3]!.id, items[4]!.id, items[5]!.id],
      [items[6]!.id],
    ]);
    writeFileSync(
      join(folder, "twice.json"),
      JSON.stringify({ version: 1, items: [item(1), item(1)] }),
    );
    expect(() =>
      buildStudy(join(folder, "twice.json"), join(folder, "out2")),
    ).toThrow("repeats");
    writeFileSync(
      join(folder, "named.json"),
      JSON.stringify({ version: 1, items: [{ ...item(1), caseId: "go:1" }] }),
    );
    expect(() =>
      buildStudy(join(folder, "named.json"), join(folder, "out3")),
    ).toThrow();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("a decision keeps each question's majority and every reason, and an unsure where there is none", () => {
  const id = item(1).id;
  const pass = (review: string, delivered: string, reason: string) =>
    ({
      answers: [
        {
          id,
          understand: "covered",
          lead: "asks-nearby",
          handoff: "shown-plainly",
          review,
          delivered,
          firstLost: "review",
          reason,
        },
      ],
    }) as never;
  const [decided] = decideRubric(
    RUBRICS.s,
    [id],
    [
      pass("judged-fine-as-intended", "no", "a"),
      pass("not-addressed", "partly", "b"),
      pass("judged-fine-as-intended", "yes", "c"),
    ],
  );
  expect(decided).toMatchObject({
    understand: "covered",
    review: "judged-fine-as-intended",
    delivered: "unsure",
    firstLost: "review",
    reason: "a | b | c",
  });
  expect(
    StudyDecided.safeParse({ version: 1, answers: [decided] }).success,
  ).toBe(true);
});
