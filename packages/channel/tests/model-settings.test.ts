import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { type Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";

import { EventSchema } from "../src/frame";
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

async function setup() {
	let harness: Harness | undefined;
	const run = await Fixture.create({
		feed: async value => { harness = value; return { close: async () => {}, pending: () => false }; },
	});
	fixture = run;
	const channel = harness!;
	const main = await channel.conversation(ROOT_CONVERSATION_ID, context);
	if (!main) throw new Error("Missing main chat");
	await run.request({ op: "select", author: OWNER, ...unchanged });
	return { run, main, watch: await run.watch() };
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

// Pi starts the next run from its own queue after the current run ends.
for (const lost of [false, true]) test(`a queued review wake applies a pending model${lost ? " with lost-key fallback" : ""}`, async () => {
	const { run, main, watch } = await setup();
	const other = offer(run, alternate.provider, alternate.modelId, 900);
	other.appendResponses([fauxAssistantMessage("Next run used the pending model")]);
	const blocked = blockTurn(run);
	run.script(blocked.step, fauxAssistantMessage("Next run used the fallback model"));
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
		const wake = await main.submit({ type: "input", content: "The review finished.", whenBusy: "followUp",
			requestId: "neuve.review:test:terminal:host-wake" }, context);
		expect((await wake.status(context)).status).toBe("queued");
		if (lost) run.scripted.models.deleteProvider(alternate.provider);
		blocked.release();
		expect(await run.request({ op: "wait", submission: first.submission })).toBe("done");
		expect((await wake.wait(context)).status).toBe("done");
		const text = lost ? "Next run used the fallback model" : "Next run used the pending model";
		expect(await watch.until("reply", event => event.text === text)).toMatchObject({ model: lost ? MODEL.modelId : alternate.modelId });
		const final = await watch.until("agent", event => !event.pending && event.effort === "high");
		expect(final).toMatchObject({ model: lost ? MODEL : alternate, effort: "high" });
		expect(final.pending).toBeUndefined();
		expect((await run.channel.info()).chats[0]?.pending).toBeUndefined();
	} finally { blocked.release(); }
});

// A refusal must leave the owner with the same model and effort after the tool finishes.
const refusals = [
	{ name: "a model outside the owner's words", text: "Use coder", args: { model: alternate } },
	{ name: "a name that matches no model", text: "Use the big model", args: { model: alternate } },
	{ name: "a name shared by two accounts", text: "Use job-model", args: { model: alternate }, duplicate: true },
	{ name: "an effort outside the owner's words", text: "Use high effort", args: { effort: "low" } },
] as const;
for (const { name, text, args, ...options } of refusals) test(`the tool refuses ${name}`, async () => {
	const { run, watch } = await setup();
	offer(run);
	if ("duplicate" in options) offer(run, "other-account");
	run.script(callModelTool("model", args), fauxAssistantMessage("Please choose an available model."));
	await run.request({ op: "ask", author: OWNER, text });
	expect(await watch.until("result", event => event.call === "model")).toMatchObject({ error: true });
	expect((await run.channel.info()).chats[0]).toMatchObject(unchanged);
	expect((await run.channel.info()).chats[0]?.pending).toBeUndefined();
});

// An admitted steer changes who can authorize the tool, even when Pi has yet to place that input.
for (const author of [OWNER, teammate, "agent@reviewer", "host", "teammate posting in the thread"] as const) test(`a busy chat receives a later input from ${author}`, async () => {
	const { run, main, watch } = await setup();
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
			await main.submit({ type: "input", whenBusy: "steer", content: "owner: Use job-model" }, context);
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
	const { run, main, watch } = await setup();
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
	const next = await main.submit({ type: "input", content: "Continue" }, context);
	expect((await next.wait(context)).status).toBe("done");
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
