import { copyJson, type Context } from "@earendil-works/chord";
import {
  defineDoc,
  type Task,
  type TaskId,
  type TaskOutcome,
  type TaskRuntime,
} from "@earendil-works/pi-durable";
import {
  Computations,
  Proofs,
  sha256Hex,
  canonicalJson,
} from "@neuve/records-core";
import { SharedWork } from "@neuve/records-core/shared-work";
import { Effect, Option } from "effect";
import { dataBlock } from "../../data-block.ts";
import { blobStructures, structureKeyOf } from "../../blob-structure.ts";
import { cpuWork } from "../../budget/cpu.ts";
import { turnLimitFor } from "../../config.ts";
import { readDeclarations, testStatusOf } from "../../declarations.ts";
import { readingBudget } from "../../find.ts";
import { Frame } from "../../frame.ts";
import { lsTree, readBlobs, type TreeEntry } from "../../git-objects.ts";
import {
  captureOutlineSource,
  type OutlineSource,
} from "../../graph-outline.ts";
import {
  logTimed,
  scopedLogSpan,
  startLogSpan,
  waitSpans,
} from "../../log-span.ts";
import {
  defsTool,
  readManyTool,
  hunkTool,
  scopeSectionTool,
  outlineTool,
  readTool,
  revisionViews,
  usesTool,
} from "../../lookups.ts";
import { RangeManifest } from "../../manifest.ts";
import {
  lookupContext,
  storedOutput,
  withRecords,
  type RangeView,
  type RunContext,
  type StageRecord,
} from "../../pipeline.ts";
import { proofReaders } from "../../proof-tools.ts";
import type { RowBasis } from "../../proof-state.ts";
import {
  isRelationsGap,
  relationCallerPaths,
  relationSlices,
  relationsSpec,
  storedRelations,
  type RelationSlice,
  type RelationsGap,
  type SliceSubject,
} from "../../relations.ts";
import { ReviewMap } from "../../review-map.ts";
import type { RouteEffort } from "../../route.ts";
import type { BlobStructure } from "../../sections.ts";
import type { ReadingProof } from "../../readings/answers.ts";
import {
  claimKey,
  claimVerifyStep,
  recordedClaimVerifyStep,
} from "../../readings/claims.ts";
import {
  EVIDENCE_RECIPE,
  GroupEvidence,
  callSitePaths,
  chooseRows,
  notRead,
  reachOf,
  relationSubjects,
  type EvidenceOutcome,
  type HeadGateEnd,
  type HeadGateStatus,
} from "../../readings/evidence.ts";
import { planGroup } from "../../readings/plan.ts";
import {
  RetainedReadingPlan,
  isAssignmentPlan,
  validateAssignments,
  assignmentOwner,
} from "../../readings/assignments.ts";
import {
  reviewerClaims,
  type RecordedReviewClaim,
} from "../../readings/reviewer-claims.ts";
import {
  comprehensiveStep,
  comprehensiveBounds,
  reviewToolState,
} from "../../readings/comprehensive.ts";
import {
  registerClaim,
  findRegisteredClaim,
  type ClaimRegistration,
} from "../claim-settlement.ts";
import { readingOrder, renderReading } from "../../readings/reading.ts";
import {
  AssessStored,
  LaneReviewStored,
  assessStep,
  laneReviewOutcomes,
  laneReviewStep,
  type ReadingProducer,
} from "../../readings/steps.ts";
import type { AgentReading } from "../contracts.ts";
import { definePolicyTask } from "../failure-policy.ts";
import { erased, type AgentStep } from "./agent.ts";
import {
  AGENT_STEP,
  type AgentStepCheckpoint,
  type AgentStepInput,
} from "./agent-step.ts";
import { childId, resultOf } from "./children.ts";
import { ChildrenDoc } from "./docs.ts";
import type { FrontResult } from "./front-task.ts";
import type { RelationsResult } from "./relations-task.ts";
import type { KindParams, StageRun } from "./run.ts";
import type { StageServices } from "./services.ts";
import { toolState } from "./tool-state.ts";
import { CHILD_STARTED_SPAN, type ResolvedAgent } from "./tools.ts";
import { repositoryOwner } from "../../budget/owner.ts";

/**
 * The section readings inside a review (NEU-148, the probe): one durable task per reading group and
 * kind, which runs the kind's step, re-reads once what the step left unanswered, checks each
 * distinct defect claim of a Lane review, and always ends `completed` (or `aborted` at the
 * cut-off), never failed: a reading that failed is "not judged", never the review's failure. Its
 * result names stored computations and sections only; it carries no model text.
 *
 * This file also prepares the readings' agent steps from their durable parameters (run.ts calls
 * `readingStep`), each at the effort its parameters carry (`withStepEffort`) and shown the relation
 * evidence they carry (`groupEvidence`, decided once per group and run as its first read starts),
 * and carries a reading step's kind and rank to its route binding (`readingBinds`).
 */

export const READING_TASK = "neuve.reading";

export type ReadingKind = "assess" | "lane-review";

export type ReadingTaskInput = {
  readonly kind: ReadingKind;
  /** Native review owner, for atomic registration of incoming claims. New assignments only. */
  readonly review?: number | undefined;
  /** The stored reading plan's computation key. */
  readonly planKey: string;
  readonly group: string;
  /** The group's risk rank: the scheduler takes readings by it, higher first. */
  readonly rank: number;
  /** Lane review only: the Frame and Map computations its reading is told of. */
  readonly frameKey?: string | undefined;
  readonly mapKey?: string | undefined;
  /**
   * The front task that makes the Frame and the Map (`front-task.ts`), as a plain number, when the
   * reading was created before they landed and so carries no keys. A Lane review waits on it for
   * its keys; an Assess task only looks at it, to stop when it ended with no Frame or Map. Not the
   * reading's child.
   */
  readonly front?: number | undefined;
  /**
   * The head gate (`relations-task.ts`, `headGateOf`), as a plain number: the head commit's
   * relations, to the readings' bound. The reading waits on it before its read (the `relations`
   * phase), so its group decides with the head's relations when they come in time, and records how
   * it ended. Absent with no gate (readings given none, a reading a build before it created): no
   * wait, as before. Not the reading's child, and never the merge base's read: no reading reads it.
   */
  readonly relations?: number | undefined;
  readonly manifestKey: string;
  readonly cutoffAt: number;
  /**
   * The effort the read and the re-read run at, decided when the readings were listed
   * (`readings/effort.ts`), and for a Lane review the effort of its claims' checks: absent when a
   * check runs at its stage's. Both absent from a reading a build before them created: its steps
   * then run at their stage's effort, as they did.
   */
  readonly effort?: RouteEffort | undefined;
  readonly claimEffort?: RouteEffort | undefined;
};

/** The Frame and Map computations a Lane review is shown. */
type Keys = { readonly frame: string; readonly map: string };

/** The head gate's end as the readings record it names every status its result has, and no other. */
const sameGateStatus: [HeadGateStatus, RelationsResult["status"]] extends [
  RelationsResult["status"],
  HeadGateStatus,
]
  ? true
  : never = true;
void sameGateStatus;

/**
 * How a head gate ended, from its outcome: its result's status and its head read's wall time; a gate
 * stopped with no result is `stopped`, and one that failed, faulted or was orphaned is `failed`.
 */
export const headGateEndOf = (
  outcome: TaskOutcome<RelationsResult>,
): HeadGateEnd => {
  const result =
    outcome.status === "completed" || outcome.status === "aborted"
      ? outcome.result
      : undefined;
  return {
    status:
      result?.status ?? (outcome.status === "aborted" ? "stopped" : "failed"),
    wallMs: result?.head?.wallMs ?? null,
  };
};

/**
 * The step task input of one reading part: the read, or the re-read of the `only` sections. A Lane
 * review's carries the Frame and Map keys it was given (`keys`): from its input, or from the front
 * task's result. Each carries the reading's effort, and the group's stored relation evidence when
 * the reading decided it (`evidence`, the key of `groupEvidence`'s decision).
 */
export const readingStepInput = (
  input: ReadingTaskInput,
  part: "read" | "reread",
  keys: Keys | undefined,
  only?: ReadonlyArray<string>,
  evidence?: string,
  owner?: number,
): AgentStepInput => {
  const common = {
    plan: input.planKey,
    group: input.group,
    rank: input.rank,
    manifest: input.manifestKey,
    part,
    ...(only === undefined ? {} : { only: [...only] }),
    ...(input.effort === undefined ? {} : { effort: input.effort }),
    ...(evidence === undefined ? {} : { evidence }),
  };
  return {
    kind: input.kind,
    params: copyJson(
      input.kind === "assess"
        ? common
        : {
            ...common,
            frame: keys?.frame,
            map: keys?.map,
            ...(owner === undefined ? {} : { owner, cutoffAt: input.cutoffAt }),
            ...(input.review === undefined ? {} : { review: input.review }),
            ...(input.claimEffort === undefined
              ? {}
              : { claimEffort: input.claimEffort }),
          },
    ),
    cutoffAt: input.cutoffAt,
  };
};

/**
 * The step task input of one claim's check, from the Lane review answer the claim is in, shown the
 * relation evidence the review was shown.
 */
export const claimStepInput = (
  input: ReadingTaskInput,
  claim: {
    readonly key: string;
    readonly answer: string;
    readonly inline?: RecordedReviewClaim;
  },
  evidence?: string,
): AgentStepInput => ({
  kind: "verify-claim",
  params: copyJson({
    plan: input.planKey,
    group: input.group,
    manifest: input.manifestKey,
    answer: claim.answer,
    claim: claim.key,
    ...("inline" in claim && claim.inline !== undefined
      ? { inline: claim.inline }
      : {}),
    ...(input.claimEffort === undefined ? {} : { effort: input.claimEffort }),
    ...(evidence === undefined ? {} : { evidence }),
  }),
  cutoffAt: input.cutoffAt,
});

/**
 * A reading step at the effort its parameters carry (`AgentSpec`'s `effort`), set each time the step
 * is prepared from them, so its key and its requests follow it and a resumed or re-read step asks
 * for the same. A step whose parameters carry none (a claim check by its kind, or a step a build
 * before them created) is returned as it is, and runs at its stage's effort.
 */
