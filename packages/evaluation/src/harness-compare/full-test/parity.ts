import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
  packetBatches,
  readShownFile,
  READS_STORED,
  type PacketLite,
} from "./packets.ts";
import { join } from "node:path";
import { z } from "zod";
import { labelOf, type ConcernRow } from "../../pr-replay/evidence.ts";
import {
  concernStandings,
  Confirmation,
  confirmedRefs,
  readMatching,
  substantiveOf,
} from "../../pr-replay/parity.ts";
import {
  concernCategories,
  relabelState,
} from "../../pr-replay/recategorize.ts";
import { CaseRecord } from "../../pr-replay/schema.ts";
import { runFolder, scoredRun } from "../../pr-replay/sources.ts";
import { quantile, random } from "../../retrieval-bench/score/stats.ts";

/**
 * Parity with a great human reviewer (10.141): how many of the reviewers' real concerns Neuve raises,
 * kept only while what it raises stays relevant. Read from the blind matching (10.133) and the merit
 * validation (10.134, 10.138) of each run, never from the harness. A parity change touches what
 * Investigate, Understand or Dispose do, so each arm is a fresh review of the same development
 * sample; candidates are paired against one fresh baseline run of main, and the noise floor comes
 * from two runs of the same build on the same cases.
 *
 * A run's labels: `labels/` for a case's first run, `run/<run>/labels/` for any other; the reviewers'
 * concerns (`labels/concerns.jsonl`) belong to the case, so every run reads the same ones.
 *
 * A concern is credited as the headline credits it: by the matcher's agreed pairs, or by the run's
 * pair confirmation (confirmation.json, pr-replay/confirm.ts) for a concern the matcher left
 * unmatched. The confirmed figure decides; the matcher-only figure is shown beside it, never gates.
 */

export const PARITY_BOOTSTRAP_SEED = "neuve-parity-v1";
export const PARITY_DRAWS = 2_000;
/** A source or kind with fewer concerns than this is reported, never judged. */
export const MIN_GROUP_CONCERNS = 10;
/** Kinds outside the aim: performance rests on measurements Neuve does not have (10.142). */
export const OUTSIDE_AIM_KINDS: ReadonlyArray<string> = ["performance"];
const inAim = (concern: { readonly kind: string }) =>
  !OUTSIDE_AIM_KINDS.includes(concern.kind);

export const runLabels = (caseDirectory: string, run: string) =>
  run === "first"
    ? join(caseDirectory, "labels")
    : join(runFolder(caseDirectory, scoredRun(run)), "labels");

/**
 * How a run ended, from its `show.json` (in `run/` for a case's first run, `run/<run>/` for any
 * other, a candidate's in its treatment folder): missing (no such run), failed (it did not complete its review: timed out, a partial
 * packet, or no packet), or completed. A failed run's items are short and its unreached concerns
 * read as misses, so it is reported, never read as a quiet review.
 */
export const runState = (
  caseDirectory: string,
  run: string,
):
  | { state: "missing" }
  | { state: "failed"; why: string }
  | { state: "completed" } => {
  const path =
    run === "first"
      ? join(caseDirectory, "run", "show.json")
      : join(runFolder(caseDirectory, scoredRun(run)), "show.json");
  if (!existsSync(path)) return { state: "missing" };
  // Through the guard: a run of a shape the parity eval's readers cannot read is refused, never
  // counted as completed (packets.ts).
  const shown = readShownFile<{
    outcome?: string;
    packet?: PacketLite | null;
  }>(path, path, READS_STORED);
  if (shown.outcome !== undefined && shown.outcome !== "completed")
    return { state: "failed", why: `the run ${shown.outcome}` };
  if (shown.packet === undefined || shown.packet === null)
    return { state: "failed", why: "it holds no packet" };
  if (shown.packet.complete !== true)
    return { state: "failed", why: "its packet is partial" };
  if (packetBatches(shown.packet, { where: path }).length === 0)
    return { state: "failed", why: "its packet holds no batch" };
  return { state: "completed" };
};

/** A recompose step's stage: review (dispose), titles, digest, else its agent's first part. */
export const stepStage = (step: {
  readonly agent?: string | undefined;
  readonly stage?: string | undefined;
}) => {
  const agent = step.agent || step.stage || "?";
  return agent.startsWith("dispose")
    ? "review"
    : agent.includes("title")
      ? "titles"
      : agent.includes("digest")
        ? "digest"
        : agent.split(".")[0]!;
};

export type RecomposeStep = {
  readonly stage: string;
  readonly outcome: string;
};

/**
 * What a run's recompose recomputed and reused, step by step, from its `show.json`: null for a run
 * with no recompose (a case's first run, or a fresh review).
 */
export const runRecompose = (
  caseDirectory: string,
  run: string,
): Array<RecomposeStep> | null => {
  const path =
    run === "first"
      ? join(caseDirectory, "run", "show.json")
      : join(runFolder(caseDirectory, run), "show.json");
  if (!existsSync(path)) return null;
  const shown = readShownFile<{
    recompose?: {
      steps?: ReadonlyArray<{
        outcome: string;
        agent?: string;
        stage?: string;
      }>;
    };
  }>(path, path, READS_STORED);
  const steps = shown.recompose?.steps;
  return steps === undefined
    ? null
    : steps.map((step) => ({ stage: stepStage(step), outcome: step.outcome }));
};

export const REUSED = "reused";
export const RECOMPUTED = "recomputed with the model";

/**
 * One arm's recompose over the compared cases: its steps by stage and outcome, the cases with any
 * step neither reused nor recomputed with the model, and the share of reviews reused, so a mostly
 * reused baseline reads beside a fresh candidate. Null when no compared case's run was recomposed.
 */
