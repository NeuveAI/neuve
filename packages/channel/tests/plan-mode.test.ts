import { expect, test } from "bun:test";
import { getCurrentTools, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Harness, LiveDoc, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { EventSchema } from "../src/frame";
import { parseRequest } from "../src/parse";
import { ChatModesDoc } from "../src/plan-mode";
import type { ChannelInfo, ChatMode, Request } from "../src/protocol";
import { Fixture, OWNER } from "./helpers";

// Both composers send through this parser before admission.
test("an ask carries only a recognized chat mode through the parser", () => {
	for (const mode of ["plan", "ace"] satisfies ChatMode[]) {
		expect(parseRequest({ op: "ask", text: "Draft a plan", mode }, "member")).toEqual({
			op: "ask", author: "member", text: "Draft a plan", mode,
		});
	}
	expect(() => parseRequest({ op: "ask", text: "Draft a plan", mode: "write" }, "member")).toThrow("at mode");
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
				const switchMode = { ...ask, mode: other };
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
