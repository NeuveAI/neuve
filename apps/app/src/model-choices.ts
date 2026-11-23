import type { ModelOption, ModelRef } from "@ace/channel/protocol";

export const key = (model: ModelRef) => `${model.provider}/${model.modelId}`;

/**
 * The model picker's choices, Automatic first, and the pick it shows for `stored` (`provider/id` or
 * `auto`). Once the offered list is known, a stored model missing from it shows as Automatic, which
 * the channel runs instead; until then the stored model stands in as a choice.
 */
export function modelChoices(models: ModelOption[] | undefined, stored: string, automatic?: ModelRef) {
	const choices = (models || []).map((value) => ({ id: key(value), name: value.modelId, vendor: value.provider }));
	const listed = stored === "auto" || choices.some((value) => value.id === stored);
	const unoffered = listed || !models?.length ? undefined : stored;
	if (!listed && !unoffered) {
		choices.unshift({ id: stored, name: stored.split("/").slice(1).join("/"), vendor: "" });
	}
	choices.unshift({ id: "auto", name: automatic ? `Automatic (${automatic.modelId})` : "Automatic", vendor: "" });
	return { model: unoffered ? "auto" : stored, choices, unoffered };
}
