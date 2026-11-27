import { copyJson, type Context } from "@earendil-works/chord";
import {
  type Task,
  type TaskId,
  type TaskOutcome,
  type TaskRuntime,
} from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { Frame } from "../../frame.ts";
import { rangeCommitFiles } from "../../git.ts";
import { logTimed, scopedLogSpan, waitSpans } from "../../log-span.ts";
import { storedOutput, type StageRecord } from "../../pipeline.ts";
import { ReviewMap } from "../../review-map.ts";
import type { RouteEffort } from "../../route.ts";
import type { AssessJudgement } from "../../readings/answers.ts";
import {
  BRIEFING_START_MARGIN_MS,
  BriefingStored,
  batchOfSections,
  briefingContextOf,
  briefingLayout,
  briefingStep,
  digestMaterial,
  partMaterial,
} from "../../readings/briefing.ts";
import type { ReadingPlan } from "../../readings/plan.ts";
import {
  AssessStored,
  assessOutcomes,
  type ReadingProducer,
} from "../../readings/steps.ts";
import type { GroupEvidence } from "../../readings/evidence.ts";
import { batchKeyOf } from "../../publish-sections-input.ts";
import { definePolicyTask } from "../failure-policy.ts";
import { erased, type AgentStep } from "./agent.ts";
import type { AgentStepCheckpoint, AgentStepInput } from "./agent-step.ts";
import { childId, resultOf } from "./children.ts";
import { ChildrenDoc } from "./docs.ts";
import type { FrontResult } from "./front-task.ts";
import {
  failureLabel,
  readEvidence,
  readManifest,
  readPlan,
  remembered,
  structuresRead,
  type ReadingTaskResult,
} from "./reading-task.ts";
import type { KindParams } from "./run.ts";
import type { StageServices } from "./services.ts";

/**
 * The briefing of one reading group (NEU-148 round 27, `design/readers-briefings.md`): one durable
 * task, `brief.<group>`, that `create` makes beside the group's Assess and Lane review, owned by the
 * review. It waits durably on the front task (for the Frame and the Map) and its own group's Assess
 * only, independently of Lane review and Verify; then starts every part of the group at
 * once as child agent steps (`readings/briefing.ts`), with the digests of batches only its group
 * holds. The digests of batches it shares with other groups and owns are a second task of the same
 * kind, `digest.<group>` (`role` `digests`), which waits on the holding groups' Assess alone and
 * which only those batches wait on: a batch of one group never waits on another group's work.
 * It always ends `completed` (or `aborted` at the cut-off), never failed: a briefing that
 * failed leaves code's text and a gap, never a held batch. Its result names stored computations
 * only; it carries no model text.
 *
 * No model call starts within `BRIEFING_START_MARGIN_MS` of the cut-off: a late wake still makes
 * every call's step, with a cut-off already past, so a step whose key is stored reuses it and one
 * with nothing stored is skipped, not reached, and the collector handles it as cut.
 */

export const BRIEFING_TASK = "neuve.briefing";

export type BriefingTaskInput = {
  readonly planKey: string;
  readonly group: string;
  /** The group's risk rank: its calls queue as readings by it. */
  readonly rank: number;
  readonly manifestKey: string;
  readonly cutoffAt: number;
  /** The Frame and Map keys, when the readings were created after they landed. */
  readonly frameKey?: string | undefined;
  readonly mapKey?: string | undefined;
  /** The front task that makes them, when the readings were created before (not a child). */
  readonly front?: number | undefined;
  /** Every reading group's Assess task, by group ID, all made in the same commit (not children). */
  readonly assess: Readonly<Record<string, number>>;
  /** The effort its calls run at (`readingStepEffort`, kind `brief`). */
  readonly effort?: RouteEffort | undefined;
  /**
   * `parts` (`brief.<group>`, the default): the group's parts and the digests only it holds.
   * `digests` (`digest.<group>`): the digests of batches it shares with other groups that it owns,
   * which only those batches wait on, so a batch of this group alone never waits on another group.
   * It makes one child task per such batch, `batch` (its own `role`), which waits on that batch's
   * holding groups' Assess alone and then makes the batch's digest call, so each digest starts as
   * soon as its own batch's Assess have settled, never on another batch's.
   */
  readonly role?: "parts" | "digests" | "batch" | undefined;
  /** Role `batch` only: the Map group (batch) whose shared digest it writes. */
  readonly batch?: string | undefined;
};

