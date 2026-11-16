import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  admit,
  changedLines,
  decodeInput,
  modelState,
  unavailable,
  type Input,
  type Output,
} from "../src/review-quality/contract.ts";
import {
  loadModelCases,
  loadScoringGold,
  type AdjudicatedGold,
} from "../src/review-quality/dataset.ts";
import {
  ReviewQualityGoldPending,
  ReviewQualityHoldoutSealed,
} from "../src/review-quality/errors.ts";
import { scorePredictions } from "../src/review-quality/metrics.ts";
const revision = "a".repeat(40);
const input = (): Input =>
  decodeInput({
    caseId: "control",
    revision,
    hunks: [
      {
        hunkId: "h1",
        path: "imports.ts",
        patch:
          '@@ -1,2 +1,2 @@\n-import "./old";\n-type Mode = "read";\n+import "./side-effect";\n+type Mode = "read" | "admin";',
      },
    ],
    sources: [
      {
        id: "s1",
        path: "side-effect.ts",
        revision,
        start: 40,
        end: 41,
        text: "registry.clear();\nregistry.install();",
      },
    ],
    limitations: [],
    humanDecisionRequired: true,
    innerLoopReceipt: null,
  });
const output = (): Output => ({
  choice: "inspect",
  coverage: [
    { hunkId: "h1", side: "old", line: 1 },
    { hunkId: "h1", side: "old", line: 2 },
    { hunkId: "h1", side: "new", line: 1 },
    { hunkId: "h1", side: "new", line: 2 },
  ],
  citations: [{ sourceId: "s1", start: 40, end: 41 }],
});
test("01 admits every added and deleted line without granting disposition", () => {
  expect(admit(input(), output())).toEqual({
    kind: "admitted",
    output: output(),
    humanDecisionRequired: true,
    finalDisposition: null,
    innerLoopReceiptApplicable: false,
  });
});
test("02 rejects a missing addition", () => {
  const o = output();
  o.coverage.pop();
  expect(admit(input(), o)).toEqual({
    kind: "rejected",
    reason: "missing-changed-line",
  });
});
test("03 rejects a missing deletion", () => {
  const o = output();
  o.coverage.shift();
  expect(admit(input(), o)).toEqual({
    kind: "rejected",
    reason: "missing-changed-line",
  });
});
test("04 rejects duplicated responsibility allocation", () => {
  const o = output();
  o.coverage.push({ ...o.coverage[0]! });
  expect(admit(input(), o)).toEqual({
    kind: "rejected",
    reason: "duplicate-changed-line",
  });
});
test("05 rejects an invented changed line", () => {
  const o = output();
  o.coverage[0]!.line = 9;
  expect(admit(input(), o)).toEqual({
    kind: "rejected",
    reason: "foreign-changed-line",
  });
});
test("06 rejects an invented hunk identity", () => {
  const o = output();
  o.coverage[0]!.hunkId = "unowned";
  expect(admit(input(), o)).toEqual({
    kind: "rejected",
    reason: "foreign-changed-line",
  });
});
test("07 rejects wrong-revision captured source before prompting", () => {
  const i = input();
  i.sources[0]!.revision = "b".repeat(40);
  expect(() => decodeInput(i)).toThrow("Invalid source identity/range/body");
});
test("08 rejects an unknown source citation", () => {
  const o = output();
  o.citations[0]!.sourceId = "invented";
  expect(admit(input(), o)).toEqual({
    kind: "rejected",
    reason: "unknown-source",
  });
});
test("09 rejects a citation outside actual provided source lines", () => {
  const o = output();
  o.citations[0]!.end = 42;
  expect(admit(input(), o)).toEqual({
    kind: "rejected",
    reason: "citation-outside-source",
  });
});
test("10 missing necessary source cannot become quiet answered work", () => {
  const i = input();
  i.sources = [];
  i.limitations = ["Necessary source omitted by budget"];
  const o = output();
  o.citations = [];
  o.choice = "no-additional-signal";
  expect(admit(i, o)).toEqual({
    kind: "rejected",
    reason: "unresolved-evidence-treated-as-answerable",
  });
});
test("11 known unresolved authority conflict requires abstain or ask-human", () => {
  const i = input();
  i.limitations = [
    "Two applicable policies conflict; owner has not resolved them",
  ];
  expect(admit(i, output())).toEqual({
    kind: "rejected",
    reason: "unresolved-evidence-treated-as-answerable",
  });
});
test("12 model cannot override explicit human obligation", () => {
  expect(admit(input(), { ...output(), humanDecisionRequired: false })).toEqual(
    { kind: "rejected", reason: "invalid-output-fields" },
  );
});
test("13 stale inner-loop receipt never becomes final approval", () => {
  const i = input();
  i.innerLoopReceipt = {
    kind: "inner-loop",
    revision: "b".repeat(40),
    scope: changedLines(i.hunks),
    outcome: "passed",
  };
  const a = admit(i, output());
  expect(a.kind).toBe("admitted");
  if (a.kind === "admitted") {
    expect(a.innerLoopReceiptApplicable).toBe(false);
    expect(a.finalDisposition).toBeNull();
    expect(a.humanDecisionRequired).toBe(true);
  }
});
test("14 unavailable provider preserves all changed work with abstention", () => {
  const a = unavailable(input());
  expect(a.kind).toBe("admitted");
  if (a.kind === "admitted") {
    expect(a.output.choice).toBe("abstain");
    expect(a.output.coverage).toEqual(output().coverage);
    expect(a.finalDisposition).toBeNull();
  }
});
test("15 import/type-only hunks cannot disappear by blanket suppression", () => {
  expect(
    admit(input(), {
      choice: "no-additional-signal",
      coverage: [],
      citations: [],
    }),
  ).toEqual({ kind: "rejected", reason: "missing-changed-line" });
});
test("16 gold/family/split data is refused at model-input boundary", () => {
  expect(() => decodeInput({ ...input(), expected: "GOLD_SENTINEL" })).toThrow(
    "gold/split/family",
  );
  const prompt = modelState(input());
  expect(prompt).not.toContain("GOLD_SENTINEL");
  expect(prompt).not.toContain('"caseId"');
  expect(prompt).not.toContain('"expected"');
});

