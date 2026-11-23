import { expect, mock, test } from "bun:test";

import type { Plan } from "@ace/channel/protocol";

// The host answers an approval with the approved plan, as the channel does.
const sent: unknown[] = [];
mock.module("../src/host", () => ({
	host: {
		channel: async (_channel: string, request: { plan: string; hash: string }) => {
			sent.push(request);
			return { ...plan("draft"), state: "approved", approved: { by: "me", at: 1 } } satisfies Plan;
		},
	},
	onOpen: () => () => {},
}));

const { apply } = await import("../src/transcript");
const { planCards } = await import("../src/plan-card");
const { approvePlan } = await import("../src/plan-approve");
type Transcript = Parameters<typeof apply>[0];

function plan(state: Plan["state"], id = "p1"): Plan {
	return { id, hash: "a".repeat(64), call: `c-${id}`, title: "Retry", state, written: 0 };
}
const states = (transcript: Transcript) =>
	[...planCards(transcript.plans, (name) => name).values()].map((card) => `${card.plan}:${card.state}`);

// Why: approving is the person's authority over scope, so the screen may say Approved only when
// the channel has recorded it. If the app believed its own request, or kept an old list beside the
// channel's, a person could see Approved for a plan the channel never approved.
test("a plan reads Approved only once the channel's plans event says so", async () => {
	let transcript = apply({ plans: [] } as unknown as Transcript, { kind: "plans", chat: 1, plans: [plan("draft")] });
	expect(states(transcript)).toEqual(["p1:draft"]);

	expect(await approvePlan("ch", 1, "me", "p1", "a".repeat(64))).toBeUndefined();
	expect(sent).toEqual([{ op: "plan-approve", chat: 1, author: "me", plan: "p1", hash: "a".repeat(64) }]);
	expect(states(transcript)).toEqual(["p1:draft"]);

	transcript = apply(transcript, { kind: "plans", chat: 1, plans: [plan("approved")] });
	expect(states(transcript)).toEqual(["p1:approved"]);

	// The event is the whole list: a plan it no longer holds is gone, not kept from before.
	transcript = apply(transcript, { kind: "plans", chat: 1, plans: [plan("draft", "p2")] });
	expect(states(transcript)).toEqual(["p2:draft"]);
});
