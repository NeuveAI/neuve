import { captureOutlineSource } from "./graph-outline.ts";
import { forgetDegradedIndexes } from "./search-index.ts";
import { readData } from "@neuve/records-core";
import { cpuJob } from "./budget/cpu.ts";
import { withCodeWork } from "./code-work.ts";
import { effectiveCutoffAt } from "./run-schedule.ts";
import {
  cutoffReached,
  cutoffNotes,
  stageStartPolicy,
} from "./stage-policy.ts";
import {
  Clock,
  Context,
  Duration,
  Effect,
  Metric,
  Option,
  Schema,
} from "effect";
import type { FileSystem } from "effect/FileSystem";
import type { SqlClient } from "effect/sql/SqlClient";
import { z } from "zod";
import {
  Blobs,
  Computations,
  Log,
  Proofs,
  Vents,
  mintUlid,
  type StoreLocation,
} from "@neuve/records-core";
import { VentText, type Range, type SourcePin } from "@neuve/records-schema";
import { ScopeChangeSubmission, type Freshness } from "./freshness.ts";
import type { AgentResult } from "./pi/stages/agent.ts";

import { type AgentStage, type Stage } from "./budget.ts";

import {
  PIPELINE_VERSION,
  keyedStub,
  precomputeSettings,
  type PipelineConfig,
} from "./config.ts";
import { type ChangedFile } from "./git.ts";
import type { CommitText } from "./git-objects.ts";
import { type Integrations } from "./integrations.ts";

import {
  HandleRegistry,
  type LookupContext,
  type RevisionView,
} from "./lookups.ts";

import {
  RangeManifest,
  frontManifest,
  frontSettings,
  type FrontSettings,
  type ManifestHunk,
  type ManifestSettings,
} from "./manifest.ts";
import { METRICS, step } from "./telemetry.ts";
import { McpClients } from "./mcp-client.ts";

import {
  ScopeSnapshot,
  Stratum,
  readScopeOpening,
  reviewSnapshot,
  scopeGapForReader,
  scopeLogFields,
  snapshotByKey,
} from "./scope.ts";
import { cutOffDisclosure } from "./reader-text.ts";
import {
  publishNote,
  publishPacket,
  recordPublishStage,
  type PublishCandidate,
} from "./publish.ts";
import {
  computationRoute,
  routeAtEffort,
  stepEffortOf,
  type RouteEffort,
} from "./route.ts";
import {
  appendTelemetry,
  harnessActor,
  harnessRegistration,
  stageTelemetry,
  legacyStageTelemetry,
  callAttemptTelemetry,
} from "./receipt.ts";
import type { RunLog } from "./run-log.ts";
import { RECORDS, defineTool, type ToolSpec } from "./toolkit.ts";
import { type StackRun } from "./stack/tools.ts";

/** Shared Records computations and telemetry for the native front, finder and publication tasks. */

/** What every stage of one run shares. */
export class RunContext extends Context.Service<
  RunContext,
  {
    readonly location: StoreLocation;
    readonly repository: string;
    readonly runId: string;
    readonly runKey: string;
    readonly range: Range;
    readonly cycleId: string;
    readonly config: PipelineConfig;
    readonly log: RunLog;
    /** When the run began, from its first attempt that started work (10.26): the cut-off is measured from it. */
    readonly startedAt: number;
    /** One per review cycle (8.16, proposal §3.7). */
    readonly reconciliationId: string;
    /** The worker's Records services. */
    readonly records: Context.Context<
      SqlClient | FileSystem | Blobs.BlobStore | Computations.ComputationStore
    >;
    /**
     * A recompose run (`recompose.ts`): every agent step must find its stored output, except the
     * operations `allow` names, which may call the model; code steps compute as usual. Absent on
     * every review a person requests.
     */
    readonly recompose?: RecomposePolicy | undefined;
  }
>()("@neuve/harness/RunContext") {}

/** What a recompose run lets call the model: the agent operations it names, none for a networkless one. */
export interface RecomposePolicy {
  readonly allow: ReadonlySet<string>;
}

