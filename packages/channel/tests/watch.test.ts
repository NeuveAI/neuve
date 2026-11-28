import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { type Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { MessagesDoc } from "../src/messages";
import { draft } from "../src/room";
import { Fixture, isolateClaudeConfig, OWNER } from "./helpers";

isolateClaudeConfig();

test("a channel watch reports the run end after overflowing to a snapshot", async () => {
	const attached = Promise.withResolvers<Harness>();
	const fixture = await Fixture.create({ feed: async harness => {
		attached.resolve(harness);
		return { close: async () => {}, pending: () => false };
	} });
	const harness = await attached.promise;
	const chat = ROOT_CONVERSATION_ID;
	const started = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const paused = Promise.withResolvers<void>();
	const resume = Promise.withResolvers<void>();
	const snapshot = harness.snapshot;
	try {
		fixture.script(async () => {
			started.resolve();
			await finish.promise;
			return fauxAssistantMessage("Run finished");
		});
		const { submission } = await fixture.request<{ submission: number }>({ op: "ask", chat, author: OWNER, text: "Start a run" });
		await started.promise;
		// Hold watch startup after pi-durable attaches so its real pending batches can overflow.
		harness.snapshot = new Proxy(snapshot, { async apply(read, receiver, args) {
			if (args[0] === MessagesDoc) {
				paused.resolve();
				await resume.promise;
			}
			return Reflect.apply(read, receiver, args);
		} });
		const watching = fixture.watch({ op: "watch", chat, queue: false, captions: false, progress: false });
		await Promise.race([paused.promise, watching]);
		finish.resolve();
		expect(await fixture.request({ op: "wait", submission })).toBe("done");
		for (let index = 0; index < 105; index++) {
			await harness.commit(tx => tx.appendEntry(chat, draft(OWNER, `Message ${index}`, Date.now())), BACKGROUND_CONTEXT);
		}
		resume.resolve();
		const watch = await watching;
		await watch.until("message", event => event.text === "Message 104");
		expect(watch.of("reply")).toEqual([]);
		expect(watch.of("run")).toEqual([
			{ kind: "run", chat, state: "start" },
			{ kind: "run", chat, state: "end" },
		]);
		await watch.stop();
	} finally {
		harness.snapshot = snapshot;
		finish.resolve();
		resume.resolve();
		await fixture.dispose();
	}
});
