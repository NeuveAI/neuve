// The real durable task and agent-step run against a faux model transport. These tests prove that
// per-finder dedupe feeds Verify and that an abort retains recorded work without inventing a check.
import { expect, test } from "bun:test";
import { z } from "zod";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type AssistantMessage,
  type Message,
} from "@earendil-works/pi-ai";
import {
  Harness,
  createRegistry,
  defineExtension,
  defineTask,
  type TaskId,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Context, Effect, Layer } from "effect";
import type { Context as ChordContext } from "@earendil-works/chord";
import {
  agentRoutes,
  clearInheritedAgentRoute,
} from "../../../src/pi/bindings.ts";
import { agentKinds } from "../../../src/pi/stages/kinds.ts";
import { erased } from "../../../src/pi/stages/agent.ts";
import {
  finderTask,
  type FinderResult,
} from "../../../src/pi/stages/finder-task.ts";
import { findStep, verifyStep } from "../../../src/pi/stages/find-steps.ts";
import {
  KindParams,
  stageRun,
  verifyChild,
} from "../../../src/pi/stages/run.ts";
import type { AgentStepInput } from "../../../src/pi/stages/agent-step.ts";
import {
  CHILD_STARTED_SPAN,
  kindExtensionName,
  startChild,
} from "../../../src/pi/stages/tools.ts";
import type { TaskGraph, ToolExecutionApi } from "@earendil-works/pi-durable";
import {
  stageRunner,
  type StageServices,
} from "../../../src/pi/stages/services.ts";
import { AgentContextDoc, ChildrenDoc } from "../../../src/pi/stages/docs.ts";
import type { ResolvedAgent } from "../../../src/pi/stages/tools.ts";
import { McpClients, mcpClientsLayer } from "../../../src/mcp-client.ts";
import {
  codeStage,
  storedOutput,
  ventTool,
  type StageRecord,
} from "../../../src/pipeline.ts";
import { childId } from "../../../src/pi/stages/children.ts";
import { recordStage } from "../../../src/pipeline.ts";
import { runStageOutputs } from "../../../src/stage-view.ts";
import { FINDERS, FindStored, type Lens } from "../../../src/find.ts";
import {
  claimKeyOf,
  verifyAgentOf,
  verifyChildName,
  VerifyStored,
} from "../../../src/verify.ts";
import { frame, map, finding, view, hunk } from "../../find-fixture.ts";
import { MAP_LOCKFILES } from "../../../src/review-map.ts";
import { captureOutlineSource } from "../../../src/graph-outline.ts";
import { OPENING_CHARS } from "../../../src/initial-context.ts";
import { rangeCommits, revisionViews } from "../../../src/lookups.ts";
import {
  defaultManifestSettings,
  rangeManifest,
} from "../../../src/manifest.ts";
import type { RangeView } from "../../../src/pipeline.ts";
import { world } from "./fixture.ts";
import type { CaptureEvent } from "../../../src/pi/capture/types.ts";
import { reviewStages } from "../../../src/pi/stages/index.ts";
import { codeFilledBatch, fill, link } from "../../../src/link.ts";
import { inputsOf, put } from "../../fixtures/link.ts";
import { Log } from "@neuve/records-core";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { openCaptureJournal } from "../../../src/pi/capture/journal.ts";
import { buildDump } from "../../../src/pi/capture/build.ts";