export const armRecompose = (
  cases: ReadonlyArray<{
    readonly caseId: string;
    readonly steps: ReadonlyArray<RecomposeStep> | null | undefined;
  }>,
) => {
  const recomposed = cases.filter(
    (entry) => entry.steps !== null && entry.steps !== undefined,
  );
  if (recomposed.length === 0) return null;
  const byStage: Record<string, Record<string, number>> = {};
  const other: Array<{ caseId: string; steps: Array<string> }> = [];
  for (const entry of recomposed) {
    const odd: Array<string> = [];
    for (const step of entry.steps!) {
      const held = (byStage[step.stage] ??= {});
      held[step.outcome] = (held[step.outcome] ?? 0) + 1;
      if (step.outcome !== REUSED && step.outcome !== RECOMPUTED)
        odd.push(`${step.outcome}: ${step.stage}`);
    }
    if (odd.length > 0) other.push({ caseId: entry.caseId, steps: odd });
  }
  const reused = byStage["review"]?.[REUSED] ?? 0;
  const recomputed = byStage["review"]?.[RECOMPUTED] ?? 0;
  return {
    cases: recomposed.length,
    notRecomposed: cases.length - recomposed.length,
    byStage,
    otherOutcomes: other,
    reviews: {
      reused,
      recomputed,
      reusedShare: share(reused, reused + recomputed),
    },
  };
};

/**
 * Why an arm run that never ran is a failed case rather than an error: only when the case's first run
 * itself failed, as an arm recomposes only first runs that completed. Null when the first run did not
 * fail, so the missing run stays an error.
 */
export const missingRunFailure = (caseDirectory: string, run: string) => {
  const first = runState(caseDirectory, "first");
  return first.state === "failed"
    ? `its first run failed (${first.why}), so it has no ${run} run`
    : null;
};

/**
 * Each reviewer concern's majority label: whether it is substantive, and its kind. The kind is read
 * as the headline reads it (concernCategories): the category relabel applied while it is of the
 * current labelling, else the labeller's category.
 */
export const concernLabels = (caseDirectory: string) => {
  const caseLabels = join(caseDirectory, "labels");
  const path = join(caseLabels, "concerns.jsonl");
  const labels = new Map<string, { substantive: boolean; kind: string }>();
  if (!existsSync(path)) return labels;
  const categories = concernCategories(caseLabels);
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const row = JSON.parse(line) as ConcernRow;
    const label = labelOf(row);
    if (label !== null && label.isConcern)
      labels.set(row.id, {
        substantive: label.substantive,
        kind: categories.get(row.id) ?? label.category,
      });
  }
  return labels;
};

/** The cases whose relabel was stale, by ID: a floor or a comparison reports them. */
const staleRelabels = (cases: ReadonlyArray<ParityCase>) =>
  cases
    .filter((entry) => entry.relabel === "stale")
    .map((entry) => entry.caseId);

const KeyItem = z.object({
  id: z.string(),
  source: z.enum(["neuve", "reviewer"]),
  group: z.string(),
  ref: z.string(),
});
const MatchingKey = z.object({ items: z.array(KeyItem) });
const Matching = z.object({
  pairs: z.array(z.string()),
  summary: z.object({
    substantiveConcerns: z.number(),
    caught: z.number().nullable(),
    caughtByAny: z.number().nullable(),
    neuve: z.object({ items: z.number() }),
  }),
});
const MeritSummary = z.object({
  incomplete: z.boolean().optional(),
  /** The merit prompt's revision: a nit-pick is its own verdict only from revision 4 (10.138). */
  revision: z.number(),
  legitimate: z.number(),
  minor: z.number(),
  noise: z.number(),
  nitPick: z.number().optional(),
});

/**
 * Each substantive reviewer concern in the run's mix, caught when a Neuve comment raises the same
 * problem (an agreed pair), caughtByAny by any of Neuve's items: rebuilt from the run's stored pairs
 * and key, and checked against the matching's own counts.
 */
export const concernsCaught = (
  key: z.infer<typeof MatchingKey>,
  pairs: ReadonlyArray<string>,
  labels: ReadonlyMap<string, { substantive: boolean; kind: string }>,
) => {
  const byId = new Map(key.items.map((item) => [item.id, item]));
  const groups = new Map<string, Set<string>>();
  for (const pair of pairs) {
    const [x, y] = pair.split("|").map((id) => byId.get(id));
    if (x === undefined || y === undefined || x.source === y.source) continue;
    const [reviewer, neuve] = x.source === "reviewer" ? [x, y] : [y, x];
    groups.set(
      reviewer.ref,
      new Set([...(groups.get(reviewer.ref) ?? []), neuve.group]),
    );
  }
  return key.items
    .filter(
      (item) =>
        item.source === "reviewer" &&
        labels.get(item.ref)?.substantive === true,
    )
    .map((item) => ({
      ref: item.ref,
      kind: labels.get(item.ref)!.kind,
      caught: groups.get(item.ref)?.has("comment") === true,
      caughtByAny: groups.has(item.ref),
    }));
};

/**
 * The run's confirmed credit for the concerns the matcher left unmatched (concernStandings, as the
 * miss sort reads them): the refs a confirmed comment raises and those any confirmed item raises.
 * Only the concerns the reader scores need it; a run with none unmatched needs no confirmation. A
 * missing or stale confirmation (confirmedRefs) is kept as the run's refusal, never thrown here, so
 * a reader that only counts concerns still reads the run, and one that scores it refuses every such
 * run at once.
 */
const confirmedCredit = (
  caseDirectory: string,
  run: string,
  scored: ReadonlySet<string>,
) => {
  const labels = runLabels(caseDirectory, run);
  const caseLabels = join(caseDirectory, "labels");
  const none = {
    comment: new Set<string>(),
    any: new Set<string>(),
    unconfirmed: null as string | null,
  };
  if (scored.size === 0) return none;
  const { key, passes } = readMatching(labels);
  const unmatched = concernStandings(key, passes, substantiveOf(caseLabels))
    .filter((row) => row.standing !== "matched" && scored.has(row.ref))
    .map((row) => row.ref);
  if (unmatched.length === 0) return none;
  try {
    const any = confirmedRefs(`${run} run`, labels, caseLabels);
    const confirmation = Confirmation.parse(
      JSON.parse(readFileSync(join(labels, "confirmation.json"), "utf8")),
    );
    return {
      comment: new Set(
        confirmation.concerns
          .filter((row) => row.caught === "comment")
          .map((row) => row.ref),
      ),
      any,
      unconfirmed: null,
    };
  } catch (error) {
    return {
      ...none,
      unconfirmed: error instanceof Error ? error.message : String(error),
    };
  }
};

/**
 * One case's run, as the parity measures read it; null where the run is not matched. Each concern's
 * caught and caughtByAny are the confirmed credit, its matcherOnly the matcher's pairs alone;
 * `unconfirmed` says why a run with unmatched concerns has no current confirmation, else null.
 */
