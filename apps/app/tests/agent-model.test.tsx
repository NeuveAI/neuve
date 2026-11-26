// Why: only the channel's owner may change an agent's model, so only the owner's line is a control,
// while a teammate reads the same values as text; and a line names a model's provider only where the
// same model comes from two, or a person can't tell which one an agent runs on.
import { afterEach, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";

import type { Chat, ModelOption } from "@ace/channel/protocol";
import type { AgentLineView } from "@ace/ui";

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

const MODELS: ModelOption[] = [
	{ provider: "work", modelId: "m", efforts: ["low", "high"] },
	{ provider: "home", modelId: "m", efforts: ["low", "high"] },
	{ provider: "work", modelId: "solo", efforts: [] },
];
mock.module("../src/host", () => ({
	host: {
		status: "open",
		accounts: [],
		settingsVersion: 0,
		subscribe: () => () => {},
		channel: async (_: string, request: { op: string }) => request.op === "models" ? MODELS : undefined,
	},
	onOpen: () => () => {},
}));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AgentLine, AgentModelProvider } = await import("@ace/ui");
const { publish } = await import("../src/details");
const { AgentModel } = await import("../src/agent-model");

const CHANNEL = "c1";
const agent: AgentLineView = { chat: 2, role: "implementer", name: "Implementer", state: "running" };

let root: ReturnType<typeof createRoot> | undefined;
async function unmount() {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.replaceChildren();
}
afterEach(unmount);

async function line(user: string, chat: Partial<Chat>) {
	await unmount();
	publish(CHANNEL, {
		info: { id: CHANNEL, owner: "me", chats: [{ id: 2, busy: false, ...chat }] } as never,
	});
	const element = document.body.appendChild(document.createElement("div"));
	root = createRoot(element);
	await act(async () =>
		root!.render(
			<AgentModelProvider
				value={(chat, plain) => <AgentModel channel={CHANNEL} models={MODELS} user={user} chat={chat} plain={plain} />}
			>
				<AgentLine agent={agent} />
			</AgentModelProvider>,
		)
	);
	// The channel's list of models arrives after the first render.
	await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
	return {
		text: element.textContent,
		buttons: [...element.querySelectorAll("button")].map((button) => button.getAttribute("aria-label") || button.textContent),
	};
}

test("the owner's line opens the picker; a teammate's shows the same values as text", async () => {
	const values = { model: { provider: "work", modelId: "m" }, effort: "high" } as const;
	expect((await line("me", values)).buttons).toEqual(["m · work", "Reasoning effort: High"]);
	const teammate = await line("sam", values);
	expect(teammate.buttons).toEqual([]);
	expect(teammate.text).toContain("m · work· High");
});

test("a model from one provider is named alone, and a model with no effort levels shows no effort", async () => {
	const { text, buttons } = await line("me", { model: { provider: "work", modelId: "solo" }, effort: "off" });
	expect(buttons).toEqual(["solo"]);
	expect(text).not.toContain("work");
});

test("a pending change shows the running value and the pending one", async () => {
	const { text, buttons } = await line("me", {
		model: { provider: "work", modelId: "m" },
		effort: "high",
		pending: { model: { provider: "home", modelId: "m" } },
	});
	expect(text).toContain("m · work· High→");
	expect(buttons).toEqual(["m · home", "Reasoning effort: High"]);
});