const toolReply = (name: string, input: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage([fauxToolCall(name, input)], { stopReason: "toolUse" });
const testWorld = async (
  name: string,
  reply: (
    messages: ReadonlyArray<Message>,
    signal: AbortSignal | undefined,
  ) => Promise<AssistantMessage> | AssistantMessage,
  abortAt: false | "find" | "map" | "dedupe" | "settle" = false,
  range = view(),
  options: {
    /** Runs before an agent is prepared: a tool call resolves its agent through it. */
    readonly preparing?: (
      input: AgentStepInput,
      context: ChordContext,
    ) => Promise<void>;
    /** The finder definition's version, for a run from an older build. */
    readonly finderVersion?: number;
    /** The Frame's key the finder reads (default `frame-key`). */
    readonly frameKey?: string;
    /** The stand-in front task's Map key (default the stored map's; null: no Map). */
    readonly mapKey?: string | null;
    /** Holds the stand-in front task, as Map still running does. */
    readonly mapLanded?: Promise<void>;
  } = {},
) => {
  const base = await world(`finder-${name}`);
  const captured: CaptureEvent[] = [];
  const clients = Context.get(
    await Effect.runPromise(
      Layer.buildWithScope(
        mcpClientsLayer({ status: "absent", path: "(none)" }),
        base.scope,
      ),
    ),
    McpClients,
  );
  let harness: Harness | undefined;
  // One process over the run's database: its own registry, models, agents and finder definition,
  // as a reopened run builds them.
  const open = async (finderVersion?: number) => {
    const models = createModels();
    const registry = createRegistry();
    const routes = () => {
      if (harness === undefined) throw new Error("not open");
      return agentRoutes({
        harness,
        models,
        runId: base.ctx.runId,
        createProvider: (binding) => {
          const faux = fauxProvider({
            api: "faux",
            provider: binding.logicalProvider,
            models: [{ id: binding.physicalModel }],
          });
          faux.setResponses(
            Array.from(
              { length: 64 },
              () => async (transcript, options) =>
                reply(transcript.messages, options?.signal),
            ),
          );
          return faux.provider;
        },
      });
    };
    const services: StageServices = {
      ctx: base.ctx,
      registry,
      clients,
      integrations: { status: "absent", path: "(none)" },
      capture: (event) => {
        captured.push(event);
      },
      run: stageRunner(base.ctx, clients),
      routes: {
        bindAgentRoute: (input, c) => routes().bindAgentRoute(input, c),
        prepareFinalGeneration: (input, c) =>
          routes().prepareFinalGeneration(input, c),
      },
      endRound: async ({ generation, decide }, c) => {
        if (harness === undefined) throw new Error("not open");
        if (await harness.commit(decide, c))
          await harness.abortTask(generation, c);
      },
    };
    const records = new Map<number, ResolvedAgent>();
    const kinds = agentKinds(services, {
      prepare: async (id, input, _read, c) => {
        await options.preparing?.(input, c);
        const held = records.get(id);
        if (held !== undefined) return held;
        if (input.kind === "find") {
          const p = KindParams.find.parse(input.params);
          const step = await services.run(
            findStep(base.ctx, range, {
              lens: p.lens,
              frame,
              keys: p,
              verify: (claim) =>
                verifyChild(p.finder, p.frame, input.cutoffAt, claim),
            }),
          );
          const resolved = {
            step: erased(step),
            vent: ventTool(base.ctx, "find"),
          };
          records.set(id, resolved);
          return resolved;
        }
        const p = KindParams.verify.parse(input.params);
        const step = await services.run(
          verifyStep(base.ctx, range, {
            finding: p.finding,
            frame,
            frameKey: p.frame,
          }),
        );
        const resolved = {
          step: erased(step),
          vent: ventTool(base.ctx, "verify"),
        };
        records.set(id, resolved);
        return resolved;
      },
    });
    const current = finderTask(services, stageRun(services), kinds.agentStep);
    const original: typeof current =
      finderVersion === undefined
        ? current
        : {
            definition: { ...current.definition, version: finderVersion },
          };
    // Cuts the finder off at the start of one phase, through its own abort handler.
    const cutOff: (typeof original.definition.phases)["dedupe"] = (
      task,
      runtime,
      c,
    ) =>
      original.definition.abort!(
        { ...task, input: { ...task.input, cutoffAt: Date.now() } },
        runtime,
        c,
      );
    const finder: typeof original = abortAt
      ? {
          definition: {
            ...original.definition,
            phases: { ...original.definition.phases, [abortAt]: cutOff },
          },
        }
      : original;
    // A stand-in for the front task: it ends (once `mapLanded` resolves) with the Map key.
    const front = defineTask<
      { mapKey: string | null },
      { phase: "run" },
      { mapKey: string | null }
    >({
      name: "test.front",
      version: 1,
      initial: () => ({ phase: "run" }),
      phases: {
        run: async (task, runtime, c) => {
          await options.mapLanded;
          await runtime.commit(
            () => ({
              status: "terminal",
              outcome: {
                status: "completed",
                result: { mapKey: task.input.mapKey },
              },
            }),
            c,
          );
        },
      },
      abort: (_task, runtime, c) =>
        runtime.commit(
          () => ({
            status: "terminal",
            outcome: {
              status: "aborted",
              reason: "stopped",
              result: { mapKey: null },
            },
          }),
          c,
        ),
    });
    registry.install(
      defineExtension({
        name: "finder-test",
        tasks: [kinds.agentStep, finder, front],
      }),
    );
    harness = await Harness.open(
      await openNodeSqliteStorage(base.database),
      {
        registry,
        models,
        settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
        conversationCreated: clearInheritedAgentRoute,
      },
      context,
    );
    await routes().restoreAgentRoutes(context);
    await kinds.restore(harness, context);
    return { harness, services, records, finder, front, registry };
  };
  const first = await open(options.finderVersion);
  const { services, records } = first;
  const root = await first.harness.root(context);
  const mapRecord = await services.run(
    codeStage(
      base.ctx,
      "precompute",
      { op: "test.finder.map", opVersion: 1, inputs: {} },
      Effect.succeed(map),
    ),
  );
  const start = async (
    lens: Lens,
    cutoffAt = Date.now() + 60_000,
    deadline = Date.now() + 30_000,
  ) =>
    harness!.commit(async (tx) => {
      // The front task that runs Map: here a stand-in whose result holds the Map key.
      const front = await tx.createTask(
        first.front,
        {
          mapKey:
            options.mapKey === undefined ? mapRecord.key! : options.mapKey,
        },
        { ownership: { kind: "conversation" }, conversationId: root.id },
      );
      return tx.createTask(
        first.finder,
        {
          lens,
          frameKey: options.frameKey ?? "frame-key",
          manifestKey: "manifest-key",
          front,
          cutoffAt,
          deadline,
        },
        { ownership: { kind: "conversation" }, conversationId: root.id },
      );
    }, context);
  return {
    harness: first.harness,
    registry: first.registry,
    services,
    start,
    base,
    records,
    captured,
    /** Closes this process and opens another over the same run, as a restart does. */
    reopen: async (finderVersion?: number) => {
      await harness?.close(context);
      return open(finderVersion);
    },
  };
};
const done = async (harness: Harness, id: TaskId<FinderResult>) => {
  const receipt = await harness.waitForTask(id, context);
  if (
    receipt.state.outcome.status !== "completed" &&
    receipt.state.outcome.status !== "aborted"
  )
    throw new Error(JSON.stringify(receipt.state.outcome));
  const result = receipt.state.outcome.result;
  if (result === undefined) throw new Error("no finder result");
  return result;
};

/** The claim key of a fixture finding in the test's finder. */
const claimOfFixture = (f: typeof finding = finding, frameKey = "frame-key") =>
  claimKeyOf(frameKey, { ...f, lens: "correctness", hunkId: "h1" });
/**
 * The result's one Verify record, checked against the base behaviour for a Verify stopped while
 * it ran: its own interrupted record with real wall time, the same status as the run log's stage
 * row for it, so the run's end reads as cut off (`handler.ts` looks for an interrupted stage).
 */
const interruptedVerify = (
  run: Awaited<ReturnType<typeof testWorld>>,
  result: FinderResult,
) => {
  const verifies = result.stages.filter(
    (s) => s.stage === "verify" && s.agent?.startsWith("verify."),
  );
  expect(verifies).toHaveLength(1);
  const verify = verifies[0]!;
  expect(verify.status).toBe("interrupted");
  expect(verify.wallMs).toBeGreaterThan(0);
  expect(
    run.base.ctx.log
      .read()
      .filter((r) => r.type === "stage" && r["agent"] === verify.agent)
      .map((r) => r["status"]),
  ).toEqual(["interrupted"]);
  return verify;
};

/** No unused Verify reaches the stage records that decide completeness and the run's end. */
const unusedOutOfStages = (result: FinderResult) =>
  (result.unused ?? []).every(
    (verify) =>
      !result.stages.some(
        (stage) =>
          stage.agent === verifyAgentOf(result.lens, verify.claim) ||
          (verify.key !== null && stage.key === verify.key),
      ),
  );

const publishFinder = async (
  run: Awaited<ReturnType<typeof testWorld>>,
  result: FinderResult,
) => {
  await run.services.run(
    Effect.gen(function* () {
      const frameKey = yield* put("test.finder.frame", frame);
      const mapKey = yield* put("test.finder.map", { ...map, frame: frameKey });
      const manifestKey = yield* put("test.finder.manifest", view().manifest);
      const setup = {
        precompute: "unused",
        scopeKey: null,
        refreshKey: null,
        pins: [],
        disclosures: [],
      };
      // The fixture has no Git repository for proof lookup; supply a fully checked ownership batch.
      const assembled = codeFilledBatch(inputsOf(view().manifest.hunks));
      const filled = {
        record: {
          stage: "link" as const,
          status: "computed" as const,
          wallMs: 0,
        },
        groups: [
          {
            group: "g1",
            assembledKey: yield* put("test.finder.fill", assembled),
          },
        ],
      };
      const linked = yield* link(run.base.ctx, {
        frameKey,
        mapKey,
        manifestKey,
        fill: filled,
        setup,
        finders: [result],
      });
      yield* Effect.promise(() =>
        reviewStages(run.services).publish({
          findings: result.findings
            .filter((finding) => finding.status === "kept")
            .map((finding) => finding.id),
          candidates: linked.candidates,
          stages: [...result.stages, filled.record, linked.record],
          sources: {
            manifest: manifestKey,
            changeMap: linked.changeMapKey,
            scope: null,
          },
          strongestStratum: frame.stratum,
          disclosures: linked.disclosures,
        }),
      );
    }),
  );
  return run.services.run(
    Log.history({ cycleId: run.base.ctx.cycleId, limit: 1000 }),
  );
};

test("finder task dedupes before Verify and returns the contract's kept and dropped results", async () => {
  const requests: string[] = [];
  const run = await testWorld("complete", (messages) => {
    const system = messages.find((m) => m.role === "system");
    const text = JSON.stringify(messages);
    requests.push(text);
    if (JSON.stringify(system).includes("Check whether the supplied evidence"))
      return toolReply("submit_verify", {
        decision: text.includes("Secondary claim") ? "drop" : "keep",
        reason: "Compared the claim with its cited lines.",
      });
    return toolReply("submit_find", {
      findings: [
        finding,
        { ...finding, critical: true },
        {
          ...finding,
          claim: "Secondary claim",
          anchors: [{ path: "old.ts", side: "old", startLine: 2, endLine: 2 }],
        },
      ],
      notes: [],
    });
  });
  try {
    const id = await run.start("correctness");
    await run.harness.resume();
    const result = await done(run.harness, id);
    expect(result.lens).toBe("correctness");
    expect(result.findKey).toBeString();
    expect(
      result.findings.map((f) => ({ id: f.id, status: f.status })),
    ).toEqual([
      { id: "correctness.2", status: "kept" },
      { id: "correctness.3", status: "dropped" },
    ]);
    // Reason (round 14, the timeline lane's condition): the finder's status is a new field. A
    // finder that completes says so, and the rest of its result is the shape it had, with its keys
    // the stored steps' own: the find key is its dedupe step's output, each verify key its Verify
    // step's, so no key moved and no stored result changed.
    const { end, ...rest } = result;
    expect(end).toEqual({ find: "completed", verify: "completed" });
    expect(Object.keys(rest)).toEqual([
      "lens",
      "findKey",
      "findings",
      "stages",
      "unused",
    ]);
    expect(rest.findKey).toBe(rest.stages[1]!.key!);
    expect(rest.findings.map((f) => f.verifyKey)).toEqual(
      rest.stages.slice(2).map((s) => s.key ?? null),
    );
    expect(result.findings.every((f) => f.verifyKey !== null)).toBe(true);
    // Why: every returned id must survive dedupe or verification in the capture ledger.
    expect(
      run.captured.filter((event) => event.type === "findings.returned"),
    ).toEqual([
      {
        type: "findings.returned",
        scope: { runId: run.base.ctx.runId, stage: "find" },
        findingIds: ["correctness.1", "correctness.2", "correctness.3"],
      },
    ]);
    expect(
      run.captured.flatMap((event) =>
        event.type === "lead.fate"
          ? [{ id: event.leadId, fate: event.fate, reason: event.reason }]
          : [],
      ),
    ).toEqual([
      { id: "correctness.1", fate: "dropped", reason: "duplicate" },
      { id: "correctness.2", fate: "handed-on", reason: undefined },
      { id: "correctness.3", fate: "dropped", reason: "not-verified" },
    ]);
    // Verify is named by its claim now, in the final list's order; nothing was recorded, so the
    // verify phase asked for both.
    const deduped = await run.services.run(
      storedOutput(run.base.ctx, result.findKey!, FindStored),
    );
    expect(result.stages.map((s) => s.agent)).toEqual([
      "find.correctness",
      "find.correctness.dedupe",
      ...deduped.findings.map((f) =>
        verifyAgentOf(f.lens, claimKeyOf("frame-key", f)),
      ),
    ]);
    expect(requests).toHaveLength(3);
    expect(
      run.base.ctx.log
        .read()
        .filter((r) => r.type === "verify.claims")
        .map(({ type: _type, at: _at, ...counts }) => counts),
    ).toEqual([
      {
        lens: "correctness",
        final: 2,
        askedAtRecord: 0,
        askedAtVerify: 2,
        used: 2,
        unused: 0,
        unusedModelCalls: 0,
      },
    ]);
    expect(
      run.base.ctx.log
        .read()
        .filter((r) => r.type === "finder.result")
        .map((r) => ({
          lens: r["lens"],
          findings: r["findings"],
          kept: r["kept"],
          dropped: r["dropped"],
          unverified: r["unverified"],
        })),
    ).toEqual([
      { lens: "correctness", findings: 2, kept: 1, dropped: 1, unverified: 0 },
    ]);
    expect(
      run.base.ctx.log
        .read()
        .filter((r) => r.type === "finding")
        .map((r) => r["status"]),
    ).toEqual(["kept", "dropped"]);
    const stored = await run.services.run(
      storedOutput(run.base.ctx, result.findKey!, FindStored),
    );
    expect(stored.findings).toHaveLength(2);
    expect(stored.findings[0]?.critical).toBe(true);
    // Why: the production finder-to-Publish handoff must end at the actual Records comment id.
    const linked = await run.services.run(
      Effect.gen(function* () {
        const frameKey = yield* put("test.fate-frame", frame);
        const mapKey = yield* put("test.fate-map", { ...map, frame: frameKey });
        const manifestKey = yield* put("test.fate-manifest", view().manifest);
        const setup = {
          precompute: "unused",
          scopeKey: null,
          refreshKey: null,
          pins: [],
          disclosures: [],
        };
        const filled = yield* fill(run.base.ctx, {
          mapKey,
          manifestKey,
          setup,
        });
        return {
          manifestKey,
          ...(yield* link(run.base.ctx, {
            frameKey,
            mapKey,
            manifestKey,
            fill: filled,
            setup,
            finders: [result],
          })),
        };
      }),
    );
    await reviewStages(run.services).publish({
      findings: result.findings
        .filter((finding) => finding.status === "kept")
        .map((finding) => finding.id),
      candidates: linked.candidates,
      stages: [...result.stages, linked.record],
      sources: {
        manifest: linked.manifestKey,
        changeMap: linked.changeMapKey,
        scope: null,
      },
      strongestStratum: frame.stratum,
      disclosures: linked.disclosures,
    });
    const comments = await run.services.run(
      Log.history({ cycleId: run.base.ctx.cycleId, limit: 1000 }),
    );
    const commentIds = comments.flatMap((row) =>
      row.event.kind === "comment.recorded@2" ? [row.event.id] : [],
    );
    expect(commentIds).toHaveLength(1);
    expect(
      run.captured.filter(
        (event) => event.type === "lead.fate" && event.handoff === "publish",
      ),
    ).toEqual([
      {
        type: "lead.fate",
        scope: { runId: run.base.ctx.runId, stage: "publish" },
        leadId: "correctness.2",
        handoff: "publish",
        fate: "published",
        publicationId: commentIds[0],
      },
    ]);
    const journalPath = join(run.base.ctx.repository, "finding-journal");
    const journal = openCaptureJournal(journalPath, run.base.ctx.runId);
    const scope = { runId: run.base.ctx.runId };
    journal.capture({
      type: "run.start",
      scope,
      runKind: "scored",
      sourceRevision: "fixture",
      route: "chatgpt",
      pricing: "subscription",
    });
    for (const event of run.captured)
      if (event.type === "findings.returned" || event.type === "lead.fate")
        journal.capture(event);
    journal.capture({ type: "run.end", scope, status: "completed" });
    journal.close();
    const dump = await buildDump({ runId: scope.runId, journal: journalPath });
    expect(dump.run.gaps).toEqual([]);
    expect(dump.run.leads.open).toEqual([]);
    expect(dump.run.complete).toBe(true);
  } finally {
    await run.harness.close(context);
  }
});

test("all four lenses share durable declarations while scope-fit enforces its condition verdicts", async () => {
  const run = await testWorld("four-lenses", (messages) => {
    const system = JSON.stringify(messages.find((m) => m.role === "system"));
    return toolReply("submit_find", {
      findings: [],
      notes: [],
      ...(system.includes("Return exactly one condition verdict")
        ? {
            conditions: [
              {
                doneWhen: "D1",
                verdict: "needs-human",
                anchors: [],
                note: "No resolving evidence.",
              },
            ],
          }
        : {}),
    });
  });
  try {
    const ids = await Promise.all(FINDERS.map((l) => run.start(l)));
    await run.harness.resume();
    const results = await Promise.all(ids.map((id) => done(run.harness, id)));
    expect(results.map((r) => r.lens)).toEqual([...FINDERS]);
    expect(results.every((r) => r.findings.length === 0)).toBe(true);
    // Why: counters must reach the real per-finder span, including a finder that opens nothing.
    const readings = run.base.ctx.log
      .read()
      .filter((r) => r.type === "span" && r["name"] === "harness.find.reading");
    const attributes = readings.map((r) =>
      z
        .strictObject({
          "harness.agent": z.string(),
          "harness.find.hunks_opened": z.literal(0),
          "harness.find.files_read": z.literal(0),
          "harness.find.log_calls": z.literal(0),
          "harness.find.opening_chars": z.number().positive(),
          "harness.find.opening_over_limit": z.literal(0),
          "harness.find.opening_frame_chars": z.number().positive(),
          "harness.find.opening_scope_chars": z.literal(0),
          "harness.find.opening_index_chars": z.number().positive(),
          "harness.find.opening_diff_chars": z.number().positive(),
          "harness.find.opening_log_chars": z.number().positive(),
          "harness.find.sections_inlined": z.literal(0),
          "harness.find.sections_listed": z.literal(0),
          "harness.find.files_total": z.literal(1),
          "harness.find.files_named": z.literal(1),
          "harness.find.files_folded": z.literal(0),
          "harness.find.files_diffed": z.literal(1),
          "harness.find.files_cut": z.literal(0),
          "harness.find.hunks_total": z.literal(1),
          "harness.find.hunks_diffed": z.literal(1),
          "harness.find.lines_added_shown": z.literal(1),
          "harness.find.lines_deleted_shown": z.literal(1),
          "harness.find.lines_context_shown": z.literal(2),
          "harness.find.owned_added_shown": z.literal(1),
          "harness.find.owned_deleted_shown": z.literal(1),
          "harness.find.owned_added_total": z.literal(1),
          "harness.find.owned_deleted_total": z.literal(1),
          "harness.find.log_lines_shown": z.literal(0),
          "harness.find.log_lines_total": z.literal(0),
        })
        .parse(r["attributes"]),
    );
    expect(attributes.map((a) => a["harness.agent"]).sort()).toEqual(
      FINDERS.map((l) => `find.${l}`).sort(),
    );
    const found = await run.services.run(
      storedOutput(run.base.ctx, results[0]!.findKey!, FindStored),
    );
    expect(found.conditions).toEqual([
      {
        doneWhen: "D1",
        verdict: "needs-human",
        anchors: [],
        note: "No resolving evidence.",
      },
    ]);
  } finally {
    await run.harness.close(context);
  }
});

for (const abortEarly of [false, true])
  test(`${abortEarly ? "parent abort" : "cut-off"} mid-find retains the tool-recorded finding as unverified without stopCause`, async () => {
    // The recorded finding's Verify starts with the record call; both it and Find's next turn are
    // in flight when the finder stops, so its finding stays unverified as before.
    let calls = 0;
    let verifies = 0;
    let waiting: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    const run = await testWorld(
      abortEarly ? "abort" : "cutoff",
      (messages, signal) => {
        if (
          JSON.stringify(messages.find((m) => m.role === "system")).includes(
            "Check whether the supplied evidence",
          )
        )
          verifies++;
        else calls++;
        if (calls === 1 && verifies === 0)
          return toolReply("record_finding", finding);
        if (calls === 2 && verifies === 1) waiting();
        return new Promise((_resolve, reject) => {
          if (signal?.aborted) reject(signal.reason);
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    );
    try {
      const cutoffAt = Date.now() + (abortEarly ? 60_000 : 1000);
      const id = await run.start("correctness", cutoffAt);
      await run.harness.resume();
      await pending;
      if (!abortEarly)
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, cutoffAt - Date.now())),
        );
      await run.harness.abortTask(id, context);
      const result = await done(run.harness, id);
      expect(result.reason).toBe(abortEarly ? "stopped" : "cutoff");
      // Its Find and its Verify were both interrupted: stopped, or cut at the cut-off.
      const stop = abortEarly ? "stopped" : "cutoff";
      expect(result.end).toEqual({ find: stop, verify: stop });
      expect(calls).toBe(2);
      expect(verifies).toBe(1);
      expect(
        run.base.ctx.log
          .read()
          .filter((r) => r.type === "finder.result")
          .map((r) => r["unverified"]),
      ).toEqual([1]);
      expect(result.stages[0]?.status).toBe("interrupted");
      // The started Verify was stopped while it ran: it keeps its own interrupted record and
      // partial key, as a Verify stopped in the verify phase did before, and the finding stays
      // unverified.
      const verify = interruptedVerify(run, result);
      expect(verify.agent).toBe(verifyAgentOf("correctness", claimOfFixture()));
      expect(result.findings).toEqual([
        {
          id: "correctness.1",
          verifyKey: verify.key ?? null,
          status: "unverified",
        },
      ]);
      expect(
        run.base.ctx.log
          .read()
          .filter((r) => r.type === "span" && r["name"] === CHILD_STARTED_SPAN)
          .map(
            (r) =>
              (r["attributes"] as Record<string, unknown>)["harness.asked_by"],
          ),
      ).toEqual(["record_finding"]);
      const found = await run.services.run(
        storedOutput(run.base.ctx, result.findKey!, FindStored),
      );
      expect(found.findings[0]?.claim).toBe(finding.claim);
      const partials = await run.harness.commit(async (tx) => {
        const page = await tx.scanConversations({}, 32);
        const docs = await Promise.all(
          page.items.map((c) => tx.doc(AgentContextDoc, c.id)),
        );
        return docs.some((p) =>
          JSON.stringify(p.state).includes(finding.claim),
        );
      }, context);
      expect(partials).toBe(true);
    } finally {
      await run.harness.close(context);
    }
  });

test("Find makes eleven turns plus one final generation, then Verify has no lookup tools", async () => {
  let findCalls = 0;
  const run = await testWorld("turn-limit", (messages) => {
    const system = JSON.stringify(messages.find((m) => m.role === "system"));
    if (system.includes("Check whether the supplied evidence"))
      return toolReply("submit_verify", {
        decision: "keep",
        reason: "The cited lines support the claim.",
      });
    findCalls++;
    return findCalls <= 11
      ? toolReply("record_finding", finding)
      : fauxAssistantMessage(
          JSON.stringify({ findings: [finding], notes: [] }),
        );
  });
  try {
    const id = await run.start("correctness");
    await run.harness.resume();
    const result = await done(run.harness, id);
    expect(findCalls).toBe(12);
    const find = [...run.records.values()].find(
      (r) => r.step.spec.stage === "find",
    );
    expect(find?.step.spec.turnLimit).toBe(11);
    expect(
      (
        await run.services.run(
          storedOutput(run.base.ctx, result.findKey!, FindStored),
        )
      ).source,
    ).toBe("final-generation");
    expect(result.findings[0]?.status).toBe("kept");
    const verify = [...run.records.values()].find(
      (r) => r.step.spec.stage === "verify",
    );
    expect(verify?.step.spec.tools).toEqual([]);
  } finally {
    await run.harness.close(context);
  }
});

// Why: tool-recorded work survives an incomplete final submission and reaches Verify once.
test("submission retains omitted recorded findings and dedupes overlaps", async () => {
  let calls = 0;
  let verifies = 0;
  const run = await testWorld("omitted", (messages) => {
    if (
      JSON.stringify(messages.find((m) => m.role === "system")).includes(
        "Check whether the supplied evidence",
      )
    ) {
      verifies++;
      return toolReply("submit_verify", {
        decision: "keep",
        reason: "Evidence supports it.",
      });
    }
    calls++;
    if (calls === 1) return toolReply("record_finding", finding);
    if (calls === 2)
      return toolReply("record_finding", {
        ...finding,
        claim: "Another claim",
        anchors: [{ path: "old.ts", side: "old", startLine: 2, endLine: 2 }],
      });
    return toolReply("submit_find", {
      findings: [{ ...finding, critical: true }],
      notes: [],
    });
  });
  try {
    const id = await run.start("correctness");
    await run.harness.resume();
    const result = await done(run.harness, id);
    expect(result.findings.map((f) => f.status)).toEqual(["kept", "kept"]);
    const stored = await run.services.run(
      storedOutput(run.base.ctx, result.findKey!, FindStored),
    );
    expect(stored.findings.map((f) => f.claim)).toEqual([
      finding.claim,
      "Another claim",
    ]);
    expect(stored.findings[0]?.critical).toBe(true);
    // Why: the submitted critical copy merges with the recorded finding into the same claim (rank
    // and evidence are not what Verify reads), so both record-time Verifies are used and none runs
    // twice.
    expect(verifies).toBe(2);
    expect(
      run.base.ctx.log
        .read()
        .filter((r) => r.type === "verify.claims")
        .map(({ type: _type, at: _at, ...counts }) => counts),
    ).toEqual([
      {
        lens: "correctness",
        final: 2,
        askedAtRecord: 2,
        askedAtVerify: 0,
        used: 2,
        unused: 0,
        unusedModelCalls: 0,
      },
    ]);
  } finally {
    await run.harness.close(context);
  }
});

// Why: failure of the optional file-list read must not fail Find after paid stages.
test("the shared view survives a real Git file-list read failure and Find states the gap", async () => {
  if (process.env["NEUVE_LOG_FAILURE_FIXTURE"] !== "1") {
    const bin = mkdtempSync(join(tmpdir(), "log-failure-bin-"));
    try {
      const executable = Bun.which("git")!;
      const wrapper = join(bin, "git");
      writeFileSync(
        wrapper,
        `#!/bin/sh\nfor arg in "$@"; do\ncase "$arg" in '--format=%x00%H%x00%P%x00%s%x00%B%x00') exit 41;; esac\ndone\nexec '${executable}' "$@"\n`,
      );
      chmodSync(wrapper, 0o755);
      // Bun resolves executables at process startup, so give only this child the failing Git.
      const result = Bun.spawnSync(
        [
          process.execPath,
          "test",
          "--quiet",
          import.meta.path,
          "--test-name-pattern",
          "the shared view survives",
        ],
        {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env["PATH"]}`,
            NEUVE_LOG_FAILURE_FIXTURE: "1",
          },
        },
      );
      expect({
        code: result.exitCode,
        errors: result.stderr.toString(),
      }).toEqual({ code: 0, errors: expect.stringContaining("0 fail") });
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
    return;
  }
  const run = await testWorld("log-read-failure", () =>
    toolReply("submit_find", { findings: [], notes: [] }),
  );
  const repository = run.base.ctx.repository;
  const executable = Bun.which("git")!;
  const git = (...args: string[]) => {
    const result = Bun.spawnSync([executable, "-C", repository, ...args]);
    expect(result.exitCode).toBe(0);
    return result.stdout.toString().trim();
  };
  try {
    git("init", "-q");
    for (const title of ["base", "head"])
      git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--allow-empty",
        "-qm",
        title,
      );
    const headOid = git("rev-parse", "HEAD"),
      baseOid = git("rev-parse", "HEAD^");
    const tree = git("rev-parse", "HEAD^{tree}");
    const manifest = {
      ...view([]).manifest,
      range: {
        baseOid,
        headOid,
        mergeBase: baseOid,
        headTree: tree,
        baseTree: tree,
      },
    };
    const manifestKey = await run.services.run(
      put("test.failure.manifest", manifest),
    );
    const precompute = await run.services.run(
      put("test.failure.precompute", {
        files: [],
        diffBytes: 0,
        manifest: manifestKey,
        scope: null,
        hunks: 0,
        reviewLines: 0,
        strongestStratum: "nothing",
        scopeGaps: [],
      }),
    );
    const stage = stageRun(run.services);
    const range = await stage.view({ precompute }, undefined);
    expect(range.findLog).toBeUndefined();
    expect(range.commits.map((c) => c.subject)).toEqual(["head"]);
    expect(await stage.view({ precompute }, undefined)).toBe(range);
    const step = await run.services.run(
      findStep(run.base.ctx, range, {
        lens: "correctness",
        frame,
        keys: { frame: "frame", manifest: manifestKey },
      }),
    );
    expect(step.spec.task).toContain("Commit file lists unavailable");
    expect(step.spec.task).toContain(`${headOid.slice(0, 8)} head`);
  } finally {
    await run.harness.close(context);
  }
}, 60_000);

// Why: all four lenses must reuse one opening and actually offer the budgeted log tool.
test("shared range renders once for four lenses and offers log within Find", async () => {
  const base = await world("shared-opening");
  let titlesRead = 0;
  const range = {
    ...view(),
    findLog: {
      commits: [
        {
          oid: "a".repeat(40),
          get subject() {
            titlesRead++;
            return "A range title";
          },
          body: "",
        },
      ],
      files: new Map(),
    },
  };
  const steps = [];
  for (const lens of FINDERS)
    steps.push(
      await Effect.runPromise(
        findStep(base.ctx, range, {
          lens,
          frame,
          keys: { frame: "frame", manifest: "manifest" },
        }).pipe(Effect.provide(base.ctx.records)),
      ),
    );
  expect(titlesRead).toBe(1);
  expect(new Set(steps.map((s) => s.spec.task)).size).toBe(1);
  for (const step of steps) {
    // The opening and system text changed; stored Find outputs must use the new prompt version.
    expect(step.opVersion).toBe(5);
    const tool = step.spec.tools.find((t) => t.name === "log");
    expect(tool).toBeDefined();
    const outcome = await Effect.runPromise(
      tool!.handle(tool!.input!.parse({})),
    );
    expect(outcome.text).toContain("aaaaaaaa A range title");
    // The opening counts against the reading budget: a finder starts with it already spent.
    expect(step.spec.state!.save().reading?.used).toBe(
      step.spec.task.length + outcome.text.length,
    );
  }
});

// Why: an abort before the dedupe checkpoint must disclose distinct unverified findings.
test("cutoff between Find and Verify keeps deduped findings and publishes a partial packet", async () => {
  const run = await testWorld(
    "abort-dedupe",
    () =>
      toolReply("submit_find", {
        findings: [finding, { ...finding, critical: true }],
        notes: [],
      }),
    "map",
  );
  try {
    // The phase hook cuts off after Find settles (Map has landed) and before any Verify starts.
    const id = await run.start("correctness");
    await run.harness.resume();
    const result = await done(run.harness, id);
    expect(result.reason).toBe("cutoff");
    // Find completed; its final claim's Verify never started.
    expect(result.end).toEqual({ find: "completed", verify: "skipped" });
    expect(result.findings).toEqual([
      { id: "correctness.2", verifyKey: null, status: "unverified" },
    ]);
    const stored = await run.services.run(
      storedOutput(run.base.ctx, result.findKey!, FindStored),
    );
    expect(stored.findings).toHaveLength(1);
    expect(stored.findings[0]?.critical).toBe(true);
    expect(
      run.captured.flatMap((event) =>
        event.type === "lead.fate"
          ? [{ id: event.leadId, fate: event.fate, reason: event.reason }]
          : [],
      ),
    ).toEqual([
      { id: "correctness.1", fate: "dropped", reason: "duplicate" },
      { id: "correctness.2", fate: "withheld", reason: "unverified" },
    ]);
    const history = await publishFinder(run, result);
    expect(
      history.flatMap((row) =>
        row.event.kind === "packet.published@1"
          ? [row.event.payload.complete]
          : [],
      ),
    ).toEqual([false]);
    expect(
      result.stages.filter((stage) => stage.agent?.startsWith("verify.")),
    ).toEqual([
      {
        stage: "verify",
        agent: verifyAgentOf(
          "correctness",
          claimKeyOf("frame-key", stored.findings[0]!),
        ),
        status: "skipped",
        wallMs: 0,
        disclosure: null,
      },
    ]);
  } finally {
    await run.harness.close(context);
  }
});

// Why: a finder stopped before Find starts never searched its lens, so the packet must be partial.
test("cutoff before Find starts records an interrupted find and publishes a partial packet", async () => {
  let calls = 0;
  const run = await testWorld(
    "abort-find",
    () => {
      calls++;
      return toolReply("submit_find", { findings: [finding], notes: [] });
    },
    "find",
  );
  try {
    const id = await run.start("correctness");
    await run.harness.resume();
    const result = await done(run.harness, id);
    expect(calls).toBe(0);
    expect(result.reason).toBe("cutoff");
    expect(result.end).toEqual({ find: "cutoff", verify: "completed" });
    expect(result.findings).toEqual([]);
    expect(result.stages).toEqual([
      {
        stage: "find",
        agent: "find.correctness",
        status: "interrupted",
        wallMs: 0,
        disclosure: null,
      },
    ]);
    const history = await publishFinder(run, result);
    expect(
      history.flatMap((row) =>
        row.event.kind === "packet.published@1"
          ? [row.event.payload.complete]
          : [],
      ),
    ).toEqual([false]);
  } finally {
    await run.harness.close(context);
  }
});

// Why: exhausting Verify's backstop settles the search but cannot publish an unchecked finding.
test("a backstop-unverified finding leaves the packet complete without a comment", async () => {
  const run = await testWorld("verify-backstop", (messages) =>
    JSON.stringify(
      messages.find((message) => message.role === "system"),
    ).includes("Check whether the supplied evidence")
      ? fauxAssistantMessage("No usable verification result.")
      : toolReply("submit_find", { findings: [finding], notes: [] }),
  );
  try {
    const id = await run.start("correctness");
    await run.harness.resume();
    const result = await done(run.harness, id);
    expect(result.reason).toBeUndefined();
    // A backstop is an end: the Verify completed, unchecked.
    expect(result.end).toEqual({ find: "completed", verify: "completed" });
    expect(result.findings).toEqual([
      {
        id: "correctness.1",
        verifyKey: expect.any(String),
        status: "unverified",
      },
    ]);
    const verify = await run.services.run(
      storedOutput(run.base.ctx, result.findings[0]!.verifyKey!, VerifyStored),
    );
    expect(verify.source).toBe("backstop");
    const history = await publishFinder(run, result);
    expect(
      history.flatMap((row) =>
        row.event.kind === "packet.published@1"
          ? [row.event.payload.complete]
          : [],
      ),
    ).toEqual([true]);
    expect(
      history.filter((row) => row.event.kind === "comment.recorded@2"),
    ).toHaveLength(0);
    expect(
      history.some(
        (row) =>
          row.event.kind === "gap.disclosed@1" &&
          row.event.payload.kind === "findings-unverified",
      ),
    ).toBe(true);
  } finally {
    await run.harness.close(context);
  }
});

// Why: distinct findings beyond the post-dedupe cap need their own fixed fate reason.
test("findings past the five-finding cap are dropped as over-cap", async () => {
  let calls = 0;
  const run = await testWorld(
    "over-cap",
    (messages) => {
      if (
        JSON.stringify(
          messages.find((message) => message.role === "system"),
        ).includes("Check whether the supplied evidence")
      )
        return toolReply("submit_verify", {
          decision: "drop",
          reason: "The evidence does not support the claim.",
        });
      calls++;
      return calls <= 5
        ? toolReply("record_finding", {
            ...finding,
            claim: `Claim ${calls}`,
            anchors: [
              {
                path: "new.ts",
                side: "new",
                startLine: calls + 1,
                endLine: calls + 1,
              },
            ],
          })
        : toolReply("submit_find", {
            findings: [
              {
                ...finding,
                claim: "Final claim",
                anchors: [
                  { path: "new.ts", side: "new", startLine: 7, endLine: 7 },
                ],
              },
            ],
            notes: [],
          });
    },
    false,
    view([
      { ...hunk, ownedRanges: [{ side: "new", startLine: 2, lineCount: 6 }] },
    ]),
  );
  try {
    const id = await run.start("correctness");
    await run.harness.resume();
    const result = await done(run.harness, id);
    expect(result.findings).toHaveLength(5);
    expect(
      run.captured.flatMap((event) =>
        event.type === "lead.fate" && event.reason === "over-cap"
          ? [{ id: event.leadId, fate: event.fate, reason: event.reason }]
          : [],
      ),
    ).toEqual([{ id: "correctness.6", fate: "dropped", reason: "over-cap" }]);
    expect(
      run.captured.filter(
        (event) => event.type === "lead.fate" && event.reason === "duplicate",
      ),
    ).toHaveLength(0);
    // Why: the over-cap claim was verified when it was recorded; that Verify is listed apart as
    // unused, stays out of the stage records, gives no verdict, and its model call is counted.
    const unused = result.unused ?? [];
    expect(unused).toHaveLength(1);
    expect(unused[0]?.status).toBe("computed");
    expect(unused[0]?.key).toBeString();
    expect(unusedOutOfStages(result)).toBe(true);
    expect(result.findings.every((f) => f.verifyKey !== unused[0]?.key)).toBe(
      true,
    );
    expect(
      run.base.ctx.log
        .read()
        .filter((r) => r.type === "verify.claims")
        .map(({ type: _type, at: _at, ...counts }) => counts),
    ).toEqual([
      {
        lens: "correctness",
        final: 5,
        askedAtRecord: 5,
        askedAtVerify: 1,
        used: 5,
        unused: 1,
        unusedModelCalls: 1,
      },
    ]);
  } finally {
    await run.harness.close(context);
  }
});

const isVerifyRequest = (messages: ReadonlyArray<Message>) =>
  JSON.stringify(messages.find((m) => m.role === "system")).includes(
    "Check whether the supplied evidence",
  );
const keep = () =>
  toolReply("submit_verify", {
    decision: "keep",
    reason: "The cited lines support the claim.",
  });
/** The fixture finding's Verify among its finder's children. */
const verifyNameOf = (f: typeof finding) =>
  verifyChildName(
    claimKeyOf("frame-key", { ...f, lens: "correctness", hunkId: "h1" }),
  );
const childrenOf = async (harness: Harness, id: TaskId) =>
  (await harness.snapshot(ChildrenDoc, id, context))?.children ?? {};
const claimCounts = (run: Awaited<ReturnType<typeof testWorld>>) =>
  run.base.ctx.log
    .read()
    .filter((r) => r.type === "verify.claims")
    .map(({ type: _type, at: _at, ...counts }) => counts);
/** The finder's children held one Verify, started by a record call and used. */
const ONE_RECORDED_CLAIM = [
  {
    lens: "correctness",
    final: 1,
    askedAtRecord: 1,
    askedAtVerify: 0,
    used: 1,
    unused: 0,
    unusedModelCalls: 0,
  },
];
const childSpans = (run: Awaited<ReturnType<typeof testWorld>>) =>
  run.base.ctx.log
    .read()
    .filter((r) => r.type === "span" && r["name"] === CHILD_STARTED_SPAN)
    .map((r) => r["attributes"] as Record<string, unknown>);

// Why: the point of the change. A recorded finding's Verify must run while Find still runs, as the
// finder's child (so the finder waits for it and its abort stops it), and the finder must then use
// it: one Verify call, and the same result as a finder that only submitted the finding.
test("a recorded finding's Verify starts before Find ends, owned by the finder, and is the one its result uses", async () => {
  let verifyStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    verifyStarted = resolve;
  });
  let proceed: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    proceed = resolve;
  });
  let calls = 0;
  let verifies = 0;
  const recording = await testWorld("record-time", async (messages) => {
    if (isVerifyRequest(messages)) {
      verifies++;
      verifyStarted();
      return keep();
    }
    calls++;
    if (calls === 1) return toolReply("record_finding", finding);
    // Find's next turn waits until the test has seen the Verify running.
    await released;
    return toolReply("submit_find", { findings: [finding], notes: [] });
  });
  let submittedVerifies = 0;
  const submitting = await testWorld("submit-only", (messages) => {
    if (isVerifyRequest(messages)) {
      submittedVerifies++;
      return keep();
    }
    return toolReply("submit_find", { findings: [finding], notes: [] });
  });
  try {
    const id = await recording.start("correctness");
    await recording.harness.resume();
    await started;
    const children = await childrenOf(recording.harness, id);
    const verifyId = children[verifyNameOf(finding)];
    expect(verifyId).toBeNumber();
    expect(
      (await recording.harness.getTask(childId(children["find"]!), context))
        ?.state.status,
    ).not.toBe("terminal");
    expect(
      (await recording.harness.getTask(childId(verifyId!), context))?.owner,
    ).toBe(id);
    proceed();
    const result = await done(recording.harness, id);

    const other = await submitting.start("correctness");
    await submitting.harness.resume();
    const expected = await done(submitting.harness, other);

    expect(calls).toBe(2);
    expect(verifies).toBe(1);
    expect(submittedVerifies).toBe(1);
    expect(result.findings).toEqual(expected.findings);
    expect(result.findings.map((f) => f.status)).toEqual(["kept"]);
    const shape = (stages: ReadonlyArray<StageRecord>) =>
      stages
        .filter((stage) => stage.stage === "verify")
        .map(({ stage, agent, status, key, note }) => ({
          stage,
          agent,
          status,
          key,
          note,
        }));
    expect(shape(result.stages)).toEqual(shape(expected.stages));
    const verdict = (run: typeof recording, key: string) =>
      run.services.run(storedOutput(run.base.ctx, key, VerifyStored));
    expect(await verdict(recording, result.findings[0]!.verifyKey!)).toEqual(
      await verdict(submitting, expected.findings[0]!.verifyKey!),
    );
    expect(childSpans(recording).map((a) => a["harness.asked_by"])).toEqual([
      "record_finding",
    ]);
    expect(childSpans(submitting).map((a) => a["harness.asked_by"])).toEqual([
      "verify-phase",
    ]);
    expect(
      recording.base.ctx.log
        .read()
        .filter((r) => r.type === "finding")
        .map((r) => ({ claim: r["claim"], asked: r["asked"] })),
    ).toEqual([
      {
        claim: claimKeyOf("frame-key", {
          ...finding,
          lens: "correctness",
          hunkId: "h1",
        }),
        asked: "record_finding",
      },
    ]);
    expect(claimCounts(recording)).toEqual(ONE_RECORDED_CLAIM);
  } finally {
    proceed();
    await recording.harness.close(context);
    await submitting.harness.close(context);
  }
});

// Why: one run per claim (record 0016). A second record of the same claim, with another rank, must
// find the Verify the first started.
test("the same claim recorded twice starts one Verify", async () => {
  let calls = 0;
  let verifies = 0;
  const run = await testWorld("recorded-twice", (messages) => {
    if (isVerifyRequest(messages)) {
      verifies++;
      return keep();
    }
    calls++;
    if (calls === 1) return toolReply("record_finding", finding);
    if (calls === 2)
      return toolReply("record_finding", { ...finding, critical: true });
    return toolReply("submit_find", { findings: [finding], notes: [] });
  });
  try {
    const id = await run.start("correctness");
    await run.harness.resume();
    const result = await done(run.harness, id);
    expect(verifies).toBe(1);
    expect(childSpans(run).map((a) => a["harness.child"])).toEqual([
      verifyNameOf(finding),
    ]);
    expect(claimCounts(run)).toEqual(ONE_RECORDED_CLAIM);
    expect(result.findings.map((f) => f.status)).toEqual(["kept"]);
  } finally {
    await run.harness.close(context);
  }
});

// Why: exactly once across a crash. The record call is cut off after pi committed its intent and
// before its answer; the reopened process reruns the call, which starts the one Verify then.
test("a record call rerun after a restart starts one Verify", async () => {
  let calls = 0;
  let verifies = 0;
  let armed = false;
  let cut: () => void = () => {};
  const interrupted = new Promise<void>((resolve) => {
    cut = resolve;
  });
  const run = await testWorld(
    "record-replay",
    (messages) => {
      if (isVerifyRequest(messages)) {
        verifies++;
        return keep();
      }
      calls++;
      if (calls === 1) {
        armed = true;
        return toolReply("record_finding", finding);
      }
      return toolReply("submit_find", { findings: [finding], notes: [] });
    },
    false,
    view(),
    {
      // The record call resolves its agent first: hold it there until the process closes.
      preparing: async (input, c) => {
        if (!armed || input.kind !== "find") return;
        armed = false;
        cut();
        await new Promise<void>((_resolve, reject) => {
          const signal = c.abortSignal;
          if (signal === undefined) return;
          if (signal.aborted) reject(signal.reason);
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    },
  );
  let second: Awaited<ReturnType<typeof run.reopen>> | undefined;
  try {
    const id = await run.start("correctness");
    await run.harness.resume();
    await interrupted;
    second = await run.reopen();
    const recordCalls = () =>
      run.base.ctx.log
        .read()
        .filter(
          (r) => r.type === "tool.call" && r["tool"] === "record_finding",
        );
    // The first process never ran the call's handler, so it started nothing.
    expect(recordCalls()).toHaveLength(0);
    expect(childSpans(run)).toHaveLength(0);
    await second.harness.resume();
    const result = await done(second.harness, id);
    expect(recordCalls()).toHaveLength(1);
    expect(calls).toBe(2);
    expect(verifies).toBe(1);
    expect(childSpans(run).map((a) => a["harness.asked_by"])).toEqual([
      "record_finding",
    ]);
    expect(claimCounts(run)).toEqual(ONE_RECORDED_CLAIM);
    expect(result.findings.map((f) => f.status)).toEqual(["kept"]);
  } finally {
    await (second?.harness ?? run.harness).close(context);
  }
}, 30_000);

// Why: the final list decides. Two recorded findings whose primary anchors overlap merge into one
// with both anchors, which neither record-time Verify read: it gets its own Verify, and the two
// are listed as not used and give no verdict.
test("overlapping recorded findings merge into one verified at the end; their own Verifies are unused", async () => {
  let calls = 0;
  const asked: string[] = [];
  // The first cites a second anchor; the second ranks higher, so dedupe keeps its claim and adds
  // the first's anchor: a claim neither record-time Verify read.
  const first = {
    ...finding,
    anchors: [
      ...finding.anchors,
      { path: "old.ts", side: "old" as const, startLine: 2, endLine: 2 },
    ],
  };
  const second = {
    ...finding,
    claim: "The writer accepts the same invalid input",
    critical: true,
  };
  const run = await testWorld("merged", (messages) => {
    if (isVerifyRequest(messages)) {
      const text = JSON.stringify(messages);
      asked.push(text);
      // Only the merged claim, the second's claim with the first's anchor, is kept.
      return toolReply("submit_verify", {
        decision:
          text.includes(second.claim) && text.includes("old.ts (old)")
            ? "keep"
            : "drop",
        reason: "Compared the claim with its cited lines.",
      });
    }
    calls++;
    if (calls === 1) return toolReply("record_finding", first);
    if (calls === 2) return toolReply("record_finding", second);
    return toolReply("submit_find", { findings: [first, second], notes: [] });
  });
  try {
    const id = await run.start("correctness");
    await run.harness.resume();
    const result = await done(run.harness, id);
    const stored = await run.services.run(
      storedOutput(run.base.ctx, result.findKey!, FindStored),
    );
    expect(stored.findings).toHaveLength(1);
    expect(stored.findings[0]?.claim).toBe(second.claim);
    expect(stored.findings[0]?.anchors).toEqual(first.anchors);
    expect(asked).toHaveLength(3);
    expect(result.findings.map((f) => f.status)).toEqual(["kept"]);
    const unused = result.unused ?? [];
    expect(unused.map((verify) => verify.claim).sort()).toEqual(
      [claimOfFixture(first), claimOfFixture(second)].sort(),
    );
    expect(unused.map((verify) => verify.status)).toEqual([
      "computed",
      "computed",
    ]);
    expect(unusedOutOfStages(result)).toBe(true);
    expect(
      unused.every((verify) =>
        result.findings.every((f) => f.verifyKey !== verify.key),
      ),
    ).toBe(true);
    expect(
      run.base.ctx.log
        .read()
        .filter((r) => r.type === "verify.claims")
        .map(({ type: _type, at: _at, ...counts }) => counts),
    ).toEqual([
      {
        lens: "correctness",
        final: 1,
        askedAtRecord: 2,
        askedAtVerify: 1,
        used: 1,
        unused: 2,
        unusedModelCalls: 2,
      },
    ]);
  } finally {
    await run.harness.close(context);
  }
});

// Why: the stage-output lines (the CLI's) must not show an unused Verify's decision as a verdict.
// Two recorded findings merge, as above; the run's Frame is recorded as Front records it, under the
// finder's frame key.
test("stage-output lines show a Verify the final list did not use as not used", async () => {
  const { first, second } = mergedPair();
  const frameKey = "f".repeat(64);
  let calls = 0;
  const run = await testWorld(
    "stage-lines",
    (messages) => {
      if (isVerifyRequest(messages)) return keep();
      calls++;
      if (calls === 1) return toolReply("record_finding", first);
      if (calls === 2) return toolReply("record_finding", second);
      return toolReply("submit_find", {
        findings: [first, second],
        notes: [],
      });
    },
    false,
    view(),
    { frameKey },
  );
  try {
    const id = await run.start("correctness");
    await run.harness.resume();
    const result = await done(run.harness, id);
    const stored = await run.services.run(
      storedOutput(run.base.ctx, result.findKey!, FindStored),
    );
    const agentOf = (claim: string) => verifyAgentOf("correctness", claim);
    // Fail open: with no Frame recorded, no claim key of the final list can be formed, so no
    // Verify of the lens matches it, and every decision prints as a verdict, as before.
    const unmatched = await run.services.run(
      runStageOutputs(run.base.ctx.runId),
    );
    expect(
      unmatched.lines.filter((line) => line.startsWith("verify.")).sort(),
    ).toEqual(
      [
        `${agentOf(claimKeyOf(frameKey, stored.findings[0]!))}: keep.`,
        `${agentOf(claimOfFixture(first, frameKey))}: keep.`,
        `${agentOf(claimOfFixture(second, frameKey))}: keep.`,
      ].sort(),
    );
    await run.services.run(
      recordStage(run.base.ctx, {
        stage: "frame",
        agent: "frame",
        status: "computed",
        key: frameKey,
        wallMs: 0,
      }),
    );
    const outputs = await run.services.run(runStageOutputs(run.base.ctx.runId));
    expect(
      outputs.lines.filter((line) => line.startsWith("verify.")).sort(),
    ).toEqual(
      [
        `${agentOf(claimKeyOf(frameKey, stored.findings[0]!))}: keep.`,
        `${agentOf(claimOfFixture(first, frameKey))}: not used; its claim is not in the finder's final list.`,
        `${agentOf(claimOfFixture(second, frameKey))}: not used; its claim is not in the finder's final list.`,
      ].sort(),
    );
    // Find's own output has no groups; one stored before they moved to dedupe has a group per
    // finding. Both shapes print their count.
    await run.services.run(
      codeStage(
        run.base.ctx,
        "find",
        { op: "test.find.grouped", opVersion: 1, inputs: {} },
        Effect.succeed({
          lens: "tests",
          source: "agent",
          findings: [
            {
              ...finding,
              id: "tests.1",
              lens: "tests",
              hunkId: "h1",
              group: "g1",
            },
          ],
          notes: [],
          reading: { used: 0, limit: 200_000 },
        }),
        { agent: "find.tests" },
      ),
    );
    const both = await run.services.run(runStageOutputs(run.base.ctx.runId));
    expect(both.lines).toContain("find.tests: 1 findings.");
    expect(
      both.lines.filter((line) =>
        /^find\.correctness: \d+ findings\.$/.test(line),
      ),
    ).toHaveLength(1);
  } finally {
    await run.harness.close(context);
  }
});

// Why: Verify may outlive Find. A Verify still running when Find ends at its deadline belongs to
// the finder, finishes inside the verify reserve and is used.
test("a Verify still running when Find hits its deadline finishes and is used", async () => {
  let calls = 0;
  let verifies = 0;
  let verifyStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    verifyStarted = resolve;
  });
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = await testWorld("deadline", async (messages) => {
    if (isVerifyRequest(messages)) {
      verifies++;
      verifyStarted();
      // Answers only once the test has seen Find end.
      await released;
      return keep();
    }
    calls++;
    if (calls === 1) return toolReply("record_finding", finding);
    // The final generation after the deadline: Find ends with what it recorded.
    return fauxAssistantMessage(
      JSON.stringify({ findings: [finding], notes: [] }),
    );
  });
  try {
    // Find's deadline passes before its second turn.
    const id = await run.start("correctness", Date.now() + 60_000, Date.now());
    await run.harness.resume();
    await started;
    const children = await childrenOf(run.harness, id);
    const findEnd = await run.harness.waitForTask(
      childId<StageRecord>(children["find"]!),
      context,
    );
    expect(findEnd.state.outcome.status).toBe("completed");
    expect(
      (
        await run.harness.getTask(
          childId(children[verifyNameOf(finding)]!),
          context,
        )
      )?.state.status,
    ).not.toBe("terminal");
    release();
    const result = await done(run.harness, id);
    const find = result.stages.find((stage) => stage.stage === "find");
    expect(find?.agentResult?.endedBy).toBe("timeout");
    expect(calls).toBe(2);
    expect(verifies).toBe(1);
    expect(result.reason).toBeUndefined();
    expect(result.findings.map((f) => f.status)).toEqual(["kept"]);
    expect(childSpans(run).map((a) => a["harness.asked_by"])).toEqual([
      "record_finding",
    ]);
  } finally {
    release();
    await run.harness.close(context);
  }
});

