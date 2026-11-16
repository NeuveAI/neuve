import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  getSupportedThinkingLevels,
  hasApi,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  Harness,
  MemoryStorage,
  createRegistry,
  type AgentState,
  type ConversationId,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
  OPUS_ROUTE,
  SOL_ROUTE,
  costOf,
  zeroUsage,
} from "../../../src/route.ts";
import type { ModelCaptureEvent } from "../../../src/pi/capture/types.ts";
import {
  createAgentRouteProvider,
  createRouteModels,
  routeModel,
} from "../../../src/pi/providers/agent-route-provider.ts";
import { routeFailureOf } from "../../../src/pi/providers/failure.ts";
import {
  completed,
  created,
  messageItem,
  openEndpoint,
  sse,
  tokenCommand,
} from "./fixture.ts";

const endpoint = openEndpoint();
const scratch = mkdtempSync(join(tmpdir(), "coding-route-metadata-"));
const token = tokenCommand(scratch, "lease");
const context = BACKGROUND_CONTEXT;
const variable = "NEUVE_TEST_ROUTE_METADATA_KEY";
const receipts: Array<unknown> = [];
afterAll(() => {
  endpoint.stop();
  const receipt = process.env["NEUVE_ROUTE_METADATA_RECEIPT"];
  if (receipt !== undefined)
    writeFileSync(receipt, JSON.stringify(receipts, null, 2));
});

