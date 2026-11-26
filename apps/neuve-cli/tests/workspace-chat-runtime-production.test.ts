import "../../neuve-host/tests/fixtures/memory-secrets.ts";
import { expect, test, spyOn } from "bun:test";
import { z } from "zod";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as fs from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Option, Stream } from "effect";
import {
  AccountName,
  DEFAULT_ACCOUNTS,
  AccountStore,
  TurnLimit,
  type Account,
  type SignInState,
} from "@neuve/runtime";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  MemoryStorage,
  ROOT_CONVERSATION_ID,
  type Harness,
} from "@earendil-works/pi-durable";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai";
import { HostConfigSchema, config } from "@ace/host/host-config";
import { configureRuntime, runtimeHooks } from "@ace/host/runtime-hooks";
import type { WorkerContext } from "@ace/host/worker-runtime";
import type { Channel, ModelRef } from "@ace/channel";
import {
  claudeDefaultModel,
  productionChatSources,
  workspaceChatModels,
  workspaceChatRuntime,
} from "../src/workspace-chat-runtime.ts";
import { SOL_ROUTE } from "../../../packages/harness/src/route.ts";
import { settingsRoute } from "../../../packages/harness/src/request.ts";
import { Settings } from "../../../packages/harness/src/settings.ts";
import { routeCodingDefaults } from "../src/workspace-models.ts";
import { defaultClaudeWorkingFolder } from "@neuve/harness/runtimes";
import { PI_TRANSITION_STORAGE_PROFILE } from "../../../scripts/pi-storage.ts";
import {
  assistant,
  result,
  textDelta,
} from "../../../packages/runtime-claude/tests/frames.ts";
import {
  account as fakeAccount,
  fixture,
  until,
} from "../../../packages/harness/tests/chat-runtime/fixture.ts";
import {
  completed,
  created,
  messageItem,
  sse,
  tokenCommand,
} from "../../../packages/harness/tests/pi/providers/fixture.ts";
import {
  openCaptureJournal,
  readCaptureLosses,
} from "../../../packages/harness/src/pi/capture/journal.ts";

// The host's config is one object for the whole test process, and other test files fill it too:
// each test here replaces every field rather than merging into what an earlier file left.
const replaceConfig = (next: typeof config) => {
  for (const key of Object.keys(config)) Reflect.deleteProperty(config, key);
  Object.assign(config, next);
};

const MarkerEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("started"),
    pid: z.number().int(),
    cwd: z.string(),
    folder: z.string().optional(),
    hasOAuthToken: z.boolean(),
  }),
  z.object({ type: z.literal("exited"), pid: z.number().int() }),
  z.object({ type: z.literal("control"), subtype: z.string() }),
  z.object({
    type: z.literal("prompt"),
    content: z.union([
      z.string(),
      z.array(z.object({ type: z.literal("text"), text: z.string() })),
    ]),
  }),
]);
const markerEvents = (path: string) =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => MarkerEvent.parse(JSON.parse(line)));

function temporary() {
  const root = mkdtempSync(join(tmpdir(), "chat-production-"));
  const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  return {
    root,
    home,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

function saveStatus(
  home: string,
  account: Account,
  signIn: SignInState,
  models: ReadonlyArray<Record<string, unknown>> = [
    { id: "default", displayName: "Test default", description: "Fake model" },
  ],
) {
  const path = AccountStore.statusesPath(home);
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      accounts: [
        {
          name: account.name,
          kind: account.kind,
          identity:
            "folder" in account.credential && account.credential.folder
              ? basename(account.credential.folder)
              : account.name,
          signIn,
          checkedAt: "2025-01-01T00:00:00.000Z",
          limits: [],
          models,
        },
      ],
    }),
    { mode: 0o600 },
  );
}

