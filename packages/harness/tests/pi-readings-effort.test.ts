// Why (NEU-148, effort per reading step): a measurement of the readings, or a default chosen from
// one, is worthless if the effort a step is sent at is not the effort code decided for it. Each
// reading step's input is made the way the readings make it, from a real plan: the reading tasks
// (`readingTaskInputs`, by risk or by kind), each step's parameters (`readingStepInput`,
// `claimStepInput`), the spec's effort from them (`withStepEffort`, as `readingStep` sets it), and
// the bind the agent step makes from the spec (`stepEffortOf` over the spec's effort, as
// `agent-step.ts` binds). Then the real review host (its route bindings and call slots) on a real pi
// Harness over SQLite, with the attempt's own provider factory (`bindingProvider`) speaking to a
// local endpoint that records each request, on the OpenAI and the Anthropic route. It checks the
// effort in each request body, on each `model.call` row, and in the step's stage key.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  type DocumentReader,
  type TaskId,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Effect } from "effect";
import { Scheduler } from "../src/budget/scheduler.ts";
import { defaultConfig } from "../src/config.ts";
import { agentStageSpec, type StageRecord } from "../src/pipeline.ts";
import { bindingProvider } from "../src/pi/attempt.ts";
import { callSlots } from "../src/pi/call-slots.ts";
import { openReviewHost } from "../src/pi/host.ts";
import type { ReviewStagesPort } from "../src/pi/review-task.ts";
import { SourceOwnership } from "../src/pi/source-ownership.ts";
import type { AgentStep } from "../src/pi/stages/agent.ts";
import type { AgentStepInput } from "../src/pi/stages/agent-step.ts";
import { KindParams } from "../src/pi/stages/run.ts";
import {
  claimStepInput,
  readingBinds,
  readingStepInput,
  withStepEffort,
} from "../src/pi/stages/reading-task.ts";
import type { StageServices } from "../src/pi/stages/services.ts";
import type { ResolvedAgent } from "../src/pi/stages/tools.ts";
import { readingTaskInputs } from "../src/readings/collect.ts";
import { readingEfforts } from "../src/readings/effort.ts";
import { planReadings } from "../src/readings/plan.ts";
import {
  OPUS_ROUTE,
  SOL_ROUTE,
  stepEffortOf,
  type AnyRouteConfig,
  type RouteEffort,
} from "../src/route.ts";
import type { RunLog, RunLogRecord } from "../src/run-log.ts";
import { riskRange } from "./fixtures/readings.ts";
import {
  completed,
  created,
  messageItem,
  openEndpoint,
  sse,
  tokenCommand,
} from "./pi/providers/fixture.ts";

const directory = mkdtempSync(join(tmpdir(), "pi-readings-effort-"));
const endpoint = openEndpoint();
afterAll(() => {
  endpoint.stop();
  rmSync(directory, { recursive: true, force: true });
});
const token = tokenCommand(directory, "lease");
const KEY_VARIABLE = "NEUVE_TEST_READINGS_EFFORT_KEY";

const record = (stage: StageRecord["stage"], agent: string): StageRecord => ({
  stage,
  agent,
  status: "computed",
  wallMs: 1,
});

/** A review that ends at once: Precompute finds no manifest, so the review publishes nothing. */
const port: ReviewStagesPort = {
  front: async () => {
    throw new Error("no front in this test");
  },
  finder: async () => {
    throw new Error("no finder in this test");
  },
  fill: async () => ({ record: record("link", "link.fill"), groups: [] }),
  link: async () => {
    throw new Error("no link in this test");
  },
  precompute: async () => ({
    record: { ...record("precompute", "precompute"), status: "skipped" },
  }),
  publish: async () => [record("publish", "publish")],
};

/** One plain answer on the route's wire, which ends the conversation's turn. */
const answer = (provider: AnyRouteConfig["provider"], at: number) =>
  provider === "openai"
    ? sse([
        created(`resp_${at}`),
        ...messageItem(0, `msg_${at}`, "final_answer", "done"),
        completed(`resp_${at}`),
      ])
    : sse(
        [
          {
            type: "message_start",
            message: {
              id: `msg_${at}`,
              type: "message",
              role: "assistant",
              model: OPUS_ROUTE.model,
              content: [],
              stop_reason: null,
              usage: { input_tokens: 10, output_tokens: 1 },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "done" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 2 },
          },
          { type: "message_stop" },
        ],
        { headers: { "request-id": `req_${at}` } },
      );

/** The effort a request body was sent at, on either route's wire. */
const sentEffort = (body: Record<string, unknown>) =>
  ((body["reasoning"] ?? body["output_config"]) as { effort?: unknown })
    ?.effort;

