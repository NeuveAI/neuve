import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { openStoreReader } from "@neuve/records-core/read-only";
import {
  confirmedMoveOf,
  floorsOf,
  movesOf,
  recordedLane,
  type Floor,
  type FloorFacts,
  type FindingAboutName,
  type FindingKindName,
  type Move,
} from "../lane-rule.ts";
import { RangeManifest, type ManifestHunk } from "../manifest.ts";
import type { DecideOutput } from "./decide.ts";
import { codeGaps } from "./decide.ts";
import { ReadingPlan } from "./plan.ts";
import { sectionAdded } from "./settled.ts";

/**
 * The hold's replay, for the gates (NEU-148 rounds 22 and 28): every section's lane recomputed from
 * what a review STORED (its readings' assessments, floor inputs, moves and gaps), with no model call:
 *
 * - `lift`: lane rule 3 as it was, the `finding` floor included and no move read;
 * - `hold`: the same, with every section whose relation evidence was shown whole (`shown`) read as
 *   `partial`, so code's relations gap is held and the lift lowers nothing;
 * - `matrixLift`: lane rule 4 (14.28), the kept findings read as moves on the matrix and no
 *   `finding` floor, over the stored gaps only (what happens once the hold goes);
 * - `matrixHold`: lane rule 4 over the stored gaps plus code's relations gap on shown sections (the
 *   product under rule 4);
 * - `confirmedLift` and `confirmedHold`: lane rule 5 (14.34), the matrix columns with a decided
 *   section's request for changes resting on confirmed claims also moving both axes, to high
 *   complexity and hard validation (`confirmedMoveOf`); `confirmedHold` is the product now.
 *
 * All run through the production lane code: `floorsOf` over the entry's floor inputs, code's own
 * gaps (`codeGaps`) and `recordedLane` (`laneOf`, the public-surface raise and the floors, via
 * `sectionLane`). The one thing kept here is rule 3's `finding` floor, which the harness no longer
 * has (`FINDING_FLOOR`), so the baseline columns are rule 3's. It is a measuring tool; the product
 * never holds the gap.
 *
 * A decision stored before the `finding` floor has no `keptFinding` fact; it is then read from the
 * stored units' comments: a section that holds a finder comment carries a kept finding. A decision
 * stored under rule 4 holds its moves; for an older one they are rebuilt from the stored comments
 * (`rebuiltMoves`), where a finding about proof is stored as about its file (`REBUILT_MOVES_NOTE`).
 * A decision stored under rule 5 holds the verdict's move among its moves; for an older one it is
 * rebuilt from the entry's stored verdict and the confirmed claims it rests on (`restsOn`), as the
 * harness places it (`REBUILT_VERDICT_MOVES_NOTE`). The rule 4 columns never read that move.
 */

type Lane = ReturnType<typeof recordedLane>["applied"];

/** One section of a stored readings decision, as `collect.ts` stores it. */
export type StoredDecisionSection = {
  readonly key: string;
  readonly path: string;
  readonly decision: DecideOutput | null;
};

export type StoredDecision = {
  readonly plan: string;
  readonly sections: ReadonlyArray<StoredDecisionSection>;
  readonly units?: unknown;
  /** The settled batches, whose units hold the comments (kind, about, section) and the lane rule. */
  readonly settled?: unknown;
};

export type ReplayedSection = {
  readonly key: string;
  readonly path: string;
  /** Null for a section not settled (waiting, or not decided). */
  readonly published: Lane | null;
  readonly lift: Lane | null;
  readonly hold: Lane | null;
  readonly matrixLift: Lane | null;
  readonly matrixHold: Lane | null;
  readonly confirmedLift: Lane | null;
  readonly confirmedHold: Lane | null;
  /** Whether the review showed its relation evidence whole (the lift's condition). */
  readonly shown: boolean;
  readonly keptFinding: boolean;
  /** The moves the matrix columns read: the entry's own under rule 4, else rebuilt from comments. */
  readonly moves: ReadonlyArray<Move>;
  readonly movesFrom: "stored" | "rebuilt";
  /** The verdict's moves the rule 5 columns also read (`confirmedMoveOf`): none, or one per axis. */
  readonly verdictMoves: ReadonlyArray<Move>;
  readonly verdictMovesFrom: "stored" | "rebuilt";
};

