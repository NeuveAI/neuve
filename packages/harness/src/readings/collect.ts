import type {
  CheckedCrossBatchClaim,
  CrossBatchReport,
} from "../pi/cross-batch-claims.ts";
import type { Context } from "@earendil-works/chord";
import type {
  DocumentReader,
  TaskId,
  TaskOutcome,
  Tx,
} from "@earendil-works/pi-durable";
import { Computations, canonicalJson, sha256Hex } from "@neuve/records-core";
import { Cause, Effect, Option } from "effect";
import { z } from "zod";
import { cpuWork } from "../budget/cpu.ts";
import type { ReadingsConfig } from "../config.ts";
import type { Freshness } from "../freshness.ts";
import { Frame } from "../frame.ts";
import { readBlobs } from "../git-objects.ts";
import { captureOutlineSource, type OutlineSource } from "../graph-outline.ts";
import { type Move, type RecordedEntry } from "../lane-rule.ts";
import type { RangeManifest } from "../manifest.ts";
import type { RunLogRecord } from "../run-log.ts";
import { storedOutput, withRecords, type StageRecord } from "../pipeline.ts";
import type { NamedProof } from "../proof-state.ts";
import { MAP_LOCKFILES, ReviewMap, buildMapManifest } from "../review-map.ts";
import { SECTION_IDENTITY_RECIPE } from "../section-identity.ts";
import {
  RULE_SKIPS_RECIPE,
  ruleDecisionsOf,
  storedSectionRules,
} from "../section-rules.ts";
import { isRelationsGap, storedRelations } from "../relations.ts";
import {
  BLOB_STRUCTURE_RECIPE,
  SECTIONS_RECIPE,
  type BlobStructure,
} from "../sections.ts";
import type { ReviewStagesPort } from "../pi/review-task.ts";
import type { FrontResult } from "../pi/stages/front-task.ts";
import type { RelationsResult } from "../pi/stages/relations-task.ts";
import {
  ReadingsRunDoc,
  readManifest,
  readPlan,
  readingName,
  structuresOf,
  type ReadingTask,
  type ReadingTaskInput,
  type ReadingTaskResult,
} from "../pi/stages/reading-task.ts";
import type { StageServices } from "../pi/stages/services.ts";
import type {
  BriefingTask,
  BriefingTaskInput,
  BriefingTaskResult,
} from "../pi/stages/briefing-task.ts";
import { BriefingStored, briefingLayout } from "./briefing.ts";
import type {
  BriefingState,
  FileLead,
  SectionBriefing,
  SettledBriefings,
} from "./briefing-settle.ts";
import type { LaneReviewJudgement } from "./answers.ts";
import { ClaimStored, claimKey, claimVerdict } from "./claims.ts";
import {
  gapKindOf,
  type CarriedFrom,
  type CodeGapKind,
  type Claim,
  type NotJudgedCause,
  type ReadingOutcome,
  type SectionEntry,
} from "./decide.ts";
import {
  READING_RECIPE,
  isGitlink,
  ReadingPlan,
  pairPlan,
  pairingBlobs,
  planReadings,
  type PlanSection,
} from "./plan.ts";
import {
  EvidenceOutcome,
  GroupEvidence,
  HeadGateStatus,
  RelationsShown,
  type SectionReach,
  relationsGapCause,
  rowLifts,
  sectionEvidence,
  type RelationsGapCause,
} from "./evidence.ts";
import {
  readingCallEffort,
  readingEfforts,
  readingStepEffort,
  sectionRisk,
  type ReadingEfforts,
  type ReadingStepKind,
} from "./effort.ts";
import type { AnyRouteConfig } from "../route.ts";
import {
  SettledBatchSchema,
  decideSections,
  settledBatches,
  stored as asStored,
  type CollectedSection,
  type RunGap,
  type SettledBatch,
} from "./settled.ts";
import {
  AssessStored,
  LaneReviewStored,
  assessOutcomes,
  laneReviewOutcomes,
  notAskedCount,
  notAskedKeys,
  testedByCounts,
  type ReadingProducer,
} from "./steps.ts";
import type { RankedComment } from "./units.ts";
import { batchHandle } from "../publish-sections-input.ts";
import {
  NO_READINGS,
  droppedPlanGap,
  reviewBatches,
  type PlanDrop,
  settleBatch,
  type ReviewBatch,
  type SettleResult,
} from "./batches.ts";
import { repositoryOwner } from "../budget/owner.ts";

/**
 * The readings' port on the review task (NEU-148, the probe): `create` plans the readings and
 * creates every reading task in the review task's own commit; `collect` decides every planned
 * section from what the readings stored, stores the result, and writes run-log rows that hold
 * counts, keys and code's words only, never model text. Nothing it returns changes a published
 * unit: the readings add stage records, stored computations, run-log rows and at most one
 * disclosure.
 */

type Ctx = StageServices["ctx"];
type Port = NonNullable<ReviewStagesPort["readings"]>;
type Disclosures = Freshness["disclosures"];

/** One carried reading's computation and the time it took (`savedMsOf`). */
interface CarriedReading {
  readonly key: string;
  readonly savedMs: number;
}
/**
 * Per read section: where its carried judgement came from (`from`, as its entry records it), and
 * every reading computation of it that was carried (`readings`, Assess then Lane review).
 */
interface CarriedReadings {
  readonly from: ReadonlyMap<string, CarriedFrom>;
  readonly readings: ReadonlyMap<string, ReadonlyArray<CarriedReading>>;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The time a ULID was minted at, in milliseconds. */
const ulidTime = (id: string) => {
  let time = 0;
  for (const char of id.slice(0, 10).toUpperCase())
    time = time * 32 + CROCKFORD.indexOf(char);
  return time;
};

export type CollectInput = Parameters<Port["collect"]>[0] & {
  /**
   * The readings' plan task ended cut at its cut-off: a plan that stands in for none stored is then
   * not reached, never failed. Absent or false, a missing plan failed.
   */
  readonly planCut?: boolean | undefined;
};

/**
 * What `prepare` reads, in either of two forms. Today's: the Frame and Map keys the review holds
 * once both landed. The early form, for a review that creates the readings as soon as the changed
 * sections exist: no Frame or Map key, but the front task that makes them (`front`), which every
 * reading task is given so it can see how that task ended, and each Lane review waits on for its
 * keys. The plan reads neither form's Frame or Map. Both forms are wider than the port's own input,
 * so the port's caller can pass today's form unchanged.
 */
export type PrepareInput = (
  | {
      readonly frameKey: string;
      readonly mapKey: string;
      readonly manifestKey: string;
      readonly cutoffAt: number;
      readonly front?: undefined;
    }
  | {
      readonly manifestKey: string;
      readonly cutoffAt: number;
      readonly front: TaskId<FrontResult>;
      readonly frameKey?: undefined;
      readonly mapKey?: undefined;
    }
) & {
  /**
   * The head gate (`relations-task.ts`, `headGateOf`) every reading waits on before its read, so
   * its group decides with the head's relations when they come by the readings' bound. Absent: no
   * reading waits.
   */
  readonly relations?: TaskId<RelationsResult> | undefined;
};

export type ReadingsPort = Omit<
  Port,
  "prepare" | "collect" | "batches" | "settle"
> & {
  readonly prepare: (
    input: PrepareInput,
    signal: AbortSignal,
  ) => ReturnType<Port["prepare"]>;
  readonly collect: (
    input: CollectInput,
    reader: DocumentReader,
    context: Context,
    signal: AbortSignal,
  ) => ReturnType<Port["collect"]>;
  readonly batches: (
    input: BatchesInput,
    reader: DocumentReader,
    context: Context,
    signal: AbortSignal,
  ) => Promise<BatchesOutput>;
  readonly settle: (
    input: SettleInput,
    reader: DocumentReader,
    context: Context,
    signal: AbortSignal,
  ) => Promise<SettleResult>;
};

type MapInput = { readonly mapKey: string; readonly manifestKey: string };

/** A gap about the run, or about a batch that is not settled (the publisher's run `gaps`). */
export type PublishGap = {
  readonly key: string;
  readonly kind: string;
  readonly detail: string;
  readonly cause?: string | undefined;
};

/** What `batches` reads: the Map and manifest keys and every reading the plan created. */
export type BatchesInput = MapInput & {
  readonly frameKey: string;
  readonly readings: ReadonlyArray<{ readonly name: string }>;
  /**
   * The readings' plan task ended cut at its cut-off: a plan that stands in for none stored is then
   * not reached, never failed. Absent or false, a missing plan failed.
   */
  readonly planCut?: boolean | undefined;
};

/** The review's batches, its totals and the run's gaps, for its waiters and its publish phase. */
export interface BatchesOutput {
  /** In the review's batch order; only batches that can be published. */
  readonly batches: ReadonlyArray<Pick<ReviewBatch, "key" | "readings">>;
  /** Of the whole review, for the pending counts (`SettledOutput.totals`). */
  readonly totals: { readonly batches: number; readonly sections: number };
  /** About the run, from the plan, manifest and Map alone: the same on every call of a run. */
  readonly gaps: ReadonlyArray<PublishGap>;
}

/** A batch, its reading outcomes and the results of its incoming checks. */
export type SettleInput = MapInput & {
  readonly frameKey: string;
  /** `ReviewBatch["key"]`. */
  readonly batch: string;
  /** The batch's reading tasks, each with its outcome; undefined when it has not ended. */
  readonly readings: ReadonlyArray<{
    readonly name: string;
    readonly outcome: TaskOutcome<unknown> | undefined;
  }>;
  readonly incoming?: ReadonlyArray<CheckedCrossBatchClaim>;
  readonly final: boolean;
  /**
   * True only on the review's ending call when no follow-on run is left: a section no reading
   * reached then settles as human-required, cause `not-reached`. False everywhere else.
   */
  readonly last: boolean;
  /**
   * The readings' plan task ended cut at its cut-off: a plan that stands in for none stored is then
   * not reached, never failed. Absent or false, a missing plan failed.
   */
  readonly planCut?: boolean | undefined;
};

const PLAN_OP = "harness.readings-plan";
const DROPPED_PLAN_OP = "harness.readings-plan-dropped";
const RELATIONS_STATES = RelationsShown.options;
const DECISION_OP = "harness.readings-decision";

/** The run's gap for a plan that failed (`droppedPlanGap`). */
export const DROPPED_PLAN_GAP: PublishGap = droppedPlanGap("failed");

/**
 * The plan's key: what it reads (the manifest alone, never the Frame or the Map) and every recipe
 * and bound it follows. The excluded files come from the manifest by the Map manifest's own rule
 * (`buildMapManifest`), whose lockfile names are an input here as they are in the Map manifest's
 * key; whether a file is declared generated is in the manifest.
 */
export const planSpec = (input: {
  readonly manifestKey: string;
  readonly bounds: ReadingsConfig["bounds"];
  /** The outline source the stored structures are read with. */
  readonly source: OutlineSource["key"];
  /** Effort by risk: the groups are packed per class, so the plan keys apart; absent, as before. */
  readonly effort?: "by-risk" | undefined;
  /**
   * Rule skips (`ReadingsConfig.ruleSkips`): the key of the rules computation the plan's decided
   * sections come from, the one its judgements are stored under (`rulesRunKey`: a retryable
   * outcome's own key, naming each blob that went without, else the stable key). Absent, the key
   * is exactly as before.
   */
  readonly rules?: string | undefined;
  readonly mapKey?: string | undefined;
}): Computations.ComputationSpec => ({
  op: PLAN_OP,
  // 2: each section keeps its identity whole, its title and its code facts.
  // 3: no Map: the excluded files come from the manifest, and reading groups follow directories,
  // not Map groups, so the same manifest gives another plan.
  // 4: each section says whether its span lost a symbol (`symbolRemoved`).
  // 5: and where its removed rows are at the head (`removedAttributed`, `removedHeads`).
  // 6: a removed row no symbol takes in is not attributed (the same fields, other values).
  // 7: a section that removes rows may carry its pairing rows (`paired`), read from the blobs at
  // the commit (`pairPlan`).
  // 8: a submodule pointer section is in a reading group of its own (`isGitlink`), so the same
  // manifest gives another plan. Code only: the readings' recipe is not bumped again for it.
  opVersion: input.mapKey === undefined ? 8 : 9,
  inputs: {
    manifest: `computation:${input.manifestKey}`,
    lockfiles: [...MAP_LOCKFILES],
    recipe: READING_RECIPE,
    sections: SECTIONS_RECIPE,
    identity: SECTION_IDENTITY_RECIPE,
    structure: BLOB_STRUCTURE_RECIPE,
    source: input.source,
    ...(input.mapKey === undefined
      ? {}
      : { map: `computation:${input.mapKey}` }),
    bounds: { ...input.bounds },
    ...(input.effort === undefined ? {} : { effort: input.effort }),
    ...(input.rules === undefined
      ? {}
      : {
          rules: `computation:${input.rules}`,
          ruleSkips: RULE_SKIPS_RECIPE,
        }),
  },
});

/**
 * The plan of a range from its manifest and blob structures alone: the excluded files are the Map
 * manifest's, made by the same code from the same manifest (`buildMapManifest`), and no affinity is
 * given to the reading groups, so they follow each file's directory (`reading-groups.ts`).
 */
export const planOfManifest = (input: {
  readonly manifest: RangeManifest;
  readonly structures: ReadonlyMap<string, BlobStructure>;
  readonly bounds: ReadingsConfig["bounds"];
  /** Effort by risk: the reading groups are packed within each class. */
  readonly effort?: "by-risk" | undefined;
}) =>
  planReadings({
    hunks: input.manifest.hunks,
    structures: input.structures,
    bounds: input.bounds,
    excluded: buildMapManifest(input.manifest).excluded.map(
      ({ path, reason }) => ({ path, reason }),
    ),
    ...(input.effort === undefined ? {} : { split: input.effort }),
  });

/**
 * Plans the readings once per key, off the event loop, and stores the plan (`planOfManifest`): no
 * Frame and no Map. Before it is stored, each removing section's pairing rows are added from the
 * texts of the blobs they are read from, at the commit (`pairingBlobs`, `pairPlan`): decided here
 * once, so every step of every group, a claim check included, renders the same rows. A blob the
 * read leaves out gives its sections none; a read that fails fails the plan, as a structure read
 * does, so no plan is ever stored with fewer rows than its blobs give.
 *
 * With rule skips on (`ReadingsConfig.ruleSkips`), the stored rule judgements are computed first,
 * with tokens and with the relations the store holds for both the head and the merge base
 * (`storedRelations`, which never starts a read or waits; with either side not stored, none, so an
 * imports-only section that adds an import is not evaluated and keeps its reading), and the
 * sections they decide (`ruleDecisionsOf`) are planned unread, keyed on the rules computation that
 * ran (`rulesRunKey`). When the rules fail, the plan is the one with the setting off, under its
 * key: nothing is decided and everything is read, and the run log says so once, with the
 * failure's tag only (`readings.rules`). Off, nothing of that is read and the plan is as before.
 */
export const storePlan = (
  ctx: Ctx,
  input: {
    readonly manifestKey: string;
    readonly bounds: ReadingsConfig["bounds"];
    readonly manifest: RangeManifest;
    readonly mapKey?: string | undefined;
    /** Effort by risk: pack the groups per class. */
    readonly effort?: "by-risk" | undefined;
  },
) =>
  Effect.gen(function* () {
    // One outline source for the plan's key and the structures it is built from.
    const source = captureOutlineSource();
    const rules =
      ctx.config.readings?.ruleSkips === true
        ? yield* Effect.gen(function* () {
            const { range, hunks } = input.manifest;
            const sides = yield* storedRelations({
              base: range.mergeBase,
              head: range.headOid,
              source,
            });
            const stored = yield* storedSectionRules(
              ctx.repository,
              range.headOid,
              hunks,
              source,
              {
                tokens: true,
                ...(isRelationsGap(sides.base) || isRelationsGap(sides.head)
                  ? {}
                  : {
                      relations: {
                        ...sides,
                        outcomes: { base: "stored", head: "stored" },
                      },
                    }),
              },
            );
            return {
              key: stored.rulesRunKey,
              decided: ruleDecisionsOf(stored.rules),
            };
          }).pipe(
            // A skip only saves work: a rules failure leaves every section read.
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.failCause(cause)
                : Effect.sync(() => {
                    rulesFailed(ctx, cause);
                    return undefined;
                  }),
            ),
          )
        : undefined;
    const spec = planSpec({
      ...input,
      source: source.key,
      ...(rules === undefined ? {} : { rules: rules.key }),
    });
    const store = yield* Computations.ComputationStore;
    const result = yield* store.run(
      spec,
      Effect.gen(function* () {
        const { structures } = yield* structuresOf(ctx, input.manifest, source);
        const map =
          input.mapKey === undefined
            ? undefined
            : yield* storedOutput(ctx, input.mapKey, ReviewMap);
        const planned = yield* cpuWork(
          repositoryOwner(ctx.repository),
          Effect.sync(() =>
            planReadings({
              hunks: input.manifest.hunks,
              structures,
              bounds: input.bounds,
              excluded: buildMapManifest(input.manifest).excluded,
              ...(input.effort === undefined ? {} : { split: input.effort }),
              ...(rules === undefined ? {} : { decided: rules.decided }),
              ...(map === undefined
                ? {}
                : {
                    batches: map.groups.map(
                      (group) => new Set(group.files.map((file) => file.path)),
                    ),
                  }),
            }),
          ),
        );
        const hunks = new Map(
          input.manifest.hunks.map((hunk) => [hunk.hunkId, hunk]),
        );
        const blobs = yield* readBlobs(
          ctx.repository,
          pairingBlobs(planned, hunks),
        );
        const plan = yield* cpuWork(
          repositoryOwner(ctx.repository),
          Effect.sync(() => {
            const decoder = new TextDecoder();
            const texts = new Map(
              [...blobs].map(([oid, bytes]) => [oid, decoder.decode(bytes)]),
            );
            return pairPlan(planned, hunks, texts);
          }),
        );
        return {
          bytes: new TextEncoder().encode(JSON.stringify(plan)),
          mediaType: "application/json",
        };
      }),
    );
    return result.computation.key;
  }).pipe((effect) => withRecords(ctx, effect));

