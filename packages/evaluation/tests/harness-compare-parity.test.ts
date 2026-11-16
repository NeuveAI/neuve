// Why (10.141): a parity change is kept only when it raises more of the reviewers' real concerns
// beyond the noise of two runs, while what Neuve raises stays relevant. A reader that credited a
// concern Neuve only touched with a checkpoint, or let a candidate raise noise on clean changes, or
// drew held-out or unrunnable cases into the sample, would keep the wrong change.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlindPass } from "../src/pr-replay/matching.ts";
import { relabelState } from "../src/pr-replay/recategorize.ts";
import {
  Confirmation,
  labellingDigest,
  matchingDigest,
} from "../src/pr-replay/parity.ts";
import {
  armRecompose,
  barFor,
  concernLabels,
  concernsCaught,
  drawParitySample,
  missingRunFailure,
  mixConcerns,
  parityComparison,
  parityFloor,
  readRun,
  refuseUnconfirmed,
  runRecompose,
  runState,
  type ParityCase,
  type ParityRun,
} from "../src/harness-compare/full-test/parity.ts";

test("a concern is caught only by a Neuve comment paired with it; any item counts toward the upper bound", () => {
  const key = {
    items: [
      { id: "r1", source: "reviewer" as const, group: "reviewer", ref: "c1" },
      { id: "r2", source: "reviewer" as const, group: "reviewer", ref: "c2" },
      { id: "r3", source: "reviewer" as const, group: "reviewer", ref: "c3" },
      { id: "n1", source: "neuve" as const, group: "comment", ref: "u1" },
      { id: "n2", source: "neuve" as const, group: "checkpoint", ref: "u1" },
    ],
  };
  const labels = new Map([
    ["c1", { substantive: true, kind: "correctness" }],
    ["c2", { substantive: true, kind: "design" }],
    ["c3", { substantive: false, kind: "style" }],
  ]);
  // A pair of two reviewers' comments raises no concern for Neuve; c3 is not substantive.
  const caught = concernsCaught(
    key,
    ["r1|n1", "n2|r2", "r1|r2", "r3|n1"],
    labels,
  );
  expect(caught).toEqual([
    { ref: "c1", kind: "correctness", caught: true, caughtByAny: true },
    { ref: "c2", kind: "design", caught: false, caughtByAny: true },
  ]);
});

const run = (
  caught: ReadonlyArray<boolean>,
  items = 20,
  noise = 2,
): ParityRun => ({
  concerns: caught.map((value, index) => ({
    ref: `c${index}`,
    kind: index % 2 === 0 ? "correctness" : "design",
    caught: value,
    caughtByAny: value,
    matcherOnly: { caught: value, caughtByAny: value },
  })),
  unconfirmed: null,
  items,
  merit: { revision: 4, judged: 18, noise, nitPick: 3 },
});
const pair = (
  id: string,
  base: ParityRun,
  next: ParityRun,
  control = false,
  source = "go",
): ParityCase => ({ caseId: id, source, control, base, next });

test("the floor is the share of concerns that flip between two runs, and the bar scales with n", () => {
  const floor = parityFloor([
    pair(
      "a",
      run([true, false, false, false]),
      run([false, false, false, false]),
    ),
    pair("b", run([true, true, false, false]), run([true, true, false, false])),
  ]);
  expect(floor).toMatchObject({ cases: 2, concerns: 8, flipped: 1, f: 0.125 });
  expect(barFor(0.125, 50)).toBe(
    Math.round(1.96 * Math.sqrt(0.125 / 50) * 1_000) / 1_000,
  );
  expect(barFor(null, 50)).toBeNull();
});

test("a candidate is kept on a clear gain in concerns caught, never when a guard clearly rises", () => {
  const floor = { cases: 20, concerns: 40, flipped: 2, f: 0.05 };
  // Thirty cases: each gains one caught concern of four.
  const gaining = Array.from({ length: 30 }, (_, index) =>
    pair(
      `c${index}`,
      run([true, false, false, false]),
      run([true, true, false, false]),
    ),
  );
  expect(parityComparison(gaining, floor).verdict).toBe("keep");
  // The same gain while every clean control case leaves twice the items: items per concern rises.
  const louder = [
    ...gaining,
    ...Array.from({ length: 10 }, (_, index) =>
      pair(`q${index}`, run([], 10), run([], 60), true),
    ),
  ];
  const result = parityComparison(louder, floor);
  expect(result.controls).toBe(10);
  expect(result.guards.itemsPerConcern.rises).toBe(true);
  expect(result.verdict).toContain(
    "do not keep: items per reviewer concern rose",
  );
  // Controls never count toward caught.
  expect(result.caught.n).toBe(120);
  // Noise rising on every case blocks too.
  const noisier = gaining.map((entry) => ({
    ...entry,
    next: {
      ...entry.next,
      merit: { revision: 4, judged: 18, noise: 9, nitPick: 3 },
    },
  }));
  expect(parityComparison(noisier, floor).verdict).toContain(
    "noise share rose",
  );
  expect(parityComparison(gaining, null).verdict).toContain("no noise floor");
});

