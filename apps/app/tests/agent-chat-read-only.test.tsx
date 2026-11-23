// Why: no person writes in a build's agent's chat, and the composer is the one way to. Its own watch
// says whose chat it is only once it has loaded, and says nothing when it fails, so the chat must be
// read-only before then: on the work log always, and by its address once the channel's builds are known.
import { afterEach, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";

import type { Build } from "@ace/channel/protocol";

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
Object.assign(window, { matchMedia: globalThis.matchMedia });
for (const name of ["customElements", "HTMLElement", "CSSStyleSheet", "ShadowRoot", "DocumentFragment", "HTMLTextAreaElement", "Element", "Node", "Text", "Range", "NodeFilter", "Event", "MutationObserver"]) {
	Object.assign(globalThis, { [name]: window[name as keyof typeof window] });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// A host whose watches never load, as while a chat opens or after its watch failed.
mock.module("../src/host", () => ({
	host: {
		status: "open",
		people: {},
		presence: {},
		channels: [],
		settingsVersion: 0,
		stalled: false,
		subscribe: () => () => {},
		channel: () => new Promise(() => {}),
		request: () => new Promise(() => {}),
	},
	onOpen: () => () => {},
	refused: async () => undefined,
	nativeToken: undefined,
}));
mock.module("../src/agent-avatar", () => ({ useAgentAvatar: () => "" }));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { publish } = await import("../src/details");
const { Conversation } = await import("../src/conversation");

const CHANNEL = "c1";
const listing = { id: CHANNEL, name: "exports", owner: "me", host: "mac", state: "open", created: 0, project: "/p" };
const build: Build = {
	id: `1:${"a".repeat(64)}`,
	chat: 1,
	plan: { id: "p", hash: "a".repeat(64), title: "Retry", call: "w" },
	approved: { by: "me", at: 0 },
	state: { kind: "started" },
	agents: [{ chat: 2, role: "implementer", started: 0, state: "running" }],
};

let root: ReturnType<typeof createRoot> | undefined;
async function open(chat: number, beside?: boolean) {
	const element = document.createElement("div");
	document.body.append(element);
	root = createRoot(element);
	await act(async () =>
		root!.render(
			<Conversation
				channel={listing as never}
				channels={[]}
				chat={chat}
				user="me"
				onDraftLoaded={() => {}}
				onOpen={() => {}}
				beside={beside}
			/>,
		)
	);
}
const composer = () => document.querySelector("[contenteditable=true], textarea");

afterEach(() => {
	act(() => root?.unmount());
	document.body.replaceChildren();
	publish(CHANNEL, { builds: { list: [], messages: [] } });
});

test("an agent's chat on the work log draws no composer before its watch loads", async () => {
	await open(2, true);
	expect(composer()).toBeNull();
});

test("an agent's chat opened by its address draws no composer once the channel's builds are known", async () => {
	publish(CHANNEL, { builds: { list: [build], messages: [] } });
	await open(2);
	expect(composer()).toBeNull();
});

test("any other chat keeps its composer while it loads", async () => {
	publish(CHANNEL, { builds: { list: [build], messages: [] } });
	await open(1);
	expect(composer()).not.toBeNull();
});
