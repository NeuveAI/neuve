// Why: the pair confirmation (10.141) turns concerns the matcher left unmatched into catches, and the
// confirmed figure decides between arms. So the judge must see Neuve's whole-file and owning-unit
// items, a split's pair always, and one decoy it cannot tell apart, and nothing that names the
// matcher's call; a concern counts as caught by a comment only when a majority names the same comment,
// by any item when the passes agree it is raised but disagree on which, never on a decoy; and the
// decoys' rate must be read with its interval and stop a full-set run above 1 in 10. A decision is
// only ever read through the key of the build it was made on, each pass casts one vote, a decoy is
// never one that could truly raise the concern, and a confirmation of an earlier matching or concern
// labelling is refused.

import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BlindGroup, BlindItem } from "../src/pr-replay/matching.ts";
import {
  ConfirmAnswer,
  ConfirmDecided,
  buildConfirm,
  confirmBuilt,
  confirmItem,
  confirmReport,
  confirmationOf,
  decoyPool,
  settleConfirm,
  type ConfirmCase,
  type ConfirmKey,
  type Decoy,
} from "../src/pr-replay/confirm.ts";
import {
  Confirmation,
  concernStandings,
  confirmedRefs,
  labellingDigest,
  matchingDigest,
  writeJson,
} from "../src/pr-replay/parity.ts";
import {
  RUBRICS,
  decideRubric,
  rubricOfItems,
} from "../src/pr-replay/rubric-judge.ts";

const item = (
  id: string,
  ref: string,
  line: number,
  group: BlindGroup = "comment",
  path = "a.js",
): BlindItem => ({
  id,
  source: group === "reviewer" ? "reviewer" : "neuve",
  group,
  ref,
  repeats: [],
  path,
  line,
  side: "new",
  anchoredTo: "line",
  text: `${id} text`,
});

const items = [
  item("r1", "t1", 100, "reviewer"),
  item("near", "b1.u1#comment-1", 104),
  item("far", "b1.u2#checkpoint-1", 400, "checkpoint"),
  item("owned", "b1.u3#consider-1", 7, "consider", "b.js"),
  item("other", "b1.u4#comment-1", 100, "comment", "c.js"),
  item("pair", "b1.u5#gap-1", 3, "gap", "d.js"),
];

const standingOf = (split: boolean) =>
  concernStandings(
    { items },
    split
      ? [
          {
            comments: [
              { id: "r1", holds: "plausible", sameAs: ["pair"], rationale: "" },
            ],
            verdicts: [],
          },
          null,
          null,
        ]
      : [null, null, null],
    new Set(["t1"]),
  )[0]!;

const decoy = {
  caseId: "case-2",
  item: item("d1", "b9.u1#comment-3", 900, "comment", "z.js"),
};

const built = (
  split = false,
  seed = 7,
  decoys: ReadonlyArray<Decoy> = [decoy],
  shownItems = items,
) =>
  confirmItem("case-1", null, standingOf(split), {
    items: shownItems,
    owners: ["b1.u3"],
    thread: ["this leaks"],
    diffs: [],
    seed,
    decoys,
  });

const decoyOf = (key: ConfirmKey) =>
  Object.values(key.candidates).find((one) => one.decoy) ?? null;