function fakeClaude(root: string) {
  const executable = join(root, "fake-claude");
  const marker = join(root, "fake-marker.jsonl");
  const reply = assistant(undefined, "Reply from the fake Claude executable");
  writeFileSync(
    executable,
    `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const marker = ${JSON.stringify(marker)};
const record = (event) => appendFileSync(marker, JSON.stringify(event) + '\\n');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
record({type:'started', pid:process.pid, cwd:process.cwd(), folder:process.env.CLAUDE_CONFIG_DIR, hasOAuthToken:process.env.CLAUDE_CODE_OAUTH_TOKEN !== undefined});
process.on('SIGTERM', () => process.exit(0));
process.on('exit', () => record({type:'exited', pid:process.pid}));
const session = process.argv[process.argv.indexOf('--session-id') + 1];
for await (const line of createInterface({input:process.stdin})) {
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    record({type:'control', subtype:message.request.subtype});
    send({type:'control_response', response:{subtype:'success', request_id:message.request_id, response:message.request.subtype === 'initialize' ? {
      commands:[], agents:[], account:{tokenSource:process.env.CLAUDE_CODE_OAUTH_TOKEN === undefined ? 'none' : 'CLAUDE_CODE_OAUTH_TOKEN'},
      models:[{value:'default', displayName:'Test default', description:'Fake model'}]
    } : {}}});
  } else if (message.type === 'user') {
    record({type:'prompt', content:message.message.content});
    send({type:'rate_limit_event', rate_limit_info:{status:'allowed_warning', rateLimitType:'five_hour', utilization:0.9, resetsAt:2000000000}, uuid:crypto.randomUUID(), session_id:session});
    send({...${JSON.stringify(textDelta("Reply from the fake Claude executable"))}, session_id:session});
    send({...${JSON.stringify(reply)}, session_id:session});
    send({...${JSON.stringify(result())}, session_id:session});
  }
}
`,
    { mode: 0o700 },
  );
  return { executable, marker };
}

// Reason: a chat's first limit event must reach the saved account snapshot through production wiring.
test("production sources save the default Claude account's chat limit", async () => {
  const at = temporary();
  const fake = fakeClaude(at.root);
  const previousPath = process.env.PATH;
  const bin = join(at.root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 97\n", { mode: 0o700 });
  process.env.PATH = `${bin}:${previousPath}`;
  const sources = productionChatSources({
    home: at.home,
    claude: { cwd: join(at.root, "work"), executable: fake.executable },
  });
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* sources.registry.openSession(
            AccountName.parse("claude"),
            {
              systemPrompt: "Local test",
              tools: [],
              approvalPolicy: "allow",
              turnLimit: TurnLimit.parse(4),
            },
            { kind: "new" },
          );
          const events = yield* Stream.toPull(session.events);
          yield* session.startTurn({ turnId: "limit", message: "Local turn" });
          const seen = yield* Stream.fromPull(Effect.succeed(events)).pipe(
            Stream.takeUntil((event) => event.type === "turn.finished"),
            Stream.runCollect,
          );
          expect(
            seen.find((event) => event.type === "turn.finished"),
          ).toMatchObject({
            outcome: { status: "completed" },
          });
          expect(
            seen.filter((event) => event.type === "rate-limit"),
          ).toHaveLength(1);
        }),
      ),
    );
    expect(
      sources.statuses.current().find((status) => status.name === "claude")
        ?.limits,
    ).toEqual([
      expect.objectContaining({
        window: "five-hour",
        status: "warning",
        utilization: 0.9,
        resetsAt: "2033-05-18T03:33:20.000Z",
      }),
    ]);
  } finally {
    await sources.close();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    for (const event of existsSync(fake.marker)
      ? markerEvents(fake.marker)
      : [])
      if (event.type === "started")
        expect(() => process.kill(event.pid, 0)).toThrow();
    at.close();
  }
});

