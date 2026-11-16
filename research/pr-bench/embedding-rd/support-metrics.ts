import * as Schema from "effect/Schema";

const Id = Schema.NonEmptyString;
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Byte = Schema.Number.check(
  Schema.isInt(), Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const Source = Schema.Struct({
  sourceId: Id, sha256: Digest, revision: Id, utf8Bytes: Byte,
});
const Range = Schema.Struct({ source: Source, start: Byte, end: Byte });
const Qualification = Schema.Struct({
  source: Source,
  kind: Schema.Literals(["QUALIFIED", "UNKNOWN", "EXCLUDED"]),
  evidence: Id,
});
const Permission = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("UNKNOWN"), reason: Id }),
  Schema.Struct({
    kind: Schema.Literal("CERTIFIED"), sourcePin: Digest,
    permittedSources: Schema.Array(Source),
  }),
]);
const Necessity = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("UNKNOWN"), reason: Id }),
  Schema.Struct({ kind: Schema.Literal("CERTIFIED"), evidence: Id }),
]);
const Atom = Schema.Struct({
  atomId: Id, requiredFragments: Schema.NonEmptyArray(Range), necessity: Necessity,
});
const Alternative = Schema.Struct({
  alternativeId: Id, atomIds: Schema.NonEmptyArray(Id),
});
const Support = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("UNKNOWN"), reason: Id }),
  Schema.Struct({
    kind: Schema.Literal("CERTIFIED"), evidence: Id,
    atoms: Schema.Array(Atom), alternatives: Schema.Array(Alternative),
  }),
]);
const Label = Schema.Union([
  Schema.Struct({
    range: Range, kind: Schema.Literals(["RELEVANT", "PARTIAL", "IRRELEVANT"]),
    certification: Id,
  }),
  Schema.Struct({ range: Range, kind: Schema.Literal("UNKNOWN"), reason: Id }),
]);
export const ScheduledCaseSchema = Schema.Struct({
  taskId: Id, familyId: Id, permission: Permission,
  qualifications: Schema.Array(Qualification), support: Support,
  supplied: Schema.Array(Range), labels: Schema.Array(Label),
});
export type SourceRef = typeof Source.Type;
export type ByteRange = typeof Range.Type;
export type ScheduledCase = typeof ScheduledCaseSchema.Type;
export type Coverage = "COMPLETE" | "PARTIAL" | "NONE";
export type Eligibility = "QUALIFIED" | "UNKNOWN" | "EXCLUDED";
export type Relevance = typeof Label.Type["kind"] | "SUPPORT_FRAGMENT";
export type ByteAccounting = {
  suppliedBytes: number;
  relevantBytes: number;
  partialBytes: number;
  confirmedIrrelevantBytes: number;
  unknownBytes: number;
  ambiguousBytes: number;
  ambiguous: readonly { range: ByteRange; labels: readonly Relevance[] }[];
};