export const readRun = (caseDirectory: string, run: string) => {
  const directory = runLabels(caseDirectory, run);
  const matchingPath = join(directory, "matching.json");
  const keyPath = join(directory, "matching-key.json");
  if (!existsSync(matchingPath) || !existsSync(keyPath)) return null;
  const matching = Matching.parse(
    JSON.parse(readFileSync(matchingPath, "utf8")),
  );
  const key = MatchingKey.parse(JSON.parse(readFileSync(keyPath, "utf8")));
  const matcherOnly = concernsCaught(
    key,
    matching.pairs,
    concernLabels(caseDirectory),
  );
  // The checks read the matcher's credit: they check the matching, which confirmation does not change.
  // The matching counted the same concerns: a different count means the labels moved since.
  if (matcherOnly.length !== matching.summary.substantiveConcerns)
    throw new Error(
      `${caseDirectory} (${run}): ${matcherOnly.length} substantive concerns from the labels, the matching counted ${matching.summary.substantiveConcerns}`,
    );
  const caughtNow = matcherOnly.filter((concern) => concern.caught).length;
  if (
    matcherOnly.length > 0 &&
    Math.abs(caughtNow / matcherOnly.length - (matching.summary.caught ?? 0)) >
      0.001
  )
    throw new Error(
      `${caseDirectory} (${run}): caught ${caughtNow} of ${matcherOnly.length} from the pairs, the matching said ${matching.summary.caught}`,
    );
  const confirmed = confirmedCredit(
    caseDirectory,
    run,
    new Set(matcherOnly.map((concern) => concern.ref)),
  );
  const concerns = matcherOnly.map((concern) => ({
    ref: concern.ref,
    kind: concern.kind,
    caught: concern.caught || confirmed.comment.has(concern.ref),
    caughtByAny: concern.caughtByAny || confirmed.any.has(concern.ref),
    matcherOnly: { caught: concern.caught, caughtByAny: concern.caughtByAny },
  }));
  const meritPath = join(directory, "merit.json");
  const merit = existsSync(meritPath)
    ? MeritSummary.parse(
        (JSON.parse(readFileSync(meritPath, "utf8")) as { summary: unknown })
          .summary,
      )
    : null;
  // Every substantive concern, as the matching counted them: the aim leaves out the kinds outside it
  // only where it is computed, so these checks and the guards still see them all.
  return {
    concerns,
    unconfirmed: confirmed.unconfirmed,
    items: matching.summary.neuve.items,
    merit:
      merit === null || merit.incomplete === true
        ? null
        : {
            revision: merit.revision,
            // Every item merit gave a verdict: legitimate, minor, nit-pick (from revision 4) and noise.
            judged:
              merit.legitimate +
              merit.minor +
              (merit.nitPick ?? 0) +
              merit.noise,
            noise: merit.noise,
            nitPick: merit.nitPick ?? null,
          },
  };
};
export type ParityRun = NonNullable<ReturnType<typeof readRun>>;

/** A run to score with its refusal, under the role it plays: the baseline, the candidate or the floor. */
type Roles = {
  readonly cases: ReadonlyArray<{
    readonly caseId: string;
    readonly base: Pick<ParityRun, "unconfirmed">;
    readonly next: Pick<ParityRun, "unconfirmed">;
  }>;
  readonly base: string;
  readonly next: string;
};

/**
 * Refuses, once, every run a reader would score whose unmatched concerns have no current
 * confirmation, as the miss sort refuses one: each listed by case, role and reason, never dropped.
 * A run read in two roles (a floor pair sharing the baseline) is listed once with both.
 */
export const refuseUnconfirmed = (groups: ReadonlyArray<Roles>) => {
  const refused = new Map<string, { roles: Array<string>; line: string }>();
  for (const group of groups)
    for (const entry of group.cases)
      for (const [role, side] of [
        [group.base, entry.base],
        [group.next, entry.next],
      ] as const) {
        if (side.unconfirmed === null) continue;
        const id = `${entry.caseId}\0${side.unconfirmed}`;
        const held = refused.get(id) ?? {
          roles: [],
          line: `${entry.caseId}: ${side.unconfirmed}`,
        };
        if (!held.roles.includes(role)) held.roles.push(role);
        refused.set(id, held);
      }
  if (refused.size > 0)
    throw new Error(
      `${refused.size} run(s) hold concerns the matcher left unmatched and no current confirmation of them: confirm them (pr-replay confirm) before parity scores them\n${[
        ...refused.values(),
      ]
        .map(({ roles, line }) => `- ${line} [${roles.join(", ")}]`)
        .join("\n")}`,
    );
};

/** A case of the sample, with its two runs read. */
export interface ParityCase {
  readonly caseId: string;
  readonly source: string;
  /** A control or quiet case: counts toward items and noise, never toward caught. */
  readonly control: boolean;
  readonly base: ParityRun;
  readonly next: ParityRun;
  /**
   * Whether its category relabel was read (recategorize's relabelState): none, current, or stale
   * (written over an earlier labelling, so its concerns keep the labeller's categories). The floor and
   * the comparison list the compared cases whose relabel is stale; a failed case's is not read.
   */
  readonly relabel?: "none" | "current" | "stale" | undefined;
  /** Each arm's recompose steps (runRecompose), null for a run not recomposed; reported per arm. */
  readonly recompose?:
    | {
        readonly base: ReadonlyArray<RecomposeStep> | null;
        readonly next: ReadonlyArray<RecomposeStep> | null;
      }
    | undefined;
}

/** A case on the volume: its record, its source's folder name and its folder. */
export interface ParityEntry {
  readonly record: CaseRecord;
  readonly source: string;
  readonly directory: string;
}

/** A run that did not complete its review, or never ran where its case's first run failed: listed, never dropped. */
export interface ParityFailure {
  readonly caseId: string;
  readonly source: string;
  readonly run: string;
  readonly why: string;
  readonly control: boolean;
  /** The concerns its mix holds (`mixConcerns`): what leaving it out costs; null while unmatched. */
  readonly concerns: number | null;
}

