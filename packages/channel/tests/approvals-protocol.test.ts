// Clients cross this boundary to answer an approval request, so silently accepting a malformed answer would go unnoticed.
import { expect, test } from "bun:test";
import { EventSchema } from "../src/frame";
import { parseRequest } from "../src/parse";
import type { ApprovalAsked, Event } from "../src/protocol";

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
				asked: { kind: "command", command: "ls", folder: "/work" },
				state: { kind: "closed", reason: "turn-ended" },
			},
			{
				requestId: "2", callId: "c2", work: "file-change", input: { files: ["note.md"] }, openedAt: 200,
				asked: { kind: "file-change", changes: null },
				state: { kind: "closed", reason: "runtime-resolved" },
			},
			{
				requestId: "3", callId: "c3", work: "web-search", input: "weather", openedAt: 300,
				asked: { kind: "unrecognised" },
				state: { kind: "closed", reason: "stopped" },
			},
			{
				requestId: "4", callId: "c4", work: "tool", input: null, openedAt: 400,
				asked: { kind: "server-prompt", server: "docs", message: "Sign in", url: "https://example.test" },
				state: { kind: "closed", reason: "restarted" },
			},
			{
				requestId: "5", callId: "c5", work: "command", input: { command: "ls" }, openedAt: 500,
				asked: { kind: "wider-access", paths: [{ target: { kind: "root" }, access: "write" }], network: true },
				state: { kind: "closed", reason: "message", by: "owner" },
			},
			{
				requestId: "6", callId: "c6", toolName: "message", input: { text: "Draft ready" }, openedAt: 600,
				asked: { kind: "unrecognised" },
				state: { kind: "answered", by: "owner", at: 650, decision: "deny" },
			},
			{
				requestId: "7", callId: "c6", work: "command", input: { command: "pwd" }, openedAt: 700,
				asked: { kind: "command", command: "pwd", folder: "/work" },
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
			asked: { kind: "unrecognised" },
			openedAt: 100,
			state: { kind: "answered", by: "owner", at: 200, decision: "allow", reason: "stopped" },
		}],
	};
	expect(EventSchema.safeParse(event).success).toBe(false);
});

test("an approval snapshot requires and preserves its description", () => {
	const record = { requestId: "1", callId: "c1", work: "command", input: null, openedAt: 1, state: { kind: "open" } };
	const event = { kind: "approval-requests", chat: 2 };
	expect(EventSchema.safeParse({ ...event, requests: [record] }).success).toBe(false);
	const shapes: ApprovalAsked[] = [
		{ kind: "command", command: "echo\n", folder: "/work", network: { host: "a.test", protocol: "socks5-udp" }, reason: " reason " },
		{ kind: "file-change", changes: null },
		{ kind: "file-change", changes: [
			{ path: "a", kind: "add", diff: "+a" },
			{ path: "b", kind: "delete", diff: "-b" },
			{ path: "c", kind: "update", newPath: "d", diff: "-c\n+d" },
		] },
		{ kind: "wider-access", network: false, folder: "/work", globDepthLimit: 3, paths: [
			{ access: "write", target: { kind: "path", path: "/" } },
			{ access: "deny", target: { kind: "glob", pattern: "**/.env" } },
			{ access: "write", target: { kind: "root" } },
			{ access: "read", target: { kind: "minimal" } },
			{ access: "read", target: { kind: "tmpdir" } },
			{ access: "read", target: { kind: "slash-tmp" } },
			{ access: "write", target: { kind: "project-roots", subpath: "docs" } },
		] },
		{ kind: "server-prompt", server: "docs", message: "Sign in\n", url: "https://example.test" },
		{ kind: "unrecognised", reason: "more access" },
	];
	for (const asked of shapes) {
		const snapshot = { ...event, requests: [{ ...record, asked }] };
		expect<unknown>(EventSchema.parse(snapshot)).toEqual(snapshot);
	}
	expect(EventSchema.safeParse({ ...event, requests: [{ ...record, asked: { kind: "file-change", changes: [] } }] }).success).toBe(false);
});
