import { expect, test } from "bun:test";

import type { Plan } from "@ace/channel/protocol";
import type { Event } from "@ace/ui";

// The saved layout lives in the window's storage; both stores are maps here.
const store = () => {
	const values = new Map<string, string>();
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => void values.set(key, value),
		removeItem: (key: string) => void values.delete(key),
	};
};
Object.assign(globalThis, { sessionStorage: store(), localStorage: store() });

const { withCards } = await import("../src/review-card");
const { planCards } = await import("../src/plan-card");
const { read, write } = await import("../src/layout/storage");
const Split = await import("@ace/split-tabs");
import type { Item } from "../src/transcript";

const plan = (patch: Partial<Plan>): Plan => ({
	id: "p1",
	hash: "a".repeat(64),
	call: "c1",
	title: "Retry failed exports",
	state: "draft",
	written: 0,
	...patch,
});

const reply = (key: string, call: string): Item => ({
	kind: "reply",
	key,
	at: 1000,
	model: "",
	text: "",
	tools: [{ call, name: "plan_write", args: {} }],
});
const message = (key: string): Item => ({ kind: "message", key, at: 0, author: "a", text: "", invoked: true });

function order(items: Item[], plans: Plan[]) {
	const events = items.map((item) => ({ uid: item.key }) as Event);
	return withCards(events, items, {}, planCards(plans, (name) => name), "t", false, true).map((event) => event.uid);
}

// Why: the card is the person's way to approve without opening the tab; under the wrong turn, or
// shown once per rewrite, it would point at a version the chat no longer shows.
test("a plan's card follows the turn whose call last wrote it, once", () => {
	const items = [message("m1"), reply("r1", "c1"), message("m2"), reply("r2", "c2"), message("m3")];
	expect(order(items, [plan({ call: "c2" })])).toEqual(["m1", "r1", "m2", "r2", "plan:p1", "m3"]);
	expect(order(items, [plan({ call: "c1" }), plan({ id: "p2", call: "c2" })]))
		.toEqual(["m1", "r1", "plan:p1", "m2", "r2", "plan:p2", "m3"]);
});

// Why: a saved layout is parsed again on every launch, and one that dropped the Plan tab or the
// plan it shows would quietly lose the person's tab; one that kept a malformed id would show nothing.
test("a saved Plan tab and each chat's opened plan come back, and malformed values are dropped", () => {
	const api = Split.create(Split.initial("chat"));
	api.open({ tab: "tab-1" });
	api.open({ tab: "tab-2" });
	const state = api.get();
	write("ch", state, {
		"tab-1": { type: "plan", chat: 2, plan: "p7" },
		"tab-2": { type: "plan", chat: 3, plan: 7 } as never,
	}, false, { "2": "p7", "3": 7 as never });
	const restored = read("ch");
	expect(restored.meta["tab-1"]).toEqual({ type: "plan", chat: 2, plan: "p7" });
	expect(restored.meta["tab-2"]).toEqual({ type: "plan", chat: 3 });
	expect(restored.plans).toEqual({ "2": "p7" });
});
