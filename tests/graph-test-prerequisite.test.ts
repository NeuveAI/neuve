// Why: a check that runs without the Graph engine must fail, so `bun run check` can't pass by
// skipping Graph's cases, including when an obsolete no-Graph declaration is set.
import { afterEach, expect, test } from "bun:test";
import { graphTestPrerequisite } from "../scripts/graph-test-prerequisite.ts";

const saved = {
  mode: process.env.NEUVE_MODE,
  withoutGraph: process.env.NEUVE_CHECK_WITHOUT_GRAPH,
};
const restore = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};
afterEach(() => {
  restore("NEUVE_MODE", saved.mode);
  restore("NEUVE_CHECK_WITHOUT_GRAPH", saved.withoutGraph);
});

const missing = (
  mode: string | undefined,
  withoutGraph: string | undefined,
) => {
  restore("NEUVE_MODE", mode);
  restore("NEUVE_CHECK_WITHOUT_GRAPH", withoutGraph);
  return graphTestPrerequisite({ available: false, message: "no engine" });
};

test.each([
  ["a package test run", undefined, undefined, true],
  ["a check", "check", undefined, false],
  ["a check with another value of the declaration", "check", "true", false],
  ["a check with the obsolete no-Graph declaration", "check", "1", false],
] as const)(
  "a missing engine in %s skips: %p",
  (_run, mode, withoutGraph, skip) => {
    const prerequisite = missing(mode, withoutGraph);
    expect(prerequisite.skip).toBe(skip);
    expect(() => prerequisite.require()).toThrow("no engine");
  },
);

test("a built engine never skips, whatever the run declares", () => {
  restore("NEUVE_MODE", "check");
  restore("NEUVE_CHECK_WITHOUT_GRAPH", "1");
  const prerequisite = graphTestPrerequisite({
    available: true,
    message: "unused",
  });
  expect(prerequisite.skip).toBe(false);
  expect(() => prerequisite.require()).not.toThrow();
});
