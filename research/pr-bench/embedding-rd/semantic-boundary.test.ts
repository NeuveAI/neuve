import { expect, test } from "bun:test";
import {
  decodeSemanticBoundary, evaluateSemanticBoundary, intersectRanges,
} from "./semantic-boundary";
import { scoreSupport, type ByteRange } from "./support-metrics";

const source = { sourceId: "synthetic-source", sha256: "a".repeat(64),
  revision: "synthetic-revision", utf8Bytes: 100 };
const range = (start: number, end: number): ByteRange => ({ source, start, end });
const support = (start: number, end: number) => ({
  range: range(start, end), kind: "NECESSARY_SUPPORT", certification: "synthetic-role",
});
const context = (start: number, end: number) => ({
  range: range(start, end), kind: "CONTEXT", certification: "synthetic-context",
});
const unknown = (start: number, end: number) => ({
  range: range(start, end), kind: "UNKNOWN", reason: "synthetic-unresolved-role",
});
const fixture = () => ({
  taskId: "synthetic-task", familyId: "synthetic-family",
  permission: { kind: "CERTIFIED", sourcePin: "b".repeat(64), permittedSources: [source] },
  qualifications: [{ source, kind: "QUALIFIED", evidence: "synthetic-qualification" }],
  witnesses: { kind: "CERTIFIED", evidence: "synthetic-set-certificate",
    atoms: [
      { atomId: "a", fragmentEnvelopes: [range(0, 10)],
        necessity: { kind: "UNKNOWN", reason: "Membership does not certify global necessity." } },
      { atomId: "b", fragmentEnvelopes: [range(20, 30)],
        necessity: { kind: "UNKNOWN", reason: "Membership does not certify global necessity." } },
      { atomId: "c", fragmentEnvelopes: [range(0, 10), range(40, 50)],
        necessity: { kind: "UNKNOWN", reason: "Membership does not certify global necessity." } },
    ],
    alternatives: [{ alternativeId: "a-and-b", atomIds: ["a", "b"] },
      { alternativeId: "or-c", atomIds: ["c"] }],
  },
  roleLabels: [support(0, 4), context(4, 10), support(20, 25), context(25, 30),
    support(40, 45), context(45, 50)],
  carriers: [{ carrierId: "carrier", path: "synthetic/artifact.md", fragments: [range(0, 4)] }],
});

test("explicit support is required, envelope context is not required", () => {
  const data = fixture();
  const result = evaluateSemanticBoundary({ ...data,
    carriers: [{ ...data.carriers[0], fragments: [range(0, 4), range(20, 25)] }] });
  expect(result.completeRequiredSupport).toBe(true);
  expect(result.adapted.support.kind).toBe("CERTIFIED");
  expect(result.atoms[0]?.requiredFragments).toEqual([range(0, 4)]);
  expect(result.globalSupplied).toMatchObject({
    totalBytes: 9, supportBytes: 9, contextBytes: 0, unknownBytes: 0,
  });
  expect(result.atoms[0]?.necessity.kind).toBe("UNKNOWN");
});

test("partial atom and AND membership cannot fulfill complete support", () => {
  const data = fixture();
  expect(evaluateSemanticBoundary(data).completeRequiredSupport).toBe(false);
  expect(evaluateSemanticBoundary({ ...data,
    carriers: [{ ...data.carriers[0], fragments: [range(0, 2), range(20, 25)] }] })
    .completeRequiredSupport).toBe(false);
});

test("second alternative and union of adjacent pieces fulfill OR-of-AND", () => {
  const data = fixture();
  const result = evaluateSemanticBoundary({ ...data,
    carriers: [{ ...data.carriers[0], fragments: [range(0, 2), range(2, 4), range(40, 45)] }] });
  expect(result.completeRequiredSupport).toBe(true);
  expect(result.alternativeRequiredUnion).toEqual([
    range(0, 4), range(20, 25), range(40, 45),
  ]);
  expect(result.sharedAlternativeIntersection).toEqual({ kind: "KNOWN", ranges: [range(0, 4)] });
});

test("missing labels remain UNKNOWN without manufacturing support", () => {
  const data = fixture();
  const result = evaluateSemanticBoundary({ ...data, roleLabels: [],
    carriers: [{ ...data.carriers[0], fragments: [range(0, 100)] }] });
  expect(result.completeRequiredSupport).toBeNull();
  expect(result.unresolvedAlternativeIds).toEqual(["a-and-b", "or-c"]);
  expect(result.globalSupplied).toMatchObject({
    totalBytes: 100, supportBytes: 0, contextBytes: 0, unknownBytes: 100,
  });
  expect(result.sharedAlternativeIntersection.kind).toBe("UNKNOWN");
});

test("carrier presence and incidental context do not fulfill support", () => {
  const data = fixture();
  const result = evaluateSemanticBoundary({ ...data,
    carriers: [{ ...data.carriers[0], fragments: [range(4, 10), range(25, 30)] }] });
  expect(result.completeRequiredSupport).toBe(false);
  expect(result.globalSupplied.supportBytes).toBe(0);
  expect(result.globalSupplied.contextBytes).toBe(11);
});

