// Why: one integrated investigation replaces the overlapping general-review passes. Only cited
// examined work may be approved, and retained concerns must survive cutoff without a verdict.
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { z } from "zod";
import { planReadings } from "../src/readings/plan.ts";
import { renderReading } from "../src/readings/reading.ts";
import {
  laneReviewStep,
  LaneReviewStored,
  offeredDigest,
} from "../src/readings/steps.ts";
import {
  comprehensiveBounds,
  comprehensiveStep,
  comprehensiveSystem,
  type ComprehensiveAnswer,
} from "../src/readings/comprehensive.ts";
import {
  recordedClaimVerifyStep,
  claimVerdict,
} from "../src/readings/claims.ts";
import {
  reviewerClaims,
  reviewClaimKey,
  type RecordedReviewClaim,
} from "../src/readings/reviewer-claims.ts";
import type { AgentResult } from "../src/pi/stages/agent.ts";
import { zeroUsage } from "../src/route.ts";
import { defineTool, READ_ONLY } from "../src/toolkit.ts";
import { mixedRange } from "./fixtures/readings.ts";

const result = <O>(output?: O): AgentResult<O> => ({
  agent: "lane-review.test",
  stage: "verify",
  status: "submitted",
  output,
  endedBy: "submit",
  turnsUsed: 1,
  finalGeneration: false,
  turnLimit: 6,
  costUsd: null,
  resumedTurns: 0,
  restarted: false,
  modelCalls: 1,
  usage: zeroUsage,
});
const build = (retained: Array<RecordedReviewClaim> = []) => {
  const source = mixedRange();
  const plan = planReadings({
    hunks: source.hunks,
    structures: source.structures,
  });
  const reading = renderReading(plan, plan.groups[0]!.id, {
    for: "lane-review",
    hunks: new Map(source.hunks.map((hunk) => [hunk.hunkId, hunk])),
    structures: source.structures,
    scopeAndTests: true,
  });
  const base = laneReviewStep({
    stage: "verify",
    reading,
    goal: { goal: "Keep parsing correct", doneWhen: [] },
    tools: [],
    scopeAndTests: true,
    keys: { frame: "frame", manifest: "manifest" },
    multiTurn: true,
  });
  const step = comprehensiveStep({
    base,
    index: reading.index,
    state: { load: () => {}, save: () => ({}) },
    claims: () => retained,
    identity: { assignment: plan.groups[0], source: "immutable" },
    turns: 6,
  });
  const answer: ComprehensiveAnswer = {
    review: {
      files: reading.index.files.map((file) => ({
        f: file.index,
        checked: "Trace the return and error paths",
        rows: null,
      })),
      sections: {
        a: reading.index.sections.map((section) => section.index),
        r: [],
        u: [],
      },
      comments: [],
      unsure: [],
      notAsked: [],
    },
    checks: reading.index.sections.map((section) => {
      const line = section.owned[0]!;
      return {
        s: section.index,
        checked: "Trace the changed return and error paths against the caller",
        cites: [
          `${section.file}${line.side === "new" ? "n" : "o"}${line.startLine}`,
        ],
      };
    }),
  };
  return { step, answer, reading };
};

test("all four concerns form one investigation with no quota or compulsory category reports", () => {
  const { step, answer } = build();
  for (const concern of [
    "scope fit",
    "correctness",
    "risky edges",
    "tests and proof",
  ])
    expect(comprehensiveSystem).toContain(concern);
  expect(step.spec.check!(answer)).toEqual([]);
  expect(step.compose(result(answer)).answer.comments).toEqual([]);
  expect(step.spec.turnLimit).toBe(6);
  expect(step.inputs.offered).toBe(offeredDigest(step.spec));
  expect(comprehensiveBounds(96_000, 20).turns).toBeLessThanOrEqual(10);
  expect(comprehensiveBounds(96_000, 20).readingChars).toBeLessThanOrEqual(
    64_000,
  );
});

test("uncited checklist completion and unknown citations cannot manufacture approval", () => {
  const { step, answer } = build();
  const invalid = {
    ...answer,
    checks: answer.checks.map((check) => ({
      ...check,
      cites: ["unknown"],
      checked: "checked",
    })),
  };
  expect(step.spec.check!(invalid).length).toBeGreaterThan(0);
  const stored = step.compose(result(step.spec.repair!(invalid)));
  expect(stored.answer.sections.a).toEqual([]);
  expect(stored.answer.sections.u.length).toBeGreaterThan(0);
  expect(LaneReviewStored.safeParse(stored).success).toBe(true);
});

