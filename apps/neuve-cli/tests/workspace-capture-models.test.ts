import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config, HostConfigSchema } from "@ace/host/host-config";
import { configureRuntime, runtimeHooks } from "@ace/host/runtime-hooks";
import { openChannel } from "@ace/host/worker-runtime";
import type { Channel } from "@ace/channel";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createModels, type Message } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import {
  CaptureFailed,
  codingRouteLimits,
  openRouteAdmission,
  type RouteModelsOptions,
} from "@neuve/harness/coding";
import { SOL_ROUTE } from "../../../packages/harness/src/route.ts";
import { routeFailureOf } from "../../../packages/harness/src/pi/providers/failure.ts";
import {
  completed,
  created,
  messageItem,
  sse,
  tokenCommand,
} from "../../../packages/harness/tests/pi/providers/fixture.ts";
import { workspaceCaptureModels } from "../src/workspace-capture-models.ts";
import { codingWorkerSetup } from "../src/workspace-worker.ts";

test.each([
  { window: 100_000, percent: 80, usable: 80_000 },
  { window: 500_000, percent: undefined, usable: 475_000 },
])("account catalogue supplies $usable tokens", async (row) => {
  const { window, percent, usable } = row;
  const scratch = mkdtempSync(join(tmpdir(), "workspace-model-limits-"));
  try {
    const token = tokenCommand(scratch, "lease");
    const observed: Readonly<Record<string, unknown>>[] = [];
    const auth = { tokenCommand: token.path };
    const transport = {
      auth,
      admission: openRouteAdmission({
        path: join(scratch, "route-admission.json"),
        route: SOL_ROUTE,
        auth,
      }),
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
    if (!route) throw new Error("Account limits were not resolved");
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
    const auth = { directory, tokenCommand: null };
    const route = await codingRouteLimits(
      SOL_ROUTE,
      {
        auth,
        admission: openRouteAdmission({
          path: join(directory, "route-admission.json"),
          route: SOL_ROUTE,
          auth,
        }),
      },
      (limits) => observed.push(limits),
    );
    expect(route).toBeUndefined();
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

test.each([true, false])(
  "history stays available during catalog lookup and the first run uses its limits (%s)",
  async (available) => {
    // Credential inspection requires a directory outside temporary storage.
    const scratch = mkdtempSync(
      join(import.meta.dir, ".workspace-model-limits-"),
    );
    const previous = { ...config };
    const previousHooks = runtimeHooks();
    const catalog = Promise.withResolvers<Response>();
    const started = Promise.withResolvers<void>();
    let release: (() => void) | undefined;
    let channel: Channel | undefined;
    try {
      const paths = {
        canonicalClone: scratch,
        worktrees: join(scratch, "lanes"),
        state: join(scratch, "state"),
        captures: join(scratch, "captures"),
        cache: join(scratch, "cache"),
        bunCache: join(scratch, "bun-cache"),
        tmp: join(scratch, "tmp"),
        builds: join(scratch, "builds"),
      };
      const stateDirectory = join(paths.state, "channel");
      mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
      mkdirSync(paths.worktrees);
      const model = { provider: "openai", modelId: SOL_ROUTE.model };
      const settings = HostConfigSchema.parse({
        home: paths.state,
        lanes: paths.worktrees,
        user: "person",
        port: 0,
        environment: {},
        worker: [process.execPath],
        model,
      });
      Object.assign(config, settings);
      Reflect.deleteProperty(config, "lanes");
      const worker = { sessionId: "channel", config: settings, stateDirectory };
      const token = tokenCommand(scratch, "lease");
      let lookups = 0;
      let calls = 0;
      const setup = codingWorkerSetup({ paths }, SOL_ROUTE, {
        auth: { tokenCommand: token.path },
        fetch: Object.assign(
          async (input: RequestInfo | URL) => {
            if (
              new URL(
                input instanceof Request ? input.url : String(input),
              ).pathname.endsWith("/models")
            ) {
              lookups++;
              started.resolve();
              return catalog.promise;
            }
            calls++;
            return sse([
              created("first"),
              ...messageItem(0, "answer", "final_answer", "first reply"),
              completed("first"),
            ]);
          },
          { preconnect: () => {} },
        ),
      });
      release = await setup.openSource?.(worker);
      if (!setup.prepareModels) throw new Error("Missing model preparation");
      configureRuntime({
        worker: { models: setup.models, prepareModels: setup.prepareModels },
      });
      const native = createModels();
      channel = await openChannel(
        {
          id: "channel",
          name: "channel",
          owner: "person",
          project: scratch,
          model,
          storage: new MemoryStorage(),
          models: native,
          env: (cwd) => new NodeExecutionEnv({ cwd }),
          directory: {
            self: { id: "channel", name: "channel" },
            list: async () => [],
            deliver: async () => {},
          },
          log: () => {},
        },
        stateDirectory,
      );
      expect(lookups).toBe(0);
      const models = await setup.models(worker, native);
      expect(models.getModel("openai", SOL_ROUTE.model)).toMatchObject({
        contextWindow: 475_000,
        maxTokens: 128_000,
      });

      const send = () => {};
      const ask = channel.handle(
        { op: "ask", author: "person", text: "First" },
        send,
      );
      await started.promise;
      const events: string[] = [];
      const watch = await channel.handle({ op: "watch" }, (event) =>
        events.push(event.kind),
      );
      expect(events).toContain("live");
      expect(await channel.info()).toMatchObject({ name: "channel" });
      expect(calls).toBe(0);

      catalog.resolve(
        available
          ? Response.json({
              models: [
                {
                  slug: SOL_ROUTE.model,
                  context_window: 100_000,
                  effective_context_window_percent: 80,
                  max_output_tokens: 12_000,
                },
              ],
            })
          : new Response(null, { status: 503 }),
      );
      const turn = await ask;
      if (
        !turn ||
        typeof turn !== "object" ||
        !("submission" in turn) ||
        typeof turn.submission !== "number"
      )
        throw new Error("No submission was accepted");
      expect(
        await channel.handle({ op: "wait", submission: turn.submission }, send),
      ).toBe("done");
      const window = available ? 80_000 : 475_000;
      expect((await channel.info()).chats[0]?.context?.window).toBe(window);
      expect(models.getModel("openai", SOL_ROUTE.model)?.maxTokens).toBe(
        available ? 12_000 : 128_000,
      );
      await setup.prepareModels?.(worker);
      expect([lookups, calls]).toEqual([1, 1]);
      if (
        watch &&
        typeof watch === "object" &&
        "stop" in watch &&
        typeof watch.stop === "function"
      )
        await watch.stop();
    } finally {
      catalog.resolve(new Response(null, { status: 503 }));
      await channel?.close();
      release?.();
      configureRuntime(
        Object.defineProperty({}, "worker", {
          value: previousHooks.worker,
          enumerable: true,
        }),
      );
      Reflect.deleteProperty(config, "model");
      Object.assign(config, previous);
      rmSync(scratch, { recursive: true, force: true });
    }
  },
  15_000,
);

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
    route: { ...SOL_ROUTE, window: 100_000 },
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
    expect(model.contextWindow).toBe(100_000);
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
    expect(routeFailureOf(await turn(80_000))?.kind).toBe("stream");
    expect(routeFailureOf(await turn(86_000))?.kind).toBe("context_overflow");
    expect(routeFailureOf(await turn(86_000, 3))?.kind).toBe("stream");
    expect(routeFailureOf(await turn(86_000, 1))?.kind).toBe(
      "context_overflow",
    );
    captureFull = true;
    expect(routeFailureOf(await turn(86_000))?.kind).toBe("capture");
    expect(sent).toBe(4);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