// Reason: the production registry and disk status source must drive the worker's real bridge, and sign-out must stop requests.
test("production sources deliver a worker chat through a fake Claude executable and reject the signed-out account", async () => {
  const at = temporary();
  const previousConfig = { ...config };
  const previousHooks = runtimeHooks();
  const previousHome = process.env.HOME;
  const previousPath = process.env.PATH;
  const bin = join(at.root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "tailscale"),
    '#!/bin/sh\necho \'{"BackendState":"Stopped"}\'\n',
    { mode: 0o700 },
  );
  // A lost explicit executable must fail locally, even on a machine with real Claude Code installed.
  writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 97\n", { mode: 0o700 });
  process.env.HOME = at.home;
  process.env.PATH = `${bin}:${previousPath}`;
  const { codingWorkerSetup } = await import("../src/workspace-cli.ts");
  const { openChannel, openWorkerStorage } =
    await import("@ace/host/worker-runtime");
  const fake = fakeClaude(at.root);
  const account = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* AccountStore.make(at.home);
        return yield* store.add("claude", "worker-test");
      }),
    ),
  );
  saveStatus(at.home, account, { state: "signed-in" });
  const sources = productionChatSources({
    home: at.home,
    claude: {
      cwd: defaultClaudeWorkingFolder(at.home),
      executable: fake.executable,
    },
  });
  const paths = {
    ...PI_TRANSITION_STORAGE_PROFILE.paths,
    state: join(at.root, "state"),
    captures: join(at.root, "captures"),
    tmp: join(at.root, "tmp"),
  };
  const stateDirectory = join(paths.state, "worker");
  const lanes = join(at.root, "lanes");
  for (const path of [stateDirectory, paths.captures, paths.tmp, lanes])
    mkdirSync(path, { recursive: true });
  replaceConfig(
    HostConfigSchema.parse({
      home: paths.state,
      lanes,
      user: "person",
      port: 0,
      environment: { HOME: at.home },
      worker: [process.execPath],
    }),
  );
  const setup = codingWorkerSetup(
    { paths },
    SOL_ROUTE,
    {
      fetch: Object.assign(
        async () => {
          throw new Error("No model calls in the production-wiring test");
        },
        { preconnect: () => {} },
      ),
    },
    sources,
  );
  let harness: Harness | undefined;
  // Only the coding model/extension hooks are in this test's worker; no reviews or planning are requested.
  configureRuntime({
    worker: {
      models: setup.models,
      extensions: (worker) => {
        const extension = setup.extensions?.(worker);
        return {
          extensions: extension?.extensions ?? [],
          attach: async (attached) => {
            harness = attached;
            await extension?.attach?.(attached);
          },
        };
      },
      ...(setup.priced ? { priced: setup.priced } : {}),
    },
  });
  const worker: WorkerContext = { sessionId: "worker", config, stateDirectory };
  let channel: Channel | undefined;
  let listing: Awaited<ReturnType<typeof workspaceChatModels>> | undefined;
  // Runtime-only fixture: there is no host catalog or Git project to place chats in.
  Reflect.deleteProperty(config, "lanes");
  const native = createModels();
  const background = fauxProvider({
    provider: "faux",
    models: [{ id: "unused" }],
  });
  native.setProvider(background.provider);
  try {
    expect(existsSync(fake.marker)).toBe(false);
    const storage = await openWorkerStorage(setup, worker, () =>
      openNodeSqliteStorage(join(stateDirectory, "channel.sqlite")),
    );
    channel = await openChannel(
      {
        id: "worker",
        name: "worker",
        owner: "person",
        project: at.root,
        storage,
        models: native,
        resume: false,
        env: (cwd) => new NodeExecutionEnv({ cwd }),
        directory: {
          self: { id: "worker", name: "worker" },
          list: async () => [],
          deliver: async () => {},
        },
        log: () => {},
      },
      stateDirectory,
    );
    await setup.models(worker, native);
    listing = await workspaceChatModels(native, sources);
    expect(listing.current()).toContainEqual({
      provider: account.name,
      modelId: "default",
      efforts: [],
    });
    expect(existsSync(fake.marker)).toBe(false);
    const observed: unknown[] = [];
    await channel.handle({ op: "watch", chat: 1 }, (frame) =>
      observed.push(frame),
    );
    await channel.handle(
      {
        op: "ask",
        author: "person",
        text: "Production worker turn",
        model: { provider: account.name, modelId: "default" },
      },
      () => {},
    );
    if (!harness) throw new Error("Worker did not attach its Harness");
    await harness.waitForIdle(BACKGROUND_CONTEXT);
    await until(() => !channel!.busy);
    const events = markerEvents(fake.marker);
    expect(events.filter((event) => event.type === "started")).toHaveLength(1);
    expect(events.find((event) => event.type === "started")).toMatchObject({
      cwd: defaultClaudeWorkingFolder(at.home),
      folder:
        "folder" in account.credential ? account.credential.folder : undefined,
    });
    expect(events.filter((event) => event.type === "prompt")).toEqual([
      {
        type: "prompt",
        content: [{ type: "text", text: "person: Production worker turn" }],
      },
    ]);
    const conversation = await harness.conversation(
      ROOT_CONVERSATION_ID,
      BACKGROUND_CONTEXT,
    );
    expect(
      (await conversation?.context(BACKGROUND_CONTEXT))?.messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.content),
    ).toEqual([
      [{ type: "text", text: "Reply from the fake Claude executable" }],
    ]);
    await until(() =>
      JSON.stringify(observed).includes(
        "Reply from the fake Claude executable",
      ),
    );
    expect(setup.priced?.({ provider: account.name, modelId: "default" })).toBe(
      false,
    );
    // Reason: the worker's production bridge must persist the same account limit as a direct session.
    expect(
      sources.statuses.current().find((status) => status.name === account.name)
        ?.limits,
    ).toEqual([
      expect.objectContaining({
        window: "five-hour",
        status: "warning",
        utilization: 0.9,
      }),
    ]);
    saveStatus(at.home, account, {
      state: "not-signed-in",
      hint: {
        kind: "command",
        command: "neuve auth login",
        account: account.name,
      },
    });
    expect(listing.current()).toEqual([]);
    await expect(
      channel.handle(
        {
          op: "ask",
          author: "person",
          chat: 1,
          text: "Do not send this",
          model: { provider: account.name, modelId: "default" },
        },
        () => {},
      ),
    ).rejects.toThrow(
      "Sign in for worker-test: run neuve auth login worker-test on this machine, then send your message again.",
    );
    expect(
      markerEvents(fake.marker).filter((event) => event.type === "prompt"),
    ).toHaveLength(1);
  } finally {
    await listing?.close();
    // Exercise the production close hook, while suppressing its unrelated detached capture scanner.
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
      throw new Error("Capture scanner is outside this test");
    });
    try {
      if (channel)
        await expect(channel.close()).rejects.toThrow(
          "capture worker could not start",
        );
    } finally {
      spawn.mockRestore();
      await sources.close();
      replaceConfig(previousConfig);
      const restoredHooks = { ...previousHooks };
      Object.defineProperty(restoredHooks, "worker", {
        value: previousHooks.worker,
        enumerable: true,
      });
      configureRuntime(restoredHooks);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (existsSync(fake.marker)) {
        const events = markerEvents(fake.marker);
        for (const started of events.filter(
          (event) => event.type === "started",
        )) {
          expect(
            events.some(
              (event) => event.type === "exited" && event.pid === started.pid,
            ),
          ).toBe(true);
          expect(() => process.kill(started.pid, 0)).toThrow();
        }
      }
      at.close();
    }
  }
}, 20000);