// Why: the finder's checkpoint and child names changed. A finder a previous build left mid-run must
// not resume into the new shape: it is blocked, and stopping it settles it as orphaned.
test("a finder from the previous version never resumes into this one", async () => {
  let calls = 0;
  const run = await testWorld(
    "upgrade",
    () => {
      calls++;
      return toolReply("submit_find", { findings: [finding], notes: [] });
    },
    false,
    view(),
    { finderVersion: 2 },
  );
  const id = await run.start("correctness");
  const next = await run.reopen();
  try {
    await next.harness.resume();
    const inspection = await next.harness.inspect(context);
    expect(
      inspection.tasks.find((task) => task.record.kind === "neuve.finder")
        ?.state,
    ).toMatchObject({ kind: "blocked", reason: "migration_failed" });
    await next.harness.abortTask(id, context);
    expect(
      (await next.harness.waitForTask(id, context)).state.outcome.status,
    ).toBe("orphaned");
    expect(calls).toBe(0);
  } finally {
    await next.harness.close(context);
  }
});

/** A Verify answer that never comes: it ends only when its step is stopped or cut off. */
const hang = (signal: AbortSignal | undefined) =>
  new Promise<AssistantMessage>((_resolve, reject) => {
    if (signal?.aborted) reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
const spansNamed = (run: Awaited<ReturnType<typeof testWorld>>, name: string) =>
  run.base.ctx.log
    .read()
    .filter((r) => r.type === "span" && r["name"] === name)
    .map((r) => r["attributes"] as Record<string, unknown>);

// Why: the base behaviour for a Verify stopped or cut off while it runs in the verify phase. It
// keeps its own interrupted record and partial key, so the receipt matches the run log and the
// run's end reads as cut off.
for (const stop of [false, true])
  test(`${stop ? "a stop" : "the cut-off"} during the verify phase keeps the running Verify's own record`, async () => {
    let started: () => void = () => {};
    const verifying = new Promise<void>((resolve) => {
      started = resolve;
    });
    const run = await testWorld(
      stop ? "verify-stop" : "verify-cutoff",
      (messages, signal) => {
        if (!isVerifyRequest(messages))
          return toolReply("submit_find", { findings: [finding], notes: [] });
        started();
        return hang(signal);
      },
    );
    try {
      const id = await run.start(
        "correctness",
        Date.now() + (stop ? 60_000 : 1_500),
      );
      await run.harness.resume();
      await verifying;
      if (stop) await run.harness.abortTask(id, context);
      const result = await done(run.harness, id);
      expect(result.reason).toBe(stop ? "stopped" : "cutoff");
      const verify = interruptedVerify(run, result);
      expect(verify.key).toBeString();
      expect(verify.note).toBeString();
      expect(result.findings).toEqual([
        {
          id: "correctness.1",
          verifyKey: verify.key ?? null,
          status: "unverified",
        },
      ]);
      expect(result.unused).toEqual([]);
    } finally {
      await run.harness.close(context);
    }
  });

/** Fails the agent preparation of the Verify of one claim, as a fault in that step does. */
const failingVerify = (claimKey: string) => async (input: AgentStepInput) => {
  if (input.kind !== "verify") return;
  const p = KindParams.verify.parse(input.params);
  if (claimKeyOf(p.frame, p.finding) === claimKey)
    throw new Error("the Verify step broke");
};

// Why: only a used Verify decides the finder. A used one that fails fails the finder, as before;
// an unused one would not have run before, so its failure is listed and changes nothing.
test("a failed used Verify fails the finder", async () => {
  const run = await testWorld(
    "used-verify-fails",
    (messages) =>
      isVerifyRequest(messages)
        ? keep()
        : toolReply("submit_find", { findings: [finding], notes: [] }),
    false,
    view(),
    { preparing: failingVerify(claimOfFixture()) },
  );
  try {
    const id = await run.start("correctness");
    await run.harness.resume();
    const settled = await run.harness.waitForTask(id, context);
    expect(settled.state.outcome.status).toBe("failed");
  } finally {
    await run.harness.close(context);
  }
});

const mergedPair = () => {
  const first = {
    ...finding,
    anchors: [
      ...finding.anchors,
      { path: "old.ts", side: "old" as const, startLine: 2, endLine: 2 },
    ],
  };
  const second = {
    ...finding,
    claim: "The writer accepts the same invalid input",
    critical: true,
  };
  return { first, second };
};

test("a failed unused Verify leaves the finder's result as it would be", async () => {
  const { first, second } = mergedPair();
  let calls = 0;
  const run = await testWorld(
    "unused-verify-fails",
    (messages) => {
      if (isVerifyRequest(messages)) return keep();
      calls++;
      if (calls === 1) return toolReply("record_finding", first);
      return toolReply("submit_find", { findings: [first, second], notes: [] });
    },
    false,
    view(),
    { preparing: failingVerify(claimOfFixture(first)) },
  );
  try {
    const id = await run.start("correctness");
    await run.harness.resume();
    const result = await done(run.harness, id);
    expect(result.reason).toBeUndefined();
    expect(result.findings.map((f) => f.status)).toEqual(["kept"]);
    expect(result.unused).toEqual([
      {
        claim: claimOfFixture(first),
        agent: null,
        status: expect.stringMatching(/^(failed|faulted)$/),
        key: null,
      },
    ]);
    expect(unusedOutOfStages(result)).toBe(true);
  } finally {
    await run.harness.close(context);
  }
});

/** Resolves once the task's committed state is in `phase` (pi's task graph, no polling). */
const phaseReached = async (harness: Harness, id: TaskId, phase: string) => {
  const graph = await harness.taskGraph(context);
  try {
    await new Promise<void>((resolve) => {
      const reached = (value: TaskGraph) => {
        const state = value.tasks[String(id)]?.state;
        return state !== undefined && "phase" in state && state.phase === phase;
      };
      if (reached(graph.value)) return resolve();
      const stop = graph.subscribe((value) => {
        if (!reached(value)) return;
        stop();
        resolve();
      });
    });
  } finally {
    graph.dispose();
  }
};
/** The finder's waits, as `harness.pi.wait` spans name them. */
const finderWaits = (run: Awaited<ReturnType<typeof testWorld>>) =>
  spansNamed(run, "harness.pi.wait").filter(
    (a) => a["harness.task_kind"] === "finder",
  );
/**
 * A finder whose record-time Verify is merged away by dedupe and still runs, unanswered, while the
 * finder's own Verify of the merged claim finishes. The test ends that unused Verify itself once
 * the finder is waiting for it alone (`settle`), so nothing depends on timing.
 */
const unusedStillRunning = async (name: string, cutOffAtSettle: boolean) => {
  const { first, second } = mergedPair();
  let calls = 0;
  const run = await testWorld(
    name,
    (messages, signal) => {
      if (isVerifyRequest(messages))
        return JSON.stringify(messages).includes(second.claim)
          ? keep()
          : hang(signal);
      calls++;
      if (calls === 1) return toolReply("record_finding", first);
      return toolReply("submit_find", {
        findings: [first, second],
        notes: [],
      });
    },
    cutOffAtSettle ? "settle" : false,
  );
  const id = await run.start("correctness");
  await run.harness.resume();
  await phaseReached(run.harness, id, "settle");
  const unusedId = (await childrenOf(run.harness, id))[
    verifyChildName(claimOfFixture(first))
  ];
  expect(unusedId).toBeNumber();
  await run.harness.abortTask(childId(unusedId!), context);
  const result = await done(run.harness, id);
  return { run, id, result, first, second };
};

// Why: an unused Verify still running when the verify phase starts is waited for after the
// reason is decided, and its interrupted end decides nothing: every used Verify finished, so the
// finder has no reason, no interrupted stage reaches the records that mark a packet partial or a
// run cut off, and the finder's waits say what each waited for.
test("an unused Verify still running at the verify phase, then interrupted, changes nothing", async () => {
  const { run, id, result, first } = await unusedStillRunning(
    "unused-running",
    false,
  );
  try {
    expect(
      (await run.harness.waitForTask(id, context)).state.outcome.status,
    ).toBe("completed");
    expect(result.reason).toBeUndefined();
    expect(result.findings.map((f) => f.status)).toEqual(["kept"]);
    expect(result.stages.some((s) => s.status === "interrupted")).toBe(false);
    expect(result.unused).toEqual([
      {
        claim: claimOfFixture(first),
        agent: verifyAgentOf("correctness", claimOfFixture(first)),
        status: "interrupted",
        key: expect.any(String),
      },
    ]);
    expect(unusedOutOfStages(result)).toBe(true);
    const merged = childSpans(run).find(
      (a) => a["harness.asked_by"] === "verify-phase",
    );
    const unusedId = childSpans(run).find(
      (a) => a["harness.asked_by"] === "record_finding",
    )?.["harness.task_id"];
    const waits = finderWaits(run);
    expect(waits.map((a) => a["harness.waiting_on"])).toEqual([
      "find",
      "verify",
      "unused-verify",
    ]);
    expect(waits[1]).toMatchObject({
      "harness.task_id": id,
      "harness.lens": "correctness",
      "harness.next_phase": "done",
      "harness.waiting_on_ids": String(merged?.["harness.task_id"]),
      "harness.verify.final": 1,
      "harness.verify.asked_at_record": 0,
      "harness.verify.asked_at_verify": 1,
      "harness.verify.unused": 1,
      "harness.verify.waiting": 1,
      "harness.verify.settled": 0,
      "harness.verify.unused_running": 1,
    });
    expect(waits[2]).toMatchObject({
      "harness.next_phase": "settle",
      "harness.waiting_on_ids": String(unusedId),
      "harness.verify.unused_running": 1,
    });
  } finally {
    await run.harness.close(context);
  }
});

// Why: the report's timings are read from these records and nothing else pins them. One finder
// with one record-time Verify and one verify-phase Verify: each phase-end commit, each wait with
// what it waited on, and each child's inputs, joined with the moment its finding was recorded.
test("the run log names the finder's commits, its waits and every child's inputs", async () => {
  const other = {
    ...finding,
    claim: "Old input is still accepted",
    anchors: [
      { path: "old.ts", side: "old" as const, startLine: 2, endLine: 2 },
    ],
  };
  let calls = 0;
  let otherStarted: () => void = () => {};
  const otherAsked = new Promise<void>((resolve) => {
    otherStarted = resolve;
  });
  const run = await testWorld("finder-telemetry", async (messages) => {
    if (isVerifyRequest(messages)) {
      // The recorded finding's Verify answers only once the verify phase has started the other,
      // so the verify phase waits for both.
      if (JSON.stringify(messages).includes(other.claim)) otherStarted();
      else await otherAsked;
      return keep();
    }
    calls++;
    if (calls === 1) return toolReply("record_finding", finding);
    return toolReply("submit_find", { findings: [finding, other], notes: [] });
  });
  try {
    const id = await run.start("correctness");
    await run.harness.resume();
    const result = await done(run.harness, id);
    expect(result.findings.map((f) => f.status)).toEqual(["kept", "kept"]);
    const records = run.base.ctx.log.read();
    const commits = spansNamed(run, "harness.pi.commit").filter(
      (a) => a["harness.task_kind"] === "finder",
    );
    expect(
      commits.map((a) => [a["harness.phase"], a["harness.next_phase"]]),
    ).toEqual([
      // Map had landed when Find ended, so the finder went from the map phase straight on.
      ["find", "map"],
      ["map", "verify"],
      ["verify", "done"],
      ["done", "terminal"],
    ]);
    for (const commit of commits)
      expect(commit).toMatchObject({
        "harness.task_id": id,
        "harness.lens": "correctness",
      });
    const inputs = records.filter(
      (r) => r.type === "task.inputs" && r["owner"] === id,
    );
    const findTask = inputs.find((r) => r["kind"] === "find");
    expect(findTask?.["inputs"]).toEqual({
      frame: "computation:frame-key",
      manifest: "computation:manifest-key",
    });
    const recorded = inputs.find((r) => r["askedBy"] === "record_finding");
    const asked = inputs.find((r) => r["askedBy"] === "verify-phase");
    expect(recorded).toMatchObject({
      kind: "verify",
      child: verifyNameOf(finding),
      inputs: { frame: "computation:frame-key" },
      callId: expect.any(String),
    });
    expect(asked).toMatchObject({
      kind: "verify",
      child: verifyNameOf(other),
      inputs: {
        frame: "computation:frame-key",
        find: `computation:${result.findKey}`,
      },
    });
    // The record-time Verify joins its record call: the call's row names the child it asked for,
    // and the child's start span names the same task.
    expect(
      records.filter(
        (r) => r.type === "tool.call" && r["child"] === recorded?.["child"],
      ),
    ).toHaveLength(1);
    expect(
      childSpans(run).map((a) => [a["harness.child"], a["harness.task_id"]]),
    ).toEqual([
      [recorded?.["child"], recorded?.["taskId"]],
      [asked?.["child"], asked?.["taskId"]],
    ]);
    const waits = finderWaits(run);
    expect(waits.map((a) => a["harness.waiting_on"])).toEqual([
      "find",
      "verify",
    ]);
    expect(waits[0]?.["harness.waiting_on_ids"]).toBe(
      String(findTask?.["taskId"]),
    );
    expect(waits[1]).toMatchObject({
      "harness.next_phase": "done",
      "harness.waiting_on_ids": [recorded?.["taskId"], asked?.["taskId"]]
        .map(Number)
        .sort((a, b) => a - b)
        .join(","),
      "harness.verify.final": 2,
      "harness.verify.asked_at_record": 1,
      "harness.verify.asked_at_verify": 1,
      "harness.verify.unused": 0,
      "harness.verify.waiting": 2,
      "harness.verify.settled": 0,
      "harness.verify.unused_running": 0,
    });
    // Every wait ended where the finder's next phase started.
    expect(
      records.filter(
        (r) =>
          r.type === "span.start" &&
          r["name"] === "harness.pi.wait" &&
          (r["attributes"] as Record<string, unknown>)["harness.task_kind"] ===
            "finder",
      ),
    ).toHaveLength(waits.length);
  } finally {
    await run.harness.close(context);
  }
});

// Why: a cut-off that reaches the finder while it waits for an unused Verify alone keeps the
// reason decided when the used Verifies ended: none.
test("a cut-off reaching the finder while it waits only for an unused Verify keeps its reason", async () => {
  const { run, id, result } = await unusedStillRunning("unused-cutoff", true);
  try {
    expect(
      (await run.harness.waitForTask(id, context)).state.outcome.status,
    ).toBe("aborted");
    expect(result.reason).toBeUndefined();
    expect(result.findings.map((f) => f.status)).toEqual(["kept"]);
    expect(result.stages.some((s) => s.status === "interrupted")).toBe(false);
    expect(result.unused?.map((verify) => verify.status)).toEqual([
      "interrupted",
    ]);
  } finally {
    await run.harness.close(context);
  }
});

// Why: the owner-refused branch. A record call that commits after its finder finished, or while it
// is being stopped, starts nothing; a live owner gets its child once.
test("startChild starts nothing for an owner that is finished or being stopped", async () => {
  const run = await testWorld("owner-refused", () =>
    toolReply("submit_find", { findings: [], notes: [] }),
  );
  try {
    const request = (owner: number) =>
      verifyChild(owner, "frame-key", Date.now() + 60_000, {
        ...finding,
        lens: "correctness",
        hunkId: "h1",
      });
    const start = (owner: number) =>
      run.harness.commit(
        (tx) => startChild(tx, run.registry.snapshot(), request(owner)),
        context,
      );
    // Live (pending): the child starts once, then its name is held.
    const live = await run.start("correctness");
    expect(await start(live)).toBeNumber();
    expect(await start(live)).toBeUndefined();
    // Abort-marked while the harness is paused, so its abort has not run yet.
    const stopping = await run.start("correctness");
    expect(await run.harness.abortTask(stopping, context)).toBe("marked");
    expect(await start(stopping)).toBeUndefined();
    expect(Object.keys(await childrenOf(run.harness, stopping))).toEqual([]);
    // Terminal. The live finder is stopped first, so nothing but `ended` runs.
    await run.harness.abortTask(live, context);
    await run.harness.resume();
    const ended = await run.start("correctness");
    await done(run.harness, ended);
    expect(await start(ended)).toBeUndefined();
  } finally {
    await run.harness.close(context);
  }
});

// Why: exactly once after the answer's commit. A record call run again once its answer is
// committed (what pi does when a process dies after the commit, before the call returns) gives the
// stored answer before its handler runs, and starts nothing.
test("a record call run again after its answer's commit returns that answer and starts nothing", async () => {
  let started: () => void = () => {};
  const verifying = new Promise<void>((resolve) => {
    started = resolve;
  });
  let proceed: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    proceed = resolve;
  });
  let calls = 0;
  let verifies = 0;
  const run = await testWorld("after-commit", async (messages) => {
    if (isVerifyRequest(messages)) {
      verifies++;
      started();
      return keep();
    }
    calls++;
    if (calls === 1) return toolReply("record_finding", finding);
    await released;
    return toolReply("submit_find", { findings: [finding], notes: [] });
  });
  try {
    const id = await run.start("correctness");
    await run.harness.resume();
    await verifying;
    const children = await childrenOf(run.harness, id);
    const find = await run.harness.getTask(childId(children["find"]!), context);
    const conversationId = (
      find?.state as { checkpoint?: { conversationId?: number } }
    ).checkpoint?.conversationId;
    expect(conversationId).toBeNumber();
    const doc = await run.harness.snapshot(
      AgentContextDoc,
      conversationId as never,
      context,
    );
    const [callId, ...others] = Object.keys(doc?.applied ?? {});
    expect(others).toEqual([]);
    const registration = run.registry
      .snapshot()
      .extension(kindExtensionName("find"))
      ?.tools?.find((tool) => tool.name === "record_finding");
    const api = {
      taskId: 0,
      conversationId,
      callId,
      registry: run.registry.snapshot(),
      commit: <T>(change: (tx: never) => T, c: typeof context) =>
        run.harness.commit(change as never, c) as Promise<T>,
    } as unknown as ToolExecutionApi;
    const answered = await registration!.execute(
      finding as never,
      api,
      context,
    );
    expect(answered.content).toEqual([
      { type: "text", text: doc!.applied[callId!]!.text },
    ]);
    const recordCalls = run.base.ctx.log
      .read()
      .filter((r) => r.type === "tool.call" && r["tool"] === "record_finding");
    expect(recordCalls).toHaveLength(1);
    expect(childSpans(run)).toHaveLength(1);
    expect(
      Object.keys(await childrenOf(run.harness, id)).filter((name) =>
        name.startsWith("verify."),
      ),
    ).toEqual([verifyNameOf(finding)]);
    proceed();
    await done(run.harness, id);
    expect(verifies).toBe(1);
  } finally {
    proceed();
    await run.harness.close(context);
  }
});

