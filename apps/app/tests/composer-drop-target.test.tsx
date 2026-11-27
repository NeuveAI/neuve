import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";

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
	matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
});
for (const name of ["customElements", "HTMLElement", "CSSStyleSheet", "ShadowRoot", "DocumentFragment", "HTMLTextAreaElement", "Element", "Node", "Text", "Range", "NodeFilter", "Event", "MutationObserver"]) {
	Object.assign(globalThis, { [name]: window[name as keyof typeof window] });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ChatComposer } = await import("@ace/ui");

// Why: every keystroke re-renders the composer. When its drop target re-subscribed on each render, the
// teardown set state from inside the commit, and a fast typist's fifty-first character threw React's
// "Maximum update depth exceeded". The drop target must subscribe once for the composer's life.
test("re-rendering the composer keeps its drop target to one subscription", () => {
	let subscribed = 0;
	const add = document.addEventListener;
	document.addEventListener = function (this: Document, ...args: Parameters<typeof add>) {
		if (args[0] === "dragenter") subscribed++;
		return add.apply(this, args);
	};

	const element = document.createElement("div");
	document.body.append(element);
	const root = createRoot(element);
	const render = (busy: boolean) =>
		act(() =>
			root.render(
				<ChatComposer
					scope="/channels/c1/1"
					modes={[{ id: "chat", name: "Chat" }, { id: "plan", name: "Plan" }]}
					mode="plan"
					onModeChange={() => {}}
					attachments={[]}
					onAttachmentsChange={() => {}}
					busy={busy}
					onSend={() => {}}
				/>,
			)
		);
	render(false);
	for (let i = 0; i < 60; i++) render(i % 2 === 0);
	act(() => root.unmount());
	document.addEventListener = add;

	expect(subscribed).toBe(1);
});
