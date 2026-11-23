import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { SystemMessage } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, GenerationTask, hook, type ConversationId, type Harness } from "@earendil-works/pi-durable";
import { ApprovalRequestsDefinition, type ApprovalRequest, type ApprovalRequestsState, type Event, type Request } from "./protocol";
import type { PersonWaits } from "./questions";
import { isAgent } from "./room";

export const ATTENDED_SECTION = "neuve.chat.request-attended";
export const ApprovalRequestsDoc = defineDoc<ApprovalRequestsState>(ApprovalRequestsDefinition);
export type ApprovalAdmission = {
	/** Stop waits for the listener before it aborts the conversation. */
	onStop?(listener: (chat: ConversationId) => Promise<void>): void;
	/** Only providers handled by the bridge receive the attendance section. */
	requestAttendance?(owns: (provider: string) => boolean): void;
	/** The runtime calls record only after delivering the answer. */
	onApprovalAnswer?(send: SendApprovalAnswer): void;
};

type ApprovalAnswer = Extract<Request, { op: "approval-answer" }>;
type SendApprovalAnswer = (
	chat: ConversationId,
	answer: Pick<ApprovalAnswer, "requestId" | "decision">,
	record: () => Promise<void>,
) => Promise<boolean>;

const AttendanceDoc = defineDoc<{ attended: boolean }>({
	kind: "neuve.chat-attendance", version: 1, scope: "conversation", history: "latest", fork: "initial",
	initial: () => ({ attended: false }),
});

export function requirePerson(author: string) {
	if (isAgent(author)) throw new Error("Only a person can answer this request.");
}

function closedReason(state: Extract<ApprovalRequest["state"], { kind: "closed" }>): string {
	switch (state.reason) {
		case "turn-ended": return "This request closed when its turn ended.";
		case "runtime-resolved": return "This request was withdrawn before an answer.";
		case "stopped": return "This request closed when the chat was stopped.";
		case "restarted": return "This request closed when Neuve restarted.";
		case "message": return "This request closed because a message was sent instead.";
	}
}

async function openApproval(harness: Harness, chat: ConversationId, answer: ApprovalAnswer, record = false) {
	await harness.commit(async tx => {
		const doc = await tx.doc(ApprovalRequestsDoc, chat);
		const request = doc.requests.find(record => record.requestId === answer.requestId);
		if (!request) throw new Error("This request could not be found in this chat.");
		const { state } = request;
		if (state.kind === "closed") throw new Error(closedReason(state));
		if (state.kind === "answered") {
			const choice = state.decision === "allow" ? "Allow" : "Deny";
			throw new Error(`This request already has an answer. It was ${choice}.`);
		}
		if (record) request.state = { kind: "answered", by: answer.author, at: Date.now(), decision: answer.decision };
	}, context);
}

export async function watchApprovals(harness: Harness, chat: ConversationId, send: (value: Event) => void) {
	await harness.commit(async tx => void await tx.doc(ApprovalRequestsDoc, chat), context);
	const watch = (await harness.watchDoc(ApprovalRequestsDoc, chat, context))!;
	const publish = (value: typeof watch.value) => send({
		kind: "approval-requests", chat,
		requests: (value?.requests ?? []).toSorted((a, b) => a.openedAt - b.openedAt),
	});
	try {
		publish(watch.value);
		watch.start(async value => publish(value));
		return watch;
	} catch (error) {
		await watch.stop();
		throw error;
	}
}

export class Approvals {
	#waiting = new Map<ConversationId, { ids: ReadonlySet<string>; wait: ReturnType<PersonWaits["listen"]>; dismiss: (author: string) => void }>();
	#pending = new Set<Promise<void>>();
	#admitting = new Map<ConversationId, Promise<unknown>>();
	#closing = false;
	#stop?: (chat: ConversationId) => Promise<void>;
	#send?: SendApprovalAnswer;
	#runtimeModels?: (provider: string) => boolean;

	constructor(
		private readonly waits: PersonWaits,
		private readonly report: (error: unknown) => void,
		private readonly serialize: (chat: ConversationId, work: () => Promise<void>) => Promise<void>,
	) {}

