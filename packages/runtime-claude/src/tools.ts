import type {
  HookCallback,
  McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  mcpTool,
  TOOL_USE_ID_INPUT,
  TurnFailed,
  unknownTool,
  type Account,
  type ToolDefinition,
} from "@neuve/runtime";
import { z } from "zod";

export const TOOL_TIMEOUT_MS = 2147483647;
export { declaresToolUseId, TOOL_USE_ID_INPUT } from "@neuve/runtime";
export class ClaudeToolDefinitionError extends TurnFailed {
  constructor(
    account: Account["name"],
    readonly toolName: string,
    readonly problem:
      "description-too-long" | "reserved-input-key" = "description-too-long",
  ) {
    super({ account, reason: "protocol-error" });
  }
  override get message() {
    return this.problem === "reserved-input-key"
      ? `Tool ${this.toolName} input schema declares reserved key ${TOOL_USE_ID_INPUT}.`
      : `Tool ${this.toolName} description exceeds 4096 characters.`;
  }
}
export const TOOL_USE_ID_META = "claudecode/toolUseId";
/** SDK types expose McpServer, whose .server accepts lossless, low-level JSON-Schema handlers. */
export function toolServer(
  definitions: ReadonlyArray<ToolDefinition>,
  run: (
    definition: ToolDefinition,
    rawInput: unknown,
    callId: string,
    signal: AbortSignal,
  ) => Promise<CallToolResult>,
  onProtocolFault: () => Promise<void> = async () => {},
  onUnknownTool?: () => Promise<void>,
): McpSdkServerConfigWithInstance & {
  readonly stampToolUseId: HookCallback;
  readonly clearStamps: () => void;
} {
  const stamps = new Map<string, string>();
  /** sdk.d.ts:2827-2840; live-experiments.md (a), Claude Code 2.1.312. */
  const stampToolUseId: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const definition = definitions.find(
      (tool) => `mcp__neuve__${tool.name}` === input.tool_name,
    );
    if (definition === undefined) return {};
    const parsed = z
      .record(z.string(), z.unknown())
      .safeParse(input.tool_input);
    if (!parsed.success || Object.hasOwn(parsed.data, TOOL_USE_ID_INPUT))
      return {};
    stamps.set(input.tool_use_id, definition.name);
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: {
          ...parsed.data,
          [TOOL_USE_ID_INPUT]: input.tool_use_id,
        },
      },
    };
  };
  const instance = new McpServer(
    { name: "neuve", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  const tools = definitions.map((definition) => ({
    ...mcpTool(definition),
    inputSchema: ToolSchema.shape.inputSchema.parse(definition.inputSchema),
    _meta: {
      "anthropic/maxResultSizeChars": 500000,
      ...(definition.deferred ? {} : { "anthropic/alwaysLoad": true }),
    },
  }));
  instance.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  instance.server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra) => {
      const definition = definitions.find(
        (tool) => tool.name === request.params.name,
      );
      if (definition === undefined) {
        await onUnknownTool?.();
        return unknownTool(request.params.name, tools);
      }
      // Live evidence: research/live-experiments.md (a), Claude Code 2.1.312, both parallel calls.
      const input = request.params.arguments ?? {};
      const direct = request.params._meta?.[TOOL_USE_ID_META];
      const stamped = input[TOOL_USE_ID_INPUT];
      const callId = z
        .string()
        .min(1)
        .safeParse(direct ?? stamped);
      if (
        !callId.success ||
        (direct == null && stamps.get(callId.data) !== definition.name)
      ) {
        await onProtocolFault();
        return {
          content: [{ type: "text", text: "Missing tool-use id." }],
          isError: true,
        };
      }
      const adapterStamped = stamps.get(callId.data) === definition.name;
      stamps.delete(callId.data);
      if (adapterStamped && stamped === callId.data) {
        const { [TOOL_USE_ID_INPUT]: _, ...unstamped } = input;
        return run(definition, unstamped, callId.data, extra.signal);
      }
      return run(definition, input, callId.data, extra.signal);
    },
  );
  return {
    type: "sdk",
    name: "neuve",
    instance,
    timeout: TOOL_TIMEOUT_MS,
    stampToolUseId,
    clearStamps: () => stamps.clear(),
  };
}
