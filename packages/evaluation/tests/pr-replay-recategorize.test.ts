// Why: 10.142 narrows "performance" to concerns resting on runtime-informed data, and the headline
// takes it out of the parity aim. So the labeller and the relabel must read the same one-line
// definitions, runtime best practice among them; the relabel must say what moved, and write a case's
// relabel only once every thread is decided, leaving the case's labelling as it was. Relabels of
// several categories must share the file without losing one another's threads, a thread left unsure
// must keep its label, and a relabel of an earlier labelling must not be read.

import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATEGORIES, Judgement } from "../src/pr-replay/concerns.ts";
import { labellingDigest } from "../src/pr-replay/parity.ts";
import {
  CategoryRelabel,
  RECATEGORIZE_QUESTIONS,
  buildRecategorize,
  concernCategories,
  relabelState,
  recategorizeReport,
  settleRecategorize,
} from "../src/pr-replay/recategorize.ts";
import {
  RUBRICS,
  decideRubric,
  promptDigest,
  rubricOfItems,
} from "../src/pr-replay/rubric-judge.ts";

test("every category has its line, runtime best practice included, and the relabel offers all but none", () => {
  expect(Judgement.shape.category.options).toEqual(
    Object.keys(CATEGORIES) as never,
  );
  expect(CATEGORIES.performance).toMatch(/runtime-informed data/);
  expect(RECATEGORIZE_QUESTIONS[0]).toContain(
    `- runtime-best-practice: ${CATEGORIES["runtime-best-practice"]}`,
  );
  expect(RECATEGORIZE_QUESTIONS[0]).not.toContain("- none:");
});

test("the judge takes category items and decides by majority, unsure when three differ", () => {
  const item = {
    id: "k000000000001",
    concern: { at: "a.js: line 3", thread: ["this is slow in the trace"] },
    laterChange: "(no later revision changed this file)",
  };
  const { rubric } = rubricOfItems({
    version: 1,
    questions: [...RUBRICS.k.questions],
    chunks: [[item]],
  });
  expect(rubric).toBe(RUBRICS.k);
  const pass = (category: string) =>
    ({ answers: [{ id: item.id, category, reason: category }] }) as never;
  expect(
    decideRubric(
      RUBRICS.k,
      [item.id],
      [pass("performance"), pass("runtime-best-practice"), pass("performance")],
    )[0],
  ).toMatchObject({ category: "performance" });
  expect(
    decideRubric(
      RUBRICS.k,
      [item.id],
      [pass("performance"), pass("correctness"), pass("style")],
    )[0],
  ).toMatchObject({ category: "unsure" });
});

test("the report counts what moved and what stayed", () => {
  const keys = ["1", "2", "3", "4"].map((at) => ({
    id: `k00000000000${at}`,
    was: "performance",
  }));
  expect(
    recategorizeReport(keys, [
      { id: keys[0]!.id, category: "performance" },
      { id: keys[1]!.id, category: "runtime-best-practice" },
      { id: keys[2]!.id, category: "runtime-best-practice" },
    ]),
  ).toEqual({
    concerns: 4,
    decided: 3,
    moved: {
      "stays performance": 1,
      "performance -> runtime-best-practice": 2,
    },
  });
});

test("a relabel of none is refused: the judge cannot answer it", () => {
  expect(() =>
    buildRecategorize(join(tmpdir(), "never-built"), 1, "none"),
  ).toThrow("cannot answer none");
});