test("a missed concern's candidates are its file's items at any distance and its owners', with one decoy near it", () => {
  const { item: shown, key } = built();
  const byLabel = (test: (one: ConfirmKey["candidates"][string]) => boolean) =>
    Object.entries(key.candidates).filter(([, one]) => test(one));
  expect(
    byLabel((one) => !one.decoy)
      .map(([, one]) => (one.decoy ? null : one.ref))
      .sort(),
  ).toEqual(["b1.u1#comment-1", "b1.u2#checkpoint-1", "b1.u3#consider-1"]);
  const [[label, keyed]] = byLabel((one) => one.decoy) as [
    [string, ConfirmKey["candidates"][string]],
  ];
  expect(keyed).toMatchObject({ decoy: true, from: "case-2" });
  // The decoy stands on the concern's file and side, near its line, with another case's text.
  const decoyShown = shown.candidates.find((one) => one.label === label)!;
  expect(decoyShown).toMatchObject({
    path: "a.js",
    side: "new",
    text: "d1 text",
  });
  expect(Math.abs(decoyShown.line - 100)).toBeLessThanOrEqual(15);
  expect(key).toMatchObject({ standing: "missed", capped: 0 });
  // Nothing the judge sees names the matcher's call, a unit or the decoy.
  expect(JSON.stringify(shown)).not.toMatch(/missed|split|b1\.u|decoy|case-/);
});

test("a split concern's pair is always a candidate, wherever it stands", () => {
  const { key } = built(true);
  expect(
    Object.values(key.candidates).some(
      (one) => !one.decoy && one.ref === "b1.u5#gap-1",
    ),
  ).toBe(true);
  expect(key.standing).toBe("split");
});

const keyWith = (
  candidates: Record<string, ConfirmKey["candidates"][string]>,
): ConfirmKey => ({
  id: "p000000000001",
  caseId: "case-1",
  ref: "t1",
  standing: "missed",
  capped: 0,
  candidates,
});
const comment = (ref: string) =>
  ({ decoy: false, item: ref, group: "comment", ref, distance: 3 }) as const;
const checkpoint = (ref: string) =>
  ({
    decoy: false,
    item: ref,
    group: "checkpoint",
    ref,
    distance: null,
  }) as const;
const theDecoy = {
  decoy: true,
  from: "case-2",
  ref: "x",
  group: "comment",
  pool: "first runs",
} as const;
const four = keyWith({
  A: comment("c1"),
  B: comment("c2"),
  C: checkpoint("k1"),
  D: theDecoy,
});

test("a majority naming one comment catches it by a comment; one other item, by any item", () => {
  expect(
    confirmationOf(four, { candidate: "A", votes: "A A -" }),
  ).toMatchObject({ caught: "comment", agreed: true, by: { ref: "c1" } });
  expect(
    confirmationOf(four, { candidate: "C", votes: "C A C" }),
  ).toMatchObject({
    caught: "item",
    agreed: true,
    by: { group: "checkpoint" },
  });
});

test("passes that agree it is raised but name different items catch it by any item, kept as a disagreement", () => {
  const row = confirmationOf(four, { candidate: "unsure", votes: "A B C" });
  expect(row).toMatchObject({ caught: "item", agreed: false, by: null });
  expect(row.votes).toEqual([
    { group: "comment", ref: "c1" },
    { group: "comment", ref: "c2" },
    { group: "checkpoint", ref: "k1" },
  ]);
});

test("a decoy a majority names catches nothing, and neither does one real vote or a label the item lacks", () => {
  expect(
    confirmationOf(four, { candidate: "D", votes: "D A D" }),
  ).toMatchObject({ caught: null, decoyNamed: true });
  expect(
    confirmationOf(four, { candidate: "unsure", votes: "A none D" }),
  ).toMatchObject({ caught: null, decoyNamed: false });
  expect(
    confirmationOf(four, { candidate: "unsure", votes: "A Q none" }).votes,
  ).toEqual([{ group: "comment", ref: "c1" }, "unknown", "none"]);
  expect(confirmationOf(four, undefined)).toMatchObject({ caught: null });
});

