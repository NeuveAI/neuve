// Clients cross this boundary to stop a build and to watch builds, and the host's own inputs to a build's chats rest on a request-ID namespace no client may claim, so a malformed or forged request accepted here would go unnoticed.
import { expect, test } from "bun:test";
import { EventSchema } from "../src/frame";
import { parseRequest } from "../src/parse";
import { buildId, type Event } from "../src/protocol";

const hash = "a".repeat(64);
const build = buildId(3, hash);

test("a build stop names the build and carries the verified author", () => {
	expect(build).toBe(`3:${hash}`);
	expect(parseRequest({ op: "build-stop", author: "claimed", build }, "owner")).toEqual({
		op: "build-stop",
		author: "owner",
		build,
	});
	expect(parseRequest({ op: "build-stop", build }, "owner")).toEqual({ op: "build-stop", author: "owner", build });
});

test("malformed build stops are refused at the request boundary", () => {
	const refused: [unknown, string][] = [
		[{ op: "build-stop", author: "claimed" }, "at build"],
		[{ op: "build-stop", author: "claimed", build: "" }, "at build"],
		[{ op: "build-stop", author: "claimed", build: "3" }, "at build"],
		[{ op: "build-stop", author: "claimed", build: `3:${"A".repeat(64)}` }, "at build"],
		[{ op: "build-stop", author: "claimed", build, chat: 3 }, 'Unrecognized key: "chat"'],
	];
	for (const [value, message] of refused) {
		expect(() => parseRequest(value, "owner")).toThrow(message);
	}
});

test("a watch opts in to builds events", () => {
	expect(parseRequest({ op: "watch", chat: 2, builds: true }, "owner")).toEqual({ op: "watch", chat: 2, builds: true });
	expect(() => parseRequest({ op: "watch", builds: "yes" }, "owner")).toThrow("at builds");
});

test("clients cannot claim a build request ID", () => {
	const requests = [
		{ op: "say", author: "claimed", text: "Brief" },
		{ op: "ask", author: "claimed", text: "Brief" },
		{ op: "plan-comments-send", author: "claimed", plan: "plan-1" },
	];
	for (const request of requests) {
		for (const requestId of ["neuve.build:", `neuve.build:${build}:brief:4`]) {
			expect(() => parseRequest({ ...request, requestId }, "owner")).toThrow("The neuve.build: request-ID namespace is reserved for the host");
		}
		expect(parseRequest({ ...request, requestId: "client-1" }, "owner")).toMatchObject({ requestId: "client-1" });
	}
});

test("say and ask carry the mentioned agents, and a malformed list is refused", () => {
	for (const op of ["say", "ask"]) {
		expect(parseRequest({ op, author: "claimed", text: "@reviewer hold", agents: [4] }, "owner")).toMatchObject({ agents: [4] });
		for (const agents of [[], [-1], [1.5], ["4"], 4]) {
			expect(() => parseRequest({ op, author: "claimed", text: "@reviewer hold", agents }, "owner")).toThrow("at agents");
		}
	}
});

test("only say and ask carry mentioned agents", () => {
	expect(() => parseRequest({ op: "plan-comments-send", author: "claimed", plan: "plan-1", agents: [4] }, "owner"))
		.toThrow('Unrecognized key: "agents"');
});

test("the builds event keeps every build state, agent and message in order across JSON", () => {
	const plan = { id: "plan-1", hash, title: "Retry exports", call: "call-1" };
	const approved = { by: "owner", at: 100 };
	const event: Extract<Event, { kind: "builds" }> = {
		kind: "builds",
		chat: 1,
		builds: [
			{ id: build, chat: 3, plan, approved, state: { kind: "started" }, agents: [
				{ role: "implementer", chat: 4, started: 110, state: "running", caption: "Reading the export queue" },
				{ role: "reviewer", chat: 5, by: 4, started: 120, state: "waiting" },
				{ role: "implementer", part: "parser", chat: 6, by: 4, started: 130, state: "done" },
			] },
			{ id: buildId(3, "b".repeat(64)), chat: 3, plan: { ...plan, id: "plan-2", hash: "b".repeat(64) }, approved, state: { kind: "delivered", to: build }, agents: [] },
			{ id: "7:c", chat: 7, plan, approved, state: { kind: "starting" }, agents: [] },
			{ id: "8:c", chat: 8, plan, approved, state: { kind: "unavailable", reason: "shared" }, agents: [] },
			{ id: "9:c", chat: 9, plan, approved, state: { kind: "unavailable", reason: "hosted" }, agents: [] },
			{ id: "10:c", chat: 10, plan, approved, state: { kind: "paused", reason: "shared" }, agents: [] },
			{ id: "11:c", chat: 11, plan, approved, state: { kind: "stopped", by: "owner", at: 200 }, agents: [
				{ role: "implementer", chat: 12, started: 150, state: "stopped" },
			] },
			{ id: "13:c", chat: 13, plan, approved, state: { kind: "failed", detail: "The worktree could not be created." }, agents: [
				{ role: "implementer", chat: 14, started: 160, state: "failed" },
			] },
		],
		messages: [
			{ build, from: 4, to: 5, at: 140, text: "Ready at abc123." },
			{ build, from: 5, to: 4, at: 150, text: "Two corrections." },
		],
	};
	expect(EventSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
	expect(() => EventSchema.parse({ ...event, builds: [{ ...event.builds[0], state: { kind: "stopped", at: 200 } }] })).toThrow();
	expect(() => EventSchema.parse({ ...event, builds: [{ ...event.builds[0], agents: [{ role: "helper", chat: 4, started: 1, state: "running" }] }] })).toThrow();
});

test("the host's brief mark survives JSON on a message and a queued message", () => {
	const system = { kind: "neuve:build:brief", build } as const;
	const message: Extract<Event, { kind: "message" }> = { kind: "message", chat: 4, entry: 1, at: 110, author: "unknown", text: "Brief", invoked: true, system };
	const queue: Extract<Event, { kind: "queue" }> = { kind: "queue", chat: 4, messages: [{ submission: 1, author: "unknown", text: "Brief", invoked: true, system }] };
	expect(EventSchema.parse(JSON.parse(JSON.stringify(message)))).toEqual(message);
	expect(EventSchema.parse(JSON.parse(JSON.stringify(queue)))).toEqual(queue);
	expect(() => EventSchema.parse({ ...message, system: { kind: "neuve:build:brief" } })).toThrow();
});
