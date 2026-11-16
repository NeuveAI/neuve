import { expect, test } from "bun:test";
import { GREP_DEADLINE, warningOutcome } from "../src/retrieval-bench/graph.ts";

// Why this test exists: Neuve Graph 65f609a answers a stopped tree grep with ordinary-looking results
// plus a W_GIT_GREP_DEADLINE warning. If that answer passed as clean it would be stored and fused as
// Graph's complete answer, and nothing downstream would notice. The deadline must become an error.

const provider = (code: string) =>
  ({
    kind: "provider",
    code,
    severity: "warning",
    effectOnCompleteness: "",
  }) as const;

test("a grep deadline makes the answer an error", () => {
  const outcome = warningOutcome([
    provider("W_REPO_IGNORED_SOURCE"),
    provider(GREP_DEADLINE),
  ]);
  expect(outcome.codes).toEqual(["W_REPO_IGNORED_SOURCE", GREP_DEADLINE]);
  expect(outcome.error).toStartWith(`${GREP_DEADLINE}:`);
});

test("other warnings are recorded without failing the answer", () => {
  expect(warningOutcome([provider("W_REPO_IGNORED_SOURCE")])).toEqual({
    codes: ["W_REPO_IGNORED_SOURCE"],
    error: null,
  });
  expect(warningOutcome([])).toEqual({ codes: [], error: null });
});