function fail(message: string): never {
  throw new Error(message);
}
export function sourceKey(source: SourceRef): string {
  return JSON.stringify([source.sourceId, source.sha256, source.revision]);
}
function safeSum(values: readonly number[]): number {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total)) fail("Byte total exceeds safe integer capacity.");
  return total;
}
function checkRanges(ranges: readonly ByteRange[]): void {
  checkSources(ranges.map((range) => range.source));
  for (const range of ranges) {
    if (range.start >= range.end || range.end > range.source.utf8Bytes)
      fail("Ranges must be nonempty UTF8 half-open byte ranges inside source length.");
  }
}
function checkSources(sources: readonly SourceRef[]): void {
  const sizes = new Map<string, number>();
  for (const source of sources) {
    const key = sourceKey(source);
    const prior = sizes.get(key);
    if (prior !== undefined && prior !== source.utf8Bytes)
      fail("Conflicting byte lengths for one immutable source identity.");
    sizes.set(key, source.utf8Bytes);
  }
}
function unique(ids: readonly string[], message: string): void {
  if (new Set(ids).size !== ids.length) fail(message);
}
export function decodeScheduledCase(raw: unknown): ScheduledCase {
  const input = Schema.decodeUnknownSync(ScheduledCaseSchema, {
    onExcessProperty: "error",
  })(raw);
  const required = input.support.kind === "CERTIFIED"
    ? input.support.atoms.flatMap((atom) => atom.requiredFragments) : [];
  const allRanges = [
    ...input.supplied, ...input.labels.map((label) => label.range), ...required,
    ...input.qualifications.flatMap((q) => q.source.utf8Bytes === 0 ? [] :
      [{ source: q.source, start: 0, end: q.source.utf8Bytes }]),
    ...(input.permission.kind === "CERTIFIED" ?
      input.permission.permittedSources.flatMap((source) => source.utf8Bytes === 0 ?
        [] : [{ source, start: 0, end: source.utf8Bytes }]) : []),
  ];
  checkRanges(allRanges);
  checkSources([...allRanges.map((range) => range.source),
    ...input.qualifications.map((q) => q.source),
    ...(input.permission.kind === "CERTIFIED" ? input.permission.permittedSources : [])]);
  unique(input.qualifications.map((q) => sourceKey(q.source)),
    "Duplicate source qualification.");
  if (input.permission.kind === "CERTIFIED")
    unique(input.permission.permittedSources.map(sourceKey), "Duplicate permitted source.");
  if (input.support.kind === "CERTIFIED") {
    unique(input.support.atoms.map((atom) => atom.atomId), "Duplicate atom.");
    unique(input.support.alternatives.map((alt) => alt.alternativeId), "Duplicate alternative.");
    const atoms = new Set(input.support.atoms.map((atom) => atom.atomId));
    for (const alt of input.support.alternatives) {
      unique(alt.atomIds, "Duplicate atom in alternative.");
      if (alt.atomIds.some((id) => !atoms.has(id)))
        fail("Alternative refers to an undeclared atom.");
    }
  }
  return input;
}

export function mergeRanges(raw: unknown): readonly ByteRange[] {
  const ranges = Schema.decodeUnknownSync(Schema.Array(Range), {
    onExcessProperty: "error",
  })(raw);
  checkRanges(ranges);
  const sorted = [...ranges].sort((a, b) =>
    (sourceKey(a.source) < sourceKey(b.source) ? -1 :
      sourceKey(a.source) > sourceKey(b.source) ? 1 : 0) ||
    a.start - b.start || a.end - b.end);
  const merged: ByteRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && sourceKey(last.source) === sourceKey(range.source) &&
        range.start <= last.end) {
      merged[merged.length - 1] = { ...last, end: Math.max(last.end, range.end) };
    } else merged.push(range);
  }
  safeSum(merged.map((range) => range.end - range.start));
  return merged;
}
export function fragmentCoverage(
  rawRequired: ByteRange, supplied: readonly ByteRange[],
): Coverage {
  const required = Schema.decodeUnknownSync(Range, {
    onExcessProperty: "error",
  })(rawRequired);
  const union = mergeRanges(supplied).filter((range) =>
    sourceKey(range.source) === sourceKey(required.source));
  checkRanges([required, ...union]);
  if (union.some((range) => range.start <= required.start && range.end >= required.end))
    return "COMPLETE";
  return union.some((range) => range.start < required.end && range.end > required.start)
    ? "PARTIAL" : "NONE";
}

