import { Checkpoints, Proofs } from "@neuve/records-core";
// Why: these are Assemble's hard rules, where a mistake is silent downstream. A unit placed in a
// lane where an agent's approval closes it while cited evidence says a person must decide (10.9),
// static automation without every requirement solid (10.82), a requirement shown solid on one kind
// of proof or on stale proof (11.1, 11.10), a group's cited work thrown away because one sibling's
// citation failed, ownership that the review rules did not give (10.21), or a changed line owned by
// two units or none after a re-split or an adjustment would each pass as a reviewed packet; nothing
// later fails. The advice that is returned once (§8.4) is a loop rule no other test reaches.
import { expect, test } from "bun:test";
import { laneOf, type ProofEntry } from "../src/compose.ts";
import {
  codeFilledBatch,
  placeFindings,
  groupDigest,
  DIGEST_CHARS,
} from "../src/link.ts";
import { anchorResolves } from "../src/disposition.ts";
import { FindStored } from "../src/find.ts";
import { frame, mapOf, inputsOf, hunk } from "./fixtures/link.ts";

const cited = [{ cites: ["p1.e1"] }];
const requirement = (coverage: "missing" | "shallow" | "solid") => ({
  requirement: "the old link is refused",
  cites: ["b1.o1"],
  coverage,
});

test("a gap never lowers cited high and hard work, and sends other work to human-suggested", () => {
  const highHard = {
    complexity: { level: "high" as const, factors: cited },
    validation: {
      level: "hard" as const,
      requirements: [requirement("missing")],
    },
    lean: null,
    gaps: [{ axis: "ease-of-validation" as const }],
  };
  expect(laneOf(highHard).lane).toBe("human-required");
  expect(laneOf(highHard).highComplexityValidationGap).toBe(false);
  // Uncited validation: the gap applies (4.4), and this is 10.55's case.
  const uncited = {
    ...highHard,
    validation: {
      ...highHard.validation,
      requirements: [{ ...requirement("missing"), cites: [] }],
    },
  };
  expect(laneOf(uncited)).toMatchObject({
    lane: "human-suggested",
    highComplexityValidationGap: true,
  });
  // High and easy with a validation gap: 10.55's case too.
  const highEasy = {
    ...highHard,
    validation: { ...highHard.validation, level: "easy" as const },
  };
  expect(laneOf(highEasy)).toMatchObject({
    lane: "human-suggested",
    highComplexityValidationGap: true,
  });
  // A complexity gap on low and easy work, even all solid, goes to human-suggested, not 10.55's case.
  const lowEasy = {
    complexity: { level: "low" as const, factors: cited },
    validation: {
      level: "easy" as const,
      requirements: [requirement("solid")],
    },
    lean: null,
    gaps: [{ axis: "complexity" as const }],
  };
  expect(laneOf(lowEasy)).toMatchObject({
    lane: "human-suggested",
    highComplexityValidationGap: false,
  });
});

test("low and easy reaches static automation only when every requirement is solid (10.82); the lean decides high and easy", () => {
  const base = {
    complexity: { level: "low" as const, factors: cited },
    lean: null,
    gaps: [],
  };
  const allSolid = laneOf({
    ...base,
    validation: {
      level: "easy",
      requirements: [
        requirement("solid"),
        { ...requirement("solid"), requirement: "logs show it" },
      ],
    },
  });
  expect(allSolid.lane).toBe("static-automation");
  const oneShallow = laneOf({
    ...base,
    validation: {
      level: "easy",
      requirements: [
        requirement("solid"),
        { ...requirement("shallow"), requirement: "logs show it" },
      ],
    },
  });
  expect(oneShallow.lane).toBe("agentic");
  expect(oneShallow.note).toContain('"logs show it" is shallow');
  // No requirement at all is not every requirement solid.
  expect(
    laneOf({ ...base, validation: { level: "easy", requirements: [] } }).lane,
  ).toBe("agentic");
  expect(
    laneOf({ ...base, validation: { level: "hard", requirements: [] } }).lane,
  ).toBe("human-suggested");
  const high = {
    ...base,
    complexity: { level: "high" as const, factors: cited },
    validation: { level: "easy" as const, requirements: [] },
  };
  expect(laneOf(high).lane).toBe("agentic");
  expect(
    laneOf({ ...high, lean: { lane: "human-suggested", reason: "security" } })
      .lane,
  ).toBe("human-suggested");
  expect(
    laneOf({ ...high, validation: { level: "hard", requirements: [] } }).lane,
  ).toBe("human-required");
});

