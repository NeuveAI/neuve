import { expect, test } from "bun:test";
import { Channel, type Fields } from "@ace/channel";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

import { serveOAuthFixture } from "./fixtures/oauth-http";
import { expandPluginValue, PluginManifest } from "../src/plugin-manifest";
import { pluginTools } from "../src/plugin-tools";

// The parser supplies a settings label and limits expansion to the credentials declared in the files.
test("the manifest resolves the display name and restricts expansion to resolved credentials", () => {
	const plugin = {
		manifest: { name: "example", description: "Example plugin" },
		mcp: { mcpServers: { example: {
			type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer ${EXAMPLE_KEY}" },
		} } },
	};
	const parsed = PluginManifest.parse(plugin);
	expect(parsed.displayName).toBe("example");
	expect(PluginManifest.parse({
		...plugin, manifest: { ...plugin.manifest, interface: { displayName: "Example" } },
	}).displayName).toBe("Example");
	expect([...parsed.variables]).toEqual(["EXAMPLE_KEY"]);
	const credentials = new Map([["EXAMPLE_KEY", "sample"]]);
	expect(expandPluginValue("Bearer ${EXAMPLE_KEY}", credentials)).toBe("Bearer sample");
	expect(() => expandPluginValue("${OPENAI_API_KEY}", credentials)).toThrow("Missing plugin variable OPENAI_API_KEY");
	expect(PluginManifest.safeParse({ ...plugin, manifest: { ...plugin.manifest, author: {} } }).success).toBe(false);
	expect(PluginManifest.safeParse({ ...plugin, mcp: { mcpServers: { example: {
		...plugin.mcp.mcpServers.example, command: "bun",
	} } } }).success).toBe(false);
});

// Claude Code can carry the same untyped stdio definition inline and in .mcp.json.
test("a Claude Code plugin can declare an untyped stdio server inline or beside its manifest", () => {
	const server = { command: "npx", args: ["chrome-devtools-mcp@latest"] };
	const manifest = {
		name: "chrome-devtools-mcp", description: "Reliable automation in Chrome",
		version: "0.21.0", author: { name: "Chrome DevTools" }, homepage: "https://developer.chrome.com/",
		repository: "https://github.com/ChromeDevTools/chrome-devtools-mcp", license: "Apache-2.0",
		keywords: ["chrome", "devtools"],
	};
	const mcpServers = { "chrome-devtools": server };
	const expected = { "chrome-devtools": { type: "stdio", ...server } };
	expect(PluginManifest.parse({ manifest: { ...manifest, mcpServers } }).servers).toEqual(expected);
	expect(PluginManifest.parse({ manifest, mcp: { mcpServers } }).servers).toEqual(expected);
	expect(PluginManifest.parse({ manifest: { ...manifest, mcpServers }, mcp: { mcpServers } }).servers).toEqual(expected);
});

const server = String.raw`
import { createInterface } from "node:readline";
if (process.env.PLUGIN_FIXTURE === "unusable") process.exit(1);
const inputSchema = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };
for await (const line of createInterface({ input: process.stdin })) {
	const { id, method, params } = JSON.parse(line);
	if (id === undefined) continue;
	const result = method === "initialize"
		? { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" } }
		: method === "tools/list" ? { tools: [
			{ name: "write.issue", description: "w".repeat(4096), inputSchema },
			{ name: "r".repeat(70), description: "Read", inputSchema, annotations: { readOnlyHint: true } },
			{ name: "long_description", description: "w".repeat(4097), inputSchema },
			{ name: "reserved", inputSchema: { ...inputSchema, properties: { value: { type: "object", required: ["__neuve_tool_use_id"] } } } },
		] }
		: { content: [{ type: "text", text: (process.env.PLUGIN_FIXTURE === "fixture-value" ? "authorized" : "missing") + ":" + params.name + ":" + params.arguments.text }] };
	console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
}
`;

