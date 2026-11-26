// Why: exercise the production preparation, native tools, durable child registration, final
// re-registration and rollback/replay together. Fixture source is retained in the manifest; only
// structural preparation is supplied (as precompute would), so this needs neither Graph nor a model account.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  type Message,
} from "@earendil-works/pi-ai";
import {
  Harness,
  createRegistry,
  defineTask,
  defineExtension,
  type TaskId,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Context, Effect, Layer, Scope } from "effect";
import {
  Blobs,
  Computations,
  Store,
  mintUlid,
  storeLocationIn,
  sha256Hex,
} from "@neuve/records-core";
import { defaultConfig } from "../src/config.ts";
import {
  RangeManifest,
  frontSettings,
  defaultManifestSettings,
} from "../src/manifest.ts";
import { Frame } from "../src/frame.ts";
import { ReviewMap, mapExclusion } from "../src/review-map.ts";
import { planAssignments } from "../src/readings/assignments.ts";
import { renderReading } from "../src/readings/reading.ts";
import { LaneReviewStored } from "../src/readings/steps.ts";
import { ClaimStored, claimVerdict } from "../src/readings/claims.ts";
import { RecordedReviewClaim } from "../src/readings/reviewer-claim-schema.ts";
import { McpClients, mcpClientsLayer } from "../src/mcp-client.ts";
import { storedOutput, ventTool, type RangeView } from "../src/pipeline.ts";
import { agentRoutes, clearInheritedAgentRoute } from "../src/pi/bindings.ts";
import {
  initializeClaimSettlement,
  ClaimSettlementDoc,
  restoreClaim,
} from "../src/pi/claim-settlement.ts";
import { agentKinds } from "../src/pi/stages/kinds.ts";
import { KindParams } from "../src/pi/stages/run.ts";
import { ChildrenDoc } from "../src/pi/stages/docs.ts";
import {
  readingTask,
  readingStep,
  remembered,
  type ReadingTaskResult,
} from "../src/pi/stages/reading-task.ts";
import { stageRunner, type StageServices } from "../src/pi/stages/services.ts";
import { mixedRange } from "./fixtures/readings.ts";
import { testRuntimes } from "./pi/stages/fixture.ts";