/**
 * The plan of a review whose readings' plan was dropped: the same rule from the manifest alone, with
 * no blob structure and no pairing rows, so each changed hunk is a section of its own (`boundaries:
 * "fallback"`) and nothing is read from Graph or Git. No reading is ever made from it: every read
 * section settles as human-required, cause `failed` (its readings are missing), and the excluded and
 * unread files as they would. Keyed apart from the real plan. Its work takes a CPU grant like the
 * plan's; when admission refuses one, the drop this plan stands in for, it is done without one,
 * since it is the only way the review can still give each section to a person.
 */
export const storeDroppedPlan = (
  ctx: Ctx,
  input: {
    readonly manifestKey: string;
    readonly bounds: ReadingsConfig["bounds"];
    readonly manifest: RangeManifest;
  },
) =>
  Effect.gen(function* () {
    const store = yield* Computations.ComputationStore;
    const planned = () =>
      planOfManifest({
        manifest: input.manifest,
        structures: new Map(),
        bounds: input.bounds,
      });
    const result = yield* store.run(
      {
        op: DROPPED_PLAN_OP,
        opVersion: 1,
        inputs: {
          manifest: `computation:${input.manifestKey}`,
          lockfiles: [...MAP_LOCKFILES],
          recipe: READING_RECIPE,
          sections: SECTIONS_RECIPE,
          identity: SECTION_IDENTITY_RECIPE,
          bounds: { ...input.bounds },
        },
      },
      cpuWork(repositoryOwner(ctx.repository), Effect.sync(planned)).pipe(
        Effect.catchTag("BudgetAdmissionFailed", () => Effect.sync(planned)),
        Effect.map((plan) => ({
          bytes: new TextEncoder().encode(JSON.stringify(plan)),
          mediaType: "application/json",
        })),
      ),
    );
    return result.computation.key;
  }).pipe((effect) => withRecords(ctx, effect));

/**
 * The run log's one line for rule judgements that failed with rule skips on, naming the failure's
 * tag only (a `_tag`, else `Error`; `Defect` for a defect), never its text. Written once per run.
 */
const rulesFailed = (ctx: Ctx, cause: Cause.Cause<unknown>) => {
  const error = Cause.findErrorOption(cause);
  const failure = Option.isNone(error) ? undefined : error.value;
  const tag = Option.isNone(error)
    ? "Defect"
    : typeof failure === "object" && failure !== null && "_tag" in failure
      ? String(failure._tag)
      : "Error";
  try {
    if (!ctx.log.read().some((row) => row.type === "readings.rules"))
      ctx.log.write({ type: "readings.rules", failed: true, tag });
  } catch {
    // The run log itself failed: the plan is still made, with every section read.
  }
};

/** What `prepare` hands `create`: the plan's key and the tasks to create, or why there are none. */
const Prepared = z.strictObject({
  plan: z.string().nullable(),
  unavailable: z.string().nullable(),
  tasks: z.array(
    z.strictObject({
      name: z.string().min(1),
      input: z.strictObject({
        kind: z.enum(["assess", "lane-review"]),
        planKey: z.string(),
        group: z.string(),
        rank: z.int().min(0),
        frameKey: z.string().optional(),
        mapKey: z.string().optional(),
        front: z.int().min(0).optional(),
        /** The head gate every reading waits on (`ReadingTaskInput.relations`). */
        relations: z.int().min(0).optional(),
        manifestKey: z.string(),
        cutoffAt: z.number(),
        effort: z.enum(["low", "medium", "high"]).optional(),
        claimEffort: z.enum(["low", "medium", "high"]).optional(),
      }),
    }),
  ),
  /**
   * One briefing task per reading group (round 27), each given every group's Assess task when
   * `create` makes them in the same commit. Absent from a value a build before it prepared.
   */
  briefings: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        input: z.strictObject({
          planKey: z.string(),
          group: z.string(),
          rank: z.int().min(0),
          manifestKey: z.string(),
          cutoffAt: z.number(),
          frameKey: z.string().optional(),
          mapKey: z.string().optional(),
          front: z.int().min(0).optional(),
          effort: z.enum(["low", "medium", "high"]).optional(),
          role: z.enum(["parts", "digests"]).optional(),
        }),
      }),
    )
    .optional(),
});

/** The groups in creation order: rank, highest first, then the plan's order. */
export const byRank = (plan: ReadingPlan) =>
  plan.groups
    .map((group, at) => ({ group, at }))
    .sort((a, b) => b.group.rank - a.group.rank || a.at - b.at)
    .map(({ group }) => group);

/**
 * Scope and tests' fields of one `reading.call` row, only with it on and only for a read or re-read
 * that stored an answer (never a claim check); none otherwise, so the row is as before. Counts and
 * identity keys only, never a path, symbol or text: an Assess reading's requirements where it showed
 * a test row (`testedByCounts`: null where it showed none); a Lane review reading's sections not
 * asked for, as a count and as their identity keys in the reading's order (`notAskedKeys`, the keys
 * the row's own stored `sections` carry).
 */
export const scopeAndTestsFields = (
  config: Pick<ReadingsConfig, "scopeAndTests">,
  kind: "assess" | "lane-review",
  part: "read" | "reread" | "claim",
  stored: unknown,
  plan: ReadingPlan,
): Record<string, unknown> =>
  config.scopeAndTests !== true || stored === undefined || part === "claim"
    ? {}
    : kind === "assess"
      ? { testedBy: testedByCounts(stored as AssessStored, plan) }
      : {
          notAsked: notAskedCount(stored as LaneReviewStored),
          notAskedSections: notAskedKeys(stored as LaneReviewStored, plan),
        };

