import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineExtension, GenerationTask, type Harness, hook, InboxDoc, LiveDoc, MemoryStorage, ROOT_CONVERSATION_ID, StorageRejected, type StorageWrite } from "@earendil-works/pi-durable";
import { Channel, type Options } from "../src/channel";
import { EventSchema } from "../src/frame";
import { parseRequest } from "../src/parse";
import { ChatModesDoc } from "../src/plan-mode";
import type { ChannelInfo, ChatMode, Event, Request } from "../src/protocol";
import { faux, Fixture, isolateClaudeConfig, MODEL, OWNER, scratch, scratchEnv, until } from "./helpers";

// Both composers send through this parser before admission.
test("an ask carries only a recognized chat mode through the parser", () => {
	for (const mode of ["plan", "ace"] satisfies ChatMode[]) {
		expect(parseRequest({ op: "ask", text: "Draft a plan", mode }, "member")).toEqual({
			op: "ask", author: "member", text: "Draft a plan", mode,
		});
	}
	expect(() => parseRequest({ op: "ask", text: "Draft a plan", mode: "write" }, "member")).toThrow("at mode");
});

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
isolateClaudeConfig();

async function memoryChannel(options: Partial<Options> = {}) {
	const root = await scratch();
	roots.push(root);
	const project = join(root, "checkout");
	await mkdir(project);
	const fake = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }, { id: "alternate" }], tokensPerSecond: 500 });
	const models = createModels();
	models.setProvider(fake.provider);
	const captions = faux().models;
	const channel = await Channel.open({
		id: "plan", name: "Plan", owner: OWNER, project, models,
		storage: new MemoryStorage(), model: MODEL, env: cwd => scratchEnv(cwd, root),
		directory: { self: { id: "plan", name: "Plan" }, list: async () => [], deliver: async () => {} },
		log: () => {},
		...options,
		// Captions and recaps now use the available model, so give them their own responses.
		extension: { extensions: [], ...options.extension, nonTurnModels: () => captions },
	});
	const request = (input: Request) => channel.handle(input, () => {});
	const ask = (fields: Pick<Extract<Request, { op: "ask" }>, "chat" | "mode" | "model" | "requestId"> = {}) =>
		request({ op: "ask", author: OWNER, text: "Inspect the repo", ...fields });
	const wait = async (receipt: unknown) => {
		if (!receipt || typeof receipt !== "object" || !("submission" in receipt) || typeof receipt.submission !== "number") {
			throw new Error("No submission was admitted");
		}
		return request({ op: "wait", submission: receipt.submission });
	};
	return { channel, fake, request, ask, wait };
}

// Listing the writer alone lets a planning agent deliver its plan as an ordinary reply.
test("only planning requests tell the agent to deliver a plan or revision with one standalone call", async () => {
	const run = await memoryChannel({ planFiles: { stage: async () => {}, read: async (_file, _hash, bytes) => bytes } });
	const prompts: string[] = [];
	const tools: string[][] = [];
	try {
		for (const mode of ["plan", "ace"] satisfies ChatMode[]) {
			run.fake.appendResponses([request => {
				prompts.push(getCurrentSystemPrompt(request.messages));
				tools.push(getCurrentTools(request.messages).map(tool => tool.name));
				return fauxAssistantMessage("Ready");
			}]);
			expect(await run.wait(await run.ask({ mode }))).toBe("done");
		}
		const instruction = "When ready, deliver the full plan or revision in one `plan_write` call on its own. That ends the turn.";
		expect(prompts[0]).toContain(instruction);
		expect(prompts[1]).not.toContain(instruction);
		expect(tools[0]).toContain("plan_write");
		expect(tools[1]).not.toContain("plan_write");
	} finally {
		await run.channel.close();
	}
});

