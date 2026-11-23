import { afterEach, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-durable";
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
			const received = /^Received arguments:\n(\{[\s\S]*?^\})/m.exec(result?.text ?? "")?.[1];
			expect(received && JSON.parse(received), name).toEqual(args);
		}
	} finally {
		await watch.stop();
	}
});

// Pi records the failure on the child, so this checks what crosses back to the parent.
test("an unanswered subagent reports the requested model and the child's failure", async () => {
	fixture = await Fixture.create();
	const args = { task: "inspect", model: "faux/coder" };
	fixture.script(
		fauxAssistantMessage(fauxToolCall("subagent", args, { id: "child" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "The model rejected the request." }),
		fauxAssistantMessage("done"),
	);
	const watch = await fixture.watch();
	try {
		await fixture.request({ op: "ask", author: OWNER, text: "delegate", model: MODEL });
		const result = await watch.until("result", event => event.call === "child");
		expect(result.error).toBe(true);
		expect(result.text).toContain("ended unanswered with faux/coder (model_error: The model rejected the request.)");
		expect(result.text).toContain(`Received arguments:\n${JSON.stringify(args, null, 2)}`);
	} finally {
		await watch.stop();
	}
});
