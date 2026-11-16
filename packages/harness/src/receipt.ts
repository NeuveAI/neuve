import { judgementCounts } from "./judgement-trace.ts";
import { effectiveCutoffAt } from "./run-schedule.ts";

import { z } from "zod";
import {
  CallUsage as RuntimeCallUsage,
  type RuntimeEvent,
} from "@neuve/runtime";
import { contractUsage } from "./pi/stages/contract-schema.ts";

import { Clock, Effect } from "effect";
import {
  Blobs,
  Identity,
  type IdempotencyConflict,
  Log,
  canonicalJson,
  mintUlid,
  sha256Hex,
} from "@neuve/records-core";
import {
  PAYLOAD_MAX_BYTES,
  ReceiptLists,
  RunReceipt,
  type CallTokenUsage,
  type ModelCallAttempts,
  type Range,
  type StageTelemetry,
} from "@neuve/records-schema";
import { type Stage } from "./budget.ts";
import type { PipelineConfig } from "./config.ts";
import type { FinderStatus } from "./pi/stages/finder-task.ts";
import type { StageRecord } from "./pipeline.ts";
import {
  routeAccount,
  addUsage,
  costOf,
  zeroUsage,
  type CallUsage,
} from "./route.ts";
import type { RunLog, RunLogRecord } from "./run-log.ts";

/**
 * The run receipt (proposal §10.2, PU6, 10.73): route, key
 * variable and organisation; tokens and cost by stage; turns per agent against the ruled limits;
 * whether the final generation ran; actual against expected time; the timeout outcome (10.42);
 * queue wait, retries and wall time. Records holds it as `run.completed@1` and each stage as
 * `stage.completed@1` (10.32); the run log keeps a copy for telemetry. The day-one counts that are
 * facts of the cycle's events (10.55, 10.62, 10.63, merges and splits) are read from Records'
 * projections, never copied here. The unit counts at 10, 20 and 40 lines (10.70) come from
 * Assemble's telemetry; a run that assembled no batch says they are not measured rather than
 * reporting zeros.
 */

/** Existing code-stage expectations; the new agent stages await calibration. */
export const EXPECTED_MS: Readonly<Partial<Record<Stage, number>>> = {
  precompute: 15_000,
  publish: 15_000,
  link: 15_000,
};

/** A receipt with the run, range and cycle its `run.completed@1` event carries as attribution. */
export type CallAttemptCounts = Partial<Omit<ModelCallAttempts, "modelCalls">>;
export type StageCallTelemetry = StageTelemetry & CallAttemptCounts;

export type Receipt = Omit<RunReceipt, "stages" | "totals"> & {
  readonly stages: StageCallTelemetry[];
  readonly totals: RunReceipt["totals"] & CallAttemptCounts;
  readonly type: "receipt";
  readonly runId: string;
  readonly range: Range;
  readonly cycleId: string;
};

export interface ReceiptInput {
  readonly runId: string;
  readonly runKey: string;
  readonly generation: number;
  readonly jobSeq: number;
  readonly range: Range;
  readonly cycleId: string;
  readonly config: PipelineConfig;
  readonly enqueuedAt: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly stages: ReadonlyArray<StageRecord>;
  readonly records: ReadonlyArray<RunLogRecord>;
}

/** Refusals consume completed turns; older logs kept only the raw provider stop reason. */
export const isCompletedModelCall = (record: RunLogRecord) =>
  record.type === "model.call" &&
  record["finishReason"] !== "aborted" &&
  (record["finishReason"] !== "error" ||
    record["refused"] === true ||
    (record["refused"] === undefined &&
      (record["stopReason"] === "refusal" ||
        record["stopReason"] === "incomplete.content_filter")));