// Reason: with `review.route: "claude"` the workspace's coding sessions took their models from the
// direct route transport, which refuses a Claude route ("requires its runtime"), so no session
// could open. They must open, and a turn on one of the built-in account's models must run through
// its Claude Code, here a fake one, with no direct route admission kept.
test("a Claude review route opens coding sessions on the built-in account's Claude Code, defaulting to the route's model", async () => {
  const at = temporary();
  const previousConfig = { ...config };
  const previousHooks = runtimeHooks();
  const previousHome = process.env.HOME;
  const previousPath = process.env.PATH;
  const bin = join(at.root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "tailscale"),
    '#!/bin/sh\necho \'{"BackendState":"Stopped"}\'\n',
    { mode: 0o700 },
  );
  writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 97\n", { mode: 0o700 });
  process.env.HOME = at.home;
  process.env.PATH = `${bin}:${previousPath}`;
  const { codingWorkerSetup } = await import("../src/workspace-cli.ts");
  const { openChannel, openWorkerStorage } =
    await import("@ace/host/worker-runtime");
  const route = settingsRoute(
    Option.some(Settings.parse({ version: 1, review: { route: "claude" } })),
  );
  expect(route).toMatchObject({
    provider: "claude",
    account: { name: "claude" },
    model: "claude-opus-5-5",
  });
  const builtIn = DEFAULT_ACCOUNTS.find((entry) => entry.name === "claude")!;
  const opus = {
    id: "opus",
    displayName: "Opus",
    description: "Fake alias row",
    resolvedModel: route.model,
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high"],
  };
  saveStatus(at.home, builtIn, { state: "signed-in" }, [
    { ...opus, id: "default", displayName: "Default" },
    opus,
  ]);
  const fake = fakeClaude(at.root);
  const previousToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";
  const sources = productionChatSources({
    home: at.home,
    claude: {
      cwd: defaultClaudeWorkingFolder(at.home),
      executable: fake.executable,
    },
  });
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const paths = {
    ...PI_TRANSITION_STORAGE_PROFILE.paths,
    state: join(at.root, "state"),
    captures: join(at.root, "captures"),
    tmp: join(at.root, "tmp"),
  };
  const stateDirectory = join(paths.state, "worker");
  const lanes = join(at.root, "lanes");
  for (const path of [stateDirectory, paths.captures, paths.tmp, lanes])
    mkdirSync(path, { recursive: true });
  replaceConfig(
    HostConfigSchema.parse({
      home: paths.state,
      lanes,
      user: "person",
      port: 0,
      environment: { HOME: at.home },
      worker: [process.execPath],
      // As the workspace configures its host: no fixed model on a Claude route, its effort.
      ...routeCodingDefaults(route),
    }),
  );
  expect(config.model).toBeUndefined();
  const setup = codingWorkerSetup(
    { paths },
    route,
    {
      fetch: Object.assign(
        async () => {
          throw new Error("No direct model calls on the Claude route");
        },
        { preconnect: () => {} },
      ),
    },
    sources,
  );
  let harness: Harness | undefined;
  configureRuntime({
    worker: {
      models: setup.models,
      extensions: (worker) => {
        const extension = setup.extensions?.(worker);
        return {
          extensions: extension?.extensions ?? [],
          attach: async (attached) => {
            harness = attached;
            await extension?.attach?.(attached);
          },
        };
      },
      ...(setup.priced ? { priced: setup.priced } : {}),
      ...(setup.defaultModel ? { defaultModel: setup.defaultModel } : {}),
    },
  });
  const worker: WorkerContext = { sessionId: "worker", config, stateDirectory };
  let channel: Channel | undefined;
  // Runtime-only fixture: placement is exercised through actual host/worker admission elsewhere.
  Reflect.deleteProperty(config, "lanes");
  const native = createModels();
  try {
    const storage = await openWorkerStorage(setup, worker, () =>
      openNodeSqliteStorage(join(stateDirectory, "channel.sqlite")),
    );
    channel = await openChannel(
      {
        id: "worker",
        name: "worker",
        owner: "person",
        project: at.root,
        storage,
        models: native,
        resume: false,
        env: (cwd) => new NodeExecutionEnv({ cwd }),
        directory: {
          self: { id: "worker", name: "worker" },
          list: async () => [],
          deliver: async () => {},
        },
        log: () => {},
      },
      stateDirectory,
    );
    const models = await setup.models(worker, native);
    expect(models.getModel("claude", "opus")?.provider).toBe("claude");
    expect(
      setup.nonTurnModels?.(worker, "caption", ROOT_CONVERSATION_ID, native),
    ).toBeDefined();
    const observed: unknown[] = [];
    await channel.handle({ op: "watch", chat: 1 }, (frame) =>
      observed.push(frame),
    );
    await channel.handle(
      {
        op: "ask",
        author: "person",
        text: "Coding turn on the Claude route",
      },
      () => {},
    );
    if (!harness) throw new Error("Worker did not attach its Harness");
    await harness.waitForIdle(BACKGROUND_CONTEXT);
    await until(() => !channel!.busy);
    const events = markerEvents(fake.marker);
    expect(events.find((event) => event.type === "started")).toMatchObject({
      hasOAuthToken: true,
    });
    expect(events.filter((event) => event.type === "prompt")).toEqual([
      {
        type: "prompt",
        content: [
          { type: "text", text: "person: Coding turn on the Claude route" },
        ],
      },
    ]);
    await until(() =>
      JSON.stringify(observed).includes(
        "Reply from the fake Claude executable",
      ),
    );
    // The chat with no model named ran the account's row for the route's model, at its effort.
    const agent = await (await harness.conversation(
      ROOT_CONVERSATION_ID,
      BACKGROUND_CONTEXT,
    ))!.agent(BACKGROUND_CONTEXT);
    expect(agent.model).toEqual({ provider: "claude", modelId: "opus" });
    expect(agent.thinkingLevel).toBe(route.effort);
    expect(setup.priced?.({ provider: "claude", modelId: "opus" })).toBe(false);
    // Each refusal is the plain sentence, never a missing API key, and no prompt reaches Claude Code.
    const refused = async (message: string) => {
      const { chat } = (await channel!.handle(
        { op: "chat", author: "person" },
        () => {},
      )) as { chat: number };
      await expect(
        channel!.handle(
          { op: "ask", author: "person", chat, text: "Do not send this" },
          () => {},
        ),
      ).rejects.toThrow(message);
    };
    saveStatus(at.home, builtIn, { state: "signed-in" }, [
      { ...opus, id: "sonnet", resolvedModel: "claude-sonnet-5" },
    ]);
    await refused(
      "Claude Code for account claude doesn't offer claude-opus-5-5, the model reviews run on. Run neuve auth status claude --check to read its models again, or pick another model for this chat.",
    );
    saveStatus(
      at.home,
      builtIn,
      {
        state: "not-signed-in",
        hint: { kind: "command", command: "claude auth login" },
      },
      [opus],
    );
    await refused(
      "Claude Code isn't signed in for account claude. Run claude auth login, then neuve auth status claude --check.",
    );
    saveStatus(
      at.home,
      builtIn,
      { state: "runtime-unavailable", reason: "not-installed" },
      [opus],
    );
    await refused(
      "Claude Code isn't installed for account claude: there's no claude on PATH. Install Claude Code, run claude auth login, then neuve auth status claude --check.",
    );
    expect(
      markerEvents(fake.marker).filter((event) => event.type === "prompt"),
    ).toHaveLength(1);
    saveStatus(at.home, builtIn, { state: "unknown", reason: "not-checked" }, [
      opus,
    ]);
    await refused(
      "Neuve doesn't know yet whether Claude Code is signed in for account claude. Run neuve auth status claude --check.",
    );
    expect(
      markerEvents(fake.marker).filter((event) => event.type === "prompt"),
    ).toHaveLength(1);
    // No direct route ran, so no direct retry deadline was kept.
    expect(existsSync(join(stateDirectory, "route-admission.json"))).toBe(
      false,
    );
  } finally {
    if (previousToken !== undefined)
      process.env.CLAUDE_CODE_OAUTH_TOKEN = previousToken;
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
      throw new Error("Capture scanner is outside this test");
    });
    try {
      if (channel)
        await expect(channel.close()).rejects.toThrow(
          "capture worker could not start",
        );
    } finally {
      spawn.mockRestore();
      await sources.close();
      replaceConfig(previousConfig);
      const restoredHooks = { ...previousHooks };
      Object.defineProperty(restoredHooks, "worker", {
        value: previousHooks.worker,
        enumerable: true,
      });
      configureRuntime(restoredHooks);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (existsSync(fake.marker))
        for (const event of markerEvents(fake.marker))
          if (event.type === "started")
            expect(() => process.kill(event.pid, 0)).toThrow();
      at.close();
    }
  }
}, 20000);

