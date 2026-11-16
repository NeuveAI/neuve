import { safeRead, sayOnce } from "@neuve/records-schema";
import { readlinkSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { Data, Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import { SpoolLine, type RecordEvent } from "@neuve/records-schema";
import { isKnownEventKind } from "./codec.ts";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { InvalidSpoolLine, SpoolWriteFailed } from "./errors.ts";
import { STORE_DIRECTORY_MODE } from "./location.ts";

export { mintUlid } from "./ids.ts";

/**
 * The spool (D18). A hook writes each event to `<spool>/<event id>.json` as one JSON line: written
 * to a temporary file, fsynced, renamed, and the directory fsynced, so a reader sees a whole durable
 * line or nothing and the name survives a crash. ULID file names sort in ingestion order. This module
 * never opens SQLite, so hooks stay fast.
 */
export const spoolFileName = (eventId: string) => `${eventId}.json`;

/** Where ingestion moves a spool file it cannot parse or append, kept for inspection, never rescanned. */
export const REJECTED_DIRECTORY = "rejected";

/** The PID namespace this process runs in. Linux names it under /proc; other systems have only one. */
const pidNamespace = () => {
  try {
    return readlinkSync("/proc/self/ns/pid");
  } catch {
    return "";
  }
};

/**
 * Which process table a PID belongs to: the host name and PID namespace, hashed to a file-name-safe
 * token. A writer in a container shares the spool through a mount but not the host's process table,
 * so its PID means nothing to a cleaner elsewhere. Every temporary names its writer's token, and a
 * cleaner judges only temporaries whose token equals its own.
 */
export const writerToken = (
  host: string = hostname(),
  namespace: string = pidNamespace(),
) => sha256Hex(`${host}\u0000${namespace}`).slice(0, 16);

const TEMPORARY =
  /^\.(?<id>[0-9A-Z]{26})\.(?<token>[0-9a-f]{16})\.(?<pid>\d+)\.tmp$/;

const temporaryName = (eventId: string) =>
  `.${eventId}.${writerToken()}.${process.pid}.tmp`;

/** fsyncs a directory so a rename or unlink inside it is durable. */
const syncDirectory = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* fs.open(directory, { flag: "r" });
        yield* handle.sync;
      }),
    );
  });

export const formatSpoolLine = (event: RecordEvent): string =>
  `${canonicalJson({ spool: 1, event })}\n`;

export const writeSpoolLine = (spoolDirectory: string, event: RecordEvent) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const target = join(spoolDirectory, spoolFileName(event.id));
    const temporary = join(spoolDirectory, temporaryName(event.id));
    yield* fs.makeDirectory(spoolDirectory, {
      recursive: true,
      mode: STORE_DIRECTORY_MODE,
    });
    yield* Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(temporary, { flag: "wx" });
          yield* file.writeAll(
            new TextEncoder().encode(formatSpoolLine(event)),
          );
          yield* file.sync;
        }),
      );
      yield* fs.rename(temporary, target);
    }).pipe(Effect.onError(() => Effect.ignore(fs.remove(temporary))));
    yield* syncDirectory(spoolDirectory);
    return target;
  }).pipe(
    Effect.mapError(
      (cause) => new SpoolWriteFailed({ file: spoolFileName(event.id), cause }),
    ),
  );

const processIsGone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
};

/**
 * Removes temporary files left by writers that died between writing and renaming. Only temporaries
 * written under this process's own writer token are judged, and one is removed only when no process
 * with its PID exists. A temporary from another host or PID namespace, such as a container sharing the
 * spool, is never removed here: its PID cannot be checked from this process table, and removing a live
 * writer's file would lose its event. Such a leftover costs one small file and is never ingested. No
 * age or time limit is involved (8.2). Spool ingestion calls this before it scans.
 */
export const removeStaleTemporaries = (spoolDirectory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    if (!(yield* fs.exists(spoolDirectory))) return [];
    const own = writerToken();
    const removed: Array<string> = [];
    for (const name of yield* fs.readDirectory(spoolDirectory)) {
      const groups = TEMPORARY.exec(name)?.groups;
      if (groups?.["token"] !== own) continue;
      if (!processIsGone(Number(groups["pid"]))) continue;
      yield* fs.remove(join(spoolDirectory, name));
      removed.push(name);
    }
    return removed;
  });

/** Deletes a spool file once its event is committed to the log, durably. */
export const removeIngested = (spoolDirectory: string, file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    yield* fs.remove(join(spoolDirectory, file));
    yield* syncDirectory(spoolDirectory);
  }).pipe(Effect.mapError((cause) => new SpoolWriteFailed({ file, cause })));

/**
 * Moves a spool file that cannot be parsed or appended to `<spool>/rejected/`, with the reason beside
 * it, so it is kept for inspection and no longer scanned.
 */
export const quarantine = (
  spoolDirectory: string,
  file: string,
  reason: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const rejected = join(spoolDirectory, REJECTED_DIRECTORY);
    yield* fs.makeDirectory(rejected, {
      recursive: true,
      mode: STORE_DIRECTORY_MODE,
    });
    yield* fs.writeFileString(
      join(rejected, `${file}.reason.txt`),
      `${reason}\n`,
    );
    yield* fs.rename(join(spoolDirectory, file), join(rejected, file));
    yield* syncDirectory(rejected);
    yield* syncDirectory(spoolDirectory);
  }).pipe(Effect.mapError((cause) => new SpoolWriteFailed({ file, cause })));

export class SpoolHeldByNewerBuild extends Data.TaggedError(
  "SpoolHeldByNewerBuild",
)<{ readonly file: string }> {}

/**
 * Parses one spool file's text: exactly one newline-terminated line holding a valid spool object
 * named after its event. The parser does not require canonical bytes: the line's meaning is what
 * the strict schema accepts, the store re-canonicalizes on append, and idempotency compares content
 * fingerprints, so key order or spacing from another writer cannot change what is recorded.
 */
export const parseSpoolLine = (file: string, text: string) =>
  Effect.gen(function* () {
    if (!text.endsWith("\n") || text.indexOf("\n") !== text.length - 1) {
      return yield* new InvalidSpoolLine({
        file,
        message: "Expected exactly one newline-terminated line",
      });
    }
    const json = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: () => new InvalidSpoolLine({ file, message: "Line is not JSON" }),
    });
    if (
      typeof json === "object" &&
      json !== null &&
      (("spool" in json && typeof json.spool === "number" && json.spool > 1) ||
        ("event" in json &&
          typeof json.event === "object" &&
          json.event !== null &&
          "kind" in json.event &&
          typeof json.event.kind === "string" &&
          !isKnownEventKind(json.event.kind)))
    ) {
      sayOnce(
        "compatible-read",
        "neuve: compatibility mode; leaving newer spool files to a newer build",
        (line) => process.stderr.write(`${line}\n`),
      );
      return yield* new SpoolHeldByNewerBuild({ file });
    }
    const parsed = safeRead(SpoolLine, json);
    if (!parsed.success)
      return yield* new InvalidSpoolLine({
        file,
        message: parsed.error.message,
      });
    if (file !== spoolFileName(parsed.data.event.id)) {
      return yield* new InvalidSpoolLine({
        file,
        message: `File name does not match event ${parsed.data.event.id}`,
      });
    }
    return {
      ...parsed.data,
      ...(parsed.droppedKeys.length === 0
        ? {}
        : { droppedKeys: parsed.droppedKeys }),
    };
  });
