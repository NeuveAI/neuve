import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { defineDoc, type ConversationId, type Harness } from "@earendil-works/pi-durable";
import { TurnRetryStatusDefinition } from "@neuve/records-schema";
import type { Event } from "./protocol";

export const TurnRetryStatusDoc = defineDoc(TurnRetryStatusDefinition);
/** The same durable conversation event path as approvals, including an initial reconnect snapshot. */
export async function watchTurnRecovery(harness: Harness, chat: ConversationId, send: (value: Event) => void) {
  await harness.commit(async (tx) => { await tx.doc(TurnRetryStatusDoc, chat); }, context);
  const watch = (await harness.watchDoc(TurnRetryStatusDoc, chat, context))!;
  const publish = (value: typeof watch.value) => send({ kind: "turn-retry-status", chat,
    ...(value?.current ? { status: value.current } : {}),
  });
  try {
    publish(watch.value);
    watch.start(async (value) => publish(value));
    return watch;
  } catch (error) { await watch.stop(); throw error; }
}
