import type { JsonValue } from "@earendil-works/chord";
import {
	type ConversationId,
	defineDoc,
	type SubmissionId,
	type Tx,
} from "@earendil-works/pi-durable";

declare const crypto: {
	subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> };
};

/**
 * Each client `requestId` a chat admitted, with a digest of the payload it named. pi returns the
 * existing submission for a repeated `requestId` of the same type whatever its content, so a reused
 * id carrying another message would silently become the earlier one.
 */
export const RequestsDoc = defineDoc<{ requests: Record<string, string> }>({
	kind: "neuve.requests",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ requests: {} }),
});

/** A request's fields; absent and undefined fields are the same request. */
type Payload = { [key: string]: JsonValue | undefined };

/** Object keys sorted, so equal payloads encode equally whatever order a client wrote them in. */
function canonical(value: JsonValue | Payload): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(",")}}`;
}

export async function digest(value: Payload): Promise<string> {
	const bytes = new TextEncoder().encode(canonical(value));
	const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The submission pi admitted under `requestId` in `chat`, which a retry of the same payload gets
 * back; an admitted id carrying another payload is refused. pi's submission decides what was
 * admitted: a claim it never admitted, left by an interrupted request, is no promise.
 */
export async function admitted(
	tx: Tx,
	chat: ConversationId,
	requestId: string,
	value: string,
): Promise<SubmissionId | undefined> {
	const existing = await tx.submissionByRequest(chat, requestId);
	if (existing === undefined) return undefined;
	if ((await tx.doc(RequestsDoc, chat)).requests[requestId] !== value) {
		throw new Error(`Request ${requestId} was already used for a different message`);
	}
	return existing.id;
}

/**
 * The submission already admitted as `admitted` finds it, or else `requestId`'s payload recorded
 * in the commit that applies the request's own effects, before pi admits it under the same id.
 */
export async function claim(
	tx: Tx,
	chat: ConversationId,
	requestId: string,
	value: string,
): Promise<SubmissionId | undefined> {
	const existing = await admitted(tx, chat, requestId, value);
	if (existing === undefined) (await tx.doc(RequestsDoc, chat)).requests[requestId] = value;
	return existing;
}