test("relabels of two categories share a case's file, merged by thread; unsure threads stay out", () => {
  const root = mkdtempSync(join(tmpdir(), "recategorize-"));
  const labels = join(root, "labels");
  mkdirSync(labels);
  writeFileSync(join(labels, "concerns.jsonl"), "kept\n");
  const relabel = () =>
    CategoryRelabel.parse(
      JSON.parse(readFileSync(join(labels, "category-relabel.json"), "utf8")),
    );
  // One build: its key and, deciding `count` threads, its answers.
  const build = (
    name: string,
    was: string,
    answers: Array<[string, string]>,
  ) => {
    const folder = join(root, name);
    mkdirSync(folder);
    const keys = answers.map(([ref], at) => ({
      id: `k${name.padEnd(10, "0").slice(0, 10)}0${at}`,
      caseId: "case-1",
      ref,
      labels,
      labelling: labellingDigest(labels),
      was,
    }));
    writeFileSync(join(folder, "key.json"), JSON.stringify({ keys }));
    return (count: number) => {
      writeFileSync(
        join(folder, "decided.json"),
        JSON.stringify({
          version: 1,
          promptDigest: promptDigest(RUBRICS.k),
          answers: keys.slice(0, count).map((key, at) => ({
            id: key.id,
            category: answers[at]![1],
            reason: "",
          })),
        }),
      );
      return settleRecategorize(folder);
    };
  };
  try {
    const performance = build("aaaaaaaaaa", "performance", [
      ["t1", "runtime-best-practice"],
      ["t2", "unsure"],
    ]);
    expect(performance(1).complete).toBe(false);
    expect(existsSync(join(labels, "category-relabel.json"))).toBe(false);
    expect(performance(2).complete).toBe(true);
    const digest = promptDigest(RUBRICS.k);
    expect(relabel()).toEqual({
      version: 1,
      labelling: labellingDigest(labels),
      categories: {
        t1: {
          was: "performance",
          now: "runtime-best-practice",
          promptDigest: digest,
        },
      },
    });
    // A second category's relabel keeps the first's threads.
    expect(
      build("bbbbbbbbbb", "design", [["t3", "correctness"]])(1).complete,
    ).toBe(true);
    expect(Object.keys(relabel().categories).sort()).toEqual(["t1", "t3"]);
    expect(readFileSync(join(labels, "concerns.jsonl"), "utf8")).toBe("kept\n");
    // The case labelled again: a build of the earlier labelling is not written, and a build of the
    // new one drops the earlier labelling's entries.
    const stale = build("cccccccccc", "style", [["t4", "correctness"]]);
    writeFileSync(join(labels, "concerns.jsonl"), "again\n");
    expect(stale(1).staleCases).toEqual(["case-1"]);
    expect(Object.keys(relabel().categories).sort()).toEqual(["t1", "t3"]);
    build("dddddddddd", "style", [["t5", "correctness"]])(1);
    expect(relabel()).toMatchObject({
      labelling: labellingDigest(labels),
      categories: { t5: { was: "style", now: "correctness" } },
    });
    expect(Object.keys(relabel().categories)).toEqual(["t5"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parity reads a thread's category from its labelling, relabelled only under the labelling as it stands", () => {
  const labels = mkdtempSync(join(tmpdir(), "categories-"));
  const judged = (id: string, category: Judgement["category"]) => {
    const pass = Judgement.parse({
      id,
      isConcern: true,
      category,
      substantive: true,
      response: "fixed",
      fixRevision: 2,
      validity: "valid",
      designDecision: false,
      rationale: "",
    });
    return { id, opener: "person", firstRevisionKey: null, a: pass, b: pass };
  };
  const unjudged = {
    ...judged("t3", "style"),
    b: { ...judged("t3", "style").a, substantive: false },
  };
  try {
    expect(relabelState(labels).state).toBe("none");
    writeFileSync(
      join(labels, "concerns.jsonl"),
      `${[judged("t1", "performance"), judged("t2", "correctness"), unjudged]
        .map((row) => JSON.stringify(row))
        .join("\n")}\n`,
    );
    const relabel = (labelling: string) =>
      writeFileSync(
        join(labels, "category-relabel.json"),
        JSON.stringify({
          version: 1,
          labelling,
          categories: {
            t1: {
              was: "performance",
              now: "runtime-best-practice",
              promptDigest: "a".repeat(64),
            },
          },
        }),
      );
    relabel(labellingDigest(labels));
    expect(relabelState(labels).state).toBe("current");
    expect([...concernCategories(labels)]).toEqual([
      ["t1", "runtime-best-practice"],
      ["t2", "correctness"],
    ]);
    relabel("0".repeat(64));
    expect(relabelState(labels).state).toBe("stale");
    expect(concernCategories(labels).get("t1")).toBe("performance");
  } finally {
    rmSync(labels, { recursive: true, force: true });
  }
});

test("a held file that is no relabel is refused, never overwritten, and one from before the digest says so", () => {
  const root = mkdtempSync(join(tmpdir(), "relabel-held-"));
  const labels = join(root, "labels");
  const folder = join(root, "build");
  mkdirSync(labels);
  mkdirSync(folder);
  writeFileSync(join(labels, "concerns.jsonl"), "");
  const key = {
    id: "k000000000001",
    caseId: "case-1",
    ref: "t1",
    labels,
    labelling: labellingDigest(labels),
    was: "performance",
  };
  writeFileSync(join(folder, "key.json"), JSON.stringify({ keys: [key] }));
  writeFileSync(
    join(folder, "decided.json"),
    JSON.stringify({
      version: 1,
      promptDigest: promptDigest(RUBRICS.k),
      answers: [{ id: key.id, category: "correctness", reason: "" }],
    }),
  );
  const held = join(labels, "category-relabel.json");
  try {
    const wrong = JSON.stringify({
      version: 1,
      labelling: labellingDigest(labels),
      categories: { t9: { was: "performance", now: "unsure" } },
    });
    writeFileSync(held, wrong);
    expect(() => settleRecategorize(folder)).toThrow(
      "is not a category relabel",
    );
    expect(readFileSync(held, "utf8")).toBe(wrong);
    expect(() => concernCategories(labels)).toThrow(
      "is not a category relabel",
    );
    writeFileSync(
      held,
      JSON.stringify({ version: 1, promptDigest: "a", categories: {} }),
    );
    expect(() => settleRecategorize(folder)).toThrow(
      "built before the labelling digest",
    );
    writeFileSync(
      join(folder, "key.json"),
      JSON.stringify({ keys: [{ ...key, labelling: undefined }] }),
    );
    expect(() => settleRecategorize(folder)).toThrow(
      "built before the labelling digest",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