export const modelCallCounts = (records: ReadonlyArray<RunLogRecord>) => {
  const calls = records.filter((record) => record.type === "model.call");
  const failedModelCalls = calls.filter(
    (record) =>
      record["finishReason"] === "error" && !isCompletedModelCall(record),
  ).length;
  const abortedModelCalls = calls.filter(
    (record) => record["finishReason"] === "aborted",
  ).length;
  return {
    modelCalls: calls.length - failedModelCalls - abortedModelCalls,
    failedModelCalls,
    abortedModelCalls,
  };
};
const attemptFields = (
  records: ReadonlyArray<RunLogRecord>,
  config: PipelineConfig,
) => {
  const counts = modelCallCounts(records);
  if (!counts.failedModelCalls && !counts.abortedModelCalls)
    return { modelCalls: counts.modelCalls };
  const failed = records.filter(
    (record) =>
      record.type === "model.call" &&
      record["finishReason"] === "error" &&
      !isCompletedModelCall(record),
  );
  const aborted = records.filter(
    (record) =>
      record.type === "model.call" && record["finishReason"] === "aborted",
  );
  const failedUsage = usageOf(failed),
    abortedUsage = usageOf(aborted);
  return {
    ...counts,
    failedUsage: tokenUsage(failedUsage),
    failedCostUsd: failed.some((record) => record["usage"] === undefined)
      ? null
      : usd(config, failedUsage),
    abortedUsage: tokenUsage(abortedUsage),
    abortedCostUsd: aborted.some((record) => record["usage"] === undefined)
      ? null
      : usd(config, abortedUsage),
  };
};

export const callAttemptTelemetry = (
  value: { readonly modelCalls: number } & CallAttemptCounts,
): ModelCallAttempts => ({
  modelCalls: value.modelCalls,
  failedModelCalls: value.failedModelCalls ?? 0,
  abortedModelCalls: value.abortedModelCalls ?? 0,
  failedUsage: value.failedUsage ?? tokenUsage(zeroUsage),
  failedCostUsd: value.failedCostUsd ?? null,
  abortedUsage: value.abortedUsage ?? tokenUsage(zeroUsage),
  abortedCostUsd: value.abortedCostUsd ?? null,
});
export const legacyStageTelemetry = ({
  failedModelCalls: _failed,
  abortedModelCalls: _aborted,
  failedUsage: _failedUsage,
  failedCostUsd: _failedCost,
  abortedUsage: _abortedUsage,
  abortedCostUsd: _abortedCost,
  ...stage
}: StageCallTelemetry): StageTelemetry => stage;

const usageOf = (records: ReadonlyArray<RunLogRecord>, contract = false) => {
  if (contract) {
    const ledger = z.object({
      contextKey: z.string(),
      at: z.iso.datetime({ offset: true }),
      turnId: z.string(),
      model: z.string(),
      scope: z.enum(["request", "turn"]),
      revision: z.int().nonnegative(),
      usage: RuntimeCallUsage,
    });
    const contexts = new Map<
      string,
      { revision: number; event: RuntimeEvent }[]
    >();
    for (const record of records) {
      if (record.type !== "runtime.usage") continue;
      const { contextKey, revision, ...usage } = ledger.parse(record);
      const entries = contexts.get(contextKey) ?? [];
      entries.push({
        revision,
        event: { type: "usage", costUsd: null, ...usage },
      });
      contexts.set(contextKey, entries);
    }
    return [...contexts.values()].reduce(
      (sum, entries) =>
        addUsage(
          sum,
          contractUsage({
            events: entries
              .sort((a, b) => a.revision - b.revision)
              .map(({ event }) => event),
          }),
        ),
      zeroUsage,
    );
  }
  return records
    .filter((record) => record.type === "model.call")
    .reduce<CallUsage>(
      (sum, record) =>
        addUsage(sum, (record["usage"] as CallUsage | undefined) ?? zeroUsage),
      zeroUsage,
    );
};

/** Usage as Records stores it: thinking only when the provider reported it. */
const tokenUsage = (usage: CallUsage): CallTokenUsage => ({
  input: usage.input,
  cacheWrite5m: usage.cacheWrite5m,
  cacheWrite1h: usage.cacheWrite1h,
  cacheRead: usage.cacheRead,
  output: usage.output,
  ...(usage.thinking === undefined ? {} : { thinking: usage.thinking }),
});

const usd = (config: PipelineConfig, usage: CallUsage) =>
  nullableUsd(costOf(config.route, usage));

/** Rounded to the micro-dollar; null stays null (a route with no per-token price). */
const nullableUsd = (usd: number | null) =>
  usd === null ? null : Number(usd.toFixed(6));

/**
 * One stage's telemetry from its record and the run log's model calls for its agent (10.32): what
 * `stage.completed@1` carries and the receipt lists.
 */
