// Keep work and Neuve tool calls whole. Keep only lengths for deltas, configuration and skill lists.
// Replace known private values with labels before writing.
import { appendFileSync } from "node:fs";
import { hostname } from "node:os";
import type { Line } from "./client.ts";
import type { ToolServers } from "./launch.ts";
import { redact } from "./redact.ts";

export interface LogEntry {
  readonly at: string;
  readonly direction: Line["direction"];
  readonly message: unknown;
}

/** Plan and balance fields that the credential redaction rules do not name. */
const PLAN = /^(planType|credits|balance|individualLimit)$/;
/** The operating system's release, which Codex writes into its user agent. */
const SYSTEM = /\((Mac OS|Windows|Linux)[^)]*\)/g;
const scrub = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(scrub)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [
            key,
            PLAN.test(key) && entry !== null ? "<redacted>" : scrub(entry),
          ]),
        )
      : typeof value === "string"
        ? value.replace(SYSTEM, "(<system>)")
        : value;

const WHOLE = new Set(["config/read", "skills/list"]);
const DELTA = /\/(delta|outputDelta|summaryTextDelta|textDelta)$/;

/**
 * Notifications that name an MCP server. Servers come from the person's configuration and from
 * their plugins and apps, so only Neuve's own keeps its name; a call to any other server keeps its
 * tool's name and its status, and loses its arguments, result and error, which are the person's.
 */
const SERVER_NAMED = /^(mcpServer\/|item\/(started|completed)$)/;
const named = (
  message: Record<string, unknown>,
  serving: ReadonlySet<string>,
) => {
  const params = (message.params ?? {}) as Record<string, unknown>;
  const item = params.item as Record<string, unknown> | undefined;
  const ours = (name: unknown) => typeof name === "string" && serving.has(name);
  const label = (name: unknown) => (ours(name) ? name : "<server>");
  return {
    ...message,
    params: {
      ...params,
      ...("name" in params ? { name: label(params.name) } : {}),
      ...("serverName" in params
        ? { serverName: label(params.serverName) }
        : {}),
      ...(item !== undefined && "server" in item
        ? {
            item: ours(item.server)
              ? item
              : {
                  ...item,
                  server: "<server>",
                  ...Object.fromEntries(
                    ["arguments", "result", "error"]
                      .filter((field) => item[field] != null)
                      .map((field) => [field, "<omitted>"]),
                  ),
                },
          }
        : {}),
    },
  };
};

export const protocolLog = (sink: (entry: LogEntry) => void) => {
  const known = new Map([[hostname(), "<host>"]]);
  const whole = new Set<unknown>();
  let serving: ReadonlySet<string> = new Set();
  const shape = (line: Line): unknown => {
    const message = line.message as Record<string, unknown> | null;
    if (message === null || typeof message !== "object") return message;
    if (line.direction === "out" && typeof message.method === "string") {
      if (WHOLE.has(message.method)) whole.add(message.id);
      return message;
    }
    if (message.method === undefined && whole.delete(message.id))
      return {
        id: message.id,
        result: { omitted: JSON.stringify(message.result ?? null).length },
      };
    if (typeof message.method === "string" && SERVER_NAMED.test(message.method))
      return named(message, serving);
    if (typeof message.method === "string" && DELTA.test(message.method)) {
      const params = (message.params ?? {}) as Record<string, unknown>;
      return {
        ...message,
        params: {
          ...params,
          delta:
            typeof params.delta === "string"
              ? { length: params.delta.length }
              : null,
        },
      };
    }
    return message;
  };
  return {
    serves: (servers: ToolServers) => {
      serving = new Set(Object.keys(servers));
    },
    know: (value: string, label: string) => {
      if (!known.has(value)) known.set(value, label);
    },
    onLine: (line: Line) =>
      sink({
        at: new Date().toISOString(),
        direction: line.direction,
        message: redact(scrub(shape(line)), known),
      }),
  };
};

export const appendTo = (path: string) => (entry: LogEntry) =>
  appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
