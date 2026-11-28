import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Channel, type Fields } from "@ace/channel";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, getCurrentTools, type ToolResultMessage } from "@earendil-works/pi-ai";
import { CompactionEntry, MemoryStorage, type Conversation, type Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Effect } from "effect";

import { Fixture, MODEL, OWNER } from "../../../packages/channel/tests/helpers";
import { policy, policyKey } from "../../../packages/harness/src/chat-runtime/transcript";
import { fauxNonTurnModels } from "./fixtures/non-turn-models";
import { serveOAuthFixture } from "./fixtures/oauth-http";
import { chromeDevToolsPlugin, expandPluginValue, PluginManifest, secretName } from "../src/plugin-manifest";
import { pluginTools } from "../src/plugin-tools";
import { config } from "../src/config";

test("Chrome DevTools resolves both host folders without a credential and alone gets a workspace argument", async () => {
	const home = config.home;
	const plugin = {
		...chromeDevToolsPlugin,
		servers: { ...chromeDevToolsPlugin.servers, plain: { type: "stdio" as const, command: "plain-server", args: ["--identify"] } },
	};
	const plugins = pluginTools(() => {}, [plugin], () => ({}));
	try {
		config.home = "/Volumes/Example Drive/ace";
		const folder = realpathSync(import.meta.dir);
		expect(chromeDevToolsPlugin.variables.size).toBe(0);
		expect(chromeDevToolsPlugin.credentials.size).toBe(0);
		expect(secretName("ACE_BROWSER_PROFILE")).toBe(false);
		expect(plugins.nativeServers?.(folder)).toEqual({
			"chrome-devtools": {
				type: "stdio", command: "npx", args: [
					"-y", "chrome-devtools-mcp@1.14.0", "--autoConnect", "--userDataDir",
					join(config.home, "browser"), `--workspace=${folder}`,
					"--experimentalScreencast", "--no-usage-statistics", "--no-performance-crux",
				],
				env: { CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1" },
			},
			plain: { type: "stdio", command: "plain-server", args: ["--identify"] },
		});
		expect(plugins.nativeServers?.()).toBeUndefined();
		expect(plugins.nativeServers?.("/")).toBeUndefined();
	} finally {
		config.home = home;
		await plugins.close();
	}
});

test("the native session policy reopens when Chrome DevTools changes and withholds it for Plan and attended chats", async () => {
	const plugins = pluginTools(() => {}, [chromeDevToolsPlugin], () => ({}));
	try {
		const mcpServers = plugins.nativeServers?.(import.meta.dir);
		const plan = { role: "system" as const, content: "", timestamp: 0,
			[Symbol.for("neuve.chat.plan-request")]: true };
		for (const ownTools of [true, false]) {
			const configured = { folder: import.meta.dir, ownTools, mcpServers };
			const handle = () => Effect.succeed({ text: "" });
			const on = policy([], handle, undefined, configured);
			const off = policy([], handle, undefined, { ...configured, mcpServers: undefined });
			expect(on.mcpServers?.["chrome-devtools"]?.command).toBe("npx");
			expect(policyKey(on)).not.toBe(policyKey(off));
			expect(policy([plan], handle, undefined, configured).mcpServers).toBeUndefined();
			expect(policy([], handle, undefined, { ...configured, attended: true }).mcpServers).toBeUndefined();
		}
	} finally {
		await plugins.close();
	}
});

// The parser supplies a settings label and limits expansion to the credentials declared in the files.
test("the manifest resolves the display name and restricts expansion to resolved credentials", () => {
	const plugin = {
		manifest: { name: "example", description: "Example plugin", codexPlugin: "example_plugin" },
		mcp: { mcpServers: { example: {
			type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer ${EXAMPLE_KEY}" },
		} } },
	};
	const parsed = PluginManifest.parse(plugin);
	expect(parsed.displayName).toBe("example");
	expect(parsed.codexPlugin).toBe("example_plugin");
	// Codex splits override keys on dots.
	expect(PluginManifest.safeParse({ ...plugin, manifest: { ...plugin.manifest, codexPlugin: "example.codexPlugin" } }).success).toBe(false);
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

// An MCP peer asks for roots during initialization and returns the scope with an inline image.
const screenshotServer = String.raw`
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const send = message => console.log(JSON.stringify({ jsonrpc: "2.0", ...message }));
let roots;
let pending;
const workspace = process.argv.find(arg => arg.startsWith("--workspace="));
const screenshot = (id, { oversized }) => {
	const data = oversized ? Buffer.alloc(900_001).toString("base64") : "aA==";
	const scope = {
		roots,
		workspace,
		noUpdateChecks: process.env.CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS,
		hasPath: Boolean(process.env.PATH),
	};
	send({ id, result: { content: [
		{ type: "image", mimeType: "image/png", data }, { type: "text", text: JSON.stringify(scope) },
	] } });
};
for await (const line of createInterface({ input: process.stdin })) {
	const { id, method, params, result } = JSON.parse(line);
	if (method === "initialize") {
		roots = params.capabilities.roots ? null : [];
		send({ id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" },
			instructions: "Use Chrome DevTools for browser work.",
		} });
	} else if (method === "notifications/initialized") {
		if (roots === null) send({ id: "roots", method: "roots/list" });
	} else if (id === "roots") {
		roots = result.roots;
		if (pending !== undefined) screenshot(...pending);
	} else if (method === "tools/list") {
		send({ id, result: { tools: [{
			name: "take_screenshot", inputSchema: { type: "object", properties: { oversized: { type: "boolean" } } },
		}] } });
	} else if (method === "tools/call") {
		appendFileSync("devtools-calls.log", params.name + "\n");
		if (roots === null) pending = [id, params.arguments];
		else screenshot(id, params.arguments);
	}
}
`;

const devtoolsServer = chromeDevToolsPlugin.servers["chrome-devtools"];
const workspaceArg = devtoolsServer?.type === "stdio" && devtoolsServer.args?.find(arg => arg.startsWith("--workspace="));
if (!workspaceArg) throw new Error("Missing the DevTools workspace argument");
const screenshotPlugin = PluginManifest.parse({
	manifest: { name: "chrome-devtools", description: "Fixture", defaultEnabled: true },
	mcp: {
		"chrome-devtools": {
			...devtoolsServer,
			command: process.execPath,
			args: ["--no-env-file", "--eval", screenshotServer, "--", workspaceArg],
		},
	},
});

const screenshotText = (folder: string) => JSON.stringify({
	roots: [{ uri: pathToFileURL(folder).href }], workspace: `--workspace=${folder}`,
	noUpdateChecks: "1", hasPath: true,
});
async function screenshotTurn(channel: Fixture, mode: "ace" | "plan", attended: boolean, args?: { oversized?: boolean }) {
	const tool = "chrome-devtools_take_screenshot";
	const search = "plugin_tool_search";
	const offer = Promise.withResolvers<{ offered: boolean; searchable: boolean; listed: boolean }>();
	const blocks = Promise.withResolvers<ToolResultMessage["content"] | undefined>();
	channel.script(request => {
		const tools = getCurrentTools(request.messages).map(candidate => candidate.name);
		offer.resolve({
			offered: tools.includes(tool), searchable: tools.includes(search),
			listed: getCurrentSystemPrompt(request.messages).includes(`\`${tool}\``),
		});
		if (args && !attended) return fauxAssistantMessage(
			fauxToolCall(search, { query: `select:${tool}` }, { id: "find-screenshot" }), { stopReason: "toolUse" },
		);
		return args
			? fauxAssistantMessage(fauxToolCall(tool, args, { id: "screenshot" }), { stopReason: "toolUse" })
			: fauxAssistantMessage("Done");
	});
	if (args && !attended) channel.script(request => {
		expect(getCurrentTools(request.messages).map(candidate => candidate.name)).toContain(tool);
		return fauxAssistantMessage(fauxToolCall(tool, args, { id: "screenshot" }), { stopReason: "toolUse" });
	});
	if (args) channel.script(request => {
		const result = request.messages.findLast(item => item.role === "toolResult");
		blocks.resolve(result?.content);
		return fauxAssistantMessage("Done");
	});
	const { submission } = await channel.request<{ submission: number }>({ op: "ask", author: OWNER, text: "Check the browser", mode, attended });
	expect(await channel.request({ op: "wait", submission })).toBe("done");
	return { ...await offer.promise, result: args ? await blocks.promise : undefined };
}

test("pi discovers scoped Chrome DevTools and delivers images and the chat's roots", async () => {
	let preference: Record<string, boolean> = {};
	const plugins = pluginTools(() => {}, [screenshotPlugin], () => preference);
	const channel = await Fixture.create({ plugins });
	try {
		expect(await screenshotTurn(channel, "ace", false, {})).toEqual({
			offered: false, searchable: true, listed: true,
			result: [
				{ type: "image", data: "aA==", mimeType: "image/png" },
				{ type: "text", text: screenshotText(channel.lane.path) },
			],
		});
		const attended = await screenshotTurn(channel, "ace", true, {});
		const calls = await Bun.file(join(channel.lane.path, "devtools-calls.log")).text();
		expect({ ...attended, calls }).toEqual({
			offered: false, searchable: false, listed: false,
			result: [{ type: "text", text: "This tool is unavailable in a person-driven chat." }],
			calls: "take_screenshot\n",
		});
		const hidden = { offered: false, searchable: false, listed: false, result: undefined };
		expect(await screenshotTurn(channel, "plan", false)).toEqual(hidden);
		preference = { "chrome-devtools": false };
		expect(plugins.nativeServers?.(channel.lane.path)).toBeUndefined();
		expect(await screenshotTurn(channel, "ace", false)).toEqual(hidden);
	} finally {
		await channel.dispose();
	}
});

test("pi drops an oversized plugin image and keeps the text with a filePath hint", async () => {
	const plugins = pluginTools(() => {}, [screenshotPlugin], () => ({}));
	const channel = await Fixture.create({ plugins });
	try {
		const { result } = await screenshotTurn(channel, "ace", false, { oversized: true });
		expect(result?.map(block => block.type)).toEqual(["text"]);
		expect(result).toEqual([{
			type: "text",
			text: screenshotText(channel.lane.path)
				+ "\nAn image was too large to include. Save it to a file with filePath.",
		}]);
	} finally {
		await channel.dispose();
	}
});

// Codex announces its native server tools itself, while Ace still supplies the plugin's guidance.
test("the Codex Chrome DevTools section keeps guidance without a tool list", async () => {
	const plugins = pluginTools(() => {}, [screenshotPlugin], () => ({}));
	const model = { ...MODEL, provider: "fixture-codex" };
	const codex = fauxProvider({ provider: model.provider, api: "neuve-runtime", models: [{ id: model.modelId }], tokensPerSecond: 100_000 });
	const channel = await Fixture.create({ plugins, ownTools: provider => provider === model.provider });
	try {
		channel.scripted.models.setProvider(codex.provider);
		let prompt = "";
		codex.appendResponses([request => {
			prompt = getCurrentSystemPrompt(request.messages);
			return fauxAssistantMessage("Done");
		}]);
		const { submission } = await channel.request<{ submission: number }>({ op: "ask", author: OWNER, text: "Check the browser", mode: "ace", model });
		expect(await channel.request({ op: "wait", submission })).toBe("done");
		expect(prompt).toContain("## Plugin: chrome-devtools\nFixture\n\n### MCP Server Instructions\n\n#### chrome-devtools\n\n> Use Chrome DevTools for browser work.");
		expect(prompt).not.toContain("### Tools");
		expect(prompt).not.toContain("Use Codex's tool discovery");
	} finally {
		await channel.dispose();
	}
});

test("plugin sections give each runtime its discovery guidance", async () => {
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
			: { tools: [{ name: "find_issue", description: "Find a ticket by ID. This sentence is omitted.", inputSchema: { type: "object" } }] };
		return Response.json({ jsonrpc: "2.0", id, result });
	});
	const plugin = PluginManifest.parse({
		manifest: {
			name: "tracker", interface: { displayName: "Fixture Tracker" },
			description: "Read and update tickets.", apiKey: { tracker: "FIXTURE_TRACKER_KEY" },
			codexPlugin: "fixture_tracker",
		},
		mcp: { tracker: { type: "http", url: endpoint.url.href } },
	});
	const plugins = pluginTools(() => {}, [plugin], () => ({ tracker: enabled }), async () => apiKey);
	let chat: Fixture | undefined;
	try {
		const channel = chat = await Fixture.create({
			plugins,
			ownTools: provider => provider === "fixture-codex",
			planning: async () => ({ kind: "failure", reason: "unavailable", message: "Fixture planning." }),
		});
		let deferredTools: unknown;
		async function ask(mode: "ace" | "plan" = "ace", provider?: "fixture-claude" | "fixture-codex") {
			const model = provider ? { ...MODEL, provider } : MODEL;
			const native = provider && fauxProvider({ provider, api: "neuve-runtime", models: [{ id: model.modelId }], tokensPerSecond: 100_000 });
			if (native) channel.scripted.models.setProvider({
				...native.provider,
				streamSimple(model, context, options) {
					deferredTools = options && Reflect.get(options, Symbol.for("neuve.chat.deferred-plugin-tools"));
					return native.provider.streamSimple(model, context, options);
				},
			});
			const prompt = Promise.withResolvers<{ pi: string; bridge: string; offered: string[]; served: string[] }>();
			(native || channel.faux).appendResponses([request => {
				const bridged = policy(request.messages, () => Effect.succeed({ text: "" }), undefined, {
					ownTools: true, pluginTools: plugins.httpTools(),
				});
				prompt.resolve({
					pi: getCurrentSystemPrompt(request.messages), bridge: bridged.systemPrompt,
					offered: getCurrentTools(request.messages).map(tool => tool.name),
					served: bridged.tools.map(tool => tool.name),
				});
				return fauxAssistantMessage("Done");
			}]);
			const { submission } = await channel.request<{ submission: number }>({ op: "ask", author: OWNER, text: "Check the tool offer", mode, model });
			expect(await channel.request({ op: "wait", submission })).toBe("done");
			return prompt.promise;
		}
		const expected = [
			"## Plugin: Fixture Tracker", "Read and update tickets.", "",
			"### MCP Server Instructions", "", "#### tracker", "",
			"> Use find_issue to look up a ticket by ID.", "> Provider detail: [redacted]",
		].join("\n");
		const first = await ask();
		expect(first.offered).toContain("plugin_tool_search");
		expect(first.offered).not.toContain("tracker_find_issue");
		expect(first.served).not.toContain("tracker_find_issue");
		for (const prompt of [first.pi, first.bridge]) {
			expect(prompt).toContain(expected);
			expect(prompt).toContain("- `tracker_find_issue` Find a ticket by ID.");
			expect(prompt).not.toContain("This sentence is omitted.");
			expect(prompt).not.toContain(apiKey);
		}
		const list = `${expected}\n\n### Tools\n\n- \`tracker_find_issue\` Find a ticket by ID.`;
		expect(first.pi).toContain(`${list}\n\nUse \`plugin_tool_search\` to load these tools before calling them.`);
		const claude = (await ask("ace", "fixture-claude")).pi;
		expect(claude).toContain(expected);
		expect(claude).not.toContain("### Tools");
		expect(claude).not.toContain("Use `ToolSearch`");
		const codex = (await ask("ace", "fixture-codex")).pi;
		expect(codex).toContain(`${list}\n\nUse Codex's tool discovery to load tools from the \`neuve_plugins\` server on demand.`);
		// The native request needs the Codex plugin that the tool's plugin declares.
		expect(deferredTools).toEqual(new Map([["tracker_find_issue", "fixture_tracker"]]));
		const plan = await ask("plan");
		expect(plan.offered).toContain("planning_issue");
		expect(plan.pi).toContain("Linear planning tools read scope and dependencies.");
		expect(plan.offered).not.toContain("tracker_find_issue");
		expect(plan.offered).not.toContain("plugin_tool_search");
		expect(plan.pi).not.toContain("Fixture Tracker");
		expect(plan.bridge).not.toContain("Fixture Tracker");
		expect((await ask()).pi).toContain(expected);

		enabled = false;
		const off = await ask();
		expect(off.offered).not.toContain("tracker_find_issue");
		expect(off.offered).not.toContain("plugin_tool_search");
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
		extension: { extensions: [], nonTurnModels: fauxNonTurnModels(model) },
		env: cwd => new NodeExecutionEnv({ cwd }),
		directory: { self: { id: "plugin-test", name: "plugin-test" }, list: async () => [], deliver: async () => {} },
		log: (_level, event, fields) => log.push({ event, fields }),
	});
	async function ask(mode: "ace" | "plan" = "ace", call?: string) {
		let offered: string[] = [];
		let result: unknown;
		if (call) fake.appendResponses([fauxAssistantMessage(
			fauxToolCall("plugin_tool_search", { query: "select:fixture_write_issue,fixture_" + "r".repeat(44) }, { id: crypto.randomUUID() }),
			{ stopReason: "toolUse" },
		)]);
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
			extension: { extensions: [], nonTurnModels: fauxNonTurnModels(model) },
			env: cwd => new NodeExecutionEnv({ cwd }),
			directory: { self: { id: "pending-test", name: "pending-test" }, list: async () => [], deliver: async () => {} },
			log: () => {},
		});
		const opened = channel;
		async function ask() {
			const offer = Promise.withResolvers<string[]>();
			fake.appendResponses([request => {
				offer.resolve(getCurrentSystemPrompt(request.messages).includes("`pending_answer`") ? ["pending_answer"] : []);
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
		channel.script(fauxAssistantMessage(fauxToolCall("plugin_tool_search", { query: "select:session_answer" }, { id: "session-search" }), { stopReason: "toolUse" }));
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

// Exercise query ranking, durable discovery after a restart and a real compaction, and current availability.
test("pi replays searches across restarts and compaction and drops disabled results", async () => {
	const schema = { type: "object", properties: { id: { type: "string" } }, required: ["id"] };
	const endpoint = serveOAuthFixture(async request => {
		if (request.method === "GET") return new Response(null, { status: 405 });
		const { id, method, params } = await request.json();
		if (id === undefined) return new Response(null, { status: 202 });
		const result = method === "initialize"
			? { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "tracker", version: "1" } }
			: { tools: [
				{ name: "browse", description: "Find tickets and links.", inputSchema: schema },
				{ name: "find_tickets", description: "Look up an issue.", inputSchema: schema },
				{ name: "write_ticket", description: "Change a ticket.", inputSchema: schema },
				{ name: "find_project", description: "Look up a project.", inputSchema: schema },
				...Array.from({ length: 5 }, (_, index) => ({ name: `extra_${index}`, description: "Find tickets.", inputSchema: schema })),
			] };
		return Response.json({ jsonrpc: "2.0", id, result });
	});
	const plugin = PluginManifest.parse({
		manifest: { name: "tracker", description: "Track work." },
		mcp: { tracker: { type: "http", url: endpoint.url.href, headers: { Authorization: "Bearer fixture" } } },
	});
	let enabled = true;
	const connect = () => pluginTools(() => {}, [plugin], () => ({ tracker: enabled }));
	let fixture: Fixture | undefined;
	let harness: Harness | undefined;
	let root: Conversation | undefined;
	try {
		const chat = fixture = await Fixture.create({
			plugins: connect(),
			extension: { extensions: [], async attach(session) { harness = session; root = await session.root(context); } },
		});
		async function ask(text = "Check the tracker") {
			const { submission } = await chat.request<{ submission: number }>({ op: "ask", author: OWNER, text });
			const status = await chat.request({ op: "wait", submission });
			const errors = chat.log.filter(item => item.level === "error");
			expect(status, JSON.stringify(errors)).toBe("done");
		}
		const query = (id: string, args: { query: string; max_results?: number }) =>
			fauxAssistantMessage(fauxToolCall("plugin_tool_search", args, { id }), { stopReason: "toolUse" });
		chat.script(
			fauxAssistantMessage([
				fauxToolCall("tracker_find_tickets", { id: "fixture" }, { id: "early" }),
				fauxToolCall("plugin_tool_search", { query: "find +tickets" }, { id: "keywords" }),
			], { stopReason: "toolUse" }),
			request => {
				expect(request.messages.find(message => message.role === "toolResult" && message.toolCallId === "early"))
					.toMatchObject({ isError: true });
				const result = request.messages.find(message => message.role === "toolResult" && message.toolCallId === "keywords");
				expect(result).toMatchObject({
					details: ["tracker_find_tickets", "tracker_browse", "tracker_extra_0", "tracker_extra_1", "tracker_extra_2"],
				});
				expect(result?.role === "toolResult" && result.content[0]).toEqual({
					type: "text",
					text: JSON.stringify({ name: "tracker_find_tickets", description: "Look up an issue.", parameters: schema }),
				});
				expect(getCurrentTools(request.messages).map(tool => tool.name)).toContain("tracker_find_tickets");
				return query("exact", { query: "select:missing,tracker_write_ticket,tracker_extra_4", max_results: 1 });
			},
			request => {
				const result = request.messages.findLast(message => message.role === "toolResult");
				expect(result).toMatchObject({ details: ["tracker_write_ticket"] });
				expect(getCurrentTools(request.messages).map(tool => tool.name)).not.toContain("tracker_extra_4");
				return fauxAssistantMessage("Loaded.");
			},
		);
		await ask();

		chat.options.plugins = connect();
		await chat.restart();
		chat.script(request => {
			expect(getCurrentTools(request.messages).map(tool => tool.name)).toContain("tracker_write_ticket");
			return fauxAssistantMessage("Recovered.");
		});
		await ask("Recent context. ".repeat(8_000));

		if (!root || !harness) throw new Error("Fixture did not open a conversation");
		chat.script(fauxAssistantMessage("A summary with no tool names."));
		const compacting = await root.compact(undefined, context);
		expect((await harness.waitForTask(compacting, context)).state.outcome.status).toBe("completed");
		const compacted = await root.context(context);
		expect(CompactionEntry.is(compacted.head)).toBe(true);
		expect(compacted.messages.some(message => message.role === "toolResult" && message.toolCallId === "exact")).toBe(false);

		chat.script(request => {
			expect(getCurrentTools(request.messages).map(tool => tool.name)).toContain("tracker_write_ticket");
			return query("before-disable", { query: "select:tracker_write_ticket" });
		}, fauxAssistantMessage("Still loaded."));
		await ask();

		enabled = false;
		chat.script(request => {
			expect(getCurrentSystemPrompt(request.messages)).not.toContain("Track work.");
			expect(getCurrentTools(request.messages).map(tool => tool.name)).not.toContain("tracker_write_ticket");
			expect(request.messages.find(message => message.role === "toolResult" && message.toolCallId === "before-disable"))
				.toMatchObject({ details: [], content: [{ type: "text", text: expect.stringContaining("unavailable") }] });
			return query("disabled", { query: "select:tracker_write_ticket" });
		}, request => {
			expect(request.messages.findLast(message => message.role === "toolResult")).toMatchObject({ details: [] });
			return fauxAssistantMessage("Unavailable.");
		});
		await ask();
	} finally {
		await fixture?.dispose();
		await endpoint.stop(true);
	}
});
