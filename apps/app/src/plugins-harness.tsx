// Dev-only, served by Vite and absent from its production entry points.
import { createRoot } from "react-dom/client";
import type { CredentialStatus, PluginSettings } from "@ace/host/protocol";

import { Plugin } from "./plugin-settings";
import { Group, Page } from "./settings-layout";
import "./styles.css";

const linear = (enabled: boolean, key: CredentialStatus): PluginSettings => ({
	name: "linear",
	displayName: "Linear",
	description: "Read and update Linear issues, projects, and teams.",
	enabled,
	credentials: [{ name: "LINEAR_API_KEY", ...key }],
});

const fixtures = {
	"on, key saved": linear(true, { source: "keychain", stored: true }),
	"off, key saved": linear(false, { source: "keychain", stored: true }),
	"on, key missing": linear(true, { source: "missing", stored: false }),
	"off, key missing": linear(false, { source: "missing", stored: false }),
	"key from the environment": linear(true, {
		source: "environment",
		stored: false,
		override: "ACE_LINEAR_API_KEY",
	}),
	"keychain waiting": linear(true, {
		source: "unavailable",
		stored: null,
		waiting: "Waiting for Keychain",
	}),
};

document.documentElement.classList.toggle(
	"dark",
	new URLSearchParams(location.search).get("theme") === "dark",
);

createRoot(document.getElementById("root")!).render(
	<main className="mx-auto h-full max-w-2xl overflow-auto bg-background p-8 text-foreground">
		<Page>
			{Object.entries(fixtures).map(([state, plugin]) => (
				<div key={state} data-state={state} className="@container rounded-xl border border-border p-5">
					<h2 className="mb-3 text-sm text-muted-foreground">{state}</h2>
					<Group>
						<Plugin plugin={plugin} disabled={false} request={async () => {}} />
					</Group>
				</div>
			))}
		</Page>
	</main>,
);
