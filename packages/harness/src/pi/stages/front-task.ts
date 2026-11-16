import { copyJson, type Context } from "@earendil-works/chord";
import type { Task, TaskId, TaskRuntime, Tx } from "@earendil-works/pi-durable";
import {
  findDeadline,
  MIN_FIND_WINDOW_MS,
  VERIFY_RESERVE_MS,
} from "../../budget.ts";
import { FINDERS, type Lens } from "../../find.ts";
import type {
  FinderCheckpoint,
  FinderInput,
  FinderResult,
} from "./finder-task.ts";
import { Effect } from "effect";
import {
  checkSources,
  judgeChecks,
  noFreshness,
  settleFreshness,
  type ChangeToJudge,
  type Freshness,
} from "../../freshness.ts";
import { Frame } from "../../frame.ts";
import { MapManifest } from "../../review-map.ts";
import {
  codeStage,
  ScopeChangeStored,
  lookupContext,
  storedOutput,
  recordStageStart,
  type StageRecord,
} from "../../pipeline.ts";
import { prewarmSearch } from "../../retrievers.ts";
import { zeroUsage, credentialName } from "../../route.ts";
import { freezeSnapshot, type Stratum } from "../../scope.ts";
import { scopeOf } from "../../lookups.ts";
import { logTimed, scopedLogSpan, waitSpans } from "../../log-span.ts";
import { RunControlDoc, composeOnAbort } from "../control.ts";
import { definePolicyTask as defineTask } from "../failure-policy.ts";
import type { AgentStepCheckpoint, AgentStepInput } from "./agent-step.ts";
import type { AgentStep } from "./agent.ts";
import { childId, failureOf, outcomeOf, resultOf, spawn } from "./children.ts";
import { ChildrenDoc, RunSetupDoc } from "./docs.ts";
import { stepInput, type RunSetup, type StageRun } from "./run.ts";
import { wireTool } from "./tools.ts";
import type { ToolSpec } from "../../toolkit.ts";
import type { StageServices } from "./services.ts";
import { frameStep, mapStep, mapManifestStage } from "./front-steps.ts";

export const FRONT_TASK = "neuve.front";
export type FrontInput = {
  readonly cutoffAt: number;
  readonly precompute: string;
};
/** The finders the front task started when Frame landed, owned by the review task. */
export type StartedFinders = {
  /** The start rule as measured when they were created (`MIN_FIND_WINDOW_MS`, `findDeadline`). */
  readonly start: number;
  readonly deadline: number;
  /** False when too little time remained: none started, and the review discloses it. */
  readonly started: boolean;
  readonly finders: ReadonlyArray<{
    readonly lens: Lens;
    readonly task: TaskId<FinderResult>;
  }>;
};
export type FrontResult = {
  readonly stages: ReadonlyArray<StageRecord>;
  readonly frameKey: string | null;
  readonly mapKey: string | null;
  readonly manifestKey: string;
  readonly scopeKey: string | null;
  readonly strongestStratum: string;
  readonly frameStratum: Stratum;
  readonly disclosures: Freshness["disclosures"];
  readonly reason?: string;
  /** Absent when the front task never held a Frame key (it failed or was stopped before). */
  readonly finders?: StartedFinders;
};
export type FrontCheckpoint =
  | { readonly phase: "setup" }
  | { readonly phase: "frame" }
  | { readonly phase: "map" }
  | {
      readonly phase: "done";
      /** From the commit that starts Map: the finders started then. */
      readonly finders?: StartedFinders;
    };
type Runtime = TaskRuntime<FrontInput, FrontCheckpoint, FrontResult, object>;
type StepId = TaskId<StageRecord>;
const done = (record: StageRecord | undefined): record is StageRecord =>
  record !== undefined &&
  (record.status === "computed" || record.status === "reused");
const recordOf = resultOf<StageRecord>;
/** The finders a checkpoint holds: only `done` can. */
const startedOf = (at: FrontCheckpoint) =>
  at.phase === "done" ? at.finders : undefined;

