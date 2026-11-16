import { z } from "zod";

/** Producer-minted, time-sortable identity of an event and of the entities events create (D4). */
export const Ulid = z.ulid();

/** A git object ID, SHA-1 or SHA-256. Ranges are fingerprinted by OIDs, never branch names (1.4). */
export const GitOid = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "Expected a git object ID");

/** sha256 of an actor's identifying inputs (D21). Aliases are projected, never stored on events. */
export const ActorId = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "Expected an actor fingerprint");

/** A UTC instant as produced by `Date.prototype.toISOString`. */
export const Instant = z.iso.datetime();

/** Largest payload, in canonical JSON bytes, that an event may carry; larger content is a referenced blob (D5). */
export const PAYLOAD_MAX_BYTES = 65_536;

export const Range = z.strictObject({
  baseRef: z.string().min(1).max(512),
  baseOid: GitOid,
  headOid: GitOid,
});

const shortText = z.string().min(1).max(512);

/** Units an event is attributed to. Each is indexed once, so the list must not repeat (D6). */
export const UnitIds = z
  .array(Ulid)
  .min(1)
  .max(4_096)
  .refine((ids) => new Set(ids).size === ids.length, "unitIds must not repeat");

/** Optional attribution shared by every event kind; kinds narrow the fields they require. */
export const Attribution = z.strictObject({
  range: Range.optional(),
  batchId: Ulid.optional(),
  cycleId: Ulid.optional(),
  unitIds: UnitIds.optional(),
  runId: shortText.optional(),
  stage: shortText.optional(),
  sessionId: shortText.optional(),
  turnKey: shortText.optional(),
});

/** Links between events. Corrections and retractions are new events that supersede, never edits. */
export const Causation = z.strictObject({
  causedBy: Ulid.optional(),
  correlationId: shortText.optional(),
  supersedes: Ulid.optional(),
});

/** A reference to a computation or blob by content hash; records never copy what they reference (5.3). */
export const Reference = z.strictObject({
  ref: z
    .string()
    .regex(
      /^(?:computation|blob):[0-9a-f]{64}$/,
      "Expected computation:<sha256> or blob:<sha256>",
    ),
  role: z.string().min(1).max(64),
});

/** Envelope fields every kind carries. `kind`, `payload` and narrowed attribution come from the kind. */
export const envelopeFields = {
  id: Ulid,
  idempotencyKey: z.string().min(1).max(512),
  actor: ActorId,
  causation: Causation.optional(),
  occurredAt: Instant,
  refs: z.array(Reference).max(64).optional(),
};

export type Range = z.infer<typeof Range>;
export type Attribution = z.infer<typeof Attribution>;
export type Causation = z.infer<typeof Causation>;
export type Reference = z.infer<typeof Reference>;
