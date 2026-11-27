import { z } from "zod";
import { Effect, ManagedRuntime } from "effect";
import {
  McpClients,
  mcpClientsLayer,
  type McpClientOptions,
  type McpConnection,
} from "./mcp-client.ts";
import { type IntegrationFile, type Integrations } from "./integrations.ts";

export { IntegrationFile } from "./integrations.ts";

/** Coding sessions own their MCP lifetimes without changing independent review defaults. */
export type LinearMcpCall = {
  server: string;
  tool: string;
  startedAt: string;
  ms: number;
  definitionHash: string | null;
  outcome: "completed" | "provider-error" | "failed" | "cancelled";
};
export function linearMcpSession(
  integrations: Integrations | IntegrationFile,
  options: Pick<McpClientOptions, "http"> & {
    capture?(call: LinearMcpCall): void;
  } = {},
) {
  const { capture, ...transport } = options;
  const makeRuntime = () =>
    ManagedRuntime.make(
      mcpClientsLayer(integrations, {
        ...transport,
        sanitizeError: (error) => {
          const parsed = z
            .object({
              code: z.union([z.string(), z.number()]).optional(),
              status: z.number().optional(),
            })
            .safeParse(error);
          if (parsed.success && parsed.data.code === "REQUEST_TIMEOUT")
            return "planning:timeout";
          if (parsed.success && parsed.data.status === 401)
            return "planning:reconnect-required";
          if (parsed.success && parsed.data.status === 403)
            return "planning:denied";
          if (parsed.success && parsed.data.status === 429)
            return "planning:rate-limited";
          return "planning:disconnected";
        },
        captureDefinitions: true,
      }),
    );
  type OwnedRuntime = {
    runtime: ReturnType<typeof makeRuntime>;
    close(): Promise<void>;
  };
  const current = new Map<string, OwnedRuntime>();
  const owned = new Set<OwnedRuntime>();
  const pending = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  const track = <A>(operation: () => Promise<A>): Promise<A> => {
    if (closing) return Promise.reject(new Error("planning:disconnected"));
    const promise = operation();
    pending.add(promise);
    void promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    );
    return promise;
  };
  const withConnection = async <A, E>(
    server: string,
    signal: AbortSignal | undefined,
    use: (connection: McpConnection) => Effect.Effect<A, E>,
  ): Promise<A> => {
    let entry = current.get(server);
    if (!entry) {
      const runtime = makeRuntime();
      let disposed: Promise<void> | undefined;
      const created: OwnedRuntime = {
        runtime,
        close: () =>
          (disposed ??= runtime.dispose().finally(() => owned.delete(created))),
      };
      entry = created;
      current.set(server, created);
      owned.add(created);
    }
    const held = entry;
    let acquisitionFailed = false;
    try {
      return await held.runtime.runPromise(
        Effect.flatMap(McpClients, (clients) =>
          clients.get(server).pipe(
            Effect.tapError(() =>
              Effect.sync(() => {
                acquisitionFailed = true;
              }),
            ),
            Effect.flatMap(use),
          ),
        ),
        { signal },
      );
    } finally {
      // A failed acquisition is cached by the review-scoped service. Retire only
      // this server's runtime so a later planning read can reconnect independently.
      if (acquisitionFailed && current.get(server) === held) {
        current.delete(server);
        await held.close();
      }
    }
  };
  return {
    integrations,
    connection(server: string, signal?: AbortSignal) {
      return track(() => withConnection(server, signal, Effect.succeed));
    },
    call(server: string, tool: string, input: unknown, signal?: AbortSignal) {
      return track(async () => {
        const started = Date.now();
        let definitionHash: string | null = null;
        let outcome: LinearMcpCall["outcome"] = "failed";
        try {
          const result = await withConnection(server, signal, (connection) => {
            definitionHash =
              connection.tools.find((entry) => entry.name === tool)
                ?.definitionHash || null;
            return connection.call(tool, input);
          });
          outcome = result.isError ? "provider-error" : "completed";
          return result;
        } finally {
          capture?.({
            server,
            tool,
            startedAt: new Date(started).toISOString(),
            ms: Date.now() - started,
            definitionHash,
            outcome: signal?.aborted ? "cancelled" : outcome,
          });
        }
      });
    },
    close() {
      return (closing ??= Promise.resolve().then(async () => {
        await Promise.allSettled([...owned].map((entry) => entry.close()));
        await Promise.allSettled([...pending]);
        current.clear();
      }));
    },
  };
}
export type LinearMcpSession = ReturnType<typeof linearMcpSession>;
