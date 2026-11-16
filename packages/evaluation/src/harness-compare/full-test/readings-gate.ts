import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import {
  BOUND_RULE,
  CATCH_RULE,
  CONFIG_RULE,
  canonical,
  catchComparison,
  categoryOf,
  configurationProblems,
  ExportFile,
  overlaps,
  reviewNotComplete,
  runFolder,
  THIN_BELOW,
  type LineRange,
  type Plant,
  type RunScore,
  type SetVariant,
  type VariantScore,
} from "./finders-gate.ts";
import { addedLines, type AddedLine } from "@neuve/harness/lane-rule";
import {
  hunksOf,
  useFloorsOf,
  useRecordedLane,
  type FloorsOf,
  type RecordedLane,
} from "./lanes-eval.ts";
import { READS_SECTIONS, readShownFile, UnreadableRun } from "./packets.ts";

/**
 * The readings' gate (NEU-148): in a probe run (`review.sectionReadings: "probe"`, which publishes
 * nothing), did the two section readings (Assess and Review) still catch the planted problems, and
 * what did they cost? It reads the run's log rows (`reading.section`, `reading.unit`,
 * `reading.batch`, `reading.call`, `readings.plan`, `readings.decision`, and the readings' own
 * `model.call` rows) as the readers lane writes them (`packages/harness/src/readings/collect.ts` on
 * `codex/neu148-readers-int` 89dc511b): keys, counts, anchors and code's words, never model text.
 * Plants, their categories, the catch levels' comparison, the configuration rule and the review's
 * completeness are the finders' gate's (`finders-gate.ts`), by import.
 *
 * The catch rule, for one complete review of one variant, over the plant's sections (the sections
 * whose owned line keys hold a planted line). Only the readings' own claims count
 * (`source: "lane-review"`); a finder's kept finding the readers lane places on a section
 * (`source: "finder"`) is never a catch of the readings. From the headline down:
 * - caught: a plant section's standing verdict asks for changes and rests on a readings claim whose
 *   anchor overlaps a planted line and that Verify did not refuse;
 * - caught beside: the same, with the claim's anchor on a `beside` or `related` line (the claim may
 *   sit on a section owning those lines);
 * - undecided: no catch, and a plant section no agent decided (human-required), by its cause;
 * - claimed, not standing: a readings claim on a planted line that the verdict does not rest on, or
 *   that Verify refused;
 * - claimed from another section: a readings claim on a planted line raised on a section that does
 *   not own it;
 * - missed: none of these, with some plant section settled;
 * - and, where no plant section settled: waiting, or unread; excluded (every plant section is a file
 *   no reading reads); no section (no section owns a planted line).
 * Beside the levels: "caught by a finder only" (a plant section requests changes resting only on
 * finder claims), and a plant section that ended in static automation or agentic with no standing
 * request for changes (no person looks there), each on its own line; the readings' own bar is zero
 * of the second.
 */

const Side = z.enum(["old", "new"]);
const Lane = z.enum([
  "static-automation",
  "agentic",
  "human-suggested",
  "human-required",
]);
type Lane = z.infer<typeof Lane>;
const NO_PERSON: ReadonlyArray<Lane> = ["static-automation", "agentic"];
const READINGS = "lane-review";

// The rows, as `collect.ts` writes them; loose, so a newer row's added keys still read. Checked
// against the readers lane's own writer's rows (`readings-probe.test.ts` run with its log dumped).

const ClaimRow = z.looseObject({
  key: z.string(),
  path: z.string(),
  side: Side,
  startLine: z.int(),
  endLine: z.int(),
  source: z.string(),
  verify: z.string(),
  restsOn: z.boolean(),
});
type ClaimRow = z.infer<typeof ClaimRow>;
export const SectionRow = z.looseObject({
  type: z.literal("reading.section"),
  decision: z.string(),
  section: z.string(),
  path: z.string(),
  /** `path:side:N` or `path:side:N-M` per side; empty for a binary or mode-only change. */
  owned: z.array(z.string()),
  group: z.string().nullable().optional(),
  state: z.enum(["settled", "waiting", "unread"]),
  lane: z
    .looseObject({
      judged: Lane.nullable(),
      surfaced: Lane.nullable(),
      floors: z.array(z.looseObject({ rule: z.string(), to: Lane })),
      applied: Lane,
    })
    .nullable(),
  floorInputs: z
    .looseObject({ facts: z.unknown(), options: z.unknown() })
    .nullable()
    .optional(),
  verdict: z.enum(["approve", "request-changes"]).nullable(),
  cause: z.string().nullable(),
  reading: z.string().nullable().optional(),
  /** Absent from rows written before claims were recorded. */
  claims: z.array(ClaimRow).optional(),
  /** Coming, read when present: an excluded file's reason, the judgement's origin, family and lineage. */
  excluded: z.looseObject({ reason: z.string() }).nullable().optional(),
  /** The readers lane's design: `{ assess: "model" | "rule", review: "model" | "family" }`; a string is read too. */
  origin: z
    .union([z.string(), z.looseObject({ review: z.string().optional() })])
    .nullable()
    .optional(),
  family: z
    .looseObject({ key: z.string(), representative: z.string() })
    .nullable()
    .optional(),
  lineage: z.string().nullable().optional(),
  /**
   * Since b46ecb81: the stored entry reduced to what the harness's `recordedLane` reads
   * (`laneEntryOf`): the assessment's levels, factors, requirements, lean and gaps, the recorded
   * floors, and the undecided cause or excluded reason. Null on a section that did not settle.
   */
  entry: z
    .looseObject({
      assess: z.unknown(),
      lane: z.looseObject({
        floors: z.array(z.looseObject({ rule: z.string(), to: Lane })),
      }),
    })
    .nullable()
    .optional(),
  at: z.string().optional(),
});
export type SectionRow = z.infer<typeof SectionRow>;
export const CallRow = z.looseObject({
  type: z.literal("reading.call"),
  decision: z.string(),
  kind: z.string(),
  group: z.string().nullable(),
  part: z.string(),
  sections: z.int().nullable(),
  characters: z.int().nullable(),
  /** `ran`, `reused`, `not-started`, `interrupted`, `failed` (with `failure`, and `key: null`). */
  run: z.string(),
  key: z.string().nullable().optional(),
  failure: z.string().optional(),
  problems: z.unknown().optional(),
  /** Since 40196b18: the call's own output tokens, the reasoning part of them, and Assess's class counts. */
  outputTokens: z.number().nullable().optional(),
  reasoningTokens: z.number().nullable().optional(),
  /**
   * Since b46ecb81: the call's own input and cached input tokens; since ccd75a4c its cache writes
   * (five-minute and one-hour together), and `inputTokens` is ordinary input only, leaving out both
   * cache reads and cache writes: the three together are all the call's input.
   */
  inputTokens: z.number().nullable().optional(),
  cachedInputTokens: z.number().nullable().optional(),
  cacheWriteTokens: z.number().nullable().optional(),
  classes: z.int().nullable().optional(),
  outside: z.int().nullable().optional(),
});
export const BatchRow = z.looseObject({
  type: z.literal("reading.batch"),
  decision: z.string(),
  /** Null for the record of sections with no Map group (`reason: "no-map-group"`). */
  mapGroup: z.string().nullable(),
  settled: z.boolean(),
  sections: z.looseObject({ settled: z.int() }).optional(),
  units: z.int().optional(),
  /** Coming: when the batch settled. */
  settledAt: z.string().nullable().optional(),
  /** Since ccd75a4c: how many of the batch's steps were reused from an earlier run (0 when none). */
  reused: z.int().nullable().optional(),
});
export const UnitRow = z.looseObject({
  type: z.literal("reading.unit"),
  decision: z.string(),
  mapGroup: z.string().nullable(),
  path: z.string(),
  lane: Lane,
  sections: z.array(z.string()),
});
export const DecisionRow = z.looseObject({
  type: z.literal("readings.decision"),
  key: z.string(),
  plan: z.string().nullable().optional(),
  sections: z.int(),
  settled: z.int(),
  findings: z.looseObject({ placed: z.int().optional() }).nullable().optional(),
  at: z.string().optional(),
});
export const PlanRow = z.looseObject({
  type: z.literal("readings.plan"),
  plan: z.string().nullable(),
  unread: z.record(z.string(), z.int()).optional(),
});
/**
 * How the readings' preparation ended (`pi/review-task.ts`): `ok`, `failed` or `cutoff` (past the
 * bound its plan is not used), and how long it took. Read for the counts, nothing else.
 */
export const PrepareRow = z.looseObject({
  type: z.literal("readings.prepare"),
  status: z.string(),
  durationMs: z.number().nullable().optional(),
});
const ModelCallRow = z.looseObject({
  type: z.literal("model.call"),
  agent: z.string(),
  usage: z
    .looseObject({
      input: z.number().optional(),
      cacheRead: z.number().optional(),
      cacheWrite5m: z.number().optional(),
      cacheWrite1h: z.number().optional(),
      output: z.number().optional(),
      thinking: z.number().optional(),
    })
    .optional(),
  providerUsage: z.looseObject({}).nullable().optional(),
});

const ROW_SCHEMAS: Record<string, z.ZodType> = {
  "reading.section": SectionRow,
  "reading.call": CallRow,
  "reading.batch": BatchRow,
  "reading.unit": UnitRow,
  "readings.decision": DecisionRow,
  "readings.plan": PlanRow,
  "readings.prepare": PrepareRow,
};

type TokenKey = "input" | "cached" | "cacheWrite" | "output" | "reasoning";
const TOKEN_KEYS: ReadonlyArray<TokenKey> = [
  "input",
  "cached",
  "cacheWrite",
  "output",
  "reasoning",
];
const TOKEN_NAME: Record<TokenKey, string> = {
  input: "input",
  cached: "cached input",
  cacheWrite: "cache write",
  output: "output",
  reasoning: "reasoning",
};
/** Each token column's field on a `reading.call` row. */
const CALL_FIELD = {
  input: "inputTokens",
  cached: "cachedInputTokens",
  cacheWrite: "cacheWriteTokens",
  output: "outputTokens",
  reasoning: "reasoningTokens",
} as const satisfies Record<TokenKey, string>;

/** A probe run's rows, read and checked; `absent` names every row kind or field the run does not hold. */
export interface ProbeRows {
  readonly sections: ReadonlyArray<SectionRow>;
  readonly calls: ReadonlyArray<z.infer<typeof CallRow>>;
  readonly batches: ReadonlyArray<z.infer<typeof BatchRow>> | null;
  readonly units: ReadonlyArray<z.infer<typeof UnitRow>> | null;
  readonly decision: z.infer<typeof DecisionRow>;
  /** The readings' own model calls for the chosen decision: before its row, of its groups or its claims. */
  readonly modelCalls: ReadonlyArray<z.infer<typeof ModelCallRow>>;
  /** `verify.claim.<12>` calls before the decision whose suffix starts none of its claim keys. */
  readonly unattributedVerifyCalls: ReadonlyArray<z.infer<typeof ModelCallRow>>;
  readonly firstAt: string | null;
  /** The last `readings.prepare` row before the decision: how the preparation ended; null when none. */
  readonly prepare: { status: string; durationMs: number | null } | null;
  /**
   * When the review was asked for: the first `run.started` row's `enqueuedAt` (in a kept store's run
   * log), else, in a run folder, export.json's `at` (written when the review ended) less `wallS`.
   */
  readonly requestedAt: string | null;
  readonly requestedAtFrom: "run.started" | "export.json at − wallS" | null;
  /** Placed finder findings, from the decision row: 0 is none placed, null not recorded. */
  readonly finderFindingsPlaced: number | null;
  readonly absent: ReadonlyArray<string>;
}

/** An error that makes a review unreadable, never "no catches". */
export class UnreadableProbe extends Error {
  override readonly name = "UnreadableProbe";
}

const requestOf = (all: ReadonlyArray<Record<string, unknown>>) => {
  const at = all
    .filter((r) => r["type"] === "run.started")
    .map((r) => r["enqueuedAt"])
    .find((t): t is string => typeof t === "string");
  return at === undefined
    ? { requestedAt: null, requestedAtFrom: null }
    : { requestedAt: at, requestedAtFrom: "run.started" as const };
};

/** A readings call's kind from its `model.call` agent (`assess.<group>`, `lane-review.<group>`, `verify.claim.<key>`). */
const kindOfAgent = (agent: string) =>
  agent.startsWith("assess.")
    ? "assess"
    : agent.startsWith("lane-review.")
      ? "lane-review"
      : agent.startsWith("verify.claim.")
        ? "verify-claim"
        : null;

/**
 * The readings' rows of one run log (JSON lines), validated: the rows of the last readings decision
 * only (a later generation decides again), and the readings' model calls written before that
 * decision's row, of its groups or its claims. They have no lower bound: an earlier generation's
 * calls for the same groups or claims are kept, since both were spent. A log with no reading rows,
 * section rows with no decision row (a partial write), a plan that did not run, or a row that does
 * not read is unreadable.
 */
