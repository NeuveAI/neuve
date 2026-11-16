import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { PlantedRecord } from "./planted-light.ts";
import { SourcePlantedRecord } from "./planted-source.ts";

/**
 * The finders' quality gate (NEU-148): did a build's four finders still find the planted problems,
 * and did anything else move beyond the noise between two runs of the same build?
 *
 * It reads planted variants through their set index (every pinned record hash-checked, read each time)
 * and, per variant, the local runner's `findings.json` and `export.json` under
 * `<root>/<source>/<number>/run/<run>/` (research/pr-bench/replay/local/run_cases.py). It writes counts
 * only: a finding's text is read for the cross-file naming check and never leaves this module.
 *
 * A review is a data point only when it completed: exit 0 (or a deadline cut-off the product itself
 * reports, with a published packet), not killed after grace, a run that was read, and every lens with a
 * Find output or a finder result. Anything else is `failed` (or `unreadable`, or `missing`): counted
 * per run, never a miss, and outside every catch count, flip and numeric pair.
 *
 * The catch rule (the lane contract), for one complete review of one variant, from the headline down:
 * - caught: a finding Verify kept has an anchor overlapping a planted line (same path and side, line
 *   ranges intersect). Acceptance and the noise bar use this alone;
 * - caught beside the plant: no kept finding on a planted line, but one overlaps a `beside` line
 *   (other places a correct finding may anchor) or a `related` line (the code the defect depends on);
 * - found, not kept: a finding overlaps the planted lines but Verify dropped it, left it unverified,
 *   or it never reached Verify (merged into another finding, or over the five-finding cap);
 * - missed: none of these.
 * Beside it, the same rule on each finding's primary (first) anchor only. For a cross-file plant, a
 * catch is "named" when a catching finding's claim or evidence names a related file (its path or file
 * name) or one of the plant's `mentions` words. A kept finding is "off the plant" when none of its
 * anchors overlaps a planted, beside or related line.
 */

export const LENSES = ["scope-fit", "correctness", "risky-edges", "tests"];
const Side = z.enum(["old", "new"]);
export const LineRange = z.looseObject({
  path: z.string().min(1),
  side: Side,
  startLine: z.int().min(1),
  endLine: z.int().min(1),
});
export type LineRange = z.infer<typeof LineRange>;

/** The fields of `planted.json` the gate reads (set B's version 1; set C adds the optional ones). */
export const Plant = z.looseObject({
  variant: z.int().min(1),
  caseId: z.string(),
  host: z.looseObject({ caseId: z.string() }),
  problem: z.string().min(1),
  kind: z.string(),
  lines: z.array(LineRange).min(1),
  mentions: z.array(z.string()),
  related: z.array(LineRange).optional(),
  beside: z.array(LineRange).optional(),
  language: z.string().optional(),
  set: z.string().optional(),
  category: z.string().optional(),
  hostTouchesFile: z.boolean().optional(),
  hostSize: z
    .looseObject({ units: z.int(), files: z.int(), size: z.string() })
    .optional(),
});
export type Plant = z.infer<typeof Plant>;

/** Set C's record as its builder defines it, with `beside` read as optional until the schema has it. */
const SetCRecord = SourcePlantedRecord.extend({
  beside: z
    .array(
      z.strictObject({
        path: z.string(),
        side: Side,
        startLine: z.int().min(1),
        endLine: z.int().min(1),
      }),
    )
    .optional(),
});

/**
 * A variant's `planted.json`, read with its own set's schema (set B's `PlantedRecord`, set C's
 * `SourcePlantedRecord`), then as the gate's view of it. A record either set's schema rejects is an
 * error, never a variant that drops out of its category.
 */
export const parsePlant = (raw: unknown, path: string): Plant => {
  const set = (raw as { set?: unknown } | null)?.set;
  if (set === "C") return Plant.parse(SetCRecord.parse(raw));
  if (set === undefined) return Plant.parse(PlantedRecord.parse(raw));
  throw new Error(
    `${path}: a planted record of an unknown set (${String(set)})`,
  );
};

/** Set C's problems, each its own category; every set B variant rolls up into `light-file`. */
export const SET_C_PROBLEMS = [
  "source-defect",
  "removed-behaviour",
  "cross-file",
  "missing-test",
  "out-of-scope",
];
export const LIGHT_FILE = "light-file";
/** The category a variant is reported under: its own `category` (set C), else derived from `problem`. */
export const categoryOf = (plant: Plant) =>
  plant.category ??
  (SET_C_PROBLEMS.includes(plant.problem) ? plant.problem : LIGHT_FILE);

const Status = z.enum([
  "kept",
  "dropped",
  "unverified",
  "deduplicated",
  "over-cap",
  /** Slice B: dropped before dedupe because its hunk has no Map group (never judged). */
  "no-group",
]);
export const StoredFinding = z.looseObject({
  id: z.string(),
  lens: z.string(),
  kind: z.string(),
  claim: z.string(),
  anchors: z.array(LineRange).min(1),
  evidence: z.array(z.string()).optional(),
  status: Status,
});
export type StoredFinding = z.infer<typeof StoredFinding>;
const ReadRange = z.tuple([z.string(), Side, z.int(), z.int()]);
const OpeningState = z.enum(["recorded", "none", "not measured"]);
const LineCounts = z.looseObject({ added: z.int(), deleted: z.int() });
const Delivery = z.looseObject({
  openingState: OpeningState,
  opening: LineCounts.nullable(),
  fetched: LineCounts,
  seen: LineCounts.nullable(),
});
const NativeCheck = z.enum(["agrees", "absent", "unreadable"]);
const Lens = z.looseObject({
  output: z.enum(["found", "none"]),
  /**
   * On a lens with no output: whether the run log holds a finder result. The round 1c reader also wrote
   * its native check's `agrees` here, as a string; that is read as `nativeCheck: agrees`.
   */
  finderResult: z.union([z.boolean(), z.literal("agrees")]).optional(),
  /** Whether the finder's own stored result was compared with what was read: agrees, absent, unreadable. */
  nativeCheck: NativeCheck.optional(),
  runLog: z.string().optional(),
});
export type NativeCheckState = z.infer<typeof NativeCheck> | "not recorded";
/** A lens record's native check, from its own field or the round 1c reader's string. */
export const nativeCheckOf = (lens: z.infer<typeof Lens>): NativeCheckState =>
  lens.nativeCheck ??
  (lens.finderResult === "agrees" ? "agrees" : "not recorded");
export const FindingsFile = z.discriminatedUnion("status", [
  z.looseObject({
    status: z.literal("read"),
    findings: z.array(StoredFinding),
    lenses: z.record(z.string(), Lens),
    reads: z
      .record(
        z.string(),
        z.looseObject({
          read: z.array(ReadRange),
          diff: z.array(ReadRange),
          /** Round 2: the opening's shown ranges (null when not measured); absent from older readers. */
          opening: z.array(ReadRange).nullable().optional(),
          openingState: OpeningState.optional(),
        }),
      )
      .nullable(),
    /** The reader that wrote the file (runner file hashes); absent before round 2. */
    reader: z.record(z.string(), z.string()).optional(),
  }),
  z.looseObject({ status: z.literal("no-run"), reason: z.string() }),
  z.looseObject({ status: z.literal("unreadable"), reason: z.string() }),
]);
export type FindingsFile = z.infer<typeof FindingsFile>;

