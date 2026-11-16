// Why: the line evidence is the lanes climb's second answer key, so its classes must follow the
// owner's ruling (10.128) exactly: a person's concern that led to a change, or a fix after landing,
// needs a person; discussion with no change is suggested to one; a confirmed bot finding or a fixed
// nit is agent work; and silence, the author's notes and unconfirmed bot findings are no label. A
// design decision needs a person wherever it was made (10.132): a person's thread that states or
// explains one counts even when it asked for nothing, and so does the author's adopted question.
// Where the two labelling passes disagree, a line must be disputed and absent, never guessed.
import { expect, test } from "bun:test";
import type { Judgement } from "../src/pr-replay/concerns.ts";
import {
  concernClass,
  lineEvidence,
  withoutOverridden,
  type ConcernRow,
} from "../src/pr-replay/evidence.ts";

const judge = (overrides: Partial<Judgement> = {}): Judgement => ({
  id: "t",
  isConcern: true,
  category: "correctness",
  substantive: true,
  response: "fixed",
  fixRevision: 2,
  validity: "valid",
  designDecision: false,
  rationale: "",
  ...overrides,
});

test("each thread maps to the class the owner ruled", () => {
  expect(concernClass(judge(), "person")?.class).toBe("needs-person");
  expect(
    concernClass(
      judge({ response: "answered", designDecision: true }),
      "person",
    )?.class,
  ).toBe("needs-person");
  for (const response of [
    "answered",
    "rejected-with-reason",
    "acknowledged-not-fixed",
  ] as const)
    expect(concernClass(judge({ response }), "person")?.class).toBe(
      "discussed",
    );
  expect(concernClass(judge({ substantive: false }), "person")?.class).toBe(
    "agent-catchable",
  );
  expect(concernClass(judge(), "bot")?.class).toBe("agent-catchable");
  // No label: unresolved, the author's own notes, unconfirmed or wrong bot findings, non-concerns.
  expect(concernClass(judge({ response: "unresolved" }), "person")).toBeNull();
  expect(concernClass(judge(), "author")).toBeNull();
  expect(concernClass(judge({ validity: "invalid" }), "bot")).toBeNull();
  expect(
    concernClass(judge({ response: "rejected-with-reason" }), "bot"),
  ).toBeNull();
  expect(concernClass(judge({ isConcern: false }), "person")).toBeNull();
});

test("a design decision needs a person wherever it was made (10.132)", () => {
  // A reviewer explaining a decision made off the thread: not a concern, still a decision.
  expect(
    concernClass(
      judge({
        isConcern: false,
        substantive: false,
        response: "not-applicable",
        designDecision: true,
      }),
      "person",
    )?.class,
  ).toBe("needs-person");
  // The author's own question, answered and adopted, is a concern and a decision.
  expect(
    concernClass(
      judge({ response: "answered", designDecision: true }),
      "author",
    )?.class,
  ).toBe("needs-person");
  // An author's question that nobody answered or adopted is no decision of a person's.
  expect(
    concernClass(
      judge({ response: "unresolved", designDecision: true }),
      "author",
    ),
  ).toBeNull();
  // The author's own note, asking nothing, stays no label even if it records a decision.
  expect(
    concernClass(judge({ isConcern: false, designDecision: true }), "author"),
  ).toBeNull();
  expect(concernClass(judge({ designDecision: true }), "bot")?.class).toBe(
    "agent-catchable",
  );
});

const row = (
  id: string,
  key: string | null,
  opener: ConcernRow["opener"],
  a: Judgement | null,
  b: Judgement | null = a,
): ConcernRow => ({ id, opener, firstRevisionKey: key, a, b });

test("lines take the most demanding class, disagreement is disputed, and silence stays absent", () => {
  const { lines, disputed, kappa } = lineEvidence(
    [
      // One line: a bot finding and a person's fixed concern; the person's wins.
      row("bot", "a.ts:new:1", "bot", judge()),
      row("person", "a.ts:new:1", "person", judge()),
      // The passes disagree on whether this was fixed or only discussed: disputed.
      row(
        "split",
        "a.ts:new:2",
        "person",
        judge(),
        judge({ response: "answered" }),
      ),
      // One pass sees no concern at all: disputed.
      row("half", "a.ts:new:3", "person", judge(), judge({ isConcern: false })),
      // A change-level thread has no line.
      row("change", null, "person", judge()),
    ],
    new Map([["b.ts:new:7", "abc123"]]),
    ["yarn.lock:new:1"],
  );
  expect(lines["a.ts:new:1"]).toEqual({
    class: "needs-person",
    strength: "strong",
    concerns: ["person"],
  });
  expect(lines["b.ts:new:7"]?.class).toBe("needs-person");
  expect(lines["b.ts:new:7"]?.concerns).toEqual(["after-merge:abc123"]);
  expect(lines["yarn.lock:new:1"]?.class).toBe("mechanical");
  expect(lines["a.ts:new:2"]).toBeUndefined();
  expect(lines["a.ts:new:3"]).toBeUndefined();
  expect(Object.keys(lines).sort()).toEqual([
    "a.ts:new:1",
    "b.ts:new:7",
    "yarn.lock:new:1",
  ]);
  expect(disputed).toBe(2);
  expect(kappa).not.toBeNull();
  expect(kappa!).toBeLessThan(1);
});

