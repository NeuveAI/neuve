import { expect, test } from "bun:test";

import { composerMode, forgetChannelMode, modeKey } from "../src/composer-mode";

// Why this test exists: if two chats of a channel shared the remembered mode, a composer left on
// Plan in the planning chat would open the channel's next chat in Plan, with nothing to say why.

test("each chat of a channel remembers its own mode", () => {
	expect(modeKey("c1", 1)).not.toBe(modeKey("c1", 2));
	expect(modeKey("c1", 1)).not.toBe(modeKey("c2", 1));
	// Not the key a channel's mode was kept under, which would bring it back to every chat.
	expect(modeKey("c1", 1)).not.toBe("ace:mode:/channels/c1");
});

// A browser that never chose a mode for a planning chat must open it in Plan, even when the chat's
// mode is reported after the composer mounted; otherwise its next send would leave plan mode.
test("a chat this browser hasn't remembered opens in its stored mode", () => {
	expect(composerMode(null, "plan")).toBe("plan");
	expect(composerMode(null, undefined)).toBe("ace");
	expect(composerMode("chat", "plan")).toBe("chat");
	expect(composerMode("plan", undefined)).toBe("plan");
});

test("the channel's old mode is removed and every chat's stays", () => {
	const stored = new Map([
		["ace:mode:/channels/c1", '"chat"'],
		[modeKey("c1", 1), '"plan"'],
		[modeKey("c1", 2), '"ace"'],
		["ace:mode:/channels/c2", '"ace"'],
	]);
	forgetChannelMode("c1", { removeItem: (key) => void stored.delete(key) });
	expect([...stored.keys()]).toEqual([modeKey("c1", 1), modeKey("c1", 2), "ace:mode:/channels/c2"]);
});

test("storage that refuses access leaves the composer working", () => {
	expect(() =>
		forgetChannelMode("c1", {
			removeItem: () => {
				throw new Error("SecurityError");
			},
		})
	).not.toThrow();
});
