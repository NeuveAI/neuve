import { afterEach, expect, test } from "bun:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { CompactionEntry, type Conversation } from "@earendil-works/pi-durable";
import type { ChatMode } from "../src/protocol";
import { Fixture, MODEL, OWNER, git } from "./helpers";

let fixture: Fixture | undefined;
afterEach(async () => { await fixture?.dispose(); fixture = undefined; });

async function ask(mode?: ChatMode) {
	const { submission } = await fixture!.request<{ submission: number }>({ op: "ask", author: OWNER, text: "Where do you run?", model: MODEL, mode });
	expect(await fixture!.request({ op: "wait", submission })).toBe("done");
}

const hostEnvironment = {
	host: "fixture-host",
	version: "captured-version",
	release: false,
	commit: "captured-build",
	neuve: { path: "/host/bin/neuve", version: "neuve 0.3.10" },
	async readBranch(folder: string) {
		return git(folder, "branch", "--show-current").trim() || "detached HEAD";
	},
};

// Observe the actual provider-facing offer and prompt, not only extension installation.
test("desktop selection follows host availability and channel settings on existing channels", async () => {
	let available = false;
	let root: Conversation | undefined;
	fixture = await Fixture.create({ desktop: async () => ({ text: "ok" }), desktopAvailable: () => available,
		browser: async () => ({ text: "browser" }),
		extension: { extensions: [], async attach(harness) { root = await harness.root(BACKGROUND_CONTEXT); } },
	});
	const observe = (enabled: boolean) => {
		fixture!.script(request => {
			const tools = getCurrentTools(request.messages).map(tool => tool.name);
			expect(tools.includes("desktop_apps")).toBe(enabled);
			expect(tools).toContain("browser_tabs");
			expect(getCurrentSystemPrompt(request.messages).includes("<ace-desktop>")).toBe(enabled);
			return fauxAssistantMessage("observed");
		});
	};
	await fixture.request({ op: "desktop", author: OWNER, enabled: true });
	observe(false); await ask();
	available = true;
	observe(true); await ask();
	if (!root) throw new Error("Missing root chat");
	const agent = await root.agent(BACKGROUND_CONTEXT);
	await root.configure({ extensions: agent.extensions }, BACKGROUND_CONTEXT);
	const entry = (await root.context(BACKGROUND_CONTEXT)).entries.at(-1);
	if (!entry) throw new Error("Missing root reply");
	const child = await root.fork(entry.id, { ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
	available = false;
	observe(false);
	const submission = await child.submit({ type: "input", content: "What can you observe?" }, BACKGROUND_CONTEXT);
	expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe("done");
	available = true;
	await fixture.request({ op: "desktop", author: OWNER, enabled: false });
	observe(false); await ask();
	await fixture.request({ op: "desktop", author: OWNER, enabled: true });
	await fixture.restart();
	observe(true); await ask();
	available = false;
	observe(false); await ask();
});

test("desktop dispatch still checks settings after the model's offer", async () => {
	let dispatched = 0;
	fixture = await Fixture.create({ desktop: async () => { dispatched++; return { text: "ok" }; } });
	await fixture.request({ op: "desktop", author: OWNER, enabled: true });
	fixture.script(async request => {
		expect(getCurrentTools(request.messages).map(tool => tool.name)).toContain("desktop_apps");
		await fixture!.request({ op: "desktop", author: OWNER, enabled: false });
		return fauxAssistantMessage([fauxToolCall("desktop_apps", {}, { id: "late" })], { stopReason: "toolUse" });
	}, request => {
		expect(getCurrentTools(request.messages).map(tool => tool.name)).not.toContain("desktop_apps");
		expect(getCurrentSystemPrompt(request.messages)).not.toContain("<ace-desktop>");
		return fauxAssistantMessage("done");
	});
	await ask();
	expect(dispatched).toBe(0);
});

test("main chat reports host facts on its lane and on the project checkout without a shell", async () => {
	let chat: Conversation | undefined;
	fixture = await Fixture.create({
		hostEnvironment,
		extension: { extensions: [], async attach(harness) { chat = await harness.root(BACKGROUND_CONTEXT); } },
	});
	fixture.script(request => {
		const prompt = getCurrentSystemPrompt(request.messages);
		expect(prompt).toContain("version captured-version (source run), commit captured-build");
		expect(prompt).toContain("Installed neuve and its version: /host/bin/neuve (neuve 0.3.10)");
		expect(prompt).toContain("Role: main chat");
		expect(prompt).toContain("Model: coder. Effort: off. Context used: unknown. Context limit: 200,000 tokens.");
		expect(prompt).toContain("Git branch: one/work");
		expect(prompt).toContain("Work lane: work");
		expect(prompt).toContain("Runtime shell: available (Ace's bash tool)");
		return fauxAssistantMessage("observed");
	});
	await ask();
	git(fixture.lane.path, "checkout", "--detach");
	if (!chat) throw new Error("Missing root chat");
	await chat.configure({ tools: [] }, BACKGROUND_CONTEXT);
	fixture.script(request => {
		const prompt = getCurrentSystemPrompt(request.messages);
		expect(prompt).toContain("Git branch: detached HEAD");
		expect(prompt).toContain("Context used: 0–10% of 200,000 tokens.");
		expect(prompt).toContain("commit captured-build");
		expect(prompt).toContain("Runtime shell: unavailable");
		return fauxAssistantMessage("observed");
	});
	await ask();
	await chat.configure({ cwd: fixture.project }, BACKGROUND_CONTEXT);
	fixture.script(request => {
		const prompt = getCurrentSystemPrompt(request.messages);
		expect(prompt).toContain("Role: main chat");
		expect(prompt).toContain(`Working folder: ${fixture!.project}. Git branch: main.`);
		expect(prompt).toContain("Runtime shell: unavailable");
		expect(prompt).toContain("version captured-version (source run), commit captured-build");
		expect(prompt).toContain("Installed neuve and its version: /host/bin/neuve (neuve 0.3.10)");
		return fauxAssistantMessage("observed");
	});
	await ask();
	expect(fixture.envs.has(fixture.project)).toBe(false);
});

test("requests in the same context tenth share the environment section", async () => {
	fixture = await Fixture.create({ hostEnvironment });
	const prompts: string[] = [];
	// Each request uses the preceding response's reported context usage.
	for (const tokens of [85_000, 95_000, 105_000, 110_000]) {
		fixture.script(request => {
			prompts.push(getCurrentSystemPrompt(request.messages));
			return {
				...fauxAssistantMessage("observed"),
				diagnostics: [{ type: "neuve.context-usage", timestamp: 1, details: { tokens } }],
			};
		});
		await ask();
	}
	expect(prompts[1]).toContain("Context used: 40–50% of 200,000 tokens.");
	expect(prompts[2]).toBe(prompts[1]);
	expect(prompts[3]).toContain("Context used: 50–60% of 200,000 tokens.");
});

test("the channel compacts at the selected model's threshold and records completed turns after it", async () => {
	const provider = fauxProvider({
		provider: MODEL.provider,
		models: [{ id: MODEL.modelId, contextWindow: 120_000 }],
		tokensPerSecond: 100_000,
	});
	const models = createModels();
	models.setProvider(provider.provider);
	let root: Conversation | undefined;
	fixture = await Fixture.create({ models, extension: {
		extensions: [],
		async attach(harness) { root = await harness.root(BACKGROUND_CONTEXT); },
	} });
	if (!root) throw new Error("Missing root chat");
	await root.configure({ model: MODEL }, BACKGROUND_CONTEXT);
	provider.setResponses(["First", "Second", "Summary", "Continued", "Later"].map(text => fauxAssistantMessage(text)));
	for (const text of ["Earlier text ".repeat(6_000), "Middle text ".repeat(10_000), "Latest text ".repeat(18_667), "Continue"]) {
		const submission = await root.submit({ type: "input", content: text }, BACKGROUND_CONTEXT);
		expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe("done");
	}
	const { items } = await root.entries({}, 30, undefined, BACKGROUND_CONTEXT);
	const compacted = items.find(CompactionEntry.is);
	expect(compacted?.data.reason).toBe("threshold");
	expect(compacted?.model?.[0]).toMatchObject({
		role: "user",
		content: [{ type: "text", text: expect.stringContaining("Summary") }],
	});
	const after = items.filter(entry => entry.id > (compacted?.id ?? Infinity));
	expect(after.flatMap(entry => entry.model ?? []).flatMap(message =>
		message.role === "assistant" ? message.content.flatMap(part => part.type === "text" ? [part.text] : []) : [],
	)).toEqual(["Later", "Continued"]);
	expect(fixture.log).toContainEqual({ level: "info", event: "chat.compacted", fields: { channel: "one", chat: root.id, reason: "threshold" } });
});

test("a runtime's own shell uses its working folder even without Ace's environment", async () => {
	let chat: Conversation | undefined;
	fixture = await Fixture.create({ hostEnvironment: { ...hostEnvironment, release: true }, ownTools: provider => provider === MODEL.provider, extension: {
		extensions: [],
		async attach(harness) { chat = await harness.root(BACKGROUND_CONTEXT); },
	} });
	if (!chat) throw new Error("Missing root chat");
	await chat.configure({ tools: [] }, BACKGROUND_CONTEXT);
	fixture.script(request => {
		const prompt = getCurrentSystemPrompt(request.messages);
		expect(prompt).toContain("Runtime shell: available (runtime's own shell)");
		expect(prompt).toContain("Git branch: one/work");
		return fauxAssistantMessage("observed");
	});
	await ask();
	await chat.configure({ cwd: fixture.project }, BACKGROUND_CONTEXT);
	fixture.script(request => {
		const prompt = getCurrentSystemPrompt(request.messages);
		expect(prompt).toContain(`Working folder: ${fixture!.project}. Git branch: main.`);
		expect(prompt).toContain("Runtime shell: available (runtime's own shell)");
		expect(prompt).toContain("version captured-version (release build), commit captured-build");
		expect(prompt).toContain("Installed neuve and its version: /host/bin/neuve (neuve 0.3.10)");
		return fauxAssistantMessage("observed");
	});
	await ask();
	fixture.script(request => {
		const prompt = getCurrentSystemPrompt(request.messages);
		expect(prompt).toContain("Runtime shell: available (runtime's own shell, read-only in Plan mode)");
		expect(prompt).toContain("Git branch: main");
		return fauxAssistantMessage("observed");
	});
	await ask("plan");
});

test("environment context reports a missing host neuve for each role", async () => {
	const { environment } = await import("../src/environment");
	for (const role of ["main chat", "implementer", "reviewer"]) {
		const section = environment({
			...hostEnvironment,
			neuve: undefined,
			readBranch: async () => "role-branch",
		}, () => role, async () => false);
		const text = await section.render({ conversationId: 1, agent: { cwd: "/no-lane", tools: [] },
			env: undefined, read: { snapshot: async () => undefined } } as never, {} as never);
		expect(text).toContain(`Role: ${role}`);
		expect(text).toContain("Working folder: /no-lane. Git branch: role-branch.");
		expect(text).toContain("Work lane: none recorded");
		expect(text).toContain("Runtime shell: unavailable");
		expect(text).toContain("Installed neuve and its version: not found on the host's PATH");
	}
});
