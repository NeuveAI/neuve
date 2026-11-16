// Why: `ruleDecisionsOf` is the one place that says which stored rule judgements let a section skip
// its model reading (decision 14.17). A decision taken where the hand checks did not vouch for the
// rule, or where an imports-only hold changes what a file loads, would leave a change no one reads.
// The function is pure over judgements, so each case builds the judgements it needs by hand and
// passes them through the stored schema, so the shapes are ones `storedSectionRules` can give.
import { expect, test } from "bun:test";

import {
  RULE_SKIPS_RECIPE,
  RuleDecision,
  SECTION_RULE_VERSIONS,
  SectionRuleJudgement,
  ruleDecisionsOf,
  type SectionRuleName,
} from "../src/section-rules.ts";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const MOVED_LIMIT =
  "the names the declaration uses are not checked to mean the same in the new file";

const judgement = (
  rule: SectionRuleName,
  options: {
    readonly key?: string;
    readonly holds?: boolean;
    readonly inputs?: Record<string, unknown>;
  } = {},
): SectionRuleJudgement => {
  const key = options.key ?? KEY_A;
  const holds = options.holds ?? true;
  return SectionRuleJudgement.parse({
    id: `${key}.rule:${rule}`,
    about: { kind: "section", key, path: "src/a.ts" },
    rule,
    version: SECTION_RULE_VERSIONS[rule],
    result: holds ? "holds" : "not-held",
    reason: holds ? null : "owns-non-blank-rows",
    inputs: options.inputs ?? {},
    statement: `${rule} statement`,
    evidence: [],
  });
};

const importsOnly = (inputs: Record<string, unknown>) =>
  judgement("imports-only", { inputs });

/** An imports-only hold's inputs when it loads, drops and reorders nothing. */
const UNCHANGED = {
  newModuleLoads: [],
  droppedModuleLoads: [],
  valueImportOrderChanged: false,
} as const;

test("the recipe names this version of which judgements decide", () => {
  // Why: the readers' plan key carries this recipe when skips are on; its value is pinned so a
  // change to the decision table is seen as a change to it.
  expect(RULE_SKIPS_RECIPE).toBe("neuve-rule-skips-v1");
});

test("a decision names one of the rules that can decide, and no other", () => {
  // Why: a stored plan holding a decision by a rule that never decides would claim a skip the
  // table does not allow.
  const of = (rule: string) =>
    RuleDecision.safeParse({
      rule,
      version: 1,
      judgement: `${KEY_A}.rule:${rule}`,
      statement: "s",
      limit: null,
    }).success;
  expect(of("generated")).toBe(true);
  for (const rule of ["comment-only", "markdown-prose", "deletion-only"])
    expect(of(rule)).toBe(false);
});

for (const rule of [
  "generated",
  "blank-rows-only",
  "whitespace-only",
] as const) {
  test(`a holding ${rule} judgement decides its section, with no limit`, () => {
    // Why: the hand checks vouched for this rule with no stated limit (decision 14.17's list).
    const decisions = ruleDecisionsOf([judgement(rule)]);
    expect([...decisions.keys()]).toEqual([KEY_A]);
    const decision = RuleDecision.parse(decisions.get(KEY_A));
    expect(decision).toEqual({
      rule,
      version: SECTION_RULE_VERSIONS[rule],
      judgement: `${KEY_A}.rule:${rule}`,
      statement: `${rule} statement`,
      limit: null,
    });
  });
}

test("a holding moved-unchanged judgement decides its section, with its stated limit", () => {
  // Why: the hand check found two pairs where the moved text's names may mean something else in
  // the new file; the decision must carry that limit so a reader is told it.
  const decision = ruleDecisionsOf([judgement("moved-unchanged")]).get(KEY_A);
  expect(decision).toEqual({
    rule: "moved-unchanged",
    version: SECTION_RULE_VERSIONS["moved-unchanged"],
    judgement: `${KEY_A}.rule:moved-unchanged`,
    statement: "moved-unchanged statement",
    limit: MOVED_LIMIT,
  });
});

test("a holding imports-only judgement with no load added or dropped and no reorder decides its section", () => {
  // Why: an import change that loads, drops and reorders no module changes nothing that runs at
  // load.
  const decision = ruleDecisionsOf([importsOnly(UNCHANGED)]).get(KEY_A);
  expect(decision).toEqual({
    rule: "imports-only",
    version: SECTION_RULE_VERSIONS["imports-only"],
    judgement: `${KEY_A}.rule:imports-only`,
    statement: "imports-only statement",
    limit: null,
  });
});