const directory = mkdtempSync(join(tmpdir(), "comprehensive-native-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const textOf = (v: unknown): string =>
  typeof v === "string"
    ? v
    : Array.isArray(v)
      ? v.map(textOf).join("\n")
      : v !== null && typeof v === "object"
        ? Object.values(v).map(textOf).join("\n")
        : "";

const execute = async (
  invalid: boolean | "abort" = false,
  reuse?: "before-drain" | "concurrent" | "changed-context",
  noClaims = false,
  restore = false,
) => {
  const location = storeLocationIn(join(directory, mintUlid()));
  const scope = await Effect.runPromise(Scope.make());
  const records = await Effect.runPromise(
    Layer.buildWithScope(
      Computations.layer.pipe(
        Layer.provideMerge(Blobs.layer(location)),
        Layer.provideMerge(Store.layer(location, { create: true })),
        Layer.provideMerge(BunFileSystem.layer),
      ),
      scope,
    ),
  );
  await Effect.runPromise(Effect.provide(Store.prepareForWrite, records));
  const clients = Context.get(
    await Effect.runPromise(
      Layer.buildWithScope(
        mcpClientsLayer({ status: "absent", path: "(none)" }),
        scope,
      ),
    ),
    McpClients,
  );
  const rows: Array<any> = [];
  const ctx = {
    location,
    repository: location.directory,
    runId: mintUlid(),
    runKey: "f".repeat(64),
    cycleId: mintUlid(),
    config: defaultConfig(),
    range: {
      baseRef: "base",
      baseOid: "1".repeat(40),
      headOid: "2".repeat(40),
    },
    log: {
      path: "memory",
      read: () => rows,
      write: (row: any) => rows.push(row),
    },
    startedAt: Date.now(),
    reconciliationId: mintUlid(),
    records,
  };
  const run = stageRunner(ctx, clients);
  const laterCtx = { ...ctx, runId: mintUlid() };
  const sourceByReview = new Map<number, typeof ctx>();
  const originalReviews = new Set<number>();
  const originalReadReady = Promise.withResolvers<void>();
  const allowOriginalDrain = Promise.withResolvers<void>();
  let originalPaused = false;
  const store = async (op: string, output: unknown) =>
    run(
      Effect.gen(function* () {
        const c = yield* Computations.ComputationStore;
        return (yield* c.run(
          { op, opVersion: 1, inputs: { test: ctx.runId } },
          Effect.succeed({
            bytes: new TextEncoder().encode(JSON.stringify(output)),
            mediaType: "application/json",
          }),
        )).computation.key;
      }),
    );
  const source = mixedRange();
  const manifest = RangeManifest.parse({
    range: {
      baseOid: ctx.range.baseOid,
      headOid: ctx.range.headOid,
      mergeBase: ctx.range.baseOid,
      baseTree: "3".repeat(40),
      headTree: "4".repeat(40),
    },
    settings: frontSettings(defaultManifestSettings(200_000)),
    files: source.hunks.length,
    reviewLines: 100,
    hunks: source.hunks.map((hunk) => {
      const retained = { ...hunk };
      Reflect.deleteProperty(retained, "leads");
      return retained;
    }),
    facts: [],
    declarations: { readers: [], gaps: [] },
    limitations: [],
  });
  const manifestKey = await store("test.manifest", manifest);
  const frame = Frame.parse({
    goal: "Preserve required behavior",
    stratum: "commit-or-pr-text",
    sourceIds: ["S1"],
    doneWhen: [
      {
        id: "D1",
        text: "Preserve required behavior",
        basis: "scope",
        candidateId: null,
        sectionId: "S1.1",
      },
    ],
    source: "agent",
    gaps: [],
    inputs: {
      sectionsInlined: 1,
      sectionsListed: 1,
      commitsShown: 1,
      commitsTotal: 1,
    },
  });
  const frameKey = await store("test.frame", frame);
  const map = ReviewMap.parse({
    frame: frameKey,
    source: "agent",
    groups: [
      {
        id: "batch",
        label: "Behavior",
        why: "Shared obligation",
        tier: "core",
        doneWhen: ["D1"],
        files: [
          ...new Set(
            source.hunks
              .filter((hunk) => mapExclusion(hunk.path, [hunk]) === undefined)
              .map((hunk) => hunk.path),
          ),
        ].map((path) => ({ path, placedBy: "map" })),
        hunkIds: source.hunks
          .filter((hunk) => mapExclusion(hunk.path, [hunk]) === undefined)
          .map((hunk) => hunk.hunkId),
        changedLines: 100,
      },
    ],
    excluded: [],
    rolledUp: [],
    unlinkedDoneWhen: [],
    gaps: [],
  });
  const mapKey = await store("test.map", map);
  const plan = planAssignments({
    hunks: source.hunks,
    structures: source.structures,
    source: { manifestKey, frameKey, mapKey },
    batches: map.groups,
  });
  const planKey = await store("test.plan", plan);
  // Supplied structural observation only. All ownership/source, scope/proof tools and durable state
  // below are production code; no verdict, lookup result or claim is stubbed into the reviewer.
  await remembered(ctx, `structures:${manifestKey}`, async () => ({
    structures: source.structures,
    source: { unavailable: "fixture" },
  }));
  await remembered(laterCtx, `structures:${manifestKey}`, async () => ({
    structures: source.structures,
    source: { unavailable: "fixture" },
  }));
  const group = plan.groups[0]!;
  const hunkMap = new Map(manifest.hunks.map((hunk) => [hunk.hunkId, hunk]));
  const index = renderReading(plan, group.id, {
    for: "lane-review",
    hunks: hunkMap,
    structures: source.structures,
  }).index;
  const first = index.sections[0]!;
  const own = first.owned[0]!;
  const path = index.files.find((file) => file.index === first.file)!.path;
  const claimText = "KEEP-CLAIM: caller receives a wrong count";
  const fails = "The final item is omitted on this path";
  const scopeBody = "# Requirement\n\nPreserve required behavior at the caller";
  const view: RangeView = {
    manifest,
    head: {
      label: "head",
      commit: ctx.range.headOid,
      tree: manifest.range.headTree,
      entries: new Map(),
    },
    base: {
      label: "base",
      commit: ctx.range.baseOid,
      tree: manifest.range.baseTree,
      entries: new Map(),
    },
    hunks: hunkMap,
    byPath: new Map(),
    searchFrequency: new Map(),
    commits: [
      {
        oid: ctx.range.headOid,
        subject: "Requirement",
        body: "Preserve required behavior at the caller",
      } as any,
    ],
    snapshot: {
      cycleId: ctx.cycleId,
      fetchedAt: "now",
      ms: 0,
      range: manifest.range,
      integrations: { file: "absent", detail: null, servers: [] },
      named: [],
      sources: [
        {
          id: "S1",
          kind: "commit-text",
          stratum: "commit-or-pr-text",
          fetchedAt: "now",
          ms: 0,
          status: "fetched",
          ref: { found: "submitted scope" },
          title: "Requirement",
          sections: [
            {
              id: "S1.1",
              title: "Requirement",
              startLine: 1,
              endLine: 3,
              bytes: scopeBody.length,
              sha256: sha256Hex(scopeBody),
            },
          ],
          capture: null,
          gap: null,
        },
      ],
      strata: {
        strongest: "commit-or-pr-text",
        present: ["commit-or-pr-text"],
      },
      gaps: [],
    },
  };
  const changedView: RangeView = {
    ...view,
    snapshot:
      view.snapshot === undefined
        ? undefined
        : {
            ...view.snapshot,
            sources: view.snapshot.sources.map((source) => ({
              ...source,
              sections: source.sections.map((section) => ({
                ...section,
                title: `${section.title} — revised context`,
              })),
            })),
          },
  };
  const models = createModels();
  const registry = createRegistry();
  let harness: Harness;
  let rounds = 0;
  let readingId: TaskId<ReadingTaskResult> | undefined;
  const sent: Array<ReadonlyArray<Message>> = [];
  const routes = () =>
    agentRoutes({
      harness,
      models,
      runId: ctx.runId,
      createProvider: (binding) => {
        let agentRound = 0;
        const faux = fauxProvider({
          api: "faux",
          provider: binding.logicalProvider,
          models: [{ id: binding.physicalModel }],
        });
        faux.setResponses(
          Array.from({ length: 40 }, () => async (transcript, options) => {
            sent.push(transcript.messages);
            const text = textOf(transcript.messages);
            const reply = (name: string, args: any) =>
              fauxAssistantMessage(
                [fauxToolCall(name, args, { id: `c${sent.length}` })],
                { stopReason: "toolUse" },
              );
            if (text.includes("Check whether the supplied evidence"))
              return reply("submit_verify", {
                decision: "keep",
                reason: "Fixture verification observed cited source",
              });
            rounds++;
            agentRound++;
            if (agentRound === 1)
              return fauxAssistantMessage(
                [
                  fauxToolCall(
                    "scope_section",
                    { id: "S1.1" },
                    { id: "scope" },
                  ),
                  fauxToolCall("proofs", {}, { id: "proofs" }),
                ],
                { stopReason: "toolUse" },
              );
            if (agentRound === 2 && !noClaims)
              return reply("record_claim", {
                anchor: { path, ...own },
                kind: "defect",
                text: claimText,
                fails,
                evidence: ["section.1"],
                row: "D1",
              });
            if (invalid === "abort") {
              void harness.abortTask(readingId!, context);
              return new Promise((resolve) => {
                const stopped = () =>
                  resolve(fauxAssistantMessage([], { stopReason: "aborted" }));
                if (options?.signal?.aborted) stopped();
                else
                  options?.signal?.addEventListener("abort", stopped, {
                    once: true,
                  });
              });
            }
            if (invalid === true)
              return reply("submit_review", {
                review: "not a review",
                checks: [],
              });
            return reply("submit_review", {
              review: {
                files: index.files.map((file) => ({
                  f: file.index,
                  checked: "Traced changed paths against required behavior",
                  rows: [
                    {
                      row: "D1",
                      reading:
                        "The source was examined; recorded proof is missing",
                      status: "no-evidence",
                      cites: [],
                    },
                  ],
                })),
                sections: {
                  a: [],
                  r: noClaims ? [] : [first.index],
                  u: index.sections
                    .filter(
                      (section) => noClaims || section.index !== first.index,
                    )
                    .map((section) => section.index),
                },
                comments: noClaims
                  ? []
                  : [
                      {
                        s: first.index,
                        side: own.side,
                        start: own.startLine,
                        end: own.startLine,
                        kind: "defect",
                        effect: null,
                        t: claimText,
                        cites: [
                          `${first.file}${own.side === "new" ? "n" : "o"}${own.startLine}`,
                        ],
                        fails,
                        row: "D1",
                      },
                    ],
                unsure: index.sections
                  .filter(
                    (section) => noClaims || section.index !== first.index,
                  )
                  .map((section) => ({
                    s: section.index,
                    t: "Additional context unavailable in this fixture",
                  })),
                notAsked: [],
              },
              checks: [],
            });
          }),
        );
        return faux.provider;
      },
    });
  let bound: ReturnType<typeof routes>;
  const services: StageServices = {
    ctx,
    clients,
    run,
    registry,
    runtimes: testRuntimes().registry,
    capture: () => {},
    integrations: { status: "absent", path: "(none)" },
    routes: {
      bindAgentRoute: (input, c) => bound.bindAgentRoute(input, c),
      prepareFinalGeneration: (input, c) =>
        bound.prepareFinalGeneration(input, c),
    },
    endRound: async ({ generation, decide }, c) => {
      if (await harness.commit(decide, c))
        await harness.abortTask(generation, c);
    },
  };
  const kinds = agentKinds(services, {
    prepare: async (_id, input) => ({
      step: await readingStep(
        sourceByReview.get(
          Number((input.params as { review?: number }).review),
        ) ?? ctx,
        run,
        async () =>
          reuse === "changed-context" &&
          sourceByReview.get(
            Number((input.params as { review?: number }).review),
          ) === laterCtx
            ? changedView
            : view,
        input.kind === "verify-claim"
          ? {
              kind: "verify-claim",
              params: KindParams["verify-claim"].parse(input.params),
            }
          : {
              kind: "lane-review",
              params: KindParams["lane-review"].parse(input.params),
            },
      ),
      vent: ventTool(ctx, "verify"),
    }),
  });
  const nativeReading = readingTask(services, kinds.agentStep);
  const childrenByAssignment: Record<number, Record<string, number>> = {};
  const donePhase = nativeReading.definition.phases.done;
  let replays = 0;
  const phase = nativeReading.definition.phases.claims;
  const reading = {
    definition: {
      ...nativeReading.definition,
      phases: {
        ...nativeReading.definition.phases,
        done: async (task: any, runtime: any, c: any) => {
          childrenByAssignment[Number(runtime.taskId)] =
            (await runtime.snapshot(ChildrenDoc, runtime.taskId, c))
              ?.children ?? {};
          return donePhase(task, runtime, c);
        },
        claims: async (task: any, runtime: any, c: any) => {
          if (
            reuse === "before-drain" &&
            originalReviews.has(task.input.review) &&
            !originalPaused
          ) {
            originalPaused = true;
            originalReadReady.resolve();
            await allowOriginalDrain.promise;
          }
          if (replays++ === 0) {
            const failure = new Error("rollback after registration");
            try {
              await phase(
                task,
                {
                  ...runtime,
                  commit: (change: any, cc: any) =>
                    runtime.commit(async (tx: any) => {
                      await change(tx);
                      throw failure;
                    }, cc),
                },
                c,
              );
            } catch (error) {
              if (error !== failure) throw error;
            }
          }
          return phase(task, runtime, c);
        },
      },
    },
  } as typeof nativeReading;
  const root = defineTask<
    { readonly later?: boolean },
    { phase: "start" } | { phase: "done"; reading: number },
    ReadingTaskResult
  >({
    name: "test.comprehensive-review",
    version: 1,
    initial: () => ({ phase: "start" }),
    phases: {
      start: async (task, runtime, c) => {
        sourceByReview.set(
          Number(runtime.taskId),
          task.input.later ? laterCtx : ctx,
        );
        if (!task.input.later) originalReviews.add(Number(runtime.taskId));
        return runtime.commit(async (tx) => {
          const id = await tx.createTask(
            reading,
            {
              kind: "lane-review",
              review: Number(runtime.taskId),
              planKey,
              group: group.id,
              rank: group.rank,
              manifestKey,
              frameKey,
              mapKey,
              cutoffAt: Date.now() + 30_000,
            },
            { ownership: { kind: "task", taskId: runtime.taskId } },
          );
          readingId = id as TaskId<ReadingTaskResult>;
          await initializeClaimSettlement(tx, runtime.taskId, {
            source: {
              plan: planKey,
              manifestKey,
              frameKey,
              mapKey,
              runKey: ctx.runKey,
              runId: task.input.later ? laterCtx.runId : ctx.runId,
              cycle: ctx.cycleId,
              head: ctx.range.headOid,
              range: JSON.stringify(ctx.range),
              config: JSON.stringify(ctx.config),
            },
            assignments: [
              {
                assignmentId: group.id,
                batchId: group.batchId,
                task: Number(id),
                sections: plan.sections
                  .filter((section) => group.keys.includes(section.key))
                  .map((section) => ({
                    key: section.key,
                    path: section.path,
                    renamedFrom: section.identity.renamedFrom,
                    owned: section.owned.map(
                      ({ side, startLine, endLine }) => ({
                        side,
                        startLine,
                        endLine,
                      }),
                    ),
                  })),
              },
            ],
            unread: [],
          });
          if (restore && task.input.later) {
            const ledger = await tx.doc(ClaimSettlementDoc);
            const originalReview = [...originalReviews][0]!;
            const original = Object.values(
              ledger.reviews[String(originalReview)]!.claims,
            )[0]!;
            const inline = RecordedReviewClaim.parse(original.report);
            // Native execution is current; retained report/source/producer are not rewritten.
            const check = await tx.createTask(
              kinds.agentStep,
              {
                kind: "verify-claim",
                params: {
                  plan: planKey,
                  group: group.id,
                  manifest: manifestKey,
                  claim: inline.key,
                  inline: JSON.parse(JSON.stringify(inline)),
                },
                cutoffAt: Date.now() + 30_000,
              },
              { ownership: { kind: "task", taskId: runtime.taskId } },
            );
            await restoreClaim(tx, runtime.taskId, {
              ...original,
              verificationTask: Number(check),
              retainedVerification: {
                task: original.verificationTask,
                key: null,
                outcome: "unconfirmed",
              },
            });
          }
          return {
            status: "waiting",
            on: [id],
            policy: "allSettled",
            checkpoint: { phase: "done", reading: Number(id) },
          };
        }, c);
      },
      done: async (task, runtime, c) => {
        const [ended] = await runtime.outcomes(
          [task.state.checkpoint.reading as TaskId<ReadingTaskResult>],
          c,
        );
        if (ended!.status !== "completed" && ended!.status !== "aborted")
          throw new Error(JSON.stringify(ended));
        const result = ended!.result;
        if (result === undefined)
          throw new Error("Reading returned no retained outcome");
        return runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result },
          }),
          c,
        );
      },
    },
    abort: (_task, runtime, c) =>
      runtime.commit(
        () => ({
          status: "terminal",
          outcome: { status: "aborted", reason: "stopped" },
        }),
        c,
      ),
  });
  registry.install(
    defineExtension({
      name: "test.comprehensive",
      tasks: [root, reading, kinds.agentStep],
    }),
  );
  harness = await Harness.open(
    await openNodeSqliteStorage(join(location.directory, "native.sqlite")),
    {
      models,
      registry,
      settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
      conversationCreated: clearInheritedAgentRoute,
    },
    context,
  );
  bound = routes();
  const conversation = await harness.root(context);
  const createRoot = (later: boolean) =>
    harness.commit(
      (tx) =>
        tx.createTask(
          root,
          { later },
          {
            ownership: { kind: "conversation" },
            conversationId: conversation.id,
          },
        ),
      context,
    );
  const id = await createRoot(false);
  let second: TaskId<ReadingTaskResult> | undefined;
  if (reuse === "concurrent" || reuse === "changed-context")
    second = await createRoot(true);
  harness.resume();
  if (reuse === "before-drain") {
    await originalReadReady.promise;
    second = await createRoot(true);
    await harness.waitForTask(second, context);
    allowOriginalDrain.resolve();
  }
  const ended = await harness.waitForTask(id, context);
  const settlement = (await harness.snapshot(ClaimSettlementDoc, context))!
    .reviews[String(id)]!;
  const result =
    ended.state.outcome.status === "completed"
      ? ended.state.outcome.result
      : undefined;
  const reused: Array<{
    result: ReadingTaskResult;
    settlement: typeof settlement;
  }> = [];
  if (second !== undefined) {
    const other = await harness.waitForTask(second, context);
    if (other.state.outcome.status !== "completed")
      throw new Error(JSON.stringify(other.state.outcome));
    reused.push({
      result: other.state.outcome.result,
      settlement: (await harness.snapshot(ClaimSettlementDoc, context))!
        .reviews[String(second)]!,
    });
    // A third distinct caller exercises completed-output reuse after the concurrent/reentrant case.
    const replay = await createRoot(true);
    const replayed = await harness.waitForTask(replay, context);
    if (replayed.state.outcome.status !== "completed")
      throw new Error(JSON.stringify(replayed.state.outcome));
    reused.push({
      result: replayed.state.outcome.result,
      settlement: (await harness.snapshot(ClaimSettlementDoc, context))!
        .reviews[String(replay)]!,
    });
  }
  const tasks = await harness.commit(
    async (tx) => (await tx.scanTasks({}, 1000)).items,
    context,
  );
  await harness.close(context);
  return {
    childrenByAssignment,
    ctx,
    laterCtx,
    run,
    result,
    settlement,
    reused,
    sent,
    rows,
    replays,
    tasks,
  };
};

