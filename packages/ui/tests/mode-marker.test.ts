import { expect, test } from "bun:test";

import { type Cause, nextMode } from "../src/components/composer/mode-marker";

// Why: every change of mode other than the menu's goes through this rule. If a draft, a key or a
// recalled message moved the composer out of Plan, the next message would take the chat out of
// plan mode, and nothing on screen would say so.

type Mode = { id: string; mention?: string; kind?: "chat" | "terminal" };
// The app's modes for the owner, or a teammate the owner lets ask the agent.
const modes: Mode[] = [{ id: "chat" }, { id: "plan" }, { id: "ace", mention: "neuve" }];
// A teammate without access has Chat alone.
const blocked: Mode[] = [{ id: "chat" }];
const mentioning = (mode: Mode) => mode.mention === "neuve";
const causes: Record<string, Cause<Mode>> = {
	"a draft with the agent's mention": { kind: "draft", has: mentioning },
	"a draft without it": { kind: "draft", has: () => false },
	"a restored draft": { kind: "restore" },
	Escape: { kind: "escape", double: false },
	"a double Escape": { kind: "escape", double: true },
	"!": { kind: "bang" },
	"a recalled agent message": { kind: "recall", mode: "ace" },
	"a recalled Chat message": { kind: "recall", mode: "chat" },
	"a recalled message from before modes were stored": { kind: "recall" },
};

for (const [name, cause] of Object.entries(causes)) {
	test(`${name} never moves Plan`, () => {
		expect(nextMode(modes, "plan", cause)).toBe("plan");
	});
}

test("! never moves Plan, even where the composer has a terminal mode", () => {
	const terminal = [...modes, { id: "term", kind: "terminal" as const }];
	expect(nextMode(terminal, "plan", { kind: "bang" })).toBe("plan");
	expect(nextMode(terminal, "chat", { kind: "bang" })).toBe("term");
});

test("a recalled Plan message never moves the other modes into Plan", () => {
	expect(nextMode(modes, "chat", { kind: "recall", mode: "plan" })).toBe("chat");
	expect(nextMode(modes, "ace", { kind: "recall", mode: "plan" })).toBe("ace");
	expect(nextMode(blocked, "chat", { kind: "recall", mode: "plan" })).toBe("chat");
});

// Why: the saved draft is the channel's and the mode is each chat's. If a draft restored when a
// chat opens set the mode, one chat's draft would overwrite another chat's remembered mode.
test("a restored draft moves no mode", () => {
	for (const mode of ["chat", "ace"]) expect(nextMode(modes, mode, { kind: "restore" })).toBe(mode);
});

// Why: Chat and the agent's mode must otherwise keep today's behaviour exactly.
test("Chat and the agent's mode move as before", () => {
	expect(nextMode(modes, "chat", causes["a draft with the agent's mention"]!)).toBe("ace");
	expect(nextMode(modes, "ace", causes["a draft without it"]!)).toBe("chat");
	expect(nextMode(modes, "ace", causes["a draft with the agent's mention"]!)).toBe("ace");
	expect(nextMode(modes, "ace", causes.Escape!)).toBe("chat");
	expect(nextMode(modes, "chat", causes.Escape!)).toBe("chat");
	expect(nextMode(modes, "chat", causes["a double Escape"]!)).toBe("ace");
	expect(nextMode(modes, "chat", causes["!"]!)).toBe("chat");
	expect(nextMode(modes, "chat", causes["a recalled agent message"]!)).toBe("ace");
	expect(nextMode(modes, "ace", causes["a recalled Chat message"]!)).toBe("chat");
	expect(nextMode(modes, "ace", causes["a recalled message from before modes were stored"]!)).toBe("chat");
	expect(nextMode(blocked, "chat", causes["a draft with the agent's mention"]!)).toBe("chat");
});
