// Why: the provider refuses a request whose answer schema is outside its subset, and that holds the
// whole review (the first probe run: an Assess answer sent back, then its final answer asked for in
// structured form, refused with `invalid_json_schema` because the rows were tuples). So each reading
// kind's submit schema is built into its wire form exactly as the provider layer builds it, for the
// submit tool and for the structured final answer, with the functions it uses, and held to the
// strict subset: and a value in that form reads back through the same path and passes zod.
import { expect, test } from "bun:test";
import type { z } from "zod";
import {
  dropAddedNulls,
  isObject,
  toStrictSchema,
} from "../src/pi/providers/wire.ts";
import type { AgentSpec } from "../src/pi/stages/agent.ts";
import {
  declarationOf,
  parseToolInput,
  submitShape,
} from "../src/pi/stages/tools.ts";
import { claimVerifyStep } from "../src/readings/claims.ts";
import { planReadings } from "../src/readings/plan.ts";
import { renderReading } from "../src/readings/reading.ts";
import { assessStep, laneReviewStep } from "../src/readings/steps.ts";
import { wireSchema } from "../src/toolkit.ts";
import { mixedRange } from "./fixtures/readings.ts";

const range = mixedRange();
const plan = planReadings({
  hunks: range.hunks,
  structures: range.structures,
  excluded: range.excluded,
});
const hunks = new Map(range.hunks.map((hunk) => [hunk.hunkId, hunk]));
const group = plan.groups[0]!.id;
const sources = { hunks, structures: range.structures };

const specs: ReadonlyArray<readonly [string, AgentSpec<unknown>]> = [
  [
    "assess",
    assessStep({
      stage: "verify",
      reading: renderReading(plan, group, { for: "assess", ...sources }),
    }).spec as AgentSpec<unknown>,
  ],
  [
    "lane-review",
    laneReviewStep({
      stage: "verify",
      reading: renderReading(plan, group, { for: "lane-review", ...sources }),
      goal: { goal: "Let callers count parsed items.", doneWhen: [] },
      tools: [],
      keys: { frame: "frame-a", manifest: "manifest-a" },
    }).spec as AgentSpec<unknown>,
  ],
  [
    "claim check",
    claimVerifyStep({
      key: "a".repeat(64),
      section: plan.groups[0]!.keys[0]!,
      comment: {
        path: "src/a.ts",
        side: "new",
        startLine: 1,
        endLine: 1,
        text: "The count is off by one.",
        fails: "The last item is dropped.",
      },
      reading: { text: "A reading." },
      turnLimit: 2,
    }).spec as AgentSpec<unknown>,
  ],
  // Scope and tests (round 11): each reading's own form, held to the same subset.
  [
    "assess, scope and tests",
    assessStep({
      stage: "verify",
      reading: renderReading(plan, group, {
        for: "assess",
        ...sources,
        scopeAndTests: true,
      }),
      scopeAndTests: true,
    }).spec as AgentSpec<unknown>,
  ],
  [
    "lane-review, scope and tests",
    laneReviewStep({
      stage: "verify",
      reading: renderReading(plan, group, {
        for: "lane-review",
        ...sources,
        scopeAndTests: true,
      }),
      goal: { goal: "Let callers count parsed items.", doneWhen: [] },
      tools: [],
      keys: { frame: "frame-a", manifest: "manifest-a" },
      scopeAndTests: true,
    }).spec as AgentSpec<unknown>,
  ],
];

/** The submit tool's parameters on the strict route: the declaration, then the strict form. */
const toolForm = (spec: AgentSpec<unknown>) =>
  toStrictSchema(declarationOf(submitShape(spec), false).parameters);

/** The final structured answer's schema: the submit schema's wire form, then the strict form. */
const finalForm = (spec: AgentSpec<unknown>) =>
  toStrictSchema(wireSchema(spec.submit.schema as z.ZodType).schema);

/** Keywords the strict subset holds; any other is outside it. */
const SUBSET = new Set([
  "type",
  "description",
  "title",
  "enum",
  "const",
  "anyOf",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "pattern",
  "format",
  "$defs",
  "$ref",
]);