export const stageTelemetry = (
  stage: StageRecord,
  records: ReadonlyArray<RunLogRecord>,
  config: PipelineConfig,
): StageCallTelemetry => {
  const agent = stage.agent ?? stage.stage;
  const own = records.filter(
    (record) =>
      (record.type === "model.call" || record.type === "runtime.usage") &&
      record["agent"] === agent,
  );
  const usage =
    config.route.provider === "claude"
      ? usageOf(own, true)
      : usageOf(own.filter(isCompletedModelCall));
  const result = stage.agentResult;
  const limit =
    result === undefined
      ? undefined
      : {
          turns: result.turnLimit,
          per:
            stage.stage === "find"
              ? "finder"
              : stage.stage === "verify"
                ? "finding"
                : "agent",
        };
  return {
    stage: stage.stage,
    agent,
    status: stage.status,
    wallMs: Math.max(0, Math.round(stage.wallMs)),
    // A stage's code step beside its agents (the change map, the partition plan) has no expectation.
    ...(stage.agent !== undefined &&
    stage.agent !== stage.stage &&
    stage.agentResult === undefined
      ? {}
      : { expectedMs: EXPECTED_MS[stage.stage] }),
    ...(result === undefined
      ? {}
      : {
          turns: {
            turnsUsed: result.turnsUsed,
            turnLimit: result.turnLimit,
            ...(limit === undefined
              ? {}
              : { ruledLimit: `${limit.turns} per ${limit.per}` }),
            limitReached: result.turnsUsed >= result.turnLimit,
            finalGeneration: result.finalGeneration,
            endedBy: result.endedBy,
            resumedTurns: result.resumedTurns,
            restarted: result.restarted,
          },
        }),
    ...(config.route.provider === "claude"
      ? modelCallCounts(own)
      : attemptFields(own, config)),
    usage: tokenUsage(usage),
    costUsd: usd(config, usage),
    ...(stage.note === undefined ? {} : { note: stage.note.slice(0, 2_000) }),
  };
};

/**
 * The Verifies the review's stages do not list: each started when its finding was recorded, for a
 * claim its finder's final list does not hold (finder-task.ts). Its own `stage` row, when it wrote
 * one, is in the run log and its calls are in the totals, but it is no stage of the review, so
 * readers of `stages` (the timeout, what was published, the evaluation's execution) never see it.
 * The receipt says once, in counts only, how much of the totals is theirs; absent when every Verify
 * was used.
 */
const unusedVerifyNote = (
  stages: ReadonlyArray<StageRecord>,
  records: ReadonlyArray<RunLogRecord>,
): string | undefined => {
  const listed = new Set(stages.map((stage) => stage.agent ?? stage.stage));
  // From its `stage` row or its model calls: a step that ends by failing or a thrown fault writes no
  // `stage` row, and its calls are still in the totals (the finder counts them the same way).
  const unused = new Set(
    records.flatMap((record) => {
      const agent = record["agent"];
      return (record.type === "stage" || record.type === "model.call") &&
        typeof agent === "string" &&
        agent.startsWith("verify.") &&
        !listed.has(agent)
        ? [agent]
        : [];
    }),
  );
  if (unused.size === 0) return undefined;
  const counts = modelCallCounts(
    records.filter(
      (record) =>
        record.type === "model.call" &&
        typeof record["agent"] === "string" &&
        unused.has(record["agent"]),
    ),
  );
  const steps =
    unused.size === 1
      ? "1 Verify step ran for a claim its finder's final list does not hold, so it gave no verdict and no stage row lists it"
      : `${unused.size} Verify steps ran for claims their finders' final lists do not hold, so they gave no verdict and no stage row lists them`;
  const attempts =
    counts.failedModelCalls || counts.abortedModelCalls
      ? ` (failed attempts: ${counts.failedModelCalls}, aborted: ${counts.abortedModelCalls})`
      : "";
  return `${steps}; model calls of the totals that are theirs: ${counts.modelCalls}${attempts}`;
};

const text = (value: unknown, fallback: string) =>
  typeof value === "string" && value !== "" ? value.slice(0, 2_000) : fallback;

/** The run's one disclosure that history is not consulted yet (10.3), once per run, never per unit. */
export const HISTORY_DISCLOSURE =
  "The change's history (earlier commits, reviews and bugs) wasn't consulted: Neuve doesn't read it yet, so it moves no unit's lane.";
