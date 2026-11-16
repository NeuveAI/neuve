import * as Schema from "effect/Schema";
import {
  decodeScheduledCase, fragmentCoverage, mergeRanges, ScheduledCaseSchema,
  scoreSupport, sourceKey, type ByteRange,
} from "./support-metrics";

const Id = Schema.NonEmptyString;
const Byte = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
const Source = Schema.Struct({ sourceId: Id,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  revision: Id, utf8Bytes: Byte });
const Range = Schema.Struct({ source: Source, start: Byte, end: Byte });
const RoleLabel = Schema.Union([
  Schema.Struct({ range: Range,
    kind: Schema.Literals(["NECESSARY_SUPPORT", "CONTEXT"]), certification: Id }),
  Schema.Struct({ range: Range, kind: Schema.Literal("UNKNOWN"), reason: Id }),
]);
const Necessity = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("CERTIFIED"), evidence: Id }),
  Schema.Struct({ kind: Schema.Literal("UNKNOWN"), reason: Id }),
]);
const Witnesses = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("UNKNOWN"), reason: Id }),
  Schema.Struct({ kind: Schema.Literal("CERTIFIED"), evidence: Id,
    atoms: Schema.Array(Schema.Struct({ atomId: Id,
      fragmentEnvelopes: Schema.NonEmptyArray(Range), necessity: Necessity })),
    alternatives: Schema.Array(Schema.Struct({
      alternativeId: Id, atomIds: Schema.NonEmptyArray(Id) })),
  }),
]);
export const SemanticBoundarySchema = Schema.Struct({
  taskId: Id, familyId: Id,
  permission: ScheduledCaseSchema.fields.permission,
  qualifications: ScheduledCaseSchema.fields.qualifications,
  witnesses: Witnesses, roleLabels: Schema.Array(RoleLabel),
  carriers: Schema.Array(Schema.Struct({
    carrierId: Id, path: Id, fragments: Schema.NonEmptyArray(Range),
  })),
});
export type SemanticBoundary = typeof SemanticBoundarySchema.Type;
export type SemanticRole = typeof RoleLabel.Type["kind"];
export type RolePiece = {
  range: ByteRange; role: SemanticRole; observedRoles: readonly SemanticRole[];
  conflict: boolean;
};

function fail(message: string): never { throw new Error(message); }
function unique(ids: readonly string[], label: string): void {
  if (new Set(ids).size !== ids.length) fail("Duplicate " + label + ".");
}
function rangeKey(range: ByteRange): string {
  return JSON.stringify([sourceKey(range.source), range.start, range.end]);
}
function validatePath(path: string): void {
  if (path.startsWith("/") || path.includes("\\") || path.includes(":") ||
    /[\u0000-\u001f\u007f]/u.test(path) ||
    path.split("/").some((part) => part === "" || part === "." || part === ".."))
    fail("Carrier path must be a normalized relative artifact path.");
}
export function decodeSemanticBoundary(raw: unknown): SemanticBoundary {
  const input = Schema.decodeUnknownSync(SemanticBoundarySchema,
    { onExcessProperty: "error" })(raw);
  unique(input.carriers.map((carrier) => carrier.carrierId), "carrier");
  for (const carrier of input.carriers) {
    validatePath(carrier.path);
    unique(carrier.fragments.map(rangeKey), "carrier fragment");
  }
  unique(input.roleLabels.map((label) => JSON.stringify([rangeKey(label.range), label.kind])),
    "role label");
  const envelopes = input.witnesses.kind === "CERTIFIED"
    ? input.witnesses.atoms.flatMap((atom) => atom.fragmentEnvelopes) : [];
  const carrierRanges = input.carriers.flatMap((carrier) => carrier.fragments);
  decodeScheduledCase({
    taskId: input.taskId, familyId: input.familyId, permission: input.permission,
    qualifications: input.qualifications, support: { kind: "UNKNOWN", reason: "Boundary validation only." },
    supplied: [...carrierRanges, ...envelopes, ...input.roleLabels.map((label) => label.range)],
    labels: [],
  });
  if (input.witnesses.kind === "CERTIFIED") {
    unique(input.witnesses.atoms.map((atom) => atom.atomId), "atom");
    unique(input.witnesses.alternatives.map((alternative) => alternative.alternativeId),
      "alternative");
    const atomIds = new Set(input.witnesses.atoms.map((atom) => atom.atomId));
    for (const atom of input.witnesses.atoms)
      unique(atom.fragmentEnvelopes.map(rangeKey), "atom fragment");
    for (const alternative of input.witnesses.alternatives) {
      unique(alternative.atomIds, "alternative atom");
      if (alternative.atomIds.some((id) => !atomIds.has(id)))
        fail("Alternative names an undeclared atom.");
    }
  }
  for (const label of input.roleLabels) {
    if (fragmentCoverage(label.range, [...envelopes, ...carrierRanges]) !== "COMPLETE")
      fail("Role label is outside the declared fragment envelopes.");
    if (label.kind === "NECESSARY_SUPPORT" &&
      fragmentCoverage(label.range, envelopes) !== "COMPLETE")
      fail("Necessary support role needs an explicit witness fragment envelope.");
  }
  return input;
}

