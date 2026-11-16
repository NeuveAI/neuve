// Why: an agent conversation's requests are dispatched by the provider its route binding names, so
// the binding is durable identity. This drives the runtime's binding owner over a real pi Harness
// and a real Models registry: a repeated bind keeps one logical alias, final mode keeps it, a
// conflicting rebind and a missing binding fail visibly, and a reopened run registers every
// persisted binding before it resumes, replacing any provider left in its models by the closed
// harness. A fork and a task-owned child copy their parent's model, so
// those tests dispatch through pi's faux provider to show the parent's route never serves them. That
// proves only which route serves a request; wire requests and reasoning continuity are the
// provider lane's proof.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  Type,
  type AssistantMessage,
  type FauxResponseFactory,
  type MutableModels,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
  type ConversationId,
  type ConversationRecord,
  type Registry,
  type SettledSubmissionRecord,
  type Storage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { agentRoutes, clearInheritedAgentRoute } from "../src/pi/bindings.ts";
import type {
  AgentRouteBinding,
  CreateRouteProvider,
} from "../src/pi/contracts.ts";
import { OPUS_ROUTE, SOL_ROUTE } from "../src/route.ts";

const directory = mkdtempSync(join(tmpdir(), "harness-pi-bindings-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const RUN = "run-1";
const SCHEMA = {
  type: "object",
  properties: { verdict: { type: "string" } },
  required: ["verdict"],
};

type Built = {
  readonly binding: AgentRouteBinding;
  readonly readBinding: () => Promise<AgentRouteBinding>;
};

const recordingProvider = (built: Array<Built>): CreateRouteProvider => {
  return (binding, readBinding) => {
    built.push({ binding, readBinding });
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

type Served = {
  readonly provider: string;
  readonly agent: string;
  readonly conversationId: ConversationId;
  readonly mode: AgentRouteBinding["mode"]["kind"];
};

/** Answers every request with `reply`, recording the binding its provider read at dispatch. */
const dispatchingProvider = (
  built: Array<Built>,
  served: Array<Served>,
  reply: (transcript: TranscriptContext) => AssistantMessage = () =>
    fauxAssistantMessage("ok"),
): CreateRouteProvider => {
  return (binding, readBinding) => {
    built.push({ binding, readBinding });
    const faux = fauxProvider({
      provider: binding.logicalProvider,
      models: [{ id: binding.physicalModel }],
    });
    const respond: FauxResponseFactory = async (transcript) => {
      faux.appendResponses([respond]);
      const { logicalProvider, agent, conversationId, mode } =
        await readBinding();
      served.push({
        provider: logicalProvider,
        agent,
        conversationId,
        mode: mode.kind,
      });
      return reply(transcript);
    };
    faux.setResponses([respond]);
    return faux.provider;
  };
};

const lastAssistant = (messages: ReadonlyArray<{ readonly role: string }>) =>
  messages.findLast(
    (message): message is AssistantMessage => message.role === "assistant",
  );

const open = async (
  storage: Storage,
  models: MutableModels,
  createProvider: CreateRouteProvider,
  registry: Registry = createRegistry(),
) => {
  const harness = await Harness.open(
    storage,
    { models, registry, conversationCreated: clearInheritedAgentRoute },
    context,
  );
  const routes = agentRoutes({ harness, models, runId: RUN, createProvider });
  const conversation = () =>
    harness.createConversation({ ownership: { kind: "ownerless" } }, context);
  return { harness, routes, conversation };
};

test("a repeated bind keeps one logical alias, and final mode keeps it", async () => {
  const models = createModels();
  const built: Array<Built> = [];
  const { harness, routes, conversation } = await open(
    new MemoryStorage(),
    models,
    recordingProvider(built),
  );
  const { id } = await conversation();
  const bind = {
    conversationId: id,
    stage: "find",
    agent: "investigator-1",
    route: SOL_ROUTE,
  } as const;

  const first = await routes.bindAgentRoute(bind, context);
  const again = await routes.bindAgentRoute(bind, context);
  expect(first).toEqual({
    provider: `neuve-route:run-1:${id}`,
    modelId: "gpt-6.1-sol",
  });
  expect(again).toEqual(first);
  expect(built.length).toBe(1);
  expect(models.getProvider(first.provider)?.id).toBe(first.provider);
  expect(await routes.readBinding(id, context)).toEqual({
    runId: "run-1",
    stage: "find",
    agent: "investigator-1",
    conversationId: id,
    logicalProvider: `neuve-route:run-1:${id}`,
    physicalProvider: "openai",
    physicalModel: "gpt-6.1-sol",
    mode: { kind: "normal" },
  });

  await routes.prepareFinalGeneration(
    { conversationId: id, schema: SCHEMA },
    context,
  );
  const atDispatch = await built[0]!.readBinding();
  expect(atDispatch.logicalProvider).toBe(first.provider);
  expect(atDispatch.mode).toEqual({ kind: "final", schema: SCHEMA });
  expect(await routes.bindAgentRoute(bind, context)).toEqual(first);
  expect((await routes.readBinding(id, context)).mode.kind).toBe("final");
  expect(built.length).toBe(1);

  await harness.close(context);
});

test("a conflicting rebind, a missing binding and a non-JSON schema fail visibly", async () => {
  const models = createModels();
  const built: Array<Built> = [];
  const { harness, routes, conversation } = await open(
    new MemoryStorage(),
    models,
    recordingProvider(built),
  );
  const bound = await conversation();
  const unbound = await conversation();
  const route = {
    conversationId: bound.id,
    stage: "map",
    agent: "mapper",
    route: OPUS_ROUTE,
  } as const;
  const ref = await routes.bindAgentRoute(route, context);

  await expect(
    routes.bindAgentRoute({ ...route, agent: "verifier" }, context),
  ).rejects.toThrow(
    "is bound to map/mapper on anthropic/claude-opus-5-5; refusing map/verifier",
  );
  await expect(
    routes.bindAgentRoute({ ...route, route: SOL_ROUTE }, context),
  ).rejects.toThrow("refusing map/mapper on openai/gpt-6.1-sol");
  expect((await routes.readBinding(bound.id, context)).agent).toBe("mapper");

  await expect(routes.readBinding(unbound.id, context)).rejects.toThrow(
    `Conversation ${unbound.id} has no agent route`,
  );
  await expect(
    routes.prepareFinalGeneration(
      { conversationId: unbound.id, schema: SCHEMA },
      context,
    ),
  ).rejects.toThrow(`Conversation ${unbound.id} has no agent route to finish`);
  await expect(routes.readBinding(unbound.id, context)).rejects.toThrow(
    "has no agent route",
  );

  await expect(
    routes.prepareFinalGeneration(
      { conversationId: bound.id, schema: { maximum: Number.NaN } },
      context,
    ),
  ).rejects.toThrow("non-finite number");
  expect((await routes.readBinding(bound.id, context)).mode).toEqual({
    kind: "normal",
  });

  const second = await conversation();
  const other = await routes.bindAgentRoute(
    { ...route, conversationId: second.id, agent: "assembler-2" },
    context,
  );
  expect(other.provider).not.toBe(ref.provider);
  expect(built.map(({ binding }) => binding.agent)).toEqual([
    "mapper",
    "assembler-2",
  ]);

  await harness.close(context);
});

test("a bind retried after a failed registration registers its provider", async () => {
  const models = createModels();
  const built: Array<Built> = [];
  const recording = recordingProvider(built);
  let failures = 1;
  const { harness, routes, conversation } = await open(
    new MemoryStorage(),
    models,
    (binding, readBinding) => {
      if (failures-- > 0) throw new Error("the provider is not ready");
      return recording(binding, readBinding);
    },
  );
  const { id } = await conversation();
  const bind = {
    conversationId: id,
    stage: "frame",
    agent: "understander",
    route: SOL_ROUTE,
  } as const;

  await expect(routes.bindAgentRoute(bind, context)).rejects.toThrow(
    "the provider is not ready",
  );
  const ref = await routes.bindAgentRoute(bind, context);
  expect(models.getProvider(ref.provider)?.id).toBe(ref.provider);
  expect(built.length).toBe(1);

  await harness.close(context);
});

test("a reopened run registers every persisted binding before it resumes", async () => {
  const path = join(directory, "pi.sqlite");
  const crashing: CreateRouteProvider = (binding) => {
    throw new Error(`registration of ${binding.agent} never happened`);
  };
  const before = await open(
    await openNodeSqliteStorage(path),
    createModels(),
    crashing,
  );
  const a = await before.conversation();
  const b = await before.conversation();
  await expect(
    before.routes.bindAgentRoute(
      {
        conversationId: a.id,
        stage: "frame",
        agent: "understander",
        route: SOL_ROUTE,
      },
      context,
    ),
  ).rejects.toThrow("registration of understander never happened");
  await expect(
    before.routes.bindAgentRoute(
      {
        conversationId: b.id,
        stage: "verify",
        agent: "verifier",
        route: SOL_ROUTE,
      },
      context,
    ),
  ).rejects.toThrow("registration of verifier never happened");
  await before.routes.prepareFinalGeneration(
    { conversationId: b.id, schema: SCHEMA },
    context,
  );
  await before.harness.close(context);

  const models = createModels();
  const built: Array<Built> = [];
  const after = await open(
    await openNodeSqliteStorage(path),
    models,
    recordingProvider(built),
  );
  const aliasA = `neuve-route:run-1:${a.id}`;
  const aliasB = `neuve-route:run-1:${b.id}`;
  expect(models.getProvider(aliasA)).toBeUndefined();

  await after.routes.restoreAgentRoutes(context);
  expect((await after.harness.inspect(context)).scheduling).toBe("paused");
  expect(models.getProvider(aliasA)?.id).toBe(aliasA);
  expect(models.getProvider(aliasB)?.id).toBe(aliasB);
  expect(
    built.map(({ binding }) => [
      binding.logicalProvider,
      binding.agent,
      binding.mode.kind,
    ]),
  ).toEqual([
    [aliasA, "understander", "normal"],
    [aliasB, "verifier", "final"],
  ]);

  expect(
    await after.routes.bindAgentRoute(
      {
        conversationId: a.id,
        stage: "frame",
        agent: "understander",
        route: SOL_ROUTE,
      },
      context,
    ),
  ).toEqual({ provider: aliasA, modelId: "gpt-6.1-sol" });
  expect(built.length).toBe(2);

  await after.harness.close(context);
});

test("a run reopened with the same models dispatches through its own harness, not the closed one", async () => {
  const path = join(directory, "pi-same-models.sqlite");
  const models = createModels();
  const built: Array<Built> = [];
  const served: Array<Served> = [];
  const before = await open(
    await openNodeSqliteStorage(path),
    models,
    dispatchingProvider(built, served),
  );
  const created = await before.conversation();
  const bind = {
    conversationId: created.id,
    stage: "map",
    agent: "mapper",
    route: SOL_ROUTE,
  } as const;
  const ref = await before.routes.bindAgentRoute(bind, context);
  await created.configure({ model: ref }, context);
  expect(
    (
      await (
        await created.submit({ type: "input", content: "first" }, context)
      ).wait(context)
    ).status,
  ).toBe("done");
  await before.routes.prepareFinalGeneration(
    { conversationId: created.id, schema: SCHEMA },
    context,
  );
  await before.harness.close(context);
  expect(models.getProvider(ref.provider)?.id).toBe(ref.provider);

  const after = await open(
    await openNodeSqliteStorage(path),
    models,
    dispatchingProvider(built, served),
  );
  await after.routes.restoreAgentRoutes(context);
  expect((await after.harness.inspect(context)).scheduling).toBe("paused");

  const resumed = await after.harness.conversation(created.id, context);
  if (resumed === undefined) throw new Error("the conversation persisted");
  expect((await resumed.agent(context)).model).toEqual(ref);
  const settled = await (
    await resumed.submit({ type: "input", content: "after reopen" }, context)
  ).wait(context);
  expect(settled.status).toBe("done");
  const turn = (mode: Served["mode"]): Served => ({
    provider: ref.provider,
    agent: "mapper",
    conversationId: created.id,
    mode,
  });
  expect(served).toEqual([turn("normal"), turn("final")]);
  const answer = lastAssistant((await resumed.context(context)).messages);
  expect(answer?.provider).toBe(ref.provider);
  expect(answer?.model).toBe("gpt-6.1-sol");

  expect(await after.routes.bindAgentRoute(bind, context)).toEqual(ref);
  expect(await after.routes.readBinding(created.id, context)).toEqual({
    runId: "run-1",
    stage: "map",
    agent: "mapper",
    conversationId: created.id,
    logicalProvider: ref.provider,
    physicalProvider: "openai",
    physicalModel: "gpt-6.1-sol",
    mode: { kind: "final", schema: SCHEMA },
  });
  expect(built.length).toBe(2);

  await after.harness.close(context);
});

test("a fork of a final-mode agent starts unbound and never dispatches through its parent's route", async () => {
  const models = createModels();
  const built: Array<Built> = [];
  const served: Array<Served> = [];
  const { harness, routes, conversation } = await open(
    new MemoryStorage(),
    models,
    dispatchingProvider(built, served),
  );
  const parent = await conversation();
  const parentRef = await routes.bindAgentRoute(
    {
      conversationId: parent.id,
      stage: "find",
      agent: "investigator-1",
      route: SOL_ROUTE,
    },
    context,
  );
  await parent.configure({ model: parentRef }, context);
  const answered = await (
    await parent.submit({ type: "input", content: "first" }, context)
  ).wait(context);
  expect(answered.status).toBe("done");
  await routes.prepareFinalGeneration(
    { conversationId: parent.id, schema: SCHEMA },
    context,
  );
  const parentTurn: Served = {
    provider: parentRef.provider,
    agent: "investigator-1",
    conversationId: parent.id,
    mode: "normal",
  };
  expect(served).toEqual([parentTurn]);

  if (answered.answer === undefined)
    throw new Error("the parent turn answered");
  const fork = await parent.fork(
    answered.answer,
    { ownership: { kind: "ownerless" } },
    context,
  );
  expect((await fork.agent(context)).model).toBeUndefined();
  expect((await parent.agent(context)).model).toEqual(parentRef);
  await expect(routes.readBinding(fork.id, context)).rejects.toThrow(
    `Conversation ${fork.id} has no agent route`,
  );

  const unbound: SettledSubmissionRecord = await (
    await fork.submit({ type: "input", content: "fork turn" }, context)
  ).wait(context);
  expect(unbound.status).toBe("unanswered");
  expect(unbound.reason).toBe("no_model");
  expect(served).toEqual([parentTurn]);
  expect(built.map(({ binding }) => binding.agent)).toEqual(["investigator-1"]);
  expect(lastAssistant((await fork.context(context)).messages)?.provider).toBe(
    parentRef.provider,
  );
  expect((await fork.context(context)).messages.at(-1)?.role).toBe("user");

  const forkRef = await routes.bindAgentRoute(
    {
      conversationId: fork.id,
      stage: "find",
      agent: "investigator-2",
      route: SOL_ROUTE,
    },
    context,
  );
  expect(forkRef).toEqual({
    provider: `neuve-route:run-1:${fork.id}`,
    modelId: "gpt-6.1-sol",
  });
  await fork.configure({ model: forkRef }, context);
  const bound = await (
    await fork.submit({ type: "input", content: "bound fork turn" }, context)
  ).wait(context);
  expect(bound.status).toBe("done");
  expect(served).toEqual([
    parentTurn,
    {
      provider: forkRef.provider,
      agent: "investigator-2",
      conversationId: fork.id,
      mode: "normal",
    },
  ]);
  expect(lastAssistant((await fork.context(context)).messages)?.provider).toBe(
    forkRef.provider,
  );
  expect((await routes.readBinding(parent.id, context)).mode.kind).toBe(
    "final",
  );

  await harness.close(context);
});

test("a task-owned child of a bound agent starts unbound until its own route is bound", async () => {
  const models = createModels();
  const built: Array<Built> = [];
  const served: Array<Served> = [];
  const children: Array<{
    readonly record: ConversationRecord;
    readonly settled: SettledSubmissionRecord;
  }> = [];
  let delegations = 0;
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "delegation",
      tools: [
        defineTool({
          name: "delegate",
          description: "Hand the question to a child conversation",
          parameters: Type.Object({}),
          execute: async (_args, api, context) => {
            // A child served by the parent's route would delegate again; one is enough to see it.
            if (delegations++ > 0) {
              return { content: [{ type: "text", text: "nested" }] };
            }
            const record = await api.commit(
              (tx) =>
                tx.createConversation({
                  ownership: { kind: "task", taskId: api.taskId },
                }),
              context,
            );
            const child = await api.conversation(record.id, context);
            if (child === undefined) throw new Error("the child exists");
            const settled = await (
              await child.submit(
                { type: "input", content: "child turn" },
                context,
              )
            ).wait(context);
            children.push({ record, settled });
            return { content: [{ type: "text", text: settled.status }] };
          },
        }),
      ],
    }),
  );
  const { harness, routes, conversation } = await open(
    new MemoryStorage(),
    models,
    dispatchingProvider(built, served, (transcript) =>
      transcript.messages.at(-1)?.role === "toolResult"
        ? fauxAssistantMessage("delegated")
        : fauxAssistantMessage(fauxToolCall("delegate", {}), {
            stopReason: "toolUse",
          }),
    ),
    registry,
  );
  const parent = await conversation();
  const parentRef = await routes.bindAgentRoute(
    {
      conversationId: parent.id,
      stage: "find",
      agent: "investigator-1",
      route: SOL_ROUTE,
    },
    context,
  );
  await parent.configure({ model: parentRef }, context);
  const answered = await (
    await parent.submit({ type: "input", content: "delegate" }, context)
  ).wait(context);
  expect(answered.status).toBe("done");

  const parentTurn: Served = {
    provider: parentRef.provider,
    agent: "investigator-1",
    conversationId: parent.id,
    mode: "normal",
  };
  expect(served).toEqual([parentTurn, parentTurn]);
  expect(delegations).toBe(1);
  expect(children.length).toBe(1);
  const [{ record, settled }] = children as [(typeof children)[number]];
  expect(record.owner?.conversationId).toBe(parent.id);
  expect(record.parent).toBeUndefined();
  expect(settled.status).toBe("unanswered");
  expect(settled.reason).toBe("no_model");
  expect(built.map(({ binding }) => binding.agent)).toEqual(["investigator-1"]);

  const child = await harness.conversation(record.id, context);
  if (child === undefined) throw new Error("the child exists");
  expect((await child.agent(context)).model).toBeUndefined();
  expect(
    lastAssistant((await child.context(context)).messages),
  ).toBeUndefined();
  await expect(routes.readBinding(child.id, context)).rejects.toThrow(
    `Conversation ${child.id} has no agent route`,
  );

  const childRef = await routes.bindAgentRoute(
    {
      conversationId: child.id,
      stage: "find",
      agent: "investigator-1-child",
      route: SOL_ROUTE,
    },
    context,
  );
  expect(childRef.provider).toBe(`neuve-route:run-1:${child.id}`);
  await child.configure({ model: childRef }, context);
  const bound = await (
    await child.submit({ type: "input", content: "bound child turn" }, context)
  ).wait(context);
  expect(bound.status).toBe("done");
  expect(served.at(-1)).toEqual({
    provider: childRef.provider,
    agent: "investigator-1-child",
    conversationId: child.id,
    mode: "normal",
  });
  expect(lastAssistant((await child.context(context)).messages)?.provider).toBe(
    childRef.provider,
  );

  await harness.close(context);
});