/** Everything in a wire schema that the strict subset forbids, by its path. */
const outside = (schema: unknown) => {
  const found: Array<string> = [];
  const walk = (node: unknown, path: string) => {
    if (Array.isArray(node)) {
      node.forEach((item, at) => walk(item, `${path}/${at}`));
      return;
    }
    if (!isObject(node)) return;
    for (const key of Object.keys(node))
      if (!SUBSET.has(key)) found.push(`${path}: keyword ${key}`);
    if ("prefixItems" in node) found.push(`${path}: prefixItems`);
    if (Array.isArray(node["items"])) found.push(`${path}: items is an array`);
    if (node["type"] === "array" && !isObject(node["items"]))
      found.push(`${path}: an array without one items schema`);
    if (node["type"] === "object" || isObject(node["properties"])) {
      if (node["additionalProperties"] !== false)
        found.push(`${path}: additionalProperties is not false`);
      const properties = Object.keys(
        isObject(node["properties"]) ? node["properties"] : {},
      ).sort();
      const required = Array.isArray(node["required"])
        ? [...(node["required"] as Array<string>)].sort()
        : [];
      if (JSON.stringify(properties) !== JSON.stringify(required))
        found.push(`${path}: not every property is required`);
    }
    for (const [key, value] of Object.entries(node))
      if (key === "properties" || key === "$defs") {
        if (isObject(value))
          for (const [name, child] of Object.entries(value))
            walk(child, `${path}/${key}/${name}`);
      } else walk(value, `${path}/${key}`);
  };
  walk(schema, "#");
  return found;
};

/** The deepest nesting of objects, which the strict subset caps (at five levels, well past ours). */
const depthOf = (node: unknown): number => {
  if (!isObject(node)) return 0;
  const children = [
    ...Object.values(isObject(node["properties"]) ? node["properties"] : {}),
    ...(isObject(node["items"]) ? [node["items"]] : []),
    ...(Array.isArray(node["anyOf"]) ? node["anyOf"] : []),
  ];
  const below = Math.max(0, ...children.map(depthOf));
  return (node["type"] === "object" ? 1 : 0) + below;
};

/** The bound keywords the stripping moves into the description; never a silent loss. */
const DESCRIBED = new Set([
  "$schema",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
]);

test("every reading kind's submit schema is inside the provider's strict subset, as a tool and as a final answer", () => {
  for (const [kind, spec] of specs) {
    const { schema: wire, removed } = wireSchema(
      spec.submit.schema as z.ZodType,
    );
    // What the stripping removed is only bounds it states in words; nothing it would lose silently.
    expect([...removed].filter((key) => !DESCRIBED.has(key))).toEqual([]);
    for (const form of [toolForm(spec), finalForm(spec)]) {
      expect({ kind, outside: outside(form) }).toEqual({ kind, outside: [] });
      expect(form["type"]).toBe("object");
      expect(form["anyOf"]).toBeUndefined();
      expect(depthOf(form)).toBeLessThanOrEqual(5);
    }
    // By construction: the strict conversion adds and drops nothing (no optional field it would
    // make nullable, no format it would drop), so what the model writes is what zod reads.
    expect(toStrictSchema(wire)).toEqual(wire);
    expect(finalForm(spec)).toEqual(wire);
  }
});

test("a value in the strict form, nulls where a field is absent, reads back and passes the schema", () => {
  const [assess, review, claim] = specs.map(([, spec]) => spec);
  const values: ReadonlyArray<readonly [AgentSpec<unknown>, unknown]> = [
    [
      assess!,
      {
        factors: [{ f: "connections", t: "Two callers.", cites: ["0n1"] }],
        requirements: [],
        impact: [],
        classes: [
          {
            S: [1, 3],
            c: "h",
            v: "e",
            F: [0],
            R: [],
            person: null,
            gaps: null,
          },
          {
            S: [2],
            c: "l",
            v: "h",
            F: [],
            R: [],
            person: { need: "no", why: "A check covers it." },
            gaps: [{ axis: "complexity", kind: "callers", t: "Not shown." }],
          },
        ],
      },
    ],
    [
      review!,
      {
        files: [
          { f: 0, checked: "Read it.", rows: null },
          {
            f: 1,
            checked: "Read it.",
            // Each row gives its reading beside its status (answer version 6, the row-reading round).
            rows: [
              {
                row: "D1",
                reading: "The changed code reads as doing it.",
                status: "no-evidence",
                cites: [],
              },
            ],
          },
        ],
        sections: { a: [1], r: [], u: [2] },
        comments: [
          {
            s: 1,
            side: "new",
            start: 1,
            end: 1,
            kind: "risk",
            effect: null,
            t: "An empty list.",
            cites: [],
            fails: "",
            row: null,
          },
        ],
        unsure: [],
      },
    ],
    [claim!, { decision: "keep", reason: "The cited lines show it." }],
  ];
  for (const [spec, value] of values) {
    // The final answer, read as agent-step.ts reads it.
    const back = dropAddedNulls(finalForm(spec), value);
    expect(back).toEqual(value);
    expect(spec.submit.schema.safeParse(back).success).toBe(true);
    // The submit tool's call, read as the tool and the step read it.
    const shape = submitShape(spec);
    expect(
      parseToolInput(declarationOf(shape, false), shape.input, value),
    ).toEqual({
      success: true,
      data: value,
    });
  }
  // A field left out, which strict output never writes, is not the schema.
  const { person: _person, ...noPerson } = (
    values[0]![1] as { classes: Array<Record<string, unknown>> }
  ).classes[0]!;
  expect(
    assess!.submit.schema.safeParse({
      ...(values[0]![1] as object),
      classes: [noPerson],
    }).success,
  ).toBe(false);
});