/** How the receipt names a finder's step's end (`FinderStatus`); undefined for no known status. */
const finderStatusLabel = (status: FinderStatus): string => {
  switch (status) {
    case "completed":
      return "completed";
    case "cutoff":
      return "cut at the cut-off";
    case "stopped":
      return "stopped";
    case "skipped":
      return "skipped";
    case "failed":
      return "failed";
  }
};
const labelOf = (value: unknown) =>
  typeof value === "string"
    ? (finderStatusLabel(value as FinderStatus) as string | undefined)
    : undefined;
/**
 * Each finder's end, as the review's last `finders.ended` row has it (`pi/review-task.ts`): one
 * disclosed line, `<lens>: find <status>, Verify <status>` per finder, and whether a follow-on runs
 * it again. Absent when the run reached no Link (no finder ended there).
 */
export const findersEndedLine = (records: ReadonlyArray<RunLogRecord>) => {
  const row = records.filter((r) => r.type === "finders.ended").at(-1);
  const finders = row?.["finders"];
  if (!Array.isArray(finders) || finders.length === 0) return undefined;
  const parts = finders.map((entry: Record<string, unknown>) => {
    const find = labelOf(entry["find"]) ?? "unknown";
    const verify = labelOf(entry["verify"]) ?? "unknown";
    return `${text(entry["lens"], "a finder")}: find ${find}, Verify ${verify}${entry["again"] === true ? " (a follow-on runs it again)" : ""}`;
  });
  return `Finders: ${parts.join("; ")}.`;
};
/**
 * The receipt's line when any finder answered at its own time limit (the review's `finders.ended`
 * row says `atLimit`, `findersAtLimit`); undefined otherwise, so the receipt is as before.
 */
export const findersAtLimitLine = (records: ReadonlyArray<RunLogRecord>) =>
  records.filter((r) => r.type === "finders.ended").at(-1)?.["atLimit"] === true
    ? "The finders answered at their time limit."
    : undefined;
/**
 * The unit counts at 10, 20 and 40 lines (10.70) from Assemble's telemetry: one record per candidate
 * batch, the last one when a resumed attempt wrote it again; absent when no batch was assembled.
 */
const unitCountsOf = (records: ReadonlyArray<RunLogRecord>) => {
  const byCandidate = new Map<string, RunLogRecord>();
  for (const record of records)
    if (record.type === "assemble.grouping")
      byCandidate.set(String(record["candidate"]), record);
  if (byCandidate.size === 0) return undefined;
  const sum = (field: string) =>
    [...byCandidate.values()].reduce(
      (total, record) => total + Number(record[field] ?? 0),
      0,
    );
  return { at10: sum("at10"), at20: sum("at20"), at40: sum("at40") };
};