// Why: finders now start when Frame lands, before Map. One whose Find ends first must wait for the
// front task (not its child) and only then group and dedupe, with each finding's group the one
// whose hunks hold its primary hunk, in dedupe's order as before.
test("a finder whose Find ends before Map lands waits for it, then groups and dedupes", async () => {
  let land: () => void = () => {};
  const landed = new Promise<void>((resolve) => {
    land = resolve;
  });
  let findEnded: () => void = () => {};
  const ended = new Promise<void>((resolve) => {
    findEnded = resolve;
  });
  const run = await testWorld(
    "map-wait",
    (messages) => {
      if (isVerifyRequest(messages)) return keep();
      findEnded();
      return toolReply("submit_find", {
        findings: [finding, { ...finding, critical: true }],
        notes: [],
      });
    },
    false,
    view(),
    { mapLanded: landed },
  );
  try {
    const id = await run.start("correctness");
    await run.harness.resume();
    await ended;
    await phaseReached(run.harness, id, "dedupe");
    // Find has ended; the finder waits on the front task, with no Verify yet.
    expect(childSpans(run)).toEqual([]);
    land();
    const result = await done(run.harness, id);
    expect(result.findings.map((f) => f.status)).toEqual(["kept"]);
    const stored = await run.services.run(
      storedOutput(run.base.ctx, result.findKey!, FindStored),
    );
    expect(stored.findings.map((f) => [f.id, f.group, f.critical])).toEqual([
      ["correctness.2", "g1", true],
    ]);
    const waits = finderWaits(run);
    expect(waits.map((a) => a["harness.waiting_on"])).toEqual([
      "find",
      "map",
      "verify",
    ]);
    const finderRecord = await run.harness.getTask(id, context);
    const frontId = String((finderRecord!.input as { front: number }).front);
    expect(waits[1]).toMatchObject({
      "harness.next_phase": "dedupe",
      "harness.waiting_on_ids": frontId,
    });
  } finally {
    land();
    await run.harness.close(context);
  }
});