const proof = (
  id: string,
  kind: ProofEntry["kind"],
  currency: string,
): ProofEntry => ({
  id,
  kind,
  revision: "c".repeat(40),
  recorder: "agent",
  requirement: "r",
  claim: "c",
  listing: "",
  currency: { "b1.u1": currency },
});

test("coverage is solid only when two or more current kinds agree and none it rests on is stale", () => {
  const proofs = new Map(
    [
      proof("T", "test-run", "current"),
      proof("S", "static-analysis", "current"),
      proof(
        "X",
        "static-analysis",
        "stale: 1 owned file(s) changed after it (a.ts)",
      ),
    ].map((entry) => [entry.id, entry]),
  );
  const named = (
    ids: Array<string>,
    agree = true,
    kinds: Array<ProofEntry["kind"]> = ["test-run", "static-analysis"],
  ) =>
    Checkpoints.coverageOfState(
      Checkpoints.proofState({
        records: ids.flatMap((id) => {
          const proof = proofs.get(id);
          return proof === undefined
            ? []
            : [
                {
                  kind: proof.kind,
                  currency: Proofs.currencyFromDescription(
                    proof.currency["b1.u1"],
                  ),
                },
              ];
        }),
        applicable: { kinds, agree, testable: true },
        sources: [],
        named: ids.length > 0,
      }).state,
    );
  expect(named([])).toBe("missing");
  expect(named(["T", "S"])).toBe("solid");
  expect(named(["T"])).toBe("shallow");
  expect(named(["T"], true, ["test-run"])).toBe("shallow");
  expect(named(["T", "S"], false)).toBe("shallow");
  expect(named(["T", "X"])).toBe("shallow");
  expect(named(["X"])).toBe("shallow");
  // Two current kinds agree, but one record it rests on is stale: not all current (10.82).
  expect(named(["T", "S", "X"])).toBe("shallow");
  // A kind the agent says applies but nobody recorded keeps it shallow.
  expect(named(["T", "S"], true, ["test-run", "static-analysis", "log"])).toBe(
    "shallow",
  );
});

// Why (11.16): the state the lanes and the reader start from is set by the shared rule, and a pinned
// source that changed or couldn't be checked must make the checkpoint Out of date, never Proven.
test("each requirement's proof state follows the shared rule, and a pinned source not current makes it out of date", () => {
  const proofs = new Map(
    [
      proof("T", "test-run", "current"),
      proof("S", "static-analysis", "current"),
    ].map((entry) => [entry.id, entry]),
  );
  const state = (
    ids: Array<string>,
    sources: Array<"current" | "changed" | "unchecked" | "unknown"> = [],
  ) =>
    Checkpoints.proofState({
      records: ids.flatMap((id) => {
        const proof = proofs.get(id);
        return proof === undefined
          ? []
          : [
              {
                kind: proof.kind,
                currency: Proofs.currencyFromDescription(
                  proof.currency["b1.u1"],
                ),
              },
            ];
      }),
      applicable: {
        kinds: ["test-run", "static-analysis"],
        agree: true,
        testable: true,
      },
      sources,
      named: ids.length > 0,
    });
  expect(state(["T", "S"]).state).toBe("proven");
  expect(state(["T", "S"], ["current"]).state).toBe("proven");
  for (const status of ["changed", "unchecked", "unknown"] as const) {
    const read = state(["T", "S"], [status]);
    expect(read.state).toBe("out-of-date");
    expect(Checkpoints.coverageOfState(read.state)).toBe("shallow");
  }
  expect(Checkpoints.stateNote(state([]))).toBe(
    "Nothing names what proves it.",
  );
  expect(state(["T"]).state).toBe("thin");
});

