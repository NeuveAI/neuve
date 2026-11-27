import { afterEach, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { Delivery } from "../src/protocol";
import { Fixture, isolateClaudeConfig, MODEL, OWNER } from "./helpers";

let fixture: Fixture | undefined;
afterEach(async () => {
	await fixture?.dispose();
	fixture = undefined;
});
isolateClaudeConfig();

// Pi can replace argument errors, so check the repair advice that reaches the model.
test("chat tools show every bad field, the accepted choices, and the original arguments", async () => {
	fixture = await Fixture.create();
	const calls: [string, JsonObject, string[]][] = [
		["lane", { action: "open", name: "Bad Name", typo: true }, [
			'action: Expected one of "start", "switch", "list".',
			"name: Expected a lowercase kebab-case work lane name of 1 to 63 characters",
			"typo: Unknown argument, use only action, name, base.",
		]],
		["lane", { action: "switch", name: "nope" }, [
			'name: No work lane is named "nope", so use {"action":"list"} with lane to find existing names.',
		]],
		["lane", { name: "new-work", action: "start", base: "no-such-base" }, [
			'base: No branch, tag, or commit named "no-such-base", so specify a local branch, tag, or commit such as "HEAD".',
		]],
		["message", { channel: "nowhere", text: "hi", invoke: false }, [
			'channel: No channel matches "nowhere", so use an id or unique name returned by channels.',
		]],
		["message", { channel: "two", text: "hi" }, [
			"invoke: Missing required value, so supply true to start the destination chat's agent or false to deliver the message without starting it.",
		]],
		["message", { channel: "two", text: "hi", invoke: "true", chat: "bad", typo: true }, [
			"chat: Expected a nonnegative integer chat id",
			"typo: Unknown argument, use only channel, chat, text, invoke.",
		]],
		["channels", { channel: "one", "client.note": 1 }, [
			"channel: Unknown argument, pass an empty object.",
			'["client.note"]: Unknown argument, pass an empty object.',
		]],
		["subagent", { model: "nobody/" }, [
			"task: Missing required value, so supply a JSON string.",
			"model: Expected a model in provider/model-id form",
		]],
		["neuve_review_branch", { against: "", base: "main" }, [
			"against: Expected a nonempty comparison revision",
			"base: Unknown argument, use only against, notify.",
		]],
		["neuve_review_pull_request", { repo: "neuve", number: 0, expected_head: "main" }, [
			'repo: Expected an owner/repository name, such as "NeuveAI/neuve".',
			"number: Expected a positive integer pull request number.",
			"expected_head: Expected a full lowercase Git commit ID",
		]],
		["neuve_review_lane", { notify: "yes", against: "main" }, [
			"notify: Expected false, or true if the person asked to be told when the review finishes.",
			"against: Unknown argument, use only notify.",
		]],
		["neuve_review_status", { review: "bad" }, [
			"review: Expected a review ULID, or omit review for this chat's latest review.",
		]],
		["neuve_review_outcome", { chat: 1 }, [
			"chat: Unknown argument, use only review.",
		]],
	];
	fixture.script(
		fauxAssistantMessage(calls.map(([name, args], index) =>
			fauxToolCall(name, args, { id: `refusal-${index}` })), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	);
	const watch = await fixture.watch();
	try {
		await fixture.request({ op: "ask", author: OWNER, text: "check these calls", model: MODEL });
		await watch.until("reply", event => event.text === "done");
		for (const [index, [name, args, problems]] of calls.entries()) {
			const result = watch.of("result").find(event => event.call === `refusal-${index}`);
			expect(result?.error, name).toBe(true);
			expect(result?.text, name).toContain(`"${name}"`);
			for (const problem of problems) expect(result?.text, name).toContain(problem);
			expect(result?.text?.match(/^  - /gm), name).toHaveLength(problems.length);
			const received = /^Received arguments:\n(\{[\s\S]*?^\})/m.exec(result?.text ?? "")?.[1];
			expect(received && JSON.parse(received), name).toEqual(args);
		}
	} finally {
		await watch.stop();
	}
});

// The destination sees pi's converted values, which a refusal-only test cannot check.
test("chat tools retain pi's argument coercion and declared required fields", async () => {
	const delivered: Delivery[] = [];
	fixture = await Fixture.create({
		directory: {
			self: { id: "one", name: "one" },
			list: async () => [{ id: "two", name: "two", prefix: "two", project: "fixture" }],
			deliver: async delivery => { delivered.push(delivery); },
		},
	});
	const calls: [string, JsonObject, string, string][] = [
		["message", { channel: "two", text: "invoke by string", invoke: "true" }, "invoke", "Delivered to two"],
		["message", { channel: "two", text: "invoke by numeric string", invoke: "1" }, "numeric-invoke", "Delivered to two"],
		["message", { channel: "two", text: "chat by string", invoke: false, chat: "2" }, "chat", "Delivered to two"],
		["message", { channel: "two", text: "default chat", invoke: false, chat: null }, "null-chat", "Delivered to two"],
		["message", { channel: "two", text: "passive by null", invoke: null }, "null-invoke", "Delivered to two"],
		["lane", { action: "list", name: "", base: "" }, "list", "work"],
		["lane", { action: "list", name: "Bad Name" }, "list-ignored-name", "work"],
		["lane", { action: "list", name: null, base: null }, "null-list", "work"],
		["lane", { action: "start", name: "null-base", base: null }, "null-base", "Started work lane null-base"],
		["lane", { action: "start", name: "empty-base", base: "" }, "empty-base", "Started work lane empty-base"],
		["channels", {}, "channels", "two"],
	];
	let required: Record<string, unknown> = {};
	let laneNamePattern: unknown;
	fixture.script(
		({ messages }) => {
			const tools = getCurrentTools(messages);
			required = Object.fromEntries(tools
				.filter(tool => ["lane", "message", "subagent"].includes(tool.name))
				.map(tool => [tool.name, tool.parameters.required]));
			laneNamePattern = tools.find(tool => tool.name === "lane")?.parameters.properties?.name?.pattern;
			return fauxAssistantMessage(fauxToolCall("subagent", { task: "inspect", model: null }, { id: "inherited" }), { stopReason: "toolUse" });
		},
		fauxAssistantMessage("Child used the inherited model"),
		fauxAssistantMessage(fauxToolCall("subagent", { task: "inspect", model: "" }, { id: "empty-model" }), { stopReason: "toolUse" }),
		(_context, _options, _state, model) => fauxAssistantMessage(`Child used ${model.provider}/${model.id}`),
		fauxAssistantMessage(calls.map(([name, args, id]) => fauxToolCall(name, args, { id })), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	);
	const watch = await fixture.watch();
	try {
		await fixture.request({ op: "ask", author: OWNER, text: "check accepted calls", model: MODEL });
		expect(await watch.until("result", event => event.call === "empty-model")).toMatchObject({
			error: false, text: "Child used faux/coder",
		});
		await watch.until("reply", event => event.text === "done");
		expect(required).toEqual({
			lane: ["action"],
			message: ["channel", "text", "invoke"],
			subagent: ["task"],
		});
		const results = watch.of("result");
		expect(results.find(event => event.call === "inherited")).toMatchObject({ error: false, text: "Child used the inherited model" });
		for (const [, , id, expected] of calls) {
			const result = results.find(event => event.call === id);
			expect(result?.error, id).toBe(false);
			expect(result?.text, id).toContain(expected);
		}
		expect(results.find(event => event.call === "empty-base")?.text).toContain("Its Diff compares against refs/heads/main");
		expect(laneNamePattern).toBe("^[a-z0-9][a-z0-9-]{0,62}$");
		expect(Object.fromEntries(delivered.map(({ text, chat, invoke }) => [text, [chat, invoke]]))).toEqual({
			"invoke by string": [undefined, true],
			"invoke by numeric string": [undefined, true],
			"chat by string": [2, false],
			"default chat": [undefined, false],
			"passive by null": [undefined, false],
		});
	} finally {
		await watch.stop();
	}
});

// Pi records the failure on the child, so this checks what crosses back to the parent.
test("a subagent refuses a model the owner did not name and reports child failures as errors", async () => {
	fixture = await Fixture.create();
	const args = { task: "inspect", model: "faux/coder" };
	fixture.script(
		fauxAssistantMessage(fauxToolCall("subagent", { ...args, model: "nobody/none" }, { id: "no-model" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("subagent", args, { id: "child" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "The model rejected the request." }),
		fauxAssistantMessage("done"),
	);
	const watch = await fixture.watch();
	try {
		await fixture.request({ op: "ask", author: OWNER, text: "delegate to coder", model: MODEL });
		const unavailable = await watch.until("result", event => event.call === "no-model");
		expect(unavailable).toMatchObject({ error: true });
		expect(unavailable.text).toContain("matches faux/coder");
		const result = await watch.until("result", event => event.call === "child");
		expect(result.error).toBe(true);
		expect(result.text).toContain("ended unanswered with faux/coder (model_error: The model rejected the request.)");
		expect(result.text).not.toContain('Tool "subagent" refused the call.');
		expect(result.text).not.toContain("Received arguments:");
	} finally {
		await watch.stop();
	}
});