export const buildReceipt = (input: ReceiptInput): Receipt => {
  const { config, records } = input;
  const observed = records
    .filter((r) => r.type === "budget.receipt")
    .flatMap((r) => {
      const parsed = z
        .object({
          limit: z.number().int().min(1).max(32),
          floor: z.number().min(0).max(1),
        })
        .safeParse(r);
      return parsed.success ? [parsed.data] : [];
    });
  const actualLimit = observed.at(-1)?.limit;
  const usedFloor =
    observed.some((r) => r.floor === 1) ||
    records.some((r) => r.type === "budget.floor" && r.floor === 1);
  const calls = records.filter((record) => record.type === "model.call");
  const attempts = records.filter((record) => record.type === "run.started");
  const preflight = [...records]
    .reverse()
    .find((record) => record.type === "preflight");
  const gaps = records.filter((record) => record.type === "gap");
  const cutoff = effectiveCutoffAt(input.startedAt, config.budgets);
  const cutShort = (stage: StageRecord) =>
    stage.status === "interrupted" || stage.status === "skipped";
  const timedOut = input.stages.some(cutShort);
  const usage =
    config.route.provider === "claude"
      ? usageOf(records, true)
      : usageOf(calls.filter(isCompletedModelCall));
  const organization = preflight?.["organization"];
  const unitCounts = unitCountsOf(records);
  const account = routeAccount(config.route);
  const credential = (() => {
    const route = config.route;
    switch (route.provider) {
      case "anthropic":
        return { credentialVariable: route.credentialVariable };
      case "openai":
        return { credentialSource: route.credentialSource };
      case "claude":
        return {};
      default: {
        const exhaustive: never = route;
        return exhaustive;
      }
    }
  })();
  const findersLine = findersEndedLine(records);
  const limitLine = findersAtLimitLine(records);
  const unusedNote = unusedVerifyNote(input.stages, records);
  return {
    type: "receipt",
    runId: input.runId,
    range: input.range,
    cycleId: input.cycleId,
    runKey: input.runKey,
    generation: input.generation,
    jobSeq: input.jobSeq,
    route: {
      ...(account === undefined
        ? {}
        : { account: { name: account.name, kind: account.kind } }),
      provider: config.route.provider,
      model: config.route.model,
      effort: config.route.effort,
      maxOutputTokens: config.route.maxOutputTokens,
      contextCeiling: config.budgets.contextCeiling,
      callsInFlight: actualLimit ?? config.budgets.callsInFlight,
      ...(actualLimit === undefined
        ? {}
        : {
            callsInFlightMin: Math.min(...observed.map((r) => r.limit)),
            callsInFlightMax: Math.max(...observed.map((r) => r.limit)),
            configuredCallsInFlight: config.budgets.callsInFlight,
          }),
      ...(usedFloor ? { budgetFloor: true } : {}),
      ...credential,
      organization:
        typeof organization === "string" && organization !== ""
          ? organization
          : null,
      // No per-token price (the ChatGPT plan): an empty table, and the cost reads as unknown.
      price: config.route.price ?? {},
    },
    outcome: timedOut ? "timed-out" : "completed",
    timeout: {
      lifetimeMs: config.budgets.lifetimeMs,
      cutoffAt: new Date(cutoff).toISOString(),
      reached: timedOut,
      published: input.stages
        .filter(
          (stage) => stage.status === "computed" || stage.status === "reused",
        )
        .map((stage) => stage.agent ?? stage.stage),
      disclosed: input.stages.filter(cutShort).map((stage) => ({
        stage: stage.agent ?? stage.stage,
        status: stage.status,
        ...(stage.note === undefined
          ? {}
          : { note: stage.note.slice(0, 2_000) }),
      })),
    },
    timing: {
      enqueuedAt: input.enqueuedAt,
      startedAt: new Date(input.startedAt).toISOString(),
      endedAt: new Date(input.endedAt).toISOString(),
      wallMs: input.endedAt - input.startedAt,
      // Queue wait is its own line: the run's clock starts at its first attempt (10.15).
      queueWaitMs: input.startedAt - Date.parse(input.enqueuedAt),
      attempts: attempts.length,
    },
    stages: input.stages.map((stage) => stageTelemetry(stage, records, config)),
    totals: {
      ...(config.route.provider === "claude"
        ? modelCallCounts(calls)
        : attemptFields(calls, config)),
      retries:
        records.filter(
          (record) =>
            record.type === "model.native-attempt" && record["retry"] === true,
        ).length +
        calls.reduce(
          (sum, record) =>
            sum +
            ((record["retries"] as ReadonlyArray<unknown> | undefined)
              ?.length ?? 0),
          0,
        ),
      usage: tokenUsage(usage),
      costUsd: usd(config, usage),
    },
    gaps: gaps.map((gap) => ({
      stage: text(gap["stage"], "run"),
      ...(typeof gap["agent"] === "string" ? { agent: gap["agent"] } : {}),
      kind: text(gap["kind"], "unnamed"),
      detail: text(gap["detail"], "no detail recorded"),
    })),
    disclosures: [
      HISTORY_DISCLOSURE,
      ...(findersLine === undefined ? [] : [findersLine]),
      ...(limitLine === undefined ? [] : [limitLine]),
    ],
    ...(unitCounts === undefined ? {} : { unitCounts }),
    notMeasured: {
      ...(unitCounts === undefined
        ? {
            unitCounts:
              "unit counts at 10, 20 and 40 lines (10.70): no batch was assembled in this run",
          }
        : {}),
      ...(unusedNote === undefined ? {} : { unusedVerifies: unusedNote }),
    },
    ...(config.stub === undefined
      ? {}
      : { stubSettings: JSON.parse(JSON.stringify(config.stub)) }),
  };
};

/** The harness actor for one stage of one run (proposal §3.7: a fan-out stage is one actor). */
export const harnessActor = (runId: string, stage: Stage) =>
  Identity.agentFingerprint({
    harness: "neuve",
    sessionId: runId,
    subagentId: stage,
  });