/** Rule 3's `finding` floor, which the harness dropped for rule 4: the baseline columns keep it. */
const FINDING_FLOOR: Floor = { rule: "finding", to: "human-suggested" };

/** What the output says when moves were rebuilt from an older decision's comments. */
export const REBUILT_MOVES_NOTE =
  "Moves for a decision stored before lane rule 4 are rebuilt from its stored finder comments. A finding about proof is stored as about its file's kind (tests or code), so it is read that way; this build's finders store none about proof.";

/** What the output says when the verdict's move was rebuilt for a decision stored before lane rule 5. */
export const REBUILT_VERDICT_MOVES_NOTE =
  "The move a confirmed request for changes gives, for a decision stored before lane rule 5, is rebuilt from each decided section's stored verdict and the confirmed claims it rests on.";

/** The highest lane rule a stored decision's units name (`laneRule`), or 3 where none names one. */
export const decisionLaneRule = (settled: unknown): number => {
  let rule = 3;
  const walk = (value: unknown) => {
    if (Array.isArray(value)) for (const item of value) walk(item);
    else if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record["laneRule"] === "number")
        rule = Math.max(rule, record["laneRule"]);
      for (const item of Object.values(record)) walk(item);
    }
  };
  walk(settled);
  return rule;
};

const KINDS: ReadonlyArray<FindingKindName> = [
  "defect",
  "risk",
  "question",
  "pattern-note",
];
const ABOUTS: ReadonlyArray<FindingAboutName> = ["code", "tests", "proof"];

/**
 * The moves an older decision's finders gave each section, rebuilt from what it stored: the comment
 * IDs its ranked unit comments mark `source: "finder"` (`units`), each with the kind, `about` and
 * section its settled comment holds (`settled`), through the harness's own `movesOf`.
 */
export const rebuiltMoves = (
  decision: Pick<StoredDecision, "units" | "settled">,
): ReadonlyMap<string, ReadonlyArray<Move>> => {
  const finders = new Set<string>();
  const comments = new Map<
    string,
    { section: string; kind: FindingKindName; about: FindingAboutName }
  >();
  const walk = (
    value: unknown,
    visit: (record: Record<string, unknown>) => void,
  ) => {
    if (Array.isArray(value)) for (const item of value) walk(item, visit);
    else if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      visit(record);
      for (const item of Object.values(record)) walk(item, visit);
    }
  };
  walk(decision.units, (record) => {
    if (record["source"] === "finder" && typeof record["id"] === "string")
      finders.add(record["id"]);
  });
  walk(decision.settled, (record) => {
    const { id, section, kind, about } = record;
    if (
      typeof id === "string" &&
      typeof section === "string" &&
      KINDS.includes(kind as FindingKindName) &&
      ABOUTS.includes(about as FindingAboutName) &&
      !comments.has(id)
    )
      comments.set(id, {
        section,
        kind: kind as FindingKindName,
        about: about as FindingAboutName,
      });
  });
  const out = new Map<string, Array<Move>>();
  for (const id of [...finders].sort()) {
    const comment = comments.get(id);
    if (comment === undefined) continue;
    out.set(comment.section, [
      ...(out.get(comment.section) ?? []),
      ...movesOf([{ id, kind: comment.kind, about: comment.about }]),
    ]);
  }
  return out;
};

