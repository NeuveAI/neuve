import { z } from "zod";

import linear from "../plugins/linear/.claude-plugin/plugin.json" with { type: "json" };
import linearMcp from "../plugins/linear/.mcp.json" with { type: "json" };

const name = z.string().regex(/^[A-Za-z0-9_-]+$/);
export const PluginPreferences = z.record(name, z.boolean());
const values = z.record(z.string(), z.string());
const server = z.discriminatedUnion("type", [
	z.strictObject({ type: z.literal("http"), url: z.string().min(1), headers: values.optional() }),
	z.strictObject({ type: z.literal("stdio"), command: z.string().min(1), args: z.array(z.string()).optional(), env: values.optional() }),
]);
const variable = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export const PluginManifest = z.strictObject({
	manifest: z.strictObject({
		name,
		description: z.string().min(1),
		interface: z.strictObject({ displayName: z.string().trim().min(1) }).optional(),
	}),
	mcp: z.strictObject({ mcpServers: z.record(name, server) }),
}).transform(({ manifest, mcp }) => {
	const variables = new Set<string>();
	for (const config of Object.values(mcp.mcpServers)) {
		const fields = config.type === "http"
			? [config.url, ...Object.values(config.headers ?? {})]
			: [config.command, ...(config.args ?? []), ...Object.values(config.env ?? {})];
		for (const field of fields)
			for (const [, name] of field.matchAll(variable)) variables.add(name);
	}
	return {
		name: manifest.name,
		description: manifest.description,
		displayName: manifest.interface?.displayName ?? manifest.name,
		servers: mcp.mcpServers,
		variables,
	};
});

export type Plugin = z.output<typeof PluginManifest>;
export type PluginServer = z.output<typeof server>;

export function expandPluginValue(value: string, credentials: ReadonlyMap<string, string>): string {
	return value.replace(variable, (_, name: string) => {
		const secret = credentials.get(name);
		if (secret === undefined) throw new Error(`Missing plugin variable ${name}`);
		return secret;
	});
}

export const carriedPlugins = [PluginManifest.parse({ manifest: linear, mcp: linearMcp })];
const pluginSecrets = new Set(carriedPlugins.flatMap(plugin =>
	[...plugin.variables].flatMap(name => [name, `ACE_${name}`]),
));

export const secretName = (name: string) =>
	pluginSecrets.has(name) || /(_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIALS?)$/.test(name);