/** Every case under the cases folder, with its record and folder. */
export const parityEntries = (root: string): Array<ParityEntry> =>
  readdirSync(root)
    .filter((source) => !source.startsWith("."))
    .flatMap((source) =>
      readdirSync(join(root, source)).flatMap((number) => {
        const directory = join(root, source, number);
        const recordPath = join(directory, "case.json");
        if (!existsSync(recordPath)) return [];
        const record = CaseRecord.parse(
          JSON.parse(readFileSync(recordPath, "utf8")),
        );
        return [{ record, source, directory }];
      }),
    );

/**
 * The sample's cases with both runs read, paired; each run that failed is pushed onto `failed` and its
 * case left out of both arms.
 */
export const readParityPairs = (
  byId: ReadonlyMap<string, ParityEntry>,
  ids: ReadonlyArray<string>,
  controls: ReadonlySet<string>,
  baseRun: string,
  nextRun: string,
  required: boolean,
  failed: Array<ParityFailure>,
): Array<ParityCase> =>
  ids.flatMap((id) => {
    const entry = byId.get(id);
    if (entry === undefined) throw new Error(`${id} is no case on the volume`);
    // The parity sample is development only; held-out is read at the turn's end, apart.
    if (entry.record.split !== "development")
      throw new Error(`${id} is not a development case`);
    // A run that never ran is an error where the run is required; one that ran and did not
    // complete its review (timed out, partial, no packet) is a failed case on both arms.
    // Both runs' states first, so a missing run is never hidden behind a failed one, and each
    // failed run is listed.
    const states = [baseRun, nextRun].map((run) => ({
      run,
      ended: runState(entry.directory, run),
    }));
    const missing = states.find((s) => s.ended.state === "missing");
    // An arm recomposes only first runs that completed: where the case's first run failed, its
    // missing arm runs are a failed case, each listed; any other missing run is an error.
    const firstFailed =
      missing === undefined
        ? null
        : missingRunFailure(entry.directory, missing.run);
    if (missing !== undefined && firstFailed === null) {
      if (required) throw new Error(`${id} has no ${missing.run} run`);
      return [];
    }
    const ended = states.flatMap(({ run, ended }) => {
      const why =
        ended.state === "failed"
          ? ended.why
          : ended.state === "missing"
            ? missingRunFailure(entry.directory, run)
            : null;
      return why === null
        ? []
        : [
            {
              caseId: id,
              source: entry.source,
              run,
              why,
              control: controls.has(id),
              concerns: mixConcerns(entry.directory),
            },
          ];
    });
    if (ended.length > 0) {
      failed.push(...ended);
      return [];
    }
    const base = readRun(entry.directory, baseRun);
    const next = readRun(entry.directory, nextRun);
    if (base === null || next === null) {
      if (required)
        throw new Error(
          `${id} has no matched ${base === null ? baseRun : nextRun} run`,
        );
      return [];
    }
    return [
      {
        caseId: id,
        source: entry.source,
        control: controls.has(id),
        base,
        next,
        relabel: relabelState(join(entry.directory, "labels")).state,
        recompose: {
          base: runRecompose(entry.directory, baseRun),
          next: runRecompose(entry.directory, nextRun),
        },
      },
    ];
  });

/**
 * The floor's pairs: two runs of one build on the same cases, `<run>:<run>` pairs, every development
 * case that has both. Its own failed cases are taken back off `failed` and returned with it, never in
 * the sample's list. Null without pairs.
 */
export const readParityFloor = (
  all: ReadonlyArray<ParityEntry>,
  pairsFlag: string | undefined,
  failed: Array<ParityFailure>,
) => {
  if (pairsFlag === undefined) return null;
  const before = failed.length;
  const byId = new Map(all.map((entry) => [entry.record.caseId, entry]));
  const cases = pairsFlag.split(",").flatMap((pair) => {
    const [a, b] = pair.split(":");
    if (a === undefined || b === undefined || a === b)
      throw new Error(`--floor takes <run>:<run> pairs, got ${pair}`);
    const development = all.filter(
      (entry) => entry.record.split === "development",
    );
    // Controls are marked, so their concerns never enter the flip rate, as they never enter caught.
    return readParityPairs(
      byId,
      development.map((entry) => entry.record.caseId),
      new Set(
        development
          .filter((entry) => entry.record.control !== null)
          .map((entry) => entry.record.caseId),
      ),
      a,
      b,
      false,
      failed,
    );
  });
  return { cases, failed: failed.splice(before) };
};

export const floorOf = (read: ReturnType<typeof readParityFloor>) =>
  read === null ? null : { ...parityFloor(read.cases), failed: read.failed };

const round = (value: number) => Math.round(value * 1_000) / 1_000;
const share = (part: number, whole: number) =>
  whole === 0 ? null : round(part / whole);

/** The concerns both runs of a case hold, paired by reference. */
const pairedConcerns = (entry: ParityCase) => {
  const next = new Map(
    entry.next.concerns.map((concern) => [concern.ref, concern]),
  );
  return entry.base.concerns.flatMap((concern) => {
    const other = next.get(concern.ref);
    return other === undefined
      ? []
      : [
          {
            ...concern,
            nextCaught: other.caught,
            nextAny: other.caughtByAny,
            matcherOnly: {
              ...concern.matcherOnly,
              nextCaught: other.matcherOnly.caught,
              nextAny: other.matcherOnly.caughtByAny,
            },
          },
        ];
  });
};

type Ratio = {
  readonly baseHit: number;
  readonly baseOf: number;
  readonly nextHit: number;
  readonly nextOf: number;
};

export const GUARDS = ["itemsPerConcern", "noise", "nitPick"] as const;
export type Guard = (typeof GUARDS)[number];

/**
 * Each guard's per-case counts, both runs: items over reviewer concerns on every case; noise and
 * nit-picks over the items merit judged, where both runs of a case have merit.
 */
