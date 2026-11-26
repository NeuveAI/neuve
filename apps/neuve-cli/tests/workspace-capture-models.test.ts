import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, type Message } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import {
  CaptureFailed,
  codingRouteLimits,
  type RouteModelsOptions,
} from "@neuve/harness/coding";
import { SOL_ROUTE } from "../../../packages/harness/src/route.ts";
import { routeFailureOf } from "../../../packages/harness/src/pi/providers/failure.ts";
import {
  created,
  sse,
  tokenCommand,
} from "../../../packages/harness/tests/pi/providers/fixture.ts";
import { workspaceCaptureModels } from "../src/workspace-capture-models.ts";

test.each([
  { window: 100_000, percent: 80, usable: 80_000 },
  { window: 500_000, percent: undefined, usable: 475_000 },
])("account catalogue supplies $usable tokens", async (row) => {
  const { window, percent, usable } = row;
  const scratch = mkdtempSync(join(tmpdir(), "workspace-model-limits-"));
  try {
    const token = tokenCommand(scratch, "lease");
    const observed: Readonly<Record<string, unknown>>[] = [];
    const transport = {
      auth: { tokenCommand: token.path },
      fetch: Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          expect(request.url).toBe("https://api.openai.com/v1/models");
          expect(request.headers.get("authorization")).toBe("Bearer tok-1");
          return Response.json({
            models: [
              { slug: "other", context_window: 1_000_000 },
              {
                slug: SOL_ROUTE.model,
                context_window: window,
                effective_context_window_percent: percent,
              },
            ],
          });
        },
        { preconnect: () => {} },
      ),
    };
    const route = await codingRouteLimits(SOL_ROUTE, transport, (limits) =>
      observed.push(limits),
    );
    const model = workspaceCaptureModels(createModels(), {
      ...transport,
      route,
      runId: "limits",
      sessionAffinity: "limits",
      credentialInspection: "ephemeral",
      capture: () => {},
    }).getModel("openai", SOL_ROUTE.model);
    expect(model).toMatchObject({
      contextWindow: usable,
      maxTokens: 128_000,
    });
    expect(observed).toEqual([
      {
        account: "chatgpt",
        model: "gpt-6.1-sol",
        contextWindow: usable,
        maxOutputTokens: 128_000,
        contextSource: "account-catalog",
        outputSource: "configured-route",
      },
    ]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a missing ChatGPT sign-in leaves the configured route limits in place", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workspace-model-limits-"));
  try {
    const observed: Readonly<Record<string, unknown>>[] = [];
    const route = await codingRouteLimits(
      SOL_ROUTE,
      { auth: { directory, tokenCommand: null } },
      (limits) => observed.push(limits),
    );
    expect(route).toEqual(SOL_ROUTE);
    expect(observed).toEqual([
      {
        account: "chatgpt",
        model: "gpt-6.1-sol",
        contextWindow: 475_000,
        maxOutputTokens: 128_000,
        contextSource: "configured-route",
        outputSource: "configured-route",
      },
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("another OpenAI model stays executable and reports its native capture gap", async () => {
  const native = createModels();
  const provider = fauxProvider({
    provider: "openai",
    models: [{ id: "other-openai" }],
  });
  native.setProvider(provider.provider);
  provider.setResponses([fauxAssistantMessage("Original Ace model path")]);
  const events: Array<Parameters<RouteModelsOptions["capture"]>[0]> = [];
  const models = workspaceCaptureModels(native, {
    route: SOL_ROUTE,
    runId: "workspace-native-model-fixture",
    sessionAffinity: "workspace-native-model-fixture",
    capture: (event) => events.push(event),
    credentialInspection: "ephemeral",
  });
  const model = models.getModel("openai", "other-openai");
  if (!model) throw new Error("Native OpenAI model disappeared");
  const response = await models.completeSimple(model, { messages: [] });
  expect(response.content).toEqual([
    { type: "text", text: "Original Ace model path" },
  ]);
  expect(
    events.some(
      (event) =>
        event.type === "model.event" && event.name === "native_capture_gap",
    ),
  ).toBe(true);
  expect(
    events.some(
      (event) =>
        event.type === "model.request" && event.body.status === "missing",
    ),
  ).toBe(true);
  expect(models.getModel("openai", "gpt-6.1-sol")?.id).toBe("gpt-6.1-sol");
});

test("only a provider breakoff near the last measured limit becomes an overflow", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "workspace-context-overflow-"));
  const token = tokenCommand(scratch, "lease");
  let captureFull = false;
  let sent = 0;
  const models = workspaceCaptureModels(createModels(), {
    route: SOL_ROUTE,
    auth: { tokenCommand: token.path },
    runId: "workspace-context-overflow",
    sessionAffinity: "workspace-context-overflow",
    credentialInspection: "ephemeral",
    capture: (event) => {
      if (captureFull && event.type === "model.request")
        throw new CaptureFailed({
          kind: "full",
          event: event.type,
          detail: "fixture capture is full",
        });
    },
    fetch: Object.assign(
      async () => {
        sent++;
        return sse([created("unfinished"), { type: "unexpected.frame" }]);
      },
      { preconnect: () => {} },
    ),
  });
  try {
    const model = models.getModel("openai", SOL_ROUTE.model);
    if (!model) throw new Error("Missing plan model");
    expect(model.contextWindow).toBe(475_000);
    const turn = (tokens: number, compactedAt?: number) => {
      const previous = fauxAssistantMessage("Previous answer", {
        timestamp: 2,
      });
      const messages: Message[] = [
        { role: "user", content: "First question", timestamp: 1 },
        {
          ...previous,
          model: model.id,
          provider: model.provider,
          api: model.api,
          usage: { ...previous.usage, input: tokens, totalTokens: tokens },
        },
        { role: "user", content: "Next question", timestamp: 4 },
      ];
      if (compactedAt !== undefined)
        messages.unshift({
          role: "user",
          content: [
            {
              type: "text",
              text: "The conversation history before this point was compacted into the following summary:\n\n<summary>\nEarlier chat.\n</summary>",
            },
          ],
          timestamp: compactedAt,
        });
      return models.completeSimple(model, { messages });
    };
    expect(routeFailureOf(await turn(200_000))?.kind).toBe("stream");
    expect(routeFailureOf(await turn(460_000))?.kind).toBe("context_overflow");
    expect(routeFailureOf(await turn(460_000, 3))?.kind).toBe("stream");
    expect(routeFailureOf(await turn(460_000, 1))?.kind).toBe(
      "context_overflow",
    );
    captureFull = true;
    expect(routeFailureOf(await turn(460_000))?.kind).toBe("capture");
    expect(sent).toBe(4);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
