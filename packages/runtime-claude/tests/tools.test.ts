import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Effect } from "effect";
import type { ToolDefinition } from "@neuve/runtime";
import {
  TOOL_USE_ID_INPUT,
  TOOL_USE_ID_META,
  toolServer,
} from "../src/tools.ts";

const handled: unknown[] = [];
const definition: ToolDefinition = {
  name: "read",
  description: "read",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
  hints: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
  },
  handle: (input) =>
    Effect.sync(() => {
      handled.push(input);
      return { text: "invalid arguments", error: "invalid-input" };
    }),
};

test("round 2 MCP metadata, lossless schemas, raw invalid input and both parallel call-id routes", async () => {
  handled.length = 0;
  const ids: string[] = [];
  let faults = 0;
  const server = toolServer(
    [definition],
    async (tool, input, id) => {
      ids.push(id);
      const outcome = await Effect.runPromise(tool.handle(input));
      return {
        content: [{ type: "text", text: outcome.text }],
        isError: outcome.error !== undefined,
      };
    },
    async () => {
      faults++;
    },
  );
  expect(server).toMatchObject({ alwaysLoad: true, timeout: 2147483647 });
  const client = new Client({ name: "fixture", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([
      client.connect(clientTransport),
      server.instance.connect(serverTransport),
    ]);
    expect(await client.callTool({ name: "missing" })).toMatchObject({
      isError: true,
      content: [
        {
          type: "text",
          text: `Neuve has no tool "missing". This chat's tools are: read.`,
        },
      ],
    });
    expect(faults).toBe(0);
    expect((await client.listTools()).tools).toMatchObject([
      {
        inputSchema: definition.inputSchema,
        _meta: {
          "anthropic/maxResultSizeChars": 500000,
          "anthropic/alwaysLoad": true,
        },
      },
    ]);
    const results = await Promise.all([
      client.callTool({
        name: "read",
        arguments: { value: 42, [TOOL_USE_ID_INPUT]: "unused-stamp" },
        _meta: { [TOOL_USE_ID_META]: "direct" },
      }),
      client.callTool({
        name: "read",
        arguments: await stamped("fallback"),
      }),
    ]);
    expect(ids.sort()).toEqual(["direct", "fallback"]);
    expect(handled).toEqual([
      { value: 42, [TOOL_USE_ID_INPUT]: "unused-stamp" },
      { value: 42 },
    ]);
    for (const result of results)
      expect(result).toMatchObject({
        isError: true,
        content: [{ type: "text", text: "invalid arguments" }],
      });
    expect(
      await client.callTool({ name: "read", arguments: {} }),
    ).toMatchObject({ isError: true });
    expect(handled).toHaveLength(2);
    expect(faults).toBe(1);
  } finally {
    await client.close();
    await server.instance.close();
  }
  async function stamped(id: string) {
    const response = await server.stampToolUseId(
      {
        hook_event_name: "PreToolUse",
        session_id: "fixture",
        transcript_path: "/unused",
        cwd: "/test",
        tool_name: "mcp__neuve__read",
        tool_use_id: id,
        tool_input: { value: 42 },
      },
      id,
      { signal: new AbortController().signal },
    );
    if (
      !("hookSpecificOutput" in response) ||
      response.hookSpecificOutput?.hookEventName !== "PreToolUse"
    )
      throw new Error("fixture stamp");
    return response.hookSpecificOutput.updatedInput;
  }
});

test("round 2 PreToolUse stamps only Neuve input without changing the public schema", async () => {
  const server = toolServer([definition], async () => ({ content: [] }));
  const stampToolUseId = server.stampToolUseId;
  const base = {
    session_id: "fixture",
    transcript_path: "/unused",
    cwd: "/test",
    hook_event_name: "PreToolUse" as const,
    tool_name: "mcp__neuve__read",
    tool_input: { value: "fixture" },
    tool_use_id: "hook-id",
  };
  const response = await stampToolUseId(base, "hook-id", {
    signal: new AbortController().signal,
  });
  expect(response).toMatchObject({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: { value: "fixture", [TOOL_USE_ID_INPUT]: "hook-id" },
    },
  });
  expect(
    await stampToolUseId({ ...base, tool_name: "Bash" }, "hook-id", {
      signal: new AbortController().signal,
    }),
  ).toEqual({});
  await server.instance.close();
});
