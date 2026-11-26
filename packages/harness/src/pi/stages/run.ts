import { captureOutlineSource } from "../../graph-outline.ts";
import { readData } from "@neuve/records-core";
import { copyJson, type Context } from "@earendil-works/chord";
import type { DocumentReader, TaskId } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { z } from "zod";
import { Proofs } from "@neuve/records-core";
import { SourcePin } from "@neuve/records-schema";
import {
  FRAME_DEADLINE_MS,
  MAP_DEADLINE_MS,
  type AgentStage,
} from "../../budget.ts";
import { git, rangeCommitFiles } from "../../git.ts";
import { rangeCommits, revisionViews } from "../../lookups.ts";
import { RangeManifest } from "../../manifest.ts";
import {
  PrecomputeOutput,
  storedOutput,
  withRecords,
  ventTool,
  type RangeView,
} from "../../pipeline.ts";
import { snapshotByKey } from "../../scope.ts";
import { readSettings } from "../../settings.ts";
import { freezeStackRun, runStackSettings } from "../../stack/frozen-state.ts";
import type { ChildRequest, ToolSpec } from "../../toolkit.ts";
import {
  Claim,
  claimKeyOf,
  claimOf,
  verifyAgentOf,
  verifyChildName,
} from "../../verify.ts";
import { ChangeMap } from "../../review-map.ts";
import { candidateObligations, commitsByPath } from "../../scope-text.ts";
import { lookupContext } from "../../pipeline.ts";
import { AGENT_STEP, type AgentStepInput } from "./agent-step.ts";
import { RunSetupDoc, type AgentKind } from "./docs.ts";
import type { StageServices } from "./services.ts";
import { scopeChangeStep } from "./scope-change-step.ts";
import { frameStep, mapStep } from "./front-steps.ts";
import { findStep, verifyStep } from "./find-steps.ts";
import { Frame } from "../../frame.ts";
import { MapManifest } from "../../review-map.ts";
import { Lens } from "../../find.ts";
import { erased } from "./agent.ts";
import { stageOfKind, type ResolvedAgent } from "./tools.ts";
import { readingStep } from "./reading-task.ts";
import { RecordedReviewClaim } from "../../readings/reviewer-claims.ts";
import { briefingAgent } from "./briefing-task.ts";

/**
 * What the review's tasks know of their run in one process, rebuilt from durable state (0014): the
 * run's setup in `RunSetupDoc`, each step's parameters in its task input and the stored outputs
 * they name. Every preparation is deterministic from those, so a reopened run, or a task another
 * phase reached first, prepares the same agent; the process only caches what it built.
 */

/** The run's setup as Front settled it: what every later stage reads the range through. */
export const RunSetup = z.strictObject({
  precompute: z.string(),
  /** The snapshot every later stage reads: the cycle's, or this run's refresh (11.18). */
  scopeKey: z.string().nullable(),
  refreshKey: z.string().nullable(),
  pins: z.array(SourcePin),
  disclosures: z.array(
    z.strictObject({
      kind: z.string(),
      detail: z.string(),
      cause: z.string().optional(),
    }),
  ),
});
export type RunSetup = z.infer<typeof RunSetup>;

/**
 * The effort a reading step sets on its spec, decided when the readings were listed
 * (`readings/effort.ts`); absent from a claim check that runs at its stage's, and from a step a
 * build before it created.
 */
const ReadingStepEffort = z.enum(["low", "medium", "high"]).optional();

/**
 * The stored relation evidence its group was shown (`readings/evidence.ts`), decided once by the
 * reading task and carried by every step of the group: the read, the re-read and the claims'
 * checks prepare from it. Absent from a step a build before it created: that step shows none.
 */
const ReadingEvidence = z.string().optional();

