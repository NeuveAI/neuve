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

const { act, createRef } = await import("react");
const { flushSync } = await import("react-dom");
const { createRoot } = await import("react-dom/client");
const { ChatComposer } = await import("@ace/ui");
type Handle = import("@ace/ui").ChatComposerHandle;

// Why: each keystroke commits at once. When the composer's drop target re-subscribed on every render,
// its teardown left another render pending after each keystroke, and a fast typist's fifty-first
// character threw React's "Maximum update depth exceeded".
test("typing a long message quickly commits every keystroke without an update loop", async () => {
	const element = document.createElement("div");
	document.body.append(element);
	const root = createRoot(element);
	const composer = createRef<Handle>();
	act(() =>
		root.render(
			<ChatComposer
				ref={composer}
				scope="/channels/c1/1"
				modes={[{ id: "chat", name: "Chat" }, { id: "plan", name: "Plan" }]}
				mode="plan"
				onModeChange={() => {}}
				attachments={[]}
				onAttachmentsChange={() => {}}
				onSend={() => {}}
			/>,
		)
	);

	const errors: unknown[] = [];
	const report = console.error;
	console.error = (...args: unknown[]) => void errors.push(args[0]);
	// Keystrokes arrive from the browser, outside act, each rendered before the next.
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
	try {
		for (const key of "a".repeat(80)) flushSync(() => composer.current!.insert(key));
		await new Promise((resolve) => setTimeout(resolve, 50));
	} finally {
		Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
		console.error = report;
	}

	expect(errors).toEqual([]);
	expect(composer.current!.get()?.textContent).toBe("a".repeat(80));
	act(() => root.unmount());
});
