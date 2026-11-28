// Why: Neuve's tools reach Codex over a local HTTP server, so the token is the only thing that
// keeps another process on the machine from calling them, and a call must appear on the contract
// as Neuve's own tool, with its own events and its handler's checks, whatever Codex does.
// The session tests bind a local port: run them outside a sandbox that forbids that.
import { expect, test } from "bun:test";
import {
  AccountName,
  RuntimeEvent,
  TurnLimit,
  type SessionPolicy,
  type ToolDefinition,
} from "@neuve/runtime";
import { Effect, Exit, Queue, Scope, Stream } from "effect";
import { launchArguments } from "../src/launch.ts";
import { openCodexSession } from "../src/session.ts";
import { toolHandler } from "../src/tools.ts";
import { codex, completed } from "./codex-fake.ts";

const seen: Array<{ input: unknown; callId: string }> = [];
const probe: ToolDefinition = {
  name: "probe",
  description: "fixture",
  inputSchema: { type: "object", properties: { n: { type: "number" } } },
  hints: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
  },
  handle: (input, call) =>
    Effect.sync(() => {
      seen.push({ input, callId: call!.callId });
      return (input as { n?: number }).n === 0
        ? { text: "refused by its own check", error: "plan mode" }
        : { text: "ran" };
    }),
};
const rpc = (url: string, token: string | undefined, body: unknown) =>
  fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
const call = (n: number) => ({
  jsonrpc: "2.0",
  id: n + 10,
  method: "tools/call",
  params: { name: "probe", arguments: { n }, _meta: { callId: `exec-${n}` } },
});

test("the server checks the session token and lists the tools an unknown call can use", async () => {
  const handler = toolHandler(
    [
      probe,
      { ...probe, name: "inspect" },
      { ...probe, name: "lookup", deferred: true },
    ],
    "secret",
    async (definition, input, _signal, callId) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({ name: definition.name, input, callId }),
        },
      ],
    }),
  );
  const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  const request = (token?: string, body: unknown = list, path = "/mcp") =>
    new Request(`http://127.0.0.1${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token === undefined ? {} : { authorization: token }),
      },
      body: JSON.stringify(body),
    });
  expect((await handler(request())).status).toBe(401);
  expect((await handler(request("Bearer wrong!"))).status).toBe(401);
  const answered = await handler(request("Bearer secret"));
  expect(answered.status).toBe(200);
  expect(await answered.json()).toMatchObject({
    result: {
      tools: [
        { name: "probe", annotations: { readOnlyHint: true } },
        { name: "inspect" },
      ],
    },
  });
  expect(
    (await handler(request("Bearer wrong!", list, "/plugins/mcp"))).status,
  ).toBe(401);
  expect(
    await (
      await handler(request("Bearer secret", list, "/plugins/mcp"))
    ).json(),
  ).toMatchObject({ result: { tools: [{ name: "lookup" }] } });
  const lookup = { ...call(1), params: { ...call(1).params, name: "lookup" } };
  expect(
    await (await handler(request("Bearer secret", lookup))).json(),
  ).toMatchObject({ result: { isError: true } });
  expect(
    await (
      await handler(request("Bearer secret", lookup, "/plugins/mcp"))
    ).json(),
  ).toMatchObject({
    result: {
      content: [
        {
          type: "text",
          text: '{"name":"lookup","input":{"n":1},"callId":"exec-1"}',
        },
      ],
    },
  });
  const unknown = await handler(
    request("Bearer secret", {
      ...call(1),
      params: { name: "missing" },
    }),
  );
  expect(await unknown.json()).toMatchObject({
    result: {
      isError: true,
      content: [
        {
          type: "text",
          text: `Neuve has no tool "missing". This chat's tools are: probe, inspect.`,
        },
      ],
    },
  });
});

