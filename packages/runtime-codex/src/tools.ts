/**
 * Neuve's tools, served to Codex as an MCP server over HTTP on the local machine, as T3 Code serves
 * its own (`CodexAdapterV2.ts`, lines 1543–1581). One per session, on a port the system picks,
 * behind a bearer token made for that session; Codex reads the token from an environment variable
 * its configuration names, so the token is on no command line and in no log.
 */
import { timingSafeEqual } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { mcpTool, unknownTool, type ToolDefinition } from "@neuve/runtime";
import { Effect, type Scope } from "effect";
import {
  NEUVE_PLUGINS_SERVER,
  NEUVE_SERVER,
  type ToolServers,
} from "./launch.ts";

const CORE_PATH = "/mcp";
const PLUGINS_PATH = "/plugins/mcp";
const pluginTool = (tool: ToolDefinition) => tool.deferred === true;

/** A call that reached the server: what the session runs, and what Codex gets back. */
export type RunTool = (
  definition: ToolDefinition,
  input: unknown,
  signal: AbortSignal,
  /** Codex's own id for the call, the id of its `mcpToolCall` item (`_meta.callId`, seen live). */
  callId: string | undefined,
) => Promise<CallToolResult>;

/**
 * Answers one HTTP request: the token first, then one stateless MCP exchange. A fresh server and
 * transport per request, since a stateless transport serves a single request.
 */
export const toolHandler = (
  definitions: ReadonlyArray<ToolDefinition>,
  token: string,
  run: RunTool,
) => {
  const expected = Buffer.from(`Bearer ${token}`);
  const endpoints = new Map([
    [
      CORE_PATH,
      mcpEndpoint(
        NEUVE_SERVER,
        definitions.filter((tool) => !pluginTool(tool)),
        run,
      ),
    ],
    [
      PLUGINS_PATH,
      mcpEndpoint(NEUVE_PLUGINS_SERVER, definitions.filter(pluginTool), run),
    ],
  ]);
  return async (request: Request): Promise<Response> => {
    const given = Buffer.from(request.headers.get("authorization") ?? "");
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      return new Response(null, { status: 401 });
    const endpoint = endpoints.get(new URL(request.url).pathname);
    return endpoint ? endpoint(request) : new Response(null, { status: 404 });
  };
};

const mcpEndpoint = (
  name: string,
  definitions: ReadonlyArray<ToolDefinition>,
  run: RunTool,
) => {
  const tools = definitions.map((definition) => ({
    ...mcpTool(definition),
    inputSchema: ToolSchema.shape.inputSchema.parse(definition.inputSchema),
  }));
  return async (request: Request): Promise<Response> => {
    const server = new Server(
      { name, version: "0.1.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
    server.setRequestHandler(CallToolRequestSchema, (call, extra) => {
      const definition = definitions.find(
        (tool) => tool.name === call.params.name,
      );
      return definition === undefined
        ? unknownTool(call.params.name, tools)
        : run(
            definition,
            call.params.arguments ?? {},
            extra.signal,
            typeof call.params._meta?.callId === "string" &&
              call.params._meta.callId.length > 0
              ? call.params._meta.callId
              : undefined,
          );
    });
    // No session id generator: stateless, one exchange per transport.
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  };
};

/** Serves the handler on 127.0.0.1 until the scope closes; returns the address Codex is given. */
export const serveTools = (
  definitions: ReadonlyArray<ToolDefinition>,
  token: string,
  run: RunTool,
) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        // A call lasts as long as its handler; the scope's end stops the server.
        idleTimeout: 0,
        fetch: toolHandler(definitions, token, run),
      }),
    ),
    (server) => Effect.promise(() => server.stop(true)),
  ).pipe(
    // The address is the one bound, so a test that reads it sees where the server listens.
    Effect.map((server): ToolServers => {
      const origin = `http://${server.hostname}:${server.port}`;
      return {
        ...(definitions.some((tool) => !pluginTool(tool))
          ? { [NEUVE_SERVER]: origin + CORE_PATH }
          : {}),
        ...(definitions.some(pluginTool)
          ? { [NEUVE_PLUGINS_SERVER]: origin + PLUGINS_PATH }
          : {}),
      };
    }),
  ) satisfies Effect.Effect<ToolServers, never, Scope.Scope>;
