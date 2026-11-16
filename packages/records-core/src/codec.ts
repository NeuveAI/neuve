import { safeRead } from "@neuve/records-schema";
import { Effect, Option } from "effect";
import type { SqlClient } from "effect/sql/SqlClient";
import { z } from "zod";
import {
  JobKind,
  PAYLOAD_MAX_BYTES,
  RecordEvent,
  Ulid,
  UnitIds,
  envelopeFields,
  type RecordEventKind,
} from "@neuve/records-schema";
import { canonicalJson, sha256Hex, utf8Length } from "./canonical.ts";
import { CorruptRecord, InvalidEvent, PayloadTooLarge } from "./errors.ts";

/** Parses a producer's event at the Records boundary and enforces the payload cap (D5). */
export const parseEvent = (input: unknown) =>
  Effect.gen(function* () {
    const parsed = RecordEvent.safeParse(input);
    if (!parsed.success)
      return yield* new InvalidEvent({ message: parsed.error.message });
    const bytes = utf8Length(canonicalJson(parsed.data.payload));
    if (bytes > PAYLOAD_MAX_BYTES) {
      return yield* new PayloadTooLarge({
        eventId: parsed.data.id,
        bytes,
        limit: PAYLOAD_MAX_BYTES,
      });
    }
    return parsed.data;
  });

/**
 * The content an idempotency key is checked against (D4): everything the producer asserts except the
 * event's own ID and timestamp, so a retried command that mints a new ULID still matches.
 */
export const fingerprintOf = (event: {
  readonly id: string;
  readonly occurredAt: string;
  readonly idempotencyKey: string;
}): string => {
  const {
    id: _id,
    occurredAt: _occurredAt,
    idempotencyKey: _key,
    ...content
  } = event;
  return sha256Hex(canonicalJson(content));
};

/**
 * The event and job kinds this build decodes (8.19). A newer build's kinds, and its new versions of
 * known ones (`review.run@2`), are absent: readers skip them and leave them to that build.
 */
export const KNOWN_EVENT_KINDS: ReadonlyArray<RecordEventKind> =
  RecordEvent.options.map((option) => option.shape.kind.value);
export const KNOWN_JOB_KINDS: ReadonlyArray<JobKind> = JobKind.options;
const knownEventKinds = new Set<string>(KNOWN_EVENT_KINDS);
const knownJobKinds = new Set<string>(KNOWN_JOB_KINDS);
export const isKnownEventKind = (kind: string) => knownEventKinds.has(kind);
export const isKnownJobKind = (kind: string) => knownJobKinds.has(kind);

/**
 * SQL for an event row a newer build wrote, which readers leave out (8.19): its `kind` column names
 * a kind this build does not know, and its envelope names the same kind. A row whose column and
 * envelope disagree, or whose envelope is not JSON, is not matched, so it is read and fails as
 * corrupt. `table` is the events table's alias in the query, if it has one.
 */
export const newerEventRow = (sql: SqlClient, table?: string) => {
  const column = (name: string) =>
    sql.literal(table === undefined ? name : `${table}.${name}`);
  return sql`(NOT ${sql.in(table === undefined ? "kind" : `${table}.kind`, KNOWN_EVENT_KINDS)}
    AND CASE WHEN json_valid(${column("envelope")})
      THEN json_extract(${column("envelope")}, '$.kind') IS ${column("kind")} ELSE 0 END)`;
};

const parseEnvelope = (envelope: string, label: string) =>
  Effect.try({
    try: () => JSON.parse(envelope) as unknown,
    catch: () =>
      new CorruptRecord({ message: `${label}: envelope is not JSON` }),
  });

const decodeParsed = (json: unknown, label: string) =>
  Effect.gen(function* () {
    const parsed = safeRead(RecordEvent, json);
    if (!parsed.success)
      return yield* new CorruptRecord({
        message: `${label}: ${parsed.error.message}`,
      });
    return parsed.data;
  });

/** Decodes a stored envelope; a failure means the stored row is corrupt, not that input was bad. */
export const decodeEnvelope = (envelope: string, label: string) =>
  Effect.flatMap(parseEnvelope(envelope, label), (json) =>
    decodeParsed(json, label),
  );