/** The agent a reading step's agent is named, as the readings' steps name theirs. */
const agentOf = (input: AgentStepInput) => {
  const params = input.params as {
    group?: string;
    part?: string;
    claim?: string;
  };
  return input.kind === "verify-claim"
    ? `verify.claim.${params.claim!.slice(0, 12)}`
    : `${input.kind}.${params.group}${params.part === "reread" ? ".reread" : ""}`;
};

/**
 * The step `readingStep` prepares from its parameters, reduced to its spec's stage, agent and
 * effort: the parameters as run.ts reads them (`KindParams`), the effort set as `readingStep` sets it.
 */
const prepared = (input: AgentStepInput): AgentStep<unknown, unknown> => {
  const params = KindParams[
    input.kind as "assess" | "lane-review" | "verify-claim"
  ].parse(input.params);
  return withStepEffort(
    {
      spec: { stage: "verify", agent: agentOf(input) },
      op: `harness.${input.kind}`,
      opVersion: 1,
      inputs: { agent: agentOf(input) },
    } as unknown as AgentStep<unknown, unknown>,
    params.effort,
  );
};

// The plans, as the readings make them: with effort by risk the riskRange is packed per class (its
// flagged and top-quarter sections in one group, the other seven in another); off, one group.
const range = riskRange();
const hunks = new Map(range.hunks.map((hunk) => [hunk.hunkId, hunk]));
const planOf = (byRisk: boolean) =>
  planReadings({
    hunks: range.hunks,
    structures: range.structures,
    ...(byRisk ? { split: "by-risk" as const } : {}),
  });
const KEYS = {
  manifestKey: "manifest-key",
  frameKey: "frame-key",
  mapKey: "map-key",
  cutoffAt: Date.now() + 3_600_000,
};

/** One plan's steps: each group's Assess and Lane review, a re-read, a claim check, a finder's turn. */
const stepsOf = (route: AnyRouteConfig, byRisk: boolean) => {
  const plan = planOf(byRisk);
  const efforts = byRisk ? readingEfforts(plan, hunks) : undefined;
  const tasks = readingTaskInputs(plan, "plan-key", KEYS, route, efforts);
  const named = (group: string) =>
    efforts === undefined
      ? "the group"
      : efforts.groups.get(group)!.laneReview === "high"
        ? "the high group"
        : "the medium group";
  const keys = { frame: KEYS.frameKey, map: KEYS.mapKey };
  const steps: Array<{
    readonly label: string;
    readonly input?: AgentStepInput;
  }> = tasks.map(({ input }) => ({
    label: `${input.kind} of ${named(input.group)}`,
    input: readingStepInput(
      input,
      "read",
      input.kind === "lane-review" ? keys : undefined,
    ),
  }));
  const last = tasks.at(-1)!.input;
  steps.push(
    {
      label: `lane-review of ${named(last.group)}, re-read`,
      input: readingStepInput(last, "reread", keys, [
        plan.groups.find((g) => g.id === last.group)!.keys[0]!,
      ]),
    },
    {
      label: `claim check of ${named(last.group)}`,
      input: claimStepInput(last, {
        key: "c".repeat(64),
        answer: "answer-key",
      }),
    },
    { label: "finder" },
  );
  return steps;
};

let runs = 0;

/**
 * Sends each step's one call through the host on `route`; returns each step's sent and recorded
 * effort, and the effort its stage key names.
 */