test("production comprehensive task exposes scope and explicit unavailable proof, registers one Verify and replays finalization with exact non-null evidence basis", async () => {
  const observed = await execute();
  expect(observed.result).toBeDefined();
  expect(observed.replays).toBeGreaterThan(0);
  const claims = Object.values(observed.settlement.claims);
  expect(claims).toHaveLength(1);
  expect(claims[0]!.basis.source).toHaveProperty("evidence");
  expect((claims[0]!.basis.source as any).evidence).not.toBeNull();
  const result = observed.result!;
  expect(result.claims).toHaveLength(1);
  const check = await observed.run(
    storedOutput(observed.ctx, result.claims[0]!.verifyKey!, ClaimStored),
  );
  expect(claimVerdict(check)).toBe("confirmed");
  expect(textOf(observed.sent)).toContain(
    "Preserve required behavior at the caller",
  );
  expect(textOf(observed.sent)).toContain("Proof records could not be read");
  const stored = await observed.run(
    storedOutput(observed.ctx, result.steps[0]!, LaneReviewStored),
  );
  expect(stored.claims).toHaveLength(1);
  expect(stored.answer.sections.a).toEqual([]);
}, 60_000);

test("invalid comprehensive answers cannot approve and do not erase registered interim claims", async () => {
  const observed = await execute(true);
  expect(Object.values(observed.settlement.claims)).toHaveLength(1);
  for (const key of observed.result!.steps) {
    const stored = await observed.run(
      storedOutput(observed.ctx, key, LaneReviewStored),
    );
    expect(stored.answer.sections.a).toEqual([]);
    expect(stored.unanswered.length).toBeGreaterThan(0);
  }
}, 60_000);