test("mixed carrier partition is disjoint and overlaps count once globally", () => {
  const data = fixture();
  const result = evaluateSemanticBoundary({ ...data,
    carriers: [{ carrierId: "one", path: "one.md", fragments: [range(0, 15), range(5, 20)] },
      { carrierId: "two", path: "two.md", fragments: [range(0, 20)] }],
  });
  expect(result.carriers[0]).toMatchObject({
    totalBytes: 20, supportBytes: 4, contextBytes: 6, unknownBytes: 10,
  });
  expect(result.carriers[1]).toMatchObject({
    totalBytes: 20, supportBytes: 4, contextBytes: 6, unknownBytes: 10,
  });
  expect(result.globalSupplied).toMatchObject({
    totalBytes: 20, supportBytes: 4, contextBytes: 6, unknownBytes: 10,
  });
});

test("conflicting support/context roles are UNKNOWN and conserve bytes", () => {
  const data = fixture();
  const result = evaluateSemanticBoundary({ ...data, roleLabels: [
    ...data.roleLabels, context(2, 4),
  ], carriers: [{ ...data.carriers[0], fragments: [range(0, 10)] }] });
  expect(result.globalSupplied).toMatchObject({
    totalBytes: 10, supportBytes: 2, contextBytes: 6, unknownBytes: 2, conflictBytes: 2,
  });
  expect(result.completeRequiredSupport).toBeNull();
  expect(result.globalSupplied.pieces.find((piece) => piece.conflict)?.observedRoles)
    .toEqual(["CONTEXT", "NECESSARY_SUPPORT"]);
});

test("explicit UNKNOWN overlap is not resolved by support label priority", () => {
  const data = fixture();
  const result = evaluateSemanticBoundary({ ...data, roleLabels: [
    ...data.roleLabels, unknown(0, 4),
  ] });
  expect(result.globalSupplied.supportBytes).toBe(0);
  expect(result.globalSupplied.unknownBytes).toBe(4);
  expect(result.completeRequiredSupport).toBeNull();
});

test("one resolved fulfilled alternative can witness OR despite another unknown route", () => {
  const data = fixture();
  const result = evaluateSemanticBoundary({ ...data,
    roleLabels: data.roleLabels.filter((label) => label.range.start < 40),
    carriers: [{ ...data.carriers[0], fragments: [range(0, 4), range(20, 25)] }] });
  expect(result.completeRequiredSupport).toBe(true);
  expect(result.unresolvedAlternativeIds).toEqual(["or-c"]);
  expect(result.sharedAlternativeIntersection.kind).toBe("UNKNOWN");
});

test("qualification remains independent from exact role coverage", () => {
  const data = fixture();
  const result = evaluateSemanticBoundary({ ...data,
    qualifications: [{ source, kind: "UNKNOWN", evidence: "synthetic-unqualified" }],
    carriers: [{ ...data.carriers[0], fragments: [range(0, 4), range(20, 25)] }] });
  expect(result.completeRequiredSupport).toBeNull();
  expect(result.evaluator.atoms.every((atom) => atom.coverage === "COMPLETE")).toBe(false);
  expect(result.evaluator.alternatives[0]?.coverage).toBe("COMPLETE");
});

test("permission remains externally supplied", () => {
  const data = fixture();
  expect(evaluateSemanticBoundary({ ...data,
    permission: { kind: "UNKNOWN", reason: "No candidate permission certificate." },
    carriers: [{ ...data.carriers[0], fragments: [range(0, 4), range(20, 25)] }],
  }).completeRequiredSupport).toBeNull();
});

test("exact evaluator adapter parity", () => {
  const result = evaluateSemanticBoundary(fixture());
  expect(result.evaluator).toEqual(scoreSupport(result.adapted));
});

test("source revision and hash mismatches cannot cover witnesses", () => {
  const data = fixture();
  for (const otherSource of [{ ...source, revision: "other" },
    { ...source, sha256: "d".repeat(64) }]) {
    const result = evaluateSemanticBoundary({ ...data,
      carriers: [{ ...data.carriers[0], fragments: [{ source: otherSource, start: 0, end: 100 }] }] });
    expect(result.completeRequiredSupport).toBe(false);
    expect(result.globalSupplied.unknownBytes).toBe(100);
  }
});

test("intersection is literal source-byte intersection and total on empty sets", () => {
  expect(intersectRanges([range(0, 8), range(20, 30)], [range(4, 25)]))
    .toEqual([range(4, 8), range(20, 25)]);
  expect(intersectRanges([], [range(0, 5)])).toEqual([]);
  expect(intersectRanges([range(0, 5)], [{ source: { ...source, revision: "other" },
    start: 0, end: 5 }])).toEqual([]);
});

test("empty alternatives and all-context atoms never succeed", () => {
  const data = fixture();
  expect(evaluateSemanticBoundary({ ...data,
    witnesses: { ...data.witnesses, alternatives: [] },
  }).completeRequiredSupport).toBeNull();
  expect(evaluateSemanticBoundary({ ...data,
    roleLabels: [context(0, 10), context(20, 30), context(40, 50)],
  }).completeRequiredSupport).toBeNull();
});

