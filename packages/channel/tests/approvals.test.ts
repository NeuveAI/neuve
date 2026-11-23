// Refusals, message delivery, and wait marks must agree with the committed approval record.
import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { type ConversationId, type Harness, LiveDoc, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { ApprovalRequestsDoc, ATTENDED_SECTION } from "../src/approvals";
import { QuestionsDoc } from "../src/questions";
import type { ApprovalRequest, ChannelInfo, Request, RunEnd } from "../src/protocol";
import { Fixture, isolateClaudeConfig, OWNER, until } from "./helpers";

isolateClaudeConfig();
const root = ROOT_CONVERSATION_ID;
const question = () => fauxAssistantMessage(fauxToolCall("question", { questions: [{
	header: "Choice", question: "Which option?", options: [{ label: "First", description: "Use the first option" }], multiple: false,
}] }, { id: "question" }), { stopReason: "toolUse" });
const record = (requestId: string, state: ApprovalRequest["state"] = { kind: "open" }, openedAt = 1): ApprovalRequest => ({
	requestId, callId: "same-work", work: "command", input: { command: "pwd" }, asked: { kind: "unrecognised" }, openedAt, state,
});

async function channel(onRun?: (run: RunEnd) => void, stop?: (harness: Harness, chat: ConversationId) => Promise<void>) {
	let harness!: Harness;
	const fixture = await Fixture.create({ onRun, extension: {
		extensions: [],
		attach(bound, admission) {
			harness = bound;
			admission.requestAttendance?.(provider => provider === "faux");
			admission.onApprovalAnswer?.(async (_chat, _answer, record) => {
				await record();
				return true;
			});
			if (stop) admission.onStop?.(chat => stop(bound, chat));
		},
	} });
	const open = (...requests: ApprovalRequest[]) => harness.commit(async tx => {
		(await tx.doc(ApprovalRequestsDoc, root)).requests.push(...requests);
	}, context);
	const answer = (requestId: string, author = OWNER, decision: "allow" | "deny" = "allow") =>
		fixture.request({ op: "approval-answer", author, requestId, decision });
	const ask = (text: string, fields: Partial<Pick<Extract<Request, { op: "ask" }>, "chat" | "attended" | "requestId" | "author">> = {}) =>
		fixture.request<{ submission: number }>({ op: "ask", author: OWNER, text, ...fields });
	const wait = ({ submission }: { submission: number }) => fixture.request({ op: "wait", submission });
	return { fixture, harness, open, answer, ask, wait };
}

test("approval refusals check the author first and preserve the recorded response", async () => {
	const { fixture, open, answer, harness } = await channel();
	try {
		await fixture.request({ op: "share", author: OWNER, shared: false });
		await open(record("closed", { kind: "closed", reason: "runtime-resolved" }), record("open"));
		await expect(answer("missing", "agent@other")).rejects.toThrow("Only a person can answer an approval request.");
		await expect(answer("missing", "teammate")).rejects.toThrow(`Agent access is off in this channel, so only its owner, ${OWNER}, can ask its agents.`);
		await expect(answer("missing")).rejects.toThrow("This approval request could not be found in this chat.");
		await expect(answer("closed")).rejects.toThrow("This approval request closed because the runtime resolved it.");
		expect((await harness.snapshot(ApprovalRequestsDoc, root, context))?.requests[1]?.state).toEqual({ kind: "open" });
		await answer("open", OWNER, "deny");
		await expect(answer("open")).rejects.toThrow(/^This approval request already has an answer\. It was Deny\.$/);
		const requests = (await harness.snapshot(ApprovalRequestsDoc, root, context))?.requests;
		expect(requests?.map(({ state }) => state)).toEqual([
			{ kind: "closed", reason: "runtime-resolved" },
			{ kind: "answered", by: OWNER, at: expect.any(Number), decision: "deny" },
		]);
		await fixture.request({ op: "share", author: OWNER, shared: true });
		await open(record("shared"));
		await answer("shared", "teammate");
		await expect(answer("shared", OWNER, "deny")).rejects.toThrow(/^This approval request already has an answer\. It was Allow\.$/);
	} finally { await fixture.dispose(); }
});

test("an answer and a close race for one state in the same document", async () => {
	const { fixture, open, answer, harness } = await channel();
	try {
		await open(record("race"));
		const [answered, closed] = await Promise.allSettled([answer("race"), harness.commit(async tx => {
			const pending = (await tx.doc(ApprovalRequestsDoc, root)).requests[0]!;
			if (pending.state.kind !== "open") return false;
			pending.state = { kind: "closed", reason: "turn-ended" };
			return true;
		}, context)]);
		const state = (await harness.snapshot(ApprovalRequestsDoc, root, context))?.requests[0]?.state;
		if (closed.status === "fulfilled" && closed.value) {
			expect(answered).toMatchObject({ status: "rejected", reason: { message: "This approval request closed when its turn ended." } });
			expect(state).toEqual({ kind: "closed", reason: "turn-ended" });
		} else {
			expect(closed).toEqual({ status: "fulfilled", value: false });
			expect(answered.status).toBe("fulfilled");
			expect(state).toMatchObject({ kind: "answered", by: OWNER, decision: "allow" });
		}
	} finally { await fixture.dispose(); }
});

test("only opted-in watches get complete approval snapshots at attach and on changes", async () => {
	const { fixture, open, answer } = await channel();
	try {
		const optedOut = await fixture.watch();
		const optedIn = await fixture.watch({ op: "watch", approvals: true });
		try {
			expect(optedIn.of("approval-requests")).toEqual([{ kind: "approval-requests", chat: root, requests: [] }]);
			await open(record("last", undefined, 2), record("first"));
			await optedIn.until("approval-requests", event => event.requests.length === 2);
			await answer("first");
			const event = await optedIn.until("approval-requests", event => event.requests[0]?.state.kind === "answered");
			expect(event.requests.map(request => request.requestId)).toEqual(["first", "last"]);
			const attached = await fixture.watch({ op: "watch", approvals: true });
			try { expect(attached.of("approval-requests")).toEqual([event]); }
			finally { await attached.stop(); }
			expect(optedOut.of("approval-requests")).toEqual([]);
		} finally { await Promise.all([optedOut.stop(), optedIn.stop()]); }
	} finally { await fixture.dispose(); }
});

test("a person's invocation dismisses both waits and reaches the same chat", async () => {
	const runs: RunEnd[] = [];
	const { fixture, open, ask, wait, answer, harness } = await channel(run => runs.push(run));
	try {
		const watch = await fixture.watch({ op: "watch", approvals: true });
		try {
			fixture.script(question(), fauxAssistantMessage("Message received."));
			const work = await ask("Ask a question");
			await until(async () => (await harness.snapshot(QuestionsDoc, root, context))?.questions.question);
			await open(record("waiting"), record("also-waiting"));
			await answer("also-waiting");
			await until(() => runs.some(run => run.outcome === "question"));
			expect(runs.map(run => run.outcome)).toEqual(["question"]);
			await ask("Continue without the approval");
			const event = await watch.until("approval-requests", event => event.requests[0]?.state.kind === "closed");
			expect(event.requests[0]?.state).toEqual({ kind: "closed", reason: "message", by: OWNER });
			expect(await wait(work)).toBe("done");
			expect(await watch.until("message", message => message.text === "Continue without the approval")).toMatchObject({ author: OWNER });
			expect(await watch.until("result", result => result.call === "question")).toMatchObject({ text: expect.stringContaining(`${OWNER} sent a message`) });
			await expect(answer("waiting")).rejects.toThrow(/^This approval request closed because a message was sent instead\.$/);
		} finally { await watch.stop(); }
	} finally { await fixture.dispose(); }
});

test("a plain message leaves both waits open and an agent invocation dismisses only the question", async () => {
	const { fixture, open, ask, wait, harness } = await channel();
	try {
		const watch = await fixture.watch({ op: "watch", approvals: true });
		try {
			fixture.script(question(), fauxAssistantMessage("Agent message received."));
			const work = await ask("Ask a question");
			await until(async () => (await harness.snapshot(QuestionsDoc, root, context))?.questions.question);
			await open(record("waiting"));
			await fixture.request({ op: "say", author: OWNER, text: "A plain message" });
			await ask("Continue on the question", { author: "agent@other" });
			expect(await watch.until("result", result => result.call === "question")).toMatchObject({
				text: "Not answered: agent@other sent a message to this chat instead. Read it before asking again.",
			});
			expect(await wait(work)).toBe("done");
			expect((await harness.snapshot(ApprovalRequestsDoc, root, context))?.requests[0]?.state).toEqual({ kind: "open" });
		} finally { await watch.stop(); }
	} finally { await fixture.dispose(); }
});

test("Stop awaits the bridge before it aborts the conversation", async () => {
	const { fixture, ask, open, harness, wait, answer } = await channel(undefined, async (harness, chat) => {
		expect((await harness.snapshot(LiveDoc, chat, context))?.run).toBeDefined();
		await harness.commit(async tx => {
			const { requests } = await tx.doc(ApprovalRequestsDoc, chat);
			for (const request of requests) if (request.state.kind === "open") request.state = { kind: "closed", reason: "stopped" };
		}, context);
	});
	try {
		fixture.script(question());
		const work = await ask("Ask a question");
		await until(async () => (await harness.snapshot(QuestionsDoc, root, context))?.questions.question);
		await open(record("waiting"));
		await fixture.request({ op: "stop", author: OWNER });
		expect(await wait(work)).toBe("unanswered");
		await expect(answer("waiting")).rejects.toThrow("This approval request closed when the chat was stopped.");
	} finally { await fixture.dispose(); }
});

test("attendance changes on a busy chat, persists when omitted, and stays local to the chat", async () => {
	const { fixture, ask, wait, harness } = await channel();
	const markers: (string | null | undefined)[] = [];
	const read = (messages: readonly Message[]) => {
		const marker = messages.findLast(message => message.role === "system" && Object.hasOwn(message.sections ?? {}, ATTENDED_SECTION));
		markers.push(marker?.role === "system" ? marker.sections?.[ATTENDED_SECTION] : undefined);
	};
	try {
		fixture.script(request => { read(request.messages); return question(); }, fauxAssistantMessage("Continued"));
		const first = await ask("Start");
		await until(async () => (await harness.snapshot(QuestionsDoc, root, context))?.questions.question);
		const steer = await ask("Continue", { attended: true, requestId: "same-ask" });
		await expect(ask("Continue", { attended: false, requestId: "same-ask" })).rejects.toThrow("already used for a different message");
		await expect(ask("Set attendance", { author: "agent@other", attended: false })).rejects.toThrow("Only a person can set the chat's attendance.");
		expect(await wait(first)).toBe("done");
		expect(await wait(steer)).toBe("done");
		fixture.script(request => { read(request.messages); return fauxAssistantMessage(fauxToolCall("subagent", { task: "Read the repo" }), { stopReason: "toolUse" }); },
			request => { read(request.messages); return fauxAssistantMessage("Child ready"); }, fauxAssistantMessage("Parent ready"));
		expect(await wait(await ask("Start a child"))).toBe("done");
		expect((await fixture.request<ChannelInfo>({ op: "info" })).chats.some(chat => chat.parent === root)).toBe(true);
		fixture.script(request => { read(request.messages); return fauxAssistantMessage("CLI ready"); });
		expect(await wait(await ask("Continue from the CLI", { attended: false }))).toBe("done");
		expect(markers).toEqual(["false", "true", "false", "false"]);
	} finally { await fixture.dispose(); }
});