/** The plan's efforts by risk when the run's readings configuration asks for them, else none. */
export const byRiskOf = (
  config: Pick<ReadingsConfig, "effort">,
  plan: ReadingPlan,
  hunks: ReadonlyMap<string, RangeManifest["hunks"][number]>,
): ReadingEfforts | undefined =>
  config.effort === "by-risk" ? readingEfforts(plan, hunks) : undefined;

/**
 * The reading tasks `prepare` lists for a plan, by rank, highest first, Assess before Lane review,
 * each with the effort its read and re-read run at, and a Lane review with its claims' checks' when
 * they have one of their own (`readingStepEffort`). Given the Frame and Map keys (today's form), each
 * Lane review task carries them; given the front task (the early form), every task carries its ID.
 * Given the head gate, every task carries its ID too, and waits on it before its read.
 */
export const readingTaskInputs = (
  plan: ReadingPlan,
  planKey: string,
  input: PrepareInput,
  route: AnyRouteConfig,
  byRisk: ReadingEfforts | undefined,
): Array<{ name: string; input: ReadingTaskInput }> =>
  byRank(plan).flatMap((group) =>
    (["assess", "lane-review"] as const).map((kind) => {
      const effort = readingStepEffort(route, byRisk, kind, group.id);
      const claimEffort =
        kind === "lane-review"
          ? readingStepEffort(route, byRisk, "verify-claim", group.id)
          : undefined;
      return {
        name: readingName(kind, group.id),
        input: {
          kind,
          planKey,
          group: group.id,
          rank: group.rank,
          manifestKey: input.manifestKey,
          cutoffAt: input.cutoffAt,
          ...(input.front !== undefined
            ? { front: Number(input.front) }
            : kind === "lane-review"
              ? { frameKey: input.frameKey, mapKey: input.mapKey }
              : {}),
          ...(effort === undefined ? {} : { effort }),
          ...(claimEffort === undefined ? {} : { claimEffort }),
          ...(input.relations === undefined
            ? {}
            : { relations: Number(input.relations) }),
        } satisfies ReadingTaskInput,
      };
    }),
  );

/**
 * The briefing tasks `prepare` lists for a plan (round 27): one per reading group, by rank, each at
 * the effort its calls run at (`readingStepEffort`, kind `brief`), given the Frame and Map keys or
 * the front task as the readings are. `create` adds every group's Assess task.
 */
export const briefingTaskInputs = (
  plan: ReadingPlan,
  planKey: string,
  input: PrepareInput,
  route: AnyRouteConfig,
): Array<{ name: string; input: Omit<BriefingTaskInput, "assess"> }> =>
  byRank(plan).flatMap((group) => {
    const effort = readingStepEffort(route, undefined, "brief", group.id);
    const common = {
      planKey,
      group: group.id,
      rank: group.rank,
      manifestKey: input.manifestKey,
      cutoffAt: input.cutoffAt,
      ...(input.front !== undefined
        ? { front: Number(input.front) }
        : { frameKey: input.frameKey, mapKey: input.mapKey }),
      ...(effort === undefined ? {} : { effort }),
    };
    // The group's parts, and apart from them the digests of batches it shares and owns, which
    // only those batches wait on (a group that owns none ends its digest task at once).
    return [
      { name: readingName("brief", group.id), input: common },
      {
        name: readingName("digest", group.id),
        input: { ...common, role: "digests" as const },
      },
    ];
  });

/**
 * What a review's briefing tasks stored (round 27), from their outcomes by task name: each read
 * section's Briefed and Explained and each batch's digest, the stored calls' keys, one
 * `briefing.call` row per call (counts, keys and labels only) and the calls' stage records. Where a
 * group's briefing never stored a call, its sections and the digest it owns read as cut (the task
 * was stopped at the cut-off, or the call was never started or interrupted) or failed (anything
 * else), so code's text stands. Reads stored outputs only.
 */
export const settledBriefingsOf = async (input: {
  readonly plan: ReadingPlan;
  readonly groups: ReadonlyArray<{
    readonly id: string;
    readonly hunkIds: ReadonlyArray<string>;
  }>;
  readonly ended: ReadonlyMap<string, TaskOutcome<unknown> | undefined>;
  readonly read: (key: string) => Promise<BriefingStored | undefined>;
}): Promise<{
  readonly briefings: SettledBriefings;
  readonly keys: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  readonly stages: ReadonlyArray<StageRecord>;
}> => {
  const { plan, groups, ended, read } = input;
  const briefingKeys: Array<string> = [];
  const briefingRows: Array<Record<string, unknown>> = [];
  const stages: Array<StageRecord> = [];
  const layout = briefingLayout(plan, groups);
  const sections = new Map<string, SectionBriefing>();
  const leads = new Map<string, FileLead>();
  const digests = new Map<
    string,
    { state: BriefingState; text: BriefingStored["answer"]["digest"] }
  >();
  const whole = (name: string): BriefingState =>
    ended.get(name)?.status === "aborted" ? "cut" : "failed";
  for (const [group, parts] of layout.parts)
    for (const part of parts)
      for (const key of part.sections)
        sections.set(key, {
          state: whole(readingName("brief", group)),
          briefed: null,
          explained: null,
        });
  for (const [batch, owner] of layout.digests)
    digests.set(batch, {
      // A shared batch's digest is its owner's digest task's; any other, its briefing's.
      state: whole(
        readingName(
          owner.kind === "call" && owner.groups.length > 1 ? "digest" : "brief",
          owner.group,
        ),
      ),
      text: null,
    });
  // Each group's briefing (`brief.<group>`) and its digest task (`digest.<group>`).
  for (const { group, name } of plan.groups.flatMap((group) =>
    (["brief", "digest"] as const).map((kind) => ({
      group,
      name: readingName(kind, group.id),
    })),
  )) {
    const outcome = ended.get(name) as
      TaskOutcome<BriefingTaskResult> | undefined;
    const result =
      outcome?.status === "completed" || outcome?.status === "aborted"
        ? outcome.result
        : undefined;
    for (const record of result?.stages ?? [])
      stages.push(
        record.status === "interrupted" || record.status === "skipped"
          ? { ...record, disclosure: null }
          : record,
      );
    for (const call of result?.calls ?? []) {
      const stored = call.key === null ? undefined : await read(call.key);
      if (call.key !== null) briefingKeys.push(call.key);
      const callState: BriefingState =
        stored !== undefined
          ? "written"
          : call.state === "not-reached"
            ? "cut"
            : "failed";
      const record = result!.stages.find(
        (r) => r.key !== undefined && r.key === call.key,
      );
      // One row per call: counts, keys and labels only, never its text.
      briefingRows.push({
        type: "briefing.call",
        group: group.id,
        batch: call.batch,
        call: call.call,
        digest: call.digest,
        sections: stored?.sections.length ?? call.sections.length,
        asked: stored?.asked.length ?? null,
        unanswered: stored?.unanswered.length ?? null,
        characters: stored?.characters ?? null,
        source: stored?.source ?? null,
        run:
          stored === undefined
            ? call.state === "failed"
              ? "failed"
              : "not-started"
            : record?.status === "reused"
              ? "stored"
              : "ran",
        ...(call.failure === undefined ? {} : { failure: call.failure }),
        key: call.key,
        problems: stored?.problems ?? null,
        judgingWords: stored?.judgingWords ?? null,
        inputTokens: record?.agentResult?.usage.input ?? null,
        cachedInputTokens: record?.agentResult?.usage.cacheRead ?? null,
        outputTokens: record?.agentResult?.usage.output ?? null,
        reasoningTokens: record?.agentResult?.usage.thinking ?? null,
        wallMs: record?.wallMs ?? null,
      });
      if (call.call === "part") {
        const unanswered = new Set(stored?.unanswered ?? []);
        for (const key of call.sections) {
          const answer = stored?.answer.sections.find((s) => s.key === key);
          sections.set(key, {
            state:
              callState === "written" && unanswered.has(key)
                ? "failed"
                : callState,
            title: answer?.title ?? null,
            briefed: answer?.briefed ?? null,
            explained: answer?.explained ?? null,
          });
        }
        // Each marked file's lead (round 27b), with the sections it speaks for.
        for (const lead of stored?.answer.leads ?? [])
          leads.set(lead.path, {
            sections: [...lead.sections],
            title: lead.title,
            text: lead.text,
          });
      }
      if (call.digest) {
        const text = stored?.answer.digest ?? null;
        digests.set(call.batch, {
          state:
            callState === "written" && text === null ? "failed" : callState,
          text,
        });
      }
    }
  }
  return {
    briefings: { sections, digests, leads },
    keys: briefingKeys,
    rows: briefingRows,
    stages,
  };
};

type SectionCause = NotJudgedCause;

/** One planned section's outcomes from both readings, the claims on it, and the steps they came from. */
type Collected = CollectedSection & { readonly claims: Array<Claim> };

const lines = (section: PlanSection) =>
  section.owned.map(
    (range) =>
      `${section.path}:${range.side}:${range.startLine === range.endLine ? range.startLine : `${range.startLine}-${range.endLine}`}`,
  );

/** A section's recorded blast radius as its row carries it: the counts, without its key; null when none. */
const reachCounts = (
  reach: SectionReach | undefined,
): Omit<SectionReach, "key"> | null =>
  reach === undefined
    ? null
    : {
        symbols: reach.symbols,
        callers: reach.callers,
        trusted: reach.trusted,
        testCallers: reach.testCallers,
        files: reach.files,
        filesComplete: reach.filesComplete,
        edges: reach.edges,
      };

/** A `reading.call` row's numbers when no call ran: none are known. */
const NO_FIGURES = {
  inputTokens: null,
  cachedInputTokens: null,
  cacheWriteTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  classes: null,
  outside: null,
} as const;

/**
 * A stored section entry reduced to exactly what `recordedLane` (`lane-rule.ts`) reads, so the lane
 * trail on a `reading.section` row can be computed again from the row: the two levels; each
 * factor's and requirement's cites, as the stable identifiers they are stored as (the rule counts
 * them); each requirement's coverage; the lean's lane; each gap's axis, with its kind as a closed
 * label (`gapKindOf`: code's own kind for a gap code wrote, else `model`, never a reading's words),
 * which `recordedLane` does not read but which lets a gap code wrote be left out; the recorded
 * floors; and
 * whether the entry is undecided (its cause, a closed label) or an excluded file (its reason, a
 * closed label). `recordedLane` also reads a requirement's text and the lean's reason, but only into
 * its note, which no row carries: they are written as empty strings, so no text of any kind is on
 * the row. `movement` is written whole: each move's signal, axis and direction (closed labels) and
 * its cites (comment IDs). `assess` is null where Assess did not judge.
 */
export const laneEntryOf = (
  entry: SectionEntry,
): Omit<RecordedEntry, "assess"> & {
  readonly assess:
    | (Omit<NonNullable<RecordedEntry["assess"]>, "movement" | "gaps"> & {
        readonly movement: ReadonlyArray<Move>;
        readonly gaps: ReadonlyArray<
          NonNullable<RecordedEntry["assess"]>["gaps"][number] & {
            readonly kind: CodeGapKind | "model";
          }
        >;
      })
    | null;
} => ({
  assess:
    entry.assess === null
      ? null
      : {
          complexity: {
            level: entry.assess.complexity.level,
            factors: entry.assess.complexity.factors.map((factor) => ({
              cites: [...factor.cites],
            })),
          },
          easeOfValidation: {
            level: entry.assess.easeOfValidation.level,
            requirements: entry.assess.easeOfValidation.requirements.map(
              (requirement) => ({
                cites: [...requirement.cites],
                coverage: requirement.coverage,
                requirement: "",
              }),
            ),
          },
          movement: entry.assess.movement.map((move) => ({
            signal: move.signal,
            axis: move.axis,
            direction: move.direction,
            cites: [...move.cites],
          })),
          lean:
            entry.assess.lean === null
              ? null
              : { lane: entry.assess.lean.lane, reason: "" },
          gaps: entry.assess.gaps.map((gap) => ({
            axis: gap.axis,
            kind: gapKindOf(gap),
          })),
        },
  lane: { floors: entry.lane.floors.map(({ rule, to }) => ({ rule, to })) },
  ...(entry.undecided === undefined
    ? {}
    : { undecided: { cause: entry.undecided.cause } }),
  ...(entry.excluded === undefined
    ? {}
    : { excluded: { reason: entry.excluded.reason } }),
});

