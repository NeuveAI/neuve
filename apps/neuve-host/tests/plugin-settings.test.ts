import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { calls } from "./fixtures/memory-secrets";
import { config } from "../src/config";
import { parseNativeHostRequest } from "../src/native-request";
import { saveFolder, savePlugins } from "../src/preferences";
import { removePluginKey, setPluginKey, settings } from "../src/settings";

// Native settings requests must persist and report plugin choices without exposing credential values.
test("plugin settings validate native payloads, preserve preferences, and restrict credential operations", async () => {
	const root = await mkdtemp(join(tmpdir(), "plugin-settings-"));
	const previous = config.settings;
	const names = ["LINEAR_API_KEY", "ACE_LINEAR_API_KEY"];
	const overrides = names.map(name => process.env[name]);
	for (const name of names) delete process.env[name];
	config.settings = root;
	try {
		const plugins = async () => (await settings()).plugins;
		const description = "Read and update Linear issues, projects, and teams.";
		const name = "LINEAR_API_KEY";
		const devtools = {
			name: "chrome-devtools", displayName: "Chrome DevTools",
			description: "Inspect and automate Ace's dedicated development browser.", enabled: true, credentials: [],
		};
		expect(await plugins()).toEqual([{
			name: "linear", displayName: "Linear", description, enabled: false, signIn: { signedIn: false }, credentials: [{ name, source: "missing", stored: false }],
		}, devtools]);
		const preferences = parseNativeHostRequest({ op: "preferences", plugins: { linear: true, "chrome-devtools": false } });
		if (preferences.op !== "preferences" || !preferences.plugins) throw new Error("Missing plugin preferences");
		savePlugins(preferences.plugins);
		saveFolder(root);
		expect(await plugins()).toEqual([{
			name: "linear", displayName: "Linear", description, enabled: true, signIn: { signedIn: false }, credentials: [{ name, source: "missing", stored: false }],
		}, { ...devtools, enabled: false }]);
		expect(() => parseNativeHostRequest({ op: "preferences", plugins: { linear: "on" } })).toThrow();

		expect(parseNativeHostRequest({ op: "plugin-sign-in", plugin: "linear" })).toEqual({
			op: "plugin-sign-in", plugin: "linear",
		});
		expect(parseNativeHostRequest({ op: "plugin-sign-out", plugin: "linear" })).toEqual({
			op: "plugin-sign-out", plugin: "linear",
		});

		const { set, delete: removed } = calls;
		await expect(setPluginKey("linear", "OPENAI_API_KEY", "unused")).rejects.toThrow("Choose a credential used by the plugin");
		await expect(removePluginKey("linear", "OPENAI_API_KEY")).rejects.toThrow("Choose a credential used by the plugin");
		expect(calls.set).toBe(set);
		expect(calls.delete).toBe(removed);
		const stored = parseNativeHostRequest({ op: "plugin-key-set", plugin: "linear", name, value: "fixture-key" });
		if (stored.op !== "plugin-key-set") throw new Error("Missing key set request");
		await setPluginKey(stored.plugin, stored.name, stored.value);
		expect(await plugins()).toEqual([{
			name: "linear", displayName: "Linear", description, enabled: true, signIn: { signedIn: false }, credentials: [{ name, source: "keychain", stored: true }],
		}, { ...devtools, enabled: false }]);
		const remove = parseNativeHostRequest({ op: "plugin-key-remove", plugin: "linear", name });
		if (remove.op !== "plugin-key-remove") throw new Error("Missing key remove request");
		await removePluginKey(remove.plugin, remove.name);
		await writeFile(join(root, "settings.json"), JSON.stringify({ folder: root, plugins: "on" }));
		expect(await plugins()).toEqual([{
			name: "linear", displayName: "Linear", description, enabled: false, signIn: { signedIn: false }, credentials: [{ name, source: "missing", stored: false }],
		}, devtools]);
		savePlugins({ linear: true });
		expect((await plugins())[0]?.enabled).toBe(true);
	} finally {
		config.settings = previous;
		for (const [index, name] of names.entries()) {
			const value = overrides[index];
			if (value !== undefined) process.env[name] = value;
		}
		await rm(root, { recursive: true, force: true });
	}
});
