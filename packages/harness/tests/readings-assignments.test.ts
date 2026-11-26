// Why: ownership omissions and overlaps can hide work or attach review authority to the wrong
// source. These tests check actual manifest rows and explicit exclusions, not only packing labels.
import { expect, test } from "bun:test";
import {
  ASSIGNMENT_RECIPE,
  AssignmentPlan,
  RetainedReadingPlan,
  assignmentOwner,
  isAssignmentPlan,
  planAssignments,
  validateAssignments,
  type AssignmentInput,
} from "../src/readings/assignments.ts";
import { planReadings } from "../src/readings/plan.ts";
import { mapExclusion } from "../src/review-map.ts";
import { diff, mixedRange } from "./fixtures/readings.ts";

const source = {
  manifestKey: "manifest-1",
  frameKey: "frame-1",
  mapKey: "map-1",
};
const inputOf = (): AssignmentInput => {
  const range = mixedRange();
  const included = range.hunks.filter(
    (hunk) => mapExclusion(hunk.path, [hunk]) === undefined,
  );
  return {
    ...range,
    source,
    batches: [
      {
        id: "parsing",
        hunkIds: included
          .filter((h) => h.path.startsWith("src/"))
          .map((h) => h.hunkId),
        doneWhen: ["D1"],
      },
      {
        id: "other",
        hunkIds: included
          .filter((h) => !h.path.startsWith("src/"))
          .map((h) => h.hunkId),
        doneWhen: ["D2"],
      },
    ],
  };
};

const anchor = (
  section: ReturnType<typeof planAssignments>["sections"][number],
) => {
  const range = section.owned[0]!;
  return {
    path: section.path,
    side: range.side,
    startLine: range.startLine,
    endLine: range.endLine,
  };
};

test("small batches each have a comprehensive assignment; section identities and row ownership remain unchanged", () => {
  const input = inputOf();
  const plan = planAssignments(input);
  const legacy = planReadings(input);
  expect(plan.recipe).toBe(ASSIGNMENT_RECIPE);
  expect(plan.source).toEqual(source);
  expect(plan.sections).toEqual(legacy.sections);
  expect(plan.unread).toEqual(legacy.unread);
  expect(plan.groups.filter((g) => g.batchId === "parsing")).toHaveLength(1);
  expect(plan.groups.find((g) => g.batchId === "parsing")!.paths).toContain(
    "src/parse.test.ts",
  );
  expect(validateAssignments(plan, input.hunks)).toEqual(plan);
  expect(AssignmentPlan.safeParse(plan).success).toBe(true);
  expect(isAssignmentPlan(RetainedReadingPlan.parse(plan))).toBe(true);
  expect(isAssignmentPlan(RetainedReadingPlan.parse(legacy))).toBe(false);
});

test("large batches split at reading bounds, and shared path affinity cannot mix batch owners", () => {
  const input = inputOf();
  const plan = planAssignments({
    ...input,
    bounds: { maxItems: 1 },
    affinity: new Map(input.hunks.map((h) => [h.path, ["all-related"]])),
  });
  expect(plan.groups.length).toBeGreaterThan(plan.batches.length);
  const grouped = plan.groups.flatMap((g) => g.keys);
  expect(grouped.sort()).toEqual(plan.sections.map((s) => s.key).sort());
  for (const group of plan.groups) {
    expect(group.keys).toHaveLength(1);
    const section = plan.sections.find((s) => s.key === group.keys[0])!;
    expect(
      section.hunkIds.every((id) =>
        plan.batches.find((b) => b.id === group.batchId)!.hunkIds.includes(id),
      ),
    ).toBe(true);
  }
});

test("batch, source, section and context order permutations produce byte-identical plans", () => {
  const input = inputOf();
  const first = planAssignments(input);
  const a = first.sections.find((s) => s.path === "src/parse.ts")!;
  const b = first.sections.find((s) => s.path === "notes.txt")!;
  const context = [
    { anchorKey: a.key, sectionKey: b.key, reason: "Required input format" },
    { anchorKey: b.key, sectionKey: a.key, reason: "Consumer of this format" },
  ];
  const normal = planAssignments({ ...input, context });
  const reversed = planAssignments({
    ...input,
    hunks: [...input.hunks].reverse(),
    structures: new Map([...input.structures].reverse()),
    batches: [...input.batches]
      .reverse()
      .map((batch) => ({ ...batch, hunkIds: [...batch.hunkIds].reverse() })),
    context: [...context].reverse(),
  });
  expect(JSON.stringify(reversed)).toBe(JSON.stringify(normal));
});