/** The shape every event kind has, `name.part@version`, whichever build defines it. */
const KIND_SHAPE = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+@[1-9][0-9]*$/;

/**
 * What every envelope carries whatever its kind, which is all this build can check of a newer
 * build's event (8.19): the shared envelope fields, a kind of the right shape, a payload, and the
 * attribution the unit and cycle indexes are built from. Other fields are that build's.
 */
const NewerEnvelope = z.object({
  ...envelopeFields,
  kind: z.string().regex(KIND_SHAPE),
  attribution: z
    .object({ cycleId: Ulid.optional(), unitIds: UnitIds.optional() })
    .optional(),
  payload: z.json(),
});

/**
 * The kind-independent checks for a stored row of a kind this build does not know (8.19): the
 * envelope is JSON in canonical form with the shared envelope fields, its kind has the shape of a
 * kind, and the row's columns and fingerprint match it. Returns the problems, and the attribution
 * the indexes must hold for it. A misspelt known kind whose fingerprint was copied fails here.
 */
export const checkNewerRow = (
  row: {
    readonly id: string;
    readonly kind: string;
    readonly idempotencyKey: string;
    readonly fingerprint: string;
    readonly actorId: string;
    readonly envelope: string;
  },
  label: string,
) => {
  const problems: Array<string> = [];
  let json: unknown;
  try {
    json = JSON.parse(row.envelope);
  } catch {
    return { problems: [`${label}: envelope is not JSON`], unitIds: [] };
  }
  const parsed = NewerEnvelope.safeParse(json);
  if (!parsed.success)
    return {
      problems: [
        `${label}: a kind this build does not know, with an envelope no kind may have: ${parsed.error.message}`,
      ],
      unitIds: [],
    };
  const event = parsed.data;
  if (canonicalJson(json) !== row.envelope)
    problems.push(`${label}: envelope is not canonical`);
  if (fingerprintOf(eventWithStoredFields(row.envelope)) !== row.fingerprint)
    problems.push(`${label}: fingerprint mismatch`);
  if (
    event.id !== row.id ||
    event.kind !== row.kind ||
    event.idempotencyKey !== row.idempotencyKey ||
    event.actor !== row.actorId
  )
    problems.push(`${label}: columns disagree with the envelope`);
  return {
    problems,
    unitIds: event.attribution?.unitIds ?? [],
    ...(event.attribution?.cycleId === undefined
      ? {}
      : { cycleId: event.attribution.cycleId }),
  };
};

/**
 * Decodes a stored event row that may be a newer build's (8.19): none for a kind this build does not
 * know, which the caller skips and leaves to that build. The row's `kind` column must name the
 * envelope's kind: a row where they disagree, an envelope that is not JSON, a kind that is not the
 * shape of one, or a known kind that fails its schema is corrupt, never skipped. `fsck` also checks
 * a skipped row with `checkNewerRow`.
 */
export const decodeStoredEvent = (
  row: { readonly kind: string; readonly envelope: string },
  label: string,
) =>
  Effect.gen(function* () {
    const json = yield* parseEnvelope(row.envelope, label);
    const named =
      typeof json === "object" && json !== null && "kind" in json
        ? json.kind
        : undefined;
    if (named !== row.kind)
      return yield* new CorruptRecord({
        message: `${label}: the kind column says ${row.kind}, the envelope ${typeof named === "string" ? named : "names no kind"}`,
      });
    if (!isKnownEventKind(row.kind)) {
      if (!KIND_SHAPE.test(row.kind))
        return yield* new CorruptRecord({
          message: `${label}: ${row.kind} is not the shape of an event kind`,
        });
      return Option.none<RecordEvent>();
    }
    return Option.some(yield* decodeParsed(json, label));
  });

/** Validate the common envelope without dropping fields used by integrity and idempotency. */
export const eventWithStoredFields = (envelope: string) =>
  z
    .looseObject({
      id: z.string(),
      occurredAt: z.string(),
      idempotencyKey: z.string(),
    })
    .parse(JSON.parse(envelope));