test("hostile recursive scalars, bounds, hashes and excess properties reject", () => {
  const data = fixture();
  for (const invalid of [
    { ...range(0, 5), start: "0" }, range(-1, 5), range(0.5, 5), range(0, 101),
    range(5, 5), range(6, 5), range(NaN, 5), range(0, Infinity),
    { ...range(0, 5), source: { ...source, sha256: "short" } },
    { ...range(0, 5), source: { ...source, utf8Bytes: true } },
    { ...range(0, 5), extra: true },
    { ...range(0, 5), source: { ...source, extra: true } },
  ]) expect(() => decodeSemanticBoundary({ ...data,
    carriers: [{ ...data.carriers[0], fragments: [invalid] }] })).toThrow();
});

test("hostile artifact paths reject", () => {
  const data = fixture();
  for (const path of ["", "/absolute", "../escape", "a/../b", "./a", "a//b",
    "C:/drive", "https://host", "a\\b", "a\u0000b", "a/"])
    expect(() => decodeSemanticBoundary({ ...data,
      carriers: [{ ...data.carriers[0], path }] })).toThrow();
});

test("nested duplicates and unknown atom membership reject", () => {
  const data = fixture(), atom = data.witnesses.atoms[0], carrier = data.carriers[0],
    label = data.roleLabels[0];
  if (!atom || !carrier || !label) throw new Error("Synthetic fixture member absent.");
  for (const invalid of [
    { ...data, carriers: [carrier, carrier] },
    { ...data, carriers: [{ ...carrier, fragments: [range(0, 4), range(0, 4)] }] },
    { ...data, roleLabels: [label, label] },
    { ...data, witnesses: { ...data.witnesses, atoms: [atom, atom] } },
    { ...data, witnesses: { ...data.witnesses, atoms: [
      { ...atom, fragmentEnvelopes: [range(0, 10), range(0, 10)] }] } },
    { ...data, witnesses: { ...data.witnesses, alternatives: [
      { alternativeId: "unknown", atomIds: ["missing"] }] } },
    { ...data, witnesses: { ...data.witnesses, alternatives: [
      { alternativeId: "duplicate", atomIds: ["a", "a"] }] } },
    { ...data, witnesses: { ...data.witnesses, alternatives: [
      { alternativeId: "empty", atomIds: [] }] } },
  ]) expect(() => decodeSemanticBoundary(invalid)).toThrow();
});

test("role labels require declared range scope and certificate", () => {
  const data = fixture();
  expect(() => decodeSemanticBoundary({ ...data,
    roleLabels: [support(90, 100)] })).toThrow();
  expect(() => decodeSemanticBoundary({ ...data,
    roleLabels: [{ range: range(0, 4), kind: "NECESSARY_SUPPORT" }] })).toThrow();
});

test("zero-length metadata contradictions reject across nested source axes", () => {
  const data = fixture();
  expect(() => decodeSemanticBoundary({ ...data, qualifications: [
    { source: { ...source, utf8Bytes: 0 }, kind: "QUALIFIED", evidence: "invalid" }],
  })).toThrow();
});



test("near-MAX offsets preserve three one-byte support and conflict totals", () => {
  const max = Number.MAX_SAFE_INTEGER;
  const wideSource = { ...source, utf8Bytes: max };
  const fragments = [
    { source: wideSource, start: 0, end: 1 },
    { source: wideSource, start: 2, end: 3 },
    { source: wideSource, start: max - 1, end: max },
  ];
  const input = {
    ...fixture(),
    permission: {
      kind: "CERTIFIED", sourcePin: "b".repeat(64), permittedSources: [wideSource],
    },
    qualifications: [{ source: wideSource, kind: "QUALIFIED", evidence: "synthetic-wide-source" }],
    witnesses: {
      kind: "CERTIFIED", evidence: "synthetic-wide-set",
      atoms: [{
        atomId: "wide", fragmentEnvelopes: fragments,
        necessity: { kind: "UNKNOWN", reason: "Synthetic membership does not certify necessity." },
      }],
      alternatives: [{ alternativeId: "wide-route", atomIds: ["wide"] }],
    },
    roleLabels: fragments.map((range) => ({
      range, kind: "NECESSARY_SUPPORT", certification: "synthetic-wide-role",
    })),
    carriers: [{ carrierId: "wide-carrier", path: "synthetic/wide.md", fragments }],
  };
  const result = evaluateSemanticBoundary(input);
  expect(result.globalSupplied.supportBytes).toBe(3);
  expect(result.globalSupplied.totalBytes).toBe(3);
  const conflict = evaluateSemanticBoundary({
    ...input,
    roleLabels: [
      ...input.roleLabels,
      ...fragments.map((range) => ({ range, kind: "CONTEXT", certification: "synthetic-context" })),
    ],
  });
  expect(conflict.globalSupplied.unknownBytes).toBe(3);
  expect(conflict.globalSupplied.conflictBytes).toBe(3);
  expect(conflict.globalSupplied.totalBytes).toBe(3);
});