const runSteps = async (route: AnyRouteConfig, byRisk: boolean) => {
  const rows: Array<RunLogRecord> = [];
  const log: RunLog = {
    path: "(memory)",
    write: (row) => {
      rows.push(JSON.parse(JSON.stringify(row)) as RunLogRecord);
    },
    read: () => rows,
  };
  const path = join(directory, `pi-${++runs}.sqlite`);
  const ownership = SourceOwnership.acquire(path);
  const budget = new Scheduler(4, 4, 4);
  const runId = `run-${runs}`;
  const host = await openReviewHost(
    {
      storage: await openNodeSqliteStorage(path),
      ownership,
      models: createModels(),
      // The attempt's own factory: each conversation's provider at its binding's effort.
      createRouteProvider: bindingProvider(route, {
        auth: { tokenCommand: token.path },
        fetch: endpoint.fetch,
        log,
        capture: () => {},
        credentialInspection: "ephemeral" as const,
      }),
      slots: callSlots(
        4,
        (work, signal) =>
          Effect.runPromise(work, signal === undefined ? {} : { signal }),
        {
          budget,
          account: "a".repeat(64),
          owner: runId,
          priority: () => ({ class: "interactive", position: "new", stage: 0 }),
        },
      ),
      registry: createRegistry(),
      run: {
        runId,
        runKey: "run-key",
        generation: 1,
        cycleId: "cycle-1",
        range: {
          baseRef: "main",
          baseOid: "a".repeat(40),
          headOid: "b".repeat(40),
        },
        config: {} as never,
        cutoffAt: KEYS.cutoffAt,
      },
      claim: { jobSeq: 7, attempt: 1, claimedAt: "effort" },
      stages: () => ({
        port,
        extension: defineExtension({ name: "test.stages", tasks: [] }),
      }),
      onClose: async () => undefined,
      cutoffGraceMs: 50,
    },
    context,
  ).finally(() => ownership.release());
  const out: Array<{
    readonly label: string;
    readonly sent: unknown;
    readonly recorded: ReadonlyArray<unknown>;
    readonly keyed: unknown;
  }> = [];
  try {
    await host.ended(context);
    // The agent step's own order: it prepares the step from its input, then binds its route at
    // the effort the prepared spec resolves to.
    const bound = readingBinds(
      {
        routes: {
          bindAgentRoute: host.routes.bindAgentRoute,
          prepareFinalGeneration: host.routes.prepareFinalGeneration,
        },
      } as StageServices,
      {
        prepare: async (_taskId, input) =>
          ({ step: prepared(input) }) as ResolvedAgent,
      },
      true,
    );
    const config = defaultConfig(undefined, route);
    for (const [at, step] of stepsOf(route, byRisk).entries()) {
      const conversation = await host.harness.createConversation(
        { ownership: { kind: "ownerless" } },
        context,
      );
      // A finder sets no effort of its own.
      const spec: Pick<
        AgentStep<unknown, unknown>["spec"],
        "stage" | "agent" | "effort"
      > =
        step.input === undefined
          ? { stage: "find", agent: "find.correctness" }
          : (
              await bound.prepare(
                at as TaskId,
                step.input,
                host.harness as DocumentReader,
                context,
              )
            ).step.spec;
      const model = await bound.services.routes.bindAgentRoute(
        {
          conversationId: conversation.id,
          stage: spec.stage,
          agent: spec.agent,
          route,
          effort: stepEffortOf(route, spec.stage, spec.effort),
        },
        context,
      );
      await conversation.configure({ model }, context);
      if (step.input !== undefined) {
        // A resumed step prepares again from the same input and binds the same conversation: it
        // asks for the same level, and the binding refuses any other, the route's included.
        const again = (
          await bound.prepare(
            at as TaskId,
            step.input,
            host.harness as DocumentReader,
            context,
          )
        ).step.spec;
        const effort = stepEffortOf(route, again.stage, again.effort);
        expect(effort).toBe(stepEffortOf(route, spec.stage, spec.effort));
        expect(
          await bound.services.routes.bindAgentRoute(
            {
              conversationId: conversation.id,
              stage: again.stage,
              agent: again.agent,
              route,
              effort,
            },
            context,
          ),
        ).toEqual(model);
        for (const other of ["low", "medium", "high"] as const)
          if (other !== effort)
            await expect(
              bound.services.routes.bindAgentRoute(
                {
                  conversationId: conversation.id,
                  stage: again.stage,
                  agent: again.agent,
                  route,
                  effort: other,
                },
                context,
              ),
            ).rejects.toThrow("refusing");
      }
      const before = endpoint.received.length;
      endpoint.respond(() => answer(route.provider, at));
      const submission = await conversation.submit(
        { type: "input", content: "Read it.", requestId: `turn-${at}` },
        context,
      );
      expect((await submission.wait(context)).status).toBe("done");
      // One request per step, and its finished call's row.
      expect(endpoint.received.length).toBe(before + 1);
      await Bun.sleep(5);
      out.push({
        label: step.label,
        sent: sentEffort(endpoint.received[before]!.body),
        recorded: rows
          .filter(
            (row) => row.type === "model.call" && row["agent"] === spec.agent,
          )
          .map((row) => row["effort"]),
        keyed: (
          agentStageSpec(
            config,
            { ...spec, turnLimit: 1 },
            { op: "harness.test", opVersion: 1, inputs: {} },
          ).route as { reasoning: unknown }
        ).reasoning,
      });
    }
  } finally {
    await host.close("ended", context);
  }
  return out;
};

/**
 * A reading's effort without effort by risk: its kind's entry, else the lower of the route's and
 * medium (round 8; before it, the route's, which is the same on a medium or low route).
 */
const readingAt = (route: AnyRouteConfig, kind: "assess" | "lane-review") =>
  route.stepEffort?.[kind] ?? (route.effort === "low" ? "low" : "medium");

/**
 * By risk: by class, the high group first (as `byRank` puts it), at fixed levels. Otherwise: each
 * reading at `readingAt`, a claim check at its stage's, the finder at its own.
 */
