import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { z } from "zod";
import { storedOutput } from "../../../src/pipeline.ts";
import {
  world as stageWorld,
  settled as stageSettled,
} from "../stages/fixture.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  type AssistantMessage,
  type MutableModels,
} from "@earendil-works/pi-ai";
import {
  Harness,
  MemoryStorage,
  createRegistry,
  defineExtension,
  defineTool,
  section,
  type Conversation,
  type ConversationId,
  type Storage,
} from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { conversationId } from "../../../src/pi/providers/wire.ts";
import { SOL_ROUTE } from "../../../src/route.ts";
import type { Json, ModelCaptureEvent } from "../../../src/pi/capture/types.ts";
import type { AgentRouteBinding } from "../../../src/pi/contracts.ts";
import {
  createAgentRouteProvider,
  routeToolArguments,
} from "../../../src/pi/providers/agent-route-provider.ts";
import { routeFailureOfSubmission } from "../../../src/pi/providers/failure.ts";
import {
  completed,
  created,
  functionCallItem,
  messageItem,
  openEndpoint,
  reasoningItem,
  schema,
  sse,
  tokenCommand,
  type Received,
} from "./fixture.ts";

// pi's own Harness drives each agent conversation: its generation task asks `Models` for the
// conversation's model ref, so the route's provider is reached only through its registration. The
// endpoint stands in for the provider at the route's real address (`https://api.openai.com/v1`).

const context = BACKGROUND_CONTEXT;
const endpoint = openEndpoint();
afterAll(() => endpoint.stop());
const scratch = mkdtempSync(join(tmpdir(), "agent-route-harness-"));
const token = tokenCommand(scratch, "lease");

test("the production stage executes its tool and reads its final provider output", async () => {
  const stageEndpoint = openEndpoint();
  const run = await stageWorld(
    "production-route-final",
    1,
    false,
    false,
    "openai-responses",
    {
      route: SOL_ROUTE,
      fetch: stageEndpoint.fetch,
      auth: { tokenCommand: token.path },
    },
  );
  stageEndpoint.respond(
    () =>
      sse([
        created("resp_stage_1"),
        ...functionCallItem(0, {
          id: "fc_stage_1",
          callId: "call_stage_1",
          name: "probe",
          arguments: '{"n":3}',
        }),
        completed("resp_stage_1"),
      ]),
    () =>
      sse([
        created("resp_stage_final"),
        ...messageItem(
          0,
          "msg_stage_final",
          "final_answer",
          '{"answer":7,"note":null,"parts":[{"label":null,"weight":null}]}',
        ),
        completed("resp_stage_final"),
      ]),
  );
  const opened = await run.open();
  try {
    const id = await run.start(opened);
    opened.harness.resume();
    const record = await stageSettled(opened.harness, id);
    const output = await Effect.runPromise(
      storedOutput(
        run.ctx,
        record.key!,
        z.strictObject({ status: z.string(), output: z.unknown() }),
      ),
    );
    expect(run.probes).toEqual([{ n: 3 }]);
    expect(output).toEqual({
      status: "final-generation",
      output: { answer: 7, parts: [{ weight: null }] },
    });
    expect(run.backstops).toEqual([]);
  } finally {
    await opened.harness.close(context);
    stageEndpoint.stop();
  }
});

const PARAMETERS = schema({
  type: "object",
  properties: { path: { type: "string" }, note: { type: "string" } },
  required: ["path"],
});
const executed: Array<{ readonly args: unknown }> = [];
const submit = defineTool({
  name: "submit",
  description: "Submit.",
  parameters: PARAMETERS,
  constrainedSampling: { type: "json_schema", strict: "require" },
  prepareArguments: (args) => routeToolArguments(SOL_ROUTE)?.(args, PARAMETERS),
  execute: async (args) => {
    executed.push({ args });
    return { content: [{ type: "text", text: "ok" }] };
  },
});
const registry = createRegistry();
registry.install(
  defineExtension({
    name: "review",
    tools: [submit],
    sections: [section("preamble", () => "You review.", { tag: false })],
  }),
);