test("cross-batch callers stay context, with one primary owner and no transfer of approval", () => {
  const helper = diff(
    "src/helper.ts",
    "export const helper = () => 1;\n",
    "export const helper = () => null;\n",
  );
  const caller = diff(
    "src/caller.ts",
    "const value = 1;\n",
    "const value = helper().toString();\n",
  );
  const input: AssignmentInput = {
    source,
    hunks: [...helper, ...caller],
    structures: new Map(),
    batches: [
      { id: "helper", hunkIds: helper.map((h) => h.hunkId), doneWhen: ["D1"] },
      { id: "caller", hunkIds: caller.map((h) => h.hunkId), doneWhen: ["D2"] },
    ],
  };
  const bare = planAssignments(input);
  const helperSection = bare.sections.find((s) => s.path === "src/helper.ts")!;
  const callerSection = bare.sections.find((s) => s.path === "src/caller.ts")!;
  const reference = {
    anchorKey: helperSection.key,
    sectionKey: callerSection.key,
    reason: "Caller dereferences the helper result",
  };
  const plan = planAssignments({ ...input, context: [reference] });
  const helperGroup = plan.groups.find((g) => g.batchId === "helper")!;
  expect(helperGroup.keys).toEqual([helperSection.key]);
  expect(helperGroup.context).toEqual([{ ...reference, approval: "none" }]);
  expect(plan.groups.find((g) => g.batchId === "caller")!.keys).toEqual([
    callerSection.key,
  ]);
  expect(assignmentOwner(plan, anchor(callerSection), input.hunks)).toEqual({
    status: "owned",
    batchId: "caller",
    sectionKey: callerSection.key,
    assignmentId: plan.groups.find((g) => g.batchId === "caller")!.id,
  });
  expect(
    assignmentOwner(
      plan,
      {
        path: "unchanged.ts",
        side: "new",
        startLine: 1,
        endLine: 1,
      },
      input.hunks,
    ),
  ).toEqual({ status: "unassigned", reason: "unknown", sectionKeys: [] });
});

test("deleted rows, renamed paths, mode changes and explicit exclusions retain their source rules", () => {
  const input = inputOf();
  const plan = planAssignments(input);
  const deleted = plan.sections.find((s) => s.path === "src/old.ts")!;
  expect(deleted.owned.every((r) => r.side === "old")).toBe(true);
  expect(assignmentOwner(plan, anchor(deleted), input.hunks).status).toBe(
    "owned",
  );
  const renamed = plan.sections.find((s) => s.path === "docs/guide.md")!;
  expect(renamed.identity.renamedFrom).not.toBeNull();
  for (const range of renamed.owned.filter((r) => r.side === "old")) {
    expect(
      assignmentOwner(
        plan,
        {
          path: renamed.identity.renamedFrom!,
          side: "old",
          startLine: range.startLine,
          endLine: range.endLine,
        },
        input.hunks,
      ).status,
    ).toBe("owned");
  }
  expect(Object.fromEntries(plan.unread.map((s) => [s.path, s.cause]))).toEqual(
    {
      "assets/logo.png": "unreadable",
      "bun.lock": "excluded",
      "data/big.txt": "too-large",
      "scripts/run.sh": "unreadable",
      "src/gen/api.ts": "excluded",
    },
  );
  const big = plan.unread.find((s) => s.path === "data/big.txt")!;
  expect(assignmentOwner(plan, anchor(big), input.hunks)).toMatchObject({
    status: "unassigned",
    reason: "unread",
    sectionKeys: [big.key],
  });
});