const Count = z.int().min(0).nullable().optional();
const Tokens = z.looseObject({
  total: z.int().min(0),
  unknownCalls: z.int().min(0),
});
export const ExportFile = z.looseObject({
  finished: z.literal(true),
  purpose: z.enum(["quality", "timing"]).optional(),
  timingsComparable: z.boolean().optional(),
  case: z.looseObject({ base: z.string(), head: z.string() }),
  exit: z.int().nullable(),
  wallS: z.number(),
  killedAfterGrace: z.boolean().optional(),
  outcome: z.string().nullable().optional(),
  timeoutReached: z.boolean().nullable().optional(),
  published: z.boolean().optional(),
  build: z.looseObject({ commit: z.string().nullable() }),
  env: z.record(z.string(), z.string()).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  deadlineMinutes: z.number().optional(),
  graceMinutes: z.number().optional(),
  wrapper: z.string().optional(),
  batchLimitMinutes: z.number().optional(),
  finders: z
    .record(
      z.string(),
      z.looseObject({
        resultPresent: z.boolean(),
        turns: Count,
        endedBy: z.string().nullable().optional(),
        outputTokens: Count,
        seconds: z.number().nullable().optional(),
      }),
    )
    .optional(),
  secondsToFirstBatch: z.number().nullable().optional(),
  usage: z
    .looseObject({
      modelCalls: z.int().min(0),
      tokens: z.looseObject({
        input: Tokens,
        cachedInput: Tokens,
        output: Tokens,
        reasoning: Tokens,
      }),
    })
    .optional(),
  /** How the runner ended the case (round 1c): processes left in its group or outside it. */
  machine: z
    .looseObject({
      end: z
        .looseObject({
          membersLeft: z.int().nullable().optional(),
          outsideGroup: z.int().nullable().optional(),
          listingFailed: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
  rangeLines: z
    .looseObject({
      added: z.int().optional(),
      deleted: z.int().optional(),
      /** Before round 2: lines read by any finder, the opening's head lines included on slice B. */
      anyFinder: z
        .looseObject({ newRead: z.int(), oldRead: z.int() })
        .optional(),
      /** Round 2: what the finders were shown, fetched and saw, kept apart. */
      allFinders: Delivery.optional(),
      /**
       * Per finder: round 2's views, or (a reader before round 2, which every finished real run before it
       * holds) `{newRead, oldRead}`, read as "not recorded".
       */
      byFinder: z
        .record(
          z.string(),
          z.union([
            Delivery,
            z.looseObject({ newRead: z.int(), oldRead: z.int() }),
          ]),
        )
        .optional(),
      /** The reader's own status: `ok`, or `no-manifest` when the range manifest was not found. */
      status: z.string().optional(),
    })
    .nullable()
    .optional(),
});
export type ExportFile = z.infer<typeof ExportFile>;

// The catch rule

export const overlaps = (
  a: { path: string; side: string; startLine: number; endLine: number },
  b: { path: string; side: string; startLine: number; endLine: number },
) =>
  a.path === b.path &&
  a.side === b.side &&
  a.startLine <= b.endLine &&
  b.startLine <= a.endLine;

type Anchored = { anchors: ReadonlyArray<LineRange> };
const touches = (finding: Anchored, ranges: ReadonlyArray<LineRange>) =>
  finding.anchors.some((a) => ranges.some((r) => overlaps(a, r)));
const primaryOnly = <T extends Anchored>(finding: T): T => ({
  ...finding,
  anchors: finding.anchors.slice(0, 1),
});

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whether a finding's own words name a related file (path or file name) or a `mentions` word. */
export const namesPlant = (finding: StoredFinding, plant: Plant) => {
  const text = [finding.claim, ...(finding.evidence ?? [])].join("\n");
  const words = [
    ...(plant.related ?? []).flatMap((r) => [r.path, basename(r.path)]),
    ...plant.mentions,
  ].filter((w) => w.trim().length > 0);
  return words.some((w) =>
    new RegExp(`(?<![A-Za-z0-9_])${escape(w)}(?![A-Za-z0-9_])`, "i").test(text),
  );
};

export type Outcome = "caught" | "caught-beside" | "found-not-kept" | "missed";
const outcomeOf = (
  findings: ReadonlyArray<StoredFinding>,
  plant: Plant,
): Outcome => {
  const near = [...(plant.beside ?? []), ...(plant.related ?? [])];
  const kept = findings.filter((f) => f.status === "kept");
  if (kept.some((f) => touches(f, plant.lines))) return "caught";
  if (kept.some((f) => touches(f, near))) return "caught-beside";
  if (findings.some((f) => touches(f, plant.lines))) return "found-not-kept";
  return "missed";
};
export const catchOf = (
  findings: ReadonlyArray<StoredFinding>,
  plant: Plant,
) => {
  const outcome = outcomeOf(findings, plant);
  const catching = findings.filter(
    (f) => f.status === "kept" && touches(f, plant.lines),
  );
  const around = [
    ...plant.lines,
    ...(plant.related ?? []),
    ...(plant.beside ?? []),
  ];
  return {
    outcome,
    primaryOutcome: outcomeOf(findings.map(primaryOnly), plant),
    caughtBy: [...new Set(catching.map((f) => f.lens))].sort(),
    named:
      plant.problem === "cross-file" && outcome === "caught"
        ? catching.some((f) => namesPlant(f, plant))
        : null,
    keptOffPlant: findings.filter(
      (f) => f.status === "kept" && !touches(f, around),
    ).length,
  };
};

// One run of one variant

export interface VariantScore {
  readonly variant: number;
  readonly caseId: string;
  readonly problem: string;
  readonly category: string;
  readonly kind: string;
  /** Set C's: the planted file's language, the host range's size class, and whether the host changes that file. */
  readonly set: string;
  readonly language: string | null;
  readonly hostSize: string | null;
  readonly hostTouchesFile: boolean | null;
  /** scored (a complete review: a data point); failed (did not complete); unreadable; missing. */
  readonly status: "scored" | "failed" | "unreadable" | "missing";
  /** Why the review is not a data point; empty when scored. */
  readonly notComplete: ReadonlyArray<string>;
  /** The product reported its own deadline cut-off: still scored, and shown. */
  readonly cutOffByProduct: boolean;
  /** Lenses whose statuses had no finder result to check them against (their catches are flagged). */
  readonly uncheckedLenses: ReadonlyArray<string>;
  /** Whether those lenses' findings decide the outcome (it differs without them). */
  readonly uncheckedChangesOutcome: boolean;
  /** Per lens, whether the finder's own stored result was compared with what was read. */
  readonly nativeCheck: Record<string, NativeCheckState>;
  readonly outcome: Outcome | "unscored";
  /** The same rule on each finding's primary anchor only. */
  readonly primaryOutcome: Outcome | "unscored";
  readonly named: boolean | null;
  readonly caughtBy: ReadonlyArray<string>;
  readonly findings: number;
  readonly kept: number;
  readonly dropped: number;
  readonly unverified: number;
  readonly notSent: number;
  readonly keptOffPlant: number;
  /**
   * How the planted lines, and the beside and related lines, reached the finders: in an opening, fetched by
   * a lookup, and either ("seen"); null where it cannot be told (an opening not measured, or no reads).
   */
  readonly plantViews: Views | null;
  readonly nearViews: Views | null;
  /**
   * The range's changed lines by how they reached the finders (all four together; per finder in `byFinder`):
   * in an opening, fetched by a lookup, and seen (either). `state` says what "in an opening" means: recorded
   * from the `find.opening` row; none (this build's opening holds no changed lines, so 0 is no defect); not
   * measured (handed over without a record); not recorded (a reader before round 2: only "fetched", which
   * then also counted slice B's opening head lines).
   */
  readonly delivery: {
    readonly state:
      "recorded" | "none" | "not measured" | "not recorded" | "no manifest";
    readonly total: { added: number; deleted: number } | null;
    readonly opening: { added: number; deleted: number } | null;
    readonly fetched: { added: number; deleted: number } | null;
    readonly seen: { added: number; deleted: number } | null;
    readonly byFinder: Record<string, z.infer<typeof Delivery>>;
  };
  /** The reader that wrote findings.json, as one string (null before round 2). */
  readonly reader: string | null;
  readonly finders: Record<
    string,
    {
      turns: number | null;
      outputTokens: number | null;
      seconds: number | null;
      endedBy: string | null;
    }
  >;
  /** Every model call of the review, and its tokens; a total is null when any call lacked the field. */
  readonly usage: {
    readonly modelCalls: number | null;
    readonly input: number | null;
    readonly cachedInput: number | null;
    readonly output: number | null;
    readonly reasoning: number | null;
  };
  /**
   * The run's configuration, as one canonical string: its `--env` and `--setting` values, and every
   * runner flag that changes what the product does or when a review is ended (deadline, grace, the
   * heavy-job wrapper, the batch limit).
   */
  readonly config: string | null;
  readonly review: {
    readonly exit: number | null;
    readonly outcome: string | null;
    /** From the review request to the packet's publication: today a packet publishes all its batches at once. */
    readonly secondsToFirstBatch: number | null;
    /** A timing run's seconds only: a quality run's (or an older run's) are skewed by work outside the lock. */
    readonly timingsComparable: boolean;
    readonly timeoutReached: boolean | null;
    readonly killedAfterGrace: boolean;
    readonly wallS: number | null;
    readonly build: string | null;
  };
}

export interface Views {
  /** Some line was in a finder's opening (null: an opening not measured, or a reader before round 2). */
  readonly opening: boolean | null;
  /** Some line was fetched by a lookup. */
  readonly fetched: boolean;
  /** Either (null when the opening is not known). */
  readonly seen: boolean | null;
  /** Per finder: "opening", "fetched", "both", or "" for neither (a "?" marks an unknown opening). */
  readonly finders: Record<string, string>;
}

/** Whether lines reached the finders, by view, kept apart. */
export const viewsOf = (
  reads: NonNullable<Extract<FindingsFile, { status: "read" }>["reads"]>,
  lines: ReadonlyArray<LineRange>,
): Views | null => {
  if (lines.length === 0) return null;
  const hit = (ranges: ReadonlyArray<z.infer<typeof ReadRange>>) =>
    ranges.some(([path, side, startLine, endLine]) =>
      lines.some((l) => overlaps({ path, side, startLine, endLine }, l)),
    );
  const finders: Record<string, string> = {};
  let opening: boolean | null = false;
  let fetched = false;
  for (const [lens, r] of Object.entries(reads)) {
    const known =
      r.openingState !== undefined && r.openingState !== "not measured";
    const shown =
      known && r.opening !== null && r.opening !== undefined
        ? hit(r.opening)
        : null;
    const got = hit(r.read) || hit(r.diff);
    if (shown === null) opening = null;
    else if (shown && opening !== null) opening = true;
    fetched = fetched || got;
    finders[lens] =
      `${shown === null ? "?" : ""}${shown && got ? "both" : shown ? "opening" : got ? "fetched" : ""}`;
  }
  return {
    opening,
    fetched,
    seen: opening === null ? null : opening || fetched,
    finders,
  };
};

/** One canonical string for a JSON value: object keys sorted, so equal configurations compare equal. */
export const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value !== null && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map(
            (k) =>
              `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`,
          )
          .join(",")}}`
      : JSON.stringify(value);

/** Why a review is not a data point (the module comment's rule); empty when it is one. */
/**
 * Why a review is not a data point, from its export alone (no finder lenses): a non-zero exit (unless the
 * product reports its own deadline cut-off and published), killed after grace, or a case that did not end.
 */
export const reviewNotComplete = (exported: ExportFile): string[] => {
  const why: string[] = [];
  const cutOff =
    exported.timeoutReached === true && exported.published === true;
  if (exported.exit !== 0 && !cutOff) why.push(`exit ${exported.exit}`);
  if (exported.killedAfterGrace === true) why.push("killed after grace");
  const ended = exported.machine?.end;
  if (
    (ended?.membersLeft ?? 0) > 0 ||
    (ended?.outsideGroup ?? 0) > 0 ||
    ended?.listingFailed === true
  )
    why.push("the case did not end");
  return why;
};

/** Why a review is not a data point for the finders' gate: `reviewNotComplete`, then the finder lenses. */
export const notCompleteOf = (
  findings: FindingsFile,
  exported: ExportFile,
): string[] => {
  const why = reviewNotComplete(exported);
  if (findings.status !== "read") why.push(findings.status);
  else
    for (const lens of LENSES) {
      const held = findings.lenses[lens];
      if (held === undefined) why.push(`${lens}: not in the findings record`);
      else if (held.output === "none" && held.finderResult !== true)
        why.push(`${lens}: neither a Find output nor a finder result`);
    }
  return why;
};

export const scoreVariant = (
  plant: Plant,
  findings: FindingsFile | null,
  exported: ExportFile | null,
): VariantScore => {
  const review = {
    exit: exported?.exit ?? null,
    outcome: exported?.outcome ?? null,
    secondsToFirstBatch: exported?.secondsToFirstBatch ?? null,
    timingsComparable: exported?.timingsComparable === true,
    timeoutReached: exported?.timeoutReached ?? null,
    killedAfterGrace: exported?.killedAfterGrace ?? false,
    wallS: exported?.wallS ?? null,
    build: exported?.build.commit ?? null,
  };
  const finders = Object.fromEntries(
    LENSES.map((lens) => {
      const f = exported?.finders?.[lens];
      return [
        lens,
        {
          turns: f?.turns ?? null,
          outputTokens: f?.outputTokens ?? null,
          seconds: f?.seconds ?? null,
          endedBy: f?.endedBy ?? (f?.resultPresent === false ? "absent" : null),
        },
      ];
    }),
  );
  const range = exported?.rangeLines;
  const total =
    range?.added === undefined || range.deleted === undefined
      ? null
      : { added: range.added, deleted: range.deleted };
  const all = range?.allFinders;
  const delivery: VariantScore["delivery"] =
    all !== undefined
      ? {
          state: all.openingState,
          total,
          opening: all.opening,
          fetched: all.fetched,
          seen: all.seen,
          byFinder: Object.fromEntries(
            Object.entries(range?.byFinder ?? {}).flatMap(([lens, d]) =>
              "openingState" in d
                ? [[lens, d as z.infer<typeof Delivery>]]
                : [],
            ),
          ),
        }
      : {
          // A reader of round 2 that found no range manifest writes no views; only an older reader
          // writes `anyFinder` (its fetched count, which also held slice B's opening head lines).
          state:
            range?.status === "no-manifest" && range.anyFinder === undefined
              ? "no manifest"
              : "not recorded",
          total,
          opening: null,
          fetched:
            range?.anyFinder === undefined
              ? null
              : {
                  added: range.anyFinder.newRead,
                  deleted: range.anyFinder.oldRead,
                },
          seen: null,
          byFinder: {},
        };
  const tokens = exported?.usage?.tokens;
  const known = (t: { total: number; unknownCalls: number } | undefined) =>
    t === undefined || t.unknownCalls > 0 ? null : t.total;
  const usage = {
    modelCalls: exported?.usage?.modelCalls ?? null,
    input: known(tokens?.input),
    cachedInput: known(tokens?.cachedInput),
    output: known(tokens?.output),
    reasoning: known(tokens?.reasoning),
  };
  const base = {
    variant: plant.variant,
    caseId: plant.caseId,
    problem: plant.problem,
    category: categoryOf(plant),
    kind: plant.kind,
    set: plant.set ?? "B",
    language: plant.language ?? null,
    hostSize: plant.hostSize?.size ?? null,
    hostTouchesFile: plant.hostTouchesFile ?? null,
    config:
      exported === null
        ? null
        : canonical({
            env: exported.env ?? {},
            settings: exported.settings ?? {},
            deadlineMinutes: exported.deadlineMinutes ?? null,
            graceMinutes: exported.graceMinutes ?? null,
            wrapper: exported.wrapper ?? null,
            batchLimitMinutes: exported.batchLimitMinutes ?? null,
          }),
    cutOffByProduct: exported?.timeoutReached === true,
    review,
    usage,
    finders,
    delivery,
    reader:
      findings !== null && findings.status === "read" && findings.reader
        ? canonical(findings.reader)
        : null,
  };
  const empty = {
    named: null,
    caughtBy: [],
    uncheckedLenses: [],
    uncheckedChangesOutcome: false,
    nativeCheck: {},
    outcome: "unscored" as const,
    primaryOutcome: "unscored" as const,
    findings: 0,
    kept: 0,
    dropped: 0,
    unverified: 0,
    notSent: 0,
    keptOffPlant: 0,
    plantViews: null,
    nearViews: null,
  };
  if (findings === null || exported === null)
    return {
      ...base,
      ...empty,
      status: "missing",
      notComplete: ["no finished run"],
    };
  const why = notCompleteOf(findings, exported);
  if (findings.status !== "read" || why.length > 0)
    return {
      ...base,
      ...empty,
      status: findings.status === "unreadable" ? "unreadable" : "failed",
      notComplete: why,
    };
  const caught = catchOf(findings.findings, plant);
  const unchecked = LENSES.filter(
    (lens) => findings.lenses[lens]?.runLog === "no-finder-result",
  );
  const withoutUnchecked = catchOf(
    findings.findings.filter((f) => !unchecked.includes(f.lens)),
    plant,
  ).outcome;
  const count = (s: z.infer<typeof Status>) =>
    findings.findings.filter((f) => f.status === s).length;
  return {
    ...base,
    status: "scored",
    notComplete: [],
    uncheckedLenses: unchecked,
    uncheckedChangesOutcome: withoutUnchecked !== caught.outcome,
    nativeCheck: Object.fromEntries(
      LENSES.map((lens) => {
        const held = findings.lenses[lens];
        return [
          lens,
          held === undefined ? "not recorded" : nativeCheckOf(held),
        ];
      }),
    ),
    outcome: caught.outcome,
    primaryOutcome: caught.primaryOutcome,
    named: caught.named,
    caughtBy: caught.caughtBy,
    findings: count("kept") + count("dropped") + count("unverified"),
    kept: count("kept"),
    dropped: count("dropped"),
    unverified: count("unverified"),
    notSent: count("deduplicated") + count("over-cap") + count("no-group"),
    keptOffPlant: caught.keptOffPlant,
    plantViews:
      findings.reads === null ? null : viewsOf(findings.reads, plant.lines),
    nearViews:
      findings.reads === null
        ? null
        : viewsOf(findings.reads, [
            ...(plant.beside ?? []),
            ...(plant.related ?? []),
          ]),
  };
};

// Sums

const sumKnown = (values: ReadonlyArray<number | null>) => ({
  total: values.reduce<number>((s, v) => s + (v ?? 0), 0),
  unknown: values.filter((v) => v === null).length,
});
const finderTotal = (
  v: VariantScore,
  key: "turns" | "outputTokens" | "seconds",
) => {
  const values = LENSES.map((lens) => v.finders[lens]?.[key] ?? null);
  return values.some((x) => x === null)
    ? null
    : values.reduce<number>((s, x) => s + (x ?? 0), 0);
};

/**
 * How the change reached the finders in these reviews: "opening" when some opening handed changed lines
 * over (recorded, or not measured), "lookups" when every opening is known to hold none, "unknown" when a
 * reader before round 2 wrote them (re-read with `collect --again`).
 */
export const deliveredBy = (scores: ReadonlyArray<VariantScore>) => {
  const scored = scores.filter((s) => s.status === "scored");
  if (
    scored.some(
      (s) =>
        s.delivery.state === "not measured" ||
        (s.delivery.state === "recorded" &&
          (s.delivery.opening?.added ?? 0) +
            (s.delivery.opening?.deleted ?? 0) >
            0),
    )
  )
    return "opening";
  if (
    scored.some(
      (s) =>
        s.delivery.state === "not recorded" ||
        s.delivery.state === "no manifest",
    )
  )
    return "unknown";
  return "lookups";
};

/** Counts over the variants that are data points; reviews that are not are counted by status, apart. */
export const summarise = (all: ReadonlyArray<VariantScore>) => {
  const scores = all.filter((s) => s.status === "scored");
  const of = (o: Outcome) => scores.filter((s) => s.outcome === o).length;
  const endedBy: Record<string, number> = {};
  for (const s of scores)
    for (const lens of LENSES) {
      const e = s.finders[lens]?.endedBy ?? "unknown";
      endedBy[`${lens}:${e}`] = (endedBy[`${lens}:${e}`] ?? 0) + 1;
    }
  return {
    variants: all.length,
    scored: scores.length,
    failed: all.filter((s) => s.status === "failed").length,
    unreadable: all.filter((s) => s.status === "unreadable").length,
    missing: all.filter((s) => s.status === "missing").length,
    caught: of("caught"),
    caughtBeside: of("caught-beside"),
    caughtOrBeside: of("caught") + of("caught-beside"),
    foundNotKept: of("found-not-kept"),
    missed: of("missed"),
    caughtByPrimaryAnchor: scores.filter((s) => s.primaryOutcome === "caught")
      .length,
    caughtNamed: scores.filter((s) => s.named === true).length,
    caughtUnnamed: scores.filter((s) => s.named === false).length,
    caughtBy: Object.fromEntries(
      LENSES.map((lens) => [
        lens,
        scores.filter((s) => s.caughtBy.includes(lens)).length,
      ]),
    ),
    cutOffByProduct: scores.filter((s) => s.cutOffByProduct).length,
    withUncheckedLenses: scores.filter((s) => s.uncheckedLenses.length > 0)
      .length,
    nativeChecks: scores.reduce<Record<string, number>>((t, s) => {
      for (const state of Object.values(s.nativeCheck))
        t[state] = (t[state] ?? 0) + 1;
      return t;
    }, {}),
    findings: scores.reduce((t, s) => t + s.findings, 0),
    kept: scores.reduce((t, s) => t + s.kept, 0),
    keptOffPlant: scores.reduce((t, s) => t + s.keptOffPlant, 0),
    /** Planted lines that reached a finder, by view: in an opening, fetched, seen (either). */
    planted: {
      opening: scores.filter((s) => s.plantViews?.opening === true).length,
      fetched: scores.filter((s) => s.plantViews?.fetched === true).length,
      seen: scores.filter((s) => s.plantViews?.seen === true).length,
      openingUnknown: scores.filter((s) => s.plantViews?.opening === null)
        .length,
    },
    near: {
      opening: scores.filter((s) => s.nearViews?.opening === true).length,
      fetched: scores.filter((s) => s.nearViews?.fetched === true).length,
      seen: scores.filter((s) => s.nearViews?.seen === true).length,
      withNearLines: scores.filter((s) => s.nearViews !== null).length,
      openingUnknown: scores.filter((s) => s.nearViews?.opening === null)
        .length,
    },
    /** The range's changed lines by view, summed over the reviews where each view is known. */
    delivery: (["opening", "fetched", "seen"] as const).reduce<
      Record<string, { added: number; deleted: number; unknown: number }>
    >((t, view) => {
      const known = scores.map((s) => s.delivery[view]);
      t[view] = {
        added: known.reduce((n, v) => n + (v?.added ?? 0), 0),
        deleted: known.reduce((n, v) => n + (v?.deleted ?? 0), 0),
        unknown: known.filter((v) => v === null).length,
      };
      return t;
    }, {}),
    deliveryStates: scores.reduce<Record<string, number>>((t, s) => {
      t[s.delivery.state] = (t[s.delivery.state] ?? 0) + 1;
      return t;
    }, {}),
    /** How the change reached the finders in these reviews: lookups only, or (also) in the opening. */
    deliveredBy: deliveredBy(scores),
    readers: [...new Set(scores.map((s) => s.reader))],
    finderTurns: sumKnown(scores.map((s) => finderTotal(s, "turns"))),
    finderOutputTokens: sumKnown(
      scores.map((s) => finderTotal(s, "outputTokens")),
    ),
    finderSeconds: sumKnown(scores.map((s) => finderTotal(s, "seconds"))),
    wallS: sumKnown(scores.map((s) => s.review.wallS)),
    secondsToFirstBatch: sumKnown(
      scores.map((s) => s.review.secondsToFirstBatch),
    ),
    modelCalls: sumKnown(scores.map((s) => s.usage.modelCalls)),
    tokens: {
      input: sumKnown(scores.map((s) => s.usage.input)),
      cachedInput: sumKnown(scores.map((s) => s.usage.cachedInput)),
      output: sumKnown(scores.map((s) => s.usage.output)),
      reasoning: sumKnown(scores.map((s) => s.usage.reasoning)),
    },
    /** Whether every variant's seconds come from a timing run; else every seconds measure here is not comparable. */
    timingsComparable:
      scores.length > 0 && scores.every((s) => s.review.timingsComparable),
    reviewOutcomes: all.reduce<Record<string, number>>((t, s) => {
      const o =
        s.review.outcome ?? (s.status === "missing" ? "missing" : "none");
      t[o] = (t[o] ?? 0) + 1;
      return t;
    }, {}),
    finderEndedBy: endedBy,
  };
};
export type Summary = ReturnType<typeof summarise>;

const groupBy = (
  scores: ReadonlyArray<VariantScore>,
  key: (s: VariantScore) => string,
) => {
  const groups = new Map<string, VariantScore[]>();
  for (const s of scores)
    groups.set(key(s), [...(groups.get(key(s)) ?? []), s]);
  return [...groups].sort(([a], [b]) => a.localeCompare(b));
};

/** Per category, with its problems as the second level (set B's eleven under `light-file`). */
export const byCategory = (scores: ReadonlyArray<VariantScore>) =>
  Object.fromEntries(
    groupBy(scores, (s) => s.category).map(([category, group]) => [
      category,
      {
        ...summarise(group),
        problems: Object.fromEntries(
          groupBy(group, (s) => s.problem).map(([p, g]) => [p, summarise(g)]),
        ),
      },
    ]),
  );

/**
 * What the redesign will need that today's records and collector cannot give, each with what it
 * would take. The gate reports these as not measured and never fills them in.
 */
export const NOT_MEASURED = [
  {
    measure:
      "sections that reach the human-required backstop, by cause (failed, not reached, unsure, unconfirmed claim)",
    why: "a published unit records its lane and the lane rule's note (complexity against how hard it is to validate); no record says that a section fell back to human-required, or why",
    wouldTake:
      "the step that sends a section to the backstop to record the cause with the section (one of the four), and the collector to count those records per run",
  },
  {
    measure:
      "published approvals later reversed within a run (the bar is zero)",
    why: "a run publishes its packet once, at the end; nothing records an approval that was published and then withdrawn before the run ended, because there is no earlier publication to reverse",
    wouldTake:
      "batches published as they finish, each verdict recorded when published, and a record when a later stage changes a published verdict; the collector then counts reversals per run",
  },
  {
    measure:
      "answer characters per section where one call covers several sections",
    why: "the collector counts streamed characters per call and per stage, not per section within a call's answer",
    wouldTake:
      "the step to record, per call that covers several sections, each section's share of the answer (characters of the part that answers it), or a structured answer the collector can split by section",
  },
];

// Reading a set and a run

export interface SetVariant {
  readonly plant: Plant;
  readonly source: string;
  readonly number: number;
  readonly index: string;
  readonly casePath: string;
  /** The pinned case's range, which every run of the variant must have reviewed. */
  readonly base: string;
  readonly head: string;
}

const sha = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const Pinned = z.looseObject({ path: z.string(), sha256: z.string() });

/** A set index's variants, every `{path, sha256}` it pins checked; a changed record is refused. */
export const readSet = (index: string): Array<SetVariant> => {
  const read = z
    .looseObject({ variants: z.array(z.record(z.string(), z.unknown())) })
    .parse(JSON.parse(readFileSync(index, "utf8")));
  return read.variants.map((entry) => {
    for (const value of Object.values(entry)) {
      const pinned = Pinned.safeParse(value);
      if (pinned.success && sha(pinned.data.path) !== pinned.data.sha256)
        throw new Error(`${pinned.data.path} changed since ${index} was built`);
    }
    const planted = Pinned.parse(entry["planted"]);
    const record = Pinned.parse(entry["case"]);
    const kase = z
      .looseObject({
        source: z.string(),
        number: z.int(),
        clone: z.looseObject({ path: z.string() }).optional(),
        firstRevision: z.looseObject({ base: z.string(), head: z.string() }),
      })
      .parse(JSON.parse(readFileSync(record.path, "utf8")));
    // A pinned replay ref (set C) must still name the commit the index recorded.
    const replay = z
      .looseObject({ ref: z.string(), commit: z.string() })
      .safeParse(entry["replay"]);
    if (replay.success) {
      const at = spawnSync(
        "git",
        [
          "-C",
          kase.clone?.path ?? "",
          "rev-parse",
          "--verify",
          `${replay.data.ref}^{commit}`,
        ],
        { encoding: "utf8" },
      );
      if (at.status !== 0 || at.stdout.trim() !== replay.data.commit)
        throw new Error(
          `${record.path}: its replay clone's ${replay.data.ref} is not ${replay.data.commit.slice(0, 12)}, as ${index} pins`,
        );
    }
    return {
      plant: parsePlant(
        JSON.parse(readFileSync(planted.path, "utf8")),
        planted.path,
      ),
      source: kase.source,
      number: kase.number,
      index,
      casePath: record.path,
      base: kase.firstRevision.base,
      head: kase.firstRevision.head,
    };
  });
};

