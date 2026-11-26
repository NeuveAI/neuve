import { expect, mock, test } from "bun:test";

import type { Build, BuildAgent, Chat, WorkMessage } from "@ace/channel/protocol";
import type { Event } from "@ace/ui";

mock.module("../src/host", () => ({ host: { channel: async () => undefined }, onOpen: () => () => {} }));
const { apply } = await import("../src/transcript");
const { agentAuthor, agentAuthors, buildCards, readOnly, workEvents } = await import("../src/build-card");
const { toEvents } = await import("../src/timeline");
const { withCards } = await import("../src/review-card");
const { planCards } = await import("../src/plan-card");
import type { Item } from "../src/transcript";
type Transcript = Parameters<typeof apply>[0];

const HASH = "a".repeat(64);
const agent = (chat: number, patch: Partial<BuildAgent> = {}): BuildAgent => ({
	chat,
	role: "implementer",
	started: 0,
	state: "running",
	...patch,
});
const build = (patch: Partial<Build> = {}): Build => ({
	id: `1:${HASH}`,
	chat: 1,
	plan: { id: "p1", hash: HASH, title: "Retry failed exports", call: "c1" },
	approved: { by: "me", at: 0 },
	state: { kind: "started" },
	agents: [agent(2), agent(3, { role: "reviewer", by: 2 })],
	...patch,
});
const said = (from: number, to: number, text: string): WorkMessage => ({ build: `1:${HASH}`, from, to, at: 0, text });

// Why: the event is the only way builds and the agents' messages reach the app; a fold that kept
// an older list would leave the card and the work log showing agents that have since changed.
test("each builds event replaces the channel's builds and messages", () => {
	let state = { builds: [], messages: [] } as unknown as Transcript;
	state = apply(state, { kind: "builds", chat: 1, builds: [build()], messages: [said(2, 3, "ready")] });
	state = apply(state, {
		kind: "builds",
		chat: 1,
		builds: [build({ state: { kind: "stopped", by: "me", at: 5 } })],
		messages: [said(2, 3, "ready"), said(3, 2, "two things")],
	});
	expect(state.builds.map((value) => value.state.kind)).toEqual(["stopped"]);
	expect(state.messages.map((value) => value.text)).toEqual(["ready", "two things"]);
});

// Why: a person must not write in an agent's chat wherever it is opened, and the composer must not
// show for it while `info` is still loading; any other chat keeps its composer.
test("a chat is read-only when its record or any build names it as an agent's", () => {
	const record = { id: 2, busy: false, build: { id: `1:${HASH}`, role: "implementer" } } as Chat;
	expect(readOnly(2, record, [])).toBe(true);
	expect(readOnly(2, undefined, [build()])).toBe(true);
	expect(readOnly(1, { id: 1, busy: false } as Chat, [build()])).toBe(false);
	expect(readOnly(4, undefined, [build()])).toBe(false);
});

// Why: a role is a fact of the build, never of a message's text; an author that is not one of the
// builds' agents, such as a subagent of the planning chat, must keep its own name.
test("an agent's author resolves to its role and part; the brief is drawn as Neuve's", () => {
	const scheduler = agent(4, { part: "scheduler", by: 2 });
	const agents = agentAuthors([build({ agents: [agent(2), agent(3, { role: "reviewer" }), scheduler] })]);
	const items: Item[] = [
		{
			kind: "message",
			key: "e1",
			entry: 1,
			at: 0,
			author: "unknown",
			text: "Build the approved plan.",
			invoked: true,
			system: { kind: "neuve:build:brief", build: `1:${HASH}` },
		},
		{ kind: "message", key: "e2", entry: 2, at: 0, author: agentAuthor(3), text: "Two things.", invoked: true },
		{ kind: "message", key: "e3", entry: 3, at: 0, author: agentAuthor(4), text: "Timer moved.", invoked: true },
		{ kind: "message", key: "e4", entry: 4, at: 0, author: "agent@9", text: "Done.", invoked: true },
		{ kind: "reply", key: "e5", entry: 5, at: 0, model: "m", text: "Fixed.", tools: [] },
	];
	const events = toEvents(
		items, "t", false, { text: "" }, {}, new Map(), {}, {}, {}, () => undefined, {}, new Set(), agents,
		{ author: agentAuthor(2), agent: agent(2) },
	) as Extract<Event, { type: "message" }>[];
	expect(events.map((event) => [event.sender.value, event.sender.display])).toEqual([
		["ace:agent", "Neuve"],
		["agent@3", "Reviewer"],
		["agent@4", "Implementer · scheduler"],
		["agent@9", "agent@9"],
		["agent@2", "Implementer"],
	]);
	// Every input to an agent asks it, so none is drawn with an @neuve.
	expect(events.slice(0, 3).map((event) => (event.content[0] as { text: string }).text))
		.toEqual(["Build the approved plan.", "Two things.", "Timer moved."]);
});

