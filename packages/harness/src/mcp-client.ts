import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { Client } from "@modelcontextprotocol/client";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio";
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/client";
import { Context, Data, Deferred, Effect, Layer, Scope, Exit } from "effect";
import type { z } from "zod";
import {
  UnlistedVariable,
  expand,
  type IntegrationFile,
  type IntegrationServer,
  type Integrations,
} from "./integrations.ts";
import { convertMcpInputSchema } from "./toolkit.ts";

/**
 * The MCP client service (10.51): the official TypeScript SDK's v2 client
 * (`@modelcontextprotocol/client` 2.3.1, within the 10-day release-age policy) wrapped in an Effect
 * service. One connection per server per scope: the scope is a run, or a cycle's scope fetch, and
 * the connection closes with it, so a proxied tool lives only as long as the work that uses it.
 *
 * At connection the server's tools are listed and only those the user allowed, and the server does
 * not mark as writing or destructive, are kept; each one's
 * input schema is converted to zod with `z.fromJSONSchema`, and a lossy conversion refuses the tool
 * with the reason (10.53, `convertMcpInputSchema`). Results are untrusted data.
 */

export class IntegrationUnavailable extends Data.TaggedError(
  "IntegrationUnavailable",
)<{
  readonly server: string;
  readonly message: string;
}> {}

export class McpCallFailed extends Data.TaggedError("McpCallFailed")<{
  readonly server: string;
  readonly tool: string;
  readonly message: string;
}> {}

export interface ProxiedTool {
  readonly name: string;
  readonly description: string;
  readonly input: z.ZodType;
  readonly readOnlyHint: boolean | undefined;
  readonly definitionHash?: string;
}

export interface CallOutcome {
  /** The text content blocks, joined. */
  readonly text: string;
  /** The structured content, when the server returned one. */
  readonly structured: unknown;
  /** The server's own `isError`: a failed call answered as data. */
  readonly isError: boolean;
}

export interface McpConnection {
  readonly server: string;
  readonly tools: ReadonlyArray<ProxiedTool>;
  /** Allowed tools the server does not list, and listed allowed tools whose schema was lossy. */
  readonly refused: ReadonlyArray<{
    readonly tool: string;
    readonly reason: string;
  }>;
  readonly call: (
    tool: string,
    input: unknown,
  ) => Effect.Effect<CallOutcome, McpCallFailed>;
}

const CLIENT_INFO = { name: "neuve-harness", version: "0.1.0" };
const CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 30_000;

const message = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 300);

/** Builds the transport with the listed variables expanded from the environment now. */
const transportFor = (name: string, server: IntegrationServer, options: McpClientOptions) => {
  const unset: Array<string> = [];
  const take = (value: string) => {
    const expanded = expand(value, server.variables);
    unset.push(...expanded.unset);
    return expanded.value;
  };
  try {
    if (server.transport.type === "stdio") {
      const listed = Object.fromEntries(
        server.variables.flatMap((variable) => {
          const value = process.env[variable];
          return value === undefined ? [] : [[variable, value]];
        }),
      );
      const env = {
        ...getDefaultEnvironment(),
        ...listed,
        ...Object.fromEntries(
          Object.entries(server.transport.env ?? {}).map(([key, value]) => [
            key,
            take(value),
          ]),
        ),
      };
      const missing = server.variables.filter(
        (variable) => !(variable in listed),
      );
      unset.push(...missing);
      return {
        unset,
        transport: new StdioClientTransport({
          command: server.transport.command,
          args: (server.transport.args ?? []).map(take),
          env,
          // Never the repository: what the server reads is never the reviewed tree.
          cwd: homedir(),
          stderr: "ignore",
        }),
      };
    }
    const headers = Object.fromEntries(
      Object.entries(server.transport.headers ?? {}).map(([key, value]) => [
        key,
        take(value),
      ]),
    );
    return {
      unset,
      transport: new StreamableHTTPClientTransport(
        new URL(take(server.transport.url)),
        {
          requestInit: { headers },
          ...options.http?.(name),
        },
      ),
    };
  } catch (error) {
    if (error instanceof UnlistedVariable)
      throw new IntegrationUnavailable({
        server: name,
        message: error.message,
      });
    throw error;
  }
};

/** Opens one server's connection in the current scope; it closes when the scope does. */
export type McpClientOptions = {
  readonly sanitizeError?: (error: unknown) => string;
  readonly captureDefinitions?: boolean;
  readonly http?: (name: string) => Pick<StreamableHTTPClientTransportOptions, "authProvider" | "fetch"> | undefined;
};