export const readSets = (indexes: ReadonlyArray<string>) => {
  const all = indexes.flatMap(readSet);
  const seen = new Set<string>();
  for (const v of all) {
    const key = `${v.source}/${v.number}`;
    if (seen.has(key)) throw new Error(`${key} is in more than one set`);
    seen.add(key);
  }
  return all;
};

export const runFolder = (
  root: string,
  v: { source: string; number: number },
  run: string,
) => join(root, v.source, String(v.number), "run", run);

const RUN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const readRun = (
  root: string,
  v: SetVariant,
  run: string,
): { findings: FindingsFile | null; exported: ExportFile | null } => {
  if (!RUN_NAME.test(run))
    throw new Error(`--run ${run} is not a run folder's name`);
  const folder = runFolder(root, v, run);
  const json = (name: string) =>
    existsSync(join(folder, name))
      ? (JSON.parse(readFileSync(join(folder, name), "utf8")) as unknown)
      : null;
  const findings = json("findings.json");
  const raw = json("export.json") as { finished?: unknown } | null;
  // A review recorded but not read yet (the runner writes its record inside the ticket) is not a run yet.
  if (raw === null || raw.finished !== true)
    return { findings: null, exported: null };
  // A file that is present but malformed is an error, never an absent run.
  const exported = ExportFile.parse(raw);
  if (exported.case.base !== v.base || exported.case.head !== v.head)
    throw new Error(
      `${folder}: the run reviewed ${exported.case.base.slice(0, 12)}..${exported.case.head.slice(0, 12)}, not the pinned case's range`,
    );
  return {
    findings: findings === null ? null : FindingsFile.parse(findings),
    exported,
  };
};

