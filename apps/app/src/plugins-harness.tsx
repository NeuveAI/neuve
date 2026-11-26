// Dev-only, served by Vite and absent from its production entry points.
import { createRoot } from "react-dom/client";
import type { CredentialStatus, PluginSettings } from "@ace/host/protocol";

import { Plugin } from "./plugin-settings";
import { Group, Page } from "./settings-layout";
import "./styles.css";

const missing: CredentialStatus = { source: "missing", stored: false };

const linear = (
	enabled: boolean,
	key: CredentialStatus,
	signIn?: PluginSettings["signIn"],
): PluginSettings => ({
	name: "linear",
	displayName: "Linear",
	description: "Read and update Linear issues, projects, and teams.",
	enabled,
	...(signIn ? { signIn } : {}),
	credentials: [{ name: "LINEAR_API_KEY", ...key }],
});

const fixtures = {
	"signed out": linear(false, missing, { signedIn: false }),
	"signed in": linear(true, missing, { signedIn: true }),
	"sign-in error": linear(true, missing, {
		signedIn: false,
		error: "Linear refused the sign-in. Try again.",
	}),
	"signed in, key set": linear(true, { source: "keychain", stored: true }, { signedIn: true }),
	"no sign-in, key missing": linear(true, missing),
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