const routes = [SOL_ROUTE, { ...OPUS_ROUTE, credentialVariable: variable }];
const input = {
  messages: [{ role: "user" as const, content: "Go.", timestamp: 1 }],
};
const anthropicAnswer = () =>
  sse([
    {
      type: "message_start",
      message: {
        id: "msg_effort",
        type: "message",
        role: "assistant",
        model: OPUS_ROUTE.model,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 0 },
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
      delta: { type: "text_delta", text: "Done." },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ]);
const answer = (provider: string) =>
  provider === "openai"
    ? sse([
        created("resp_effort"),
        ...messageItem(0, "msg_effort", "final_answer", "Done."),
        completed("resp_effort"),
      ])
    : anthropicAnswer();
const effortFrom = (body: Record<string, unknown>, provider: string) =>
  provider === "openai" ? body["reasoning"] : body["output_config"];

// A process isolates import-time effects and the guarded builtins from the rest of the suite.
test("the descriptor imports and runs with file and network access forbidden", async () => {
  const descriptor = new URL(
    "../../../src/pi/providers/route-model.ts",
    import.meta.url,
  ).href;
  const source = `
    import { mock, spyOn } from "bun:test";
    import * as fs from "node:fs";
    import * as fsp from "node:fs/promises";
    const accessed = [];
    const forbidden = (name) => () => { accessed.push(name); throw new Error(name); };
    for (const name of ["readFile", "readFileSync", "open", "openSync", "existsSync", "statSync"])
      spyOn(fs, name).mockImplementation(forbidden(name));
    for (const name of ["readFile", "open", "access", "stat"])
      spyOn(fsp, name).mockImplementation(forbidden(name));
    spyOn(Bun, "file").mockImplementation(forbidden("Bun.file"));
    spyOn(Bun, "spawn").mockImplementation(forbidden("Bun.spawn"));
    spyOn(Bun, "spawnSync").mockImplementation(forbidden("Bun.spawnSync"));
    spyOn(globalThis, "fetch").mockImplementation(forbidden("fetch"));
    const { routeModel } = await import(${JSON.stringify(descriptor)});
    const models = ${JSON.stringify(routes)}.map(routeModel);
    mock.restore();
    process.stdout.write(JSON.stringify({ accessed, identities: models.map(m => [m.provider, m.id]) }));
  `;
  const child = Bun.spawn([process.execPath, "--eval", source], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
  const observed: unknown = JSON.parse(stdout);
  expect(observed).toEqual({
    accessed: [],
    identities: [
      ["openai", SOL_ROUTE.model],
      ["anthropic", OPUS_ROUTE.model],
    ],
  });
  receipts.push({ kind: "pure-descriptor", observed });
});

describe("native route descriptors", () => {
  for (const route of routes) {
    test(`${route.provider} registration uses the same physical descriptor and offers only supported efforts`, () => {
      const captured: Array<ModelCaptureEvent> = [];
      const leases = token.runs();
      const models = createRouteModels({
        credentialInspection: "ephemeral" as const,
        route,
        auth: { tokenCommand: token.path },
        capture: (event) => captured.push(event),
        runId: "metadata",
        sessionAffinity: "metadata",
        fetch: Object.assign(
          () => {
            throw new Error("unexpected fetch");
          },
          { preconnect: globalThis.fetch.preconnect },
        ),
      });
      const descriptor = routeModel(route);
      expect(models.getModel(route.provider, route.model)).toEqual(descriptor);
      expect(getSupportedThinkingLevels(descriptor)).toEqual([
        "low",
        "medium",
        "high",
      ]);
      expect(descriptor).toMatchObject({
        id: route.model,
        provider: route.provider,
        input: ["text"],
        contextWindow: route.window,
        maxTokens: route.maxOutputTokens,
      });
      expect(captured).toEqual([]);
      expect(token.runs()).toBe(leases);
      if (route.provider === "openai") {
        expect(descriptor.cost).toEqual({
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        });
        expect(
          costOf(route, { ...zeroUsage, input: 1_000_000, output: 1_000_000 }),
        ).toBeNull();
      } else {
        expect(descriptor.cost).toEqual({
          input: 4,
          output: 20,
          cacheRead: 0.2,
          cacheWrite: 5,
        });
        expect(
          costOf(route, {
            input: 1_000_000,
            output: 1_000_000,
            cacheRead: 1_000_000,
            cacheWrite5m: 1_000_000,
            cacheWrite1h: 1_000_000,
          }),
        ).toBe(37.2);
      }
      receipts.push({
        kind: "descriptor",
        model: descriptor,
        priceKnown: route.price !== null,
      });
    });
  }
});

describe("coding and review effort at the wire", () => {
  for (const route of routes) {
    test(`${route.provider} coding Models uses selected effort, defaults to the configured route and refuses wider pi levels`, async () => {
      const captured: Array<ModelCaptureEvent> = [];
      const models = createRouteModels({
        credentialInspection: "ephemeral" as const,
        route: { ...route, effort: "high" },
        auth: { tokenCommand: token.path },
        capture: (event) => captured.push(event),
        fetch: endpoint.fetch,
        runId: "effort",
        sessionAffinity: "effort",
      });
      const model = models.getModel(route.provider, route.model)!;
      process.env[variable] = "synthetic-key";
      try {
        for (const effort of [
          "low",
          "medium",
          "high",
          undefined,
        ] satisfies Array<SimpleStreamOptions["reasoning"]>) {
          endpoint.respond(() => answer(route.provider));
          const message = await models.completeSimple(
            model,
            input,
            effort === undefined ? {} : { reasoning: effort },
          );
          expect(message.stopReason).toBe("stop");
          const request = endpoint.received.at(-1)!;
          expect(effortFrom(request.body, route.provider)).toMatchObject({
            effort: effort ?? "high",
          });
          const capturedRequest = captured.findLast(
            (event) => event.type === "model.request",
          );
          expect(capturedRequest).toMatchObject({
            body: { status: "sent", json: request.body },
          });
          receipts.push({
            kind: "coding-models",
            provider: route.provider,
            selected: effort ?? null,
            wire: request.body,
            capture: capturedRequest,
          });
        }
        for (const effort of ["minimal", "xhigh", "max"] satisfies Array<
          SimpleStreamOptions["reasoning"]
        >) {
          const sent = endpoint.received.length;
          const leases = token.runs();
          const message = await models.completeSimple(model, input, {
            reasoning: effort,
          });
          expect(message.stopReason).toBe("error");
          expect(routeFailureOf(message)).toEqual({
            kind: "invalid_request",
            detail: `unsupported route effort ${effort}; choose low, medium or high`,
          });
          expect(endpoint.received.length).toBe(sent);
          expect(token.runs()).toBe(leases);
        }
        endpoint.respond(() => answer(route.provider));
        const raw = hasApi(model, "openai-responses")
          ? await models.complete(model, input, { reasoningEffort: "low" })
          : hasApi(model, "anthropic-messages")
            ? await models.complete(model, input, { effort: "low" })
            : undefined;
        expect(raw?.stopReason).toBe("stop");
        expect(
          effortFrom(endpoint.received.at(-1)!.body, route.provider),
        ).toMatchObject({ effort: "low" });
      } finally {
        delete process.env[variable];
      }
    });

    test(`${route.provider} native Harness forwards each chat's selected effort and the unset chat uses the route default`, async () => {
      const captured: Array<ModelCaptureEvent> = [];
      const models = createRouteModels({
        credentialInspection: "ephemeral" as const,
        route: { ...route, effort: "high" },
        auth: { tokenCommand: token.path },
        capture: (event) => captured.push(event),
        fetch: endpoint.fetch,
        runId: "native-effort",
        sessionAffinity: "native-effort",
      });
      const harness = await Harness.open(
        new MemoryStorage(),
        {
          models,
          registry: createRegistry(),
          env: () => new NodeExecutionEnv({ cwd: scratch }),
          settings: { retry: { maxRetries: 0 } },
        },
        context,
      );
      process.env[variable] = "synthetic-key";
      try {
        for (const effort of [
          "low",
          "medium",
          "high",
          undefined,
        ] satisfies Array<AgentState["thinkingLevel"]>) {
          const conversation = await harness.createConversation(
            {
              ownership: { kind: "ownerless" },
              agent: {
                model: { provider: route.provider, modelId: route.model },
                ...(effort === undefined ? {} : { thinkingLevel: effort }),
              },
            },
            context,
          );
          endpoint.respond(() => answer(route.provider));
          const settled = await (
            await conversation.submit(
              { type: "input", content: "Go." },
              context,
            )
          ).wait(context);
          expect(settled.status).toBe("done");
          const request = endpoint.received.at(-1)!;
          expect(effortFrom(request.body, route.provider)).toMatchObject({
            effort: effort ?? "high",
          });
          receipts.push({
            kind: "coding-harness",
            provider: route.provider,
            selected: effort ?? null,
            wire: request.body,
          });
        }
      } finally {
        delete process.env[variable];
        await harness.close(context);
      }
    });

    test(`${route.provider} review retains configured effort under native and API-specific override attempts`, async () => {
      const models = createModels();
      const captured: Array<ModelCaptureEvent> = [];
      const logical = `review.${route.provider}`;
      models.setProvider(
        createAgentRouteProvider({
          credentialInspection: "ephemeral" as const,
          route: { ...route, effort: "medium" },
          logicalProvider: logical,
          auth: { tokenCommand: token.path },
          capture: (event) => captured.push(event),
          fetch: endpoint.fetch,
          readBinding: async () => ({
            runId: "review-effort",
            stage: "frame",
            agent: "frame",
            conversationId: 1 as ConversationId,
            logicalProvider: logical,
            physicalProvider: route.provider,
            physicalModel: route.model,
            mode: { kind: "normal" },
          }),
        }),
      );
      const model = models.getModel(logical, route.model)!;
      process.env[variable] = "synthetic-key";
      try {
        for (const effort of ["low", "high", "max"] satisfies Array<
          SimpleStreamOptions["reasoning"]
        >) {
          endpoint.respond(() => answer(route.provider));
          const message = await models.completeSimple(model, input, {
            reasoning: effort,
          });
          expect(message.stopReason).toBe("stop");
          const request = endpoint.received.at(-1)!;
          expect(effortFrom(request.body, route.provider)).toMatchObject({
            effort: "medium",
          });
          receipts.push({
            kind: "review-models",
            provider: route.provider,
            selected: effort,
            wire: request.body,
          });
        }
        endpoint.respond(() => answer(route.provider));
        const raw = hasApi(model, "openai-responses")
          ? await models.complete(model, input, { reasoningEffort: "high" })
          : hasApi(model, "anthropic-messages")
            ? await models.complete(model, input, { effort: "high" })
            : undefined;
        expect(raw?.stopReason).toBe("stop");
        expect(
          effortFrom(endpoint.received.at(-1)!.body, route.provider),
        ).toMatchObject({ effort: "medium" });
        const harness = await Harness.open(
          new MemoryStorage(),
          {
            models,
            registry: createRegistry(),
            env: () => new NodeExecutionEnv({ cwd: scratch }),
            settings: { retry: { maxRetries: 0 } },
          },
          context,
        );
        try {
          const conversation = await harness.createConversation(
            {
              ownership: { kind: "ownerless" },
              agent: {
                model: { provider: logical, modelId: route.model },
                thinkingLevel: "high",
              },
            },
            context,
          );
          endpoint.respond(() => answer(route.provider));
          const settled = await (
            await conversation.submit(
              { type: "input", content: "Go." },
              context,
            )
          ).wait(context);
          expect(settled.status).toBe("done");
          const request = endpoint.received.at(-1)!;
          expect(effortFrom(request.body, route.provider)).toMatchObject({
            effort: "medium",
          });
          const capturedRequest = captured.findLast(
            (event) => event.type === "model.request",
          );
          expect(capturedRequest).toMatchObject({
            body: { status: "sent", json: request.body },
          });
          receipts.push({
            kind: "review-harness",
            provider: route.provider,
            selected: "high",
            wire: request.body,
            capture: capturedRequest,
          });
        } finally {
          await harness.close(context);
        }
      } finally {
        delete process.env[variable];
      }
    });
  }
});