test("a guard also blocks when its rise passes the bar from two runs of one build, and says when that bar is pending", () => {
  const gaining = Array.from({ length: 30 }, (_, index) =>
    pair(
      `c${index}`,
      run([true, false, false, false]),
      run([true, true, false, false]),
    ),
  );
  // Without the repeats' guard noise, the bar is pending and only the interval test applies.
  const pending = parityComparison(gaining, {
    cases: 20,
    concerns: 40,
    flipped: 2,
    f: 0.05,
  });
  expect(pending.guards.noise).toMatchObject({
    bar: null,
    barPending: true,
    rises: false,
  });
  // Repeats whose noise share barely moves give a small bar; a modest rise on half the cases
  // passes it, though the bootstrap interval alone still reaches 0.
  const repeats = Array.from({ length: 20 }, (_, index) =>
    pair(
      `r${index}`,
      run([true, false], 20, 2),
      run([true, false], 20, index % 2 === 0 ? 2 : 3),
    ),
  );
  const floor = parityFloor(repeats);
  expect(floor.guards.noise?.cases).toBe(20);
  // Only the bar decides here: four cases' noise rises sharply and eight fall to none, so the
  // candidate's own interval reaches 0 while its delta passes the repeats' small bar.
  const modest = gaining.map((entry, index) =>
    index < 4
      ? {
          ...entry,
          next: {
            ...entry.next,
            merit: { revision: 4, judged: 18, noise: 14, nitPick: 3 },
          },
        }
      : index < 12
        ? {
            ...entry,
            next: {
              ...entry.next,
              merit: { revision: 4, judged: 18, noise: 0, nitPick: 3 },
            },
          }
        : entry,
  );
  const result = parityComparison(modest, floor);
  expect(result.guards.noise.bar).not.toBeNull();
  expect(result.guards.noise.interval![0]).toBeLessThanOrEqual(0);
  expect(result.guards.noise.delta!).toBeGreaterThan(result.guards.noise.bar!);
  expect(result.guards.noise.rises).toBe(true);
});

test("a gain with a source falling beyond its bar goes to the overseer, not kept", () => {
  const floor = { cases: 20, concerns: 40, flipped: 2, f: 0.05 };
  const cases = [
    ...Array.from({ length: 30 }, (_, index) =>
      pair(`g${index}`, run([false, false]), run([true, true]), false, "go"),
    ),
    ...Array.from({ length: 10 }, (_, index) =>
      pair(`t${index}`, run([true, true]), run([false, true]), false, "t3code"),
    ),
  ];
  const result = parityComparison(cases, floor);
  expect(result.bySource["t3code"]!.falls).toBe(true);
  expect(result.verdict).toBe("gain, for the overseer: falls in source t3code");
});

test("the sample draws development cases with a concern by source, and runnable development controls", () => {
  const cases = [
    ...Array.from({ length: 6 }, (_, index) => ({
      caseId: `go-${index}`,
      source: "go",
      split: "development",
      control: null,
      substantiveConcerns: 2,
      runnable: true,
    })),
    ...Array.from({ length: 2 }, (_, index) => ({
      caseId: `t3-${index}`,
      source: "t3code",
      split: "development",
      control: null,
      substantiveConcerns: 1,
      runnable: true,
    })),
    {
      caseId: "held",
      source: "go",
      split: "held-out",
      control: null,
      substantiveConcerns: 3,
      runnable: true,
    },
    {
      caseId: "none",
      source: "go",
      split: "development",
      control: null,
      substantiveConcerns: 0,
      runnable: true,
    },
    {
      caseId: "quiet",
      source: "go",
      split: "development",
      control: "quiet",
      substantiveConcerns: 0,
      runnable: true,
    },
    {
      caseId: "gone",
      source: "go",
      split: "development",
      control: "quiet",
      substantiveConcerns: 0,
      runnable: false,
    },
  ];
  const sample = drawParitySample(cases, 4, "seed");
  expect(sample.concerns).toHaveLength(4);
  expect(sample.concerns.filter((id) => id.startsWith("t3"))).toHaveLength(1);
  expect(sample.concerns).not.toContain("held");
  expect(sample.controls).toEqual(["quiet"]);
  expect(drawParitySample(cases, 4, "seed")).toEqual(sample);
});