test("the report reads the decoys' rate with its interval, and stops a full-set run above 1 in 10", () => {
  const keys = Array.from({ length: 10 }, (_, at) => ({
    ...four,
    id: `p00000000000${at}`,
    ref: `t${at}`,
  }));
  const answers = keys.map((key, at) =>
    at < 2
      ? { id: key.id, candidate: "D", votes: "D D -" }
      : at < 5
        ? { id: key.id, candidate: "A", votes: "A A -" }
        : { id: key.id, candidate: "none", votes: "none none -" },
  );
  const report = confirmReport(keys, answers.slice(0, 9), 2);
  expect(report).toMatchObject({
    concerns: 10,
    decided: 9,
    caught: { comment: 3, any: 3 },
    decoys: {
      shown: 9,
      named: 2,
      passVotes: { cast: 18, onDecoy: 4 },
      stop: true,
    },
    window: { confirmedBeyondNearby: 0, matchedOutsideWindow: 2 },
  });
  expect(report.decoys.interval![0]).toBeGreaterThan(0.05);
  expect(report.decoys.interval![1]).toBeLessThan(0.6);
  expect(confirmReport(keys, answers.slice(2), 0).decoys.stop).toBe(false);
});

test("the judge takes confirmation items, keeps every pass's vote and the reasons behind any answer", () => {
  const { item: shown } = built();
  const { rubric } = rubricOfItems({
    version: 1,
    questions: [...RUBRICS.p.questions],
    chunks: [[shown]],
  });
  expect(rubric).toBe(RUBRICS.p);
  const pass = (candidate: string, reason: string) =>
    ({ answers: [{ id: shown.id, candidate, reason }] }) as never;
  expect(
    decideRubric(
      RUBRICS.p,
      [shown.id],
      [pass("B", "B says it"), pass("C", "C"), pass("B", "B again")],
    )[0],
  ).toEqual({
    id: shown.id,
    candidate: "B",
    reason: "B says it | B again",
    votes: "B C B",
  });
  expect(
    decideRubric(
      RUBRICS.p,
      [shown.id],
      [pass("none", "no"), pass("none", "no"), null],
    )[0],
  ).toMatchObject({ candidate: "none", votes: "none none -" });
});

