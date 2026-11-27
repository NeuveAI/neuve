import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serveOAuthFixture } from "./fixtures/oauth-http";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Fixture, OWNER } from "../../../packages/channel/tests/helpers";
import { config } from "../src/config";
import { forget, store } from "../src/keys";
import { linearPlanningSource } from "../src/linear-plugin";
import { PluginManifest } from "../src/plugin-manifest";
import { PluginOAuth } from "../src/plugin-oauth";
import { saveSession } from "../src/plugin-oauth-store";
import { savePlugins } from "../src/preferences";
import { planningConnections, workspaceLinearPlanning } from "../../neuve-cli/src/workspace-linear";

// A Plan-mode message must read through the workspace's real adapter and plugin bearer, with writes excluded.
test.each(["OAuth", "API key"])("Plan mode reads a Linear issue through the plugin using %s", async (credential) => {
  const keyName = "FIXTURE_PLANNING_KEY";
  const apiKey = "fixture-planning-key";
  const access = 'fixture-"planning"-access';
  const bearer = credential === "OAuth" ? access : apiKey;
  const issue = {
    id: "fixture-uuid", identifier: "PLAN-42", title: "Tighten the plan",
    description: `Read this scope before editing. Authorized with ${bearer}.`, url: "https://linear.app/fixture/issue/PLAN-42",
  };
  const calls: Array<{ name: string; arguments: unknown }> = [];
  const endpoint = serveOAuthFixture(async (request) => {
    if (request.headers.get("authorization") !== `Bearer ${bearer}`)
      return new Response(null, { status: 401 });
    if (request.method === "GET") return new Response(null, { status: 405 });
    const { id, method, params } = await request.json();
    if (id === undefined) return new Response(null, { status: 202 });
    const schema = (field: string) => ({
      type: "object", properties: { [field]: { type: "string" }, includeRelations: { type: "boolean" } },
      required: [field],
    });
    let result;
    if (method === "initialize")
      result = { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "linear", version: "1" } };
    else if (method === "tools/list")
      result = { tools: [
        { name: "list_issues", inputSchema: schema("query") },
        { name: "get_issue", inputSchema: schema("id") },
        { name: "save_issue", inputSchema: schema("id") },
      ] };
    else {
      calls.push({ name: params.name, arguments: params.arguments });
      result = { content: [{ type: "text", text: JSON.stringify(issue) }] };
    }
    return Response.json({ jsonrpc: "2.0", id, result });
  });
  const plugin = PluginManifest.parse({
    manifest: { name: "linear", description: "Fixture", interface: { displayName: "Linear" }, apiKey: { linear: keyName } },
    mcp: { linear: { type: "http", url: endpoint.url.href } },
  });
  const server = plugin.oauth.get("linear");
  if (!server) throw new Error("The fixture requires OAuth");
  const oauth = new PluginOAuth([plugin]);
  const source = linearPlanningSource(plugin);
  const { client, read } = workspaceLinearPlanning({ source });
  const root = await mkdtemp(join(tmpdir(), "workspace-linear-"));
  const previous = config.settings;
  config.settings = root;
  let chat: Awaited<ReturnType<typeof Fixture.create>> | undefined;
  try {
    savePlugins({ linear: true });
    expect(await planningConnections(source)).toEqual({
      connections: [], status: "unavailable", message: "No Linear read operations are configured on this host.",
    });
    await store(keyName, apiKey);
    if (credential === "OAuth") await saveSession(server, {
      kind: "signed-in",
      client: { client_id: "fixture", issuer: endpoint.url.origin },
      discovery: { authorizationServerUrl: endpoint.url.origin },
      tokens: { access_token: access, token_type: "Bearer" },
    });
    expect(await planningConnections(source)).toEqual({
      connections: [{ id: "linear", label: "Linear" }], status: "configured", message: null,
    });
    chat = await Fixture.create({ planning: read });
    chat.script(
      fauxAssistantMessage(fauxToolCall("planning_issue", { connection: "linear", issue: "PLAN-42" }, { id: "read-scope" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Scope read."),
    );
    const watch = await chat.watch();
    await chat.request({ op: "ask", author: OWNER, text: "Read my Linear issue", mode: "plan" });
    const result = await watch.until("result", event => event.call === "read-scope");
    expect(result.error).not.toBe(true);
    expect(result.text).toContain("Authorized with [redacted].");
    await watch.until("reply", event => event.text === "Scope read.");
    await watch.stop();
    expect(calls).toEqual([{ name: "get_issue", arguments: { id: "PLAN-42" } }]);
    expect((await client.connection("linear")).tools.map(tool => tool.name)).toEqual(["list_issues", "get_issue"]);
    savePlugins({ linear: false });
    expect((await planningConnections(source)).status).toBe("unavailable");
  } finally {
    await chat?.dispose();
    await client.close();
    await oauth.signOut(plugin.name, () => {});
    await forget(keyName);
    config.settings = previous;
    await endpoint.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