const expected = (route: AnyRouteConfig, byRisk: boolean) =>
  byRisk
    ? [
        { label: "assess of the high group", effort: "medium" },
        { label: "lane-review of the high group", effort: "high" },
        { label: "assess of the medium group", effort: "medium" },
        { label: "lane-review of the medium group", effort: "medium" },
        { label: "lane-review of the medium group, re-read", effort: "medium" },
        { label: "claim check of the medium group", effort: "high" },
        { label: "finder", effort: stepEffortOf(route, "find") },
      ]
    : [
        { label: "assess of the group", effort: readingAt(route, "assess") },
        {
          label: "lane-review of the group",
          effort: readingAt(route, "lane-review"),
        },
        {
          label: "lane-review of the group, re-read",
          effort: readingAt(route, "lane-review"),
        },
        {
          label: "claim check of the group",
          effort: stepEffortOf(route, "verify"),
        },
        { label: "finder", effort: stepEffortOf(route, "find") },
      ];

const check = (
  got: Awaited<ReturnType<typeof runSteps>>,
  want: ReturnType<typeof expected>,
) => {
  expect(got.map(({ label, sent }) => ({ label, effort: sent }))).toEqual(want);
  for (const [at, row] of got.entries()) {
    // The finished call's row says the effort that was sent.
    expect(row.recorded).toEqual([want[at]!.effort]);
    // The step's stage key names the same effort.
    expect(row.keyed).toBe(want[at]!.effort);
  }
};

const ROUTES = [SOL_ROUTE, { ...OPUS_ROUTE, credentialVariable: KEY_VARIABLE }];

/** The route a run freezes at an effort, with per-kind step efforts when given. */
const routeOf = (
  base: (typeof ROUTES)[number],
  effort: RouteEffort,
  stepEffort?: AnyRouteConfig["stepEffort"],
) =>
  ({
    ...base,
    effort,
    ...(stepEffort === undefined ? {} : { stepEffort }),
  }) as AnyRouteConfig;

// Reason: the effort sent must be the effort code chose, and the effort recorded and keyed the
// effort sent: with effort by risk on and off. A resumed step and a re-read ask for the same level,
// as the binding refuses another.
for (const base of ROUTES)
  for (const routeEffort of ["high", "medium", "low"] as const)
    test(`on the ${base.provider} route at ${routeEffort}: by risk each reading step goes at its class's level and the finder at the route's; without it each reading goes at the lower of the route's and medium`, async () => {
      process.env[KEY_VARIABLE] = "sk-ant-test-readings-effort";
      try {
        const route = routeOf(base, routeEffort);
        check(await runSteps(route, true), expected(route, true));
        check(await runSteps(route, false), expected(route, false));
      } finally {
        delete process.env[KEY_VARIABLE];
      }
    }, 60_000);

// Reason: a default review on a high route must send Assess and Lane review at medium and the claim
// check at high, and a person's entry must still win over the default.
for (const base of ROUTES)
  test(`on the ${base.provider} route at high: with nothing set, Assess and Lane review go at medium and the claim check and finder at high; an entry for assess keeps it at high`, async () => {
    process.env[KEY_VARIABLE] = "sk-ant-test-readings-effort";
    try {
      const plain = routeOf(base, "high");
      expect(expected(plain, false).map((step) => step.effort)).toEqual([
        "medium",
        "medium",
        "medium",
        "high",
        "high",
      ]);
      check(await runSteps(plain, false), expected(plain, false));
      const set = routeOf(base, "high", { assess: "high" });
      expect(expected(set, false).map((step) => step.effort)).toEqual([
        "high",
        "medium",
        "medium",
        "high",
        "high",
      ]);
      check(await runSteps(set, false), expected(set, false));
    } finally {
      delete process.env[KEY_VARIABLE];
    }
  }, 60_000);

// Reason: a kind's own step effort must reach the request, and only that kind's steps.
for (const base of ROUTES)
  test(`on the ${base.provider} route with a step effort for assess and verify: Assess goes at its entry, a claim check at verify's, a Lane review and the finder at the route's`, async () => {
    process.env[KEY_VARIABLE] = "sk-ant-test-readings-effort";
    try {
      const route = routeOf(base, "medium", { assess: "high", verify: "low" });
      const want = expected(route, false);
      expect(want.map((step) => step.effort)).toEqual([
        "high",
        "medium",
        "medium",
        "low",
        "medium",
      ]);
      check(await runSteps(route, false), want);
      // By risk, the levels are fixed whatever the entries say.
      check(await runSteps(route, true), expected(route, true));
    } finally {
      delete process.env[KEY_VARIABLE];
    }
  }, 60_000);