test("a call is Neuve's own tool on the contract, keeps its checks, and is refused outside a turn", async () => {
  const fake = codex();
  await Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const session = yield* openCodexSession({
        account: AccountName.parse("codex"),
        program: "/test/codex",
        cwd: "/work",
        environment: {},
        policy: {
          systemPrompt: "fixture",
          tools: [
            probe,
            {
              ...probe,
              name: "fails",
              handle: () => Effect.die("fixture failure"),
            },
            {
              ...probe,
              name: "lookup",
              deferred: true,
              codexApp: "tracker_app",
            },
          ],
          approvalPolicy: "allow",
          turnLimit: TurnLimit.parse(8),
        },
        start: { kind: "new" },
        stopWait: "10 millis",
      }).pipe(Scope.provide(scope));
      const events: RuntimeEvent[] = [];
      const queue = yield* Queue.unbounded<RuntimeEvent>();
      yield* Stream.runForEach(session.events, (event) =>
        Effect.sync(() => {
          RuntimeEvent.parse(event);
          events.push(event);
          Queue.offerUnsafe(queue, event);
        }),
      ).pipe(Effect.forkDetach);
      const { args, env } = fake.current();
      const url = /mcp_servers\.neuve\.url="([^"]+)"/.exec(args.join(" "))![1]!;
      // Bound to the loopback interface only: the address given is the one the server listens on.
      expect(url).toStartWith("http://127.0.0.1:");
      const plugin = /mcp_servers\.neuve_plugins\.url="([^"]+)"/.exec(
        args.join(" "),
      )![1]!;
      expect(plugin).toBe(new URL("/plugins/mcp", url).href);
      const token = env.NEUVE_CODEX_TOOL_TOKEN!;
      expect(args).toContain(
        'mcp_servers.neuve.bearer_token_env_var="NEUVE_CODEX_TOOL_TOKEN"',
      );
      expect(args).toContain(
        'mcp_servers.neuve.default_tools_approval_mode="approve"',
      );
      // The clean launch before any write turn leaves Codex's apps to its own switch-off.
      expect(args).not.toContain("apps.tracker_app.enabled=false");

      const outside = yield* Effect.promise(() =>
        rpc(url, token, call(1)).then((r) => r.json()),
      );
      expect(outside).toMatchObject({ result: { isError: true } });

      yield* session.startTurn({
        turnId: "turn",
        message: "go",
        workspace: { folder: "/work", access: "write" },
      });
      // The write turn's launch switches off the Codex app that Ace's plugin stands for.
      expect(fake.current().args).toContain("apps.tracker_app.enabled=false");
      const ran = yield* Effect.promise(() =>
        rpc(plugin, token, {
          ...call(1),
          params: { ...call(1).params, name: "lookup" },
        }).then((r) => r.json()),
      );
      expect(ran).toMatchObject({
        result: { content: [{ type: "text", text: "ran" }], isError: false },
      });
      const refused = yield* Effect.promise(() =>
        rpc(url, token, call(0)).then((r) => r.json()),
      );
      expect(refused).toMatchObject({
        result: {
          isError: true,
          content: [{ type: "text", text: "refused by its own check" }],
        },
      });
      const failed = yield* Effect.promise(() =>
        rpc(url, token, { ...call(2), params: { name: "fails" } }).then((r) =>
          r.json(),
        ),
      );
      expect(failed).toMatchObject({
        result: {
          isError: true,
          content: [{ type: "text", text: "The tool failed." }],
        },
      });
      fake.send("item/completed", {
        threadId: "thread-1",
        turnId: "codex-turn",
        completedAtMs: 0,
        item: {
          type: "mcpToolCall",
          id: "exec-1",
          server: "neuve_plugins",
          tool: "lookup",
          status: "completed",
          arguments: { n: 1 },
          result: null,
          error: null,
          durationMs: null,
        },
      });
      expect(seen.map((s) => s.input)).toEqual([{ n: 1 }, { n: 0 }]);
      fake.send("turn/completed", completed("completed"));
      while ((yield* Queue.take(queue)).type !== "turn.finished");
      expect(events.map((e) => e.type)).toEqual([
        "turn.started",
        "message.finished",
        "tool.started",
        "tool.finished",
        "message.finished",
        "tool.started",
        "tool.finished",
        "message.finished",
        "tool.started",
        "tool.finished",
        "turn.finished",
      ]);
      // The call carries Codex's own id for it, the id of its item.
      expect(events[2]).toMatchObject({
        toolName: "lookup",
        callId: "exec-1",
        input: { n: 1 },
      });
      expect(seen.map((s) => s.callId)).toEqual(["exec-1", "exec-0"]);
      expect(events[6]).toMatchObject({ errored: true });
      yield* Scope.close(scope, Exit.void);
      // The server goes with the session.
      const after = yield* Effect.promise(() =>
        rpc(url, token, call(1)).then(
          () => "answered",
          () => "closed",
        ),
      );
      expect(after).toBe("closed");
    }).pipe(Effect.provide(fake.layer), Effect.timeout("5 seconds")),
  );
});