test("settling writes each case's confirmation only once every concern is decided", () => {
  const folder = mkdtempSync(join(tmpdir(), "confirm-"));
  const labels = join(folder, "case-1-labels");
  const rematched = join(folder, "case-2-labels");
  const relabelled = join(folder, "case-3-labels");
  for (const one of [labels, rematched, relabelled]) {
    mkdirSync(one);
    writeFileSync(join(one, "matching-key.json"), "{}");
    writeFileSync(join(one, "matching.json"), "{}");
    writeFileSync(join(one, "concerns.jsonl"), "{}\n");
  }
  // Each case's run labels hold its concern labels too, as a first run's do.
  const caseOf = (caseId: string, at: string) => ({
    caseId,
    labels: at,
    matching: matchingDigest(at),
    caseLabels: at,
    labelling: labellingDigest(at),
  });
  try {
    const keys = [
      { ...four, id: "p000000000001", ref: "t1", labels },
      { ...four, id: "p000000000002", ref: "t2", labels },
    ];
    writeFileSync(
      join(folder, "key.json"),
      JSON.stringify({
        run: "cloud-2",
        cases: [
          caseOf("case-1", labels),
          caseOf("case-2", rematched),
          caseOf("case-3", relabelled),
        ],
        matchedOutsideWindow: 0,
        keys,
      }),
    );
    const decide = (count: number) =>
      writeFileSync(
        join(folder, "decided.json"),
        JSON.stringify({
          version: 1,
          promptDigest: "a".repeat(64),
          answers: keys.slice(0, count).map((key) => ({
            id: key.id,
            candidate: "A",
            reason: "",
            votes: "A A -",
          })),
        }),
      );
    decide(1);
    expect(settleConfirm(folder).complete).toBe(false);
    expect(existsSync(join(labels, "confirmation.json"))).toBe(false);
    decide(2);
    // case-2 is matched again after the build, and case-3's concerns labelled again: neither is written.
    writeFileSync(join(rematched, "matching.json"), '{"again":true}');
    writeFileSync(join(relabelled, "concerns.jsonl"), '{"again":true}\n');
    expect(settleConfirm(folder)).toMatchObject({
      complete: true,
      staleCases: ["case-2", "case-3"],
    });
    expect(existsSync(join(rematched, "confirmation.json"))).toBe(false);
    expect(existsSync(join(relabelled, "confirmation.json"))).toBe(false);
    const written = Confirmation.parse(
      JSON.parse(readFileSync(join(labels, "confirmation.json"), "utf8")),
    );
    expect(written.run).toBe("cloud-2");
    expect(written.concerns.map((row) => [row.ref, row.caught])).toEqual([
      ["t1", "comment"],
      ["t2", "comment"],
    ]);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("an item's ID names its seed and what is shown, so another build's answers are never read through it", () => {
  const first = built().item.id;
  expect(built().item.id).toBe(first);
  expect(built(false, 8).item.id).not.toBe(first);
  const moved = items.map((one) =>
    one.id === "near" ? { ...one, text: "another text" } : one,
  );
  expect(built(false, 7, [decoy], moved).item.id).not.toBe(first);
});

test("a build refuses a folder another build used", () => {
  const folder = mkdtempSync(join(tmpdir(), "confirm-used-"));
  try {
    writeFileSync(join(folder, "decided-0.json"), "{}");
    expect(() => buildConfirm(folder, 1)).toThrow("is not empty");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("a pass casts one vote: several labels in one answer fail the pass, and a decision holds three votes", () => {
  const id = "p000000000001";
  expect(
    ConfirmAnswer.safeParse({ id, candidate: "B C", reason: "" }).success,
  ).toBe(false);
  for (const candidate of ["A", "Z", "Z1", "Z30", "none", "unsure"])
    expect(ConfirmAnswer.safeParse({ id, candidate, reason: "" }).success).toBe(
      true,
    );
  const decided = (votes: string) =>
    ConfirmDecided.safeParse({
      version: 1,
      answers: [{ id, candidate: "unsure", reason: "", votes }],
    }).success;
  expect(decided("B C none")).toBe(true);
  expect(decided("B C none none")).toBe(false);
  expect(decided("B C")).toBe(false);
});

test("a decoy is never from the concern's own file, nor worded as a candidate is", () => {
  const sameFile = {
    caseId: "case-3",
    item: item("s1", "b8.u1#gap-1", 5, "gap", "a.js"),
  };
  const sameText = {
    caseId: "case-4",
    item: {
      ...item("s2", "b7.u1#comment-1", 5, "comment", "q.js"),
      text: "NEAR  Text",
    },
  };
  expect(
    decoyOf(built(false, 7, [sameFile, sameText, decoy]).key),
  ).toMatchObject({
    from: "case-2",
  });
  expect(decoyOf(built(false, 7, [sameFile, sameText]).key)).toBeNull();
});

const caseOf = (
  caseId: string,
  source: string,
  neuve: ReadonlyArray<BlindItem>,
): ConfirmCase => ({
  caseId,
  source,
  labels: `/labels/${caseId}`,
  matching: "f".repeat(64),
  caseLabels: `/labels/${caseId}`,
  labelling: "e".repeat(64),
  key: { seed: 3, items: [items[0]!, ...neuve] },
  passes: [null, null, null],
  substantive: new Set(["t1"]),
  packet: null,
  threads: new Map(),
  diffs: [],
});

test("a build is the same for the same seed, and draws decoys from the run's own items before the first runs'", () => {
  const runCases = [
    caseOf("run-a", "react", [item("ra", "b1.u1#comment-1", 101)]),
    caseOf("run-b", "react", [
      item("rb", "b1.u1#comment-1", 50, "comment", "r.js"),
    ]),
    caseOf("run-c", "go", [item("rc", "b1.u1#comment-1", 101)]),
  ];
  const first = [
    caseOf("first-a", "go", [
      item("fa", "b1.u1#comment-1", 50, "comment", "f.js"),
    ]),
  ];
  const pools = [
    { name: "this run", pool: decoyPool(runCases) },
    { name: "first runs", pool: decoyPool(first) },
  ];
  const once = confirmBuilt(runCases, pools, 11, "cloud-2");
  expect(confirmBuilt(runCases, pools, 11, "cloud-2")).toEqual(once);
  const byCase = new Map(once.built.map((one) => [one.key.caseId, one.key]));
  // react has another case in the run; go does not, so its decoy comes from the first runs.
  expect(byCase.get("run-a")).toMatchObject({ decoyPool: "this run" });
  expect(decoyOf(byCase.get("run-a")!)).toMatchObject({ from: "run-b" });
  expect(byCase.get("run-c")).toMatchObject({ decoyPool: "first runs" });
  expect(decoyOf(byCase.get("run-c")!)).toMatchObject({ from: "first-a" });
  // run-b's only other react case is run-a, whose item stands on run-b's concern file, and the first
  // runs hold no other react case: no decoy.
  expect(byCase.get("run-b")).toMatchObject({ decoyPool: null });
});

test("the miss sort refuses a run with no confirmation, or one of an earlier matching or labelling", () => {
  const labels = mkdtempSync(join(tmpdir(), "confirm-refs-"));
  try {
    writeFileSync(join(labels, "matching-key.json"), "{}");
    writeFileSync(join(labels, "matching.json"), '{"pairs":[]}');
    writeFileSync(join(labels, "concerns.jsonl"), "{}\n");
    const refs = () => confirmedRefs("case-1", labels, labels);
    expect(refs).toThrow("not confirmed yet");
    const write = (matching: string, labelling = labellingDigest(labels)) =>
      writeFileSync(
        join(labels, "confirmation.json"),
        JSON.stringify({
          version: 1,
          promptDigest: "a".repeat(64),
          matching,
          labelling,
          run: null,
          concerns: [
            {
              ref: "t1",
              standing: "missed",
              caught: "item",
              agreed: false,
              by: null,
              votes: [],
            },
            {
              ref: "t2",
              standing: "split",
              caught: null,
              agreed: false,
              by: null,
              votes: [],
            },
          ],
        }),
      );
    write(matchingDigest(labels));
    expect([...refs()]).toEqual(["t1"]);
    // A confirmation from before the labelling digest is refused with what to do.
    const current = readFileSync(join(labels, "confirmation.json"), "utf8");
    const { labelling: _, ...older } = JSON.parse(current) as Record<
      string,
      unknown
    >;
    writeFileSync(join(labels, "confirmation.json"), JSON.stringify(older));
    expect(refs).toThrow("built before the labelling digest");
    writeFileSync(join(labels, "confirmation.json"), current);
    write(matchingDigest(labels), "0".repeat(64));
    expect(refs).toThrow("earlier concern labelling");
    write(matchingDigest(labels));
    writeFileSync(join(labels, "matching.json"), '{"pairs":["x|y"]}');
    expect(refs).toThrow("earlier matching");
  } finally {
    rmSync(labels, { recursive: true, force: true });
  }
});

test("a key from before the labelling digest is refused with what to do, and files are written whole", () => {
  const folder = mkdtempSync(join(tmpdir(), "confirm-old-key-"));
  try {
    writeFileSync(
      join(folder, "key.json"),
      JSON.stringify({
        run: null,
        cases: [{ caseId: "case-1", labels: folder, matching: "f".repeat(64) }],
        matchedOutsideWindow: 0,
        keys: [],
      }),
    );
    writeFileSync(
      join(folder, "decided.json"),
      JSON.stringify({ version: 1, answers: [] }),
    );
    expect(() => settleConfirm(folder)).toThrow(
      "built before the labelling digest",
    );
    writeJson(join(folder, "out.json"), { a: 1 });
    expect(readdirSync(folder).sort()).toEqual([
      "decided.json",
      "key.json",
      "out.json",
    ]);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
