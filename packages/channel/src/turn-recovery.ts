import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { defineDoc, type ConversationId, type Harness } from "@earendil-works/pi-durable";
import { TurnRetryStatusDefinition, type TurnRetryStatusState } from "@neuve/records-schema";
import type { Event } from "./protocol";

export const TurnRetryStatusDoc = defineDoc<TurnRetryStatusState>(TurnRetryStatusDefinition);

export async function watchTurnRecovery(harness: Harness, chat: ConversationId, send: (value: Event) => void) {
	await harness.commit(async tx => void await tx.doc(TurnRetryStatusDoc, chat), context);
	const watch = await harness.watchDoc(TurnRetryStatusDoc, chat, context);
	if (!watch) throw new Error("The retry status document is missing.");
	const publish = (value: typeof watch.value) => send({
		kind: "turn-retry-status", chat,
		...(value?.current ? { status: value.current } : {}),
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