export const scoreRun = (
  root: string,
  run: string,
  variants: ReadonlyArray<SetVariant>,
) => {
  const scores = variants.map((v) => {
    const { findings, exported } = readRun(root, v, run);
    return scoreVariant(v.plant, findings, exported);
  });
  const present = scores.filter((s) => s.status !== "missing");
  return {
    run,
    /** Every build and configuration the run's finished reviews used; `null` is an unknown build. */
    builds: [...new Set(present.map((s) => s.review.build))],
    configs: [...new Set(present.map((s) => s.config))],
    variants: scores,
    byCategory: byCategory(scores),
    overall: summarise(scores),
    notMeasured: NOT_MEASURED,
  };
};
export type RunScore = ReturnType<typeof scoreRun>;

// Comparing a candidate with two baseline runs

export const DATA_POINT_RULE =
  "Data points: a variant enters the comparison only when its review is complete (status scored) in all three runs. A review that failed, was killed after grace, made no run, could not be read, is missing, or has a lens with neither a Find output nor a finder result is counted per run and kept out of every catch count, flip and numeric pair; while any run has one, acceptance fails. A deadline cut-off the product itself reports is scored and shown.";
export const CATCH_RULE =
  "Catch noise: over the data points, a variant is unstable when its outcome (caught or not) differs between the two baseline runs; the noise bar of a category is its unstable count. On stable variants, a candidate that loses a catch both baselines made counts as lost, and one that catches what neither baseline caught counts as gained. The candidate is better than noise when gained > lost, worse when lost > gained, and within noise when they are equal; unstable variants never count either way. The second line applies the same rule to caught or caught beside the plant.";