/** An agent step a recompose run would have to call the model for, though its policy allows none. */
export const needsModel = (op: string, agent: string) => ({
  tag: "NeedsModel",
  message: `${agent} (${op}) has no stored output for these inputs and needs the model, which this recompose does not allow`,
  retryable: false,
});

/** One stage's outcome as its task returns it (JSON, stored by pi). */
export interface StageRecord {
  readonly stage: Stage;
  readonly agent?: string | undefined;
  readonly status: "computed" | "reused" | "interrupted" | "skipped" | "stub";
  readonly key?: string | undefined;
  readonly wallMs: number;
  readonly agentResult?: Omit<AgentResult<unknown>, "output"> | undefined;
  readonly captures?: ReadonlyArray<string> | undefined;
  readonly note?: string | undefined;
  /**
   * What a cut-short stage's gap tells the reader: by default the cut-off's sentence
   * (`cutOffDisclosure`); null when another gap already says it, so the stage discloses none.
   */
  readonly disclosure?: string | null | undefined;
}

export interface PipelineResult {
  readonly stages: ReadonlyArray<StageRecord>;
}

/** The run's cut-off, including the publication reserve for older frozen configurations. */
export const cutoffAt = (ctx: RunContext["Service"]) =>
  effectiveCutoffAt(ctx.startedAt, ctx.config.budgets);

export const withRecords = <A, E, R>(
  ctx: RunContext["Service"],
  effect: Effect.Effect<A, E, R>,
) => Effect.provide(effect, ctx.records);

export { harnessActor };

/** Registers the stage's actor once, so its vents and records have an alias. */
const registerActor = (ctx: RunContext["Service"], stage: Stage) =>
  withRecords(
    ctx,
    Effect.gen(function* () {
      const registration = harnessRegistration(
        ctx.runId,
        stage,
        new Date(yield* Clock.currentTimeMillis).toISOString(),
      );
      yield* Log.append([registration]);
      return registration.actor;
    }),
  );

export const recordStageStart = (
  ctx: RunContext["Service"],
  stage: Stage,
  agent: string = stage,
) =>
  withRecords(
    ctx,
    Effect.gen(function* () {
      const actor = yield* registerActor(ctx, stage);
      const occurredAt = new Date(yield* Clock.currentTimeMillis).toISOString();
      ctx.log.write({
        type: "stage.start",
        stage,
        agent,
        startedAt: occurredAt,
      });
      yield* appendTelemetry(ctx.log, [
        {
          id: mintUlid(),
          kind: "stage.started@1",
          idempotencyKey: `review:${ctx.runId}:stage-start:${agent}`,
          actor,
          occurredAt,
          attribution: {
            cycleId: ctx.cycleId,
            range: ctx.range,
            runId: ctx.runId,
            stage,
          },
          payload: { agent },
        },
      ]);
    }),
  );

/**
 * Records a finished stage in Records (10.32): the gaps its agent disclosed in the run log, a gap
 * for a stage the 9:45 cut-off stopped or never started (10.42), then its `stage.completed@1`. Keys
 * are the run, the agent and the gap's position among the agent's gaps, so a replay records nothing
 * twice. The run log keeps its own stage record for telemetry.
 */
