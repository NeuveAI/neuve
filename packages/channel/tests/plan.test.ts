import { expect, test } from "bun:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Fixture, OWNER } from "./helpers";

// Without shared admission, a paused rewrite can overwrite the version that just received approval.
test("approval waits for a draft rewrite in its chat while another chat can read its plan", async () => {
	const staged = new Map<string, Uint8Array>();
	const writing = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const fixture = await Fixture.create({ planFiles: {
		async stage(file, _hash, bytes) {
			if (new TextDecoder().decode(bytes) === "Revised") {
				writing.resolve();
				await finish.promise;
			}
			staged.set(file, bytes);
		},
		async read(file, _hash, bytes) { return staged.get(file) ?? bytes; },
	} });
	try {
		const { chat } = await fixture.request<{ chat: number }>({ op: "chat", author: OWNER });
		const root = await fixture.watch({ op: "watch", plans: true });
		const other = await fixture.watch({ op: "watch", plans: true, chat });
		const write = async (text: string, chat?: number) => {
			fixture.script(fauxAssistantMessage(fauxToolCall("plan_write", { text }, { id: text }), { stopReason: "toolUse" }));
			return fixture.request<{ submission: number }>({ op: "ask", author: OWNER, text: "Draft the plan", mode: "plan", chat });
		};
		await fixture.request({ op: "wait", submission: (await write("First draft")).submission });
		await fixture.request({ op: "wait", submission: (await write("Other chat", chat)).submission });
		const { plans: [draft] } = await root.until("plans", event => event.plans.length === 1);
		const { plans: [another] } = await other.until("plans", event => event.plans.length === 1);
		if (!draft || !another) throw new Error("Both chats should have a draft.");
		const { submission } = await write("Revised");
		await writing.promise;
		const approval = fixture.request({ op: "plan-approve", author: OWNER, plan: draft.id, hash: draft.hash })
			.catch((error: unknown) => error);
		expect(await fixture.request({ op: "plan", chat, plan: another.id })).toEqual({ hash: another.hash, text: "Other chat" });
		finish.resolve();
		expect(await approval).toMatchObject({ message: "The plan has changed. Read the current version before approving it." });
		expect(await fixture.request({ op: "wait", submission })).toBe("done");
		const { plans } = await root.until("plans", event => event.plans[0]?.call === "Revised");
		expect(plans).toEqual([{
			...draft, call: "Revised", hash: "a95671b6583aa676ba510fea23eb8ceb17f2741084896d2a615dab259dbbeee4",
			written: expect.any(Number),
		}]);
		await Promise.all([root.stop(), other.stop()]);
	} finally {
		finish.resolve();
		await fixture.dispose();
	}
});