export const NUMERIC_RULE =
  "Numeric noise: over the data points with the measure known in all three runs, d_i = baseline-again_i - baseline_i and D = sum of (candidate_i - (baseline_i + baseline-again_i) / 2). If the two baselines are draws of the same build with per-variant variance s^2, var(d_i) = 2 s^2 and var(D) = 1.5 n s^2 = 0.75 sum(d_i^2). The bar is 2 sqrt(0.75 sum(d_i^2)); |D| at or under it is within noise, over it the measure moved (better or worse by the measure's direction). A bar of 0 (the baselines agree exactly) makes any change a move.";
export const DELIVERY_RULE =
  'Delivery: how the change reaches a finder, in its opening or by lookups. When the three runs differ in it, only the measures that mean the same either way are rated (seen, catches, counts, cost); the opening and fetched shares, and planted lines in the opening or fetched, are printed and not rated. On a build whose opening holds no changed lines, "in the opening" is 0 by construction, not a defect.';
export const BOUND_RULE =
  "What a pass can exclude: with c plants caught by both baseline runs and none of them lost by the candidate, the one-sided 95% upper bound on the candidate's loss rate is 1 - 0.05^(1/c) (c = 3 bounds it only under 63%); it is given only when nothing was lost.";
export const TIMING_RULE =
  "Seconds (finder seconds, wall time, time to the packet's publication) are rated better or worse only when all three runs are timing runs (--purpose timing: one review per ticket of the check lock). A quality run's seconds are printed but not comparable: other lanes work outside the lock.";