export const recordStage = (ctx: RunContext["Service"], record: StageRecord) =>
  withRecords(
    ctx,
    Effect.gen(function* () {
      const agent = record.agent ?? record.stage;
      const actor = yield* registerActor(ctx, record.stage);
      const occurredAt = new Date(yield* Clock.currentTimeMillis).toISOString();
      const run = { cycleId: ctx.cycleId, range: ctx.range, runId: ctx.runId };
      const attribution = { ...run, stage: record.stage };
      const records = ctx.log.read();
      const gap = (key: string, kind: string, detail: string) => ({
        id: mintUlid(),
        kind: "gap.disclosed@1",
        idempotencyKey: `review:${ctx.runId}:gap:${agent}:${key}`,
        actor,
        occurredAt,
        attribution,
        payload: { kind, detail: detail.slice(0, 2_000) },
      });
      // A gap marked unpublished stays in the run log and the receipt: plumbing a reader cannot act on.
      const disclosed = records
        .filter(
          (entry) =>
            entry.type === "gap" &&
            entry["published"] !== false &&
            (entry["agent"] ?? entry["stage"]) === agent,
        )
        .map((entry, index) =>
          gap(
            String(index),
            String(entry["kind"]),
            String(entry["detail"] ?? "no detail recorded"),
          ),
        );
      const cutShort =
        (record.status === "interrupted" || record.status === "skipped") &&
        record.disclosure !== null
          ? [
              gap(
                "cut-off",
                `stage-${record.status}`,
                record.disclosure ??
                  cutOffDisclosure(record.stage, record.agent, record.status),
              ),
            ]
          : [];
      const telemetry = stageTelemetry(record, records, ctx.config);
      yield* appendTelemetry(ctx.log, [
        ...disclosed,
        ...cutShort,
        ...(telemetry.failedModelCalls || telemetry.abortedModelCalls
          ? [
              {
                id: mintUlid(),
                kind: "model.calls-counted@2",
                idempotencyKey: `review:${ctx.runId}:calls:v2:${agent}`,
                actor,
                occurredAt,
                attribution,
                payload: {
                  agent,
                  ...callAttemptTelemetry(telemetry),
                },
              },
            ]
          : []),
        {
          id: mintUlid(),
          kind: "stage.completed@1",
          idempotencyKey: `review:${ctx.runId}:stage:${agent}`,
          actor,
          occurredAt,
          attribution,
          ...(record.key === undefined
            ? {}
            : { refs: [{ ref: `computation:${record.key}`, role: "output" }] }),
          payload: legacyStageTelemetry(telemetry),
        },
      ]);
    }),
  );

const VENT_DESCRIPTION = `Optional. If something is making this task difficult, say what, in your own words, drawing on the turns you remember. One vent per stage of this run; a second keeps the first. It never changes your task or the review.

Good vents:
- "The diff for this file is paged in three parts and I cannot see which hunk the question refers to."
- "The task asks for one note per file, but two files are binary and I cannot read them."

Bad vents:
- "Error." (says nothing about what happened)
- "Done with the first file." (a progress report, not a difficulty)`;

/** The `vent` tool for one stage's agents (2.15, 8.8, 8.16): one vent per actor and cycle ID. */
export const ventTool = (
  ctx: RunContext["Service"],
  stage: Stage,
): ToolSpec<unknown> =>
  defineTool({
    name: "vent",
    description: VENT_DESCRIPTION,
    input: z.strictObject({
      text: VentText.describe(
        "What made this task difficult, in your own words.",
      ),
    }),
    hints: RECORDS,
    handle: (input: { text: string }) =>
      withRecords(
        ctx,
        Effect.gen(function* () {
          const actorId = yield* registerActor(ctx, stage);
          const result = yield* Vents.record({
            actorId,
            sessionId: ctx.runId,
            text: input.text,
            reconciliationId: ctx.reconciliationId,
            runId: ctx.runId,
            stage,
          });
          ctx.log.write({ type: "vent", stage, status: result.status });
          return {
            text:
              result.status === "recorded"
                ? "Vent recorded. It does not change your task."
                : "This stage already vented in this run; the earlier vent is kept.",
          };
        }),
      ).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            text: "The vent was not recorded; nothing else is needed.",
            error: String((error as { _tag?: string })._tag ?? error),
          }),
        ),
      ),
  });

/**
 * Precompute's output (proposal §5, slice H5): references to the range manifest and the cycle's
 * scope snapshot, which are computations of their own, and the changed files the stub stages use.
 */
export const PrecomputeOutput = z.strictObject({
  files: z.array(
    z.strictObject({
      path: z.string(),
      added: z.int().nullable(),
      deleted: z.int().nullable(),
    }),
  ),
  diffBytes: z.int().min(0),
  manifest: z.string(),
  /** Null when the snapshot could not be fetched at all; the gap says why. */
  scope: z.string().nullable(),
  hunks: z.int().min(0),
  reviewLines: z.int().min(0),
  strongestStratum: Stratum,
  scopeGaps: z.array(z.string()),
  /** The scope gaps' technical causes, written to the run log beside them; absent in older outputs. */
  scopeCauses: z
    .array(z.strictObject({ gap: z.string(), cause: z.string() }))
    .optional(),
});
export type PrecomputeOutput = z.infer<typeof PrecomputeOutput>;