test("merit shares count every judged verdict, and compare only runs judged under one revision", () => {
  const floor = { cases: 20, concerns: 40, flipped: 2, f: 0.05 };
  // Legitimate turned to nit-picks with the noise count flat: the noise share must not move.
  const shifted = Array.from({ length: 30 }, (_, index) =>
    pair(
      `s${index}`,
      {
        ...run([true, false]),
        merit: { revision: 4, judged: 14, noise: 2, nitPick: 2 },
      },
      {
        ...run([true, false]),
        merit: { revision: 4, judged: 14, noise: 2, nitPick: 8 },
      },
    ),
  );
  const result = parityComparison(shifted, floor);
  expect(result.guards.noise).toMatchObject({
    baseline: 0.143,
    candidate: 0.143,
    delta: 0,
  });
  expect(result.guards.nitPick.candidate).toBeLessThanOrEqual(1);
  // A case judged under two revisions leaves the merit guards.
  const mixed = shifted.map((entry) => ({
    ...entry,
    base: {
      ...entry.base,
      merit: { ...entry.base.merit!, revision: 2, nitPick: null },
    },
  }));
  expect(parityComparison(mixed, floor).guards.noise.cases).toBe(0);
});

test("the sample is refused while a runnable development case is unmatched, and draws exactly its size", () => {
  const entry = (caseId: string, source: string, concerns: number | null) => ({
    caseId,
    source,
    split: "development",
    control: null,
    substantiveConcerns: concerns,
    runnable: true,
  });
  expect(() =>
    drawParitySample([entry("a", "go", 2), entry("b", "go", null)], 1, "seed"),
  ).toThrow("not matched yet");
  const four = ["go", "t3code", "react-core", "devtools-frontend"].flatMap(
    (source) =>
      [0, 1, 2].map((index) => entry(`${source}-${index}`, source, 1)),
  );
  expect(drawParitySample(four, 6, "seed").concerns).toHaveLength(6);
});