// A live MCP server exercises Pi's tool offer and dispatch across settings changes on one channel.
test("a running channel discovers, dispatches, and hides a plugin at the next request", async () => {
	const plugin = PluginManifest.parse({
		manifest: { name: "fixture", description: "Local MCP fixture" },
		mcp: { mcpServers: { fixture: {
			type: "stdio", command: process.execPath, args: ["--no-env-file", "--eval", server],
			env: { PLUGIN_FIXTURE: "${PLUGIN_FIXTURE}" },
		} } },
	});
	let enabled = false;
	let credential: string | undefined;
	const log: Array<{ event: string; fields?: Fields }> = [];
	const plugins = pluginTools(
		(_level, event, fields) => log.push({ event, fields }),
		[plugin], () => ({ fixture: enabled }), async () => credential,
	);
	let refreshed: Promise<void> = Promise.resolve();
	const refresh = plugins.refresh;
	plugins.refresh = registry => refreshed = refresh(registry);
	const model = { provider: "faux", modelId: "agent" };
	const fake = fauxProvider({ provider: model.provider, models: [{ id: model.modelId }], tokensPerSecond: 100_000 });
	const models = createModels();
	models.setProvider(fake.provider);
	const channel = await Channel.open({
		id: "plugin-test", name: "plugin-test", owner: "owner", project: import.meta.dir,
		storage: new MemoryStorage(), defaultModel: async () => model, models, plugins,
		env: cwd => new NodeExecutionEnv({ cwd }),
		directory: { self: { id: "plugin-test", name: "plugin-test" }, list: async () => [], deliver: async () => {} },
		log: (_level, event, fields) => log.push({ event, fields }),
	});
	async function ask(mode: "ace" | "plan" = "ace", call = false) {
		let offered: string[] = [];
		let result: unknown;
		fake.appendResponses([request => {
			offered = getCurrentTools(request.messages).map(tool => tool.name).filter(name => name.startsWith("fixture_"));
			if (call) return fauxAssistantMessage([
				fauxToolCall("fixture_write_issue", { text: "tool argument" }, { id: "mcp-write" }),
			], { stopReason: "toolUse" });
			return fauxAssistantMessage("Done");
		}]);
		if (call) fake.appendResponses([request => {
			const message = request.messages.findLast(item => item.role === "toolResult");
			if (message?.role === "toolResult") result = message.content;
			return fauxAssistantMessage("Done");
		}]);
		const response = await channel.handle({ op: "ask", author: "owner", text: "Check plugin", mode }, () => {});
		if (typeof response !== "object" || !response || !("submission" in response) || typeof response.submission !== "number")
			throw new Error("Channel did not accept the request");
		expect(await channel.handle({ op: "wait", submission: response.submission }, () => {})).toBe("done");
		return { offered, result };
	}
	try {
		expect((await ask()).offered).toEqual([]);
		await refreshed;
		enabled = true;
		expect((await ask()).offered).toEqual([]);
		await refreshed;
		expect(log).toContainEqual({ event: "plugin.credential.unavailable", fields: { plugin: "fixture", name: "PLUGIN_FIXTURE" } });
		credential = "unusable";
		expect((await ask()).offered).toEqual([]);
		await refreshed;
		expect(log).toContainEqual({ event: "plugin.connection.failed", fields: { plugin: "fixture", server: "fixture" } });
		credential = "fixture-value";
		await ask();
		await refreshed;
		expect(await ask("ace", true)).toEqual({
			offered: ["fixture_write_issue", "fixture_" + "r".repeat(44)],
			result: [{ type: "text", text: "authorized:write.issue:tool argument" }],
		});
		expect(log).toContainEqual({ event: "plugin.connected", fields: { plugin: "fixture", server: "fixture", tools: 2 } });
		expect(log).toContainEqual({ event: "plugin.tool.call", fields: { plugin: "fixture", tool: "fixture_write_issue", outcome: "ok" } });
		expect(log.filter(item => item.event === "plugin.tool.refused").map(item => item.fields?.reason)).toEqual([
			"description exceeds 4096 characters", "reserved input key",
		]);
		expect(JSON.stringify(log)).not.toContain("tool argument");
		expect(JSON.stringify(log)).not.toContain("fixture-value");
		expect((await ask("plan")).offered).toEqual([]);
		enabled = false;
		expect((await ask()).offered).toEqual([]);
	} finally {
		await channel.close();
	}
});