export const readProbeRows = (text: string): ProbeRows => {
  const lines = text.split("\n");
  const all: Array<Record<string, unknown>> = [];
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue;
    try {
      all.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // A line cut short by a crash mid-write ends the log; anywhere else it is unreadable.
      if (lines.slice(index + 1).some((l) => l.trim() !== ""))
        throw new UnreadableProbe(
          `line ${index + 1} of the run log is not JSON`,
        );
    }
  }
  const parsedAt = new Map<number, Record<string, unknown>>();
  for (const [index, row] of all.entries()) {
    const schema = ROW_SCHEMAS[String(row["type"])];
    if (schema === undefined) continue;
    const parsed = schema.safeParse(row);
    if (!parsed.success)
      throw new UnreadableProbe(
        `a ${String(row["type"])} row (record ${index + 1}) does not read: ${parsed.error.issues[0]?.path.join(".") || "row"} ${parsed.error.issues[0]?.message ?? ""}`.trim(),
      );
    parsedAt.set(index, parsed.data as Record<string, unknown>);
  }
  const typed = <T>(type: string) =>
    [...parsedAt].filter(([, r]) => r["type"] === type) as Array<[number, T]>;
  const plans = typed<z.infer<typeof PlanRow>>("readings.plan");
  if (plans.length > 0 && plans.every(([, p]) => p.plan === null))
    throw new UnreadableProbe(
      "the readings did not run: the run's only plan row has no plan",
    );
  const sectionsAll = typed<SectionRow>("reading.section");
  if (sectionsAll.length === 0)
    throw new UnreadableProbe("the run log holds no reading.section rows");
  const decisions = typed<z.infer<typeof DecisionRow>>("readings.decision");
  const last = decisions.at(-1);
  if (last === undefined)
    throw new UnreadableProbe(
      "the run log holds reading.section rows but no readings.decision row: a partial write",
    );
  const [at, decision] = last;
  const of = <T extends { decision: string }>(rows: Array<[number, T]>) =>
    rows.map(([, r]) => r).filter((r) => r.decision === decision.key);
  const sections = of(sectionsAll);
  if (sections.length === 0)
    throw new UnreadableProbe(
      "no reading.section row is of the run's last readings decision",
    );
  const batches = of(typed<z.infer<typeof BatchRow>>("reading.batch"));
  const units = of(typed<z.infer<typeof UnitRow>>("reading.unit"));
  const calls = of(typed<z.infer<typeof CallRow>>("reading.call"));
  // The chosen decision's own readings calls: an `assess.<group>` or `lane-review.<group>` agent
  // (its re-reads and claim reads included) of a group the decision's calls name, or a
  // `verify.claim.<12>` agent whose suffix starts one of the decision's claim keys. A model call
  // written after the decision is a later generation's.
  const groups = new Set(
    calls.flatMap((c) => (c.group === null ? [] : [c.group])),
  );
  const claimKeys = sections.flatMap((s) => (s.claims ?? []).map((c) => c.key));
  const before = all.flatMap((row, index) => {
    if (row["type"] !== "model.call" || index >= at) return [];
    const parsed = ModelCallRow.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
  const isVerify = (agent: string) => kindOfAgent(agent) === "verify-claim";
  const listed = (agent: string) => {
    const suffix = agent.slice("verify.claim.".length);
    return suffix !== "" && claimKeys.some((key) => key.startsWith(suffix));
  };
  const modelCalls = before.filter(({ agent }) => {
    const kind = kindOfAgent(agent);
    if (kind === null) return false;
    if (kind === "verify-claim") return listed(agent);
    return groups.has(agent.slice(kind.length + 1).split(".")[0] ?? "");
  });
  // A Verify call whose claim no section row lists (its section outside the plan, or its Lane review
  // outcome overwritten) is kept apart rather than dropped. It may also be an earlier generation's.
  const unattributedVerifyCalls = before.filter(
    ({ agent }) => isVerify(agent) && !listed(agent),
  );
  const plan = plans.map(([, p]) => p).find((p) => p.plan === decision.plan);
  const placed = decision.findings?.placed;
  const absent: string[] = [];
  if (batches.length === 0) absent.push("reading.batch");
  if (units.length === 0) absent.push("reading.unit");
  if (sections.some((s) => s.claims === undefined))
    absent.push("reading.section claims");
  if (placed === undefined)
    absent.push("finder findings placed (not recorded)");
  if (sections.every((s) => s.floorInputs === undefined))
    absent.push("reading.section floorInputs");
  if (
    plan?.unread === undefined &&
    !sections.some((s) => s.cause === "excluded")
  )
    absent.push("excluded entries (not recorded)");
  if (modelCalls.length === 0) {
    // Without model calls a token column is measured only where the call rows carry it.
    const missing = TOKEN_KEYS.filter(
      (k) => !calls.some((c) => typeof c[CALL_FIELD[k]] === "number"),
    );
    absent.push(
      missing.length === TOKEN_KEYS.length
        ? "model.call (tokens not measured)"
        : missing.length === 0
          ? "model.call (every token column from reading.call)"
          : `model.call (${missing.map((k) => TOKEN_NAME[k]).join(", ")} tokens not measured)`,
    );
  }
  if (sections.every((s) => s.entry === undefined))
    absent.push("reading.section entry");
  if (sections.some((s) => s.cause === "excluded" && !s.excluded))
    absent.push("reading.section excluded.reason");
  if (!batches.some((b) => typeof b.settledAt === "string"))
    absent.push("reading.batch settledAt");
  const times = all
    .map((r) => r["at"])
    .filter((t): t is string => typeof t === "string")
    .sort();
  return {
    sections,
    calls,
    batches: batches.length === 0 ? null : batches,
    units: units.length === 0 ? null : units,
    decision,
    modelCalls,
    unattributedVerifyCalls,
    firstAt: times[0] ?? null,
    prepare: (() => {
      const row = typed<z.infer<typeof PrepareRow>>("readings.prepare")
        .filter(([index]) => index < at)
        .at(-1)?.[1];
      return row === undefined
        ? null
        : { status: row.status, durationMs: row.durationMs ?? null };
    })(),
    ...requestOf(all),
    finderFindingsPlaced: placed ?? null,
    absent,
  };
};

/** `path:side:N` or `path:side:N-M`, as `reading.section.owned` writes a range, as a line range. */
export const ownedRange = (text: string): LineRange | null => {
  const match = /^(.*):(old|new):(\d+)(?:-(\d+))?$/.exec(text);
  if (match === null) return null;
  const startLine = Number(match[3]);
  return {
    path: match[1]!,
    side: match[2] as "old" | "new",
    startLine,
    endLine: match[4] === undefined ? startLine : Number(match[4]),
  };
};
const rangesOf = (row: SectionRow) =>
  row.owned.flatMap((o) => {
    const r = ownedRange(o);
    return r === null ? [] : [r];
  });
const lineCount = (row: SectionRow) =>
  rangesOf(row).reduce((n, r) => n + (r.endLine - r.startLine + 1), 0);
const touchesAny = (
  r: { path: string; side: string; startLine: number; endLine: number },
  ranges: ReadonlyArray<LineRange>,
) => ranges.some((x) => overlaps(r, x));

const isExcluded = (row: SectionRow) =>
  row.cause === "excluded" ||
  (row.excluded !== null && row.excluded !== undefined);
/** A settled section no agent decided: human-required under its cause (an excluded file is apart). */
const undecidedCause = (row: SectionRow) =>
  row.state === "settled" && row.cause !== null && !isExcluded(row)
    ? row.cause
    : null;
/** A claim the verdict stands on: a request for changes resting on it, and Verify did not refuse it. */
const isStanding = (s: SectionRow, c: ClaimRow) =>
  s.verdict === "request-changes" && c.restsOn && c.verify !== "refuted";

// One plant against one run's sections

export type ReadingOutcome =
  | "caught"
  | "caught-beside"
  | "undecided"
  | "claimed-not-standing"
  | "claimed-from-another-section"
  /** A family plant whose only standing claims on the deviating copy sit in carried sections: never a catch. */
  | "caught-through-carried"
  /**
   * A family plant whose only standing claims on the deviating copy sit in sections with no family
   * mark, in a run whose other rows carry marks: not measured, never caught, and not a data point.
   */
  | "catch-not-measured"
  /** A family plant with no claim on the deviating copy, and a readings claim on another copy. */
  | "claimed-on-another-member"
  | "missed"
  /** A plant section waiting with cause `not-reached`: the review's time ran out before its reading. */
  | "not-reached"
  | "waiting"
  | "unread"
  | "excluded"
  | "no-section"
  | "claims-not-recorded";
/** The outcomes a plant has with no settled section of the readings to judge it on. */
export const NOT_JUDGED: ReadonlyArray<ReadingOutcome> = [
  "not-reached",
  "waiting",
  "unread",
  "excluded",
  "no-section",
  "claims-not-recorded",
];

/** The family field of a `family` plant, read loosely: its name is the plant builder's to set. */
const familyRanges = (value: unknown): Array<LineRange> => {
  const one = (v: unknown) => {
    const parsed = z
      .looseObject({
        path: z.string(),
        side: Side,
        startLine: z.int(),
        endLine: z.int(),
      })
      .safeParse(v);
    return parsed.success ? [parsed.data as LineRange] : [];
  };
  if (Array.isArray(value)) return value.flatMap(one);
  const lines = (value as { lines?: unknown } | null)?.lines;
  return Array.isArray(lines) ? lines.flatMap(one) : one(value);
};

export const NO_FAMILY_MARK =
  "not measured: the rows carry no mark this gate reads as own or carried (reading.section `family.representative`, `origin.review` model or family, or `lineage` carried)";

/**
 * How a section's Lane review judgement was made, from the marks the readers lane's design notes
 * give it (`design/readers-compaction-3-5.md`, `design/records-code-rules-and-families.md`):
 *
 * - carried: `family.representative` names another section, `origin.review` (or a string `origin`)
 *   is `family`, or `lineage` is `carried`;
 * - read on its own: `family.representative` is the section itself, or `origin.review` (or a string
 *   `origin`) is `model`;
 * - not measured: anything else. `lineage: "fresh"` is written for every entry whatever its family
 *   (`readings/decide.ts`), so it says nothing here; another `origin.review` value (`none`, or one
 *   added later) is not read as either.
 *
 * Where one row's marks disagree, carried wins: a deviating copy judged through another section is
 * the outcome that must never be hidden.
 */
export const familyReadOf = (
  s: SectionRow,
): "own" | "carried" | typeof NO_FAMILY_MARK => {
  const review =
    typeof s.origin === "string" ? s.origin : (s.origin?.review ?? null);
  const hasFamily = s.family !== null && s.family !== undefined;
  const carried =
    (hasFamily && s.family!.representative !== s.section) ||
    review === "family" ||
    s.lineage === "carried";
  if (carried) return "carried";
  const own =
    (hasFamily && s.family!.representative === s.section) || review === "model";
  return own ? "own" : NO_FAMILY_MARK;
};

/**
 * One copy's read, from the sections that own its lines: carried when any is carried (it outweighs
 * both own and unmarked, so a carried judgement is never hidden), else not measured when any is
 * unmarked or none owns the lines, else read on its own.
 */
const memberRead = (
  rows: ProbeRows,
  member: LineRange,
): "own" | "carried" | typeof NO_FAMILY_MARK => {
  const held = rows.sections.filter((s) =>
    rangesOf(s).some((r) => overlaps(r, member)),
  );
  const reads = new Set(held.map(familyReadOf));
  return reads.has("carried")
    ? "carried"
    : held.length === 0 || reads.has(NO_FAMILY_MARK)
      ? NO_FAMILY_MARK
      : "own";
};

/**
 * Whether a family catch names the deviating literal. A `reading.section` claim records its key,
 * lines, source, Verify outcome and `restsOn` only (the readers lane writes "each defect claim by its
 * anchor and outcome only", `readings/collect.ts`), and no other readings row carries a claim's
 * words, so there is no field to match the plant's `mentions` against.
 */
export const NAMING_NOT_MEASURABLE =
  "naming not measurable from the rows: a reading.section claim records its key, lines, source, Verify outcome and restsOn, and no row carries its text";

/**
 * A family plant's catch, apart from the outcome: caught on the deviating copy's line or beside it
 * (named and not named cannot be told apart: `NAMING_NOT_MEASURABLE`), caught only through a carried
 * judgement (never a catch), or claimed only on another copy (not a catch).
 */
export type FamilyCatch =
  | "caught on the line, naming not measurable"
  | "caught beside, naming not measurable"
  | "caught through a carried judgement"
  | "catch not measured: its section has no family mark while other rows of the run carry one"
  | "claimed on another member";

export const scorePlantReadings = (plant: Plant, rows: ProbeRows) => {
  const near = [...(plant.beside ?? []), ...(plant.related ?? [])];
  const holding = rows.sections.filter((s) =>
    rangesOf(s).some((r) => touchesAny(r, plant.lines)),
  );
  const read = holding.filter((s) => !isExcluded(s));
  const settled = read.filter((s) => s.state === "settled");
  const nearSettled = rows.sections.filter(
    (s) =>
      s.state === "settled" &&
      !isExcluded(s) &&
      rangesOf(s).some((r) => touchesAny(r, near)),
  );
  const readingsClaims = (s: SectionRow) =>
    (s.claims ?? []).filter((c) => c.source === READINGS);
  // A family plant (`planted-source.ts`): `members`, each copy's changed lines in path order, and
  // `deviant`, the index of the copy with the defect (its lines are the plant's `lines`).
  const family = (
    plant as { family?: { members?: unknown; deviant?: unknown } }
  ).family;
  const members = family === undefined ? [] : familyRanges(family.members);
  const at =
    family !== undefined && typeof family.deviant === "number"
      ? family.deviant
      : -1;
  // On a family plant a standing claim in a section whose judgement was carried from another copy
  // is not the deviating copy's own catch: it is set apart, and it is never a catch. Once any row
  // of the run carries `origin` or `family`, the writer marks its judgements, so a catch counts only
  // from a section marked read on its own; one on an unmarked section is not measured.
  const marked =
    family !== undefined &&
    rows.sections.some(
      (s) =>
        (s.origin !== undefined && s.origin !== null) ||
        (s.family !== undefined && s.family !== null),
    );
  const ownJudgement = (s: SectionRow) =>
    family === undefined ||
    (marked ? familyReadOf(s) === "own" : familyReadOf(s) !== "carried");
  const standingOn = (s: SectionRow, ranges: ReadonlyArray<LineRange>) =>
    readingsClaims(s).some((c) => isStanding(s, c) && touchesAny(c, ranges));
  const caughtIn = settled.filter((s) => standingOn(s, plant.lines));
  const caught = caughtIn.some(ownJudgement);
  const besideIn = caught
    ? []
    : [...new Set([...settled, ...nearSettled])].filter((s) =>
        standingOn(s, near),
      );
  const beside = besideIn.some(ownJudgement);
  const throughCarried =
    !caught &&
    !beside &&
    [...caughtIn, ...besideIn].some((s) => familyReadOf(s) === "carried");
  const catchNotMeasured =
    !caught &&
    !beside &&
    !throughCarried &&
    caughtIn.length + besideIn.length > 0;
  const otherMembers = members.filter((_, i) => i !== at);
  const claimsOnOtherMembers = rows.sections.flatMap((s) =>
    readingsClaims(s).filter(
      (c) => !touchesAny(c, plant.lines) && touchesAny(c, otherMembers),
    ),
  ).length;
  const claimsOffTheFamily = rows.sections.flatMap((s) =>
    readingsClaims(s).filter(
      (c) => !touchesAny(c, plant.lines) && !touchesAny(c, members),
    ),
  ).length;
  const causes = [
    ...new Set(settled.flatMap((s) => undecidedCause(s) ?? [])),
  ].sort();
  const claimed = settled.some((s) =>
    readingsClaims(s).some(
      (c) => touchesAny(c, plant.lines) && !isStanding(s, c),
    ),
  );
  const fromAnother = rows.sections.some(
    (s) =>
      !holding.includes(s) &&
      readingsClaims(s).some((c) => touchesAny(c, plant.lines)),
  );
  // A request for changes on a plant section resting only on finder claims: not the readings'.
  const finderOnly = holding.some(
    (s) =>
      s.verdict === "request-changes" &&
      (s.claims ?? []).some((c) => isStanding(s, c)) &&
      (s.claims ?? []).every((c) => !isStanding(s, c) || c.source !== READINGS),
  );
  // A plant section the review's time ran out before reading: its lines were never judged.
  const notReached = read.some(
    (s) => s.state === "waiting" && s.cause === "not-reached",
  );
  const outcome: ReadingOutcome =
    holding.length === 0
      ? "no-section"
      : read.length === 0
        ? "excluded"
        : settled.length === 0
          ? notReached
            ? "not-reached"
            : read.some((s) => s.state === "waiting")
              ? "waiting"
              : "unread"
          : settled.some((s) => s.claims === undefined)
            ? "claims-not-recorded"
            : caught
              ? "caught"
              : beside
                ? "caught-beside"
                : throughCarried
                  ? "caught-through-carried"
                  : catchNotMeasured
                    ? "catch-not-measured"
                    : notReached
                      ? "not-reached"
                      : causes.length > 0
                        ? "undecided"
                        : claimed
                          ? "claimed-not-standing"
                          : fromAnother
                            ? "claimed-from-another-section"
                            : family !== undefined && claimsOnOtherMembers > 0
                              ? "claimed-on-another-member"
                              : "missed";
  // Excluded sections stay in this count: today's lane rule puts them in human-suggested, and the
  // count guards a later code-decided lane for such files.
  const noPerson = holding.filter(
    (s) =>
      s.state === "settled" &&
      s.lane !== null &&
      NO_PERSON.includes(s.lane.applied) &&
      s.verdict !== "request-changes",
  );
  let familyRead: string | null = null;
  let familyMembers: {
    carried: number;
    own: number;
    notMeasured: number;
  } | null = null;
  let familyCatch: FamilyCatch | null = null;
  if (family !== undefined) {
    const deviant = members[at];
    familyRead =
      deviant === undefined ? NO_FAMILY_MARK : memberRead(rows, deviant);
    const others = otherMembers.map((m) => memberRead(rows, m));
    familyMembers = {
      carried: others.filter((r) => r === "carried").length,
      own: others.filter((r) => r === "own").length,
      notMeasured: others.filter((r) => r === NO_FAMILY_MARK).length,
    };
    familyCatch =
      outcome === "caught"
        ? "caught on the line, naming not measurable"
        : outcome === "caught-beside"
          ? "caught beside, naming not measurable"
          : outcome === "caught-through-carried"
            ? "caught through a carried judgement"
            : outcome === "catch-not-measured"
              ? "catch not measured: its section has no family mark while other rows of the run carry one"
              : outcome === "claimed-on-another-member"
                ? "claimed on another member"
                : null;
  }
  return {
    outcome,
    finderOnly: finderOnly && !caught && !beside,
    /** The states of the plant's sections the readings did not settle. */
    states: [
      ...new Set(holding.map((s) => (isExcluded(s) ? "excluded" : s.state))),
    ].sort(),
    sections: holding.length,
    lanes: settled.flatMap((s) => (s.lane === null ? [] : [s.lane.applied])),
    undecidedCauses: causes,
    /** Plant sections in static automation or agentic with no standing request: no person looks. */
    noPersonSections: noPerson.length,
    /** The deviating copy: read on its own, carried from another member, or not measured. */
    familyRead,
    /** The other copies: carried (the saving the change is for), read on their own, not measured. */
    familyMembers,
    /** A family plant's catch apart from its outcome; null for other plants and other outcomes. */
    familyCatch,
    /**
     * A family plant's readings claims (standing or not) off the deviating copy: on another copy, and
     * elsewhere in the commit. A whole-commit scope claim is anchored like any other, and with no
     * claim text in the rows it cannot be told apart, so it is only counted here.
     */
    familyClaims:
      family === undefined
        ? null
        : {
            onOtherMembers: claimsOnOtherMembers,
            offTheFamily: claimsOffTheFamily,
          },
  };
};

// One review of one variant

/** The fields of `export.json` the gate reads beyond the finders' gate's: where the run log is. */
const ProbeExport = ExportFile.extend({
  runId: z.string().nullable().optional(),
  store: z
    .looseObject({ path: z.string().nullable(), kept: z.boolean() })
    .optional(),
});

/** The probe rows' file the runner would write beside `export.json` (not written today). */
export const ROWS_FILE = "readings.jsonl";

export const configOf = (exported: z.infer<typeof ProbeExport>) =>
  canonical({
    env: exported.env ?? {},
    settings: exported.settings ?? {},
    deadlineMinutes: exported.deadlineMinutes ?? null,
    graceMinutes: exported.graceMinutes ?? null,
    wrapper: exported.wrapper ?? null,
    batchLimitMinutes: exported.batchLimitMinutes ?? null,
  });

/** A range manifest's hunks, as the lanes eval reads them from a shown run. */
export type Hunks = ReturnType<typeof hunksOf>;
export const SHOWN_FILE = "show.json";
export const REUSED_TIME =
  "not measured: a reused computation keeps its first time";
export const NO_REQUEST_TIME =
  "not measured: the review's request time is not recorded (no run.started row, and no export.json at and wallS)";
export const NO_MANIFEST_GIVEN =
  "no range manifest was given, so the lines a section adds cannot be read";

/**
 * The run's range manifest hunks, from `show.json` beside `export.json` (`neuve review show --run
 * <id> --json`, which the local runner writes), for the lines each section adds.
 */
export const manifestOf = (
  folder: string,
): { hunks: Hunks | null; hunksWhy: string | null } => {
  const path = join(folder, SHOWN_FILE);
  if (!existsSync(path))
    return {
      hunks: null,
      hunksWhy: `the run folder holds no ${SHOWN_FILE}, so the lines a section adds cannot be read: the runner must keep \`neuve review show --run <id> --json\` (its range manifest's hunks) beside export.json`,
    };
  try {
    const shown = JSON.parse(readFileSync(path, "utf8")) as {
      manifest?: unknown;
    };
    if (shown.manifest === undefined || shown.manifest === null)
      return {
        hunks: null,
        hunksWhy: `${SHOWN_FILE} holds no range manifest (manifest.hunks), so the lines a section adds cannot be read`,
      };
    return { hunks: hunksOf(shown), hunksWhy: null };
  } catch {
    return {
      hunks: null,
      hunksWhy: `${SHOWN_FILE} or its range manifest does not read, so the lines a section adds cannot be read`,
    };
  }
};

/**
 * One run of one variant: its export and its rows, from `readings.jsonl` beside `export.json` when the
 * runner wrote it, else the run log in the kept store (`<store>/repo/.git/neuve/run-logs/<runId>.jsonl`),
 * and its range manifest's hunks from `show.json` beside them.
 */
export const readProbeRun = (root: string, v: SetVariant, run: string) =>
  readProbeFolder(runFolder(root, v, run), v);

/**
 * One run folder, read as `readProbeRun` reads a planted run's: its export, its rows and its range
 * manifest's hunks. With `pinned`, the run must have reviewed that range; a plain probe folder has
 * no pinned case, so it is read without one.
 */
export const readProbeFolder = (
  folder: string,
  pinned?: { readonly base: string; readonly head: string },
) => {
  const exportPath = join(folder, "export.json");
  const none = { hunks: null, hunksWhy: null };
  if (!existsSync(exportPath))
    return { exported: null, rows: null, why: null, ...none };
  const raw = JSON.parse(readFileSync(exportPath, "utf8")) as {
    finished?: unknown;
  };
  if (raw.finished !== true)
    return { exported: null, rows: null, why: null, ...none };
  const exported = ProbeExport.parse(raw);
  if (
    pinned !== undefined &&
    (exported.case.base !== pinned.base || exported.case.head !== pinned.head)
  )
    throw new Error(
      `${folder}: the run reviewed ${exported.case.base.slice(0, 12)}..${exported.case.head.slice(0, 12)}, not the pinned case's range`,
    );
  const beside = join(folder, ROWS_FILE);
  const inStore =
    exported.store?.kept === true &&
    exported.store.path !== null &&
    typeof exported.runId === "string"
      ? join(
          exported.store.path,
          "repo",
          ".git",
          "neuve",
          "run-logs",
          `${exported.runId}.jsonl`,
        )
      : null;
  const path = existsSync(beside)
    ? beside
    : inStore !== null && existsSync(inStore)
      ? inStore
      : null;
  if (path === null)
    return {
      exported,
      rows: null,
      why: `no readings rows: no ${ROWS_FILE} beside export.json, and ${inStore === null ? "the store was not kept" : "the kept store holds no run log"}`,
      ...none,
    };
  try {
    const rows = readProbeRows(readFileSync(path, "utf8"));
    const ended = (raw as { at?: unknown }).at;
    return {
      exported,
      rows:
        rows.requestedAt === null &&
        typeof ended === "string" &&
        !Number.isNaN(Date.parse(ended))
          ? {
              ...rows,
              requestedAt: new Date(
                Date.parse(ended) - exported.wallS * 1000,
              ).toISOString(),
              requestedAtFrom: "export.json at − wallS" as const,
            }
          : rows,
      why: null,
      ...manifestOf(folder),
    };
  } catch (error) {
    if (error instanceof UnreadableProbe)
      return { exported, rows: null, why: error.message, ...none };
    throw error;
  }
};

export type ProbeStatus = "scored" | "failed" | "unreadable" | "missing";

/** One identity check over a review's settled sections: how many ran, and why the rest did not. */
export interface IdentityCount {
  readonly checked: number;
  readonly notChecked: number;
  /** Why a section was not checked, with the sections each reason held back. */
  readonly why: Readonly<Record<string, number>>;
}
export interface Identity {
  readonly failures: ReadonlyArray<string>;
  /** What `added`, the lines a section adds, is built from. */
  readonly added: string;
  readonly recordedLane: IdentityCount;
  /** Every stored floor is one the floor inputs give. */
  readonly floors: IdentityCount;
  /** The floors the inputs give, through `recordedLane`, leave exactly the stored floors. */
  readonly floorsRaised: IdentityCount;
}

export interface ReadingScore {
  readonly variant: number;
  readonly caseId: string;
  readonly category: string;
  readonly problem: string;
  readonly status: ProbeStatus;
  readonly notComplete: ReadonlyArray<string>;
  /** The plant's outcome in a scored review; null when the review is not scored. */
  readonly outcome: ReadingOutcome | null;
  readonly finderOnly: boolean;
  readonly states: ReadonlyArray<string>;
  readonly sections: number;
  readonly lanes: ReadonlyArray<Lane>;
  readonly undecidedCauses: ReadonlyArray<string>;
  readonly noPersonSections: number;
  readonly familyRead: string | null;
  readonly familyMembers: {
    carried: number;
    own: number;
    notMeasured: number;
  } | null;
  readonly familyCatch: FamilyCatch | null;
  readonly familyClaims: {
    onOtherMembers: number;
    offTheFamily: number;
  } | null;
  /** A test-file plant's form (`forged`, `no-assert`, `wrong-path`); `FORM_NOT_RECORDED` when its record has none; null for other plants. */
  readonly form: string | null;
  /**
   * The review's settled sections by the lane `recordedLane` gives for each one's own entry with
   * code's own gaps left out (a recomputation, never the run's lane), and those not measured by
   * reason; null when the review is not scored.
   */
  readonly withoutCodeGaps: {
    lanes: Readonly<Record<string, number>>;
    notMeasured: Readonly<Record<string, number>>;
  } | null;
  /** The plant's settled sections' lanes both ways: applied by the run, and recomputed without code's gaps. */
  readonly plantLanes: ReadonlyArray<{
    section: string;
    applied: Lane;
    withoutCodeGaps: string;
  }>;
  readonly build: string | null;
  readonly config: string | null;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly rows: ProbeRows | null;
  readonly identity: Identity | null;
}

export const MANIFEST_LACKS_LINES =
  "the manifest does not hold the lines the section owns";
const NO_RECORDED_LANE_EXPORT = "this build's harness exports no recordedLane";
const NO_ENTRY =
  "the row carries no entry (written before the readers lane recorded it)";
const NULL_ENTRY = "the settled row's entry is null";

/**
 * The lines a section adds (`ADDED_FROM`). Its owned new-side lines are changed lines, so each is a
 * `+` row of the manifest: when `addedLines` gives fewer, the manifest does not hold them (no hunks,
 * or not that file), and the public-surface raise that reads them cannot be recomputed.
 */
const addedOf = (
  s: SectionRow,
  hunks: Hunks | null,
  hunksWhy: string,
): { added: Array<AddedLine> } | { why: string } => {
  const ranges = rangesOf(s).map((r) => ({ kind: "lines", ...r }));
  const owned = ranges
    .filter((r) => r.side === "new")
    .reduce((n, r) => n + (r.endLine - r.startLine + 1), 0);
  if (owned === 0) return { added: [] };
  if (hunks === null) return { why: hunksWhy };
  const added = addedLines(ranges, hunks);
  return added.length < owned ? { why: MANIFEST_LACKS_LINES } : { added };
};

/** Code's own gap kinds (`readings/decide.ts`, `codeGaps`): a closed list. */
export const CODE_GAP_KINDS = [
  "relations-unavailable",
  "structure-unavailable",
] as const;
/** The kind the readers lane writes on every gap a reading wrote (since its round 2h, e0c5b15f). */
export const MODEL_GAP_KIND = "model";
/** Every gap kind the gate knows: code's own two and the readings'. */
export const KNOWN_GAP_KINDS: ReadonlyArray<string> = [
  ...CODE_GAP_KINDS,
  MODEL_GAP_KIND,
];
export const GAP_KIND_NOT_RECORDED =
  "a gap on the row's entry has no kind (a row written before the readers lane recorded each gap's kind), so code's own gaps cannot be told from the reading's";
/** Why a section whose entry holds a gap of a kind the gate does not know is not recomputed. */
export const unknownGapKind = (kinds: ReadonlyArray<string>) =>
  `the row's entry holds a gap of a kind the gate does not know (${[...new Set(kinds)].sort().join(", ")}), so whether code or the reading wrote it cannot be told`;

/**
 * The lane the harness's `recordedLane` gives for a settled section's own entry with code's own
 * gaps (`CODE_GAP_KINDS`) left out: a recomputation that says how the readings themselves judged,
 * never the run's lane. It needs the entry, every gap's `kind` (one of `KNOWN_GAP_KINDS`), the
 * seam and the added lines; otherwise it is not measured, with the reason. A gap the reading itself
 * named with code's kind is left out too: code adds none where the reading already has one
 * (`storedAssess`).
 */
export const laneWithoutCodeGaps = (
  s: SectionRow,
  hunks: Hunks | null,
  hunksWhy: string,
): { lane: Lane } | { why: string } => {
  const lane = useRecordedLane(undefined);
  useRecordedLane(lane);
  if (lane === undefined) return { why: NO_RECORDED_LANE_EXPORT };
  if (s.entry === undefined) return { why: NO_ENTRY };
  if (s.entry === null) return { why: NULL_ENTRY };
  const assess = s.entry.assess as {
    gaps?: ReadonlyArray<{ axis?: unknown; kind?: unknown }>;
  } | null;
  const gaps = assess?.gaps ?? [];
  if (gaps.some((g) => typeof g.kind !== "string"))
    return { why: GAP_KIND_NOT_RECORDED };
  const unknown = gaps
    .map((g) => g.kind as string)
    .filter((k) => !KNOWN_GAP_KINDS.includes(k));
  if (unknown.length > 0) return { why: unknownGapKind(unknown) };
  const lines = addedOf(s, hunks, hunksWhy);
  if ("why" in lines) return lines;
  const entry =
    assess === null
      ? s.entry
      : {
          ...s.entry,
          assess: {
            ...assess,
            gaps: gaps.filter(
              (g) =>
                !(CODE_GAP_KINDS as ReadonlyArray<unknown>).includes(g.kind),
            ),
          },
        };
  try {
    return {
      lane: lane(entry as unknown as Parameters<RecordedLane>[0], lines.added)
        .applied as Lane,
    };
  } catch (error) {
    return {
      why: `recordedLane refuses the entry (${error instanceof Error ? error.message : String(error)})`,
    };
  }
};

export const ADDED_FROM =
  "the lines a section adds: its row's owned line keys on the new side, read through the harness's addedLines against the run's range manifest hunks (show.json beside export.json); a section that owns no new-side line adds none and needs no manifest";

const trailField = (
  field: "judged" | "surfaced" | "floors" | "applied",
  a: { readonly [k: string]: unknown },
  b: { readonly [k: string]: unknown },
) => {
  if (field !== "floors") return (a[field] ?? null) === (b[field] ?? null);
  const x = (a["floors"] ?? []) as ReadonlyArray<{ rule: string; to: string }>;
  const y = (b["floors"] ?? []) as ReadonlyArray<{ rule: string; to: string }>;
  return (
    x.length === y.length &&
    x.every((f, i) => f.rule === y[i]!.rule && f.to === y[i]!.to)
  );
};
const TRAIL_FIELDS = ["judged", "surfaced", "floors", "applied"] as const;

/**
 * The identity checks, through `lanes-eval.ts`'s seams, per settled section:
 *
 * - recordedLane: the harness's `recordedLane(row.entry, added)` must give the row's stored lane
 *   trail (`judged`, `surfaced`, `floors`, `applied`), `added` as `ADDED_FROM` says;
 * - floors given: every stored floor must be one the row's `floorInputs` give (`floorsOf`);
 * - floors raised: the floors the inputs give, run through `recordedLane` in place of the stored
 *   ones, must leave exactly the stored floors, so a floor that should have raised the lane and is
 *   missing is refused too.
 *
 * A check a section lacks a piece for (the seam, its entry, its floor inputs, or the manifest when it
 * adds lines) is not checked, counted under that reason. A failed check makes the review unreadable.
 */
export const identityOfRows = (
  rows: ProbeRows,
  hunks: Hunks | null = null,
  hunksWhy: string = NO_MANIFEST_GIVEN,
): Identity => {
  // The seams' current functions: swapped out and straight back.
  const lane = useRecordedLane(undefined);
  useRecordedLane(lane);
  const floors = useFloorsOf(undefined);
  useFloorsOf(floors);
  const settled = rows.sections.filter(
    (s) => s.state === "settled" && s.lane !== null,
  );
  const failures: string[] = [];
  const count = () => ({ checked: 0, reasons: new Map<string, number>() });
  const laneCheck = count();
  const givenCheck = count();
  const raisedCheck = count();
  const not = (c: ReturnType<typeof count>, why: string) =>
    c.reasons.set(why, (c.reasons.get(why) ?? 0) + 1);
  for (const s of settled) {
    const stored = s.lane!;
    const inputs =
      s.floorInputs === null || s.floorInputs === undefined
        ? null
        : s.floorInputs;
    const given =
      floors === undefined || inputs === null
        ? null
        : floors(inputs.facts, inputs.options);
    const noGiven =
      floors === undefined
        ? "this build's harness exports no floorsOf"
        : "the row prints no floor inputs";
    if (given === null) not(givenCheck, noGiven);
    else {
      givenCheck.checked += 1;
      for (const floor of stored.floors)
        if (!given.some((g) => g.rule === floor.rule && g.to === floor.to))
          failures.push(
            `section ${s.section}: it stores the floor ${floor.rule} to ${floor.to}, which its floor inputs do not give`,
          );
    }
    const lines = addedOf(s, hunks, hunksWhy);
    const added = "added" in lines ? lines.added : null;
    const noLane =
      lane === undefined
        ? NO_RECORDED_LANE_EXPORT
        : s.entry === undefined
          ? NO_ENTRY
          : s.entry === null
            ? NULL_ENTRY
            : "why" in lines
              ? lines.why
              : null;
    if (noLane !== null) {
      not(laneCheck, noLane);
      not(raisedCheck, noLane);
      continue;
    }
    const rule = lane!;
    const entry = s.entry as unknown as Parameters<RecordedLane>[0];
    let trail: ReturnType<RecordedLane>;
    try {
      trail = rule(entry, added!);
    } catch (error) {
      laneCheck.checked += 1;
      failures.push(
        `section ${s.section}: recordedLane refuses its entry (${error instanceof Error ? error.message : String(error)})`,
      );
      not(raisedCheck, "recordedLane refuses the entry");
      continue;
    }
    laneCheck.checked += 1;
    for (const field of TRAIL_FIELDS)
      if (!trailField(field, trail as never, stored as never))
        failures.push(
          `section ${s.section}: recordedLane recomputes ${field} ${JSON.stringify(trail[field] ?? null)} from its entry where the row stores ${JSON.stringify(stored[field] ?? null)}`,
        );
    if (given === null) {
      not(raisedCheck, noGiven);
      continue;
    }
    raisedCheck.checked += 1;
    const again = rule(
      {
        ...entry,
        lane: { ...(entry as { lane: object }).lane, floors: given },
      } as Parameters<RecordedLane>[0],
      added!,
    );
    if (!trailField("floors", again as never, stored as never))
      failures.push(
        `section ${s.section}: its floor inputs give the floors ${JSON.stringify(again.floors)} where the row stores ${JSON.stringify(stored.floors)}`,
      );
  }
  const out = (c: ReturnType<typeof count>) => ({
    checked: c.checked,
    notChecked: settled.length - c.checked,
    why: Object.fromEntries(c.reasons),
  });
  return {
    failures,
    added: ADDED_FROM,
    recordedLane: out(laneCheck),
    floors: out(givenCheck),
    floorsRaised: out(raisedCheck),
  };
};

export const FORM_NOT_RECORDED = "form not recorded";
/** A test-file plant's form from its record's `form`, read loosely while the plant builder adds it. */
export const formOf = (plant: Plant) => {
  const form = (plant as { form?: unknown }).form;
  return typeof form === "string"
    ? form
    : categoryOf(plant) === "test-file"
      ? FORM_NOT_RECORDED
      : null;
};

export const scoreReadings = (
  v: SetVariant,
  read: ReturnType<typeof readProbeRun>,
): ReadingScore => {
  const base = {
    variant: v.plant.variant,
    caseId: v.plant.caseId,
    category: categoryOf(v.plant),
    form: formOf(v.plant),
    problem: v.plant.problem,
    build: read.exported?.build.commit ?? null,
    config: read.exported === null ? null : configOf(read.exported),
    settings: read.exported?.settings ?? {},
    rows: read.rows,
  };
  const empty = {
    outcome: null,
    finderOnly: false,
    states: [],
    sections: 0,
    lanes: [],
    undecidedCauses: [],
    noPersonSections: 0,
    familyRead: null,
    familyMembers: null,
    familyCatch: null,
    familyClaims: null,
    withoutCodeGaps: null,
    plantLanes: [],
    identity: null,
  };
  if (read.exported === null)
    return {
      ...base,
      ...empty,
      status: "missing",
      notComplete: ["no finished run"],
    };
  const why = reviewNotComplete(read.exported);
  if (why.length > 0)
    return { ...base, ...empty, status: "failed", notComplete: why };
  if (read.rows === null)
    return {
      ...base,
      ...empty,
      status: "unreadable",
      notComplete: [read.why ?? "no readings rows"],
    };
  const identity = identityOfRows(
    read.rows,
    read.hunks,
    read.hunksWhy ?? NO_MANIFEST_GIVEN,
  );
  if (identity.failures.length > 0)
    return {
      ...base,
      ...empty,
      identity,
      status: "unreadable",
      notComplete: [`the identity check failed: ${identity.failures[0]}`],
    };
  // Each settled section's lane two ways: as the run applied it, and recomputed from its own entry
  // with code's own gaps left out (how the readings themselves judged; never the run's lane).
  const linesWhy = read.hunksWhy ?? NO_MANIFEST_GIVEN;
  const twoWays = read.rows.sections
    .filter((s) => s.state === "settled" && s.lane !== null)
    .map((s) => ({
      s,
      without: laneWithoutCodeGaps(s, read.hunks, linesWhy),
    }));
  return {
    ...base,
    ...scorePlantReadings(v.plant, read.rows),
    withoutCodeGaps: {
      lanes: tally(
        twoWays.flatMap((x) => ("lane" in x.without ? [x.without] : [])),
        (x) => x.lane,
      ),
      notMeasured: tally(
        twoWays.flatMap((x) => ("why" in x.without ? [x.without] : [])),
        (x) => x.why,
      ),
    },
    plantLanes: twoWays
      .filter(
        (x) =>
          !isExcluded(x.s) &&
          rangesOf(x.s).some((r) => touchesAny(r, v.plant.lines)),
      )
      .map((x) => ({
        section: x.s.section,
        applied: x.s.lane!.applied,
        withoutCodeGaps:
          "lane" in x.without
            ? x.without.lane
            : `not measured: ${x.without.why}`,
      })),
    identity,
    status: "scored",
    notComplete: [],
  };
};

// Per run, counts only

const tally = <T>(items: ReadonlyArray<T>, key: (t: T) => string) =>
  items.reduce<Record<string, number>>((t, x) => {
    t[key(x)] = (t[key(x)] ?? 0) + 1;
    return t;
  }, {});

const tokensOfModelCall = (row: z.infer<typeof ModelCallRow>) => {
  const p = row.providerUsage as
    | {
        input_tokens?: number;
        input_tokens_details?: { cached_tokens?: number };
        output_tokens?: number;
        output_tokens_details?: { reasoning_tokens?: number };
      }
    | null
    | undefined;
  return {
    input: row.usage?.input ?? p?.input_tokens ?? null,
    cached:
      row.usage?.cacheRead ?? p?.input_tokens_details?.cached_tokens ?? null,
    cacheWrite:
      row.usage?.cacheWrite5m === undefined &&
      row.usage?.cacheWrite1h === undefined
        ? null
        : (row.usage.cacheWrite5m ?? 0) + (row.usage.cacheWrite1h ?? 0),
    output: row.usage?.output ?? p?.output_tokens ?? null,
    reasoning:
      row.usage?.thinking ?? p?.output_tokens_details?.reasoning_tokens ?? null,
  };
};

const sumKnown = (values: ReadonlyArray<number | null>) => ({
  total: values.reduce<number>((s, v) => s + (v ?? 0), 0),
  unknown: values.filter((v) => v === null).length,
});
const ratio = (a: number | null, b: number) =>
  a === null || b === 0 ? null : Math.round((a / b) * 10) / 10;

export interface KindCounts {
  readonly calls: number;
  readonly ran: number;
  readonly reused: number;
  readonly failed: number;
  /** reading.call rows that say how many sections they covered, and those sections. */
  readonly counted: number;
  readonly sections: number;
  readonly characters: number;
  /** Sections covered by calls that ran: the denominator of the tokens per section. */
  readonly ranSections: number;
  /**
   * Per column, null when not measured: from the call rows' own `inputTokens`,
   * `cachedInputTokens`, `outputTokens` and `reasoningTokens` where a call that ran has them, else
   * from the readings' `model.call` rows. A column from `reading.call` covers the calls that ran only.
   */
  readonly tokens: Record<TokenKey, { total: number; unknown: number } | null>;
  readonly tokensFrom: Record<TokenKey, "reading.call" | "model.call" | null>;
  /** Assess's class counts and the sections outside the largest class or verdict list, summed over the calls that report them. */
  readonly classes: { total: number; calls: number };
  readonly outside: { total: number; calls: number };
  /**
   * When any token column comes from `reading.call`: the calls cut off (`interrupted`) or
   * `failed`, which those columns leave out (a column from `model.call` counts what they spent).
   * Null when no column comes from `reading.call`.
   */
  readonly leftOut: number | null;
}

/** One review's counts from its rows; each field is named for the row field it comes from. */
export const probeCounts = (rows: ProbeRows) => {
  const settled = rows.sections.filter((s) => s.state === "settled");
  const undecided: Record<string, { sections: number; lines: number }> = {};
  const excluded: Record<string, { sections: number; lines: number }> = {};
  for (const s of rows.sections) {
    const cause = undecidedCause(s);
    if (cause !== null) {
      const row = (undecided[cause] ??= { sections: 0, lines: 0 });
      row.sections += 1;
      row.lines += lineCount(s);
    }
    if (isExcluded(s)) {
      const reason = s.excluded?.reason ?? "reason not recorded";
      const row = (excluded[reason] ??= { sections: 0, lines: 0 });
      row.sections += 1;
      row.lines += lineCount(s);
    }
  }
  const byKind: Record<string, KindCounts> = {};
  for (const kind of [...new Set(rows.calls.map((c) => c.kind))].sort()) {
    const calls = rows.calls.filter((c) => c.kind === kind);
    const counted = calls.filter((c) => c.sections !== null);
    const ran = calls.filter((c) => c.run === "ran");
    const model = rows.modelCalls.filter((m) => kindOfAgent(m.agent) === kind);
    const fromModel = model.map(tokensOfModelCall);
    const tokens = {} as Record<
      TokenKey,
      { total: number; unknown: number } | null
    >;
    const tokensFrom = {} as Record<
      TokenKey,
      "reading.call" | "model.call" | null
    >;
    for (const k of TOKEN_KEYS) {
      const field = CALL_FIELD[k];
      if (ran.some((c) => typeof c[field] === "number")) {
        tokens[k] = sumKnown(ran.map((c) => c[field] ?? null));
        tokensFrom[k] = "reading.call";
      } else if (model.length > 0) {
        tokens[k] = sumKnown(fromModel.map((v) => v[k]));
        tokensFrom[k] = "model.call";
      } else {
        tokens[k] = null;
        tokensFrom[k] = null;
      }
    }
    const reporting = (field: "classes" | "outside") => {
      const of = calls.filter((c) => typeof c[field] === "number");
      return {
        total: of.reduce((n, c) => n + (c[field] ?? 0), 0),
        calls: of.length,
      };
    };
    byKind[kind] = {
      calls: calls.length,
      ran: ran.length,
      reused: calls.filter((c) => c.run === "reused").length,
      failed: calls.filter((c) => c.run === "failed").length,
      counted: counted.length,
      sections: counted.reduce((n, c) => n + (c.sections ?? 0), 0),
      characters: counted
        .filter((c) => c.characters !== null)
        .reduce((n, c) => n + (c.characters ?? 0), 0),
      ranSections: ran.reduce((n, c) => n + (c.sections ?? 0), 0),
      tokens,
      tokensFrom,
      classes: reporting("classes"),
      outside: reporting("outside"),
      leftOut: TOKEN_KEYS.some((k) => tokensFrom[k] === "reading.call")
        ? calls.filter((c) => c.run === "interrupted" || c.run === "failed")
            .length
        : null,
    };
  }
  const unattributed = rows.unattributedVerifyCalls.map(tokensOfModelCall);
  const perKind = Object.fromEntries(
    Object.entries(byKind).map(([kind, k]) => [
      kind,
      {
        ...k,
        /** Output tokens divided by the reading.call rows that ran; null when not measured. */
        outputTokensPerCall: ratio(k.tokens.output?.total ?? null, k.ran),
        /** Call tokens divided by the sections covered by calls that ran: tokens per section are not observable when one call covers several. */
        outputTokensPerSectionCovered: ratio(
          k.tokens.output?.total ?? null,
          k.ranSections,
        ),
        inputTokensPerSectionCovered: ratio(
          k.tokens.input?.total ?? null,
          k.ranSections,
        ),
        /** reading.call characters divided by the sections those calls covered. */
        answerCharactersPerSectionCovered: ratio(k.characters, k.sections),
        /** reading.call sections, over the calls that say how many they covered. */
        sectionsPerCall: ratio(k.sections, k.counted),
      },
    ]),
  );
  const outside = rows.sections.reduce(
    (n, s) =>
      n +
      (s.claims ?? []).filter(
        (c) =>
          c.source === READINGS && !rangesOf(s).some((r) => overlaps(c, r)),
      ).length,
    0,
  );
  // A batch with a reused step may carry an earlier run's time: left out where the field exists.
  const settledTimes = (rows.batches ?? [])
    .filter(
      (b) =>
        b.settled &&
        typeof b.settledAt === "string" &&
        (b.reused === undefined || b.reused === null || b.reused === 0),
    )
    .map((b) => b.settledAt as string)
    .sort();
  const seconds = (to: string | null | undefined) =>
    to === null || to === undefined || rows.firstAt === null
      ? null
      : Math.round((Date.parse(to) - Date.parse(rows.firstAt)) / 100) / 10;
  // A computation reused from an earlier run keeps the time it was first completed, so a batch
  // settled from a reused store can carry a time before this review was asked for: measured from
  // the review's request only when it is not before it.
  const firstSettled = settledTimes[0];
  const firstSettledNote =
    firstSettled === undefined
      ? null
      : rows.requestedAt === null
        ? NO_REQUEST_TIME
        : Date.parse(firstSettled) < Date.parse(rows.requestedAt)
          ? REUSED_TIME
          : null;
  return {
    sections: tally(rows.sections, (s) => s.state),
    settledByLane: tally(
      settled.filter((s) => s.lane !== null),
      (s) => s.lane!.applied,
    ),
    origins: tally(
      rows.sections.filter((s) => s.origin !== null && s.origin !== undefined),
      (s) => (typeof s.origin === "string" ? s.origin : canonical(s.origin)),
    ),
    undecided,
    excluded,
    calls: perKind,
    /** Verify calls whose claim no section row lists: kept apart, never in a kind's cost. */
    verifyNotAttributable: {
      calls: unattributed.length,
      output: sumKnown(unattributed.map((t) => t.output)),
      input: sumKnown(unattributed.map((t) => t.input)),
    },
    batches:
      rows.batches === null
        ? null
        : {
            total: rows.batches.length,
            settled: rows.batches.filter((b) => b.settled).length,
          },
    /** From the run log's first row to the first `reading.batch.settledAt`; null when not recorded. */
    secondsToFirstSettledBatch:
      firstSettled === undefined || firstSettledNote !== null
        ? null
        : Math.round(
            (Date.parse(firstSettled) - Date.parse(rows.requestedAt!)) / 100,
          ) / 10,
    /** Why `secondsToFirstSettledBatch` is null when a batch did record its time. */
    secondsToFirstSettledBatchNote: firstSettledNote,
    /** Where the review's request time came from. */
    requestedAtFrom: rows.requestedAtFrom,
    /** How the readings' preparation ended, from its `readings.prepare` row. */
    prepare: rows.prepare,
    /**
     * From the run log's first row to the readings.decision row: every batch row is written then, so
     * the first settled batch's own time is not recorded by it.
     */
    secondsToDecision: seconds(rows.decision.at),
    claimsOutsideTheirSection: outside,
    finderClaims: rows.sections.reduce(
      (n, s) =>
        n + (s.claims ?? []).filter((c) => c.source === "finder").length,
      0,
    ),
    finderFindingsPlaced: rows.finderFindingsPlaced,
    absent: rows.absent,
  };
};

export interface KindTotals {
  calls: number;
  ran: number;
  reused: number;
  failed: number;
  counted: number;
  sections: number;
  ranSections: number;
  characters: number;
  /** Null when no review of the run recorded tokens for the kind. */
  output: { total: number; unknown: number } | null;
  input: { total: number; unknown: number } | null;
  reasoning: { total: number; unknown: number } | null;
  /** Where each token column came from, over the run's reviews. */
  sources: Record<
    "output" | "input" | "cached" | "cacheWrite" | "reasoning",
    ReadonlyArray<string>
  >;
  classes: { total: number; calls: number };
  outside: { total: number; calls: number };
  /** Calls cut off or failed, left out of the token columns taken from `reading.call`. */
  leftOut: number;
  cached: { total: number; unknown: number } | null;
  cacheWrite: { total: number; unknown: number } | null;
}

const sumCounts = (all: ReadonlyArray<ReturnType<typeof probeCounts>>) => {
  const add = (
    into: Record<string, number>,
    from: Readonly<Record<string, number>>,
  ) => {
    for (const [k, n] of Object.entries(from)) into[k] = (into[k] ?? 0) + n;
  };
  const sections: Record<string, number> = {};
  const lanes: Record<string, number> = {};
  const undecided: Record<string, { sections: number; lines: number }> = {};
  const excluded: Record<string, { sections: number; lines: number }> = {};
  const calls: Record<string, KindTotals> = {};
  let verifyNotAttributable: {
    calls: number;
    output: { total: number; unknown: number } | null;
    input: { total: number; unknown: number } | null;
  } = { calls: 0, output: null, input: null };
  const tokenSum = (
    into: { total: number; unknown: number } | null,
    from: { total: number; unknown: number } | undefined,
  ) =>
    from === undefined
      ? into
      : {
          total: (into?.total ?? 0) + from.total,
          unknown: (into?.unknown ?? 0) + from.unknown,
        };
  for (const c of all) {
    if (c.verifyNotAttributable.calls > 0)
      verifyNotAttributable = {
        calls: verifyNotAttributable.calls + c.verifyNotAttributable.calls,
        output: tokenSum(
          verifyNotAttributable.output,
          c.verifyNotAttributable.output,
        ),
        input: tokenSum(
          verifyNotAttributable.input,
          c.verifyNotAttributable.input,
        ),
      };
    add(sections, c.sections);
    add(lanes, c.settledByLane);
    for (const [k, v] of Object.entries(c.undecided)) {
      const r = (undecided[k] ??= { sections: 0, lines: 0 });
      r.sections += v.sections;
      r.lines += v.lines;
    }
    for (const [k, v] of Object.entries(c.excluded)) {
      const r = (excluded[k] ??= { sections: 0, lines: 0 });
      r.sections += v.sections;
      r.lines += v.lines;
    }
    for (const [k, v] of Object.entries(c.calls)) {
      const r = (calls[k] ??= {
        calls: 0,
        ran: 0,
        reused: 0,
        failed: 0,
        counted: 0,
        sections: 0,
        ranSections: 0,
        characters: 0,
        output: null,
        input: null,
        reasoning: null,
        sources: {
          output: [],
          input: [],
          cached: [],
          cacheWrite: [],
          reasoning: [],
        },
        classes: { total: 0, calls: 0 },
        outside: { total: 0, calls: 0 },
        leftOut: 0,
        cached: null,
        cacheWrite: null,
      });
      r.leftOut += v.leftOut ?? 0;
      r.cached = tokenSum(r.cached, v.tokens.cached ?? undefined);
      r.cacheWrite = tokenSum(r.cacheWrite, v.tokens.cacheWrite ?? undefined);
      r.calls += v.calls;
      r.ran += v.ran;
      r.reused += v.reused;
      r.failed += v.failed;
      r.counted += v.counted;
      r.sections += v.sections;
      r.ranSections += v.ranSections;
      r.characters += v.characters;
      r.output = tokenSum(r.output, v.tokens.output ?? undefined);
      r.input = tokenSum(r.input, v.tokens.input ?? undefined);
      r.reasoning = tokenSum(r.reasoning, v.tokens.reasoning ?? undefined);
      for (const k of [
        "output",
        "input",
        "cached",
        "cacheWrite",
        "reasoning",
      ] as const) {
        const from = v.tokensFrom[k];
        if (from !== null && !r.sources[k].includes(from))
          r.sources[k] = [...r.sources[k], from];
      }
      r.classes = {
        total: r.classes.total + v.classes.total,
        calls: r.classes.calls + v.classes.calls,
      };
      r.outside = {
        total: r.outside.total + v.outside.total,
        calls: r.outside.calls + v.outside.calls,
      };
    }
  }
  return {
    sections,
    settledByLane: lanes,
    undecided,
    excluded,
    calls,
    verifyNotAttributable,
  };
};

const OUTCOMES: ReadonlyArray<ReadingOutcome> = [
  "caught",
  "caught-beside",
  "undecided",
  "claimed-not-standing",
  "claimed-from-another-section",
  "caught-through-carried",
  "catch-not-measured",
  "claimed-on-another-member",
  "missed",
  "not-reached",
  "waiting",
  "unread",
  "excluded",
  "no-section",
  "claims-not-recorded",
];

const sumIdentity = (all: ReadonlyArray<IdentityCount>): IdentityCount => {
  const why: Record<string, number> = {};
  for (const c of all)
    for (const [k, n] of Object.entries(c.why)) why[k] = (why[k] ?? 0) + n;
  return {
    checked: all.reduce((n, c) => n + c.checked, 0),
    notChecked: all.reduce((n, c) => n + c.notChecked, 0),
    why,
  };
};

/** Counts over the scored reviews, the reviews that are not scored counted apart. */
export const summariseReadings = (scores: ReadonlyArray<ReadingScore>) => {
  const scored = scores.filter((s) => s.status === "scored");
  const outcomes = Object.fromEntries(
    OUTCOMES.map((o) => [o, scored.filter((s) => s.outcome === o).length]),
  ) as Record<ReadingOutcome, number>;
  const identities = scored.flatMap((s) =>
    s.identity === null ? [] : [s.identity],
  );
  return {
    variants: scores.length,
    scored: scored.length,
    failed: scores.filter((s) => s.status === "failed").length,
    unreadable: scores.filter((s) => s.status === "unreadable").length,
    missing: scores.filter((s) => s.status === "missing").length,
    outcomes,
    undecidedByCause: scored.reduce<Record<string, number>>((t, s) => {
      if (s.outcome === "undecided")
        for (const c of s.undecidedCauses) t[c] = (t[c] ?? 0) + 1;
      return t;
    }, {}),
    /** Plants whose only standing request rests on finder claims: never a catch of the readings. */
    caughtByFinderOnly: scored.filter((s) => s.finderOnly).length,
    /** Plants with a section in static automation or agentic and no standing request; the bar is 0. */
    plantsWhereNoPersonLooks: scored.filter((s) => s.noPersonSections > 0)
      .length,
    plantSectionsWhereNoPersonLooks: scored.reduce(
      (n, s) => n + s.noPersonSections,
      0,
    ),
    family: scored.reduce<Record<string, number>>((t, s) => {
      if (s.familyRead !== null) t[s.familyRead] = (t[s.familyRead] ?? 0) + 1;
      return t;
    }, {}),
    /** The family plants' other copies: carried (the saving), read on their own, not measured. */
    familyMembers: scored.reduce(
      (t, s) =>
        s.familyMembers === null
          ? t
          : {
              carried: t.carried + s.familyMembers.carried,
              own: t.own + s.familyMembers.own,
              notMeasured: t.notMeasured + s.familyMembers.notMeasured,
            },
      { carried: 0, own: 0, notMeasured: 0 },
    ),
    /** The family plants' catches apart: on the line, beside, through a carried judgement, on another copy. */
    familyCatches: tally(
      scored.filter((s) => s.familyCatch !== null),
      (s) => s.familyCatch!,
    ),
    /** Settled sections recomputed with code's own gaps left out (not the run's lane), and not measured by reason. */
    settledWithoutCodeGaps: scored.reduce(
      (t, s) => {
        if (s.withoutCodeGaps === null) return t;
        for (const [k, n] of Object.entries(s.withoutCodeGaps.lanes))
          t.lanes[k] = (t.lanes[k] ?? 0) + n;
        for (const [k, n] of Object.entries(s.withoutCodeGaps.notMeasured))
          t.notMeasured[k] = (t.notMeasured[k] ?? 0) + n;
        return t;
      },
      {
        lanes: {} as Record<string, number>,
        notMeasured: {} as Record<string, number>,
      },
    ),
    /** The plant sections' lanes as `applied → recomputed without code's gaps`. */
    plantSectionLanes: tally(
      scored.flatMap((s) => s.plantLanes),
      (x) =>
        `${x.applied} → ${x.withoutCodeGaps.startsWith("not measured") ? "not measured" : x.withoutCodeGaps}`,
    ),
    /** Family plants caught only through a carried judgement: never a catch; the bar is 0. */
    caughtThroughCarried: scored
      .filter((s) => s.outcome === "caught-through-carried")
      .map((s) => s.variant),
    /** The family plants' readings claims off the deviating copy: on another copy, elsewhere in the commit. */
    familyClaims: scored.reduce(
      (t, s) =>
        s.familyClaims === null
          ? t
          : {
              onOtherMembers: t.onOtherMembers + s.familyClaims.onOtherMembers,
              offTheFamily: t.offTheFamily + s.familyClaims.offTheFamily,
            },
      { onOtherMembers: 0, offTheFamily: 0 },
    ),
    identity: {
      added: ADDED_FROM,
      recordedLane: sumIdentity(identities.map((i) => i.recordedLane)),
      floors: sumIdentity(identities.map((i) => i.floors)),
      floorsRaised: sumIdentity(identities.map((i) => i.floorsRaised)),
    },
    costs: sumCounts(
      scored.flatMap((s) => (s.rows === null ? [] : [probeCounts(s.rows)])),
    ),
    absent: [...new Set(scored.flatMap((s) => s.rows?.absent ?? []))].sort(),
  };
};
export type ReadingsSummary = ReturnType<typeof summariseReadings>;

export const scoreProbeRun = (
  root: string,
  run: string,
  variants: ReadonlyArray<SetVariant>,
) => {
  const scores = variants.map((v) =>
    scoreReadings(v, readProbeRun(root, v, run)),
  );
  const present = scores.filter((s) => s.status !== "missing");
  const categories = [...new Set(scores.map((s) => s.category))].sort();
  return {
    run,
    builds: [...new Set(present.map((s) => s.build))],
    configs: [...new Set(present.map((s) => s.config))],
    settings: [...new Set(present.map((s) => canonical(s.settings)))],
    variants: scores,
    byCategory: Object.fromEntries(
      categories.map((c) => [
        c,
        summariseReadings(scores.filter((s) => s.category === c)),
      ]),
    ),
    /** The test-file plants per form, as well as per category (`FORM_NOT_RECORDED` when the record has none). */
    byForm: Object.fromEntries(
      [...new Set(scores.flatMap((s) => (s.form === null ? [] : [s.form])))]
        .sort()
        .map((f) => [f, summariseReadings(scores.filter((s) => s.form === f))]),
    ),
    overall: summariseReadings(scores),
  };
};
export type ProbeRunScore = ReturnType<typeof scoreProbeRun>;

// Comparing a candidate with two baseline runs

/**
 * The readings' outcome as the finders' gate's comparison reads it: caught and caught beside as
 * they are, everything else (undecided, waiting, unread, claimed, caught through a carried
 * judgement, claimed on another copy, finder only, missed, no section, excluded) as not caught.
 */
const asFinderOutcome = (s: ReadingScore) =>
  ({
    variant: s.variant,
    outcome:
      s.outcome === "caught"
        ? "caught"
        : s.outcome === "caught-beside"
          ? "caught-beside"
          : "missed",
  }) as unknown as VariantScore;

export const READINGS_DATA_POINT_RULE =
  'Data points: a variant enters the comparison when its review is complete, its rows read and its plant sections\' rows record claims, in all three runs. Its plant then counts in every catch count: caught or caught beside as such, and every other outcome (undecided by its cause, waiting, unread, claimed but not standing, claimed from another section, a family plant caught only through a carried judgement or claimed only on another copy, caught by a finder only, missed) as not caught; those are also listed on their own lines, per run. Only a plant that no section owns ("no section owns a planted line"), or whose every section is a file no reading reads (excluded), in all three runs stays out; one that is so in some runs and not others is a data point, counted not caught where it is so, and listed. An incomplete, unreadable or missing review, a plant whose rows record no claims, or a family plant whose catch sits on an unmarked section in a run whose other rows carry family marks (not measured), is not a data point and fails acceptance.';
export const READINGS_BAR_RULE =
  "The readings' own bar: no plant section ends in static automation or agentic with no standing request for changes, in any of the three runs.";
export const READINGS_ACCEPTANCE_RULE =
  "Acceptance: every review is complete and readable, with claims recorded, in all three runs; the configuration rule holds; no category has fewer catches (caught) in the candidate than the lower of the two baseline runs; the readings' own bar holds; and no family plant is caught only through a carried judgement, in any of the three runs.";

export const compareProbeRuns = (
  baseline: ProbeRunScore,
  again: ProbeRunScore,
  candidate: ProbeRunScore,
) => {
  const runs = [baseline, again, candidate];
  const by = runs.map((r) => new Map(r.variants.map((s) => [s.variant, s])));
  const variants = [...new Set(candidate.variants.map((s) => s.variant))];
  // A plant whose rows record no claims cannot be judged: not a data point, and it fails acceptance
  // as an unreadable review does.
  const judgeable = (s: ReadingScore | undefined) =>
    s?.status === "scored" &&
    s.outcome !== "claims-not-recorded" &&
    s.outcome !== "catch-not-measured";
  const scoredInAll = variants.filter((v) =>
    by.every((m) => judgeable(m.get(v))),
  );
  const everywhere = (v: number, outcome: ReadingOutcome) =>
    by.every((m) => m.get(v)?.outcome === outcome);
  const outAll = scoredInAll.filter(
    (v) => everywhere(v, "no-section") || everywhere(v, "excluded"),
  );
  const common = new Set(scoredInAll.filter((v) => !outAll.includes(v)));
  const pick = (r: ProbeRunScore, keep?: (s: ReadingScore) => boolean) =>
    r.variants
      .filter((s) => common.has(s.variant) && (keep === undefined || keep(s)))
      .map(asFinderOutcome);
  const side = (keep?: (s: ReadingScore) => boolean) => ({
    catches: catchComparison(
      pick(baseline, keep),
      pick(again, keep),
      pick(candidate, keep),
    ),
    catchesOrBeside: catchComparison(
      pick(baseline, keep),
      pick(again, keep),
      pick(candidate, keep),
      "caught-or-beside",
    ),
  });
  const categories = Object.fromEntries(
    [...new Set(candidate.variants.map((s) => s.category))]
      .sort()
      .map((c) => [c, side((s) => s.category === c)]),
  );
  /** The test-file plants per form, reported beside the categories (the acceptance reads categories). */
  const forms = Object.fromEntries(
    [
      ...new Set(
        candidate.variants.flatMap((s) => (s.form === null ? [] : [s.form])),
      ),
    ]
      .sort()
      .map((f) => [f, side((s) => s.form === f)]),
  );
  // A family plant caught only through a carried judgement fails acceptance by itself, in any run,
  // as a plant section where no person looks does.
  const carried = runs.map((r) => ({
    run: r.run,
    variants: r.overall.caughtThroughCarried,
  }));
  /** Per run, the data points that were not caught, by outcome (undecided by cause), and finder-only. */
  const notCaught = runs.map((r) => {
    const points = r.variants.filter((s) => common.has(s.variant));
    const of = points.filter(
      (s) => s.outcome !== "caught" && s.outcome !== "caught-beside",
    );
    return {
      run: r.run,
      byOutcome: tally(of, (s) => String(s.outcome)),
      undecidedByCause: of.reduce<Record<string, number>>((t, s) => {
        if (s.outcome === "undecided")
          for (const c of s.undecidedCauses) t[c] = (t[c] ?? 0) + 1;
        return t;
      }, {}),
      caughtByFinderOnly: points.filter((s) => s.finderOnly).length,
    };
  });
  const notDataPoints = runs.flatMap((r) =>
    r.variants
      .filter((s) => !judgeable(s))
      .map((s) => ({
        run: r.run,
        variant: s.variant,
        status:
          s.status !== "scored"
            ? s.status
            : s.outcome === "catch-not-measured"
              ? ("catch not measured" as const)
              : ("claims not recorded" as const),
        notComplete:
          s.status !== "scored"
            ? s.notComplete
            : s.outcome === "catch-not-measured"
              ? [
                  "its deviating copy's catch sits on a section with no family mark, while other rows of the run carry one",
                ]
              : ["its plant sections' rows record no claims"],
      })),
  );
  const outOfReach = [...common].flatMap((v) => {
    const states = by.map((m) => m.get(v)!.outcome);
    return states.some((o) => o === "no-section" || o === "excluded")
      ? [
          {
            variant: v,
            outcomes: Object.fromEntries(
              runs.map((r, i) => [r.run, states[i]]),
            ),
          },
        ]
      : [];
  });
  const configuration = configurationProblems(
    ...(runs.map((r) => ({
      run: r.run,
      builds: r.builds,
      configs: r.configs,
    })) as unknown as [RunScore, RunScore, RunScore]),
  );
  const noPerson = runs.map((r) => ({
    run: r.run,
    plants: r.overall.plantsWhereNoPersonLooks,
    sections: r.overall.plantSectionsWhereNoPersonLooks,
  }));
  const failing = Object.entries(categories)
    .filter(([, c]) => !c.catches.holds)
    .map(([c]) => c);
  return {
    rules: {
      dataPoints: READINGS_DATA_POINT_RULE,
      catches: CATCH_RULE,
      configuration: CONFIG_RULE,
      bar: READINGS_BAR_RULE,
      acceptance: READINGS_ACCEPTANCE_RULE,
      bound: BOUND_RULE,
      thinBelow: THIN_BELOW,
    },
    dataPoints: common.size,
    /** Plants no section owns, or only excluded files hold, in all three runs: out of the comparison. */
    outInAllRuns: outAll,
    /** Data points that were out of reach (no section, excluded) in some runs only. */
    outOfReachInSomeRuns: outOfReach,
    notCaught,
    overall: side(),
    categories,
    forms,
    identity: runs.map((r) => ({ run: r.run, ...r.overall.identity })),
    acceptance: {
      passes:
        notDataPoints.length === 0 &&
        configuration.length === 0 &&
        failing.length === 0 &&
        noPerson.every((r) => r.sections === 0) &&
        carried.every((r) => r.variants.length === 0),
      notDataPoints,
      configuration,
      categoriesWithFewerCatches: failing,
      noPerson,
      caughtThroughCarried: carried,
    },
  };
};

// One plain run folder: a probe with no plants

/** A probe folder's state: read, a review that did not complete, rows that do not read, or no finished run. */
export type ProbeFolderStatus = "read" | "failed" | "unreadable" | "missing";
export const NO_GAP_KIND = "no kind";
export const IDENTITY_FAILED =
  "the identity check failed, so the lane rule does not give this run's own lanes";

/**
 * Every gap on the sections' entries, by `<axis> / <kind>` (`NO_GAP_KIND` for a gap with none):
 * code's own, the readings' (`model`), and any other kind as written.
 */
export const gapsByAxisAndKind = (sections: ReadonlyArray<SectionRow>) =>
  tally(
    sections.flatMap((s) => {
      const assess = (s.entry ?? null)?.assess as {
        gaps?: ReadonlyArray<{ axis?: unknown; kind?: unknown }>;
      } | null;
      return assess?.gaps ?? [];
    }),
    (g) =>
      `${typeof g.axis === "string" ? g.axis : "no axis"} / ${typeof g.kind === "string" ? g.kind : NO_GAP_KIND}`,
  );

/**
 * A probe's settled sections' lanes two ways: the lane the run applied (the run's lane), and the
 * lane `recordedLane` gives for each one's own entry with code's own gaps left out (a
 * recomputation, never the run's lane), with the moves from the first to the second (an unchanged
 * lane is `x → x`) and the sections not recomputed, by reason. When the identity check failed, the
 * rule does not give the run's own lanes, so nothing is recomputed.
 */
export const probeLanes = (
  rows: ProbeRows,
  hunks: Hunks | null,
  hunksWhy: string,
  identityHolds: boolean,
) => {
  const settled = rows.sections.filter(
    (s) => s.state === "settled" && s.lane !== null,
  );
  const twoWays = settled.map((s) => ({
    applied: s.lane!.applied,
    without: identityHolds
      ? laneWithoutCodeGaps(s, hunks, hunksWhy)
      : { why: IDENTITY_FAILED },
  }));
  const measured = twoWays.flatMap((x) =>
    "lane" in x.without ? [{ applied: x.applied, lane: x.without.lane }] : [],
  );
  return {
    applied: tally(settled, (s) => s.lane!.applied),
    recomputedWithoutCodeGaps: tally(measured, (x) => x.lane),
    moves: tally(measured, (x) => `${x.applied} → ${x.lane}`),
    notMeasured: tally(
      twoWays.flatMap((x) => ("why" in x.without ? [x.without] : [])),
      (x) => x.why,
    ),
  };
};
export type ProbeLanes = ReturnType<typeof probeLanes>;

/**
 * One plain run folder (`readings.jsonl`, `show.json`, `export.json`; no plants), read the way a
 * planted run is: `probeCounts` over its rows, the identity checks, its settled sections' lanes two
 * ways (`probeLanes`) and its gaps by axis and kind. Counts, lanes, kinds and section ids only.
 */
export const probeFolder = (folder: string) => {
  const read = readProbeFolder(folder);
  const base = {
    folder,
    build: read.exported?.build.commit ?? null,
    settings: read.exported?.settings ?? {},
  };
  const nothing = {
    counts: null,
    identity: null,
    lanes: null,
    gaps: null,
  };
  if (read.exported === null)
    return {
      ...base,
      ...nothing,
      status: "missing" as ProbeFolderStatus,
      notComplete: ["no finished run (no export.json, or it is not finished)"],
    };
  const notComplete = reviewNotComplete(read.exported);
  if (read.rows === null)
    return {
      ...base,
      ...nothing,
      status: "unreadable" as ProbeFolderStatus,
      notComplete: [...notComplete, read.why ?? "no readings rows"],
    };
  const hunksWhy = read.hunksWhy ?? NO_MANIFEST_GIVEN;
  const identity = identityOfRows(read.rows, read.hunks, hunksWhy);
  const holds = identity.failures.length === 0;
  return {
    ...base,
    status: (notComplete.length > 0
      ? "failed"
      : holds
        ? "read"
        : "unreadable") as ProbeFolderStatus,
    notComplete: holds
      ? notComplete
      : [
          ...notComplete,
          `the identity check failed (${identity.failures.length} failure(s)): ${identity.failures[0]}`,
        ],
    counts: probeCounts(read.rows),
    identity,
    lanes: probeLanes(read.rows, read.hunks, hunksWhy, holds),
    gaps: gapsByAxisAndKind(read.rows.sections),
  };
};
export type ProbeFolder = ReturnType<typeof probeFolder>;

/**
 * A probe's counts in a summary's shape, for the same printed rows a planted run's costs print:
 * the costs, the lanes recomputed without code's gaps (never the run's lane) and the absent rows.
 */
export const probeSummaryOf = (p: ProbeFolder) =>
  p.counts === null
    ? null
    : {
        costs: sumCounts([p.counts]),
        settledWithoutCodeGaps: {
          lanes: p.lanes!.recomputedWithoutCodeGaps,
          notMeasured: p.lanes!.notMeasured,
        },
        absent: [...p.counts.absent].sort(),
      };

// Briefing usefulness (the readers' briefing rubric, 3.8)

/**
 * What a person reads before the code, measured from the packet (`show.json`'s `packet`), never by a
 * model: is each claim cited, and does the text say what changed in product and system terms rather
 * than list files and symbols? The texts are each unit's lead (its `briefed` stop's first paragraph;
 * a unit with none leads with its Facts, `lead-is-facts`), each section's `content.briefed` and each
 * batch digest's `digest`. Whose a text is: its own `source` where it names one (a digest always
 * does); else, in a batch whose packet shows a briefing ran (a model digest, or a `briefing-failed` /
 * `briefing-cut` gap), the model's, unless such a gap names its unit, when it is counted with code's
 * fallback; else not recorded. Only model-written texts enter the gate values; code's and unrecorded
 * texts are reported apart, and an unrecorded lead or section text stops the gate as not measured.
 */

/** A phrase link, `[phrase](id)`: records-schema's `PHRASE_LINK`, which this package does not import. */
const PHRASE_LINK = /\[([^\]\n]{1,200})\]\(([^)\s]{1,160})\)/g;

