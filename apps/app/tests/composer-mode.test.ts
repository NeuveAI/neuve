import { beforeEach, expect, mock, test } from "bun:test";

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
		const value: T = raw === undefined ? fallback : JSON.parse(raw);
		const set = (next: T | ((prev: T) => T)) =>
			stored.set(key, JSON.stringify(typeof next === "function" ? (next as (prev: T) => T)(value) : next));
		return [value, set];
	},
}));
// The app keeps one composer across a channel's chats; its state is this one slot.
let slot: unknown;
const react = await import("react");
mock.module("react", () => ({
	...react,
	default: react,
	useCallback: <T>(callback: T) => callback,
	useState<T>(initial?: T) {
		if (slot === undefined) slot = initial;
		return [slot, (next: T) => void (slot = next)];
	},
}));
beforeEach(() => void (slot = undefined));
const { askMode, usePlanReturn, useChatMode } = await import("../src/composer-mode");

// Why: if two chats of a channel shared the remembered mode, a composer left on Plan in the
// planning chat would open the channel's next chat in Plan, and nothing would say why.
test("a composer left on Plan in one chat leaves the channel's other chats be", () => {
	useChatMode("c1", 1, undefined)[1]("plan", true);
	slot = undefined;
	expect(useChatMode("c1", 1, undefined)[0]).toBe("plan");
	expect(useChatMode("c1", 2, undefined)[0]).toBe("ace");
	expect(useChatMode("c2", 1, undefined)[0]).toBe("ace");
});

// Why: a browser that never chose a mode for a planning chat must not take it out of plan mode
// on its next send, so it opens in the chat's stored mode until a person chooses one here.
test("a chat this browser hasn't remembered opens in its stored mode, and a choice here wins", () => {
	expect(useChatMode("c3", 1, "plan")[0]).toBe("plan");
	useChatMode("c3", 1, "plan")[1]("chat", true);
	slot = undefined;
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

// Why: approving takes the planning chat out of Plan, so the approving person's composer goes back
// to the mode it left for Plan; one the person has since moved out of Plan stays where they put it.
test("approving returns the composer to the mode it had before Plan, and no further", () => {
	for (const before of ["chat", "ace"]) {
		const [, change] = useChatMode(before, 1, "ace");
		change(before, true);
		useChatMode(before, 1, "ace")[1]("plan", true);
		slot = undefined;
		expect(useChatMode(before, 1, "plan")[0]).toBe("plan");
		usePlanReturn(before, 1)();
		expect(useChatMode(before, 1, "ace")[0]).toBe(before);
	}
	useChatMode("moved", 1, "ace")[1]("plan", true);
	useChatMode("moved", 1, "plan")[1]("ace", true);
	usePlanReturn("moved", 1)();
	expect(useChatMode("moved", 1, "ace")[0]).toBe("ace");
	// A chat that opened in Plan from its stored mode, with nothing chosen here, returns to the agent's.
	usePlanReturn("seeded", 1)();
	expect(useChatMode("seeded", 1, "ace")[0]).toBe("ace");
});