// Exercise worker admission with a live account catalogue as its status rows change.
test("worker admission keeps Claude route and colliding account refusals", async () => {
  const at = temporary();
  const previousConfig = { ...config };
  const previousHooks = runtimeHooks();
  const claude = fakeAccount("claude");
  const collision = fakeAccount("faux", "other");
  const run = await fixture({ accounts: [claude, collision] });
  const [claudeStatus, collidingStatus] = run.statuses.current();
  const route = { account: claude, model: "claude-sonnet-test" };
  const { openChannel } = await import("@ace/host/worker-runtime");
  let channel: Channel | undefined;
  try {
    Reflect.deleteProperty(config, "lanes");
    Reflect.deleteProperty(config, "model");
    configureRuntime({
      worker: {
        models: () => run.models,
        defaultModel: async () =>
          claudeDefaultModel(route, run.statuses.current()),
      },
    });
    const opened = await openChannel(
      {
        id: "account-admission",
        name: "Account admission",
        owner: "person",
        project: at.root,
        storage: new MemoryStorage(),
        models: run.native,
        env: (cwd) => new NodeExecutionEnv({ cwd }),
        directory: {
          self: { id: "account-admission", name: "Account admission" },
          list: async () => [],
          deliver: async () => {},
        },
        log: () => {},
      },
      at.root,
    );
    channel = opened;
    const ask = (selection: { chat?: number; model?: ModelRef } = {}) =>
      opened.handle(
        { op: "ask", author: "person", text: "Hello", ...selection },
        () => {},
      );
    run.fake.frames.push({ text: "Claude received the default turn" });
    await ask();
    await until(() => run.fake.requests.length === 1);
    expect(run.fake.opened[0]).toMatchObject({
      account: "claude",
      policy: { model: { id: "sonnet" } },
    });

    const signIn = {
      state: "not-signed-in",
      hint: {
        kind: "command",
        command: "neuve auth login",
        account: collision.name,
      },
    } as const;
    run.statuses.set([
      claudeStatus!,
      { ...collidingStatus!, signIn, models: [] },
    ]);
    await expect(
      ask({ model: { provider: "account:faux", modelId: "sonnet" } }),
    ).rejects.toThrow(
      "Sign in for faux: run neuve auth login faux on this machine, then send your message again.",
    );
    run.statuses.set([{ ...claudeStatus!, models: [] }, collidingStatus!]);
    const { chat } = (await channel.handle(
      { op: "chat", author: "person" },
      () => {},
    )) as { chat: number };
    await expect(ask({ chat })).rejects.toThrow(
      "Claude Code for account claude doesn't offer claude-sonnet-test",
    );
    expect(run.fake.requests).toHaveLength(1);
  } finally {
    try {
      await channel?.close();
    } finally {
      await run.close();
      replaceConfig(previousConfig);
      configureRuntime({ worker: previousHooks.worker });
      at.close();
    }
  }
});

