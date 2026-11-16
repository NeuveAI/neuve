// Why: one section's decision is pure code over recorded values, and three things must hold.
// 1. Every row of the outcome table gives its lane, undecided cause and disposition: no outcome may
//    be undefined, and a failure of any kind must end with a person, never with an approval.
// 3. `recordedLane` over a stored entry returns the entry's lane, including where code added a gap
//    and where the section is undecided with and without an assessment: the lanes eval recomputes
//    stored lanes and refuses a run that differs.
// 8. A reading not judged or refused never produces an approval on any lane, and a refused section
//    is not settled: the owner's ruling on quota and failure.
import { expect, test } from "bun:test";
import { applyLane } from "../src/disposition.ts";
import { floorsOf, recordedLane, type Move } from "../src/lane-rule.ts";
import {
  decideSection,
  OUTCOMES,
  type DecideInput,
} from "../src/readings/decide.ts";
import {
  EvidenceOutcome,
  HeadGateStatus,
  RelationsShown,
  relationsGapCause,
} from "../src/readings/evidence.ts";
import { batchSettled, composeUnits } from "../src/readings/units.ts";
import { inputFor, LANES } from "./fixtures/readings.ts";

test("every row of the outcome table gives its lane, undecided cause and disposition", () => {
  expect(OUTCOMES.length).toBeGreaterThan(15);
  for (const row of OUTCOMES)
    for (const lane of LANES) {
      const input = inputFor({
        lane,
        assess: row.assess,
        review: row.review,
        claims: row.claims,
        cap: row.cap,
        ...(row.excluded === undefined ? {} : { excluded: row.excluded }),
      });
      const decision = decideSection(input);
      expect({ state: row.state, settled: decision.settled }).toEqual({
        state: row.state,
        settled: row.settled,
      });
      if (!decision.settled) {
        expect(row.lane).toBeNull();
        expect(decision.verdict).toBeNull();
        continue;
      }
      const entry = decision.entry;
      expect({ state: row.state, lane: entry.lane.applied as string }).toEqual({
        state: row.state,
        lane: row.lane === "rule" ? lane : (row.lane ?? "none"),
      });
      expect({ state: row.state, undecided: entry.undecided ?? null }).toEqual({
        state: row.state,
        undecided: row.undecided,
      });
      expect({ state: row.state, verdict: entry.verdict }).toEqual({
        state: row.state,
        verdict: row.verdict,
      });
      const [unit] = composeUnits([{ path: "a.ts", order: 0, decision }]);
      // A unit with an undecided section has no verdict, so no disposition (`composeUnits`).
      const expected =
        row.disposition === "none" || entry.undecided !== undefined
          ? { disposition: undefined, suggestion: false }
          : applyLane(entry.lane.applied, row.verdict!);
      expect({
        state: row.state,
        disposition: unit!.disposition,
        suggestion: unit!.suggestion,
      }).toEqual({ state: row.state, ...expected });
      // A failure of any kind ends with a person.
      if (entry.undecided !== undefined)
        expect(unit!.disposition).not.toBe("approve");
    }
});