/** Every section key that holds a finder comment, anywhere in the stored units. */
export const finderSections = (units: unknown): ReadonlySet<string> => {
  const found = new Set<string>();
  const walk = (value: unknown) => {
    if (Array.isArray(value)) for (const item of value) walk(item);
    else if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (
        record["source"] === "finder" &&
        typeof record["section"] === "string"
      )
        found.add(record["section"]);
      for (const item of Object.values(record)) walk(item);
    }
  };
  walk(units);
  return found;
};

/** Every section's lanes, from the stored decision, its plan and manifest, and the shown set. */
export const replayHold = (input: {
  readonly decision: StoredDecision;
  readonly plan: ReadingPlan;
  readonly hunks: ReadonlyMap<string, ManifestHunk>;
  /**
   * The sections shown whole, as the run log's `reading.section` rows say; `derived` where there is
   * no run log: a settled section code would give its relations gap, shown nothing, whose entry
   * holds no relations gap (only the lift removes it).
   */
  readonly shown: ReadonlySet<string> | "derived";
}): Array<ReplayedSection> => {
  const planned = new Map(
    [...input.plan.sections, ...input.plan.unread].map((section) => [
      section.key,
      section,
    ]),
  );
  const withFinder = finderSections(input.decision.units);
  const storedRule = decisionLaneRule(input.decision.settled);
  const rule4 = storedRule >= 4;
  const rule5 = storedRule >= 5;
  const rebuilt = rule4 ? new Map() : rebuiltMoves(input.decision);
  return input.decision.sections.map((stored): ReplayedSection => {
    const decision = stored.decision;
    const section = planned.get(stored.key);
    const shown =
      input.shown !== "derived"
        ? input.shown.has(stored.key)
        : decision !== null &&
          decision.settled &&
          section !== undefined &&
          decision.entry.assess !== null &&
          codeGaps({
            relations: false,
            declared: section.declared,
            boundaries: section.boundaries,
          }).some((gap) => gap.kind === "relations-unavailable") &&
          !decision.entry.assess.gaps.some(
            (gap) => gap.kind === "relations-unavailable",
          );
    if (decision === null || !decision.settled || section === undefined)
      return {
        key: stored.key,
        path: stored.path,
        published:
          decision?.settled === true ? decision.entry.lane.applied : null,
        lift: null,
        hold: null,
        matrixLift: null,
        matrixHold: null,
        confirmedLift: null,
        confirmedHold: null,
        shown,
        keptFinding: withFinder.has(stored.key),
        moves: [],
        movesFrom: rule4 ? "stored" : "rebuilt",
        verdictMoves: [],
        verdictMovesFrom: rule5 ? "stored" : "rebuilt",
      };
    const entry = decision.entry;
    // A rule 3 entry's facts may hold `keptFinding`; rule 4's never do.
    const stored3 = entry.floorInputs.facts as FloorFacts & {
      readonly keptFinding?: boolean | undefined;
    };
    const keptFinding = stored3.keptFinding ?? withFinder.has(stored.key);
    const facts: FloorFacts = {
      removesDeclaration: stored3.removesDeclaration,
      removesPublicName: stored3.removesPublicName,
      effects: stored3.effects,
    };
    const matrixFloors = floorsOf(facts, entry.floorInputs.options);
    const rule3Floors = keptFinding
      ? [...matrixFloors, FINDING_FLOOR]
      : matrixFloors;
    const storedMoves = entry.assess?.movement ?? [];
    const moves: ReadonlyArray<Move> = rule4
      ? storedMoves.filter((move) => move.signal === "kept-finding")
      : (rebuilt.get(stored.key) ?? []);
    // Rule 5's move: stored with the others, else rebuilt as `decideSection` places it, only on a
    // decided section with an assessment.
    const verdictMoves: ReadonlyArray<Move> = rule5
      ? storedMoves.filter(
          (move) => move.signal === "confirmed-request-changes",
        )
      : entry.assess === null || entry.undecided !== undefined
        ? []
        : confirmedMoveOf(entry.verdict, entry.restsOn);
    const added = sectionAdded(section, input.hunks);
    const laneOf = (
      gaps: NonNullable<typeof entry.assess>["gaps"] | null,
      rule: 3 | 4 | 5,
    ) =>
      recordedLane(
        {
          assess:
            entry.assess === null || gaps === null
              ? null
              : {
                  complexity: entry.assess.complexity,
                  easeOfValidation: entry.assess.easeOfValidation,
                  movement:
                    rule === 3
                      ? []
                      : rule === 4
                        ? moves
                        : [...moves, ...verdictMoves],
                  lean: entry.assess.lean,
                  gaps,
                },
          lane: { floors: rule === 3 ? rule3Floors : matrixFloors },
          ...(entry.undecided === undefined
            ? {}
            : { undecided: entry.undecided }),
          ...(entry.excluded === undefined ? {} : { excluded: entry.excluded }),
        },
        added,
      ).applied;
    const gaps = entry.assess?.gaps ?? null;
    // The hold: code's gaps as a section shown nothing gets them, each one not already there.
    const held =
      gaps === null || !shown
        ? gaps
        : [
            ...gaps,
            ...codeGaps({
              relations: false,
              declared: section.declared,
              boundaries: section.boundaries,
            }).filter(
              (gap) =>
                !gaps.some((g) => g.axis === gap.axis && g.kind === gap.kind),
            ),
          ];
    return {
      key: stored.key,
      path: stored.path,
      published: entry.lane.applied,
      lift: laneOf(gaps, 3),
      hold: laneOf(held, 3),
      matrixLift: laneOf(gaps, 4),
      matrixHold: laneOf(held, 4),
      confirmedLift: laneOf(gaps, 5),
      confirmedHold: laneOf(held, 5),
      shown,
      keptFinding,
      moves,
      movesFrom: rule4 ? "stored" : "rebuilt",
      verdictMoves,
      verdictMovesFrom: rule5 ? "stored" : "rebuilt",
    };
  });
};

