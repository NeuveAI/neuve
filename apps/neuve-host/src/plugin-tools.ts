import { homedir } from "node:os";

import type { Options, Log } from "@ace/channel";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { Client, SdkError, SdkErrorCode, SdkHttpError, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { SharedWork } from "@neuve/records-core/shared-work";
import { declaresToolUseId } from "@neuve/runtime";

import { key } from "./keys";
import { carriedPlugins, expandPluginValue, type OAuthServer, type Plugin, type PluginServer } from "./plugin-manifest";
import { oauthAccessToken, pluginOAuthTransport } from "./plugin-oauth-client";
import { pluginPreferences } from "./preferences";

const CONNECT = { timeout: 20_000 };
const TOOL_NAME_LIMIT = 64 - "mcp__neuve__".length;
const request = globalThis.fetch;

function transport(config: PluginServer, credentials: ReadonlyMap<string, string>, oauth?: OAuthServer, signedIn = false) {
	const expand = (value: string) => expandPluginValue(value, credentials);
	const expandValues = (fields: Record<string, string> = {}) =>
		Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, expand(value)]));

	if (config.type === "stdio") return new StdioClientTransport({
		command: expand(config.command),
		args: config.args?.map(expand),
		env: expandValues(config.env),
		cwd: homedir(),
		stderr: "ignore",
	});
	const url = new URL(expand(config.url));
	if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Expected an HTTP URL");
	const headers = new Headers(expandValues(config.headers));
	const fallback = !signedIn && oauth?.apiKey && credentials.get(oauth.apiKey);
	if (fallback) headers.set("authorization", `Bearer ${fallback}`);
	return new StreamableHTTPClientTransport(url, {
		fetch: request,
		requestInit: { headers, redirect: "error" },
		...(oauth && signedIn ? pluginOAuthTransport(oauth) : {}),
	});
}

type Connection = {
	credentials: ReadonlyMap<string, string>;
	signedIn: ReadonlySet<string>;
	clients: Client[];
	httpTools: string[];
	lost: boolean;
};

type PluginRegistry = Parameters<NonNullable<Options["plugins"]>["refresh"]>[0];

