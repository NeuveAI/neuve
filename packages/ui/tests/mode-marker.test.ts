import { expect, test } from "bun:test";

import { held, markedMode } from "../src/components/composer/mode-marker";

// Why this test exists: a draft that moved the composer out of Plan would send the next message
// in the agent's mode and take the chat out of plan mode, and nothing on screen would say so.

const chat = { id: "chat" };
const plan = { id: "plan" };
const agent = { id: "ace", mention: "neuve" };
const modes = [chat, plan, agent];
const drafts = {
	empty: () => false,
	"with the agent's mention": (mode: { mention?: string }) => mode.mention === "neuve",
};

for (const [name, has] of Object.entries(drafts)) {
	test(`a draft ${name} never moves Plan`, () => {
		expect(markedMode(modes, "plan", has)).toBe("plan");
		// A teammate's composer offers no agent mention, so its modes carry no marker at all.
		expect(markedMode([chat, plan], "plan", has)).toBe("plan");
	});
}

test("only Plan is held; the other modes keep today's markers", () => {
	expect(held("plan")).toBe(true);
	expect(held("chat")).toBe(false);
	expect(held("ace")).toBe(false);
	// Chat moves to the agent when the draft mentions it, and back when the marker goes.
	expect(markedMode(modes, "chat", drafts["with the agent's mention"])).toBe("ace");
	expect(markedMode(modes, "ace", drafts.empty)).toBe("chat");
	expect(markedMode(modes, "ace", drafts["with the agent's mention"])).toBe("ace");
	expect(markedMode(modes, "chat", drafts.empty)).toBe("chat");
});