/** The changed files of a manifest, as the stub stages list them (null counts for binary files). */
const filesOf = (manifest: RangeManifest): ReadonlyArray<ChangedFile> => {
  const files = new Map<
    string,
    { added: number | null; deleted: number | null }
  >();
  for (const hunk of manifest.hunks) {
    const held = files.get(hunk.path) ?? { added: 0, deleted: 0 };
    files.set(
      hunk.path,
      hunk.kind === "binary"
        ? { added: null, deleted: null }
        : {
            added: held.added === null ? null : held.added + hunk.added,
            deleted: held.deleted === null ? null : held.deleted + hunk.deleted,
          },
    );
  }
  return [...files].map(([path, counts]) => ({ path, ...counts }));
};

/**
 * The Precompute stage (proposal §5, 10.20): the range manifest, computed once per range from what
 * commit preparation stored, and the cycle's scope snapshot, fetched once per cycle and shared with
 * the `scope.fetch` job's attempt when one is in flight. The stage's own computation is keyed by the
 * range and the cycle, because the snapshot it references belongs to the cycle. Scope gaps are
 * disclosed as the stage's gaps (10.76).
 */
/**
 * Precompute's computation: the range, the cycle and the manifest's settings. Version 3 holds no
 * leads retriever: the leads are their own computation, off the review's path (NEU-148).
 * Version 4 references the two scope computations for a read-opened cycle.
 */
const precomputeSpec = (
  range: { readonly baseOid: string; readonly headOid: string },
  cycleId: string,
  settings: ManifestSettings | FrontSettings,
  splitScope = false,
): Computations.ComputationSpec => ({
  op: "harness.precompute",
  opVersion: splitScope ? 4 : 3,
  inputs: {
    base: `git-commit:${range.baseOid}`,
    head: `git-commit:${range.headOid}`,
    cycle: `cycle:${cycleId}`,
  },
  config: frontSettings(settings) as never,
});

interface ScopeEnvironment {
  readonly integrations: Integrations;
  readonly clients: McpClients["Service"];
}