export const guardRows = (
  cases: ReadonlyArray<ParityCase>,
): Record<Guard, Array<Ratio>> => {
  // Merit compares only where both runs of a case were judged under the same revision: the verdicts
  // a share counts changed between revisions.
  const merited = cases.filter(
    (entry) =>
      entry.base.merit !== null &&
      entry.next.merit !== null &&
      entry.base.merit.revision === entry.next.merit.revision,
  );
  return {
    // Over every substantive concern, performance included: the guards hold volume and noise down,
    // not the aim, so they never narrow with it.
    itemsPerConcern: cases.map((entry) => ({
      baseHit: entry.base.items,
      baseOf: entry.base.concerns.length,
      nextHit: entry.next.items,
      nextOf: entry.next.concerns.length,
    })),
    noise: merited.map((entry) => ({
      baseHit: entry.base.merit!.noise,
      baseOf: entry.base.merit!.judged,
      nextHit: entry.next.merit!.noise,
      nextOf: entry.next.merit!.judged,
    })),
    nitPick: merited
      .filter(
        (entry) =>
          entry.base.merit!.nitPick !== null &&
          entry.next.merit!.nitPick !== null,
      )
      .map((entry) => ({
        baseHit: entry.base.merit!.nitPick!,
        baseOf: entry.base.merit!.judged,
        nextHit: entry.next.merit!.nitPick!,
        nextOf: entry.next.merit!.judged,
      })),
  };
};

/** The paired case bootstrap's draws of a ratio's delta, seeded by label. */
const ratioDraws = (cases: ReadonlyArray<Ratio>, label: string) => {
  const deltas: Array<number> = [];
  if (cases.length === 0) return deltas;
  const next = random(`${PARITY_BOOTSTRAP_SEED}:${label}`);
  for (let draw = 0; draw < PARITY_DRAWS; draw++) {
    const t = { bh: 0, bo: 0, nh: 0, no: 0 };
    for (let index = 0; index < cases.length; index++) {
      const entry =
        cases[Math.min(cases.length - 1, Math.floor(next() * cases.length))]!;
      t.bh += entry.baseHit;
      t.bo += entry.baseOf;
      t.nh += entry.nextHit;
      t.no += entry.nextOf;
    }
    if (t.bo > 0 && t.no > 0) deltas.push(t.nh / t.no - t.bh / t.bo);
  }
  return deltas;
};

/**
 * A guard's run-to-run noise from two runs of one build: the spread (standard deviation) of its
 * delta over the paired case bootstrap, at the repeats' number of cases. Scaled to a sample of n
 * cases, its bar is 1.96 × sd × √(repeats / n): what the guard moves by between two runs alone.
 */
const guardNoise = (rows: ReadonlyArray<Ratio>, label: string) => {
  const deltas = ratioDraws(rows, `floor:${label}`);
  if (deltas.length < 2) return null;
  const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const sd = Math.sqrt(
    deltas.reduce((sum, d) => sum + (d - mean) ** 2, 0) / (deltas.length - 1),
  );
  // Unrounded: a spread that rounds to 0 would make any rise block.
  return { cases: rows.length, sd };
};
export const guardBar = (
  noise: { readonly cases: number; readonly sd: number } | null | undefined,
  n: number,
) =>
  noise === null || noise === undefined || n === 0
    ? null
    : round(1.96 * noise.sd * Math.sqrt(noise.cases / n));

/**
 * The noise floor: the share of concerns whose caught status flips between two runs of the same
 * build on the same cases, and the bar a group of n concerns is judged by, 1.96 × √(f / n). The flip
 * rate is of the confirmed credit, which the aim is judged on; the matcher-only rate sits beside it.
 */
export const parityFloor = (pairs: ReadonlyArray<ParityCase>) => {
  refuseUnconfirmed([{ cases: pairs, base: "floor", next: "floor" }]);
  // The flip rate of the aim's concerns: its bar judges the aim.
  const concerns = pairs
    .filter((entry) => !entry.control)
    .flatMap(pairedConcerns)
    .filter(inAim);
  const flipped = concerns.filter(
    (concern) => concern.caught !== concern.nextCaught,
  ).length;
  const matcherFlipped = concerns.filter(
    (concern) => concern.matcherOnly.caught !== concern.matcherOnly.nextCaught,
  ).length;
  const rows = guardRows(pairs);
  return {
    cases: pairs.length,
    concerns: concerns.length,
    flipped,
    relabelStale: staleRelabels(pairs),
    f: share(flipped, concerns.length),
    matcherOnly: {
      flipped: matcherFlipped,
      f: share(matcherFlipped, concerns.length),
    },
    guards: Object.fromEntries(
      GUARDS.map((name) => [name, guardNoise(rows[name], name)]),
    ) as Record<Guard, ReturnType<typeof guardNoise>>,
  };
};
export const barFor = (f: number | null, n: number) =>
  f === null || n === 0 ? null : round(1.96 * Math.sqrt(f / n));

/** A seeded paired case bootstrap of a ratio's delta: each draw reads both arms on the same cases. */
const ratioInterval = (cases: ReadonlyArray<Ratio>, label: string) => {
  const deltas = ratioDraws(cases, label);
  if (deltas.length === 0) return null;
  deltas.sort((a, b) => a - b);
  return [
    round(quantile(deltas, 0.025)),
    round(quantile(deltas, 0.975)),
  ] as const;
};

const ratioRow = (
  cases: ReadonlyArray<{
    baseHit: number;
    baseOf: number;
    nextHit: number;
    nextOf: number;
  }>,
  label: string,
) => {
  const sum = (field: "baseHit" | "baseOf" | "nextHit" | "nextOf") =>
    cases.reduce((total, entry) => total + entry[field], 0);
  const baseline = share(sum("baseHit"), sum("baseOf"));
  const candidate = share(sum("nextHit"), sum("nextOf"));
  return {
    baseline,
    candidate,
    delta:
      baseline === null || candidate === null
        ? null
        : round(candidate - baseline),
    interval: ratioInterval(cases, label),
  };
};

/**
 * The aim's concerns a failed case would have been compared on: the reviewer side of the first run's
 * mix, which every run with a packet shares, without the kinds outside the aim, as kept concerns are
 * counted. Null while that run is unmatched, never the labels' count, which also holds
 * later-revision and lineless concerns that no run's mix holds.
 */
export const mixConcerns = (caseDirectory: string) =>
  readRun(caseDirectory, "first")?.concerns.filter(inAim).length ?? null;

/**
 * Each source's failed cases over its cases in the sample, those compared and those that failed,
 * and the aim's concerns those failed cases hold over the source's, both counted from the mix and
 * without controls: timeouts lean toward large changes, which may hold more than their share of
 * concerns. A failed case whose mix is unmatched is counted apart, never guessed.
 */
