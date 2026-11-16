import { expect } from "bun:test";
import type {
  AccountInfo,
  Options,
  PermissionResult,
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { RuntimeEvent } from "@neuve/runtime";
import { Effect, Layer, Stream } from "effect";
import { ClaudeSdk, ClaudeSdkError } from "../src/services.ts";
import { assistant } from "./frames.ts";
import { frameShapeIssues, validFrame } from "../src/protocol.ts";
import { TOOL_USE_ID_META } from "../src/tools.ts";
import { fixtureSchema } from "../src/smoke-fixture-recorder.ts";
import { z } from "zod";

/** Rehydrate reviewed shape fixtures; SDK-only mandatory content fields use empty defaults. */
export function fixtureReplay(
  input: unknown,
  schemas: Record<string, unknown>,
  offers: ReadonlyArray<{ beforeFrame: number; priority?: "now" }> = [
    { beforeFrame: 0 },
  ],
) {
  const fixture = fixtureSchema.parse(input);
  if (
    offers.length !== fixture.sends ||
    offers.some(
      (offer, index) =>
        !Number.isInteger(offer.beforeFrame) ||
        offer.beforeFrame < 0 ||
        offer.beforeFrame > fixture.frames.length ||
        offer.beforeFrame < (offers[index - 1]?.beforeFrame ?? 0),
    )
  )
    throw new Error("Fixture offer schedule does not match sends");
  const ids = new Map<string, string>();
  const sends: string[] = [];
  const fresh = (placeholder: string) => {
    let value = ids.get(placeholder);
    if (value === undefined) {
      value = crypto.randomUUID();
      ids.set(placeholder, value);
    }
    return value;
  };
  const hydrate = (
    value: z.infer<ReturnType<typeof z.json>>,
  ): z.infer<ReturnType<typeof z.json>> => {
    if (typeof value === "string") {
      const send = /^send_([1-9]\d*)$/.exec(value);
      if (send !== null) {
        const uuid = sends[Number(send[1]) - 1];
        if (uuid === undefined) throw new Error("Fixture stamp precedes send");
        return uuid;
      }
      return /^(?:msg|toolu|uuid|session|foreign)_[1-9]\d*$/.test(value)
        ? fresh(value)
        : value;
    }
    if (Array.isArray(value)) return value.map(hydrate);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, hydrate(item)]),
      );
    return value;
  };
  const entries: Entry[] = [out({ type: "query.open" })];
  const expectOffers = (index: number) => {
    for (const offer of offers.filter((offer) => offer.beforeFrame === index))
      entries.push(
        out({
          type: "prompt.offer",
          message: /[\s\S]*/,
          ...(offer.priority === undefined ? {} : { priority: offer.priority }),
          check: (message) => {
            if (message.uuid !== undefined) sends.push(message.uuid);
          },
        }),
      );
  };
  const dispatched = new Set<string>();
  const calls = new Map<
    string,
    { name: string; callId: string; input: Record<string, unknown> }
  >();
  for (const [index, recorded] of fixture.frames.entries()) {
    const toolBlock = z
      .object({
        type: z.literal("content_block_start"),
        content_block: z.record(z.string(), z.json()),
      })
      .safeParse(recorded.event);
    const streamed =
      recorded.type === "stream_event" && toolBlock.success
        ? [toolBlock.data.content_block]
        : [];
    if (recorded.type === "assistant") {
      const content =
        z
          .object({
            content: z.array(z.record(z.string(), z.json())).optional(),
          })
          .parse(recorded.message).content ?? [];
      for (const block of content) {
        if (
          block.type !== "tool_use" ||
          typeof block.id !== "string" ||
          typeof block.name !== "string" ||
          !block.name.startsWith("mcp__neuve__")
        )
          continue;
        calls.set(block.id, {
          name: block.name.slice("mcp__neuve__".length),
          callId: fresh(block.id),
          input: {},
        });
      }
    }
    for (const block of streamed) {
      if (
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string" &&
        block.name.startsWith("mcp__neuve__")
      )
        calls.set(block.id, {
          name: block.name.slice("mcp__neuve__".length),
          callId: fresh(block.id),
          input: {},
        });
    }
    // Dispatch at the result carrier, preserving any intervening stream tails.
    if (recorded.type === "user") {
      const content = z
        .object({
          content: z
            .union([z.string(), z.array(z.record(z.string(), z.json()))])
            .optional(),
        })
        .parse(recorded.message).content;
      const ready = Array.isArray(content)
        ? content.flatMap((block) => {
            if (
              block.type !== "tool_result" ||
              typeof block.tool_use_id !== "string" ||
              dispatched.has(block.tool_use_id)
            )
              return [];
            const call = calls.get(block.tool_use_id);
            if (call === undefined) return [];
            dispatched.add(block.tool_use_id);
            return [call];
          })
        : [];
      if (ready.length > 0)
        entries.push({
          type: "smoke.tool.calls",
          dispatchOnly: true,
          schemas,
          calls: ready,
        });
    }
    expectOffers(index);
    entries.push({
      type: "emit_inbound",
      get frame() {
        const frame = z.record(z.string(), z.json()).parse(hydrate(recorded));
        if (frame.type === "result") {
          frame.modelUsage ??= {};
          if (frame.subtype === "success") frame.result = "";
          else frame.errors = [];
        }
        if (frame.type === "system" && frame.subtype === "api_retry") {
          frame.attempt = 1;
          frame.max_retries = 1;
          frame.retry_delay_ms = 0;
          frame.error_status = null;
        }
        // Shape fixtures intentionally omit SDK fields the adapter never consumes.
        return frame as SDKMessage;
      },
    });
  }
  expectOffers(fixture.frames.length);
  entries.push(out({ type: "query.close" }));
  return entries;
}