const FINAL_SCHEMA = {
  type: "object",
  properties: { verdict: { type: "string" }, reason: { type: "string" } },
  required: ["verdict"],
};
const RAW_ARGUMENTS = '{"path": "a.ts", "note": null}';

/** The provider's three answers to one agent: a tool call, its answer, then the final generation. */
const answers = (tag: string, wait = 0) => [
  () =>
    sse([
      created(`resp_${tag}_1`),
      wait,
      ...reasoningItem(0, `rs_${tag}_1`, `enc-${tag}-1`),
      ...messageItem(1, `msg_${tag}_1`, "commentary", "Checking."),
      ...functionCallItem(2, {
        id: `fc_${tag}_1`,
        callId: `call_${tag}_1`,
        name: "submit",
        arguments: RAW_ARGUMENTS,
      }),
      completed(`resp_${tag}_1`),
    ]),
  () =>
    sse([
      created(`resp_${tag}_2`),
      wait,
      ...reasoningItem(0, `rs_${tag}_2`, `enc-${tag}-2`),
      ...messageItem(1, `msg_${tag}_2`, "final_answer", "Done."),
      completed(`resp_${tag}_2`),
    ]),
  () =>
    sse([
      created(`resp_${tag}_3`),
      wait,
      ...messageItem(
        0,
        `msg_${tag}_3`,
        "final_answer",
        '{"verdict":"clean","reason":null}',
      ),
      completed(`resp_${tag}_3`),
    ]),
];

const userItem = (text: string) => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
});
const assistantItem = (phase: string, text: string) => ({
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text, annotations: [] }],
  phase,
});

/** The final generation's input: both turns' encrypted reasoning, phases and the tool round, replayed. */
const finalInput = (tag: string) => [
  userItem("Review it."),
  {
    type: "reasoning",
    id: `rs_${tag}_1`,
    summary: [],
    encrypted_content: `enc-${tag}-1`,
  },
  assistantItem("commentary", "Checking."),
  {
    type: "function_call",
    call_id: `call_${tag}_1`,
    name: "submit",
    namespace: "neuve",
    arguments: '{"path":"a.ts","note":null}',
  },
  { type: "function_call_output", call_id: `call_${tag}_1`, output: "ok" },
  {
    type: "reasoning",
    id: `rs_${tag}_2`,
    summary: [],
    encrypted_content: `enc-${tag}-2`,
  },
  assistantItem("final_answer", "Done."),
  userItem("Return the verdict as JSON."),
];

const FINAL_FORMAT = {
  format: {
    type: "json_schema",
    name: "stage_output",
    strict: true,
    schema: {
      type: "object",
      properties: {
        verdict: { type: "string" },
        reason: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
      required: ["verdict", "reason"],
      additionalProperties: false,
    },
  },
};

/** A stand-in for the runtime's AgentRouteDoc: bindings persisted by conversation, read at every dispatch. */
const bindingStore = (path: string) => {
  const read = async (): Promise<Record<string, AgentRouteBinding>> =>
    existsSync(path)
      ? (JSON.parse(await readFile(path, "utf8")) as Record<
          string,
          AgentRouteBinding
        >)
      : {};
  return {
    put: async (binding: AgentRouteBinding) => {
      const all = await read();
      all[String(binding.conversationId)] = binding;
      await writeFile(path, JSON.stringify(all));
    },
    get: async (id: ConversationId) => {
      const binding = (await read())[String(id)];
      if (binding === undefined)
        throw new Error(`conversation ${id} has no agent route`);
      return binding;
    },
    all: async () => Object.values(await read()),
  };
};
type BindingStore = ReturnType<typeof bindingStore>;

/** One run: pi's Models with the routes registered, the Harness over its storage, and its captures. */
const openRun = async (storage: Storage, store: BindingStore) => {
  const models = createModels();
  const captured: Array<ModelCaptureEvent> = [];
  const register = (logicalProvider: string, id: ConversationId) =>
    models.setProvider(
      createAgentRouteProvider({
        credentialInspection: "ephemeral" as const,
        route: SOL_ROUTE,
        auth: { tokenCommand: token.path },
        fetch: endpoint.fetch,
        capture: (event) => captured.push(event),
        logicalProvider,
        readBinding: () => store.get(id),
      }),
    );
  for (const binding of await store.all())
    register(binding.logicalProvider, binding.conversationId);
  const harness = await Harness.open(
    storage,
    { models, registry, settings: { retry: { maxRetries: 0 } } },
    context,
  );
  return { harness, models, captured, register };
};

/** The runtime's bindAgentRoute, as far as this provider needs it: commit, then register. */
const bind = async (
  run: Awaited<ReturnType<typeof openRun>>,
  store: BindingStore,
  input: {
    readonly runId: string;
    readonly agent: string;
    readonly logicalProvider: string;
  },
) => {
  const conversation = await run.harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent: {
        model: { provider: input.logicalProvider, modelId: SOL_ROUTE.model },
      },
    },
    context,
  );
  const binding: AgentRouteBinding = {
    runId: input.runId,
    stage: "find",
    agent: input.agent,
    conversationId: conversation.id,
    logicalProvider: input.logicalProvider,
    physicalProvider: "openai",
    physicalModel: SOL_ROUTE.model,
    mode: { kind: "normal" },
  };
  await store.put(binding);
  run.register(input.logicalProvider, conversation.id);
  return { conversation, binding };
};