export function intersectRanges(left: readonly ByteRange[], right: readonly ByteRange[]) {
  const a = mergeRanges(left), b = mergeRanges(right);
  mergeRanges([...a, ...b]);
  return mergeRanges(a.flatMap((first) => b.flatMap((second) => {
    if (sourceKey(first.source) !== sourceKey(second.source)) return [];
    const start = Math.max(first.start, second.start), end = Math.min(first.end, second.end);
    return start < end ? [{ source: first.source, start, end }] : [];
  })));
}
function rolePieces(ranges: readonly ByteRange[], labels: SemanticBoundary["roleLabels"]): RolePiece[] {
  return mergeRanges(ranges).flatMap((range) => {
    const same = labels.filter((label) =>
      sourceKey(label.range.source) === sourceKey(range.source) &&
      label.range.start < range.end && range.start < label.range.end);
    const bounds = [...new Set([range.start, range.end, ...same.flatMap((label) => [
      Math.max(range.start, label.range.start), Math.min(range.end, label.range.end),
    ])])].sort((a, b) => a - b);
    const pieces: RolePiece[] = [];
    for (let i = 1; i < bounds.length; i++) {
      const start = bounds[i - 1], end = bounds[i];
      if (start === undefined || end === undefined) fail("Missing interval boundary.");
      const observedRoles = [...new Set(same.filter((label) =>
        label.range.start < end && start < label.range.end).map((label) => label.kind))].sort();
      const first = observedRoles[0];
      pieces.push({ range: { source: range.source, start, end },
        role: observedRoles.length === 1 && first !== undefined ? first : "UNKNOWN",
        observedRoles, conflict: observedRoles.length > 1 });
    }
    return pieces;
  });
}
function countBytes(pieces: readonly RolePiece[]) {
  const count = (role: SemanticRole) => pieces.filter((piece) => piece.role === role)
    .reduce((sum, piece) => sum + (piece.range.end - piece.range.start), 0);
  const supportBytes = count("NECESSARY_SUPPORT"), contextBytes = count("CONTEXT"),
    unknownBytes = count("UNKNOWN");
  const totalBytes = supportBytes + contextBytes + unknownBytes;
  if (!Number.isSafeInteger(totalBytes)) fail("Byte total exceeds safe integer capacity.");
  return { totalBytes, supportBytes, contextBytes, unknownBytes,
    conflictBytes: pieces.filter((piece) => piece.conflict)
      .reduce((sum, piece) => sum + (piece.range.end - piece.range.start), 0) };
}
export function evaluateSemanticBoundary(raw: unknown) {
  const input = decodeSemanticBoundary(raw);
  const carriers = input.carriers.map((carrier) => {
    const pieces = rolePieces(carrier.fragments, input.roleLabels);
    return { carrierId: carrier.carrierId, path: carrier.path, pieces, ...countBytes(pieces) };
  });
  const suppliedPieces = rolePieces(
    input.carriers.flatMap((carrier) => carrier.fragments), input.roleLabels);
  const suppliedSupport = suppliedPieces.filter((piece) =>
    piece.role === "NECESSARY_SUPPORT").map((piece) => piece.range);
  const atoms = input.witnesses.kind === "CERTIFIED"
    ? input.witnesses.atoms.map((atom) => {
      const pieces = rolePieces(atom.fragmentEnvelopes, input.roleLabels);
      const requiredFragments = mergeRanges(pieces.filter((piece) =>
        piece.role === "NECESSARY_SUPPORT").map((piece) => piece.range));
      return { atomId: atom.atomId, necessity: atom.necessity,
        requiredFragments, roleKnown: requiredFragments.length > 0 &&
          pieces.every((piece) => piece.role !== "UNKNOWN"), pieces };
    }) : [];
  const alternatives = input.witnesses.kind === "CERTIFIED"
    ? input.witnesses.alternatives.map((alternative) => {
      const members = alternative.atomIds.map((id) =>
        atoms.find((atom) => atom.atomId === id) ?? fail("Validated atom missing."));
      const roleKnown = members.every((atom) => atom.roleKnown);
      const requiredUnion = mergeRanges(members.flatMap((atom) => atom.requiredFragments));
      return { alternativeId: alternative.alternativeId, atomIds: alternative.atomIds,
        roleKnown, requiredUnion };
    }) : [];
  const resolved = alternatives.filter((alternative) => alternative.roleKnown);
  const resolvedAtomIds = new Set(resolved.flatMap((alternative) => alternative.atomIds));
  const adapted = decodeScheduledCase({
    taskId: input.taskId, familyId: input.familyId,
    permission: input.permission, qualifications: input.qualifications,
    supplied: suppliedSupport, labels: [],
    support: input.witnesses.kind === "CERTIFIED" && resolved.length > 0
      ? { kind: "CERTIFIED", evidence: input.witnesses.evidence,
        atoms: atoms.filter((atom) => resolvedAtomIds.has(atom.atomId)).map((atom) => ({
          atomId: atom.atomId, necessity: atom.necessity,
          requiredFragments: atom.requiredFragments,
        })),
        alternatives: resolved.map((alternative) => ({
          alternativeId: alternative.alternativeId, atomIds: alternative.atomIds,
        })),
      } : { kind: "UNKNOWN", reason: "No role-resolved certified sufficient alternative." },
  });
  const evaluator = scoreSupport(adapted);
  const unresolvedAlternativeIds = alternatives.filter((alternative) =>
    !alternative.roleKnown).map((alternative) => alternative.alternativeId);
  const completeRequiredSupport = evaluator.completeRequiredSupport === true ? true :
    unresolvedAlternativeIds.length > 0 ? null : evaluator.completeRequiredSupport;
  const requiredUnion = mergeRanges(alternatives.flatMap((alternative) => alternative.requiredUnion));
  const first = alternatives[0];
  const intersection = first ? alternatives.slice(1).reduce((shared, alternative) =>
    intersectRanges(shared, alternative.requiredUnion), first.requiredUnion) : [];
  return {
    taskId: input.taskId, familyId: input.familyId, carriers, atoms, alternatives,
    globalSupplied: { pieces: suppliedPieces, ...countBytes(suppliedPieces) },
    unresolvedAlternativeIds, completeRequiredSupport, evaluator, adapted,
    alternativeRequiredUnion: requiredUnion,
    sharedAlternativeIntersection: {
      kind: alternatives.length > 0 && unresolvedAlternativeIds.length === 0 ? "KNOWN" : "UNKNOWN",
      ranges: alternatives.length > 0 && unresolvedAlternativeIds.length === 0 ? intersection : [],
    },
    certificationAuthority: "External certificates and source bodies are not authenticated by this pure boundary.",
  };
}

