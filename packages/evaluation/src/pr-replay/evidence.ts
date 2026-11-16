import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cohensKappa } from "../harness-compare/full-test/stats.ts";
import { rangeIdentity } from "../harness-compare/full-test/lanes.ts";
import { z } from "zod";
import {
  AFTER_MERGE_PREFIX,
  AuditOverride,
  REPLAY_EVIDENCE_VERSION,
  ReplayLineEvidence,
  type EvidenceClass,
  type LineEvidence,
} from "../harness-compare/full-test/replay-evidence.ts";
import { AfterMergeRecord } from "./aftermerge.ts";
import { decideThread, type Judgement } from "./concerns.ts";
import { majority } from "./majority.ts";
import { addedLines } from "./rework.ts";
import { ReworkMap } from "./rework.ts";
import type { CaseRecord } from "./schema.ts";
import {
  SOURCES,
  caseDirectory,
  isIncidentalPath,
  mirrorPath,
  type SourceName,
} from "./sources.ts";

/**
 * The replay's line evidence for one case (design §4, 10.128), the second answer key of the lanes
 * climb. Each of the first revision's lines gets the most demanding class its evidence supports:
 *
 * - needs-person: a person's substantive concern on it led to a change or a recorded design
 *   decision, or a commit judged a fix or a revert changed it within 90 days of landing;
 * - discussed: a person's substantive concern on it was answered, declined or accepted as a
 *   limitation, and nothing changed;
 * - agent-catchable: its only concerns were bot findings a maintainer confirmed, or a person's
 *   nit that was fixed;
 * - mechanical: it sits in a generated, vendored, lockfile or translation file.
 *
 * A line with none of these is absent: silence is not a label. Each thread gives its line the
 * majority of the passes' own classes (10.135, `threadClass`), so never a class no pass gave; a line
 * where a thread has no majority is disputed and absent, unless the line already needs a person,
 * which no thread can raise further. `concernKappa`, the first two passes' agreement, is a minor
 * quality signal.
 */

const RANK: Readonly<Record<EvidenceClass, number>> = {
  "needs-person": 4,
  discussed: 3,
  "agent-catchable": 2,
  mechanical: 1,
};

/** The class one judgement of one thread gives its anchor line, if any. */
export const concernClass = (
  judgement: Judgement,
  opener: "author" | "person" | "bot" | null,
): { class: EvidenceClass; strength: "strong" | "weak" } | null => {
  // 10.132: a person's thread that states or explains a design decision shows the change needed a
  // person, whether or not it asked for anything; so does the author's question that a reviewer
  // answered and the change adopted.
  if (
    judgement.designDecision &&
    (opener === "person" ||
      (opener === "author" &&
        judgement.isConcern &&
        (judgement.response === "answered" || judgement.response === "fixed")))
  )
    return { class: "needs-person", strength: "strong" };
  if (!judgement.isConcern) return null;
  if (opener === "person") {
    if (
      judgement.substantive &&
      (judgement.response === "fixed" || judgement.designDecision)
    )
      return { class: "needs-person", strength: "strong" };
    if (
      judgement.substantive &&
      ["answered", "rejected-with-reason", "acknowledged-not-fixed"].includes(
        judgement.response,
      )
    )
      return { class: "discussed", strength: "strong" };
    if (!judgement.substantive && judgement.response === "fixed")
      return { class: "agent-catchable", strength: "strong" };
    return null;
  }
  if (
    opener === "bot" &&
    judgement.validity === "valid" &&
    (judgement.response === "fixed" ||
      judgement.response === "acknowledged-not-fixed")
  )
    return {
      class: "agent-catchable",
      strength: judgement.response === "fixed" ? "strong" : "weak",
    };
  return null;
};

export interface ConcernRow {
  readonly id: string;
  readonly opener: "author" | "person" | "bot" | null;
  readonly firstRevisionKey: string | null;
  readonly a: Judgement | null;
  readonly b: Judgement | null;
  /** The third pass, on threads the first two tie on (10.135); absent in rows labelled before it. */
  readonly c?: Judgement | null;
}

