import { useState } from "react";

import { Switch } from "@ace/ui";
import type { HostRequest, PluginSettings } from "@ace/host/protocol";

import { KeyRow, Problem, Row } from "./settings-layout";

export function Plugin({ plugin, disabled, request }: {
	plugin: PluginSettings;
	disabled: boolean;
	request: (request: HostRequest) => Promise<unknown>;
}) {
	const [action, setAction] = useState<{ busy?: boolean; error?: string }>({});

	async function toggle(enabled: boolean) {
		setAction({ busy: true });
		try {
			await request({ op: "preferences", plugins: { [plugin.name]: enabled } });
			setAction({});
		} catch (error) {
			setAction({ error: (error as Error).message });
		}
	}

	return (
		<>
			<Row
				label={plugin.displayName}
				description={plugin.description}
				footer={action.error && <Problem>{action.error}</Problem>}
			>
				<Switch
					aria-label={plugin.displayName}
					checked={plugin.enabled}
					disabled={disabled || action.busy}
					onCheckedChange={(enabled) => void toggle(enabled)}
				/>
			</Row>
			{plugin.credentials.map((credential) => (
				<KeyRow
					key={credential.name}
					id={`plugin-${plugin.name}-${credential.name}`}
					label={credential.name}
					subject={credential.name}
					status={credential}
					disabled={disabled}
					onSave={(value) =>
						request({ op: "plugin-key-set", plugin: plugin.name, name: credential.name, value })}
					onRemove={() =>
						request({ op: "plugin-key-remove", plugin: plugin.name, name: credential.name })}
				/>
			))}
		</>
	);
}