test("recordedLane over a stored entry gives the entry's lane", () => {
  const cases = [
    // Decided, in each lane.
    ...LANES.map((lane) => inputFor({ lane })),
    // Code added the relation gap: a low, easy section goes to human-suggested.
    inputFor({ lane: "static-automation", relations: false }),
    // Code added the structure gap.
    inputFor({ lane: "agentic", boundaries: "fallback" }),
    // The removal floor raised it.
    inputFor({ lane: "agentic", removal: true }),
    // Undecided with an assessment.
    inputFor({ lane: "agentic", review: "unsure" }),
    // Undecided without one.
    inputFor({ assess: "failed" }),
    // An excluded file: no assessment, not undecided, today's lane for such a file.
    inputFor({ excluded: "lockfile" }),
  ];
  const applied: Array<string> = [];
  for (const input of cases) {
    const decision = decideSection(input);
    if (!decision.settled) throw new Error("expected a settled section");
    const entry = decision.entry;
    const trail = recordedLane(entry, input.section.added);
    expect({
      judged: trail.judged,
      surfaced: trail.surfaced,
      floors: trail.floors,
      applied: trail.applied,
    }).toEqual(entry.lane);
    // The floor rule's inputs are on the entry: run again, they give every floor it recorded.
    const again = floorsOf(entry.floorInputs.facts, entry.floorInputs.options);
    for (const floor of entry.lane.floors)
      expect(again as ReadonlyArray<unknown>).toContainEqual(floor);
    applied.push(entry.lane.applied);
  }
  expect(applied).toEqual([
    ...LANES,
    "human-suggested",
    "human-suggested",
    "human-suggested",
    "human-required",
    "human-required",
    "human-suggested",
  ]);
  const excluded = decideSection(inputFor({ excluded: "declared-generated" }));
  if (!excluded.settled) throw new Error("expected a settled section");
  expect(excluded.entry).toMatchObject({
    assess: null,
    review: null,
    excluded: { reason: "declared-generated" },
    lane: {
      judged: null,
      surfaced: null,
      floors: [],
      applied: "human-suggested",
    },
    verdict: null,
    restsOn: [],
  });
  expect(excluded.entry.undecided).toBeUndefined();
  const gapped = decideSection(
    inputFor({ lane: "static-automation", relations: false }),
  );
  if (!gapped.settled) throw new Error("expected a settled section");
  expect(gapped.entry.assess?.gaps.map((gap) => gap.kind)).toEqual([
    "relations-unavailable",
  ]);
  expect(gapped.entry.lane.judged).toBe("human-suggested");
  const undecided = decideSection(inputFor({ assess: "failed" }));
  if (!undecided.settled) throw new Error("expected a settled section");
  expect(undecided.entry.lane).toEqual({
    judged: null,
    surfaced: null,
    floors: [],
    applied: "human-required",
  });
  const unsure = decideSection(inputFor({ lane: "agentic", review: "unsure" }));
  if (!unsure.settled) throw new Error("expected a settled section");
  expect(unsure.entry.lane.judged).toBe("agentic");
  expect(unsure.entry.lane.applied).toBe("human-required");
});

test("a reading not judged or refused never yields an approval, and a refused section is not settled", () => {
  const causes = ["failed", "too-large", "not-reached", "refused"] as const;
  for (const lane of LANES)
    for (const cause of causes)
      for (const cap of [false, true])
        for (const verdict of ["approve", "request-changes", "unsure"] as const)
          for (const input of [
            inputFor({ lane, assess: cause, review: verdict, cap }),
            inputFor({ lane, review: cause, cap }),
            inputFor({ lane, assess: cause, review: cause, cap }),
          ]) {
            const decision = decideSection(input);
            if (cause === "refused") {
              expect(decision.settled).toBe(false);
              expect(batchSettled([{ decision }])).toBe(false);
              // Units form only for a settled batch: an unsettled section is an error.
              expect(() =>
                composeUnits([{ path: "a.ts", order: 0, decision }]),
              ).toThrow("1 of its 1 section(s) is not settled");
              continue;
            }
            if (cause === "not-reached" && !cap) {
              expect(decision.settled).toBe(false);
              continue;
            }
            expect(decision.settled).toBe(true);
            if (!decision.settled) continue;
            expect(decision.entry.lane.applied).toBe("human-required");
            const [unit] = composeUnits([{ path: "a.ts", order: 0, decision }]);
            expect(unit!.disposition).not.toBe("approve");
          }
});