/** A row's majority label, or null when the thread is unjudged. */
export const labelOf = (row: ConcernRow) =>
  decideThread(row.a, row.b, row.c ?? null).label;

type Lines = Map<string, LineEvidence>;

const raise = (
  lines: Lines,
  key: string,
  found: { class: EvidenceClass; strength: "strong" | "weak" },
  cite: string,
) => {
  const held = lines.get(key);
  if (held === undefined || RANK[found.class] > RANK[held.class])
    lines.set(key, { ...found, concerns: [cite] });
  else if (held.class === found.class)
    lines.set(key, {
      ...held,
      strength:
        held.strength === "strong" || found.strength === "strong"
          ? "strong"
          : "weak",
      concerns: [...held.concerns, cite],
    });
};

/**
 * A thread's class on its line by the majority of the passes' own classes (10.135), "none" counting
 * as an answer: two of three decide, so the class is always one some pass gave. The third pass
 * counts only where it ran, on the threads the first two tied on. `open` when there is no majority.
 */
export const threadClass = (
  row: ConcernRow,
):
  | { readonly open: true }
  | {
      readonly open: false;
      readonly found: {
        class: EvidenceClass;
        strength: "strong" | "weak";
      } | null;
    } => {
  const classed = [row.a, row.b, row.c ?? null].map((judgement) =>
    judgement === null ? null : concernClass(judgement, row.opener),
  );
  const name = (found: (typeof classed)[number] | undefined) =>
    found === undefined ? null : found === null ? "none" : found.class;
  const answers = [row.a, row.b, row.c ?? null].map((judgement, at) =>
    judgement === null ? null : name(classed[at]),
  );
  const decided = majority(answers[0]!, answers[1]!, answers[2]!);
  if (decided.value === null) return { open: true };
  if (decided.value === "none") return { open: false, found: null };
  const backing = classed.filter(
    (found): found is NonNullable<typeof found> =>
      found?.class === decided.value,
  );
  return {
    open: false,
    found: {
      class: decided.value as EvidenceClass,
      // Strong only when every pass that gave the class held it strong.
      strength: backing.every((found) => found.strength === "strong")
        ? "strong"
        : "weak",
    },
  };
};

/** The classes the threads' majority classes give the case's lines. */
const decidedLines = (
  concerns: ReadonlyArray<ConcernRow>,
  fixedAfter: ReadonlyMap<string, string>,
  mechanical: ReadonlyArray<string>,
) => {
  const lines: Lines = new Map();
  for (const key of mechanical)
    raise(lines, key, { class: "mechanical", strength: "weak" }, "path");
  for (const row of concerns) {
    if (row.firstRevisionKey === null) continue;
    const decided = threadClass(row);
    if (!decided.open && decided.found !== null)
      raise(lines, row.firstRevisionKey, decided.found, row.id);
  }
  for (const [key, commit] of fixedAfter)
    raise(
      lines,
      key,
      { class: "needs-person", strength: "strong" },
      `${AFTER_MERGE_PREFIX}${commit}`,
    );
  return lines;
};

/**
 * The passes' agreement: Cohen's kappa over the lines that threads both passes answered are anchored
 * to, each pass's class there from its own concern judgements alone, "none" counted as a class.
 * Mechanical and post-merge lines are decided by code, the same for both passes, so they never
 * enter it: counted, they would read as agreement the passes never reached.
 */