/** The registration of a stage's actor, so its vents and records have an alias. */
export const harnessRegistration = (
  runId: string,
  stage: Stage,
  occurredAt: string,
) => {
  const actor = harnessActor(runId, stage);
  const payload = {
    actorKind: "agent",
    harness: "neuve",
    sessionId: runId,
    subagentId: stage,
    agentType: `harness.${stage}`,
  };
  return {
    id: mintUlid(),
    kind: "actor.registered@1",
    idempotencyKey: `actor:${actor}:${sha256Hex(canonicalJson(payload)).slice(0, 16)}`,
    actor,
    occurredAt,
    payload,
  };
};

/**
 * Appends telemetry events one at a time. A replayed stage or Publish (the engine's at-least-once
 * activities, or a later attempt after a crash) records the same key with new timings; the first
 * record stands, and the run log says so. Any other failure fails the attempt, so the queue retries
 * it: Records is the source of truth (10.32).
 */
export const appendTelemetry = (
  log: RunLog,
  events: ReadonlyArray<Record<string, unknown>>,
) =>
  Effect.forEach(events, (event) =>
    Log.append([event]).pipe(
      Effect.map(([result]) => result?.status ?? "appended"),
      Effect.catchTag("IdempotencyConflict", (conflict: IdempotencyConflict) =>
        Effect.sync(() => {
          log.write({
            type: "records",
            status: "kept-earlier",
            kind: event["kind"],
            idempotencyKey: conflict.idempotencyKey,
            existingEventId: conflict.existingEventId,
          });
          return "kept-earlier" as const;
        }),
      ),
    ),
  );

/**
 * The receipt as a `run.completed@1` payload and refs. Its lists (stages, gaps, what was published
 * and disclosed) go into one durable blob when they would take the payload past the 64 KB cap
 * (5.3, D5); the payload then keeps their sizes, so the receipt's scalars stay in the event.
 */
const receiptPayload = (payload: RunReceipt) =>
  Effect.gen(function* () {
    const bytes = new TextEncoder().encode(canonicalJson(payload)).length;
    // Inline only when the payload fits and its lists are within the event's caps; otherwise the
    // lists go to the blob, checked here against the same schema the readers parse it with.
    if (bytes <= PAYLOAD_MAX_BYTES && RunReceipt.safeParse(payload).success)
      return { payload };
    const lists = ReceiptLists.parse({
      stages: payload.stages,
      gaps: payload.gaps,
      published: payload.timeout.published,
      disclosed: payload.timeout.disclosed,
    });
    const blobs = yield* Blobs.BlobStore;
    const stored = yield* blobs.put({
      bytes: new TextEncoder().encode(canonicalJson(lists)),
      mediaType: "application/json",
      retention: "durable",
    });
    return {
      payload: {
        ...payload,
        stages: [],
        gaps: [],
        timeout: { ...payload.timeout, published: [], disclosed: [] },
        listsByReference: {
          stages: lists.stages.length,
          gaps: lists.gaps.length,
          published: lists.published.length,
          disclosed: lists.disclosed.length,
        },
      } satisfies RunReceipt,
      refs: [{ ref: `blob:${stored.blob.hash}`, role: "lists" }],
    };
  });

/**
 * Publish's receipt step (proposal §10.2): the run's receipt as `run.completed@1`, with the run's
 * one disclosure that history is not consulted as a `gap.disclosed@1` (10.3), appended by the
 * Publish actor. The run log keeps a copy for telemetry. Stage gaps and cut-off stages are recorded
 * as each stage ends (the pipeline's `recordStage`).
 */
