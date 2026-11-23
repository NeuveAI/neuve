// Why: the owner saw a never-checked account card show a check time from 1970, and a weekly
// limit drawn as current three days after it reset. The card must not say either.
import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.window.document,
	navigator: dom.window.navigator,
	HTMLElement: dom.window.HTMLElement,
	Node: dom.window.Node,
	customElements: dom.window.customElements,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Accounts } = await import("../src/accounts");
const { accountFixtures } = await import("../src/accounts.fixtures");
import type { AccountStatus } from "@neuve/runtime/status";

async function card(accounts: AccountStatus[]) {
	const element = document.body.appendChild(document.createElement("div"));
	const root = createRoot(element);
	await act(async () => root.render(<Accounts accounts={accounts} />));
	const text = element.textContent ?? "";
	await act(async () => root.unmount());
	element.remove();
	return text;
}

test("a never-checked account shows no check time", async () => {
	const text = await card(accountFixtures.unknown);
	expect(text).toContain("Not checked yet");
	expect(text).not.toContain("Checked");
});

test("an account whose check failed still shows when it was checked", async () => {
	expect(await card(accountFixtures.checkFailed)).toContain("Checked");
});

test("a limit whose reset has passed is not drawn, and a live one is", async () => {
	const text = await card(accountFixtures.resetPassed);
	expect(text).not.toContain("Weekly limit");
	expect(text).toContain("5-hour limit: 20% used · resets");
});
