// Why: proof state is set by code alone, in the order the shared rule gives (Missing, Out of date,
// Conflicting, Proven, Thin), and static automation rests on it: only a Proven requirement is solid
// coverage, which is what lets a low, easy section close on its checks.
import { expect, test } from "bun:test";
import { coverageOf, type NamedProof } from "../src/proof-state.ts";

const records: ReadonlyMap<string, NamedProof> = new Map([
  ["run", { kind: "test-run", currency: "current" }],
  ["lint", { kind: "static-analysis", currency: "current" }],
  [
    "old-run",
    {
      kind: "test-run",
      currency: "stale: its commit is not in the head's history",
    },
  ],
]);

const requirement = (
  proof: ReadonlyArray<string>,
  rest: Partial<{ agree: boolean; testable: boolean; untested: string }> = {},
) => ({
  kinds: ["test-run", "static-analysis"] as const,
  proof,
  agree: rest.agree ?? true,
  testable: rest.testable ?? true,
  untested: rest.untested ?? "",
});

test("proof state follows the shared rule's order, and only Proven is solid", () => {
  const missing = coverageOf(requirement([]), records);
  expect([missing.proofState, missing.coverage]).toEqual([
    "missing",
    "missing",
  ]);
  // A record the reading named that Records does not hold is still Missing.
  expect(coverageOf(requirement(["nowhere"]), records).proofState).toBe(
    "missing",
  );
  const proven = coverageOf(requirement(["run", "lint"]), records);
  expect([proven.proofState, proven.coverage]).toEqual(["proven", "solid"]);
  const stale = coverageOf(requirement(["old-run", "lint"]), records);
  expect([stale.proofState, stale.coverage]).toEqual([
    "out-of-date",
    "shallow",
  ]);
  // A changed pinned source leaves it out of date too.
  expect(
    coverageOf(requirement(["run", "lint"]), records, ["changed"]).proofState,
  ).toBe("out-of-date");
  const conflicting = coverageOf(
    requirement(["run", "lint"], { agree: false }),
    records,
  );
  expect([conflicting.proofState, conflicting.coverage]).toEqual([
    "conflicting",
    "shallow",
  ]);
  const thin = coverageOf(requirement(["run"]), records);
  expect([thin.proofState, thin.coverage]).toEqual(["thin", "shallow"]);
  // Excused from a test run only by an explicit "not testable" with a reason.
  expect(
    coverageOf(
      {
        kinds: ["static-analysis"],
        proof: ["lint", "run"],
        agree: true,
        testable: false,
        untested: "",
      },
      new Map([
        ["lint", { kind: "static-analysis", currency: "current" }],
        ["run", { kind: "screenshot", currency: "current" }],
      ]),
    ).proofState,
  ).toBe("thin");
  expect(
    coverageOf(
      {
        kinds: ["static-analysis"],
        proof: ["lint", "run"],
        agree: true,
        testable: false,
        untested: "It draws on a canvas no test can read.",
      },
      new Map([
        ["lint", { kind: "static-analysis", currency: "current" }],
        ["run", { kind: "screenshot", currency: "current" }],
      ]),
    ).proofState,
  ).toBe("proven");
});