test("submodule pointer sections stay alone, even inside the same batch as their caller", () => {
  const pointer = diff(
    "lib/vendor",
    `Subproject commit ${"1".repeat(40)}\n`,
    `Subproject commit ${"2".repeat(40)}\n`,
  ).map((h) => ({ ...h, oldMode: "160000", newMode: "160000" }));
  const code = diff(
    "lib/read.ts",
    "const version = 1;\n",
    "const version = 2;\n",
  );
  const hunks = [...pointer, ...code];
  const plan = planAssignments({
    source,
    hunks,
    structures: new Map(),
    batches: [
      { id: "version", hunkIds: hunks.map((h) => h.hunkId), doneWhen: [] },
    ],
  });
  expect(plan.groups).toHaveLength(2);
  expect(
    plan.groups.find((g) => g.paths.includes("lib/vendor"))!.paths,
  ).toEqual(["lib/vendor"]);
  expect(validateAssignments(plan, hunks)).toEqual(plan);
});

test("unsettled, duplicate, unknown and section-crossing batch ownership is rejected", () => {
  const input = inputOf();
  const first = input.batches[0]!;
  expect(() => planAssignments({ ...input, batches: [] })).toThrow(
    "no batch owner",
  );
  expect(() =>
    planAssignments({
      ...input,
      batches: [...input.batches, { ...first, id: "again" }],
    }),
  ).toThrow("more than one batch");
  expect(() =>
    planAssignments({
      ...input,
      batches: [
        ...input.batches,
        { id: "unknown", hunkIds: ["absent"], doneWhen: [] },
      ],
    }),
  ).toThrow("unknown hunk");
  expect(() =>
    planAssignments({ ...input, source: { ...source, mapKey: "" } }),
  ).toThrow();
  const copy = structuredClone(planAssignments(input));
  copy.groups[0]!.batchId =
    copy.groups[0]!.batchId === "parsing" ? "other" : "parsing";
  expect(() => validateAssignments(copy, input.hunks)).toThrow("crosses batch");
});

test("coverage validation rejects actual missing, invented and overlapping rows despite unique keys", () => {
  const input = inputOf();
  const plan = planAssignments(input);
  const missing = structuredClone(plan);
  missing.sections[0]!.owned = [];
  expect(() => validateAssignments(missing, input.hunks)).toThrow(
    "missing or invented",
  );
  const invented = structuredClone(plan);
  invented.sections[0]!.owned[0]!.endLine += 100;
  expect(() => validateAssignments(invented, input.hunks)).toThrow();
  const overlap = structuredClone(plan);
  overlap.sections[0]!.owned.push({ ...overlap.sections[0]!.owned[0]! });
  expect(() => validateAssignments(overlap, input.hunks)).toThrow(
    "overlapping changed-row",
  );
  const missingNontext = structuredClone(plan);
  missingNontext.unread = missingNontext.unread.filter(
    (s) => s.path !== "scripts/run.sh",
  );
  expect(() => validateAssignments(missingNontext, input.hunks)).toThrow(
    "no section",
  );
  const duplicateManifest = [...input.hunks, input.hunks[0]!];
  expect(() => validateAssignments(plan, duplicateManifest)).toThrow(
    "duplicate manifest",
  );
});

test("coverage validation rejects dropped/duplicated assignments, unread assignments and false exclusions", () => {
  const input = inputOf();
  const plan = planAssignments(input);
  const omitted = structuredClone(plan);
  omitted.groups.pop();
  expect(() => validateAssignments(omitted, input.hunks)).toThrow(
    "no primary assignment",
  );
  const duplicate = structuredClone(plan);
  duplicate.groups.push({ ...duplicate.groups[0]!, id: "another" });
  expect(() => validateAssignments(duplicate, input.hunks)).toThrow(
    "more than one primary",
  );
  const unread = structuredClone(plan);
  unread.groups[0]!.keys = [unread.unread[0]!.key];
  expect(() => validateAssignments(unread, input.hunks)).toThrow(
    "unknown or unread",
  );
  const falseExclusion = structuredClone(plan);
  const section = falseExclusion.sections.pop()!;
  falseExclusion.unread.push({ ...section, cause: "excluded" });
  expect(() => validateAssignments(falseExclusion, input.hunks)).toThrow();
});

test("bad context references are explicit errors, not silently dropped observations", () => {
  const input = inputOf();
  const plan = planAssignments(input);
  const first = plan.sections[0]!;
  const second = plan.sections.find((s) => s.path === "src/parse.ts")!;
  expect(() =>
    planAssignments({
      ...input,
      context: [
        { anchorKey: "unknown", sectionKey: second.key, reason: "Caller" },
      ],
    }),
  ).toThrow("no primary assignment");
  expect(() =>
    planAssignments({
      ...input,
      context: [
        { anchorKey: first.key, sectionKey: "unknown", reason: "Caller" },
      ],
    }),
  ).toThrow("context");
  expect(() =>
    planAssignments({
      ...input,
      context: [
        { anchorKey: first.key, sectionKey: first.key, reason: "Own work" },
      ],
    }),
  ).toThrow("outside owned work");
});

