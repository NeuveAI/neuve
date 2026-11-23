import { expect, test } from "bun:test";

import type { PlanComment } from "@ace/channel/protocol";

import { commentSends } from "../src/plan-comments";
import { toEvents, withMention } from "../src/timeline";
import type { Item } from "../src/transcript";

const sent = { at: 1, submission: 3, entry: 7 };
const said = (comments: PlanComment[]) =>
	new Map([...commentSends(comments).values()].map(({ entry, text }) => [entry!, text]));
const comment: PlanComment = {
	id: "8c070ef5-6aa3-473a-bf90-f56aa1391f1a",
	plan: "p1",
	author: "me",
	at: 0,
	text: "Should @vivienne review this first?",
	sent,
	anchor: { hash: "a".repeat(64), lines: [{ line: 34, text: "Ask @vivienne *first*" }], quote: "Ask @vivienne *first*", section: "Validation" },
	placement: { kind: "stays", hash: "a".repeat(64), lines: [{ line: 34, text: "Ask @vivienne *first*" }] },
	replies: [{ kind: "person", id: "r1", author: "me", at: 2, text: "And keep it short.", sent }],
};

// Why: the channel's message for a send of plan comments is written for the agent, with the
// comment's id, its lines and instructions. The chat shows the person what they said: each
// passage quoted as written and their words under it, with no `@name` drawn as a mention.
test("a send of plan comments reads as the person's words under each passage", () => {
	let drawn = withMention({ entry: 7, invoked: true, text: "Comments on the plan. Comment 8c070ef5, lines 34-34" }, said([comment]));
	expect(drawn.replaceAll("⁠", "")).toBe(
		"> Ask @vivienne \\*first\\*\n\nShould @vivienne review this first?\n\n> Ask @vivienne \\*first\\*\n\nAnd keep it short.",
	);
	expect(drawn.match(/(^|[\s([{])@[\w-]+/gm)).toBeNull();
	expect(withMention({ entry: 8, invoked: false, text: "Ask @vivienne" }, said([comment]))).toBe("Ask @vivienne");
});

// Why: the agent answers a comment through a tool, but what it wrote is its words to the person.
// Drawn as a tool row it showed the comment's id and hid the answer; a call still running or
// refused stays a row, naming no comment, so its reason can still be opened.
test("an answered comment reads as the agent's words, a running or refused answer as a row with no id", () => {
	const answer = (call: string, result?: { error: boolean; text: string }) =>
		({ call, name: "plan_comment_answer", args: { comment: comment.id, text: "Kept short." }, ...(result ? { result } : {}) });
	const items: Item[] = [{
		kind: "reply",
		key: "r",
		entry: 9,
		at: 0,
		text: "",
		tools: [
			answer("a1", { error: false, text: "Answered in the plan comment thread." }),
			answer("a2", { error: true, text: "Plan comments can only be answered in Plan mode." }),
			answer("a3"),
		],
	}];
	const [event] = toEvents(items, "c", true, { text: "" }, {}, new Map(), {}, {}, {}, () => undefined, {});
	const content = (event as { content: { type: string; text?: string; arguments?: object }[] }).content;
	expect(content.map(({ type, text, arguments: args }) => type === "text" ? text : args)).toEqual(["Kept short.", {}, {}]);
	expect(JSON.stringify(content)).not.toContain(comment.id);
});