export const SECONDS_MEASURES = [
  "finderSeconds",
  "wallS",
  "secondsToFirstBatch",
];
export const CONFIG_RULE =
  "Configuration: each run holds one known build and one configuration (its --env and --setting values); the two baseline runs hold the same ones; the three run names differ. Otherwise acceptance fails.";
export const ACCEPTANCE_RULE =
  "Acceptance: every variant is a data point in all three runs; the configuration rule holds; no category has fewer catches (the headline rule, caught) in the candidate than the lower of the two baseline runs; and kept findings off the plant are not up beyond the numeric noise bar.";
/** Below this many variants a category's bar means little: one flip is more than a sixth of it. */
export const THIN_BELOW = 6;

type Verdict =
  | "better"
  | "within noise"
  | "worse"
  | "up"
  | "down"
  | "not rated: not all timing runs"
  | "not rated: the change reaches the finders differently";
type Level = "caught" | "caught-or-beside";

export const catchComparison = (
  baseline: ReadonlyArray<VariantScore>,
  again: ReadonlyArray<VariantScore>,
  candidate: ReadonlyArray<VariantScore>,
  level: Level = "caught",
) => {
  const caught = (s: VariantScore | undefined) =>
    s?.outcome === "caught" ||
    (level === "caught-or-beside" && s?.outcome === "caught-beside");
  const key = (s: VariantScore) => s.variant;
  const b = new Map(baseline.map((s) => [key(s), s]));
  const a = new Map(again.map((s) => [key(s), s]));
  let unstable = 0;
  let lost = 0;
  let gained = 0;
  let bothCaught = 0;
  for (const c of candidate) {
    const x = b.get(key(c));
    const y = a.get(key(c));
    if (caught(x) !== caught(y)) {
      unstable += 1;
      continue;
    }
    if (caught(x)) bothCaught += 1;
    if (caught(x) && !caught(c)) lost += 1;
    if (!caught(x) && caught(c)) gained += 1;
  }
  const count = (s: ReadonlyArray<VariantScore>) =>
    s.filter((v) => caught(v)).length;
  const lower = Math.min(count(baseline), count(again));
  const verdict: Verdict =
    gained > lost ? "better" : lost > gained ? "worse" : "within noise";
  return {
    level,
    variants: candidate.length,
    caught: {
      baseline: count(baseline),
      baselineAgain: count(again),
      candidate: count(candidate),
    },
    flips: unstable,
    lost,
    gained,
    verdict,
    holds: count(candidate) >= lower,
    thin: candidate.length < THIN_BELOW,
    /** Plants both baseline runs caught, and what no lost catch among them can exclude (one-sided 95%). */
    bothBaselinesCaught: bothCaught,
    lossRateUpperBound:
      lost > 0 ? null : bothCaught === 0 ? 1 : 1 - 0.05 ** (1 / bothCaught),
  };
};

const flag = (v: boolean | null | undefined) =>
  v === null || v === undefined ? null : v ? 1 : 0;
const share = (s: VariantScore, view: "opening" | "fetched" | "seen") => {
  const t = s.delivery.total;
  const v = s.delivery[view];
  return t === null || v === null || t.added + t.deleted === 0
    ? null
    : (v.added + v.deleted) / (t.added + t.deleted);
};

