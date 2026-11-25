import { expect, mock, test } from "bun:test";

// The browser's storage, as the composer's own hook reads and writes it.
const stored = new Map<string, string>();
Object.assign(globalThis, {
	localStorage: {
		getItem: (key: string) => stored.get(key) ?? null,
		setItem: (key: string, value: string) => void stored.set(key, value),
		removeItem: (key: string) => void stored.delete(key),
	},
});
mock.module("@ace/ui", () => ({
	useLocalStorage<T>(key: string, fallback: T) {
		const raw = stored.get(key);
		return [raw === undefined ? fallback : JSON.parse(raw), (value: T) => stored.set(key, JSON.stringify(value))];
	},
}));
// Hook calculations use the real shared per-chat selection store.
const react = await import("react");
mock.module("react", () => ({
	...react,
	default: react,
	useSyncExternalStore<T>(_subscribe: unknown, snapshot: () => T) { return snapshot(); },
}));
const { askMode, useChatMode, beginPlanApproval } = await import("../src/composer-mode");

// Why: if two chats of a channel shared the remembered mode, a composer left on Plan in the
// planning chat would open the channel's next chat in Plan, and nothing would say why.
test("a composer left on Plan in one chat leaves the channel's other chats be", () => {
	useChatMode("c1", 1, undefined)[1]("plan", true);
	expect(useChatMode("c1", 1, undefined)[0]).toBe("plan");
	expect(useChatMode("c1", 2, undefined)[0]).toBe("ace");
	expect(useChatMode("c2", 1, undefined)[0]).toBe("ace");
});

// Why: a browser that never chose a mode for a planning chat must not take it out of plan mode
// on its next send, so it opens in the chat's stored mode until a person chooses one here.
test("a chat this browser hasn't remembered opens in its stored mode, and a choice here wins", () => {
	expect(useChatMode("c3", 1, "plan")[0]).toBe("plan");
	useChatMode("c3", 1, "plan")[1]("chat", true);
	expect(useChatMode("c3", 1, "plan")[0]).toBe("chat");
});

// Why: in a fresh browser the composer's mount, before the chat's details arrive, moved the mode
// to "chat" and back to "ace" from its empty draft, and that was remembered. The planning chat then
// opened in the agent's mode, and its next send took it out of plan mode. These calls are the ones
// logged in the running app.
test("nothing but a menu choice is remembered, and nothing moves the mode before the stored one is known", () => {
	const [, change] = useChatMode("c5", 1, undefined);
	change("chat");
	change("chat");
	change("ace");
	expect(stored.has("ace:mode:/channels/c5/1")).toBe(false);
	expect(useChatMode("c5", 1, "plan")[0]).toBe("plan");
	// Once it is known, a draft's marker moves the mode while the chat is open, as on main, unremembered.
	useChatMode("c5", 1, "ace")[1]("chat");
	expect(useChatMode("c5", 1, "ace")[0]).toBe("chat");
	expect(stored.has("ace:mode:/channels/c5/1")).toBe(false);
});

// Why: the old per-channel value, read by any chat, would bring one chat's mode back to all of them.
test("the channel's old remembered mode is removed and each chat's stays", () => {
	stored.set("ace:mode:/channels/c4", '"chat"');
	stored.set("ace:mode:/channels/c4/1", '"plan"');
	expect(useChatMode("c4", 2, undefined)[0]).toBe("ace");
	expect(stored.has("ace:mode:/channels/c4")).toBe(false);
	expect(useChatMode("c4", 1, undefined)[0]).toBe("plan");
});

// Why: a channel that predates the mode refuses a message carrying one, so a message in the mode
// the chat already has must stay the plain ask; only a change of mode carries it.
test("an ask carries a mode only when it changes the chat's", () => {
	expect(askMode("ace", undefined)).toBeUndefined();
	expect(askMode("ace", "ace")).toBeUndefined();
	expect(askMode("plan", "plan")).toBeUndefined();
	expect(askMode("plan", undefined)).toBe("plan");
	expect(askMode("ace", "plan")).toBe("ace");
	expect(askMode("chat", "plan")).toBeUndefined();
});

// Approval callbacks are armed only at the person's action and committed only on success.
test.each(["chat", "ace"])("approval returns to %s, including a revision and repeated Plan selection", returning => {
	const channel = `return-${returning}`;
	for (let revision = 0; revision < 2; revision++) {
		useChatMode(channel, 1, "ace")[1](returning, true);
		useChatMode(channel, 1, "ace")[1]("plan", true);
		useChatMode(channel, 1, "plan")[1]("plan", true);
		const success = beginPlanApproval(channel, 1);
		expect(useChatMode(channel, 1, "plan")[0]).toBe("plan");
		success();
		expect(useChatMode(channel, 1, "plan")[0]).toBe(returning);
		expect(JSON.parse(stored.get(`ace:mode:/channels/${channel}/1`)!)).toBe(returning);
		success();
		expect(useChatMode(channel, 1, "plan")[0]).toBe(returning);
	}
});

test("temporary choices are captured before Plan and isolated from another chat", () => {
	useChatMode("temporary", 1, "ace")[1]("chat");
	useChatMode("temporary", 1, "ace")[1]("plan", true);
	expect(JSON.parse(stored.get("ace:plan-return:/channels/temporary/1")!)).toBe("chat");
	useChatMode("temporary", 2, "plan");
	beginPlanApproval("temporary", 1)();
	expect(useChatMode("temporary", 1, "ace")[0]).toBe("chat");
	expect(useChatMode("temporary", 2, "plan")[0]).toBe("plan");
});

test("a failed approval leaves Plan, and a late success cannot overwrite a newer choice or session", () => {
	useChatMode("late", 1, "ace")[1]("plan", true);
	const failed = beginPlanApproval("late", 1);
	// A rejection never calls the returned success operation.
	expect(useChatMode("late", 1, "plan")[0]).toBe("plan");
	useChatMode("late", 1, "plan")[1]("chat", true);
	failed();
	expect(useChatMode("late", 1, "plan")[0]).toBe("chat");
	useChatMode("late", 1, "plan")[1]("plan", true);
	const late = beginPlanApproval("late", 1);
	useChatMode("late", 1, "plan")[1]("ace", true);
	useChatMode("late", 1, "plan")[1]("plan", true);
	late();
	expect(useChatMode("late", 1, "plan")[0]).toBe("plan");
});

test("older saved Plan without a return choice falls back to the agent mode", () => {
	stored.set("ace:mode:/channels/older/1", '"plan"');
	expect(useChatMode("older", 1, "plan")[0]).toBe("plan");
	beginPlanApproval("older", 1)();
	expect(useChatMode("older", 1, "plan")[0]).toBe("ace");
});