const precomputeWithScope = (
  ctx: RunContext["Service"],
  env: ScopeEnvironment,
  opening: Effect.Success<ReturnType<typeof readScopeOpening>>,
) => {
  const settings = precomputeSettings(ctx.config);
  const spec = precomputeSpec(
    ctx.range,
    ctx.cycleId,
    settings,
    opening !== undefined,
  );
  return guard(
    ctx,
    "precompute",
    undefined,
    spec,
    Effect.gen(function* () {
      forgetDegradedIndexes();
      const store = yield* Computations.ComputationStore;
      // Where the stage's time goes: its sub-steps are spans under its own (10.97).
      const result = yield* store
        .run(
          spec,
          Effect.gen(function* () {
            // The scope fetch reads no hunk, so it runs beside the manifest, not after it.
            const [manifest, fetched] = yield* Effect.all(
              [
                frontManifest(
                  ctx.repository,
                  ctx.range,
                  settings,
                  captureOutlineSource(),
                ),
                // A snapshot that cannot be fetched at all is a disclosed gap, never a stop (1.8, 10.54).
                step(
                  "harness.precompute.scope",
                  Effect.result(
                    reviewSnapshot(
                      {
                        repository: ctx.repository,
                        location: ctx.location,
                        cycleId: ctx.cycleId,
                        range: ctx.range,
                        integrations: env.integrations,
                      },
                      opening,
                    ).pipe(Effect.provideService(McpClients, env.clients)),
                  ),
                  (value) => ({
                    "harness.scope.status":
                      value._tag === "Success"
                        ? value.success.status
                        : "failed",
                  }),
                ),
              ],
              { concurrency: 2 },
            );
            const scope =
              fetched._tag === "Success" ? fetched.success : undefined;
            const scopeFailure =
              fetched._tag === "Failure"
                ? `scope snapshot not fetched: ${String((fetched.failure as { _tag?: unknown })._tag ?? "error")}: ${String((fetched.failure as { message?: unknown }).message ?? fetched.failure).slice(0, 300)}`
                : undefined;
            ctx.log.write({
              type: "precompute.manifest",
              key: manifest.key,
              status: manifest.status,
              hunks: manifest.value.hunks.length,
              files: manifest.value.files,
              reviewLines: manifest.value.reviewLines,
              limitations: manifest.value.limitations,
            });
            ctx.log.write(
              scope === undefined
                ? {
                    type: "precompute.scope",
                    status: "failed",
                    detail: scopeFailure,
                  }
                : {
                    type: "precompute.scope",
                    key: scope.key,
                    status: scope.status,
                    ...scopeLogFields(scope.value),
                  },
            );
            const files = filesOf(manifest.value);
            const output: PrecomputeOutput = {
              files: [...files],
              diffBytes: manifest.value.hunks.reduce(
                (sum, hunk) => sum + Buffer.byteLength(hunk.text),
                0,
              ),
              manifest: manifest.key,
              scope: scope?.key ?? null,
              hunks: manifest.value.hunks.length,
              reviewLines: manifest.value.reviewLines,
              strongestStratum: scope?.value.strata.strongest ?? "nothing",
              scopeGaps:
                scope === undefined
                  ? [scopeFailure ?? "scope snapshot not fetched"]
                  : [...scope.value.gaps],
              ...(scope?.value.causes === undefined
                ? {}
                : { scopeCauses: [...scope.value.causes] }),
            };
            return {
              bytes: new TextEncoder().encode(JSON.stringify(output)),
              mediaType: "application/json",
            };
          }),
        )
        .pipe((effect) =>
          step("harness.precompute.computation", effect, (value) => ({
            "harness.computation.status": value.status,
          })),
        );
      const output = readData(
        PrecomputeOutput,
        JSON.parse(new TextDecoder().decode(result.output)),
      );
      const records = ctx.log.read();
      if (
        output.scope !== null &&
        result.status !== "computed" &&
        !records.some(
          (entry) =>
            entry.type === "precompute.scope" && entry["key"] === output.scope,
        )
      ) {
        const scope = yield* snapshotByKey(output.scope);
        if (scope !== undefined)
          ctx.log.write({
            type: "precompute.scope",
            status: result.status,
            key: output.scope,
            ...scopeLogFields(scope),
          });
      }
      const written = records.some(
        (entry) => entry.type === "gap" && entry["stage"] === "precompute",
      );
      if (!written)
        for (const gap of output.scopeGaps) {
          const detail = scopeGapForReader(gap);
          const cause =
            output.scopeCauses?.find((entry) => entry.gap === gap)?.cause ??
            (detail === gap ? undefined : gap);
          ctx.log.write({
            type: "gap",
            stage: "precompute",
            kind: "scope",
            detail,
            ...(cause === undefined ? {} : { cause }),
          });
        }
      const record: StageRecord = {
        stage: "precompute",
        status: result.status === "computed" ? "computed" : "reused",
        key: result.computation.key,
        wallMs: 0,
        note: `${output.hunks} hunk(s), ${output.reviewLines} review lines; scope ${output.strongestStratum}, ${output.scopeGaps.length} gap(s)`,
      };
      return record;
    }).pipe((effect) => withRecords(ctx, effect)),
  );
};

export const precomputeStage = (
  ctx: RunContext["Service"],
  env: ScopeEnvironment,
  deadline = cutoffAt(ctx),
) =>
  withRecords(ctx, readScopeOpening(ctx.cycleId)).pipe(
    Effect.flatMap((opening) => precomputeWithScope(ctx, env, opening)),
    (effect) =>
      cpuJob(
        { class: "interactive", position: "understand", stage: 0 },
        withCodeWork(ctx.location, false, effect, deadline),
      ),
  );

/** Runs `effect` unless the cut-off has passed; holds the stage first when a stub setting asks. */
/** Attributes for the stage spans opened under it, such as a finder's lens. */
const StageSpanAttributes = Context.Reference<Record<string, string>>(
  "neuve/harness/StageSpanAttributes",
  { defaultValue: () => ({}) },
);

