import { describe, expect, test } from "bun:test";

import { EventSchema } from "../src/frame";
import { parseRequest } from "../src/parse";

const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

describe("wire effort", () => {
	for (const op of ["ask", "select"]) {
		for (const effort of levels) {
			test(`${op} preserves ${effort}`, () => {
				const request = { op, effort, ...(op === "ask" ? { text: "hello" } : {}) };
				expect<unknown>(parseRequest(request, "owner")).toEqual({ ...request, author: "owner" });
			});
		}

		test(`${op} allows an omitted effort`, () => {
			const request = { op, ...(op === "ask" ? { text: "hello" } : {}) };
			expect<unknown>(parseRequest(request, "owner")).toEqual({ ...request, author: "owner" });
		});

		for (const effort of ["extreme", "HIGH", "", " high", null, 1, true, [], {}]) {
			test(`${op} refuses effort ${JSON.stringify(effort)}`, () => {
				const request = { op, effort, ...(op === "ask" ? { text: "hello" } : {}) };
				expect(() => parseRequest(request, "owner")).toThrow("→ at effort");
			});
		}
	}
	for (const effort of levels) {
		test(`agent event preserves ${effort}`, () => {
			const event = { kind: "agent", chat: 0, model: { provider: "faux", modelId: "faux" }, effort };
			expect<unknown>(EventSchema.parse(event)).toEqual(event);
		});
	}

	for (const effort of ["extreme", "HIGH", "", " high", null, 1, true, [], {}, undefined]) {
		test(`agent event refuses effort ${JSON.stringify(effort)}`, () => {
			const event = { kind: "agent", chat: 0, model: { provider: "faux", modelId: "faux" }, effort };
			expect(EventSchema.safeParse(event).success).toBe(false);
		});
	}
});
