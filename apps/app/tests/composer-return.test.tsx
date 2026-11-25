import { expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
	localStorage: dom.window.localStorage, addEventListener: dom.window.addEventListener.bind(dom.window),
	removeEventListener: dom.window.removeEventListener.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true });
const { useLocalStorage } = await import("../../../packages/ui/src/hooks/use-local-storage");
mock.module("@ace/ui", () => ({ useLocalStorage }));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useChatMode, beginPlanApproval } = await import("../src/composer-mode");

// Real React subscriptions and browser storage: a successful action in another mounted surface
// must update the composer without dropping its draft or clobbering a later local choice.
test("approval publishes the restored mode to a mounted composer and preserves its draft", async () => {
	let change!: (mode: string, chosen?: boolean) => void;
	function Composer() {
		const [mode, set] = useChatMode("mounted", 1, "plan");
		change = set;
		return <><output>{mode}</output><textarea defaultValue="Keep this draft" /></>;
	}
	const element = document.body.appendChild(document.createElement("div"));
	const root = createRoot(element);
	try {
		await act(async () => root.render(<Composer />));
		await act(async () => change("chat", true));
		await act(async () => change("plan", true));
		const returned = beginPlanApproval("mounted", 1);
		expect(element.querySelector("output")!.textContent).toBe("plan");
		await act(async () => returned());
		expect(element.querySelector("output")!.textContent).toBe("chat");
		expect(element.querySelector("textarea")!.value).toBe("Keep this draft");
		expect(JSON.parse(localStorage.getItem("ace:mode:/channels/mounted/1")!)).toBe("chat");
		await act(async () => change("plan", true));
		const late = beginPlanApproval("mounted", 1);
		await act(async () => change("ace", true));
		await act(async () => late());
		expect(element.querySelector("output")!.textContent).toBe("ace");
	} finally { await act(async () => root.unmount()); element.remove(); }
});
