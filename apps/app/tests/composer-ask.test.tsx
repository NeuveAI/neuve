// What the composer asks the channel for must match what its model control shows: a stored model the
// channel no longer offers shows as Automatic, so the ask requests Automatic rather than leaving the
// channel to run, or refuse, the stored one.
import { afterEach, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";

import type { ModelRef } from "@ace/channel/protocol";

// A DOM for the real composer; React reads these globals when it loads.
const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
const { window } = dom;
const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
Object.assign(window, { matchMedia });
Object.assign(globalThis, {
	window,
	document: window.document,
	navigator: window.navigator,
	localStorage: window.localStorage,
	getSelection: () => window.getSelection(),
	getComputedStyle: window.getComputedStyle.bind(window),
	requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	matchMedia,
});
for (const name of ["customElements", "HTMLElement", "CSSStyleSheet", "ShadowRoot", "DocumentFragment", "HTMLTextAreaElement", "Element", "Node", "Text", "Range", "NodeFilter", "Event", "MutationObserver", "ResizeObserver"]) {
	Object.assign(globalThis, { [name]: window[name as keyof typeof window] });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// The channel, as the composer reaches it: one offered model, and every ask recorded.
const asks: Record<string, unknown>[] = [];
mock.module("../src/host", () => ({
	host: {
		url: "ws://test",
		status: "open",
		settingsVersion: 0,
		subscribe: () => () => {},
		channel: (_channel: string, request: Record<string, unknown>) => {
			if (request.op === "models") return Promise.resolve([{ provider: "anthropic", modelId: "opus", efforts: ["off"] }]);
			if (request.op === "ask") asks.push(request);
			return Promise.resolve({});
		},
	},
}));
mock.module("../src/agent-avatar", () => ({ useAgentAvatar: () => "" }));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Composer } = await import("../src/composer");

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
	act(() => root?.unmount());
	document.body.replaceChildren();
	asks.length = 0;
});

/** Retries a failed run of a chat whose stored model is `current`, and returns what it asked. */
async function retry(current: ModelRef) {
	const element = document.createElement("div");
	document.body.append(element);
	root = createRoot(element);
	await act(async () =>
		root!.render(
			<Composer
				channel={{ id: "c1", owner: "me", state: "open" } as never}
				chat={1}
				chatMode="ace"
				user="me"
				current={current}
				busy={false}
				waiting="Send"
				shared
				ready
				onDraftLoaded={() => {}}
				returned={[]}
				members={[]}
				failure="The run stopped"
			/>,
		)
	);
	const button = [...document.querySelectorAll("button")].find((value) => value.textContent === "Retry")!;
	await act(async () => button.click());
	return asks;
}

test("a chat whose stored model is not offered asks for Automatic", async () => {
	expect(await retry({ provider: "retired", modelId: "old" })).toEqual([
		{ op: "ask", chat: 1, author: "me", text: "Try again.", automatic: true },
	]);
	expect(document.body.textContent).toContain("retired/old is no longer offered, so this chat uses Automatic.");
});

test("a chat whose stored model is offered asks without choosing a model", async () => {
	expect(await retry({ provider: "anthropic", modelId: "opus" })).toEqual([
		{ op: "ask", chat: 1, author: "me", text: "Try again." },
	]);
});