/**
 * The digest calls one task of a group makes: the briefing (`parts`) those of batches only its
 * group holds; the digest task (`digests`) those of batches it shares, which it owns.
 */
export const ownedDigests = (
  layout: ReturnType<typeof briefingLayout>,
  group: string,
  role: "parts" | "digests",
) =>
  [...layout.digests].flatMap(([batch, owner]) =>
    owner.kind === "call" &&
    owner.group === group &&
    (role === "digests") === owner.groups.length > 1
      ? [{ batch, groups: owner.groups }]
      : [],
  );

/** The digest calls a task makes itself: a `batch` task its one batch's, else by its role. */
const ownedOf = (
  layout: ReturnType<typeof briefingLayout>,
  input: Pick<BriefingTaskInput, "group" | "role" | "batch">,
) =>
  input.role === "batch"
    ? ownedDigests(layout, input.group, "digests").filter(
        (owned) => owned.batch === input.batch,
      )
    : ownedDigests(layout, input.group, input.role ?? "parts");

/** One call the briefing planned, by its child's name. */
export interface PlannedCall {
  readonly name: string;
  readonly call: "part" | "digest";
  /** The Map group (batch) it writes for. */
  readonly batch: string;
  /** A part's sections; empty for a digest call. */
  readonly sections: ReadonlyArray<string>;
  /** A part that also writes its batch's digest. */
  readonly digest: boolean;
}

export type BriefingTaskResult = {
  readonly group: string;
  /** Every call the briefing planned, with how it ended. */
  readonly calls: ReadonlyArray<
    PlannedCall & {
      /** The stored output; null when none was stored. */
      readonly key: string | null;
      /** `not-reached`: never started (the cut-off), skipped or interrupted. */
      readonly state: "stored" | "failed" | "not-reached";
      /** A failed call's kind of failure, a label (`failureLabel`). */
      readonly failure?: string;
    }
  >;
  readonly stages: ReadonlyArray<StageRecord>;
  /** The front task ended with no Frame or Map: nothing was planned. */
  readonly unframed?: boolean;
};

type Keys = { readonly frame: string; readonly map: string };

type BriefingCheckpoint =
  | { readonly phase: "wait" }
  | {
      readonly phase: "digests";
      readonly keys: Keys;
      readonly planned: ReadonlyArray<PlannedCall>;
      readonly late: boolean;
    }
  | {
      readonly phase: "end";
      readonly planned: ReadonlyArray<PlannedCall>;
      readonly late: boolean;
    };

type Runtime = TaskRuntime<
  BriefingTaskInput,
  BriefingCheckpoint,
  BriefingTaskResult,
  object
>;

type AgentStepTask = Task<
  AgentStepInput,
  AgentStepCheckpoint,
  StageRecord,
  object
>;

type Ctx = StageServices["ctx"];
type Run = StageServices["run"];

const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** A terminal task's result when it completed or was aborted with one. */
const resultOfTask = <R>(outcome: TaskOutcome<R> | undefined) =>
  outcome?.status === "completed" || outcome?.status === "aborted"
    ? outcome.result
    : undefined;

/** Each section's Assess judgement from the stored Assess outputs named, judged sections only. */
const assessOf = async (
  ctx: Ctx,
  run: Run,
  plan: ReadingPlan,
  keys: ReadonlyArray<string>,
  signal?: AbortSignal,
): Promise<Map<string, AssessJudgement | undefined>> => {
  const out = new Map<string, AssessJudgement | undefined>();
  for (const key of keys) {
    const stored = await run(storedOutput(ctx, key, AssessStored), signal);
    for (const { key: section, outcome } of assessOutcomes(stored, plan))
      if (outcome.judged) out.set(section, outcome.judgement);
  }
  return out;
};