// Why (11.17): an anchor placed on a line the unit doesn't own, or a requirement that reaches no
// owned line shown on some other line, puts the checkpoint where it isn't met; the desk only
// displays what Assemble anchors, so nothing later corrects it.

// Code fill is unassessed even when a hunk's ownership is non-text or empty.
test("code fill preserves proximity, old-side and non-text ownership with no model credit", () => {
  const inputs = inputsOf([
    hunk("h1", "a.ts"),
    hunk("h2", "a.ts", 300),
    hunk("h3", "gone.ts", 10, {
      added: 0,
      deleted: 1,
      ownedRanges: [{ side: "old", startLine: 11, lineCount: 1 }],
    }),
    hunk("h4", "image.png", 0, {
      kind: "binary",
      ownedRanges: [],
      qualifications: [{ kind: "binary", detail: "binary file" }],
    }),
    hunk("h5", "context.ts", 10, { ownedRanges: [] }),
  ]);
  const output = codeFilledBatch(inputs);
  expect(output.units).toHaveLength(5);
  expect(
    output.units.filter((unit) => unit.path === "a.ts").map((unit) => unit.id),
  ).toEqual(["g1.u1", "g1.u2"]);
  expect(
    output.units.find((unit) => unit.path === "image.png")?.ownedRanges,
  ).toEqual([
    { kind: "whole-nontext", hunkId: "h4", path: "image.png", side: "new" },
  ]);
  expect(
    output.units.find((unit) => unit.path === "context.ts")?.ownedRanges,
  ).toEqual([]);
  expect(
    output.units.every(
      (unit) =>
        unit.assessment.status === "not-assessed" &&
        unit.content.source === "code",
    ),
  ).toBe(true);
  expect(output.turns).toMatchObject({
    confirm: 0,
    groups: 0,
    digests: 0,
    overrun: false,
  });
  const gone = output.units.find((unit) => unit.path === "gone.ts")!;
  expect(
    anchorResolves(
      { path: "gone.ts", side: "old", startLine: 11, endLine: 11 },
      { unit: gone, references: [] },
    ),
  ).toBe(true);
  expect(
    anchorResolves(
      { path: "gone.ts", side: "new", startLine: 11, endLine: 11 },
      { unit: gone, references: [] },
    ),
  ).toBe(false);
});

test("an unanchored finding becomes a gap, and capped digests retain whole unit links", () => {
  const inputs = inputsOf([hunk("h1", "a.ts")]);
  const assembled = codeFilledBatch(inputs),
    unit = assembled.units[0]!;
  const finding = FindStored.shape.findings.element.parse({
    id: "f1",
    lens: "correctness",
    hunkId: "h1",
    claim: "A ".repeat(140),
    kind: "defect",
    about: "code",
    signal: null,
    critical: false,
    anchors: [{ path: "a.ts", side: "new", startLine: 11, endLine: 11 }],
    doneWhen: "D1",
    group: "g1",
    evidence: [],
  });
  const unanchored = placeFindings(assembled.units, [
    {
      ...finding,
      anchors: [
        { path: "outside.ts", side: "new", startLine: 11, endLine: 11 },
      ],
    },
  ]);
  expect(unanchored.placed.size).toBe(0);
  expect(unanchored.disclosures.map((gap) => gap.kind)).toEqual([
    "finding-unanchored",
  ]);
  const group = mapOf(inputs.manifest.hunks).groups[0]!;
  const digest = groupDigest(
    frame,
    group,
    assembled.units,
    new Map([[unit.id, Array.from({ length: 20 }, () => finding)]]),
    [
      {
        doneWhen: "D1",
        verdict: "needs-human",
        anchors: [],
        note: "Human evidence is needed.",
      },
    ],
    [],
  );
  expect(digest.digest.length).toBeLessThanOrEqual(DIGEST_CHARS);
  expect(digest.digest).toEndWith("](" + unit.id + ")");
  expect(digest.verification).toContain(
    "[A revoked link is refused](D1): needs-human",
  );
  expect(digest.limitations.join(" ")).toContain("beyond this digest's limit");
});