test("native interruption retains registered and partial claims without approving unreached work", async () => {
  const observed = await execute("abort");
  expect(Object.values(observed.settlement.claims)).toHaveLength(1);
  expect(observed.result!.notJudged.length).toBeGreaterThan(0);
  expect(
    observed.result!.stages.some((stage) => stage.status === "interrupted"),
  ).toBe(true);
  expect(observed.result!.steps.length).toBeGreaterThan(0);
  const stored = await observed.run(
    storedOutput(observed.ctx, observed.result!.steps[0]!, LaneReviewStored),
  );
  expect(stored.claims).toHaveLength(1);
  expect(stored.answer.sections.a).toEqual([]);
  expect(stored.unanswered).toHaveLength(stored.sections.length);
}, 60_000);

for (const mode of [
  "before-drain",
  "concurrent",
  "restored-before-drain",
] as const) {
  test(`exact comprehensive work is shared across different native IDs and run labels (${mode})`, async () => {
    const observed = await execute(
      false,
      mode === "restored-before-drain" ? "before-drain" : mode,
      false,
      mode === "restored-before-drain",
    );
    expect(observed.reused).toHaveLength(2);
    const first = await observed.run(
      storedOutput(observed.ctx, observed.result!.steps[0]!, LaneReviewStored),
    );
    expect(first.origin).toBeDefined();
    expect(first.claims).toHaveLength(1);
    expect(first.claims![0]!.basis!.origin).toEqual(first.origin);
    const producers = new Set<number>();
    for (const value of [
      observed.result!,
      ...observed.reused.map((entry) => entry.result),
    ]) {
      expect(value.steps).toEqual(observed.result!.steps);
      expect(value.claims).toHaveLength(1);
      expect(value.claims[0]!.verifyKey).toBe(
        observed.result!.claims[0]!.verifyKey,
      );
      const stored = await observed.run(
        storedOutput(observed.ctx, value.steps[0]!, LaneReviewStored),
      );
      expect(stored).toEqual(first);
      for (const stage of value.stages)
        if (stage.agent?.startsWith("lane-review."))
          expect(["computed", "reused"]).toContain(stage.status);
    }
    for (const settlement of [
      observed.settlement,
      ...observed.reused.map((entry) => entry.settlement),
    ]) {
      const claims = Object.values(settlement.claims);
      expect(claims).toHaveLength(1);
      expect(RecordedReviewClaim.parse(claims[0]!.report)).toEqual(
        first.claims![0]!,
      );
      expect(claims[0]!.basis.origin).toEqual(first.origin);
      expect(claims[0]!.basis.producer).toEqual(first.by);
      expect(claims[0]!.producer.task).toBe(first.origin!.assignmentTask);
      expect(claims[0]!.source.runId).toBe(first.by!.run);
      expect(claims[0]!.source.origin).toEqual(first.origin);
      expect(claims[0]!.verificationTask).not.toBeNull();
      const verify = observed.tasks.find(
        (task) => Number(task.id) === claims[0]!.verificationTask,
      )!;
      const inline = (verify.input as { params: { inline: unknown } }).params
        .inline;
      expect(inline).toEqual(first.claims![0]);
      expect(claims[0]!.destination.status).toBe("owned");
      // Native delivery is rebound, but this output remains the original producer's report.
      for (const assignment of settlement.assignments) {
        expect(assignment.task).not.toBeNull();
        if (assignment.task !== null) {
          producers.add(assignment.task);
          expect(
            observed.childrenByAssignment[assignment.task]![
              `claim.${claims[0]!.key}`
            ],
          ).toBe(claims[0]!.verificationTask!);
          const currentReview = observed.tasks.find(
            (task) => Number(task.id) === assignment.task,
          )!.owner;
          // Restored checks are review-owned in this database, never old native IDs.
          if (
            mode === "restored-before-drain" &&
            assignment.task !== first.origin!.assignmentTask
          )
            expect(Number(verify.owner)).toBe(Number(currentReview));
        }
      }
    }
    expect(producers.size).toBe(3);
    const verifications = observed.sent.filter((messages) =>
      textOf(messages).includes("Check whether the supplied evidence"),
    );
    expect(verifications).toHaveLength(1);
    const computed = [
      observed.result!,
      ...observed.reused.map((entry) => entry.result),
    ]
      .flatMap((value) => value.stages)
      .filter(
        (stage) =>
          stage.agent?.startsWith("lane-review.") &&
          stage.status === "computed",
      );
    expect(computed).toHaveLength(1);
    expect(computed[0]!.agentResult!.modelCalls).toBeGreaterThan(0);
    expect(observed.sent.length - verifications.length).toBe(
      computed[0]!.agentResult!.modelCalls,
    );
    expect(observed.ctx.runId).not.toBe(observed.laterCtx.runId);
    expect([observed.ctx.runId, observed.laterCtx.runId]).toContain(
      first.by!.run,
    );
  }, 60_000);
}

