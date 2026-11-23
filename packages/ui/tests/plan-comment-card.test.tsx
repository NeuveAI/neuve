import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { PlanCommentCard, type PlanCommentView } from "../src/components/plan/plan-comments";

const person = (id: string, kept: boolean, mine = true) =>
	({ id, agent: false, name: "Vinicius", initial: "V", text: id, kept, mine });
const card = (messages: PlanCommentView["messages"]) =>
	renderToStaticMarkup(
		<PlanCommentCard
			comment={{ id: "c", placement: { kind: "stays", hash: "a".repeat(64), lines: [{ line: 1, text: "x" }] }, quote: "x", section: "", messages }}
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
