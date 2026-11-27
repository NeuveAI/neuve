import { useEffect, useState } from "react";

import { Button, Switch } from "@ace/ui";
import { IconChevronRight } from "@ace/ui/icons";
import type { HostRequest, PluginSettings } from "@ace/host/protocol";

import { KeyRow, Link, Problem, Row } from "./settings-layout";

export function Plugin({ plugin, disabled, request }: {
	plugin: PluginSettings;
	disabled: boolean;
	request: (request: HostRequest) => Promise<unknown>;
}) {
	const [action, setAction] = useState<{ busy?: boolean; error?: string }>({});
	const [account, setAccount] = useState<
		{ busy?: boolean; pending?: boolean; url?: string; error?: string }
	>({});
	const [keys, setKeys] = useState(() =>
		!plugin.signIn
		|| plugin.credentials.some(({ source }) => source === "keychain" || source === "environment")
	);

	async function toggle(enabled: boolean) {
		setAction({ busy: true });
		try {
			await request({ op: "preferences", plugins: { [plugin.name]: enabled } });
			setAction({});
		} catch (error) {
			setAction({ error: (error as Error).message });
		}
	}

	// The host's answer only opens the page; the sign-in ends when settings report it.
	useEffect(() => setAccount({}), [plugin.signIn?.signedIn, plugin.signIn?.error]);

	async function signIn() {
		setAccount({ busy: true, pending: true });
		try {
			const { url, opened } = await request({ op: "plugin-sign-in", plugin: plugin.name }) as {
				url: string;
				opened: boolean;
			};
			setAccount({ pending: true, ...(opened ? {} : { url }) });
		} catch (error) {
			setAccount({ error: (error as Error).message });
		}
	}

	async function signOut() {
		setAccount({ busy: true });
		try {
			await request({ op: "plugin-sign-out", plugin: plugin.name });
			setAccount({});
		} catch (error) {
			setAccount({ error: (error as Error).message });
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
			{plugin.signIn && (
				<Row
					label={plugin.signIn.signedIn ? "Signed in" : "Not signed in"}
					footer={
						<>
							{plugin.signIn.error && <Problem>{plugin.signIn.error}</Problem>}
							{account.error && <Problem>{account.error}</Problem>}
							{account.url && (
								<p className="text-xs">
									<Link href={account.url}>Open sign-in page</Link>
								</p>
							)}
							{plugin.credentials.length > 0 && (
								<Button
									variant="ghost"
									size="sm"
									className="-ml-2 self-start text-muted-foreground"
									aria-expanded={keys}
									onClick={() => setKeys(!keys)}
								>
									<IconChevronRight
										aria-hidden
										className={`size-3.5 transition-transform motion-reduce:transition-none ${
											keys ? "rotate-90" : ""
										}`}
									/>
									Use an API key
								</Button>
							)}
						</>
					}
				>
					{plugin.signIn.signedIn
						? (
							<Button
								variant="ghost"
								aria-label={`Sign out of ${plugin.displayName}`}
								disabled={disabled || account.busy}
								onClick={() => void signOut()}
							>
								Sign out
							</Button>
						)
						: (
							<Button
								variant="outline"
								aria-label={`Sign in to ${plugin.displayName}`}
								disabled={disabled || account.busy}
								onClick={() => void signIn()}
							>
								{account.pending ? "Signing in…" : "Sign in"}
							</Button>
						)}
				</Row>
			)}
			{keys && plugin.credentials.map((credential) => (
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
