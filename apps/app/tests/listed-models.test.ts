import { expect, test } from "bun:test";

import { AccountStatus } from "@neuve/runtime/status";
import { listed } from "../src/listed-models";

const plan = (name: string, email?: string) =>
	AccountStatus.parse({
		name,
		kind: "chatgpt-subscription",
		signIn: { state: "signed-in", ...(email ? { email } : {}) },
		limits: [],
		checkedAt: "2026-11-24T10:00:00Z",
	});
const names = (rows: { provider: string; name: string }[]) => rows.map(({ provider, name }) => `${provider} ${name}`);

// Why: one ChatGPT sign-in reached through two runtimes listed every model twice in the picker,
// and a chat or new-channel pick stored on the hidden account must still show as picked.
test("one sign-in's accounts list each model once, and a pick on a folded account shows on its row", () => {
	const models = [
		{ provider: "codex", modelId: "gpt-6.2-sol" },
		{ provider: "codex", modelId: "gpt-6.1-sol" },
		{ provider: "main", modelId: "gpt-6.2-sol" },
	];
	const accounts = [plan("codex", "alex@example.com"), plan("main")];
	const { rows, picked } = listed(models, "main/gpt-6.2-sol", accounts);
	expect(names(rows)).toEqual(["codex gpt-6.2-sol", "codex gpt-6.1-sol"]);
	expect(picked).toBe("codex/gpt-6.2-sol");
	expect(listed(models, "gone/gpt-6.1-sol", accounts).picked).toBe("codex/gpt-6.1-sol");
	expect(listed(models, "gone/gpt-1", accounts).picked).toBe("gone/gpt-1");
	expect(listed(models, "auto", accounts).picked).toBe("auto");
});

// Why: a person who really has two ChatGPT sign-ins, or an API key beside a plan, must still be
// able to pick either; folding them would bill or run on the one they did not choose.
test("a model on two sign-ins, or on an API key and a plan, is listed for each, named with its provider", () => {
	const models = [
		{ provider: "openai", modelId: "m" },
		{ provider: "codex", modelId: "m" },
		{ provider: "chatgpt", modelId: "m" },
		{ provider: "work", modelId: "m" },
	];
	const accounts = [plan("codex"), plan("chatgpt", "alex@example.com"), plan("work", "sam@example.com")];
	const { rows, picked } = listed(models, "work/m", accounts);
	expect(names(rows)).toEqual(["openai m · openai", "codex m · codex", "work m · work"]);
	expect(picked).toBe("work/m");
	expect(listed(models, "chatgpt/m", accounts).picked).toBe("codex/m");
});
