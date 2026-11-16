import {expect, test} from "bun:test";
import {ExtensionRequestSchema as publicSchema, MUTATING, HOST_ONLY} from "../src/operations";
import {ExtensionRequestSchema} from "../src/operations-protocol";

test("runtime and data-only operation exports share one strict schema", () => {
	expect(publicSchema).toBe(ExtensionRequestSchema);
	const valid = [
		{op: "review-origin"},
		{op: "review-origin-set", chat: 1, items: [{provider: "fixture", id: "opaque"}], forkedFrom: {channel: "parent", chat: 1}},
		{op: "planning-read", request: {op: "search", connection: "connection", query: "scope"}},
		{op: "planning-select", chat: 1, author: "owner", connection: "connection", issue: "issue"},
		{op: "planning-clear", chat: 1, author: "owner"},
		{op: "planning-state", chat: 1},
		{op: "planning-reviewed", chat: 1, source: null, review: {reference: "records", base: "a".repeat(40), head: "b".repeat(40)}},
	];
	for (const value of valid) {
		expect(ExtensionRequestSchema.parse(value)).toMatchObject(value);
		expect(ExtensionRequestSchema.safeParse({...value, unexpected: true}).success).toBe(false);
	}
	expect([...MUTATING]).toEqual(["review-origin-set", "planning-select", "planning-clear", "planning-reviewed"]);
	expect([...HOST_ONLY]).toEqual(["review-origin-set", "planning-reviewed"]);
	expect(ExtensionRequestSchema.parse({op: "planning-clear"})).toEqual({op: "planning-clear", author: ""});
	expect(ExtensionRequestSchema.safeParse({op: "planning-select", connection: "", issue: "issue"}).success).toBe(false);
});