const ask = async (conversation: Conversation, content: string) => {
  const submission = await conversation.submit(
    { type: "input", content },
    context,
  );
  return submission.wait(context);
};

const assistants = async (conversation: Conversation) =>
  (await conversation.context(context)).messages.filter(
    (message): message is AssistantMessage => message.role === "assistant",
  );

/** One agent's review: a tool round, then the final generation once the runtime commits final mode. */
const review = async (
  conversation: Conversation,
  store: BindingStore,
  binding: AgentRouteBinding,
) => {
  expect((await ask(conversation, "Review it.")).status).toBe("done");
  await store.put({
    ...binding,
    mode: { kind: "final", schema: FINAL_SCHEMA },
  });
  expect((await ask(conversation, "Return the verdict as JSON.")).status).toBe(
    "done",
  );
};

const sentBy = (runId: string, agent: string) =>
  endpoint.received.filter(
    (request) =>
      request.headers.get("session-id") === conversationId(runId, agent),
  );

const headerNames = (request: Received) => [...request.headers.keys()].sort();

describe("an agent conversation on its logical route", () => {
  test("sends what the physical route sends, and keeps reasoning and phase through the final generation", async () => {
    executed.length = 0;
    const canonicalStore = bindingStore(join(scratch, "canonical.json"));
    const canonical = await openRun(new MemoryStorage(), canonicalStore);
    endpoint.respondTo(
      conversationId("run-c", "investigate-1"),
      ...answers("a"),
    );
    const physical = await bind(canonical, canonicalStore, {
      runId: "run-c",
      agent: "investigate-1",
      logicalProvider: "openai",
    });
    await review(physical.conversation, canonicalStore, physical.binding);

    const routedStore = bindingStore(join(scratch, "routed.json"));
    const routed = await openRun(new MemoryStorage(), routedStore);
    const LOGICAL = "agent-route.run-r.investigate-1";
    endpoint.respondTo(
      conversationId("run-r", "investigate-1"),
      ...answers("a"),
    );
    const logical = await bind(routed, routedStore, {
      runId: "run-r",
      agent: "investigate-1",
      logicalProvider: LOGICAL,
    });
    await review(logical.conversation, routedStore, logical.binding);

    const physicalWire = sentBy("run-c", "investigate-1");
    const logicalWire = sentBy("run-r", "investigate-1");
    expect(logicalWire).toHaveLength(3);
    expect(logicalWire.map((request) => request.body)).toEqual(
      physicalWire.map((request) => request.body),
    );
    expect(logicalWire.map(headerNames)).toEqual(physicalWire.map(headerNames));
    expect(logicalWire.map((request) => request.path)).toEqual([
      "/v1/responses",
      "/v1/responses",
      "/v1/responses",
    ]);

    const [first, second, last] = logicalWire.map((request) => request.body);
    expect(first).toMatchObject({
      model: "gpt-6.1-sol",
      instructions: "You review.",
      input: [userItem("Review it.")],
      tool_choice: "auto",
      store: false,
    });
    expect(second!["input"]).toEqual(finalInput("a").slice(0, 5));
    expect(second!["tool_choice"]).toBe("auto");
    expect(last!["input"]).toEqual(finalInput("a"));
    expect(last!["tool_choice"]).toBe("none");
    expect(last!["text"]).toEqual(FINAL_FORMAT);
    expect(last!["model"]).toBe("gpt-6.1-sol");

    const replies = await assistants(logical.conversation);
    expect(replies.map((message) => [message.provider, message.model])).toEqual(
      [
        [LOGICAL, "gpt-6.1-sol"],
        [LOGICAL, "gpt-6.1-sol"],
        [LOGICAL, "gpt-6.1-sol"],
      ],
    );
    expect(
      (await assistants(physical.conversation)).map(
        (message) => message.provider,
      ),
    ).toEqual(["openai", "openai", "openai"]);
    const call = replies[0]!.content.find((block) => block.type === "toolCall");
    expect(call?.type === "toolCall" ? call.arguments : undefined).toEqual({
      path: "a.ts",
      note: null,
    });
    expect(executed.map((entry) => entry.args)).toEqual([
      { path: "a.ts" },
      { path: "a.ts" },
    ]);
    const answer = replies[2]!.content.find((block) => block.type === "text");
    expect(JSON.parse(answer?.type === "text" ? answer.text : "")).toEqual({
      verdict: "clean",
      reason: null,
    });

    const requests = routed.captured.filter(
      (event) => event.type === "model.request",
    );
    expect(
      requests.map((event) => [event.scope, event.provider, event.model]),
    ).toEqual(
      Array(3).fill([
        {
          runId: "run-r",
          stage: "find",
          agent: "investigate-1",
          conversationId: logical.conversation.id,
        },
        "openai",
        "gpt-6.1-sol",
      ]),
    );
    expect(requests.map((event) => event.logicalRoute)).toEqual(
      Array(3).fill(LOGICAL),
    );
    expect(requests.map((event) => event.body)).toEqual(
      logicalWire.map((request) => ({
        status: "sent" as const,
        json: request.body as Json,
      })),
    );
    const ends = routed.captured.filter((event) => event.type === "model.end");
    expect(
      ends.map((event) => [event.responseId, event.messageTimestamp]),
    ).toEqual(
      replies.map((message) => [message.responseId, message.timestamp]),
    );
    await canonical.harness.close(context);
    await routed.harness.close(context);
  });

  test("keeps two concurrent agents' bindings, requests and captures apart", async () => {
    const store = bindingStore(join(scratch, "concurrent.json"));
    const run = await openRun(new MemoryStorage(), store);
    endpoint.respondTo(
      conversationId("run-2", "investigate-1"),
      ...answers("x", 40),
    );
    endpoint.respondTo(
      conversationId("run-2", "investigate-2"),
      ...answers("y", 15),
    );
    const one = await bind(run, store, {
      runId: "run-2",
      agent: "investigate-1",
      logicalProvider: "agent-route.run-2.investigate-1",
    });
    const two = await bind(run, store, {
      runId: "run-2",
      agent: "investigate-2",
      logicalProvider: "agent-route.run-2.investigate-2",
    });

    await Promise.all([
      review(one.conversation, store, one.binding),
      review(two.conversation, store, two.binding),
    ]);

    const wireOne = sentBy("run-2", "investigate-1");
    const wireTwo = sentBy("run-2", "investigate-2");
    expect(wireOne.at(-1)!.body["input"]).toEqual(finalInput("x"));
    expect(wireTwo.at(-1)!.body["input"]).toEqual(finalInput("y"));
    expect(
      JSON.stringify(wireOne.map((request) => request.body)),
    ).not.toContain("enc-y");
    expect(
      JSON.stringify(wireTwo.map((request) => request.body)),
    ).not.toContain("enc-x");
    expect(
      (await assistants(two.conversation)).map((message) => message.provider),
    ).toEqual(Array(3).fill("agent-route.run-2.investigate-2"));

    const attributed = run.captured
      .filter((event) => event.type === "model.end")
      .map((event) => [event.scope.agent, event.responseId]);
    expect(attributed.toSorted()).toEqual(
      [
        ["investigate-1", "resp_x_1"],
        ["investigate-1", "resp_x_2"],
        ["investigate-1", "resp_x_3"],
        ["investigate-2", "resp_y_1"],
        ["investigate-2", "resp_y_2"],
        ["investigate-2", "resp_y_3"],
      ].toSorted(),
    );
    await run.harness.close(context);
  });

  test("continues after a restart from the persisted bindings, final generation included", async () => {
    const directory = join(scratch, "restart");
    const store = bindingStore(join(scratch, "restart.json"));
    const LOGICAL = "agent-route.run-3.investigate-1";
    endpoint.respondTo(
      conversationId("run-3", "investigate-1"),
      ...answers("z"),
    );

    const before = await openRun(
      await openNodeJsonlStorage(directory, context),
      store,
    );
    const { conversation, binding } = await bind(before, store, {
      runId: "run-3",
      agent: "investigate-1",
      logicalProvider: LOGICAL,
    });
    expect((await ask(conversation, "Review it.")).status).toBe("done");
    await before.harness.close(context);

    const after = await openRun(
      await openNodeJsonlStorage(directory, context),
      store,
    );
    expect(after.models.getModel(LOGICAL, SOL_ROUTE.model)).toMatchObject({
      provider: LOGICAL,
      id: "gpt-6.1-sol",
    });
    after.harness.resume();
    const reopened = (await after.harness.conversation(
      conversation.id,
      context,
    ))!;
    await store.put({
      ...binding,
      mode: { kind: "final", schema: FINAL_SCHEMA },
    });
    expect((await ask(reopened, "Return the verdict as JSON.")).status).toBe(
      "done",
    );

    const last = sentBy("run-3", "investigate-1").at(-1)!.body;
    expect(last["input"]).toEqual(finalInput("z"));
    expect(last["tool_choice"]).toBe("none");
    expect(last["text"]).toEqual(FINAL_FORMAT);
    expect(
      after.captured.find((event) => event.type === "model.request"),
    ).toMatchObject({
      scope: { runId: "run-3", agent: "investigate-1" },
      provider: "openai",
      model: "gpt-6.1-sol",
    });
    await after.harness.close(context);
  });

  test("replays encrypted reasoning without its readable summary, through the final generation and a restart", async () => {
    const SUMMARY = "Synthetic summary: compare the two hunks.";
    const reasoning = (index: number, id: string, encrypted: string) => [
      {
        type: "response.output_item.added",
        output_index: index,
        item: { type: "reasoning", id, summary: [] },
      },
      {
        type: "response.reasoning_summary_text.delta",
        output_index: index,
        summary_index: 0,
        delta: SUMMARY,
      },
      {
        type: "response.reasoning_summary_part.done",
        output_index: index,
        summary_index: 0,
        part: { type: "summary_text", text: SUMMARY },
      },
      {
        type: "response.output_item.done",
        output_index: index,
        item: {
          type: "reasoning",
          id,
          summary: [{ type: "summary_text", text: SUMMARY }],
          encrypted_content: encrypted,
        },
      },
    ];
    const directory = join(scratch, "summary");
    const store = bindingStore(join(scratch, "summary.json"));
    const LOGICAL = "agent-route.run-5.investigate-1";
    endpoint.respondTo(
      conversationId("run-5", "investigate-1"),
      () =>
        sse([
          created("resp_s_1"),
          ...reasoning(0, "rs_s_1", "enc-opaque-1=="),
          ...functionCallItem(1, {
            id: "fc_s_1",
            callId: "call_s_1",
            name: "submit",
            arguments: RAW_ARGUMENTS,
          }),
          completed("resp_s_1"),
        ]),
      () =>
        sse([
          created("resp_s_2"),
          ...reasoning(0, "rs_s_2", "enc-opaque-2=="),
          ...messageItem(1, "msg_s_2", "final_answer", "Done."),
          completed("resp_s_2"),
        ]),
      () =>
        sse([
          created("resp_s_3"),
          ...messageItem(0, "msg_s_3", "final_answer", '{"verdict":"clean"}'),
          completed("resp_s_3"),
        ]),
    );

    const before = await openRun(
      await openNodeJsonlStorage(directory, context),
      store,
    );
    const { conversation, binding } = await bind(before, store, {
      runId: "run-5",
      agent: "investigate-1",
      logicalProvider: LOGICAL,
    });
    expect((await ask(conversation, "Review it.")).status).toBe("done");
    const thinking = (await assistants(conversation)).flatMap((message) =>
      message.content.filter((block) => block.type === "thinking"),
    );
    expect(thinking.map((block) => block.thinking)).toEqual([SUMMARY, SUMMARY]);
    await before.harness.close(context);

    const after = await openRun(
      await openNodeJsonlStorage(directory, context),
      store,
    );
    after.harness.resume();
    const reopened = (await after.harness.conversation(
      conversation.id,
      context,
    ))!;
    await store.put({
      ...binding,
      mode: { kind: "final", schema: FINAL_SCHEMA },
    });
    expect((await ask(reopened, "Return the verdict as JSON.")).status).toBe(
      "done",
    );

    const sent = sentBy("run-5", "investigate-1").map(
      (request) => request.body,
    );
    expect(sent).toHaveLength(3);
    const replayed = (body: Record<string, unknown>) =>
      (body["input"] as Array<Record<string, unknown>>).filter(
        (item) => item["type"] === "reasoning",
      );
    expect(replayed(sent[1]!)).toEqual([
      {
        type: "reasoning",
        id: "rs_s_1",
        summary: [],
        encrypted_content: "enc-opaque-1==",
      },
    ]);
    expect(replayed(sent[2]!)).toEqual([
      {
        type: "reasoning",
        id: "rs_s_1",
        summary: [],
        encrypted_content: "enc-opaque-1==",
      },
      {
        type: "reasoning",
        id: "rs_s_2",
        summary: [],
        encrypted_content: "enc-opaque-2==",
      },
    ]);
    expect(sent[2]!["tool_choice"]).toBe("none");
    for (const body of sent)
      expect(JSON.stringify(body).includes(SUMMARY)).toBe(false);

    const kept = [...before.captured, ...after.captured].filter(
      (event) =>
        event.type === "model.event" &&
        event.name === "response.output_item.done" &&
        (event.data as { item: { type: string } }).item.type === "reasoning",
    );
    expect(
      kept.map((event) =>
        event.type === "model.event" ? event.data : null,
      ) as unknown,
    ).toEqual([
      reasoning(0, "rs_s_1", "enc-opaque-1==")[3],
      reasoning(0, "rs_s_2", "enc-opaque-2==")[3],
    ]);
    await after.harness.close(context);
  });

  test("an agent without a binding fails visibly and sends nothing", async () => {
    const store = bindingStore(join(scratch, "missing.json"));
    const run = await openRun(new MemoryStorage(), store);
    const LOGICAL = "agent-route.run-4.investigate-1";
    const conversation = await run.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: { provider: LOGICAL, modelId: SOL_ROUTE.model } },
      },
      context,
    );
    run.register(LOGICAL, conversation.id);
    const sent = endpoint.received.length;

    const settled = await ask(conversation, "Review it.");

    expect(settled.status).toBe("unanswered");
    expect(endpoint.received.length).toBe(sent);
    expect(run.captured).toEqual([]);
    expect((await assistants(conversation)).map((m) => m.errorMessage)).toEqual(
      [],
    );
    expect(settled.detail).toBe(
      "OpenAI API error: the agent route binding is missing or names another route",
    );
    expect(
      await routeFailureOfSubmission(conversation, settled, context),
    ).toEqual({
      kind: "binding",
      detail: `agent route binding unavailable for ${LOGICAL}: conversation ${conversation.id} has no agent route`,
    });
    await run.harness.close(context);
  });
});
