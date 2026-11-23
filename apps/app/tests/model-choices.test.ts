// Which model the composer's control reports decides what the person believes the next run uses;
// a stored model the channel no longer offers must report Automatic, which the channel runs instead.
import { expect, test } from "bun:test";

import { modelChoices } from "../src/model-choices";

const OFFERED = [{ provider: "anthropic", modelId: "claude-opus-5-5", efforts: ["off" as const] }];
const AUTOMATIC = { id: "auto", name: "Automatic (claude-opus-5-5)", vendor: "" };
const OPUS = { id: "anthropic/claude-opus-5-5", name: "claude-opus-5-5", vendor: "anthropic" };
const automatic = { provider: "anthropic", modelId: "claude-opus-5-5" };

test("a stored model that is not offered shows as Automatic and is not a choice", () => {
	expect(modelChoices(OFFERED, "retired/old-model", automatic)).toEqual({
		model: "auto",
		choices: [AUTOMATIC, OPUS],
		unoffered: "retired/old-model",
	});
});

test("an offered stored model stays selected", () => {
	expect(modelChoices(OFFERED, OPUS.id, automatic)).toEqual({
		model: OPUS.id,
		choices: [AUTOMATIC, OPUS],
		unoffered: undefined,
	});
});

test("Automatic stays Automatic", () => {
	expect(modelChoices(OFFERED, "auto", automatic).model).toBe("auto");
});

test("until the offered list is known, the stored model stands in and nothing is called unoffered", () => {
	const stand = { id: "retired/old-model", name: "old-model", vendor: "" };
	expect(modelChoices(undefined, stand.id)).toEqual({
		model: stand.id,
		choices: [{ id: "auto", name: "Automatic", vendor: "" }, stand],
		unoffered: undefined,
	});
	// An empty list is a missing provider or a failed answer, which the composer explains on its own.
	expect(modelChoices([], stand.id).unoffered).toBeUndefined();
});