export const failedShares = (
  cases: ReadonlyArray<{
    readonly caseId: string;
    readonly source: string;
    readonly control?: boolean;
    readonly base?: {
      readonly concerns: ReadonlyArray<{ readonly kind: string }>;
    };
  }>,
  failed: ReadonlyArray<{
    readonly caseId: string;
    readonly source: string;
    readonly control?: boolean | undefined;
    /** The case's aim concerns in its mix (`mixConcerns`), null while unmatched. */
    readonly concerns?: number | null | undefined;
  }>,
) => {
  const failedCases = new Map(failed.map((f) => [f.caseId, f]));
  const sources = [
    ...new Set([
      ...cases.map((c) => c.source),
      ...[...failedCases.values()].map((f) => f.source),
    ]),
  ].sort();
  return Object.fromEntries(
    sources.map((source) => {
      const failedHere = [...failedCases.values()].filter(
        (f) => f.source === source,
      );
      const compared = cases.filter((c) => c.source === source);
      const total = compared.length + failedHere.length;
      const concernFailed = failedHere.filter((f) => f.control !== true);
      const lostConcerns = concernFailed.reduce(
        (sum, f) => sum + (f.concerns ?? 0),
        0,
      );
      const keptConcerns = compared
        .filter((c) => c.control !== true)
        .reduce(
          (sum, c) => sum + (c.base?.concerns.filter(inAim).length ?? 0),
          0,
        );
      return [
        source,
        {
          failed: failedHere.length,
          cases: total,
          share: share(failedHere.length, total),
          failedConcerns: lostConcerns,
          concerns: keptConcerns + lostConcerns,
          concernShare: share(lostConcerns, keptConcerns + lostConcerns),
          unmatchedFailed: concernFailed.filter(
            (f) => f.concerns === null || f.concerns === undefined,
          ).length,
        },
      ];
    }),
  );
};

/**
 * A parity candidate against its baseline on the same sample (10.141).
 *
 * - The aim: the share of substantive reviewer concerns a Neuve comment raises (caught), pooled
 *   over the sample's concerns, with the case mean beside it and caughtByAny as the upper bound. It
 *   gains when the delta clears the floor's bar and the paired case bootstrap's interval excludes 0.
 *   Performance concerns sit outside the aim (10.142): left out of it, the floor and failed cases'
 *   lost concerns, and reported as their own row by kind, never judged.
 * - By source and by kind: each delta against its own bar; a fall beyond the bar goes to the overseer.
 * - The guards, over every case (controls and quiet cases included): items per reviewer concern, and
 *   the noise and nit-pick shares among the items merit judged. Two fresh reviews differ by run
 *   noise, so a guard blocks when it rises clearly: its paired interval lies wholly above 0.
 */