// Why: without a Map key (Map and its fallback both missing) a finder's findings have no group and
// cannot be placed; it must end on its own, say why, and account for every finding.
test("a finder without a Map key ends with no final list and says why", async () => {
  const run = await testWorld(
    "no-map",
    (messages) =>
      isVerifyRequest(messages)
        ? keep()
        : toolReply("submit_find", { findings: [finding], notes: [] }),
    false,
    view(),
    { mapKey: null },
  );
  try {
    const id = await run.start("correctness");
    await run.harness.resume();
    const result = await done(run.harness, id);
    expect(result.findKey).toBeNull();
    expect(result.findings).toEqual([]);
    expect(result.reason).toBe(
      "the map is unavailable, so the findings have no group",
    );
    expect(
      run.captured.flatMap((event) =>
        event.type === "lead.fate"
          ? [{ id: event.leadId, reason: event.reason }]
          : [],
      ),
    ).toEqual([{ id: "correctness.1", reason: "map-unavailable" }]);
  } finally {
    await run.harness.close(context);
  }
});

// Why: deleted lines are citable as owned changed lines on the old side; a primary anchor there
// must pass every check from submission to the published comment.
test("a finding anchored on deleted lines passes every check up to Publish", async () => {
  const deleted = {
    ...finding,
    anchors: [
      { path: "old.ts", side: "old" as const, startLine: 2, endLine: 2 },
    ],
  };
  const run = await testWorld("deleted-anchor", (messages) =>
    isVerifyRequest(messages)
      ? keep()
      : toolReply("submit_find", { findings: [deleted], notes: [] }),
  );
  try {
    const id = await run.start("correctness");
    await run.harness.resume();
    const result = await done(run.harness, id);
    expect(result.findings.map((f) => f.status)).toEqual(["kept"]);
    const history = await publishFinder(run, result);
    expect(
      history.filter((row) => row.event.kind === "comment.recorded@2"),
    ).toHaveLength(1);
  } finally {
    await run.harness.close(context);
  }
});