const runOf = (status: StageRecord["status"]) =>
  status === "reused"
    ? "reused"
    : status === "skipped"
      ? "not-started"
      : status === "interrupted"
        ? "interrupted"
        : "ran";

/** Why a section is still waiting: a reading not reached or refused, or a claim's check not reached. */
export type WaitingCause =
  "reading-not-reached" | "check-not-reached" | "refused";

/**
 * The one disclosure of a probe run that left sections not judged or still waiting, in plain words
 * with counts. A run with any waiting section always has it.
 */
export const readingsDisclosure = (
  total: number,
  causes: ReadonlyArray<SectionCause>,
  waiting: ReadonlyArray<WaitingCause> = [],
): Disclosures => {
  if (causes.length === 0 && waiting.length === 0) return [];
  const words: Record<SectionCause, string> = {
    failed: "failed",
    "not-reached": "not reached",
    "too-large": "too large to read",
    refused: "refused by the provider",
    unreadable: "with no text to read",
  };
  const waits: Record<WaitingCause, string> = {
    "reading-not-reached": "for a reading not reached",
    "check-not-reached": "for a claim check not reached",
    refused: "for a reading the provider refused",
  };
  const listed = <C extends string>(
    values: ReadonlyArray<C>,
    names: Record<C, string>,
  ) =>
    (Object.keys(names) as Array<C>)
      .map(
        (cause) => [cause, values.filter((c) => c === cause).length] as const,
      )
      .filter(([, count]) => count > 0)
      .map(([cause, count]) => `${count} ${names[cause]}`)
      .join(", ");
  const judged =
    causes.length === 0
      ? `all ${total} sections were judged`
      : `${causes.length} of ${total} sections were not judged (${listed(causes, words)})`;
  const still =
    waiting.length === 0
      ? ""
      : `; ${waiting.length} ${waiting.length === 1 ? "section is" : "sections are"} still waiting (${listed(waiting, waits)})`;
  return [
    {
      kind: "section-readings",
      detail: `Section readings: ${judged}${still}.`,
    },
  ];
};

/** What the stored decision holds for the publisher (`harness.readings-decision`, version 2). */
const StoredSettled = z.looseObject({
  settled: z.array(SettledBatchSchema),
  totals: z.strictObject({
    batches: z.int().min(0),
    sections: z.int().min(0),
  }),
  gaps: z.array(
    z.strictObject({ key: z.string(), kind: z.string(), detail: z.string() }),
  ),
});

/** What the publisher is to be handed for a run: its settled batches, the review's totals and the run's gaps. */
export interface SettledForRun {
  readonly batches: ReadonlyArray<SettledBatch>;
  readonly totals: { readonly batches: number; readonly sections: number };
  readonly gaps: ReadonlyArray<RunGap>;
}

/**
 * The key of the run's latest stored readings decision, from its `readings.decision` row; null when
 * the readings decided nothing in this run. Until the readings' hook returns the key, this is how
 * the caller of `publishSettled` finds it.
 */
export const decisionKeyOf = (log: Pick<Ctx["log"], "read">): string | null => {
  const rows = log.read().filter((row) => row.type === "readings.decision");
  const key = rows.at(-1)?.["key"];
  return typeof key === "string" ? key : null;
};

/**
 * The settled batches of a run, from its stored decision by key, as the future caller of
 * `publishSettled` hands them over: in the Map's order, with the review's totals and the run's gaps.
 * A unit with no disposition reads back with `disposition` undefined, as the contract writes it.
 */
export const settledOf = async (
  services: Pick<StageServices, "ctx" | "run">,
  decisionKey: string,
  signal?: AbortSignal,
): Promise<SettledForRun> => {
  const decision = await services.run(
    storedOutput(services.ctx, decisionKey, StoredSettled),
    signal,
  );
  return {
    batches: decision.settled.map((batch) => ({
      ...batch,
      sections: batch.sections.map((section) => ({
        ...section,
        entry:
          section.entry as unknown as SettledBatch["sections"][number]["entry"],
      })),
      units: batch.units.map((unit) => ({
        ...unit,
        disposition: unit.disposition,
      })),
    })) as ReadonlyArray<SettledBatch>,
    totals: decision.totals,
    gaps: decision.gaps,
  };
};

/**
 * Whether the commit's view of the owner shows it finishing (`completing` or terminal), when the
 * commit can still read tables; false when it cannot look (a table was written first, or the read
 * failed), which leaves the judgement to the runtime's own check at commit.
 */
const finishing = async (tx: Tx, owner: TaskId): Promise<boolean> => {
  try {
    const held = await tx.task(owner);
    return (
      held !== undefined &&
      (held.state.status === "completing" || held.state.status === "terminal")
    );
  } catch {
    return false;
  }
};