export const parityComparison = (
  cases: ReadonlyArray<ParityCase>,
  /** The repeats' floor; its guard noise is absent (pending) until the repeats are matched. */
  floor:
    | (Omit<
        ReturnType<typeof parityFloor>,
        "guards" | "relabelStale" | "matcherOnly"
      > & {
        readonly guards?: ReturnType<typeof parityFloor>["guards"] | undefined;
        /** The floor's pairs whose relabel was stale: said with the verdict. */
        readonly relabelStale?: ReadonlyArray<string> | undefined;
        readonly matcherOnly?:
          ReturnType<typeof parityFloor>["matcherOnly"] | undefined;
      })
    | null,
  /** Cases where either run holds no packet: left out of both arms, and reported. */
  failed: ReadonlyArray<{
    readonly caseId: string;
    readonly source: string;
    readonly run: string;
    readonly why: string;
    readonly control?: boolean | undefined;
    readonly concerns?: number | null | undefined;
  }> = [],
) => {
  refuseUnconfirmed([{ cases, base: "baseline", next: "candidate" }]);
  const concernCases = cases.filter((entry) => !entry.control);
  // `all` keeps the kinds outside the aim for their own row by kind; everything the aim computes
  // reads `paired`, the aim's concerns. A case holding only those kinds stays a concern case (the
  // sample decided it) and adds 0 of 0.
  const caughtCases = concernCases.map((entry) => {
    const all = pairedConcerns(entry);
    const paired = all.filter(inAim);
    return {
      entry,
      all,
      paired,
      baseHit: paired.filter((c) => c.caught).length,
      baseOf: paired.length,
      nextHit: paired.filter((c) => c.nextCaught).length,
      nextOf: paired.length,
    };
  });
  type Paired = (typeof caughtCases)[number]["paired"][number];
  // The same cases' ratio under another credit: the matcher-only figures shown beside the confirmed.
  const creditRow = (
    base: (c: Paired) => boolean,
    next: (c: Paired) => boolean,
    label: string,
  ) =>
    ratioRow(
      caughtCases.map((entry) => ({
        ...entry,
        baseHit: entry.paired.filter(base).length,
        nextHit: entry.paired.filter(next).length,
      })),
      label,
    );
  const n = caughtCases.reduce((sum, entry) => sum + entry.baseOf, 0);
  const f = floor?.f ?? null;
  // The confirmed figures gate; each matcher-only figure is reported beside, never judged.
  const caught = {
    ...ratioRow(caughtCases, "caught"),
    n,
    bar: barFor(f, n),
    matcherOnly: creditRow(
      (c) => c.matcherOnly.caught,
      (c) => c.matcherOnly.nextCaught,
      "caught:matcherOnly",
    ),
  };
  const byAny = {
    ...creditRow(
      (c) => c.caughtByAny,
      (c) => c.nextAny,
      "caughtByAny",
    ),
    matcherOnly: creditRow(
      (c) => c.matcherOnly.caughtByAny,
      (c) => c.matcherOnly.nextAny,
      "caughtByAny:matcherOnly",
    ),
  };
  const caseMean = (hit: (c: Paired) => boolean) => {
    const shares = caughtCases
      .filter((entry) => entry.paired.length > 0)
      .map((entry) => entry.paired.filter(hit).length / entry.paired.length);
    return shares.length === 0
      ? null
      : round(shares.reduce((a, b) => a + b, 0) / shares.length);
  };
  const groupRows = (
    keyOf: (entry: ParityCase, kind: string) => string,
    concernsOf: (
      caseRow: (typeof caughtCases)[number],
    ) => (typeof caughtCases)[number]["all"],
  ) => {
    const groups = new Map<
      string,
      Map<
        string,
        {
          baseHit: number;
          baseOf: number;
          nextHit: number;
          nextOf: number;
          matcherBaseHit: number;
          matcherNextHit: number;
        }
      >
    >();
    for (const caseRow of caughtCases)
      for (const concern of concernsOf(caseRow)) {
        const entry = caseRow.entry;
        const group = keyOf(entry, concern.kind);
        const byCase = groups.get(group) ?? new Map();
        const held = byCase.get(entry.caseId) ?? {
          baseHit: 0,
          baseOf: 0,
          nextHit: 0,
          nextOf: 0,
          matcherBaseHit: 0,
          matcherNextHit: 0,
        };
        held.baseOf++;
        held.nextOf++;
        if (concern.caught) held.baseHit++;
        if (concern.nextCaught) held.nextHit++;
        if (concern.matcherOnly.caught) held.matcherBaseHit++;
        if (concern.matcherOnly.nextCaught) held.matcherNextHit++;
        byCase.set(entry.caseId, held);
        groups.set(group, byCase);
      }
    return Object.fromEntries(
      [...groups]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([group, byCase]) => {
          const list = [...byCase.values()];
          const concerns = list.reduce((sum, entry) => sum + entry.baseOf, 0);
          const row = ratioRow(list, `group:${group}`);
          const bar = barFor(f, concerns);
          return [
            group,
            {
              ...row,
              concerns,
              bar,
              judged: concerns >= MIN_GROUP_CONCERNS,
              falls:
                concerns >= MIN_GROUP_CONCERNS &&
                row.delta !== null &&
                bar !== null &&
                -row.delta > bar,
              matcherOnly: ratioRow(
                list.map((entry) => ({
                  ...entry,
                  baseHit: entry.matcherBaseHit,
                  nextHit: entry.matcherNextHit,
                })),
                `group:${group}:matcherOnly`,
              ),
            },
          ];
        }),
    );
  };
  const bySource = groupRows(
    (entry) => entry.source,
    (caseRow) => caseRow.paired,
  );
  // A kind outside the aim is reported beside it, never judged: it neither falls nor gains.
  const byKind = Object.fromEntries(
    Object.entries(
      groupRows(
        (_, kind) => kind,
        (caseRow) => caseRow.all,
      ),
    ).map(([kind, row]) =>
      inAim({ kind })
        ? [kind, { ...row, outsideAim: false }]
        : [kind, { ...row, outsideAim: true, judged: false, falls: false }],
    ),
  );
  const outside = caughtCases.filter(
    (caseRow) => caseRow.all.length > caseRow.paired.length,
  );
  const leftOut = outside.reduce(
    (sum, caseRow) => sum + caseRow.all.length - caseRow.paired.length,
    0,
  );
  // A guard blocks when it rises clearly (its paired interval wholly above 0) or, once the repeats
  // are matched, beyond its own floor bar; each is reported with its delta, interval and bar.
  const rows = guardRows(cases);
  const guardOf = (name: Guard) => {
    const row = ratioRow(rows[name], name);
    const bar = guardBar(floor?.guards?.[name], rows[name].length);
    const clearly = row.interval !== null && row.interval[0] > 0;
    const beyondBar = bar !== null && row.delta !== null && row.delta > bar;
    return {
      ...row,
      cases: rows[name].length,
      bar,
      barPending: bar === null,
      rises: clearly || beyondBar,
    };
  };
  const itemsPerConcern = guardOf("itemsPerConcern");
  const noise = guardOf("noise");
  const nitPick = guardOf("nitPick");
  const gained =
    caught.delta !== null &&
    caught.bar !== null &&
    caught.delta > caught.bar &&
    caught.interval !== null &&
    caught.interval[0] > 0;
  const rose = [
    ["items per reviewer concern", itemsPerConcern],
    ["noise share", noise],
    ["nit-pick share", nitPick],
  ]
    .filter(([, row]) => (row as { rises: boolean }).rises)
    .map(([name]) => name as string);
  const falls = [
    ...Object.entries(bySource)
      .filter(([, row]) => row.falls)
      .map(([group]) => `source ${group}`),
    ...Object.entries(byKind)
      .filter(([, row]) => row.falls)
      .map(([group]) => `kind ${group}`),
  ];
  return {
    cases: cases.length,
    concernCases: concernCases.length,
    controls: cases.length - concernCases.length,
    // Concerns in one run's mix and not the other's are left out of the pairing, and counted.
    unpaired: caughtCases.reduce(
      (sum, { entry, paired }) =>
        sum +
        entry.base.concerns.filter(inAim).length +
        entry.next.concerns.filter(inAim).length -
        2 * paired.length,
      0,
    ),
    // The paired concerns of the kinds outside the aim, left out of it and reported by kind, and the
    // concern cases that hold no other, which add nothing to the aim.
    outsideAim: {
      kinds: OUTSIDE_AIM_KINDS,
      concerns: leftOut,
      casesWithNoAimConcern: outside.filter(
        (caseRow) => caseRow.paired.length === 0,
      ).length,
    },
    // Cases whose category relabel was of an earlier labelling: their concerns kept the labeller's kind.
    // The floor's own are on the floor.
    relabelStale: staleRelabels(cases),
    floor,
    failed,
    // Timeouts lean toward large changes, so leaving them out of both arms tilts the sample toward
    // smaller ones: each source's share of failed cases is read beside the verdict.
    failedBySource: failedShares(cases, failed),
    // Read with every report: the guard is over substantive concerns, so its scale is not 10.133's
    // items per concern over all of them (905 per 40 in the pilot).
    notes: [
      "Items per reviewer concern counts substantive concerns only; 10.133's figure counts all concerns, so their scales differ.",
      "A guard blocks on a clear rise (its paired interval wholly above 0, or its rise beyond its repeat-derived bar), not on any rise: both arms are fresh reviews.",
      "Caught counts a concern the matcher paired or the pair confirmation found raised, and decides; matcherOnly beside it counts the matcher's pairs alone and is never judged.",
    ],
    caught,
    caughtByAny: byAny,
    // What each arm's recompose recomputed and reused, beside the aim: a mostly reused baseline
    // against a fresh candidate is read with the catches it made.
    recompose: {
      baseline: armRecompose(
        cases.map((entry) => ({
          caseId: entry.caseId,
          steps: entry.recompose?.base,
        })),
      ),
      candidate: armRecompose(
        cases.map((entry) => ({
          caseId: entry.caseId,
          steps: entry.recompose?.next,
        })),
      ),
    },
    caseMean: {
      baseline: caseMean((c) => c.caught),
      candidate: caseMean((c) => c.nextCaught),
      matcherOnly: {
        baseline: caseMean((c) => c.matcherOnly.caught),
        candidate: caseMean((c) => c.matcherOnly.nextCaught),
      },
      // The case mean's delta resampled by case, as the pooled share's is.
      interval: (() => {
        const deltas = caughtCases
          .filter((entry) => entry.paired.length > 0)
          .map(
            (entry) =>
              (entry.paired.filter((c) => c.nextCaught).length -
                entry.paired.filter((c) => c.caught).length) /
              entry.paired.length,
          );
        if (deltas.length === 0) return null;
        const next = random(`${PARITY_BOOTSTRAP_SEED}:caseMean`);
        const draws: Array<number> = [];
        for (let draw = 0; draw < PARITY_DRAWS; draw++) {
          let sum = 0;
          for (let index = 0; index < deltas.length; index++)
            sum +=
              deltas[
                Math.min(deltas.length - 1, Math.floor(next() * deltas.length))
              ]!;
          draws.push(sum / deltas.length);
        }
        draws.sort((a, b) => a - b);
        return [
          round(quantile(draws, 0.025)),
          round(quantile(draws, 0.975)),
        ] as const;
      })(),
    },
    bySource,
    byKind,
    guards: { itemsPerConcern, noise, nitPick },
    verdict: (() => {
      const verdict =
        rose.length > 0
          ? `do not keep: ${rose.join(", ")} rose`
          : floor === null
            ? "no verdict: no noise floor"
            : !gained
              ? "no gain"
              : falls.length > 0
                ? `gain, for the overseer: falls in ${falls.join(", ")}`
                : "keep";
      // Concerns left out of the aim are said with the verdict, so its scale is never misread.
      const kept =
        leftOut === 0
          ? verdict
          : `${verdict}; ${leftOut} ${OUTSIDE_AIM_KINDS.join(" or ")} concern(s) left out of the aim, reported by kind`;
      const stale = staleRelabels(cases).length;
      const compared =
        stale === 0
          ? kept
          : `${kept}; ${stale} case(s) read the labeller's categories, their relabel being of an earlier labelling`;
      const floorStale = floor?.relabelStale?.length ?? 0;
      const read =
        floorStale === 0
          ? compared
          : `${compared}; ${floorStale} of the floor's pair(s) read the labeller's categories, their relabel being of an earlier labelling`;
      // A comparison that left cases out never reads as a clean verdict.
      return failed.length === 0
        ? read
        : `${read}; for the overseer: ${new Set(failed.map((f) => f.caseId)).size} failed case(s) left out of both arms (${Object.entries(
            failedShares(cases, failed),
          )
            .filter(([, row]) => row.failed > 0)
            .map(
              ([source, row]) =>
                `${source} ${row.failed} of ${row.cases} cases, ${row.failedConcerns} of ${row.concerns} concerns${row.unmatchedFailed > 0 ? `, ${row.unmatchedFailed} failed case(s) unmatched` : ""}`,
            )
            .join(", ")})`;
    })(),
  };
};