// Why: new-side lines the opening's diff shows count as read, as `read`'s do: a secondary anchor
// on them passes the checks from the first turn, and still does after the step's state is saved
// and loaded again (a resumed step).
test("opening lines are citable as read and stay so across a resume", async () => {
  const base = await world("opening-citable");
  const step = await Effect.runPromise(
    findStep(base.ctx, view(), {
      lens: "correctness",
      frame,
      keys: { frame: "frame", manifest: "manifest" },
    }).pipe(Effect.provide(base.ctx.records)),
  );
  // The fixture's hunk shows new.ts lines 1 to 3 (context, added, context).
  const cited = {
    findings: [
      {
        ...finding,
        anchors: [
          ...finding.anchors,
          { path: "new.ts", side: "new" as const, startLine: 1, endLine: 3 },
        ],
      },
    ],
    notes: [],
  };
  expect(step.spec.check?.(cited)).toEqual([]);
  const saved = JSON.parse(JSON.stringify(step.spec.state!.save()));
  const resumed = await Effect.runPromise(
    findStep(base.ctx, view(), {
      lens: "correctness",
      frame,
      keys: { frame: "frame", manifest: "manifest" },
    }).pipe(Effect.provide(base.ctx.records)),
  );
  resumed.spec.state!.load(saved, 3);
  expect(resumed.spec.check?.(cited)).toEqual([]);
  // A line the opening did not show is not citable.
  expect(
    resumed.spec.check?.({
      findings: [
        {
          ...finding,
          anchors: [
            ...finding.anchors,
            { path: "new.ts", side: "new" as const, startLine: 1, endLine: 9 },
          ],
        },
      ],
      notes: [],
    }),
  ).toEqual(["finding 1: secondary anchor must be owned or read head lines"]);
  // The opening is counted in the reading budget from the start.
  expect(resumed.spec.state!.save().reading?.used).toBe(step.spec.task.length);
});