async function connect(
	plugin: Plugin, credentials: ReadonlyMap<string, string>, signedIn: ReadonlySet<string>, names: Set<string>, log: Log,
	signal: AbortSignal, opened: Map<Client, { plugin: string; closing?: Promise<void> }>,
	close: (clients: Client[]) => Promise<void>,
	disconnected: (connection: Connection) => void,
): Promise<{ connection: Connection; tools: ToolRegistration[] } | undefined> {
	const connection: Connection = { credentials, signedIn, clients: [], httpTools: [], lost: false };
	const tools: ToolRegistration[] = [];
	const lost = () => {
		if (connection.lost || signal.aborted) return;
		connection.lost = true;
		disconnected(connection);
	};
	for (const [server, config] of Object.entries(plugin.servers)) {
		if (signal.aborted) return;
		const client = new Client({ name: "ace", version: "1" });
		opened.set(client, { plugin: plugin.name });
		connection.clients.push(client);
		try {
			const wire = transport(config, credentials, plugin.oauth.get(server), signedIn.has(server));
			const observeError = (error: unknown) => {
				if ((error instanceof SdkError && (error.code === SdkErrorCode.ConnectionClosed || error.code === SdkErrorCode.NotConnected))
					|| (wire instanceof StreamableHTTPClientTransport && wire.sessionId
						&& error instanceof SdkHttpError && error.status === 404)) lost();
			};
			client.onclose = lost;
			client.onerror = observeError;
			await client.connect(wire, { ...CONNECT, signal });
			const { tools: listed } = await client.listTools(undefined, { ...CONNECT, signal });
			if (connection.lost) {
				await close(connection.clients);
				return;
			}
			let accepted = 0;
			for (const tool of listed) {
				const name = `${server}_${tool.name}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, TOOL_NAME_LIMIT);
				const description = tool.description ?? "";
				const reason = description.length > 4096 ? "description exceeds 4096 characters"
					: declaresToolUseId(tool.inputSchema) ? "reserved input key"
					: names.has(name) ? "duplicate tool name" : undefined;
				if (reason) {
					log("warn", "plugin.tool.refused", { plugin: plugin.name, server, tool: name, reason });
					continue;
				}
				names.add(name);
				accepted++;
				if (config.type === "http") connection.httpTools.push(name);
				tools.push(defineTool({
					name,
					description,
					parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
					replay: tool.annotations?.readOnlyHint === true ? "safe" : "unsafe",
					async execute(args, _api, context) {
						let outcome = "failed";
						try {
							const result = await client.callTool(
								{ name: tool.name, arguments: args },
								{ signal: context.abortSignal, timeout: 30_000 },
							);
							outcome = result.isError ? "error" : "ok";
							const text = result.content?.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
							return {
								content: [{ type: "text", text: text || JSON.stringify(result.structuredContent) || "" }],
								isError: result.isError === true,
							};
						} catch (error) {
							observeError(error);
							return { content: [{ type: "text", text: "The plugin tool call failed." }], isError: true };
						} finally {
							log(outcome === "ok" ? "info" : "warn", "plugin.tool.call", { plugin: plugin.name, tool: name, outcome });
						}
					},
				}));
			}
			log("info", "plugin.connected", { plugin: plugin.name, server, tools: accepted });
		} catch {
			if (!signal.aborted) log("warn", "plugin.connection.failed", { plugin: plugin.name, server });
			await close(connection.clients);
			return;
		}
	}
	return { connection, tools };
}

const extensionName = (plugin: Plugin) => `ace-plugin-${plugin.name}`;

export function pluginTools(
	log: Log, plugins: readonly Plugin[] = carriedPlugins,
	readPreferences = pluginPreferences, lookup = key,
): NonNullable<Options["plugins"]> {
	const active = new Map<Plugin, Connection>();
	const opened = new Map<Client, { plugin: string; closing?: Promise<void> }>();
	const lifetime = new AbortController();
	const work = new SharedWork<void>();
	const prefixes = plugins.flatMap(plugin => Object.keys(plugin.servers).map(server => `${server}_`.slice(0, TOOL_NAME_LIMIT)));

	async function close(clients: Client[]): Promise<void> {
		await Promise.all(clients.map(client => {
			const owned = opened.get(client);
			if (!owned) return;
			return owned.closing ??= client.close()
				.catch(() => log("warn", "plugin.close.failed", { plugin: owned.plugin }))
				.finally(() => { opened.delete(client); });
		}));
	}

	function preferences() {
		try {
			return readPreferences();
		} catch {
			log("warn", "plugin.preferences.failed");
			return {};
		}
	}

	return {
		hidden() {
			const enabled = preferences();
			return plugins.filter(plugin => enabled[plugin.name] !== true).map(extensionName);
		},
		ownsTool: name => prefixes.some(prefix => name.startsWith(prefix)),
		httpTools() {
			const enabled = preferences();
			return new Set([...active].flatMap(([plugin, connection]) =>
				enabled[plugin.name] === true ? connection.httpTools : [],
			));
		},
		async refresh(registry) {
			if (lifetime.signal.aborted) return;
			await work.run({ scope: "plugins", key: "refresh", run: async () => {
				let enabled = preferences();
				for (;;) {
					await reconcile(enabled, registry);
					const next = preferences();
					if (lifetime.signal.aborted || plugins.every(({ name }) => next[name] === enabled[name])) break;
					enabled = next;
				}
				return { kind: "succeeded", value: undefined };
			} });
		},
		async close() {
			lifetime.abort();
			active.clear();
			await close([...opened.keys()]);
		},
	};

	function retire(plugin: Plugin, connection: Connection, registry: PluginRegistry) {
		if (active.get(plugin) !== connection) return;
		active.delete(plugin);
		registry.uninstall({ name: extensionName(plugin) });
		return close(connection.clients);
	}

	async function reconcile(enabled: Record<string, boolean>, registry: PluginRegistry) {
		for (const plugin of plugins) {
			if (lifetime.signal.aborted) return;
			const name = extensionName(plugin);
			const credentials = new Map<string, string>();
			const signedIn = new Set<string>();
			let ready = enabled[plugin.name] === true;
			if (ready) {
				for (const variable of plugin.variables) {
					const value = await lookup(variable).catch(() => undefined);
					if (value === undefined) {
						log("warn", "plugin.credential.unavailable", { plugin: plugin.name, name: variable });
						ready = false;
						break;
					}
					credentials.set(variable, value);
				}
			}
			if (ready) {
				for (const [name, server] of plugin.oauth) {
					try {
						if (await oauthAccessToken(server)) {
							signedIn.add(name);
							continue;
						}
						if (server.apiKey) {
							const fallback = credentials.get(server.apiKey) ?? await lookup(server.apiKey);
							if (fallback) {
								credentials.set(server.apiKey, fallback);
								continue;
							}
						}
					} catch {
						// Sign-in and keychain failures stay outside the tool surface.
					}
					log("warn", "plugin.sign-in.unavailable", { plugin: plugin.name, server: name });
					ready = false;
					break;
				}
			}
			if (lifetime.signal.aborted) return;
			const current = active.get(plugin);
			if (current) {
				if (ready && credentials.size === current.credentials.size && signedIn.size === current.signedIn.size
					&& [...signedIn].every(name => current.signedIn.has(name))
					&& [...credentials].every(([key, value]) => current.credentials.get(key) === value)) continue;
				await retire(plugin, current, registry);
			}
			if (!ready) continue;
			const names = new Set(registry.snapshot().tools().map(({ tool }) => tool.name));
			const connected = await connect(plugin, credentials, signedIn, names, log, lifetime.signal, opened, close,
				connection => { void retire(plugin, connection, registry); });
			if (!connected) continue;
			if (lifetime.signal.aborted) return;
			if (connected.connection.lost || preferences()[plugin.name] !== true) {
				await close(connected.connection.clients);
				continue;
			}
			active.set(plugin, connected.connection);
			registry.install({ name, tools: connected.tools });
		}
	}
}