// Why: the card is how a person stops a build from the chat; under another turn, or in another
// chat's timeline, it would sit away from the plan it builds.
test("a build's card follows its plan's card, only in the planning chat", () => {
	const items: Item[] = [
		{ kind: "message", key: "m1", at: 0, author: "me", text: "", invoked: true },
		{ kind: "reply", key: "r1", at: 1000, model: "", text: "", tools: [{ call: "c1", name: "plan_write", args: {} }] },
		{ kind: "message", key: "m2", at: 2000, author: "me", text: "", invoked: true },
	];
	const plans = planCards([{ id: "p1", hash: HASH, call: "c1", title: "", state: "approved", written: 0 }], (name) => name);
	const order = (chat: number) =>
		withCards(
			items.map((item) => ({ uid: item.key }) as Event),
			items,
			{},
			plans,
			"t",
			false,
			true,
			buildCards([build()], chat, (name) => name),
		).map((event) => event.uid);
	expect(order(1)).toEqual(["m1", "r1", "plan:p1", `build:1:${HASH}`, "m2"]);
	expect(order(2)).toEqual(["m1", "r1", "plan:p1", "m2"]);
	// A start still under way, or a plan delivered to agents already building, draws no card.
	for (const state of [{ kind: "starting" }, { kind: "delivered", to: "x" }] as const) {
		expect(buildCards([build({ state, agents: [] })], 1, (name) => name).size).toBe(0);
	}
});

// Why: the card is where a person sees that an agent gave up, so a failed agent's line must say why in
// place of its stale caption, and must go back to its caption once a later turn clears the failure.
test("a failed agent's line says why it stopped until a later turn clears the failure", () => {
	const failure = { role: "implementer", turn: "t1", at: 0, reason: "retry-budget-exhausted", attempts: 6 } as const;
	const line = (patch: Partial<BuildAgent>) =>
		buildCards([build({ agents: [agent(2, { caption: "Editing retry.ts", ...patch })] })], 1, (name) => name)
			.get("c1")!.agents[0]!;
	expect(line({ state: "failed", failure })).toMatchObject({ state: "failed", caption: "Failed after 6 attempts" });
	expect(line({ state: "failed", failure: { ...failure, reason: "ambiguous-tool-effect", attempts: 1 } }).caption)
		.toBe("Stopped: a tool may have run without a recorded result");
	expect(line({ state: "failed", failure: { ...failure, reason: "model_error", attempts: 1 } }).caption)
		.toBe("Failed without an answer");
	expect(line({ state: "running" }).caption).toBe("Editing retry.ts");
});

// Why: the recipient is named only where more than two agents could be meant; the chat that drafted
// the plan writes as Neuve to either agent, so its recipient is always named; a message from a chat
// no build lists has no role to draw, so it is left out rather than drawn as a person.
test("the work log names a recipient only past two agents, draws the planning chat as Neuve and skips unknown senders", () => {
	const two = workEvents([build()], [said(2, 3, "ready"), said(1, 3, "wake up"), said(9, 2, "?")], "t") as Extract<Event, { type: "message" }>[];
	expect(two.map((event) => [event.sender.display, (event.sender as { credit?: string }).credit])).toEqual([
		["Implementer", undefined],
		["Neuve", "to Reviewer"],
	]);
	const four = build({ agents: [agent(2), agent(3, { role: "reviewer" }), agent(4, { part: "scheduler" })] });
	const many = workEvents([four], [said(4, 2, "moved")], "t") as Extract<Event, { type: "message" }>[];
	expect((many[0]!.sender as { credit?: string }).credit).toBe("to Implementer");
});

// Why: agents' talk names no one by text, so an agent's `@reviewer` there must stay words.
test("the work log draws no name in agents' talk as a mention", () => {
	const [event] = workEvents([build()], [said(2, 3, "ask @reviewer to look")], "t") as Extract<Event, { type: "message" }>[];
	expect(event!.content).toEqual([{ type: "text", text: "ask @reviewer to look", parts: [] }]);
});
