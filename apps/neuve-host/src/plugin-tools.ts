import { homedir, tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { isAbsolute, parse } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import type { Options, Log } from "@ace/channel";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { Client, SdkError, SdkErrorCode, SdkHttpError, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { SharedWork } from "@neuve/records-core/shared-work";
import { declaresToolUseId, type McpStdioServer } from "@neuve/runtime";

import { key } from "./keys";
import { carriedPlugins, chromeDevToolsPlugin, expandPluginValue, pluginEnabled, type Plugin, type PluginServer } from "./plugin-manifest";
import { pluginCredential, pluginMcp } from "./plugin-oauth-client";
import { pluginPreferences } from "./preferences";

const CONNECT = { timeout: 20_000 };
const STARTUP_TIMEOUT = 10_000;
const TOOL_NAME_LIMIT = 64 - "mcp__neuve__".length;
const MCP_TEXT_LIMIT = 4096;
const MAX_IMAGE_BYTES = 900_000;
const request = globalThis.fetch;

const expandValues = (fields: Record<string, string> | undefined, credentials: ReadonlyMap<string, string>, folder?: string) =>
	Object.fromEntries(Object.entries(fields ?? {}).map(([name, value]) => [name, expandPluginValue(value, credentials, folder)]));

function chatFolder(folder: string | undefined): string | undefined {
	if (!folder || !isAbsolute(folder)) return;
	try {
		const canonical = realpathSync(folder);
		if (parse(canonical).root !== canonical) return canonical;
	} catch {
		return;
	}
}

function stdio(config: Extract<PluginServer, { type: "stdio" }>, credentials: ReadonlyMap<string, string>, folder?: string): McpStdioServer {
	const expand = (value: string) => expandPluginValue(value, credentials, folder);
	return {
		type: "stdio",
		command: expand(config.command),
		...(config.args && { args: config.args.map(expand) }),
		...(config.env && { env: expandValues(config.env, credentials, folder) }),
	};
}

function transport(config: PluginServer, credentials: ReadonlyMap<string, string>, folder?: string) {
	if (config.type === "stdio") return new StdioClientTransport({
		...stdio(config, credentials, folder),
		cwd: folder ?? homedir(),
		stderr: "ignore",
	});
	const url = new URL(expandPluginValue(config.url, credentials));
	if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Expected an HTTP URL");
	const headers = new Headers(expandValues(config.headers, credentials));
	return new StreamableHTTPClientTransport(url, {
		fetch: request,
		requestInit: { headers, redirect: "error" },
	});
}

type Connection = {
	credentials: ReadonlyMap<string, string>;
	signedIn: ReadonlySet<string>;
	clients: Set<Client>;
	lifetime: AbortController;
	httpTools: string[];
	lost: boolean;
};

type Startup = PromiseWithResolvers<void> & { claimed: boolean };
type EnabledPlugin = { startup?: Startup };

type PluginRegistry = Parameters<NonNullable<Options["plugins"]>["refresh"]>[0];
const browserPlugin = (plugin: Plugin) => plugin.name === chromeDevToolsPlugin.name;

async function connect(
	plugin: Plugin, credentials: ReadonlyMap<string, string>, signedIn: ReadonlySet<string>, lookup: typeof key, names: Set<string>, log: Log,
	signal: AbortSignal, opened: Map<Client, { plugin: string; closing?: Promise<void> }>,
	close: (clients: Iterable<Client>) => Promise<void>,
	disconnected: (connection: Connection) => void,
	enabled: () => boolean,
): Promise<{ connection: Connection; tools: ToolRegistration[]; instructions: string[] } | undefined> {
	const connection: Connection = { credentials, signedIn, clients: new Set(), lifetime: new AbortController(), httpTools: [], lost: false };
	const scopeSignal = AbortSignal.any([signal, connection.lifetime.signal]);
	const tools: ToolRegistration[] = [];
	const instructions: string[] = [];
	const lost = () => {
		if (connection.lost || signal.aborted) return;
		connection.lost = true;
		disconnected(connection);
	};
	for (const [server, config] of Object.entries(plugin.servers)) {
		if (signal.aborted) return;
		try {
			const scoped = browserPlugin(plugin) && config.type === "stdio";
			const oauth = plugin.oauth.get(server);
			const { client, transport: wire } = oauth ? pluginMcp(oauth, lookup) : {
				client: new Client({ name: "neuve", version: "1" }),
				// Discovery only lists tools, so a chat-scoped server gets only the temporary directory here.
				transport: transport(config, credentials, scoped ? chatFolder(tmpdir()) : undefined),
			};
			opened.set(client, { plugin: plugin.name });
			connection.clients.add(client);
			const chatClients = new Map<string, Client>();
			const work = new SharedWork<Client>();
			async function forChat({ conversationId, env }: ToolExecutionApi): Promise<Client> {
				const folder = chatFolder(env?.cwd);
				if (!folder) throw new Error("The chat has no working folder.");
				scopeSignal.throwIfAborted();
				const key = JSON.stringify([conversationId, folder]);
				const { outcome } = await work.run({ scope: "plugin.mcp.connect", key, run: async () => {
					const chat = chatClients.get(key);
					if (chat) return { kind: "succeeded", value: chat };
					scopeSignal.throwIfAborted();
					const next = new Client({ name: "neuve", version: "1" }, { capabilities: { roots: {} } });
					next.setRequestHandler("roots/list", () => ({ roots: [{ uri: pathToFileURL(folder).href }] }));
					opened.set(next, { plugin: plugin.name });
					connection.clients.add(next);
					let closed = false;
					next.onclose = () => {
						closed = true;
						chatClients.delete(key);
						connection.clients.delete(next);
						opened.delete(next);
					};
					try {
						await next.connect(transport(config, credentials, folder), { ...CONNECT, signal: scopeSignal });
						scopeSignal.throwIfAborted();
						if (closed) throw new Error("The plugin server disconnected.");
						chatClients.set(key, next);
						return { kind: "succeeded", value: next };
					} catch (error) {
						await close([next]);
						throw error;
					}
				} });
				if (outcome.kind === "failed") throw outcome.error;
				return outcome.value;
			}
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
				const reason = description.length > MCP_TEXT_LIMIT ? "description exceeds 4096 characters"
					: declaresToolUseId(tool.inputSchema) ? "reserved input key"
					: names.has(name) ? "duplicate tool name" : undefined;
				if (reason) {
					log("warn", "plugin.tool.refused", { plugin: plugin.name, server, tool: name, reason });
					continue;
				}
				names.add(name);
				accepted++;
				if (config.type === "http") connection.httpTools.push(name);
				tools.push(Object.assign(defineTool({
					name,
					description,
					parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
					replay: tool.annotations?.readOnlyHint === true ? "safe" : "unsafe",
					async execute(args, api, context) {
						if (scoped && (!enabled() || scopeSignal.aborted))
							return { content: [{ type: "text", text: "Chrome DevTools is switched off." }], isError: true };
						let outcome = "failed";
						try {
							const target = scoped ? await forChat(api) : client;
							const result = await target.callTool(
								{ name: tool.name, arguments: args },
								{ signal: context.abortSignal, timeout: 30_000 },
							);
							outcome = result.isError ? "error" : "ok";
							let text = result.content?.flatMap(block => block.type === "text" ? [block.text] : []).join("\n")
								|| JSON.stringify(result.structuredContent) || "";
							const images = result.content?.flatMap(block => block.type === "image"
								? [{ type: "image" as const, data: block.data, mimeType: block.mimeType }] : []) ?? [];
							const inlineImages = images.filter(({ data }) => Buffer.byteLength(data, "base64") <= MAX_IMAGE_BYTES);
							if (inlineImages.length < images.length) {
								const note = "An image was too large to include. Save it to a file with filePath.";
								text = text ? `${text}\n${note}` : note;
							}
							return {
								content: text || !inlineImages.length ? [...inlineImages, { type: "text", text }] : inlineImages,
								isError: result.isError === true,
							};
						} catch (error) {
							if (!scoped) observeError(error);
							return { content: [{ type: "text", text: "The plugin tool call failed." }], isError: true };
						} finally {
							log(outcome === "ok" ? "info" : "warn", "plugin.tool.call", { plugin: plugin.name, tool: name, outcome });
						}
					},
				}), {
					deferred: true,
					...(plugin.codexPlugin === undefined ? {} : { codexPlugin: plugin.codexPlugin }),
				}));
			}
			let guidance = client.getInstructions() ?? "";
			for (const value of credentials.values()) {
				if (value) guidance = guidance.replaceAll(value, "[redacted]");
			}
			guidance = guidance.slice(0, MCP_TEXT_LIMIT);
			if (guidance.trim()) {
				const quoted = guidance.split(/\r\n?|\n|\u2028|\u2029/).map(line => `> ${line}`).join("\n");
				instructions.push(`#### ${server}\n\n${quoted}`);
			}
			log("info", "plugin.connected", { plugin: plugin.name, server, tools: accepted });
			if (scoped) {
				// This connection discovers tool definitions. Calls use the chat's own roots.
				client.onclose = () => {};
				connection.clients.delete(client);
				await close([client]);
			}
		} catch {
			if (!signal.aborted) log("warn", "plugin.connection.failed", { plugin: plugin.name, server });
			await close(connection.clients);
			return;
		}
	}
	return { connection, tools, instructions };
}

const extensionName = (plugin: Plugin) => `ace-plugin-${plugin.name}`;

export function pluginTools(
	log: Log, plugins: readonly Plugin[] = carriedPlugins,
	readPreferences = pluginPreferences, lookup = key,
): NonNullable<Options["plugins"]> {
	const active = new Map<Plugin, Connection>();
	const enabledPlugins = new Map<Plugin, EnabledPlugin>();
	const opened = new Map<Client, { plugin: string; closing?: Promise<void> }>();
	const lifetime = new AbortController();
	const work = new SharedWork<void>();
	const prefixes = plugins.flatMap(plugin => Object.keys(plugin.servers).map(server => `${server}_`.slice(0, TOOL_NAME_LIMIT)));

	async function close(clients: Iterable<Client>): Promise<void> {
		await Promise.all([...clients].map(client => {
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

	function settleStartup(state: EnabledPlugin | undefined) {
		state?.startup?.resolve();
		if (state) delete state.startup;
	}

	function observePreferences() {
		const enabled = preferences();
		for (const plugin of plugins) {
			const state = enabledPlugins.get(plugin);
			if (pluginEnabled(plugin, enabled)) {
				if (!state) enabledPlugins.set(plugin, { startup: { ...Promise.withResolvers<void>(), claimed: false } });
			} else if (state) {
				settleStartup(state);
				enabledPlugins.delete(plugin);
			}
		}
	}

	return {
		hidden() {
			const enabled = preferences();
			return plugins.filter(plugin => !pluginEnabled(plugin, enabled)).map(extensionName);
		},
		ownsTool: name => prefixes.some(prefix => name.startsWith(prefix)),
		nativeTool: name => Object.keys(chromeDevToolsPlugin.servers).some(server => name.startsWith(`${server}_`)),
		nativeServers(cwd) {
			const folder = chatFolder(cwd);
			const plugin = plugins.find(browserPlugin);
			if (!folder || !plugin || !pluginEnabled(plugin, preferences())) return;
			return Object.fromEntries(Object.entries(plugin.servers).flatMap(([name, server]) =>
				server.type === "stdio" ? [[name, stdio(server, new Map(), folder)]] : [],
			));
		},
		httpTools() {
			const enabled = preferences();
			return new Set([...active].flatMap(([plugin, connection]) =>
				pluginEnabled(plugin, enabled) ? connection.httpTools : [],
			));
		},
		async refresh(registry) {
			if (lifetime.signal.aborted) return;
			await work.run({ scope: "plugins", key: "refresh", run: async () => {
				observePreferences();
				for (;;) {
					const enabled = new Map(enabledPlugins);
					for (const plugin of plugins) {
						if (lifetime.signal.aborted) break;
						await reconcile(plugin, enabled.get(plugin), registry);
					}
					if (lifetime.signal.aborted) break;
					observePreferences();
					if (plugins.every(plugin => enabledPlugins.get(plugin) === enabled.get(plugin))) break;
				}
				return { kind: "succeeded", value: undefined };
			} });
		},
		async waitForStartup(signal) {
			if (signal.aborted) return;
			observePreferences();
			const pending = new Map<Plugin, Startup>();
			for (const [plugin, { startup }] of enabledPlugins) {
				if (!startup || startup.claimed) continue;
				startup.claimed = true;
				pending.set(plugin, startup);
			}
			if (pending.size === 0) return;
			const timer = new AbortController();
			try {
				const timedOut = await Promise.race([
					Promise.all([...pending.values()].map(startup => startup.promise)).then(() => false),
					delay(STARTUP_TIMEOUT, true, { signal: AbortSignal.any([signal, timer.signal]) }),
				]);
				if (timedOut) {
					for (const [plugin, startup] of pending) {
						if (enabledPlugins.get(plugin)?.startup === startup)
							log("warn", "plugin.startup.timeout", { plugin: plugin.name, ms: STARTUP_TIMEOUT });
					}
				}
			} catch (error) {
				if (!signal.aborted) throw error;
			} finally {
				timer.abort();
			}
		},
		async close() {
			lifetime.abort();
			for (const state of enabledPlugins.values()) settleStartup(state);
			enabledPlugins.clear();
			active.clear();
			await close([...opened.keys()]);
		},
	};

	function retire(plugin: Plugin, connection: Connection, registry: PluginRegistry) {
		if (active.get(plugin) !== connection) return;
		active.delete(plugin);
		connection.lifetime.abort();
		registry.uninstall({ name: extensionName(plugin) });
		return close(connection.clients);
	}

	async function reconcile(plugin: Plugin, state: EnabledPlugin | undefined, registry: PluginRegistry) {
		try {
			const name = extensionName(plugin);
			const credentials = new Map<string, string>();
			const signedIn = new Set<string>();
			let ready = state !== undefined;
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
						const credential = await pluginCredential(server, name => Promise.resolve(credentials.get(name) ?? lookup(name)));
						if (credential?.kind === "oauth") {
							signedIn.add(name);
							continue;
						}
						if (credential?.kind === "api-key") {
							credentials.set(credential.name, credential.value);
							continue;
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
					&& [...credentials].every(([key, value]) => current.credentials.get(key) === value)) return;
				await retire(plugin, current, registry);
			}
			if (!ready) return;
			const names = new Set(registry.snapshot().tools().map(({ tool }) => tool.name));
			const connected = await connect(plugin, credentials, signedIn, lookup, names, log, lifetime.signal, opened, close,
				connection => {
					if (active.get(plugin) !== connection) return;
					const enabled = enabledPlugins.get(plugin);
					if (enabled) enabled.startup = { ...Promise.withResolvers<void>(), claimed: false };
					void retire(plugin, connection, registry);
				}, () => pluginEnabled(plugin, preferences()));
			if (!connected) return;
			if (lifetime.signal.aborted) return;
			if (connected.connection.lost || !pluginEnabled(plugin, preferences())) {
				await close(connected.connection.clients);
				return;
			}
			active.set(plugin, connected.connection);
			const description = `## Plugin: ${plugin.displayName}\n${plugin.description}`;
			const { instructions, tools } = connected;
			const text = instructions.length ? [description, "### MCP Server Instructions", ...instructions].join("\n\n") : description;
			registry.install({ name, tools, sections: tools.length ? [{
				key: name,
				tag: false,
				render: ({ agent }) => agent.tools.length ? [text, "### Tools", agent.tools.map(tool => {
					const description = tool.description.trim().split(/(?<=[.!?])\s|[\r\n\u2028\u2029]/u, 1)[0]?.slice(0, 100);
					return description ? `- \`${tool.name}\` ${description}` : `- \`${tool.name}\``;
				}).join("\n")].join("\n\n") : text,
			}] : [] });
		} finally {
			settleStartup(state);
		}
	}
}