export const guard = <E, R>(
  ctx: RunContext["Service"],
  stage: Stage,
  agent: string | undefined,
  key: Computations.ComputationSpec,
  effect: Effect.Effect<StageRecord, E, R>,
  /** False for a stage's code step beside its agents, which a stub hold never delays. */
  holdable = true,
  /**
   * True for code that only composes stored outputs (fill and Link): it costs no
   * model call, so it runs after the cut-off too and Publish has what completed (10.42).
   */
  afterCutoff = false,
) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    // A stage whose output is already stored costs nothing: it is published even after the cut-off.
    const stored = yield* withRecords(
      ctx,
      Effect.gen(function* () {
        const store = yield* Computations.ComputationStore;
        return yield* store.lookup(Computations.computationKey(key).key);
      }),
    );
    const policy = stageStartPolicy({
      now: started,
      cutoffAt: cutoffAt(ctx),
      stored: Option.isSome(stored),
      afterCutoff,
      holdable,
      stage,
      hold: ctx.config.stub?.hold,
    });
    if (policy.kind === "skip") {
      const skipped: StageRecord = {
        stage,
        agent,
        status: "skipped",
        wallMs: 0,
        note: cutoffNotes.skipped,
      };
      ctx.log.write({ type: "stage", ...skipped });
      yield* recordStage(ctx, skipped);
      return skipped;
    }
    yield* recordStageStart(ctx, stage, agent);
    if (policy.holdMs !== undefined) {
      const wait = policy.holdMs;
      ctx.log.write({
        type: "progress",
        message: `${agent ?? stage}: holding ${Math.round(wait / 1000)} s (stub setting)`,
      });
      yield* Effect.logInfo(
        `${agent ?? stage}: stub hold of ${Math.round(wait / 1_000)} s`,
      );
      yield* Effect.sleep(Duration.millis(wait));
      if (cutoffReached(yield* Clock.currentTimeMillis, cutoffAt(ctx))) {
        const interrupted: StageRecord = {
          stage,
          agent,
          status: "interrupted",
          wallMs: (yield* Clock.currentTimeMillis) - started,
          note: cutoffNotes.held,
        };
        ctx.log.write({ type: "stage", ...interrupted });
        yield* recordStage(ctx, interrupted);
        return interrupted;
      }
    }
    ctx.log.write({ type: "progress", message: `${agent ?? stage}: started` });
    const extra = yield* StageSpanAttributes;
    const finder =
      stage === "find" || stage === "verify" ? agent?.split(".")[1] : undefined;
    const record = yield* effect.pipe(
      Effect.withSpan(`harness.stage.${stage}`, {
        attributes: {
          ...extra,
          ...(finder === undefined ? {} : { "harness.batch": finder }),
          "harness.stage": stage,
          "harness.agent": agent ?? stage,
        },
      }),
    );
    const done = {
      ...record,
      wallMs: (yield* Clock.currentTimeMillis) - started,
    };
    yield* Metric.update(
      Metric.withAttributes(METRICS.stageDuration, {
        "harness.stage": stage,
        "harness.status": done.status,
      }),
      done.wallMs / 1_000,
    );
    ctx.log.write({ type: "stage", ...done });
    yield* recordStage(ctx, done);
    return done;
  });

/** A code stage over the computation store; `agent` names it when a stage has several. */
export const codeStage = <O>(
  ctx: RunContext["Service"],
  stage: Stage,
  spec: Computations.ComputationSpec,
  compute: Effect.Effect<
    O,
    unknown,
    SqlClient | Blobs.BlobStore | Computations.ComputationStore
  >,
  options: {
    readonly agent?: string | undefined;
    readonly note?: ((output: O) => string) | undefined;
    readonly schema?: z.ZodType<O> | undefined;
    readonly fixedNote?: string | undefined;
    readonly afterCutoff?: boolean | undefined;
  } = {},
) =>
  guard(
    ctx,
    stage,
    options.agent,
    spec,
    Effect.gen(function* () {
      const store = yield* Computations.ComputationStore;
      const result = yield* store.run(
        spec,
        Effect.map(compute, (output) => ({
          bytes: new TextEncoder().encode(JSON.stringify(output)),
          mediaType: "application/json",
        })),
      );
      const note =
        options.note === undefined || options.schema === undefined
          ? options.fixedNote
          : options.note(
              readData(
                options.schema,
                JSON.parse(new TextDecoder().decode(result.output)),
              ),
            );
      const record: StageRecord = {
        stage,
        agent: options.agent,
        status: result.status === "computed" ? "computed" : "reused",
        key: result.computation.key,
        wallMs: 0,
        ...(note === undefined ? {} : { note }),
      };
      return record;
    }).pipe((effect) => withRecords(ctx, effect)),
    options.agent === undefined,
    options.afterCutoff === true,
  );

