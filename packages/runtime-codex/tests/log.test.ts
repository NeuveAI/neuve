// Why: the protocol log is written beside a run and must never hold the person's configuration,
// their settings' names, the session's token, or streamed model text, whatever Codex sends.
import { expect, test } from "bun:test";
import { protocolLog, type LogEntry } from "../src/log.ts";

test("the protocol log keeps every line, and none of what is the person's", () => {
  const entries: LogEntry[] = [];
  const log = protocolLog((entry) => entries.push(entry));
  log.serves({
    neuve: "http://127.0.0.1/mcp",
    neuve_plugins: "http://127.0.0.1/plugins/mcp",
  });
  log.know("tok-1234567890", "<token>");
  log.know("own-server", "<server-1>");
  log.onLine({
    direction: "out",
    message: { id: 1, method: "config/read", params: {} },
  });
  log.onLine({
    direction: "in",
    message: {
      id: 1,
      result: { config: { mcp_servers: { "own-server": {} } } },
    },
  });
  log.onLine({
    direction: "in",
    message: {
      method: "item/agentMessage/delta",
      params: { turnId: "t", delta: "secret words" },
    },
  });
  log.onLine({
    direction: "in",
    message: {
      method: "item/completed",
      params: {
        item: {
          type: "mcpToolCall",
          server: "own-server",
          tool: "lookup",
          arguments: { query: "the person's words" },
          note: "tok-1234567890",
        },
      },
    },
  });
  log.onLine({ direction: "in", message: { unparsed: 12 } });
  log.onLine({
    direction: "in",
    message: {
      method: "account/updated",
      params: {
        planType: "example-plan",
        userAgent: "neuve/1.0 (Mac OS 0.0.0-test; test-arch)",
      },
    },
  });
  expect(entries).toHaveLength(6);
  expect(entries[5]!.message).toEqual({
    method: "account/updated",
    params: { planType: "<redacted>", userAgent: "neuve/1.0 (<system>)" },
  });
  const text = JSON.stringify(entries);
  expect(text).not.toContain("own-server");
  expect(text).not.toContain("tok-1234567890");
  expect(text).not.toContain("secret words");
  expect(text).not.toContain("the person's words");
  expect(entries[1]!.message).toEqual({ id: 1, result: { omitted: 44 } });
  expect(entries[2]!.message).toMatchObject({
    params: { delta: { length: 12 } },
  });
  expect(entries[3]!.message).toMatchObject({
    params: {
      item: {
        server: "<server>",
        tool: "lookup",
        arguments: "<omitted>",
        note: "<token>",
      },
    },
  });
  // A server the person's plugins bring has a name nobody told the log; it goes all the same.
  log.onLine({
    direction: "in",
    message: {
      method: "mcpServer/startupStatus/updated",
      params: { name: "plugin_server" },
    },
  });
  log.onLine({
    direction: "in",
    message: {
      method: "mcpServer/startupStatus/updated",
      params: { name: "neuve" },
    },
  });
  log.onLine({
    direction: "in",
    message: {
      method: "mcpServer/startupStatus/updated",
      params: { name: "neuve_plugins" },
    },
  });
  expect(entries.slice(-3).map((e) => e.message)).toEqual([
    { method: "mcpServer/startupStatus/updated", params: { name: "<server>" } },
    { method: "mcpServer/startupStatus/updated", params: { name: "neuve" } },
    {
      method: "mcpServer/startupStatus/updated",
      params: { name: "neuve_plugins" },
    },
  ]);
});

test("a server named neuve is the person's when this session serves no Neuve tools", () => {
  const entries: LogEntry[] = [];
  const log = protocolLog((entry) => entries.push(entry));
  log.onLine({
    direction: "in",
    message: {
      method: "item/completed",
      params: {
        item: {
          type: "mcpToolCall",
          server: "neuve",
          arguments: { q: "theirs" },
        },
      },
    },
  });
  expect(entries[0]!.message).toMatchObject({
    params: { item: { server: "<server>", arguments: "<omitted>" } },
  });
});
