import {extendModels} from "./model-availability";
import { ClaudeSubscriptionTokenRefused, isClaudeSubscriptionToken } from "../../../packages/harness/src/subscription-token.ts";
import type { ModelRef } from "@ace/channel/protocol";
import { available } from "@ace/channel/models";
import { isBranchPrefix } from "@ace/channel/git";
import { homedir } from "node:os";

import { computeSettings } from "./compute";
import { config } from "./config";
import * as directory from "./directory";
import { config as host, LanesDirectory, separateDirectories } from "./host-config";
import { rejection } from "./http";
import {
	forget,
	isRejected,
	judge,
	key,
	KEYCHAIN_WAITING,
	latest,
	models as keyed,
	overriding,
	settled,
	store,
} from "./keys";
import { carriedPlugins, pluginEnabled, type Plugin } from "./plugin-manifest";
import { log } from "./log";
import { pluginOAuth, type PluginOAuth } from "./plugin-oauth";
import { defaultModel, models, parseModel } from "./manage";
import { canonical } from "./move";
import {
	isModel,
	lanePreferences,
	preference,
	pluginPreferences,
	saveCompute,
	saveFolder,
	saveLanePreferences,
	savePreference,
} from "./preferences";
import { git } from "./projects";
import type { Compute, Invite, PluginSettings, ProviderId, Settings } from "./protocol";
import * as tailnet from "./tailnet";

const providers = new Map(
	[
		["anthropic", {
			name: "Anthropic",
			key: "ANTHROPIC_API_KEY",
			url: "https://api.anthropic.com/v1/models?limit=1",
		}],
		["openai", { name: "OpenAI", key: "OPENAI_API_KEY", url: "https://api.openai.com/v1/models" }],
	] as const,
);

function provider(id: ProviderId) {
	const found = providers.get(id);
	if (!found) throw new Error("Choose Anthropic or OpenAI");
	return found;
}

/** Settings never waits on a keychain prompt; `fresh` reads again names whose last read prompted. */
export async function settings(fresh?: boolean): Promise<Settings> {
	const catalog = settled(fresh);
	let enabled: ReturnType<typeof pluginPreferences> = {};
	try {
		enabled = pluginPreferences();
	} catch {
		log("warn", "plugin.preferences.failed");
	}
	const [statuses, plugins, usable, automatic] = await Promise.all([
		Promise.all(
			[...providers].map(async ([id, { name, key }]) =>
				Object.assign(
					await latest(key, fresh),
					{ id, name },
					isRejected(key) ? { rejected: true as const } : {},
				)
			),
		),
		Promise.all(carriedPlugins.map(plugin => pluginSettings(plugin, pluginEnabled(plugin, enabled), fresh))),
		extendModels(available(catalog.models)).catch((error: Error) => error),
		defaultModel(catalog.models).catch(() => undefined),
	]);
	return {
		providers: statuses,
		plugins,
		...lanePreferences(),
		model: preference(),
		modelOverride: config.model ? parseModel(config.model) : undefined,
		models: usable instanceof Error ? [] : usable,
		...(automatic ? { automatic } : {}),
		waiting: catalog.waiting() ? KEYCHAIN_WAITING : undefined,
		error: usable instanceof Error ? usable.message : undefined,
	};
}

export async function pluginSettings(plugin: Plugin, enabled: boolean, fresh?: boolean, oauth: PluginOAuth = pluginOAuth): Promise<PluginSettings> {
	const [credentials, signIn] = await Promise.all([
		Promise.all([...plugin.credentials].map(async name => ({ name, ...await latest(name, fresh) }))),
		oauth.status(plugin, fresh),
	]);
	const { name, displayName, description } = plugin;
	return { name, displayName, description, enabled, credentials, ...(signIn ? { signIn } : {}) };
}

class Rejected extends Error {}

async function check(id: ProviderId, value: string): Promise<void> {
	if (id === "anthropic" && isClaudeSubscriptionToken(value)) {
		throw new ClaudeSubscriptionTokenRefused("ANTHROPIC_API_KEY");
	}
	const selected = provider(id);
	const headers: Record<string, string> = id === "anthropic"
		? { "x-api-key": value, "anthropic-version": "2023-06-01" }
		: { authorization: `Bearer ${value}` };
	let response: Response;
	try {
		response = await fetch(selected.url, {
			headers,
			signal: AbortSignal.timeout(10_000),
			redirect: "error",
		});
	} catch {
		throw new Error(`Could not reach ${selected.name}. Check your connection and try again.`);
	}
	// Provider errors can echo credentials. Only status codes leave the host.
	await response.body?.cancel();
	if (response.ok) return;
	if (response.status === 401) throw new Rejected(`${selected.name} rejected this API key.`);
	if (response.status === 403) {
		throw new Error(
			`${selected.name} denied access. Check this key's permissions for listing models.`,
		);
	}
	if (response.status === 429) {
		throw new Error(`${selected.name} is rate limiting requests. Try again shortly.`);
	}
	throw new Error(`${selected.name} could not check the key (HTTP ${response.status}). Try again.`);
}

