import planning from "../plugins/linear/planning.json" with { type: "json" };
import { linearPlugin, pluginEnabled } from "./plugin-manifest";
import { key } from "./keys";
import { pluginCredential, pluginMcp } from "./plugin-oauth-client";

export function linearPlanningSource(plugin = linearPlugin) {
	const server = plugin.oauth.get("linear");
	if (!server) throw new Error("Linear planning requires the plugin's OAuth server");
	return {
		id: server.name,
		label: plugin.displayName,
		definition: {
			...planning,
			transport: { type: "http", url: server.url.href, headers: server.headers },
			variables: [],
		},
		http: (_name: string, info: Parameters<typeof pluginMcp>[2]) => pluginMcp(server, key, info),
		async available() {
			try {
				const { pluginPreferences } = await import("./preferences");
				if (!pluginEnabled(plugin, pluginPreferences())) return false;
			} catch {
				const { log } = await import("./log");
				log("warn", "plugin.preferences.failed", { plugin: plugin.name });
				return false;
			}
			return pluginCredential(server).then(Boolean, () => false);
		},
	};
}
