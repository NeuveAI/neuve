import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { PlanCommentCard, type PlanCommentView } from "../src/components/plan/plan-comments";

const person = (id: string, kept: boolean, mine = true) =>
	({ id, agent: false, name: "Vinicius", initial: "V", text: id, kept, mine });
const card = (messages: PlanCommentView["messages"], delivery: Pick<PlanCommentView, "state" | "failure"> = {}) =>
	renderToStaticMarkup(
		<PlanCommentCard
			comment={{ id: "c", placement: { kind: "stays", hash: "a".repeat(64), lines: [{ line: 1, text: "x" }] }, quote: "x", section: "", messages, ...delivery }}
			actions={{ list: [], edit: async () => {}, remove: async () => {} }}
		/>,
	);
const removes = (html: string) => html.match(/>Remove</g)?.length ?? 0;

// Why: the channel refuses to remove a kept comment once anything under it was delivered, since that
// would discard a delivered reply. The card must not offer what the channel will refuse.
test("a kept comment is offered for removal only while nothing under it was delivered", () => {
	expect(removes(card([person("c", true), person("r", true, false)]))).toBe(1);
	expect(removes(card([person("c", true), person("r", false, false)]))).toBe(0);
	expect(removes(card([person("c", true), { ...person("a", false, false), agent: true }]))).toBe(0);
	expect(removes(card([person("c", false), person("r", true)]))).toBe(1);
});

// Why: a failed send is the one delivery state the person acts on, by sending again, so the card
// says so with the reason. Every other state needs nothing from them and shows no line.
test("only a failed delivery shows a line on the card, with its reason", () => {
	const line = (html: string) => html.match(/role="alert"[^>]*>([^<]*)</)?.[1];
	expect(line(card([person("c", false)], { state: "failed", failure: "Stopped before the agent read it" })))
		.toBe("Not delivered: Stopped before the agent read it");
	for (const state of [undefined, "queued", "sent", "picked-up", "working", "replied"] as const) {
		expect(line(card([person("c", false)], { state }))).toBeUndefined();
	}
});