// Reason (round 23): under the hold every code section keeps the relations gap, so its words must
// say what the read found. The owner's batch told 27 sections whose callers were read that they were
// "not available". Each state of a decision that read the head has its own words; only a head the
// decision did not find stored (or no decision) is "not available", which is then true.
test("the relations gap names what the read found: each state its own words, a read decision never 'not available', and a head not stored still 'not available'", () => {
  const NOT_AVAILABLE =
    "The callers and tests of this code were not available, so how it is used could not be checked.";
  /** The relations gap's words for a section whose group decided `evidence` and whose state is `state`. */
  const words = (
    evidence: Parameters<typeof relationsGapCause>[0],
    state: RelationsShown,
    file?: { readonly gitlink: boolean },
  ) => {
    const input = inputFor({ relations: false });
    const out = decideSection({
      ...input,
      section: {
        ...input.section,
        relationsGap: relationsGapCause(evidence, state, file),
      },
    });
    if (!out.settled) throw new Error("not settled");
    const gaps = out.entry.assess!.gaps.filter(
      (gap) => gap.kind === "relations-unavailable",
    );
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.axis).toBe("ease-of-validation");
    return gaps[0]!.detail;
  };
  const read = { outcome: "read" as const };
  // 1. Each state's exact words.
  expect(words(read, "no-evidence")).toBe(
    "No caller shows how this code is used.",
  );
  expect(words(read, "partial")).toBe(
    "The callers read don't show how all of this code is used.",
  );
  expect(words(read, "over-cap")).toBe(
    "This change touches too much code to show all its callers.",
  );
  expect(words(read, "shown")).toBe(
    "The callers of this code were read; a person still reviews it.",
  );
  // A section the read did not reach: in general, and named where the stored data says why (a
  // submodule pointer, from its own manifest hunks' gitlink mode).
  expect(words(read, "not-read")).toBe("Callers weren't read for this file.");
  expect(words(read, "not-read", { gitlink: true })).toBe(
    "Callers aren't read for a submodule pointer, so none is shown.",
  );
  // The gate's ends, on a head not stored, keep their words.
  const notStored = (
    status: (typeof HeadGateStatus.options)[number],
    wallMs: number | null,
  ) => ({
    outcome: "not-stored" as const,
    gate: { status, wallMs },
  });
  expect(words(notStored("cutoff", 41_000), "not-read")).toBe(
    "The callers and tests of this code were still being computed when it was read.",
  );
  expect(words(notStored("cutoff", 0), "not-read")).toBe(
    "The callers and tests of this code had not started being computed when it was read.",
  );
  expect(words(notStored("published", null), "not-read")).toBe(
    "The callers and tests of this code were not computed before the review was published, so how it is used could not be checked.",
  );
  expect(words(notStored("stopped", null), "not-read")).toBe(
    "The callers and tests of this code were not computed because the review was stopped, so how it is used could not be checked.",
  );
  // 2. A decision that read the head never says "not available", in any state, with or without a
  // gate, a pointer or not.
  for (const gate of [undefined, ...HeadGateStatus.options])
    for (const state of RelationsShown.options)
      for (const gitlink of [false, true]) {
        const evidence =
          gate === undefined
            ? read
            : { ...read, gate: { status: gate, wallMs: 5 } };
        expect([
          gate,
          state,
          gitlink,
          words(evidence, state, { gitlink }),
        ]).not.toEqual([gate, state, gitlink, NOT_AVAILABLE]);
      }
  // 3. A head the decision found not stored, though the gate ended stored or failed, and no head at
  // all (not stored with no gate, failed, past the bound, no decision): "not available", true here.
  expect(words(notStored("stored", 9), "not-read")).toBe(NOT_AVAILABLE);
  expect(words(notStored("failed", 40), "not-read")).toBe(NOT_AVAILABLE);
  for (const outcome of EvidenceOutcome.options.filter((o) => o !== "read"))
    expect(words({ outcome }, "not-read")).toBe(NOT_AVAILABLE);
  expect(words(undefined, "not-read")).toBe(NOT_AVAILABLE);
});

// ---------------------------------------------------------------------------------------------
// Lane rule 5 (14.34): a confirmed request for changes also makes validation hard
// ---------------------------------------------------------------------------------------------

/** `inputFor` with Assess's levels set, and the claims' IDs kept as given. */
const withLevels = (
  input: DecideInput,
  complexity: "low" | "high",
  ease: "easy" | "hard",
): DecideInput => {
  if (!input.assess.judged) throw new Error("expected a judged assessment");
  const judgement = input.assess.judgement;
  return {
    ...input,
    assess: {
      judged: true,
      judgement: {
        ...judgement,
        complexity: { ...judgement.complexity, level: complexity },
        easeOfValidation: { ...judgement.easeOfValidation, level: ease },
      },
    },
  };
};

