// Why: a check that runs without the Graph engine must fail, so `bun run check` can't pass by
// skipping Graph's cases; only a run that declares it has no Graph (the portable CI job) skips them.
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
  ["a check that declares it runs without Graph", "check", "1", true],
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