export const concernKappa = (concerns: ReadonlyArray<ConcernRow>) => {
  const answered = concerns.filter(
    (row) => row.a !== null && row.b !== null && row.firstRevisionKey !== null,
  );
  const classAt = (pass: "a" | "b", key: string) => {
    let best: EvidenceClass | null = null;
    for (const row of answered)
      if (row.firstRevisionKey === key) {
        const found = concernClass(row[pass]!, row.opener);
        if (found !== null && (best === null || RANK[found.class] > RANK[best]))
          best = found.class;
      }
    return best ?? "none";
  };
  const keys = [...new Set(answered.map((row) => row.firstRevisionKey!))];
  const pairs = keys.map((key) => ({
    family: "case",
    caseId: "case",
    x: classAt("a", key),
    y: classAt("b", key),
  }));
  // With one category kappa is 0/0, undefined; stats.ts reads that as 1, which would make a case
  // with one agreed line look perfectly reliable. Null instead, which the schema allows.
  if (new Set(pairs.flatMap((pair) => [pair.x, pair.y])).size < 2) return null;
  return cohensKappa(pairs).kappa;
};

/**
 * The evidence from the threads' majority labels: each line's class, the count of lines held back
 * because an unjudged thread stands there, and `concernKappa`. Post-merge fixes and mechanical paths
 * are code-decided.
 */
export const lineEvidence = (
  concerns: ReadonlyArray<ConcernRow>,
  fixedAfter: ReadonlyMap<string, string>,
  mechanical: ReadonlyArray<string>,
) => {
  const decided = decidedLines(concerns, fixedAfter, mechanical);
  // A thread with no majority class could have raised its line's class: the line is held back,
  // unless it already needs a person.
  const unsettled = concerns.filter(
    (row) => row.firstRevisionKey !== null && threadClass(row).open,
  );
  const open = new Set(unsettled.map((row) => row.firstRevisionKey!));
  const lines: Record<string, LineEvidence> = {};
  let disputed = 0;
  for (const key of [...new Set([...decided.keys(), ...open])].sort()) {
    const found = decided.get(key);
    if (open.has(key) && found?.class !== "needs-person") disputed++;
    else if (found !== undefined)
      lines[key] = { ...found, concerns: [...found.concerns].sort() };
  }
  // Threads one pass skipped (as against judged differently): reported apart, not in the schema.
  const missing = concerns.filter(
    (row) =>
      row.firstRevisionKey !== null && (row.a === null) !== (row.b === null),
  ).length;
  // Threads with a line and no majority class: what the held-back lines come from.
  const unjudged = unsettled.length;
  return { lines, disputed, missing, unjudged, kappa: concernKappa(concerns) };
};

const labelsOf = (record: CaseRecord) =>
  join(caseDirectory(record.source as SourceName, record.number), "labels");

const readJson = (path: string) =>
  JSON.parse(readFileSync(path, "utf8")) as unknown;

/**
 * The evidence inputs with each override's citation taken off its lines: a thread's row, a fix or
 * revert commit's lines, or a mechanical path's lines. Each line then takes what its other evidence
 * gives, if any.
 */
export const withoutOverridden = (
  concerns: ReadonlyArray<ConcernRow>,
  fixedAfter: ReadonlyMap<string, string>,
  mechanical: ReadonlyArray<string>,
  overrides: ReadonlyArray<AuditOverride>,
): [
  ReadonlyArray<ConcernRow>,
  ReadonlyMap<string, string>,
  ReadonlyArray<string>,
] => {
  const dropped = (
    origin: AuditOverride["origin"],
    cite: string,
    key: string,
  ) =>
    overrides.some(
      (override) =>
        override.origin === origin &&
        override.cite === cite &&
        override.lines.includes(key),
    );
  return [
    concerns.filter(
      (row) =>
        row.firstRevisionKey === null ||
        !dropped("review", row.id, row.firstRevisionKey),
    ),
    new Map(
      [...fixedAfter].filter(
        ([key, commit]) => !dropped("after-merge", commit, key),
      ),
    ),
    mechanical.filter(
      (key) => !dropped("path", key.slice(0, key.indexOf(":new:")), key),
    ),
  ];
};

/**
 * Records an audit override in the case's `labels/audit-overrides.json` (once per audit and citation)
 * and rebuilds its evidence with it. Returns each covered line's class before and after.
 */
