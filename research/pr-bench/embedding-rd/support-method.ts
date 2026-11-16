import * as Schema from "effect/Schema";
import { fragmentCoverage, mergeRanges, sourceKey, type ByteRange } from "./support-metrics";

const Id = Schema.NonEmptyString;
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Finite = Schema.Number.check(Schema.isFinite());
const Nat = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
const Positive = Nat.check(Schema.isGreaterThan(0));
const Source = Schema.Struct({sourceId: Id, sha256: Digest, revision: Id, utf8Bytes: Nat});
const Range = Schema.Struct({source: Source, start: Nat, end: Nat});
const Unit = Schema.Struct({unitId: Id, fragments: Schema.NonEmptyArray(Range), score: Finite});
const Atom = Schema.Struct({atomId: Id, fragments: Schema.NonEmptyArray(Range)});
const Alternative = Schema.Struct({semanticRouteId: Id, atomIds: Schema.NonEmptyArray(Id), requiredUnitIds: Schema.NonEmptyArray(Id)});
const Targets = Schema.Union([
  Schema.Struct({kind: Schema.Literal("UNKNOWN"), reason: Id}),
  Schema.Struct({kind: Schema.Literal("CERTIFIED"), supportPin: Digest, negativeFnPin: Digest,
    atoms: Schema.NonEmptyArray(Atom), alternatives: Schema.NonEmptyArray(Alternative),
    confusers: Schema.Array(Schema.Struct({unitId: Id, kind: Schema.Literal("CONFIRMED_IRRELEVANT"), certification: Digest})),
  }),
]);
const Task = Schema.Struct({taskId: Id, familyId: Id, split: Schema.Literals(["TRAIN", "DEV"]),
  qualification: Schema.Union([
    Schema.Struct({kind: Schema.Literal("UNKNOWN"), reason: Id}),
    Schema.Struct({kind: Schema.Literal("EXCLUDED"), reason: Id}),
    Schema.Struct({kind: Schema.Literal("QUALIFIED"), sourceAdmissionPin: Digest}),
  ]), units: Schema.NonEmptyArray(Unit), targets: Targets});
