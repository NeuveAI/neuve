import type { ModelRef } from "@ace/channel/protocol";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";

export function fauxNonTurnModels({ provider, modelId }: ModelRef) {
	return (kind: "caption" | "recap") => {
		// The channel checks this model against the turn catalogue before using this provider.
		const fake = fauxProvider({ provider, models: [{ id: modelId }], tokensPerSecond: 100_000 });
		const reply = fauxAssistantMessage(kind === "caption" ? "Ran fixture tools" : "Completed the scripted work.");
		const models = createModels();
		models.setProvider({
			...fake.provider,
			streamSimple(model, context, options) {
				fake.appendResponses([reply]);
				return fake.provider.streamSimple(model, context, options);
			},
		});
		return models;
	};
}