function isValue(value: unknown): value is string {
	return typeof value === "string" && !!value.trim() && value.length <= 4096
		&& !/[\r\n]/.test(value) && !value.includes("\0");
}

function requirePluginKey(plugin: string, name: string): void {
	if (!carriedPlugins.find(item => item.name === plugin)?.credentials.has(name))
		throw new Error("Choose a credential used by the plugin");
}

export async function setPluginKey(plugin: string, name: string, value: string): Promise<void> {
	requirePluginKey(plugin, name);
	if (!isValue(value)) throw new Error("Enter a valid plugin credential");
	try {
		await store(name, value.trim());
	} catch {
		throw new Error("Could not save the plugin credential. Unlock the keychain and allow Neuve Helper, then retry.");
	}
}

export async function removePluginKey(plugin: string, name: string): Promise<void> {
	requirePluginKey(plugin, name);
	try {
		await forget(name);
	} catch {
		throw new Error("Could not remove the plugin credential. Unlock the keychain and allow Neuve Helper, then retry.");
	}
}

export async function setKey(id: ProviderId, value: string): Promise<void> {
	const selected = provider(id);
	if (!isValue(value)) throw new Error("Enter a valid API key");
	value = value.trim();
	await check(id, value);
	try {
		await store(selected.key, value);
	} catch {
		throw new Error(
			`Could not save the ${selected.name} key. Unlock the keychain and allow Neuve Helper, then retry.`,
		);
	}
}

/** `changed` runs when the verdict changes what Settings shows for the key. */
export async function checkKey(id: ProviderId, changed: () => void): Promise<void> {
	const selected = provider(id);
	const value = await key(selected.key);
	if (!value) throw new Error(`Add a ${selected.name} API key first.`);
	try {
		await check(id, value);
	} catch (error) {
		if (error instanceof Rejected && judge(selected.key, false)) changed();
		throw error;
	}
	if (judge(selected.key, true)) changed();
}

export async function removeKey(id: ProviderId): Promise<void> {
	const selected = provider(id);
	try {
		await forget(selected.key);
	} catch {
		throw new Error(
			`Could not remove the ${selected.name} key. Unlock the keychain and allow Neuve Helper, then retry.`,
		);
	}
}

/**
 * A model this host can run, as the default and `ace new --model` both need: one a provider key
 * gives, or one a signed-in account's model rows list. `found` is the list to check against; the
 * command line passes the running host's, which alone knows the accounts' models.
 */
export async function checkModel(
	model: ModelRef,
	found: readonly ModelRef[] | Promise<readonly ModelRef[]> = models(),
): Promise<void> {
	if (!isModel(model)) throw new Error("Choose a provider and model");
	const listed = await found;
	if (listed.some((item) => item.provider === model.provider && item.modelId === model.modelId)) {
		return;
	}
	// With its key set, or its account signed in, the provider lists every model it has.
	if (listed.some((item) => item.provider === model.provider)) {
		throw new Error(`${model.provider} has no model named ${model.modelId}.`);
	}
	if (!keyed().getProvider(model.provider)) {
		throw new Error(
			`There's no model provider or signed-in account named ${model.provider}. An account's models are listed while the workspace runs and the account is signed in; check it with neuve auth status ${model.provider} --check.`,
		);
	}
	throw new Error("This model is unavailable. Add its provider key first.");
}

export async function setModel(model: ModelRef | null, found?: readonly ModelRef[]): Promise<void> {
	if (model !== null) await checkModel(model, found);
	savePreference(model);
}

/**
 * A compute service answers an unsigned request with 401 and its tailnet, so a new URL is checked
 * before it's saved, without reading the team's secret.
 */
async function probe(url: string): Promise<void> {
	const { host } = new URL(url);
	let response: Response;
	try {
		response = await fetch(`${url}/workspaces/0000000000000000/status`, {
			signal: AbortSignal.timeout(10_000),
		});
	} catch (error) {
		throw new Error(`Could not reach ${host}: ${(error as Error).message}. Check the URL.`, {
			cause: error,
		});
	}
	if (response.status !== 401) {
		await response.body?.cancel();
		throw new Error(
			`${host} is not a Neuve compute service (HTTP ${response.status}). Check the URL.`,
		);
	}
	const served = response.headers.get("ace-tailnet");
	const domain = await tailnet.domain();
	if (!served || (domain && served !== domain)) {
		throw new Error(await rejection(response, host));
	}
	await response.body?.cancel();
}

