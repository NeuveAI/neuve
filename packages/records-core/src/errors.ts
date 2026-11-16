import { Data } from "effect";

/** The event failed its zod schema at the Records boundary. */
export class InvalidEvent extends Data.TaggedError("InvalidEvent")<{
  readonly message: string;
}> {}

/** The payload exceeds the envelope cap; larger content belongs in a referenced blob (D5). */
export class PayloadTooLarge extends Data.TaggedError("PayloadTooLarge")<{
  readonly eventId: string;
  readonly bytes: number;
  readonly limit: number;
}> {}

/** The idempotency key is already held by an event with different content (D4). */
export class IdempotencyConflict extends Data.TaggedError(
  "IdempotencyConflict",
)<{
  readonly idempotencyKey: string;
  readonly existingEventId: string;
}> {}

/** The event ID is already held by an event under a different idempotency key. */
export class EventIdConflict extends Data.TaggedError("EventIdConflict")<{
  readonly eventId: string;
}> {}

/** This build is older than the database's minimum writer version (D2). */
export class WriterTooOld extends Data.TaggedError("WriterTooOld")<{
  readonly writerVersion: number;
  readonly minWriterVersion: number;
}> {}

interface VersionPair {
  readonly schemaVersion: number;
  readonly projectorVersion: number;
}

/**
 * The store is older than this build, or its initialization did not finish, and the operation ran
 * without opening it first: `prepareForRead` and `prepareForWrite` migrate it (12.24), as does
 * `neuve records migrate`. `stored` is absent for an incomplete store.
 */
export class MigrationRequired extends Data.TaggedError("MigrationRequired")<{
  readonly stored: VersionPair | undefined;
  readonly current: VersionPair;
}> {}

/**
 * A newer build migrated the store past what this build understands. Since 12.24 the gate no longer
 * raises it (such a store is used in compatibility mode); it stays for callers that name it.
 */
export class StoreNewer extends Data.TaggedError("StoreNewer")<{
  readonly stored: VersionPair;
  readonly current: VersionPair;
}> {}

/** The copy taken before an automatic migrate failed, so the store was left as it was (12.24). */
export class BackupFailed extends Data.TaggedError("BackupFailed")<{
  readonly path: string;
  readonly message: string;
}> {}

/**
 * A store in WAL mode with no WAL beside it, for a reader that must see every commit. A clean close
 * and a lost WAL look the same, and only a writer's open accepts the file as it stands.
 */
export class StoreWithoutLog extends Data.TaggedError("StoreWithoutLog")<{
  readonly path: string;
}> {
  override get message() {
    return `${this.path} is in WAL mode with no WAL beside it. A clean close and a lost WAL look the same, so nothing shows this file holds every commit. Opening the store for writing, for example with \`neuve records migrate\`, accepts it as it stands`;
  }
}

/** The database file exists but Records never initialized it. */
export class StoreNotInitialized extends Data.TaggedError(
  "StoreNotInitialized",
)<{}> {}

/** No Records database exists yet for this repository. */
export class StoreMissing extends Data.TaggedError("StoreMissing")<{
  readonly path: string;
}> {}

/** The repository's git common directory could not be resolved. */
export class RepositoryUnavailable extends Data.TaggedError(
  "RepositoryUnavailable",
)<{
  readonly repository: string;
  readonly cause: unknown;
}> {
  override get message() {
    return `${this.repository} is not inside a git repository, so it has no Records store.`;
  }
}

/** A stored row no longer matches its schema or its recorded hash. */
export class CorruptRecord extends Data.TaggedError("CorruptRecord")<{
  readonly message: string;
}> {}

/** A spool file is not one valid spool line. */
export class InvalidSpoolLine extends Data.TaggedError("InvalidSpoolLine")<{
  readonly file: string;
  readonly message: string;
}> {}

/** Writing a spool file failed; the event was not spooled. */
export class SpoolWriteFailed extends Data.TaggedError("SpoolWriteFailed")<{
  readonly file: string;
  readonly cause: unknown;
}> {}

/**
 * The event breaks a review-workflow rule checked in the append transaction: only a human approves
 * human-required work, and only a disposition's author retracts or replaces it (4.5, 0009). These
 * are rules about who decides in a lane, not access control.
 */
export class WorkflowRuleViolation extends Data.TaggedError(
  "WorkflowRuleViolation",
)<{
  readonly eventId: string;
  readonly rule:
    | "cycle-scope-already-bound"
    | "human-required-approval"
    | "supersedes-unknown-disposition"
    | "supersedes-other-author"
    | "supersedes-other-unit"
    | "rests-on-unknown-comment"
    | "feedback-not-human"
    | "feedback-unknown-target"
    | "feedback-attribution-mismatch"
    | "feedback-supersedes-other"
    | "feedback-not-superseding";
  readonly message: string;
}> {}

/** A `--session` override names no live session in this store and gives no harness to derive one. */
export class UnknownSession extends Data.TaggedError("UnknownSession")<{
  readonly session: string;
  readonly message: string;
}> {}