const settledEntry = (input: DecideInput) => {
  const decision = decideSection(input);
  if (!decision.settled) throw new Error("expected a settled section");
  return decision.entry;
};

/** The two moves a request for changes resting on these confirmed claims gives (14.34, both axes). */
const verdictMoves = (cites: ReadonlyArray<string>): Array<Move> =>
  (["complexity", "ease-of-validation"] as const).map((axis) => ({
    signal: "confirmed-request-changes",
    axis,
    direction: "toward-human",
    cites,
  }));

// Reason (14.34, plant 101): a request for changes resting on Verify-confirmed claims moves both
// axes, from either source of confirmed claim: a kept finder defect, or a Lane review defect claim
// Verify confirmed. With easy validation and high complexity the section is human-required, where
// rule 4 left it human-suggested (a kept finding) or agentic (none); the moves cite the claims the
// request rests on, and the stored entry recomputes to its own lane.
test("a confirmed request for changes with easy validation and high complexity is human-required, from a finder's or a Lane review's confirmed claim", () => {
  const kept = {
    signal: "kept-finding",
    axis: "complexity",
    direction: "toward-human",
    cites: ["claim-0"],
  } as const;
  for (const [claims, review, moves] of [
    // Plant 101's shape: kept finder defects about code, Lane review requesting changes too.
    [
      [
        { source: "finder", verify: "confirmed" },
        { source: "lane-review", verify: "confirmed" },
      ],
      "request-changes",
      [kept],
    ],
    // A Lane review's defect claims alone, Verify-confirmed, no finder finding kept.
    [
      [
        { source: "lane-review", verify: "confirmed" },
        { source: "lane-review", verify: "confirmed" },
        { source: "lane-review", verify: "confirmed" },
      ],
      "request-changes",
      [],
    ],
  ] as const) {
    const input = withLevels(
      inputFor({ lane: "agentic", review, claims, moves }),
      "high",
      "easy",
    );
    const entry = settledEntry(input);
    expect(entry.verdict).toBe("request-changes");
    expect(entry.assess!.movement).toEqual([
      ...moves,
      ...verdictMoves(claims.map((_, i) => `claim-${i}`)),
    ]);
    expect(entry.restsOn).toEqual(claims.map((_, i) => `claim-${i}`));
    expect(entry.lane).toEqual({
      judged: "human-required",
      surfaced: "human-required",
      floors: [],
      applied: "human-required",
    });
    expect(recordedLane(entry, input.section.added).applied).toBe(
      "human-required",
    );
    const [unit] = composeUnits([
      { path: "a.ts", order: 0, decision: decideSection(input) },
    ]);
    expect(unit).toMatchObject({
      lane: "human-required",
      disposition: "request-changes",
    });
  }
});

