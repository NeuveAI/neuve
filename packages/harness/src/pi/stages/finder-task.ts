import {
  logTimed,
  scopedLogSpan,
  startLogSpan,
  waitSpans,
} from "../../log-span.ts";
import type { Context } from "@earendil-works/chord";
import type { Task, TaskRuntime, TaskId } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import {
  FindOutput,
  FindStored,
  dedupeFindings,
  groupOfHunk,
  type Lens,
} from "../../find.ts";
import type { FrontResult } from "./front-task.ts";
import { ReviewMap } from "../../review-map.ts";
import { codeStage, storedOutput, type StageRecord } from "../../pipeline.ts";
import {
  claimKeyOf,
  verifyAgentOf,
  verifyChildName,
  VerifyStored,
} from "../../verify.ts";
import { definePolicyTask } from "../failure-policy.ts";
import { AgentStepInput, type AgentStepCheckpoint } from "./agent-step.ts";
import { childId, failureOf, resultOf } from "./children.ts";
import { ChildrenDoc } from "./docs.ts";
import { stepInput, verifyChild, type StageRun } from "./run.ts";
import type { StageServices } from "./services.ts";
import { CHILD_STARTED_SPAN } from "./tools.ts";

/**
 * One finder lens: Find, then per-finder dedupe and the cap, then one Verify per final finding.
 *
 * Verify is keyed by the claim it reads (verify.ts, `claimKeyOf`) and named by it in this task's
 * children, and it is always owned by this task. A finding `record_finding` accepts has its Verify
 * started in that call's own commit (tools.ts), so its check runs while Find goes on. The final list
 * still decides, exactly as before: the verify phase uses the Verify started under a final claim's
 * name and starts one for every other final claim (only submitted, changed by repair, or merged by
 * dedupe).
 *
 * A Verify whose claim is not in the final list (unused) never changes the result: it gives no
 * verdict, its failure does not fail the finder, its cut-off does not set the finder's reason, and
 * it stays out of `stages`, which decide the packet's completeness and the run's end. It is listed
 * in `unused` and counted in the run log. A task cannot stop a child that has not failed, so the
 * finder waits for an unused Verify still running, after it has decided its reason (`settle`).
 */
export const FINDER_TASK = "neuve.finder";
/**
 * A finder starts when Frame has landed (front-task.ts), before Map: Find reads no Map. Map is
 * needed only to assign groups and order dedupe, so after Find the finder waits for the front task
 * that runs Map (`front`, not its child) and reads the Map key from its result.
 */
export type FinderInput = {
  lens: Lens;
  frameKey: string;
  manifestKey: string;
  /** The front task, whose result holds the Map key. */
  front: number;
  cutoffAt: number;
  deadline: number;
};
export type FinderResult = {
  lens: Lens;
  findKey: string | null;
  findings: ReadonlyArray<{
    id: string;
    verifyKey: string | null;
    status: "kept" | "dropped" | "unverified";
  }>;
  stages: ReadonlyArray<StageRecord>;
  reason?: string;
  /**
   * Verifies started for a claim the final list does not hold: never a verdict, and never in
   * `stages`. Absent only in a result composed by something other than the finder.
   */
  unused?: ReadonlyArray<UnusedVerify>;
  /**
   * How its Find and its used Verifies ended (`finderEndOf`), set where the finder ends: a field of
   * its own beside the rest of the result, which it changes nothing in, and in no key.
   */
  end: FinderEnd;
};
/**
 * How a finder's Find, or its used Verifies taken together, ended: the one closed set every reader
 * of a finder's end decides from, each by an exhaustive switch. `completed`: it ran to its end;
 * `cutoff`: the run's cut-off (or the finders' deadline before it) interrupted it; `stopped`: its
 * run was stopped; `skipped`: it never started (the cut-off came first, too little time remained to
 * start the finders, or a claim's Verify was never started); `failed`: it failed. The same words as
 * the readings' plan's end (`ReadingsPlanResult["status"]`) where they mean the same (`cutoff`,
 * `stopped`, `failed`); `completed` is the plan's `ok`. None of them is shown to a person.
 */
