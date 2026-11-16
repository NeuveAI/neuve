// Why: the lanes measure reads the replay's line evidence as a second answer key, joined on its
// own line keys. A key format that drifts from `ownedLineKeys` or `rangeIdentity` would match no
// line and judge nothing, silently, and a record of another version must not be read as v2: v1's
// lines came from two passes' agreement, v2's from a majority (10.135). So the schema accepts exactly
// the keys the measure writes, refuses the rest, and only version 2 with its majority rule.
import { expect, test } from "bun:test";
import { rangeIdentity } from "../src/harness-compare/full-test/lanes.ts";
import { ownedLineKeys } from "../src/harness-compare/full-test/packets.ts";
import {
  REPLAY_EVIDENCE_VERSION,
  ReplayLineEvidence,
} from "../src/harness-compare/full-test/replay-evidence.ts";

const evidence = (
  lines: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) => ({
  version: 2,
  caseId: "github:pingdotgg/t3code:8830",
  source: "t3code",
  era: "2026",
  split: "pilot",
  family: "github:pingdotgg/t3code:8830",
  control: null,
  range: "aaaaaaaa..bbbbbbbb",
  runId: "01M5R6M78BP7E31R4MQVP10MCS",
  labelling: { passes: 3, rule: "majority", kappa: 0.61 },
  lines,
  disputed: 0,
  ...overrides,
});

const line = { class: "needs-person", strength: "strong", concerns: ["c1"] };

test("the measure's own line and range keys are accepted", () => {
  const keys = ownedLineKeys({
    recorded: {
      payload: {
        ownedRanges: [
          {
            kind: "lines",
            path: "src/a b/c.ts",
            side: "new",
            startLine: 9,
            endLine: 10,
          },
          {
            kind: "lines",
            path: "src/d.ts",
            side: "old",
            startLine: 3,
            endLine: 3,
          },
          { kind: "whole-nontext", path: "img/e.png", side: "new" },
        ],
      },
    },
  } as never);
  expect([...keys]).toEqual([
    "src/a b/c.ts:new:9",
    "src/a b/c.ts:new:10",
    "src/d.ts:old:3",
    "img/e.png:new:whole",
  ]);
  const range = rangeIdentity(
    `${"0123456789".repeat(4)}..${"abcdef0123".repeat(4)}`,
  );
  const parsed = ReplayLineEvidence.safeParse(
    evidence(Object.fromEntries([...keys].map((key) => [key, line])), {
      range,
    }),
  );
  expect(parsed.success).toBe(true);
});

test("keys, classes and versions outside v2 are refused", () => {
  for (const key of ["src/a.ts:9", "src/a.ts:both:9", "src/a.ts:new:"])
    expect(
      ReplayLineEvidence.safeParse(evidence({ [key]: line })).success,
    ).toBe(false);
  expect(
    ReplayLineEvidence.safeParse(
      evidence({ "a.ts:new:1": line }, { range: "0123456789..abcdef" }),
    ).success,
  ).toBe(false);
  // "No evidence" is an absent line, never a class.
  expect(
    ReplayLineEvidence.safeParse(
      evidence({ "a.ts:new:1": { ...line, class: "no-evidence" } }),
    ).success,
  ).toBe(false);
  expect(REPLAY_EVIDENCE_VERSION).toBe(2);
  expect(
    ReplayLineEvidence.safeParse(
      evidence({ "a.ts:new:1": line }, { version: 1 }),
    ).success,
  ).toBe(false);
  // A v1 record's labelling (two passes agreeing) is refused too, and so is any pass count but 2 or 3.
  for (const labelling of [
    { passes: 2, kappa: 0.61 },
    { passes: 4, rule: "majority", kappa: 0.61 },
  ])
    expect(
      ReplayLineEvidence.safeParse(
        evidence({ "a.ts:new:1": line }, { labelling }),
      ).success,
    ).toBe(false);
});