test("a run that did not complete its review is a failed case, a missing one is told apart, and the verdict names failures", () => {
  const root = mkdtempSync(join(tmpdir(), "parity-packet-"));
  try {
    const write = (path: string, shown: unknown) => {
      mkdirSync(join(root, path), { recursive: true });
      writeFileSync(join(root, path, "show.json"), JSON.stringify(shown));
    };
    const batches = [{ batchId: "b1", units: [] }];
    write("run", { outcome: "completed", packet: { complete: true, batches } });
    // A timed-out run still holds batches, but its packet is partial.
    write("run/late", {
      outcome: "timed-out",
      packet: { complete: false, batches },
    });
    write("run/partial", { packet: { complete: false, batches } });
    write("run/empty", { outcome: "completed", packet: null });
    expect(runState(root, "first")).toEqual({ state: "completed" });
    expect(runState(root, "late")).toEqual({
      state: "failed",
      why: "the run timed-out",
    });
    expect(runState(root, "partial")).toMatchObject({ state: "failed" });
    expect(runState(root, "empty")).toMatchObject({ state: "failed" });
    expect(runState(root, "absent")).toEqual({ state: "missing" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const floor = { cases: 20, concerns: 40, flipped: 2, f: 0.05 };
  const gaining = Array.from({ length: 30 }, (_, index) =>
    pair(
      `c${index}`,
      run([true, false, false, false]),
      run([true, true, false, false]),
    ),
  );
  const result = parityComparison(gaining, floor, [
    {
      caseId: "b",
      source: "go",
      run: "fresh",
      why: "the run timed-out",
      concerns: 12,
    },
    // A failed control's concerns are left out, as a compared control's are.
    {
      caseId: "k",
      source: "go",
      run: "fresh",
      why: "the run timed-out",
      control: true,
      concerns: 3,
    },
    { caseId: "u", source: "rust", run: "fresh", why: "the run timed-out" },
  ]);
  expect(result.failed).toHaveLength(3);
  // Timeouts lean toward large changes: each source's failed share sits beside the verdict.
  // One failed case of 31, but 12 of the 132 concerns: its size shows in concerns, not only cases.
  expect(result.failedBySource["go"]).toEqual({
    failed: 2,
    cases: 32,
    share: 0.063,
    failedConcerns: 12,
    concerns: 132,
    concernShare: 0.091,
    unmatchedFailed: 0,
  });
  // An unmatched failed case is named, never counted as holding no concerns.
  expect(result.verdict).toBe(
    "keep; for the overseer: 3 failed case(s) left out of both arms (go 2 of 32 cases, 12 of 132 concerns, rust 1 of 1 cases, 0 of 0 concerns, 1 failed case(s) unmatched)",
  );
  expect(result.notes[0]).toContain("substantive concerns only");
});

test("a failed case's concerns are its mix's, not every substantive concern in its labels", () => {
  const root = mkdtempSync(join(tmpdir(), "parity-mix-"));
  try {
    const judged = (id: string) => ({
      id,
      isConcern: true,
      category: "correctness",
      substantive: true,
      response: "fixed",
      fixRevision: 2,
      validity: "valid",
      designDecision: false,
      rationale: "",
    });
    mkdirSync(join(root, "labels"), { recursive: true });
    // Three substantive threads; only t1 sits on a first-revision line, so only t1 is in the mix.
    writeFileSync(
      join(root, "labels", "concerns.jsonl"),
      ["t1", "t2", "t3"]
        .map((id) => JSON.stringify({ id, a: judged(id), b: judged(id) }))
        .join("\n") + "\n",
    );
    expect(
      [...concernLabels(root).values()].filter((label) => label.substantive),
    ).toHaveLength(3);
    expect(mixConcerns(root)).toBeNull();
    writeFileSync(
      join(root, "labels", "matching-key.json"),
      JSON.stringify({
        items: [
          { id: "r1", source: "reviewer", group: "concern", ref: "t1" },
          { id: "n1", source: "neuve", group: "comment", ref: "c1" },
        ],
      }),
    );
    writeFileSync(
      join(root, "labels", "matching.json"),
      JSON.stringify({
        pairs: [],
        summary: {
          substantiveConcerns: 1,
          caught: 0,
          caughtByAny: 0,
          neuve: { items: 1 },
        },
      }),
    );
    expect(mixConcerns(root)).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A case's substantive concerns on disk, each with its kind.
const writeConcerns = (
  root: string,
  concerns: ReadonlyArray<readonly [string, string]>,
) => {
  const judged = (id: string, category: string) => ({
    id,
    isConcern: true,
    category,
    substantive: true,
    response: "fixed",
    fixRevision: 2,
    validity: "valid",
    designDecision: false,
    rationale: "",
  });
  mkdirSync(join(root, "labels"), { recursive: true });
  writeFileSync(
    join(root, "labels", "concerns.jsonl"),
    concerns
      .map(([id, category]) =>
        JSON.stringify({
          id,
          a: judged(id, category),
          b: judged(id, category),
        }),
      )
      .join("\n") + "\n",
  );
};

// A run's matching on disk: its key, its settled pairs and the two passes that agreed on them, so
// the headline's standings (concernStandings) read the same pairs the matcher settled.
const writeMatching = (
  labels: string,
  items: ReadonlyArray<{
    id: string;
    source: "reviewer" | "neuve";
    group: string;
    ref: string;
  }>,
  pairs: ReadonlyArray<string>,
  neuveItems = items.filter((item) => item.source === "neuve").length,
) => {
  mkdirSync(labels, { recursive: true });
  writeFileSync(join(labels, "matching-key.json"), JSON.stringify({ items }));
  // The matching's own counts, as the matcher writes them: caught by a paired comment, or any item.
  const credit = concernsCaught(
    { items: [...items] },
    pairs,
    new Map(
      items
        .filter((item) => item.source === "reviewer")
        .map((item) => [item.ref, { substantive: true, kind: "correctness" }]),
    ),
  );
  const shareOf = (hits: number) =>
    credit.length === 0 ? null : hits / credit.length;
  writeFileSync(
    join(labels, "matching.json"),
    JSON.stringify({
      pairs,
      summary: {
        substantiveConcerns: credit.length,
        caught: shareOf(credit.filter((c) => c.caught).length),
        caughtByAny: shareOf(credit.filter((c) => c.caughtByAny).length),
        neuve: { items: neuveItems },
      },
    }),
  );
  const pass = BlindPass.parse({
    comments: pairs.map((pair) => {
      const [x, y] = pair.split("|");
      return { id: x, holds: "unsure", sameAs: [y], rationale: "" };
    }),
    verdicts: [],
  });
  for (const name of ["a", "b"]) {
    mkdirSync(join(labels, "matching", `pass-${name}`), { recursive: true });
    writeFileSync(
      join(labels, "matching", `pass-${name}`, "output.json"),
      JSON.stringify(pass),
    );
  }
};

// A current pair confirmation of the run's unmatched concerns, as settleConfirm writes one: each
// concern caught by a comment, by another item, or not (null).
const writeConfirmation = (
  labels: string,
  caseLabels: string,
  caught: Readonly<Record<string, "comment" | "item" | null>>,
  digests: { matching?: string; labelling?: string } = {},
) =>
  writeFileSync(
    join(labels, "confirmation.json"),
    JSON.stringify(
      Confirmation.parse({
        version: 1,
        promptDigest: "a".repeat(64),
        matching: digests.matching ?? matchingDigest(labels),
        labelling: digests.labelling ?? labellingDigest(caseLabels),
        run: null,
        concerns: Object.entries(caught).map(([ref, by]) => ({
          ref,
          standing: "missed",
          caught: by,
          agreed: by !== null,
          by:
            by === null
              ? null
              : {
                  group: by === "comment" ? "comment" : "checkpoint",
                  ref: "b1.u1#1",
                },
          votes: [],
        })),
      }),
    ),
  );

// A case on disk whose labels hold a correctness and a performance concern, the matching having
// counted both and paired a Neuve comment with the performance one; the confirmation found the
// correctness one unraised.
const writePerformanceCase = (root: string) => {
  writeConcerns(root, [
    ["t1", "correctness"],
    ["t2", "performance"],
  ]);
  writeMatching(
    join(root, "labels"),
    [
      { id: "r1", source: "reviewer", group: "concern", ref: "t1" },
      { id: "r2", source: "reviewer", group: "concern", ref: "t2" },
      { id: "n1", source: "neuve", group: "comment", ref: "c1" },
    ],
    ["r2|n1"],
  );
  writeConfirmation(join(root, "labels"), join(root, "labels"), { t1: null });
};

test("a run's matching checks count performance concerns, as the matching did", () => {
  // Why: the matching counted performance too; dropping it before the checks fails such cases.
  const root = mkdtempSync(join(tmpdir(), "parity-performance-"));
  try {
    writePerformanceCase(root);
    expect(readRun(root, "first")?.concerns).toEqual([
      {
        ref: "t1",
        kind: "correctness",
        caught: false,
        caughtByAny: false,
        matcherOnly: { caught: false, caughtByAny: false },
      },
      {
        ref: "t2",
        kind: "performance",
        caught: true,
        caughtByAny: true,
        matcherOnly: { caught: true, caughtByAny: true },
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a current category relabel moves a concern's kind; a stale one is read as labelled, and counted", () => {
  // Why: the floor and compare read kinds as the headline does, so a concern relabelled runtime best
  // practice joins the aim; a relabel of an earlier labelling must not apply, and must not pass quietly.
  const root = mkdtempSync(join(tmpdir(), "parity-relabel-"));
  try {
    writePerformanceCase(root);
    const write = (labelling: string) =>
      writeFileSync(
        join(root, "labels", "category-relabel.json"),
        JSON.stringify({
          version: 1,
          labelling,
          categories: {
            t2: {
              was: "performance",
              now: "runtime-best-practice",
              promptDigest: "0".repeat(64),
            },
          },
        }),
      );
    expect(relabelState(join(root, "labels")).state).toBe("none");
    write(labellingDigest(join(root, "labels")));
    expect(relabelState(join(root, "labels")).state).toBe("current");
    expect(concernLabels(root).get("t2")?.kind).toBe("runtime-best-practice");
    write("f".repeat(64));
    expect(relabelState(join(root, "labels")).state).toBe("stale");
    expect(concernLabels(root).get("t2")?.kind).toBe("performance");
    const runOf = readRun(root, "first")!;
    const result = parityComparison(
      [
        {
          caseId: "c1",
          source: "go",
          control: false,
          base: runOf,
          next: runOf,
          relabel: "stale",
        },
      ],
      { cases: 1, concerns: 1, flipped: 0, f: 0.1 },
    );
    expect(result.relabelStale).toEqual(["c1"]);
    expect(result.verdict).toContain(
      "1 case(s) read the labeller's categories, their relabel being of an earlier labelling",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Each case's concerns by kind, caught in the baseline and in the candidate.
const kindRun = (
  concerns: ReadonlyArray<readonly [string, boolean]>,
): ParityRun => ({
  concerns: concerns.map(([kind, caught], index) => ({
    ref: `c${index}`,
    kind,
    caught,
    caughtByAny: caught,
    matcherOnly: { caught, caughtByAny: caught },
  })),
  unconfirmed: null,
  items: 20,
  merit: { revision: 4, judged: 18, noise: 2, nitPick: 3 },
});

test("performance concerns sit outside the aim, the floor and by source, and their own row never falls", () => {
  // Why (10.142): Neuve has no measurements, so performance must neither move the aim nor be judged.
  const floor = { cases: 20, concerns: 40, flipped: 2, f: 0.05 };
  // The aim gains one of four on each case while every performance concern caught is lost.
  const cases = Array.from({ length: 30 }, (_, index) =>
    pair(
      `p${index}`,
      kindRun([
        ["correctness", true],
        ["design", false],
        ["correctness", false],
        ["design", false],
        ["performance", true],
      ]),
      kindRun([
        ["correctness", true],
        ["design", true],
        ["correctness", false],
        ["design", false],
        ["performance", false],
      ]),
    ),
  );
  const result = parityComparison(cases, floor);
  expect(result.caught).toMatchObject({
    n: 120,
    baseline: 0.25,
    candidate: 0.5,
  });
  expect(result.caughtByAny).toMatchObject({ baseline: 0.25, candidate: 0.5 });
  expect(result.caseMean).toMatchObject({ baseline: 0.25, candidate: 0.5 });
  expect(result.bySource["go"]!.concerns).toBe(120);
  expect(result.unpaired).toBe(0);
  expect(result.byKind["performance"]).toMatchObject({
    concerns: 30,
    delta: -1,
    outsideAim: true,
    judged: false,
    falls: false,
  });
  expect(result.byKind["correctness"]).toMatchObject({ outsideAim: false });
  expect(result.outsideAim).toEqual({
    kinds: ["performance"],
    concerns: 30,
    casesWithNoAimConcern: 0,
  });
  expect(result.verdict).toBe(
    "keep; 30 performance concern(s) left out of the aim, reported by kind",
  );
  // Items per reviewer concern still counts the performance concerns: five per case.
  expect(result.guards.itemsPerConcern.baseline).toBe(4);
  // A flip in a performance concern alone never widens the aim's floor.
  const repeat = pair(
    "r",
    kindRun([
      ["correctness", true],
      ["performance", true],
    ]),
    kindRun([
      ["correctness", true],
      ["performance", false],
    ]),
  );
  expect(parityFloor([repeat])).toMatchObject({
    concerns: 1,
    flipped: 0,
    f: 0,
  });
});

test("a failed case's lost concerns leave performance out, as its kept concerns do", () => {
  // Why: counting performance on the lost side only would tilt the failed share.
  const root = mkdtempSync(join(tmpdir(), "parity-lost-"));
  try {
    writePerformanceCase(root);
    expect(mixConcerns(root)).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const floor = { cases: 20, concerns: 40, flipped: 2, f: 0.05 };
  const kept = pair(
    "k",
    kindRun([
      ["correctness", true],
      ["performance", true],
    ]),
    kindRun([
      ["correctness", true],
      ["performance", true],
    ]),
  );
  const result = parityComparison([kept], floor, [
    {
      caseId: "f",
      source: "go",
      run: "fresh",
      why: "the run timed-out",
      concerns: 1,
    },
  ]);
  expect(result.failedBySource["go"]).toMatchObject({
    failedConcerns: 1,
    concerns: 2,
    concernShare: 0.5,
  });
});

test("a case holding only performance concerns stays a concern case and adds nothing to the aim", () => {
  // Why: the frozen sample made it a concern case; it must not vanish silently or divide by zero.
  const floor = { cases: 20, concerns: 40, flipped: 2, f: 0.05 };
  const only = kindRun([
    ["performance", true],
    ["performance", false],
  ]);
  const gaining = Array.from({ length: 30 }, (_, index) =>
    pair(
      `c${index}`,
      run([true, false, false, false]),
      run([true, true, false, false]),
    ),
  );
  const result = parityComparison([...gaining, pair("o", only, only)], floor);
  expect(result.concernCases).toBe(31);
  expect(result.controls).toBe(0);
  expect(result.caught.n).toBe(120);
  expect(result.caseMean).toMatchObject({ baseline: 0.25, candidate: 0.5 });
  expect(result.outsideAim).toMatchObject({
    concerns: 2,
    casesWithNoAimConcern: 1,
  });
  expect(result.verdict).toBe(
    "keep; 2 performance concern(s) left out of the aim, reported by kind",
  );
  // A sample of such cases alone gives no aim at all, and no error.
  const none = parityComparison([pair("o", only, only)], floor);
  expect(none.caught).toMatchObject({ n: 0, baseline: null, bar: null });
  expect(none.caseMean).toEqual({
    baseline: null,
    candidate: null,
    matcherOnly: { baseline: null, candidate: null },
    interval: null,
  });
  expect(none.verdict).toBe(
    "no gain; 2 performance concern(s) left out of the aim, reported by kind",
  );
});

// A case of three correctness concerns the matcher left unmatched in both runs: its first run's
// confirmation found none raised, its `again` run's found t1 raised by a comment and t2 by a checkpoint.
const writeConfirmedCase = (root: string) => {
  writeConcerns(root, [
    ["t1", "correctness"],
    ["t2", "correctness"],
    ["t3", "correctness"],
  ]);
  const items = [
    { id: "r1", source: "reviewer" as const, group: "concern", ref: "t1" },
    { id: "r2", source: "reviewer" as const, group: "concern", ref: "t2" },
    { id: "r3", source: "reviewer" as const, group: "concern", ref: "t3" },
    { id: "n1", source: "neuve" as const, group: "comment", ref: "b1.u1#1" },
    { id: "n2", source: "neuve" as const, group: "checkpoint", ref: "b1.u1#2" },
  ];
  const caseLabels = join(root, "labels");
  const again = join(root, "run", "again", "labels");
  writeMatching(caseLabels, items, []);
  writeMatching(again, items, []);
  writeConfirmation(caseLabels, caseLabels, { t1: null, t2: null, t3: null });
  writeConfirmation(again, caseLabels, { t1: "comment", t2: "item", t3: null });
};

test("a confirmed comment raises caught, a confirmed item only caughtByAny, and the matcher-only figure stands beside", () => {
  // Why: the confirmed credit decides a keep, as the headline's does; the matcher's own figure must
  // still read unchanged beside it, never mixed in.
  const root = mkdtempSync(join(tmpdir(), "parity-confirmed-"));
  try {
    writeConfirmedCase(root);
    const first = readRun(root, "first")!;
    const again = readRun(root, "again")!;
    expect(again.unconfirmed).toBeNull();
    expect(again.concerns.map((c) => [c.ref, c.caught, c.caughtByAny])).toEqual(
      [
        ["t1", true, true],
        ["t2", false, true],
        ["t3", false, false],
      ],
    );
    expect(again.concerns.every((c) => !c.matcherOnly.caughtByAny)).toBe(true);
    const result = parityComparison(
      [{ caseId: "a", source: "go", control: false, base: first, next: again }],
      { cases: 1, concerns: 3, flipped: 0, f: 0.1 },
    );
    expect(result.caught).toMatchObject({
      baseline: 0,
      candidate: 0.333,
      matcherOnly: { baseline: 0, candidate: 0, delta: 0 },
    });
    expect(result.caughtByAny).toMatchObject({
      baseline: 0,
      candidate: 0.667,
      matcherOnly: { baseline: 0, candidate: 0 },
    });
    expect(result.bySource["go"]).toMatchObject({
      delta: 0.333,
      matcherOnly: { delta: 0 },
    });
    expect(result.caseMean.matcherOnly).toEqual({ baseline: 0, candidate: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the floor's flip rate is of the confirmed credit, with the matcher-only rate beside it", () => {
  // Why: the bar judges the confirmed aim, so its noise must be the confirmed credit's flips.
  const root = mkdtempSync(join(tmpdir(), "parity-floor-confirmed-"));
  try {
    writeConfirmedCase(root);
    const floor = parityFloor([
      {
        caseId: "a",
        source: "go",
        control: false,
        base: readRun(root, "first")!,
        next: readRun(root, "again")!,
      },
    ]);
    expect(floor).toMatchObject({
      concerns: 3,
      flipped: 1,
      f: 0.333,
      matcherOnly: { flipped: 0, f: 0 },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runs with unmatched concerns and no current confirmation are refused together, each named", () => {
  // Why: scoring such a run would read a scoring gap as a miss; refusing one at a time, or dropping
  // one, would hide the others.
  const root = mkdtempSync(join(tmpdir(), "parity-refused-"));
  try {
    const write = (
      id: string,
      first: "missing" | "current" | "labelling",
      again: "current" | "matching",
    ) => {
      const directory = join(root, id);
      writeConcerns(directory, [["t1", "correctness"]]);
      const items = [
        { id: "r1", source: "reviewer" as const, group: "concern", ref: "t1" },
        { id: "n1", source: "neuve" as const, group: "comment", ref: "u#1" },
      ];
      const caseLabels = join(directory, "labels");
      const runLabels = join(directory, "run", "again", "labels");
      writeMatching(caseLabels, items, []);
      writeMatching(runLabels, items, []);
      if (first !== "missing")
        writeConfirmation(
          caseLabels,
          caseLabels,
          { t1: null },
          first === "labelling" ? { labelling: "0".repeat(64) } : {},
        );
      writeConfirmation(
        runLabels,
        caseLabels,
        { t1: null },
        again === "matching" ? { matching: "0".repeat(64) } : {},
      );
      return {
        caseId: id,
        source: "go",
        control: false,
        base: readRun(directory, "first")!,
        next: readRun(directory, "again")!,
      };
    };
    const cases = [
      write("a", "missing", "current"),
      write("b", "current", "matching"),
      write("c", "labelling", "current"),
      write("d", "current", "current"),
    ];
    const refusal = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("not refused");
    };
    const compared = refusal(() =>
      parityComparison(cases, { cases: 1, concerns: 1, flipped: 0, f: 0.1 }),
    );
    expect(compared).toContain(
      "3 run(s) hold concerns the matcher left unmatched",
    );
    expect(compared).toContain(
      "- a: first run: its unmatched concerns are not confirmed yet",
    );
    expect(compared).toContain(
      "- b: again run: its confirmation is of an earlier matching",
    );
    expect(compared).toContain(
      "- c: first run: its confirmation is of an earlier concern labelling",
    );
    expect(compared).toContain("[baseline]");
    expect(compared).toContain("[candidate]");
    expect(compared).not.toContain("- d:");
    // A run the floor reads too is listed once, under both roles.
    const both = refusal(() =>
      refuseUnconfirmed([
        { cases, base: "baseline", next: "candidate" },
        { cases: [cases[0]!], base: "floor", next: "floor" },
      ]),
    );
    expect(both).toContain("3 run(s)");
    expect(both).toContain("[baseline, floor]");
    expect(refusal(() => parityFloor(cases))).toContain("[floor]");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run whose concerns the matcher all paired needs no confirmation", () => {
  // Why: only concerns the matcher left unmatched are confirmed; asking more would refuse good runs.
  const root = mkdtempSync(join(tmpdir(), "parity-all-matched-"));
  try {
    writeConcerns(root, [["t1", "correctness"]]);
    writeMatching(
      join(root, "labels"),
      [
        { id: "r1", source: "reviewer", group: "concern", ref: "t1" },
        { id: "n1", source: "neuve", group: "comment", ref: "u#1" },
      ],
      ["r1|n1"],
    );
    const runOf = readRun(root, "first")!;
    expect(runOf.unconfirmed).toBeNull();
    expect(
      parityComparison(
        [
          {
            caseId: "m",
            source: "go",
            control: false,
            base: runOf,
            next: runOf,
          },
        ],
        { cases: 1, concerns: 1, flipped: 0, f: 0.1 },
      ).caught,
    ).toMatchObject({ baseline: 1, candidate: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a floor pair's stale relabel is said with the comparison's verdict", () => {
  // Why: a floor read under the labeller's categories sets the bar the aim is judged by.
  const result = parityComparison(
    [pair("a", run([true, false]), run([true, false]))],
    { cases: 2, concerns: 4, flipped: 0, f: 0.1, relabelStale: ["x", "y"] },
  );
  expect(result.verdict).toContain(
    "2 of the floor's pair(s) read the labeller's categories, their relabel being of an earlier labelling",
  );
});

test("a missing arm run is a failed case when the case's first run failed", () => {
  // Why: an arm recomposes only completed first runs, so those cases have no arm run and must be
  // reported as failed, not stop the comparison.
  const root = mkdtempSync(join(tmpdir(), "parity-first-failed-"));
  try {
    mkdirSync(join(root, "run"), { recursive: true });
    writeFileSync(
      join(root, "run", "show.json"),
      JSON.stringify({ outcome: "timed-out", packet: null }),
    );
    expect(missingRunFailure(root, "lanes-live")).toBe(
      "its first run failed (the run timed-out), so it has no lanes-live run",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing arm run on a case whose first run completed stays an error", () => {
  // Why: such a case should have its arm run; reading it as failed would hide a run that never ran.
  const root = mkdtempSync(join(tmpdir(), "parity-first-completed-"));
  try {
    mkdirSync(join(root, "run"), { recursive: true });
    writeFileSync(
      join(root, "run", "show.json"),
      JSON.stringify({
        outcome: "completed",
        packet: { complete: true, batches: [{ batchId: "b1", units: [] }] },
      }),
    );
    expect(missingRunFailure(root, "lanes-live")).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("each arm reports what its recompose reused and recomputed, by stage, beside the aim", () => {
  // Why: a mostly reused baseline against a fresh candidate changes what a gain means; it must read
  // beside the catches, with any step that neither reused nor recomputed named by case.
  const root = mkdtempSync(join(tmpdir(), "parity-recompose-"));
  try {
    mkdirSync(join(root, "run", "lanes-base"), { recursive: true });
    writeFileSync(join(root, "run", "show.json"), JSON.stringify({}));
    writeFileSync(
      join(root, "run", "lanes-base", "show.json"),
      JSON.stringify({
        recompose: {
          steps: [
            { agent: "dispose.b1.u1", outcome: "reused" },
            { agent: "dispose.b1.u2", outcome: "reused" },
            { agent: "dispose.b1.u3", outcome: "recomputed with the model" },
            { agent: "unit-titles.b1", outcome: "recomputed with the model" },
            { stage: "digest", outcome: "failed" },
            { agent: "evidence.b1.u1", outcome: "reused" },
          ],
        },
      }),
    );
    expect(runRecompose(root, "first")).toBeNull();
    const steps = runRecompose(root, "lanes-base")!;
    expect(steps.map((step) => step.stage)).toEqual([
      "review",
      "review",
      "review",
      "titles",
      "digest",
      "evidence",
    ]);
    const result = parityComparison(
      [
        {
          ...pair("a", run([true]), run([true])),
          recompose: { base: null, next: steps },
        },
        {
          ...pair("b", run([true]), run([true])),
          recompose: { base: null, next: steps.slice(0, 3) },
        },
      ],
      { cases: 2, concerns: 2, flipped: 0, f: 0.1 },
    );
    expect(result.recompose.baseline).toBeNull();
    expect(result.recompose.candidate).toEqual({
      cases: 2,
      notRecomposed: 0,
      byStage: {
        review: { reused: 4, "recomputed with the model": 2 },
        titles: { "recomputed with the model": 1 },
        digest: { failed: 1 },
        evidence: { reused: 1 },
      },
      otherOutcomes: [{ caseId: "a", steps: ["failed: digest"] }],
      reviews: { reused: 4, recomputed: 2, reusedShare: 0.667 },
    });
    expect(armRecompose([{ caseId: "x", steps: null }])).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