export const recordAuditOverride = (
  record: CaseRecord,
  override: AuditOverride,
) => {
  const path = join(labelsOf(record), "audit-overrides.json");
  const held = existsSync(path)
    ? z
        .strictObject({ overrides: z.array(AuditOverride) })
        .parse(readJson(path)).overrides
    : [];
  const before = ReplayLineEvidence.parse(
    readJson(join(labelsOf(record), "line-evidence.json")),
  ).lines;
  const others = held.filter(
    (one) => !(one.audit === override.audit && one.cite === override.cite),
  );
  writeFileSync(
    path,
    `${JSON.stringify({ overrides: [...others, override] }, null, 2)}\n`,
  );
  const { evidence } = writeLineEvidence(record);
  return override.lines.map((line) => ({
    line,
    before: before[line]?.class ?? null,
    after: evidence.lines[line]?.class ?? null,
  }));
};

/** Builds and writes `labels/line-evidence.json` from the case's labels. */
export const writeLineEvidence = (record: CaseRecord) => {
  if (record.firstRevision === null)
    throw new Error(`${record.caseId} has no first revision`);
  const directory = labelsOf(record);
  const runFile = join(
    caseDirectory(record.source as SourceName, record.number),
    "run",
    "show.json",
  );
  const runId = (readJson(runFile) as { runId: string }).runId;
  const concerns = readFileSync(join(directory, "concerns.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as ConcernRow);
  const rework = ReworkMap.parse(readJson(join(directory, "rework.json")));
  const afterMergePath = join(directory, "aftermerge.json");
  const kinds = new Map(
    existsSync(afterMergePath)
      ? AfterMergeRecord.parse(readJson(afterMergePath)).commits.map(
          (commit) => [commit.commit, commit.kind] as const,
        )
      : [],
  );
  const fixedAfter = new Map<string, string>();
  for (const [key, entry] of Object.entries(rework.lines)) {
    const kind = entry.afterMerge ? kinds.get(entry.afterMerge.commit) : null;
    if (kind === "fix" || kind === "revert")
      fixedAfter.set(key, entry.afterMerge!.commit);
  }
  const mirror = mirrorPath(SOURCES[record.source as SourceName]);
  const mechanical = [
    ...addedLines(mirror, record.firstRevision.base, record.firstRevision.head),
  ]
    .filter(([path]) => isIncidentalPath(path))
    .flatMap(([path, numbers]) => numbers.map((line) => `${path}:new:${line}`));
  // The audit's overrides (labels/audit-overrides.json): each takes its citation's evidence off its
  // lines, so a rebuild keeps the correction; the kappa stays the labelling's own.
  const overridesPath = join(directory, "audit-overrides.json");
  const overrides = existsSync(overridesPath)
    ? z
        .strictObject({ overrides: z.array(AuditOverride) })
        .parse(readJson(overridesPath)).overrides
    : [];
  const { lines, disputed, missing, unjudged } = lineEvidence(
    ...withoutOverridden(concerns, fixedAfter, mechanical, overrides),
  );
  const kappa = concernKappa(concerns);
  const evidence = ReplayLineEvidence.parse({
    version: REPLAY_EVIDENCE_VERSION,
    caseId: record.caseId,
    source: record.source,
    era: record.era,
    split: record.split,
    family: record.family,
    control: record.control,
    range: rangeIdentity(
      `${record.firstRevision.base}..${record.firstRevision.head}`,
    ),
    runId,
    labelling: {
      passes: concerns.some((row) => row.c !== undefined && row.c !== null)
        ? 3
        : 2,
      rule: "majority",
      kappa,
    },
    lines,
    disputed,
    ...(overrides.length > 0 ? { auditOverrides: overrides } : {}),
  });
  writeFileSync(
    join(directory, "line-evidence.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  // Beside the evidence, for batch reports: what the frozen schema does not carry.
  writeFileSync(
    join(directory, "evidence-summary.json"),
    `${JSON.stringify({ caseId: record.caseId, lines: Object.keys(lines).length, disputed, missing, unjudged, tieBroken: concerns.some((row) => row.c !== undefined), kappa }, null, 2)}\n`,
  );
  return { evidence, missing };
};