export const LossInputSchema = Schema.Struct({scheduledCensusPin: Digest, candidateInventoryPin: Digest,
  scheduledTaskIds: Schema.NonEmptyArray(Id), tasks: Schema.NonEmptyArray(Task),
  cohort: Schema.Union([
    Schema.Struct({kind: Schema.Literal("UNKNOWN"), reason: Id}),
    Schema.Struct({kind: Schema.Literal("CERTIFIED"), certificationPin: Digest, taskIds: Schema.NonEmptyArray(Id)}),
  ]),
});
export type LossInput = typeof LossInputSchema.Type;
function fail(message: string): never { throw new Error(message); }
function unique(ids: readonly string[], label: string) {
  if (new Set(ids).size !== ids.length) fail("Duplicate " + label);
}
function sameIds(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every(id => b.includes(id));
}
function unitFor(units: readonly typeof Unit.Type[], id: string) {
  return units.find(unit => unit.unitId === id) ?? fail("Absent unit " + id);
}
export function decodeLossInput(raw: unknown): LossInput {
  const data = Schema.decodeUnknownSync(LossInputSchema, {onExcessProperty: "error"})(raw);
  unique(data.scheduledTaskIds, "scheduled task"); unique(data.tasks.map(t => t.taskId), "task");
  if (!sameIds(data.scheduledTaskIds, data.tasks.map(t => t.taskId))) fail("Every scheduled case must remain present");
  if (data.cohort.kind === "CERTIFIED") {
    unique(data.cohort.taskIds, "cohort task");
    if (data.cohort.taskIds.some(id => !data.scheduledTaskIds.includes(id))) fail("Unscheduled cohort task");
  }
  mergeRanges(data.tasks.flatMap(task => [
    ...task.units.flatMap(unit => unit.fragments),
    ...(task.targets.kind === "CERTIFIED"
      ? task.targets.atoms.flatMap(atom => atom.fragments) : []),
  ]));
  for (const task of data.tasks) {
    unique(task.units.map(u => u.unitId), "candidate unit");
    mergeRanges(task.units.flatMap(u => u.fragments));
    if (task.targets.kind !== "CERTIFIED") continue;
    const targets = task.targets;
    unique(targets.atoms.map(a => a.atomId), "atom");
    unique(targets.alternatives.map(a => a.semanticRouteId), "semantic route, carrier representations must not be independent routes");
    unique(targets.confusers.map(n => n.unitId), "confuser");
    for (const atom of targets.atoms) mergeRanges(atom.fragments);
    for (const alternative of targets.alternatives) {
      unique(alternative.atomIds, "alternative atom"); unique(alternative.requiredUnitIds, "required unit");
      const supplied = alternative.requiredUnitIds.flatMap(id => unitFor(task.units, id).fragments);
      for (const id of alternative.atomIds) {
        const atom = targets.atoms.find(a => a.atomId === id) ?? fail("Absent atom");
        if (atom.fragments.some(fragment => fragmentCoverage(fragment, supplied) !== "COMPLETE"))
          fail("Every required fragment must have byte-exact complete unit coverage");
      }
      for (const id of alternative.requiredUnitIds) {
        const remaining = alternative.requiredUnitIds.filter(other => other !== id)
          .flatMap(other => unitFor(task.units, other).fragments);
        const needed = alternative.atomIds.some(atomId => {
          const atom = targets.atoms.find(a => a.atomId === atomId) ?? fail("Absent atom");
          return atom.fragments.some(fragment => fragmentCoverage(fragment, remaining) !== "COMPLETE");
        });
        if (!needed) fail("Redundant carrier unit cannot become necessary training target");
      }
    }
    const allSupport = targets.atoms.filter(atom => targets.alternatives.some(a => a.atomIds.includes(atom.atomId)))
      .flatMap(atom => atom.fragments);
    for (const negative of targets.confusers) {
      const unit = unitFor(task.units, negative.unitId);
      if (targets.alternatives.some(a => a.requiredUnitIds.includes(negative.unitId))) fail("Support unit is not a negative");
      if (unit.fragments.some(n => allSupport.some(p => sourceKey(n.source) === sourceKey(p.source) && n.start < p.end && p.start < n.end)))
        fail("Certified negative overlaps applicable support");
    }
  }
  return data;
}
export function softplus(value: number) {
  if (!Number.isFinite(value)) fail("Nonfinite softplus input");
  return Math.max(value, 0) + Math.log1p(Math.exp(-Math.abs(value)));
}
export function completeLoss(raw: unknown, objective: "A" | "B", split: "TRAIN" | "DEV") {
  const data = decodeLossInput(raw);
  const cohort = data.cohort;
  const retained = {scheduledTaskIds: data.scheduledTaskIds, scheduledTasks: data.tasks.length,
    outsideCohortTaskIds: data.tasks.filter(t => cohort.kind === "UNKNOWN" || !cohort.taskIds.includes(t.taskId)).map(t => t.taskId)};
  if (cohort.kind === "UNKNOWN") return {kind: tag("UNKNOWN"), reason: cohort.reason, ...retained};
  const tasks = data.tasks.filter(t => cohort.taskIds.includes(t.taskId));
  if (tasks.some(t => t.split !== split)) fail("Cohort split mismatch");
  const unresolved = tasks.filter(t => t.qualification.kind !== "QUALIFIED" || t.targets.kind !== "CERTIFIED" || t.targets.confusers.length === 0);
  if (unresolved.length) return {kind: tag("UNKNOWN"), unresolvedTaskIds: unresolved.map(t => t.taskId), ...retained};
  const losses = tasks.map(task => {
    if (task.targets.kind !== "CERTIFIED") return fail("Unqualified target");
    const negatives = task.targets.confusers.map(n => unitFor(task.units, n.unitId).score);
    const alternatives = task.targets.alternatives.map(alt => {
      const positives = alt.requiredUnitIds.map(id => unitFor(task.units, id).score);
      const loss = objective === "A"
        ? positives.reduce((sum, p) => sum + negatives.reduce((subtotal, n) => subtotal + softplus((n - p) / 0.1), 0), 0) / (positives.length * negatives.length)
        : softplus((Math.max(...negatives) - Math.min(...positives)) / 0.1);
      return {semanticRouteId: alt.semanticRouteId, loss};
    }).sort((a, b) => a.loss - b.loss || compareId(a.semanticRouteId, b.semanticRouteId));
    const chosen = alternatives[0] ?? fail("Missing alternative");
    return {taskId: task.taskId, familyId: task.familyId, loss: chosen.loss, chosenSemanticRoute: chosen.semanticRouteId, alternatives};
  });
  const families = [...new Set(losses.map(t => t.familyId))].sort().map(familyId => {
    const members = losses.filter(t => t.familyId === familyId);
    return {familyId, loss: members.reduce((sum, task) => sum + task.loss, 0) / members.length, tasks: members.length};
  });
  const loss = families.reduce((sum, family) => sum + family.loss, 0) / families.length;
  if (!Number.isFinite(loss)) fail("Nonfinite full objective");
  return {kind: tag("MEASURED"), objective, split, loss, taskLosses: losses, familyLosses: families, ...retained};
}
function tag<const K extends string>(kind: K): K { return kind; }
function compareId(a: string, b: string) { return a < b ? -1 : a > b ? 1 : 0; }
const RankedScore = Schema.Struct({unitId: Id, score: Finite});
export function canonicalRank(raw: unknown) {
  const rows = Schema.decodeUnknownSync(Schema.Array(RankedScore), {onExcessProperty: "error"})(raw);
  unique(rows.map(r => r.unitId), "score unit");
  return [...rows].sort((a, b) => b.score - a.score || compareId(a.unitId, b.unitId)).map(row => row.unitId);
}
export function equalRrf(rawDense: unknown, rawLexical: unknown) {
  const list = Schema.NonEmptyArray(Id);
  const dense = Schema.decodeUnknownSync(list)(rawDense), lexical = Schema.decodeUnknownSync(list)(rawLexical);
  unique(dense, "dense rank"); unique(lexical, "lexical rank");
  if (!sameIds(dense, lexical)) fail("Matched complete candidate universes required");
  return canonicalRank(dense.map((unitId, index) => ({unitId, score: 1 / (60 + index + 1) + 1 / (60 + lexical.indexOf(unitId) + 1)})));
}
const PackingSchema = Schema.Struct({rankedUnitIds: Schema.Array(Id), units: Schema.Array(Schema.Struct({unitId: Id, text: Schema.String, fragments: Schema.NonEmptyArray(Range)})),
  query: Schema.String, envelope: Schema.String, budgets: Schema.Struct({sourceBytes: Positive, queryBytes: Positive, envelopeBytes: Positive}), cut: Positive});
