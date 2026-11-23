// Why: Neuve's tools reach Codex over a local HTTP server, so the token is the only thing that
// keeps another process on the machine from calling them, and a call must appear on the contract
// as Neuve's own tool, with its own events and its handler's checks, whatever Codex does.
// The session tests bind a local port: run them outside a sandbox that forbids that.
import { expect, test } from "bun:test";
import {
  AccountName,
  RuntimeEvent,
  TurnLimit,
  type ToolDefinition,
} from "@neuve/runtime";
import { Effect, Exit, Queue, Scope, Stream } from "effect";
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
    [probe, { ...probe, name: "inspect" }],
    "secret",
    async () => ({ content: [] }),
  );
  const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  const request = (token?: string, body: unknown = list) =>
    new Request("http://127.0.0.1/mcp", {
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
      const token = env.NEUVE_CODEX_TOOL_TOKEN!;
      expect(args).toContain(
        'mcp_servers.neuve.bearer_token_env_var="NEUVE_CODEX_TOOL_TOKEN"',
      );
      expect(args).toContain(
        'mcp_servers.neuve.default_tools_approval_mode="approve"',
      );

      const outside = yield* Effect.promise(() =>
        rpc(url, token, call(1)).then((r) => r.json()),
      );
      expect(outside).toMatchObject({ result: { isError: true } });

      yield* session.startTurn({
        turnId: "turn",
        message: "go",
        workspace: { folder: "/work", access: "read-only" },
      });
      const ran = yield* Effect.promise(() =>
        rpc(url, token, call(1)).then((r) => r.json()),
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
        toolName: "probe",
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
