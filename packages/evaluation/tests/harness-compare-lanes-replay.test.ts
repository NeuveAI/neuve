// Why (10.124–10.128): the replay key is the lanes climb's second answer key. A reader that judged
// an unlabelled or disputed line, pooled two eras, measured held-out cases unasked, or mapped a class
// to the wrong lane would quietly move every replay measure; and evidence that slipped past the
// schema would be judged on keys the measure never wrote. A revert marks every line of a change, so
// recall that counted it, or counted lines alone, would let a few reverted cases carry the figure.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  assertNotOwnerRepository,
  checkReplayRanges,
  readAfterMerge,
  readEvidence,
  REPLAY_LANES,
  replayKey,
  replayMeasures,
  type ReplayCall,
} from "../src/harness-compare/full-test/lanes-replay.ts";
import { describeReplay } from "../src/harness-compare/full-test/lanes.ts";
import type { ReplayLineEvidence } from "../src/harness-compare/full-test/replay-evidence.ts";

const evidence = (
  range: string,
  overrides: Partial<ReplayLineEvidence> = {},
): ReplayLineEvidence => ({
  version: 2,
  caseId: `github:example/repo:${range}`,
  source: "t3code",
  era: "2026",
  split: "pilot",
  family: range,
  control: null,
  range,
  runId: "01RUN",
  labelling: { passes: 2, rule: "majority", kappa: 0.8 },
  lines: {},
  disputed: 0,
  ...overrides,
});

const call = (
  unit: string,
  range: string,
  harness: ReplayCall["harness"],
  lines: Array<string>,
): ReplayCall => ({ unit, title: `title ${unit}`, range, harness, lines });

test("each class means its decided lane (10.128), and only labelled lines enter the key", () => {
  expect(REPLAY_LANES).toEqual({
    "needs-person": "human-required",
    discussed: "human-suggested",
    "agent-catchable": "agentic",
    mechanical: "static-automation",
  });
  const key = replayKey([
    evidence("aaaaaaaa..bbbbbbbb", {
      lines: {
        "a.ts:new:1": {
          class: "needs-person",
          strength: "strong",
          concerns: ["c1"],
        },
        "a.ts:new:2": { class: "mechanical", strength: "weak", concerns: [] },
      },
      disputed: 3,
    }),
  ]);
  expect(key).toEqual({
    "aaaaaaaa..bbbbbbbb|a.ts:new:1": "human-required",
    "aaaaaaaa..bbbbbbbb|a.ts:new:2": "static-automation",
  });
});

test("the measures judge only labelled lines the runs own, per era and split, never pooled", () => {
  const range = "aaaaaaaa..bbbbbbbb";
  const old = "cccccccc..dddddddd";
  const held = "eeeeeeee..ffffffff";
  const cases = [
    evidence(range, {
      lines: {
        "a.ts:new:1": {
          class: "needs-person",
          strength: "strong",
          concerns: ["c1"],
        },
        "a.ts:new:2": {
          class: "needs-person",
          strength: "weak",
          concerns: ["c2"],
        },
        "a.ts:new:3": {
          class: "agent-catchable",
          strength: "weak",
          concerns: [],
        },
        "a.ts:new:4": { class: "mechanical", strength: "weak", concerns: [] },
        // Labelled, but no unit of the run owns it: never judged.
        "a.ts:new:9": {
          class: "needs-person",
          strength: "strong",
          concerns: ["c9"],
        },
      },
      disputed: 2,
    }),
    evidence(old, {
      era: "pre-2022",
      control: "quiet",
      lines: {
        "b.ts:new:1": { class: "discussed", strength: "weak", concerns: [] },
      },
    }),
    evidence(held, {
      split: "held-out",
      lines: {
        "c.ts:new:1": {
          class: "needs-person",
          strength: "strong",
          concerns: [],
        },
      },
    }),
  ];
  const calls = [
    // One needs-person line kept with a person, one placed lower beside an unlabelled line.
    call("u1", range, "human-required", ["a.ts:new:1"]),
    call("u2", range, "agentic", ["a.ts:new:2", "a.ts:new:3", "a.ts:new:5"]),
    call("u3", range, "human-required", ["a.ts:new:4"]),
    call("v1", old, "human-required", ["b.ts:new:1", "b.ts:new:2"]),
    call("w1", held, "agentic", ["c.ts:new:1"]),
  ];
  const byEra = replayMeasures(calls, cases);
  // Eras and splits stay apart, and held-out is left out unless asked for.
  expect(Object.keys(byEra).sort()).toEqual(["2026", "pre-2022"]);
  expect(Object.keys(byEra["2026"]!)).toEqual(["pilot"]);
  const pilot = byEra["2026"]!["pilot"]!;
  expect(pilot.escalationRecall).toMatchObject({
    needsPerson: 2,
    required: 0.5,
    suggestedOrHigher: 0.5,
    lower: [
      {
        unit: "u2",
        title: "title u2",
        harness: "agentic",
        lines: 1,
        concerns: ["c2"],
      },
    ],
  });
  // Of the agent-catchable and mechanical lines, the mechanical one sits in human-required.
  expect(pilot.overEscalation).toMatchObject({ lines: 2, required: 0.5 });
  expect(pilot.lineAgreement).toMatchObject({
    judged: 4,
    agree: 2,
    share: 0.5,
  });
  expect(pilot.lineAgreement.byClass["needs-person"]).toEqual({
    judged: 2,
    agree: 1,
    share: 0.5,
  });
  // A unit takes its most demanding class: u2 holds a needs-person line, so it should be human-required.
  expect(pilot.unitAgreement?.items).toBe(3);
  expect(pilot.unitAgreement?.agreement).toBeCloseTo(1 / 3, 5);
  expect(pilot.coverage).toEqual({
    judged: 4,
    owned: 5,
    disputed: 2,
    unassessedUnits: 0,
    unassessedNeedsPerson: 0,
  });
  const quiet = byEra["pre-2022"]!["pilot"]!;
  expect(quiet.quietControls).toEqual({ units: 1, lines: 1 });
  expect(quiet.lineAgreement).toMatchObject({ judged: 1, agree: 0 });
  // Held-out only when asked.
  expect(
    Object.keys(
      replayMeasures(calls, cases, { heldOut: true })["2026"]!,
    ).sort(),
  ).toEqual(["held-out", "pilot"]);
});

