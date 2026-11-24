import { expect, test } from "bun:test";

import { AccountStatus } from "@neuve/runtime/status";
import { listed } from "../src/listed-models";

const signedIn = (name: string, email?: string) =>
	AccountStatus.parse({
		name,
		kind: "chatgpt-subscription",
		signIn: { state: "signed-in", ...(email ? { email } : {}) },
		limits: [],
		checkedAt: "2026-11-24T10:00:00Z",
	});
const models = [
	{ provider: "openai", modelId: "gpt-6.1-sol" },
	{ provider: "codex", modelId: "gpt-6.2-sol" },
	{ provider: "codex", modelId: "gpt-6.1-sol" },
	{ provider: "main", modelId: "gpt-6.2-sol" },
];

// Why: one ChatGPT sign-in reached through two runtimes listed every model twice in the picker,
// and a chat or new-channel pick stored on the hidden account must still show as picked.
test("one sign-in's accounts list each model once, and a pick on a folded account shows on its row", () => {
	const accounts = [signedIn("codex", "alex@example.com"), signedIn("main")];
	const { rows, picked } = listed(models, "main/gpt-6.2-sol", accounts);
	expect(rows.map(({ provider, name }) => `${provider} ${name}`)).toEqual([
		"openai gpt-6.1-sol",
		"codex gpt-6.2-sol",
	]);
	expect(picked).toBe("codex/gpt-6.2-sol");
	expect(listed(models, "gone/gpt-6.1-sol", accounts).picked).toBe("openai/gpt-6.1-sol");
	expect(listed(models, "gone/gpt-1", accounts).picked).toBe("gone/gpt-1");
	expect(listed(models, "auto", accounts).picked).toBe("auto");
});

// Why: a person who really has two ChatGPT sign-ins must still be able to pick either one.
test("a model on two different sign-ins is listed once for each, named with its account", () => {
	const accounts = [signedIn("codex", "alex@example.com"), signedIn("main", "sam@example.com")];
	const { rows, picked } = listed(models, "main/gpt-6.2-sol", accounts);
	expect(rows.map(({ name }) => name)).toEqual(["gpt-6.1-sol", "gpt-6.2-sol · codex", "gpt-6.2-sol · main"]);
	expect(picked).toBe("main/gpt-6.2-sol");
});