test('Codex gets "Stopped." when a Neuve tool call is interrupted', async () => {
  const fake = codex((message, process) => {
    if (message.method === "turn/interrupt")
      queueMicrotask(() =>
        process.io.send({
          method: "turn/completed",
          params: completed("interrupted"),
        }),
      );
    return undefined;
  });
  const started = Promise.withResolvers<void>();
  let aborted = false;
  const waits: ToolDefinition = {
    ...probe,
    name: "waits",
    handle: (_input, call) =>
      Effect.callback<never>((resume) => {
        call!.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resume(Effect.interrupt);
          },
          { once: true },
        );
        started.resolve();
      }),
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const session = yield* openCodexSession({
        account: AccountName.parse("codex"),
        program: "/test/codex",
        cwd: "/work",
        environment: {},
        policy: {
          systemPrompt: "fixture",
          tools: [waits],
          approvalPolicy: "allow",
          turnLimit: TurnLimit.parse(8),
        },
        start: { kind: "new" },
        stopWait: "10 millis",
      }).pipe(Scope.provide(scope));
      const events: RuntimeEvent[] = [];
      const queue = yield* Queue.unbounded<RuntimeEvent>();
      yield* Stream.runForEach(session.events, (event) =>
        Effect.sync(() => {
          events.push(event);
          Queue.offerUnsafe(queue, event);
        }),
      ).pipe(Effect.forkDetach);
      yield* session.startTurn({
        turnId: "turn",
        message: "go",
        workspace: { folder: "/work", access: "write" },
      });
      const { args, env } = fake.current();
      const url = /mcp_servers\.neuve\.url="([^"]+)"/.exec(args.join(" "))![1]!;
      const response = rpc(url, env.NEUVE_CODEX_TOOL_TOKEN!, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "waits", arguments: {} },
      }).then((r) => r.json());
      while ((yield* Queue.take(queue)).type !== "tool.started");
      yield* Effect.promise(() => started.promise);
      yield* session.interruptTurn({ turnId: "turn" });
      while ((yield* Queue.take(queue)).type !== "turn.finished");
      expect(yield* Effect.promise(() => response)).toMatchObject({
        result: {
          content: [{ type: "text", text: "Stopped." }],
          isError: true,
        },
      });
      expect(aborted).toBe(true);
      expect(events.map((e) => e.type).slice(-2)).toEqual([
        "tool.finished",
        "turn.finished",
      ]);
      expect(events.at(-2)).toMatchObject({ errored: true });
      expect(events.filter((e) => e.type === "tool.finished")).toHaveLength(1);
      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.provide(fake.layer), Effect.timeout("5 seconds")),
  );
});

test("Codex loads only the core endpoint eagerly and keeps the person's write tools enabled", () => {
  const own = {
    mcpServers: ["personal"],
    plugins: ["personal-plugin"],
    apps: [],
    skills: [],
    exclude: ["OTHER"],
  };
  const urls = {
    neuve: "http://127.0.0.1:1234/mcp",
    neuve_plugins: "http://127.0.0.1:1234/plugins/mcp",
  };
  const args = launchArguments("own", own, urls);
  expect(args.filter((arg) => arg.includes("omit_tools_from"))).toEqual([
    'mcp_servers.neuve.omit_tools_from=["deferred","code_mode"]',
  ]);
  expect(args).toContain(
    'mcp_servers.neuve_plugins.bearer_token_env_var="NEUVE_CODEX_TOOL_TOKEN"',
  );
  expect(args).toContain(
    'mcp_servers.neuve_plugins.default_tools_approval_mode="approve"',
  );
  expect(args).not.toContain("mcp_servers.personal.enabled=false");
  expect(args).not.toContain("plugins.personal-plugin.enabled=false");
  const clean = launchArguments("clean", own, { neuve: urls.neuve });
  expect(clean).toContain("mcp_servers.personal.enabled=false");
  expect(clean).toContain("plugins.personal-plugin.enabled=false");
  expect(
    clean.some((arg) => arg.startsWith("mcp_servers.neuve_plugins.")),
  ).toBe(false);
});

// Every served Codex app is switched off once, and other personal features keep their mode's defaults.
test("only a write launch serving deferred plugin tools switches off the Codex apps they stand for", () => {
  const own = {
    mcpServers: ["personal"],
    plugins: ["personal-plugin"],
    apps: ["tracker_app", "other_app", "personal_app"],
    skills: [],
    exclude: [],
  };
  const core = { neuve: "http://127.0.0.1:1234/mcp" };
  const served = {
    ...core,
    neuve_plugins: "http://127.0.0.1:1234/plugins/mcp",
  };
  const tools = [
    {
      ...probe,
      name: "lookup",
      deferred: true,
      codexApp: "tracker_app",
    },
    {
      ...probe,
      name: "update",
      deferred: true,
      codexApp: "tracker_app",
    },
    { ...probe, name: "search", deferred: true, codexApp: "other_app" },
    { ...probe, codexApp: "personal_app" },
  ] satisfies SessionPolicy["tools"];
  const write = (servers: typeof core, offered: SessionPolicy["tools"]) =>
    launchArguments(
      "own",
      own,
      servers,
      undefined,
      undefined,
      undefined,
      offered,
    );
  const withoutCodexApps = [
    { ...probe, deferred: true },
  ] satisfies SessionPolicy["tools"];

  expect(write(served, tools).filter((arg) => arg.startsWith("apps."))).toEqual(
    ["apps.tracker_app.enabled=false", "apps.other_app.enabled=false"],
  );
  expect(write(core, tools)).toEqual(write(core, []));
  expect(write(served, withoutCodexApps)).toEqual(write(served, []));
  expect(
    launchArguments(
      "clean",
      own,
      served,
      undefined,
      undefined,
      undefined,
      tools,
    ),
  ).toEqual(launchArguments("clean", own, served));
});
