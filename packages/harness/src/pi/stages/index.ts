import { fill, link } from "../../link.ts";
import { Effect } from "effect";
import { coverageStage, coverageFacts } from "../../coverage.ts";
import type { Context } from "@earendil-works/chord";
import {
  defineExtension,
  type Extension,
  type Harness,
} from "@earendil-works/pi-durable";
import {
  ManifestProgress,
  type PrecomputeProgress,
  RangeManifest,
} from "../../manifest.ts";
import {
  cutoffAt,
  PrecomputeOutput,
  codeStage,
  recordStage,
  precomputeStage,
  publishStage,
  storedOutput,
  type StageRecord,
} from "../../pipeline.ts";
import type { AgentStepCheckpoint } from "./agent-step.ts";
import { frontTask } from "./front-task.ts";
import { finderTask } from "./finder-task.ts";
import { leadsTask } from "./leads-task.ts";
import { readingsStages } from "./readings-plan-task.ts";
import { headGateOf, relationsTask } from "./relations-task.ts";
import { childOf, type ReviewStagesPort } from "../review-task.ts";
import { agentKinds } from "./kinds.ts";
import { settledStages } from "./batch-waiter-task.ts";
import { stageRun } from "./run.ts";
import { readingBinds, readingTask } from "./reading-task.ts";
import { briefingTask } from "./briefing-task.ts";
import { readingsPort } from "../../readings/collect.ts";
import type { StageServices } from "./services.ts";
/** Native tasks for the fixed review shape; model calls remain owned by pi. */

export type { StageServices } from "./services.ts";
export { stageRunner } from "./services.ts";

export type { PublishInput } from "../review-task.ts";

export interface ReviewStages extends Omit<
  ReviewStagesPort,
  "front" | "finder"
> {
  readonly extension: Extension;
  readonly coverage: NonNullable<ReviewStagesPort["coverage"]>;
  readonly leads: NonNullable<ReviewStagesPort["leads"]>;
  readonly front: ReturnType<typeof frontTask>;
  readonly finder: ReturnType<typeof finderTask>;
  readonly restore: (harness: Harness, context: Context) => Promise<void>;
}

export const STAGES_EXTENSION = "neuve.stages";

