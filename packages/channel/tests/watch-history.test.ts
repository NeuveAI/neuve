import { afterEach, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { parseFrame } from "../src/frame";
import { RequestSchema } from "../src/parse";
import type { SeedChat, SeedItem } from "../src/seed";
import { Fixture, OWNER } from "./helpers";

let fixture: Fixture | undefined;
afterEach(async () => {
	await fixture?.dispose();
	fixture = undefined;
});

const message = (text: string): SeedItem => ({ author: OWNER, text, at: "2026-11-20T09:00:00Z" });
const reply = (content: Parameters<typeof fauxAssistantMessage>[0]): SeedItem => ({
	agent: { kind: "pi.assistant", model: [fauxAssistantMessage(content)] },
});

async function seed(chat: SeedChat) {
	const channel = fixture = await Fixture.create();
	await channel.channel.import({ format: "ace-seed", version: 1, name: "history", chats: [chat] });
	return channel;
}

test("watch replays the requested suffix and keeps full history available to existing clients", async () => {
	const texts = Array.from({ length: 12 }, (_, i) => `Message ${i + 1}`);
	const calls = texts.map((_, i) => `read-${i + 1}`);
	const channel = await seed({
		items: texts.flatMap((text, i) => [message(text), reply(fauxToolCall("read", { path: "README.md" }, { id: calls[i] }))]),
		captions: {
			groups: Object.fromEntries(calls.map(call => [call, { calls: [call], text: `Caption ${call}`, done: true }])),
			recaps: Object.fromEntries(calls.map(call => [call, { calls: [call], text: `Recap ${call}` }])),
		},
	});
	const request = { op: "watch", turns: 10 } as const;
	const recent = await channel.watch(request);
	const current = await recent.until("live");
	await recent.stop();
	expect(recent.of("message").map(event => event.text)).toEqual(texts.slice(2));
	expect(recent.of("caption").map(event => event.calls)).toEqual(calls.slice(2).map(call => [call]));
	expect(recent.of("recap").map(event => event.calls)).toEqual(calls.slice(2).map(call => [call]));
	expect(parseFrame(JSON.stringify({ id: 0, event: current }))).toEqual({ id: 0, event: { kind: "live", chat: 1, older: true } });
	expect(RequestSchema.parse(request)).toEqual(request);
	for (const turns of [0, -1, 1.5, "10"]) {
		expect(RequestSchema.safeParse({ ...request, turns }).success).toBe(false);
	}

	const expanded = await channel.watch({ op: "watch", turns: 30 });
	const full = await channel.watch();
	await expanded.stop();
	await full.stop();
	expect(expanded.of("live")).toEqual([{ kind: "live", chat: 1 }]);
	expect(expanded.events).toEqual(full.events);
	expect(full.of("message").map(event => event.text)).toEqual(texts);
	expect(full.of("caption").map(event => event.calls)).toEqual(calls.map(call => [call]));
	expect(full.of("recap").map(event => event.calls)).toEqual(calls.map(call => [call]));
});

test("the replay cap keeps whole turns when possible and bounds a single long turn", async () => {
	const replies = Array.from({ length: 110 }, (_, i) => `Reply ${i + 1}`);
	const channel = await seed({ items: [message("Long turn"), ...replies.map(reply)] });
	const recent = await channel.watch({ op: "watch", turns: 1 });
	await recent.stop();
	expect(recent.of("live")).toEqual([{ kind: "live", chat: 1, older: true }]);
	expect(recent.of("reply").map(event => event.text)).toEqual(replies.slice(60));

	const { submission } = await channel.request<{ submission: number }>({ op: "say", author: OWNER, text: "Next turn" });
	await channel.request({ op: "wait", submission });
	const expanded = await channel.watch({ op: "watch", turns: 2 });
	await expanded.stop();
	expect(expanded.of("live")).toEqual([{ kind: "live", chat: 1, older: true }]);
	expect(expanded.of("message").map(event => event.text)).toEqual(["Next turn"]);
	expect(expanded.of("reply")).toEqual([]);
});

test("a replayed message shows its latest edit even with actions disabled", async () => {
	const channel = await seed({ items: [message("Older"), message("Original text")] });
	const full = await channel.watch();
	await full.stop();
	const original = full.of("message").find(event => event.text === "Original text")!;
	for (const text of ["First edit", "Final edit"]) {
		await channel.request({ op: "edit", author: OWNER, entry: original.entry, text });
	}
	const recent = await channel.watch({ op: "watch", turns: 1, actions: false });
	await recent.stop();
	expect(recent.of("message").map(({ entry, text }) => ({ entry, text }))).toEqual([
		{ entry: original.entry, text: "Final edit" },
	]);
	expect(recent.of("edited")).toEqual([]);
});