// Why (round 2f): the answers became classes (Assess) and lists by verdict (Lane review), and the
// bounds moved from what zod refuses to what code clips and counts. The provider must still be told
// every bound in words, and each new list must be a plain list of integers inside a small object,
// never a tuple, in both wire forms.
test("the class and verdict-list shapes are lists of integers in small objects, and every cap is still stated to the model", () => {
  const [assess, review] = specs.map(([, spec]) => spec);
  const node = (schema: Record<string, unknown>, ...path: Array<string>) =>
    path.reduce<Record<string, unknown>>((at, key) => {
      const next =
        key === "[]"
          ? at["items"]
          : (at["properties"] as Record<string, unknown>)[key];
      if (isObject(next) && Array.isArray(next["anyOf"]))
        return (next["anyOf"] as Array<Record<string, unknown>>).find(
          (branch) => branch["type"] !== "null",
        )!;
      return next as Record<string, unknown>;
    }, schema);
  for (const form of [toolForm(assess!), finalForm(assess!)]) {
    const classes = node(form, "classes");
    expect(classes["type"]).toBe("array");
    expect(classes["description"]).toBe("at most 40 items");
    for (const key of ["S", "F", "R"]) {
      const list = node(form, "classes", "[]", key);
      expect(list["type"]).toBe("array");
      expect(node(form, "classes", "[]", key, "[]")["type"]).toBe("integer");
    }
    // Round 2h: the smaller caps and bounds, each stated to the model in both forms.
    expect(node(form, "classes", "[]", "F")["description"]).toBe(
      "at most 4 items",
    );
    expect(node(form, "classes", "[]", "R")["description"]).toBe(
      "at most 4 items",
    );
    expect(node(form, "factors")["description"]).toBe("at most 4 items");
    expect(node(form, "requirements")["description"]).toBe("at most 4 items");
    expect(node(form, "impact")["description"]).toBe("at most 40 items");
    expect(node(form, "factors", "[]", "t")["description"]).toBe(
      "at most 80 characters",
    );
    for (const table of ["factors", "requirements", "impact"])
      expect(node(form, table, "[]", "cites")["description"]).toBe(
        "at most 2 items",
      );
    expect(node(form, "requirements", "[]", "t")["description"]).toBe(
      "at most 90 characters",
    );
    expect(node(form, "classes", "[]", "person", "why")["description"]).toBe(
      "at most 60 characters",
    );
    expect(node(form, "classes", "[]", "gaps", "[]", "t")["description"]).toBe(
      "at most 60 characters",
    );
    // Round 2h: an impact entry is only for existing behaviour that changes.
    expect(node(form, "impact", "[]", "effect")["enum"]).toEqual([
      "narrowed",
      "disabled",
      "changed",
    ]);
    expect(node(form, "requirements", "[]", "proof")["description"]).toBe(
      "at most 8 items",
    );
    expect(node(form, "requirements", "[]", "untested")["description"]).toBe(
      "at most 80 characters",
    );
    // The model's factor kinds leave out what only code writes; size stays, as a reason only.
    expect(node(form, "factors", "[]", "f")["enum"]).toContain("size");
    for (const only of ["declared-kind", "removal"])
      expect(node(form, "factors", "[]", "f")["enum"]).not.toContain(only);
    expect(node(form, "impact", "[]", "effect")["enum"]).not.toContain(
      "removed",
    );
    // An empty text is accepted and handled by code, an impact entry's included.
    expect(node(form, "impact", "[]", "t")["description"]).toBe(
      "at most 90 characters",
    );
  }
  for (const form of [toolForm(review!), finalForm(review!)]) {
    const sections = node(form, "sections");
    expect(sections["type"]).toBe("object");
    expect(Object.keys(sections["properties"] as object).sort()).toEqual([
      "a",
      "r",
      "u",
    ]);
    for (const v of ["a", "r", "u"])
      expect(node(form, "sections", v, "[]")["type"]).toBe("integer");
    expect(node(form, "files", "[]", "checked")["description"]).toBe(
      "at most 80 characters",
    );
    expect(node(form, "comments", "[]", "t")["description"]).toBe(
      "at most 400 characters",
    );
  }
});