export type FinderStatus =
  "completed" | "cutoff" | "stopped" | "skipped" | "failed";
export const FINDER_STATUSES: ReadonlyArray<FinderStatus> = [
  "completed",
  "cutoff",
  "stopped",
  "skipped",
  "failed",
];
/** A finder's end: its Find's status and its used Verifies' (`completed` when there were none). */
export type FinderEnd = {
  readonly find: FinderStatus;
  readonly verify: FinderStatus;
};
/** What an interruption of one of the finder's steps was: the cut-off, or a stop of its run. */
type Stop = "cutoff" | "stopped";
/** One step's end, from its stage record's status. */
const stepStatus = (
  status: StageRecord["status"],
  stop: Stop,
): FinderStatus => {
  switch (status) {
    case "computed":
    case "reused":
    case "stub":
      return "completed";
    case "interrupted":
      return stop;
    case "skipped":
      return "skipped";
  }
};
/** Which of two ends is worse: a failure over a stop over the cut-off over a skip over completion. */
const rank = (status: FinderStatus): number => {
  switch (status) {
    case "completed":
      return 0;
    case "skipped":
      return 1;
    case "cutoff":
      return 2;
    case "stopped":
      return 3;
    case "failed":
      return 4;
  }
};
/**
 * A finder's end from its stage records: its Find's record (none: it ended with no record, as `stop`
 * says), and one entry per final claim, its used Verify's record or none (never started:
 * `skipped`). `stop` says what an interruption was.
 */
export const finderEndOf = (
  find: StageRecord | undefined,
  verifies: ReadonlyArray<StageRecord | undefined>,
  stop: Stop,
): FinderEnd => ({
  find: find === undefined ? stop : stepStatus(find.status, stop),
  verify: verifies.reduce<FinderStatus>((worse, record) => {
    const status =
      record === undefined ? "skipped" : stepStatus(record.status, stop);
    return rank(status) > rank(worse) ? status : worse;
  }, "completed"),
});
/** A Verify the final list did not use: its claim, how it ended and its stored output, if any. */
export type UnusedVerify = {
  claim: string;
  agent: string | null;
  status: StageRecord["status"] | "failed" | "faulted" | "orphaned";
  key: string | null;
};
type Composing = {
  findKey: string | null;
  stages: StageRecord[];
  /** The Verifies the verify phase started; a `record_finding` call started every other one. */
  asked: string[];
  /** Why the finder has no final list (no Map to group its findings), when it has none. */
  missing?: string;
};
export type FinderCheckpoint =
  | { phase: "find" }
  /** Find is running; after it, the finder waits for Map if it has not landed. */
  | { phase: "map"; find: number }
  | { phase: "dedupe"; find: number }
  | {
      phase: "verify";
      findKey: string | null;
      stages: StageRecord[];
      missing?: string;
    }
  | ({ phase: "done" } & Composing)
  /** Every used Verify ended and the reason is decided; unused Verifies still running remain. */
  | ({ phase: "settle"; reason: string | null } & Composing);
type Runtime = TaskRuntime<FinderInput, FinderCheckpoint, FinderResult, object>;

const isVerify = (name: string) => name.startsWith("verify.");