test("kappa reads only the concern judgements: code-decided lines never inflate it", () => {
  // Two person concerns the passes judge oppositely: agreement below chance.
  const split = [
    row("x", "a.ts:new:1", "person", judge(), judge({ isConcern: false })),
    row("y", "a.ts:new:2", "person", judge({ isConcern: false }), judge()),
  ];
  const lockfile = Array.from(
    { length: 200 },
    (_, i) => `yarn.lock:new:${i + 1}`,
  );
  const fixes = new Map(
    Array.from({ length: 50 }, (_, i) => [`b.ts:new:${i + 1}`, "abc"]),
  );
  const alone = lineEvidence(split, new Map(), []).kappa;
  expect(alone).toBe(-1);
  // 200 lockfile lines and 50 post-merge fixes, shared by both passes, change nothing.
  expect(lineEvidence(split, fixes, lockfile).kappa).toBe(alone);
  // A line both passes leave unclassed is agreement on "none": with it kappa is 0.4; dropping it
  // (as before) would read 0.
  const withNone = [
    row("w", "a.ts:new:1", "person", judge()),
    row("z", "a.ts:new:2", "person", judge({ isConcern: false })),
    row("x", "a.ts:new:3", "person", judge(), judge({ isConcern: false })),
  ];
  expect(lineEvidence(withNone, new Map(), []).kappa).toBeCloseTo(0.4, 10);
});

test("kappa is null when only one category appears, never a perfect 1", () => {
  // One anchored line both passes class alike, and one both leave unclassed.
  expect(
    lineEvidence([row("x", "a.ts:new:1", "person", judge())], new Map(), [])
      .kappa,
  ).toBeNull();
  expect(
    lineEvidence(
      [row("x", "a.ts:new:1", "person", judge({ isConcern: false }))],
      new Map(),
      [],
    ).kappa,
  ).toBeNull();
  // A thread one pass skipped is counted apart from disagreement.
  expect(
    lineEvidence(
      [row("x", "a.ts:new:1", "person", judge(), null)],
      new Map(),
      [],
    ).missing,
  ).toBe(1);
});

test("an audit override takes only its citation off only its lines, and each line keeps its other evidence", () => {
  // Why: a label every auditor found wrong is corrected without labelling the case again, and a
  // rebuild must keep the correction; a line with other evidence must keep the class that gives.
  const concerns = [
    row("bot", "a.ts:new:1", "bot", judge()),
    row("person", "a.ts:new:1", "person", judge()),
    row("alone", "a.ts:new:5", "person", judge()),
  ];
  const fixedAfter = new Map([
    ["b.ts:new:7", "abc123"],
    ["b.ts:new:8", "abc123"],
  ]);
  const override = (
    origin: "review" | "after-merge" | "path",
    cite: string,
    lines: string[],
  ) => ({
    audit: "batch-1",
    origin,
    cite,
    lines,
    was: "needs-person" as const,
    now: "none" as const,
    verdicts: ["wrong" as const, "wrong" as const, "wrong" as const],
    reasons: ["r", "r", "r"],
  });
  const { lines } = lineEvidence(
    ...withoutOverridden(
      concerns,
      fixedAfter,
      ["yarn.lock:new:1"],
      [
        override("review", "person", ["a.ts:new:1"]),
        override("review", "alone", ["a.ts:new:5"]),
        override("after-merge", "abc123", ["b.ts:new:7"]),
        override("path", "yarn.lock", ["yarn.lock:new:1"]),
      ],
    ),
  );
  // The person's thread is off line 1, so its bot finding gives it agent-catchable.
  expect(lines["a.ts:new:1"]?.class).toBe("agent-catchable");
  // A line with nothing else is absent: no class.
  expect(lines["a.ts:new:5"]).toBeUndefined();
  // The fix is off line 7 only; line 8, outside the override, keeps it.
  expect(lines["b.ts:new:7"]).toBeUndefined();
  expect(lines["b.ts:new:8"]?.class).toBe("needs-person");
  expect(lines["yarn.lock:new:1"]).toBeUndefined();
});