/** Each agent kind's parameters, as its step task's input carries them. */
export const KindParams = {
  frame: z.strictObject({}),
  map: z.strictObject({ frame: z.string(), manifest: z.string() }),
  find: z.strictObject({
    lens: Lens,
    frame: z.string(),
    manifest: z.string(),
    /** The finder task that owns the step, which owns the Verify of each finding it records. */
    finder: z.int().min(0),
  }),
  /** The claim a Verify reads, carried whole: it exists before the Find that recorded it ends. */
  verify: z.strictObject({
    frame: z.string(),
    finding: Claim,
  }),
  "scope-change": z.strictObject({
    change: z.strictObject({
      source: z.string(),
      title: z.string(),
      fromSha: z.string(),
      toSha: z.string(),
      region: z.strictObject({
        line: z.int(),
        before: z.string(),
        after: z.string(),
      }),
    }),
  }),
  // The section readings (NEU-148): a group of the stored plan, its rank for the scheduler, and for
  // a re-read the sections to read; a claim's check names the stored Lane review answer it is in.
  // Each carries the effort it runs at (`effort`) and the relation evidence it is shown (`evidence`).
  assess: z.strictObject({
    plan: z.string(),
    group: z.string(),
    rank: z.int().min(0),
    manifest: z.string(),
    part: z.enum(["read", "reread"]),
    only: z.array(z.string()).optional(),
    effort: ReadingStepEffort,
    evidence: ReadingEvidence,
  }),
  "lane-review": z.strictObject({
    owner: z.int().min(0).optional(),
    review: z.int().min(0).optional(),
    cutoffAt: z.number().optional(),
    claimEffort: ReadingStepEffort,
    plan: z.string(),
    group: z.string(),
    rank: z.int().min(0),
    frame: z.string(),
    map: z.string(),
    manifest: z.string(),
    part: z.enum(["read", "reread"]),
    only: z.array(z.string()).optional(),
    effort: ReadingStepEffort,
    evidence: ReadingEvidence,
  }),
  "verify-claim": z.strictObject({
    plan: z.string(),
    group: z.string(),
    manifest: z.string(),
    answer: z.string().optional(),
    inline: RecordedReviewClaim.optional(),
    claim: z.string(),
    effort: ReadingStepEffort,
    evidence: ReadingEvidence,
  }),
  // The briefing (NEU-148 round 27, `briefing-task.ts`): a part of a reading group's sections in one
  // batch, or the batch's digest, over the stored Assess outputs named (`assess`) and, for a digest,
  // the groups' stored relation evidence. The rank is its group's, for the scheduler.
  brief: z.strictObject({
    plan: z.string(),
    group: z.string(),
    rank: z.int().min(0),
    manifest: z.string(),
    frame: z.string(),
    map: z.string(),
    call: z.enum(["part", "digest"]),
    /** The Map group (batch) it writes for. */
    batch: z.string(),
    /** A part's sections, in part order; empty for a digest. */
    sections: z.array(z.string()),
    /** A part that also writes its batch's digest. */
    digest: z.boolean().optional(),
    assess: z.array(z.string()),
    evidence: z.array(z.string()).optional(),
    effort: ReadingStepEffort,
  }),
} satisfies { readonly [K in AgentKind]: z.ZodType };
export type KindParams<K extends AgentKind> = z.infer<(typeof KindParams)[K]>;

/** A step task's input for one kind, from its typed parameters. */
export const stepInput = <K extends AgentKind>(
  kind: K,
  params: KindParams<K>,
  cutoffAt: number,
  deadline?: number,
): AgentStepInput => {
  const json = copyJson(KindParams[kind].parse(params));
  const limit =
    deadline ??
    (kind === "frame"
      ? Date.now() + FRAME_DEADLINE_MS
      : kind === "map"
        ? Date.now() + MAP_DEADLINE_MS
        : undefined);
  return {
    kind,
    params: json,
    cutoffAt,
    ...(limit === undefined ? {} : { deadline: limit }),
  };
};

/**
 * The Verify of one claim, as a child of its finder: asked for by the `record_finding` call that
 * accepts the claim (find-steps.ts) or by the finder's verify phase (finder-task.ts). Both name it
 * by the claim's key and give it the same input, so whichever comes first starts the one run.
 * `findKey`, for one the verify phase starts, is the final list it read the claim from; a record
 * call's claim comes from the call itself, which its `task.inputs` record names.
 */
export const verifyChild = (
  finder: number,
  frameKey: string,
  cutoffAt: number,
  finding: Claim,
  findKey?: string,
) => {
  const claimKey = claimKeyOf(frameKey, finding);
  return {
    owner: finder,
    name: verifyChildName(claimKey),
    task: AGENT_STEP,
    input: stepInput(
      "verify",
      { frame: frameKey, finding: claimOf(finding) },
      cutoffAt,
    ),
    attributes: {
      "harness.lens": finding.lens,
      "harness.claim": claimKey,
      "harness.agent": verifyAgentOf(finding.lens, claimKey),
    },
    kind: "verify",
    inputs: {
      frame: `computation:${frameKey}`,
      ...(findKey === undefined ? {} : { find: `computation:${findKey}` }),
    },
  } satisfies ChildRequest;
};