export const connect = (
  name: string,
  server: IntegrationServer,
  options: McpClientOptions = {},
) =>
  Effect.gen(function* () {
    const safeMessage = (error: unknown) =>
      options.sanitizeError
        ? options.sanitizeError(error).slice(0, 300)
        : message(error);
    const built = yield* Effect.try({
      try: () => transportFor(name, server, options),
      catch: (error) =>
        error instanceof IntegrationUnavailable
          ? error
          : new IntegrationUnavailable({
              server: name,
              message: safeMessage(error),
            }),
    });
    if (built.unset.length > 0)
      return yield* new IntegrationUnavailable({
        server: name,
        message: `listed variable(s) not set in the environment: ${[...new Set(built.unset)].join(", ")}`,
      });
    const client = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const client = new Client(CLIENT_INFO);
          await client.connect(built.transport, {
            timeout: CONNECT_TIMEOUT_MS,
          });
          return client;
        },
        catch: (error) =>
          new IntegrationUnavailable({
            server: name,
            message: `could not connect: ${safeMessage(error)}`,
          }),
      }),
      (client) => Effect.promise(() => client.close().catch(() => undefined)),
    );
    const listed = yield* Effect.tryPromise({
      try: () => client.listTools(),
      catch: (error) =>
        new IntegrationUnavailable({
          server: name,
          message: `could not list tools: ${safeMessage(error)}`,
        }),
    });
    const tools: Array<ProxiedTool> = [];
    const refused: Array<{ tool: string; reason: string }> = [];
    for (const allowed of server.tools) {
      const tool = listed.tools.find((entry) => entry.name === allowed);
      if (tool === undefined) {
        refused.push({ tool: allowed, reason: "the server does not list it" });
        continue;
      }
      // The user's list is required, and the server's own hints can still refuse: a tool the
      // server says writes or destroys is never proxied, whatever the list says (10.53).
      const writes = [
        ...(tool.annotations?.readOnlyHint === false
          ? ["readOnlyHint: false"]
          : []),
        ...(tool.annotations?.destructiveHint === true
          ? ["destructiveHint: true"]
          : []),
      ];
      if (writes.length > 0) {
        refused.push({
          tool: allowed,
          reason: `the server marks it as writing (${writes.join(", ")})`,
        });
        continue;
      }
      const converted = convertMcpInputSchema(tool.inputSchema);
      if (converted.status === "refused") {
        refused.push({
          tool: allowed,
          reason: `lossy schema: ${converted.reason}${converted.lost.length === 0 ? "" : ` (${converted.lost.slice(0, 4).join("; ")})`}`,
        });
        continue;
      }
      tools.push({
        name: tool.name,
        description: (tool.description ?? "").slice(0, 1_000),
        input: converted.schema,
        readOnlyHint: tool.annotations?.readOnlyHint,
        ...(options.captureDefinitions
          ? {
              definitionHash: createHash("sha256")
                .update(JSON.stringify(tool))
                .digest("hex"),
            }
          : {}),
      });
    }
    const call = (tool: string, input: unknown) =>
      Effect.gen(function* () {
        const proxied = tools.find((entry) => entry.name === tool);
        if (proxied === undefined)
          return yield* new McpCallFailed({
            server: name,
            tool,
            message: "not an allowed tool of this server",
          });
        const parsed = proxied.input.safeParse(input);
        if (!parsed.success)
          return yield* new McpCallFailed({
            server: name,
            tool,
            message: `input refused by the tool's schema: ${parsed.error.issues[0]?.message ?? "invalid"}`,
          });
        const result = yield* Effect.tryPromise({
          try: (signal) =>
            client.callTool(
              { name: tool, arguments: parsed.data as Record<string, unknown> },
              { signal, timeout: CALL_TIMEOUT_MS },
            ),
          catch: (error) =>
            new McpCallFailed({
              server: name,
              tool,
              message: safeMessage(error),
            }),
        });
        const content = (result.content ?? []) as ReadonlyArray<{
          type: string;
          text?: string;
        }>;
        const outcome: CallOutcome = {
          text: content
            .filter(
              (block) =>
                block.type === "text" && typeof block.text === "string",
            )
            .map((block) => block.text)
            .join("\n"),
          structured: result.structuredContent,
          isError: result.isError === true,
        };
        return outcome;
      }).pipe(
        Effect.withSpan("harness.mcp.call", {
          attributes: { "harness.mcp.server": name, "harness.mcp.tool": tool },
        }),
      );
    const connection: McpConnection = { server: name, tools, refused, call };
    return connection;
  }).pipe(
    Effect.withSpan("harness.mcp.connect", {
      attributes: { "harness.mcp.server": name },
    }),
  );

/** The integrations of one run: each configured server, connected at most once, on first use. */
export class McpClients extends Context.Service<
  McpClients,
  {
    readonly integrations: Integrations | IntegrationFile;
    readonly get: (
      server: string,
    ) => Effect.Effect<McpConnection, IntegrationUnavailable>;
  }
>()("@neuve/harness/McpClients") {}

/** The service for one scope (a run or a scope fetch): connections close when the scope closes. */
export const mcpClientsLayer = (
  integrations: Integrations | IntegrationFile,
  options: McpClientOptions = {},
) =>
  Layer.effect(
    McpClients,
    Effect.gen(function* () {
      const scope = yield* Scope.Scope;
      const opened = new Map<
        string,
        Deferred.Deferred<McpConnection, IntegrationUnavailable>
      >();
      const get = (server: string) =>
        Effect.gen(function* () {
          const held = opened.get(server);
          if (held !== undefined) return yield* Deferred.await(held);
          const deferred = yield* Deferred.make<
            McpConnection,
            IntegrationUnavailable
          >();
          opened.set(server, deferred);
          const definitions = "servers" in integrations
            ? integrations.servers
            : integrations.status === "configured" ? integrations.file.servers : undefined;
          const definition = definitions?.[server];
          // A caller that gives up (a timeout) never leaves the next caller waiting forever.
          const exit = yield* Effect.exit(
            definition === undefined
              ? Effect.fail(
                  new IntegrationUnavailable({
                    server,
                    message: "no such server is configured",
                  }),
                )
              : connect(server, definition, options).pipe(
                  Scope.provide(scope),
                  Effect.onInterrupt(() =>
                    Effect.andThen(
                      Deferred.fail(
                        deferred,
                        new IntegrationUnavailable({
                          server,
                          message: "the connection attempt was interrupted",
                        }),
                      ),
                      Effect.sync(() => opened.delete(server)),
                    ),
                  ),
                ),
          );
          yield* Deferred.done(deferred, exit);
          return yield* Exit.isSuccess(exit)
            ? Effect.succeed(exit.value)
            : Effect.failCause(exit.cause);
        });
      return McpClients.of({ integrations, get });
    }),
  );