export const reviewStages = (services: StageServices): ReviewStages => {
  const { ctx } = services;
  const run = stageRun(services);
  // The section readings' probe (NEU-148), only when the run's configuration has its block: a
  // reading step's binding then carries its kind and rank.
  const readingsConfig = ctx.config.readings;
  const bound = readingBinds(services, run, readingsConfig !== undefined);
  const { agentStep, restore } = agentKinds(bound.services, {
    prepare: bound.prepare,
  });
  const finder = finderTask(services, run, agentStep);
  // Front starts the finders when Frame lands, so it is given the finder task.
  const front = frontTask(services, run, agentStep, finder);
  const leads = leadsTask(services);
  // Registered always, like the plan task; the review starts it only with readings on.
  const relations = relationsTask(services);
  // Registered whatever this run's configuration says, so a stored checkpoint that holds readings
  // always resumes; only the run's frozen configuration gives the review the readings port. The
  // plan task is registered either way, so a review that created one always resumes it.
  const reading = readingTask(services, agentStep);
  const briefing = briefingTask(services, agentStep);
  const readings = readingsStages(
    ctx.log,
    readingsConfig === undefined
      ? undefined
      : readingsPort(services, reading, readingsConfig, briefing),
  );
  // The publish phase (NEU-148): readings on means the review publishes per batch.
  const settled = settledStages(services, readings.port.readings);

  return {
    extension: defineExtension({
      name: STAGES_EXTENSION,
      tasks: [
        agentStep,
        front,
        finder,
        leads,
        relations,
        reading,
        briefing,
        readings.task,
        settled.task,
      ],
    }),
    ...readings.port,
    ...settled.port,
    ...(readingsConfig === undefined
      ? {}
      : {
          relations: childOf(relations),
          headGate: headGateOf(relations, ctx),
        }),
    front,
    finder,
    // Already a child starter, so the runtime's port takes it as it stands.
    leads: childOf(leads),
    restore,
    fill: async (input, reader, context, signal) =>
      services.run(
        fill(ctx, { ...input, setup: await run.setup(reader, context) }),
        signal,
      ),
    link: async (input, reader, context, signal) => {
      const setup = await run.setup(reader, context);
      const filled =
        input.fill ??
        (await services.run(
          fill(ctx, {
            mapKey: input.mapKey,
            manifestKey: input.manifestKey,
            setup,
          }),
          signal,
        ));
      const linked = await services.run(
        link(ctx, { ...input, fill: filled, setup }),
        signal,
      );
      return { ...linked, fillRecord: filled.record };
    },
    coverage: async (signal) => {
      try {
        const record = await services.run(coverageStage(ctx), signal);
        if (record.key === undefined) return { record };
        const manifest = await services.run(
          storedOutput(ctx, record.key, RangeManifest),
          signal,
        );
        const output = coverageFacts(record.key, manifest);
        const bound = await services.run(
          codeStage(
            ctx,
            "precompute",
            {
              op: "harness.coverage-facts",
              opVersion: 1,
              inputs: { manifest: `computation:${record.key}` },
            },
            Effect.succeed(output),
            { afterCutoff: true, schema: PrecomputeOutput },
          ),
          signal,
        );
        return {
          record,
          ...(bound.key === undefined
            ? {}
            : { facts: { key: bound.key, output } }),
        };
      } catch (error) {
        if (signal?.aborted) throw error;
        return {
          record: {
            stage: "precompute",
            agent: "precompute.coverage",
            status: "skipped",
            wallMs: 0,
            note: "The range manifest could not be bound; coverage is unknown.",
          },
        };
      }
    },
    precompute: async (signal, deadline = cutoffAt(ctx)) => {
      const started = performance.now();
      const stop = new AbortController();
      const timer = setTimeout(
        () => stop.abort(),
        Math.max(0, Math.ceil(deadline - Date.now())),
      );
      const bounded =
        signal === undefined
          ? stop.signal
          : AbortSignal.any([signal, stop.signal]);
      let progress: PrecomputeProgress = {
        phase: "pending",
        files: 0,
        hunks: 0,
      };
      try {
        const record = await services.run(
          precomputeStage(
            ctx,
            {
              integrations: services.integrations,
              clients: services.clients,
            },
            deadline,
          ).pipe(
            Effect.provideService(ManifestProgress, (value) => {
              progress = value;
            }),
          ),
          bounded,
        );
        if (record.key === undefined) return { record };
        const output = await services.run(
          storedOutput(ctx, record.key, PrecomputeOutput),
          bounded,
        );
        return { record, facts: { key: record.key, output }, progress };
      } catch (error) {
        if (!bounded.aborted) throw error;
        ctx.log.write({ type: "precompute.interrupted", ...progress });
        return {
          record: {
            stage: "precompute",
            status: "skipped",
            wallMs: performance.now() - started,
            note: `Precompute stopped; last reported code phase ${progress.phase}; ${progress.files} files, ${progress.hunks} hunks finished and cached`,
          },
          progress,
        };
      } finally {
        clearTimeout(timer);
      }
    },
    publish: async (input, signal) => {
      const skipped: StageRecord[] =
        input.reason === undefined
          ? []
          : [
              {
                stage: "link",
                agent: "link",
                status: "skipped",
                wallMs: 0,
                note: input.reason,
              },
            ];
      for (const record of skipped)
        await services.run(recordStage(ctx, record), signal);
      const { record, summary } = await services.run(
        publishStage(ctx, {
          findings: input.findings,
          candidates: input.candidates,
          stages: [...input.stages, ...skipped],
          sources: input.sources,
          strongestStratum: input.strongestStratum,
          reason: input.reason,
          disclosures: input.disclosures,
        }),
        signal,
      );
      // Kept findings end at their recorded comments, or a code-written reason (12.41).
      for (const finding of summary.findings)
        services.capture({
          type: "lead.fate",
          scope: { runId: ctx.runId, stage: "publish" },
          leadId: finding.id,
          handoff: "publish",
          ...(finding.fate === "published"
            ? { fate: finding.fate, publicationId: finding.publicationId }
            : { fate: finding.fate, reason: finding.reason }),
        });
      return [...skipped, record];
    },
  };
};

export type { AgentStepCheckpoint };