test("a reused judgment with no claims keeps its original native producer before the original root drains", async () => {
  const observed = await execute(false, "before-drain", true);
  const original = await observed.run(
    storedOutput(observed.ctx, observed.result!.steps[0]!, LaneReviewStored),
  );
  expect(original.claims).toEqual([]);
  expect(original.origin).toBeDefined();
  expect(original.by!.run).toBe(observed.ctx.runId);
  for (const reused of observed.reused) {
    expect(reused.result.steps).toEqual(observed.result!.steps);
    const stored = await observed.run(
      storedOutput(observed.ctx, reused.result.steps[0]!, LaneReviewStored),
    );
    expect(stored.origin).toEqual(original.origin);
    expect(stored.by).toEqual(original.by);
    expect(Object.values(reused.settlement.claims)).toEqual([]);
  }
  const computed = [
    observed.result!,
    ...observed.reused.map((entry) => entry.result),
  ]
    .flatMap((value) => value.stages)
    .filter(
      (stage) =>
        stage.agent?.startsWith("lane-review.") && stage.status === "computed",
    );
  expect(computed).toHaveLength(1);
  expect(observed.sent).toHaveLength(computed[0]!.agentResult!.modelCalls);
}, 60_000);

test("changed actual surrounding context misses the judgment cache even when source and assignment are unchanged", async () => {
  const observed = await execute(false, "changed-context");
  expect(observed.result!.steps[0]).not.toBe(
    observed.reused[0]!.result.steps[0],
  );
  expect(observed.reused[0]!.result.steps).toEqual(
    observed.reused[1]!.result.steps,
  );
  const original = await observed.run(
    storedOutput(observed.ctx, observed.result!.steps[0]!, LaneReviewStored),
  );
  const changed = await observed.run(
    storedOutput(
      observed.ctx,
      observed.reused[0]!.result.steps[0]!,
      LaneReviewStored,
    ),
  );
  expect(original.by!.run).toBe(observed.ctx.runId);
  expect(changed.by!.run).toBe(observed.laterCtx.runId);
  expect(changed.origin).not.toEqual(original.origin);
  const computed = [
    observed.result!,
    ...observed.reused.map((entry) => entry.result),
  ]
    .flatMap((value) => value.stages)
    .filter(
      (stage) =>
        stage.agent?.startsWith("lane-review.") && stage.status === "computed",
    );
  expect(computed).toHaveLength(2);
  const verificationCalls = observed.sent.filter((messages) =>
    textOf(messages).includes("Check whether the supplied evidence"),
  ).length;
  expect(observed.sent.length - verificationCalls).toBe(
    computed.reduce((total, stage) => total + stage.agentResult!.modelCalls, 0),
  );
}, 60_000);