export const withStepEffort = (
  step: AgentStep<unknown, unknown>,
  effort: RouteEffort | undefined,
): AgentStep<unknown, unknown> => {
  if (effort === undefined) return step;
  return { ...step, spec: { ...step.spec, effort } };
};

/** Why a section of a reading was not judged. */
export type ReadingNotJudged = "failed" | "not-reached";

export type ReadingTaskResult = {
  readonly kind: ReadingKind;
  readonly group: string;
  /** The step computations that hold the answers (the read, then the re-read). */
  readonly steps: ReadonlyArray<string>;
  /**
   * Lane review: each distinct defect claim, checked once (one check per claim key, record 0016),
   * the first section it was found on and its check's computation. The same claim may sit on more
   * than one section: the collector gives its check's outcome to every section whose final
   * judgement holds the key (`readings/collect.ts`), never to `section` alone.
   */
  readonly claims: ReadonlyArray<{
    readonly key: string;
    readonly section: string;
    readonly verifyKey: string | null;
    /** False when the cut-off (or the run's stop) kept its check from running: not reached. */
    readonly reached: boolean;
  }>;
  /** Every child's stage record. */
  readonly stages: ReadonlyArray<StageRecord>;
  readonly notJudged: ReadonlyArray<{
    readonly section: string;
    readonly cause: ReadingNotJudged;
  }>;
  /**
   * Each step that ended failed (the read, the re-read), with what kind of failure it was: a label
   * code can count (`failureLabel`), never the failure's message. Absent in a result from before.
   */
  readonly failures?: ReadonlyArray<{
    readonly part: "read" | "reread";
    readonly failure: string;
  }>;
  /**
   * The key of the group's stored relation evidence its steps were shown (`groupEvidence`): the
   * same for both readings of a group. Absent when the reading never started its read, when the
   * decision could not be stored (its steps were shown none), and in a result from before.
   */
  readonly evidence?: string;
};

/** A failure label may hold letters and underscores only, at most 40 of them. */
const LABEL = /^[A-Za-z_]{1,40}$/;

/**
 * What kind of failure a step's outcome was, as a label safe to count: the route failure's kind
 * (`detail.failure.kind`, such as `invalid_request`) when the step task recorded one, else its tag
 * (`detail.tag`), else `unknown`; anything that is not a short word of letters and underscores is
 * `unknown`. Never the message or any other text of the outcome.
 */
export const failureLabel = (
  outcome: TaskOutcome<unknown> | undefined,
): string => {
  const detail =
    outcome !== undefined &&
    (outcome.status === "failed" || outcome.status === "faulted")
      ? outcome.error?.detail
      : undefined;
  const object = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (!object(detail)) return "unknown";
  const failure = detail["failure"];
  const kind = object(failure) ? failure["kind"] : undefined;
  const label =
    typeof kind === "string"
      ? kind
      : typeof detail["tag"] === "string"
        ? detail["tag"]
        : undefined;
  return label !== undefined && LABEL.test(label) ? label : "unknown";
};

type Claimed = {
  readonly key: string;
  readonly section: string;
  /** The stored Lane review output the claim was read from. */
  readonly answer: string;
  readonly inline?: RecordedReviewClaim;
  readonly basis?: Record<string, unknown>;
};

type ReadingCheckpoint =
  | { readonly phase: "read" }
  /** A Lane review given no keys, waiting on the front task (not its child) for them. */
  | { readonly phase: "front" }
  /**
   * Waiting on the head gate (not its child), and a Lane review given no keys whose front task had
   * not ended on that task too, both settled (round 20).
   */
  | { readonly phase: "relations" }
  | {
      readonly phase: "reread";
      readonly read: number;
      /** The keys the read was given from the front task's result; absent when the input held them. */
      readonly keys?: Keys;
      /**
       * The group's stored relation evidence the read was shown, so the re-read and the claims'
       * checks are shown the same; absent when none could be stored, and in a checkpoint from before.
       */
      readonly evidence?: string;
    }
  | {
      readonly phase: "claims";
      readonly read: number;
      readonly reread: number | null;
      readonly evidence?: string;
    }
  | {
      readonly phase: "done";
      readonly read: number;
      readonly reread: number | null;
      readonly evidence?: string;
      /** Each claim's check, or null where none was started because the cut-off had passed. */
      readonly claims: ReadonlyArray<
        Claimed & { readonly task: number | null }
      >;
      /** Set when the claims phase ran past the cut-off and started no check. */
      readonly late?: boolean;
    };

type Runtime = TaskRuntime<
  ReadingTaskInput,
  ReadingCheckpoint,
  ReadingTaskResult,
  object
>;

type AgentStepTask = Task<
  AgentStepInput,
  AgentStepCheckpoint,
  StageRecord,
  object
>;

/**
 * The run's readings as `create` left them: the plan's key (null when it could not be computed, with
 * why) and each reading task by name, so a replayed `create` makes none twice and `collect` reads the
 * plan the readings ran on.
 */
export const ReadingsRunDoc = defineDoc<{
  plan: string | null;
  unavailable: string | null;
  tasks: { [name: string]: number };
}>({
  kind: "neuve.readings",
  version: 1,
  scope: "session",
  initial: () => ({ plan: null, unavailable: null, tasks: {} }),
});

/**
 * A reading task's name, a reading group's briefing task's (`brief.<group>`) and its digest task's
 * (`digest.<group>`).
 */
export const readingName = (
  kind: ReadingKind | "brief" | "digest",
  group: string,
) => `${kind}.${group}`;

// ---------------------------------------------------------------------------------------------
// What a reading is built from, read once per process
// ---------------------------------------------------------------------------------------------

type Ctx = RunContext["Service"];

/**
 * One read per run and key (record 0016): the first caller starts it through records-core's
 * `SharedWork` in its in-process mode, every other caller subscribes to the same run, and a
 * caller's abort only withdraws that caller; the read is cancelled only when no caller still wants
 * it. A completed value is kept in front of it, so a later caller is answered at once. A failed read
 * is not kept: the callers waiting on it get its error, and a later caller reads again. A value given
 * a `slot` replaces the slot's earlier value, so the slot holds one entry at most.
 */
type Shared = {
  readonly work: SharedWork<unknown, unknown>;
  readonly values: Map<string, unknown>;
  readonly slots: Map<string, string>;
};
const sharing = new WeakMap<object, Shared>();
export const remembered = async <V>(
  ctx: Ctx,
  key: string,
  make: (signal: AbortSignal) => Promise<V>,
  signal?: AbortSignal,
  slot?: string,
): Promise<V> => {
  let held = sharing.get(ctx);
  if (held === undefined) {
    held = {
      work: new SharedWork<unknown, unknown>(),
      values: new Map(),
      slots: new Map(),
    };
    sharing.set(ctx, held);
  }
  const { work, values, slots } = held;
  if (values.has(key)) return values.get(key) as V;
  const { outcome } = await work.run({
    scope: `neuve.readings:${ctx.runId}`,
    key,
    ...(signal === undefined ? {} : { signal }),
    run: async (shared) => {
      try {
        const value = await make(shared);
        if (!shared.aborted) {
          values.set(key, value);
          if (slot !== undefined) {
            const before = slots.get(slot);
            if (before !== undefined && before !== key) values.delete(before);
            slots.set(slot, key);
          }
        }
        return { kind: "succeeded", value };
      } catch (error) {
        if (shared.aborted) throw error;
        return { kind: "failed", error };
      }
    },
  });
  if (outcome.kind === "failed") throw outcome.error;
  return outcome.value as V;
};

type Run = StageServices["run"];

export const readPlan = (
  ctx: Ctx,
  run: Run,
  key: string,
  signal?: AbortSignal,
) =>
  remembered(
    ctx,
    `plan:${key}`,
    (shared) => run(storedOutput(ctx, key, RetainedReadingPlan), shared),
    signal,
  );

export const readManifest = (
  ctx: Ctx,
  run: Run,
  key: string,
  signal?: AbortSignal,
) =>
  remembered(
    ctx,
    `manifest:${key}`,
    (shared) => run(storedOutput(ctx, key, RangeManifest), shared),
    signal,
  );

/**
 * Each changed blob's stored structure, by object ID, as the plan and the readings read them:
 * through `blobStructures` with the run's outline source, which reads Graph only for a blob whose
 * structure is not stored yet.
 */
export const structuresOf = (
  ctx: Ctx,
  manifest: RangeManifest,
  source: OutlineSource = captureOutlineSource(),
) =>
  Effect.gen(function* () {
    const { head, base } = yield* revisionViews(ctx.repository, manifest);
    const entries: Array<TreeEntry> = [];
    const side = (
      oid: string | null,
      path: string | null,
      mode: string | null,
      revision: typeof head,
    ) => {
      if (oid === null || path === null) return;
      const held = revision.entries.get(path);
      entries.push(
        held !== undefined && held.oid === oid
          ? held
          : {
              mode: mode ?? "100644",
              type: "blob",
              oid,
              size: null,
              path,
            },
      );
    };
    for (const hunk of manifest.hunks) {
      if (hunk.kind !== "text") continue;
      side(hunk.oldOid, hunk.oldPath, hunk.oldMode, base);
      side(hunk.newOid, hunk.newPath, hunk.newMode, head);
    }
    const read = yield* withRecords(
      ctx,
      blobStructures(ctx.repository, entries, source),
    );
    const structures = new Map<string, BlobStructure>();
    for (const entry of entries) {
      const structure = read.structures.get(
        structureKeyOf(entry.path, entry.oid),
      );
      if (structure !== undefined && !structures.has(entry.oid))
        structures.set(entry.oid, structure);
    }
    return { structures, source: source.key };
  });

export const structuresRead = (
  ctx: Ctx,
  run: Run,
  manifestKey: string,
  signal?: AbortSignal,
) =>
  remembered(
    ctx,
    `structures:${manifestKey}`,
    async (shared) =>
      run(
        structuresOf(ctx, await readManifest(ctx, run, manifestKey, shared)),
        shared,
      ),
    signal,
  );

// ---------------------------------------------------------------------------------------------
// The relation evidence a group is shown, decided once per group and run
// ---------------------------------------------------------------------------------------------

const EVIDENCE_OP = "harness.reading-evidence";

/**
 * At most this long for the evidence of one group from what is stored: past it, the group is shown
 * none (and that is what is stored), so a slow store or Git never holds a reading.
 */