export function accountBytes(raw: unknown): ByteAccounting {
  const input = decodeScheduledCase(raw);
  const supplied = mergeRanges(input.supplied);
  const supportFragments = input.support.kind === "CERTIFIED"
    ? input.support.atoms.filter((atom) => input.support.kind === "CERTIFIED" &&
      input.support.alternatives.some((alternative) => alternative.atomIds.includes(atom.atomId)))
      .flatMap((atom) => atom.requiredFragments) : [];
  const pieces: { range: ByteRange; labels: Relevance[] }[] = [];
  for (const range of supplied) {
    const same = input.labels.filter((label) =>
      sourceKey(label.range.source) === sourceKey(range.source) &&
      label.range.start < range.end && label.range.end > range.start);
    const support = supportFragments.filter((fragment) =>
      sourceKey(fragment.source) === sourceKey(range.source) &&
      fragment.start < range.end && fragment.end > range.start);
    const bounds = [...new Set([range.start, range.end, ...same.flatMap((label) => [
      Math.max(range.start, label.range.start), Math.min(range.end, label.range.end),
    ]), ...support.flatMap((fragment) => [
      Math.max(range.start, fragment.start), Math.min(range.end, fragment.end),
    ])])].sort((a, b) => a - b);
    for (let i = 1; i < bounds.length; i++) {
      const start = bounds[i - 1], end = bounds[i];
      if (start === undefined || end === undefined) fail("Missing partition boundary.");
      const labels: Relevance[] = [...new Set(same.filter((label) =>
        label.range.start < end && label.range.end > start).map((label) => label.kind))].sort();
      if (labels.length === 0) labels.push("UNKNOWN");
      if (support.some((fragment) => fragment.start < end && fragment.end > start))
        labels.push("SUPPORT_FRAGMENT");
      labels.sort();
      pieces.push({ range: { source: range.source, start, end },
        labels });
    }
  }
  const bytesFor = (kind: Relevance) => safeSum(pieces.filter((piece) =>
    piece.labels.length === 1 && piece.labels[0] === kind).map((piece) =>
      piece.range.end - piece.range.start));
  const ambiguous = pieces.filter((piece) => piece.labels.length > 1);
  const result = {
    suppliedBytes: safeSum(supplied.map((range) => range.end - range.start)),
    relevantBytes: bytesFor("RELEVANT"),
    partialBytes: bytesFor("PARTIAL"),
    confirmedIrrelevantBytes: bytesFor("IRRELEVANT"),
    unknownBytes: bytesFor("UNKNOWN"),
    ambiguousBytes: safeSum(ambiguous.map((piece) => piece.range.end - piece.range.start)),
    ambiguous,
  };
  if (safeSum([result.relevantBytes, result.partialBytes, result.confirmedIrrelevantBytes,
    result.unknownBytes, result.ambiguousBytes]) !== result.suppliedBytes)
    fail("Byte partition does not conserve the supplied union.");
  return result;
}

function sourceEligibility(source: SourceRef, input: ScheduledCase): Eligibility {
  if (input.permission.kind === "UNKNOWN") return "UNKNOWN";
  if (!input.permission.permittedSources.some((candidate) => sourceKey(candidate) === sourceKey(source)))
    return "EXCLUDED";
  return input.qualifications.find((q) => sourceKey(q.source) === sourceKey(source))?.kind ?? "UNKNOWN";
}
export function scoreSupport(raw: unknown) {
  const input = decodeScheduledCase(raw);
  const bytes = accountBytes(input);
  const suppliedQualifications = mergeRanges(input.supplied).map((range) => ({
    source: range.source, eligibility: sourceEligibility(range.source, input),
  })).filter((value, index, values) => values.findIndex((prior) =>
    sourceKey(prior.source) === sourceKey(value.source)) === index);
  if (input.support.kind === "UNKNOWN" || input.support.alternatives.length === 0)
    return {
      taskId: input.taskId, familyId: input.familyId,
      completeRequiredSupport: null, status: "UNKNOWN",
      reason: input.support.kind === "UNKNOWN" ? input.support.reason : "No certified sufficient alternatives.",
      atoms: [], alternatives: [], bytes, permission: input.permission,
      suppliedQualifications,
    };
  const atoms = input.support.atoms.map((atom) => {
    const fragments = atom.requiredFragments.map((range) => ({
      range, coverage: fragmentCoverage(range, input.supplied),
      eligibility: sourceEligibility(range.source, input),
    }));
    const coverage: Coverage = fragments.every((f) => f.coverage === "COMPLETE")
      ? "COMPLETE" : fragments.some((f) => f.coverage !== "NONE") ? "PARTIAL" : "NONE";
    const eligibility: Eligibility = fragments.some((f) => f.eligibility === "EXCLUDED")
      ? "EXCLUDED" : fragments.every((f) => f.eligibility === "QUALIFIED") ? "QUALIFIED" : "UNKNOWN";
    return { atomId: atom.atomId, necessity: atom.necessity, coverage, eligibility, fragments };
  });
  const alternatives = input.support.alternatives.map((alternative) => {
    const members = alternative.atomIds.map((id) => {
      const atom = atoms.find((candidate) => candidate.atomId === id);
      if (!atom) return fail("Validated atom membership absent.");
      return atom;
    });
    const coverage: Coverage = members.every((atom) => atom.coverage === "COMPLETE")
      ? "COMPLETE" : members.some((atom) => atom.coverage !== "NONE") ? "PARTIAL" : "NONE";
    const eligibility: Eligibility = members.some((atom) => atom.eligibility === "EXCLUDED")
      ? "EXCLUDED" : members.every((atom) => atom.eligibility === "QUALIFIED") ? "QUALIFIED" : "UNKNOWN";
    return { alternativeId: alternative.alternativeId, coverage, eligibility };
  });
  const complete = alternatives.some((alt) =>
    alt.coverage === "COMPLETE" && alt.eligibility === "QUALIFIED");
  const allQualified = alternatives.every((alt) => alt.eligibility === "QUALIFIED");
  const completeRequiredSupport = complete ? true : allQualified ? false : null;
  return {
    taskId: input.taskId, familyId: input.familyId, completeRequiredSupport,
    status: complete ? "COMPLETE" : !allQualified ? "UNKNOWN" :
      alternatives.some((alt) => alt.coverage !== "NONE") ? "PARTIAL" : "NONE",
    reason: null, atoms, alternatives, bytes, permission: input.permission,
    suppliedQualifications,
  };
}