test("lookup tools remain usable after the first turn in comprehensive Lane review", async () => {
  const { reading } = build();
  let reads = 0;
  const tool = defineTool({
    name: "read",
    description: "read frozen source",
    input: z.strictObject({}),
    hints: READ_ONLY,
    handle: () => Effect.sync(() => ({ text: `source ${++reads}` })),
  });
  const step = laneReviewStep({
    stage: "verify",
    reading,
    goal: { goal: "Goal", doneWhen: [] },
    tools: [tool],
    multiTurn: true,
    keys: { frame: "f", manifest: "m" },
  });
  step.spec.state!.load(undefined, 3);
  expect((await Effect.runPromise(step.spec.tools[0]!.handle({}))).text).toBe(
    "source 1",
  );
});

test("partial output retains supported claims but leaves every section explicitly unanswered", () => {
  const { step, answer, reading } = build();
  const partial = step.partial!(result(answer));
  expect(partial.answer.sections.a).toEqual([]);
  expect([...partial.unanswered]).toEqual([...reading.sectionKeys]);
  expect(partial.claims).toEqual([]);
});

test("oversized claim verification stays unconfirmed rather than confirming truncated evidence", () => {
  const observation = {
    anchor: { path: "source", side: "new" as const, startLine: 1, endLine: 1 },
    kind: "defect" as const,
    text: "Broken return",
    fails: "caller receives undefined",
    evidence: ["section.1"],
    row: null,
  };
  const claim: RecordedReviewClaim = {
    key: reviewClaimKey(observation),
    observation,
    section: "section",
    ownership: "owned",
    evidence: [{ reference: "section.1", text: "source".repeat(6000) }],
  };
  const step = recordedClaimVerifyStep({ claim, turnLimit: 1 });
  const stored = step.compose(
    result({ decision: "keep" as const, reason: "Looks correct" }),
  );
  expect(claimVerdict(stored)).toBe("unconfirmed");
  expect(stored.reason).toContain("exceeds");
});

test("a retained supported defect survives final omission and cannot sit beside approval", () => {
  const retained: Array<RecordedReviewClaim> = [];
  const { step, answer, reading } = build(retained);
  const section = reading.index.sections[0]!;
  const owned = section.owned[0]!;
  const observation = {
    anchor: {
      path: reading.index.files.find((file) => file.index === section.file)!
        .path,
      ...owned,
    },
    kind: "defect" as const,
    text: "The changed path breaks its caller",
    fails: "A null result is dereferenced",
    evidence: ["section.1"],
    row: null,
  };
  retained.push({
    key: reviewClaimKey(observation),
    observation,
    section: section.key,
    ownership: "owned",
    evidence: [{ reference: "section.1", text: "actual changed source" }],
  });
  expect(step.spec.check!(answer).join(" ")).toContain("retained defect");
  const stored = step.compose(result(step.spec.repair!(answer)));
  expect(stored.answer.sections.a).not.toContain(section.index);
  expect(stored.answer.sections.u).toContain(section.index);
  expect(step.partial!(result(answer)).claims).toEqual(retained);
});

test("claim verification identity includes its composed destination section", () => {
  const observation = {
    anchor: { path: "source", side: "new" as const, startLine: 1, endLine: 1 },
    kind: "defect" as const,
    text: "Broken return",
    fails: "Caller receives undefined",
    evidence: ["section.1"],
    row: null,
  };
  const claim: RecordedReviewClaim = {
    key: reviewClaimKey(observation),
    observation,
    section: "old-section",
    ownership: "owned",
    evidence: [{ reference: "section.1", text: "exact source" }],
  };
  const old = recordedClaimVerifyStep({ claim, turnLimit: 1 });
  const changed = recordedClaimVerifyStep({
    claim: { ...claim, section: "new-section" },
    turnLimit: 1,
  });
  expect(old.inputs).not.toEqual(changed.inputs);
  expect(
    old.compose(result({ decision: "keep" as const, reason: "Read source" }))
      .section,
  ).toBe("old-section");
  expect(
    changed.compose(
      result({ decision: "keep" as const, reason: "Read source" }),
    ).section,
  ).toBe("new-section");
});

// Why: a test process that imported steps first hid the adapter/store schema cycle. Each entry
// order must execute in a fresh module graph rather than reusing this test's loaded modules.
for (const order of [
  ["comprehensive", "steps"],
  ["steps", "comprehensive"],
]) {
  test(`fresh process initializes reviewer modules in ${order.join(" then ")} order`, async () => {
    const modules = order.map(
      (name) => new URL(`../src/readings/${name}.ts`, import.meta.url).href,
    );
    const source = `const first = await import(${JSON.stringify(modules[0])}); const second = await import(${JSON.stringify(modules[1])}); const adapter = ${order[0] === "comprehensive" ? "first" : "second"}; const store = ${order[0] === "steps" ? "first" : "second"}; if (!adapter.ComprehensiveAnswer || !store.LaneReviewStored) throw new Error("Missing review schemas"); console.log("reviewer schemas initialized");`;
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", "--eval", source],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout).toContain("reviewer schemas initialized");
  });
}