export const MEASURES: ReadonlyArray<{
  name: string;
  direction: "lower" | "higher" | "none";
  /** False for a measure whose meaning changes with how the change reaches the finders (opening or lookups). */
  sameAcrossDelivery?: boolean;
  of: (s: VariantScore) => number | null;
}> = [
  { name: "findings", direction: "none", of: (s) => s.findings },
  { name: "kept", direction: "none", of: (s) => s.kept },
  { name: "keptOffPlant", direction: "lower", of: (s) => s.keptOffPlant },
  {
    name: "plantedSeen",
    direction: "higher",
    of: (s) => flag(s.plantViews?.seen),
  },
  {
    name: "plantedFetched",
    direction: "higher",
    sameAcrossDelivery: false,
    of: (s) => flag(s.plantViews?.fetched),
  },
  {
    name: "plantedInOpening",
    direction: "higher",
    sameAcrossDelivery: false,
    of: (s) => flag(s.plantViews?.opening),
  },
  { name: "nearSeen", direction: "higher", of: (s) => flag(s.nearViews?.seen) },
  {
    name: "rangeSeenShare",
    direction: "higher",
    of: (s) => share(s, "seen"),
  },
  {
    name: "rangeFetchedShare",
    direction: "higher",
    sameAcrossDelivery: false,
    of: (s) => share(s, "fetched"),
  },
  {
    name: "rangeOpeningShare",
    direction: "higher",
    sameAcrossDelivery: false,
    of: (s) => share(s, "opening"),
  },
  { name: "modelCalls", direction: "lower", of: (s) => s.usage.modelCalls },
  { name: "inputTokens", direction: "lower", of: (s) => s.usage.input },
  { name: "outputTokens", direction: "lower", of: (s) => s.usage.output },
  {
    name: "reasoningTokens",
    direction: "lower",
    of: (s) => s.usage.reasoning,
  },
  {
    name: "secondsToFirstBatch",
    direction: "lower",
    of: (s) => s.review.secondsToFirstBatch,
  },
  {
    name: "finderTurns",
    direction: "lower",
    of: (s) => finderTotal(s, "turns"),
  },
  {
    name: "finderOutputTokens",
    direction: "lower",
    of: (s) => finderTotal(s, "outputTokens"),
  },
  {
    name: "finderSeconds",
    direction: "lower",
    of: (s) => finderTotal(s, "seconds"),
  },
  { name: "wallS", direction: "lower", of: (s) => s.review.wallS },
];

export const numericComparison = (
  baseline: ReadonlyArray<VariantScore>,
  again: ReadonlyArray<VariantScore>,
  candidate: ReadonlyArray<VariantScore>,
  measure: (typeof MEASURES)[number],
  timing = true,
  deliveryDiffers = false,
) => {
  const b = new Map(baseline.map((s) => [s.variant, measure.of(s)]));
  const a = new Map(again.map((s) => [s.variant, measure.of(s)]));
  let n = 0;
  let squares = 0;
  let shift = 0;
  const sums = { baseline: 0, baselineAgain: 0, candidate: 0 };
  for (const s of candidate) {
    const x = b.get(s.variant);
    const y = a.get(s.variant);
    const c = measure.of(s);
    if (x === undefined || y === undefined || x === null || y === null)
      continue;
    if (c === null) continue;
    n += 1;
    squares += (y - x) ** 2;
    shift += c - (x + y) / 2;
    sums.baseline += x;
    sums.baselineAgain += y;
    sums.candidate += c;
  }
  const bar = 2 * Math.sqrt(0.75 * squares);
  const moved = Math.abs(shift) > bar + 1e-9;
  const verdict: Verdict =
    measure.sameAcrossDelivery === false && deliveryDiffers
      ? "not rated: the change reaches the finders differently"
      : SECONDS_MEASURES.includes(measure.name) && !timing
        ? "not rated: not all timing runs"
        : !moved
          ? "within noise"
          : measure.direction === "none"
            ? shift > 0
              ? "up"
              : "down"
            : shift < 0 === (measure.direction === "lower")
              ? "better"
              : "worse";
  return {
    measure: measure.name,
    direction: measure.direction,
    pairedVariants: n,
    sums,
    candidateShift: shift,
    bar,
    verdict,
  };
};

/** A run's reviews that are not data points, and what it ran with. */
const runRecord = (r: RunScore) => ({
  run: r.run,
  builds: r.builds,
  configs: r.configs,
  scored: r.overall.scored,
  failed: r.overall.failed,
  unreadable: r.overall.unreadable,
  missing: r.overall.missing,
  cutOffByProduct: r.overall.cutOffByProduct,
  withUncheckedLenses: r.overall.withUncheckedLenses,
  notDataPoints: r.variants
    .filter((v) => v.status !== "scored")
    .map((v) => ({
      variant: v.variant,
      status: v.status,
      notComplete: v.notComplete,
    })),
});

export const configurationProblems = (
  baseline: RunScore,
  again: RunScore,
  candidate: RunScore,
) => {
  const problems: string[] = [];
  const names = [baseline.run, again.run, candidate.run];
  if (new Set(names).size < 3)
    problems.push(`the three run names are not distinct (${names.join(", ")})`);
  for (const r of [baseline, again, candidate]) {
    if (r.builds.includes(null)) problems.push(`${r.run}: an unknown build`);
    if (r.builds.length > 1)
      problems.push(`${r.run}: ${r.builds.length} builds in one run`);
    if (r.configs.length > 1)
      problems.push(`${r.run}: ${r.configs.length} configurations in one run`);
  }
  const same = (x: ReadonlyArray<unknown>, y: ReadonlyArray<unknown>) =>
    x.length === y.length && x.every((v) => y.includes(v));
  if (!same(baseline.builds, again.builds))
    problems.push("the two baseline runs used different builds");
  if (!same(baseline.configs, again.configs))
    problems.push("the two baseline runs used different configurations");
  return problems;
};

