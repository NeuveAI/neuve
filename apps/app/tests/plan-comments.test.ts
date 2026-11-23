import { expect, test } from "bun:test";

import type { PlanComment } from "@ace/channel/protocol";

import { planCommentViews } from "../src/plan-comments";

const anchor = { hash: "a".repeat(64), lines: [{ line: 5, text: "x" }], quote: "x", section: "Goal" };
const comment = (patch: Partial<PlanComment>): PlanComment => ({
	id: "c1",
	plan: "p1",
	author: "me",
	at: 0,
	text: "Five.",
	anchor,
	placement: { kind: "stays", hash: anchor.hash, lines: anchor.lines },
	replies: [],
	...patch,
});

// Why: what is kept and whose it is decides what the person may edit or remove and what the one
// send carries. A sent comment shown as kept would invite an edit the channel refuses; someone
// else's kept comment counted as the person's would put words in their send that are not theirs.
test("kept means not sent, and only the person's own words are theirs", () => {
	let [view] = planCommentViews(
		[
			comment({
				sent: { at: 1, submission: 3 },
				replies: [
					{ kind: "agent", id: "a1", model: "m", at: 2, text: "Done." },
					{ kind: "person", id: "r1", author: "me", at: 3, text: "Thanks." },
					{ kind: "person", id: "r2", author: "viv", at: 4, text: "Agreed.", sent: { at: 5, submission: 4, entry: 9 } },
				],
			}),
			comment({ id: "c2", plan: "p2" }),
		],
		"p1",
		"me",
		(author) => author === "me" ? "Vinicius" : "Vivienne",
	);
	expect(view!.messages.map(({ id, agent, kept, mine, initial }) => ({ id, agent, kept, mine, initial }))).toEqual([
		{ id: "c1", agent: false, kept: false, mine: true, initial: "V" },
		{ id: "a1", agent: true, kept: false, mine: false, initial: "N" },
		{ id: "r1", agent: false, kept: true, mine: true, initial: "V" },
		{ id: "r2", agent: false, kept: false, mine: false, initial: "V" },
	]);
});

test("only the shown plan's comments are listed", () => {
	expect(planCommentViews([comment({ plan: "p2" })], "p1", "me", (author) => author)).toEqual([]);
});
