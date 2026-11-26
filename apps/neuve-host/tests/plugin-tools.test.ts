import { expect, test } from "bun:test";
import { Channel, type Fields } from "@ace/channel";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

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
		enabled = true;
		expect((await ask()).offered).toEqual([]);
		expect(log).toContainEqual({ event: "plugin.credential.unavailable", fields: { plugin: "fixture", name: "PLUGIN_FIXTURE" } });
		credential = "unusable";
		expect((await ask()).offered).toEqual([]);
		expect(log).toContainEqual({ event: "plugin.connection.failed", fields: { plugin: "fixture", server: "fixture" } });
		credential = "fixture-value";
		expect(await ask("ace", true)).toEqual({
			offered: ["fixture_write_issue", "fixture_" + "r".repeat(56)],
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