/** A stored computation's bytes; envelope and output schemas remain the caller's boundary. */
export const storedBytes = (ctx: RunContext["Service"], key: string) =>
  withRecords(
    ctx,
    Effect.gen(function* () {
      const store = yield* Computations.ComputationStore;
      const blobs = yield* Blobs.BlobStore;
      const computation = Option.getOrThrow(yield* store.lookup(key));
      const read = yield* blobs.get(computation.outputHash);
      if (read._tag === "Pruned")
        throw new Error(`stage output ${key} was pruned`);
      return read.bytes;
    }),
  );

/** Reads a stored stage output back, unwrapping the incumbent agent envelope once. */
export const storedOutput = <O>(
  ctx: RunContext["Service"],
  key: string,
  schema: z.ZodType<O>,
) =>
  Effect.map(storedBytes(ctx, key), (bytes) => {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as {
      output?: unknown;
    };
    return readData(schema, "output" in value ? value.output : value);
  });

/** An agent context's estimated and measured context, as the receipt compares them (UN9, 10.35). */
export interface ContextFigures {
  /** The stage's own estimate of what the first call sends, from the plan (diff load and inputs). */
  readonly planned?: Readonly<Record<string, number>> | undefined;
  /** UN9's bytes ÷ 3 × 1.3 over the first call's system, task and tools. */
  readonly estimated?: number | undefined;
  /** The provider's free count of the same request, or null when counting failed. */
  readonly counted?: number | null | undefined;
  /** What the provider billed on the first call and the largest one. */
  readonly firstCall?: number | undefined;
  readonly peak?: number | undefined;
}

/** What an agent stage stores under its key: the composed output, the loop's summary and context. */
export const AgentStored = z.object({
  output: z.unknown(),
  summary: z.unknown(),
  context: z.unknown().optional(),
});

/**
 * An agent stage's computation spec: what its stored result is keyed on. Its route is the one the
 * step runs on, at the step's effort (`stepEffortOf`), so only a step at another effort keys apart.
 */
export const agentStageSpec = (
  config: RunContext["Service"]["config"],
  spec: {
    readonly stage: AgentStage;
    readonly effort?: RouteEffort | undefined;
    readonly turnLimit: number;
    readonly agent: string;
    readonly retries?: number | undefined;
  },
  options: {
    readonly op: string;
    readonly opVersion: number;
    readonly inputs: Record<string, unknown>;
  },
): Computations.ComputationSpec => ({
  op: options.op,
  opVersion: options.opVersion,
  inputs: options.inputs as never,
  config: {
    turnLimit: spec.turnLimit,
    ...(spec.retries === undefined ? {} : { retries: spec.retries }),
    agent: spec.agent,
    stub: keyedStub(config.stub),
  },
  route: computationRoute(
    routeAtEffort(
      config.route,
      stepEffortOf(config.route, spec.stage, spec.effort),
    ),
  ),
});

/** The immutable range and scope shared by the run's lookup tools. */
export interface RangeView {
  readonly manifest: RangeManifest;
  readonly snapshot: ScopeSnapshot | undefined;
  readonly head: RevisionView;
  readonly base: RevisionView;
  readonly hunks: ReadonlyMap<string, ManifestHunk>;
  readonly commits: ReadonlyArray<CommitText>;
  readonly findLog?: import("./git.ts").FindLog | undefined;
  readonly byPath: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly searchFrequency: Map<string, Set<string>>;
  /** The stack tools' store and the cycle's frozen stack state: only while they are on (11.15). */
  readonly stack?: StackRun | undefined;
  /**
   * The key of the snapshot this run refreshed because an external source changed (11.18): an
   * input of Frame only then, so it and what follows rerun while other runs keep their keys.
   */
  readonly scopeRefresh?: string | undefined;
  /** The run's pins of the snapshot's external sources, with what its check found (11.17, 11.18). */
  readonly pins?: ReadonlyArray<SourcePin> | undefined;
  /**
   * The run's proof currency check against its head (11.10, 11.18), shared by every batch so each
   * record's commit is diffed once per run.
   */
  readonly currency?: ReturnType<typeof Proofs.currencyChecker> | undefined;
}

