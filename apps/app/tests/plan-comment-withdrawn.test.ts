import { expect, mock, test } from "bun:test";

import type { PlanComment, QueuedMessage } from "@ace/channel/protocol";

mock.module("../src/host", () => ({ host: { channel: async () => undefined }, onOpen: () => () => {} }));
const { apply } = await import("../src/transcript");
type Transcript = Parameters<typeof apply>[0];

const anchor = { hash: "a".repeat(64), lines: [{ line: 1, text: "x" }], quote: "x", section: "" };
const comment: PlanComment = {
	id: "c", plan: "p", author: "me", at: 0, text: "Five.", anchor,
	placement: { kind: "stays", hash: anchor.hash, lines: anchor.lines },
	sent: { at: 1, submission: 4 }, state: "queued", replies: [],
};
const queued = (submission: number, text: string): QueuedMessage => ({ submission, author: "me", text, invoked: true });

// Why: Stop returns withdrawn messages to their author's composer. A withdrawn send of plan
// comments leaves its comments kept in the Plan tab; returning its text to the composer too would
// invite the person to send the same words twice, once as an ordinary message.
test("a withdrawn send of plan comments is not returned to the composer; another message is", () => {
	let state = { returned: [], withdrawn: [], items: [], queue: [], planComments: [], commentSends: [], busy: false } as unknown as Transcript;
	state = apply(state, { kind: "plan-comments", chat: 1, comments: [comment] });
	state = apply(state, { kind: "plan-comments", chat: 1, comments: [{ ...comment, sent: undefined, state: "failed" }] });
	state = apply(state, { kind: "queue", chat: 1, messages: [], withdrawn: [queued(4, "Comments on the plan"), queued(5, "And this")] });
	expect(state.returned.map((message) => message.submission)).toEqual([5]);
});
