import "./fixtures/memory-secrets";
import {expect, test} from "bun:test";
import {mkdir, mkdtemp, rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {configure, bindConfiguredCatalog} from "../src/host-config";
import {configureRuntime} from "../src/runtime-hooks";
import {extendModels} from "../src/model-availability";
import {checkModel, setModel, settings} from "../src/settings";
import {models} from "../src/manage";
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