/** The batch's files, as the publisher keys it: its Map group's files less the excluded ones. */
const batchPaths = (map: ReviewMap, batch: string) => {
  const excluded = new Set(map.excluded.map((e) => e.path));
  return (map.groups.find((g) => g.id === batch)?.files ?? [])
    .map((file) => file.path)
    .filter((path) => !excluded.has(path));
};

/**
 * The agent of one briefing step, from its durable parameters (run.ts): a part over the group's
 * stored plan and its Assess outputs, or a batch's digest over every holding group's, with their
 * relation evidence and the range's commit subjects.
 */
export const briefingAgent = async (
  ctx: Ctx,
  run: Run,
  params: KindParams<"brief">,
  signal?: AbortSignal,
): Promise<AgentStep<unknown, unknown>> => {
  const plan = await readPlan(ctx, run, params.plan, signal);
  const manifest = await readManifest(ctx, run, params.manifest, signal);
  const hunks = new Map(manifest.hunks.map((hunk) => [hunk.hunkId, hunk]));
  const frame = await run(storedOutput(ctx, params.frame, Frame), signal);
  const map = await run(storedOutput(ctx, params.map, ReviewMap), signal);
  const mapGroup = map.groups.find((g) => g.id === params.batch);
  if (mapGroup === undefined)
    throw new Error(`The review's map has no group ${params.batch}`);
  const context = briefingContextOf(frame, mapGroup);
  const assess = await assessOf(ctx, run, plan, params.assess, signal);
  const by: ReadingProducer = {
    review: ctx.runKey,
    run: ctx.runId,
    cycle: ctx.cycleId,
    head: ctx.range.headOid,
  };
  const paths = batchPaths(map, params.batch);
  if (params.call === "part") {
    const { structures } = await structuresRead(
      ctx,
      run,
      params.manifest,
      signal,
    );
    // The group's stored relation evidence (round 27b): its confirmed caller rows into the batch's
    // other read sections become the sections' linked lines.
    const [evidenceKey] = params.evidence ?? [];
    const batchOf = batchOfSections(plan, map.groups);
    const material = partMaterial({
      plan,
      group: params.group,
      part: { sections: params.sections, digest: params.digest === true },
      hunks,
      structures,
      context,
      assess,
      evidence:
        evidenceKey === undefined
          ? undefined
          : await readEvidence(ctx, run, evidenceKey, signal),
      batchSections: plan.sections
        .filter((section) => batchOf.get(section.key) === params.batch)
        .map((section) => section.key),
    });
    return erased(
      briefingStep({
        stage: "verify",
        call: "part",
        group: params.group,
        batch: batchKeyOf(paths),
        material,
        hunks,
        by,
        effort: params.effort,
      }),
    );
  }
  const batchOf = batchOfSections(plan, map.groups);
  const evidence: Array<GroupEvidence> = [];
  for (const key of params.evidence ?? [])
    evidence.push(await readEvidence(ctx, run, key, signal));
  const log = await remembered(
    ctx,
    `commits:${manifest.range.mergeBase}:${manifest.range.headOid}`,
    (shared) =>
      run(
        rangeCommitFiles(
          ctx.repository,
          manifest.range.mergeBase,
          manifest.range.headOid,
        ).pipe(Effect.catch(() => Effect.succeed(undefined))),
        shared,
      ),
    signal,
  );
  const material = digestMaterial({
    plan,
    sections: plan.sections
      .filter((section) => batchOf.get(section.key) === params.batch)
      .map((section) => section.key),
    paths,
    hunks,
    context,
    assess,
    evidence,
    commits: (log?.commits ?? []).map((commit) => ({
      oid: commit.oid,
      subject: commit.subject,
      files: log?.files.get(commit.oid) ?? [],
    })),
  });
  return erased(
    briefingStep({
      stage: "verify",
      call: "digest",
      group: params.group,
      material,
      hunks,
      by,
      effort: params.effort,
    }),
  );
};