export const EVIDENCE_BOUND_MS = 30_000;

/**
 * The key of a group's decision: the review's sequence (its cycle and run key), the plan, the group
 * and the manifest. The sequence is in it because what was stored when the group decided is not an
 * input anyone else can name; it is the sequence, not the run, so every run of one chain (a held run
 * and its follow-ons, generation after generation) is shown what the first one to decide was shown,
 * and a follow-on's readings meet the same text and reuse every completed answer, even when a
 * relations read that failed in one run succeeds in the next. A group decided once never takes up
 * relations stored later (its gaps still say why); another review (a new cycle or run key) decides
 * again from what is stored by then. The lift is no switch (round 13), so the key never says
 * whether it is on: the recipe (`EVIDENCE_RECIPE` 13) moved instead.
 */
export const evidenceSpec = (input: {
  readonly cycleId: string;
  readonly runKey: string;
  readonly planKey: string;
  readonly group: string;
  readonly manifestKey: string;
}): Computations.ComputationSpec => ({
  op: EVIDENCE_OP,
  // 2: keyed by the sequence (cycle and run key), no longer by the run.
  opVersion: 2,
  inputs: {
    sequence: `${input.cycleId}:${input.runKey}`,
    plan: `computation:${input.planKey}`,
    group: input.group,
    manifest: `computation:${input.manifestKey}`,
    recipe: EVIDENCE_RECIPE,
  },
});

/**
 * The base side as this consumer gives the caller paths and the slices: never sliced here, since no
 * row reads it (a counterpart, which only the base gives, is never shown), so no view of the base's
 * index is built. Whether the base was stored is still recorded with the decision.
 */
const BASE_NOT_READ: RelationsGap = { gap: "over-bound", tag: null };

/**
 * The graph lane's calls a decision makes, counted in this process, for tests: the stored lookup
 * (`storedRelations`), the passes that name callers (`relationCallerPaths`), the slicing passes
 * (`relationSlices`), and the reads of the head commit's declarations (`readDeclarations`, which
 * read every package manifest and `bunfig.toml`). A decision makes them only through the wrappers
 * below.
 */
export const evidenceWork = {
  lookups: 0,
  callerPaths: 0,
  slices: 0,
  declarations: 0,
};
const counted =
  <A extends ReadonlyArray<unknown>, R>(
    kind: keyof typeof evidenceWork,
    call: (...args: A) => R,
  ) =>
  (...args: A): R => {
    evidenceWork[kind]++;
    return call(...args);
  };
const lookupRelations = counted("lookups", storedRelations);
const callerPathsOf = counted("callerPaths", relationCallerPaths);
const slicesOf = counted("slices", relationSlices);
const declarationsOf = counted("declarations", readDeclarations);

/**
 * A head side `storedRelations` found no index for, as the decision's outcome. Not stored (its tag
 * `NOT_STORED`), and no engine or one whose identity is unknown (`graph-unavailable`), are
 * `not-stored`, as round 6 counted both; an unreadable store or an index that does not decode is
 * `failed`. The lookup gives no other `over-bound`; one would mean nothing stored was read, so it
 * counts as not stored.
 */
const outcomeOf = (gap: RelationsGap): Exclude<EvidenceOutcome, "read"> =>
  gap.gap === "failed" ? "failed" : "not-stored";

/** The head tree's entries, once per run and manifest. */
const headTree = (
  ctx: Ctx,
  run: Run,
  manifest: RangeManifest,
  manifestKey: string,
  signal?: AbortSignal,
) =>
  remembered(
    ctx,
    `head-tree:${manifestKey}`,
    (shared) => run(lsTree(ctx.repository, manifest.range.headTree), shared),
    signal,
  );

/**
 * The head commit's files by test status (`testStatusOf`): every file of the head tree the head's
 * declarations name a test (`tests`), and every one whose status the reader could not settle
 * (`undecided`: under a manifest or script it did not follow, or named as a runner it does not
 * read documents). Every other file is not a test, by declarations the reader followed. Once per
 * run in this process; nothing in it depends on the group: it is read from the head tree alone.
 *
 * The declarations are read over the whole head tree (`tree` is every entry), so every manifest,
 * the `bunfig.toml` beside it and the paths a script names are seen (with only the manifests, no
 * `bunfig.toml` and no `./tests` root was ever seen: 127 of this repository's 734 test-named files
 * were declared). No file's first bytes are read (`markers: false`: the generated-file marker is
 * not needed here). The other work inside that read is `git check-attr` over the tree's paths, one
 * process per 16,384 paths.
 *
 * This is a memory of a pure read of immutable data (the head tree, by its object ID), not a claim
 * or a lock: concurrent decisions share the one read through `remembered` (record 0016), it holds
 * one entry (its slot), and a lost memory (a resumed run in a new process) costs one read again and
 * nothing else.
 */
/** The head's test files and its undecided files (`testFilesOf`); every other file is not a test. */
export type HeadTestFiles = Readonly<{
  tests: ReadonlySet<string>;
  undecided: ReadonlySet<string>;
}>;

const NO_TEST_FILES: HeadTestFiles = { tests: new Set(), undecided: new Set() };

export const testFilesOf = (
  ctx: Ctx,
  run: Run,
  manifest: RangeManifest,
  entries: ReadonlyArray<TreeEntry>,
  signal?: AbortSignal,
) =>
  remembered(
    ctx,
    `test-files:${manifest.range.headTree}`,
    async (shared): Promise<HeadTestFiles> => {
      const paths = entries
        .filter((entry) => entry.type === "blob")
        .map((entry) => entry.path);
      const declarations = await run(
        declarationsOf({
          repository: ctx.repository,
          revision: manifest.range.headOid,
          tree: entries,
          paths,
          markers: false,
        }),
        shared,
      );
      const tests = new Set<string>();
      const undecided = new Set<string>();
      for (const path of paths) {
        const status = testStatusOf(declarations, path);
        if (status === "test") tests.add(path);
        else if (status !== "not-test") undecided.add(path);
      }
      return { tests, undecided };
    },
    signal,
    "test-files",
  );

/**
 * Every read section's slice of the plan, cut once per run in this process for the stored head
 * index (its computation key) with the head's declared test files (`testFilesOf`), with the head's
 * undecided files beside them, and remembered
 * like them: through `remembered` (record 0016: decisions asking at once share the one cut), one
 * entry (its slot), a failed cut never kept, and a lost memory (a new process) costs one cut again.
 * It holds the slices only, never an index. The subjects are every read section, so which callers
 * changed is told against the whole range.
 */
const planSlices = (
  ctx: Ctx,
  input: Readonly<{
    planKey: string;
    headKey: string;
    cut: (signal: AbortSignal) => Promise<{
      readonly slices: ReadonlyArray<RelationSlice>;
      readonly files: HeadTestFiles;
    }>;
  }>,
  signal?: AbortSignal,
) =>
  remembered(
    ctx,
    `plan-slices:${input.planKey}:${input.headKey}`,
    async (
      shared,
    ): Promise<{
      readonly slices: ReadonlyMap<string, RelationSlice>;
      readonly files: HeadTestFiles;
    }> => {
      const cut = await input.cut(shared);
      return {
        slices: new Map(cut.slices.map((slice) => [slice.key, slice])),
        files: cut.files,
      };
    },
    signal,
    "plan-slices",
  );

/**
 * One group's evidence from what is stored now: the head commit's and the merge base's relations
 * reads, looked up once by the graph lane's stored-only lookup (`storedRelations`, with this run's
 * engine) and never started or waited for here (the review's relations task starts them). Nothing
 * stored for the head leaves every section of the group not read.
 *
 * Per decision, on the index objects that one lookup returned, and never on a copy: one pass that
 * names the group's callers (`relationCallerPaths`), to tell whether the group has any caller to
 * classify. A group with one takes the plan's slices, cut once per run (`planSlices`); a group with
 * none cuts its own sections only, with no declarations read. This lane keeps no index of its own:
 * sharing a load and a decode between decisions is the graph lane's.
 */
const decideEvidence = async (
  ctx: Ctx,
  run: Run,
  input: Pick<ReadingTaskInput, "planKey" | "group" | "manifestKey">,
  signal?: AbortSignal,
): Promise<GroupEvidence> => {
  const plan = await readPlan(ctx, run, input.planKey, signal);
  const keys = readingOrder(plan, input.group);
  const manifest = await readManifest(ctx, run, input.manifestKey, signal);
  const source = captureOutlineSource();
  const relationKeys = {
    head: Computations.computationKey(
      relationsSpec(manifest.range.headOid, source),
    ).key,
    // The merge base, as the relations task reads it: a section's old lines are lines of it.
    base: Computations.computationKey(
      relationsSpec(manifest.range.mergeBase, source),
    ).key,
  };
  // The one lookup of this decision: both sides, from the store only. Not under the machine's CPU
  // budget: a slot held by a relations read in flight would make the reading wait for it.
  const stored = await run(
    withRecords(
      ctx,
      lookupRelations({
        base: manifest.range.mergeBase,
        head: manifest.range.headOid,
        source,
      }),
    ),
    signal,
  );
  const relations = {
    head: isRelationsGap(stored.head) ? null : relationKeys.head,
    base: isRelationsGap(stored.base) ? null : relationKeys.base,
  };
  if (isRelationsGap(stored.head))
    return notRead(input.group, outcomeOf(stored.head), relations, keys);
  const sides = { base: BASE_NOT_READ, head: stored.head };
  const hunks = new Map(manifest.hunks.map((hunk) => [hunk.hunkId, hunk]));
  const subjects = relationSubjects(plan, hunks);
  const own = new Set(keys);
  // The group's callers: none means no caller to classify, and no declarations are read.
  const callers = await run(
    cpuWork(
      repositoryOwner(ctx.repository),
      Effect.sync(
        () =>
          callerPathsOf(
            sides,
            subjects.filter((subject) => own.has(subject.key)),
          ).head,
      ),
    ),
    signal,
  );
  // Each candidate call site's line at the head commit, from the head tree's blobs: a line the tree
  // does not give (past the end, a blob the read leaves out, a path that is no blob) is no row.
  const entries = await headTree(ctx, run, manifest, input.manifestKey, signal);
  const tree = new Map(entries.map((entry) => [entry.path, entry]));
  const cut = (
    of: ReadonlyArray<SliceSubject>,
    tests: ReadonlySet<string>,
    shared?: AbortSignal,
  ) =>
    run(
      cpuWork(
        repositoryOwner(ctx.repository),
        Effect.sync(() =>
          slicesOf(sides, of, {
            base: () => false,
            head: (path) => tests.has(path),
          }),
        ),
      ),
      shared,
    );
  const { slices, files } =
    callers.length === 0
      ? // No caller in the group's sections: which caller is a test, and which changed, cannot
        // matter, so only the group's own sections are cut, with no declarations read.
        {
          slices: new Map(
            (
              await cut(
                subjects.filter((subject) => own.has(subject.key)),
                new Set(),
                signal,
              )
            ).map((slice): [string, RelationSlice] => [slice.key, slice]),
          ),
          files: NO_TEST_FILES,
        }
      : await planSlices(
          ctx,
          {
            planKey: input.planKey,
            headKey: relationKeys.head,
            cut: async (shared) => {
              const files = await testFilesOf(
                ctx,
                run,
                manifest,
                entries,
                shared,
              );
              return {
                slices: await cut(subjects, files.tests, shared),
                files,
              };
            },
          },
          signal,
        );
  const oids = callSitePaths(
    plan,
    input.group,
    slices,
    hunks,
    files.undecided,
  ).flatMap((path) => {
    const entry = tree.get(path);
    return entry?.type === "blob" ? [entry.oid] : [];
  });
  const blobs = await run(readBlobs(ctx.repository, oids), signal);
  const lines = new Map<string, ReadonlyArray<string>>();
  const lineAt = (path: string, line: number) => {
    const entry = tree.get(path);
    const bytes = entry === undefined ? undefined : blobs.get(entry.oid);
    if (bytes === undefined) return null;
    let held = lines.get(path);
    if (held === undefined) {
      held = new TextDecoder().decode(bytes).split("\n");
      lines.set(path, held);
    }
    return held[line - 1] ?? null;
  };
  return {
    recipe: EVIDENCE_RECIPE,
    group: input.group,
    outcome: "read",
    relations,
    sections: chooseRows(
      plan,
      input.group,
      slices,
      lineAt,
      hunks,
      files.undecided,
    ),
    // Recorded for measuring, shown to no reading (`SectionReach`).
    reach: reachOf(plan, input.group, slices, hunks),
  };
};