// ---------------------------------------------------------------------------------------------
// From a stored review, read only
// ---------------------------------------------------------------------------------------------

type Row = Record<string, unknown> & { readonly type: string };

/** The run logs to replay: one run's, or every run's whose log names `cycle` (a cycle or run key). */
export const runLogsOf = (
  logs: string,
  select: { readonly run: string } | { readonly cycle: string },
): Array<{ readonly run: string; readonly path: string }> => {
  if ("run" in select) {
    const path = join(logs, `${select.run}.jsonl`);
    if (!existsSync(path)) throw new Error(`no run log for run ${select.run}`);
    return [{ run: select.run, path }];
  }
  return readdirSync(logs)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .map((name) => ({
      run: name.slice(0, -".jsonl".length),
      path: join(logs, name),
    }))
    .filter(({ path }) => readFileSync(path, "utf8").includes(select.cycle));
};

/**
 * The replay of one run from a store, read only (`openStoreReader`: no sidecar is made, nothing is
 * written): its last readings decision (`readings.decision`), the sections its `reading.section`
 * rows say were `shown`, and the plan and manifest the decision names, read from the store.
 */
export const replayRun = (input: {
  /** The store's `records.sqlite`. */
  readonly database: string;
  /** The store's folder (`.git/neuve`), where its file blobs are (`blobs/sha256/…`). */
  readonly directory: string;
  readonly runLog: string;
  /** The manifest's key, where the plan's computation does not name it (a test's plan). */
  readonly manifestKey?: string;
}) => {
  const rows: Array<Row> = readFileSync(input.runLog, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Row);
  const decided = rows.filter((row) => row.type === "readings.decision").at(-1);
  if (decided === undefined) return null;
  const decisionKey = String(decided["key"]);
  const shown = new Set(
    rows
      .filter(
        (row) =>
          row.type === "reading.section" &&
          row["decision"] === decisionKey &&
          row["relations"] === "shown",
      )
      .map((row) => String(row["section"])),
  );
  const sections = replayDecision({
    database: input.database,
    directory: input.directory,
    decisionKey,
    shown,
    ...(input.manifestKey === undefined
      ? {}
      : { manifestKey: input.manifestKey }),
  });
  return {
    decision: decisionKey,
    notes: replayNotes(sections),
    sections,
  };
};