export type Outbound =
  | {
      type: "query.open";
      check?: (options: Options) => void;
      account?: AccountInfo;
      models?: unknown;
      initNever?: boolean;
      initFail?: boolean;
    }
  | {
      type: "prompt.offer";
      message: string | RegExp;
      priority?: "now";
      check?: (message: SDKUserMessage) => void;
    }
  | { type: "query.interrupt"; hang?: boolean }
  | { type: "query.set_model"; model?: string }
  | { type: "query.flags"; effortLevel: "low" | "medium" | "high" }
  | { type: "query.close" }
  | {
      type: "permission.response";
      check: (response: PermissionResult) => void;
    };
export type Entry =
  | { type: "expect_outbound"; frame: Outbound }
  | { type: "pause"; until: Promise<void> }
  | { type: "emit_inbound"; frame: SDKMessage }
  | {
      type: "permission.request";
      tool: string;
      callId: string;
      input: Record<string, unknown>;
      abort?: boolean;
    }
  | {
      type: "tool.calls";
      dispatchOnly?: boolean;
      background?: boolean;
      message?: SDKAssistantMessage;
      calls: ReadonlyArray<{
        name: string;
        callId: string;
        input: Record<string, unknown>;
      }>;
      check?: (results: unknown[]) => void;
    }
  | {
      type: "smoke.tool.calls";
      dispatchOnly?: boolean;
      calls: ReadonlyArray<{
        name: string;
        callId: string;
        input: Record<string, unknown>;
      }>;
      schemas: Record<string, unknown>;
    }
  | { type: "runtime_exit" }
  | { type: "stream_failure" };
export const out = (frame: Outbound): Entry => ({
  type: "expect_outbound",
  frame,
});
export const inbound = (frame: SDKMessage): Entry => ({
  type: "emit_inbound",
  frame,
});

