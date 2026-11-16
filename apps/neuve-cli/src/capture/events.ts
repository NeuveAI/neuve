import { RecordEvent } from "@neuve/records-schema";
import {
  canonicalJson,
  mintUlid,
  sha256Hex,
} from "@neuve/records-core/capture";

/**
 * Builds a capture event and checks it against the Records schema before it is spooled, so a hook
 * never writes a line the worker would refuse. `occurredAt` is the producer's time; the writer adds
 * its own at append.
 */
export const captureEvent = (fields: {
  readonly kind: RecordEvent["kind"];
  readonly idempotencyKey: (id: string) => string;
  readonly actor: string;
  readonly attribution?: unknown;
  readonly payload: unknown;
}): RecordEvent => {
  const id = mintUlid();
  return RecordEvent.parse({
    id,
    kind: fields.kind,
    idempotencyKey: fields.idempotencyKey(id),
    actor: fields.actor,
    occurredAt: new Date().toISOString(),
    ...(fields.attribution === undefined
      ? {}
      : { attribution: fields.attribution }),
    payload: fields.payload,
  });
};

/** Drops `undefined` fields so optional schema fields are absent rather than present and undefined. */
export const defined = <T extends Record<string, unknown>>(value: T) =>
  Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as { [K in keyof T]: Exclude<T[K], undefined> };

/**
 * An actor registration. Its key carries a hash of its content, so re-registering the same actor is
 * idempotent and a registration with a new display name is a new event, never a conflict.
 */
export const registration = (
  actorId: string,
  payload: Readonly<Record<string, unknown>>,
) => {
  const content = defined(payload);
  return captureEvent({
    kind: "actor.registered@1",
    idempotencyKey: () =>
      `actor:${actorId}:${sha256Hex(canonicalJson(content)).slice(0, 16)}`,
    actor: actorId,
    payload: content,
  });
};
