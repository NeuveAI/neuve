// Why: two agents of one role are told apart by their task, read short and plain. A part that is a
// path goes by its last segment, and by more of the path only where two would read alike. The
// mention's chip reads the same as the line, while the text keeps the mention's name, which is what
// a posted message and its drawn mentions match on.
import { expect, test } from "bun:test";

import type { Build } from "@ace/channel/protocol";
import { agentName, mentionable } from "../src/build-card";

const implementer = (part?: string) => ({ role: "implementer" as const, ...(part ? { part } : {}) });

test("an agent's part reads short, with more of its path only where two collide", () => {
	expect(agentName(implementer("frontend"))).toBe("Implementer · frontend");
	expect(agentName(implementer("apps/app/src/listed-models.ts"), [implementer("packages/channel/src/models.ts")]))
		.toBe("Implementer · listed-models.ts");
	const one = implementer("apps/app/src/models.ts");
	const two = implementer("packages/channel/src/models.ts");
	expect(agentName(one, [one, two])).toBe("Implementer · app/src/models.ts");
	expect(agentName(two, [one, two])).toBe("Implementer · channel/src/models.ts");
	// A reviewer's part is told apart among reviewers only.
	expect(agentName(one, [one, { role: "reviewer", part: "packages/x/models.ts" }])).toBe("Implementer · models.ts");
});

test("a mention's chip reads as the agent's line, and its name stays the mention's token", () => {
	const build: Build = {
		id: "b",
		chat: 1,
		plan: { id: "p", hash: "h", title: "Retry", call: "w" },
		approved: { by: "me", at: 0 },
		state: { kind: "started" },
		agents: [{ chat: 2, role: "implementer", part: "apps/app/src/listed-models.ts", started: 0, state: "running" }],
	};
	const [mention] = mentionable([build]);
	expect(mention?.name).toBe("implementer-apps-app-src-listed-models-ts");
	expect(mention?.label).toBe("Implementer · listed-models.ts");
	expect(mention?.agent?.name).toBe("Implementer · listed-models.ts");
});