const Pair = Schema.Struct({
  taskId: Id, familyId: Id,
  base: Schema.NullOr(Schema.Number), tuned: Schema.NullOr(Schema.Number),
  certification: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("CERTIFIED"), evidence: Id }),
    Schema.Struct({ kind: Schema.Literal("UNKNOWN"), reason: Id }),
  ]),
});
const BootstrapOptions = Schema.Struct({
  resamples: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(1000000)),
  seed: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(4294967295)),
});
const Cohort = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("UNKNOWN"), reason: Id }),
  Schema.Struct({
    kind: Schema.Literal("CERTIFIED"), evidence: Id,
    scheduledCensusSha256: Digest, cohortSha256: Digest,
    taskIds: Schema.NonEmptyArray(Id),
  }),
]);
export const PairedBootstrapSchema = Schema.Struct({
  scheduledPairs: Schema.Array(Pair), cohort: Cohort,
});
export const proposedBootstrap = { resamples: 10000, seed: 20261011 };
function quantile(sorted: readonly number[], probability: number): number {
  const position = (sorted.length - 1) * probability;
  const lo = sorted[Math.floor(position)], hi = sorted[Math.ceil(position)];
  if (lo === undefined || hi === undefined) fail("Quantile needs samples.");
  return lo + (hi - lo) * (position - Math.floor(position));
}
export function pairedFamilyBootstrap(raw: unknown, rawOptions: unknown = proposedBootstrap) {
  const input = Schema.decodeUnknownSync(PairedBootstrapSchema, {
    onExcessProperty: "error",
  })(raw);
  const scheduled = input.scheduledPairs;
  const cohort = input.cohort;
  const options = Schema.decodeUnknownSync(BootstrapOptions, {
    onExcessProperty: "error",
  })(rawOptions);
  unique(scheduled.map((pair) => pair.taskId), "Duplicate scheduled task.");
  if (scheduled.some((pair) => (pair.base !== null && !Number.isFinite(pair.base)) ||
    (pair.tuned !== null && !Number.isFinite(pair.tuned)))) fail("Nonfinite metric value.");
  if (cohort.kind === "CERTIFIED") {
    unique(cohort.taskIds, "Duplicate frozen cohort task.");
    const scheduledIds = new Set(scheduled.map((pair) => pair.taskId));
    if (cohort.taskIds.some((taskId) => !scheduledIds.has(taskId)))
      fail("Frozen cohort refers to an unscheduled task.");
  }
  const cohortIds = new Set(cohort.kind === "CERTIFIED" ? cohort.taskIds : []);
  const pairs = scheduled.filter((pair) => cohortIds.has(pair.taskId));
  const familyIds = [...new Set(pairs.map((pair) => pair.familyId))].sort();
  const unresolvedTaskIds = pairs.filter((pair) =>
    pair.base === null || pair.tuned === null || pair.certification.kind !== "CERTIFIED")
    .map((pair) => pair.taskId).sort();
  const retained = {
    scheduledTasks: scheduled.length,
    scheduledFamilies: new Set(scheduled.map((pair) => pair.familyId)).size,
    scheduledTaskIds: scheduled.map((pair) => pair.taskId).sort(),
    scheduledFamilyIds: [...new Set(scheduled.map((pair) => pair.familyId))].sort(),
    cohort: cohort.kind === "CERTIFIED" ? { ...cohort, taskIds: [...cohort.taskIds].sort() } : cohort,
    cohortTasks: pairs.length, cohortFamilies: familyIds.length,
    cohortTaskIds: pairs.map((pair) => pair.taskId).sort(),
    outsideCohortTaskIds: scheduled.filter((pair) => !cohortIds.has(pair.taskId))
      .map((pair) => pair.taskId).sort(),
    familyIds, unresolvedTaskIds, resamples: options.resamples, seed: options.seed,
  };
  if (cohort.kind === "UNKNOWN" || pairs.length === 0 || unresolvedTaskIds.length > 0)
    return { kind: "UNKNOWN", ...retained, estimate: null, interval95: null,
      familyDeltas: [], firstResampleIndices: [], firstSampleMeans: [],
      reason: cohort.kind === "UNKNOWN" ? cohort.reason : pairs.length === 0 ? "No scheduled cases." :
        "Whole-family paired estimator requires every scheduled pair on this certified axis." };
  const familyDeltas = familyIds.map((familyId) => {
    const tasks = pairs.filter((pair) => pair.familyId === familyId)
      .sort((a, b) => a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0);
    const delta = tasks.reduce((sum, task) => {
      if (task.base === null || task.tuned === null) return fail("Missing paired metric.");
      return sum + task.tuned - task.base;
    }, 0) / tasks.length;
    if (!Number.isFinite(delta)) fail("Nonfinite family delta.");
    return { familyId, tasks: tasks.length, delta };
  });
  let state = options.seed >>> 0;
  function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }
  const samples: number[] = [], firstResampleIndices: number[] = [];
  for (let sample = 0; sample < options.resamples; sample++) {
    let total = 0;
    for (let draw = 0; draw < familyDeltas.length; draw++) {
      const index = Math.floor(random() * familyDeltas.length);
      const family = familyDeltas[index];
      if (!family) fail("Invalid resample index.");
      if (sample === 0) firstResampleIndices.push(index);
      total += family.delta;
    }
    const mean = total / familyDeltas.length;
    if (!Number.isFinite(mean)) fail("Nonfinite bootstrap mean.");
    samples.push(mean);
  }
  const firstSampleMeans = samples.slice(0, 8);
  samples.sort((a, b) => a - b);
  const estimate = familyDeltas.reduce((sum, family) => sum + family.delta, 0) / familyDeltas.length;
  if (!Number.isFinite(estimate)) fail("Nonfinite paired estimate.");
  return {
    kind: "ESTIMATED", ...retained,
    estimate,
    interval95: [quantile(samples, 0.025), quantile(samples, 0.975)],
    familyDeltas, firstResampleIndices, firstSampleMeans,
    uncertainty: "Proposal percentile interval assumes independent representative families. Few families, selection and unresolved qualification limit inference; it is not a power guarantee or admission/superiority decision.",
    randomAlgorithm: "mulberry32, unsigned 32-bit state, uniform index floor(u * familyCount)",
    quantile: "linear interpolation at (resamples - 1) * probability",
  };
}

