import { defineDoc } from "@earendil-works/pi-durable";
import type { ExternalRef } from "./external-ref";

/** Coding provenance only. Records owns every accepted review association and disposition. */
export const ReviewContextDoc = defineDoc<{
	chats: Record<string, ExternalRef[]>;
	forkedFrom?: { channel: string; chat: number };
}>({
	kind: "neuve.review-context",
	version: 1,
	scope: "session",
	initial: () => ({ chats: {} }),
});
