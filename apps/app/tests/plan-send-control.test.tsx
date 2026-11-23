import { afterEach, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";

import type { Plan, PlanComment, PlanCommentsSent } from "@ace/channel/protocol";

// A DOM for the real Plan panel; React reads these globals when it loads.
const dom = new JSDOM("<!doctype html><body></body>");
const { window } = dom;
Object.assign(globalThis, {
	window,
	document: window.document,
	navigator: window.navigator,
	getSelection: () => window.getSelection(),
	getComputedStyle: window.getComputedStyle.bind(window),
	requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
});
for (const name of ["customElements", "HTMLElement", "CSSStyleSheet", "ShadowRoot", "DocumentFragment", "HTMLTextAreaElement", "Element", "Node", "Text", "Range", "NodeFilter", "Event", "MutationObserver"]) {
	Object.assign(globalThis, { [name]: window[name as keyof typeof window] });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// The channel, as the panel reaches it: the plan's text at once, each send as the test answers it.
let answer: { resolve: (value: PlanCommentsSent) => void; reject: (error: Error) => void } | undefined;
mock.module("../src/host", () => ({
	host: {
		status: "open",
		people: {},
		subscribe: () => () => {},
		channel: (_channel: string, request: { op: string }) =>
			request.op === "plan"
				? Promise.resolve({ hash: "a".repeat(64), text: "# Retry\n\n## Goal\n\nFive times.\n" })
				: new Promise((resolve, reject) => void (answer = { resolve, reject })),
	},
	onOpen: () => () => {},
}));
mock.module("../src/agent-avatar", () => ({ useAgentAvatar: () => "" }));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { publish } = await import("../src/details");
const { Plan: PlanPanel } = await import("../src/panels/plan");

const CHANNEL = "c1";
const plan: Plan = { id: "p", hash: "a".repeat(64), call: "w", title: "Retry", state: "draft", written: 0 };
const anchor = { hash: plan.hash, lines: [{ line: 5, text: "Five times." }], quote: "Five", section: "Goal" };
const comment = (patch: Partial<PlanComment> = {}): PlanComment => ({
	id: "c", plan: "p", author: "me", at: 0, text: "Why five?", anchor,
	placement: { kind: "stays", hash: plan.hash, lines: anchor.lines }, replies: [], ...patch,
});
const stopped = comment({ state: "failed", failure: "Stopped before the agent read it" });

function event(list: PlanComment[], sends: number[]) {
	act(() => publish(CHANNEL, { planComments: { chat: 1, list, sends } }));
}

let root: ReturnType<typeof createRoot> | undefined;
async function open(list: PlanComment[], sends: number[] = []) {
	publish(CHANNEL, { plans: { chat: 1, list: [plan] }, planComments: { chat: 1, list, sends }, shared: true });
	const element = document.createElement("div");
	document.body.append(element);
	root = createRoot(element);
	await act(async () =>
		root!.render(<PlanPanel channel={{ id: CHANNEL, owner: "me" } as never} chat={1} user="me" />)
	);
}
// The Plan tab's footer: its send control, absent when nothing is kept, and the line beside it.
const footer = () => document.querySelector("section[aria-label=Plan] footer");
const control = () =>
	[...footer()?.querySelectorAll("button") ?? []].find((button) => /^(Send|Sending)/.test(button.textContent ?? ""));
const state = () => control()?.textContent ?? "none";
const line = () => footer()?.querySelector("p")?.textContent;
async function press() {
	await act(async () => control()!.click());
}
async function answered(value: PlanCommentsSent | Error) {
	await act(async () => (value instanceof Error ? answer!.reject(value) : answer!.resolve(value)));
}

afterEach(() => {
	act(() => root?.unmount());
	document.body.innerHTML = "";
	answer = undefined;
});

// Why: the channel answers a send before or after its comments event, and a stopped send puts a
// comment back exactly as it was. The control must wait for this send's own outcome and then come
// back; if it compared what the comments look like, a second stopped send would leave it stuck on
// "Sending…" for good, and the person could never send those words again.
test("a send stopped twice gives the control back each time", async () => {
	await open([stopped], [4]);
	for (const submission of [9, 11]) {
		await press();
		expect(state()).toBe("Sending…");
		await answered({ submission, comments: ["c"] });
		expect(state()).toBe("Sending…");
		event([comment({ sent: { at: 1, submission }, state: "queued" })], [4, submission]);
		event([stopped], [4, submission]);
		expect(state()).toBe("Send 1 comment");
		expect(control()!.getAttribute("aria-disabled")).toBeNull();
	}
});

test("an answer that comes before its event holds the control until the event shows the send", async () => {
	await open([comment()]);
	await press();
	await answered({ submission: 7, comments: ["c"] });
	expect(state()).toBe("Sending…");
	event([comment({ sent: { at: 1, submission: 7 }, state: "queued" })], [7]);
	// Nothing is kept now, so there is nothing to send.
	expect(state()).toBe("none");
});

test("an event that comes before the answer frees the control as soon as the answer arrives", async () => {
	await open([comment()]);
	await press();
	event([comment({ sent: { at: 1, submission: 7, entry: 3 }, state: "sent" })], [7]);
	await answered({ submission: 7, comments: ["c"] });
	expect(state()).toBe("none");
});

test("a refused send gives the control back at once and says why", async () => {
	await open([comment()]);
	await press();
	await answered(new Error("Nothing was sent. Your replies were kept because their parent comments have not reached the chat."));
	expect(state()).toBe("Send 1 comment");
	expect(line()).toContain("Nothing was sent.");
});

test("a send that keeps replies back says so and waits for its own event", async () => {
	const held = { kind: "person" as const, id: "r", author: "me", at: 1, text: "And then?" };
	const answered_ = comment({ sent: { at: 1, submission: 5 }, state: "queued", replies: [held] });
	await open([comment(), comment({ id: "d", ...answered_ })], [5]);
	await press();
	await answered({ submission: 8, comments: ["c"], keptReplies: { ids: ["r"], reason: "Your replies were kept." } });
	expect(line()).toBe("Your replies were kept.");
	expect(state()).toBe("Sending…");
	event([comment({ sent: { at: 1, submission: 8 }, state: "queued" }), comment({ ...answered_, id: "d" })], [5, 8]);
	// The held reply is still kept, so the control is back for it.
	expect(state()).toBe("Send 1 comment");
});