/**
 * The parity sample (10.141): from the development cases, a seeded draw of `size` cases with at
 * least one substantive reviewer concern, stratified by source in proportion, and every development
 * control or quiet case beside them for the guards. Held-out cases are never drawn.
 */
export const drawParitySample = (
  cases: ReadonlyArray<{
    readonly caseId: string;
    readonly source: string;
    readonly split: string;
    readonly control: string | null;
    /** Null while the case's first run is not matched: the draw is refused until every one is. */
    readonly substantiveConcerns: number | null;
    /** The replay could run it: a case left out (unavailable, never run) is never drawn. */
    readonly runnable: boolean;
  }>,
  size: number,
  seed: string,
) => {
  const development = cases.filter(
    (entry) => entry.split === "development" && entry.runnable,
  );
  // A sample is drawn once: an unmatched case would read as having no concern and never be drawn.
  const unmatched = development.filter(
    (entry) => entry.substantiveConcerns === null,
  );
  if (unmatched.length > 0)
    throw new Error(
      `${unmatched.length} runnable development case(s) are not matched yet, first ${unmatched[0]!.caseId}: draw the sample after the full-set matching`,
    );
  const withConcerns = development.filter(
    (entry) => entry.control === null && entry.substantiveConcerns! > 0,
  );
  const controls = development.filter((entry) => entry.control !== null);
  const sources = [
    ...new Set(withConcerns.map((entry) => entry.source)),
  ].sort();
  const rank = (entry: { caseId: string }) =>
    createHash("sha256").update(`${seed}|${entry.caseId}`).digest("hex");
  // Largest remainder: each source's share of the size, its floor, then the leftover seats to the
  // largest fractions (ties by source name), so the draw holds exactly `size` where the pool allows.
  const exact = sources.map((source) => ({
    source,
    share:
      (Math.min(size, withConcerns.length) *
        withConcerns.filter((e) => e.source === source).length) /
      Math.max(1, withConcerns.length),
  }));
  const quota = new Map(exact.map((e) => [e.source, Math.floor(e.share)]));
  const left =
    Math.min(size, withConcerns.length) -
    [...quota.values()].reduce((a, b) => a + b, 0);
  for (const e of [...exact]
    .sort(
      (a, b) =>
        b.share - Math.floor(b.share) - (a.share - Math.floor(a.share)) ||
        (a.source < b.source ? -1 : 1),
    )
    .slice(0, left))
    quota.set(e.source, quota.get(e.source)! + 1);
  const picked = sources.flatMap((source) =>
    withConcerns
      .filter((entry) => entry.source === source)
      .sort((a, b) => (rank(a) < rank(b) ? -1 : 1))
      .slice(0, quota.get(source)),
  );
  return {
    seed,
    size,
    concerns: picked.map((entry) => entry.caseId),
    controls: controls.map((entry) => entry.caseId),
    concernCount: picked.reduce(
      (sum, entry) => sum + entry.substantiveConcerns!,
      0,
    ),
  };
};