// Reason: a group-writable Neuve folder must leave native pi models usable and fail account selection with the existing copy.
test("an unreadable production store leaves pi executable", async () => {
  const at = temporary();
  const folder = AccountStore.neuveFolder(at.home);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  chmodSync(folder, 0o775);
  const sources = productionChatSources({
    home: at.home,
    claude: {
      cwd: join(at.root, "unused"),
      executable: join(at.root, "missing-claude"),
    },
  });
  const native = createModels();
  const fake = fauxProvider({ provider: "faux", models: [{ id: "pi" }] });
  fake.setResponses([fauxAssistantMessage("Pi still works")]);
  native.setProvider(fake.provider);
  let runtime: Awaited<ReturnType<typeof workspaceChatRuntime>> | undefined;
  let listing: Awaited<ReturnType<typeof workspaceChatModels>> | undefined;
  try {
    runtime = await workspaceChatRuntime(
      native,
      join(at.root, "chat"),
      sources,
    );
    listing = await workspaceChatModels(native, sources);
    const model = runtime.models.getModel("faux", "pi");
    if (!model) throw new Error("Missing pi fixture");
    expect(
      (await runtime.models.completeSimple(model, { messages: [] })).content,
    ).toEqual([{ type: "text", text: "Pi still works" }]);
    expect(() => runtime!.models.getModel("claude", "default")).toThrow(
      "The selected account claude cannot run here.",
    );
    expect(listing.current()).toEqual([]);
    expect(existsSync(join(at.root, "unused"))).toBe(false);
  } finally {
    await runtime?.close();
    await listing?.close();
    await sources.close();
    at.close();
  }
});