export function replay(entries: ReadonlyArray<Entry>) {
  let cursor = 0;
  let wake = Promise.withResolvers<void>();
  const opens: Options[] = [];
  const uuids = new Set<string>();
  const signal = () => {
    const previous = wake;
    wake = Promise.withResolvers<void>();
    previous.resolve();
  };
  function take<T extends Outbound["type"]>(
    type: T,
  ): Extract<Outbound, { type: T }> {
    const entry = entries[cursor];
    if (entry?.type !== "expect_outbound" || entry.frame.type !== type)
      throw new Error(
        `Replay ${cursor}: expected ${entry?.type === "expect_outbound" ? entry.frame.type : entry?.type}; received ${type}`,
      );
    const frame = entry.frame;
    cursor++;
    signal();
    // The discriminator equality above proves the Extract at this test boundary.
    return frame as Extract<Outbound, { type: T }>;
  }
  const layer = Layer.effect(
    ClaudeSdk,
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => expect(cursor).toBe(entries.length)),
      );
      return ClaudeSdk.of({
        prefixes: {
          usage: ["TEST_USAGE_LIMIT"],
          organization: ["TEST_ORG_LIMIT"],
        },
        open: (options) =>
          Effect.gen(function* () {
            const opening = take("query.open");
            opening.check?.(options);
            opens.push(options);
            let closed = false;
            let client: Client | undefined;
            let callbackFailure: unknown;
            const callbacks = new Set<Promise<void>>();
            const permissionControllers = new Set<AbortController>();
            const close = Effect.sync(() => {
              if (!closed) {
                take("query.close");
                closed = true;
                for (const controller of permissionControllers)
                  controller.abort();
                signal();
              }
            }).pipe(
              Effect.andThen(
                Effect.promise(async () => {
                  await Promise.allSettled([...callbacks]);
                  if (callbackFailure !== undefined) throw callbackFailure;
                  await client?.close();
                }),
              ),
            );
            yield* Effect.addFinalizer(() => close);
            async function* messages(): AsyncGenerator<SDKMessage> {
              while (!closed) {
                if (callbackFailure !== undefined) throw callbackFailure;
                const waiting = wake.promise;
                const entry = entries[cursor];
                if (entry?.type === "pause") {
                  cursor++;
                  await entry.until;
                } else if (entry?.type === "emit_inbound") {
                  cursor++;
                  signal();
                  yield entry.frame;
                } else if (entry?.type === "permission.request") {
                  cursor++;
                  signal();
                  const controller = new AbortController();
                  if (options.canUseTool === undefined)
                    throw new Error("Missing permission handler");
                  permissionControllers.add(controller);
                  const response = options.canUseTool(entry.tool, entry.input, {
                    signal: controller.signal,
                    toolUseID: entry.callId,
                    requestId: "test-request",
                  });
                  if (entry.abort) controller.abort();
                  const callback = response
                    .then((answered) => {
                      if (answered === null)
                        throw new Error("Unexpected null permission result");
                      take("permission.response").check(answered);
                    })
                    .catch((cause: unknown) => {
                      callbackFailure = cause;
                      signal();
                    })
                    .finally(() => {
                      permissionControllers.delete(controller);
                      callbacks.delete(callback);
                    });
                  callbacks.add(callback);
                } else if (entry?.type === "smoke.tool.calls") {
                  cursor++;
                  signal();
                  const modelMessage = assistant(undefined);
                  modelMessage.message.id = crypto.randomUUID();
                  modelMessage.message.stop_reason = "tool_use";
                  modelMessage.message.content = entry.calls.map((call) => ({
                    type: "tool_use",
                    id: call.callId,
                    name: `mcp__neuve__${call.name}`,
                    input: call.input,
                  }));
                  if (!entry.dispatchOnly) yield modelMessage;
                  const server = options.mcpServers?.neuve;
                  if (server?.type !== "sdk")
                    throw new Error("Missing SDK server");
                  if (client === undefined) {
                    client = new Client({ name: "smoke-test", version: "1" });
                    const [clientTransport, serverTransport] =
                      InMemoryTransport.createLinkedPair();
                    await Promise.all([
                      client.connect(clientTransport),
                      server.instance.connect(serverTransport),
                    ]);
                    const listed = await client.listTools();
                    expect<unknown>(
                      Object.fromEntries(
                        listed.tools.map((tool) => [
                          tool.name,
                          tool.inputSchema,
                        ]),
                      ),
                    ).toEqual(entry.schemas);
                  }
                  await Promise.all(
                    entry.calls.map((call) =>
                      client!.callTool({
                        name: call.name,
                        arguments: call.input,
                        _meta: { [TOOL_USE_ID_META]: call.callId },
                      }),
                    ),
                  );
                } else if (entry?.type === "tool.calls") {
                  cursor++;
                  signal();
                  // Model delivery precedes MCP dispatch under the amended contract.
                  const modelMessage = entry.message ?? assistant(undefined);
                  modelMessage.message.id = crypto.randomUUID();
                  modelMessage.message.stop_reason = "tool_use";
                  modelMessage.message.content = entry.calls.map((call) => ({
                    type: "tool_use",
                    id: call.callId,
                    name: `mcp__neuve__${call.name}`,
                    input: call.input,
                  }));
                  if (!entry.dispatchOnly) yield modelMessage;
                  const server = options.mcpServers?.neuve;
                  if (server?.type !== "sdk")
                    throw new Error("Missing SDK server");
                  if (client === undefined) {
                    client = new Client({ name: "test", version: "1" });
                    const [clientTransport, serverTransport] =
                      InMemoryTransport.createLinkedPair();
                    await Promise.all([
                      client.connect(clientTransport),
                      server.instance.connect(serverTransport),
                    ]);
                    const listed = await client.listTools();
                    expect(listed.tools.length).toBeGreaterThan(0);
                    for (const tool of listed.tools)
                      expect(tool.inputSchema).toEqual({
                        type: "object",
                        properties: { value: { type: "string", minLength: 2 } },
                        required: ["value"],
                        additionalProperties: false,
                      });
                  }
                  const results = Promise.all(
                    entry.calls.map((call) =>
                      client!.callTool({
                        name: call.name,
                        arguments: call.input,
                        _meta: { [TOOL_USE_ID_META]: call.callId },
                      }),
                    ),
                  );
                  const callback = results.then((results) =>
                    entry.check?.(results),
                  );
                  if (entry.background) {
                    const tracked = callback
                      .catch((cause: unknown) => {
                        callbackFailure = cause;
                        signal();
                      })
                      .finally(() => callbacks.delete(tracked));
                    callbacks.add(tracked);
                  } else await callback;
                } else if (entry?.type === "runtime_exit") {
                  cursor++;
                  signal();
                  return;
                } else if (entry?.type === "stream_failure") {
                  cursor++;
                  signal();
                  throw new ClaudeSdkError({ method: "messages" });
                } else await waiting;
              }
            }
            return {
              messages: Stream.fromAsyncIterable(
                { [Symbol.asyncIterator]: messages },
                () => new ClaudeSdkError({ method: "messages" }),
              ).pipe(
                Stream.tap((frame) =>
                  Effect.sync(() => {
                    // Reason: every delivered fixture must give identical validity through both schema entrypoints.
                    expect(frameShapeIssues(frame).length === 0).toBe(
                      validFrame(frame),
                    );
                  }),
                ),
              ),
              offer: (message) =>
                Effect.sync(() => {
                  const expected = take("prompt.offer");
                  if (typeof expected.message === "string")
                    expect(message.message.content).toBe(expected.message);
                  else {
                    expect(typeof message.message.content).toBe("string");
                    expect(message.message.content).toMatch(expected.message);
                  }
                  expect(message.priority).toBe(expected.priority);
                  expect(message.parent_tool_use_id).toBeNull();
                  expect(message.uuid).toBeDefined();
                  expect(uuids.has(message.uuid!)).toBe(false);
                  uuids.add(message.uuid!);
                  expected.check?.(message);
                }),
              interrupt: Effect.suspend(() =>
                take("query.interrupt").hang ? Effect.never : Effect.void,
              ),
              setModel: (model) =>
                Effect.sync(() =>
                  expect(model).toBe(take("query.set_model").model),
                ),
              applyFlagSettings: (settings) =>
                Effect.sync(() =>
                  expect(settings.effortLevel).toBe(
                    take("query.flags").effortLevel,
                  ),
                ),
              close,
              initializationResult: opening.initNever
                ? Effect.never
                : opening.initFail
                  ? Effect.fail(
                      new ClaudeSdkError({ method: "initializationResult" }),
                    )
                  : Effect.succeed({
                      account: opening.account ?? { tokenSource: "none" },
                      models: opening.models,
                    }),
            };
          }),
      });
    }),
  );
  return { layer, opens };
}

// Check every replayed turn, including denied and undispatched calls, at its public boundary.
export function toolLifecycle() {
  const turns = new Map<string, Map<string, boolean>>();
  return (event: RuntimeEvent) => {
    if (event.type === "turn.started") turns.set(event.turnId, new Map());
    const calls = turns.get(event.turnId);
    if (event.type === "tool.started") {
      expect(calls).toBeDefined();
      expect(calls!.has(event.callId)).toBe(false);
      calls!.set(event.callId, false);
    } else if (event.type === "tool.finished") {
      expect(calls?.get(event.callId)).toBe(false);
      calls!.set(event.callId, true);
    } else if (event.type === "turn.finished") {
      expect(calls).toBeDefined();
      for (const finished of calls!.values()) expect(finished).toBe(true);
      turns.delete(event.turnId);
    }
  };
}