/**
 * The key of a group's relation evidence for this review's sequence (record 0016): the first of the
 * group's readings to start its read decides it and stores it, and every other caller (the other
 * reading, a replayed phase, a follow-on run) subscribes to that run or reads it stored, so both
 * readings, their re-reads and the claims' checks are shown the same in every run of the chain. A
 * decision that cannot be made from what is stored (an error, the bound passed) stores one that
 * shows nothing, with its outcome (`failed`, `over-bound`); one that found nothing stored says
 * `not-stored`. Only a store that cannot store
 * gives no key, and the reading is then shown nothing (`collect` then keeps every section's gap).
 */
/**
 * Whether the group's decision for this review's sequence (`evidenceSpec`: its cycle and run key) is
 * already stored: a lookup in the store, read only, which starts and claims nothing. A follow-on run
 * of a chain finds the decision its first run stored, and that decision is what it shows whatever
 * the relations are by now, so it need not wait on its own head gate first. A lookup that fails
 * says not stored: the reading waits, as it would without this look.
 */
export const evidenceStored = async (
  ctx: Ctx,
  run: Run,
  input: Pick<ReadingTaskInput, "planKey" | "group" | "manifestKey">,
  signal?: AbortSignal,
): Promise<boolean> => {
  const { key } = Computations.computationKey(
    evidenceSpec({
      cycleId: ctx.cycleId,
      runKey: ctx.runKey,
      planKey: input.planKey,
      group: input.group,
      manifestKey: input.manifestKey,
    }),
  );
  try {
    return Option.isSome(
      await run(
        withRecords(
          ctx,
          Effect.gen(function* () {
            const store = yield* Computations.ComputationStore;
            return yield* store.lookup(key);
          }),
        ),
        signal,
      ),
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    return false;
  }
};

export const groupEvidence = async (
  ctx: Ctx,
  run: Run,
  input: Pick<ReadingTaskInput, "planKey" | "group" | "manifestKey"> & {
    /** How the head gate the reading waited on ended, recorded with the decision; none, absent. */
    readonly gate?: HeadGateEnd | undefined;
  },
  signal?: AbortSignal,
  /** The decision's time bound; a test gives a short one. */
  bound: number = EVIDENCE_BOUND_MS,
): Promise<string | undefined> => {
  const spec = evidenceSpec({
    cycleId: ctx.cycleId,
    runKey: ctx.runKey,
    planKey: input.planKey,
    group: input.group,
    manifestKey: input.manifestKey,
  });
  try {
    return await run(
      withRecords(
        ctx,
        Effect.gen(function* () {
          const store = yield* Computations.ComputationStore;
          // Inside the store's one run: the other reading of the group subscribes, never decides.
          const decided = Effect.tryPromise({
            try: (shared) => decideEvidence(ctx, run, input, shared),
            catch: (error) => error,
          }).pipe(
            Effect.timeoutOption(bound),
            Effect.map((found) =>
              Option.getOrElse(found, () => notRead(input.group, "over-bound")),
            ),
            Effect.catch(() => Effect.succeed(notRead(input.group, "failed"))),
            // However it was decided, it records the gate's end: only the person's words read it.
            Effect.map((evidence): GroupEvidence =>
              input.gate === undefined
                ? evidence
                : { ...evidence, gate: { ...input.gate } },
            ),
          );
          const result = yield* store.run(
            spec,
            Effect.map(decided, (evidence) => ({
              bytes: new TextEncoder().encode(
                JSON.stringify(GroupEvidence.parse(evidence)),
              ),
              mediaType: "application/json",
            })),
          );
          return result.computation.key;
        }),
      ),
      signal,
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    return undefined;
  }
};

/** A group's stored relation evidence by its key, read once per process. */
export const readEvidence = (
  ctx: Ctx,
  run: Run,
  key: string,
  signal?: AbortSignal,
) =>
  remembered(
    ctx,
    `evidence:${key}`,
    (shared) => run(storedOutput(ctx, key, GroupEvidence), shared),
    signal,
  );

/**
 * The range's proof records as a reading lists them, with each one's currency for every given path
 * (`Proofs.describeCurrency`), as `fill` reads them. None when the list cannot be read.
 */
const proofsFor = async (
  ctx: Ctx,
  run: Run,
  paths: ReadonlyArray<string>,
  signal?: AbortSignal,
): Promise<ReadonlyArray<ReadingProof>> => {
  const listed = await remembered(
    ctx,
    "proofs",
    (shared) =>
      run(
        withRecords(
          ctx,
          Proofs.list({ repository: ctx.repository, range: ctx.range }).pipe(
            Effect.map((list) => list.records),
            Effect.catch(() => Effect.succeed([])),
          ),
        ),
        shared,
      ),
    signal,
  );
  if (listed.length === 0) return [];
  const currency = await remembered(
    ctx,
    "currency",
    async () =>
      Proofs.currencyChecker({
        repository: ctx.repository,
        headOid: ctx.range.headOid,
      }),
    signal,
  );
  const out: Array<ReadingProof> = [];
  for (const proof of listed) {
    const byPath: Record<string, string> = {};
    for (const path of paths)
      byPath[path] = await remembered(
        ctx,
        `currency:${proof.id}:${path}`,
        (shared) =>
          run(
            withRecords(
              ctx,
              Effect.map(currency(proof.revision, [path]), (found) =>
                Proofs.describeCurrency(found),
              ),
            ),
            shared,
          ),
        signal,
      );
    out.push({
      id: proof.id,
      kind: proof.kind,
      requirement: proof.requirement.text,
      currency: byPath,
    });
  }
  return out;
};

/**
 * The done-when rows each file of the range may be judged on: a Map group's done-when links, with
 * each row's id and text from the Frame. No requirements in this build: nothing of an Assess answer
 * ever reaches a Lane review.
 */
const rowsOf = (frame: Frame, map: ReviewMap) => {
  const rows = new Map<string, Array<RowBasis>>();
  for (const group of map.groups)
    for (const file of group.files)
      for (const row of frame.doneWhen.filter((d) =>
        group.doneWhen.includes(d.id),
      )) {
        const held = rows.get(file.path) ?? [];
        if (!held.some((entry) => entry.row === row.id))
          held.push({ row: row.id, text: row.text, requirements: [] });
        rows.set(file.path, held);
      }
  return rows;
};

/** A Lane review's tools for its one tool turn, under one reading budget. */
export const LANE_REVIEW_READING_CHARS = 24_000;

type ReadingParams =
  | { readonly kind: "assess"; readonly params: KindParams<"assess"> }
  | {
      readonly kind: "lane-review";
      readonly params: KindParams<"lane-review">;
    }
  | {
      readonly kind: "verify-claim";
      readonly params: KindParams<"verify-claim">;
    };

/**
 * The agent of one reading step, from its durable parameters (run.ts): the stored plan rendered
 * for the group (only the `only` sections for a re-read), the Assess or Lane review step over it,
 * or the check of one defect claim.
 */
export const readingStep = async (
  ctx: Ctx,
  run: Run,
  /** The range as the run reads it, for Lane review's tools only: listed only when asked for. */
  view: () => Promise<RangeView>,
  input: ReadingParams,
  signal?: AbortSignal,
): Promise<AgentStep<unknown, unknown>> => {
  const { params } = input;
  const plan = await readPlan(ctx, run, params.plan, signal);
  const manifest = await readManifest(ctx, run, params.manifest, signal);
  if (isAssignmentPlan(plan)) {
    validateAssignments(plan, manifest.hunks);
    if (plan.source.manifestKey !== params.manifest)
      throw new Error("Assignment source differs from the reviewed manifest");
  }
  const { structures } = await structuresRead(
    ctx,
    run,
    params.manifest,
    signal,
  );
  const hunks = new Map(manifest.hunks.map((hunk) => [hunk.hunkId, hunk]));
  const paths = planGroup(plan, params.group).paths;
  // The group's stored relation evidence, as every step of the group is shown it. One that cannot
  // be read fails the step (not judged), never a reading shown less than its group was.
  const evidence =
    params.evidence === undefined
      ? undefined
      : await readEvidence(ctx, run, params.evidence, signal);
  if (input.kind === "verify-claim") {
    const p = input.params;
    if (p.inline !== undefined) {
      if (p.inline.key !== p.claim)
        throw new Error(
          "Inline claim identity differs from its requested check",
        );
      return withStepEffort(
        erased(
          recordedClaimVerifyStep({
            claim: p.inline,
            turnLimit: turnLimitFor(ctx.config, "verify"),
          }),
        ),
        p.effort,
      );
    }
    if (p.answer === undefined)
      throw new Error(
        "A claim check needs retained inline source or a stored answer",
      );
    const stored = await run(
      storedOutput(ctx, p.answer, LaneReviewStored),
      signal,
    );
    const found = laneReviewOutcomes(stored, plan).flatMap(
      ({ key, outcome }) =>
        outcome.judged
          ? outcome.judgement.comments
              .filter(
                (comment) =>
                  comment.kind === "defect" && claimKey(comment) === p.claim,
              )
              .map((comment) => ({ key, comment }))
          : [],
    )[0];
    if (found === undefined)
      throw new Error(
        `The Lane review answer ${p.answer} holds no defect claim ${p.claim}`,
      );
    const reading = renderReading(plan, params.group, {
      for: "lane-review",
      hunks,
      structures,
      only: [found.key],
      evidence,
    });
    return withStepEffort(
      erased(
        claimVerifyStep({
          key: p.claim,
          section: found.key,
          comment: found.comment,
          reading,
          turnLimit: turnLimitFor(ctx.config, "verify"),
        }),
      ),
      p.effort,
    );
  }
  const proofs = await proofsFor(ctx, run, paths, signal);
  const only = input.params.part === "reread" ? input.params.only : undefined;
  // Scope and tests, as the run's configuration froze it: the two readings' own steps (a read and
  // its re-read) render and answer with it; a claim check above never does.
  const scopeAndTests = ctx.config.readings?.scopeAndTests === true;
  // This review, stored with what the step computes: a later review that finds the output records
  // the judgement as carried from it (`readings/collect.ts`).
  const by: ReadingProducer = {
    review: ctx.runKey,
    run: ctx.runId,
    cycle: ctx.cycleId,
    head: ctx.range.headOid,
  };
  // Two returns, not one conditional, so the reader registry's audit follows the step's schema. A
  // read and its re-read run at the reading's one effort.
  const reread = (step: AgentStep<unknown, unknown>) => {
    if (input.params.part !== "reread")
      return withStepEffort(step, input.params.effort);
    return withStepEffort(
      {
        ...step,
        spec: { ...step.spec, agent: `${step.spec.agent}.reread` },
      },
      input.params.effort,
    );
  };
  if (input.kind === "assess")
    return reread(
      erased(
        assessStep({
          stage: "verify",
          reading: renderReading(plan, params.group, {
            for: "assess",
            hunks,
            structures,
            proofs,
            only,
            evidence,
            scopeAndTests,
          }),
          scopeAndTests,
          by,
        }),
      ),
    );
  const p = input.params;
  const frame = await run(storedOutput(ctx, p.frame, Frame), signal);
  const map = await run(storedOutput(ctx, p.map, ReviewMap), signal);
  const assigned = isAssignmentPlan(plan);
  if (
    assigned &&
    (plan.source.frameKey !== p.frame || plan.source.mapKey !== p.map)
  )
    throw new Error(
      "Assignment frame or batch map differs from the prepared source",
    );
  const rangeView = await view();
  const lookups = lookupContext(ctx, rangeView);
  const bounds = comprehensiveBounds(
    planGroup(plan, params.group).totals.characters,
    planGroup(plan, params.group).keys.length,
  );
  const readingChars = assigned
    ? bounds.readingChars
    : LANE_REVIEW_READING_CHARS;
  const raw = [
    readTool(lookups),
    usesTool(lookups),
    defsTool(lookups),
    outlineTool(lookups),
  ];
  const budget = readingBudget(
    assigned
      ? [
          ...raw,
          readManyTool(lookups),
          hunkTool(lookups),
          scopeSectionTool(lookups),
          ...proofReaders({
            repository: ctx.repository,
            range: ctx.range,
            services: ctx.records,
            ownedPaths: paths,
            currencyScope: "this assignment",
          }),
        ]
      : raw,
    readingChars,
  );
  const reading = renderReading(plan, params.group, {
    for: "lane-review",
    hunks,
    structures,
    proofs,
    rows: rowsOf(frame, map),
    only,
    evidence,
    scopeAndTests: assigned || scopeAndTests,
  });
  const state = toolState({ handles: lookups.handles, reading: budget });
  const goal = {
    goal: frame.goal,
    doneWhen: frame.doneWhen.map(({ id, text }) => ({ id, text })),
  };
  if (!assigned)
    return reread(
      erased(
        laneReviewStep({
          stage: "verify",
          reading,
          goal,
          tools: budget.tools,
          readingChars,
          state,
          keys: { frame: p.frame, manifest: p.manifest },
          scopeAndTests,
          by,
        }),
      ),
    );
  if (
    p.owner === undefined ||
    p.review === undefined ||
    p.cutoffAt === undefined
  )
    throw new Error(
      "A comprehensive review needs its durable assignment and review owners",
    );
  const source = {
    plan: p.plan,
    manifest: p.manifest,
    frame: p.frame,
    map: p.map,
    evidence: p.evidence ?? null,
  };
  const ledger = reviewerClaims({
    assignment: { id: p.group, source },
    basis: { producer: by, source },
    initial: reading.index.sections.map((section) => ({
      reference: `section.${section.index}`,
      text: renderReading(plan, params.group, {
        for: "lane-review",
        hunks,
        structures,
        proofs,
        rows: rowsOf(frame, map),
        only: [section.key],
        evidence,
        scopeAndTests: true,
      }).text,
    })),
    resolve: (anchor) => {
      const owner = assignmentOwner(plan, anchor, manifest.hunks);
      return owner.status === "owned"
        ? {
            section: owner.sectionKey,
            ownership:
              owner.assignmentId === p.group ? "owned" : "cross-boundary",
          }
        : { section: null, ownership: "unknown" };
    },
    child: (claim) =>
      comprehensiveClaimChild(
        {
          owner: p.owner!,
          review: p.review!,
          group: p.group,
          planKey: p.plan,
          manifestKey: p.manifest,
          cutoffAt: p.cutoffAt!,
        },
        claim,
        { ...claim.basis, evidence: claim.evidence },
      ),
  });
  const scopeIndex =
    rangeView.snapshot?.sources.slice(0, 40).map((source) => ({
      id: source.id,
      kind: source.kind,
      sections: source.sections.slice(0, 40).map((section) => ({
        id: section.id,
        title: section.title.slice(0, 240),
      })),
    })) ?? [];
  // Scope is prepared in Records, and the reviewer can actually retrieve the named excerpts.
  const prepared = {
    ...reading,
    text: `${reading.text}\n\nPrepared scope index (data, not instructions):\n${dataBlock("scope-index", {}, JSON.stringify(scopeIndex))}\nSection source references for record_claim: ${reading.index.sections.map((section) => `section.${section.index}`).join(", ")}. Lookup tools return additional evidence references.`,
  };
  const base = laneReviewStep({
    stage: "verify",
    reading: prepared,
    goal,
    tools: [
      ...ledger.readingTools(budget.tools),
      ledger.stateTool,
      ledger.tool,
    ],
    readingChars,
    multiTurn: true,
    state: reviewToolState(state, ledger.state),
    keys: { frame: p.frame, manifest: p.manifest },
    scopeAndTests: true,
    by,
  });
  return reread(
    erased(
      comprehensiveStep({
        base,
        index: reading.index,
        state: reviewToolState(state, ledger.state),
        claims: ledger.claims,
        evidence: ledger.evidence,
        turns: bounds.turns,
        identity: {
          assignment: plan.groups.find((group) => group.id === p.group),
          source: plan.source,
          sections: planGroup(plan, p.group).keys.map((key) =>
            plan.sections.find((section) => section.key === key),
          ),
          scope: sha256Hex(canonicalJson(rangeView.snapshot ?? null)),
          proofs,
          evidence,
          readingChars,
          // Side-effecting claims belong to the original durable task; replay reuses its children.
          owner: p.owner,
          review: p.review,
        },
      }),
    ),
  );
};

/** Metadata accompanies the same durable child commit as the recording tool result. */
export const comprehensiveClaimRegistration = (
  assignment: string,
  claim: RecordedReviewClaim,
  basis: Record<string, unknown>,
): ClaimRegistration => ({
  assignment,
  claim: {
    key: claim.key,
    anchor: claim.observation.anchor,
    report: copyJson(claim) as ClaimRegistration["claim"]["report"],
    basis: copyJson(basis) as ClaimRegistration["claim"]["basis"],
  },
});

export const comprehensiveClaimChild = (
  input: {
    readonly owner: number;
    readonly review: number;
    readonly group: string;
    readonly planKey: string;
    readonly manifestKey: string;
    readonly cutoffAt: number;
    readonly claimEffort?: RouteEffort;
  },
  claim: RecordedReviewClaim,
  basis: Record<string, unknown>,
) => ({
  owner: input.owner,
  name: `claim.${claim.key}`,
  task: AGENT_STEP,
  input: {
    kind: "verify-claim",
    params: copyJson({
      plan: input.planKey,
      group: input.group,
      manifest: input.manifestKey,
      claim: claim.key,
      inline: claim,
      ...(input.claimEffort === undefined ? {} : { effort: input.claimEffort }),
    }),
    cutoffAt: input.cutoffAt,
  } satisfies AgentStepInput,
  attributes: { "harness.claim": claim.key },
  kind: "verify-claim",
  inputs: {
    plan: `computation:${input.planKey}`,
    manifest: `computation:${input.manifestKey}`,
  },
  claimRegistration: comprehensiveClaimRegistration(input.group, claim, basis),
});

/**
 * Carries a reading step's kind and its group's rank to its route binding, so its calls queue as a
 * reading by rank, and a re-read as continued (scheduler hand-over, the smaller option). The agent
 * step binds after it prepares, so the prepared agent's name finds what its parameters said. Off,
 * the services and the preparation are returned as they are. The preparation is called as the run's
 * member, never held bare, so the reader registry's audit follows it to the stage run.
 */
export const readingBinds = (
  services: StageServices,
  run: { readonly prepare: StageRun["prepare"] },
  on: boolean,
): {
  readonly services: StageServices;
  readonly prepare: StageRun["prepare"];
} => {
  if (!on) return { services, prepare: run.prepare };
  const readings = new Map<string, AgentReading>();
  return {
    services: {
      ...services,
      routes: {
        ...services.routes,
        bindAgentRoute: (input, context) => {
          const reading = readings.get(input.agent);
          return services.routes.bindAgentRoute(
            reading === undefined ? input : { ...input, reading },
            context,
          );
        },
      },
    },
    prepare: async (taskId, input, read, context): Promise<ResolvedAgent> => {
      const agent = await run.prepare(taskId, input, read, context);
      // The briefing's parts and digests (NEU-148 round 27) queue as readings too, by their group's
      // rank: without this advice they would go as a review's own step at Verify's stage.
      if (
        input.kind === "assess" ||
        input.kind === "lane-review" ||
        input.kind === "brief"
      ) {
        const params = input.params as { rank?: unknown; part?: unknown };
        if (typeof params.rank === "number")
          readings.set(agent.step.spec.agent, {
            kind: input.kind,
            rank: params.rank,
            ...(params.part === "reread" ? { reread: true } : {}),
          });
      }
      return agent;
    },
  };
};

// ---------------------------------------------------------------------------------------------
// The reading task
// ---------------------------------------------------------------------------------------------

/** One step child's end, as the reading reads it. */
type StepEnd<S> =
  | { readonly state: "stored"; readonly key: string; readonly stored: S }
  | { readonly state: "not-reached" }
  | { readonly state: "failed"; readonly failure: string };

/** A JSON copy with its type kept, as the review task's checkpoints are copied. */
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const settledRecord = (outcome: TaskOutcome<StageRecord> | undefined) =>
  outcome === undefined ? undefined : resultOf(outcome);

export const readingTask = (
  services: StageServices,
  agentStep: AgentStepTask,
) => {
  const { ctx } = services;
  const log = ctx.log;
  const waits = waitSpans(log);
  const span = (runtime: Runtime, phase: string, kind: ReadingKind) => {
    waits.resumed(runtime.taskId);
    return scopedLogSpan(log, "harness.pi.phase", {
      "harness.task_id": runtime.taskId,
      "harness.phase": phase,
      "harness.task_kind": `reading.${kind}`,
    });
  };

  /** A step's end: its stored output, or not reached (skipped or cut off), or failed. */
  const endOf = async (
    kind: ReadingKind,
    outcome: TaskOutcome<StageRecord> | undefined,
    signal: AbortSignal,
  ): Promise<StepEnd<AssessStored | LaneReviewStored>> => {
    if (outcome === undefined) return { state: "not-reached" };
    if (
      outcome.status === "failed" ||
      outcome.status === "faulted" ||
      outcome.status === "orphaned"
    )
      return { state: "failed", failure: failureLabel(outcome) };
    const record = resultOf(outcome);
    if (
      record?.key !== undefined &&
      (record.status === "computed" ||
        record.status === "reused" ||
        (kind === "lane-review" && record.status === "interrupted"))
    ) {
      try {
        const stored: AssessStored | LaneReviewStored =
          kind === "assess"
            ? await services.run(
                storedOutput(ctx, record.key, AssessStored),
                signal,
              )
            : await services.run(
                storedOutput(ctx, record.key, LaneReviewStored),
                signal,
              );
        return { state: "stored", key: record.key, stored };
      } catch (error) {
        if (signal.aborted) throw error;
        return { state: "failed", failure: "unknown" };
      }
    }
    return outcome.status === "completed" &&
      record !== undefined &&
      record.status !== "interrupted" &&
      record.status !== "skipped"
      ? { state: "failed", failure: "unknown" }
      : { state: "not-reached" };
  };

  /** Which computations a task reads, as the finder records its children's (`task.inputs`). */
  const inputsOf = (
    runtime: Runtime,
    task: number,
    kind: string,
    inputs: Readonly<Record<string, string>>,
    more: Record<string, string> = {},
  ) =>
    log.write({
      type: "task.inputs",
      taskId: task,
      owner: runtime.taskId,
      kind,
      inputs,
      ...more,
    });

  const stepOf = readingStepInput;

  /** The keys a reading was given: those its read found (`at`), else its input's, when it has both. */
  const keysOf = (
    input: ReadingTaskInput,
    at?: { readonly keys?: Keys },
  ): Keys | undefined =>
    at?.keys ??
    (input.frameKey === undefined || input.mapKey === undefined
      ? undefined
      : { frame: input.frameKey, map: input.mapKey });

  /**
   * How the front task ended, as the finder reads it: a look, never a wait. Undefined while it has
   * not ended, and for a reading given no front task; its Frame and Map keys when it ended
   * (`completed`, or `aborted` with a result) holding both; null when it ended without one (null
   * keys, failed, faulted, orphaned, or stopped before it had them), or when there is no such task.
   */
  const frontKeys = async (
    input: ReadingTaskInput,
    runtime: Runtime,
    context: Context,
  ): Promise<Keys | null | undefined> => {
    if (input.front === undefined) return undefined;
    const front = await runtime.getTask(
      childId<FrontResult>(input.front),
      context,
    );
    if (front === undefined) return null;
    if (front.state.status !== "terminal") return undefined;
    const outcome = front.state.outcome;
    const result =
      outcome.status === "completed" || outcome.status === "aborted"
        ? outcome.result
        : undefined;
    const frame = result?.frameKey ?? null;
    const map = result?.mapKey ?? null;
    return frame === null || map === null ? null : { frame, map };
  };

  /**
   * How the reading's head gate ended (`headGateEndOf`), as a look, never a wait: `running` while it
   * has not ended; undefined for a reading given none, or when there is no such task.
   */
  const headGate = async (
    input: ReadingTaskInput,
    runtime: Runtime,
    context: Context,
  ): Promise<HeadGateEnd | "running" | undefined> => {
    if (input.relations === undefined) return undefined;
    const gate = await runtime.getTask(
      childId<RelationsResult>(input.relations),
      context,
    );
    if (gate === undefined) return undefined;
    if (gate.state.status !== "terminal") return "running";
    return headGateEndOf(gate.state.outcome);
  };

  /**
   * Ends a reading whose read never started because the front task ended with no Frame or Map:
   * every section not reached, never failed (nothing was wrong with the reading), with one skipped
   * record for the read it did not start.
   */
  const unreached = async (
    input: ReadingTaskInput,
    runtime: Runtime,
    context: Context,
  ) => {
    const plan = await readPlan(
      ctx,
      services.run,
      input.planKey,
      runtime.signal,
    );
    const result: ReadingTaskResult = {
      kind: input.kind,
      group: input.group,
      steps: [],
      claims: [],
      stages: [
        {
          stage: "verify",
          agent: `${input.kind}.${input.group}`,
          status: "skipped",
          wallMs: 0,
          note: "The reading did not start: the review has no Frame or Map for it.",
          disclosure: null,
        },
      ],
      notJudged: planGroup(plan, input.group).keys.map((section) => ({
        section,
        cause: "not-reached" as const,
      })),
      failures: [],
    };
    await runtime.commit(
      () => ({
        status: "terminal",
        outcome: { status: "completed", result: json(result) },
      }),
      context,
    );
  };

  /**
   * Creates the named children that do not exist yet, records them in the task's `ChildrenDoc` and
   * starts the wait, all in one commit; a phase that runs again finds them instead.
   */
  const start = async (
    runtime: Runtime,
    phase: string,
    children: ReadonlyArray<{
      readonly name: string;
      readonly input: AgentStepInput;
      readonly claimRegistration?: ClaimRegistration;
    }>,
    next: (ids: ReadonlyArray<number>) => ReadingCheckpoint,
    context: Context,
  ) => {
    const taskReview = children.some(
      (child) => child.claimRegistration !== undefined,
    )
      ? (await runtime.getTask(runtime.taskId, context))?.owner
      : undefined;
    if (
      children.some((child) => child.claimRegistration !== undefined) &&
      taskReview === undefined
    )
      throw new Error("A claim registration requires the native review owner");
    const ids: Array<number> = [];
    const created: Array<{ name: string; id: number }> = [];
    await logTimed(
      log,
      "harness.pi.commit",
      {
        "harness.task_id": runtime.taskId,
        "harness.task_kind": "reading",
        "harness.phase": phase,
        "harness.next_phase": "next",
      },
      () =>
        runtime.commit(async (tx) => {
          ids.length = 0;
          created.length = 0;
          const doc = await tx.doc(ChildrenDoc, runtime.taskId);
          for (const child of children) {
            const held = doc.children[child.name];
            if (held !== undefined) {
              ids.push(held);
              if (child.claimRegistration !== undefined)
                await registerClaim(
                  tx,
                  childId(taskReview!),
                  runtime.taskId,
                  child.claimRegistration,
                  held,
                );
              continue;
            }
            const prior =
              child.claimRegistration === undefined
                ? undefined
                : await findRegisteredClaim(
                    tx,
                    childId(taskReview!),
                    child.claimRegistration,
                  );
            if (
              prior?.verificationTask !== undefined &&
              prior.verificationTask !== null
            ) {
              await registerClaim(
                tx,
                childId(taskReview!),
                runtime.taskId,
                child.claimRegistration!,
                prior.verificationTask,
              );
              doc.children[child.name] = prior.verificationTask;
              ids.push(prior.verificationTask);
              continue;
            }
            const id = await tx.createTask(agentStep, child.input, {
              ownership: { kind: "task", taskId: runtime.taskId },
            });
            doc.children[child.name] = id;
            if (child.claimRegistration !== undefined)
              await registerClaim(
                tx,
                childId(taskReview!),
                runtime.taskId,
                child.claimRegistration,
                id,
              );
            ids.push(id);
            created.push({ name: child.name, id });
          }
          const checkpoint = next(ids);
          return ids.length === 0
            ? { status: "running", checkpoint }
            : {
                status: "waiting",
                on: ids.map((id) => childId<StageRecord>(id)),
                policy: "allSettled",
                checkpoint,
              };
        }, context),
    );
    // Which computations each new child reads, so a collector joins it with its producer's end.
    for (const child of created) {
      const input = children.find((c) => c.name === child.name)!.input;
      const params = input.params as Record<string, unknown>;
      startLogSpan(log, CHILD_STARTED_SPAN, {
        "harness.child": child.name,
        "harness.task_id": child.id,
        "harness.owner_task_id": runtime.taskId,
        "harness.asked_by": `${phase}-phase`,
      })();
      inputsOf(
        runtime,
        child.id,
        input.kind,
        Object.fromEntries(
          ["plan", "manifest", "frame", "map", "answer", "evidence"].flatMap(
            (name) =>
              typeof params[name] === "string"
                ? [[name, `computation:${params[name]}`]]
                : [],
          ),
        ),
        {
          child: child.name,
          askedBy: `${phase}-phase`,
          ...(typeof params["group"] === "string"
            ? { group: params["group"] }
            : {}),
        },
      );
    }
    if (ids.length > 0)
      waits.waiting(runtime.taskId, {
        "harness.task_id": runtime.taskId,
        "harness.task_kind": "reading",
        "harness.waiting_on": children.map((c) => c.name).join(","),
        "harness.waiting_on_ids": ids.join(","),
      });
    return created;
  };

  /**
   * What the reading's children add up to, from whichever of them exist: each section judged or
   * not (with its cause), the stored answers, the claims' checks and every child's record.
   */
  const gather = async (
    input: ReadingTaskInput,
    runtime: Runtime,
    context: Context,
    claims: ReadonlyArray<Claimed & { readonly task: number | null }>,
    /** Why a claim with no check was not started: the cut-off, or the run's stop. */
    unstarted?: "cutoff" | "stopped",
    /** The group's stored relation evidence its steps were shown. */
    evidence?: string,
  ): Promise<ReadingTaskResult> => {
    const why =
      unstarted ??
      (runtime.now() >= input.cutoffAt ? ("cutoff" as const) : "stopped");
    const plan = await readPlan(
      ctx,
      services.run,
      input.planKey,
      runtime.signal,
    );
    const keys = planGroup(plan, input.group).keys;
    const doc = await runtime.snapshot(ChildrenDoc, runtime.taskId, context);
    const held = doc?.children ?? {};
    const outcomeOf = async (id: number | undefined) =>
      id === undefined
        ? undefined
        : (await runtime.outcomes([childId<StageRecord>(id)], context))[0];
    const readOutcome = await outcomeOf(held["read"]);
    const rereadOutcome = await outcomeOf(held["reread"]);
    const first = await endOf(input.kind, readOutcome, runtime.signal);
    const second =
      held["reread"] === undefined
        ? undefined
        : await endOf(input.kind, rereadOutcome, runtime.signal);
    const notJudged: Array<ReadingTaskResult["notJudged"][number]> = [];
    const unansweredFirst =
      first.state === "stored"
        ? new Set(first.stored.unanswered)
        : new Set(keys);
    for (const section of keys) {
      if (first.state === "not-reached") {
        notJudged.push({ section, cause: "not-reached" });
        continue;
      }
      if (!unansweredFirst.has(section)) continue;
      if (second === undefined) {
        // The re-read was never started: the cut-off came first.
        notJudged.push({ section, cause: "not-reached" });
        continue;
      }
      if (second.state === "stored") {
        if (
          second.stored.sections.includes(section) &&
          !second.stored.unanswered.includes(section)
        )
          continue;
        notJudged.push({ section, cause: "failed" });
        continue;
      }
      notJudged.push({
        section,
        cause: second.state === "failed" ? "failed" : "not-reached",
      });
    }
    const claimRecords: Array<StageRecord | undefined> = [];
    for (const claim of claims)
      claimRecords.push(
        claim.task === null
          ? undefined
          : settledRecord(await outcomeOf(claim.task)),
      );
    return {
      kind: input.kind,
      group: input.group,
      steps: [first, second].flatMap((end) =>
        end?.state === "stored" ? [end.key] : [],
      ),
      claims: claims.map((claim, at) => {
        const record = claimRecords[at];
        return {
          key: claim.key,
          section: claim.section,
          verifyKey:
            record?.key !== undefined &&
            (record.status === "computed" || record.status === "reused")
              ? record.key
              : null,
          // Never started, or kept from starting or stopped at the cut-off: not reached. A check
          // that ran and failed was reached, and its claim stays unconfirmed.
          reached:
            claim.task !== null &&
            record?.status !== "skipped" &&
            record?.status !== "interrupted",
        };
      }),
      stages: [
        settledRecord(readOutcome),
        settledRecord(rereadOutcome),
        // A re-read the cut-off kept from starting reads as one, as a stage it kept from starting.
        ...(held["reread"] === undefined &&
        first.state !== "not-reached" &&
        notJudged.length > 0
          ? [
              {
                stage: "verify" as const,
                agent: `${input.kind}.${input.group}.reread`,
                status: "skipped" as const,
                wallMs: 0,
                note:
                  runtime.now() >= input.cutoffAt
                    ? "The re-read did not start before the review's cut-off."
                    : "The re-read did not start: the review was stopped first.",
                disclosure: null,
              },
            ]
          : []),
        ...claimRecords,
        // Claims whose checks were never started (the cut-off had passed, or the run stopped): one
        // skipped record for them, so the run reads as cut short and a later one checks them.
        ...(claims.some((claim) => claim.task === null)
          ? [
              {
                stage: "verify" as const,
                agent: `${input.kind}.${input.group}.claims`,
                status: "skipped" as const,
                wallMs: 0,
                note:
                  why === "cutoff"
                    ? "The checks of this reading's claims did not start before the review's cut-off."
                    : "The checks of this reading's claims did not start: the review was stopped first.",
                disclosure: null,
              },
            ]
          : []),
      ].flatMap((record) => (record === undefined ? [] : [record])),
      notJudged,
      failures: (
        [
          ["read", first],
          ["reread", second],
        ] as const
      ).flatMap(([part, end]) =>
        end?.state === "failed" ? [{ part, failure: end.failure }] : [],
      ),
      ...(evidence === undefined ? {} : { evidence }),
    };
  };

  /** A Lane review's distinct defect claims on the sections it judged, from its stored answers. */
  const claimsOf = async (
    input: ReadingTaskInput,
    runtime: Runtime,
    context: Context,
  ): Promise<Array<Claimed>> => {
    const claims: Array<Claimed> = [];
    if (input.kind !== "lane-review") return claims;
    const so = await gather(input, runtime, context, []);
    const notJudged = new Set(so.notJudged.map((entry) => entry.section));
    const plan = await readPlan(
      ctx,
      services.run,
      input.planKey,
      runtime.signal,
    );
    for (const key of so.steps) {
      const stored = await services.run(
        storedOutput(ctx, key, LaneReviewStored),
        runtime.signal,
      );
      if (stored.claims !== undefined) {
        for (const claim of stored.claims)
          if (!claims.some((held) => held.key === claim.key))
            claims.push({
              key: claim.key,
              section: claim.section ?? `unknown:${claim.key}`,
              answer: key,
              inline: claim,
              basis: {
                ...(claim.basis ?? {
                  producer: stored.by ?? null,
                  source: {
                    plan: input.planKey,
                    manifest: input.manifestKey,
                    frame: isAssignmentPlan(plan)
                      ? plan.source.frameKey
                      : (input.frameKey ?? null),
                    map: isAssignmentPlan(plan)
                      ? plan.source.mapKey
                      : (input.mapKey ?? null),
                    evidence: so.evidence ?? null,
                  },
                }),
                evidence: claim.evidence,
              },
            });
        continue;
      }
      const answered = new Set(
        stored.sections.filter((s) => !stored.unanswered.includes(s)),
      );
      for (const { key: section, outcome } of laneReviewOutcomes(stored, plan))
        if (outcome.judged && answered.has(section) && !notJudged.has(section))
          for (const comment of outcome.judgement.comments) {
            if (comment.kind !== "defect") continue;
            const claim = claimKey(comment);
            if (!claims.some((held) => held.key === claim))
              claims.push({ key: claim, section, answer: key });
          }
    }
    return claims;
  };

  const claimInput = claimStepInput;

  /**
   * Starts the read with the keys it is shown (a Lane review's; none for Assess) and the group's
   * relation evidence, decided here once for the group (`groupEvidence`: the first of its two
   * readings to get here decides, from what is stored now, and never waits for more; a reading
   * given the head gate gets here once it ended, and its end is recorded with the decision). Keys
   * that came from the front task's result, and the evidence, are kept in the checkpoint, so the
   * re-read and the claims' checks are shown the same.
   */
  const startRead = async (
    input: ReadingTaskInput,
    runtime: Runtime,
    keys: Keys | undefined,
    context: Context,
  ) => {
    const found =
      keys !== undefined && keysOf(input) === undefined ? keys : undefined;
    const gate = await headGate(input, runtime, context);
    const evidence = await groupEvidence(
      ctx,
      services.run,
      {
        planKey: input.planKey,
        group: input.group,
        manifestKey: input.manifestKey,
        ...(gate === undefined || gate === "running" ? {} : { gate }),
      },
      runtime.signal,
    );
    const created = await start(
      runtime,
      "read",
      [
        {
          name: "read",
          input: stepOf(
            input,
            "read",
            keys,
            undefined,
            evidence,
            runtime.taskId,
          ),
        },
      ],
      ([read]) => ({
        phase: "reread",
        read: read!,
        ...(found === undefined ? {} : { keys: found }),
        ...(evidence === undefined ? {} : { evidence }),
      }),
      context,
    );
    // What this reading reads: its plan and group, written once, by the phase run whose commit
    // started its read (the review's own row names the frame, map and manifest it was given), with
    // its group's evidence and the stored relations reads that evidence was decided from.
    if (created.length > 0) {
      const decided =
        evidence === undefined
          ? undefined
          : await readEvidence(
              ctx,
              services.run,
              evidence,
              runtime.signal,
            ).catch((error: unknown) => {
              if (runtime.signal.aborted) throw error;
              return undefined;
            });
      log.write({
        type: "task.inputs",
        taskId: runtime.taskId,
        kind: `reading.${input.kind}`,
        group: input.group,
        inputs: {
          plan: `computation:${input.planKey}`,
          manifest: `computation:${input.manifestKey}`,
          ...(keys === undefined
            ? {}
            : {
                frame: `computation:${keys.frame}`,
                map: `computation:${keys.map}`,
              }),
          ...(evidence === undefined
            ? {}
            : { evidence: `computation:${evidence}` }),
          // Only the head's read is read for rows; the decision records whether the base's was stored.
          ...(decided?.relations.head == null
            ? {}
            : { relations: `computation:${decided.relations.head}` }),
        },
      });
    }
  };

  /**
   * The read phase's work: start the read, or wait. Assess never waits for the front task: it only
   * looks, and stops when that task ended with no Frame or Map, since nothing it would read for can
   * then be published. A Lane review given no keys waits on the front task for them. With `gated`,
   * a reading given the head gate that has not ended waits on it first (`relations`), a Lane review
   * whose front task has not ended on both at once; with no gate, or one that ended, it reads as it
   * did before the gate. The `relations` phase runs it again with `gated` false.
   */
  const begin = async (
    input: ReadingTaskInput,
    runtime: Runtime,
    context: Context,
    gated: boolean,
  ): Promise<void> => {
    /** Commits the wait on the head gate (and `also`) when it has not ended; true when it did. */
    const waitForGate = async (
      also: ReadonlyArray<TaskId<FrontResult>>,
    ): Promise<boolean> => {
      if (!gated || input.relations === undefined) return false;
      if ((await headGate(input, runtime, context)) !== "running") return false;
      // The chain's decision is stored already (a follow-on run): it is what the group shows, so
      // waiting on this run's gate would gain nothing. Decide at once from it.
      if (await evidenceStored(ctx, services.run, input, runtime.signal))
        return false;
      const gate = childId<RelationsResult>(input.relations);
      // No poll and no timer: the gate's end (its bound at the latest) wakes this task.
      await logTimed(
        log,
        "harness.pi.commit",
        {
          "harness.task_id": runtime.taskId,
          "harness.task_kind": "reading",
          "harness.phase": "read",
          "harness.next_phase": "relations",
        },
        () =>
          runtime.commit(
            () => ({
              status: "waiting",
              checkpoint: { phase: "relations" },
              on: [...also, gate],
              policy: "allSettled",
            }),
            context,
          ),
      );
      waits.waiting(runtime.taskId, {
        "harness.task_id": runtime.taskId,
        "harness.task_kind": "reading",
        "harness.waiting_on":
          also.length === 0 ? "relations" : "front,relations",
        "harness.waiting_on_ids": [...also.map(Number), input.relations].join(
          ",",
        ),
      });
      return true;
    };
    if (input.kind === "assess") {
      if ((await frontKeys(input, runtime, context)) === null)
        return unreached(input, runtime, context);
      if (await waitForGate([])) return;
      return startRead(input, runtime, undefined, context);
    }
    const given = keysOf(input);
    if (given !== undefined) {
      if (await waitForGate([])) return;
      return startRead(input, runtime, given, context);
    }
    if (input.front === undefined) return unreached(input, runtime, context);
    const found = await frontKeys(input, runtime, context);
    if (found === null) return unreached(input, runtime, context);
    if (found !== undefined) {
      if (await waitForGate([])) return;
      return startRead(input, runtime, found, context);
    }
    // The front task has not ended: wait for it (not a child, as the finder does), with the gate
    // when there is one, then read with the keys its result holds. Its end wakes this task.
    const front = childId<FrontResult>(input.front);
    if (await waitForGate([front])) return;
    await logTimed(
      log,
      "harness.pi.commit",
      {
        "harness.task_id": runtime.taskId,
        "harness.task_kind": "reading",
        "harness.phase": gated ? "read" : "relations",
        "harness.next_phase": "front",
      },
      () =>
        runtime.commit(
          () => ({
            status: "waiting",
            checkpoint: { phase: "front" },
            on: [front],
            policy: "allSettled",
          }),
          context,
        ),
    );
    waits.waiting(runtime.taskId, {
      "harness.task_id": runtime.taskId,
      "harness.task_kind": "reading",
      "harness.waiting_on": "front",
      "harness.waiting_on_ids": String(input.front),
    });
  };

  return definePolicyTask<
    ReadingTaskInput,
    ReadingCheckpoint,
    ReadingTaskResult
  >({
    name: READING_TASK,
    // 2: a reading may carry the front task instead of the Frame and Map keys, and a Lane review
    // given it waits on it (the `front` phase). Every version-1 record is a version-2 one as it is.
    // The relation evidence (`evidence` in the checkpoint) is optional: a checkpoint without it is
    // one whose steps are shown none, as before, so the version stays.
    // 3: a reading may carry the head gate (`relations`) and waits on it before its read (the
    // `relations` phase). Every version-2 record is a version-3 one as it is: its input holds no
    // gate, so it resumes in the phase it was in and never waits on one.
    version: 3,
    migrate: (input, checkpoint) => ({
      input: input as unknown as ReadingTaskInput,
      checkpoint: checkpoint as unknown as ReadingCheckpoint,
    }),
    initial: () => ({ phase: "read" }),
    phases: {
      read: async (task, runtime, context) => {
        using phaseSpan = span(runtime, "read", task.input.kind);
        await begin(task.input, runtime, context, true);
      },
      // The head gate ended (and, for a Lane review that also waited on it, the front task): the
      // read starts as the `read` phase would start it, with no second wait on the gate.
      relations: async (task, runtime, context) => {
        using phaseSpan = span(runtime, "relations", task.input.kind);
        await begin(task.input, runtime, context, false);
      },
      front: async (task, runtime, context) => {
        using phaseSpan = span(runtime, "front", task.input.kind);
        const found = await frontKeys(task.input, runtime, context);
        // Ended with no Frame or Map: not reached. (Undefined cannot follow the wait; read as the
        // same, it never starts a read without both keys.)
        if (found === null || found === undefined)
          return unreached(task.input, runtime, context);
        await startRead(task.input, runtime, found, context);
      },
      reread: async (task, runtime, context) => {
        using phaseSpan = span(runtime, "reread", task.input.kind);
        const at = task.state.checkpoint;
        const [outcome] = await runtime.outcomes(
          [childId<StageRecord>(at.read)],
          context,
        );
        const end = await endOf(task.input.kind, outcome, runtime.signal);
        const plan = await readPlan(
          ctx,
          services.run,
          task.input.planKey,
          runtime.signal,
        );
        const keys = planGroup(plan, task.input.group).keys;
        // Read once more, alone, what the step left unanswered or lost to a failure; never a third time.
        const unanswered =
          end.state === "stored"
            ? keys.filter((key) => end.stored.unanswered.includes(key))
            : end.state === "failed"
              ? [...keys]
              : [];
        // An Assess task looks at the front task once more before the re-read, as before its read;
        // a Lane review has its keys already, from its input or from the read (`at.keys`).
        const unframed =
          unanswered.length > 0 &&
          task.input.kind === "assess" &&
          (await frontKeys(task.input, runtime, context)) === null;
        const later =
          unanswered.length > 0 &&
          !unframed &&
          runtime.now() < task.input.cutoffAt
            ? [
                {
                  name: "reread",
                  input: stepOf(
                    task.input,
                    "reread",
                    keysOf(task.input, at),
                    unanswered,
                    at.evidence,
                    runtime.taskId,
                  ),
                },
              ]
            : [];
        await start(
          runtime,
          "reread",
          later,
          ([reread]) => ({
            phase: "claims",
            read: at.read,
            reread: reread ?? null,
            ...(at.evidence === undefined ? {} : { evidence: at.evidence }),
          }),
          context,
        );
      },
      claims: async (task, runtime, context) => {
        using phaseSpan = span(runtime, "claims", task.input.kind);
        const at = task.state.checkpoint;
        const claims = await claimsOf(task.input, runtime, context);
        // Past the cut-off no check is started: those claims are recorded as not reached.
        const late = runtime.now() >= task.input.cutoffAt;
        const existing =
          (await runtime.snapshot(ChildrenDoc, runtime.taskId, context))
            ?.children ?? {};
        await start(
          runtime,
          "claims",
          late
            ? []
            : claims.map((claim) => ({
                name: `claim.${claim.key}`,
                input: claimInput(task.input, claim, at.evidence),
                ...(claim.inline === undefined
                  ? {}
                  : {
                      claimRegistration: comprehensiveClaimRegistration(
                        task.input.group,
                        claim.inline,
                        claim.basis ?? {},
                      ),
                    }),
              })),
          (ids) => ({
            phase: "done",
            read: at.read,
            reread: at.reread,
            ...(at.evidence === undefined ? {} : { evidence: at.evidence }),
            claims: claims.map((claim, index) => ({
              ...claim,
              task: late
                ? (existing[`claim.${claim.key}`] ?? null)
                : ids[index]!,
            })),
            ...(late ? { late: true } : {}),
          }),
          context,
        );
      },
      done: async (task, runtime, context) => {
        using phaseSpan = span(runtime, "done", task.input.kind);
        const result = await gather(
          task.input,
          runtime,
          context,
          task.state.checkpoint.claims,
          task.state.checkpoint.late === true ? "cutoff" : undefined,
          task.state.checkpoint.evidence,
        );
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result: json(result) },
          }),
          context,
        );
      },
    },
    // Stopped (the cut-off, or the run stopped): what was collected so far, never a failure.
    abort: async (task, runtime, context) => {
      waits.resumed(runtime.taskId);
      const at = task.state.checkpoint;
      // Claims a Lane review made whose checks were never started are not reached.
      const held =
        (await runtime.snapshot(ChildrenDoc, runtime.taskId, context))
          ?.children ?? {};
      const claims =
        at.phase === "done"
          ? at.claims
          : (await claimsOf(task.input, runtime, context)).map((claim) => ({
              ...claim,
              task: held[`claim.${claim.key}`] ?? null,
            }));
      const result = await gather(
        task.input,
        runtime,
        context,
        claims,
        undefined,
        at.phase === "reread" || at.phase === "claims" || at.phase === "done"
          ? at.evidence
          : undefined,
      );
      const reason =
        runtime.now() >= task.input.cutoffAt ? "cutoff" : "stopped";
      await runtime.commit(
        () => ({
          status: "terminal",
          outcome: { status: "aborted", reason, result: json(result) },
        }),
        context,
      );
    },
  });
};

export type ReadingTask = ReturnType<typeof readingTask>;
