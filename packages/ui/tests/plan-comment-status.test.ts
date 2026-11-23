import { expect, test } from "bun:test";

import { commentStatus, type PlanCommentView } from "../src/components/plan/plan-comments";

const message = (kept: boolean) => ({ id: kept ? "r" : "c", agent: false, name: "Vinicius", initial: "V", text: "Five.", kept, mine: true });
const comment = (patch: Partial<PlanCommentView>, kept = false): PlanCommentView => ({
	id: "c",
	placement: { kind: "stays", hash: "a".repeat(64), lines: [{ line: 5, text: "x" }] },
	quote: "x",
	section: "Goal",
	messages: [message(false), ...(kept ? [message(true)] : [])],
	...patch,
});

// Why: the card's last line tells the person whether their words reached the agent. A delivery
// state left from an earlier send must never hide words they kept since, and a send that failed
// must say so even though its words are kept again for the next send.
test("words kept since the last send say they are not sent, whatever that send reached", () => {
	expect(commentStatus(comment({ state: "replied" }, true), "Neuve")).toBe("Not sent yet");
	expect(commentStatus(comment({ state: "picked-up" }, true), "Neuve")).toBe("Not sent yet");
	expect(commentStatus(comment({}, true), "Neuve")).toBe("Not sent yet");
});

test("a failed send says why, though its words are kept again", () => {
	expect(commentStatus(comment({ state: "failed", failure: "Stopped before the agent read it" }, true), "Neuve"))
		.toBe("Not delivered: Stopped before the agent read it");
});

test("a send on its way says where it is, and an answered one says nothing", () => {
	expect(commentStatus(comment({ state: "queued" }), "Neuve")).toBe("Queued · reaches Neuve when it’s free");
	expect(commentStatus(comment({ state: "picked-up" }), "Neuve")).toBe("Picked up by Neuve");
	expect(commentStatus(comment({ state: "replied" }), "Neuve")).toBeUndefined();
});