const gold = (required = true): AdjudicatedGold => ({
  caseId: "control",
  status: "adjudicated",
  acceptedChoices: required ? ["inspect"] : ["no-additional-signal"],
  investigationRequired: required,
  requiredSources: ["s1"],
  relevantSources: ["s1"],
  reviewerIds: ["synthetic-native-metric-control"],
  evidence: [
    "literal control expectation, not independently adjudicated pilot gold",
  ],
  rationale:
    "A native metric control verifies count arithmetic, not semantic model quality.",
});
const usage = { kind: "unavailable", reason: "model-not-invoked" } as const;
const ownedFixtures: string[] = [];
afterEach(async () => {
  for (const dir of ownedFixtures.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function pendingFixture(split: "development" | "holdout") {
  const dir = await mkdtemp(join(tmpdir(), "neuve-review-quality-"));
  ownedFixtures.push(dir);
  await writeFile(join(dir, "inputs.jsonl"), JSON.stringify(input()) + "\n");
  await writeFile(
    join(dir, "metadata.jsonl"),
    JSON.stringify({
      caseId: "control",
      family: "control",
      variant: "full",
      split,
      sourceIdentityKind: "synthetic-content-sha1-not-git-commit",
      changedLines: 4,
    }) + "\n",
  );
  await writeFile(
    join(dir, "gold.jsonl"),
    JSON.stringify({
      caseId: "control",
      status: "pending-independent-adjudication",
      draftChoice: "inspect",
      draftRequiredSources: ["s1"],
      reason: "Synthetic loader control",
      unknowns: ["Native control, not pilot adjudication"],
    }) + "\n",
  );
  return dir;
}
test("development model inputs contain no golden answers", async () => {
  const cases = await loadModelCases(
    await pendingFixture("development"),
    "development",
  );
  expect(cases).toHaveLength(1);
  for (const c of cases) {
    expect(Object.keys(JSON.parse(modelState(c)))).toEqual([
      "revision",
      "hunks",
      "sources",
      "limitations",
      "humanDecisionRequired",
      "innerLoopReceipt",
    ]);
  }
});
test("holdout model inputs are sealed by default", async () => {
  await expect(
    loadModelCases(await pendingFixture("holdout"), "holdout"),
  ).rejects.toBeInstanceOf(ReviewQualityHoldoutSealed);
});
test("pending development gold cannot produce a semantic score", async () => {
  await expect(
    loadScoringGold(await pendingFixture("development"), ["control"]),
  ).rejects.toBeInstanceOf(ReviewQualityGoldPending);
});
test("holdout gold is sealed even before considering pending labels", async () => {
  await expect(
    loadScoringGold(await pendingFixture("holdout"), ["control"]),
  ).rejects.toBeInstanceOf(ReviewQualityHoldoutSealed);
});
test("quiet output on required investigation counts an unsafe false negative", () => {
  const o = output();
  o.choice = "no-additional-signal";
  const result = scorePredictions(
    [input()],
    [gold()],
    [{ caseId: "control", output: o, usage }],
  );
  expect(result.unsafeFalseNegatives).toBe(1);
  expect(result.investigationObligations).toBe(1);
  expect(result.selectiveChoiceRisk).toBe(1);
  expect(result.cost.usd).toBeNull();
  expect(result.cost.status).toBe("unavailable");
});
test("abstention retains obligation without claiming a false negative or answered coverage", () => {
  const o = output();
  o.choice = "abstain";
  const result = scorePredictions(
    [input()],
    [gold()],
    [{ caseId: "control", output: o, usage }],
  );
  expect(result.abstained).toBe(1);
  expect(result.answerCoverage).toBe(0);
  expect(result.selectiveChoiceRisk).toBeNull();
  expect(result.unsafeFalseNegatives).toBe(0);
  expect(result.wrongChoices).toBe(1);
});
test("noise metrics count duplicate and irrelevant citations separately from missing sources", () => {
  const i = input();
  i.sources.push({
    id: "unrelated",
    path: "unrelated.ts",
    revision,
    start: 1,
    end: 1,
    text: "export const colour = 1;",
  });
  const o = output();
  o.citations = [
    { sourceId: "unrelated", start: 1, end: 1 },
    { sourceId: "unrelated", start: 1, end: 1 },
  ];
  const result = scorePredictions(
    [i],
    [gold(false)],
    [{ caseId: "control", output: o, usage }],
  );
  expect(result.unnecessaryInvestigation).toBe(1);
  expect(result.wrongAttribution).toBe(2);
  expect(result.missingAttribution).toBe(1);
  expect(result.duplicateCitations).toBe(1);
});
test("uncovered changes fail admission before semantic quality scoring", () => {
  const o = output();
  o.coverage = [];
  const result = scorePredictions(
    [input()],
    [gold()],
    [{ caseId: "control", output: o, usage }],
  );
  expect(result.rejected).toBe(1);
  expect(result.admitted).toBe(0);
  expect(result.answerCoverage).toBe(0);
  expect(result.unsafeFalseNegatives).toBe(0);
});
test("source admission preserves trailing LF and CRLF as two actual lines", () => {
  const i = input();
  i.sources[0]!.text = "registry.clear();\r\nregistry.install();\r\n";
  const validated = decodeInput(i);
  expect(validated.sources[0]!.text).toBe(
    "registry.clear();\r\nregistry.install();\r\n",
  );
  expect(admit(validated, output()).kind).toBe("admitted");
});