// Reason: constructing and closing unused process sources must not open the account store or create Claude's working folder.
test("unused production sources stay lazy", async () => {
  const at = temporary();
  const sources = productionChatSources({ home: at.home });
  try {
    expect(existsSync(AccountStore.neuveFolder(at.home))).toBe(false);
    await sources.close();
    await sources.close();
    expect(existsSync(AccountStore.neuveFolder(at.home))).toBe(false);
  } finally {
    await sources.close();
    at.close();
  }
});

test("the workspace account check replaces a stale Claude sign-in", async () => {
  const at = temporary();
  const fake = fakeClaude(at.root);
  const builtIn = DEFAULT_ACCOUNTS.find(
    (account) => account.name === "claude",
  )!;
  AccountStore.setProgramPath(
    at.home,
    AccountName.parse("codex"),
    join(at.root, "no-codex"),
  );
  saveStatus(at.home, builtIn, {
    state: "signed-in",
    credentialSource: "environment",
    sourceMatchesAccount: false,
  });
  const sources = productionChatSources({
    home: at.home,
    claude: {
      cwd: join(at.root, "work"),
      executable: fake.executable,
      oauthToken: "test-token",
    },
    environment: { ANTHROPIC_API_KEY: "test-key" },
  });
  try {
    await sources.checkAccounts();
    const statuses = sources.statuses.current();
    expect(statuses.find((status) => status.name === "claude")?.signIn).toEqual(
      {
        state: "signed-in",
        credentialSource: "environment",
        sourceMatchesAccount: true,
      },
    );
    expect(
      statuses.find((status) => status.name === "anthropic")?.signIn,
    ).toEqual({
      state: "signed-in",
      credentialSource: "environment",
    });
  } finally {
    await sources.close();
    at.close();
  }
});

// Reason: a refused status snapshot must not prevent pi accounts from resolving or launch Claude Code.
test("an unreadable production status snapshot leaves the registry usable", async () => {
  const at = temporary();
  const path = AccountStore.statusesPath(at.home);
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, "invalid snapshot", { mode: 0o600 });
  const fake = fakeClaude(at.root);
  const sources = productionChatSources({
    home: at.home,
    claude: { cwd: join(at.root, "work"), executable: fake.executable },
  });
  try {
    const result = await Effect.runPromise(
      sources.registry.capabilities(AccountName.parse("anthropic")).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: (capabilities) => capabilities,
        }),
      ),
    );
    expect(result).toMatchObject({
      ownsLoop: false,
    });
    expect(existsSync(fake.marker)).toBe(false);
    expect(existsSync(join(at.root, "work"))).toBe(false);
  } finally {
    await sources.close();
    at.close();
  }
});

// Reason: resolving a missing Claude executable must neither launch a fallback nor prevent native pi turns.
test("a missing Claude executable leaves pi executable", async () => {
  const at = temporary();
  const sources = productionChatSources({
    home: at.home,
    claude: {
      cwd: join(at.root, "work"),
      executable: join(at.root, "missing-claude"),
    },
  });
  const native = createModels();
  const fake = fauxProvider({ provider: "faux", models: [{ id: "pi" }] });
  fake.setResponses([fauxAssistantMessage("Pi without Claude Code")]);
  native.setProvider(fake.provider);
  let runtime: Awaited<ReturnType<typeof workspaceChatRuntime>> | undefined;
  try {
    runtime = await workspaceChatRuntime(
      native,
      join(at.root, "chat"),
      sources,
    );
    const model = runtime.models.getModel("faux", "pi");
    if (!model) throw new Error("Missing pi fixture");
    expect(
      (await runtime.models.completeSimple(model, { messages: [] })).content,
    ).toEqual([{ type: "text", text: "Pi without Claude Code" }]);
    expect(runtime.owns("claude")).toBe(false);
  } finally {
    await runtime?.close();
    await sources.close();
    at.close();
  }
});