export interface StageRun {
  /** Precompute's stored output. */
  readonly facts: (
    key: string,
    signal: AbortSignal | undefined,
  ) => Promise<PrecomputeOutput>;
  /** The run's setup, which Front commits before any agent of the run starts. */
  readonly setup: (read: DocumentReader, context: Context) => Promise<RunSetup>;
  /**
   * The range as an agent reads it: with `setup`, its settled snapshot and pins; without, the
   * cycle's snapshot as Precompute stored it (Front's setup, before the freshness check).
   */
  readonly view: (
    from: {
      readonly precompute: string;
      readonly setup?: RunSetup | undefined;
    },
    signal: AbortSignal | undefined,
  ) => Promise<RangeView>;
  /** Candidate done-when conditions extracted from the scope snapshot. */
  readonly candidates: (
    view: RangeView,
    signal: AbortSignal | undefined,
  ) => Promise<ChangeMap["candidates"]>;
  /** An agent as a step task with `input` would prepare it, built afresh (Front's preflight). */
  readonly preview: (
    input: AgentStepInput,
    read: DocumentReader,
    context: Context,
  ) => Promise<ResolvedAgent>;
  /** The agent of one step task, prepared from its durable input. */
  readonly prepare: (
    taskId: TaskId,
    input: AgentStepInput,
    read: DocumentReader,
    context: Context,
  ) => Promise<ResolvedAgent>;
}

/** Caches one promise per key, dropping it when it fails so a later call tries again. */
const cached = <K, V>() => {
  const held = new Map<K, Promise<V>>();
  return (key: K, make: () => Promise<V>): Promise<V> => {
    const found = held.get(key);
    if (found !== undefined) return found;
    const made = make();
    held.set(key, made);
    made.catch(() => held.delete(key));
    return made;
  };
};