// The Codex bridge reads this exact symbol on the model request. Hooks may copy the messages.
test("the channel sends the Codex planning marker after request hooks", async () => {
	let dropDecision = false;
	const run = await memoryChannel({
		extension: {
			extensions: [defineExtension({
				name: "copy-request-messages",
				hooks: [hook(GenerationTask, {
					beforeRequest: ({ messages }) => ({
						messages: structuredClone(dropDecision ? messages.slice(0, -1) : messages),
					}),
				})],
			})],
		},
	});
	try {
		const markers: boolean[] = [];
		for (const mode of ["ace", "plan", "ace"] satisfies ChatMode[]) {
			run.fake.appendResponses([request => {
				markers.push(request.messages.some(message =>
					message.role === "system" && Reflect.get(message, Symbol.for("neuve.chat.plan-request")) === true));
				return fauxAssistantMessage("Ready");
			}]);
			expect(await run.wait(await run.ask({ mode }))).toBe("done");
		}
		expect(markers).toEqual([false, true, false]);
		dropDecision = true;
		run.fake.appendResponses([fauxAssistantMessage("The model should not be called")]);
		expect(await run.wait(await run.ask({ mode: "plan" }))).toBe("unanswered");
		expect(run.fake.state.callCount).toBe(3);
	} finally {
		await run.channel.close();
	}
});

// Reject the batch containing the submission, where a separate mode commit used to leak through.
test("a rejected submission keeps the chat mode and lets the same request retry", async () => {
	class RefusingStorage extends MemoryStorage {
		refuse = true;
		override commit(writes: readonly StorageWrite[], context: Context) {
			if (this.refuse && writes.some(write => write.type === "submission")) {
				throw new StorageRejected("Fixture rejected submission");
			}
			return super.commit(writes, context);
		}
	}
	const storage = new RefusingStorage();
	const run = await memoryChannel({ storage });
	try {
		const ask = { mode: "plan" as const, requestId: "mode-change", model: { ...MODEL, modelId: "alternate" } };
		await expect(run.ask(ask)).rejects.toThrow("Fixture rejected submission");
		expect((await run.channel.info()).chats[0]).toMatchObject({ mode: "ace", busy: false, model: MODEL });
		storage.refuse = false;
		run.fake.appendResponses([fauxAssistantMessage("Ready")]);
		expect(await run.wait(await run.ask(ask))).toBe("done");
		expect((await run.channel.info()).chats[0]).toMatchObject({ mode: "plan", model: ask.model });
	} finally {
		await run.channel.close();
	}
});

test("file policy waits for a refused mode change to roll back", async () => {
	let harness: Harness | undefined;
	const access = Promise.withResolvers<(context: Context) => Promise<boolean>>();
	const paused = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const run = await memoryChannel({
		feed: async value => { harness = value; return { close: async () => {}, pending: () => false }; },
		planFileAccess: (env, planning) => { access.resolve(planning); return env; },
	});
	try {
		run.fake.appendResponses([fauxAssistantMessage("Planning")]);
		expect(await run.wait(await run.ask({ mode: "plan" }))).toBe("done");
		const conversation = await harness?.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
		if (!harness || !conversation) throw new Error("Missing fixture conversation");
		const readMode = await access.promise;
		const selectConversation = spyOn(harness, "conversation").mockResolvedValue(conversation);
		const submit = spyOn(conversation, "submit").mockImplementation(async () => {
			paused.resolve();
			await release.promise;
			throw new StorageRejected("Fixture refused the ask");
		});
		try {
			const refused = run.ask({ mode: "ace" }).catch((error: unknown) => error);
			await paused.promise;
			const policy = readMode(BACKGROUND_CONTEXT);
			// This transaction runs after the policy read's first lookup and before admission settles.
			const staged = await harness.commit(async tx =>
				(await tx.doc(ChatModesDoc)).chats[ROOT_CONVERSATION_ID], BACKGROUND_CONTEXT);
			expect(staged).toBe("ace");
			expect(await Promise.race([policy, Promise.resolve("waiting")])).toBe("waiting");
			release.resolve();
			expect(await refused).toMatchObject({ message: "Fixture refused the ask" });
			expect(await policy).toBe(true);
		} finally {
			release.resolve();
			submit.mockRestore();
			selectConversation.mockRestore();
		}
	} finally {
		await run.channel.close();
	}
});

