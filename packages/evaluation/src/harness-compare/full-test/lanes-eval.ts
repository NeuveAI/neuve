import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { publicEntryAt } from "@neuve/harness/lane-context";
import * as harnessLaneRule from "@neuve/harness/lane-rule";
import {
  addedLines,
  ENTRY_STEPS,
  LANE_CANDIDATES,
  laneOf,
  withPublicSurface,
  type AddedLine,
  type LaneContext,
} from "@neuve/harness/lane-rule";
import { ACCURACY_FLOOR } from "../../pr-replay/audit.ts";
import { CaseRecord } from "../../pr-replay/schema.ts";
import {
  carriedKey,
  carriedOwnerUnits,
  laneMeasures,
  LANES_RESULTS,
  runAgreement,
  shownRun,
  type LaneCall,
} from "./lanes.ts";
import {
  originOf,
  readAfterMerge,
  readEvidence,
  replayMeasures,
  type AfterMergeKinds,
  type ReplayCall,
} from "./lanes-replay.ts";
import {
  isSectionsShape,
  ownedLineKeys,
  packetUnits,
  rangeLineKeys,
  READS_SECTIONS,
  readShownFile,
  UnreadableRun,
  type Lane,
  type PacketLite,
  type PacketUnitLite,
  type SectionLite,
} from "./packets.ts";
import {
  AFTER_MERGE_PREFIX,
  type ReplayLineEvidence,
} from "./replay-evidence.ts";
import { quantile, random } from "../../retrieval-bench/score/stats.ts";

/**
 * The lanes evals (10.137): the replay dataset frozen as an eval set, and a lane candidate measured
 * on it without a model call. A unit's lane is decided by code from its recorded assessment
 * (`laneOf`, inside the composition stage), and the packet records every input that rule reads, so a
 * candidate is recomputed per published unit from the packet alone. The identity check holds that
 * claim up: the harness's own rule, recomputed, must give every stored lane. Labels, after-merge
 * records and concerns are read here only, never by the harness.
 *
 * Units joined by lane are recomputed as published: a candidate that would split one is applied to
 * the joined unit, and such units are counted (`joined`), since only a composition rerun from the
 * stored stages can show the split.
 *
 * Lane rule 3 (the sections shape, `assessment.recorded@4`) is read per section: each section's
 * stored trail must be what the harness's `recordedLane` gives from the section's own entry and the
 * lines it adds, its stored floors what the harness's `floorsOf` gives from its floor inputs, every
 * section's applied lane is the unit's, and the unit owns exactly its sections' lines. The per-line measures then read the unit's owned ranges and lane as for rules 1 and 2.
 */

/** The lane rule a run was placed with: 1, `laneOf`; 2, with the public-surface raise; 3, per section; 4, the matrix with kept findings as moves; 5, rule 4 with a Verify-confirmed request for changes moving both axes. */
export type LaneRuleVersion = 1 | 2 | 3 | 4 | 5;
const LaneRuleField = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);

/** A section's lane trail, as the harness's `recordedLane` gives it and Publish stores it. */
export interface LaneTrail {
  readonly judged: Lane | null;
  readonly surfaced: Lane | null;
  readonly floors: ReadonlyArray<{ readonly rule: string; readonly to: Lane }>;
  readonly applied: Lane;
}

/** The harness's rule 3 over one stored section entry and the lines that section adds. */
export type RecordedLane = (
  entry: SectionLite,
  added: ReadonlyArray<AddedLine>,
) => LaneTrail;

/**
 * The one seam rule 3 is read through: the harness's own `recordedLane` when this build's
 * `@neuve/harness/lane-rule` exports it, never a copy of the rule here. Tests put a stand-in in.
 */
let recordedLaneOf: RecordedLane | undefined = (
  harnessLaneRule as unknown as { readonly recordedLane?: RecordedLane }
).recordedLane;

/** Puts `fn` in the seam (a test's stand-in, or undefined for a build without it); returns the one it replaced. */
export const useRecordedLane = (fn: RecordedLane | undefined) => {
  const was = recordedLaneOf;
  recordedLaneOf = fn;
  return was;
};

export const NO_RECORDED_LANE =
  "this build's @neuve/harness/lane-rule exports no recordedLane, so a lane rule 3 run cannot be recomputed here; read it with a build that has the harness's rule 3";

const recordedLane = (): RecordedLane => {
  if (recordedLaneOf === undefined) throw new Error(NO_RECORDED_LANE);
  return recordedLaneOf;
};

/** The harness's floor rule over a section's stored floor inputs: every floor that applies. */
export type FloorsOf = (
  facts: unknown,
  options: unknown,
) => ReadonlyArray<{ readonly rule: string; readonly to: Lane }>;

/**
 * The second seam: the harness's own `floorsOf` when `@neuve/harness/lane-rule` exports it, so the
 * stored floors are held to the section's stored floor inputs, never only to themselves.
 */
let floorsOfFn: FloorsOf | undefined = (
  harnessLaneRule as unknown as { readonly floorsOf?: FloorsOf }
).floorsOf;

/** Puts `fn` in the floors seam (a test's stand-in, or undefined); returns the one it replaced. */
export const useFloorsOf = (fn: FloorsOf | undefined) => {
  const was = floorsOfFn;
  floorsOfFn = fn;
  return was;
};

export const NO_FLOORS_OF =
  "this build's @neuve/harness/lane-rule exports no floorsOf, so a lane rule 3 run's floors cannot be held to its floor inputs here; read it with a build that has the harness's floor rule";

const floorsOf = (): FloorsOf => {
  if (floorsOfFn === undefined) throw new Error(NO_FLOORS_OF);
  return floorsOfFn;
};

/** Rule 3's `finding` floor (NEU-148 round 22), which rule 4 replaced with a move on the matrix. */
const FINDING_FLOOR = { rule: "finding", to: "human-suggested" } as const;

/**
 * The floors a section's stored floor inputs give under the lane rule its run was placed with, so
 * each run is judged by its own rule: under rule 3 a finder finding Verify kept (`keptFinding` in
 * the stored facts) holds the `finding` floor, which the harness's rule 4 `floorsOf` no longer
 * gives; under rule 4 that finding is a move the assessment holds, and the floors are the harness's.
 */
const floorsUnder = (laneRule: number, facts: unknown, options: unknown) => {
  const given = floorsOf()(facts, options);
  const kept =
    facts !== null &&
    typeof facts === "object" &&
    (facts as { keptFinding?: unknown }).keptFinding === true;
  return laneRule === 3 && kept && !given.some((f) => f.rule === "finding")
    ? [...given, FINDING_FLOOR]
    : given;
};

/** The note a sections report carries when a run prints no floor inputs, with the count. */
export const FLOORS_NOT_CHECKED =
  "floors not checked: the run prints no floor inputs";

