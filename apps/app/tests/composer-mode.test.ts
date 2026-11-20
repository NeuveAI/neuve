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
const { askMode, useChatMode } = await import("../src/composer-mode");

// Why: if two chats of a channel shared the remembered mode, a composer left on Plan in the
// planning chat would open the channel's next chat in Plan, and nothing would say why.
test("a composer left on Plan in one chat leaves the channel's other chats be", () => {
	const [, choose] = useChatMode("c1", 1, undefined);
	choose("plan");
	expect(useChatMode("c1", 1, undefined)[0]).toBe("plan");
	expect(useChatMode("c1", 2, undefined)[0]).toBe("ace");
	expect(useChatMode("c2", 1, undefined)[0]).toBe("ace");
});

// Why: a browser that never chose a mode for a planning chat must not take it out of plan mode
// on its next send, so it opens in the chat's stored mode until this browser chooses one.
test("a chat this browser hasn't remembered opens in its stored mode, and a choice here wins", () => {
	expect(useChatMode("c3", 1, "plan")[0]).toBe("plan");
	useChatMode("c3", 1, "plan")[1]("chat");
	expect(useChatMode("c3", 1, "plan")[0]).toBe("chat");
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
