// Why: a step at its own effort sends that effort because its conversation's route binding carries
// it, and the binding is durable: a resumed process rebuilds every provider from what was stored.
// This drives the binding owner over a real pi Harness and SQLite file, and the kinds' response hook
// that writes the receipt's per-call rows.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  type AssistantMessage,
  type MutableModels,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  MemoryStorage,
  type ConversationId,
  type Storage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  agentRoutes,
  bindingRoute,
  clearInheritedAgentRoute,
} from "../src/pi/bindings.ts";
import type {
  AgentRouteBinding,
  CreateRouteProvider,
} from "../src/pi/contracts.ts";
import { AgentContextDoc } from "../src/pi/stages/docs.ts";
import { kindExtension, type KindTools } from "../src/pi/stages/tools.ts";
import type { AgentStep } from "../src/pi/stages/agent.ts";
import { SOL_ROUTE, stepEffortOf, type RouteEffort } from "../src/route.ts";
import type { RunLogRecord } from "../src/run-log.ts";

const directory = mkdtempSync(join(tmpdir(), "harness-pi-step-effort-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const recording = (built: Array<AgentRouteBinding>): CreateRouteProvider => {
  return (binding) => {
    built.push(binding);
    return {
      id: binding.logicalProvider,
      name: binding.logicalProvider,
      auth: {},
      getModels: () => [],
      stream: () => {
        throw new Error("the binding test never dispatches");
      },
      streamSimple: () => {
        throw new Error("the binding test never dispatches");
      },
    };
  };
};

const open = async (
  storage: Storage,
  models: MutableModels,
  createProvider: CreateRouteProvider,
) => {
  const harness = await Harness.open(
    storage,
    {
      models,
      registry: createRegistry(),
      conversationCreated: clearInheritedAgentRoute,
    },
    context,
  );
  const routes = agentRoutes({
    harness,
    models,
    runId: "run-1",
    createProvider,
  });
  const conversation = () =>
    harness.createConversation({ ownership: { kind: "ownerless" } }, context);
  return { harness, routes, conversation };
};

// Reason: a resumed process must send what the first one sent.
test("a binding stored with an effort is restored with it, and its provider is built at it", async () => {
  const path = join(directory, "with-effort.sqlite");
  const before = await open(
    await openNodeSqliteStorage(path),
    createModels(),
    recording([]),
  );
  const { id } = await before.conversation();
  await before.routes.bindAgentRoute(
    {
      conversationId: id,
      stage: "verify",
      agent: "assess.1",
      route: SOL_ROUTE,
      effort: "high",
    },
    context,
  );
  expect((await before.routes.readBinding(id, context)).effort).toBe("high");
  await before.harness.close(context);

  const built: Array<AgentRouteBinding> = [];
  const after = await open(
    await openNodeSqliteStorage(path),
    createModels(),
    recording(built),
  );
  await after.routes.restoreAgentRoutes(context);
  expect(built.map((binding) => binding.effort)).toEqual(["high"]);
  expect(bindingRoute(SOL_ROUTE, built[0]!)).toEqual({
    ...SOL_ROUTE,
    effort: "high",
  });
  await after.harness.close(context);
});

// Reason: runs in flight across the upgrade must not fault, and must keep running at the route's effort.
test("a binding stored without an effort is accepted by a default step's bind and runs at the route's", async () => {
  const path = join(directory, "without-effort.sqlite");
  const before = await open(
    await openNodeSqliteStorage(path),
    createModels(),
    recording([]),
  );
  const { id } = await before.conversation();
  const bind = {
    conversationId: id,
    stage: "find",
    agent: "find.correctness",
    route: SOL_ROUTE,
  } as const;
  const ref = await before.routes.bindAgentRoute(bind, context);
  // Exactly the binding stored before steps had their own effort.
  expect(await before.routes.readBinding(id, context)).toEqual({
    runId: "run-1",
    stage: "find",
    agent: "find.correctness",
    conversationId: id,
    logicalProvider: `neuve-route:run-1:${id}`,
    physicalProvider: "openai",
    physicalModel: "gpt-6.1-sol",
    mode: { kind: "normal" },
  });
  await before.harness.close(context);

  const built: Array<AgentRouteBinding> = [];
  const after = await open(
    await openNodeSqliteStorage(path),
    createModels(),
    recording(built),
  );
  await after.routes.restoreAgentRoutes(context);
  expect(bindingRoute(SOL_ROUTE, built[0]!)).toBe(SOL_ROUTE);
  // The step task binds with its effort, which is the route's for a default step.
  expect(
    await after.routes.bindAgentRoute(
      { ...bind, effort: stepEffortOf(SOL_ROUTE, "find") },
      context,
    ),
  ).toEqual(ref);
  expect("effort" in (await after.routes.readBinding(id, context))).toBe(false);
  await after.harness.close(context);
});

// Reason: a conversation bound at one effort must never send another.
test("a bind at a different effort is refused", async () => {
  const { harness, routes, conversation } = await open(
    new MemoryStorage(),
    createModels(),
    recording([]),
  );
  const high = await conversation();
  const plain = await conversation();
  const bind = (conversationId: ConversationId, effort?: RouteEffort) =>
    routes.bindAgentRoute(
      {
        conversationId,
        stage: "verify",
        agent: "assess.1",
        route: SOL_ROUTE,
        ...(effort === undefined ? {} : { effort }),
      },
      context,
    );
  await bind(high.id, "high");
  await expect(bind(high.id, "low")).rejects.toThrow(
    "at high effort; refusing verify/assess.1 on openai/gpt-6.1-sol at low effort",
  );
  await expect(bind(high.id)).rejects.toThrow(
    "at high effort; refusing verify/assess.1 on openai/gpt-6.1-sol",
  );
  await bind(plain.id);
  await expect(bind(plain.id, "high")).rejects.toThrow(
    "refusing verify/assess.1 on openai/gpt-6.1-sol at high effort",
  );
  expect((await routes.readBinding(high.id, context)).effort).toBe("high");
  await harness.close(context);
});

/**
 * The kinds' response hook over a conversation of `harness` whose step's spec says `spec` (which a
 * newer build may have changed since the conversation was bound), writing into `records`.
 */
const responseHook = (
  harness: Harness,
  conversationId: ConversationId,
  records: Array<RunLogRecord>,
  spec: { readonly effort?: RouteEffort },
) => {
  const tools: KindTools = {
    route: SOL_ROUTE,
    ceiling: 100_000,
    log: {
      path: join(directory, "calls.jsonl"),
      write: (record) => records.push(record),
      read: () => records,
    },
    run: undefined as never,
    endRound: async () => {},
    inputOf: () => undefined,
    resolve: async () => ({
      step: {
        spec: { stage: "verify", agent: "assess.1", ...spec },
      } as unknown as AgentStep<unknown, unknown>,
      vent: undefined as never,
    }),
  };
  const extension = kindExtension("verify-claim", [], tools);
  const handlers = extension.hooks![0]!.handlers as {
    readonly afterResponse: (
      message: AssistantMessage,
      api: unknown,
      context: unknown,
    ) => Promise<void>;
  };
  return (message: AssistantMessage) =>
    handlers.afterResponse(
      message,
      {
        conversationId,
        // The conversation's step, and every other document as the run's harness holds it.
        snapshot: (token: unknown, id: ConversationId, at: typeof context) =>
          token === AgentContextDoc
            ? Promise.resolve({ step: { agent: "assess.1" }, final: false })
            : harness.snapshot(token as never, id, at),
      },
      context,
    );
};

/** The row as main writes it: the same fields in the same order, effort included. */
const ROW_FIELDS = [
  "type",
  "stage",
  "agent",
  "call",
  "kind",
  "model",
  "effort",
  "maxTokens",
  "startedAt",
  "latencyMs",
  "finishReason",
  "stopReason",
  "refused",
  "usage",
  "costUsd",
  "responseId",
  "toolCalls",
  "assistantBlocks",
];

// Reason: the receipt's per-call rows are evidence of what each call was made at, which is the
// binding's effort even when the step's spec now says another.
test("the model.call row names the effort its conversation's binding carries", async () => {
  const { harness, routes, conversation } = await open(
    new MemoryStorage(),
    createModels(),
    recording([]),
  );
  /** One response's rows, on a conversation bound with `bound` (unbound when undefined). */
  const rows = async (
    bound: { readonly effort?: RouteEffort } | undefined,
    spec: { readonly effort?: RouteEffort },
  ) => {
    const { id } = await conversation();
    if (bound !== undefined)
      await routes.bindAgentRoute(
        {
          conversationId: id,
          stage: "verify",
          agent: "assess.1",
          route: SOL_ROUTE,
          ...bound,
        },
        context,
      );
    const records: Array<RunLogRecord> = [];
    await responseHook(
      harness,
      id,
      records,
      spec,
    )({
      ...fauxAssistantMessage("ok"),
      responseId: "r1",
    });
    return records.filter((record) => record.type === "model.call");
  };
  const effortOf = (records: ReadonlyArray<RunLogRecord>) =>
    records.map((record) => record["effort"]);
  // Bound at high; the spec now says low.
  expect(effortOf(await rows({ effort: "high" }, { effort: "low" }))).toEqual([
    "high",
  ]);
  // Bound at the route's; the spec now says high.
  expect(effortOf(await rows({}, { effort: "high" }))).toEqual(["medium"]);
  // No binding: the route's.
  expect(effortOf(await rows(undefined, { effort: "high" }))).toEqual([
    "medium",
  ]);
  // Nothing set: the row is main's, field for field.
  const plain = await rows({}, {});
  expect(effortOf(plain)).toEqual(["medium"]);
  expect(Object.keys(plain[0]!)).toEqual(ROW_FIELDS);
  await harness.close(context);
});