export const frontTask = (
  services: StageServices,
  run: StageRun,
  agentStep: Task<AgentStepInput, AgentStepCheckpoint, StageRecord, object>,
  /** The finder task, which this task starts for the review when Frame lands. */
  finder: Task<FinderInput, FinderCheckpoint, FinderResult, object>,
): Task<FrontInput, FrontCheckpoint, FrontResult, object> => {
  const { ctx } = services;
  const waits = waitSpans(ctx.log);
  let prewarmed = false;
  const freshness = async (
    task: { readonly input: FrontInput },
    runtime: Runtime,
    context: Context,
  ) => {
    const facts = await run.facts(task.input.precompute, runtime.signal);
    const view = await run.view(
      { precompute: task.input.precompute },
      runtime.signal,
    );
    const snapshot = view.snapshot;
    const snapshotKey = facts.scope;
    const judged: Array<StepId> = [];
    if (snapshot === undefined || snapshotKey === null)
      return { freshness: noFreshness(snapshot, snapshotKey), judged };
    const judge = async (change: ChangeToJudge) => {
      const id = await spawn(
        runtime,
        `scope-change.${change.source}.${change.fromSha.slice(0, 12)}.${change.toSha.slice(0, 12)}`,
        agentStep,
        stepInput("scope-change", { change }, task.input.cutoffAt),
        context,
      );
      judged.push(id);
      const record = recordOf(await outcomeOf(runtime, id, context));
      if (!done(record) || record.key === undefined) return undefined;
      const stored = await services.run(
        storedOutput(ctx, record.key, ScopeChangeStored),
        runtime.signal,
      );
      return stored.judgement ?? undefined;
    };
    const settled = await services.run(
      Effect.gen(function* () {
        const checks = yield* checkSources({
          snapshot,
          integrations: services.integrations,
          location: ctx.location,
          cycleId: ctx.cycleId,
          readSince: ctx.startedAt,
        });
        const withJudgements = yield* judgeChecks(checks, snapshot, (change) =>
          Effect.promise(() => judge(change).catch(() => undefined)),
        );
        return yield* settleFreshness({
          snapshot,
          snapshotKey,
          checks: withJudgements,
          integrations: services.integrations,
          location: ctx.location,
          cycleId: ctx.cycleId,
          log: ctx.log,
        });
      }),
      runtime.signal,
    );
    return { freshness: settled, judged };
  };

  const preflight = async (
    runtime: Runtime,
    first:
      | {
          readonly system: string;
          readonly task: string;
          readonly tools: ReadonlyArray<ToolSpec<unknown>>;
        }
      | undefined,
    context: Context,
  ) => {
    if ((await runtime.memo<boolean>("preflight", context)) === true) return;
    const counted =
      first === undefined || services.countTokens === undefined
        ? null
        : await services.countTokens(
            {
              label: "frame.initial-context",
              system: first.system,
              user: first.task,
              tools: first.tools.map((spec) => {
                const tool = wireTool(spec);
                return {
                  name: tool.name,
                  description: tool.description,
                  input_schema: { ...tool.parameters },
                };
              }),
            },
            runtime.signal,
          );
    ctx.log.write({
      type: "preflight",
      route: `${ctx.config.route.provider}/${ctx.config.route.model}`,
      credentialVariable: credentialName(ctx.config.route),
      organization: null,
      countedTokens: counted,
      status: "ok",
    });
    await runtime.memo("preflight", true, context);
  };

  const records = async (runtime: Runtime, context: Context) => {
    const children = await runtime.snapshot(
      ChildrenDoc,
      runtime.taskId,
      context,
    );
    const outcomes = await runtime.outcomes(
      Object.values(children?.children ?? {}).map((id) =>
        childId<StageRecord>(id),
      ),
      context,
    );
    return {
      outcomes,
      stages: outcomes.flatMap((o) => {
        const r = resultOf(o);
        return r === undefined ? [] : [r];
      }),
    };
  };
  // Only Frame and Map fail the task; a failed scope-change judge is tolerated
  // by the freshness setup, as Understand tolerated it.
  const failIf = async (runtime: Runtime, context: Context) => {
    const children = await runtime.snapshot(
      ChildrenDoc,
      runtime.taskId,
      context,
    );
    const own = (["frame", "map"] as const).flatMap((kind) => {
      const id = children?.children[kind];
      return id === undefined ? [] : [childId<StageRecord>(id)];
    });
    const failure = failureOf(await runtime.outcomes(own, context));
    if (failure === undefined) return false;
    await runtime.commit(
      () => ({ status: "terminal", outcome: failure }),
      context,
    );
    return true;
  };
  const ensureSetup = async (
    input: FrontInput,
    runtime: Runtime,
    context: Context,
  ) => {
    if ((await runtime.snapshot(RunSetupDoc, context))?.setup == null) {
      const facts = await run.facts(input.precompute, runtime.signal);
      await runtime.commit(async (tx) => {
        const doc = await tx.doc(RunSetupDoc);
        doc.setup = copyJson({
          precompute: input.precompute,
          scopeKey: facts.scope,
          refreshKey: null,
          pins: [],
          disclosures: [],
        });
        return { status: "running", checkpoint: { phase: "done" } };
      }, context);
    }
    return run.setup(runtime, context);
  };
  const fallbackRecord = <O, S>(step: AgentStep<O, S>, runtime: Runtime) =>
    services.run(
      codeStage(
        ctx,
        step.spec.stage,
        {
          op: `${step.op}-fallback`,
          opVersion: step.opVersion,
          inputs: { ...step.inputs, run: ctx.runId },
        },
        Effect.sync(() =>
          step.compose({
            agent: step.spec.agent,
            stage: step.spec.stage,
            status: "backstop",
            endedBy: "timeout",
            turnsUsed: 0,
            turnLimit: step.spec.turnLimit,
            finalGeneration: false,
            usage: zeroUsage,
            costUsd: null,
            resumedTurns: 0,
            restarted: false,
            modelCalls: 0,
          }),
        ),
        { agent: step.spec.agent, schema: step.schema, afterCutoff: true },
      ),
      runtime.signal,
    );
  const frameOf = async (
    input: FrontInput,
    runtime: Runtime,
    context: Context,
  ) => {
    const setup = await ensureSetup(input, runtime, context);
    const view = await run.view(
      { precompute: input.precompute, setup },
      runtime.signal,
    );
    const held = (await records(runtime, context)).stages.find(
      (r) => r.agent === "frame" && done(r),
    );
    const record =
      held ??
      (await fallbackRecord(
        await services.run(
          frameStep(ctx, view, await run.candidates(view, runtime.signal)),
          runtime.signal,
        ),
        runtime,
      ));
    if (record.key === undefined)
      throw new Error("Frame did not store an output");
    return {
      setup,
      view,
      record,
      key: record.key,
      value: await services.run(
        storedOutput(ctx, record.key, Frame),
        runtime.signal,
      ),
    };
  };
  const manifestOf = async (
    input: FrontInput,
    runtime: Runtime,
    context: Context,
  ) => {
    const setup = await run.setup(runtime, context);
    const view = await run.view(
      { precompute: input.precompute, setup },
      runtime.signal,
    );
    const facts = await run.facts(input.precompute, runtime.signal);
    const held = await runtime.memo<{
      key: string;
      reused: boolean;
      wallMs: number;
      note: string | null;
    }>("map.manifest", context);
    const record: StageRecord =
      held === undefined
        ? await services.run(
            mapManifestStage(ctx, facts.manifest, view.manifest),
            runtime.signal,
          )
        : {
            stage: "map",
            agent: "map.manifest",
            key: held.key,
            status: held.reused ? "reused" : "computed",
            wallMs: held.wallMs,
            note: held.note ?? undefined,
          };
    if (record.key === undefined)
      throw new Error("Map manifest did not store an output");
    await runtime.memo(
      "map.manifest",
      {
        key: record.key,
        reused: record.status === "reused",
        wallMs: record.wallMs,
        note: record.note ?? null,
      },
      context,
    );
    return {
      record,
      key: record.key,
      value: await services.run(
        storedOutput(ctx, record.key, MapManifest),
        runtime.signal,
      ),
    };
  };
  const compose = async (
    input: FrontInput,
    runtime: Runtime,
    context: Context,
    finders: StartedFinders | undefined,
  ): Promise<FrontResult> => {
    const frame = await frameOf(input, runtime, context);
    const manifest = await manifestOf(input, runtime, context);
    const settled = await records(runtime, context);
    const held = settled.stages.find((r) => r.agent === "map" && done(r));
    const map =
      held ??
      (await fallbackRecord(
        mapStep(ctx, frame.view, frame, manifest),
        runtime,
      ));
    if (map.key === undefined) throw new Error("Map did not store an output");
    const facts = await run.facts(input.precompute, runtime.signal);
    const additions =
      (await runtime.snapshot(RunSetupDoc, context))?.additions ?? [];
    const frozen = await services.run(
      Effect.provide(freezeSnapshot(ctx.cycleId, additions), ctx.records),
      runtime.signal,
    );
    ctx.log.write({
      type: "scope.frozen",
      status: frozen.status,
      additions: frozen.value.additions.length,
    });
    const frameRecords = settled.stages.filter((r) => r.agent === "frame");
    const mapRecords = settled.stages.filter((r) => r.agent === "map");
    const stages = [
      ...settled.stages.filter((r) => r.agent !== "frame" && r.agent !== "map"),
      ...frameRecords,
      ...(frameRecords.some(
        (r) => r.key === frame.record.key && r.status === frame.record.status,
      )
        ? []
        : [frame.record]),
      manifest.record,
      ...mapRecords,
      ...(mapRecords.some((r) => r.key === map.key && r.status === map.status)
        ? []
        : [map]),
    ];
    return {
      stages,
      frameKey: frame.key,
      mapKey: map.key,
      manifestKey: facts.manifest,
      scopeKey: frame.setup.scopeKey,
      strongestStratum: facts.strongestStratum,
      frameStratum: frame.value.stratum,
      disclosures: frame.setup.disclosures,
      ...(finders === undefined ? {} : { finders }),
    };
  };
  /**
   * The finders, started when Frame has landed (the Frame key this task holds, possibly its
   * fallback), in the commit that starts Map: owned by the review task, which this task's own owner
   * is, so the review waits for them and its stop stops them. The start rule is the review's, as
   * before, measured now; each finder waits for this task before dedupe, for the Map key.
   */
  const startFinders = async (
    tx: Tx,
    input: FrontInput,
    runtime: Runtime,
    frameKey: string,
    manifestKey: string,
  ): Promise<StartedFinders | undefined> => {
    const self = await tx.task(runtime.taskId);
    if (self?.owner === undefined) return undefined;
    const now = runtime.now();
    const deadline = findDeadline(now, input.cutoffAt);
    const started =
      input.cutoffAt - VERIFY_RESERVE_MS - now >= MIN_FIND_WINDOW_MS;
    const finders: Array<{ lens: Lens; task: TaskId<FinderResult> }> = [];
    if (started)
      for (const lens of FINDERS)
        finders.push({
          lens,
          task: await tx.createTask(
            finder,
            {
              lens,
              frameKey,
              manifestKey,
              front: runtime.taskId,
              cutoffAt: input.cutoffAt,
              deadline,
            },
            { ownership: { kind: "task", taskId: self.owner } },
          ),
        });
    return { start: now, deadline, started, finders };
  };
  /**
   * What a start of finders leaves in the run log: the schedule (once per review) and each finder's
   * inputs (once per finder). Each is written only when the log lacks it, so the phase after the
   * commit that started them can write what a crash right after that commit left out.
   */
  const logFinders = (
    runtime: Runtime,
    started: StartedFinders,
    owner: TaskId | undefined,
    /** Undefined when the finders' inputs cannot be read: their rows are then left out. */
    keys: { frame: string; manifest: string } | undefined,
    input: FrontInput,
  ) => {
    const logged = ctx.log.read();
    const has = (type: string, taskId: TaskId | undefined) =>
      logged.some((entry) => entry.type === type && entry["taskId"] === taskId);
    if (!has("review.schedule", owner))
      ctx.log.write({
        type: "review.schedule",
        taskId: owner,
        front: runtime.taskId,
        start: started.start,
        deadline: started.deadline,
        cutoffAt: input.cutoffAt,
        finders: started.finders.length,
        skipped: !started.started,
      });
    if (keys === undefined) return;
    for (const finder of started.finders)
      if (!has("task.inputs", finder.task))
        ctx.log.write({
          type: "task.inputs",
          taskId: finder.task,
          owner,
          kind: `finder.${finder.lens}`,
          inputs: {
            frame: `computation:${keys.frame}`,
            manifest: `computation:${keys.manifest}`,
          },
          front: runtime.taskId,
        });
  };
  /**
   * The finders' log, written again from the checkpoint by the phase after the commit that started
   * them (`done`, or `abort`): a crash between that commit and `map`'s own writes leaves the log
   * without them, and nothing else would write them. The keys are the ones the finders were given.
   */
  const relogFinders = async (
    started: StartedFinders | undefined,
    input: FrontInput,
    runtime: Runtime,
    context: Context,
  ) => {
    if (started === undefined) return;
    const owner = (await runtime.getTask(runtime.taskId, context))?.owner;
    const first = started.finders[0];
    const given =
      first === undefined
        ? undefined
        : ((await runtime.getTask(first.task, context))?.input as
            FinderInput | undefined);
    logFinders(
      runtime,
      started,
      owner,
      given === undefined
        ? undefined
        : { frame: given.frameKey, manifest: given.manifestKey },
      input,
    );
  };
  const waitFor = async (
    kind: "frame" | "map",
    params: {} | { frame: string; manifest: string },
    next: FrontCheckpoint["phase"],
    input: FrontInput,
    runtime: Runtime,
    context: Context,
    /** In the same commit, for Map: the finders (once; a rerun after this commit is past it). */
    alongside?: (tx: Tx) => Promise<StartedFinders | undefined>,
  ) => {
    const step: { id?: StepId; created?: boolean } = {};
    let finders: StartedFinders | undefined;
    await logTimed(
      ctx.log,
      "harness.pi.commit",
      {
        "harness.task_id": runtime.taskId,
        "harness.task_kind": "front",
        "harness.phase": kind,
        "harness.next_phase": next,
      },
      () =>
        runtime.commit(async (tx) => {
          const children = await tx.doc(ChildrenDoc, runtime.taskId);
          const held = children.children[kind];
          // Reads before writes: a commit reads no task after it creates one.
          finders = await alongside?.(tx);
          const id =
            held === undefined
              ? await tx.createTask(
                  agentStep,
                  stepInput(kind, params, input.cutoffAt),
                  { ownership: { kind: "task", taskId: runtime.taskId } },
                )
              : childId<StageRecord>(held);
          children.children[kind] = id;
          step.id = id;
          step.created = held === undefined;
          return {
            status: "waiting",
            checkpoint: {
              phase: next,
              ...(finders === undefined ? {} : { finders }),
            },
            on: [id],
            policy: "allSettled",
          };
        }, context),
    );
    if (step.id === undefined) return finders;
    // Which computations the step reads, so a collector joins it with their producers' ends.
    if (step.created)
      ctx.log.write({
        type: "task.inputs",
        taskId: step.id,
        owner: runtime.taskId,
        kind,
        inputs:
          "frame" in params
            ? {
                frame: `computation:${params.frame}`,
                manifest: `computation:${params.manifest}`,
              }
            : { precompute: `computation:${input.precompute}` },
      });
    waits.waiting(runtime.taskId, {
      "harness.task_id": runtime.taskId,
      "harness.task_kind": "front",
      "harness.next_phase": next,
      "harness.waiting_on": kind,
      "harness.waiting_on_ids": String(step.id),
    });
    return finders;
  };
  /** A phase-end commit, as its own span. */
  const commitSpan = (
    runtime: Runtime,
    phase: FrontCheckpoint["phase"],
    next: string,
    work: () => Promise<unknown>,
  ) =>
    logTimed(
      ctx.log,
      "harness.pi.commit",
      {
        "harness.task_id": runtime.taskId,
        "harness.task_kind": "front",
        "harness.phase": phase,
        "harness.next_phase": next,
      },
      work,
    );
  /** Each phase's span; the wait it resumes from ends where it starts (telemetry only). */
  const phaseOf = (runtime: Runtime, phase: FrontCheckpoint["phase"]) => {
    waits.resumed(runtime.taskId);
    return scopedLogSpan(ctx.log, "harness.pi.phase", {
      "harness.task_id": runtime.taskId,
      "harness.phase": phase,
      "harness.task_kind": "front",
    });
  };
  return defineTask<FrontInput, FrontCheckpoint, FrontResult>({
    name: FRONT_TASK,
    // 2: the commit that starts Map also starts the finders, which `done` carries to the result.
    version: 2,
    initial: () => ({ phase: "setup" }),
    phases: {
      setup: async (task, runtime, context) => {
        using phaseSpan = phaseOf(runtime, "setup");
        await services.run(
          recordStageStart(ctx, "frame", "frame"),
          runtime.signal,
        );
        const { freshness: settled } = await freshness(task, runtime, context);
        const setup: RunSetup = {
          precompute: task.input.precompute,
          scopeKey: settled.scopeKey,
          refreshKey: settled.refreshKey ?? null,
          pins: [...settled.pins],
          disclosures: settled.disclosures.map((entry) =>
            "cause" in entry && entry.cause !== undefined
              ? { kind: entry.kind, detail: entry.detail, cause: entry.cause }
              : { kind: entry.kind, detail: entry.detail },
          ),
        };
        await commitSpan(runtime, "setup", "frame", () =>
          runtime.commit(async (tx) => {
            const doc = await tx.doc(RunSetupDoc);
            doc.setup = copyJson(setup);
            return { status: "running", checkpoint: { phase: "frame" } };
          }, context),
        );
      },
      frame: async (task, runtime, context) => {
        using phaseSpan = phaseOf(runtime, "frame");
        const setup = await run.setup(runtime, context);
        const view = await run.view(
          { precompute: task.input.precompute, setup },
          runtime.signal,
        );
        if (ctx.config.search !== undefined && !prewarmed) {
          prewarmed = true;
          await services.run(
            prewarmSearch(
              scopeOf(lookupContext(ctx, view)),
              ctx.config.search,
              ctx.records,
              (record) =>
                ctx.log.write({
                  ...record,
                  type:
                    typeof record["type"] === "string"
                      ? record["type"]
                      : "prewarm",
                }),
            ),
            runtime.signal,
          );
        }
        if (ctx.recompose === undefined) {
          const prepared = await run.preview(
            stepInput("frame", {}, task.input.cutoffAt),
            runtime,
            context,
          );
          await preflight(runtime, prepared.step.spec, context);
        }
        await waitFor("frame", {}, "map", task.input, runtime, context);
      },
      map: async (task, runtime, context) => {
        using phaseSpan = phaseOf(runtime, "map");
        if (await failIf(runtime, context)) return;
        // Frame has landed: its key (or its fallback's) is what the finders read.
        const frame = await frameOf(task.input, runtime, context);
        const manifest = await manifestOf(task.input, runtime, context);
        const facts = await run.facts(task.input.precompute, runtime.signal);
        const owner = (await runtime.getTask(runtime.taskId, context))?.owner;
        const alongside = (tx: Tx) =>
          startFinders(tx, task.input, runtime, frame.key, facts.manifest);
        let finders: StartedFinders | undefined;
        if (manifest.value.entries.length === 0)
          await commitSpan(runtime, "map", "done", () =>
            runtime.commit(async (tx) => {
              finders = await alongside(tx);
              return {
                status: "running",
                checkpoint: {
                  phase: "done",
                  ...(finders === undefined ? {} : { finders }),
                },
              };
            }, context),
          );
        else
          finders = await waitFor(
            "map",
            { frame: frame.key, manifest: manifest.key },
            "done",
            task.input,
            runtime,
            context,
            alongside,
          );
        if (finders !== undefined)
          logFinders(
            runtime,
            finders,
            owner,
            { frame: frame.key, manifest: facts.manifest },
            task.input,
          );
      },
      done: async (task, runtime, context) => {
        using phaseSpan = phaseOf(runtime, "done");
        await relogFinders(
          task.state.checkpoint.finders,
          task.input,
          runtime,
          context,
        );
        if (await failIf(runtime, context)) return;
        const result = await compose(
          task.input,
          runtime,
          context,
          task.state.checkpoint.finders,
        );
        await commitSpan(runtime, "done", "terminal", () =>
          runtime.commit(
            () => ({
              status: "terminal",
              outcome: { status: "completed", result },
            }),
            context,
          ),
        );
      },
    },
    abort: async (task, runtime, context) => {
      waits.resumed(runtime.taskId);
      await relogFinders(
        startedOf(task.state.checkpoint),
        task.input,
        runtime,
        context,
      );
      if (await failIf(runtime, context)) return;
      const control = await runtime.snapshot(RunControlDoc, context);
      if (!composeOnAbort(control?.stopCause)) {
        const facts = await run.facts(task.input.precompute, runtime.signal);
        const setupDoc = await runtime.snapshot(RunSetupDoc, context);
        const setup =
          setupDoc?.setup == null
            ? undefined
            : await run.setup(runtime, context);
        const finders = startedOf(task.state.checkpoint);
        const result: FrontResult = {
          stages: (await records(runtime, context)).stages,
          frameKey: null,
          mapKey: null,
          manifestKey: facts.manifest,
          scopeKey: setup?.scopeKey ?? facts.scope,
          strongestStratum: facts.strongestStratum,
          frameStratum: "nothing",
          disclosures: setup?.disclosures ?? [],
          reason:
            control?.stopCause === "held-failure"
              ? "held route failure"
              : "user stop",
          // The finders it started are the review's: they read no Map key from this result.
          ...(finders === undefined ? {} : { finders }),
        };
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "aborted", reason: "stopped", result },
          }),
          context,
        );
        return;
      }
      const result = await compose(
        task.input,
        runtime,
        context,
        startedOf(task.state.checkpoint),
      );
      await runtime.commit(
        () => ({
          status: "terminal",
          outcome: { status: "aborted", reason: "cutoff", result },
        }),
        context,
      );
    },
  });
};