	registerAnswer(send: SendApprovalAnswer) {
		this.#send = send;
	}

	async answer(harness: Harness, chat: ConversationId, answer: ApprovalAnswer) {
		await openApproval(harness, chat, answer);
		const { requestId, decision } = answer;
		if (await this.#send?.(chat, { requestId, decision }, () => openApproval(harness, chat, answer, true))) return;
		await openApproval(harness, chat, answer);
		throw new Error("This answer could not be delivered, so it was not applied.");
	}

	readonly extension = defineExtension({
		name: "neuve-chat-attendance",
		hooks: [hook(GenerationTask, {
			beforeRequest: async ({ messages }, api, context) => {
				await this.#admitting.get(api.conversationId)?.catch(() => {});
				const attended = (await api.snapshot(AttendanceDoc, api.conversationId, context))?.attended ?? false;
				const marker: SystemMessage = {
					role: "system", content: "", timestamp: messages.at(-1)?.timestamp ?? 0,
					sections: { [ATTENDED_SECTION]: String(attended) },
				};
				return { messages: [...messages, marker] };
			},
		})],
	});

	async admit<T>(harness: Harness, chat: ConversationId, attended: boolean | undefined, settled: Promise<unknown>, submit: () => Promise<T>): Promise<T> {
		if (attended === undefined) return submit();
		this.#admitting.set(chat, settled);
		let previous: boolean | undefined;
		try {
			previous = await harness.commit(async tx => {
				const doc = await tx.doc(AttendanceDoc, chat);
				const before = doc.attended;
				doc.attended = attended;
				return before;
			}, context);
			return await submit();
		} catch (error) {
			if (previous !== undefined && previous !== attended) {
				const restore = previous;
				try {
					await harness.commit(async tx => { (await tx.doc(AttendanceDoc, chat)).attended = restore; }, context);
				} catch (rollback) {
					throw new AggregateError([error, rollback], "The chat could not restore attendance after the message failed.");
				}
			}
			throw error;
		} finally {
			this.#admitting.delete(chat);
		}
	}

	registerStop(stop: (chat: ConversationId) => Promise<void>) {
		this.#stop = stop;
	}

	registerRuntimeModels(owns: (provider: string) => boolean) {
		this.#runtimeModels = owns;
	}

	receivesAttendance(provider: string) {
		return this.#runtimeModels?.(provider) ?? false;
	}

	async stop(chat: ConversationId) {
		await this.#stop?.(chat);
	}

	changed(harness: Harness, chat: ConversationId, value: ApprovalRequestsState | null) {
		if (this.#closing) return;
		const ids = new Set(value?.requests.filter(request => request.state.kind === "open").map(request => request.requestId));
		const previous = this.#waiting.get(chat);
		if (!ids.size) {
			previous?.wait.stop(true);
			this.#waiting.delete(chat);
			return;
		}
		if (previous) {
			previous.ids = ids;
		} else {
			const dismiss = (by: string) => {
				const waiting = this.#waiting.get(chat)?.ids;
				if (!waiting || this.#closing) return;
				// The commit listener must return before asking pi to commit another document.
				const task = Promise.resolve().then(() => this.serialize(chat, () => harness.commit(async tx => {
					const doc = await tx.doc(ApprovalRequestsDoc, chat);
					for (const request of doc.requests) {
						if (request.state.kind === "open" && waiting.has(request.requestId))
							request.state = { kind: "closed", reason: "message", by };
					}
				}, context))).catch(this.report);
				this.#pending.add(task);
				void task.finally(() => this.#pending.delete(task));
			};
			const wait = this.waits.listen(chat, "approval", dismiss);
			this.#waiting.set(chat, { ids, wait, dismiss });
			wait.start();
		}
		const author = this.waits.queued(chat, "approval");
		if (author) this.#waiting.get(chat)?.dismiss(author);
	}

	async close() {
		this.#closing = true;
		for (const { wait } of this.#waiting.values()) wait.stop();
		this.#waiting.clear();
		await Promise.allSettled(this.#pending);
	}
}