// Reason (14.34, both axes; the release lane's clean-account run): a change to a test file had three
// planted bugs, the Lane review requested changes on three defect claims Verify confirmed, no finder
// finding was kept, and Assess called it low and easy; rule 4 published it human-suggested, so the
// batch counted no unit needing a person. Rule 5 raises both axes, so a confirmed request for
// changes is human-required at low complexity too: on Lane review claims alone, and with kept
// finder defects about tests (which already moved validation under rule 4, and still do).
test("a confirmed request for changes with low complexity is human-required: three Lane review claims on a test file, or kept finder defects about tests", () => {
  const testFile = (input: DecideInput): DecideInput => ({
    ...input,
    section: { ...input.section, path: "a.test.ts", declared: "test" },
  });
  const three = [
    { source: "lane-review", verify: "confirmed" },
    { source: "lane-review", verify: "confirmed" },
    { source: "lane-review", verify: "confirmed" },
  ] as const;
  for (const complexity of ["low", "high"] as const) {
    const review = settledEntry(
      testFile(
        withLevels(
          inputFor({
            lane: "agentic",
            review: "request-changes",
            claims: three,
            relations: false,
          }),
          complexity,
          "easy",
        ),
      ),
    );
    expect(review.verdict).toBe("request-changes");
    // A declared test file gets no relations gap; nothing but the moves raised it.
    expect(review.assess!.gaps).toEqual([]);
    expect(review.assess!.movement).toEqual(
      verdictMoves(["claim-0", "claim-1", "claim-2"]),
    );
    expect(review.lane).toEqual({
      judged: "human-required",
      surfaced: "human-required",
      floors: [],
      applied: "human-required",
    });
  }
  // Kept finder defects about tests: rule 4's move on validation, kept, and rule 5's two after it.
  const keptTests = (id: string) =>
    ({
      signal: "kept-finding",
      axis: "ease-of-validation",
      direction: "toward-human",
      cites: [id],
    }) as const;
  const finder = settledEntry(
    testFile(
      withLevels(
        inputFor({
          lane: "agentic",
          review: "approve",
          claims: [
            { source: "finder", verify: "confirmed" },
            { source: "finder", verify: "confirmed" },
          ],
          moves: [keptTests("claim-0"), keptTests("claim-1")],
        }),
        "low",
        "easy",
      ),
    ),
  );
  expect(finder.assess!.movement).toEqual([
    keptTests("claim-0"),
    keptTests("claim-1"),
    ...verdictMoves(["claim-0", "claim-1"]),
  ]);
  expect(finder.lane.applied).toBe("human-required");
  // Under rule 4 (the kept findings' moves alone) the same section was low and hard: suggested.
  expect(
    recordedLane(
      {
        ...finder,
        assess: {
          ...finder.assess!,
          movement: finder.assess!.movement.filter(
            (move) => move.signal === "kept-finding",
          ),
        },
      },
      [],
    ).applied,
  ).toBe("human-suggested");
});

// Reason (14.34): only a confirmed claim makes a request for changes the move rests on. A claim
// Verify refuted leaves an approval standing; one it neither confirmed nor refuted, or a request
// whose every claim was refuted, leaves the section undecided (14.4). None gives the move, and an
// approval with no claim gives none either.
test("an unconfirmed or refuted claim, and an approval, give no verdict move", () => {
  for (const [review, claims, verdict] of [
    ["approve", [{ source: "lane-review", verify: "refuted" }], "approve"],
    ["approve", [{ source: "finder", verify: "refuted" }], "approve"],
    ["approve", [{ source: "lane-review", verify: "unconfirmed" }], null],
    ["request-changes", [{ source: "lane-review", verify: "refuted" }], null],
    ["request-changes", [], null],
    ["approve", [], "approve"],
  ] as const) {
    const entry = settledEntry(
      withLevels(inputFor({ lane: "agentic", review, claims }), "high", "easy"),
    );
    expect({ review, claims, verdict: entry.verdict }).toEqual({
      review,
      claims,
      verdict,
    });
    expect(entry.assess!.movement).toEqual([]);
    // Decided and approved: rule 4's lane, high and easy with no lean, agentic. Undecided: required.
    expect(entry.lane.applied).toBe(
      entry.undecided === undefined ? "agentic" : "human-required",
    );
  }
});

// Reason (14.4): an undecided section is human-required whatever it holds, and its entry must be
// what rule 4 stored: a confirmed request beside an unconfirmed claim, or under an unsure Lane
// review, gets no verdict move.
test("an undecided section is unchanged: no verdict move, human-required", () => {
  for (const [review, claims] of [
    [
      "request-changes",
      [
        { source: "lane-review", verify: "confirmed" },
        { source: "finder", verify: "unconfirmed" },
      ],
    ],
    ["unsure", [{ source: "finder", verify: "confirmed" }]],
  ] as const) {
    const entry = settledEntry(
      withLevels(inputFor({ lane: "agentic", review, claims }), "low", "easy"),
    );
    expect(entry.verdict).toBe("request-changes");
    expect(entry.undecided).toBeDefined();
    expect(entry.assess!.movement).toEqual([]);
    expect(entry.lane).toEqual({
      judged: "agentic",
      surfaced: "agentic",
      floors: [],
      applied: "human-required",
    });
  }
});