export const readingsPort = (
  services: StageServices,
  task: ReadingTask,
  config: ReadingsConfig,
  /** The briefing task (round 27); without it no briefing is made, and code writes as before. */
  briefing?: BriefingTask,
): ReadingsPort => {
  const { ctx } = services;
  const run = services.run;

  /**
   * Everything slow, before the review's commit and with no transaction open: the plan, computed
   * once and stored (a replayed phase finds it), and the list of reading tasks to create, by rank,
   * highest first, Assess before Lane review. A plan that cannot be made is returned as such: the
   * probe never stops a review. The `readings.plan` row is written once per plan.
   *
   * Current plans pack sections within Map batches. The saved plan carries each section's ownership.
   */
  const prepare: ReadingsPort["prepare"] = async (input, signal) => {
    let planKey: string;
    let manifest: RangeManifest;
    try {
      manifest = await readManifest(ctx, run, input.manifestKey, signal);
      planKey = await run(
        storePlan(ctx, {
          manifestKey: input.manifestKey,
          bounds: config.bounds,
          manifest,
          mapKey: input.mapKey,
          ...(config.effort === undefined ? {} : { effort: config.effort }),
        }),
        signal,
      );
    } catch (error) {
      if (signal.aborted) throw error;
      const unavailable =
        error instanceof Error ? error.message.slice(0, 300) : String(error);
      if (
        !ctx.log
          .read()
          .some((row) => row.type === "readings.plan" && row["plan"] === null)
      )
        ctx.log.write({ type: "readings.plan", plan: null, unavailable: true });
      return Prepared.parse({ plan: null, unavailable, tasks: [] });
    }
    const plan = await readPlan(ctx, run, planKey, signal);
    const hunks = new Map(manifest.hunks.map((hunk) => [hunk.hunkId, hunk]));
    // The plan's classes, for the row: by risk when the run asks for it (its groups are then of one
    // class each), else as the plan's groups would be classed, so a run at any effort can be scored.
    const byRisk = byRiskOf(config, plan, hunks);
    const classes = byRisk ?? readingEfforts(plan, hunks);
    const tasks = readingTaskInputs(
      plan,
      planKey,
      input,
      ctx.config.route,
      byRisk,
    );
    if (
      !ctx.log
        .read()
        .some((row) => row.type === "readings.plan" && row["plan"] === planKey)
    ) {
      const unread = (cause: string) =>
        plan.unread.filter((section) => section.cause === cause).length;
      ctx.log.write({
        type: "readings.plan",
        plan: planKey,
        sections: plan.sections.length,
        unread: {
          excluded: unread("excluded"),
          unreadable: unread("unreadable"),
          "too-large": unread("too-large"),
        },
        groups: plan.groups.length,
        tasks: tasks.length,
        // Sections and groups per class and the high sections by reason, as counts; `rule` is
        // `by-risk` when the efforts follow the classes, else null.
        effort: {
          rule: byRisk === undefined ? null : "by-risk",
          ...classes.counts,
        },
      });
    }
    // A task input this schema does not take (a field added to `ReadingTaskInput` and not here)
    // would end the plan with no reading: the row says which fields, as closed labels, before the
    // plan task's own failed path (`readings.prepare` `failed`) ends it.
    const parsed = Prepared.safeParse({
      plan: planKey,
      unavailable: null,
      tasks,
      ...(briefing === undefined
        ? {}
        : {
            briefings: briefingTaskInputs(
              plan,
              planKey,
              input,
              ctx.config.route,
            ),
          }),
    });
    if (!parsed.success) {
      ctx.log.write({
        type: "readings.prepare.invalid",
        plan: planKey,
        issues: parsed.error.issues.map((issue) =>
          [
            issue.code,
            ...issue.path
              .filter((part) => typeof part === "string")
              .map(String),
            ...("keys" in issue && Array.isArray(issue.keys)
              ? issue.keys.map(String)
              : []),
          ].join(":"),
        ),
      });
      throw parsed.error;
    }
    return parsed.data;
  };

  /**
   * Only creates, inside the caller's commit, the tasks `prepare` listed: no store read, no CPU
   * work. Each task is recorded by name in the run's `ReadingsRunDoc` in that same commit, so a
   * second call before the commit lands, or a replayed change, finds it instead of making it again.
   *
   * It never throws: the review task calls it unguarded, and the probe never stops a review. A
   * value that is not what `prepare` hands over, a document that cannot be read, or a task that
   * cannot be created leaves no reading to wait on (an empty list) and one `readings.create` row
   * saying at which step, with no message. Every reading of the plan is then missing, so `collect`
   * finds them failed and the disclosure says so.
   *
   * The runtime refuses a task under an owner that is finishing (`completing` or terminal) only when
   * the commit is assembled, after this returned (pi-durable's owner check), so the whole commit
   * would fail. `create` therefore looks at the owner first, when the commit has written no table
   * yet, and makes no task under one that is finishing (step `task`). Where it cannot look (the
   * commit wrote a table before calling it), the runtime's own check still stands.
   */
  const create: Port["create"] = async (tx: Tx, value, owner: TaskId) => {
    let step: "input" | "document" | "task" = "input";
    try {
      const prepared = Prepared.parse(value);
      if (prepared.plan !== null && prepared.tasks.length > 0) {
        step = "task";
        if (await finishing(tx, owner))
          throw new Error("the readings' owner is finishing");
      }
      step = "document";
      const doc = await tx.doc(ReadingsRunDoc);
      if (prepared.plan === null) {
        doc.unavailable = prepared.unavailable;
        return [];
      }
      doc.plan = prepared.plan;
      doc.unavailable = null;
      step = "task";
      const created: Array<{ name: string; task: TaskId<unknown> }> = [];
      for (const { name, input } of prepared.tasks) {
        const id =
          doc.tasks[name] ??
          (await tx.createTask(task, input as ReadingTaskInput, {
            ownership: { kind: "task", taskId: owner },
          }));
        doc.tasks[name] = id;
        created.push({ name, task: id as TaskId<unknown> });
      }
      // Each group's briefing, given every group's Assess task made above (round 27).
      if (briefing !== undefined) {
        const assess = Object.fromEntries(
          prepared.tasks
            .filter((t) => t.input.kind === "assess")
            .map((t) => [t.input.group, doc.tasks[t.name]!]),
        );
        for (const { name, input } of prepared.briefings ?? []) {
          const id =
            doc.tasks[name] ??
            (await tx.createTask(
              briefing,
              { ...input, assess } as BriefingTaskInput,
              { ownership: { kind: "task", taskId: owner } },
            ));
          doc.tasks[name] = id;
          created.push({ name, task: id as TaskId<unknown> });
        }
      }
      return created;
    } catch {
      try {
        ctx.log.write({ type: "readings.create", failed: true, step });
      } catch {
        // The run log itself failed: nothing more can be said, and the review goes on.
      }
      return [];
    }
  };

  const collect = async (
    input: CollectInput,
    reader: DocumentReader,
    context: Context,
    signal: AbortSignal,
  ): ReturnType<Port["collect"]> => {
    try {
      return await collected(input, reader, context, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      // Never the review's failure: the probe's outcome is lost, and the run says so.
      ctx.log.write({ type: "readings.collect", failed: true });
      return {
        stages: [],
        disclosures: [
          {
            kind: "section-readings",
            detail:
              "Section readings: their outcome could not be collected, so no section was judged by them.",
          },
        ],
      };
    }
  };

  /** How long a stored reading's first successful attempt took, from its ULID to its completion. */
  const savedMsOf = (
    row: { attemptId: string; completedAt: string } | undefined,
  ) => {
    const ms =
      row === undefined
        ? 0
        : Date.parse(row.completedAt) - ulidTime(row.attemptId);
    return Number.isFinite(ms) ? Math.max(0, ms) : 0;
  };

  /**
   * The read sections whose judgement this review carried, with where from: those whose Assess
   * (else Lane review) judgement is held in a stored output another review produced (`by` names a
   * run key other than this run's). A follow-on run of this review, or a replay of this run, shares
   * the run key, so what they reuse stays fresh. The computation's row names its output blob and its
   * first successful attempt, whose ULID gives when that reading started: `savedMs` is how long it
   * took. A store that cannot say leaves the output empty and the time 0; the lineage stands.
   */
  const carriedOf = async (
    collected: ReadonlyMap<string, CollectedSection>,
    producers: ReadonlyMap<string, ReadingProducer | undefined>,
    signal: AbortSignal,
  ): Promise<CarriedReadings> => {
    const earlier = new Map<string, ReadingProducer>();
    for (const [key, by] of producers)
      if (by !== undefined && by.review !== ctx.runKey) earlier.set(key, by);
    if (earlier.size === 0) return { from: new Map(), readings: new Map() };
    const rows = await run(
      withRecords(
        ctx,
        Effect.gen(function* () {
          const store = yield* Computations.ComputationStore;
          return yield* store.lookupMany([...earlier.keys()].sort());
        }),
      ),
      signal,
    ).catch(
      (
        error: unknown,
      ): ReadonlyMap<
        string,
        { outputHash: string; attemptId: string; completedAt: string }
      > => {
        if (signal.aborted) throw error;
        return new Map();
      },
    );
    const from = new Map<string, CarriedFrom>();
    const readings = new Map<string, ReadonlyArray<CarriedReading>>();
    for (const [section, held] of collected) {
      // Both readings' computations, Assess first: `from` names the first, and each one carried
      // is listed so the ledger can count its time once.
      const keys = [held.steps.assess, held.steps.review].filter(
        (step, at, all): step is string =>
          step !== null && earlier.has(step) && all.indexOf(step) === at,
      );
      if (keys.length === 0) continue;
      readings.set(
        section,
        keys.map((key) => ({ key, savedMs: savedMsOf(rows.get(key)) })),
      );
      const key = keys[0]!;
      const by = earlier.get(key)!;
      from.set(section, {
        review: by.review,
        run: by.run,
        cycle: by.cycle,
        head: by.head,
        judgement: key,
        output: rows.get(key)?.outputHash ?? "",
        savedMs: savedMsOf(rows.get(key)),
      });
    }
    return { from, readings };
  };

  /**
   * Every section decision from the plan and stored answers, and every settled batch as the publisher takes it, with the figures `collect`'s rows
   * hold. It reads stored outputs only: it stores nothing, writes no row and calls no model, so the
   * collector and the batch waiters (`settle`) decide from one code path.
   */
  const judge = async (
    input: Pick<
      CollectInput,
      "frameKey" | "mapKey" | "manifestKey" | "readings"
    > & {
      readonly last?: boolean | undefined;
      readonly incoming?: ReadonlyArray<CheckedCrossBatchClaim>;
    },
    plan: ReadingPlan,
    planKey: string,
    signal: AbortSignal,
    /**
     * The plan stands in for a dropped one (`planOf`): no batch names a failed reading, and every
     * missing reading is failed, or not reached when the plan was cut at its cut-off.
     */
    dropped: PlanDrop | false = false,
  ) => {
    const manifest = await readManifest(ctx, run, input.manifestKey, signal);
    const map = await run(storedOutput(ctx, input.mapKey, ReviewMap), signal);
    const frame = await run(storedOutput(ctx, input.frameKey, Frame), signal);
    const hunks = new Map(manifest.hunks.map((hunk) => [hunk.hunkId, hunk]));
    const sectionByKey = new Map(plan.sections.map((s) => [s.key, s]));
    const ended = new Map(input.readings.map((r) => [r.name, r.outcome]));
    // The effort each call ran at, by the rule and plan `prepare` gave the tasks (`readingCallEffort`),
    // and why the rule's class of its group is high (`effortWhy`: the union of its sections'
    // reasons), with effort by risk on or off; each section's facts (`risk`, `topQuarter`) likewise.
    // Closed labels and booleans only.
    const byRisk = byRiskOf(config, plan, hunks);
    const classes = byRisk ?? readingEfforts(plan, hunks);
    const effortOf = (kind: ReadingStepKind, group: string) => ({
      effort: readingCallEffort(ctx.config.route, byRisk, kind, group),
      effortWhy: [...(classes.groups.get(group)?.why ?? [])],
    });
    // An unread section has no rank among the read ones: never in the top quarter.
    const riskOf = (section: PlanSection) => {
      const { removal, publicSurface } = sectionRisk(section, hunks);
      return {
        risk: { removal, publicSurface },
        topQuarter: classes.sections.get(section.key)?.topQuarter === true,
      };
    };

    const read = <O>(key: string, schema: import("zod").ZodType<O>) =>
      run(storedOutput(ctx, key, schema), signal).catch((error: unknown) => {
        if (signal.aborted) throw error;
        return undefined;
      });

    const collected = new Map<string, Collected>();
    for (const section of plan.sections)
      collected.set(section.key, {
        assess: { judged: false, cause: "failed" },
        review: { judged: false, cause: "failed" },
        claims: [],
        steps: { assess: null, review: null },
      });
    const proofs = new Map<string, Map<string, NamedProof>>();
    const stages: Array<StageRecord> = [];
    const stepKeys: Array<string> = [];
    const verifyKeys: Array<string> = [];
    const figures: Array<Record<string, unknown>> = [];
    const calls: Array<Record<string, unknown>> = [];
    const reviewComments = new Map<string, LaneReviewJudgement>();
    // Per section, the stored computations of the readings and claim checks that read it: when the
    // last of them ended is when its batch's readings ended (`reading.batch`'s `settledAt`).
    const endedBy = new Map<string, Set<string>>();
    // The stored computations a reading's records say were reused from an earlier run.
    const reusedKeys = new Set<string>();
    // Each Assess and Lane review step's stored output by key, with the review that produced it
    // (`ReadingProducer`): one another review stored is carried here.
    const producers = new Map<string, ReadingProducer | undefined>();
    const endedOn = (section: string, keys: ReadonlyArray<string>) => {
      const held = endedBy.get(section) ?? new Set<string>();
      for (const key of keys) held.add(key);
      endedBy.set(section, held);
    };

    // The relation evidence each reading was shown (`readings/evidence.ts`), from its stored
    // decision, each read once. A section's gap goes only where both readings of its group name one
    // decision and it shows the section whole: with any doubt the gap stays.
    const evidenceRead = new Map<string, GroupEvidence | undefined>();
    const evidenceAt = async (key: string | undefined) => {
      if (key === undefined) return undefined;
      if (!evidenceRead.has(key))
        evidenceRead.set(key, await read(key, GroupEvidence));
      return evidenceRead.get(key);
    };
    const resultOf = (name: string) => {
      const outcome = ended.get(name) as
        TaskOutcome<ReadingTaskResult> | undefined;
      return outcome?.status === "completed" || outcome?.status === "aborted"
        ? outcome.result
        : undefined;
    };
    /** What each reading (by name) was shown. */
    const shownTo = new Map<string, GroupEvidence | undefined>();
    /** Per read section: its state and the caller and test rows its group was shown for it. */
    const relationsOf = new Map<
      string,
      {
        readonly relations: RelationsShown;
        readonly callers: number;
        readonly tests: number;
        readonly unconfirmedCallers: number;
        readonly unconfirmedTests: number;
        /** Its blast radius as the group's decision recorded it (`SectionReach`); null when none. */
        readonly reach: Omit<SectionReach, "key"> | null;
      }
    >();
    /** The sections shown whole: none while the hold stands (below), so no gap is lifted. */
    const shownWhole = new Set<string>();
    /**
     * Each read section whose relations gap has other words than today's (`relationsGapCause`):
     * its group's readings waited on the head gate, which ended before the head's relations were
     * stored. Every other section's gap reads as before.
     */
    const relationsGaps = new Map<string, RelationsGapCause>();
    /** Each group's decision by how its head gate had ended; `none` where it waited on none. */
    const gates: Record<HeadGateStatus | "none", number> = {
      ...(Object.fromEntries(
        HeadGateStatus.options.map((status) => [status, 0]),
      ) as Record<HeadGateStatus, number>),
      none: 0,
    };
    /** Each group's decision by how it was made; `none` where no decision could be read. */
    const outcomes: Record<EvidenceOutcome | "none", number> = {
      read: 0,
      "not-stored": 0,
      failed: 0,
      "over-bound": 0,
      none: 0,
    };
    /**
     * The rows of every group's decision (each decision once; groups with none are not counted): its
     * caller rows by what their line shows, and its test rows. Closed labels and counts only.
     */
    const shownRows = { call: 0, reference: 0, caller: 0, tests: 0 };
    /** Each group's decision, for the same-batch references by code (round 27b). */
    const groupEvidence: Array<GroupEvidence> = [];
    for (const group of plan.groups) {
      const keys = {
        assess: resultOf(readingName("assess", group.id))?.evidence,
        review: resultOf(readingName("lane-review", group.id))?.evidence,
      };
      shownTo.set(
        readingName("assess", group.id),
        await evidenceAt(keys.assess),
      );
      shownTo.set(
        readingName("lane-review", group.id),
        await evidenceAt(keys.review),
      );
      const agreed = keys.assess !== undefined && keys.assess === keys.review;
      const evidence = await evidenceAt(keys.assess ?? keys.review);
      outcomes[
        evidence !== undefined && evidence.group === group.id
          ? evidence.outcome
          : "none"
      ]++;
      if (evidence !== undefined && evidence.group === group.id)
        for (const section of evidence.sections)
          for (const row of section.rows)
            shownRows[row.kind === "test" ? "tests" : row.shows]++;
      const decision = evidence?.group === group.id ? evidence : undefined;
      if (decision !== undefined) groupEvidence.push(decision);
      gates[decision?.gate?.status ?? "none"]++;
      for (const key of group.keys) {
        const entry = sectionEvidence(
          evidence?.group === group.id ? evidence : undefined,
          key,
        );
        // What the lift would show whole: one decision for both readings, at least one caller row,
        // and every caller row lifting (`rowLifts`). Test rows are not read.
        const callerRows = entry.rows.filter((row) => row.kind === "caller");
        const lifts =
          entry.relations === "shown" &&
          agreed &&
          callerRows.length > 0 &&
          callerRows.every(rowLifts);
        // The hold (NEU-148 round 22): such a section is recorded as `partial`, as before the lift,
        // so code's relations gap stays and the lift never lowers a lane; its gap says the callers
        // were read (`held`). The readings still see the caller rows: the evidence and the reading's
        // text are as they were. Gates' decisive check on `78a3d147` decided it (the table
        // `gates/runs/hold-score-decisive-78a3.json`): as built, plant 203 was lowered to an agent's
        // approval and lost; held, none was lowered and none lost. The lowering returns with the
        // readings-quality work, with plant 203 and plants 112, 116, 117 and 133 as its cases. No
        // switch and no setting.
        const relations =
          entry.relations === "shown" ? "partial" : entry.relations;
        // The words its gap says: the state the lift would show (held), else the state recorded.
        const own = sectionByKey.get(key)?.hunkIds.flatMap((id) => {
          const hunk = hunks.get(id);
          return hunk === undefined ? [] : [hunk];
        });
        const cause = relationsGapCause(decision, lifts ? "shown" : relations, {
          gitlink: own !== undefined && isGitlink(own),
        });
        if (cause !== "unavailable") relationsGaps.set(key, cause);
        relationsOf.set(key, {
          relations,
          callers: entry.rows.filter(
            (row) => row.kind === "caller" && row.confirmed,
          ).length,
          tests: entry.rows.filter(
            (row) => row.kind === "test" && row.confirmed,
          ).length,
          unconfirmedCallers: entry.rows.filter(
            (row) => row.kind === "caller" && !row.confirmed,
          ).length,
          unconfirmedTests: entry.rows.filter(
            (row) => row.kind === "test" && !row.confirmed,
          ).length,
          reach: reachCounts(decision?.reach?.find((r) => r.key === key)),
        });
      }
    }
    /**
     * The caller and test rows in a call's reading, confirmed or not: its sections' rows in what its
     * reading was shown.
     */
    const evidenceRows = (
      name: string,
      sections: ReadonlyArray<string>,
      confirmed: boolean,
    ) =>
      sections.reduce(
        (sum, key) =>
          sum +
          sectionEvidence(shownTo.get(name), key).rows.filter(
            (row) => row.confirmed === confirmed,
          ).length,
        0,
      );

    for (const group of plan.groups)
      for (const kind of ["assess", "lane-review"] as const) {
        const name = readingName(kind, group.id);
        const outcome = ended.get(name) as
          TaskOutcome<ReadingTaskResult> | undefined;
        const result =
          outcome?.status === "completed" || outcome?.status === "aborted"
            ? outcome.result
            : undefined;
        // The step a judgement came from is what its comments' line cites name.
        const set = (
          key: string,
          value: ReadingOutcome<never>,
          step: string | null = null,
        ) => {
          const held = collected.get(key);
          if (held === undefined) return;
          collected.set(
            key,
            kind === "assess"
              ? {
                  ...held,
                  assess: value,
                  steps: { ...held.steps, assess: step },
                }
              : {
                  ...held,
                  review: value,
                  steps: { ...held.steps, review: step },
                },
          );
        };
        // A failed, faulted, orphaned or missing reading leaves its group failed; one stopped
        // before it returned anything leaves it not reached.
        // A plan cut at its cut-off made no reading: its sections are not reached, never failed.
        const whole: SectionCause =
          outcome?.status === "aborted" || dropped === "not-reached"
            ? "not-reached"
            : "failed";
        for (const key of group.keys) set(key, { judged: false, cause: whole });
        figures.push({
          name,
          kind,
          group: group.id,
          outcome: outcome?.status ?? "missing",
          steps: result?.steps.length ?? 0,
          claims: result?.claims.length ?? 0,
          notJudged: result?.notJudged.length ?? group.keys.length,
        });
        if (result === undefined) {
          // Stopped before it returned anything: the cut-off (or the run's stop) came first, which a
          // skipped record says, as a stage the cut-off kept from starting does. A failed, faulted,
          // orphaned or missing reading adds no record: it did not run out of time, and the
          // disclosure says it was not judged.
          if (outcome?.status === "aborted") {
            stages.push({
              stage: "verify",
              agent: name,
              status: "skipped",
              wallMs: 0,
              note:
                outcome.reason === "cutoff"
                  ? "The reading did not finish before the review's cut-off."
                  : "The reading did not finish: the review was stopped first.",
              disclosure: null,
            });
            calls.push({
              type: "reading.call",
              kind,
              group: group.id,
              part: "read",
              sections: null,
              rank: group.rank,
              characters: null,
              source: null,
              run: "not-started",
              key: null,
              ...NO_FIGURES,
              evidenceRows: null,
              unconfirmedRows: null,
              ...effortOf(kind, group.id),
            });
          }
          continue;
        }
        stepKeys.push(...result.steps);
        for (const key of group.keys) endedOn(key, result.steps);
        for (const key of result.steps) {
          if (kind === "assess") {
            const stored = await read(key, AssessStored);
            if (stored === undefined) continue;
            producers.set(key, stored.by);
            for (const proof of stored.listed.proofs)
              for (const [path, currency] of Object.entries(proof.currency)) {
                const byId = proofs.get(path) ?? new Map();
                byId.set(proof.id, { kind: proof.kind, currency });
                proofs.set(path, byId);
              }
            for (const { key: section, outcome: judged } of assessOutcomes(
              stored,
              plan,
            ))
              if (judged.judged) set(section, judged as never, key);
          } else {
            const stored = await read(key, LaneReviewStored);
            if (stored === undefined) continue;
            producers.set(key, stored.by);
            for (const { key: section, outcome: judged } of laneReviewOutcomes(
              stored,
              plan,
            ))
              if (judged.judged) {
                set(section, judged as never, key);
                reviewComments.set(section, judged.judgement);
              }
          }
        }
        for (const entry of result.notJudged)
          set(entry.section, { judged: false, cause: entry.cause });
        // Each claim is checked once, however many sections it sits on (one check per claim key,
        // record 0016). Its outcome goes to every section of the group whose final Lane review
        // judgement holds a defect comment with that key: read from the judgement each section
        // ends with, so a resumed run, and a re-read that drops or adds the comment, leave each
        // section exactly the claims its judgement holds.
        const checked = new Map<
          string,
          {
            readonly verify: Claim["verify"];
            readonly verifyKey: string | null;
          }
        >();
        for (const claim of result.claims) {
          if (claim.verifyKey !== null) verifyKeys.push(claim.verifyKey);
          if (checked.has(claim.key)) continue;
          const stored =
            claim.verifyKey === null
              ? undefined
              : await read(claim.verifyKey, ClaimStored);
          checked.set(claim.key, {
            // A check the cut-off kept from running is not reached, never unconfirmed.
            verify:
              claim.reached === false
                ? "not-reached"
                : claimVerdict(
                    stored !== undefined && stored.claim === claim.key
                      ? stored
                      : undefined,
                  ),
            verifyKey: claim.verifyKey,
          });
        }
        for (const section of group.keys) {
          const held = collected.get(section);
          if (held === undefined || !held.review.judged) continue;
          for (const comment of held.review.judgement.comments) {
            if (comment.kind !== "defect") continue;
            const id = claimKey(comment);
            const check = checked.get(id);
            if (check === undefined || held.claims.some((c) => c.id === id))
              continue;
            if (check.verifyKey !== null) endedOn(section, [check.verifyKey]);
            held.claims.push({
              id,
              source: "lane-review",
              verify: check.verify,
            });
          }
        }
        // The calls this reading made, and every record, with no gap of their own: the one
        // disclosure below says what was not judged.
        for (const record of result.stages) {
          if (record.status === "reused" && record.key !== undefined)
            reusedKeys.add(record.key);
          stages.push(
            record.status === "interrupted" || record.status === "skipped"
              ? { ...record, disclosure: null }
              : record,
          );
          const agent = record.agent ?? "";
          const part =
            agent.startsWith("verify.claim.") || agent.endsWith(".claims")
              ? "claim"
              : agent.endsWith(".reread")
                ? "reread"
                : "read";
          const stored =
            record.key === undefined ||
            (record.status !== "computed" && record.status !== "reused")
              ? undefined
              : part === "claim"
                ? await read(record.key, ClaimStored)
                : kind === "assess"
                  ? await read(record.key, AssessStored)
                  : await read(record.key, LaneReviewStored);
          calls.push({
            type: "reading.call",
            kind: part === "claim" ? "verify-claim" : kind,
            group: group.id,
            part,
            sections:
              stored === undefined
                ? null
                : "sections" in stored
                  ? stored.sections.length
                  : 1,
            rank: group.rank,
            characters:
              stored === undefined
                ? null
                : "characters" in stored
                  ? stored.characters
                  : JSON.stringify({
                      decision: stored.decision,
                      reason: stored.reason,
                    }).length,
            source: stored?.source ?? null,
            run: runOf(record.status),
            key: record.key ?? null,
            // The call's numbers for the probe: tokens read, as three parts that together are all
            // the call's input (`CallUsage`: ordinary input, which leaves out both cache reads and
            // cache writes; input read from the cache; input written to it, the five-minute and
            // one-hour writes together), tokens written (reasoning, where the route reports it,
            // is part of them), and how the answer fell into classes. Numbers only.
            inputTokens: record.agentResult?.usage.input ?? null,
            cachedInputTokens: record.agentResult?.usage.cacheRead ?? null,
            cacheWriteTokens:
              record.agentResult === undefined
                ? null
                : record.agentResult.usage.cacheWrite5m +
                  record.agentResult.usage.cacheWrite1h,
            outputTokens: record.agentResult?.usage.output ?? null,
            reasoningTokens: record.agentResult?.usage.thinking ?? null,
            classes:
              stored !== undefined && "classes" in stored
                ? stored.classes
                : null,
            outside:
              stored !== undefined && "outside" in stored
                ? stored.outside
                : null,
            // Why answers were sent back: counts per class of problem only, never a cite or text.
            problems:
              stored !== undefined && "problems" in stored
                ? stored.problems
                : null,
            // The caller and test rows its reading showed, a count; null when it stored nothing.
            // Confirmed and unconfirmed apart.
            evidenceRows:
              stored === undefined
                ? null
                : evidenceRows(
                    name,
                    "sections" in stored ? stored.sections : [stored.section],
                    true,
                  ),
            unconfirmedRows:
              stored === undefined
                ? null
                : evidenceRows(
                    name,
                    "sections" in stored ? stored.sections : [stored.section],
                    false,
                  ),
            ...effortOf(part === "claim" ? "verify-claim" : kind, group.id),
            ...scopeAndTestsFields(config, kind, part, stored, plan),
          });
        }
        // A step that ended failed has no record; its row says what kind of failure it was, as a
        // label code can count, never the failure's message.
        for (const failed of result.failures ?? [])
          calls.push({
            type: "reading.call",
            kind,
            group: group.id,
            part: failed.part,
            sections: null,
            rank: group.rank,
            characters: null,
            source: null,
            run: "failed",
            key: null,
            ...NO_FIGURES,
            problems: null,
            failure: failed.failure,
            evidenceRows: null,
            unconfirmedRows: null,
            ...effortOf(kind, group.id),
          });
      }

    // The briefings (round 27): each read section's Briefed and Explained and each batch's digest,
    // from the stored parts and digests. Where a group's briefing never stored its call, its
    // sections and the digest it owns read as cut (the task was stopped at the cut-off) or failed
    // (anything else), and code's text stands. A review that made no briefing task has none.
    const briefingKeys: Array<string> = [];
    const briefingRows: Array<Record<string, unknown>> = [];
    let briefings: SettledBriefings | undefined;
    if (input.readings.some((r) => r.name.startsWith("brief."))) {
      const out = await settledBriefingsOf({
        plan,
        groups: map.groups,
        ended,
        read: (key) => read(key, BriefingStored),
      });
      briefings = out.briefings;
      briefingKeys.push(...out.keys);
      briefingRows.push(...out.rows);
      stages.push(...out.stages);
    }

    const incoming = new Map<string, Array<CrossBatchReport>>();
    for (const report of input.incoming ?? []) {
      if (report.verifyKey === null) continue;
      const verdict = await read(report.verifyKey, ClaimStored);
      if (
        verdict?.claim !== report.key ||
        claimVerdict(verdict) !== "confirmed"
      )
        continue;
      const reports = incoming.get(report.target.section) ?? [];
      reports.push(report);
      incoming.set(report.target.section, reports);
    }

    const proofIds = new Set<string>();
    for (const byId of proofs.values())
      for (const id of byId.keys()) proofIds.add(id);

    const groups = map.groups.map((group) => ({
      id: group.id,
      label: group.label,
      why: group.why,
      files: group.files.map((file) => ({ path: file.path })),
      hunkIds: group.hunkIds,
      doneWhen: [...group.doneWhen],
    }));
    const carried = await carriedOf(collected, producers, signal);
    const decidedAll = decideSections({
      plan,
      hunks,
      groups,
      incoming,
      collected,
      proofs,
      carried: carried.from,
      // The Map's list and the plan's are made by the same code (`buildMapManifest`) from the same
      // manifest, so they agree; a Map stored by another build of that rule could still differ, and
      // `decideSections` keeps that case undecided and a run gap.
      excluded: map.excluded.map(({ path, reason }) => ({ path, reason })),
      relations: shownWhole,
      relationsGaps,
      // Only `settle`'s ending call on the last allowed run; `collect` never gives it.
      ...(input.last === true ? { capReached: true } : {}),
    });
    const entries = decidedAll.sections;
    const settled = settledBatches({
      planKey,
      manifestKey: input.manifestKey,
      hunks,
      groups,
      frame,
      sections: entries,
      incoming,
      collected,
      proofs: proofIds,
      ...(dropped === false ? {} : { dropped: true }),
      ...(briefings === undefined ? {} : { briefings }),
      // The same-batch references (round 27b): the groups' confirmed caller rows, at the head.
      head: manifest.range.headOid,
      base: manifest.range.mergeBase,
      evidence: groupEvidence,
    });
    const units = settled.formed;
    // Each section's Lane review comments by fate, as ranked on its unit.
    const commentFates = new Map<
      string,
      Record<RankedComment["fate"], number>
    >();
    for (const batch of units)
      for (const order of batch.comments)
        for (const comment of order) {
          const key = comment.section;
          if (comment.source !== "lane-review" || key === null) continue;
          const held = commentFates.get(key) ?? {
            shown: 0,
            "below-cut": 0,
            refuted: 0,
          };
          held[comment.fate]++;
          commentFates.set(key, held);
        }

    return {
      briefingKeys,
      briefingRows,
      calls,
      carried,
      collected,
      commentFates,
      decidedAll,
      endedBy,
      entries,
      figures,
      gates,
      outcomes,
      relationsOf,
      reusedKeys,
      reviewComments,
      riskOf,
      settled,
      shownRows,
      stages,
      stepKeys,
      units,
      verifyKeys,
    };
  };

  const collected = async (
    input: CollectInput,
    reader: DocumentReader,
    context: Context,
    signal: AbortSignal,
  ): Promise<Awaited<ReturnType<Port["collect"]>>> => {
    // A dropped plan is decided as any other, every read section by its missing readings; its one
    // gap is the run's, on every packet (`batches`), so it adds no disclosure of its own here.
    const { plan, planKey, dropped } = await planOf(
      reader,
      context,
      input.manifestKey,
      signal,
      input.planCut,
    );
    const {
      briefingKeys,
      briefingRows,
      calls,
      carried,
      collected,
      commentFates,
      decidedAll,
      endedBy,
      entries,
      figures,
      gates,
      outcomes,
      relationsOf,
      reusedKeys,
      reviewComments,
      riskOf,
      settled,
      shownRows,
      stages,
      stepKeys,
      units,
      verifyKeys,
    } = await judge(input, plan, planKey, signal, dropped);
    // The whole result, stored: the settled batches are what the publisher is to be handed; nothing
    // publishes them in this build. Comment bodies are model text, so the stored decision is read
    // only as a step's stored answer is, never written to a row.
    const decision = asStored({
      plan: planKey,
      sections: entries.map((entry) => ({
        key: entry.section.key,
        path: entry.section.path,
        group: entry.group,
        mapGroup: entry.mapGroup,
        unread: entry.cause !== null ? entry.cause : null,
        decision: entry.decision,
        claims: entry.claims,
      })),
      units: units.map((batch) => ({
        mapGroup: batch.mapGroup,
        units: batch.units,
        comments: batch.comments,
      })),
      readings: figures,
      settled: settled.batches,
      batches: settled.records,
      totals: settled.totals,
      gaps: settled.gaps,
    });
    const steps = [...new Set(stepKeys)].sort();
    const verifies = [...new Set(verifyKeys)].sort();
    const stored = await run(
      withRecords(
        ctx,
        Effect.gen(function* () {
          const store = yield* Computations.ComputationStore;
          return yield* store.run(
            {
              op: DECISION_OP,
              // 2: the publisher's batches, their records, and the run's gaps.
              // 3: each unit's Guided stop from the Frame's done-when rows, and each section's Briefed.
              // 4: the briefing's Briefed, Explained and digest (round 27), from the stored calls
              // named in `briefings`, and a note on every undecided section.
              opVersion: 4,
              inputs: {
                plan: `computation:${planKey}`,
                frame: `computation:${input.frameKey}`,
                steps: steps.map((key) => `computation:${key}`),
                verifies: verifies.map((key) => `computation:${key}`),
                briefings: [...new Set(briefingKeys)]
                  .sort()
                  .map((key) => `computation:${key}`),
                // The outcomes it was decided from include ends no key holds (a failed or stopped
                // reading), so the decision is keyed by its own content too.
                output: sha256Hex(
                  canonicalJson(JSON.parse(JSON.stringify(decision))),
                ),
              },
            },
            Effect.succeed({
              bytes: new TextEncoder().encode(JSON.stringify(decision)),
              mediaType: "application/json",
            }),
          );
        }),
      ),
      signal,
    );

    // Run-log rows: keys, counts, anchors and code's own words; never a comment, a requirement or
    // a reason. They are keyed by the decision: a replayed Link phase that decides the same writes
    // none again (the `readings.decision` row, written last, marks a decision whose rows exist).
    const decisionKey = stored.computation.key;
    const written = ctx.log
      .read()
      .some(
        (row) => row.type === "readings.decision" && row["key"] === decisionKey,
      );
    const notJudged: Array<SectionCause> = [];
    const rows: Array<RunLogRecord> = [...calls, ...briefingRows].map(
      (call) => ({
        ...(call as { type: string }),
        decision: decisionKey,
      }),
    );
    for (const entry of entries) {
      const decided = entry.decision;
      const outcomes = collected.get(entry.section.key);
      if (entry.cause === "too-large" || entry.cause === "unreadable")
        notJudged.push(entry.cause);
      else if (outcomes !== undefined) {
        const cause = !outcomes.assess.judged
          ? outcomes.assess.cause
          : !outcomes.review.judged
            ? outcomes.review.cause
            : undefined;
        if (cause !== undefined) notJudged.push(cause);
      }
      const fates = (verify: Claim["verify"]) =>
        entry.claims.filter((claim) => claim.verify === verify).length;
      const fate = commentFates.get(entry.section.key);
      const judgement = reviewComments.get(entry.section.key);
      const comments = judgement?.comments.length ?? 0;
      const restsOn = new Set(decided?.settled === true ? decided.restsOn : []);
      // Each defect claim by its anchor and outcome only.
      const claims = (judgement?.comments ?? [])
        .filter((comment) => comment.kind === "defect")
        .map((comment) => ({ comment, key: claimKey(comment) }))
        .filter(
          ({ key }, at, all) => all.findIndex((c) => c.key === key) === at,
        )
        .map(({ comment, key }) => ({
          key,
          path: comment.path,
          side: comment.side,
          startLine: comment.startLine,
          endLine: comment.endLine,
          source: "lane-review" as const,
          verify: (entry.claims.find((claim) => claim.id === key)?.verify ??
            "unconfirmed") as Claim["verify"],
          restsOn: restsOn.has(key),
        }));
      rows.push({
        type: "reading.section",
        decision: decisionKey,
        section: entry.section.key,
        path: entry.section.path,
        owned: lines(entry.section),
        group: entry.group,
        // The facts the effort rule reads, as booleans, whatever the run's effort.
        ...riskOf(entry.section),
        // What its group was shown of its callers and tests: a closed label and counts only (no
        // path, symbol or source text). `shown` is the one state that leaves no relations gap.
        relations: relationsOf.get(entry.section.key)?.relations ?? "not-read",
        relationRows: {
          callers: relationsOf.get(entry.section.key)?.callers ?? 0,
          tests: relationsOf.get(entry.section.key)?.tests ?? 0,
          unconfirmedCallers:
            relationsOf.get(entry.section.key)?.unconfirmedCallers ?? 0,
          unconfirmedTests:
            relationsOf.get(entry.section.key)?.unconfirmedTests ?? 0,
        },
        // Its blast radius's parts, counts only, as its group's decision recorded them from the
        // head's relations slice (`SectionReach`, each part's source field named there); null where
        // none was recorded (the head not read, a decision stored before it). The lane reads none.
        reach: relationsOf.get(entry.section.key)?.reach ?? null,
        state:
          entry.cause !== null && decided === null
            ? "unread"
            : decided?.settled === true
              ? "settled"
              : "waiting",
        lane:
          decided?.settled === true
            ? {
                judged: decided.entry.lane.judged,
                surfaced: decided.entry.lane.surfaced,
                floors: decided.entry.lane.floors.map(({ rule, to }) => ({
                  rule,
                  to,
                })),
                applied: decided.entry.lane.applied,
              }
            : null,
        // The entry as the lane rule reads it, so the trail above can be computed again from the
        // row (`laneEntryOf`): numbers, identifiers and closed labels only. Null when not settled.
        entry: decided?.settled === true ? laneEntryOf(decided.entry) : null,
        // A lockfile or declared-generated file: the map's reason, as the plan excluded it.
        excluded:
          decided?.settled === true && decided.entry.excluded !== undefined
            ? { reason: decided.entry.excluded.reason }
            : null,
        // What the floor rule read (code facts and which floors are on), so it can be run again.
        floorInputs:
          decided?.settled === true
            ? {
                facts: {
                  removesDeclaration:
                    decided.entry.floorInputs.facts.removesDeclaration,
                  removesPublicName:
                    decided.entry.floorInputs.facts.removesPublicName,
                  effects: [...decided.entry.floorInputs.facts.effects],
                },
                options: { ...decided.entry.floorInputs.options },
              }
            : null,
        verdict: decided?.verdict ?? null,
        cause:
          decided === null
            ? entry.cause
            : decided.settled
              ? (decided.entry.undecided?.cause ??
                (decided.entry.excluded !== undefined ? "excluded" : null))
              : decided.waiting.cause,
        reading:
          decided === null
            ? null
            : decided.settled
              ? (decided.entry.undecided?.reading ?? null)
              : decided.waiting.reading,
        comments: {
          shown: fate?.shown ?? 0,
          belowCut: fate?.["below-cut"] ?? 0,
          refuted: fate?.refuted ?? 0,
          unranked:
            comments -
            (fate === undefined
              ? 0
              : fate.shown + fate["below-cut"] + fate.refuted),
        },
        claims,
        claimFates: {
          confirmed: fates("confirmed"),
          refuted: fates("refuted"),
          unconfirmed: fates("unconfirmed"),
        },
      });
    }
    // When each reading and claim check ended: the time its stored computation was completed.
    const completed = await run(
      withRecords(
        ctx,
        Effect.gen(function* () {
          const store = yield* Computations.ComputationStore;
          return yield* store.lookupMany([
            ...new Set([...endedBy.values()].flatMap((keys) => [...keys])),
          ]);
        }),
      ),
      signal,
    ).catch((error: unknown): ReadonlyMap<string, { completedAt: string }> => {
      // A store that cannot say leaves the times unknown; the decision itself stands.
      if (signal.aborted) throw error;
      return new Map();
    });
    /**
     * When a settled batch's last reading or claim check ended: the latest completion time among the
     * stored computations of the readings and checks that read its sections. Null for a batch that
     * is not settled, and for one none of whose readings stored anything (every one failed, or its
     * sections are excluded files no reading reads). A computation reused from an earlier run keeps
     * the time it was first completed; `reused` says how many of its steps were.
     */
    const settledAtOf = (mapGroup: string | null) => {
      let latest: string | null = null;
      for (const entry of entries)
        if (entry.mapGroup === mapGroup)
          for (const key of endedBy.get(entry.section.key) ?? []) {
            const at = completed.get(key)?.completedAt;
            if (at !== undefined && (latest === null || at > latest))
              latest = at;
          }
      return latest;
    };
    /**
     * How many of a batch's reading and claim-check steps were reused from an earlier run, so a
     * scorer can tell when `settledAt` is not this run's: 0 when none.
     */
    const reusedOf = (mapGroup: string | null) => {
      const keys = new Set<string>();
      for (const entry of entries)
        if (entry.mapGroup === mapGroup)
          for (const key of endedBy.get(entry.section.key) ?? [])
            if (reusedKeys.has(key)) keys.add(key);
      return keys.size;
    };
    // One row per batch (Map group): settled or not, its sections by state, its units, whether it
    // is ready for the publisher (every check passed), with the count of checks that failed, and
    // when its last reading or claim check ended, with how many of those steps were reused.
    for (const batch of settled.records)
      rows.push({
        type: "reading.batch",
        decision: decisionKey,
        mapGroup: batch.mapGroup,
        settled: batch.settled,
        ready: batch.ready,
        reason: batch.reason,
        sections: batch.sections,
        units: batch.units,
        problems: batch.problems.length,
        settledAt: batch.settled ? settledAtOf(batch.mapGroup) : null,
        reused: reusedOf(batch.mapGroup),
        // Its briefing in counts and labels (round 27): how it ended, its sections by how their
        // briefing ended, and who wrote its digest; null for a batch that is not settled.
        briefing: batch.briefing ?? null,
      });
    // One row per unit `composeUnits` formed.
    for (const group of units)
      for (const [at, unit] of group.units.entries()) {
        const order = group.comments[at] ?? [];
        rows.push({
          type: "reading.unit",
          decision: decisionKey,
          mapGroup: group.mapGroup,
          path: unit.path,
          lane: unit.lane,
          sections: [...unit.sectionKeys],
          verdict: unit.verdict,
          disposition: unit.disposition ?? null,
          suggestion: unit.suggestion,
          undecided: { ...unit.undecided },
          comments: {
            shown: order.filter((c) => c.fate === "shown").length,
            belowCut: order.filter((c) => c.fate === "below-cut").length,
          },
          // The Guided stop in counts and labels: its basis, its rows by status, and whether it
          // holds the agent's review, a suggested review and unsure notes. Never their words.
          guided: group.guided[at] ?? null,
        });
      }
    // The run's judgement ledger (`judgementCounts`, `judgement.counted@1`): one row per section a
    // reading judged, carried or fresh as its entry records it. The ledger sums the rows' saved
    // time, and one carried reading serves every section of its group, so each carried computation
    // (Assess and Lane review alike) gives its time once, on the first row that carries it, and 0 on
    // the rest.
    const timed = new Set<string>();
    for (const entry of entries) {
      const decided = entry.decision;
      if (decided?.settled !== true) continue;
      if (decided.entry.assess === null && decided.entry.review === null)
        continue;
      let savedMs = 0;
      if (decided.entry.lineage === "carried")
        for (const reading of carried.readings.get(entry.section.key) ?? [])
          if (!timed.has(reading.key)) {
            timed.add(reading.key);
            savedMs += reading.savedMs;
          }
      rows.push({
        type: "judgement",
        decision: decisionKey,
        unit: entry.section.key,
        source: decided.entry.lineage,
        savedMs,
      });
    }
    rows.push({
      type: "readings.decision",
      key: decisionKey,
      plan: planKey,
      sections: entries.length,
      settled: entries.filter((entry) => entry.decision?.settled === true)
        .length,
      units: units.reduce((sum, group) => sum + group.units.length, 0),
      batches: {
        total: settled.totals.batches,
        ready: settled.batches.length,
      },
      // Every reading group by how its evidence was decided, and every planned section by what its
      // group was shown of its callers and tests: closed labels and counts.
      evidence: outcomes,
      // Every reading group by how the head gate its readings waited on had ended (`none`: none),
      // when any waited on one; a review with no gate writes the row as before.
      ...(HeadGateStatus.options.some((status) => gates[status] > 0)
        ? { gates }
        : {}),
      relationRowKinds: shownRows,
      relations: Object.fromEntries(
        RELATIONS_STATES.map((state) => [
          state,
          entries.filter(
            (entry) =>
              (relationsOf.get(entry.section.key)?.relations ?? "not-read") ===
              state,
          ).length,
        ]),
      ),
    });
    if (!written) for (const row of rows) ctx.log.write(row);
    return {
      stages,
      // A dropped plan's one gap is the run's when it publishes per batch (`batches`; Link leaves
      // this out then); in the old packet, which no batch reached, it says no reading ran.
      disclosures:
        dropped !== false
          ? plan.sections.length + plan.unread.length === 0
            ? []
            : [NO_READINGS]
          : readingsDisclosure(
              plan.sections.length +
                plan.unread.filter(
                  (s) => s.cause === "too-large" || s.cause === "unreadable",
                ).length,
              notJudged,
              entries.flatMap((entry): Array<WaitingCause> =>
                entry.decision === null || entry.decision.settled
                  ? []
                  : [
                      entry.decision.waiting.cause === "refused"
                        ? "refused"
                        : entry.decision.waiting.reading === "verify"
                          ? "check-not-reached"
                          : "reading-not-reached",
                    ],
              ),
            ),
    };
  };

  /**
   * The plan the readings' run document names; when it names none, the readings' plan was dropped
   * (its `prepare` stored no plan, or the plan task ended with no readings: failed, cut off or
   * stopped), and the plan that stands in for it (`storeDroppedPlan`), from the manifest alone, the
   * same on every call, `dropped`. Only a review with the readings on calls the port, so "off" never
   * reaches here; a plan with no section is nothing to read.
   */
  const planOf = async (
    reader: DocumentReader,
    context: Context,
    manifestKey: string,
    signal: AbortSignal,
    planCut: boolean | undefined,
  ) => {
    const doc = await reader.snapshot(ReadingsRunDoc, context);
    if (doc !== undefined && doc.plan !== null)
      return {
        planKey: doc.plan,
        plan: await readPlan(ctx, run, doc.plan, signal),
        dropped: false as const,
      };
    const manifest = await readManifest(ctx, run, manifestKey, signal);
    const planKey = await run(
      storeDroppedPlan(ctx, { manifestKey, bounds: config.bounds, manifest }),
      signal,
    );
    return {
      planKey,
      plan: await readPlan(ctx, run, planKey, signal),
      // By how the plan task ended, never by the document's absence (a `prepare` that threw, or a
      // failed `create`, leaves none too): cut at its cut-off, its sections are not reached;
      // otherwise the plan failed.
      dropped: (planCut === true ? "not-reached" : "failed") as PlanDrop,
    };
  };

  /**
   * The review's batches, in its batch order, with the reading tasks each waits on, the review's
   * totals and the run's gaps. Decided from the plan, the manifest and the Map alone (no reading's
   * outcome and no finding changes which batches there are, their files or the totals), so every
   * call of a run gives the same value. Writes no row. With the plan dropped, the batches are the
   * stand-in plan's (`planOf`), none waits on a reading, and the run's first gap says how the plan
   * failed (`DROPPED_PLAN_GAP`); a dropped plan with no section is nothing to read, with no gap.
   */
  const batches: ReadingsPort["batches"] = async (
    input,
    reader,
    context,
    signal,
  ) => {
    const { plan, planKey, dropped } = await planOf(
      reader,
      context,
      input.manifestKey,
      signal,
      input.planCut,
    );
    const manifest = await readManifest(ctx, run, input.manifestKey, signal);
    const map = await run(storedOutput(ctx, input.mapKey, ReviewMap), signal);
    const hunks = new Map(manifest.hunks.map((hunk) => [hunk.hunkId, hunk]));
    const groups = map.groups.map((group) => ({
      id: group.id,
      label: group.label,
      why: group.why,
      files: group.files.map((file) => ({ path: file.path })),
      hunkIds: group.hunkIds,
      doneWhen: [...group.doneWhen],
    }));
    const collectedNone = new Map<string, CollectedSection>();
    const decided = decideSections({
      plan,
      hunks,
      groups,
      collected: collectedNone,
      proofs: new Map(),
      excluded: map.excluded.map(({ path, reason }) => ({ path, reason })),
    });
    const created = new Set(input.readings.map((reading) => reading.name));
    const list = reviewBatches({
      plan,
      hunks,
      groups,
      sections: decided.sections,
    });
    const settled = settledBatches({
      planKey,
      manifestKey: input.manifestKey,
      hunks,
      groups,
      // Only the totals and the run's gaps are read from this value, and neither reads the Frame.
      frame: { stratum: "", doneWhen: [] },
      sections: decided.sections,
      collected: collectedNone,
      proofs: new Set(),
    });
    const nothingToRead = plan.sections.length + plan.unread.length === 0;
    return {
      // A reading the plan listed but no task was made for is waited on by no one: `settle` then
      // finds it failed, as `collect` does.
      batches: list.map((batch) => ({
        key: batch.key,
        readings: batch.readings.filter((name) => created.has(name)),
      })),
      totals: settled.totals,
      gaps:
        dropped !== false && !nothingToRead
          ? [droppedPlanGap(dropped, false), ...settled.gaps]
          : settled.gaps,
    };
  };

  /**
   * One batch as the publisher takes it, or not settled with a gap, decided by the same code as
   * `collect` (`judge`) from the batch's readings and incoming checks. A reading given with no
   * outcome has not ended: the batch is not reached, never decided. Stores nothing, writes no row and
   * calls no model, so a replay gives the same value. Never throws for a reading's failure: anything
   * that cannot be read leaves the batch not settled (`refused`), and only an aborted signal throws.
   */
  const settle: ReadingsPort["settle"] = async (
    input,
    reader,
    context,
    signal,
  ) => {
    try {
      const { plan, planKey, dropped } = await planOf(
        reader,
        context,
        input.manifestKey,
        signal,
        input.planCut,
      );
      const judged = await judge(input, plan, planKey, signal, dropped);
      const manifest = await readManifest(ctx, run, input.manifestKey, signal);
      const map = await run(storedOutput(ctx, input.mapKey, ReviewMap), signal);
      return settleBatch({
        key: input.batch,
        batches: reviewBatches({
          plan,
          hunks: new Map(manifest.hunks.map((hunk) => [hunk.hunkId, hunk])),
          groups: map.groups.map((group) => ({
            id: group.id,
            label: group.label,
            why: group.why,
            files: group.files.map((file) => ({ path: file.path })),
            hunkIds: group.hunkIds,
            doneWhen: [...group.doneWhen],
          })),
          sections: judged.entries,
        }),
        ended: input.readings.map((reading) => ({
          name: reading.name,
          ended: reading.outcome !== undefined,
        })),
        settled: judged.settled,
        sections: judged.entries,
        final: input.final,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      return {
        settled: false,
        gap: {
          key: `batch-refused:${batchHandle(input.batch)}`,
          kind: "refused",
          detail:
            "This batch's readings could not be collected, so it was not published.",
        },
      };
    }
  };

  return { prepare, create, collect, batches, settle };
};