/**
 * The output's notes: `REBUILT_MOVES_NOTE` when any section's moves were rebuilt, and
 * `REBUILT_VERDICT_MOVES_NOTE` when any section's verdict move was.
 */
export const replayNotes = (sections: ReadonlyArray<ReplayedSection>) => [
  ...(sections.some((section) => section.movesFrom === "rebuilt")
    ? [REBUILT_MOVES_NOTE]
    : []),
  ...(sections.some((section) => section.verdictMovesFrom === "rebuilt")
    ? [REBUILT_VERDICT_MOVES_NOTE]
    : []),
];

/**
 * The replay of one stored readings decision by its key, read only. With no run log (a copied
 * database), the shown sections are derived from the entries (`replayHold`'s `derived`).
 */
export const replayDecision = (input: {
  readonly database: string;
  readonly directory: string;
  readonly decisionKey: string;
  readonly shown?: ReadonlySet<string> | undefined;
  readonly manifestKey?: string;
}) => {
  const decisionKey = input.decisionKey;
  const database = openStoreReader(input.database);
  try {
    const computation = (key: string) => {
      const row = database
        .query<{ material: string; output_hash: string }, [string]>(
          "SELECT material, output_hash FROM computations WHERE key = ?",
        )
        .get(key);
      if (row === null) throw new Error(`computation ${key} is not stored`);
      const blob = database
        .query<{ placement: string; content: Uint8Array | null }, [string]>(
          "SELECT placement, content FROM blobs WHERE hash = ?",
        )
        .get(row.output_hash);
      if (blob === null) throw new Error(`blob ${row.output_hash} is missing`);
      const bytes =
        blob.placement === "inline" && blob.content !== null
          ? blob.content
          : readFileSync(
              join(
                input.directory,
                "blobs",
                "sha256",
                row.output_hash.slice(0, 2),
                row.output_hash.slice(2),
              ),
            );
      if (createHash("sha256").update(bytes).digest("hex") !== row.output_hash)
        throw new Error(`blob ${row.output_hash} does not match its hash`);
      return {
        material: JSON.parse(row.material) as {
          readonly inputs?: Record<string, unknown>;
        },
        value: JSON.parse(new TextDecoder().decode(bytes)) as unknown,
      };
    };
    const decision = computation(decisionKey).value as StoredDecision;
    const planned = computation(decision.plan);
    const named = planned.material.inputs?.["manifest"];
    const manifestKey =
      input.manifestKey ??
      (typeof named === "string" && named.startsWith("computation:")
        ? named.slice("computation:".length)
        : undefined);
    if (manifestKey === undefined)
      throw new Error("the plan names no manifest; give its key");
    const manifest = RangeManifest.parse(computation(manifestKey).value);
    return replayHold({
      decision,
      plan: ReadingPlan.parse(planned.value),
      hunks: new Map(manifest.hunks.map((hunk) => [hunk.hunkId, hunk])),
      shown: input.shown ?? "derived",
    });
  } finally {
    database.close();
  }
};

/** The readings decisions a database holds, oldest first: their keys and when they were stored. */
export const decisionsIn = (path: string) => {
  const database = openStoreReader(path);
  try {
    return database
      .query<{ key: string; completed_at: string }, []>(
        "SELECT key, completed_at FROM computations WHERE op = 'harness.readings-decision' ORDER BY completed_at, key",
      )
      .all()
      .map((row) => ({ key: row.key, storedAt: row.completed_at }));
  } finally {
    database.close();
  }
};
