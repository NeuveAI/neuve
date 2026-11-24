// Why: the channel delivers a person's words to a working agent only from the request's list of
// agents, and the screen must say the same. If the list came from text, or if text drew an agent as
// mentioned, a pasted or quoted "@reviewer" would look like it reached the reviewer, or reach it.
import { afterEach, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";

import type { Build, Request } from "@ace/channel/protocol";
import type { Event } from "@ace/ui";

type Text = Event.Message.Content.Text;

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
const { window } = dom;
Object.assign(globalThis, {
	window,
	document: window.document,
	navigator: window.navigator,
	localStorage: window.localStorage,
	getSelection: () => window.getSelection(),
	getComputedStyle: window.getComputedStyle.bind(window),
	requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
});
Object.assign(window, { matchMedia: globalThis.matchMedia });
for (const name of ["customElements", "HTMLElement", "CSSStyleSheet", "ShadowRoot", "DocumentFragment", "HTMLTextAreaElement", "Element", "Node", "Text", "Range", "NodeFilter", "Event", "KeyboardEvent", "MutationObserver", "DOMRect"]) {
	Object.assign(globalThis, { [name]: window[name as keyof typeof window] });
}
const empty = () => Object.assign([], { item: () => null });
Object.assign(window.Range.prototype, { getClientRects: empty, getBoundingClientRect: () => new window.DOMRect() });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const sent: Request[] = [];
mock.module("../src/host", () => ({
	host: {
		url: "http://host",
		status: "open",
		settingsVersion: 0,
		subscribe: () => () => {},
		channel: async (_: string, request: Request) => {
			if (request.op !== "typing") sent.push(request);
		},
	},
}));
mock.module("../src/agent-avatar", () => ({ useAgentAvatar: () => "" }));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Composer } = await import("../src/composer");
const { toEvents } = await import("../src/timeline");
const { agentAuthors, mentionable } = await import("../src/build-card");

const build: Build = {
	id: `1:${"a".repeat(64)}`,
	chat: 1,
	plan: { id: "p", hash: "a".repeat(64), title: "Retry", call: "w" },
	approved: { by: "me", at: 0 },
	state: { kind: "stopped", by: "me", at: 1 },
	agents: [
		{ chat: 2, role: "implementer", started: 0, state: "stopped" },
		{ chat: 3, role: "reviewer", started: 0, state: "stopped" },
	],
};