export const stageRun = (
  services: Pick<StageServices, "ctx" | "run">,
): StageRun => {
  const { ctx } = services;
  const run = services.run;
  const facts = cached<string, PrecomputeOutput>();
  const views = cached<string, RangeView>();
  const candidates = cached<RangeView, ChangeMap["candidates"]>();
  const prepared = cached<number, ResolvedAgent>();
  const vents = new Map<AgentStage, ToolSpec<unknown>>();

  const read = <O>(
    key: string,
    schema: z.ZodType<O>,
    signal: AbortSignal | undefined,
  ) => run(storedOutput(ctx, key, schema), signal);

  const factsOf = (key: string, signal: AbortSignal | undefined) =>
    facts(key, () => read(key, PrecomputeOutput, signal));

  const setupOf = async (reader: DocumentReader, context: Context) => {
    const doc = await reader.snapshot(RunSetupDoc, context);
    if (doc === undefined || doc.setup === null)
      throw new Error("the run's setup is not committed yet");
    return readData(RunSetup, copyJson(doc.setup));
  };

  /** The stack tools' frozen state, while they are on (11.15); the gap is written once per run. */
  const stackOf = async (signal: AbortSignal | undefined) => {
    const config = ctx.config.stack;
    if (config === undefined) return undefined;
    const stack = await run(
      freezeStackRun({
        source: captureOutlineSource(),
        repository: ctx.repository,
        storeDirectory: ctx.location.directory,
        cycleId: ctx.cycleId,
        range: ctx.range,
        config,
        settings: runStackSettings(readSettings()),
      }),
      signal,
    );
    if (
      stack.state === undefined &&
      !ctx.log
        .read()
        .some(
          (entry) =>
            entry.type === "gap" && entry["kind"] === "stack-unavailable",
        )
    )
      ctx.log.write({
        type: "gap",
        stage: "frame",
        kind: "stack-unavailable",
        detail:
          "The sources of the libraries this change uses couldn't be read, so context from them is missing.",
        cause: stack.unavailable ?? "unknown",
      });
    return stack;
  };

  const viewOf: StageRun["view"] = (from, signal) =>
    views(JSON.stringify([from.precompute, from.setup ?? null]), async () => {
      const stored = await factsOf(from.precompute, signal);
      const scopeKey =
        from.setup === undefined ? stored.scope : from.setup.scopeKey;
      const built = await run(
        Effect.gen(function* () {
          const manifest = yield* storedOutput(
            ctx,
            stored.manifest,
            RangeManifest,
          );
          const snapshot =
            scopeKey === null
              ? undefined
              : yield* withRecords(ctx, snapshotByKey(scopeKey));
          const { head, base } = yield* revisionViews(ctx.repository, manifest);
          return {
            manifest,
            snapshot,
            head,
            base,
            hunks: new Map(manifest.hunks.map((hunk) => [hunk.hunkId, hunk])),
            commits: yield* rangeCommits(ctx.repository, manifest),
            findLog: yield* rangeCommitFiles(
              ctx.repository,
              manifest.range.mergeBase,
              manifest.range.headOid,
            ).pipe(Effect.catch(() => Effect.succeed(undefined))),
            byPath: yield* commitsByPath(manifest, (args) =>
              git(ctx.repository, args),
            ),
            searchFrequency: new Map<string, Set<string>>(),
          };
        }),
        signal,
      );
      const stack = await stackOf(signal);
      const setup = from.setup;
      return {
        ...built,
        ...(stack === undefined ? {} : { stack }),
        ...(setup === undefined
          ? {}
          : {
              pins: setup.pins,
              currency: Proofs.currencyChecker({
                repository: ctx.repository,
                headOid: ctx.range.headOid,
              }),
              ...(setup.refreshKey === null
                ? {}
                : { scopeRefresh: setup.refreshKey }),
            }),
      };
    });

  const candidatesOf: StageRun["candidates"] = (view, signal) =>
    candidates(view, () =>
      run(candidateObligations(lookupContext(ctx, view)), signal),
    );

  const ventOf = (stage: AgentStage) => {
    const held = vents.get(stage);
    if (held !== undefined) return held;
    const made = ventTool(ctx, stage);
    vents.set(stage, made);
    return made;
  };

  const prepareStep = async (
    input: AgentStepInput,
    reader: DocumentReader,
    context: Context,
  ): Promise<ResolvedAgent> => {
    const vent = ventOf(stageOfKind(input.kind));
    const signal = context.abortSignal;
    switch (input.kind) {
      case "scope-change": {
        const { change } = readData(KindParams["scope-change"], input.params);
        const step = scopeChangeStep(ctx, change);
        return {
          step: erased({
            ...step,
            spec: {
              ...step.spec,
              stage: "frame",
              agent: `frame.scope-change.${change.source}`,
            },
          }),
          vent,
        };
      }
      case "frame": {
        readData(KindParams.frame, input.params);
        const setup = await setupOf(reader, context);
        const view = await viewOf(
          { precompute: setup.precompute, setup },
          signal,
        );
        const step = await run(
          frameStep(
            ctx,
            setup.precompute,
            view,
            await candidatesOf(view, signal),
          ),
          signal,
        );
        return {
          step: erased({
            ...step,
            spec: { ...step.spec, retries: step.spec.retries ?? 1 },
          }),
          vent,
        };
      }
      case "map": {
        const params = readData(KindParams.map, input.params);
        const setup = await setupOf(reader, context);
        const view = await viewOf(
          { precompute: setup.precompute, setup },
          signal,
        );
        const step = mapStep(
          ctx,
          view,
          { key: params.frame, value: await read(params.frame, Frame, signal) },
          {
            key: params.manifest,
            value: await read(params.manifest, MapManifest, signal),
          },
        );
        return {
          step: erased({
            ...step,
            spec: { ...step.spec, retries: step.spec.retries ?? 1 },
          }),
          vent,
        };
      }
      case "find":
      case "verify": {
        const setup = await setupOf(reader, context);
        const view = await viewOf(
          { precompute: setup.precompute, setup },
          signal,
        );
        if (input.kind === "find") {
          const params = readData(KindParams.find, input.params);
          return {
            step: erased(
              await run(
                findStep(ctx, view, {
                  lens: params.lens,
                  frame: await read(params.frame, Frame, signal),
                  keys: params,
                  verify: (claim) =>
                    verifyChild(
                      params.finder,
                      params.frame,
                      input.cutoffAt,
                      claim,
                    ),
                }),
                signal,
              ),
            ),
            vent,
          };
        }
        const params = readData(KindParams.verify, input.params);
        return {
          step: erased(
            await run(
              verifyStep(ctx, view, {
                finding: params.finding,
                frame: await read(params.frame, Frame, signal),
                frameKey: params.frame,
              }),
              signal,
            ),
          ),
          vent,
        };
      }
      case "assess":
      case "lane-review":
      case "verify-claim": {
        // Only Lane review's tools read the range's trees; the other two never list them.
        const view = async () => {
          const setup = await setupOf(reader, context);
          return viewOf({ precompute: setup.precompute, setup }, signal);
        };
        return {
          step: await readingStep(
            ctx,
            run,
            view,
            input.kind === "assess"
              ? {
                  kind: "assess",
                  params: readData(KindParams.assess, input.params),
                }
              : input.kind === "lane-review"
                ? {
                    kind: "lane-review",
                    params: readData(KindParams["lane-review"], input.params),
                  }
                : {
                    kind: "verify-claim",
                    params: readData(KindParams["verify-claim"], input.params),
                  },
            signal,
          ),
          vent,
        };
      }
      case "brief":
        return {
          step: await briefingAgent(
            ctx,
            run,
            readData(KindParams.brief, input.params),
            signal,
          ),
          vent,
        };
    }
  };

  return {
    facts: factsOf,
    setup: setupOf,
    view: viewOf,
    candidates: candidatesOf,
    preview: prepareStep,
    prepare: (taskId, input, reader, context) =>
      prepared(taskId, () => prepareStep(input, reader, context)),
  };
};
