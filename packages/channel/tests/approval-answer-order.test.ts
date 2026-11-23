// Concurrent answers must see the preceding answer's committed outcome in the same chat.
import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { type Harness, ROOT_CONVERSATION_ID as chat } from "@earendil-works/pi-durable";
import { ApprovalRequestsDoc } from "../src/approvals";
import { Fixture, OWNER } from "./helpers";

test("concurrent approval answers in one chat are recorded in request order", async () => {
	let harness!: Harness;
	let started = Promise.withResolvers<void>();
	let delivery = Promise.withResolvers<void>();
	const delivered: string[] = [];
	const fixture = await Fixture.create({
		extension: {
			extensions: [],
			attach(bound, admission) {
				harness = bound;
				admission.onApprovalAnswer?.(async (_chat, answer, record) => {
					if (answer.decision === "allow") {
						started.resolve();
						await delivery.promise;
					}
					await record();
					delivered.push(answer.requestId);
					return true;
				});
			},
		},
	});
	const answer = (requestId: string, decision: "allow" | "deny") =>
		fixture.request({ op: "approval-answer", author: OWNER, requestId, decision });

	try {
		await harness.commit(async (tx) => {
			const { requests } = await tx.doc(ApprovalRequestsDoc, chat);
			for (const requestId of ["shared", "first", "second"]) {
				requests.push({
					requestId, callId: requestId, work: "command", input: {},
					asked: { kind: "unrecognised" }, openedAt: 1, state: { kind: "open" },
				});
			}
		}, context);
		const together = async (first: string, second: string) => {
			started = Promise.withResolvers<void>();
			delivery = Promise.withResolvers<void>();
			const answers = Promise.allSettled([answer(first, "allow"), answer(second, "deny")]);
			await started.promise;
			// Let a competing answer advance before releasing the first reply.
			await new Promise<void>((resolve) => setImmediate(resolve));
			delivery.resolve();
			return answers;
		};

		const [first, duplicate] = await together("shared", "shared");
		expect(duplicate).toMatchObject({
			status: "rejected",
			reason: { message: "This approval request already has an answer. It was Allow." },
		});
		expect(first.status).toBe("fulfilled");

		expect((await together("first", "second")).map(({ status }) => status)).toEqual([
			"fulfilled", "fulfilled",
		]);
		expect(delivered).toEqual(["shared", "first", "second"]);
		const record = await harness.snapshot(ApprovalRequestsDoc, chat, context);
		expect(record?.requests.map(({ requestId, state }) => ({ requestId, state }))).toEqual([
			{ requestId: "shared", state: { kind: "answered", by: OWNER, at: expect.any(Number), decision: "allow" } },
			{ requestId: "first", state: { kind: "answered", by: OWNER, at: expect.any(Number), decision: "allow" } },
			{ requestId: "second", state: { kind: "answered", by: OWNER, at: expect.any(Number), decision: "deny" } },
		]);
	} finally {
		delivery.resolve();
		await fixture.dispose();
	}
});
