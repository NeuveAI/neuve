import { z } from "zod";

export const SHARED_WORK_LINE_BYTES = 8192;
export const SharedWorkOutcome = z.enum(["succeeded", "failed"]);
/** Both identities are SHA-256 digests, so even very long input keys fit the line cap. */
const identity = z.string().regex(/^[a-f0-9]{64}$/);
export const SharedWorkMessage = z.discriminatedUnion("kind", [
  z.strictObject({
    version: z.literal(1),
    kind: z.literal("delivery"),
    publication: z.string().min(1).max(128).optional(),
    store: identity,
    key: identity,
    host: z.uuid().optional(),
  }),
  z.strictObject({
    version: z.literal(1),
    kind: z.literal("ownership"),
    store: identity,
    key: identity,
  }),
  z.strictObject({ version: z.literal(1), kind: z.literal("withdraw") }),
  z.strictObject({
    version: z.literal(1),
    kind: z.literal("claim"),
    deliveryAcknowledgement: z.literal(true).optional(),
    store: identity,
    key: identity,
    insideGrant: z.boolean(),
    redeclare: z.boolean().default(false),
  }),
  z.strictObject({
    version: z.literal(1),
    kind: z.literal("settle"),
    outcome: SharedWorkOutcome,
    publication: z.string().min(1).max(128),
  }),
]);
export type SharedWorkMessage = z.infer<typeof SharedWorkMessage>;
export const SharedWorkReply = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("delivery"),
    host: z.uuid(),
    claimed: z.boolean(),
    unread: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("ownership"), live: z.boolean() }),
  z.strictObject({
    kind: z.literal("claimed"),
    host: z.uuid().optional(),
    takeover: z.boolean(),
    waiters: z.int().nonnegative(),
    declaring: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("waiting"), host: z.uuid().optional() }),
  z.strictObject({ kind: z.literal("held"), host: z.uuid().optional() }),
  z.strictObject({ kind: z.literal("withdrawn") }),
  z.strictObject({
    kind: z.literal("retained"),
    count: z.int().nonnegative(),
    declaring: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("waiters"),
    count: z.int().nonnegative(),
    declaring: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("done"),
    host: z.uuid().optional(),
    outcome: SharedWorkOutcome,
    publication: z.string().min(1).max(128),
  }),
  z.strictObject({ kind: z.literal("error") }),
]);
export type SharedWorkReply = z.infer<typeof SharedWorkReply>;
