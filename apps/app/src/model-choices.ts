import type { ModelOption, ModelRef } from "@ace/channel/protocol";

export const key = (model: ModelRef) => `${model.provider}/${model.modelId}`;

/**
 * The model picker's choices, Automatic first, and the pick it shows for `stored` (`provider/id` or
 * `auto`). Once the offered list is known, a stored model missing from it shows as Automatic, which
 * the channel runs instead; until then the stored model stands in as a choice.
 */
export function modelChoices(models: ModelOption[] | undefined, stored: string, automatic?: ModelRef) {
	const offered = (models || []).map((value) => ({ id: key(value), name: value.modelId, vendor: value.provider }));
	const known = !!models?.length;
	const listed = stored === "auto" || offered.some((value) => value.id === stored);
	const standIn = listed || known ? [] : [{ id: stored, name: stored.split("/").slice(1).join("/"), vendor: "" }];
	return {
		model: listed || !known ? stored : "auto",
		choices: [
			{ id: "auto", name: automatic ? `Automatic (${automatic.modelId})` : "Automatic", vendor: "" },
			...standIn,
			...offered,
		],
	};
}
