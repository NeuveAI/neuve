// The model control is the only place a person learns what the next run uses: a stored model the
// channel no longer offers must show as Automatic, which the channel runs instead.
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
	});
});

test("an offered stored model stays selected", () => {
	expect(modelChoices(OFFERED, OPUS.id, automatic)).toEqual({
		model: OPUS.id,
		choices: [AUTOMATIC, OPUS],
	});
});

test("Automatic stays Automatic", () => {
	expect(modelChoices(OFFERED, "auto", automatic).model).toBe("auto");
});

test("until a non-empty offered list is known, the stored model stands in for itself", () => {
	const stand = { id: "retired/old-model", name: "old-model", vendor: "" };
	expect(modelChoices(undefined, stand.id)).toEqual({
		model: stand.id,
		choices: [{ id: "auto", name: "Automatic", vendor: "" }, stand],
	});
	// An empty list is a missing provider or a failed answer, which the composer explains on its own.
	expect(modelChoices([], stand.id).model).toBe(stand.id);
});
