// Why: the work log has a line for the main agent of each chat that planned. When two chats have
// planned, a person must be able to tell those lines apart before choosing one, so they must not
// read the same.
import { expect, test } from "bun:test";

import type { Build } from "@ace/channel/protocol";
import { mainLines } from "../src/build-card";

const build = (chat: number, agent: number, title: string, at = chat): Build => ({
	id: `${chat}:${at}`,
	chat,
	plan: { id: `p${chat}`, hash: "h", title, call: "w" },
	approved: { by: "me", at },
	state: { kind: "started" },
	agents: [{ chat: agent, role: "implementer", started: 0, state: "running" }],
});
const read = (lines: ReturnType<typeof mainLines>) => lines.map(({ name, caption }) => [name, caption].join(" "));

test("two planning chats get two main agent lines that read differently", () => {
	const lines = read(mainLines([build(1, 3, "Retry exports"), build(2, 4, "Rename the picker")], [], ""));
	expect(lines.length).toBe(2);
	expect(new Set(lines).size).toBe(2);
	// One chat that planned twice keeps one line, named only Neuve.
	expect(read(mainLines([build(1, 3, "Retry exports"), build(1, 4, "Retry again", 9)], [], ""))).toEqual(["Neuve "]);
});
