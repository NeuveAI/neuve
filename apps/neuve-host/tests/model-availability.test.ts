import "./fixtures/memory-secrets";
import {expect, test} from "bun:test";
import {createModels, fauxProvider} from "@earendil-works/pi-ai";
import {mkdir, mkdtemp, rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {configure, bindConfiguredCatalog} from "../src/host-config";
import {configureRuntime} from "../src/runtime-hooks";
import {extendModels} from "../src/model-availability";
import {checkModel, setModel, settings} from "../src/settings";
import {defaultModel, models} from "../src/manage";
import {preference} from "../src/preferences";

test("configured subscription identity reaches native preference admission and settings without inventing a provider key", async () => {
	const root = await mkdtemp(join(tmpdir(), "models-"));
	try {
		await mkdir(join(root, "h")); await mkdir(join(root, "l"));
		const configured = {provider: "openai", modelId: "configured-subscription-model"};
		configure({home: join(root, "h"), lanes: join(root, "l"), user: "owner", port: 0, environment: {}, worker: [process.execPath], model: configured});
		await bindConfiguredCatalog();
		expect(await models()).toContainEqual(configured);
		await checkModel(configured); await setModel(configured);
		expect(preference()).toEqual(configured);
		const shown = await settings();
		expect(shown.models).toContainEqual(configured);
		expect(shown.providers.find((provider) => provider.id === "openai")?.source).toBe("missing");
		await expect(checkModel({provider: "openai", modelId: "unknown"})).rejects.toThrow("no model named unknown");
		const native = {provider: "openai", modelId: "native-key-model"};
		configureRuntime({modelAvailability: () => [configured, native]});
		expect(await extendModels(Promise.resolve([native, {provider: "anthropic", modelId: "other-native"}]))).toEqual([native, {provider: "anthropic", modelId: "other-native"}, configured]);
		configureRuntime({modelAvailability: () => []});
		await expect(extendModels(Promise.reject(new Error("native credentials failed")))).rejects.toThrow("native credentials failed");
	} finally {await rm(root, {recursive: true, force: true});}
});

// Why: an account's models (codex/<id>, claude/<id>) are not one of pi's providers, and only the
// running host lists them. Choosing one as a channel's model or the default must check it against
// that list, as the channel resolves it, and still refuse a model or provider nobody lists.
test("an account's model is accepted from the host's list, and an unknown one is still refused", async () => {
	const root = await mkdtemp(join(tmpdir(), "models-"));
	try {
		await mkdir(join(root, "h")); await mkdir(join(root, "l"));
		configure({home: join(root, "h"), lanes: join(root, "l"), user: "owner", port: 0, environment: {}, worker: [process.execPath]});
		await bindConfiguredCatalog();
		configureRuntime({modelAvailability: () => []});
		const account = {provider: "codex", modelId: "gpt-6.2-sol"};
		const host = [account];
		await checkModel(account, host);
		await setModel(account, host);
		expect(preference()).toEqual(account);
		await expect(checkModel({provider: "codex", modelId: "none"}, host)).rejects.toThrow("codex has no model named none.");
		await expect(checkModel({provider: "nobody", modelId: "x"}, host)).rejects.toThrow("There's no model provider or signed-in account named nobody.");
		// Without the host's list (no workspace running), the account is not known here.
		await expect(checkModel(account)).rejects.toThrow("neuve auth status codex --check");
	} finally {await rm(root, {recursive: true, force: true});}
});

// The last selected default may belong to a managed account, even when the native catalogue has keys.
test("the host uses the saved default from the worker catalogue and falls back if it disappears", async () => {
	const root = await mkdtemp(join(tmpdir(), "model-default-"));
	try {
		await mkdir(join(root, "h")); await mkdir(join(root, "l"));
		configure({home: join(root, "h"), lanes: join(root, "l"), user: "owner", port: 0, environment: {}, worker: [process.execPath]});
		const catalogue = createModels();
		const first = {provider: "test-native", modelId: "first"};
		const account = {provider: "test-account", modelId: "preferred"};
		for (const ref of [first, account]) {
			catalogue.setProvider(fauxProvider({provider: ref.provider, models: [{id: ref.modelId}]}).provider);
		}
		await setModel(account, [first, account]);
		expect(await defaultModel(catalogue)).toEqual(account);
		catalogue.deleteProvider(account.provider);
		expect(await defaultModel(catalogue)).toEqual(first);
	} finally {await rm(root, {recursive: true, force: true});}
});
