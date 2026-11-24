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
import { AccountStatus } from "@neuve/runtime/status";

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

test("an account whose saved status needs a newer build shows no check time", async () => {
	const text = await card(accountFixtures.needsNewerBuild);
	expect(text).toContain("Couldn't check this account");
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

// Why: an account with no folder of its own was described as signed in through "not this account".
// The card names where the sign-in comes from instead.
test("a sign-in from outside Claude Code's login names its source", async () => {
	const { accountDescription } = await import("../src/accounts-copy");
	const signedIn = { state: "signed-in", sourceMatchesAccount: false } as const;
	expect(
		accountDescription("claude-subscription", { ...signedIn, credentialSource: "environment" }),
	).toBe("Signed in through a credential from the environment, not a Claude Code login");
	expect(
		accountDescription("claude-subscription", { ...signedIn, credentialSource: "credential-helper" }),
	).toBe("Signed in through a credential helper, not a Claude Code login");
});

// Why: the owner saw one ChatGPT plan listed three times, once per runtime that reaches it.
test("accounts of one sign-in show as one row, and a different sign-in keeps its own", async () => {
	const chatgpt = (name: string, signIn: AccountStatus["signIn"], limits: AccountStatus["limits"] = []) =>
		AccountStatus.parse({ name, kind: "chatgpt-subscription", signIn, limits, checkedAt: "2026-11-24T10:00:00Z" });
	const resetsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
	const one = [
		chatgpt("chatgpt", { state: "signed-in", email: "alex@example.com" }),
		chatgpt("codex", { state: "signed-in" }, [{ window: "weekly", status: "allowed", utilization: 0.35, resetsAt }]),
		chatgpt("main", { state: "not-signed-in", hint: { kind: "command", command: "neuve auth login", account: "main" } }),
	];
	const text = await card(one);
	expect(text.match(/ChatGPT/g)).toHaveLength(1);
	expect(text).toContain("Signed in as alex@example.com");
	expect(text).toContain("Weekly limit: 35% used");
	expect(text).not.toContain("neuve auth login");

	const two = await card([...one, chatgpt("work", { state: "signed-in", email: "sam@example.com" })]);
	expect(two).toContain("ChatGPT · chatgpt");
	expect(two).toContain("ChatGPT · work");
});