// Pi may keep a queued passive write when an earlier run aborts. It still belongs before the ask.
test("a mode-changing ask admits previously queued work in order", async () => {
	let harness: Harness | undefined;
	const run = await memoryChannel({
		feed: async value => { harness = value; return { close: async () => {}, pending: () => false }; },
	});
	try {
		if (!harness) throw new Error("Missing fixture harness");
		const chat = ROOT_CONVERSATION_ID;
		await harness.commit(async tx => {
			const inbox = await tx.doc(InboxDoc, chat);
			const olderInput = await tx.createSubmission({ conversationId: chat, type: "input", status: "queued" });
			inbox.items.push({ id: olderInput.id, mode: "followUp", content: "Earlier input" });
			const passive = await tx.createSubmission({ conversationId: chat, type: "write", status: "queued" });
			inbox.items.push({
				id: passive.id, mode: "write",
				entry: { kind: "fixture.write", model: [{ role: "user", content: "Passive write", timestamp: 1 }] },
			});
		}, BACKGROUND_CONTEXT);
		let inputs: unknown[] = [];
		run.fake.appendResponses([request => {
			inputs = request.messages.flatMap(message => message.role === "user" ? [message.content] : []);
			return fauxAssistantMessage("Ready");
		}]);
		expect(await run.wait(await run.ask({ mode: "plan" }))).toBe("done");
		expect(inputs).toEqual(["Passive write", "Earlier input", "owner: Inspect the repo"]);
	} finally {
		await run.channel.close();
	}
});