export const compareRuns = (
  baseline: RunScore,
  again: RunScore,
  candidate: RunScore,
) => {
  const runs = [baseline, again, candidate];
  const timing = runs.every((r) =>
    r.variants.every((v) => v.review.timingsComparable),
  );
  const delivered = runs.map((r) => deliveredBy(r.variants));
  /** The baseline and the candidate differ in how the change reaches the finders (opening against lookups). */
  const deliveryDiffers = new Set(delivered).size > 1;
  const scoredIn = (r: RunScore) =>
    new Set(
      r.variants.filter((v) => v.status === "scored").map((v) => v.variant),
    );
  const [x, y, z_] = runs.map(scoredIn) as [
    Set<number>,
    Set<number>,
    Set<number>,
  ];
  const common = new Set([...x].filter((v) => y.has(v) && z_.has(v)));
  const pick = (r: RunScore, keep?: (v: VariantScore) => boolean) =>
    r.variants.filter(
      (v) => common.has(v.variant) && (keep === undefined || keep(v)),
    );
  const side = (keep?: (v: VariantScore) => boolean) => {
    const catches = catchComparison(
      pick(baseline, keep),
      pick(again, keep),
      pick(candidate, keep),
    );
    const orBeside = catchComparison(
      pick(baseline, keep),
      pick(again, keep),
      pick(candidate, keep),
      "caught-or-beside",
    );
    return {
      catches,
      catchesOrBeside: orBeside,
      /** The second line would give another verdict, or another answer to "fewer than the lower baseline". */
      linesDisagree:
        catches.verdict !== orBeside.verdict ||
        catches.holds !== orBeside.holds,
      measures: MEASURES.map((m) =>
        numericComparison(
          pick(baseline, keep),
          pick(again, keep),
          pick(candidate, keep),
          m,
          timing,
          deliveryDiffers,
        ),
      ),
    };
  };
  const names = (of: (v: VariantScore) => string) =>
    [...new Set(candidate.variants.map(of))].sort();
  const categories = Object.fromEntries(
    names((v) => v.category).map((c) => [
      c,
      {
        ...side((v) => v.category === c),
        problems:
          c !== LIGHT_FILE
            ? {}
            : Object.fromEntries(
                names((v) => v.problem)
                  .filter((p) =>
                    candidate.variants.some(
                      (v) => v.problem === p && v.category === c,
                    ),
                  )
                  .map((p) => [p, side((v) => v.problem === p).catches]),
              ),
      },
    ]),
  );
  const overall = side();
  const perRun = runs.map(runRecord);
  const notDataPoints = perRun.flatMap((r) =>
    r.notDataPoints.map((v) => ({ run: r.run, ...v })),
  );
  const configuration = configurationProblems(baseline, again, candidate);
  const failing = Object.entries(categories)
    .filter(([, c]) => !c.catches.holds)
    .map(([p]) => p);
  const offPlant = overall.measures.find((m) => m.measure === "keptOffPlant")!;
  const thin = Object.entries(categories)
    .filter(([, c]) => c.catches.thin)
    .map(([p, c]) => ({ category: p, variants: c.catches.variants }));
  const withUnchecked = runs.reduce(
    (t, r) => t + r.variants.filter((v) => v.uncheckedLenses.length > 0).length,
    0,
  );
  const unchecked = runs.flatMap((r) =>
    r.variants
      .filter((v) => v.uncheckedChangesOutcome)
      .map((v) => ({
        run: r.run,
        variant: v.variant,
        lenses: v.uncheckedLenses,
      })),
  );
  return {
    rules: {
      dataPoints: DATA_POINT_RULE,
      catches: CATCH_RULE,
      numeric: NUMERIC_RULE,
      configuration: CONFIG_RULE,
      acceptance: ACCEPTANCE_RULE,
      timing: TIMING_RULE,
      bound: BOUND_RULE,
      thinBelow: THIN_BELOW,
    },
    timingsComparable: timing,
    delivery: {
      baseline: delivered[0],
      baselineAgain: delivered[1],
      candidate: delivered[2],
      differs: deliveryDiffers,
      rule: DELIVERY_RULE,
    },
    readers: {
      baseline: baseline.overall.readers,
      baselineAgain: again.overall.readers,
      candidate: candidate.overall.readers,
      differ:
        new Set(
          runs.flatMap((r) =>
            r.overall.readers.map((x) => x ?? "before round 2"),
          ),
        ).size > 1,
    },
    dataPoints: common.size,
    runs: perRun,
    overall,
    categories,
    acceptance: {
      passes:
        notDataPoints.length === 0 &&
        configuration.length === 0 &&
        failing.length === 0 &&
        offPlant.verdict !== "worse",
      notDataPoints,
      configuration,
      categoriesWithFewerCatches: failing,
      keptOffPlant: offPlant.verdict,
      thin,
      /** Variants whose outcome rests on lenses the run log could not check (flagged, not refused), and how many variants had such a lens at all. */
      uncheckedLenses: unchecked,
      withUncheckedLenses: withUnchecked,
      linesDisagree: Object.entries(categories)
        .filter(([, c]) => c.linesDisagree)
        .map(([p]) => p),
    },
  };
};

// The merit pack: kept findings off the plant, blind, for an independent reviewer

export interface PackItem {
  readonly item: string;
  readonly lens: string;
  readonly kind: string;
  readonly claim: string;
  readonly evidence: ReadonlyArray<string>;
  readonly anchors: ReadonlyArray<LineRange>;
  readonly cited: ReadonlyArray<{
    path: string;
    side: string;
    startLine: number;
    endLine: number;
    lines: ReadonlyArray<{ n: number; text: string }> | null;
  }>;
  readonly mark: null;
}
export interface KeyEntry {
  readonly run: string;
  readonly variant: number;
  readonly finding: string;
}

/** Fisher–Yates with a cryptographic source, so the order says nothing about the run. */
const shuffle = <T>(items: T[]) => {
  for (let i = items.length - 1; i > 0; i--) {
    const j = randomBytes(4).readUInt32BE(0) % (i + 1);
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
};

export const meritPack = (
  entries: ReadonlyArray<{
    run: string;
    variant: SetVariant;
    findings: ReadonlyArray<StoredFinding>;
  }>,
  lines: (
    v: SetVariant,
    anchor: LineRange,
  ) => ReadonlyArray<{ n: number; text: string }> | null,
) => {
  const packId = randomBytes(8).toString("hex");
  const key: Record<string, KeyEntry> = {};
  const items: PackItem[] = [];
  for (const { run, variant, findings } of entries) {
    const around = [
      ...variant.plant.lines,
      ...(variant.plant.related ?? []),
      ...(variant.plant.beside ?? []),
    ];
    for (const f of findings) {
      if (f.status !== "kept" || touches(f, around)) continue;
      let item = randomBytes(5).toString("hex");
      while (key[item] !== undefined) item = randomBytes(5).toString("hex");
      key[item] = { run, variant: variant.plant.variant, finding: f.id };
      items.push({
        item,
        lens: f.lens,
        kind: f.kind,
        claim: f.claim,
        evidence: f.evidence ?? [],
        anchors: f.anchors,
        cited: f.anchors.map((a) => ({
          path: a.path,
          side: a.side,
          startLine: a.startLine,
          endLine: a.endLine,
          lines: lines(variant, a),
        })),
        mark: null,
      });
    }
  }
  return {
    pack: {
      version: 1,
      packId,
      instructions:
        'Each item is one review finding with the lines it cites (and three lines around them). Mark it "real" when the cited lines show the problem the claim states, "false" when they do not. Write the marks as {"packId": ..., "marks": {"<item>": "real" | "false"}}, or fill each item\'s "mark".',
      items: shuffle(items),
    },
    key: { version: 1, packId, items: key },
  };
};

const MarkMap = z.looseObject({
  packId: z.string(),
  marks: z.record(z.string(), z.enum(["real", "false"])),
});
const MarkItems = z.looseObject({
  packId: z.string(),
  items: z.array(
    z.looseObject({
      item: z.string(),
      mark: z.enum(["real", "false"]).nullable(),
    }),
  ),
});
const Key = z.looseObject({
  packId: z.string(),
  items: z.record(
    z.string(),
    z.looseObject({ run: z.string(), variant: z.int(), finding: z.string() }),
  ),
});

export const meritRead = (answers: unknown, keyFile: unknown) => {
  const map = MarkMap.safeParse(answers);
  const marked = map.success ? map.data : MarkItems.parse(answers);
  const key = Key.parse(keyFile);
  if (marked.packId !== key.packId)
    throw new Error("the answers are for another pack than this key");
  const marks: Record<string, "real" | "false" | null> = map.success
    ? map.data.marks
    : Object.fromEntries(
        MarkItems.parse(answers).items.map((i) => [i.item, i.mark]),
      );
  for (const item of Object.keys(marks))
    if (key.items[item] === undefined)
      throw new Error(`item ${item} is not in the key`);
  const runs: Record<
    string,
    {
      items: number;
      real: number;
      false: number;
      unmarked: number;
      falseRate: number | null;
    }
  > = {};
  for (const [item, entry] of Object.entries(key.items)) {
    const r = (runs[entry.run] ??= {
      items: 0,
      real: 0,
      false: 0,
      unmarked: 0,
      falseRate: null,
    });
    r.items += 1;
    const mark = marks[item] ?? null;
    if (mark === "real") r.real += 1;
    else if (mark === "false") r.false += 1;
    else r.unmarked += 1;
  }
  for (const r of Object.values(runs))
    r.falseRate = r.real + r.false === 0 ? null : r.false / (r.real + r.false);
  return { packId: key.packId, runs };
};