test("evidence files are checked against the schema, hashed, and never name a case twice", () => {
  const dir = mkdtempSync(join(tmpdir(), "lanes-replay-"));
  try {
    const good = join(dir, "good.json");
    writeFileSync(good, JSON.stringify([evidence("aaaaaaaa..bbbbbbbb")]));
    const read = readEvidence([good]);
    expect(read.evidence).toHaveLength(1);
    expect(read.files[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify(evidence("aaaa..bbbb")));
    expect(() => readEvidence([bad])).toThrow();
    const twice = join(dir, "twice.json");
    writeFileSync(twice, JSON.stringify(evidence("aaaaaaaa..bbbbbbbb")));
    expect(() => readEvidence([good, twice])).toThrow("more than once");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one run per case: a second run of a case goes to the floor, which covers the same cases once each", () => {
  expect(() => checkReplayRanges(["a..b", "c..d"], [])).not.toThrow();
  expect(() => checkReplayRanges(["a..b", "a..b"], [])).toThrow(
    "two replay runs of a..b",
  );
  expect(() =>
    checkReplayRanges(["a..b", "c..d"], ["c..d", "a..b"]),
  ).not.toThrow();
  expect(() => checkReplayRanges(["a..b", "c..d"], ["a..b"])).toThrow(
    "not one each",
  );
  expect(() => checkReplayRanges(["a..b"], ["a..b", "a..b"])).toThrow(
    "not one each",
  );
});

test("a unit the harness never assessed is counted apart, never as a line placed lower", () => {
  const range = "aaaaaaaa..bbbbbbbb";
  const byEra = replayMeasures(
    [call("u1", range, null, ["a.ts:new:1"])],
    [
      evidence(range, {
        lines: {
          "a.ts:new:1": {
            class: "needs-person",
            strength: "strong",
            concerns: [],
          },
        },
      }),
    ],
  );
  const pilot = byEra["2026"]!["pilot"]!;
  expect(pilot.escalationRecall.needsPerson).toBe(0);
  expect(pilot.coverage).toMatchObject({
    judged: 0,
    unassessedUnits: 1,
    unassessedNeedsPerson: 1,
  });
});

test("a replay run is never read from the owner's repository, its main checkout or any worktree of it", () => {
  const dir = mkdtempSync(join(tmpdir(), "lanes-owner-repo-"));
  const git = (cwd: string, ...args: Array<string>) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  try {
    const owner = join(dir, "owner");
    execFileSync("git", ["init", "-q", owner]);
    git(
      owner,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "one",
    );
    const worktree = join(dir, "owner-worktree");
    git(owner, "worktree", "add", "-q", "--detach", worktree);
    const clone = join(dir, "case-clone");
    execFileSync("git", ["clone", "-q", "--no-hardlinks", owner, clone]);
    expect(() => assertNotOwnerRepository(owner, owner)).toThrow(
      "shares the owner's repository",
    );
    expect(() => assertNotOwnerRepository(worktree, owner)).toThrow(
      "shares the owner's repository",
    );
    expect(() => assertNotOwnerRepository(owner, worktree)).toThrow(
      "shares the owner's repository",
    );
    expect(() => assertNotOwnerRepository(clone, owner)).not.toThrow();
    expect(() => assertNotOwnerRepository("", owner)).toThrow(
      "names no case clone",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recall's headline leaves reverts out and reads per unit and per case; each origin is reported apart", () => {
  const range = "aaaaaaaa..bbbbbbbb";
  const other = "cccccccc..dddddddd";
  const quiet = "eeeeeeee..ffffffff";
  const np = (concerns: Array<string>) => ({
    class: "needs-person" as const,
    strength: "strong" as const,
    concerns,
  });
  const cases = [
    evidence(range, {
      lines: {
        "a.ts:new:1": np(["thread-1"]),
        "a.ts:new:2": np(["after-merge:F"]),
        "a.ts:new:3": np(["after-merge:X"]),
        "a.ts:new:4": np(["after-merge:V"]),
        "a.ts:new:5": np(["after-merge:V"]),
        "a.ts:new:6": np(["after-merge:V"]),
        // A thread wins over what happened after merge.
        "a.ts:new:7": np(["after-merge:V", "thread-2"]),
        "b.ts:new:1": {
          class: "agent-catchable",
          strength: "weak",
          concerns: [],
        },
      },
    }),
    evidence(other, { lines: { "c.ts:new:1": np(["thread-3"]) } }),
    evidence(quiet, { control: "quiet" }),
  ];
  const calls = [
    call("u1", range, "agentic", ["a.ts:new:1", "a.ts:new:7"]),
    call("u2", range, "human-required", ["a.ts:new:2", "a.ts:new:3"]),
    call("u3", range, "agentic", ["a.ts:new:4", "a.ts:new:5", "a.ts:new:6"]),
    // Only an agent-catchable line is labelled: the unit is over-escalated on a quarter of it.
    call("u4", range, "human-required", [
      "b.ts:new:1",
      "b.ts:new:2",
      "b.ts:new:3",
      "b.ts:new:4",
    ]),
    call("v1", other, "human-required", ["c.ts:new:1"]),
    call("q1", quiet, "human-suggested", ["q.ts:new:1"]),
    call("q2", quiet, "agentic", ["q.ts:new:2"]),
  ];
  const { kinds } = (() => {
    const dir = mkdtempSync(join(tmpdir(), "lanes-aftermerge-"));
    try {
      const file = join(dir, "aftermerge.json");
      writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          caseId: `github:example/repo:${range}`,
          commits: [
            { commit: "F", subject: "Fix", a: "fix", b: "fix", kind: "fix" },
            {
              commit: "V",
              subject: "Revert",
              a: "revert",
              b: "revert",
              kind: "revert",
            },
          ],
          failures: [],
        }),
      );
      return readAfterMerge([file]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  })();
  const pilot = replayMeasures(calls, cases, { afterMerge: kinds })["2026"]![
    "pilot"
  ]!;
  // Headline: the thread lines (1, 7 and c.ts:1), the fix (2) and the unknown kind (3).
  expect(pilot.escalationRecall).toMatchObject({
    needsPerson: 5,
    required: 0.6,
    units: { units: 3, required: 0.667, suggestedOrHigher: 0.667 },
    // a..b keeps 2 of its 4 headline lines, c..d its 1 of 1.
    cases: { cases: 2, required: 0.75 },
  });
  expect(
    Object.fromEntries(
      Object.entries(pilot.escalationRecall.byOrigin).map(([origin, r]) => [
        origin,
        [r.lines, r.required, r.units.units, r.cases.cases],
      ]),
    ),
  ).toEqual({
    thread: [3, 0.333, 2, 2],
    fix: [1, 1, 1, 1],
    revert: [3, 0, 1, 1],
    "after-merge": [1, 1, 1, 1],
  });
  expect(pilot.overEscalation.units).toEqual({
    units: 1,
    withReverts: 0,
    of: 3,
    share: 0.333,
    labelledShare: 0.25,
  });
  expect(pilot.controls).toEqual({
    quiet: { cases: 1, units: 2, required: 0, suggestedOrHigher: 0.5 },
  });
  // Without the after-merge records a revert cannot be told apart, and the headline keeps it.
  const unread = replayMeasures(calls, cases)["2026"]!["pilot"]!;
  expect(unread.escalationRecall.needsPerson).toBe(8);
  expect(Object.keys(unread.escalationRecall.byOrigin).sort()).toEqual([
    "after-merge",
    "thread",
  ]);
});

test("after-merge records are checked against their schema and never name a case twice", () => {
  const dir = mkdtempSync(join(tmpdir(), "lanes-aftermerge-"));
  try {
    const record = {
      version: 1,
      caseId: "github:example/repo:1",
      commits: [],
      failures: [],
    };
    const good = join(dir, "good.json");
    writeFileSync(good, JSON.stringify(record));
    expect(readAfterMerge([good]).files[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ ...record, version: 2 }));
    expect(() => readAfterMerge([bad])).toThrow("not an after-merge record");
    expect(() => readAfterMerge([good, good])).toThrow("more than once");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the report says reverts are apart only when every after-merge line's kind is known", () => {
  const range = "aaaaaaaa..bbbbbbbb";
  const cases = [
    evidence(range, {
      lines: {
        "a.ts:new:1": {
          class: "needs-person",
          strength: "strong",
          concerns: ["after-merge:V"],
        },
      },
    }),
  ];
  const calls = [call("u1", range, "agentic", ["a.ts:new:1"])];
  const kinds = new Map([
    [`github:example/repo:${range}`, new Map([["V", "revert" as const]])],
  ]);
  const text = (afterMerge?: typeof kinds) =>
    describeReplay(
      {
        files: [],
        afterMergeFiles: afterMerge === undefined ? null : [],
        runs: [{ runId: "r", range }],
        byEra: replayMeasures(calls, cases, { afterMerge }),
        floor: null,
      } as unknown as Parameters<typeof describeReplay>[0],
      (value) => (value === null ? "n/a" : `${Math.round(value * 100)}%`),
    ).join("\n");
  expect(text(kinds)).toContain("reverts reported apart, not counted here");
  expect(text(kinds)).toContain("revert 0% of 1 lines");
  expect(text(kinds)).toContain("in human-required n/a of 0");
  expect(text(kinds)).toContain("(revert lines apart: 0% of 1 in their lane)");
  // Without records the revert line is of unknown kind, in the headline, and the report says so.
  expect(text()).not.toContain("reverts reported apart");
  expect(text()).toContain(
    "1 after-merge line(s) of unknown kind are counted here and may include reverts",
  );
});

test("agreement leaves revert lines out, with their own row, and no unit takes its class from them", () => {
  const range = "aaaaaaaa..bbbbbbbb";
  const revert = {
    class: "needs-person" as const,
    strength: "strong" as const,
    concerns: ["after-merge:V"],
  };
  const cases = [
    evidence(range, {
      lines: {
        "a.ts:new:1": revert,
        "a.ts:new:2": revert,
        "b.ts:new:1": revert,
        "b.ts:new:2": {
          class: "agent-catchable",
          strength: "weak",
          concerns: [],
        },
        "c.ts:new:1": {
          class: "needs-person",
          strength: "strong",
          concerns: ["thread-1"],
        },
      },
    }),
  ];
  const calls = [
    // Revert lines only: the unit has no class to be judged by.
    call("u1", range, "agentic", ["a.ts:new:1", "a.ts:new:2"]),
    // A revert line beside an agent-catchable one: judged by the latter, so over-escalated.
    call("u2", range, "human-required", ["b.ts:new:1", "b.ts:new:2"]),
    call("u3", range, "human-required", ["c.ts:new:1"]),
  ];
  const afterMerge = new Map([
    [`github:example/repo:${range}`, new Map([["V", "revert" as const]])],
  ]);
  const pilot = replayMeasures(calls, cases, { afterMerge })["2026"]!["pilot"]!;
  // Judged: b.ts:2 (agentic expected, in human-required) and c.ts:1 (in its lane).
  expect(pilot.lineAgreement).toMatchObject({
    judged: 2,
    agree: 1,
    share: 0.5,
    reverts: { judged: 3, agree: 1, share: 0.333 },
  });
  expect(pilot.lineAgreement.byClass["needs-person"]).toEqual({
    judged: 1,
    agree: 1,
    share: 1,
  });
  // u1 has no class; u2 is judged agentic against human-required, u3 agrees.
  expect(pilot.unitAgreement?.items).toBe(2);
  expect(pilot.unitAgreement?.agreement).toBe(0.5);
  expect(pilot.overEscalation.units).toMatchObject({
    units: 1,
    withReverts: 1,
    of: 2,
  });
  // Labelling coverage still counts every labelled line the run owns.
  expect(pilot.coverage.judged).toBe(5);
});
