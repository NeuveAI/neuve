// Why: citations determine the scope basis passed to later review. Unknown or unshown
// sources must not become scope, and the fallback must preserve candidate wording.
import { expect, test } from "bun:test";
import {
  Frame,
  composeFrame,
  fallbackFrame,
  frameProblems,
  repairFrame,
  type FrameSubmission,
} from "../src/frame.ts";
import { ScopeSnapshot, type ScopeSource } from "../src/scope.ts";
const source = (id: string, stratum: ScopeSource["stratum"]): ScopeSource => ({
  id,
  kind: "repository-document",
  stratum,
  fetchedAt: "2026-11-03T00:00:00Z",
  ms: 0,
  status: "fetched",
  ref: { found: "test", path: `${id}.md` },
  title: id,
  sections: [
    {
      id: `${id}.s1`,
      title: "Done when",
      startLine: 1,
      endLine: 3,
      bytes: 100,
      sha256: "0".repeat(64),
    },
  ],
  capture: null,
  gap: null,
});
const snapshot = ScopeSnapshot.parse({
  cycleId: "cycle",
  fetchedAt: "2026-11-03T00:00:00Z",
  ms: 0,
  range: { baseOid: "base", headOid: "head", mergeBase: "base" },
  integrations: { file: "absent", detail: null, servers: [] },
  named: [],
  sources: [
    source("base", "plan-or-ticket-at-base"),
    source("range", "plan-inside-range"),
    source("commit", "commit-or-pr-text"),
  ],
  strata: {
    strongest: "plan-or-ticket-at-base",
    present: [
      "plan-or-ticket-at-base",
      "plan-inside-range",
      "commit-or-pr-text",
    ],
  },
  gaps: [],
});
const candidates = [
  {
    id: "O1",
    sourceId: "range",
    sectionId: "range.s1",
    text: "The saved value survives restart",
  },
];
const checks = { snapshot, candidates };
const submission: FrameSubmission = {
  goal: "Persist the saved value",
  stratum: "plan-inside-range",
  sourceIds: ["range"],
  doneWhen: [
    { text: candidates[0]!.text, candidateId: "O1", sectionId: "range.s1" },
  ],
};
const figures = {
  sectionsInlined: 1,
  sectionsListed: 3,
  commitsShown: 1,
  commitsTotal: 1,
};
test("frame accepts cited scope and code assigns ids and obligation basis", () => {
  expect(frameProblems(submission, checks)).toEqual([]);
  const frame = Frame.parse(composeFrame(submission, figures));
  expect(frame.doneWhen).toEqual([
    { ...submission.doneWhen[0]!, id: "D1", basis: "done-when" },
  ]);
});
test("repair removes unknown citations, duplicates and an unsupported stratum", () => {
  const invalid: FrameSubmission = {
    ...submission,
    stratum: "plan-or-ticket-at-base",
    sourceIds: ["missing"],
    doneWhen: [
      {
        text: "Inspect the change",
        candidateId: "missing",
        sectionId: "missing",
      },
      { text: "Inspect the change", candidateId: null, sectionId: null },
      submission.doneWhen[0]!,
    ],
  };
  expect(frameProblems(invalid, checks).length).toBeGreaterThan(0);
  const repaired = repairFrame(invalid, checks);
  expect(frameProblems(repaired, checks)).toEqual([]);
  expect(repaired.stratum).toBe("plan-inside-range");
  expect(repaired.sourceIds).toEqual([]);
  expect(repaired.doneWhen).toHaveLength(2);
});
test("inferred frame has no citations; valid citations from a different stratum cannot justify the claimed one", () => {
  expect(
    frameProblems({ ...submission, stratum: "nothing" }, checks),
  ).toContain("An inferred frame cannot cite scope.");
  expect(
    frameProblems({ ...submission, stratum: "plan-or-ticket-at-base" }, checks),
  ).toContain("The stratum must have a citation in it.");
  const inferred = repairFrame(
    {
      ...submission,
      sourceIds: [],
      doneWhen: [{ text: "Inspect", candidateId: null, sectionId: null }],
    },
    checks,
  );
  expect(inferred.stratum).toBe("nothing");
  expect(frameProblems(inferred, checks)).toEqual([]);
});
test("candidate citations are exact and unshown commit sections are rejected", () => {
  expect(
    frameProblems(
      {
        ...submission,
        doneWhen: [
          { ...submission.doneWhen[0]!, text: "A changed paraphrase" },
        ],
      },
      checks,
    ),
  ).toContain("Quote O1 exactly and cite its section.");
  const hidden: FrameSubmission = {
    ...submission,
    sourceIds: [],
    stratum: "commit-or-pr-text",
    doneWhen: [{ text: "Inspect", candidateId: null, sectionId: "commit.s1" }],
  };
  const limited = { ...checks, sections: new Set(["range.s1"]) };
  expect(frameProblems(hidden, limited)).toContain(
    "Unknown section commit.s1.",
  );
  expect(repairFrame(hidden, limited).doneWhen[0]?.sectionId).toBeNull();
});
test("fallback uses first five exact candidates, including text longer than the model's output cap", () => {
  const long = "Saved values " + "must survive restart. ".repeat(12);
  const items = Array.from({ length: 6 }, (_, i) => ({
    id: `O${i + 1}`,
    sourceId: "range",
    sectionId: "range.s1",
    text: `${i} ${long}`,
  }));
  const frame = Frame.parse(
    fallbackFrame({ snapshot, candidates: items }, ["src"], 420, figures),
  );
  expect(frame.source).toBe("fallback");
  expect(frame.doneWhen.map((d) => d.text)).toEqual(
    items.slice(0, 5).map((c) => c.text),
  );
  expect(frame.stratum).toBe("plan-inside-range");
  expect(frame.gaps).toHaveLength(1);
  const inferred = fallbackFrame(
    { snapshot: undefined, candidates: [] },
    [],
    0,
    figures,
  );
  expect(inferred.doneWhen.map((d) => d.basis)).toEqual(["gathered"]);
  expect(inferred.stratum).toBe("nothing");
});