export async function setCompute({ enabled, url }: Compute): Promise<void> {
	if (typeof enabled !== "boolean") throw new Error("Turn cloud compute on or off");
	const service = url?.trim() ? canonical(url.trim()) : null;
	if (enabled && !service) throw new Error("Add the cloud compute service URL first");
	if (service && service !== computeSettings().url) await probe(service);
	saveCompute({ enabled, url: service });
}

function fullFolder(value: string, example: string): string {
	const path = value.trim().replace(/(.)\/+$/, "$1");
	if (!isValue(path) || !/^(?:~(?:\/|$)|\/)/.test(path)) {
		throw new Error(`Enter a full folder path, such as ${example}`);
	}
	return path;
}

export function setFolder(value: string): void {
	saveFolder(fullFolder(value, "~/code"));
}

export async function setLanePreferences({ lanesFolder, branchPrefix }: {
	lanesFolder?: string;
	branchPrefix?: string;
}): Promise<void> {
	if (lanesFolder === undefined && branchPrefix === undefined) return;
	if (lanesFolder) {
		const path = fullFolder(lanesFolder, "~/worktrees");
		const expanded = path.startsWith("~") ? homedir() + path.slice(1) : path;
		const directory = LanesDirectory.safeParse(expanded);
		if (!directory.success) throw new Error("Choose an existing directory for work lanes");
		lanesFolder = directory.data;
		if (!separateDirectories(lanesFolder, host.home)) {
			throw new Error("Choose a lanes folder separate from the host's state folder");
		}
		if ((await git(lanesFolder, ["rev-parse", "--git-dir"])).status === 0) {
			throw new Error("Choose a lanes folder outside Git checkouts");
		}
	}
	if (branchPrefix && (!isBranchPrefix(branchPrefix)
		|| (await git(host.home, ["check-ref-format", "--branch", branchPrefix])).status !== 0)) {
		throw new Error("Enter a valid Git branch prefix of 1 to 40 letters, digits, dots, underscores, or hyphens starting with a letter or digit");
	}
	saveLanePreferences({
		...(lanesFolder === undefined ? {} : { lanesFolder }),
		...(branchPrefix === undefined ? {} : { branchPrefix }),
	});
}

function named(name: unknown): void {
	if (typeof name !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(name)) {
		throw new Error("Name a key such as OPENAI_API_KEY");
	}
}

/**
 * Keychain items saved through Ace Helper, so it can read them later without a macOS prompt: an
 * item saved by another program, such as a CLI's Bun or `security`, asks before Ace Helper reads it.
 */
export async function storeKey(name: string, value: string): Promise<void> {
	named(name);
	if (!isValue(value)) throw new Error(`Enter a valid ${name}`);
	try {
		await store(name, value.trim());
	} catch {
		throw new Error(
			`Could not save ${name}. Unlock the keychain and allow Neuve Helper, then retry.`,
		);
	}
}

export async function forgetKey(name: string): Promise<boolean> {
	named(name);
	try {
		return await forget(name);
	} catch {
		throw new Error(
			`Could not remove ${name}. Unlock the keychain and allow Neuve Helper, then retry.`,
		);
	}
}

/** What a teammate needs to join: this host's directory and the secret it was joined with. */
export async function invite(): Promise<Invite> {
	const url = directory.url();
	const secret = await key("ACE_SECRET");
	if (!url || !secret) throw new Error("Join the team's directory first");
	return { url, secret };
}

/**
 * Join the team's directory, or leave it when `url` is null. A new secret replaces the saved
 * ACE_SECRET only after the directory accepts it; without one, the saved secret is sent if there
 * is one, and a directory a host serves needs none.
 */
export async function setDirectory(url: string | null, secret?: string): Promise<void> {
	if (url === null) return directory.configure(undefined);
	const base = directory.canonical(url);
	if (secret !== undefined && !isValue(secret)) throw new Error("Enter the team's shared secret");
	const override = secret !== undefined && overriding("ACE_SECRET");
	if (override) {
		throw new Error(
			`${override} in Neuve Helper's environment takes priority over a saved secret. Remove it and restart Neuve Helper first.`,
		);
	}
	const value = secret?.trim() || await key("ACE_SECRET");
	await directory.check(base, value);
	if (secret !== undefined) await storeKey("ACE_SECRET", secret.trim());
	await directory.configure(base);
}