export const finderTask = (
  services: StageServices,
  _run: StageRun,
  agentStep: Task<AgentStepInput, AgentStepCheckpoint, StageRecord, object>,
) => {
  const { ctx } = services;
  const readFind = (key: string, signal?: AbortSignal) =>
    services.run(storedOutput(ctx, key, FindStored), signal);
  /** The Map key of the run, from the front task's result once it has ended; null without one. */
  const mapKeyOf = async (
    input: FinderInput,
    runtime: Runtime,
    context: Context,
  ): Promise<string | null | undefined> => {
    const front = await runtime.getTask(
      childId<FrontResult>(input.front),
      context,
    );
    if (front?.state.status !== "terminal") return undefined;
    const outcome = front.state.outcome;
    return outcome.status === "completed" || outcome.status === "aborted"
      ? (outcome.result?.mapKey ?? null)
      : null;
  };
  const logResult = (result: FinderResult) => {
    const find = result.stages.find((stage) => stage.stage === "find");
    ctx.log.write({
      type: "finder.result",
      lens: result.lens,
      turns: find?.agentResult?.turnsUsed ?? null,
      endedBy: find?.agentResult?.endedBy ?? null,
      findings: result.findings.length,
      kept: result.findings.filter((f) => f.status === "kept").length,
      dropped: result.findings.filter((f) => f.status === "dropped").length,
      unverified: result.findings.filter((f) => f.status === "unverified")
        .length,
      find: result.end.find,
      verify: result.end.verify,
    });
  };
  const compose = async (
    input: FinderInput,
    runtime: Runtime,
    context: Context,
    findKey: string | null,
    stages: ReadonlyArray<StageRecord>,
    asked: ReadonlyArray<string>,
    reason: string | undefined,
    /** What an interrupted step's interruption was: the cut-off, or a stop of the run (`abort`). */
    stop: Stop,
  ): Promise<
    | { readonly result: FinderResult }
    | { readonly failure: NonNullable<ReturnType<typeof failureOf>> }
  > => {
    const children = await runtime.snapshot(
      ChildrenDoc,
      runtime.taskId,
      context,
    );
    const verifying = Object.entries(children?.children ?? {}).filter(
      ([name]) => isVerify(name),
    );
    const outcomes = new Map(
      (
        await runtime.outcomes(
          verifying.map(([, id]) => childId<StageRecord>(id)),
          context,
        )
      ).map((outcome, at) => [verifying[at]![0], outcome] as const),
    );
    const found =
      findKey === null
        ? undefined
        : await readFind(findKey, context.abortSignal);
    const claims = (found?.findings ?? []).map((f) => {
      const claimKey = claimKeyOf(input.frameKey, f);
      return { f, claimKey, name: verifyChildName(claimKey) };
    });
    const final = new Set(claims.map((claim) => claim.name));
    // A used Verify that failed fails the finder, as a failed Verify did before. An unused one
    // would not have run before, so its failure is only listed.
    const failure = failureOf(
      claims.flatMap(({ name }) => {
        const outcome = outcomes.get(name);
        return outcome === undefined ? [] : [outcome];
      }),
    );
    if (failure !== undefined) return { failure };
    const findings: FinderResult["findings"][number][] = [];
    const used: StageRecord[] = [];
    const unfinished: StageRecord[] = [];
    // Each final claim's used Verify record, or none: how the Verifies ended (`end`).
    const verified: Array<StageRecord | undefined> = [];
    // In the final list's order, so the records never depend on which Verify finished first.
    for (const { f, claimKey, name } of claims) {
      const outcome = outcomes.get(name);
      const record = outcome === undefined ? undefined : resultOf(outcome);
      // As before: a Verify that ran keeps its own record (interrupted, with its partial output,
      // when it was stopped or cut off); a made-up row only for a claim whose Verify never started.
      verified.push(record);
      if (record !== undefined) used.push(record);
      else if (reason !== undefined)
        unfinished.push({
          stage: "verify",
          agent: verifyAgentOf(input.lens, claimKey),
          status: "skipped",
          wallMs: 0,
          disclosure: null,
        });
      const stored =
        record?.key !== undefined &&
        (record.status === "computed" || record.status === "reused")
          ? await services.run(
              storedOutput(ctx, record.key, VerifyStored),
              context.abortSignal,
            )
          : undefined;
      const checked =
        stored !== undefined &&
        stored.finding === claimKey &&
        stored.source !== "backstop";
      const status = !checked
        ? "unverified"
        : stored.decision === "keep"
          ? "kept"
          : "dropped";
      findings.push({ id: f.id, verifyKey: record?.key ?? null, status });
      services.capture({
        type: "lead.fate",
        scope: {
          runId: ctx.runId,
          stage: status === "kept" ? "find" : "verify",
        },
        leadId: f.id,
        handoff: status === "kept" ? "find" : "verify",
        fate:
          status === "kept"
            ? "handed-on"
            : status === "dropped"
              ? "dropped"
              : "withheld",
        ...(status === "kept"
          ? {}
          : { reason: status === "dropped" ? "not-verified" : "unverified" }),
      });
      ctx.log.write({
        type: "finding",
        lens: input.lens,
        group: f.group,
        doneWhen: f.doneWhen,
        status,
        claim: claimKey,
        // Who started its Verify: the call that recorded it, the verify phase, or nobody.
        asked: !outcomes.has(name)
          ? null
          : asked.includes(name)
            ? "verify-phase"
            : "record_finding",
      });
    }
    // A Verify started for a claim the final list does not hold (merged by dedupe, changed by
    // repair, over the cap): listed beside the stages, never read for a verdict.
    const unused: UnusedVerify[] = [];
    for (const [name, outcome] of outcomes) {
      if (final.has(name)) continue;
      const record = resultOf(outcome);
      unused.push({
        claim: name.slice("verify.".length),
        agent: record?.agent ?? null,
        status:
          record?.status ??
          (outcome.status === "completed" || outcome.status === "aborted"
            ? "skipped"
            : outcome.status),
        key: record?.key ?? null,
      });
    }
    // Its model calls stay in the run log under its own agent name; counted here.
    const unusedAgents = new Set(
      unused.map((verify) => verifyAgentOf(input.lens, verify.claim)),
    );
    ctx.log.write({
      type: "verify.claims",
      lens: input.lens,
      final: claims.length,
      askedAtRecord: verifying.length - asked.length,
      askedAtVerify: asked.length,
      used: claims.filter(({ name }) => outcomes.has(name)).length,
      unused: unused.length,
      unusedModelCalls: ctx.log
        .read()
        .filter(
          (entry) =>
            entry.type === "model.call" &&
            unusedAgents.has(String(entry["agent"])),
        ).length,
    });
    return {
      result: {
        lens: input.lens,
        findKey,
        findings,
        stages: [...stages, ...used, ...unfinished],
        ...(reason === undefined ? {} : { reason }),
        unused,
        end: finderEndOf(
          stages.find((stage) => stage.stage === "find"),
          verified,
          stop,
        ),
      },
    };
  };
  /** A used Verify's failure fails the finder from its phases, as before. */
  const resultOrThrow = (
    composed: Awaited<ReturnType<typeof compose>>,
  ): FinderResult => {
    if ("result" in composed) return composed.result;
    const { failure } = composed;
    throw {
      _tag: "FinderChildFailed",
      message:
        failure.status === "failed" || failure.status === "faulted"
          ? failure.error.message
          : "finder child failed",
      retryable: false,
    };
  };
  const waits = waitSpans(ctx.log);
  /** Each phase's span; the wait it resumes from ends where it starts (telemetry only). */
  const phaseOf = (runtime: Runtime, lens: Lens, phase: string) => {
    waits.resumed(runtime.taskId);
    return scopedLogSpan(ctx.log, "harness.pi.phase", {
      "harness.task_id": runtime.taskId,
      "harness.task_kind": "finder",
      "harness.phase": phase,
      "harness.lens": lens,
    });
  };
  /** A phase-end commit, as its own span: creating children and the store write take time. */
  const commitSpan = <T>(
    runtime: Runtime,
    lens: Lens,
    phase: string,
    next: string,
    work: () => Promise<T>,
  ) =>
    logTimed(
      ctx.log,
      "harness.pi.commit",
      {
        "harness.task_id": runtime.taskId,
        "harness.task_kind": "finder",
        "harness.phase": phase,
        "harness.next_phase": next,
        "harness.lens": lens,
      },
      work,
    );
  /** The wait a waiting commit starts, naming what it waits on and, for Verify, its counts. */
  const waiting = (
    runtime: Runtime,
    lens: Lens,
    next: string,
    on: "find" | "map" | "verify" | "unused-verify",
    ids: ReadonlyArray<number>,
    counts: Record<string, number> = {},
  ) =>
    waits.waiting(runtime.taskId, {
      "harness.task_id": runtime.taskId,
      "harness.task_kind": "finder",
      "harness.lens": lens,
      "harness.next_phase": next,
      "harness.waiting_on": on,
      "harness.waiting_on_ids": ids.join(","),
      ...counts,
    });
  /** Which computations a new child reads, so a collector joins it with their producers' ends. */
  const inputsOf = (
    runtime: Runtime,
    task: number,
    kind: string,
    inputs: Readonly<Record<string, string>>,
    more: Record<string, string> = {},
  ) =>
    ctx.log.write({
      type: "task.inputs",
      taskId: task,
      owner: runtime.taskId,
      kind,
      inputs,
      ...more,
    });
  const finish = async (
    input: FinderInput,
    runtime: Runtime,
    context: Context,
    at: Composing,
    reason: string | undefined,
    phase: "done" | "settle",
  ) => {
    const result = resultOrThrow(
      await compose(
        input,
        runtime,
        context,
        at.findKey,
        at.stages,
        at.asked,
        reason,
        // Not stopped: a step interrupted on the way here was cut at the cut-off or the deadline.
        "cutoff",
      ),
    );
    logResult(result);
    await commitSpan(runtime, input.lens, phase, "terminal", () =>
      runtime.commit(
        () => ({
          status: "terminal",
          outcome: { status: "completed", result },
        }),
        context,
      ),
    );
  };
  /**
   * Groups and dedupe, once Map has landed: each finding gets the Map group that holds its primary
   * hunk (code, here, so Find reads no Map), then per-finder dedupe and the cap run as before, on
   * the group's tier. Without a Map key (Map and its fallback both missing) the findings cannot be
   * grouped or placed, so the finder has no final list and says why.
   */
  const dedupe = async (
    input: FinderInput,
    found: string | null,
    mapKey: string | null,
    stages: StageRecord[],
    signal: AbortSignal,
  ): Promise<{ findKey: string | null; missing?: string }> => {
    if (found === null) return { findKey: null };
    const stored = await services.run(
      storedOutput(ctx, found, FindOutput),
      signal,
    );
    services.capture({
      type: "findings.returned",
      scope: { runId: ctx.runId, stage: "find" },
      findingIds: stored.findings.map((finding) => finding.id),
    });
    const drop = (leadId: string, reason: string) =>
      services.capture({
        type: "lead.fate",
        scope: { runId: ctx.runId, stage: "verify" },
        leadId,
        handoff: "verify",
        fate: "dropped",
        reason,
      });
    if (mapKey === null) {
      for (const finding of stored.findings)
        drop(finding.id, "map-unavailable");
      return {
        findKey: null,
        missing: "the map is unavailable, so the findings have no group",
      };
    }
    const map = await services.run(
      storedOutput(ctx, mapKey, ReviewMap),
      signal,
    );
    const groupOf = groupOfHunk(map);
    const grouped = stored.findings.flatMap((finding) => {
      const group = groupOf(finding.hunkId);
      return group === undefined ? [] : [{ ...finding, group }];
    });
    const distinct = dedupeFindings(grouped, map);
    const distinctIds = new Set(distinct.map((finding) => finding.id));
    const record = await services.run(
      codeStage(
        ctx,
        "verify",
        {
          // 2: the output's findings carry the group code assigned from Map.
          op: "harness.verify.dedupe",
          opVersion: 2,
          inputs: {
            find: `computation:${found}`,
            map: `computation:${mapKey}`,
          },
        },
        Effect.succeed({
          ...stored,
          findings: distinct.slice(0, 5),
        }),
        {
          agent: `find.${input.lens}.dedupe`,
          schema: FindStored,
          afterCutoff: true,
        },
      ),
      signal,
    );
    stages.push(record);
    if (record.key !== undefined) {
      const deduped = await readFind(record.key, signal);
      const kept = new Set(deduped.findings.map((finding) => finding.id));
      const groupedIds = new Set(grouped.map((finding) => finding.id));
      for (const finding of stored.findings)
        if (!groupedIds.has(finding.id)) drop(finding.id, "no-group");
        else if (!kept.has(finding.id))
          drop(
            finding.id,
            distinctIds.has(finding.id) ? "over-cap" : "duplicate",
          );
    }
    return { findKey: record.key ?? null };
  };
  /** After Find, with the Map key known (null when the run has none): groups, dedupe, then Verify. */
  const afterFind = async (
    task: {
      readonly input: FinderInput;
      readonly state: { readonly checkpoint: { readonly find: number } };
    },
    runtime: Runtime,
    context: Context,
    phase: "map" | "dedupe",
    mapKey: string | null,
  ) => {
    const [outcome] = await runtime.outcomes(
      [childId<StageRecord>(task.state.checkpoint.find)],
      context,
    );
    const failure = failureOf(outcome === undefined ? [] : [outcome]);
    if (failure !== undefined)
      return commitSpan(runtime, task.input.lens, phase, "terminal", () =>
        runtime.commit(
          () => ({ status: "terminal", outcome: failure }),
          context,
        ),
      );
    const found = outcome === undefined ? undefined : resultOf(outcome);
    const stages = found === undefined ? [] : [found];
    const { findKey, missing } = await dedupe(
      task.input,
      found?.key ?? null,
      mapKey,
      stages,
      runtime.signal,
    );
    await commitSpan(runtime, task.input.lens, phase, "verify", () =>
      runtime.commit(
        () => ({
          status: "running",
          checkpoint: {
            phase: "verify",
            findKey,
            stages,
            ...(missing === undefined ? {} : { missing }),
          },
        }),
        context,
      ),
    );
  };
  return definePolicyTask<FinderInput, FinderCheckpoint, FinderResult>({
    name: FINDER_TASK,
    // 3: no Map in the input; the finder waits for the front task (`map`) before dedupe. A
    // version-2 finder never resumes into this shape.
    version: 3,
    initial: () => ({ phase: "find" }),
    phases: {
      find: async (task, runtime, context) => {
        using phaseSpan = phaseOf(runtime, task.input.lens, "find");
        const p = task.input;
        const input = {
          ...stepInput(
            "find",
            {
              lens: p.lens,
              frame: p.frameKey,
              manifest: p.manifestKey,
              finder: runtime.taskId,
            },
            p.cutoffAt,
          ),
          deadline: p.deadline,
        };
        // One commit creates Find (once: a rerun finds it by name) and waits for it.
        const step: { id?: TaskId<StageRecord>; created?: boolean } = {};
        await commitSpan(runtime, p.lens, "find", "map", () =>
          runtime.commit(async (tx) => {
            const children = await tx.doc(ChildrenDoc, runtime.taskId);
            const held = children.children["find"];
            const id =
              held === undefined
                ? await tx.createTask(agentStep, input, {
                    ownership: { kind: "task", taskId: runtime.taskId },
                  })
                : childId<StageRecord>(held);
            children.children["find"] = id;
            step.id = id;
            step.created = held === undefined;
            return {
              status: "waiting",
              checkpoint: { phase: "map", find: id },
              on: [id],
              policy: "allSettled",
            };
          }, context),
        );
        if (step.id === undefined) return;
        if (step.created)
          inputsOf(runtime, step.id, "find", {
            frame: `computation:${p.frameKey}`,
            manifest: `computation:${p.manifestKey}`,
          });
        waiting(runtime, p.lens, "map", "find", [step.id]);
      },
      map: async (task, runtime, context) => {
        using phaseSpan = phaseOf(runtime, task.input.lens, "map");
        const mapKey = await mapKeyOf(task.input, runtime, context);
        if (mapKey !== undefined)
          return afterFind(task, runtime, context, "map", mapKey);
        // Find ended before Map landed: wait for the front task (not a child), then dedupe.
        await commitSpan(runtime, task.input.lens, "map", "dedupe", () =>
          runtime.commit(
            () => ({
              status: "waiting",
              checkpoint: { phase: "dedupe", find: task.state.checkpoint.find },
              on: [childId(task.input.front)],
              policy: "allSettled",
            }),
            context,
          ),
        );
        waiting(runtime, task.input.lens, "dedupe", "map", [task.input.front]);
      },
      dedupe: async (task, runtime, context) => {
        using phaseSpan = phaseOf(runtime, task.input.lens, "dedupe");
        await afterFind(
          task,
          runtime,
          context,
          "dedupe",
          (await mapKeyOf(task.input, runtime, context)) ?? null,
        );
      },
      verify: async (task, runtime, context) => {
        using phaseSpan = phaseOf(runtime, task.input.lens, "verify");
        const at = task.state.checkpoint;
        const found =
          at.findKey === null
            ? undefined
            : await readFind(at.findKey, runtime.signal);
        const claims = (found?.findings ?? []).map((f) =>
          verifyChild(
            runtime.taskId,
            task.input.frameKey,
            task.input.cutoffAt,
            f,
            at.findKey ?? undefined,
          ),
        );
        const final = new Set(claims.map((claim) => claim.name));
        let started: Array<{ name: string; id: number }> = [];
        let live: TaskId<StageRecord>[] = [];
        let settled = 0;
        let unused = 0;
        let unusedRunning = 0;
        // One commit starts the Verify of every final claim no record call started and waits for
        // the used Verifies still running: a phase rerun after a crash before it starts nothing
        // twice, and one after it is past this phase. Unused Verifies are waited for only after the
        // reason is decided (`done`), so their end decides nothing.
        await commitSpan(runtime, task.input.lens, "verify", "done", () =>
          runtime.commit(async (tx) => {
            started = [];
            live = [];
            const children = await tx.doc(ChildrenDoc, runtime.taskId);
            // Reads before writes: a commit reads no task after it creates one.
            const held = Object.keys(children.children).filter(isVerify);
            unusedRunning = 0;
            for (const name of held) {
              const id = childId<StageRecord>(children.children[name]!);
              if ((await tx.task(id))?.state.status === "terminal") continue;
              if (final.has(name)) live.push(id);
              else unusedRunning++;
            }
            for (const claim of claims) {
              if (children.children[claim.name] !== undefined) continue;
              const id = await tx.createTask(agentStep, claim.input, {
                ownership: { kind: "task", taskId: runtime.taskId },
              });
              children.children[claim.name] = id;
              started.push({ name: claim.name, id });
              live.push(id);
            }
            unused = held.filter((name) => !final.has(name)).length;
            settled =
              held.length + started.length - live.length - unusedRunning;
            return {
              status: "waiting",
              checkpoint: {
                phase: "done",
                findKey: at.findKey,
                stages: at.stages,
                asked: started.map((child) => child.name),
                ...(at.missing === undefined ? {} : { missing: at.missing }),
              },
              on: live,
              policy: "allSettled",
            };
          }, context),
        );
        for (const child of started) {
          const claim = claims.find((c) => c.name === child.name);
          startLogSpan(ctx.log, CHILD_STARTED_SPAN, {
            ...claim?.attributes,
            "harness.child": child.name,
            "harness.task_id": child.id,
            "harness.owner_task_id": runtime.taskId,
            "harness.asked_by": "verify-phase",
          })();
          if (claim !== undefined)
            inputsOf(runtime, child.id, claim.kind, claim.inputs, {
              child: child.name,
              askedBy: "verify-phase",
            });
        }
        waiting(runtime, task.input.lens, "done", "verify", live, {
          "harness.verify.final": claims.length,
          "harness.verify.asked_at_record": claims.length - started.length,
          "harness.verify.asked_at_verify": started.length,
          "harness.verify.unused": unused,
          // Used Verifies waited for (still running, or started now; the ids above) and those
          // already finished, which the wait does not include.
          "harness.verify.waiting": live.length,
          "harness.verify.settled": settled,
          // Unused Verifies still running: waited for after the reason is decided (`done`).
          "harness.verify.unused_running": unusedRunning,
        });
      },
      done: async (task, runtime, context) => {
        using phaseSpan = phaseOf(runtime, task.input.lens, "done");
        const at = task.state.checkpoint;
        // Decided when the used Verifies ended, as before: an unused one cannot move it.
        const reason =
          at.missing ??
          (runtime.now() >= task.input.cutoffAt ? "cutoff" : undefined);
        // An unused Verify still running cannot be stopped (a task cannot abort a child that has
        // not failed); the finder waits for it so it does not end before its own work, but that
        // wait decides nothing.
        const children = await runtime.snapshot(
          ChildrenDoc,
          runtime.taskId,
          context,
        );
        const running: TaskId<StageRecord>[] = [];
        for (const [name, held] of Object.entries(children?.children ?? {})) {
          if (!isVerify(name)) continue;
          const id = childId<StageRecord>(held);
          if ((await runtime.getTask(id, context))?.state.status !== "terminal")
            running.push(id);
        }
        if (running.length > 0) {
          await commitSpan(runtime, task.input.lens, "done", "settle", () =>
            runtime.commit(
              () => ({
                status: "waiting",
                checkpoint: { ...at, phase: "settle", reason: reason ?? null },
                on: running,
                policy: "allSettled",
              }),
              context,
            ),
          );
          waiting(
            runtime,
            task.input.lens,
            "settle",
            "unused-verify",
            running,
            {
              "harness.verify.unused_running": running.length,
            },
          );
          return;
        }
        await finish(task.input, runtime, context, at, reason, "done");
      },
      settle: async (task, runtime, context) => {
        using phaseSpan = phaseOf(runtime, task.input.lens, "settle");
        const at = task.state.checkpoint;
        await finish(
          task.input,
          runtime,
          context,
          at,
          at.reason ?? undefined,
          "settle",
        );
      },
    },
    abort: async (task, runtime, context) => {
      waits.resumed(runtime.taskId);
      const terminal = (work: () => Promise<void>) =>
        commitSpan(runtime, task.input.lens, "abort", "terminal", work);
      const children = await runtime.snapshot(
        ChildrenDoc,
        runtime.taskId,
        context,
      );
      // Find's failure first; a used Verify's comes from `compose`, an unused one's never.
      const ids = Object.entries(children?.children ?? {}).filter(
        ([name]) => !isVerify(name),
      );
      const outcomes = await runtime.outcomes(
        ids.map(([, id]) => childId<StageRecord>(id)),
        context,
      );
      const failure = failureOf(outcomes);
      if (failure !== undefined)
        return terminal(() =>
          runtime.commit(
            () => ({ status: "terminal", outcome: failure }),
            context,
          ),
        );
      const at = task.state.checkpoint;
      const find = resultOf(
        outcomes[ids.findIndex(([name]) => name === "find")] ?? {
          status: "aborted",
          reason: "stopped",
        },
      );
      const composing =
        at.phase === "verify" || at.phase === "done" || at.phase === "settle";
      const stages: Array<StageRecord> = composing
        ? at.stages
        : find === undefined
          ? // Aborted before Find returned: the lens never searched, so the packet is partial (12.41).
            [
              {
                stage: "find",
                agent: `find.${task.input.lens}`,
                status: "interrupted",
                wallMs: 0,
                disclosure: null,
              },
            ]
          : [find];
      let findKey = composing ? at.findKey : (find?.key ?? null);
      let missing = composing ? at.missing : undefined;
      // Stopped before dedupe: groups need Map, which is there only if the front task has ended.
      if (!composing) {
        const deduped = await dedupe(
          task.input,
          findKey,
          (await mapKeyOf(task.input, runtime, context)) ?? null,
          stages,
          runtime.signal,
        );
        findKey = deduped.findKey;
        missing = deduped.missing;
      }
      const stop = runtime.now() >= task.input.cutoffAt ? "cutoff" : "stopped";
      const reason = missing ?? stop;
      const composed = await compose(
        task.input,
        runtime,
        context,
        findKey,
        stages,
        at.phase === "done" || at.phase === "settle" ? at.asked : [],
        // Stopped while only unused Verifies ran, at the cut-off: every used Verify had ended,
        // so the reason decided then stands.
        at.phase === "settle" && stop === "cutoff"
          ? (at.reason ?? undefined)
          : reason,
        stop,
      );
      if ("failure" in composed) {
        const { failure: failed } = composed;
        return terminal(() =>
          runtime.commit(
            () => ({ status: "terminal", outcome: failed }),
            context,
          ),
        );
      }
      const { result } = composed;
      logResult(result);
      await terminal(() =>
        runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "aborted", reason: stop, result },
          }),
          context,
        ),
      );
    },
  });
};