/**
 * A cite of a hunk and lines inside it, `h<hex>@<start>-<end>` or one line `h<hex>@<line>`, which
 * records resolve to those lines. It is cited like a bare hunk ID: by its own ID resolving in the
 * unit's citations.
 */
const LINE_RANGE_ID = /@\d+(?:-\d+)?$/;
/**
 * What is left of a link once the whole links and backticked code are taken out: a "](" that never
 * closed as `[phrase](id)`, or a "[" with no "]" after it on its line (a text cut inside a phrase).
 * A bracket pair in code written as plain text (`keys[0]`, `T[]`) is no link, and the desk shows it
 * as it is, so it does not count.
 */
const DANGLING_LINK = /\]\(|\[[^\]\n]*$/m;
const isDangling = (text: string) =>
  DANGLING_LINK.test(text.replace(/`[^`\n]*`/g, " ").replace(PHRASE_LINK, " "));

type BriefingSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "phrase"; readonly phrase: string; readonly id: string };

const segmentsOf = (text: string): Array<BriefingSegment> => {
  const out: Array<BriefingSegment> = [];
  let at = 0;
  for (const m of text.matchAll(PHRASE_LINK)) {
    if (m.index > at) out.push({ kind: "text", text: text.slice(at, m.index) });
    out.push({ kind: "phrase", phrase: m[1]!, id: m[2]! });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ kind: "text", text: text.slice(at) });
  return out;
};

// The desk's `briefingClaims` (apps/neuve-web/packages/ui/src/neuve/review-desk/briefing-claims.ts),
// over the same segments: a sentence ends at . ! or ? before a space and a capital, digit or opening
// mark; a blank line ends a claim; a phrase is never split.
const SENTENCE_END = /(?<=[.!?])\s+(?=[A-Z0-9“"‘'([])/;
const ENDS_SENTENCE = /[.!?]\s+$/;
const BLANK_LINE = /\n[^\S\n]*\n\s*/;

export const briefingClaims = (
  segments: ReadonlyArray<BriefingSegment>,
): Array<Array<BriefingSegment>> => {
  const claims: Array<Array<BriefingSegment>> = [];
  let current: Array<BriefingSegment> = [];
  const close = () => {
    const claim = trimmedClaim(current);
    if (claim.length > 0) claims.push(claim);
    current = [];
  };
  segments.forEach((segment, i) => {
    if (segment.kind !== "text") {
      current.push(segment);
      return;
    }
    segment.text.split(BLANK_LINE).forEach((paragraph, p) => {
      if (p > 0) close();
      paragraph.split(SENTENCE_END).forEach((piece, k) => {
        if (k > 0) close();
        if (piece) current.push({ kind: "text", text: piece });
      });
    });
    if (ENDS_SENTENCE.test(segment.text) && segments[i + 1]?.kind === "phrase")
      close();
  });
  close();
  return claims;
};

const trimmedClaim = (
  claim: ReadonlyArray<BriefingSegment>,
): Array<BriefingSegment> => {
  const out = claim.map((segment, i): BriefingSegment => {
    if (segment.kind !== "text") return segment;
    let text = segment.text;
    if (i === 0) text = text.trimStart();
    if (i === claim.length - 1) text = text.trimEnd();
    return { kind: "text", text };
  });
  const kept = out.filter((s) => s.kind !== "text" || s.text);
  return kept.some((s) => s.kind !== "text" || s.text.trim()) ? kept : [];
};

/** Claims under this many words are not counted. */
export const MIN_CLAIM_WORDS = 4;

const LINE_COUNT = /\d+ lines? (?:added|removed)/g;
/** One word standing for a line count, so `12 lines added` is one code-like word. */
const LINE_COUNT_WORD = "\u0000lines";
const PATH = /\S+\/\S+/;
const FILE_NAME =
  /\S+\.(?:ts|tsx|js|jsx|mjs|go|py|md|json|ya?ml|toml|lock|css|html|sh)\b/;
const IDENTIFIER = /^[A-Za-z_$][\w$]*(?:[a-z][A-Z]|_|\.|\(\))[\w$.()]*$/;
/** Code's Facts form, `<what>: <n> lines`. */
const FACTS_FORM = /^[^:]{1,120}: \d+ lines?/;

/**
 * The words of a text as the rubric counts them: a backticked span is one word (its spaces held by a
 * character `\s` does not match), a line count is one word, and sentence punctuation at either end of
 * a word is not part of it.
 */
const wordsOf = (text: string) =>
  text
    .replace(/`[^`\n]*`/g, (m) => m.replace(/\s+/g, "\u0001"))
    .replace(LINE_COUNT, ` ${LINE_COUNT_WORD} `)
    .split(/\s+/)
    .filter((raw) => /[\p{L}\p{N}`\u0000]/u.test(raw))
    .map((raw) => ({ raw, word: bareWord(raw) }));

/** A word without the punctuation around it; a closing parenthesis stays when it closes one in the word. */
const bareWord = (raw: string) => {
  if (raw.startsWith("`")) return raw.replace(/[,;:.!?)\]"']+$/, "");
  let word = raw.replace(/^[("'“‘[]+/, "");
  for (;;) {
    const next = word.replace(/[,;:!?\]"'”’]+$|\.+$/, "");
    const unbalanced =
      next.endsWith(")") &&
      (next.match(/\(/g)?.length ?? 0) < (next.match(/\)/g)?.length ?? 0);
    const cut = unbalanced ? next.slice(0, -1) : next;
    if (cut === word) return word;
    word = cut;
  }
};

export const isCodeLike = (word: string) =>
  word === LINE_COUNT_WORD ||
  (word.startsWith("`") && word.endsWith("`") && word.length > 1) ||
  PATH.test(word) ||
  FILE_NAME.test(word) ||
  IDENTIFIER.test(word);

/** Three or more code-like words joined by commas or "and". */
const joinsThreeNames = (words: ReturnType<typeof wordsOf>) => {
  let run = 0;
  let best = 0;
  let joined = false;
  for (const { raw, word } of words) {
    if (isCodeLike(word)) {
      run = joined || run === 0 ? run + 1 : 1;
      best = Math.max(best, run);
      joined = raw.endsWith(",");
    } else if (word === "and" && run > 0) {
      joined = true;
    } else {
      run = 0;
      joined = false;
    }
  }
  return best >= 3;
};

export interface ClaimRead {
  readonly words: number;
  readonly codeLike: number;
  readonly written: boolean;
  readonly cited: boolean;
  readonly enumerates: boolean;
}

/** One claim read: its words, whether it links at all, whether a link resolves, and whether it enumerates. */
export const readClaim = (
  claim: ReadonlyArray<BriefingSegment>,
  resolved: ReadonlySet<string>,
): ClaimRead => {
  const text = claim
    .map((s) => (s.kind === "text" ? s.text : s.phrase))
    .join("");
  const words = wordsOf(text);
  const codeLike = words.filter((w) => isCodeLike(w.word)).length;
  const phrases = claim.filter(
    (s): s is Extract<BriefingSegment, { kind: "phrase" }> =>
      s.kind === "phrase",
  );
  return {
    words: words.length,
    codeLike,
    written: phrases.length > 0,
    cited: phrases.some((p) => resolved.has(p.id)),
    enumerates:
      (words.length > 0 && codeLike / words.length >= 0.3) ||
      FACTS_FORM.test(text.trim()) ||
      joinsThreeNames(words),
  };
};

export type BriefingTextKind = "lead" | "section" | "digest";
export type BriefingSource = "agent" | "code" | "not recorded";

export interface BriefingText {
  readonly kind: BriefingTextKind;
  readonly source: BriefingSource;
  readonly unit: string | null;
  readonly claims: ReadonlyArray<ClaimRead>;
  /** Half or more of its counted claims enumerate. */
  readonly fileList: boolean;
  readonly phrases: number;
  /** Linked phrases whose words are half or more code-like. */
  readonly fileNamePhrases: number;
  /** Linked phrases whose ID carries a line range inside its hunk (`LINE_RANGE_ID`). */
  readonly rangedPhrases: number;
  /** A link left open: a "[" or "](" outside a whole `[phrase](id)` and outside code. */
  readonly danglingLink: boolean;
}

const sourceOf = (holder: unknown): BriefingSource => {
  const s = (holder as { source?: unknown } | null | undefined)?.source;
  return s === "agent" || s === "code" ? s : "not recorded";
};

/** The gaps a briefing that failed or was cut discloses (the readers' `briefingGaps` and `digestGap`). */
export const BRIEFING_GAP_KINDS: ReadonlyArray<string> = [
  "briefing-failed",
  "briefing-cut",
];

/**
 * A batch's briefing state, as its packet shows it: a batch was briefed when its digest is the
 * model's or it discloses a briefing gap (a briefing that ran and failed or was cut); and the units a
 * briefing gap names, whose texts may be code's fallback (the gap counts sections, never says which).
 */
const briefingStateOf = (batch: Record<string, any>) => {
  const gaps = (Array.isArray(batch?.gaps) ? batch.gaps : []).filter((g: any) =>
    BRIEFING_GAP_KINDS.includes(g?.payload?.kind ?? g?.kind),
  );
  const fellBack = new Set<string>(
    gaps.flatMap((g: any) =>
      Array.isArray(g?.attribution?.unitIds) ? g.attribution.unitIds : [],
    ),
  );
  return {
    briefed: batch?.digest?.source === "agent" || gaps.length > 0,
    fellBack,
  };
};

/**
 * Whose a lead or section text is: its own `source` where it names one; else, in a briefed batch,
 * the model's, unless a briefing gap names its unit, when it is counted with code's; else not recorded.
 */
const textSourceOf = (
  holder: unknown,
  unit: string,
  state: ReturnType<typeof briefingStateOf>,
): BriefingSource => {
  const own = sourceOf(holder);
  if (own !== "not recorded" || !state.briefed) return own;
  return state.fellBack.has(unit) ? "code" : "agent";
};

const resolvedIds = (citations: unknown): Set<string> => {
  const cited = (citations as { cited?: unknown } | null | undefined)?.cited;
  return new Set(
    (Array.isArray(cited) ? cited : [])
      .filter(
        (c): c is { id: string; resolution: unknown } =>
          typeof (c as { id?: unknown })?.id === "string" &&
          (c as { resolution?: unknown }).resolution !== undefined &&
          (c as { resolution?: unknown }).resolution !== null,
      )
      .map((c) => c.id),
  );
};

export const readBriefingText = (
  kind: BriefingTextKind,
  source: BriefingSource,
  unit: string | null,
  text: string,
  resolved: ReadonlySet<string>,
): BriefingText => {
  const segments = segmentsOf(text.replace(/\r\n?/g, "\n"));
  const claims = briefingClaims(segments)
    .map((c) => readClaim(c, resolved))
    .filter((c) => c.words >= MIN_CLAIM_WORDS);
  const phrases = segments.filter(
    (s): s is Extract<BriefingSegment, { kind: "phrase" }> =>
      s.kind === "phrase",
  );
  const fileNamePhrases = phrases.filter((p) => {
    const words = wordsOf(p.phrase);
    return (
      words.length > 0 &&
      words.filter((w) => isCodeLike(w.word)).length / words.length >= 0.5
    );
  }).length;
  const enumerating = claims.filter((c) => c.enumerates).length;
  return {
    kind,
    source,
    unit,
    claims,
    fileList: claims.length > 0 && enumerating / claims.length >= 0.5,
    phrases: phrases.length,
    fileNamePhrases,
    rangedPhrases: phrases.filter((p) => LINE_RANGE_ID.test(p.id)).length,
    danglingLink: isDangling(text),
  };
};

const filledText = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/**
 * Every local ID the packet knows, which Explained's prose must not carry as words: the range's hunk
 * IDs, every unit's and digest's cited IDs, every Facts and Explained cite, and the unit and batch
 * handles. A briefing part writes for several units, so a sibling unit's ID counts too.
 */
const localIdsOf = (
  batches: ReadonlyArray<Record<string, any>>,
  hunkIds: ReadonlyArray<string>,
): Set<string> => {
  const ids = new Set<string>();
  const add = (list: unknown) => {
    for (const id of Array.isArray(list) ? list : [])
      if (typeof id === "string" && id.length > 0) ids.add(id);
  };
  add(hunkIds);
  for (const batch of batches) {
    add([batch?.local, batch?.batchId]);
    for (const c of batch?.digestCitations?.cited ?? []) add([c?.id]);
    for (const unit of Array.isArray(batch?.units) ? batch.units : []) {
      add([unit?.local, unit?.unitId]);
      for (const c of unit?.citations?.cited ?? []) add([c?.id]);
      add(unit?.content?.facts?.cites);
      add(unit?.content?.explained?.cites);
      for (const s of unit?.sections ?? []) {
        add(s?.content?.facts?.cites);
        add(s?.content?.explained?.cites);
      }
    }
  }
  return ids;
};

/** Phrase links and local IDs written in an Explained stop's before or after. */
const idsInExplained = (explained: unknown, ids: ReadonlySet<string>) => {
  const e = explained as { before?: unknown; after?: unknown } | null;
  let found = 0;
  for (const side of [e?.before, e?.after]) {
    if (!filledText(side)) continue;
    found += [...side.matchAll(PHRASE_LINK)].length;
    for (const { word } of wordsOf(side.replace(PHRASE_LINK, " "))) {
      const bare = word.replace(/^`|`$/g, "");
      // A hunk with a line range is still that hunk's local ID.
      if (ids.has(bare) || ids.has(bare.replace(LINE_RANGE_ID, ""))) found++;
    }
  }
  return found;
};

/**
 * The undecided causes of a section no reading reads (the harness's `UnreadCause` in
 * `readings/plan.ts`, as a section records it): no text, or its own reading over the size bound.
 * An excluded file is unread too, recorded as `excluded`. An Assess failure is not among them: the
 * section is still read and briefed beside its Facts, so a unit of such sections is held to the rule.
 */
export const UNREAD_CAUSES: ReadonlySet<string> = new Set([
  "unreadable",
  "too-large",
]);
const isUnread = (section: Record<string, any> | null | undefined) =>
  (section?.excluded !== null && section?.excluded !== undefined) ||
  UNREAD_CAUSES.has(String(section?.undecided?.cause));

export interface BriefingUnit {
  readonly unit: string;
  readonly sections: number;
  /** Sections the readings read. A unit with none has nothing a lead could be written from, so the
   * lead rule does not apply to it (see `UNREAD_CAUSES`). */
  readonly read: number;
  readonly leadIsFacts: boolean;
  readonly explainedIds: number;
}

/**
 * Every briefing text of a packet, and each unit's lead state and Explained IDs. `hunkIds` are the
 * range's hunk IDs (`show.json`'s manifest), so a hunk no Facts cites is still a local ID.
 */
export const briefingTextsOf = (
  packet: unknown,
  hunkIds: ReadonlyArray<string> = [],
) => {
  const texts: Array<BriefingText> = [];
  const units: Array<BriefingUnit> = [];
  // Section titles, reported only: a title that is a file name or a line count is code-like.
  const titles = { total: 0, codeLike: 0 };
  const given = (packet as { batches?: unknown } | null)?.batches;
  const batches: Array<Record<string, any>> = Array.isArray(given) ? given : [];
  const ids = localIdsOf(batches, hunkIds);
  for (const batch of batches) {
    const state = briefingStateOf(batch);
    const d = batch?.digest;
    if (filledText(d?.digest))
      texts.push(
        readBriefingText(
          "digest",
          sourceOf(d),
          null,
          d.digest,
          resolvedIds(batch?.digestCitations),
        ),
      );
    for (const unit of Array.isArray(batch?.units) ? batch.units : []) {
      const id = String(unit?.unitId ?? "");
      const resolved = resolvedIds(unit?.citations);
      const briefed = unit?.content?.briefed;
      const lead: string | undefined = filledText(briefed?.text)
        ? briefed.text
            .replace(/\r\n?/g, "\n")
            .split(BLANK_LINE)
            .find((p: string) => p.trim().length > 0)
        : undefined;
      if (lead !== undefined)
        texts.push(
          readBriefingText(
            "lead",
            textSourceOf(briefed, id, state),
            id,
            lead,
            resolved,
          ),
        );
      const sections: Array<Record<string, any>> = Array.isArray(unit?.sections)
        ? unit.sections
        : [];
      for (const s of sections)
        if (filledText(s?.content?.briefed))
          texts.push(
            readBriefingText(
              "section",
              textSourceOf(s.content, id, state),
              id,
              s.content.briefed,
              resolved,
            ),
          );
      for (const s of sections)
        if (filledText(s?.title)) {
          titles.total++;
          const words = wordsOf(s.title);
          if (
            words.length > 0 &&
            words.filter((w) => isCodeLike(w.word)).length / words.length >= 0.5
          )
            titles.codeLike++;
        }
      units.push({
        unit: id,
        sections: sections.length,
        read: sections.filter((s) => !isUnread(s)).length,
        leadIsFacts: lead === undefined,
        explainedIds:
          idsInExplained(unit?.content?.explained, ids) +
          sections.reduce(
            (n, s) => n + idsInExplained(s?.content?.explained, ids),
            0,
          ),
      });
    }
  }
  return { texts, units, titles };
};

export interface BriefingTotals {
  readonly texts: number;
  readonly claims: number;
  readonly citedClaims: number;
  readonly writtenClaims: number;
  readonly enumeratingClaims: number;
  readonly fileListTexts: number;
  readonly phrases: number;
  readonly fileNamePhrases: number;
  readonly rangedPhrases: number;
  readonly danglingLinkTexts: number;
}

const totalsOf = (texts: ReadonlyArray<BriefingText>): BriefingTotals => ({
  texts: texts.length,
  claims: texts.reduce((n, t) => n + t.claims.length, 0),
  citedClaims: texts.reduce(
    (n, t) => n + t.claims.filter((c) => c.cited).length,
    0,
  ),
  writtenClaims: texts.reduce(
    (n, t) => n + t.claims.filter((c) => c.written).length,
    0,
  ),
  enumeratingClaims: texts.reduce(
    (n, t) => n + t.claims.filter((c) => c.enumerates).length,
    0,
  ),
  fileListTexts: texts.filter((t) => t.fileList).length,
  phrases: texts.reduce((n, t) => n + t.phrases, 0),
  fileNamePhrases: texts.reduce((n, t) => n + t.fileNamePhrases, 0),
  rangedPhrases: texts.reduce((n, t) => n + t.rangedPhrases, 0),
  danglingLinkTexts: texts.filter((t) => t.danglingLink).length,
});

/** The rubric's gate values, over model-written texts. */
export const BRIEFING_GATE = {
  citeShareAtLeast: 0.9,
  fileListTexts: 0,
  fileNamePhraseShareAtMost: 0.1,
  explainedIds: 0,
  danglingLinkTexts: 0,
} as const;

export const NOTHING_MODEL_WRITTEN =
  "not measured: no model-written briefing text (a source of agent)";
export const SOURCE_NOT_RECORDED = (n: number) =>
  `not measured: ${n} lead or section text(s) in a batch with no briefing state (no model digest and no briefing gap), so whose they are is not recorded`;

/**
 * The measure over a packet: totals by source and by kind, the cite and written shares over
 * model-written texts overall and per unit, and the gate values. Counts only.
 */
export const briefingUsefulness = (
  packet: unknown,
  hunkIds: ReadonlyArray<string> = [],
) => {
  const { texts, units, titles } = briefingTextsOf(packet, hunkIds);
  const agent = texts.filter((t) => t.source === "agent");
  const bySource = Object.fromEntries(
    (["agent", "code", "not recorded"] as const).map((s) => [
      s,
      totalsOf(texts.filter((t) => t.source === s)),
    ]),
  ) as Record<BriefingSource, BriefingTotals>;
  const modelByKind = Object.fromEntries(
    (["lead", "section", "digest"] as const).map((k) => [
      k,
      totalsOf(agent.filter((t) => t.kind === k)),
    ]),
  ) as Record<BriefingTextKind, BriefingTotals>;
  const model = bySource.agent;
  const share = (a: number, b: number) => (b > 0 ? a / b : null);
  const perUnit = units
    .map((u) => {
      const t = totalsOf(agent.filter((x) => x.unit === u.unit));
      return {
        unit: u.unit,
        claims: t.claims,
        citeShare: share(t.citedClaims, t.claims),
        writtenShare: share(t.writtenClaims, t.claims),
      };
    })
    .filter((u) => u.claims > 0);
  const citeShare = share(model.citedClaims, model.claims);
  const fileNamePhraseShare = share(model.fileNamePhrases, model.phrases);
  const explainedIds = units.reduce((n, u) => n + u.explainedIds, 0);
  const leadIsFactsOnMultiSection = units.filter(
    (u) => u.leadIsFacts && u.sections > 1 && u.read > 0,
  ).length;
  const fails: Array<string> = [];
  const unrecorded = texts.filter(
    (t) => t.kind !== "digest" && t.source === "not recorded",
  ).length;
  if (unrecorded > 0) fails.push(SOURCE_NOT_RECORDED(unrecorded));
  if (citeShare === null) fails.push(NOTHING_MODEL_WRITTEN);
  else if (citeShare < BRIEFING_GATE.citeShareAtLeast)
    fails.push(
      `cite share ${citeShare.toFixed(3)} (${model.citedClaims} of ${model.claims} claims) is under ${BRIEFING_GATE.citeShareAtLeast}`,
    );
  if (model.fileListTexts > BRIEFING_GATE.fileListTexts)
    fails.push(
      `${model.fileListTexts} model-written text(s) are file lists (half or more of their claims enumerate)`,
    );
  if (
    fileNamePhraseShare !== null &&
    fileNamePhraseShare > BRIEFING_GATE.fileNamePhraseShareAtMost
  )
    fails.push(
      `file-name phrases ${fileNamePhraseShare.toFixed(3)} (${model.fileNamePhrases} of ${model.phrases}) are over ${BRIEFING_GATE.fileNamePhraseShareAtMost}`,
    );
  if (explainedIds > BRIEFING_GATE.explainedIds)
    fails.push(
      `${explainedIds} link(s) or local ID(s) in Explained's before or after`,
    );
  if (model.danglingLinkTexts > BRIEFING_GATE.danglingLinkTexts)
    fails.push(
      `${model.danglingLinkTexts} model-written text(s) leave a link open (a "[" or "](" that is no whole [phrase](id))`,
    );
  if (leadIsFactsOnMultiSection > 0)
    fails.push(
      `${leadIsFactsOnMultiSection} unit(s) of more than one section lead with their Facts`,
    );
  return {
    bySource,
    modelByKind,
    citeShare,
    writtenShare: share(model.writtenClaims, model.claims),
    fileNamePhraseShare,
    lineRangeShare: share(model.rangedPhrases, model.phrases),
    sectionTitles: titles.total,
    codeLikeSectionTitles: titles.codeLike,
    perUnit,
    units: units.length,
    leadIsFacts: units.filter((u) => u.leadIsFacts).length,
    leadIsFactsOnMultiSection,
    leadIsFactsUnread: units.filter((u) => u.leadIsFacts && u.read === 0)
      .length,
    explainedIds,
    fails,
    passes: fails.length === 0,
  };
};
export type BriefingUsefulness = ReturnType<typeof briefingUsefulness>;

/**
 * One run folder's briefing usefulness, from the packet in its `show.json` through the eval's guard
 * (sections shape included). A folder with no `show.json`, no packet, or a packet the guard refuses
 * is not measured, with the reason.
 */
export const briefingOfFolder = (
  folder: string,
):
  | { folder: string; measured: true; briefing: BriefingUsefulness }
  | { folder: string; measured: false; why: string } => {
  const path = join(folder, SHOWN_FILE);
  if (!existsSync(path))
    return { folder, measured: false, why: `no ${SHOWN_FILE} in the folder` };
  try {
    const shown = readShownFile<{
      packet?: unknown;
      manifest?: { hunks?: ReadonlyArray<{ hunkId?: unknown }> } | null;
    }>(path, folder, READS_SECTIONS);
    if (shown.packet === null || shown.packet === undefined)
      return { folder, measured: false, why: `${SHOWN_FILE} holds no packet` };
    return {
      folder,
      measured: true,
      briefing: briefingUsefulness(
        shown.packet,
        (shown.manifest?.hunks ?? []).flatMap((h) =>
          typeof h?.hunkId === "string" ? [h.hunkId] : [],
        ),
      ),
    };
  } catch (error) {
    if (error instanceof UnreadableRun || error instanceof SyntaxError)
      return { folder, measured: false, why: error.message.split("\n")[0]! };
    throw error;
  }
};

// Where the lane rule comes from

export const LANE_RULE_IMPORT = "@neuve/harness/lane-rule";

/** Where the seams' lane rule came from, and which of its two functions it exports. */
export interface LaneRuleSource {
  readonly from: "file" | "package import";
  /** The file given, or the path the package import resolves to (null when it does not resolve). */
  readonly path: string | null;
  readonly recordedLane: boolean;
  readonly floorsOf: boolean;
}

/**
 * The seams as the package's own import left them: in a checkout whose `node_modules` belongs to
 * another worktree, `@neuve/harness/lane-rule` is that worktree's harness, so the path is printed.
 * Read before any `useLaneRuleFile`.
 */
export const packageLaneRule = (): LaneRuleSource => {
  const lane = useRecordedLane(undefined);
  useRecordedLane(lane);
  const floors = useFloorsOf(undefined);
  useFloorsOf(floors);
  let path: string | null;
  try {
    path = fileURLToPath(import.meta.resolve(LANE_RULE_IMPORT));
  } catch {
    path = null;
  }
  return {
    from: "package import",
    path,
    recordedLane: lane !== undefined,
    floorsOf: floors !== undefined,
  };
};

/**
 * Loads a `lane-rule.ts` and puts its `recordedLane` and `floorsOf` in the seams (a function it
 * does not export leaves its seam empty). A path that does not load, or that exports neither, is
 * an error with the path in it, never a silent "not measured".
 */
export const useLaneRuleFile = async (
  file: string,
): Promise<LaneRuleSource> => {
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`--lane-rule ${path}: no such file`);
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(pathToFileURL(path).href)) as Record<
      string,
      unknown
    >;
  } catch (error) {
    throw new Error(
      `--lane-rule ${path} does not load: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const lane =
    typeof loaded["recordedLane"] === "function"
      ? (loaded["recordedLane"] as RecordedLane)
      : undefined;
  const floors =
    typeof loaded["floorsOf"] === "function"
      ? (loaded["floorsOf"] as FloorsOf)
      : undefined;
  if (lane === undefined && floors === undefined)
    throw new Error(
      `--lane-rule ${path} exports neither recordedLane nor floorsOf`,
    );
  useRecordedLane(lane);
  useFloorsOf(floors);
  return {
    from: "file",
    path,
    recordedLane: lane !== undefined,
    floorsOf: floors !== undefined,
  };
};

/** The one line every output gives: where the lane rule came from, and what it exports. */
export const laneRuleLine = (s: LaneRuleSource) =>
  `lane rule: ${s.from === "file" ? `the file ${s.path}` : `the package import ${LANE_RULE_IMPORT}, resolved to ${s.path ?? "nothing (it does not resolve)"}`}; exports recordedLane ${s.recordedLane ? "yes" : "no"}, floorsOf ${s.floorsOf ? "yes" : "no"}`;