export const briefingTask = (
  services: StageServices,
  agentStep: AgentStepTask,
) => {
  const { ctx } = services;
  const log = ctx.log;
  const waits = waitSpans(log);
  const span = (runtime: Runtime, phase: string) => {
    waits.resumed(runtime.taskId);
    return scopedLogSpan(log, "harness.pi.phase", {
      "harness.task_id": runtime.taskId,
      "harness.phase": phase,
      "harness.task_kind": "briefing",
    });
  };

  /** A task's outcome when it is terminal; undefined while it runs or when there is none. */
  const ended = async <R>(
    runtime: Runtime,
    id: number,
    context: Context,
  ): Promise<{ readonly outcome: TaskOutcome<R> | undefined } | undefined> => {
    const task = await runtime.getTask(childId<R>(id), context);
    if (task === undefined) return { outcome: undefined };
    if (task.state.status !== "terminal") return undefined;
    return { outcome: task.state.outcome as TaskOutcome<R> };
  };

  /** The Frame and Map keys: given, or the front task's; null when it ended with none. */
  const keysOf = async (
    input: BriefingTaskInput,
    runtime: Runtime,
    context: Context,
  ): Promise<Keys | null | undefined> => {
    if (input.frameKey !== undefined && input.mapKey !== undefined)
      return { frame: input.frameKey, map: input.mapKey };
    if (input.front === undefined) return null;
    const front = await ended<FrontResult>(runtime, input.front, context);
    if (front === undefined) return undefined;
    const result = resultOfTask(front.outcome);
    const frame = result?.frameKey ?? null;
    const map = result?.mapKey ?? null;
    return frame === null || map === null ? null : { frame, map };
  };

  /** A group's Assess result: its stored steps and evidence; none when it ended with none. */
  const assessResult = async (
    input: BriefingTaskInput,
    group: string,
    runtime: Runtime,
    context: Context,
  ) => {
    const id = input.assess[group];
    if (id === undefined) return { steps: [], evidence: undefined };
    const held = await ended<ReadingTaskResult>(runtime, id, context);
    const result = resultOfTask(held?.outcome);
    return { steps: [...(result?.steps ?? [])], evidence: result?.evidence };
  };

  const stepInput = (
    input: BriefingTaskInput,
    keys: Keys,
    /** The step's cut-off: the run's, or one already past for a late wake (stored outputs only). */
    cutoffAt: number,
    params: Omit<
      KindParams<"brief">,
      "plan" | "group" | "rank" | "manifest" | "frame" | "map" | "effort"
    >,
  ): AgentStepInput => ({
    kind: "brief",
    params: copyJson({
      ...params,
      plan: input.planKey,
      group: input.group,
      rank: input.rank,
      manifest: input.manifestKey,
      frame: keys.frame,
      map: keys.map,
      ...(input.effort === undefined ? {} : { effort: input.effort }),
    } as KindParams<"brief">),
    cutoffAt,
  });

  /** Creates the named children that do not exist yet and commits the next checkpoint and wait. */
  const start = async (
    runtime: Runtime,
    phase: string,
    children: ReadonlyArray<
      | { readonly name: string; readonly input: AgentStepInput }
      /** A digest task's per-batch child: a briefing task of role `batch`. */
      | { readonly name: string; readonly batch: BriefingTaskInput }
    >,
    /** Tasks that are not children, also waited on (other groups' Assess). */
    others: ReadonlyArray<number>,
    /**
     * What the task waits on besides `others`: every child it holds (`all`), or none (`none`), so a
     * digest waiting for other groups' Assess never waits on this group's parts, which run beside it.
     */
    wait: "all" | "none",
    next: BriefingCheckpoint,
    context: Context,
  ) => {
    const ids: Array<number> = [];
    await logTimed(
      log,
      "harness.pi.commit",
      {
        "harness.task_id": runtime.taskId,
        "harness.task_kind": "briefing",
        "harness.phase": phase,
        "harness.next_phase": next.phase,
      },
      () =>
        runtime.commit(async (tx) => {
          ids.length = 0;
          const doc = await tx.doc(ChildrenDoc, runtime.taskId);
          for (const child of children) {
            if (doc.children[child.name] !== undefined) continue;
            const ownership = {
              ownership: { kind: "task" as const, taskId: runtime.taskId },
            };
            doc.children[child.name] =
              "batch" in child
                ? await tx.createTask(self!, child.batch, ownership)
                : await tx.createTask(agentStep, child.input, ownership);
          }
          if (wait === "all") ids.push(...Object.values(doc.children));
          const on = [...ids, ...others].map((id) => childId<unknown>(id));
          return on.length === 0
            ? { status: "running", checkpoint: next }
            : {
                status: "waiting",
                on,
                policy: "allSettled",
                checkpoint: next,
              };
        }, context),
    );
    if (ids.length + others.length > 0)
      waits.waiting(runtime.taskId, {
        "harness.task_id": runtime.taskId,
        "harness.task_kind": "briefing",
        "harness.waiting_on": phase,
        "harness.waiting_on_ids": [...ids, ...others].join(","),
      });
  };

  /** The digest calls' children: each owned batch's, shown every holding group's Assess. */
  const digestChildren = async (
    input: BriefingTaskInput,
    keys: Keys,
    planned: ReadonlyArray<PlannedCall>,
    holders: ReadonlyMap<string, ReadonlyArray<string>>,
    cutoffAt: number,
    runtime: Runtime,
    context: Context,
  ) => {
    const out: Array<{ name: string; input: AgentStepInput }> = [];
    for (const call of planned.filter((c) => c.call === "digest")) {
      const groups = holders.get(call.batch) ?? [];
      // Only once every holding group's Assess has ended (a late wake may come before): one that
      // has not is not reached, and the digest is cut.
      let ready = true;
      for (const group of groups) {
        const id = input.assess[group];
        if (
          id !== undefined &&
          (await ended(runtime, id, context)) === undefined
        )
          ready = false;
      }
      if (!ready) continue;
      const steps: Array<string> = [];
      const evidence: Array<string> = [];
      for (const group of groups) {
        const held = await assessResult(input, group, runtime, context);
        steps.push(...held.steps);
        if (held.evidence !== undefined && !evidence.includes(held.evidence))
          evidence.push(held.evidence);
      }
      out.push({
        name: call.name,
        input: stepInput(input, keys, cutoffAt, {
          call: "digest",
          batch: call.batch,
          sections: [],
          assess: steps,
          evidence,
        }),
      });
    }
    return out;
  };

  /** What the planned calls came to, from whichever children exist. */
  const gather = async (
    input: BriefingTaskInput,
    runtime: Runtime,
    planned: ReadonlyArray<PlannedCall>,
    context: Context,
  ): Promise<BriefingTaskResult> => {
    const doc = await runtime.snapshot(ChildrenDoc, runtime.taskId, context);
    const held = doc?.children ?? {};
    const calls: Array<BriefingTaskResult["calls"][number]> = [];
    const stages: Array<StageRecord> = [];
    for (const call of planned) {
      const id = held[call.name];
      if (id === undefined) {
        calls.push({ ...call, key: null, state: "not-reached" });
        continue;
      }
      // A digest task's child is a `batch` task: its one call, as that task gathered it.
      if (input.role === "digests") {
        const [outcome] = await runtime.outcomes(
          [childId<BriefingTaskResult>(id)],
          context,
        );
        const result =
          outcome?.status === "completed" || outcome?.status === "aborted"
            ? outcome.result
            : undefined;
        const own = result?.calls.find((c) => c.batch === call.batch);
        stages.push(...(result?.stages ?? []));
        calls.push(
          own !== undefined
            ? { ...own, name: call.name }
            : {
                ...call,
                key: null,
                state:
                  outcome === undefined || outcome.status === "aborted"
                    ? "not-reached"
                    : "failed",
                ...(outcome === undefined || outcome.status === "aborted"
                  ? {}
                  : { failure: failureLabel(outcome) }),
              },
        );
        continue;
      }
      const [outcome] = await runtime.outcomes(
        [childId<StageRecord>(id)],
        context,
      );
      if (
        outcome === undefined ||
        outcome.status === "failed" ||
        outcome.status === "faulted" ||
        outcome.status === "orphaned"
      ) {
        calls.push({
          ...call,
          key: null,
          state: outcome === undefined ? "not-reached" : "failed",
          ...(outcome === undefined ? {} : { failure: failureLabel(outcome) }),
        });
        continue;
      }
      const record = resultOf(outcome);
      if (record !== undefined) stages.push(record);
      const stored =
        record?.key !== undefined &&
        (record.status === "computed" || record.status === "reused");
      calls.push({
        ...call,
        key: stored ? record!.key! : null,
        state: stored
          ? "stored"
          : record === undefined ||
              record.status === "skipped" ||
              record.status === "interrupted"
            ? "not-reached"
            : "failed",
      });
    }
    return { group: input.group, calls, stages };
  };

  const finish = async (
    runtime: Runtime,
    result: BriefingTaskResult,
    context: Context,
  ) =>
    runtime.commit(
      () => ({
        status: "terminal",
        outcome: { status: "completed", result: json(result) },
      }),
      context,
    );

  // The task itself, so a digest task can make its per-batch children of the same kind.
  let self:
    | Task<BriefingTaskInput, BriefingCheckpoint, BriefingTaskResult, object>
    | undefined;
  const made = definePolicyTask<
    BriefingTaskInput,
    BriefingCheckpoint,
    BriefingTaskResult
  >({
    name: BRIEFING_TASK,
    // 2: a digest task's children are per-batch briefing tasks (role `batch`), whose results are
    // `BriefingTaskResult`s, where a version-1 digest task's were agent steps' `StageRecord`s; and a
    // part's step is given its group's relation evidence. No migration: a version-1 task is never
    // resumed into this shape. The scheduler holds it as `migration_failed`, and when the review's
    // stop or cut-off aborts it, ends it `orphaned`; the collector reads that as a failed briefing,
    // so code's text stands with a `briefing-failed` gap. A new review makes version-2 tasks.
    version: 2,
    initial: () => ({ phase: "wait" }),
    phases: {
      // Wait on the front task, and for the parts the group's own Assess (neither a child), then
      // plan and start every part at once; a digest whose groups' Assess has not ended waits on
      // those alone while the parts run.
      wait: async (task, runtime, context) => {
        using phaseSpan = span(runtime, "wait");
        const { input } = task;
        const role = input.role ?? "parts";
        const keys = await keysOf(input, runtime, context);
        if (keys === null)
          return finish(
            runtime,
            { group: input.group, calls: [], stages: [], unframed: true },
            context,
          );
        const own = input.assess[input.group];
        const ownEnded =
          role !== "parts" ||
          own === undefined ||
          (await ended<ReadingTaskResult>(runtime, own, context)) !== undefined;
        if (keys === undefined || !ownEnded) {
          const on = [
            ...(keys === undefined && input.front !== undefined
              ? [input.front]
              : []),
            ...(!ownEnded && own !== undefined ? [own] : []),
          ];
          await runtime.commit(
            () => ({
              status: "waiting",
              on: on.map((id) => childId<unknown>(id)),
              policy: "allSettled",
              checkpoint: { phase: "wait" },
            }),
            context,
          );
          waits.waiting(runtime.taskId, {
            "harness.task_id": runtime.taskId,
            "harness.task_kind": "briefing",
            "harness.waiting_on": "front,assess",
            "harness.waiting_on_ids": on.join(","),
          });
          return;
        }
        const plan = await readPlan(
          ctx,
          services.run,
          input.planKey,
          runtime.signal,
        );
        const map = await services.run(
          storedOutput(ctx, keys.map, ReviewMap),
          runtime.signal,
        );
        const layout = briefingLayout(plan, map.groups);
        // A digest task makes one `batch` child per shared batch it owns, and waits on them all.
        if (role === "digests") {
          const owned = ownedDigests(layout, input.group, "digests");
          return start(
            runtime,
            "wait",
            owned.map(({ batch }) => ({
              name: `digest.${batch}`,
              batch: { ...input, role: "batch", batch },
            })),
            [],
            "all",
            {
              phase: "end",
              planned: owned.map(({ batch }) => ({
                name: `digest.${batch}`,
                call: "digest" as const,
                batch,
                sections: [],
                digest: true,
              })),
              late: false,
            },
            context,
          );
        }
        const parts =
          role === "parts" ? (layout.parts.get(input.group) ?? []) : [];
        const owned = ownedOf(layout, input);
        const planned: Array<PlannedCall> = [
          ...parts.map((part, at) => ({
            name: `part.${at}`,
            call: "part" as const,
            batch: part.batch,
            sections: [...part.sections],
            digest: part.digest,
          })),
          ...owned.map(({ batch }) => ({
            name: `digest.${batch}`,
            call: "digest" as const,
            batch,
            sections: [],
            digest: true,
          })),
        ];
        const late = runtime.now() >= input.cutoffAt - BRIEFING_START_MARGIN_MS;
        // Late, every call is still made, with a cut-off already past: its step finds a stored
        // output by its key and reuses it, and one with none stored is skipped, never sent.
        const cutoffAt = late
          ? input.cutoffAt - BRIEFING_START_MARGIN_MS
          : input.cutoffAt;
        const ownAssess =
          role === "parts"
            ? await assessResult(input, input.group, runtime, context)
            : { steps: [], evidence: undefined };
        const partChildren = parts.map((part, at) => ({
          name: `part.${at}`,
          input: stepInput(input, keys, cutoffAt, {
            call: "part",
            batch: part.batch,
            sections: [...part.sections],
            ...(part.digest ? { digest: true } : {}),
            assess: ownAssess.steps,
            // The group's relation evidence (round 27b): its links in the batch.
            ...(ownAssess.evidence === undefined
              ? {}
              : { evidence: [ownAssess.evidence] }),
          }),
        }));
        // The Assess a digest needs that has not ended: waited on alone, never on the parts.
        const needed: Array<number> = [];
        for (const { groups } of owned)
          for (const group of groups) {
            const id = input.assess[group];
            if (
              id !== undefined &&
              !needed.includes(id) &&
              (await ended(runtime, id, context)) === undefined
            )
              needed.push(id);
          }
        if (late || needed.length === 0) {
          const digests = await digestChildren(
            input,
            keys,
            planned,
            new Map(owned.map((o) => [o.batch, o.groups])),
            cutoffAt,
            runtime,
            context,
          );
          return start(
            runtime,
            "wait",
            [...partChildren, ...digests],
            [],
            "all",
            { phase: "end", planned, late },
            context,
          );
        }
        await start(
          runtime,
          "wait",
          partChildren,
          needed,
          // The Assess alone: the parts run meanwhile, and the digest starts beside them.
          "none",
          { phase: "digests", keys, planned, late },
          context,
        );
      },
      // Every Assess a digest needs has ended: start the digests, then wait on all.
      digests: async (task, runtime, context) => {
        using phaseSpan = span(runtime, "digests");
        const at = task.state.checkpoint;
        const plan = await readPlan(
          ctx,
          services.run,
          task.input.planKey,
          runtime.signal,
        );
        const map = await services.run(
          storedOutput(ctx, at.keys.map, ReviewMap),
          runtime.signal,
        );
        const owned = ownedOf(briefingLayout(plan, map.groups), task.input);
        const late =
          at.late ||
          runtime.now() >= task.input.cutoffAt - BRIEFING_START_MARGIN_MS;
        const digests = await digestChildren(
          task.input,
          at.keys,
          at.planned,
          new Map(owned.map((o) => [o.batch, o.groups])),
          late
            ? task.input.cutoffAt - BRIEFING_START_MARGIN_MS
            : task.input.cutoffAt,
          runtime,
          context,
        );
        await start(
          runtime,
          "digests",
          digests,
          [],
          "all",
          { phase: "end", planned: at.planned, late },
          context,
        );
      },
      end: async (task, runtime, context) => {
        using phaseSpan = span(runtime, "end");
        const result = await gather(
          task.input,
          runtime,
          task.state.checkpoint.planned,
          context,
        );
        await finish(runtime, result, context);
      },
    },
    // Stopped (the cut-off, or the run stopped): what was stored so far, never a failure.
    abort: async (task, runtime, context) => {
      waits.resumed(runtime.taskId);
      const at = task.state.checkpoint;
      const result =
        at.phase === "wait"
          ? { group: task.input.group, calls: [], stages: [] }
          : await gather(task.input, runtime, at.planned, context);
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
  self = made as unknown as typeof self;
  return made;
};

export type BriefingTask = ReturnType<typeof briefingTask>;

/** A briefing task's ID, as `create` holds it. */
export type BriefingTaskId = TaskId<BriefingTaskResult>;

export { BriefingStored };
