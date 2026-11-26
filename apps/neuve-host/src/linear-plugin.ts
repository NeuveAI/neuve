import planning from "../plugins/linear/planning.json" with { type: "json" };
import { linearPlugin } from "./plugin-manifest";
import { pluginOAuth } from "./plugin-oauth";
import { pluginOAuthTransport } from "./plugin-oauth-client";

export function linearPlanningSource(plugin = linearPlugin, oauth = pluginOAuth) {
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
		http: () => pluginOAuthTransport(server),
		async available() {
			try {
				const { pluginPreferences } = await import("./preferences");
				return pluginPreferences()[plugin.name] === true && (await oauth.status(plugin))?.signedIn === true;
			} catch {
				const { log } = await import("./log");
				log("warn", "plugin.preferences.failed", { plugin: plugin.name });
				return false;
			}
		},
	};
}