let root: ReturnType<typeof createRoot> | undefined;
async function open() {
	localStorage.setItem("ace:mode:/channels/c1/1", JSON.stringify("chat"));
	const element = document.createElement("div");
	document.body.append(element);
	root = createRoot(element);
	await act(async () =>
		root!.render(
			<Composer
				channel={{ id: "c1", name: "exports", owner: "me", host: "mac", state: "running", created: 0 } as never}
				chat={1}
				user="me"
				busy={false}
				waiting="Sending"
				shared={false}
				ready
				onDraftLoaded={() => {}}
				returned={[]}
				members={[{ name: "vivienne" }, { name: "reviewer" }, { name: "reviewer-bob" }]}
				builds={[build]}
			/>,
		)
	);
	return document.querySelector<HTMLElement>("[contenteditable=true]")!;
}
const key = (editor: HTMLElement, name: string) =>
	act(async () => {
		editor.dispatchEvent(new window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
	});
/** Types as the browser does: the text lands in the DOM and the editor reads it from there. */
const type = (editor: HTMLElement, text: string) =>
	act(async () => {
		const line = editor.querySelector("p")!;
		line.querySelector("br")?.remove();
		const node = document.createTextNode(text);
		line.append(node);
		window.getSelection()!.collapse(node, text.length);
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
const rows = () =>
	[...document.querySelectorAll("[data-slot=popover-positioner] button")].map((row) => row.textContent);

afterEach(() => {
	act(() => root?.unmount());
	document.body.replaceChildren();
	localStorage.clear();
	sent.length = 0;
});

test("an agent chosen from the mention list goes on the request as its chat", async () => {
	const editor = await open();
	await type(editor, "@rev");
	expect(rows()).toEqual(["Reviewer", "reviewer-bob"]);
	await key(editor, "Enter");
	await key(editor, "Enter");
	expect(sent).toEqual([{ op: "say", chat: 1, author: "me", text: "@reviewer", agents: [3] }]);
});

test("typed text that names an agent goes as words to no agent", async () => {
	const editor = await open();
	await type(editor, "@reviewer");
	await type(editor, " ");
	await type(editor, "hold it");
	expect(editor.querySelector("[data-mention-name]")).toBeNull();
	await key(editor, "Enter");
	expect(sent).toEqual([{ op: "say", chat: 1, author: "me", text: "@reviewer hold it" }]);
});

test("pasted text that names an agent goes as words to no agent", async () => {
	const editor = await open();
	await act(async () => {
		const paste = new window.Event("paste", { bubbles: true, cancelable: true });
		Object.assign(paste, {
			clipboardData: {
				types: ["text/plain"],
				files: [],
				getData: (type: string) => (type === "text/plain" ? "@reviewer hold the final review" : ""),
			},
		});
		editor.dispatchEvent(paste);
	});
	expect(editor.querySelector("[data-mention-name]")).toBeNull();
	await key(editor, "Enter");
	expect(sent).toEqual([{ op: "say", chat: 1, author: "me", text: "@reviewer hold the final review" }]);
});

const posted = (agents?: number[], text = "@reviewer hold it, @vivienne, @reviewer-bob") => {
	const [event] = toEvents(
		[{
			kind: "message",
			key: "e1",
			entry: 1,
			at: 0,
			author: "me",
			text,
			invoked: false,
			...(agents ? { agents } : {}),
		}],
		"c1",
		false,
		{ text: "" },
		{},
		new Map(),
		{},
		{},
		{},
		() => undefined,
		new Map(),
		new Map(),
		agentAuthors([build]),
	);
	const [content] = (event as { content: Text[] }).content;
	expect(content!.text).toBe(text);
	return content!.parts!.map((part) => part.value);
};

// Why: a name drawn as words must still read as written, so copying the message or finding
// "@reviewer" on the page works.
test("a posted message draws an agent as mentioned only from its list of agents, and keeps its text as written", () => {
	expect(posted()).toEqual(["vivienne", "reviewer-bob"]);
	expect(posted([2])).toEqual(["vivienne", "reviewer-bob"]);
	expect(posted([3])).toEqual(["reviewer", "vivienne", "reviewer-bob"]);
});

// Why: a bold mention is written `**@name**`, so the name follows no space and must still be offered.
test("a bold mention keeps its chip, for a person and for a listed agent", () => {
	expect(posted([3], "**@vivienne** and **@reviewer**, please")).toEqual(["vivienne", "reviewer"]);
	expect(posted(undefined, "**@vivienne** and **@reviewer**, please")).toEqual(["vivienne"]);
});

test("an agent's reply that names another agent draws no mention", () => {
	const [event] = toEvents(
		[{ kind: "reply", key: "e1", entry: 1, at: 0, model: "m", text: "Ask @reviewer, not @vivienne", tools: [] }],
		"c1",
		false,
		{ text: "" },
		{},
		new Map(),
		{},
		{},
		{},
		() => undefined,
		new Map(),
		new Map(),
		agentAuthors([build]),
	);
	const [content] = (event as { content: Text[] }).content;
	expect(content!.text).toBe("Ask @reviewer, not @vivienne");
	expect(content!.parts!.map((part) => part.value)).toEqual(["vivienne"]);
});

// Why: a revision approved while agents work goes to them and starts no one, so its loop has no
// agents. Offering the newest loop regardless would leave the person nothing to mention.
test("the list offers each planning chat's newest loop that has agents, and tells same-named agents apart by plan", () => {
	const later = { ...build, id: "1:b", approved: { by: "me", at: 5 }, state: { kind: "delivered", to: build.id }, agents: [] } satisfies Build;
	const other = { ...build, id: "9:a", chat: 9, plan: { ...build.plan, title: "Docs" }, agents: [{ chat: 10, role: "implementer", started: 0, state: "running" }] } satisfies Build;
	expect(mentionable([build, later, other]).map(({ name, id, agent }) => [name, id, agent?.caption])).toEqual([
		["implementer", "2", "Retry"],
		["reviewer", "3", undefined],
		["implementer", "10", "Docs"],
	]);
});
