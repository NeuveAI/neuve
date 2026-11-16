import { join } from "node:path";
import { Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import { InvalidEvent } from "./errors.ts";
import { append, captureEventKindForKey } from "./log.ts";
import type { StoreLocation } from "./location.ts";
import {
  parseSpoolLine,
  quarantine,
  removeIngested,
  removeStaleTemporaries,
} from "./spool.ts";

/** A spool file named after its event's ULID; temporaries and `rejected/` never match. */
const SPOOL_FILE = /^[0-9A-HJKMNP-TV-Z]{26}\.json$/;

/** Failures that belong to one spool file; the file is set aside and ingestion goes on. */
const FILE_FAULTS = new Set([
  "InvalidSpoolLine",
  "InvalidEvent",
  "PayloadTooLarge",
  "IdempotencyConflict",
  "EventIdConflict",
  "WorkflowRuleViolation",
]);

export interface IngestReport {
  readonly appended: number;
  /** Events the log already held under the same key and content (an earlier ingestion). */
  readonly existing: number;
  /** Second vents from an actor and session that already vented; the earlier vent is kept (8.8). */
  readonly keptEarlier: number;
  /** Files moved to `spool/rejected/`, with why. */
  readonly rejected: ReadonlyArray<{
    readonly file: string;
    readonly reason: string;
  }>;
}

/** Spool files waiting for ingestion, in ULID order, which is ingestion order (D18). */
export const pendingSpoolFiles = (location: StoreLocation) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    if (!(yield* fs.exists(location.spool))) return [];
    const names = yield* fs.readDirectory(location.spool);
    return names.filter((name) => SPOOL_FILE.test(name)).sort();
  });

const isNotFound = (cause: unknown) =>
  typeof cause === "object" &&
  cause !== null &&
  (cause as { _tag?: unknown })._tag === "PlatformError" &&
  (cause as { reason?: { _tag?: unknown } }).reason?._tag === "NotFound";

const describeFault = (error: { readonly _tag: string }) => {
  const message = (error as { readonly message?: unknown }).message;
  return typeof message === "string" && message.length > 0
    ? `${error._tag}: ${message}`
    : `${error._tag}: ${JSON.stringify(error)}`;
};

/**
 * Ingests the spool (D18): each file in ULID order is parsed and appended through `Log.append`,
 * then removed. Appending is idempotent by the event's key, so a file ingested twice (a crash
 * between append and removal, or two ingesters) records its event once. A file that cannot be
 * recorded is quarantined in `spool/rejected/` with its reason; one refused by an append-time
 * workflow rule is first retried after the rest of the pass. A storage or version-gate failure
 * stops ingestion and leaves the remaining files for the next run.
 */
export const ingestSpool = (location: StoreLocation) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    yield* removeStaleTemporaries(location.spool);
    let appended = 0;
    let existing = 0;
    let keptEarlier = 0;
    const rejected: Array<{ file: string; reason: string }> = [];

    /** One file: `held` when an append-time workflow rule refused it and a retry may succeed. */
    const ingestFile = (file: string, final: boolean) =>
      Effect.gen(function* () {
        const path = join(location.spool, file);
        // Another ingester may have taken the file since the listing.
        const text = yield* fs
          .readFileString(path)
          .pipe(
            Effect.catchTag("PlatformError", (error) =>
              error.reason._tag === "NotFound"
                ? Effect.succeed(undefined)
                : Effect.fail(error),
            ),
          );
        if (text === undefined) return "done" as const;
        const line = yield* Effect.result(parseSpoolLine(file, text));
        if (
          line._tag === "Failure" &&
          line.failure._tag === "SpoolHeldByNewerBuild"
        )
          return "done" as const;
        if (
          line._tag === "Success" &&
          (line.success.droppedKeys?.length ?? 0) > 0
        )
          return "done" as const;
        const outcome = yield* Effect.result(
          Effect.flatMap(
            line._tag === "Failure"
              ? Effect.fail(line.failure)
              : Effect.succeed(line.success),
            (line) =>
              captureEventKindForKey(line.event.idempotencyKey) !== undefined ||
              line.event.kind === "capture.filed@1" ||
              line.event.kind === "capture.sealed@1" ||
              line.event.kind === "capture.marked@1"
                ? Effect.fail(
                    new InvalidEvent({
                      message:
                        "capture events require the in-process filing, scan or audit writer",
                    }),
                  )
                : append([line.event]),
          ),
        );
        if (outcome._tag === "Failure") {
          const error = outcome.failure;
          if (error._tag === "WorkflowRuleViolation" && !final)
            return "held" as const;
          if (!FILE_FAULTS.has(error._tag)) return yield* error;
          const reason = describeFault(error);
          yield* quarantine(location.spool, file, reason);
          rejected.push({ file, reason });
          return "done" as const;
        }
        for (const result of outcome.success) {
          if (result.status === "appended") appended += 1;
          else if (result.status === "kept-earlier") keptEarlier += 1;
          else existing += 1;
        }
        // Another ingester may have removed the file since it was read: it is ingested either way.
        yield* removeIngested(location.spool, file).pipe(
          Effect.catchTag("SpoolWriteFailed", (error) =>
            isNotFound(error.cause) ? Effect.void : Effect.fail(error),
          ),
        );
        return "done" as const;
      });

    // A spooled event may depend on one later in ULID order (a retraction captured before what it
    // retracts is ingested); such files are retried once after the pass, then set aside.
    const held: Array<string> = [];
    for (const file of yield* pendingSpoolFiles(location)) {
      if ((yield* ingestFile(file, false)) === "held") held.push(file);
    }
    for (const file of held) yield* ingestFile(file, true);
    const report: IngestReport = {
      appended,
      existing,
      keptEarlier,
      rejected,
    };
    return report;
  });