// Why: Map's groups never hold a lockfile or a declared-generated file, so a finding there would
// have no group at dedupe. `record_finding` must refuse it when it is recorded, and say why, so the
// finder can move it; the rule is the one Map's manifest applies (review-map.ts, `mapExclusion`).
test("record_finding refuses a finding on a file Map does not review, saying why", async () => {
  const base = await world("record-unreviewed");
  const lock = MAP_LOCKFILES[0]!;
  const files = [
    { ...hunk, path: lock, newPath: lock, oldPath: lock },
    {
      ...hunk,
      hunkId: "h2",
      path: "out.js",
      newPath: "out.js",
      oldPath: "out.js",
      declared: [
        {
          kind: "generated" as const,
          by: "gitattributes: linguist-generated=true",
        },
      ],
    },
  ];
  const step = await Effect.runPromise(
    findStep(base.ctx, view(files), {
      lens: "correctness",
      frame,
      keys: { frame: "frame-unreviewed", manifest: "manifest" },
    }).pipe(Effect.provide(base.ctx.records)),
  );
  const record = step.spec.tools.find((t) => t.name === "record_finding")!;
  const on = (path: string) =>
    Effect.runPromise(
      record.handle({
        ...finding,
        anchors: [{ path, side: "new", startLine: 2, endLine: 2 }],
      }),
    );
  expect(await on(lock)).toEqual({
    text: `finding 1: primary anchor must be in a reviewed file: ${JSON.stringify(lock)} is a lockfile, which no Map group holds`,
    error: "InvalidFinding",
  });
  expect(await on("out.js")).toEqual({
    text: 'finding 1: primary anchor must be in a reviewed file: "out.js" is declared generated, which no Map group holds',
    error: "InvalidFinding",
  });
});

