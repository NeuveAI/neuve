import { join } from "node:path";
import { z } from "zod";

import chromeDevTools from "../plugins/chrome-devtools/.claude-plugin/plugin.json" with { type: "json" };
import chromeDevToolsMcp from "../plugins/chrome-devtools/.mcp.json" with { type: "json" };
import linear from "../plugins/linear/.claude-plugin/plugin.json" with { type: "json" };
import linearMcp from "../plugins/linear/.mcp.json" with { type: "json" };
import { config } from "./config";

const name = z.string().regex(/^[A-Za-z0-9_-]+$/);
export const PluginPreferences = z.record(name, z.boolean());
const values = z.record(z.string(), z.string());
const server = z.union([
	z.strictObject({ type: z.literal("http"), url: z.string().min(1), headers: values.optional() }),
	z.strictObject({ type: z.literal("stdio").default("stdio"), command: z.string().min(1), args: z.array(z.string()).optional(), env: values.optional() }),
]);
const variable = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const servers = z.record(name, server);
const hostVariables = new Map<string, (folder?: string) => string | undefined>([
	["ACE_BROWSER_PROFILE", () => join(config.home, "browser")],
	["ACE_CHAT_FOLDER", folder => folder],
]);

export type OAuthServer = { plugin: string; name: string; url: URL; headers?: Record<string, string>; apiKey?: string };
export const loopback = (url: URL) => ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);

export const PluginManifest = z.strictObject({
	manifest: z.strictObject({
		name,
		codexPlugin: name.optional(),
		description: z.string().min(1),
		version: z.string().optional(),
		author: z.object({ name: z.string().min(1), email: z.string().optional(), url: z.string().optional() }).optional(),
		homepage: z.string().optional(),
		repository: z.string().optional(),
		license: z.string().optional(),
		keywords: z.array(z.string()).optional(),
		mcpServers: servers.optional(),
		interface: z.strictObject({ displayName: z.string().trim().min(1) }).optional(),
		defaultEnabled: z.boolean().default(false),
		apiKey: z.record(name, z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).optional(),
	}),
	mcp: z.union([z.strictObject({ mcpServers: servers }).transform(({ mcpServers }) => mcpServers), servers]).optional(),
}).transform(({ manifest, mcp }, context) => {
	const configured = { ...mcp, ...manifest.mcpServers };
	const variables = new Set<string>();
	const oauth = new Map<string, OAuthServer>();
	for (const [name, config] of Object.entries(configured)) {
		const fields = config.type === "http"
			? [config.url, ...Object.values(config.headers ?? {})]
			: [config.command, ...(config.args ?? []), ...Object.values(config.env ?? {})];
		const names = fields.flatMap(field => [...field.matchAll(variable)].map(([, name]) => name));
		for (const name of names) if (!hostVariables.has(name)) variables.add(name);
		if (config.type !== "http" || names.length
			|| Object.keys(config.headers ?? {}).some(header => header.toLowerCase() === "authorization")) continue;
		const url = URL.parse(config.url);
		if (url && !url.username && !url.password && !url.hash && (
			url.protocol === "https:" || (url.protocol === "http:" && loopback(url))
		)) oauth.set(name, { plugin: manifest.name, name, url, headers: config.headers, apiKey: manifest.apiKey?.[name] });
	}
	for (const name of Object.keys(manifest.apiKey ?? {})) {
		if (oauth.has(name)) continue;
		context.issues.push({ code: "custom", message: "An API key fallback requires a headerless OAuth server", input: name });
		return z.NEVER;
	}
	return {
		name: manifest.name,
		...(manifest.codexPlugin === undefined ? {} : { codexPlugin: manifest.codexPlugin }),
		description: manifest.description,
		displayName: manifest.interface?.displayName ?? manifest.name,
		defaultEnabled: manifest.defaultEnabled,
		servers: configured,
		variables,
		oauth,
		credentials: new Set([...variables, ...Object.values(manifest.apiKey ?? {})]),
	};
});

export type Plugin = z.output<typeof PluginManifest>;
export type PluginServer = z.output<typeof server>;

export const pluginEnabled = (plugin: Plugin, preferences: z.output<typeof PluginPreferences>) =>
	preferences[plugin.name] ?? plugin.defaultEnabled;

export function expandPluginValue(value: string, credentials: ReadonlyMap<string, string>, folder?: string): string {
	return value.replace(variable, (_, name: string) => {
		const hostValue = hostVariables.get(name);
		const resolved = hostValue ? hostValue(folder) : credentials.get(name);
		if (resolved === undefined) throw new Error(`Missing plugin variable ${name}`);
		return resolved;
	});
}

export const linearPlugin = PluginManifest.parse({ manifest: linear, mcp: linearMcp });
export const chromeDevToolsPlugin = PluginManifest.parse({ manifest: chromeDevTools, mcp: chromeDevToolsMcp });
export const carriedPlugins = [linearPlugin, chromeDevToolsPlugin];
const pluginSecrets = new Set(carriedPlugins.flatMap(plugin =>
	[...plugin.credentials].flatMap(name => [name, `ACE_${name}`]),
));

export const secretName = (name: string) =>
	pluginSecrets.has(name) || /(_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIALS?)$/.test(name);