// Keep initialize unanswered through channel open and two admissions, then let the same request finish.
test("an unanswered MCP connection does not delay channel open or messages", async () => {
	const initialize = Promise.withResolvers<void>();
	const connected = Promise.withResolvers<void>();
	let initializations = 0;
	const endpoint = serveOAuthFixture(async request => {
		if (request.method === "GET") return new Response(null, { status: 405 });
		const { id, method, params } = await request.json();
		if (id === undefined) return new Response(null, { status: 202 });
		if (method === "initialize") {
			initializations++;
			await initialize.promise;
			return Response.json({ jsonrpc: "2.0", id, result: {
				protocolVersion: params.protocolVersion, capabilities: { tools: {} },
				serverInfo: { name: "pending", version: "1" },
			} });
		}
		return Response.json({ jsonrpc: "2.0", id, result: {
			tools: [{ name: "answer", inputSchema: { type: "object" } }],
		} });
	});
	const plugin = PluginManifest.parse({
		manifest: { name: "pending", description: "Holds initialization" },
		mcp: { pending: { type: "http", url: endpoint.url.href, headers: { Authorization: "Bearer fixture" } } },
	});
	const plugins = pluginTools(() => {}, [plugin], () => ({ pending: true }));
	const refresh = plugins.refresh;
	plugins.refresh = registry => refresh(registry).then(() => { connected.resolve(); });
	const model = { provider: "faux", modelId: "agent" };
	const fake = fauxProvider({ provider: model.provider, models: [{ id: model.modelId }], tokensPerSecond: 100_000 });
	const models = createModels();
	models.setProvider(fake.provider);
	let channel: Channel | undefined;
	try {
		const before = performance.now();
		channel = await Channel.open({
			id: "pending-test", name: "pending-test", owner: "owner", project: import.meta.dir,
			storage: new MemoryStorage(), defaultModel: async () => model, models, plugins,
			env: cwd => new NodeExecutionEnv({ cwd }),
			directory: { self: { id: "pending-test", name: "pending-test" }, list: async () => [], deliver: async () => {} },
			log: () => {},
		});
		const opened = channel;
		async function ask() {
			const offer = Promise.withResolvers<string[]>();
			fake.appendResponses([request => {
				offer.resolve(getCurrentTools(request.messages).map(tool => tool.name).filter(name => name.startsWith("pending_")));
				return fauxAssistantMessage("Done");
			}]);
			const response = await opened.handle({ op: "ask", author: "owner", text: "Say hello" }, () => {});
			if (typeof response !== "object" || !response || !("submission" in response) || typeof response.submission !== "number")
				throw new Error("Channel did not accept the request");
			expect(await opened.handle({ op: "wait", submission: response.submission }, () => {})).toBe("done");
			return offer.promise;
		}
		expect(await ask()).toEqual([]);
		expect(await ask()).toEqual([]);
		expect(performance.now() - before).toBeLessThan(2000);
		initialize.resolve();
		await connected.promise;
		expect(await ask()).toEqual(["pending_answer"]);
		expect(initializations).toBe(1);
	} finally {
		initialize.resolve();
		await channel?.close();
		await endpoint.stop(true);
	}
});

// Closing while a credential read is unanswered must let shutdown finish and prevent a later install.
test("a keychain read that finishes after close cannot install plugin tools", async () => {
	const plugin = PluginManifest.parse({
		manifest: { name: "fixture", description: "Blocked credential" },
		mcp: { fixture: { command: process.execPath, args: ["--no-env-file", "--eval", server], env: { PLUGIN_FIXTURE: "${PLUGIN_FIXTURE}" } } },
	});
	const credential = Promise.withResolvers<string>();
	const waiting = Promise.withResolvers<void>();
	const plugins = pluginTools(() => {}, [plugin], () => ({ fixture: true }), () => {
		waiting.resolve();
		return credential.promise;
	});
	const { createRegistry } = await import("@earendil-works/pi-durable");
	const registry = createRegistry();
	const refresh = plugins.refresh(registry);
	try {
		await waiting.promise;
		await plugins.close();
	} finally {
		credential.resolve("fixture-value");
		await refresh;
	}
	expect(registry.snapshot().installed()).toEqual([]);
});
