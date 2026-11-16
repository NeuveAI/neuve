// Why: a step's stage key names the effort it runs at, so its requests must carry that effort, not
// the run route's. The provider is built by the attempt's own `bindingProvider`, from a binding and
// from a binding a reopened run restored, and a local HTTP server reads the request bodies each
// route actually received.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  type Api,
  type Model,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import type { ConversationId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { bindingProvider } from "../../../src/pi/attempt.ts";
import {
  agentRoutes,
  clearInheritedAgentRoute,
} from "../../../src/pi/bindings.ts";
import type { AgentRouteBinding } from "../../../src/pi/contracts.ts";
import { OPUS_ROUTE, SOL_ROUTE, type RouteConfig } from "../../../src/route.ts";
import {
  completed,
  created,
  messageItem,
  openEndpoint,
  sse,
  tokenCommand,
} from "./fixture.ts";

const endpoint = openEndpoint();
const scratch = mkdtempSync(join(tmpdir(), "step-effort-wire-"));
afterAll(() => {
  endpoint.stop();
  rmSync(scratch, { recursive: true, force: true });
});

const LOGICAL = "neuve-route:run-1:7";

/** A `high` step's binding on a `medium` route. */
const highBinding = (route: RouteConfig): AgentRouteBinding => ({
  runId: "run-1",
  stage: "verify",
  agent: "assess.1",
  conversationId: 7 as ConversationId,
  logicalProvider: LOGICAL,
  physicalProvider: route.provider,
  physicalModel: route.model,
  effort: "high",
  mode: { kind: "normal" },
});

/** What the attempt gives `bindingProvider`, pointed at the local endpoint. */
const transport = (
  route: RouteConfig,
  extra: { readonly auth?: { readonly tokenCommand: string } },
) => ({
  credentialInspection: "ephemeral" as const,
  baseUrl:
    route.provider === "openai"
      ? `${endpoint.server.url.origin}/v1`
      : endpoint.server.url.origin,
  capture: () => {},
  ...extra,
});

/** One normal turn through the provider the attempt builds for `binding`. */
const send = async (
  route: RouteConfig,
  extra: { readonly auth?: { readonly tokenCommand: string } },
) => {
  const binding = highBinding(route);
  const models = createModels();
  models.setProvider(
    bindingProvider(route, transport(route, extra))(
      binding,
      async () => binding,
    ),
  );
  endpoint.received.length = 0;
  await models.complete(models.getModel(LOGICAL, route.model) as Model<Api>, {
    systemPrompt: "You review.",
    messages: [{ role: "user", content: "Review it.", timestamp: 1 }],
  });
  return endpoint.received[0]!.body;
};

// Reason: the key and the wire must not disagree (OpenAI).
test("a high step on the medium OpenAI route sends high", async () => {
  expect(SOL_ROUTE.effort).toBe("medium");
  const token = tokenCommand(scratch, "step-effort");
  endpoint.respond(() =>
    sse([
      created("resp_1"),
      ...messageItem(0, "msg_1", "final_answer", "ok"),
      completed("resp_1"),
    ]),
  );
  const body = await send(SOL_ROUTE, { auth: { tokenCommand: token.path } });
  expect(body["reasoning"]).toEqual({ effort: "high", context: "all_turns" });
});

// Reason: the key and the wire must not disagree (Anthropic).
test("a high step on the medium Anthropic route sends high", async () => {
  expect(OPUS_ROUTE.effort).toBe("medium");
  const variable = "NEUVE_TEST_STEP_EFFORT_KEY";
  const route = { ...OPUS_ROUTE, credentialVariable: variable };
  endpoint.respond(() =>
    sse([
      {
        type: "message_start",
        message: {
          id: "msg_a",
          type: "message",
          role: "assistant",
          model: route.model,
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
        delta: { type: "text_delta", text: "ok" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 2 },
      },
      { type: "message_stop" },
    ]),
  );
  process.env[variable] = "sk-ant-test-step-effort";
  try {
    const body = await send(route, {});
    expect(body["output_config"]).toEqual({ effort: "high" });
  } finally {
    delete process.env[variable];
  }
});

const openRun = async (path: string, models: MutableModels) => {
  const harness = await Harness.open(
    await openNodeSqliteStorage(path),
    {
      models,
      registry: createRegistry(),
      conversationCreated: clearInheritedAgentRoute,
    },
    context,
  );
  return { harness, models };
};

// Reason: a resumed process must send what the first one sent; this goes from the stored binding,
// through the routes' restore and the attempt's `bindingProvider`, to the request body.
test("a reopened run's provider for a binding stored at high sends high", async () => {
  const path = join(scratch, "stored.sqlite");
  const token = tokenCommand(scratch, "stored");
  const createProvider = bindingProvider(
    SOL_ROUTE,
    transport(SOL_ROUTE, { auth: { tokenCommand: token.path } }),
  );
  const before = await openRun(path, createModels());
  const { id } = await before.harness.createConversation(
    { ownership: { kind: "ownerless" } },
    context,
  );
  const ref = await agentRoutes({
    harness: before.harness,
    models: before.models,
    runId: "run-1",
    createProvider,
  }).bindAgentRoute(
    {
      conversationId: id,
      stage: "verify",
      agent: "assess.1",
      route: SOL_ROUTE,
      effort: "high",
    },
    context,
  );
  await before.harness.close(context);

  const after = await openRun(path, createModels());
  await agentRoutes({
    harness: after.harness,
    models: after.models,
    runId: "run-1",
    createProvider,
  }).restoreAgentRoutes(context);
  endpoint.respond(() =>
    sse([
      created("resp_2"),
      ...messageItem(0, "msg_2", "final_answer", "ok"),
      completed("resp_2"),
    ]),
  );
  endpoint.received.length = 0;
  await after.models.complete(
    after.models.getModel(ref.provider, ref.modelId) as Model<Api>,
    {
      systemPrompt: "You review.",
      messages: [{ role: "user", content: "Review it.", timestamp: 1 }],
    },
  );
  expect(endpoint.received[0]!.body["reasoning"]).toEqual({
    effort: "high",
    context: "all_turns",
  });
  await after.harness.close(context);
});