export const recordReceipt = (log: RunLog, receipt: Receipt) =>
  Effect.gen(function* () {
    log.write(receipt);
    const { type: _type, runId, range, cycleId, ...receiptFields } = receipt;
    const occurredAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    const actor = harnessActor(runId, "publish");
    const {
      failedModelCalls: _failed,
      abortedModelCalls: _aborted,
      failedUsage: _failedUsage,
      failedCostUsd: _failedCost,
      abortedUsage: _abortedUsage,
      abortedCostUsd: _abortedCost,
      ...totals
    } = receiptFields.totals;
    const event = yield* receiptPayload({
      ...receiptFields,
      totals,
      stages: receiptFields.stages.map(legacyStageTelemetry),
    });
    const counts = callAttemptTelemetry(receipt.totals);
    const statuses = yield* appendTelemetry(log, [
      harnessRegistration(runId, "publish", occurredAt),
      {
        id: mintUlid(),
        kind: "judgement.counted@1",
        idempotencyKey: `review:${runId}:judgements`,
        actor,
        occurredAt,
        attribution: { cycleId, range, runId },
        payload: judgementCounts(log.read()),
      },
      {
        id: mintUlid(),
        kind: "gap.disclosed@1",
        idempotencyKey: `review:${runId}:gap:run:history-not-consulted`,
        actor,
        occurredAt,
        attribution: { cycleId, range, runId },
        payload: { kind: "history-not-consulted", detail: HISTORY_DISCLOSURE },
      },
      ...(counts.failedModelCalls || counts.abortedModelCalls
        ? [
            {
              id: mintUlid(),
              kind: "model.calls-counted@2",
              idempotencyKey: `review:${runId}:calls:v2:run`,
              actor,
              occurredAt,
              attribution: { cycleId, range, runId },
              payload: counts,
            },
          ]
        : []),
      {
        id: mintUlid(),
        kind: "run.completed@1",
        idempotencyKey: `review:${runId}:run.completed`,
        actor,
        occurredAt,
        attribution: { cycleId, range, runId, stage: "publish" },
        ...event,
      },
    ]);
    log.write({
      type: "records",
      kind: "run.completed@1",
      status: statuses.at(-1),
    });
  });

/**
 * The receipt a `run.completed@1` holds, with its lists read back from their blob when they went by
 * reference. `readLists` reads that blob's bytes.
 */
export const receiptFromEvent = <E, R>(
  event: {
    readonly attribution: {
      readonly runId: string;
      readonly range: Range;
      readonly cycleId: string;
    };
    readonly payload: RunReceipt;
    readonly refs?: ReadonlyArray<{ readonly ref: string }> | undefined;
  },
  readLists: (hash: string) => Effect.Effect<ReceiptLists, E, R>,
) =>
  Effect.gen(function* () {
    const { runId, range, cycleId } = event.attribution;
    const lists = event.refs?.[0];
    const payload =
      lists === undefined || event.payload.listsByReference === undefined
        ? event.payload
        : yield* Effect.map(
            readLists(lists.ref.slice("blob:".length)),
            (read): RunReceipt => ({
              ...event.payload,
              stages: read.stages,
              gaps: read.gaps,
              timeout: {
                ...event.payload.timeout,
                published: read.published,
                disclosed: read.disclosed,
              },
            }),
          );
    const receipt: Receipt = {
      type: "receipt",
      runId,
      range,
      cycleId,
      ...payload,
    };
    return receipt;
  });

const fmtUsd = (usd: number) => `$${usd.toFixed(4)}`;
/** The cost, or that it is unknown when the route has no price table (the ChatGPT plan). */
/** An unpriced cost names the plan by the route's account kind; a receipt without one is ChatGPT's, as before. */
const fmtCost = (usd: number | null, kind?: string | undefined) =>
  usd !== null
    ? fmtUsd(usd)
    : kind === "claude-subscription"
      ? "USD unknown (Claude plan usage)"
      : "USD unknown (ChatGPT plan usage)";
const fmtMs = (ms: number | null | undefined) =>
  ms === null || ms === undefined
    ? "-"
    : ms < 1000
      ? `${ms} ms`
      : `${(ms / 1000).toFixed(1)} s`;
const fmtTokens = (u: CallTokenUsage) =>
  `in ${u.input} · cache write ${u.cacheWrite5m + u.cacheWrite1h} · cache read ${u.cacheRead} · out ${u.output}${u.thinking === undefined ? "" : ` (thinking ${u.thinking})`}`;

