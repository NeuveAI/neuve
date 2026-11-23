import { expect, mock, test } from "bun:test";

import type { Plan } from "@ace/channel/protocol";

mock.module("../src/host", () => ({ host: {}, onOpen: () => () => {} }));

const { apply } = await import("../src/transcript");
const { planCards } = await import("../src/plan-card");
type Transcript = Parameters<typeof apply>[0];

function plan(state: Plan["state"], id = "p1"): Plan {
	return { id, hash: "a".repeat(64), call: `c-${id}`, title: "Retry", state, written: 0 };
}
const states = (transcript: Transcript) =>
	[...planCards(transcript.plans, (name) => name).values()].map((card) => `${card.plan}:${card.state}`);

// Why: approving is the person's authority over scope, so the screen may say Approved only when
// the channel has recorded it. If the app kept an old list beside the channel's, a person could see
// Approved for a plan the channel no longer holds.
test("a plan reads Approved only once the channel's plans event says so", () => {
	let transcript = apply({ plans: [] } as unknown as Transcript, { kind: "plans", chat: 1, plans: [plan("draft")] });
	expect(states(transcript)).toEqual(["p1:draft"]);

	transcript = apply(transcript, { kind: "plans", chat: 1, plans: [plan("approved")] });
	expect(states(transcript)).toEqual(["p1:approved"]);

	transcript = apply(transcript, { kind: "plans", chat: 1, plans: [plan("draft", "p2")] });
	expect(states(transcript)).toEqual(["p2:draft"]);
});