test("repair deduplicates conditions after restoring their candidate wording", () => {
  const invalid: FrameSubmission = {
    ...submission,
    doneWhen: [
      { ...submission.doneWhen[0]!, text: "first paraphrase" },
      { ...submission.doneWhen[0]!, text: "second paraphrase" },
    ],
  };
  const fixed = repairFrame(invalid, checks);
  expect(fixed.doneWhen).toHaveLength(1);
  expect(frameProblems(fixed, checks)).toEqual([]);
});

// Why: Frame has no lookup tools, including when its scope exceeds the input bound.
import { Effect } from "effect";
import { lookupContext } from "../src/pipeline.ts";
import { scopeBlock } from "../src/scope-text.ts";
import { view } from "./find-fixture.ts";
import { storeFixture } from "./fixtures/link.ts";
test("Frame lists omitted scope without naming an unavailable tool", async () => {
  const store = storeFixture("frame-scope-");
  const text = await store.run(
    Effect.gen(function* () {
      const ctx = yield* store.ctx();
      const lookup = lookupContext(ctx, { ...view(), snapshot });
      return yield* scopeBlock(lookup, 0, undefined, "frame");
    }),
  );
  expect(text).toContain("not included");
  expect(text).toContain("base.s1");
  expect(text).not.toContain("scope_section");
});

// Why: a source and one of its sections must remain distinct citation kinds on every route.
test("frame sourceIds cite the source containing a done-when section", () => {
  const cited = source("S1", "plan-inside-range");
  cited.sections[0]!.id = "S1.1";
  const scoped = {
    snapshot: { ...snapshot, sources: [cited] },
    candidates: [],
  };
  const output: FrameSubmission = {
    ...submission,
    sourceIds: ["S1"],
    doneWhen: [
      {
        text: "Preserve the saved value",
        candidateId: null,
        sectionId: "S1.1",
      },
    ],
  };
  expect(frameProblems(output, scoped)).toEqual([]);
  expect(frameProblems({ ...output, sourceIds: ["S1.1"] }, scoped)).toEqual([
    "Unknown source S1.1.",
  ]);
});