test("old-side source aliases come only from the immutable manifest, not retained identity metadata", () => {
  const input = inputOf();
  const plan = planAssignments(input);
  const section = plan.sections.find((s) => s.path === "src/parse.ts")!;
  const owned = section.owned.find((r) => r.side === "old")!;
  const forged = structuredClone(plan);
  forged.sections.find((s) => s.key === section.key)!.identity.renamedFrom =
    "invented.ts";
  expect(() => validateAssignments(forged, input.hunks)).toThrow(
    "renamed source",
  );
  expect(() =>
    assignmentOwner(
      forged,
      {
        path: "invented.ts",
        side: "old",
        startLine: owned.startLine,
        endLine: owned.endLine,
      },
      input.hunks,
    ),
  ).toThrow("renamed source");
  expect(
    assignmentOwner(
      plan,
      {
        path: "invented.ts",
        side: "old",
        startLine: owned.startLine,
        endLine: owned.endLine,
      },
      input.hunks,
    ),
  ).toMatchObject({ status: "unassigned", reason: "unknown" });
  const renamed = plan.sections.find((s) => s.path === "docs/guide.md")!;
  const newRow = renamed.owned.find((r) => r.side === "new")!;
  expect(
    assignmentOwner(
      plan,
      {
        path: renamed.identity.renamedFrom!,
        side: "new",
        startLine: newRow.startLine,
        endLine: newRow.endLine,
      },
      input.hunks,
    ),
  ).toMatchObject({ status: "unassigned", reason: "unknown" });
});

test("source rows repeated under different hunk labels cannot acquire two owners", () => {
  const input = inputOf();
  const hunk = input.hunks.find((h) => h.ownedRanges.length > 0)!;
  expect(() =>
    validateAssignments(planAssignments(input), [
      ...input.hunks,
      { ...hunk, hunkId: "duplicate-source" },
    ]),
  ).toThrow("overlapping changed-row");
});

test("rule-decided sections retain their explicit decision without a comprehensive assignment", () => {
  const input = inputOf();
  const initial = planAssignments(input);
  const section = initial.sections.find((s) => s.path === "src/parse.test.ts")!;
  const decision = {
    rule: "whitespace-only" as const,
    version: 1,
    judgement: `${section.key}.rule:whitespace-only`,
    statement: "Only whitespace changed.",
    limit: null,
  };
  const plan = planAssignments({
    ...input,
    decided: new Map([[section.key, decision]]),
  });
  expect(plan.unread.find((s) => s.key === section.key)).toMatchObject({
    cause: "rule-decided",
    decidedBy: decision,
  });
  expect(plan.groups.some((g) => g.keys.includes(section.key))).toBe(false);
  expect(assignmentOwner(plan, anchor(section), input.hunks)).toMatchObject({
    status: "unassigned",
    reason: "unread",
  });
});

test("anchors spanning several section owners remain ambiguous rather than transferring authority", () => {
  const input = inputOf();
  const plan = planAssignments({ ...input, bounds: { maxItems: 1 } });
  const sections = plan.sections.filter((s) => s.path === "src/parse.ts");
  const rows = sections.flatMap((s) => s.owned.filter((r) => r.side === "new"));
  expect(sections.length).toBeGreaterThan(1);
  expect(
    assignmentOwner(
      plan,
      {
        path: "src/parse.ts",
        side: "new",
        startLine: Math.min(...rows.map((r) => r.startLine)),
        endLine: Math.max(...rows.map((r) => r.endLine)),
      },
      input.hunks,
    ),
  ).toMatchObject({
    status: "unassigned",
    reason: "ambiguous",
    sectionKeys: sections.map((s) => s.key).sort(),
  });
  expect(() =>
    assignmentOwner(
      plan,
      { path: "src/parse.ts", side: "new", startLine: 0, endLine: 1 },
      input.hunks,
    ),
  ).toThrow("invalid primary anchor");
});