/** The receipt as `neuve review show` prints it. */
export const formatReceipt = (receipt: Receipt) => {
  const lines = [
    `Run ${receipt.runId} (generation ${receipt.generation}, job ${receipt.jobSeq}): ${receipt.outcome}`,
    `range      ${receipt.range.baseRef} ${receipt.range.baseOid.slice(0, 12)}..${receipt.range.headOid.slice(0, 12)}`,
    `route      ${receipt.route.provider}/${receipt.route.model}, effort ${receipt.route.effort}, output cap ${receipt.route.maxOutputTokens.toLocaleString("en")}, ceiling ${receipt.route.contextCeiling.toLocaleString("en")}, ${receipt.route.callsInFlight} calls in flight${receipt.route.callsInFlightMin === undefined ? "" : ` (observed ${receipt.route.callsInFlightMin} to ${receipt.route.callsInFlightMax})`}${receipt.route.budgetFloor ? "; recovery floor used" : ""}`,
    `key from   ${receipt.route.provider === "claude" && receipt.route.account?.kind === "claude-subscription" ? `the Claude Code sign-in of account ${receipt.route.account.name}` : (receipt.route.credentialVariable ?? "the Neuve sign-in (neuve auth login openai)")} (value never recorded); organisation ${receipt.route.organization ?? "not named by the provider"}`,
    `time       ${fmtMs(receipt.timing.wallMs)} wall; queue wait ${fmtMs(receipt.timing.queueWaitMs)}; ${receipt.timing.attempts} attempt(s); cut-off ${receipt.timeout.cutoffAt}`,
    `cost       ${fmtCost(receipt.totals.costUsd, receipt.route.account?.kind)} over ${receipt.totals.modelCalls} model call(s), ${receipt.totals.retries} retr${receipt.totals.retries === 1 ? "y" : "ies"}; ${fmtTokens(receipt.totals.usage)}`,
    ...(receipt.totals.failedModelCalls || receipt.totals.abortedModelCalls
      ? [
          `attempts   ${receipt.totals.failedModelCalls ?? 0} failed, ${receipt.totals.abortedModelCalls ?? 0} aborted`,
          `failed     ${receipt.totals.failedCostUsd == null ? "USD unknown" : fmtUsd(receipt.totals.failedCostUsd)}; ${fmtTokens(receipt.totals.failedUsage ?? tokenUsage(zeroUsage))}`,
          `aborted    ${receipt.totals.abortedCostUsd == null ? "USD unknown" : fmtUsd(receipt.totals.abortedCostUsd)}; ${fmtTokens(receipt.totals.abortedUsage ?? tokenUsage(zeroUsage))}`,
        ]
      : []),
    "",
    "stages",
  ];
  for (const stage of receipt.stages) {
    const t = stage.turns;
    const turns =
      t === undefined
        ? ""
        : ` · turns ${t.turnsUsed}/${t.turnLimit} (ruled ${t.ruledLimit ?? "-"})${t.limitReached ? " limit reached" : ""}${t.finalGeneration ? " · final generation" : ""} · ended by ${t.endedBy}${t.resumedTurns ? ` · resumed with ${t.resumedTurns} stored turn(s)` : ""}${t.restarted ? " · RESTARTED: working copy lost" : ""}`;
    lines.push(
      `  ${stage.agent.padEnd(22)} ${stage.status.padEnd(11)} ${fmtMs(stage.wallMs).padStart(8)}${stage.expectedMs === undefined ? "" : ` (expected ${fmtMs(stage.expectedMs)})`}${turns}`,
    );
    if (stage.modelCalls > 0)
      lines.push(
        `  ${"".padEnd(22)} ${stage.modelCalls} call(s), ${fmtCost(stage.costUsd, receipt.route.account?.kind)}; ${fmtTokens(stage.usage)}`,
      );
    if (stage.note !== undefined)
      lines.push(`  ${"".padEnd(22)} ${stage.note}`);
  }
  if (receipt.unitCounts !== undefined)
    lines.push(
      "",
      `units      at 10/20/40 lines: ${receipt.unitCounts.at10}/${receipt.unitCounts.at20}/${receipt.unitCounts.at40}`,
    );
  lines.push(
    "",
    `timeout    ${receipt.timeout.reached ? "reached: published what completed, disclosed the rest" : "not reached"}`,
  );
  if (receipt.timeout.reached)
    lines.push(
      `  published ${receipt.timeout.published.join(", ") || "nothing"}`,
      ...receipt.timeout.disclosed.map(
        (d) =>
          `  disclosed ${d.stage}: ${d.status}${d.note === undefined ? "" : ` (${d.note})`}`,
      ),
    );
  if (receipt.gaps.length > 0) {
    lines.push("", "gaps");
    for (const gap of receipt.gaps)
      lines.push(`  ${gap.agent ?? gap.stage}: ${gap.kind}: ${gap.detail}`);
  }
  lines.push("", "disclosed", ...receipt.disclosures.map((d) => `  ${d}`));
  lines.push(
    ...Object.entries(receipt.notMeasured).map(
      ([k, v]) => `  not measured (${k}): ${v}`,
    ),
  );
  if (receipt.stubSettings !== undefined)
    lines.push("", `stub settings ${JSON.stringify(receipt.stubSettings)}`);
  return lines.join("\n");
};