// A child can receive its own message after the parent run that created it is over.
test("a busy child blocks an idle parent's mode change", async () => {
	const run = await memoryChannel();
	const started = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	try {
		run.fake.appendResponses([
			fauxAssistantMessage(fauxToolCall("subagent", { task: "Read the repo" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Child ready"), fauxAssistantMessage("Parent ready"),
		]);
		expect(await run.wait(await run.ask())).toBe("done");
		const child = (await run.channel.info()).chats.find(chat => chat.parent === ROOT_CONVERSATION_ID);
		if (!child) throw new Error("No child chat was created");
		run.fake.appendResponses([async () => {
			started.resolve();
			await finish.promise;
			return fauxAssistantMessage("Child finished");
		}]);
		const receipt = await run.ask({ chat: child.id });
		await started.promise;
		const parent = (await run.channel.info()).chats.find(chat => chat.id === ROOT_CONVERSATION_ID);
		expect(parent).toMatchObject({ busy: false, mode: "ace" });
		await expect(run.ask({ mode: "plan" })).rejects.toThrow("a chat it started is busy");
		expect((await run.channel.info()).chats.find(chat => chat.id === ROOT_CONVERSATION_ID)?.mode).toBe("ace");
		finish.resolve();
		expect(await run.wait(receipt)).toBe("done");
	} finally {
		finish.resolve();
		await run.channel.close();
	}
});

// Wait for pi's persisted partial, then stop before it can write a final reply.
test("a stopped partial reply keeps the mode it ran in", async () => {
	let harness: Harness | undefined;
	const run = await memoryChannel({
		feed: async value => { harness = value; return { close: async () => {}, pending: () => false }; },
	});
	try {
		const events: Event[] = [];
		await run.channel.handle({ op: "watch" }, event => events.push(event));
		run.fake.appendResponses([fauxAssistantMessage("Draft ".repeat(2_000))]);
		const receipt = await run.ask({ mode: "plan" });
		await until(async () => (await harness?.snapshot(LiveDoc, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT))?.generation?.message);
		await run.request({ op: "stop", author: OWNER });
		expect(await run.wait(receipt)).toBe("unanswered");
		const reply = await until(() => events.find(event => event.kind === "reply" && event.stopped));
		expect(EventSchema.parse(reply)).toMatchObject({ mode: "plan", stopped: true });

		run.fake.appendResponses([fauxAssistantMessage("Ready")]);
		expect(await run.wait(await run.ask({ mode: "ace" }))).toBe("done");
		const replay: Event[] = [];
		await run.channel.handle({ op: "watch" }, event => replay.push(event));
		expect(replay.find(event => event.kind === "reply" && event.stopped)).toMatchObject({ mode: "plan" });
	} finally {
		await run.channel.close();
	}
});

const question = (id: string) => fauxAssistantMessage(fauxToolCall("question", {
	questions: [{
		header: "Approach", question: "Which approach?",
		options: [{ label: "Small", description: "" }, { label: "Large", description: "" }],
		multiple: false,
	}],
}, { id }), { stopReason: "toolUse" });

// A question keeps the actual pi run busy while a person's second message crosses the same ingress.
test.each([OWNER, "teammate"])("%s can keep, but cannot switch, a busy chat's mode", async (author) => {
	const fixture = await Fixture.create();
	try {
		if (author !== OWNER) await fixture.request({ op: "share", author: OWNER, shared: true });
		const watch = await fixture.watch();
		try {
			for (const mode of ["ace", "plan"] satisfies Array<"ace" | "plan">) {
				const other = mode === "plan" ? "ace" : "plan";
				fixture.script(question(`choose-${mode}`), fauxAssistantMessage(`Answered in ${mode}`));
				const ask = { op: "ask", author, text: "Consider the approach", mode } satisfies
					Extract<Request, { op: "ask" }>;
				const switchMode = { ...ask, mode: other } satisfies Extract<Request, { op: "ask" }>;
				const { submission } = await fixture.request<{ submission: number }>({ ...ask, requestId: mode });
				await watch.until("tool", event => event.call === `choose-${mode}`);
				expect((await fixture.request<ChannelInfo>({ op: "info" })).chats[0]).toMatchObject({ mode, busy: true });
				await expect(fixture.request({ ...switchMode, requestId: mode })).rejects.toThrow("different message");
				await expect(fixture.request(switchMode)).rejects.toThrow("busy");
				await expect(fixture.request({ ...switchMode, author: "agent@other" })).rejects.toThrow("Only a person");
				const settingsEvents = watch.of("agent").length;
				await fixture.request({ ...ask, text: "Keep going in this mode" });
				expect(watch.of("agent")).toHaveLength(settingsEvents);
				expect(await fixture.request({ op: "wait", submission })).toBe("done");
				const reply = await watch.until("reply", event => event.text === `Answered in ${mode}`);
				expect(EventSchema.parse(reply)).toMatchObject({ mode, text: `Answered in ${mode}` });
				fixture.script(fauxAssistantMessage("Continued"));
				const next = await fixture.request<{ submission: number }>({ op: "ask", author, text: "Continue" });
				expect(await fixture.request({ op: "wait", submission: next.submission })).toBe("done");
				expect((await fixture.request<ChannelInfo>({ op: "info" })).chats[0]?.mode).toBe(mode);
			}
			expect(watch.of("agent").map(event => EventSchema.parse(event))).toContainEqual(
				expect.objectContaining({ mode: "plan" }),
			);
			await fixture.restart();
			expect((await fixture.request<ChannelInfo>({ op: "info" })).chats[0]?.mode).toBe("plan");
			const replay = await fixture.watch();
			expect(await replay.until("reply", event => event.text === "Answered in ace")).toMatchObject({ mode: "ace" });
			await replay.stop();
		} finally {
			await watch.stop();
		}
	} finally {
		await fixture.dispose();
	}
});

// The faux model deliberately asks for omitted tools. Its calls still reach pi's registered tools.
test("the plan tool guard refuses writes in the planning chat and its child", async () => {
	const fixture = await Fixture.create();
	const attempts = (prefix: string) => fauxAssistantMessage([
		fauxToolCall("bash", { command: "exit 0" }, { id: `${prefix}-bash` }),
		fauxToolCall("write", { path: "unexpected.txt", content: "unexpected" }, { id: `${prefix}-write` }),
		fauxToolCall("edit", { path: "README.md", edits: [{ oldText: "hello", newText: "unexpected" }] }, { id: `${prefix}-edit` }),
	], { stopReason: "toolUse" });
	try {
		fixture.script(
			fauxAssistantMessage(fauxToolCall("subagent", { task: "Read the repo" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Child ready"), fauxAssistantMessage("Parent ready"),
		);
		const normal = await fixture.request<{ submission: number }>({ op: "ask", author: OWNER, text: "Prepare a child chat" });
		expect(await fixture.request({ op: "wait", submission: normal.submission })).toBe("done");
		const child = (await fixture.request<ChannelInfo>({ op: "info" })).chats.find(chat => chat.parent === ROOT_CONVERSATION_ID);
		if (!child) throw new Error("The subagent did not create a child chat");
		const rootWatch = await fixture.watch();
		const childWatch = await fixture.watch({ op: "watch", chat: child.id });
		try {
			for (const [chat, watch, prefix] of [
				[ROOT_CONVERSATION_ID, rootWatch, "root"],
				[child.id, childWatch, "child"],
			] as const) {
				fixture.script(received => {
					const offered = getCurrentTools(received.messages).map(tool => tool.name);
					expect(offered).not.toContain("bash");
					expect(offered).toContain("read");
					return attempts(prefix);
				}, fauxAssistantMessage("All changes refused"));
				const { submission } = await fixture.request<{ submission: number }>({
					op: "ask", chat, author: OWNER, text: "Plan the changes",
					...(chat === ROOT_CONVERSATION_ID ? { mode: "plan" } : {}),
				});
				expect(await fixture.request({ op: "wait", submission })).toBe("done");
				for (const tool of ["bash", "write", "edit"]) {
					expect(await watch.until("result", e => e.call === `${prefix}-${tool}`)).toMatchObject({
						error: true, text: `Plan mode is read-only. The ${tool} tool is unavailable in plan mode.`,
					});
				}
			}
		} finally {
			await Promise.all([rootWatch.stop(), childWatch.stop()]);
		}
	} finally {
		await fixture.dispose();
	}
});

// The fixture puts a replay-safe call in pi's execute checkpoint before simulating recovery in plan mode.
test("pi recovery refuses a replay-safe lane call inside execute", async () => {
	let harness: Harness | undefined;
	const started = Promise.withResolvers<void>();
	const fixture = await Fixture.create({
		feed: async value => { harness = value; return { close: async () => {}, pending: () => false }; },
		tool: tool => tool.name === "lane" ? {
			...tool,
			async execute(_args, _api, context) {
				started.resolve();
				await new Promise<void>(resolve => context.abortSignal?.addEventListener("abort", () => resolve(), { once: true }));
				context.abortSignal?.throwIfAborted();
				return { content: [{ type: "text", text: "Lane tool ran" }] };
			},
		} : tool,
	});
	try {
		fixture.script(fauxAssistantMessage(fauxToolCall("lane", { action: "start", name: "test-lane" }, { id: "lane-replay" }), { stopReason: "toolUse" }));
		await fixture.request({ op: "ask", author: OWNER, text: "Start a lane" });
		await started.promise;
		if (!harness) throw new Error("Missing fixture harness");
		expect((await harness.snapshot(LiveDoc, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT))?.tools?.[0]?.status).toBe("running");
		await harness.commit(async tx => {
			(await tx.doc(ChatModesDoc)).chats[ROOT_CONVERSATION_ID] = "plan";
		}, BACKGROUND_CONTEXT);
		fixture.script(fauxAssistantMessage("Recovered without a lane"));
		await fixture.restart();
		const watch = await fixture.watch();
		try {
			expect(await watch.until("result", e => e.call === "lane-replay")).toMatchObject({
				error: true, text: "Plan mode is read-only. The lane tool is unavailable in plan mode.",
			});
			expect(await watch.until("reply", e => e.text === "Recovered without a lane")).toMatchObject({ mode: "plan" });
			expect(fixture.log.filter(line => line.event === "plan.tool.refused").map(line => line.fields?.tool)).toEqual(["lane"]);
		} finally {
			await watch.stop();
		}
	} finally {
		await fixture.dispose();
	}
});