// Why: two measurements (the ladder's share of changed lines read, and the planted-case gate's
// "in the opening" against "fetched by a lookup") read the `find.opening` row as the truth of what a
// finder was handed. So on a small real range with a deletion its ranges must be exactly the lines
// the opening's diff shows, side by side, with no line's text; and a resumed context, whether its
// state was stored or not, must not write a second row.
test("the find.opening row lists exactly the lines the opening's diff shows, once per context", async () => {
  const base = await world("opening-row");
  const repository = mkdtempSync(join(tmpdir(), "opening-row-"));
  try {
    const git = (...args: Array<string>) => {
      const ran = Bun.spawnSync(["git", "-C", repository, ...args], {
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.test",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.test",
        },
      });
      if (ran.exitCode !== 0) throw new Error(ran.stderr.toString());
      return ran.stdout.toString().trim();
    };
    git("init", "-q", "-b", "main");
    const lines = (n: number, label: string) =>
      Array.from({ length: n }, (_, i) => `${label} ${i + 1}`).join("\n") +
      "\n";
    writeFileSync(join(repository, "x.ts"), lines(12, "SECRET-x"));
    git("add", ".");
    git("commit", "-q", "-m", "base");
    const baseOid = git("rev-parse", "HEAD");
    // Lines 5 and 6 deleted, line 9 rewritten; a new file of three lines.
    writeFileSync(
      join(repository, "x.ts"),
      lines(12, "SECRET-x")
        .split("\n")
        .filter((_, i) => i !== 4 && i !== 5)
        .map((l) => (l === "SECRET-x 9" ? "SECRET-x nine" : l))
        .join("\n"),
    );
    writeFileSync(join(repository, "y.ts"), lines(3, "SECRET-y"));
    git("add", ".");
    git("commit", "-q", "-m", "change");
    const headOid = git("rev-parse", "HEAD");
    const ctx = {
      ...base.ctx,
      repository,
      range: { baseRef: "main", baseOid, headOid },
    };
    const build = () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const manifest = (yield* rangeManifest(
            repository,
            { baseOid, headOid },
            defaultManifestSettings(1_000_000),
            captureOutlineSource(),
          )).value;
          const views = yield* revisionViews(repository, manifest);
          const range: RangeView = {
            manifest,
            snapshot: undefined,
            head: views.head,
            base: views.base,
            hunks: new Map(manifest.hunks.map((h) => [h.hunkId, h])),
            commits: yield* rangeCommits(repository, manifest),
            byPath: new Map(),
            searchFrequency: new Map(),
          };
          const step = yield* findStep(ctx, range, {
            lens: "correctness",
            frame,
            keys: { frame: "frame-opening-row", manifest: "manifest-row" },
          });
          return { step, range };
        }).pipe(Effect.provide(base.ctx.records)),
      );
    const rows = () =>
      base.ctx.log.read().filter((r) => r.type === "find.opening");
    const first = await build();
    expect(rows()).toEqual([]);
    // The context's first call: no state stored yet.
    first.step.spec.state!.load(undefined, 0);
    first.step.spec.state!.load(undefined, 1);
    expect(rows()).toHaveLength(1);
    const row = rows()[0]!;
    // What the opening's diff shows, read back from its text: each hunk's numbered lines by side.
    const text = first.step.spec.task;
    const ids = new Set(first.range.hunks.keys());
    const shown: Array<{ id: string; old: number[]; new: number[] }> = [];
    for (const l of text.slice(text.indexOf("\nDiff\n")).split("\n")) {
      const id = l.split(" ")[0]!;
      if (ids.has(id)) shown.push({ id, old: [], new: [] });
      const numbered = /^([ \d]{5}) ([ \d]{5}) [-+ ]/.exec(l);
      if (numbered === null || shown.length === 0) continue;
      if (numbered[1]!.trim() !== "")
        shown.at(-1)!.old.push(Number(numbered[1]));
      if (numbered[2]!.trim() !== "")
        shown.at(-1)!.new.push(Number(numbered[2]));
    }
    expect(row).toEqual({
      type: "find.opening",
      at: expect.any(String),
      agent: "find.correctness",
      frame: "computation:frame-opening-row",
      manifest: "computation:manifest-row",
      limit: OPENING_CHARS,
      length: text.length,
      hunks: shown.map((h) => ({
        id: h.id,
        cut: false,
        ...(h.old.length === 0 ? {} : { old: [h.old[0], h.old.at(-1)] }),
        ...(h.new.length === 0 ? {} : { new: [h.new[0], h.new.at(-1)] }),
      })),
      sections: [],
    });
    // The range itself, by hand: x.ts shows old 2-12 and new 2-10 (lines 5, 6 and 9 deleted, the
    // new 9 added, three lines of context around), and y.ts new 1-3 only.
    const byPath = new Map(
      [...first.range.hunks.values()].map((h) => [h.path, h.hunkId]),
    );
    expect(row["hunks"]).toEqual([
      { id: byPath.get("x.ts"), cut: false, old: [2, 12], new: [2, 10] },
      { id: byPath.get("y.ts"), cut: false, new: [1, 3] },
    ]);
    // Contiguous ranges: every line between first and last is shown, on each side.
    for (const h of shown) {
      for (const side of [h.old, h.new])
        expect(side).toEqual(
          side.length === 0
            ? []
            : Array.from(
                { length: side.at(-1)! - side[0]! + 1 },
                (_, i) => side[0]! + i,
              ),
        );
    }
    expect(JSON.stringify(row)).not.toContain("SECRET");
    expect(JSON.stringify(row)).not.toContain("x.ts");
    // A resumed context with its state stored, and one resumed before any state was stored:
    // neither writes a second row.
    const saved = JSON.parse(JSON.stringify(first.step.spec.state!.save()));
    const resumed = await build();
    resumed.step.spec.state!.load(saved, 2);
    const early = await build();
    early.step.spec.state!.load(undefined, 0);
    expect(rows()).toHaveLength(1);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
