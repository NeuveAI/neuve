/**
 * The protocol log: every line each way, redacted before it leaves the runtime, as T3 Code logs
 * decoded messages per thread without deltas (`EventNdjsonLogger.ts`, lines 54–64). Streamed text
 * and command output keep their length only. Codex's own commands, file changes and Neuve's tool
 * calls are kept whole, since they are the run's record of what was done. The person's configuration and skills, which Codex
 * returns whole, are kept as their size, and their plan and balance are removed. Their settings'
 * names, the session's token, and the session's folders and program are replaced by labels
 * everywhere else.
 */
import { appendFileSync } from "node:fs";
import { hostname } from "node:os";
import type { Line } from "./client.ts";
import { NEUVE_SERVER } from "./launch.ts";
import { redact } from "./redact.ts";

export interface LogEntry {
  readonly at: string;
  readonly direction: Line["direction"];
  readonly message: unknown;
}

/** Fields that describe the person's plan and balance, which no redaction rule names. */
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

/** Answers that hold the person's whole configuration or skill list. */
const WHOLE = new Set(["config/read", "skills/list"]);
/** Notifications whose body is streamed text, kept by its length. */
const DELTA = /\/(delta|outputDelta|summaryTextDelta|textDelta)$/;

/**
 * Notifications that name an MCP server. Servers come from the person's configuration and from
 * their plugins and apps, so only Neuve's own keeps its name; a call to any other server keeps its
 * tool's name and its status, and loses its arguments, result and error, which are the person's.
 */
const SERVER_NAMED = /^(mcpServer\/|item\/(started|completed)$)/;
const named = (message: Record<string, unknown>, serving: boolean) => {
  const params = (message.params ?? {}) as Record<string, unknown>;
  const item = params.item as Record<string, unknown> | undefined;
  const ours = (name: unknown) => serving && name === NEUVE_SERVER;
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
  const known: Array<readonly [string, string]> = [[hostname(), "<host>"]];
  const whole = new Set<unknown>();
  /** Set once this session serves Neuve's tools: a server of that name is then Neuve's own. */
  let serving = false;
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
    serves: () => {
      serving = true;
    },
    /** Adds a value to replace wherever it appears, with the label that stands for it. */
    know: (value: string, label: string) => {
      if (value.length > 1) known.push([value, label]);
    },
    onLine: (line: Line) =>
      sink({
        at: new Date().toISOString(),
        direction: line.direction,
        message: redact(scrub(shape(line)), known),
      }),
  };
};

/** A sink that appends each entry as one line of JSON to a file only its owner can read. */
export const appendTo = (path: string) => (entry: LogEntry) =>
  appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