const Hashed = z.strictObject({
  path: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export const EvalSetCase = z.strictObject({
  caseId: z.string().min(1),
  source: z.string().min(1),
  number: z.int(),
  range: z.string().regex(/^[0-9a-f]{8}\.\.[0-9a-f]{8}$/),
  era: z.enum(["pre-2022", "2024-2025", "2026"]),
  split: z.enum(["development", "held-out", "pilot"]),
  control: z.enum(["quiet", "abandoned", "reverted", "mechanical"]).nullable(),
  evidence: Hashed,
  packet: Hashed,
  afterMerge: Hashed.nullable(),
  concerns: Hashed.nullable(),
  audit: Hashed.nullable(),
  /** The noise floor's second run of this case, when it is one of the floor's cases. */
  floor: Hashed.nullable().optional(),
  /** A second run that tests run consistency only, never the floor's flip rate. */
  consistency: Hashed.nullable().optional(),
});
export type EvalSetCase = z.infer<typeof EvalSetCase>;

/** A frozen eval set: every file it reads, pinned by hash; a changed file refuses the set. */
export const EvalSet = z.strictObject({
  version: z.literal(1),
  name: z.string().min(1),
  frozenAt: z.string(),
  batch: Hashed,
  auditReport: Hashed.nullable(),
  /**
   * The lane rule the set's runs were placed with (`LANE_RULE_VERSION`): 1, laneOf alone (sets frozen
   * before 10.140, which hold no field); 2, with the public-surface raise. The identity check
   * recomputes each stored lane with it.
   */
  laneRule: LaneRuleField.optional(),
  cases: z.array(EvalSetCase).min(1),
  /** Batch cases left out by name because the replay has no run or evidence for them, with why. */
  leftOut: z
    .array(
      z.strictObject({
        source: z.string().min(1),
        number: z.int(),
        reason: z.string().min(1),
      }),
    )
    .optional(),
});
export type EvalSet = z.infer<typeof EvalSet>;

const sha256Of = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const hashed = (path: string) => ({ path, sha256: sha256Of(path) });
const optional = (path: string) => (existsSync(path) ? hashed(path) : null);

/** A case's second run, pinned; refused when it is the case's own first run under another name. */
const secondRun = (
  directory: string,
  packet: string,
  run: string | undefined,
  laneRule: LaneRuleVersion,
) => {
  if (run === undefined) return null;
  const path = join(directory, "run", run, "show.json");
  const pinned = optional(path);
  if (pinned !== null && pinned.sha256 === sha256Of(packet))
    throw new Error(`${path} is the case's own run, not a second run of it`);
  if (pinned !== null) pinnable(path, path, laneRule);
  return pinned;
};

/**
 * A run a set may pin: read with the guard and through the lane rule's reader (`recordedUnits`), so
 * a set never pins a run its readers would refuse, an assessment that does not parse and a rule-3
 * trail that does not recompute included.
 */
const pinnable = (path: string, where: string, laneRule: LaneRuleVersion) => {
  const shown = readableShown(path, where);
  recordedUnits(
    shown.packet ?? null,
    hunksOf(shown),
    undefined,
    laneRule,
    shapeOf(shown),
    where,
  );
  return shown;
};

/** A stored run's `review show --json`, read and put through the guard (packets.ts `readShownFile`). */
const readableShown = (path: string, where: string) =>
  readShownFile<{
    packet?: PacketLite | null;
    manifest?: unknown;
    range?: { headOid?: string };
    stages?: unknown;
  }>(path, where, READS_SECTIONS);

const BatchFile = z.object({
  cases: z.array(z.object({ source: z.string(), number: z.int() })),
});

/**
 * Freezes a batch of the replay dataset as an eval set. Every case needs line evidence of the
 * current schema and a packet; a case without either refuses the freeze, named.
 */
export const freezeEvalSet = (options: {
  readonly name: string;
  /** The research volume's `cases` folder. */
  readonly cases: string;
  /** The batch's case list (`index/batches/<batch>.json`). */
  readonly batch: string;
  /** The batch's label audit (`audits/<batch>`), when it has run. */
  readonly audit?: string | undefined;
  /**
   * The noise floor's runs: each case's `run/<floorRun>/show.json`, a second run of the same build,
   * pinned with the set where a case has one.
   */
  readonly floorRun?: string | undefined;
  /** Second runs that test run consistency only (`run/<consistencyRun>/show.json`), never f. */
  readonly consistencyRun?: string | undefined;
  /**
   * Batch cases the replay could not run (`<source>/<number>`, with neither evidence nor a run),
   * left out by name and recorded in the set; a case that has either is never left out.
   */
  readonly leaveOut?: ReadonlyArray<string> | undefined;
  /** The lane rule the batch's runs were placed with; stated, since a run of rules 1 and 2 does not record it. */
  readonly laneRule: LaneRuleVersion;
}): EvalSet => {
  const listed = BatchFile.parse(
    JSON.parse(readFileSync(options.batch, "utf8")),
  ).cases;
  const missing: Array<string> = [];
  // `<source>/<number>`, or `<source>/<number>=<why>` where the case record gives no reason.
  const given = new Map(
    (options.leaveOut ?? []).map((entry) => {
      const at = entry.indexOf("=");
      return at === -1
        ? [entry, undefined]
        : [entry.slice(0, at), entry.slice(at + 1)];
    }),
  );
  const leaving = new Set(given.keys());
  const unknown = [...leaving].filter(
    (name) =>
      !listed.some(({ source, number }) => `${source}/${number}` === name),
  );
  if (unknown.length > 0)
    throw new Error(
      `--leave-out names ${unknown.join(", ")}, not cases of the batch`,
    );
  const leftOut: Array<{ source: string; number: number; reason: string }> = [];
  const cases = listed.flatMap(({ source, number }) => {
    const directory = join(options.cases, source, String(number));
    const evidence = join(directory, "labels", "line-evidence.json");
    const packet = join(directory, "run", "show.json");
    if (leaving.has(`${source}/${number}`)) {
      if (existsSync(evidence) || existsSync(packet))
        throw new Error(
          `${source}/${number} has its evidence or run; only a case the replay could not run is left out`,
        );
      const record = existsSync(join(directory, "case.json"))
        ? CaseRecord.parse(
            JSON.parse(readFileSync(join(directory, "case.json"), "utf8")),
          )
        : null;
      leftOut.push({
        source,
        number,
        reason:
          record?.unavailable ??
          given.get(`${source}/${number}`) ??
          "the replay has no run for it",
      });
      return [];
    }
    for (const path of [evidence, packet, join(directory, "case.json")])
      if (!existsSync(path)) missing.push(path);
    if (!existsSync(evidence) || !existsSync(packet)) return [];
    const record = CaseRecord.parse(
      JSON.parse(readFileSync(join(directory, "case.json"), "utf8")),
    );
    // Read with the reader's own check, so a set never holds evidence the reader would refuse.
    const [line] = readEvidence([evidence]).evidence;
    // And the run with the eval's guard and its lane rule's reader, so a set never pins a run its
    // readers would refuse.
    pinnable(packet, `case ${record.caseId} (${packet})`, options.laneRule);
    return [
      {
        caseId: record.caseId,
        source,
        number,
        range: line!.range,
        era: record.era,
        split: record.split,
        control: record.control,
        evidence: hashed(evidence),
        packet: hashed(packet),
        afterMerge: optional(join(directory, "labels", "aftermerge.json")),
        concerns: optional(join(directory, "labels", "concerns.jsonl")),
        audit:
          options.audit === undefined
            ? null
            : optional(
                join(options.audit, `${source}-${number}`, "verdicts.json"),
              ),
        floor: secondRun(directory, packet, options.floorRun, options.laneRule),
        consistency: secondRun(
          directory,
          packet,
          options.consistencyRun,
          options.laneRule,
        ),
      },
    ];
  });
  for (const [flag, run, kind] of [
    ["--floor-run", options.floorRun, "floor"],
    ["--consistency-run", options.consistencyRun, "consistency"],
  ] as const)
    if (run !== undefined && cases.every((entry) => entry[kind] === null))
      throw new Error(
        `${flag} ${run}: no case of the batch has run/${run}/show.json`,
      );
  const both = cases.filter(
    (entry) => entry.floor !== null && entry.consistency !== null,
  );
  if (both.length > 0)
    throw new Error(
      `${both[0]!.caseId} has a floor run and a consistency run; the consistency runs are kept apart from the floor`,
    );
  if (missing.length > 0)
    throw new Error(
      `the batch is not ready to freeze; missing ${missing.length} file(s), first ${missing.slice(0, 5).join(", ")}`,
    );
  return EvalSet.parse({
    version: 1,
    name: options.name,
    frozenAt: new Date().toISOString(),
    batch: hashed(options.batch),
    auditReport:
      options.audit === undefined
        ? null
        : optional(join(options.audit, "report.json")),
    laneRule: options.laneRule,
    cases,
    ...(leftOut.length === 0 ? {} : { leftOut }),
  });
};

export const EVAL_SETS = join(LANES_RESULTS, "eval-sets");

/** Writes a frozen set once: a set is never re-frozen under the same name. */
export const writeEvalSet = (set: EvalSet, directory = EVAL_SETS) => {
  const path = join(directory, `${set.name}.json`);
  if (existsSync(path))
    throw new Error(`${path} exists: a frozen set is never rewritten`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path, `${JSON.stringify(set, null, 2)}\n`);
  return path;
};

const ConcernLabel = z.object({
  category: z.string().nullable().optional(),
  designDecision: z.boolean().optional(),
  rationale: z.string().optional(),
});
const ConcernRecord = z.object({
  id: z.string(),
  agreed: z.boolean(),
  a: ConcernLabel.nullable().optional(),
  label: ConcernLabel.nullable().optional(),
});
const AuditVerdicts = z.object({
  items: z.array(
    z.object({
      cite: z.string(),
      lines: z.array(z.string()),
      verdict: z.enum(["right", "wrong", "unsure"]).nullable(),
    }),
  ),
});
const AuditReport = z.object({
  byKind: z.record(
    z.string(),
    z.object({
      accuracy: z.number().nullable(),
      interval: z.tuple([z.number(), z.number()]).nullable(),
    }),
  ),
});

/** A manifest hunk as the candidates read it: its file and its diff text, nothing else. */
const ManifestHunk = z.object({
  kind: z.string(),
  path: z.string(),
  newPath: z.string().nullable(),
  newStart: z.int(),
  text: z.string(),
});
type ManifestHunk = z.infer<typeof ManifestHunk>;

/** A shown run's manifest hunks; a run that shows none gives candidates no added lines. */
export const hunksOf = (shown: { readonly manifest?: unknown }) =>
  z
    .object({ hunks: z.array(ManifestHunk) })
    .nullable()
    .optional()
    .parse(shown.manifest ?? null)?.hunks ?? [];

/**
 * The review shape a shown run was made with, from the stages it ran: the fixed review shape
 * (decision 12.41) links findings to code-filled units in a Link stage; the older shape had
 * Assemble and Dispose. On the older shape a unit joins sections that took one lane, so a candidate
 * that would split them is approximated; on the fixed shape a unit is one proximity unit whose
 * sections are code sections of it, placed in one lane whole, so a candidate's lane is exact.
 */
export type ReviewShape = "fixed" | "older" | "sections";
export const shapeOf = (shown: {
  readonly stages?: unknown;
  readonly packet?: unknown;
}): ReviewShape =>
  // One authority (packets.ts `isSectionsShape`): units carrying the sections shape's records. The
  // guard refuses them under any packet kind but `packet.published@2`, so the two agree.
  isSectionsShape(shown.packet as PacketLite | null | undefined)
    ? "sections"
    : Array.isArray(shown.stages) &&
        shown.stages.some(
          (stage) => (stage as { stage?: unknown } | null)?.stage === "link",
        )
      ? "fixed"
      : "older";

/** The package-entry check a run reads, and the packages it read only in part (disclosed). */
type EntryCheck = NonNullable<LaneContext["isPublicEntry"]> & {
  readonly truncated: () => ReadonlyArray<string>;
};

/**
 * The package-entry check at a range's head, built only when a candidate asks: a repository and
 * head the run names, read with the harness's own function. No head, no check.
 */
const entryAt = (
  repository: string,
  head: string | undefined,
): EntryCheck | undefined => {
  if (head === undefined) return undefined;
  let built: ReturnType<typeof publicEntryAt> | undefined;
  return Object.assign(
    (path: string, names: ReadonlyArray<string>) =>
      (built ??= publicEntryAt(repository, head))(path, names),
    {
      truncated: () =>
        built === undefined
          ? []
          : built
              .truncated()
              .map((root) => `${repository}@${head.slice(0, 12)}:${root}`),
    },
  );
};

/** Every package any case read only in part, so a verdict says where its entry reading stopped. */
const truncatedEntries = (cases: ReadonlyArray<LoadedCase>) =>
  cases.flatMap(
    (entry) =>
      (entry.isPublicEntry as EntryCheck | undefined)?.truncated() ?? [],
  );

/**
 * One owner run's units under a rule: its shown packet's units, with their added lines from its
 * manifest and the package-entry check at its own head in the owner's repository. A candidate that
 * reads added lines refuses a run that shows none.
 */
export const ownerRunUnits = (
  shown: {
    readonly packet: PacketLite | null;
    readonly manifest?: unknown;
    readonly range?: { readonly headOid?: string };
    readonly stages?: unknown;
  },
  run: string,
  range: string,
  rule: LaneRule,
  options: {
    readonly repository: string;
    readonly candidate: boolean;
    /** The lane rule the owner's run was placed with: 1 before 10.140. */
    readonly laneRule?: LaneRuleVersion | undefined;
  },
) => {
  const hunks = hunksOf(shown);
  requireHunks(hunks, run, options.candidate);
  const entry = entryAt(options.repository, shown.range?.headOid);
  let moved = 0;
  const laneRule = options.laneRule ?? 1;
  const recorded = recordedUnits(
    shown.packet,
    hunks,
    entry,
    laneRule,
    shapeOf(shown),
    `owner run ${run}`,
  );
  // The run's own identity check: its stored lanes are its lane rule's, or the guard would judge a
  // harness that never ran (a rule-2 desk run read as rule 1 puts its raised units back).
  const off = recorded.filter(
    (entry) =>
      entry.recorded !== null &&
      harnessRule(entry.recorded) !== entry.recorded.lane,
  );
  if (off.length > 0)
    throw new Error(
      `owner run ${run} was not placed with lane rule ${laneRule}: ${off.length} unit(s) recompute to another lane, first ${off[0]!.unit.unitId}; state the rule its build used with --owner-lane-rule`,
    );
  const calls = recorded.map(({ unit, recorded }): LaneCall => {
    const lane = recorded === null ? null : rule(recorded);
    if (recorded !== null && lane !== recorded.lane) moved++;
    return {
      unit: unit.unitId,
      title: unit.recorded?.payload.title ?? unit.unitId,
      range,
      harness: lane,
      owner: null,
      lines: [...ownedLineKeys(unit)],
    };
  });
  return { calls, moved, truncated: entry?.truncated() ?? [] };
};

/** One case of a loaded set: its pinned files, read and checked. */
export interface LoadedCase {
  readonly meta: EvalSetCase;
  readonly evidence: ReplayLineEvidence;
  readonly packet: PacketLite | null;
  /** The run's manifest hunks, from the same pinned packet file. */
  readonly hunks: ReadonlyArray<ManifestHunk>;
  /** The noise floor's second run of the case, pinned with the set; null when it has none. */
  readonly floorPacket: PacketLite | null;
  /** The lane rule the case's runs were placed with: the set's. */
  readonly laneRule: LaneRuleVersion;
  /** The review shape of the run read; absent, the older shape (cases loaded before it was read). */
  readonly shape?: ReviewShape | undefined;
  /** What a refusal calls the run read, when it is not the case's own (a floor or consistency run). */
  readonly label?: string | undefined;
  /** A second run pinned for run consistency only; null when it has none. */
  readonly consistencyPacket: PacketLite | null;
  /**
   * Whether an exported name crosses its package's public entry at the range's head (the replay
   * case's first revision, in its own clone), read with the harness's own function.
   */
  readonly isPublicEntry: LaneContext["isPublicEntry"];
  /** Each concern's majority summary, by its id; null where the passes reached no majority. */
  readonly concerns: ReadonlyMap<string, z.infer<typeof ConcernLabel> | null>;
  /** The label audit's majority verdict for each audited item, by `<cite>|<line>`. */
  readonly audited: ReadonlyMap<string, "right" | "wrong" | "unsure" | null>;
}

export interface LoadedSet {
  readonly set: EvalSet;
  readonly cases: ReadonlyArray<LoadedCase>;
  readonly afterMerge: AfterMergeKinds;
  /** Each label kind's audited accuracy, flagged under the audit's floor (10.136). */
  readonly kinds: Record<
    string,
    {
      accuracy: number | null;
      interval: [number, number] | null;
      flagged: boolean;
    }
  >;
}

/** A pinned second run's packet; a pinned run that shows none is refused, never skipped. */
const pinnedPacket = (
  file: z.infer<typeof Hashed> | null | undefined,
  caseId: string,
  what: "floor" | "consistency",
) => {
  if (file === undefined || file === null) return null;
  const packet = readableShown(
    checked(file),
    `case ${caseId}'s ${what} run (${file.path})`,
  ).packet;
  if (packet === undefined || packet === null)
    throw new Error(`${file.path} shows no packet`);
  return packet;
};

const checked = (file: z.infer<typeof Hashed>) => {
  const actual = sha256Of(file.path);
  if (actual !== file.sha256)
    throw new Error(
      `${file.path} changed since the set was frozen (${file.sha256.slice(0, 12)} → ${actual.slice(0, 12)})`,
    );
  return file.path;
};

/**
 * A case's `run/<run>/show.json`: beside its pinned packet, or under a run root laid out like the
 * research volume's `cases` (`<source>/<number>/run/<run>/show.json`), such as the `--out` folder
 * of the local runner (`research/pr-bench/replay/local/run_cases.py`).
 */
export const runFileOf = (
  meta: Pick<EvalSetCase, "packet">,
  run: string,
  runRoot?: string | undefined,
) =>
  runRoot === undefined
    ? join(dirname(meta.packet.path), run, "show.json")
    : join(
        runRoot,
        // The pinned packet's `<source>/<number>/run` folder, under the run root.
        ...dirname(meta.packet.path).split("/").slice(-3),
        run,
        "show.json",
      );

/**
 * Loads a frozen set, refusing any file whose hash moved. Held-out cases are read only when asked
 * for, which `heldOutRead` allows once per round.
 */
export const loadEvalSet = (
  path: string,
  options: {
    readonly heldOut?: boolean | undefined;
    /**
     * Read each case's `run/<run>/show.json` (a recompose's output, not pinned) in place of its pinned
     * run, placed with `laneRule`; a case without it is refused.
     */
    readonly run?: string | undefined;
    /** Where `run` is read, when not beside each pinned packet (`runFileOf`). */
    readonly runRoot?: string | undefined;
    readonly laneRule?: LaneRuleVersion | undefined;
    /** Cases left out by ID, as a comparison of recomposes states them (runs recompose refuses). */
    readonly leaveOut?: ReadonlySet<string> | undefined;
  } = {},
): LoadedSet => {
  if (options.runRoot !== undefined && options.run === undefined)
    throw new Error("a run root names where a run is read; name the run too");
  const set = EvalSet.parse(JSON.parse(readFileSync(path, "utf8")));
  const kept = set.cases.filter(
    (entry) =>
      (entry.split !== "held-out" || options.heldOut === true) &&
      options.leaveOut?.has(entry.caseId) !== true,
  );
  const afterMerge = readAfterMerge(
    kept.flatMap((entry) =>
      entry.afterMerge === null ? [] : [checked(entry.afterMerge)],
    ),
  ).kinds;
  const cases = kept.map((meta): LoadedCase => {
    const [evidence] = readEvidence([checked(meta.evidence)]).evidence;
    const runFile =
      options.run === undefined
        ? checked(meta.packet)
        : runFileOf(meta, options.run, options.runRoot);
    if (!existsSync(runFile))
      throw new Error(`${runFile} is missing: every case needs the run`);
    const shown = readableShown(runFile, `case ${meta.caseId} (${runFile})`);
    const concerns = new Map<string, z.infer<typeof ConcernLabel> | null>();
    if (meta.concerns !== null)
      for (const line of readFileSync(checked(meta.concerns), "utf8").split(
        "\n",
      )) {
        if (line.trim() === "") continue;
        const record = ConcernRecord.parse(JSON.parse(line));
        concerns.set(
          record.id,
          record.label ?? (record.agreed ? (record.a ?? null) : null),
        );
      }
    const audited = new Map<string, "right" | "wrong" | "unsure" | null>();
    if (meta.audit !== null)
      for (const item of AuditVerdicts.parse(
        JSON.parse(readFileSync(checked(meta.audit), "utf8")),
      ).items)
        for (const line of item.lines)
          audited.set(`${item.cite}|${line}`, item.verdict);
    return {
      meta,
      evidence: evidence!,
      packet: shown.packet ?? null,
      hunks: hunksOf(shown),
      floorPacket: pinnedPacket(meta.floor, meta.caseId, "floor"),
      laneRule: options.laneRule ?? set.laneRule ?? 1,
      shape: shapeOf(shown),
      consistencyPacket: pinnedPacket(
        meta.consistency,
        meta.caseId,
        "consistency",
      ),
      isPublicEntry: entryAt(
        join(dirname(dirname(meta.evidence.path)), "replay"),
        shown.range?.headOid,
      ),
      concerns,
      audited,
    };
  });
  const report =
    set.auditReport === null
      ? null
      : AuditReport.parse(
          JSON.parse(readFileSync(checked(set.auditReport), "utf8")),
        );
  const kinds = Object.fromEntries(
    Object.entries(report?.byKind ?? {}).map(([kind, entry]) => [
      kind,
      {
        accuracy: entry.accuracy,
        interval: entry.interval,
        flagged: entry.accuracy === null || entry.accuracy < ACCURACY_FLOOR,
      },
    ]),
  );
  return { set, cases, afterMerge, kinds };
};

/**
 * The set's cases a parity sample (10.141) leaves out, by ID: a run of the sample reviews only its
 * cases. A sample naming a case the set has not is refused.
 */
export const outsideSample = (set: EvalSet, samplePath: string) => {
  const sample = JSON.parse(readFileSync(samplePath, "utf8")) as {
    concerns?: ReadonlyArray<string>;
    controls?: ReadonlyArray<string>;
  };
  const ids = new Set([...(sample.concerns ?? []), ...(sample.controls ?? [])]);
  if (ids.size === 0) throw new Error(`${samplePath} names no case`);
  const known = new Set(set.cases.map((entry) => entry.caseId));
  const unknown = [...ids].filter((id) => !known.has(id));
  if (unknown.length > 0)
    throw new Error(
      `${samplePath} names cases the set has not: ${unknown.slice(0, 3).join(", ")}`,
    );
  return set.cases.map((entry) => entry.caseId).filter((id) => !ids.has(id));
};

/** A unit's recorded assessment, as the published record keeps it: what `laneOf` reads. */
export const RecordedAssessment = z.object({
  lane: z.enum([
    "static-automation",
    "agentic",
    "human-suggested",
    "human-required",
  ]),
  quadrant: z.enum(["low-easy", "low-hard", "high-easy", "high-hard"]),
  complexity: z.object({
    level: z.enum(["low", "high"]),
    factors: z.array(z.object({ cites: z.array(z.unknown()) })),
  }),
  easeOfValidation: z.object({
    level: z.enum(["easy", "hard"]),
    requirements: z.array(
      z.object({
        cites: z.array(z.unknown()),
        coverage: z.string(),
        requirement: z.string(),
      }),
    ),
  }),
  lean: z
    .object({
      lane: z.enum(["agentic", "human-suggested"]),
      reason: z.string(),
    })
    .nullable()
    .optional(),
  gaps: z.array(
    z.object({ axis: z.enum(["complexity", "ease-of-validation"]) }),
  ),
});
export type RecordedAssessment = z.infer<typeof RecordedAssessment>;

/** One section of a rule-3 unit as the rule reads it: its stored entry, untouched, and the lines it adds. */
export interface RecordedSection {
  readonly key: string;
  readonly entry: SectionLite;
  readonly added: ReadonlyArray<AddedLine>;
}

/** One published unit as a lane rule sees it. */
export interface RecordedUnit {
  readonly unitId: string;
  /** The unit's stored lane: its assessment's. */
  readonly lane: Lane;
  /** Rules 1 and 2: the unit's recorded assessment, what `laneOf` reads. Null under rule 3. */
  readonly assessment: RecordedAssessment | null;
  /** Rule 3: its sections, each checked against the harness's `recordedLane`; empty otherwise. */
  readonly sectionEntries: ReadonlyArray<RecordedSection>;
  /** How many sections it joins; above one, a candidate that would split it is approximated. */
  readonly sections: number;
  /** The lines its owned new-side ranges add, read by code from the run's hunks. */
  readonly added: ReadonlyArray<AddedLine>;
  /** The package-entry check at its range's head, when the run names a head. */
  readonly isPublicEntry: LaneContext["isPublicEntry"];
  /** The lane rule its run was placed with, which the harness's rule recomputes it by. */
  readonly laneRule: LaneRuleVersion;
}

export type LaneRule = (unit: RecordedUnit) => Lane;

/**
 * `laneOf`'s input from a recorded assessment. Cites are only counted, so their recorded form
 * stands. A record that keeps no lean (it keeps none when the lean was null) gives a high-easy unit's
 * lean back from its lane only when it has no gap: there the lean alone decides the lane, while a
 * gap decides it whatever the lean was.
 */
export const laneInputOf = (assessment: RecordedAssessment) =>
  ({
    complexity: assessment.complexity,
    validation: assessment.easeOfValidation,
    lean:
      assessment.lean ??
      (assessment.quadrant === "high-easy" &&
      assessment.gaps.length === 0 &&
      (assessment.lane === "agentic" || assessment.lane === "human-suggested")
        ? { lane: assessment.lane, reason: "the recorded lane" }
        : null),
    gaps: assessment.gaps,
  }) as unknown as Parameters<typeof laneOf>[0];

/**
 * The harness's lane rule as the unit's run was placed with it: laneOf, and from rule 2 (10.140)
 * the public-surface raise the composition applies, over the unit's own added lines.
 */
export const harnessRule: LaneRule = (unit) => {
  // Rule 3: each section's trail was recomputed and held to the stored one when the unit was read
  // (`recordedUnits`), and every section applies the unit's lane, so the rule gives it back.
  if (unit.laneRule >= 3 || unit.assessment === null) return unit.lane;
  const lane = laneOf(laneInputOf(unit.assessment)).lane;
  return unit.laneRule === 2 ? withPublicSurface(lane, unit.added).lane : lane;
};

const noRule3Candidate = (unit: RecordedUnit, what: string) => {
  if (unit.laneRule >= 3 || unit.assessment === null)
    throw new Error(
      `${what} is not defined per section, so it cannot be applied to unit ${unit.unitId} of a lane rule 3 run`,
    );
  return unit;
};

/** The live lane rule (10.140), applied to any recorded unit as if its run had been placed with it. */
export const liveRule: LaneRule = (unit) =>
  harnessRule({ ...noRule3Candidate(unit, "the live rule 2"), laneRule: 2 });

/** A run a candidate reads must show its manifest hunks, or the candidate measures nothing there. */
export const requireHunks = (
  hunks: ReadonlyArray<unknown>,
  run: string,
  candidate: boolean,
) => {
  if (candidate && hunks.length === 0)
    throw new Error(
      `run ${run} shows no manifest hunks: a candidate that reads added lines cannot be measured on it`,
    );
};

/**
 * The rules a lanes-eval command compares: the harness's own when none is named, else each named
 * candidate. A lane candidate is defined on a unit's assessment, not per section, so naming one on a
 * lane rule 3 set is refused before anything is read.
 */
export const candidatesFor = (
  loaded: LoadedSet,
  names: ReadonlyArray<string>,
) => {
  if (
    names.length > 0 &&
    ((loaded.set.laneRule ?? 1) >= 3 ||
      loaded.cases.some((entry) => entry.shape === "sections"))
  )
    throw new Error(
      "--candidate is refused on a lane rule 3 set: lane candidates are not yet defined per section",
    );
  return names.length === 0
    ? [
        {
          name: "the harness's lane rule, unchanged",
          rule: harnessRule,
          named: false,
        },
      ]
    : names.map((entry) => ({
        name: entry,
        rule: candidateRule(entry),
        named: true,
      }));
};

/** A harness lane candidate by name, applied after the harness's own rule. */
export const candidateRule = (name: string): LaneRule => {
  const candidate = Object.hasOwn(LANE_CANDIDATES, name)
    ? LANE_CANDIDATES[name]
    : undefined;
  if (candidate === undefined)
    throw new Error(
      `no lane candidate ${name}; the harness has ${Object.keys(LANE_CANDIDATES).join(", ") || "none"}`,
    );
  return (unit) =>
    candidate(harnessRule(noRule3Candidate(unit, `lane candidate ${name}`)), {
      added: unit.added,
      isPublicEntry: unit.isPublicEntry,
    });
};

/**
 * A packet's assessed units, as rules read them; a unit with no assessment keeps no lane and is
 * counted apart. The packet goes through the guard first (packets.ts, with the sections shape),
 * named by `where`; an assessment that is there but does not read as its rule's input is refused
 * too, since it would otherwise read as unassessed and never be judged. The stated rule and the
 * record agree: a rule-3 assessment (`assessment.recorded@4`) is read only where rule 3 is stated,
 * and rule 3 reads no other. Under rule 3 every section's stored trail is recomputed with the
 * harness's `recordedLane` and must be the one stored (the identity check, per section).
 */
export const recordedUnits = (
  packet: PacketLite | null,
  hunks: ReadonlyArray<ManifestHunk> = [],
  isPublicEntry: LaneContext["isPublicEntry"] = undefined,
  laneRule: LaneRuleVersion = 1,
  shape: ReviewShape = "older",
  where = "a stored run",
) =>
  packetUnits(packet, { where, reads: READS_SECTIONS }).map(({ unit }) => {
    const refuse = (what: string) =>
      new UnreadableRun(`${where} cannot be read by the eval: ${what}.`);
    const kind = (unit.assessment as { kind?: unknown } | undefined)?.kind;
    if (kind === "assessment.recorded@4") {
      if (laneRule < 3)
        throw refuse(
          `unit ${unit.unitId} records lane rule 3 (assessment.recorded@4), but the run is read as lane rule ${laneRule}; state rule 3`,
        );
      return { unit, recorded: rule3Unit(unit, hunks, isPublicEntry, where) };
    }
    if (laneRule >= 3 && unit.assessment != null)
      throw refuse(
        `unit ${unit.unitId}'s assessment is ${String(kind)}, which holds no sections, but the run is read as lane rule 3`,
      );
    const parsed = RecordedAssessment.safeParse(unit.assessment?.payload);
    if (!parsed.success && unit.assessment != null)
      throw refuse(
        `unit ${unit.unitId}'s assessment does not read as the lane rule's input (${parsed.error.issues[0]?.path.join(".") || "its payload"}: ${parsed.error.issues[0]?.message ?? "invalid"}), so it would read as unassessed`,
      );
    return {
      unit,
      recorded: parsed.success
        ? ({
            unitId: unit.unitId,
            lane: parsed.data.lane,
            assessment: parsed.data,
            sectionEntries: [],
            // A fixed-shape unit's sections are code sections of one proximity unit, not lanes joined.
            sections:
              shape === "fixed"
                ? 1
                : ((unit as { sections?: ReadonlyArray<unknown> }).sections
                    ?.length ?? 1),
            added: addedLines(unit.recorded?.payload.ownedRanges ?? [], hunks),
            isPublicEntry,
            laneRule,
          } satisfies RecordedUnit)
        : null,
    };
  });

/** Two trail fields equal, field by field: a lane, or each floor's rule and lane in order. */
const sameTrailField = (
  field: "judged" | "surfaced" | "floors" | "applied",
  a: LaneTrail,
  b: LaneTrail,
) => {
  if (field !== "floors") return (a[field] ?? null) === (b[field] ?? null);
  const x = a.floors ?? [];
  const y = b.floors ?? [];
  return (
    x.length === y.length &&
    x.every((floor, i) => floor.rule === y[i]!.rule && floor.to === y[i]!.to)
  );
};

const TRAIL_FIELDS = ["judged", "surfaced", "floors", "applied"] as const;

/**
 * One rule-3 unit, read: the guard has held its sections to its lane and its owned lines, so here
 * each section's trail is recomputed by the harness's `recordedLane` from the stored entry and the
 * lines the section adds, and must equal the stored `judged`, `surfaced`, `floors` and `applied`.
 */
const rule3Unit = (
  unit: PacketUnitLite,
  hunks: ReadonlyArray<ManifestHunk>,
  isPublicEntry: LaneContext["isPublicEntry"],
  where: string,
): RecordedUnit => {
  const rule = recordedLane();
  const { lane, laneRule } = (
    unit.assessment as unknown as { payload: { lane: Lane; laneRule: number } }
  ).payload;
  const sections = (unit as unknown as { sections: ReadonlyArray<SectionLite> })
    .sections;
  const sectionEntries = sections.map((entry): RecordedSection => {
    const added = addedLines(entry.ownedRanges, hunks);
    const trail = rule(entry, added);
    for (const field of TRAIL_FIELDS)
      if (!sameTrailField(field, trail, entry.lane))
        throw new Error(
          `${where}: the identity check failed: unit ${unit.unitId}'s section ${entry.key} recomputes ${field} ${JSON.stringify(trail[field] ?? null)} where the run stored ${JSON.stringify(entry.lane[field] ?? null)}`,
        );
    // The second identity check: the floors the section's own floor inputs give, run through the
    // rule in place of the stored ones, must leave exactly the stored floors. So a floor the inputs
    // do not give, or one they give that would raise and is missing, is refused. A run that prints
    // no floor inputs is not checked here, and the sections report says so with a count.
    const inputs = (entry as { floorInputs?: unknown }).floorInputs as
      { facts?: unknown; options?: unknown } | undefined;
    if (inputs !== undefined && inputs !== null) {
      if (
        typeof inputs !== "object" ||
        inputs.facts === null ||
        typeof inputs.facts !== "object" ||
        inputs.options === null ||
        typeof inputs.options !== "object"
      )
        throw new UnreadableRun(
          `${where} cannot be read by the eval: unit ${unit.unitId}'s section ${entry.key} holds floor inputs with no facts or options.`,
        );
      const given = floorsUnder(laneRule, inputs.facts, inputs.options);
      const again = rule(
        { ...entry, lane: { ...entry.lane, floors: given } },
        added,
      );
      if (!sameTrailField("floors", again, entry.lane))
        throw new Error(
          `${where}: the identity check failed: unit ${unit.unitId}'s section ${entry.key}'s floor inputs give floors ${JSON.stringify(again.floors)} where the run stored ${JSON.stringify(entry.lane.floors)}`,
        );
    }
    return { key: entry.key, entry, added };
  });
  return {
    unitId: unit.unitId,
    lane,
    assessment: null,
    sectionEntries,
    sections: sections.length,
    added: addedLines(unit.recorded?.payload.ownedRanges ?? [], hunks),
    isPublicEntry,
    // Rule 5 keeps its own number; its floors are rule 4's (`floorsUnder` gives the finding floor to rule 3 only).
    laneRule: laneRule === 4 || laneRule === 5 ? laneRule : 3,
  };
};

/** A unit whose recomputed lane differs from its stored one. */
export interface Moved {
  readonly caseId: string;
  readonly unit: string;
  readonly title: string;
  readonly from: Lane;
  readonly to: Lane;
  readonly sections: number;
}

/** A case's units with their lanes under a rule, as the replay measures read them. */
export const recompute = (entry: LoadedCase, rule: LaneRule) => {
  const calls: Array<ReplayCall> = [];
  const moved: Array<Moved> = [];
  for (const { unit, recorded } of recordedUnits(
    entry.packet,
    entry.hunks,
    entry.isPublicEntry,
    entry.laneRule,
    entry.shape,
    entry.label ?? `case ${entry.meta.caseId}`,
  )) {
    const title = unit.recorded?.payload.title ?? unit.unitId;
    const lane = recorded === null ? null : rule(recorded);
    if (recorded !== null && lane !== recorded.lane)
      moved.push({
        caseId: entry.meta.caseId,
        unit: unit.unitId,
        title,
        from: recorded.lane,
        to: lane!,
        sections: recorded.sections,
      });
    calls.push({
      unit: unit.unitId,
      title,
      range: entry.meta.range,
      harness: lane,
      lines: [...ownedLineKeys(unit)],
    });
  }
  return { calls, moved };
};

/** The identity check: the harness's rule, recomputed, must give every stored lane. */
export const identity = (cases: ReadonlyArray<LoadedCase>) =>
  cases.flatMap((entry) => recompute(entry, harnessRule).moved);

const ratio = (part: number, whole: number) =>
  whole === 0 ? null : Math.round((part / whole) * 1_000) / 1_000;

/** The measures a candidate is judged by, per era and split (never pooled). */
export const keyMeasures = (
  measures: ReturnType<typeof replayMeasures>,
  calls: ReadonlyArray<ReplayCall>,
  cases: ReadonlyArray<LoadedCase>,
) =>
  Object.fromEntries(
    Object.entries(measures).flatMap(([era, splits]) =>
      Object.entries(splits).map(([split, m]) => {
        const ranges = new Set(
          cases
            .filter((c) => c.meta.era === era && c.meta.split === split)
            .map((c) => c.meta.range),
        );
        const assessed = calls.filter(
          (call) => ranges.has(call.range) && call.harness !== null,
        );
        const thread = m.escalationRecall.byOrigin["thread"];
        return [
          `${era} ${split}`,
          {
            threadUnitsRequired: thread?.units.required ?? null,
            threadUnitsSuggestedOrHigher:
              thread?.units.suggestedOrHigher ?? null,
            unitsRequired: m.escalationRecall.units.required,
            unitsSuggestedOrHigher: m.escalationRecall.units.suggestedOrHigher,
            overEscalatedUnits: m.overEscalation.units.share,
            ...Object.fromEntries(
              Object.entries(m.controls).map(([kind, c]) => [
                `controls ${kind}`,
                c.suggestedOrHigher,
              ]),
            ),
            sentToPerson: ratio(
              assessed.filter(
                (call) =>
                  call.harness === "human-required" ||
                  call.harness === "human-suggested",
              ).length,
              assessed.length,
            ),
          } as Record<string, number | null>,
        ];
      }),
    ),
  );

/** Measures where a rise is the candidate's aim; every other key must not rise. */
const AIMS = new Set([
  "threadUnitsSuggestedOrHigher",
  "threadUnitsRequired",
  // Per line, rated only when two runs of different shapes are compared (`lineKeyMeasures`).
  "threadLinesSuggestedOrHigher",
  "threadLinesRequired",
]);
/**
 * Measures reported beside the verdict and never gating it: recall over every origin tracks the aim
 * itself, and a rule that raises lanes always sends more to a person. The guard on noise is
 * over-escalation per unit and the controls (10.128), and the owner's desk guard.
 */
const ALONGSIDE = new Set([
  "unitsRequired",
  "unitsSuggestedOrHigher",
  "sentToPerson",
  "linesRequired",
  "linesSuggestedOrHigher",
  "lineAgreement",
]);

/**
 * The key measures counted per line, which mean the same whatever a unit holds, so two runs of
 * different shapes are rated on these alone: thread-backed needs-a-person lines kept with a person
 * (the aims), all needs-a-person lines and lines in their lane (beside), and agent-catchable and
 * mechanical lines sent to human-required (the guard, which must not rise).
 */
export const lineKeyMeasures = (measures: ReturnType<typeof replayMeasures>) =>
  Object.fromEntries(
    Object.entries(measures).flatMap(([era, splits]) =>
      Object.entries(splits).map(([split, m]) => [
        `${era} ${split}`,
        {
          threadLinesRequired:
            m.escalationRecall.byOrigin["thread"]?.required ?? null,
          threadLinesSuggestedOrHigher:
            m.escalationRecall.byOrigin["thread"]?.suggestedOrHigher ?? null,
          linesRequired: m.escalationRecall.required,
          linesSuggestedOrHigher: m.escalationRecall.suggestedOrHigher,
          overEscalatedLines: m.overEscalation.required,
          lineAgreement: m.lineAgreement.share,
        } as Record<string, number | null>,
      ]),
    ),
  );

/** A set's runs as one shape for comparison: the sections shape, or today's (older or fixed). */
const armShape = (loaded: LoadedSet) =>
  loaded.cases.some((entry) => entry.shape === "sections")
    ? "sections"
    : "today";

/**
 * What a sections-shape run reports beside its measures, counts only: sections no agent decided,
 * per cause as the run names them (an open set) with the lines they own, and the same from the
 * units' own counts (`assessment.payload.sections.undecided`), which must agree; sections a floor
 * raised, per floor rule; and units and lines in human-suggested whose sections record a gap,
 * apart from those whose sections record none. Null for a set with no sections-shape case.
 */
export const sectionsReport = (cases: ReadonlyArray<LoadedCase>) => {
  const read = cases.filter((entry) => entry.shape === "sections");
  if (read.length === 0) return null;
  const undecided: Record<string, { sections: number; lines: number }> = {};
  // Excluded files, by the reason the run names (an open set): human-suggested, not the backstop.
  const excluded: Record<string, { sections: number; lines: number }> = {};
  let noFloorInputs = 0;
  const stated: Record<string, number> = {};
  const raised: Record<string, number> = {};
  const suggested = {
    withGap: { units: 0, lines: 0 },
    withoutGap: { units: 0, lines: 0 },
  };
  let units = 0;
  let sections = 0;
  for (const entry of read)
    for (const { unit } of packetUnits(entry.packet, {
      where: entry.label ?? `case ${entry.meta.caseId}`,
      reads: READS_SECTIONS,
    })) {
      const assessment = unit.assessment as
        | {
            kind?: string;
            payload: {
              lane: Lane;
              sections?: { undecided?: Record<string, number> };
            };
          }
        | undefined;
      if (assessment?.kind !== "assessment.recorded@4") continue;
      units++;
      const held = (unit as unknown as { sections: ReadonlyArray<SectionLite> })
        .sections;
      for (const section of held) {
        sections++;
        const cause = section.undecided?.cause;
        if (cause !== undefined) {
          const row = (undecided[cause] ??= { sections: 0, lines: 0 });
          row.sections++;
          row.lines += rangeLineKeys(section.ownedRanges).size;
        }
        const reason = section.excluded?.reason;
        if (reason !== undefined) {
          const row = (excluded[reason] ??= { sections: 0, lines: 0 });
          row.sections++;
          row.lines += rangeLineKeys(section.ownedRanges).size;
        }
        if (section.floorInputs === undefined || section.floorInputs === null)
          noFloorInputs++;
        for (const rule of new Set(section.lane.floors.map((f) => f.rule)))
          raised[rule] = (raised[rule] ?? 0) + 1;
      }
      for (const [cause, n] of Object.entries(
        assessment.payload.sections?.undecided ?? {},
      ))
        if (n > 0) stated[cause] = (stated[cause] ?? 0) + n;
      if (assessment.payload.lane === "human-suggested") {
        const gap = held.some(
          (section) => (section.assess?.gaps?.length ?? 0) > 0,
        );
        const row = gap ? suggested.withGap : suggested.withoutGap;
        row.units++;
        row.lines += ownedLineKeys(unit).size;
      }
    }
  // The guard has held each unit's counts to its sections, so the two totals agree here.
  const causes = [
    ...new Set([...Object.keys(undecided), ...Object.keys(stated)]),
  ].sort();
  return {
    cases: read.length,
    units,
    sections,
    undecided: Object.fromEntries(causes.map((c) => [c, undecided[c]!])),
    unitsCountUndecided: Object.fromEntries(causes.map((c) => [c, stated[c]!])),
    excluded: Object.fromEntries(
      Object.keys(excluded)
        .sort()
        .map((reason) => [reason, excluded[reason]!]),
    ),
    raised,
    // Never read as checked: the sections whose floors were not held to their floor inputs.
    floorsNotChecked:
      noFloorInputs === 0
        ? null
        : { sections: noFloorInputs, note: FLOORS_NOT_CHECKED },
    humanSuggested: suggested,
  };
};

/** The sections report in plain lines; none for a run of today's shapes. */
export const describeSections = (
  arm: string,
  report: ReturnType<typeof sectionsReport>,
) =>
  report === null
    ? []
    : [
        `Sections in the ${arm} (${report.units} unit(s), ${report.sections} section(s)): not decided by an agent, so human-required, ${
          Object.entries(report.undecided)
            .map(
              ([cause, row]) =>
                `${cause} ${row.sections} (${row.lines} line(s))`,
            )
            .join(", ") || "none"
        }; raised by a floor ${
          Object.entries(report.raised)
            .map(([rule, n]) => `${rule} ${n}`)
            .join(", ") || "none"
        }.`,
        `  Human-suggested with a gap in a section: ${report.humanSuggested.withGap.units} unit(s), ${report.humanSuggested.withGap.lines} line(s); without: ${report.humanSuggested.withoutGap.units} unit(s), ${report.humanSuggested.withoutGap.lines} line(s).`,
        `  Excluded files, human-suggested and not counted as undecided: ${
          Object.entries(report.excluded)
            .map(
              ([reason, row]) =>
                `${reason} ${row.sections} (${row.lines} line(s))`,
            )
            .join(", ") || "none"
        }.`,
        ...(report.floorsNotChecked === null
          ? []
          : [
              `  ${report.floorsNotChecked.note} (${report.floorsNotChecked.sections} section(s)).`,
            ]),
      ];

/** Each aim key and the count of kept units it reads. */
const AIM_COUNTS = {
  threadUnitsSuggestedOrHigher: "suggestedOrHigher",
  threadUnitsRequired: "required",
} as const;
type AimKey = keyof typeof AIM_COUNTS;

/** How an aim is judged in one group: the bar scaled to its size, and the case bootstrap's interval. */
export interface AimJudge {
  /** Thread-backed units in the group: the aim's denominator. */
  readonly n: number;
  /** The floor's unit flip rate between two runs, and where it was measured. */
  readonly f: number | null;
  readonly fFrom: string | null;
  /** 1.96 × √(f / n): how far the aim moves by the run-to-run noise alone, at 95%. */
  readonly bar: number | null;
  /** The paired case bootstrap's 95% interval for the aim's delta; null with no thread unit. */
  readonly interval: readonly [number, number] | null;
}

/**
 * Candidate against baseline, per era and split. The aim (thread-backed recall per unit) keeps when
 * its delta clears the bar scaled to the group's size and the case bootstrap's 95% interval
 * excludes 0; it blocks when it falls beyond the bar (any fall, with no bar). The guards
 * (over-escalation per unit and each control kind, 10.128) must not rise at all: baseline and
 * candidate are read from the same stored runs, so any rise is the candidate's. A guard with no
 * baseline value rises when the candidate gives it one. The raw floor (how far each measure moved
 * between two runs) is shown beside every row and decides nothing. Group verdicts: `keep`, `no
 * gain`, `blocked` (a guard rose, or the aim fell beyond the bar), `no floor` (no aim has a bar).
 */
export const compare = (
  baseline: ReturnType<typeof keyMeasures>,
  candidate: ReturnType<typeof keyMeasures>,
  floor: ReturnType<typeof keyMeasures> | null,
  aims: Readonly<Record<string, Partial<Record<AimKey, AimJudge>>>> = {},
) =>
  Object.fromEntries(
    [...new Set([...Object.keys(baseline), ...Object.keys(candidate)])].map(
      (group) => {
        const base = baseline[group] ?? {};
        const next = candidate[group] ?? {};
        const judgedBy = floorFor(floor, group);
        const noise = judgedBy?.values;
        const keys = Object.fromEntries(
          [...new Set([...Object.keys(base), ...Object.keys(next)])].map(
            (key) => {
              const value = base[key] ?? null;
              const after = next[key] ?? null;
              const delta =
                value === null || after === null
                  ? null
                  : Math.round((after - value) * 1_000) / 1_000;
              return [
                key,
                {
                  baseline: value,
                  candidate: after,
                  delta,
                  floor: noise?.[key] ?? null,
                  judge: aims[group]?.[key as AimKey] ?? null,
                },
              ];
            },
          ),
        );
        const rows = Object.entries(keys);
        const aimed = rows.filter(([key]) => AIMS.has(key));
        const guarded = rows.filter(
          ([key]) => !AIMS.has(key) && !ALONGSIDE.has(key),
        );
        const rose = guarded.some(
          ([, row]) =>
            (row.delta !== null && row.delta > 0) ||
            (row.baseline === null &&
              row.candidate !== null &&
              row.candidate > 0),
        );
        const fell = aimed.some(
          ([, row]) =>
            row.delta !== null &&
            row.delta < 0 &&
            (row.judge?.bar == null || -row.delta > row.judge.bar),
        );
        const earned = aimed
          .filter(
            ([, row]) =>
              row.delta !== null &&
              row.judge?.bar != null &&
              row.delta > row.judge.bar &&
              row.judge.interval !== null &&
              row.judge.interval[0] > 0,
          )
          .map(([key]) => key as AimKey);
        const gained = earned.length > 0;
        const verdict =
          rose || fell
            ? "blocked"
            : aimed.every(([, row]) => row.judge?.bar == null)
              ? "no floor"
              : gained
                ? "keep"
                : "no gain";
        return [
          group,
          {
            verdict,
            floorFrom: judgedBy?.from ?? null,
            // The aims whose gain earned a keep: run consistency checks each of them.
            earned: verdict === "keep" ? earned : [],
            keys,
          },
        ];
      },
    ),
  );

/**
 * The candidate's verdict over the set: blocked by the owner's desk guard or by any group's guard,
 * kept when some group gains and none is blocked. Run consistency is a sanity check on each aim that
 * earned a keep, not a gate with power: it blocks the keep only when that gain clearly disappears
 * (it falls back on most of the cases run twice), and an aim it could not test (no case gains on it)
 * gives no verdict, never a keep. Without the owner's guard read, there is none.
 */
export const overallVerdict = (
  comparison: ReturnType<typeof compare>,
  owner: { readonly guard: { readonly holds: boolean } } | null,
  consistency: {
    readonly byAim: Readonly<
      Record<AimKey, { readonly cases: number; readonly gone: boolean }>
    >;
  } | null = null,
) => {
  const groups = Object.values(comparison).map((group) => group.verdict);
  if (owner !== null && !owner.guard.holds) return "do not keep";
  if (groups.includes("blocked")) return "do not keep";
  if (owner === null) return "no verdict: the owner's guard was not read";
  if (!groups.includes("keep"))
    return groups.includes("no gain") ? "no gain" : "no floor";
  if (consistency === null)
    return "no verdict: no second run was read for run consistency";
  const earned = [
    ...new Set(Object.values(comparison).flatMap((group) => group.earned)),
  ];
  if (earned.some((aim) => consistency.byAim[aim].gone))
    return "not kept: its gain falls back on most of the cases run twice";
  if (earned.some((aim) => consistency.byAim[aim].cases === 0))
    return "no verdict: run consistency untested, since the candidate gains nothing to repeat on the cases run twice";
  return "keep";
};

/** One case's thread-backed units, and how many of them a rule's lanes keep at each aim. */
const threadCounts = (
  entry: LoadedCase,
  calls: ReadonlyArray<ReplayCall>,
  afterMerge: AfterMergeKinds,
) => {
  const units = replayMeasures(calls, [entry.evidence], {
    afterMerge,
    heldOut: true,
  })[entry.meta.era]?.[entry.meta.split]?.escalationRecall.byOrigin["thread"]
    ?.units;
  return {
    units: units?.units ?? 0,
    required: units?.kept.required ?? 0,
    suggestedOrHigher: units?.kept.suggestedOrHigher ?? 0,
  };
};

/** One case read under the baseline and the candidate: the bootstrap's sampling unit. */
export interface PairedCase {
  readonly group: string;
  readonly units: number;
  /**
   * The candidate's thread-backed units, where its run's units differ from the baseline's (two runs
   * compared, a split giving more); absent, the baseline's count.
   */
  readonly unitsNext?: number | undefined;
  readonly base: {
    readonly required: number;
    readonly suggestedOrHigher: number;
  };
  readonly next: {
    readonly required: number;
    readonly suggestedOrHigher: number;
  };
}

const pairedCase = (
  entry: LoadedCase,
  packet: PacketLite | null,
  rule: LaneRule,
  afterMerge: AfterMergeKinds,
  label?: string,
): PairedCase => {
  // A floor case's second run is of the same range, so the first run's hunks are its hunks too.
  const run = { ...entry, packet, ...(label === undefined ? {} : { label }) };
  const base = threadCounts(run, recompute(run, harnessRule).calls, afterMerge);
  const next = threadCounts(run, recompute(run, rule).calls, afterMerge);
  return {
    group: `${entry.meta.era} ${entry.meta.split}`,
    units: base.units,
    base,
    next,
  };
};

export const BOOTSTRAP_DRAWS = 2_000;
export const LANES_BOOTSTRAP_SEED = "neuve-lanes-eval-v1";
/** An era's own flip rate needs this many matched units; below it the pooled rate is used. */
export const MIN_MATCHED_UNITS = 30;

/**
 * The aim's delta over some cases: the candidate's share of thread-backed units kept less the
 * baseline's, each over its own units (the same units when one run is read under two rules); null
 * with none.
 */
const aimDelta = (cases: ReadonlyArray<PairedCase>, key: AimKey) => {
  const count = AIM_COUNTS[key];
  const units = cases.reduce((sum, entry) => sum + entry.units, 0);
  const unitsNext = cases.reduce(
    (sum, entry) => sum + (entry.unitsNext ?? entry.units),
    0,
  );
  if (units === 0 || unitsNext === 0) return null;
  const kept = (side: "base" | "next") =>
    cases.reduce((sum, entry) => sum + entry[side][count], 0);
  return (
    Math.round((kept("next") / unitsNext - kept("base") / units) * 1_000) /
    1_000
  );
};

/**
 * The paired case bootstrap: a group's cases resampled with replacement, each draw reading the
 * candidate and the baseline on the same cases, so the interval is the delta's own. Seeded per
 * group and aim, so a group's interval does not depend on which other groups were read.
 */
export const pairedInterval = (
  cases: ReadonlyArray<PairedCase>,
  key: AimKey,
  seed = LANES_BOOTSTRAP_SEED,
  draws = BOOTSTRAP_DRAWS,
): readonly [number, number] | null => {
  if (cases.length === 0 || cases.every((entry) => entry.units === 0))
    return null;
  const next = random(`${seed}:${cases[0]!.group}:${key}`);
  const deltas: Array<number> = [];
  for (let draw = 0; draw < draws; draw++) {
    const drawn = Array.from(
      { length: cases.length },
      () =>
        cases[Math.min(cases.length - 1, Math.floor(next() * cases.length))]!,
    );
    const delta = aimDelta(drawn, key);
    // A draw of cases with no thread-backed unit has no recall to move.
    if (delta !== null) deltas.push(delta);
  }
  if (deltas.length === 0) return null;
  deltas.sort((a, b) => a - b);
  return [
    Math.round(quantile(deltas, 0.025) * 1_000) / 1_000,
    Math.round(quantile(deltas, 0.975) * 1_000) / 1_000,
  ];
};

/**
 * The flip rate a group is judged by: its era's, measured on the floor cases, where at least
 * `MIN_MATCHED_UNITS` units matched between the two runs, else the rate pooled over every floor case.
 */
export const flipRateFor = (
  flips: ReturnType<typeof noiseFloor>["flips"] | null,
  group: string,
) => {
  if (flips === null) return null;
  const era = group.slice(0, group.lastIndexOf(" "));
  const own = flips.byEra[era];
  const [from, counted] =
    own !== undefined && own.matched >= MIN_MATCHED_UNITS
      ? [era, own]
      : [POOLED, flips.pooled];
  return counted.matched === 0
    ? null
    : {
        from,
        f: Math.round((counted.flipped / counted.matched) * 1_000) / 1_000,
      };
};

/** Each group's aim judges: n, f and the scaled bar, and the bootstrap interval. */
export const aimJudges = (
  paired: ReadonlyArray<PairedCase>,
  flips: ReturnType<typeof noiseFloor>["flips"] | null,
) =>
  Object.fromEntries(
    [...new Set(paired.map((entry) => entry.group))].map((group) => {
      const cases = paired.filter((entry) => entry.group === group);
      const n = cases.reduce((sum, entry) => sum + entry.units, 0);
      const rate = flipRateFor(flips, group);
      const bar =
        rate === null || n === 0
          ? null
          : Math.round(1.96 * Math.sqrt(rate.f / n) * 1_000) / 1_000;
      return [
        group,
        Object.fromEntries(
          (Object.keys(AIM_COUNTS) as Array<AimKey>).map((key) => [
            key,
            {
              n,
              f: rate?.f ?? null,
              fFrom: rate?.from ?? null,
              bar,
              interval: pairedInterval(cases, key),
            } satisfies AimJudge,
          ]),
        ),
      ];
    }),
  ) as Record<string, Record<AimKey, AimJudge>>;

/**
 * Run consistency: the candidate's aim delta on cases run twice (the floor's cases and those pinned
 * for consistency alone), read on their stored run and on their second run, per era and pooled.
 * Per aim it counts the cases where the candidate moves thread-backed units on the stored run, the
 * moves judged, and in how many of those cases it still moves some on the second run; the gain
 * falls back (`gone`) when it repeats in fewer than half of them. A sanity check over few moves,
 * not a test with power: it blocks a keep only on that clear fall-back.
 */
export const runConsistency = (
  loaded: LoadedSet,
  rule: LaneRule,
  seconds: ReadonlyArray<{
    readonly range: string;
    readonly packet: PacketLite | null;
    /** What a refusal calls this second run: its file, where it was read from one. */
    readonly label?: string | undefined;
  }>,
) => {
  const byRange = new Map(
    loaded.cases.map((entry) => [entry.meta.range, entry]),
  );
  const ranges = seconds.map(({ range }) => range);
  const twice = ranges.find((range, index) => ranges.indexOf(range) !== index);
  if (twice !== undefined)
    throw new Error(
      `run consistency names ${twice} more than once; one second run per case`,
    );
  const runs = seconds.map(({ range, packet, label }) => {
    const entry = byRange.get(range);
    if (entry === undefined)
      throw new Error(`the floor's run of ${range} is not a case of this set`);
    return {
      first: pairedCase(entry, entry.packet, rule, loaded.afterMerge),
      second: pairedCase(
        entry,
        packet,
        rule,
        loaded.afterMerge,
        label ?? `case ${entry.meta.caseId}'s second run`,
      ),
      era: entry.meta.era,
    };
  });
  const read = (of: typeof runs) =>
    Object.fromEntries(
      (Object.keys(AIM_COUNTS) as Array<AimKey>).map((key) => [
        key,
        {
          first: aimDelta(
            of.map((run) => run.first),
            key,
          ),
          second: aimDelta(
            of.map((run) => run.second),
            key,
          ),
          units: {
            first: of.reduce((sum, run) => sum + run.first.units, 0),
            second: of.reduce((sum, run) => sum + run.second.units, 0),
          },
        },
      ]),
    ) as Record<
      AimKey,
      {
        first: number | null;
        second: number | null;
        units: { first: number; second: number };
      }
    >;
  const pooled = read(runs);
  return {
    cases: runs.length,
    pooled,
    byEra: Object.fromEntries(
      [...new Set(runs.map((run) => run.era))]
        .sort()
        .map((era) => [era, read(runs.filter((run) => run.era === era))]),
    ),
    byAim: Object.fromEntries(
      (Object.keys(AIM_COUNTS) as Array<AimKey>).map((key) => {
        const count = AIM_COUNTS[key];
        const gain = (paired: PairedCase) =>
          paired.next[count] - paired.base[count];
        // The cases where the candidate moves thread-backed units on the stored run, and whether
        // it still moves some on the second run of each.
        const moving = runs.filter((run) => gain(run.first) > 0);
        const repeated = moving.filter((run) => gain(run.second) > 0).length;
        return [
          key,
          {
            cases: moving.length,
            moves: moving.reduce((sum, run) => sum + gain(run.first), 0),
            repeated,
            gone: moving.length > 0 && repeated * 2 < moving.length,
          },
        ];
      }),
    ) as Record<
      AimKey,
      { cases: number; moves: number; repeated: number; gone: boolean }
    >,
  };
};

/** The floor's group of every floor case, whatever its era and split. */
export const POOLED = "pooled";

/**
 * Which floor a group is judged against. The floor is the harness's run-to-run noise, measured on
 * development cases: a group takes its own when the floor has it (a held-out group has one only if
 * held-out second runs were given), else its era's development floor (so a round's end is judged
 * too), else the floor pooled over every floor case, usually the lowest bar since it spans the most
 * cases. The fallback is per group, not per measure.
 */
export const floorFor = (
  floor: ReturnType<typeof keyMeasures> | null,
  group: string,
) => {
  if (floor === null) return null;
  const era = group.slice(0, group.lastIndexOf(" "));
  for (const [from, values] of [
    [group, floor[group]],
    [`${era} development`, floor[`${era} development`]],
    [POOLED, floor[POOLED]],
  ] as const)
    if (values !== undefined) return { from, values };
  return null;
};

/**
 * The noise floor from two runs of the same cases: per era and split, how far each key measure
 * moved between them, with the line-by-line agreement of their lanes.
 */
export const noiseFloor = (
  loaded: LoadedSet,
  seconds: ReadonlyArray<{
    readonly range: string;
    readonly packet: PacketLite | null;
    /** What a refusal calls this second run: its file, where it was read from one. */
    readonly label?: string | undefined;
  }>,
) => {
  const byRange = new Map(
    loaded.cases.map((entry) => [entry.meta.range, entry]),
  );
  const ranges = seconds.map(({ range }) => range);
  const twice = ranges.filter(
    (range, index) => ranges.indexOf(range) !== index,
  );
  if (twice.length > 0)
    throw new Error(
      `the floor names ${[...new Set(twice)].join(", ")} more than once; one second run per case`,
    );
  const firsts = seconds.map(({ range }) => {
    const entry = byRange.get(range);
    if (entry === undefined)
      throw new Error(`the floor's run of ${range} is not a case of this set`);
    return entry;
  });
  const asCase = (
    entry: LoadedCase,
    packet: PacketLite | null,
    label: string | undefined,
  ): LoadedCase => ({
    ...entry,
    packet,
    label: label ?? `case ${entry.meta.caseId}'s floor run`,
  });
  const run = (cases: ReadonlyArray<LoadedCase>) => {
    const calls = cases.flatMap((entry) => recompute(entry, harnessRule).calls);
    return {
      calls,
      key: keyMeasures(
        replayMeasures(
          calls,
          cases.map((entry) => entry.evidence),
          // Held-out cases are in the set only when --final read them.
          { afterMerge: loaded.afterMerge, heldOut: true },
        ),
        calls,
        cases,
      ),
    };
  };
  const againsts = firsts.map((entry, index) =>
    asCase(entry, seconds[index]!.packet, seconds[index]!.label),
  );
  // The second runs are recomputed too, so they must pass the same identity check.
  const wrong = identity(againsts);
  if (wrong.length > 0)
    throw new Error(
      `the floor's second run of ${wrong[0]!.caseId} recomputes ${wrong.length} lane(s) away from its stored ones`,
    );
  // Every floor case as one group too: the fallback for a group whose era has no floor case.
  const pooled = (cases: ReadonlyArray<LoadedCase>) =>
    cases.map((entry) => ({
      ...entry,
      meta: { ...entry.meta, era: POOLED, split: POOLED },
      evidence: { ...entry.evidence, era: POOLED, split: POOLED },
    })) as unknown as ReadonlyArray<LoadedCase>;
  const rename = (key: ReturnType<typeof keyMeasures>) =>
    Object.fromEntries(
      Object.entries(key).map(([group, values]) => [
        group === `${POOLED} ${POOLED}` ? POOLED : group,
        values,
      ]),
    );
  const first = run(firsts);
  const second = run(againsts);
  const firstKey = { ...first.key, ...rename(run(pooled(firsts)).key) };
  const secondKey = { ...second.key, ...rename(run(pooled(againsts)).key) };
  const moved = Object.fromEntries(
    Object.entries(firstKey).map(([group, values]) => [
      group,
      Object.fromEntries(
        Object.entries(values).map(([key, value]) => {
          const other = secondKey[group]?.[key] ?? null;
          return [
            key,
            value === null || other === null
              ? null
              : Math.round(Math.abs(value - other) * 1_000) / 1_000,
          ];
        }),
      ),
    ]),
  );
  const asLane = (calls: ReadonlyArray<ReplayCall>): Array<LaneCall> =>
    calls.map((call) => ({ ...call, owner: null }));
  // Unit flips: a first-run unit is matched when the second run assesses any of its lines, and it
  // flips when the lane holding most of those lines there is not its own. A tie with another lane
  // counts as a flip: a higher rate only raises the bar.
  const flipsOf = (cases: ReadonlyArray<LoadedCase>) => {
    let matched = 0;
    let flipped = 0;
    for (const entry of cases) {
      const index = firsts.indexOf(entry);
      const laneThere = new Map<string, Lane>();
      for (const call of recompute(againsts[index]!, harnessRule).calls)
        if (call.harness !== null)
          for (const line of call.lines) laneThere.set(line, call.harness);
      for (const call of recompute(entry, harnessRule).calls) {
        if (call.harness === null) continue;
        const counts = new Map<Lane, number>();
        for (const line of call.lines) {
          const lane = laneThere.get(line);
          if (lane !== undefined) counts.set(lane, (counts.get(lane) ?? 0) + 1);
        }
        if (counts.size === 0) continue;
        matched++;
        const most = Math.max(...counts.values());
        const top = [...counts].filter(([, count]) => count === most);
        if (top.length > 1 || top[0]![0] !== call.harness) flipped++;
      }
    }
    return { matched, flipped };
  };
  return {
    cases: firsts.length,
    agreement: runAgreement(asLane(first.calls), asLane(second.calls)),
    moved,
    flips: {
      byEra: Object.fromEntries(
        [...new Set(firsts.map((entry) => entry.meta.era))]
          .sort()
          .map((era) => [
            era,
            flipsOf(firsts.filter((entry) => entry.meta.era === era)),
          ]),
      ) as Record<string, { matched: number; flipped: number }>,
      pooled: flipsOf(firsts),
    },
  };
};

/** The second runs pinned for run consistency only, in the shape `runConsistency` takes. */
export const pinnedConsistency = (loaded: LoadedSet) =>
  loaded.cases.flatMap((entry) =>
    entry.consistencyPacket === null
      ? []
      : [
          {
            range: entry.meta.range,
            packet: entry.consistencyPacket,
            label: `case ${entry.meta.caseId}'s consistency run (${entry.meta.consistency?.path})`,
          },
        ],
  );

/** The floor's second runs pinned with the set, as `noiseFloor` takes them. */
export const pinnedFloor = (loaded: LoadedSet) =>
  loaded.cases.flatMap((entry) =>
    entry.floorPacket === null
      ? []
      : [
          {
            range: entry.meta.range,
            packet: entry.floorPacket,
            label: `case ${entry.meta.caseId}'s floor run (${entry.meta.floor?.path})`,
          },
        ],
  );

/**
 * The owner's desk key under a rule: a lanes round's runs as published now, their lanes recomputed,
 * judged line by line against the owner's carried key and units (10.123's guard). A run shown
 * again may be a later publication of its range, with new unit ids, so the guard reads lines, never
 * the round's unit ids.
 */
export const ownerGuard = (
  round: string,
  rule: LaneRule,
  options: {
    readonly repository?: string | undefined;
    /** The rule is a candidate that reads added lines, so every run must show its hunks. */
    readonly candidate?: boolean | undefined;
    /** The lane rule the round's desk runs were placed with; each run is checked against it. */
    readonly laneRule?: LaneRuleVersion | undefined;
  } = {},
) => {
  const file = JSON.parse(
    readFileSync(join(LANES_RESULTS, `${round}.json`), "utf8"),
  ) as {
    source: {
      reviews?: ReadonlyArray<{ run: string; range: string }>;
      run?: string;
      range?: string;
    };
  };
  const reviews =
    file.source.reviews ??
    (file.source.run === undefined || file.source.range === undefined
      ? []
      : [{ run: file.source.run, range: file.source.range }]);
  if (reviews.length === 0) throw new Error(`${round} names no desk run`);
  const repo = ["--repo", options.repository ?? "."];
  const runs = reviews.map(({ run, range }) =>
    ownerRunUnits(
      shownRun(undefined, run, repo, READS_SECTIONS) as Parameters<
        typeof ownerRunUnits
      >[0],
      run,
      range,
      rule,
      {
        repository: options.repository ?? ".",
        candidate: options.candidate === true,
        laneRule: options.laneRule,
      },
    ),
  );
  const calls = runs.flatMap((entry) => entry.calls);
  const moved = runs.reduce((sum, entry) => sum + entry.moved, 0);
  const measured = laneMeasures(
    calls,
    carriedKey(undefined),
    carriedOwnerUnits(undefined),
  );
  return {
    round,
    units: calls.length,
    moved,
    guard: measured.guard,
    sentToPerson: measured.sentToPerson,
    lineAgreement: measured.lineAgreement,
    entryTruncated: runs.flatMap((entry) => entry.truncated),
  };
};

/**
 * A candidate against the set's development cases (and held-out only when asked for): the stored
 * lanes as the baseline, the candidate's recomputed, both measured on the replay key.
 */
export const evaluateCandidate = (
  loaded: LoadedSet,
  candidate: LaneRule,
  options: {
    readonly floor?: ReturnType<typeof noiseFloor> | undefined;
    /** The second runs run consistency reads: the floor's and those pinned for it alone. */
    readonly seconds?:
      | ReadonlyArray<{
          readonly range: string;
          readonly packet: PacketLite | null;
          readonly label?: string | undefined;
        }>
      | undefined;
  } = {},
) => {
  const wrong = identity(loaded.cases);
  if (wrong.length > 0)
    throw new Error(
      `the identity check failed: the harness's rule, recomputed, moves ${wrong.length} stored lane(s), first ${wrong[0]!.caseId} ${wrong[0]!.unit} (${wrong[0]!.from} → ${wrong[0]!.to}); a candidate goes after laneOf, not into it`,
    );
  const evidence = loaded.cases.map((entry) => entry.evidence);
  const measured = { afterMerge: loaded.afterMerge, heldOut: true };
  const base = loaded.cases.flatMap(
    (entry) => recompute(entry, harnessRule).calls,
  );
  const next = loaded.cases.map((entry) => recompute(entry, candidate));
  const nextCalls = next.flatMap((entry) => entry.calls);
  const entryTruncated = truncatedEntries(loaded.cases);
  const moved = next.flatMap((entry) => entry.moved);
  const baseline = keyMeasures(
    replayMeasures(base, evidence, measured),
    base,
    loaded.cases,
  );
  const candidateMeasures = keyMeasures(
    replayMeasures(nextCalls, evidence, measured),
    nextCalls,
    loaded.cases,
  );
  const paired = loaded.cases.map((entry) =>
    pairedCase(entry, entry.packet, candidate, loaded.afterMerge),
  );
  const aims = aimJudges(paired, options.floor?.flips ?? null);
  const consistency =
    options.seconds === undefined || options.seconds.length === 0
      ? null
      : runConsistency(loaded, candidate, options.seconds);
  return {
    set: loaded.set.name,
    cases: loaded.cases.length,
    moved,
    // Joined units a candidate moved: their split shows only on a rerun from the stored stages.
    joined: moved.filter((entry) => entry.sections > 1).length,
    entryTruncated,
    flaggedKinds: Object.entries(loaded.kinds)
      .filter(([, kind]) => kind.flagged)
      .map(([kind]) => kind),
    comparison: compare(
      baseline,
      candidateMeasures,
      options.floor?.moved ?? null,
      aims,
    ),
    consistency,
    replay: replayMeasures(nextCalls, evidence, measured),
    sections: sectionsReport(loaded.cases),
  };
};

/**
 * Two runs of the same cases compared (10.140's ship gate): a baseline recompose and a candidate's,
 * each checked against its own lane rule (every stored lane recomputes), then the key measures,
 * the aim judged by the scaled bar on the baseline's thread-backed units and the paired case
 * bootstrap over each run's own share. A candidate that splits units changes the unit counts, so
 * the shares are each over their own units.
 */
export const compareRuns = (
  base: LoadedSet,
  next: LoadedSet,
  floor: ReturnType<typeof noiseFloor> | null,
) => {
  const ranges = (loaded: LoadedSet) =>
    loaded.cases
      .map((entry) => entry.meta.range)
      .sort()
      .join(" ");
  if (ranges(base) !== ranges(next))
    throw new Error("the two runs are not of the same cases");
  for (const [arm, loaded] of [
    ["baseline", base],
    ["candidate", next],
  ] as const) {
    const wrong = identity(loaded.cases);
    if (wrong.length > 0)
      throw new Error(
        `the ${arm} run's lanes are not its rule's: ${wrong.length} unit(s) recompute elsewhere, first ${wrong[0]!.caseId} ${wrong[0]!.unit} (${wrong[0]!.from} → ${wrong[0]!.to})`,
      );
  }
  const measured = { afterMerge: base.afterMerge, heldOut: true };
  const callsOf = (loaded: LoadedSet) =>
    loaded.cases.flatMap((entry) => recompute(entry, harnessRule).calls);
  const keyOf = (loaded: LoadedSet) => {
    const calls = callsOf(loaded);
    return keyMeasures(
      replayMeasures(
        calls,
        loaded.cases.map((entry) => entry.evidence),
        measured,
      ),
      calls,
      loaded.cases,
    );
  };
  const nextOf = new Map(next.cases.map((entry) => [entry.meta.range, entry]));
  const paired = base.cases.map((entry): PairedCase => {
    const other = nextOf.get(entry.meta.range)!;
    const b = threadCounts(
      entry,
      recompute(entry, harnessRule).calls,
      base.afterMerge,
    );
    const n = threadCounts(
      other,
      recompute(other, harnessRule).calls,
      base.afterMerge,
    );
    return {
      group: `${entry.meta.era} ${entry.meta.split}`,
      units: b.units,
      unitsNext: n.units,
      base: b,
      next: n,
    };
  });
  const units = (loaded: LoadedSet) =>
    loaded.cases.reduce(
      (sum, entry) =>
        sum +
        (entry.packet === null
          ? 0
          : packetUnits(entry.packet, {
              where: `case ${entry.meta.caseId}`,
              reads: READS_SECTIONS,
            }).length),
      0,
    );
  // Units with no assessment (a fixed-shape fallback publishes them as human-suggested): reported
  // with the needs-a-person lines only they own, which no measure above judges.
  const unassessed = (loaded: LoadedSet) => {
    const calls = callsOf(loaded).filter((call) => call.harness === null);
    const held = new Set(
      calls.flatMap((call) =>
        call.lines.map((line) => `${call.range}|${line}`),
      ),
    );
    const assessed = new Set(
      callsOf(loaded)
        .filter((call) => call.harness !== null)
        .flatMap((call) => call.lines.map((line) => `${call.range}|${line}`)),
    );
    return {
      units: calls.length,
      needsPersonLines: loaded.cases.reduce(
        (sum, entry) =>
          sum +
          Object.entries(entry.evidence.lines).filter(
            ([line, evidence]) =>
              evidence.class === "needs-person" &&
              held.has(`${entry.meta.range}|${line}`) &&
              !assessed.has(`${entry.meta.range}|${line}`),
          ).length,
        0,
      ),
    };
  };
  // Two shapes (the sections shape against today's): per-unit measures count different units, so
  // they are shown as not comparable and only the per-line measures are rated, with no bar.
  const shapes = { baseline: armShape(base), candidate: armShape(next) };
  const comparable = shapes.baseline === shapes.candidate;
  const lineKeyOf = (loaded: LoadedSet) =>
    lineKeyMeasures(
      replayMeasures(
        callsOf(loaded),
        loaded.cases.map((entry) => entry.evidence),
        measured,
      ),
    );
  return {
    cases: base.cases.length,
    units: { baseline: units(base), candidate: units(next) },
    unassessed: { baseline: unassessed(base), candidate: unassessed(next) },
    shapes,
    comparable,
    comparison: comparable
      ? compare(
          keyOf(base),
          keyOf(next),
          floor?.moved ?? null,
          aimJudges(paired, floor?.flips ?? null),
        )
      : compare(lineKeyOf(base), lineKeyOf(next), null),
    perUnitNotComparable: comparable
      ? null
      : { baseline: keyOf(base), candidate: keyOf(next) },
    sections: {
      baseline: sectionsReport(base.cases),
      candidate: sectionsReport(next.cases),
    },
  };
};

const HeldOutLog = z.array(
  z.strictObject({ round: z.string(), at: z.string() }),
);

/**
 * Held-out cases are read once, at a round's end: the read is logged beside the set, and a second
 * read for the same round is refused.
 */
export const heldOutRead = (setPath: string, round: string) => {
  const log = setPath.replace(/\.json$/, ".held-out.json");
  const reads = existsSync(log)
    ? HeldOutLog.parse(JSON.parse(readFileSync(log, "utf8")))
    : [];
  if (reads.some((read) => read.round === round))
    throw new Error(
      `${round} already read the held-out cases (${log}); they are read once per round`,
    );
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(
    log,
    `${JSON.stringify([...reads, { round, at: new Date().toISOString() }], null, 2)}\n`,
  );
};

/** One miss a change could address, with what the evidence says and whether the audit checked it. */
export interface Miss {
  readonly unit: string;
  readonly title: string;
  readonly lane: Lane | null;
  readonly lines: ReadonlyArray<string>;
  readonly owned: number;
  readonly concerns: ReadonlyArray<{
    readonly id: string;
    readonly category: string | null;
    readonly designDecision: boolean;
    readonly summary: string | null;
    readonly audit: "right" | "wrong" | "unsure" | "not audited";
  }>;
}

/**
 * The error-analysis set, per case under a rule: thread-backed needs-a-person lines in units an
 * agent or automation takes, and human-required units whose labelled lines an agent or automation
 * could take. What a person reads to design the next change; it is never fed back to the harness.
 */
export const missesOf = (loaded: LoadedSet, rule: LaneRule) =>
  loaded.cases.map((entry) => {
    const { calls } = recompute(entry, rule);
    const describe = (call: ReplayCall, lines: ReadonlyArray<string>): Miss => {
      const ids = [
        ...new Set(
          lines.flatMap((line) => entry.evidence.lines[line]!.concerns),
        ),
      ];
      return {
        unit: call.unit,
        title: call.title,
        lane: call.harness,
        lines,
        owned: call.lines.length,
        concerns: ids.map((id) => {
          const label = entry.concerns.get(id) ?? null;
          // The audit names a review concern by its id, an after-merge one by its commit and a
          // mechanical line by its file.
          const citeOf = (line: string) =>
            id === "path"
              ? line.slice(0, line.lastIndexOf(":", line.lastIndexOf(":") - 1))
              : id.startsWith(AFTER_MERGE_PREFIX)
                ? id.slice(AFTER_MERGE_PREFIX.length)
                : id;
          const verdicts = lines
            .map((line) => `${citeOf(line)}|${line}`)
            .filter((key) => entry.audited.has(key))
            .map((key) => entry.audited.get(key)!);
          const verdict = verdicts.length === 0 ? undefined : verdicts[0];
          return {
            id,
            category: label?.category ?? null,
            designDecision: label?.designDecision ?? false,
            summary: label?.rationale ?? null,
            audit:
              verdict === undefined
                ? ("not audited" as const)
                : (verdict ?? ("unsure" as const)),
          };
        }),
      };
    };
    const lower = calls.flatMap((call) => {
      if (call.harness !== "agentic" && call.harness !== "static-automation")
        return [];
      const lines = call.lines.filter((line) => {
        const evidence = entry.evidence.lines[line];
        return (
          evidence?.class === "needs-person" &&
          originOf(entry.evidence, evidence.concerns, loaded.afterMerge) ===
            "thread"
        );
      });
      return lines.length === 0 ? [] : [describe(call, lines)];
    });
    const over = calls.flatMap((call) => {
      if (call.harness !== "human-required") return [];
      const labelled = call.lines.filter(
        (line) => entry.evidence.lines[line] !== undefined,
      );
      return labelled.length > 0 &&
        labelled.every((line) =>
          ["agent-catchable", "mechanical"].includes(
            entry.evidence.lines[line]!.class,
          ),
        )
        ? [describe(call, labelled)]
        : [];
    });
    return {
      caseId: entry.meta.caseId,
      era: entry.meta.era,
      split: entry.meta.split,
      control: entry.meta.control,
      lower,
      overEscalated: over,
    };
  });

const pctOf = (value: number | null) =>
  value === null ? "n/a" : `${Math.round(value * 1_000) / 10}%`;
const points = (value: number) => `${Math.round(value * 1_000) / 10}`;
const signed = (value: number) => `${value >= 0 ? "+" : ""}${points(value)}`;

/** A candidate's evaluation in plain lines. */
export const describeEval = (
  result: ReturnType<typeof evaluateCandidate>,
  candidate: string,
  owner: ReturnType<typeof ownerGuard> | null,
  floor: ReturnType<typeof noiseFloor> | null,
) => [
  `Eval set ${result.set}: ${result.cases} case(s); identity check passed (every stored lane recomputes from its recorded assessment).`,
  `Candidate: ${candidate}. ${result.moved.length} unit(s) change lane${result.joined === 0 ? "" : `, ${result.joined} of them joined units (approximated: a rerun from the stored stages shows their split)`}.`,
  ...(result.entryTruncated.length === 0 &&
  (owner?.entryTruncated.length ?? 0) === 0
    ? []
    : [
        `Package entries read only in part (past ${ENTRY_STEPS} re-exporting files): ${[...result.entryTruncated, ...(owner?.entryTruncated ?? [])].join(", ")}.`,
      ]),
  ...(result.flaggedKinds.length === 0
    ? []
    : [
        `Label kinds under the audit's floor (provisional): ${result.flaggedKinds.join(", ")}.`,
      ]),
  floor === null
    ? "No noise floor given: no verdict."
    : `Noise floor: ${floor.cases} case(s) run twice, ${pctOf(floor.agreement.agreement)} of ${floor.agreement.lines} shared lines in the same lane; ${floor.flips.pooled.flipped} of ${floor.flips.pooled.matched} matched units changed lane (${Object.entries(
        floor.flips.byEra,
      )
        .map(([era, flips]) => `${era} ${flips.flipped} of ${flips.matched}`)
        .join(
          ", ",
        )}; an era's own rate is used from ${MIN_MATCHED_UNITS} matched units).`,
  ...Object.entries(result.comparison).flatMap(
    ([group, { verdict, floorFrom, keys }]) => [
      `  ${group}: ${verdict}${floorFrom === null || floorFrom === group ? "" : ` (judged against the ${floorFrom} floor)`}.`,
      ...Object.entries(keys).map(
        ([key, row]) =>
          `    ${key}: ${pctOf(row.baseline)} → ${pctOf(row.candidate)}${row.delta === null ? "" : ` (${signed(row.delta)} points${row.floor === null ? "" : `; moved ${points(row.floor)} between two runs`})`}${row.judge === null ? "" : `; bar ${row.judge.bar === null ? "none" : points(row.judge.bar)} (f ${pctOf(row.judge.f)}${row.judge.fFrom === null ? "" : ` from ${row.judge.fFrom}`}, n ${row.judge.n})${row.judge.interval === null ? "" : `, 95% interval ${signed(row.judge.interval[0])} to ${signed(row.judge.interval[1])}`}`}`,
      ),
    ],
  ),
  ...(result.consistency === null
    ? ["Run consistency: no second run was read."]
    : [
        `Run consistency, a sanity check on ${result.consistency.cases} case(s) run twice: ${Object.entries(
          result.consistency.byAim,
        )
          .map(([key, aim]) =>
            aim.cases === 0
              ? `${key} untested (no case gains on it)`
              : `${key} judged ${aim.moves} thread-backed move(s) in ${aim.cases} case(s), repeated in ${aim.repeated}${aim.gone ? ", so the gain falls back" : ""}`,
          )
          .join("; ")}.`,
        ...[
          ["pooled", result.consistency.pooled] as const,
          ...Object.entries(result.consistency.byEra),
        ].map(
          ([group, read]) =>
            `  ${group}: ${Object.entries(read)
              .map(
                ([key, row]) =>
                  `${key} ${row.first === null ? "n/a" : signed(row.first)} then ${row.second === null ? "n/a" : signed(row.second)} (n ${row.units.first}, ${row.units.second})`,
              )
              .join("; ")}`,
        ),
      ]),
  `Verdict: ${overallVerdict(result.comparison, owner, result.consistency)}.`,
  ...describeSections("set", result.sections),
  ...(owner === null
    ? ["Owner's desk key: not read (give --owner-round)."]
    : [
        `Owner's desk key (${owner.round}, ${owner.units} units, ${owner.moved} moved): guard ${owner.guard.holds ? "holds" : `broken (${owner.guard.lower.map((u) => u.title).join("; ")})`}; units sent to a person ${pctOf(owner.sentToPerson.units)}; lines in the owner's lane ${pctOf(owner.lineAgreement.share)} of ${owner.lineAgreement.judged}.`,
      ]),
];

/**
 * Candidates side by side on what decides between them: thread-backed recall per unit, the share
 * sent to a person, per era and split, and the owner's line agreement.
 */
export const describeSideBySide = (
  evaluated: ReadonlyArray<{
    readonly name: string;
    readonly result: ReturnType<typeof evaluateCandidate>;
    readonly owner: ReturnType<typeof ownerGuard> | null;
  }>,
) => {
  const groups = [
    ...new Set(
      evaluated.flatMap(({ result }) => Object.keys(result.comparison)),
    ),
  ];
  const row = (key: string, group: string) =>
    evaluated
      .map(({ name, result }) => {
        const entry = result.comparison[group]?.keys[key];
        return `${name} ${pctOf(entry?.candidate ?? null)}`;
      })
      .join(", ");
  return [
    "Side by side:",
    ...groups.flatMap((group) => [
      `  ${group}: thread recall per unit (suggested or higher) ${row("threadUnitsSuggestedOrHigher", group)}; sent to a person ${row("sentToPerson", group)}; verdict ${evaluated.map(({ name, result }) => `${name} ${result.comparison[group]?.verdict ?? "n/a"}`).join(", ")}.`,
    ]),
    `  Owner's line agreement: ${evaluated.map(({ name, owner }) => `${name} ${owner === null ? "not read" : pctOf(owner.lineAgreement.share)}`).join(", ")}.`,
    `  Overall: ${evaluated.map(({ name, result, owner }) => `${name} ${overallVerdict(result.comparison, owner, result.consistency)}`).join("; ")}.`,
  ];
};
