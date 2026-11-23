// Clients cross this boundary to answer an approval request, so silently accepting a malformed answer would go unnoticed.
import { expect, test } from "bun:test";
import { EventSchema } from "../src/frame";
import { parseRequest } from "../src/parse";
import type { Event } from "../src/protocol";

const answer = { op: "approval-answer", chat: 2, author: "claimed", requestId: "request-1", decision: "allow" };

test("an approval answer uses the verified author", () => {
	expect(parseRequest(answer, "owner")).toEqual({
		op: "approval-answer",
		chat: 2,
		author: "owner",
		requestId: "request-1",
		decision: "allow",
	});
	expect(parseRequest({ op: "approval-answer", author: "claimed", requestId: "request-1", decision: "deny" }, "owner")).toEqual({
		op: "approval-answer",
		author: "owner",
		requestId: "request-1",
		decision: "deny",
	});
});

test("malformed approval answers are refused at the request boundary", () => {
	const refused: [unknown, string][] = [
		[{ op: "approval-answer", author: "claimed", decision: "allow" }, "at requestId"],
		[{ ...answer, requestId: "" }, "at requestId"],
		[{ ...answer, decision: "skip" }, "at decision"],
		[{ ...answer, extra: true }, 'Unrecognized key: "extra"'],
		[{ op: "approval-answer", requestId: "request-1", decision: "allow" }, "at author"],
		[{ ...answer, author: "" }, "at author"],
	];
	for (const [value, message] of refused) {
		expect(() => parseRequest(value, "owner")).toThrow(message);
	}
});

test("clients can set attended on ask and opt in to approval requests on watch", () => {
	for (const attended of [true, false]) {
		expect(parseRequest({ op: "ask", author: "claimed", text: "Continue", attended }, "owner")).toEqual({
			op: "ask", author: "owner", text: "Continue", attended,
		});
	}
	expect(parseRequest({ op: "watch", chat: 2, approvals: true }, "owner")).toEqual({
		op: "watch", chat: 2, approvals: true,
	});
});

test("the approval requests event preserves the complete list and its order across JSON", () => {
	const event: Extract<Event, { kind: "approval-requests" }> = {
		kind: "approval-requests",
		chat: 2,
		requests: [
			{
				requestId: "1", callId: "c1", work: "command", input: { command: "ls" }, openedAt: 100,
				state: { kind: "closed", reason: "turn-ended" },
			},
			{
				requestId: "2", callId: "c2", work: "file-change", input: { files: ["note.md"] }, openedAt: 200,
				state: { kind: "closed", reason: "runtime-resolved" },
			},
			{
				requestId: "3", callId: "c3", work: "web-search", input: "weather", openedAt: 300,
				state: { kind: "closed", reason: "stopped" },
			},
			{
				requestId: "4", callId: "c4", work: "tool", input: null, openedAt: 400,
				state: { kind: "closed", reason: "restarted" },
			},
			{
				requestId: "5", callId: "c5", work: "command", input: { command: "ls" }, openedAt: 500,
				state: { kind: "closed", reason: "message", by: "owner" },
			},
			{
				requestId: "6", callId: "c6", toolName: "message", input: { text: "Draft ready" }, openedAt: 600,
				state: { kind: "answered", by: "owner", at: 650, decision: "deny" },
			},
			{
				requestId: "7", callId: "c6", work: "command", input: { command: "pwd" }, openedAt: 700,
				state: { kind: "open" },
			},
		],
	};
	expect(EventSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
});

test("a closed reason is refused on an answered approval request", () => {
	const event = {
		kind: "approval-requests",
		chat: 2,
		requests: [{
			requestId: "1",
			callId: "c1",
			work: "command",
			input: null,
			openedAt: 100,
			state: { kind: "answered", by: "owner", at: 200, decision: "allow", reason: "stopped" },
		}],
	};
	expect(EventSchema.safeParse(event).success).toBe(false);
});