export function packWholeUnits(raw: unknown) {
  const input = Schema.decodeUnknownSync(PackingSchema, {onExcessProperty: "error"})(raw);
  unique(input.units.map(u => u.unitId), "packing unit"); unique(input.rankedUnitIds, "packing rank");
  if (!sameIds(input.rankedUnitIds, input.units.map(u => u.unitId))) fail("Packing requires full ranked inventory");
  const bytes = (text: string) => new TextEncoder().encode(text).length;
  const queryBytes = bytes(input.query), envelopeBytes = bytes(input.envelope);
  if (queryBytes > input.budgets.queryBytes || envelopeBytes > input.budgets.envelopeBytes) fail("Independent query/envelope quota exceeded");
  mergeRanges(input.units.flatMap(unit => unit.fragments));
  for (const unit of input.units) {
    const ranges = mergeRanges(unit.fragments);
    const requiredBytes = ranges.reduce((sum, range) => sum + range.end - range.start, 0);
    if (bytes(unit.text) !== requiredBytes) fail("Whole original unit UTF8 byte mismatch");
  }
  const selected: string[] = [], skipped: string[] = [];
  const supplied: ByteRange[] = []; let sourceBytes = 0;
  for (const id of input.rankedUnitIds) {
    if (selected.length >= input.cut) break;
    const unit = input.units.find(u => u.unitId === id) ?? fail("Missing packing unit");
    const size = bytes(unit.text);
    if (sourceBytes + size > input.budgets.sourceBytes) { skipped.push(id); continue; }
    sourceBytes += size; selected.push(id); supplied.push(...unit.fragments);
  }
  return {selected, skipped, supplied, sourceBytes, queryBytes, envelopeBytes, allocatedSourceBytes: input.budgets.sourceBytes,
    unusedSourceBytes: input.budgets.sourceBytes - sourceBytes, quotasBorrowed: false};
}

export function compareFullTrainLoss(rawBefore: unknown, rawAfter: unknown, objective: "A" | "B") {
  const before = decodeLossInput(rawBefore), after = decodeLossInput(rawAfter);
  const fixed = (data: LossInput) => JSON.stringify({...data, tasks: data.tasks.map(task => ({...task,
    units: task.units.map(({score: _score, ...unit}) => unit)}))});
  if (fixed(before) !== fixed(after)) fail("Before/after require identical complete census, cohort, sources and targets");
  const oldLoss = completeLoss(before, objective, "TRAIN"), newLoss = completeLoss(after, objective, "TRAIN");
  if (oldLoss.kind !== "MEASURED" || newLoss.kind !== "MEASURED") return {kind: tag("UNKNOWN"), before: oldLoss, after: newLoss};
  return {kind: tag("COMPARED"), objective, before: oldLoss.loss, after: newLoss.loss,
    delta: newLoss.loss - oldLoss.loss, strictlyLower: newLoss.loss < oldLoss.loss,
    scheduledTasks: before.tasks.length, cohort: before.cohort};
}