test("an imports-only hold that adds a module load decides nothing", () => {
  // Why: a new module load runs that module's top-level code; the checkers named it a weakness.
  expect(
    ruleDecisionsOf([importsOnly({ ...UNCHANGED, newModuleLoads: ["./b.ts"] })])
      .size,
  ).toBe(0);
});

test("an imports-only hold that drops a module load decides nothing", () => {
  // Why: dropping the file's last load of a module stops its top-level code from running here.
  expect(
    ruleDecisionsOf([
      importsOnly({ ...UNCHANGED, droppedModuleLoads: ["./b.ts"] }),
    ]).size,
  ).toBe(0);
});

test("an imports-only hold whose load inputs are missing or not arrays decides nothing", () => {
  // Why: an input that is not there cannot show the loads are unchanged; it must not default to
  // "none".
  const order = { valueImportOrderChanged: false };
  for (const inputs of [
    { ...order },
    { ...order, newModuleLoads: [] },
    { ...order, droppedModuleLoads: [] },
    { ...order, newModuleLoads: null, droppedModuleLoads: [] },
    { ...order, newModuleLoads: [], droppedModuleLoads: "none" },
  ])
    expect(ruleDecisionsOf([importsOnly(inputs)]).size).toBe(0);
});

test("an imports-only hold whose value imports are reordered, or whose order input is missing or not a boolean, decides nothing", () => {
  // Why: the order of value imports is the order their modules run, so a reorder can change what
  // runs first; an input that is not there cannot show the order is the same.
  const { valueImportOrderChanged: _order, ...loads } = UNCHANGED;
  for (const inputs of [
    { ...UNCHANGED, valueImportOrderChanged: true },
    { ...loads },
    { ...loads, valueImportOrderChanged: null },
    { ...loads, valueImportOrderChanged: "false" },
  ])
    expect(ruleDecisionsOf([importsOnly(inputs)]).size).toBe(0);
  expect(ruleDecisionsOf([importsOnly(UNCHANGED)]).size).toBe(1);
});

for (const rule of [
  "comment-only",
  "markdown-prose",
  "deletion-only",
] as const) {
  test(`a holding ${rule} judgement decides nothing`, () => {
    // Why: decision 14.17 keeps the reading for this rule (a source-text scanner, prose acted on
    // literally, or not in the list).
    expect(ruleDecisionsOf([judgement(rule)]).size).toBe(0);
  });
}

test("a judgement that does not hold decides nothing, whatever its rule", () => {
  // Why: only a hold says what the rule found; not-held or not-evaluated says it could not.
  const rules = [
    "generated",
    "blank-rows-only",
    "whitespace-only",
    "moved-unchanged",
  ] as const;
  expect(
    ruleDecisionsOf(rules.map((rule) => judgement(rule, { holds: false })))
      .size,
  ).toBe(0);
  expect(
    ruleDecisionsOf([
      SectionRuleJudgement.parse({
        ...importsOnly(UNCHANGED),
        result: "not-evaluated",
        reason: "relations-not-read",
      }),
    ]).size,
  ).toBe(0);
});

test("two decisions of one section: the first in the table's order, in any input order", () => {
  // Why: the decision a reader is told must not depend on the order judgements were stored in.
  const moved = judgement("moved-unchanged");
  const imports = importsOnly(UNCHANGED);
  const blank = judgement("blank-rows-only");
  const other = judgement("whitespace-only", { key: KEY_B });
  for (const order of [
    [moved, imports, blank, other],
    [blank, other, imports, moved],
    [other, moved, blank, imports],
  ]) {
    const decisions = ruleDecisionsOf(order);
    expect(decisions.size).toBe(2);
    expect(decisions.get(KEY_A)?.rule).toBe("blank-rows-only");
    expect(decisions.get(KEY_B)?.rule).toBe("whitespace-only");
  }
  // imports-only stands ahead of moved-unchanged, so the decision carries no limit.
  expect(ruleDecisionsOf([moved, imports]).get(KEY_A)).toMatchObject({
    rule: "imports-only",
    limit: null,
  });
  // An excluded imports-only hold gives way to the next deciding rule.
  expect(
    ruleDecisionsOf([
      importsOnly({ ...UNCHANGED, newModuleLoads: ["./b.ts"] }),
      moved,
    ]).get(KEY_A),
  ).toMatchObject({ rule: "moved-unchanged", limit: MOVED_LIMIT });
});