/** One agent context's lookups, with its own handle registry. */
export const lookupContext = (
  ctx: RunContext["Service"],
  view: RangeView,
  placement?: LookupContext["placement"],
): LookupContext => ({
  source: captureOutlineSource(),
  repository: ctx.repository,
  location: ctx.location,
  cycleId: ctx.cycleId,
  manifest: view.manifest,
  head: view.head,
  base: view.base,
  hunks: view.hunks,
  commits: view.commits,
  findLog: view.findLog,
  snapshot: view.snapshot,
  records: ctx.records,
  handles: new HandleRegistry(),
  ...(placement === undefined ? {} : { placement }),
  searchFrequency: view.searchFrequency,
  search: ctx.config.search,
  ...(view.stack === undefined ? {} : { stack: view.stack }),
});

export const sectionIds = (snapshot: ScopeSnapshot | undefined) =>
  new Set(
    (snapshot?.sources ?? []).flatMap((source) =>
      source.sections.map((section) => section.id),
    ),
  );

const fmt = (value: number | null | undefined) =>
  value === null || value === undefined ? "-" : value.toLocaleString("en");

/** The receipt's note on an agent's context: estimated against measured (UN9, 10.35). */
export const contextNote = (context: ContextFigures | undefined) =>
  context === undefined
    ? ""
    : `first context estimated ${fmt(context.estimated)} tokens (UN9), counted ${fmt(context.counted)}, billed ${fmt(context.firstCall)}; peak ${fmt(context.peak)}`;

/** What the judgement of a ticket's change stores: the agent's answer, or none when it gave none. */
export const ScopeChangeStored = z.strictObject({
  judgement: ScopeChangeSubmission.nullable(),
});
export type ScopeChangeStored = z.infer<typeof ScopeChangeStored>;

/** Publish (H8): always runs, after the cut-off too, on everything that completed (10.42, PU2). */
export const publishStage = (
  ctx: RunContext["Service"],
  inputs: {
    readonly findings?: ReadonlyArray<string> | undefined;
    readonly candidates: ReadonlyArray<PublishCandidate>;
    readonly stages: ReadonlyArray<StageRecord>;
    readonly sources: {
      readonly manifest: string | null;
      readonly changeMap: string | null;
      readonly scope: string | null;
    };
    readonly strongestStratum: string;
    readonly reason?: string | undefined;
    readonly disclosures: Freshness["disclosures"];
  },
) =>
  withRecords(
    ctx,
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      yield* recordStageStart(ctx, "publish");
      ctx.log.write({ type: "progress", message: "publish: started" });
      const summary = yield* publishPacket(ctx, {
        findings: inputs.findings,
        candidates: inputs.candidates,
        stages: [...inputs.stages],
        sources: inputs.sources,
        strongestStratum: inputs.strongestStratum,
        reason: inputs.reason,
        disclosures: inputs.disclosures,
      });
      const done: StageRecord = {
        stage: "publish",
        status: "computed",
        wallMs: (yield* Clock.currentTimeMillis) - started,
        note: publishNote(summary),
      };
      ctx.log.write({ type: "stage", ...done });
      yield* recordPublishStage(ctx, done, summary.manifest);
      return { record: done, summary };
    }).pipe(Effect.withSpan("harness.stage.publish")),
  );

/**
 * A failure as the engine stores it: plain JSON with the error's tag and message, so a stage's real
 * cause (a provider refusal, a git error) reaches the job's last error instead of an encoding defect.
 */
export const StageFailure = Schema.Struct({
  tag: Schema.String,
  message: Schema.String,
  retryable: Schema.Boolean,
});

export { PIPELINE_VERSION };
export type { AgentStage };
