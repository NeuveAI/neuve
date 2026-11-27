import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { type Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { AccountStatus } from "@neuve/runtime/status";

import { EventSchema } from "../src/frame";
import type { Channel } from "../src/channel";
import type { Request } from "../src/protocol";
import { Fixture, MODEL, OWNER, until } from "./helpers";

let fixture: Fixture | undefined;
afterEach(async () => { await fixture?.dispose(); fixture = undefined; });

const alternate = { provider: "another", modelId: "job-model" };
const unchanged = { model: MODEL, effort: "medium" };

function offer(fixture: Fixture, provider = alternate.provider, id = alternate.modelId, window = 100_000) {
	const handle = fauxProvider({
		provider, models: [{ id, reasoning: true, contextWindow: window }], tokensPerSecond: 100_000,
	});
	fixture.scripted.models.setProvider(handle.provider);
	return handle;
}

async function setup(accounts: readonly AccountStatus[] = []) {
	let harness: Harness | undefined;
	let submitInput: Channel["submitInput"] | undefined;
	const run = await Fixture.create({
		accountStatuses: () => accounts,
		feed: async (value, submit) => {
			harness = value;
			submitInput = submit;
			return { close: async () => {}, pending: () => false };
		},
	});
	fixture = run;
	const channel = harness!;
	const main = await channel.conversation(ROOT_CONVERSATION_ID, context);
	if (!main || !submitInput) throw new Error("Missing main chat or host admission");
	await run.request({ op: "select", author: OWNER, ...unchanged });
	return { run, main, submitInput, watch: await run.watch() };
}

const callModelTool = (id: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall("set_agent_model", { role: "main", ...args }, { id }), { stopReason: "toolUse" });

function blockTurn(run: Fixture) {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	return {
		entered: entered.promise,
		release: release.resolve,
		step: async () => {
			entered.resolve();
			await release.promise;
			return fauxAssistantMessage("First run finished");
		},
	};
}

const teammate = "teammate";
const unauthorized: Request[] = [
	{ op: "select", author: teammate, model: alternate },
	{ op: "ask", author: teammate, text: "change", model: alternate },
	{ op: "ask", author: teammate, text: "change", effort: "high" },
	{ op: "ask", author: teammate, text: "change", automatic: true },
	{ op: "ask", author: teammate, text: "change", automatic: false },
	{ op: "chat", author: teammate, model: alternate },
];

// A shared channel permits ordinary teammate input, so the model checks must run at each write route.
test("a teammate's model fields are refused without changing any chat", async () => {
	const { run, watch } = await setup();
	offer(run);
	await run.request({ op: "share", author: OWNER, shared: true });
	for (const request of unauthorized) {
		await expect(run.request(request)).rejects.toThrow("Only the channel's owner can change an agent's model.");
	}
	expect((await run.channel.info()).chats).toMatchObject([{ ...unchanged, busy: false }]);
	expect(watch.of("message")).toEqual([]);
	expect(run.faux.state.callCount).toBe(0);
});

// Pi drains queued follow-ups itself, so a busy wake cannot apply pending settings at that boundary.
for (const lost of [false, true]) test(`a queued review wake keeps the old settings until a channel input arrives while idle${lost ? " with lost-key fallback" : ""}`, async () => {
	const { run, main, submitInput, watch } = await setup();
	const other = offer(run, alternate.provider, alternate.modelId, 900);
	other.appendResponses([fauxAssistantMessage("Next run used the pending model")]);
	const blocked = blockTurn(run);
	run.script(blocked.step, fauxAssistantMessage("Queued wake used the running model"), fauxAssistantMessage("Next run used the fallback model"));
	try {
		const first = await run.request<{ submission: number }>({ op: "ask", author: OWNER, text: "start" });
		await blocked.entered;
		const selection = await run.request({ op: "select", author: OWNER, model: alternate, effort: "high" });
		const pending = { model: alternate, effort: "high" };
		expect(selection).toEqual({ ...unchanged, pending });
		expect(EventSchema.parse(await watch.until("agent", event => !!event.pending))).toMatchObject({ ...unchanged, pending });
		expect((await run.channel.info()).chats[0]).toMatchObject({ ...unchanged, pending });
		await expect(run.request({ op: "say", author: OWNER, text: "file", files: [{ name: "large.txt", text: "x".repeat(2800) }] }))
			.rejects.toThrow("Attach a smaller file");
		await expect(run.request({ op: "ask", author: OWNER, text: "file", files: [{ name: "large.txt", text: "x".repeat(2800) }] }))
			.rejects.toThrow("Attach a smaller file");
		const wake = await submitInput(main, { type: "input", content: "The review finished.", whenBusy: "followUp",
			requestId: "neuve.review:test:terminal:host-wake" }, context);
		expect((await wake.status(context)).status).toBe("queued");
		blocked.release();
		expect(await run.request({ op: "wait", submission: first.submission })).toBe("done");
		expect((await wake.wait(context)).status).toBe("done");
		expect(await watch.until("reply", event => event.text === "Queued wake used the running model")).toMatchObject({ model: MODEL.modelId });
		expect((await run.channel.info()).chats[0]).toMatchObject({ ...unchanged, pending });
		if (lost) run.scripted.models.deleteProvider(alternate.provider);
		const next = await submitInput(main, { type: "input", content: "A second review finished.",
			requestId: "neuve.review:next:terminal:host-wake" }, context);
		expect((await next.wait(context)).status).toBe("done");
		const text = lost ? "Next run used the fallback model" : "Next run used the pending model";
		expect(await watch.until("reply", event => event.text === text)).toMatchObject({ model: lost ? MODEL.modelId : alternate.modelId });
		const final = await watch.until("agent", event => !event.pending && event.effort === "high");
		expect(final).toMatchObject({ model: lost ? MODEL : alternate, effort: "high" });
		expect(final.pending).toBeUndefined();
		expect((await run.channel.info()).chats[0]?.pending).toBeUndefined();
	} finally { blocked.release(); }
});

// The live ask must resolve to one offered route before an agent can retry a refused call.
test("the plain Opus ask has one match in the lane model list", async () => {
	const { run, watch } = await setup([
		account("claude", "claude-subscription"),
		account("codex", "chatgpt-subscription"),
		account("main", "chatgpt-subscription"),
	]);
	const catalogue = await Bun.file(new URL("fixtures/plain-ask-lane-models.txt", import.meta.url)).text();
	const rows = catalogue.trim().split("\n").slice(1);
	for (const [provider, models] of Map.groupBy(rows, row => row.slice(0, row.indexOf("/")))) {
		run.scripted.models.setProvider(fauxProvider({
			provider, models: models.map(row => ({ id: row.slice(provider.length + 1), reasoning: true })),
		}).provider);
	}
	const opus = { provider: "claude", modelId: "opus" };
	run.script(
		callModelTool("wrong-route", { model: { provider: "anthropic", modelId: "claude-opus-4-6" } }),
		callModelTool("retry", { model: opus }),
		fauxAssistantMessage("Done."),
	);
	await run.request({ op: "ask", author: OWNER, text: "move the frontend implementer to Opus" });
	const refusal = await watch.until("result", event => event.call === "wrong-route");
	expect(await watch.until("result", event => event.call === "retry")).toMatchObject({
		error: false, text: "claude/opus, effort medium, pending until an input is sent while idle.",
	});
	expect((await run.channel.info()).chats[0]?.pending).toEqual({ model: opus });
	expect(refusal).toMatchObject({
		error: true, text: "The owner's latest message matches claude/opus and no available effort.",
	});
});

// The tool must tell the caller what matched so it can retry, without changing either setting on refusal.
const refusals = [
	{ name: "a model outside the owner's words", text: "Use coder", args: { model: alternate }, matches: "faux/coder and no available effort" },
	{ name: "a name that matches no model", text: "Use the big model", args: { model: alternate }, matches: "no available model and no available effort" },
	{ name: "a name shared by two accounts", text: "Use job-model", args: { model: alternate }, duplicate: true,
		matches: "another/job-model, other-account/job-model and no available effort" },
	{ name: "an effort outside the owner's words", text: "Use high effort", args: { effort: "low" }, matches: "no available model and effort high" },
	{ name: "two named effort levels", text: "Use low or high effort", args: { effort: "high" }, matches: "no available model and effort low, high" },
] as const;
for (const { name, text, args, matches, ...options } of refusals) test(`the tool refuses ${name}`, async () => {
	const { run, watch } = await setup();
	offer(run);
	if ("duplicate" in options) offer(run, "other-account");
	run.script(callModelTool("model", args), fauxAssistantMessage("Please choose an available model."));
	await run.request({ op: "ask", author: OWNER, text });
	expect(await watch.until("result", event => event.call === "model")).toMatchObject({
		error: true, text: expect.stringContaining(`The owner's latest message matches ${matches}.`),
	});
	expect((await run.channel.info()).chats[0]).toMatchObject(unchanged);
	expect((await run.channel.info()).chats[0]?.pending).toBeUndefined();
});

const terra = { provider: "codex", modelId: "gpt-6.1-terra" };
const account = (name: string, kind: AccountStatus["kind"], email?: string) => AccountStatus.parse({
	name, kind, signIn: { state: "signed-in", ...(email ? { email } : {}) },
	limits: [], checkedAt: "2026-11-27T00:00:00Z",
});

// The catalogue shows both routes, but the owner's words must select the route the picker shows.
for (const [name, text, provider] of [
	["unqualified", "Run it on gpt-6.1-terra, high effort.", "codex"],
	["with ChatGPT named", "Use ChatGPT gpt-6.1-terra with high effort.", "main"],
] as const) test(`one subscription model matches once ${name}`, async () => {
	const { run, watch } = await setup([
		account("codex", "chatgpt-subscription", "owner@example.com"),
		account("main", "chatgpt-subscription"),
	]);
	offer(run, "codex", terra.modelId);
	offer(run, "main", terra.modelId);
	run.script(callModelTool("model", { model: { ...terra, provider }, effort: "high" }), fauxAssistantMessage("Done."));
	await run.request({ op: "ask", author: OWNER, text });
	expect(await watch.until("result", event => event.call === "model")).toMatchObject({
		error: false, text: "codex/gpt-6.1-terra, effort high, pending until an input is sent while idle.",
	});
	expect((await run.channel.info()).chats[0]?.pending).toEqual({ model: terra, effort: "high" });
});

// The owner must choose an account when the picker offers separate rows for the same model.
for (const [name, second] of [
	["an API key", account("other-account", "openai-api-key")],
	["a different subscription email", account("other-account", "chatgpt-subscription", "work@example.com")],
] as const) test(`a subscription model shared with ${name} needs an account qualifier`, async () => {
	const { run, watch } = await setup([
		account("codex", "chatgpt-subscription", "owner@example.com"),
		second,
	]);
	offer(run, "codex", terra.modelId);
	offer(run, second.name, terra.modelId);
	const model = { provider: second.name, modelId: terra.modelId };
	run.script(callModelTool("ambiguous", { model }), fauxAssistantMessage("Which account?"),
		callModelTool("qualified", { model }), fauxAssistantMessage("Done."));
	const { submission } = await run.request<{ submission: number }>({ op: "ask", author: OWNER, text: "Use gpt-6.1-terra." });
	expect(await watch.until("result", event => event.call === "ambiguous")).toMatchObject({ error: true });
	expect((await run.channel.info()).chats[0]).toMatchObject(unchanged);
	expect((await run.channel.info()).chats[0]?.pending).toBeUndefined();
	expect(await run.request({ op: "wait", submission })).toBe("done");
	await run.request({ op: "ask", author: OWNER, text: "Use gpt-6.1-terra from other-account." });
	expect(await watch.until("result", event => event.call === "qualified")).toMatchObject({ error: false });
	expect((await run.channel.info()).chats[0]?.pending?.model).toEqual(model);
});

// An admitted steer changes who can authorize the tool, even when Pi has yet to place that input.
for (const author of [OWNER, teammate, "agent@reviewer", "host", "teammate posting in the thread"] as const) test(`a busy chat receives a later input from ${author}`, async () => {
	const { run, main, submitInput, watch } = await setup();
	offer(run);
	await run.request({ op: "share", author: OWNER, shared: true });
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	run.script(async () => {
		entered.resolve();
		await release.promise;
		return callModelTool("model", { model: alternate });
	}, fauxAssistantMessage("Done"));
	try {
		await run.request({ op: "ask", author: OWNER, text: author === OWNER ? "Start" : "Use job-model" });
		await entered.promise;
		if (author === "host") {
			await submitInput(main, { type: "input", whenBusy: "steer", content: "owner: Use job-model" }, context);
		} else if (author === "teammate posting in the thread") {
			await run.request({ op: "say", author: teammate, text: "Use job-model" });
		} else {
			await run.request({ op: "ask", author, text: "Use job-model" });
		}
		release.resolve();
		expect(await watch.until("result", event => event.call === "model")).toMatchObject({ error: author !== OWNER });
		const selection = (await run.channel.info()).chats[0]!;
		expect(selection).toMatchObject(unchanged);
		expect(selection.pending).toEqual(author === OWNER ? { model: alternate } : undefined);
	} finally { release.resolve(); }
});

// The tool may change just the named setting. Account qualification admits a duplicate model name.
for (const setting of ["model", "effort"] as const) test(`a named ${setting} leaves the other setting in place`, async () => {
	const { run, watch } = await setup();
	const other = offer(run);
	other.appendResponses([fauxAssistantMessage("Changed")]);
	offer(run, "other-account");
	const change = setting === "model" ? { model: alternate } : { effort: "high" };
	run.script(callModelTool("model", change), fauxAssistantMessage("Done"), fauxAssistantMessage("Changed"));
	const { submission } = await run.request<{ submission: number }>({ op: "ask", author: OWNER,
		text: setting === "model" ? "Use job-model from another" : "Use high effort" });
	expect(await watch.until("result", event => event.call === "model")).toMatchObject({ error: false });
	expect((await run.channel.info()).chats[0]?.pending).toEqual(change);
	expect(await run.request({ op: "wait", submission })).toBe("done");
	const next = await run.request<{ submission: number }>({ op: "ask", author: OWNER, text: "Continue" });
	expect(await run.request({ op: "wait", submission: next.submission })).toBe("done");
	expect((await run.channel.info()).chats[0]).toMatchObject({ ...unchanged, ...change });
});

// The subagent tool accepts the model only when the channel can prove the owner named it.
for (const reason of ["named", "unnamed", "replaced"] as const) test(`a subagent's requested model is ${reason}`, async () => {
	const { run, watch } = await setup();
	const other = offer(run);
	other.appendResponses([fauxAssistantMessage("Alternate child")]);
	await run.request({ op: "share", author: OWNER, shared: true });
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	run.script(async () => {
		entered.resolve();
		await release.promise;
		return fauxAssistantMessage(fauxToolCall("subagent", { task: "Inspect", model: "another/job-model" }, { id: "child" }), { stopReason: "toolUse" });
	}, ...(reason === "named" ? [] : [fauxAssistantMessage("Inherited child")]), fauxAssistantMessage("Done"));
	try {
		await run.request({ op: "ask", author: OWNER, text: reason === "unnamed" ? "Delegate" : "Delegate using job-model" });
		await entered.promise;
		if (reason === "replaced") await run.request({ op: "ask", author: teammate, text: "Keep using job-model" });
		release.resolve();
		expect(await watch.until("result", event => event.call === "child")).toMatchObject({
			error: false, text: reason === "named" ? "Alternate child" : "Inherited child",
		});
		const info = await run.channel.info();
		expect(info.chats.find(chat => chat.parent === ROOT_CONVERSATION_ID)?.model).toEqual(reason === "named" ? alternate : MODEL);
	} finally { release.resolve(); }
});

// A plain teammate message can recover a chat whose stored account went away.
test("a lost model falls back when the next message is from a teammate", async () => {
	const { run, watch } = await setup();
	offer(run);
	await run.request({ op: "select", author: OWNER, model: alternate });
	await run.request({ op: "share", author: OWNER, shared: true });
	run.scripted.models.deleteProvider(alternate.provider);
	run.script(fauxAssistantMessage("Recovered"));
	await run.request({ op: "ask", author: teammate, text: "Continue" });
	expect(await watch.until("reply")).toMatchObject({ model: MODEL.modelId, text: "Recovered" });
	await until(() => run.channel.isIdle());
	expect((await run.channel.info()).chats[0]?.model).toEqual(MODEL);
});
