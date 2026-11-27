import { expect, test } from "bun:test";
import { Channel, type Fields } from "@ace/channel";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Effect } from "effect";

import { Fixture, OWNER } from "../../../packages/channel/tests/helpers";
import { policy } from "../../../packages/harness/src/chat-runtime/transcript";
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
	if (method === "tools/call" && params.arguments.text === "drop transport") process.exit(0);
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

// Exercise the prompt from a real channel request and the bridge policy that consumes it.
test("connected plugin guidance reaches pi and the bridged policy only while its tools are offered", async () => {
	const apiKey = "fixture-tracker-key";
	let instructions = `Use find_issue to look up a ticket by ID.\nProvider detail: ${apiKey}`;
	let enabled = true;
	const endpoint = serveOAuthFixture(async request => {
		if (request.headers.get("authorization") !== `Bearer ${apiKey}`) return new Response(null, { status: 401 });
		if (request.method === "GET") return new Response(null, { status: 405 });
		const { id, method, params } = await request.json();
		if (id === undefined) return new Response(null, { status: 202 });
		const result = method === "initialize"
			? { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "tracker", version: "1" }, instructions }
			: { tools: [{ name: "find_issue", description: "Find a ticket by ID.", inputSchema: { type: "object" } }] };
		return Response.json({ jsonrpc: "2.0", id, result });
	});
	const plugin = PluginManifest.parse({
		manifest: {
			name: "tracker", interface: { displayName: "Fixture Tracker" },
			description: "Read and update tickets.", apiKey: { tracker: "FIXTURE_TRACKER_KEY" },
		},
		mcp: { tracker: { type: "http", url: endpoint.url.href } },
	});
	const plugins = pluginTools(() => {}, [plugin], () => ({ tracker: enabled }), async () => apiKey);
	let chat: Fixture | undefined;
	try {
		const channel = chat = await Fixture.create({
			plugins,
			planning: async () => ({ kind: "failure", reason: "unavailable", message: "Fixture planning." }),
		});
		async function ask(mode: "ace" | "plan" = "ace") {
			const prompt = Promise.withResolvers<{ pi: string; bridge: string; offered: string[]; served: string[] }>();
			channel.script(request => {
				const bridged = policy(request.messages, () => Effect.succeed({ text: "" }), undefined, {
					ownTools: true, pluginTools: plugins.httpTools(),
				});
				prompt.resolve({
					pi: getCurrentSystemPrompt(request.messages), bridge: bridged.systemPrompt,
					offered: getCurrentTools(request.messages).map(tool => tool.name),
					served: bridged.tools.map(tool => tool.name),
				});
				return fauxAssistantMessage("Done");
			});
			const { submission } = await channel.request<{ submission: number }>({ op: "ask", author: OWNER, text: "Check the tool offer", mode });
			expect(await channel.request({ op: "wait", submission })).toBe("done");
			return prompt.promise;
		}
		const expected = [
			"## Plugin: Fixture Tracker", "Read and update tickets.", "",
			"### MCP Server Instructions", "", "#### tracker", "",
			"> Use find_issue to look up a ticket by ID.", "> Provider detail: [redacted]",
		].join("\n");
		const first = await ask();
		expect(first.offered).toContain("tracker_find_issue");
		expect(first.served).toContain("tracker_find_issue");
		for (const prompt of [first.pi, first.bridge]) {
			expect(prompt).toContain(expected);
			expect(prompt).not.toContain(apiKey);
		}
		const plan = await ask("plan");
		expect(plan.offered).toContain("planning_issue");
		expect(plan.pi).toContain("Linear planning tools read scope and dependencies.");
		expect(plan.offered).not.toContain("tracker_find_issue");
		expect(plan.pi).not.toContain("Fixture Tracker");
		expect(plan.bridge).not.toContain("Fixture Tracker");
		expect((await ask()).pi).toContain(expected);

		enabled = false;
		const off = await ask();
		expect(off.offered).not.toContain("tracker_find_issue");
		expect(off.served).not.toContain("tracker_find_issue");
		expect(off.pi).not.toContain("Fixture Tracker");
		expect(off.bridge).not.toContain("Fixture Tracker");

		const kept = "x".repeat(4096);
		instructions = kept + "do not forward this tail";
		enabled = true;
		const limited = await ask();
		for (const prompt of [limited.pi, limited.bridge]) {
			expect(prompt).toContain(`#### tracker\n\n> ${kept}`);
			expect(prompt).not.toContain("do not forward this tail");
		}
	} finally {
		await chat?.dispose();
		await endpoint.stop(true);
	}
});

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
	async function ask(mode: "ace" | "plan" = "ace", call?: string) {
		let offered: string[] = [];
		let result: unknown;
		fake.appendResponses([request => {
			offered = getCurrentTools(request.messages).map(tool => tool.name).filter(name => name.startsWith("fixture_"));
			if (call) return fauxAssistantMessage([
				fauxToolCall("fixture_write_issue", { text: call }, { id: "mcp-write" }),
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
		expect(await ask("ace", "tool argument")).toEqual({
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
		expect((await ask("ace", "drop transport")).result).toEqual([
			{ type: "text", text: "The plugin tool call failed." },
		]);
		expect((await ask("ace", "after reconnect")).result).toEqual([
			{ type: "text", text: "authorized:write.issue:after reconnect" },
		]);
		expect((await ask("plan")).offered).toEqual([]);
		enabled = false;
		expect((await ask()).offered).toEqual([]);
		await refreshed;
		enabled = true;
		expect((await ask("ace", "after enabling")).result).toEqual([
			{ type: "text", text: "authorized:write.issue:after enabling" },
		]);
	} finally {
		await channel.close();
	}
});

// An MCP handshake can overlap the first message. Its tools should reach that turn if it answers,
// and a stalled handshake must only delay one admission while the same connection continues.
test.each([
	{ outcome: "offers tools on the first message", answers: true },
	{ outcome: "times out once and offers tools after connecting", answers: false },
])("a pending MCP connection $outcome", async ({ answers }) => {
	const initialize = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	const connected = Promise.withResolvers<void>();
	let initializations = 0;
	const endpoint = serveOAuthFixture(async request => {
		if (request.method === "GET") return new Response(null, { status: 405 });
		const { id, method, params } = await request.json();
		if (id === undefined) return new Response(null, { status: 202 });
		if (method === "initialize") {
			initializations++;
			started.resolve();
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
	const log: Array<{ event: string; fields?: Fields }> = [];
	const plugins = pluginTools((_level, event, fields) => log.push({ event, fields }), [plugin], () => ({ pending: true }));
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
		expect(performance.now() - before).toBeLessThan(2000);
		await started.promise;
		const firstAt = performance.now();
		const first = ask();
		if (answers) {
			await Bun.sleep(100);
			initialize.resolve();
			expect(await first).toEqual(["pending_answer"]);
		} else {
			expect(await first).toEqual([]);
			expect(performance.now() - firstAt).toBeGreaterThanOrEqual(9_950);
			expect(performance.now() - firstAt).toBeLessThan(11_000);
			const secondAt = performance.now();
			expect(await ask()).toEqual([]);
			expect(performance.now() - secondAt).toBeLessThan(1000);
			initialize.resolve();
			await connected.promise;
			expect(await ask()).toEqual(["pending_answer"]);
		}
		expect(log.filter(item => item.event === "plugin.startup.timeout")).toEqual(answers ? [] : [
			{ event: "plugin.startup.timeout", fields: { plugin: "pending", ms: 10_000 } },
		]);
		expect(initializations).toBe(1);
	} finally {
		initialize.resolve();
		await channel?.close();
		await endpoint.stop(true);
	}
}, 15_000);

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

// A server can forget its session while credentials remain unchanged. Reconnect on a later admission.
test("an expired HTTP session is replaced without restarting the channel or retrying the call", async () => {
	let opened = 0;
	let session: string | undefined;
	const endpoint = serveOAuthFixture(async request => {
		if (request.method === "GET") return new Response(null, { status: 405 });
		const { id, method, params } = await request.json();
		if (method === "initialize") {
			session = `fixture-${++opened}`;
			return Response.json({ jsonrpc: "2.0", id, result: {
				protocolVersion: params.protocolVersion, capabilities: { tools: {} },
				serverInfo: { name: "fixture", version: "1" },
			} }, { headers: { "mcp-session-id": session } });
		}
		if (!session || request.headers.get("mcp-session-id") !== session)
			return new Response("Session expired", { status: 404 });
		if (id === undefined) return new Response(null, { status: 202 });
		return Response.json({ jsonrpc: "2.0", id, result: method === "tools/list"
			? { tools: [{ name: "answer", inputSchema: { type: "object" } }] }
			: { content: [{ type: "text", text: `Answered in session ${opened}` }] },
		});
	});
	const plugin = PluginManifest.parse({
		manifest: { name: "session", description: "Forgets its MCP session" },
		mcp: { session: { type: "http", url: endpoint.url.href, headers: { Authorization: "Bearer fixture" } } },
	});
	const plugins = pluginTools(() => {}, [plugin], () => ({ session: true }));
	let chat: Fixture | undefined;
	try {
		const channel = chat = await Fixture.create({ plugins });
		const watch = await channel.watch();
		async function ask(text: string, call?: string) {
			if (call) channel.script(fauxAssistantMessage(fauxToolCall("session_answer", {}, { id: call }), { stopReason: "toolUse" }));
			channel.script(fauxAssistantMessage(text));
			const { submission } = await channel.request<{ submission: number }>({ op: "ask", author: OWNER, text });
			expect(await channel.request({ op: "wait", submission })).toBe("done");
			return call ? watch.until("result", event => event.call === call) : undefined;
		}
		expect((await ask("First call", "before-expiry"))?.text).toBe("Answered in session 1");
		session = undefined;
		const failed = await ask("Expired call", "expired");
		expect(failed?.error).toBe(true);
		expect(failed?.text).toBe("The plugin tool call failed.");
		expect(opened).toBe(1);
		expect((await ask("After reconnect", "after-expiry"))?.text).toBe("Answered in session 2");
		expect(opened).toBe(2);
		await watch.stop();
	} finally {
		await chat?.dispose();
		await endpoint.stop(true);
	}
});
