import "./fixtures/memory-secrets";
/**
 * A channel worker as root's entry runs one, with pi-ai's no-network faux provider for Models.
 * Responses come from the JSON script in NEUVE_TEST_SCRIPT; a cursor file beside it records how
 * many were used, so a worker started after a restart continues the script instead of repeating it.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	type FauxResponseStep,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-durable";

import { nativeReview } from "../src/native-review";
import { runWorker } from "../src/worker-runtime";
import { fauxNonTurnModels } from "./fixtures/non-turn-models";

export type Step =
	| { text: string }
	| { tool: string; args: JsonObject; id: string }
	| { error: string };

const script = () => process.env.NEUVE_TEST_SCRIPT!;
const cursor = () => `${script()}.cursor`;
const model = { provider: "faux", modelId: "coder" };
const nonTurnModels = fauxNonTurnModels(model);

const next: FauxResponseStep = () => {
	const steps = JSON.parse(readFileSync(script(), "utf8")) as Step[];
	const used = Number(readFileSync(cursor(), "utf8").trim() || "0");
	writeFileSync(cursor(), String(used + 1));
	const step = steps[used];
	if (!step) return fauxAssistantMessage("The script has no more steps");
	if ("text" in step) return fauxAssistantMessage(step.text);
	if ("error" in step) return fauxAssistantMessage("", { stopReason: "error", errorMessage: step.error });
	return fauxAssistantMessage(fauxToolCall(step.tool, step.args, { id: step.id }), { stopReason: "toolUse" });
};

// Accelerate only the idle clock in the real worker process; production retirement constants stay unchanged.
const retirement = process.env.NEUVE_TEST_RETIRE_NOW;
if (retirement) {
	const clock = Date.now;
	let elapsed = 0;
	Date.now = () => clock() + (existsSync(retirement) ? (elapsed += 11 * 60_000) : 0);
	const interval = globalThis.setInterval;
	globalThis.setInterval = (callback, ms, ...args) => interval(callback, ms === 30_000 ? 20 : ms, ...args);
}

let reviewAdapter: ReturnType<typeof nativeReview> | undefined;
await runWorker({
 review(worker) { reviewAdapter = nativeReview(worker.sessionId); return reviewAdapter.review; },
	async close({ worker, reads, context }) {
 reviewAdapter?.close();
		const wait = process.env.NEUVE_TEST_CLOSE_WAIT;
		if (wait) {
			writeFileSync(`${wait}.closing`, "");
			while (!existsSync(wait)) await Bun.sleep(10);
		}
		const conversations = await reads.scanConversations({}, 256, undefined, context);
		writeFileSync(join(worker.stateDirectory, "read-before-close.json"), JSON.stringify(conversations.items.map(({ id }) => id)));
		if (process.env.NEUVE_TEST_CLOSE_FAIL === "1") throw new Error("Synthetic capture export failure");
	},
	models({ sessionId, stateDirectory, config }) {
		// What root's factory would bind capture to, recorded for the host test to compare.
		writeFileSync(join(stateDirectory, "models-context.json"), JSON.stringify({ sessionId, stateDirectory, home: config.home }));
		const faux = fauxProvider({ provider: model.provider, models: [{ id: model.modelId, contextWindow: 200_000 }] });
		faux.setResponses(Array.from({ length: 64 }, () => next));
		const models = createModels();
		models.setProvider(faux.provider);
		return models;
	},
	nonTurnModels: (_, kind) => nonTurnModels(kind),
	defaultModel: async () => model,
});