test("the coding worker answers after its capture journal cannot reopen", async () => {
  const at = temporary();
  const paths = {
    ...PI_TRANSITION_STORAGE_PROFILE.paths,
    state: join(at.root, "state"),
    captures: join(at.root, "captures"),
    tmp: join(at.root, "tmp"),
  };
  const stateDirectory = join(paths.state, "worker");
  const worker: WorkerContext = { sessionId: "worker", config, stateDirectory };
  const capture = join(stateDirectory, "capture");
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const { codingWorkerSetup } = await import("../src/workspace-cli.ts");
  const { path } = tokenCommand(at.root, "lease");
  const setup = () =>
    codingWorkerSetup({ paths }, SOL_ROUTE, {
      auth: { tokenCommand: path },
      fetch: Object.assign(
        async () =>
          sse([
            created("response"),
            ...messageItem(0, "message", "final_answer", "Done."),
            completed("response"),
          ]),
        { preconnect() {} },
      ),
    });
  try {
    const releasePrevious = await setup().openSource?.(worker);
    try {
      openCaptureJournal(capture, worker.sessionId, {
        allowCredentialLoss: true,
      }).close();
    } finally {
      releasePrevious?.();
    }
    const restarted = setup();
    const releaseRestarted = await restarted.openSource?.(worker);
    const fault = spyOn(fs, "appendFileSync").mockImplementation(() => {
      throw Object.assign(new Error("disk is full"), { code: "ENOSPC" });
    });
    try {
      const models = await restarted.models(worker, createModels());
      const model = models.getModel(SOL_ROUTE.provider, SOL_ROUTE.model);
      if (!model) throw new Error("Expected coding route model");
      const answer = await models.complete(model, {
        messages: [{ role: "user", content: "Check the work.", timestamp: 1 }],
      });
      expect(answer.stopReason).toBe("stop");
      expect(answer.content).toContainEqual(
        expect.objectContaining({ type: "text", text: "Done." }),
      );
      expect(readCaptureLosses(capture)).toEqual([
        expect.objectContaining({
          sessionId: expect.any(String),
          event: "journal.open",
          reason: "disk full",
        }),
        expect.objectContaining({
          callId: expect.any(String),
          event: "credential.registration",
          reason: "disk full",
        }),
      ]);
    } finally {
      fault.mockRestore();
      releaseRestarted?.();
    }
  } finally {
    at.close();
  }
}, 30_000);

// Reason: coding chats use the worker's recoverable directory, including every directory operation behind the registry.
for (const startup of [true, false]) {
  test(`production chats resolve defaults and recover a named account ${startup ? "refused at startup" : "refused after open"}`, async () => {
    const at = temporary();
    const name = AccountName.parse("work");
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(at.home);
          yield* store.add("claude", name);
        }),
      ),
    );
    const folder = AccountStore.neuveFolder(at.home);
    if (startup) chmodSync(folder, 0o775);
    const sources = productionChatSources({
      home: at.home,
      claude: { cwd: join(at.root, "work"), executable: process.execPath },
    });
    try {
      if (!startup)
        expect(
          (await Effect.runPromise(sources.registry.continuation(name)))
            .runtime,
        ).toBe("claude-code");
      chmodSync(folder, 0o775);
      for (const account of ["anthropic", "chatgpt"])
        expect(
          await Effect.runPromise(
            sources.registry.capabilities(AccountName.parse(account)),
          ),
        ).toMatchObject({ ownsLoop: false });
      const refused = await Effect.runPromise(
        sources.registry.continuation(name).pipe(Effect.result),
      );
      expect(refused).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "AccountStoreRefused",
          folder,
          problem: { kind: "writable-by-others" },
        },
      });
      if (refused._tag !== "Failure") throw new Error("Expected refusal");
      expect(refused.failure.message).toBe(
        `${folder} is writable by other users. Neuve needs it writable only by you.`,
      );
      chmodSync(folder, 0o755);
      expect(
        (await Effect.runPromise(sources.registry.continuation(name))).runtime,
      ).toBe("claude-code");
      expect(existsSync(join(at.root, "work"))).toBe(false);
    } finally {
      await sources.close();
      at.close();
    }
  });
}
